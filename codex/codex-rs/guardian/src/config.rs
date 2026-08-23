use std::path::Path;
use std::sync::Arc;

use serde::Deserialize;
use serde::Serialize;

use crate::Guardian;
use crate::NoopGuardian;

/// Directory under `$CODEX_HOME` owning everything the guard layer writes.
pub const GUARDIAN_DIR: &str = "guardian";

/// Which guardian implementation a session runs with.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GuardianMode {
    /// No guarding and no recording.
    #[default]
    Off,
}

/// Guard-layer settings, read from the `[guardian]` table of `config.toml`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct GuardianConfig {
    pub mode: GuardianMode,
}

/// Selects the guardian implementation for a session.
///
/// Mirrors how the thread store is chosen from config: core depends only on the
/// trait, so a deployment decides what happens to session activity without core
/// knowing which backend is in play.
pub fn guardian_from_config(config: &GuardianConfig, _codex_home: &Path) -> Arc<dyn Guardian> {
    match config.mode {
        GuardianMode::Off => Arc::new(NoopGuardian),
    }
}
