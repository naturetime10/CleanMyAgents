use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use serde::Deserialize;
use serde::Serialize;

use crate::CsvHistoryGuardian;
use crate::Guardian;
use crate::NoopGuardian;

/// Directory under `$CODEX_HOME` owning everything the guard layer writes.
pub const GUARDIAN_DIR: &str = "guardian";
/// Sub-directory holding the per-session CSV history.
pub const DEBUG_DIR: &str = "debug";

/// Which guardian implementation a session runs with.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GuardianMode {
    /// No guarding and no recording.
    #[default]
    Off,
    /// Local history only: append every activity to a per-session CSV file.
    Csv,
}

/// Guard-layer settings, read from the `[guardian]` table of `config.toml`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct GuardianConfig {
    pub mode: GuardianMode,
    /// Overrides `$CODEX_HOME/guardian/debug`.
    pub debug_dir: Option<PathBuf>,
}

impl GuardianConfig {
    /// Resolved directory for the per-session CSV history.
    pub fn debug_dir(&self, codex_home: &Path) -> PathBuf {
        self.debug_dir
            .clone()
            .unwrap_or_else(|| codex_home.join(GUARDIAN_DIR).join(DEBUG_DIR))
    }
}

/// Selects the guardian implementation for a session.
///
/// Mirrors how the thread store is chosen from config: core depends only on the
/// trait, so a deployment decides what happens to session activity without core
/// knowing which backend is in play.
pub fn guardian_from_config(config: &GuardianConfig, codex_home: &Path) -> Arc<dyn Guardian> {
    match config.mode {
        GuardianMode::Off => Arc::new(NoopGuardian),
        GuardianMode::Csv => Arc::new(CsvHistoryGuardian::new(config.debug_dir(codex_home))),
    }
}
