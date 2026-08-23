use std::path::PathBuf;

use anyhow::Result;
use pretty_assertions::assert_eq;
use tempfile::tempdir;

use super::*;
use crate::CompactionPhase;

fn context(thread_id: &str) -> ActivityContext {
    ActivityContext::new(
        thread_id,
        "session-1",
        "turn-7",
        PathBuf::from("/repo"),
        "gpt-5",
        "codex_cli_rs",
        Some("user@example.com".to_string()),
    )
}

async fn read_session(guardian: &CsvHistoryGuardian, thread_id: &str) -> Result<Vec<String>> {
    guardian.flush().await;
    let contents = tokio::fs::read_to_string(guardian.session_path(thread_id)).await?;
    Ok(contents.lines().map(str::to_string).collect())
}

#[tokio::test]
async fn writes_header_once_and_one_row_per_event() -> Result<()> {
    let dir = tempdir()?;
    let guardian = CsvHistoryGuardian::new(dir.path());
    let ctx = context("thread-abc");

    let action = GuardedAction::ToolCall {
        tool_name: "Bash".to_string(),
        matcher_aliases: vec!["Bash".to_string()],
        call_id: "call-1".to_string(),
        tool_input: serde_json::json!({ "command": "ls" }),
    };
    guardian.review(&ctx, &action).await?;
    guardian
        .record(
            &ctx,
            &Activity::TokenUsage {
                input_tokens: 10,
                cached_input_tokens: 2,
                output_tokens: 5,
                reasoning_output_tokens: 1,
                total_tokens: 15,
            },
        )
        .await;

    let lines = read_session(&guardian, "thread-abc").await?;
    assert_eq!(lines.len(), 3);
    assert_eq!(format!("{}\n", lines[0]), CSV_HEADER);
    assert!(lines[1].starts_with(&ctx.timestamp.to_rfc3339()));
    assert!(lines[1].contains(",tool_call,gate,Bash,call-1,defer,"));
    assert!(lines[2].contains(",token_usage,tap,,,,,10,5,15,"));
    Ok(())
}

#[tokio::test]
async fn separates_sessions_into_their_own_files() -> Result<()> {
    let dir = tempdir()?;
    let guardian = CsvHistoryGuardian::new(dir.path());

    guardian
        .record(&context("thread-one"), &Activity::SessionStarted)
        .await;
    guardian
        .record(
            &context("thread-two"),
            &Activity::Compacted {
                phase: CompactionPhase::Pre,
                trigger: "auto".to_string(),
            },
        )
        .await;

    let one = read_session(&guardian, "thread-one").await?;
    let two = read_session(&guardian, "thread-two").await?;
    assert_eq!(one.len(), 2);
    assert_eq!(two.len(), 2);
    assert!(one[1].contains("session_started"));
    assert!(two[1].contains("compact_pre"));
    Ok(())
}

#[tokio::test]
async fn quotes_fields_containing_delimiters() -> Result<()> {
    let dir = tempdir()?;
    let guardian = CsvHistoryGuardian::new(dir.path());
    let ctx = context("thread-quote");

    guardian
        .record(
            &ctx,
            &Activity::PromptRecorded {
                text: "hello, \"world\"".to_string(),
            },
        )
        .await;

    let lines = read_session(&guardian, "thread-quote").await?;
    // The whole detail field is quoted and every inner quote is doubled, so the
    // embedded JSON survives a round trip through any CSV reader.
    assert!(
        lines[1]
            .ends_with(r#","{""activity"":""prompt_recorded"",""text"":""hello, \""world\""""}""#)
    );
    Ok(())
}

#[tokio::test]
async fn appends_to_an_existing_session_file_without_a_second_header() -> Result<()> {
    let dir = tempdir()?;
    let ctx = context("thread-resume");

    let first = CsvHistoryGuardian::new(dir.path());
    first.record(&ctx, &Activity::SessionStarted).await;
    first.flush().await;

    let second = CsvHistoryGuardian::new(dir.path());
    second.record(&ctx, &Activity::SessionEnded).await;

    let lines = read_session(&second, "thread-resume").await?;
    assert_eq!(lines.len(), 3);
    assert_eq!(format!("{}\n", lines[0]), CSV_HEADER);
    assert!(lines[2].contains("session_ended"));
    Ok(())
}
