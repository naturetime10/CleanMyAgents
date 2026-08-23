//! Per-thread metadata sidecar written beside the CSV history.
//!
//! History files are named by thread id, so a run that spawns sub-agents
//! scatters one session across several CSVs. The sidecar makes that tree
//! discoverable without parsing history: it names the session the thread
//! belongs to, and owns every field that is constant for the whole file.
//!
//! Those fields are deliberately not columns. Repeating a thread id, a session
//! id, an account and a working directory on every row costs more bytes than
//! the events themselves and tells a reader nothing new after the first line.

use std::path::Path;

use serde::Deserialize;
use serde::Serialize;
use tokio::io::AsyncWriteExt;

use crate::ActivityContext;
use crate::ActivityRow;

/// Shape version stamped into every sidecar, so a reader can tell what it is
/// looking at before trusting the fields.
pub const SESSION_META_VERSION: u32 = 1;

/// Suffix appended to the thread id to name the sidecar.
pub const SESSION_META_SUFFIX: &str = ".meta.yml";

/// What one thread's history file belongs to, and a summary of what is in it.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionMeta {
    pub schema_version: u32,
    /// Identity shared by the root thread and every thread descended from it.
    /// Group sidecars by this to reassemble one multi-agent run.
    pub session_id: String,
    pub thread_id: String,
    /// History file this sidecar describes, named relative to the same
    /// directory.
    pub csv_file: String,
    /// The working directory the thread started in. A turn can be run
    /// somewhere else, so this is where it began rather than a claim about
    /// every event in the file.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub cwd: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub account: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub model: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub originator: String,
    pub first_activity_at: String,
    pub last_activity_at: String,
    /// Stamped when the thread records `SessionEnded`. Absent while it is still
    /// live, and also when the process died before it could end cleanly, so an
    /// absent value means "unknown", not "still running".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<String>,
    pub rows: u64,
    pub turns: u64,
    /// Latest cumulative token spend reported for this thread.
    pub tokens_total: i64,
}

impl SessionMeta {
    /// Opens a sidecar from the first row seen for a thread.
    pub(crate) fn new(row: &ActivityRow, identity: &SessionIdentity, csv_file: String) -> Self {
        Self {
            schema_version: SESSION_META_VERSION,
            session_id: identity.session_id.clone(),
            thread_id: identity.thread_id.clone(),
            csv_file,
            first_activity_at: row.ts.clone(),
            last_activity_at: row.ts.clone(),
            ..Self::default()
        }
    }

    /// Folds one row in.
    ///
    /// Returns whether a field a reader selects sessions by changed, which is
    /// what earns an immediate rewrite; the counters ride along to the next
    /// one rather than paying a write per row.
    pub(crate) fn observe(&mut self, row: &ActivityRow, identity: &SessionIdentity) -> bool {
        self.rows += 1;
        self.last_activity_at = row.ts.clone();
        if let Ok(total) = row.tokens_total.parse::<i64>() {
            self.tokens_total = total;
        }
        if row.kind == "turn_stopped" {
            self.turns += 1;
        }

        // Session-scoped events carry no cwd and no model, so identity is
        // learned from the first turn-scoped row rather than at session start.
        let mut selector_changed = fill(&mut self.cwd, &identity.cwd);
        selector_changed |= fill(&mut self.account, &identity.account);
        selector_changed |= fill(&mut self.model, &identity.model);
        selector_changed |= fill(&mut self.originator, &identity.originator);
        if row.kind == "session_ended" && self.ended_at.is_none() {
            self.ended_at = Some(row.ts.clone());
            selector_changed = true;
        }
        selector_changed
    }
}

/// What every row of one file shares, carried beside the row because the CSV
/// no longer has columns for it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct SessionIdentity {
    pub(crate) thread_id: String,
    pub(crate) session_id: String,
    pub(crate) account: String,
    pub(crate) cwd: String,
    pub(crate) model: String,
    pub(crate) originator: String,
}

impl SessionIdentity {
    pub(crate) fn from_context(ctx: &ActivityContext) -> Self {
        Self {
            thread_id: ctx.thread_id.clone(),
            session_id: ctx.session_id.clone(),
            account: ctx.account.clone().unwrap_or_default(),
            cwd: ctx.cwd.display().to_string(),
            model: ctx.model.clone(),
            originator: ctx.originator.clone(),
        }
    }
}

/// Fills a field the first time a non-empty value for it turns up.
fn fill(field: &mut String, value: &str) -> bool {
    if field.is_empty() && !value.is_empty() {
        value.clone_into(field);
        true
    } else {
        false
    }
}

/// Writes the sidecar through a temporary file and a rename, so a reader that
/// opens it mid-update sees the previous version whole rather than a truncated
/// one.
pub(crate) async fn write_session_meta(path: &Path, meta: &SessionMeta) -> std::io::Result<()> {
    let mut body = serde_yaml::to_string(meta)
        .map_err(|err| std::io::Error::new(std::io::ErrorKind::InvalidData, err))?
        .into_bytes();
    if !body.ends_with(b"\n") {
        body.push(b'\n');
    }

    let tmp = path.with_extension("tmp");
    let mut options = tokio::fs::OpenOptions::new();
    options.create(true).write(true).truncate(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options.open(&tmp).await?;
    file.write_all(&body).await?;
    file.flush().await?;
    drop(file);
    tokio::fs::rename(&tmp, path).await
}

/// Reads every sidecar in `dir`, oldest first.
///
/// This is the entry point for tracking sessions: the whole set is small and
/// fixed-size per thread, so a caller can group by [`SessionMeta::session_id`]
/// to list runs without touching the history files themselves. A sidecar that
/// cannot be read or parsed is skipped rather than failing the scan — one
/// truncated file should not hide every other session.
pub async fn read_session_metas(dir: &Path) -> std::io::Result<Vec<SessionMeta>> {
    let mut entries = match tokio::fs::read_dir(dir).await {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(err),
    };

    let mut metas = Vec::new();
    while let Some(entry) = entries.next_entry().await? {
        let path = entry.path();
        let is_sidecar = path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.ends_with(SESSION_META_SUFFIX));
        if !is_sidecar {
            continue;
        }
        match tokio::fs::read(&path).await {
            Ok(body) => match serde_yaml::from_slice::<SessionMeta>(&body) {
                Ok(meta) => metas.push(meta),
                Err(err) => tracing::debug!("skipping unparseable session metadata: {err}"),
            },
            Err(err) => tracing::debug!("skipping unreadable session metadata: {err}"),
        }
    }
    metas.sort_by(|a, b| {
        a.first_activity_at
            .cmp(&b.first_activity_at)
            .then_with(|| a.thread_id.cmp(&b.thread_id))
    });
    Ok(metas)
}

#[cfg(test)]
#[path = "session_meta_tests.rs"]
mod tests;
