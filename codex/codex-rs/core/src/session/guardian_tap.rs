//! Adapter between `codex-core` and the guard layer.
//!
//! Every guard gate and recording tap in core goes through the helpers here so
//! that no call site has to assemble an [`ActivityContext`] by hand, and so the
//! fail posture is applied in exactly one place.
//!
//! The guard is *not* a hook: [`review`] runs before the hook layer at each
//! choke point, and its verdict cannot be overridden by hook configuration.
//! Precedence at a choke point is Guard -> Hooks -> Guardian review -> user.

use std::sync::Arc;

use codex_guardian::Activity;
use codex_guardian::ActivityContext;
use codex_guardian::GuardedAction;
use codex_guardian::Verdict;

use crate::session::Session;
use crate::session::TurnContext;

/// Authenticated identity attached to every recorded event.
///
/// Hook payloads carry session/turn correlation but never say *who* ran the
/// action, so this is resolved once at session start and stamped onto each
/// event.
#[derive(Clone, Debug, Default)]
pub(crate) struct GuardianIdentity {
    pub(crate) originator: String,
    pub(crate) account: Option<String>,
}

/// Builds the correlation + identity envelope for one event.
pub(crate) fn activity_context(sess: &Session, turn_context: &TurnContext) -> ActivityContext {
    let identity = &sess.services.guardian_identity;
    ActivityContext::new(
        sess.thread_id.to_string(),
        sess.session_id().to_string(),
        turn_context.sub_id.clone(),
        #[allow(deprecated)]
        turn_context.cwd.to_path_buf(),
        turn_context.model_info.slug.clone(),
        identity.originator.clone(),
        identity.account.clone(),
    )
}

/// Asks the guard to decide on `action`, applying the configured fail posture
/// when the guard cannot answer.
///
/// A `FailClosed` guardian that is unreachable yields [`Verdict::Deny`], so an
/// outage blocks the action instead of silently admitting it.
pub(crate) async fn review(
    sess: &Session,
    turn_context: &TurnContext,
    action: GuardedAction,
) -> Verdict {
    let guardian = Arc::clone(&sess.services.guardian);
    if !guardian.is_enabled() {
        return Verdict::Defer;
    }
    let ctx = activity_context(sess, turn_context);
    match guardian.review(&ctx, &action).await {
        Ok(verdict) => verdict,
        Err(err) => {
            tracing::warn!("guardian review failed: {err}");
            Verdict::on_error(&err, guardian.failure_posture())
        }
    }
}

/// Records an activity. Log-only: failures never affect the turn.
pub(crate) async fn record(sess: &Session, turn_context: &TurnContext, activity: Activity) {
    let guardian = Arc::clone(&sess.services.guardian);
    if !guardian.is_enabled() {
        return;
    }
    let ctx = activity_context(sess, turn_context);
    guardian.record(&ctx, &activity).await;
}

/// Asks the guard to decide on an action that has no turn attached (session
/// scope), applying the configured fail posture.
pub(crate) async fn review_session(sess: &Session, action: GuardedAction) -> Verdict {
    let guardian = Arc::clone(&sess.services.guardian);
    if !guardian.is_enabled() {
        return Verdict::Defer;
    }
    let ctx = session_context(sess);
    match guardian.review(&ctx, &action).await {
        Ok(verdict) => verdict,
        Err(err) => {
            tracing::warn!("guardian review failed: {err}");
            Verdict::on_error(&err, guardian.failure_posture())
        }
    }
}

/// Records an activity that has no turn attached (session lifecycle).
pub(crate) async fn record_session(sess: &Session, activity: Activity) {
    let guardian = Arc::clone(&sess.services.guardian);
    if !guardian.is_enabled() {
        return;
    }
    let ctx = session_context(sess);
    guardian.record(&ctx, &activity).await;
}

/// Context for session-scoped events, which have no turn or model attached.
fn session_context(sess: &Session) -> ActivityContext {
    let identity = &sess.services.guardian_identity;
    ActivityContext::new(
        sess.thread_id.to_string(),
        sess.session_id().to_string(),
        String::new(),
        std::path::PathBuf::new(),
        String::new(),
        identity.originator.clone(),
        identity.account.clone(),
    )
}
