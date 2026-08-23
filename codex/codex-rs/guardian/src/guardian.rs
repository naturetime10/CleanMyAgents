use std::future::Future;
use std::pin::Pin;

use crate::Activity;
use crate::ActivityContext;
use crate::FailurePosture;
use crate::GuardedAction;
use crate::GuardianError;
use crate::SandboxContext;
use crate::SandboxProfileOverride;
use crate::Verdict;

/// Boxed future returned by the object-safe [`Guardian`] methods.
pub type GuardianFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Inline reference monitor for one Codex process.
///
/// Implementations sit *above* the hook layer: [`Guardian::review`] is consulted
/// before any configured hook runs and its verdict cannot be overridden by hook
/// configuration, while [`Guardian::record`] is a log-only firehose that must
/// never block or fail an action. Both are called on the turn's async path, so
/// implementations must be non-blocking and bounded in time — do file or socket
/// I/O on a background task and give every remote call a deadline.
///
/// A single instance serves every session in the process; use
/// [`ActivityContext::thread_id`] to separate them.
pub trait Guardian: Send + Sync + std::fmt::Debug {
    /// Decides whether an action may proceed, before the hook layer sees it.
    ///
    /// Returning `Err` leaves the choice to the call site, which applies its
    /// fail posture: enforcing gates deny, recording taps continue.
    fn review<'a>(
        &'a self,
        ctx: &'a ActivityContext,
        action: &'a GuardedAction,
    ) -> GuardianFuture<'a, Result<Verdict, GuardianError>>;

    /// Records an activity that already happened. Errors are the
    /// implementation's to absorb; callers ignore failures here by design.
    fn record<'a>(
        &'a self,
        ctx: &'a ActivityContext,
        activity: &'a Activity,
    ) -> GuardianFuture<'a, ()>;

    /// Whether this guardian does anything at all.
    ///
    /// Call sites check this before building an [`ActivityContext`], so the
    /// default-off configuration costs one virtual call per choke point rather
    /// than an allocation. Only [`crate::NoopGuardian`] answers `false`.
    fn is_enabled(&self) -> bool {
        true
    }

    /// How call sites should react when [`Guardian::review`] fails. Enforcing
    /// implementations return [`FailurePosture::FailClosed`]; observe-only ones
    /// return [`FailurePosture::FailOpen`].
    fn failure_posture(&self) -> FailurePosture {
        FailurePosture::FailClosed
    }

    /// Optional containment tightening applied when sandbox permissions are
    /// resolved for a request. Synchronous because the sandbox decision is on a
    /// non-async path; implementations must answer from local state.
    fn sandbox_override(&self, _ctx: &SandboxContext<'_>) -> Option<SandboxProfileOverride> {
        None
    }

    /// Flushes pending records. Called once per session at session end.
    fn flush(&self) -> GuardianFuture<'_, ()> {
        Box::pin(async {})
    }
}
