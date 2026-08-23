use std::path::PathBuf;
use std::sync::Mutex;

use anyhow::Result;
use pretty_assertions::assert_eq;

use super::*;

fn context() -> ActivityContext {
    ActivityContext::new(
        "thread-fanout",
        "session-1",
        "turn-1",
        PathBuf::from("/repo"),
        "gpt-5",
        "codex_cli_rs",
        None,
    )
}

fn action() -> GuardedAction {
    GuardedAction::Prompt {
        text: "hello".to_string(),
    }
}

/// Guardian that answers with a fixed result and counts what it saw.
#[derive(Debug)]
struct StubGuardian {
    verdict: Result<Verdict, GuardianError>,
    posture: FailurePosture,
    recorded: Mutex<usize>,
}

impl StubGuardian {
    fn allowing(verdict: Verdict) -> Self {
        Self {
            verdict: Ok(verdict),
            posture: FailurePosture::FailOpen,
            recorded: Mutex::new(0),
        }
    }

    fn failing() -> Self {
        Self {
            verdict: Err(GuardianError::Timeout),
            posture: FailurePosture::FailClosed,
            recorded: Mutex::new(0),
        }
    }
}

impl Guardian for StubGuardian {
    fn review<'a>(
        &'a self,
        _ctx: &'a ActivityContext,
        _action: &'a GuardedAction,
    ) -> GuardianFuture<'a, Result<Verdict, GuardianError>> {
        let verdict = self.verdict.clone();
        Box::pin(async move { verdict })
    }

    fn record<'a>(
        &'a self,
        _ctx: &'a ActivityContext,
        _activity: &'a Activity,
    ) -> GuardianFuture<'a, ()> {
        Box::pin(async move {
            if let Ok(mut recorded) = self.recorded.lock() {
                *recorded += 1;
            }
        })
    }

    fn failure_posture(&self) -> FailurePosture {
        self.posture
    }
}

#[tokio::test]
async fn deny_beats_allow_and_rewrite() -> Result<()> {
    let fanout = FanOutGuardian::new(vec![
        Arc::new(StubGuardian::allowing(Verdict::Allow)),
        Arc::new(StubGuardian::allowing(Verdict::Deny {
            reason: "policy".to_string(),
        })),
        Arc::new(StubGuardian::allowing(Verdict::Rewrite {
            payload: serde_json::json!("rewritten"),
            note: None,
        })),
    ]);

    assert_eq!(
        fanout.review(&context(), &action()).await?,
        Verdict::Deny {
            reason: "policy".to_string()
        }
    );
    Ok(())
}

#[tokio::test]
async fn rewrite_beats_allow_and_allow_beats_defer() -> Result<()> {
    let rewriting = FanOutGuardian::new(vec![
        Arc::new(StubGuardian::allowing(Verdict::Defer)),
        Arc::new(StubGuardian::allowing(Verdict::Rewrite {
            payload: serde_json::json!("rewritten"),
            note: None,
        })),
        Arc::new(StubGuardian::allowing(Verdict::Allow)),
    ]);
    assert_eq!(
        rewriting.review(&context(), &action()).await?,
        Verdict::Rewrite {
            payload: serde_json::json!("rewritten"),
            note: None,
        }
    );

    let allowing = FanOutGuardian::new(vec![
        Arc::new(StubGuardian::allowing(Verdict::Defer)),
        Arc::new(StubGuardian::allowing(Verdict::Allow)),
    ]);
    assert_eq!(
        allowing.review(&context(), &action()).await?,
        Verdict::Allow
    );

    let deferring = FanOutGuardian::new(vec![Arc::new(StubGuardian::allowing(Verdict::Defer))]);
    assert_eq!(
        deferring.review(&context(), &action()).await?,
        Verdict::Defer
    );
    Ok(())
}

#[tokio::test]
async fn an_error_propagates_so_gates_can_fail_closed() -> Result<()> {
    let fanout = FanOutGuardian::new(vec![
        Arc::new(StubGuardian::allowing(Verdict::Allow)),
        Arc::new(StubGuardian::failing()),
    ]);

    let err = fanout
        .review(&context(), &action())
        .await
        .expect_err("a failing member must not be swallowed");
    assert_eq!(err, GuardianError::Timeout);
    assert_eq!(fanout.failure_posture(), FailurePosture::FailClosed);
    Ok(())
}

#[tokio::test]
async fn recording_reaches_every_member() -> Result<()> {
    let first = Arc::new(StubGuardian::allowing(Verdict::Defer));
    let second = Arc::new(StubGuardian::allowing(Verdict::Defer));
    let fanout = FanOutGuardian::new(vec![first.clone(), second.clone()]);

    fanout.record(&context(), &Activity::SessionStarted).await;

    assert_eq!(*first.recorded.lock().expect("lock"), 1);
    assert_eq!(*second.recorded.lock().expect("lock"), 1);
    Ok(())
}

#[tokio::test]
async fn a_fan_out_is_enabled_when_any_member_is() -> Result<()> {
    let disabled = FanOutGuardian::new(vec![Arc::new(crate::NoopGuardian)]);
    assert!(!disabled.is_enabled());

    let enabled = FanOutGuardian::new(vec![
        Arc::new(crate::NoopGuardian),
        Arc::new(StubGuardian::allowing(Verdict::Allow)),
    ]);
    assert!(enabled.is_enabled());
    Ok(())
}
