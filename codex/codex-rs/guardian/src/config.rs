use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;
use serde::Serialize;

use crate::CsvHistoryGuardian;
use crate::FanOutGuardian;
use crate::Guardian;
use crate::IpcGuardian;
use crate::NoopGuardian;

/// Directory under `$CODEX_HOME` owning everything the guard layer writes.
pub const GUARDIAN_DIR: &str = "guardian";
/// Sub-directory holding the per-session CSV history.
pub const DEBUG_DIR: &str = "debug";
/// Default rendezvous path for the resident guardian process.
pub const SOCKET_FILE: &str = "guardian.sock";

/// Which guardian implementation a session runs with.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GuardianMode {
    /// No guarding and no recording.
    #[default]
    Off,
    /// Local history only: append every activity to a per-session CSV file.
    Csv,
    /// Delegate every decision to the resident local process.
    Ipc,
    /// Both: record locally *and* enforce through the resident process.
    Both,
}

/// Guard-layer settings, read from the `[guardian]` table of `config.toml`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GuardianConfig {
    pub mode: GuardianMode,
    /// Overrides `$CODEX_HOME/guardian/debug`.
    pub debug_dir: Option<PathBuf>,
    /// Overrides `$CODEX_HOME/guardian/guardian.sock`.
    pub socket_path: Option<PathBuf>,
    /// Deny actions when the resident process cannot be reached. On by default:
    /// a guard that fails open is not a guard.
    pub fail_closed: bool,
    /// Deadline for one round trip to the resident process.
    pub request_timeout: Duration,
}

impl Default for GuardianConfig {
    fn default() -> Self {
        Self {
            mode: GuardianMode::Off,
            debug_dir: None,
            socket_path: None,
            fail_closed: true,
            request_timeout: Duration::from_secs(3),
        }
    }
}

impl GuardianConfig {
    /// Resolved directory for the per-session CSV history.
    pub fn debug_dir(&self, codex_home: &Path) -> PathBuf {
        self.debug_dir
            .clone()
            .unwrap_or_else(|| codex_home.join(GUARDIAN_DIR).join(DEBUG_DIR))
    }

    /// Resolved socket path for the resident guardian process.
    pub fn socket_path(&self, codex_home: &Path) -> PathBuf {
        self.socket_path
            .clone()
            .unwrap_or_else(|| codex_home.join(GUARDIAN_DIR).join(SOCKET_FILE))
    }
}

/// Selects the guardian implementation for a process.
///
/// Mirrors how the thread store is chosen from config: core depends only on the
/// trait, and the deployment decides whether activity is written to local CSV
/// history, delegated to a local process over IPC, both, or dropped.
pub fn guardian_from_config(config: &GuardianConfig, codex_home: &Path) -> Arc<dyn Guardian> {
    match config.mode {
        GuardianMode::Off => Arc::new(NoopGuardian),
        GuardianMode::Csv => Arc::new(CsvHistoryGuardian::new(config.debug_dir(codex_home))),
        GuardianMode::Ipc => Arc::new(IpcGuardian::new(
            config.socket_path(codex_home),
            config.request_timeout,
            config.fail_closed,
        )),
        GuardianMode::Both => Arc::new(FanOutGuardian::new(vec![
            Arc::new(CsvHistoryGuardian::new(config.debug_dir(codex_home))),
            Arc::new(IpcGuardian::new(
                config.socket_path(codex_home),
                config.request_timeout,
                config.fail_closed,
            )),
        ])),
    }
}
