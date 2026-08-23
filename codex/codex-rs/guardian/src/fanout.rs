use std::sync::Arc;

use crate::Activity;
use crate::ActivityContext;
use crate::FailurePosture;
use crate::GuardedAction;
use crate::Guardian;
use crate::GuardianError;
use crate::GuardianFuture;
use crate::SandboxContext;
use crate::SandboxProfileOverride;
use crate::Verdict;

/// Runs several guardians as one — typically the CSV debug history alongside the
/// enforcing IPC guardian.
///
/// Decision rules, in order: any error propagates (so gates fail closed), the
/// first `Deny` wins immediately, otherwise the first `Rewrite` applies, and a
/// single `Allow` outranks `Defer`.
#[derive(Debug)]
pub struct FanOutGuardian {
    guardians: Vec<Arc<dyn Guardian>>,
}

impl FanOutGuardian {
    pub fn new(guardians: Vec<Arc<dyn Guardian>>) -> Self {
        Self { guardians }
    }
}

impl Guardian for FanOutGuardian {
    fn review<'a>(
        &'a self,
        ctx: &'a ActivityContext,
        action: &'a GuardedAction,
    ) -> GuardianFuture<'a, Result<Verdict, GuardianError>> {
        Box::pin(async move {
            let mut rewrite: Option<Verdict> = None;
            let mut allowed = false;
            for guardian in &self.guardians {
                match guardian.review(ctx, action).await? {
                    deny @ Verdict::Deny { .. } => return Ok(deny),
                    rewritten @ Verdict::Rewrite { .. } if rewrite.is_none() => {
                        rewrite = Some(rewritten);
                    }
                    Verdict::Allow => allowed = true,
                    Verdict::Rewrite { .. } | Verdict::Defer => {}
                }
            }
            Ok(match (rewrite, allowed) {
                (Some(rewrite), _) => rewrite,
                (None, true) => Verdict::Allow,
                (None, false) => Verdict::Defer,
            })
        })
    }

    fn record<'a>(
        &'a self,
        ctx: &'a ActivityContext,
        activity: &'a Activity,
    ) -> GuardianFuture<'a, ()> {
        Box::pin(async move {
            for guardian in &self.guardians {
                guardian.record(ctx, activity).await;
            }
        })
    }

    /// Enabled when any composed guardian is.
    fn is_enabled(&self) -> bool {
        self.guardians.iter().any(|guardian| guardian.is_enabled())
    }

    /// Fails closed if any composed guardian does.
    fn failure_posture(&self) -> FailurePosture {
        if self
            .guardians
            .iter()
            .any(|guardian| guardian.failure_posture() == FailurePosture::FailClosed)
        {
            FailurePosture::FailClosed
        } else {
            FailurePosture::FailOpen
        }
    }

    /// Returns the first override any composed guardian asks for.
    fn sandbox_override(&self, ctx: &SandboxContext<'_>) -> Option<SandboxProfileOverride> {
        self.guardians
            .iter()
            .find_map(|guardian| guardian.sandbox_override(ctx))
    }

    fn flush(&self) -> GuardianFuture<'_, ()> {
        Box::pin(async move {
            for guardian in &self.guardians {
                guardian.flush().await;
            }
        })
    }
}

#[cfg(test)]
#[path = "fanout_tests.rs"]
mod tests;
