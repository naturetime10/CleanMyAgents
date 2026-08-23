use std::collections::HashMap;
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
use crate::GuardianError;
use crate::GuardianFuture;
use crate::Verdict;

/// Header written once at the top of every per-session CSV file.
pub const CSV_HEADER: &str = "ts,thread_id,session_id,turn_id,kind,phase,tool,call_id,decision,\
reason,tokens_in,tokens_out,tokens_total,context_used,context_limit,account,cwd,detail\n";

/// Bounded so a burst of activity applies backpressure to the writer instead of
/// growing without limit; matches the rollout recorder's queue depth.
const QUEUE_DEPTH: usize = 256;

enum Cmd {
    Row(Box<ActivityRow>),
    Flush(oneshot::Sender<()>),
}

/// Local history guardian: appends every session activity to a CSV file for
/// debugging and never denies anything.
///
/// One file per session lives at `<dir>/<thread_id>.csv`. Writes are handed to a
/// background task that owns the file handles, so the turn path never blocks on
/// disk I/O.
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

    async fn send(&self, row: ActivityRow) {
        if self.tx.send(Cmd::Row(Box::new(row))).await.is_err() {
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
            self.send(ActivityRow::for_action(ctx, action, &Verdict::Defer))
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
            self.send(ActivityRow::for_activity(ctx, activity)).await;
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

fn session_path(dir: &Path, thread_id: &str) -> PathBuf {
    dir.join(format!("{}.csv", sanitize_file_stem(thread_id)))
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
    while let Some(cmd) = rx.recv().await {
        match cmd {
            Cmd::Row(row) => {
                if let Err(err) = write_row(&dir, &mut files, &row).await {
                    tracing::warn!("guardian csv write failed: {err}");
                }
            }
            Cmd::Flush(ack) => {
                for file in files.values_mut() {
                    if let Err(err) = file.flush().await {
                        tracing::warn!("guardian csv flush failed: {err}");
                    }
                }
                let _ = ack.send(());
            }
        }
    }
}

async fn write_row(
    dir: &Path,
    files: &mut HashMap<String, File>,
    row: &ActivityRow,
) -> std::io::Result<()> {
    if !files.contains_key(&row.thread_id) {
        let file = open_session_file(dir, &row.thread_id).await?;
        files.insert(row.thread_id.clone(), file);
    }
    let Some(file) = files.get_mut(&row.thread_id) else {
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
