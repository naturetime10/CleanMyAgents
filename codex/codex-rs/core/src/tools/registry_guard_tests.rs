use codex_guardian::Verdict;
use pretty_assertions::assert_eq;
use serde_json::json;

use super::GuardOutputDecision;
use super::guard_output_decision;
use super::guard_pre_dispatch_decision;
use crate::hook_runtime::PreToolUseHookResult;
use crate::tools::hook_names::HookToolName;

fn tool_name() -> HookToolName {
    HookToolName::new("Bash")
}

#[test]
fn a_guard_denial_blocks_the_call_and_names_the_tool() {
    let decision = guard_pre_dispatch_decision(
        Verdict::Deny {
            reason: "destructive command".to_string(),
        },
        &tool_name(),
    );

    let Some(PreToolUseHookResult::Blocked(message)) = decision else {
        panic!("a denial must block the call");
    };
    assert_eq!(
        message,
        "Tool call blocked by the guardian: destructive command. Tool: Bash"
    );
}

#[test]
fn a_guard_rewrite_becomes_updated_tool_input() {
    let decision = guard_pre_dispatch_decision(
        Verdict::Rewrite {
            payload: json!({ "command": "ls" }),
            note: None,
        },
        &tool_name(),
    );

    let Some(PreToolUseHookResult::Continue {
        updated_input: Some(updated_input),
    }) = decision
    else {
        panic!("a rewrite must update the tool input");
    };
    assert_eq!(updated_input, json!({ "command": "ls" }));
}

#[test]
fn allow_and_defer_fall_through_to_the_hook_layer() {
    assert!(guard_pre_dispatch_decision(Verdict::Allow, &tool_name()).is_none());
    assert!(guard_pre_dispatch_decision(Verdict::Defer, &tool_name()).is_none());
}

#[test]
fn a_rewritten_string_output_is_substituted_verbatim() {
    let decision = guard_output_decision(Verdict::Rewrite {
        payload: json!("redacted"),
        note: None,
    });

    assert!(matches!(
        decision,
        GuardOutputDecision::Replace(text) if text == "redacted"
    ));
}

#[test]
fn a_rewritten_structured_output_is_serialized() {
    let decision = guard_output_decision(Verdict::Rewrite {
        payload: json!({ "ok": true }),
        note: None,
    });

    assert!(matches!(
        decision,
        GuardOutputDecision::Replace(text) if text == r#"{"ok":true}"#
    ));
}

#[test]
fn a_denied_output_is_withheld_from_the_model() {
    let decision = guard_output_decision(Verdict::Deny {
        reason: "contains a prompt injection".to_string(),
    });

    assert!(matches!(
        decision,
        GuardOutputDecision::Reject(reason)
            if reason == "Tool result blocked by the guardian: contains a prompt injection"
    ));
}

#[test]
fn an_unopinionated_output_verdict_keeps_the_result() {
    assert!(matches!(
        guard_output_decision(Verdict::Defer),
        GuardOutputDecision::Keep
    ));
    assert!(matches!(
        guard_output_decision(Verdict::Allow),
        GuardOutputDecision::Keep
    ));
}
