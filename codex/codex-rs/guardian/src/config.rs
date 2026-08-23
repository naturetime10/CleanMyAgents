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
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GuardianMode {
    /// No guarding and no recording.
    Off,
    /// Local history only: append every activity to a per-session CSV file.
    Csv,
    /// Delegate every decision to the resident local process.
    Ipc,
    /// Both: record locally *and* enforce through the resident process.
    Both,
}

impl Default for GuardianMode {
    /// Debug builds record local history without being asked, so a developer
    /// running from source has a session trail to read after the fact. Release
    /// builds stay off: recording every prompt and tool result to disk is not
    /// something a shipped binary should start doing on its own.
    fn default() -> Self {
        if cfg!(debug_assertions) {
            Self::Csv
        } else {
            Self::Off
        }
    }
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
            mode: GuardianMode::default(),
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::FailurePosture;

    /// Every mode has to select an implementation, and the recording-only one
    /// must not start failing actions closed just because it is composed with
    /// an enforcing guardian.
    #[tokio::test]
    async fn each_mode_selects_an_implementation_with_the_right_posture() {
        let codex_home = std::path::Path::new("/codex-home");
        let cases = [
            (
                GuardianMode::Off,
                /*enabled*/ false,
                FailurePosture::FailOpen,
            ),
            (
                GuardianMode::Csv,
                /*enabled*/ true,
                FailurePosture::FailOpen,
            ),
            (
                GuardianMode::Ipc,
                /*enabled*/ true,
                FailurePosture::FailClosed,
            ),
            // Composed: recording alone fails open, but the enforcing half
            // decides the posture for the pair.
            (
                GuardianMode::Both,
                /*enabled*/ true,
                FailurePosture::FailClosed,
            ),
        ];
        for (mode, enabled, posture) in cases {
            let config = GuardianConfig {
                mode,
                ..GuardianConfig::default()
            };
            let guardian = guardian_from_config(&config, codex_home);
            assert_eq!(guardian.is_enabled(), enabled, "{mode:?}");
            assert_eq!(guardian.failure_posture(), posture, "{mode:?}");
        }
    }

    #[test]
    fn paths_fall_back_to_codex_home_and_honour_overrides() {
        let codex_home = std::path::Path::new("/codex-home");
        let defaults = GuardianConfig::default();
        assert_eq!(
            defaults.debug_dir(codex_home),
            codex_home.join(GUARDIAN_DIR).join(DEBUG_DIR)
        );
        assert_eq!(
            defaults.socket_path(codex_home),
            codex_home.join(GUARDIAN_DIR).join(SOCKET_FILE)
        );

        let overridden = GuardianConfig {
            debug_dir: Some(PathBuf::from("/elsewhere/history")),
            socket_path: Some(PathBuf::from("/elsewhere/guard.sock")),
            ..GuardianConfig::default()
        };
        assert_eq!(
            overridden.debug_dir(codex_home),
            PathBuf::from("/elsewhere/history")
        );
        assert_eq!(
            overridden.socket_path(codex_home),
            PathBuf::from("/elsewhere/guard.sock")
        );
    }

    #[cfg(debug_assertions)]
    #[test]
    fn a_debug_build_records_local_history_by_default() {
        assert_eq!(GuardianConfig::default().mode, GuardianMode::Csv);
    }

    #[cfg(not(debug_assertions))]
    #[test]
    fn a_release_build_stays_off_by_default() {
        assert_eq!(GuardianConfig::default().mode, GuardianMode::Off);
    }
}
