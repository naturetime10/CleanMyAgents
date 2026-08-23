use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;
use serde::Serialize;

use codex_http_client::HttpClientFactory;

use crate::ApiEndpoint;
use crate::ApiEndpointError;
use crate::ApiGuardian;
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

/// Where [`GuardianMode::Api`] looks for a backend when config names none.
///
/// Loopback on purpose: the default must not send a session's prompts and tool
/// output anywhere but this machine.
pub const DEFAULT_ENDPOINT: &str = "http://127.0.0.1:4500/guardian";

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
    /// Delegate every decision to an HTTP backend over the REST protocol.
    Api,
}

impl Default for GuardianMode {
    /// Delegate to the local REST backend without being asked.
    ///
    /// The default points at [`DEFAULT_ENDPOINT`], a loopback address, so a
    /// session picks up the monitor as soon as one is running and needs no
    /// configuration to do it.
    fn default() -> Self {
        Self::Api
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
    /// Base URL of the REST backend. Required by [`GuardianMode::Api`] and
    /// ignored by every other mode.
    pub endpoint: Option<String>,
    /// Name of the environment variable holding the bearer token for
    /// `endpoint`. The token itself is deliberately not a config field: a
    /// credential in `config.toml` outlives the session that needed it.
    pub api_key_env: Option<String>,
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
            endpoint: Some(DEFAULT_ENDPOINT.to_string()),
            api_key_env: None,
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

    /// Checks that the selected mode has everything it needs.
    ///
    /// Called while config is loaded so a mode that cannot work says so at
    /// startup. The alternative -- discovering it at the first choke point --
    /// leaves a fail-closed deployment denying every action for a reason the
    /// operator has to go digging for.
    pub fn validate(&self) -> Result<(), GuardianConfigError> {
        if self.mode != GuardianMode::Api {
            return Ok(());
        }
        let Some(endpoint) = self.endpoint.as_deref() else {
            return Err(GuardianConfigError::MissingEndpoint);
        };
        ApiEndpoint::parse(endpoint).map_err(GuardianConfigError::Endpoint)?;
        Ok(())
    }

    /// The bearer token for the REST backend, read from the environment
    /// variable named by `api_key_env`.
    fn bearer_token(&self) -> Option<String> {
        let name = self.api_key_env.as_deref()?;
        match std::env::var(name) {
            Ok(token) if !token.trim().is_empty() => Some(token),
            _ => {
                tracing::warn!(
                    "guardian api_key_env `{name}` is unset or empty; sending unauthenticated"
                );
                None
            }
        }
    }
}

/// Why a `[guardian]` table cannot be used as written.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GuardianConfigError {
    /// `mode = "api"` without an `endpoint` to send to.
    MissingEndpoint,
    /// `endpoint` is set but unusable.
    Endpoint(ApiEndpointError),
}

impl std::fmt::Display for GuardianConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MissingEndpoint => {
                write!(f, "`[guardian] mode = \"api\"` requires `endpoint`")
            }
            Self::Endpoint(err) => write!(f, "`[guardian] endpoint` is unusable: {err}"),
        }
    }
}

impl std::error::Error for GuardianConfigError {}

/// Selects the guardian implementation for a process.
///
/// Mirrors how the thread store is chosen from config: core depends only on the
/// trait, and the deployment decides whether activity is written to local CSV
/// history, delegated to a local process over IPC, both, or dropped.
pub fn guardian_from_config(
    config: &GuardianConfig,
    codex_home: &Path,
    http_client_factory: &HttpClientFactory,
) -> Arc<dyn Guardian> {
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
        GuardianMode::Api => api_guardian(config, http_client_factory),
    }
}

/// Builds the REST guardian, or falls back to no guarding at all when it
/// cannot be built.
///
/// [`GuardianConfig::validate`] rejects both failure paths while config is
/// loading, so reaching the fallback means the guardian was constructed from a
/// config that never went through validation. It is logged at error rather
/// than silently swallowed, because the operator asked for enforcement and is
/// not getting it.
fn api_guardian(config: &GuardianConfig, factory: &HttpClientFactory) -> Arc<dyn Guardian> {
    let parsed = config
        .endpoint
        .as_deref()
        .ok_or(GuardianConfigError::MissingEndpoint)
        .and_then(|endpoint| ApiEndpoint::parse(endpoint).map_err(GuardianConfigError::Endpoint));
    let endpoint = match parsed {
        Ok(endpoint) => endpoint,
        Err(err) => {
            tracing::error!("guardian disabled: {err}");
            return Arc::new(NoopGuardian);
        }
    };
    match ApiGuardian::new(
        endpoint,
        factory,
        config.bearer_token(),
        config.request_timeout,
        config.fail_closed,
    ) {
        Ok(guardian) => Arc::new(guardian),
        Err(err) => {
            tracing::error!("guardian disabled: could not build an HTTP client: {err}");
            Arc::new(NoopGuardian)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::FailurePosture;
    use codex_http_client::OutboundProxyPolicy;

    fn test_factory() -> HttpClientFactory {
        HttpClientFactory::new(OutboundProxyPolicy::ReqwestDefault)
    }

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
            (
                GuardianMode::Api,
                /*enabled*/ true,
                FailurePosture::FailClosed,
            ),
        ];
        for (mode, enabled, posture) in cases {
            let config = GuardianConfig {
                mode,
                endpoint: Some("https://guardian.example/api".to_string()),
                ..GuardianConfig::default()
            };
            let guardian = guardian_from_config(&config, codex_home, &test_factory());
            assert_eq!(guardian.is_enabled(), enabled, "{mode:?}");
            assert_eq!(guardian.failure_posture(), posture, "{mode:?}");
        }
    }

    /// The operator asked for enforcement, so a mode that cannot enforce has to
    /// be caught while config is loading rather than at the first choke point.
    #[test]
    fn api_mode_requires_a_usable_endpoint() {
        let api = |endpoint: Option<&str>| GuardianConfig {
            mode: GuardianMode::Api,
            endpoint: endpoint.map(str::to_string),
            ..GuardianConfig::default()
        };

        assert_eq!(
            api(None).validate(),
            Err(GuardianConfigError::MissingEndpoint)
        );
        assert!(matches!(
            api(Some("not a url")).validate(),
            Err(GuardianConfigError::Endpoint(ApiEndpointError::Malformed(
                _
            )))
        ));
        assert!(matches!(
            api(Some("ftp://guardian.example")).validate(),
            Err(GuardianConfigError::Endpoint(
                ApiEndpointError::UnsupportedScheme(_)
            ))
        ));
        assert_eq!(api(Some("https://guardian.example/api")).validate(), Ok(()));

        // Every other mode ignores the field entirely.
        assert_eq!(
            GuardianConfig {
                mode: GuardianMode::Csv,
                endpoint: None,
                ..GuardianConfig::default()
            }
            .validate(),
            Ok(())
        );
    }

    /// An unbuildable REST guardian must not masquerade as a working one.
    #[tokio::test]
    async fn api_mode_without_an_endpoint_falls_back_to_no_guarding() {
        let config = GuardianConfig {
            mode: GuardianMode::Api,
            endpoint: None,
            ..GuardianConfig::default()
        };
        let guardian = guardian_from_config(&config, Path::new("/codex-home"), &test_factory());
        assert!(!guardian.is_enabled());
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

    /// The out-of-the-box configuration has to be one that works: a mode with
    /// somewhere to send to, an endpoint that stays on this machine, and a
    /// posture that does not admit an action nobody vetted.
    #[test]
    fn the_default_delegates_to_the_local_backend() {
        let defaults = GuardianConfig::default();
        assert_eq!(defaults.mode, GuardianMode::Api);
        assert_eq!(defaults.endpoint.as_deref(), Some(DEFAULT_ENDPOINT));
        assert!(defaults.fail_closed);
        assert_eq!(defaults.validate(), Ok(()));

        let endpoint = ApiEndpoint::parse(DEFAULT_ENDPOINT).expect("default endpoint parses");
        assert_eq!(
            endpoint.reviews().as_str(),
            "http://127.0.0.1:4500/guardian/v1/reviews"
        );
        assert_eq!(
            endpoint.activities().as_str(),
            "http://127.0.0.1:4500/guardian/v1/activities"
        );
        assert_eq!(
            endpoint.base().host_str(),
            Some("127.0.0.1"),
            "the default must not leave this machine"
        );
    }
}
