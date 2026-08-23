//! Inline reference monitor ("guard layer") for Codex sessions.
//!
//! The guard sits *above* the hook subsystem: `codex-core` consults a
//! [`Guardian`] at each dispatch choke point before any configured hook runs,
//! so a guard verdict cannot be overridden by hook configuration. Decision
//! precedence at a choke point is Guard -> Hooks -> Guardian review -> user.
//!
//! The trait is the only thing `codex-core` depends on; a deployment picks an
//! implementation with [`guardian_from_config`]. This crate ships
//! [`NoopGuardian`], the implementation used when guarding is disabled.

mod config;
mod event;
mod guardian;
mod noop;
mod verdict;

pub use config::GUARDIAN_DIR;
pub use config::GuardianConfig;
pub use config::GuardianMode;
pub use config::guardian_from_config;
pub use event::Activity;
pub use event::ActivityContext;
pub use event::CompactionPhase;
pub use event::GuardedAction;
pub use event::SandboxContext;
pub use event::SandboxProfileOverride;
pub use guardian::Guardian;
pub use guardian::GuardianFuture;
pub use noop::NoopGuardian;
pub use verdict::FailurePosture;
pub use verdict::GuardianError;
pub use verdict::Verdict;
