use std::path::PathBuf;

use anyhow::Result;
use pretty_assertions::assert_eq;
use tempfile::tempdir;

use super::*;
use crate::Activity;
use crate::ActivityContext;
use crate::ActivityRow;
use crate::CompactionPhase;
use crate::CsvHistoryGuardian;
use crate::GuardedAction;
use crate::Guardian;
use crate::Verdict;

fn context(thread_id: &str, session_id: &str) -> ActivityContext {
    ActivityContext::new(
        thread_id,
        session_id,
        "turn-7",
        PathBuf::from("/repo"),
        "gpt-5",
        "codex_cli_rs",
        Some("user@example.com".to_string()),
    )
}

async fn read_meta(guardian: &CsvHistoryGuardian, thread_id: &str) -> Result<SessionMeta> {
    guardian.flush().await;
    let body = tokio::fs::read(guardian.session_meta_path(thread_id)).await?;
    Ok(serde_yaml::from_slice(&body)?)
}

#[tokio::test]
async fn sidecar_names_the_session_the_history_file_belongs_to() -> Result<()> {
    let dir = tempdir()?;
    let guardian = CsvHistoryGuardian::new(dir.path());
    let ctx = context("thread-abc", "session-1");

    guardian.record(&ctx, &Activity::SessionStarted).await;

    let meta = read_meta(&guardian, "thread-abc").await?;
    assert_eq!(meta.schema_version, SESSION_META_VERSION);
    assert_eq!(meta.session_id, "session-1");
    assert_eq!(meta.thread_id, "thread-abc");
    assert_eq!(meta.csv_file, "thread-abc.csv");
    assert_eq!(meta.first_activity_at, ctx.timestamp.to_rfc3339());
    Ok(())
}

#[tokio::test]
async fn sidecar_keeps_identity_the_csv_columns_drop() -> Result<()> {
    let dir = tempdir()?;
    let guardian = CsvHistoryGuardian::new(dir.path());
    let ctx = context("thread-abc", "session-1");

    guardian.record(&ctx, &Activity::SessionStarted).await;

    let meta = read_meta(&guardian, "thread-abc").await?;
    assert_eq!(meta.model, "gpt-5");
    assert_eq!(meta.originator, "codex_cli_rs");
    assert_eq!(meta.account, "user@example.com");
    assert_eq!(meta.cwd, "/repo");
    Ok(())
}

#[tokio::test]
async fn counters_track_rows_turns_and_latest_token_total() -> Result<()> {
    let dir = tempdir()?;
    let guardian = CsvHistoryGuardian::new(dir.path());
    let ctx = context("thread-abc", "session-1");

    for total in [15, 40] {
        guardian
            .record(
                &ctx,
                &Activity::TokenUsage {
                    input_tokens: 10,
                    cached_input_tokens: 2,
                    output_tokens: 5,
                    reasoning_output_tokens: 1,
                    total_tokens: total,
                },
            )
            .await;
        guardian
            .record(
                &ctx,
                &Activity::TurnStopped {
                    last_assistant_message: None,
                },
            )
            .await;
    }

    let meta = read_meta(&guardian, "thread-abc").await?;
    assert_eq!(meta.rows, 4);
    assert_eq!(meta.turns, 2);
    // Token usage is reported cumulatively, so the sidecar keeps the latest
    // value rather than summing the reports.
    assert_eq!(meta.tokens_total, 40);
    Ok(())
}

#[tokio::test]
async fn ended_at_is_stamped_only_once_the_session_ends() -> Result<()> {
    let dir = tempdir()?;
    let guardian = CsvHistoryGuardian::new(dir.path());
    let ctx = context("thread-abc", "session-1");

    guardian.record(&ctx, &Activity::SessionStarted).await;
    assert_eq!(read_meta(&guardian, "thread-abc").await?.ended_at, None);

    guardian.record(&ctx, &Activity::SessionEnded).await;

    let meta = read_meta(&guardian, "thread-abc").await?;
    assert_eq!(meta.ended_at, Some(ctx.timestamp.to_rfc3339()));
    Ok(())
}

#[tokio::test]
async fn sibling_threads_are_grouped_by_their_shared_session_id() -> Result<()> {
    let dir = tempdir()?;
    let guardian = CsvHistoryGuardian::new(dir.path());

    for thread_id in ["thread-root", "thread-child"] {
        guardian
            .record(&context(thread_id, "session-1"), &Activity::SessionStarted)
            .await;
    }
    guardian
        .record(
            &context("thread-other", "session-2"),
            &Activity::SessionStarted,
        )
        .await;
    guardian.flush().await;

    let metas = read_session_metas(dir.path()).await?;
    assert_eq!(metas.len(), 3);
    let mut in_session_1: Vec<&str> = metas
        .iter()
        .filter(|meta| meta.session_id == "session-1")
        .map(|meta| meta.thread_id.as_str())
        .collect();
    in_session_1.sort_unstable();
    assert_eq!(in_session_1, vec!["thread-child", "thread-root"]);
    Ok(())
}

#[tokio::test]
async fn scanning_skips_unparseable_sidecars_and_missing_directories() -> Result<()> {
    let dir = tempdir()?;
    let guardian = CsvHistoryGuardian::new(dir.path());
    guardian
        .record(
            &context("thread-abc", "session-1"),
            &Activity::SessionStarted,
        )
        .await;
    guardian.flush().await;

    tokio::fs::write(
        dir.path().join(format!("truncated{SESSION_META_SUFFIX}")),
        b"schema_version: [unterminated\n",
    )
    .await?;

    let metas = read_session_metas(dir.path()).await?;
    assert_eq!(metas.len(), 1);
    assert_eq!(metas[0].thread_id, "thread-abc");

    assert!(
        read_session_metas(&dir.path().join("absent"))
            .await?
            .is_empty()
    );
    Ok(())
}

#[tokio::test]
async fn the_sidecar_is_yaml_and_names_the_history_file() -> Result<()> {
    let dir = tempdir()?;
    let guardian = CsvHistoryGuardian::new(dir.path());
    let ctx = context("thread-abc", "session-1");

    guardian.record(&ctx, &Activity::SessionStarted).await;
    guardian.flush().await;

    let path = guardian.session_meta_path("thread-abc");
    assert!(
        path.to_string_lossy().ends_with(".meta.yml"),
        "sidecar should be a .yml file: {path:?}"
    );

    let body = tokio::fs::read_to_string(&path).await?;
    assert!(
        body.starts_with("schema_version: 1\n"),
        "unexpected: {body}"
    );
    assert!(body.contains("thread_id: thread-abc"));
    assert!(!body.contains('{'), "yaml should not be json: {body}");
    Ok(())
}

#[tokio::test]
async fn the_history_rows_do_not_repeat_what_the_sidecar_owns() -> Result<()> {
    let dir = tempdir()?;
    let guardian = CsvHistoryGuardian::new(dir.path());
    let ctx = context("thread-abc", "session-1");

    guardian.record(&ctx, &Activity::SessionStarted).await;
    guardian.flush().await;

    let csv = tokio::fs::read_to_string(guardian.session_path("thread-abc")).await?;
    for owned in [
        "thread-abc",
        "session-1",
        "user@example.com",
        &PathBuf::from("/repo").display().to_string(),
    ] {
        assert!(
            !csv.contains(owned),
            "{owned:?} belongs to the sidecar, not to every row: {csv}"
        );
    }

    // The sidecar still has all of it.
    let meta = read_meta(&guardian, "thread-abc").await?;
    assert_eq!(meta.thread_id, "thread-abc");
    assert_eq!(meta.session_id, "session-1");
    assert_eq!(meta.account, "user@example.com");
    assert_eq!(meta.cwd, "/repo");
    Ok(())
}

/// Every `GuardedAction` variant, with the label the CSV should carry for it.
fn every_action() -> Vec<(&'static str, GuardedAction)> {
    vec![
        (
            "prompt",
            GuardedAction::Prompt {
                text: "hello".to_string(),
            },
        ),
        (
            "tool_call",
            GuardedAction::ToolCall {
                tool_name: "Bash".to_string(),
                matcher_aliases: vec!["Bash".to_string()],
                call_id: "call-1".to_string(),
                tool_input: serde_json::json!({ "command": "ls" }),
            },
        ),
        (
            "tool_output",
            GuardedAction::ToolOutput {
                tool_name: "Bash".to_string(),
                call_id: "call-1".to_string(),
                tool_input: serde_json::json!({ "command": "ls" }),
                tool_response: serde_json::json!({ "stdout": "a\nb" }),
            },
        ),
        (
            "approval",
            GuardedAction::Approval {
                tool_name: "Bash".to_string(),
                run_id: "run-1".to_string(),
                tool_input: serde_json::json!({ "command": "rm -rf /" }),
            },
        ),
        (
            "mcp_admission",
            GuardedAction::McpAdmission {
                server_name: "docs".to_string(),
                connector_id: Some("conn-1".to_string()),
            },
        ),
        (
            "compaction",
            GuardedAction::Compaction {
                trigger: "auto".to_string(),
            },
        ),
    ]
}

/// Every `Activity` variant, with the label the CSV should carry for it.
fn every_activity() -> Vec<(&'static str, Activity)> {
    vec![
        ("session_started", Activity::SessionStarted),
        (
            "turn_stopped",
            Activity::TurnStopped {
                last_assistant_message: Some("done".to_string()),
            },
        ),
        (
            "prompt_recorded",
            Activity::PromptRecorded {
                text: "hello".to_string(),
            },
        ),
        (
            "tool_call_completed",
            Activity::ToolCallCompleted {
                tool_name: "Bash".to_string(),
                call_id: "call-1".to_string(),
                success: true,
                tool_response: serde_json::json!({ "stdout": "ok" }),
            },
        ),
        (
            "approval_resolved",
            Activity::ApprovalResolved {
                tool_name: "Bash".to_string(),
                call_id: "call-1".to_string(),
                decision: "approved".to_string(),
                source: "user".to_string(),
            },
        ),
        (
            "token_usage",
            Activity::TokenUsage {
                input_tokens: 10,
                cached_input_tokens: 2,
                output_tokens: 5,
                reasoning_output_tokens: 1,
                total_tokens: 17,
            },
        ),
        (
            "context_window",
            Activity::ContextWindow {
                active_context_tokens: 100,
                full_context_window_limit: Some(1000),
                base_window_tokens_remaining: Some(900),
                limit_reached: false,
            },
        ),
        (
            "compacted",
            Activity::Compacted {
                phase: CompactionPhase::Pre,
                trigger: "auto".to_string(),
            },
        ),
        (
            "hook_completed",
            Activity::HookCompleted {
                hook_event: "PreToolUse".to_string(),
                handler: "lint".to_string(),
                status: "ok".to_string(),
                duration_ms: Some(12),
            },
        ),
        ("session_ended", Activity::SessionEnded),
    ]
}

/// Drives every gate and every tap through the recording guardian, so a new
/// `GuardedAction` or `Activity` variant that nothing maps cannot slip through.
#[tokio::test]
async fn every_action_and_activity_reaches_the_history() -> Result<()> {
    let dir = tempdir()?;
    let guardian = CsvHistoryGuardian::new(dir.path());
    let ctx = context("thread-abc", "session-1");

    let mut expected = Vec::new();
    for (kind, action) in every_action() {
        // Recording never enforces, whatever the action.
        assert_eq!(guardian.review(&ctx, &action).await?, Verdict::Defer);
        expected.push(kind);
    }
    for (kind, activity) in every_activity() {
        guardian.record(&ctx, &activity).await;
        expected.push(kind);
    }

    guardian.flush().await;
    let csv = tokio::fs::read_to_string(guardian.session_path("thread-abc")).await?;
    let rows: Vec<&str> = csv.lines().skip(1).collect();
    assert_eq!(rows.len(), expected.len());

    let kinds: Vec<&str> = rows
        .iter()
        .map(|row| row.split(',').nth(2).unwrap_or_default())
        .collect();
    assert_eq!(kinds, expected);

    let meta = read_meta(&guardian, "thread-abc").await?;
    assert_eq!(meta.rows as usize, expected.len());
    assert_eq!(meta.turns, 1);
    assert_eq!(meta.tokens_total, 17);
    assert!(meta.ended_at.is_some(), "session_ended should be stamped");
    Ok(())
}

/// The observe-only guardian admits everything, but the row still records
/// whatever verdict was reached, so the other verdict shapes have to render.
#[tokio::test]
async fn every_verdict_shape_renders_a_decision_column() -> Result<()> {
    let ctx = context("thread-abc", "session-1");
    let action = GuardedAction::Prompt {
        text: "hello".to_string(),
    };

    let cases = [
        (Verdict::Allow, "allow", ""),
        (
            Verdict::Deny {
                reason: "nope".to_string(),
            },
            "deny",
            "nope",
        ),
        (
            Verdict::Rewrite {
                payload: serde_json::json!("redacted"),
                note: Some("scrubbed".to_string()),
            },
            "rewrite",
            "scrubbed",
        ),
        (Verdict::Defer, "defer", ""),
    ];
    for (verdict, decision, reason) in cases {
        let row = ActivityRow::for_action(&ctx, &action, &verdict);
        assert_eq!(row.decision, decision);
        assert_eq!(row.reason, reason);
    }
    Ok(())
}
