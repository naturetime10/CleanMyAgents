//! Inline reference monitor ("guard layer") for Codex sessions.
//!
//! The guard sits *above* the hook subsystem: `codex-core` consults a
//! [`Guardian`] at each dispatch choke point before any configured hook runs,
//! so a guard verdict cannot be overridden by hook configuration. Decision
//! precedence at a choke point is Guard -> Hooks -> Guardian review -> user.
//!
//! The trait is the only thing `codex-core` depends on; a deployment picks an
//! implementation with [`guardian_from_config`]:
//!
//! * [`NoopGuardian`] — monitoring disabled (the default).
//! * [`CsvHistoryGuardian`] — local history: every session activity is appended
//!   to a per-session CSV file inside a debug directory, beside a
//!   [`SessionMeta`] sidecar that says which session the file belongs to.
//! * [`IpcGuardian`] — relays every event to a resident local monitor process
//!   over a Unix domain socket and enforces the verdict it returns.
//! * [`FanOutGuardian`] — composes several of the above.

mod config;
mod csv_history;
mod event;
mod fanout;
mod guardian;
mod ipc;
mod noop;
mod row;
mod session_meta;
mod verdict;

pub use config::DEBUG_DIR;
pub use config::GUARDIAN_DIR;
pub use config::GuardianConfig;
pub use config::GuardianMode;
pub use config::SOCKET_FILE;
pub use config::guardian_from_config;
pub use csv_history::CSV_HEADER;
pub use csv_history::CsvHistoryGuardian;
pub use csv_history::configured_session_path;
pub use event::Activity;
pub use event::ActivityContext;
pub use event::CompactionPhase;
pub use event::GuardedAction;
pub use event::SandboxContext;
pub use event::SandboxProfileOverride;
pub use fanout::FanOutGuardian;
pub use guardian::Guardian;
pub use guardian::GuardianFuture;
pub use ipc::GuardianRequest;
pub use ipc::GuardianResponse;
pub use ipc::IpcGuardian;
pub use ipc::OwnedGuardianRequest;
pub use ipc::PROTOCOL_VERSION;
pub use noop::NoopGuardian;
pub use row::ActivityRow;
pub use session_meta::SESSION_META_SUFFIX;
pub use session_meta::SESSION_META_VERSION;
pub use session_meta::SessionMeta;
pub use session_meta::read_session_metas;
pub use verdict::FailurePosture;
pub use verdict::GuardianError;
pub use verdict::Verdict;
