use crate::Activity;
use crate::ActivityContext;
use crate::FailurePosture;
use crate::GuardedAction;
use crate::Guardian;
use crate::GuardianError;
use crate::GuardianFuture;
use crate::Verdict;

/// The guardian used when guarding is disabled: every action is deferred and
/// nothing is recorded.
///
/// Keeping a real object here (instead of `Option<Arc<dyn Guardian>>`) means the
/// call sites in `codex-core` have one shape regardless of configuration.
#[derive(Clone, Copy, Debug, Default)]
pub struct NoopGuardian;

impl Guardian for NoopGuardian {
    fn review<'a>(
        &'a self,
        _ctx: &'a ActivityContext,
        _action: &'a GuardedAction,
    ) -> GuardianFuture<'a, Result<Verdict, GuardianError>> {
        Box::pin(async { Ok(Verdict::Defer) })
    }

    fn record<'a>(
        &'a self,
        _ctx: &'a ActivityContext,
        _activity: &'a Activity,
    ) -> GuardianFuture<'a, ()> {
        Box::pin(async {})
    }

    fn is_enabled(&self) -> bool {
        false
    }

    fn failure_posture(&self) -> FailurePosture {
        FailurePosture::FailOpen
    }
}
