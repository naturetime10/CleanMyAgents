use std::collections::HashMap;
use std::collections::hash_map::Entry;
use std::path::Path;
use std::path::PathBuf;

use tokio::fs::File;
use tokio::io::AsyncWriteExt;
use tokio::sync::mpsc;
use tokio::sync::oneshot;

use crate::Activity;
use crate::ActivityContext;
use crate::ActivityRow;
use crate::FailurePosture;
use crate::GuardedAction;
use crate::Guardian;
use crate::GuardianConfig;
use crate::GuardianError;
use crate::GuardianFuture;
use crate::GuardianMode;
use crate::SessionMeta;
use crate::Verdict;
use crate::session_meta::SESSION_META_SUFFIX;
use crate::session_meta::SessionIdentity;
use crate::session_meta::write_session_meta;

/// Header written once at the top of every per-session CSV file.
pub const CSV_HEADER: &str = "ts,turn_id,kind,phase,tool,call_id,decision,reason,\
tokens_in,tokens_out,tokens_total,context_used,context_limit,detail\n";

/// Bounded so a burst of activity applies backpressure to the writer instead of
/// growing without limit; matches the rollout recorder's queue depth.
const QUEUE_DEPTH: usize = 256;

enum Cmd {
    Row {
        row: Box<ActivityRow>,
        /// Everything constant for the file. The CSV has no columns for it, so
        /// it rides along for the sidecar and for naming the file.
        identity: Box<SessionIdentity>,
    },
    Flush(oneshot::Sender<()>),
}

/// Local history guardian: appends every session activity to a CSV file for
/// debugging and never denies anything.
///
/// One file per session lives at `<dir>/<thread_id>.csv`, beside a
/// `<thread_id>.meta.json` sidecar naming the session it belongs to. Writes are
/// handed to a background task that owns the file handles, so the turn path
/// never blocks on disk I/O.
#[derive(Debug)]
pub struct CsvHistoryGuardian {
    tx: mpsc::Sender<Cmd>,
    dir: PathBuf,
}

impl CsvHistoryGuardian {
    /// Starts the writer task. The directory is created lazily on first write so
    /// constructing a guardian never touches the filesystem.
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        let dir = dir.into();
        let (tx, rx) = mpsc::channel(QUEUE_DEPTH);
        tokio::spawn(writer_loop(dir.clone(), rx));
        Self { tx, dir }
    }

    /// Directory holding the per-session files.
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Path of the file for one session.
    pub fn session_path(&self, thread_id: &str) -> PathBuf {
        session_path(&self.dir, thread_id)
    }

    /// Path of the metadata sidecar for one session.
    pub fn session_meta_path(&self, thread_id: &str) -> PathBuf {
        meta_path(&self.dir, thread_id)
    }

    async fn send(&self, ctx: &ActivityContext, row: ActivityRow) {
        let cmd = Cmd::Row {
            row: Box::new(row),
            identity: Box::new(SessionIdentity::from_context(ctx)),
        };
        if self.tx.send(cmd).await.is_err() {
            tracing::debug!("guardian csv writer stopped; dropping row");
        }
    }
}

impl Guardian for CsvHistoryGuardian {
    fn review<'a>(
        &'a self,
        ctx: &'a ActivityContext,
        action: &'a GuardedAction,
    ) -> GuardianFuture<'a, Result<Verdict, GuardianError>> {
        Box::pin(async move {
            // History is observe-only: record what was attempted, admit it, and
            // leave enforcement to whichever guardian is composed alongside.
            self.send(ctx, ActivityRow::for_action(ctx, action, &Verdict::Defer))
                .await;
            Ok(Verdict::Defer)
        })
    }

    fn record<'a>(
        &'a self,
        ctx: &'a ActivityContext,
        activity: &'a Activity,
    ) -> GuardianFuture<'a, ()> {
        Box::pin(async move {
            self.send(ctx, ActivityRow::for_activity(ctx, activity))
                .await;
        })
    }

    fn failure_posture(&self) -> FailurePosture {
        FailurePosture::FailOpen
    }

    fn flush(&self) -> GuardianFuture<'_, ()> {
        Box::pin(async move {
            let (ack_tx, ack_rx) = oneshot::channel();
            if self.tx.send(Cmd::Flush(ack_tx)).await.is_ok() {
                let _ = ack_rx.await;
            }
        })
    }
}

/// Where a session's history file lands under `config`, or `None` when the
/// configured mode writes no history at all.
///
/// Surfaces that want to point a user at their history -- the TUI session
/// header, say -- go through this rather than rebuilding the naming rules.
pub fn configured_session_path(
    config: &GuardianConfig,
    codex_home: &Path,
    thread_id: &str,
) -> Option<PathBuf> {
    match config.mode {
        GuardianMode::Csv | GuardianMode::Both => {
            Some(session_path(&config.debug_dir(codex_home), thread_id))
        }
        GuardianMode::Off | GuardianMode::Ipc => None,
    }
}

fn session_path(dir: &Path, thread_id: &str) -> PathBuf {
    dir.join(csv_file_name(thread_id))
}

fn csv_file_name(thread_id: &str) -> String {
    format!("{}.csv", sanitize_file_stem(thread_id))
}

fn meta_path(dir: &Path, thread_id: &str) -> PathBuf {
    dir.join(format!(
        "{}{SESSION_META_SUFFIX}",
        sanitize_file_stem(thread_id)
    ))
}

/// Keeps a thread id from escaping the debug directory or naming a path.
fn sanitize_file_stem(thread_id: &str) -> String {
    let sanitized: String = thread_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if sanitized.is_empty() {
        "unknown-session".to_string()
    } else {
        sanitized
    }
}

async fn writer_loop(dir: PathBuf, mut rx: mpsc::Receiver<Cmd>) {
    let mut files: HashMap<String, File> = HashMap::new();
    let mut metas: HashMap<String, SessionMeta> = HashMap::new();
    while let Some(cmd) = rx.recv().await {
        match cmd {
            Cmd::Row { row, identity } => {
                if let Err(err) = write_row(&dir, &mut files, &row, &identity).await {
                    tracing::warn!("guardian csv write failed: {err}");
                }
                if let Err(err) = update_meta(&dir, &mut metas, &row, &identity).await {
                    tracing::warn!("guardian session metadata write failed: {err}");
                }
            }
            Cmd::Flush(ack) => {
                for file in files.values_mut() {
                    if let Err(err) = file.flush().await {
                        tracing::warn!("guardian csv flush failed: {err}");
                    }
                }
                // Counters advance on every row but are only persisted at
                // checkpoints. Session end flushes, so the final tallies land
                // here rather than costing a sidecar rewrite per row.
                for (thread_id, meta) in &metas {
                    if let Err(err) = write_session_meta(&meta_path(&dir, thread_id), meta).await {
                        tracing::warn!("guardian session metadata flush failed: {err}");
                    }
                }
                let _ = ack.send(());
            }
        }
    }
}

/// Folds one row into the thread's metadata, rewriting the sidecar when a field
/// a reader selects on has changed.
async fn update_meta(
    dir: &Path,
    metas: &mut HashMap<String, SessionMeta>,
    row: &ActivityRow,
    identity: &SessionIdentity,
) -> std::io::Result<()> {
    let (meta, is_new) = match metas.entry(identity.thread_id.clone()) {
        Entry::Occupied(entry) => (entry.into_mut(), false),
        Entry::Vacant(entry) => (
            entry.insert(SessionMeta::new(
                row,
                identity,
                csv_file_name(&identity.thread_id),
            )),
            true,
        ),
    };
    if meta.observe(row, identity) || is_new {
        write_session_meta(&meta_path(dir, &identity.thread_id), meta).await?;
    }
    Ok(())
}

async fn write_row(
    dir: &Path,
    files: &mut HashMap<String, File>,
    row: &ActivityRow,
    identity: &SessionIdentity,
) -> std::io::Result<()> {
    if !files.contains_key(&identity.thread_id) {
        let file = open_session_file(dir, &identity.thread_id).await?;
        files.insert(identity.thread_id.clone(), file);
    }
    let Some(file) = files.get_mut(&identity.thread_id) else {
        return Ok(());
    };
    file.write_all(row.to_csv_line().as_bytes()).await?;
    file.flush().await
}

/// Opens (creating if needed) the session file, writing the header exactly once.
async fn open_session_file(dir: &Path, thread_id: &str) -> std::io::Result<File> {
    tokio::fs::create_dir_all(dir).await?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = tokio::fs::metadata(dir).await?.permissions();
        permissions.set_mode(0o700);
        tokio::fs::set_permissions(dir, permissions).await?;
    }

    let path = session_path(dir, thread_id);
    let needs_header = tokio::fs::metadata(&path)
        .await
        .map(|metadata| metadata.len() == 0)
        .unwrap_or(true);

    let mut options = tokio::fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options.open(&path).await?;
    if needs_header {
        file.write_all(CSV_HEADER.as_bytes()).await?;
        file.flush().await?;
    }
    Ok(file)
}

#[cfg(test)]
#[path = "csv_history_tests.rs"]
mod tests;
