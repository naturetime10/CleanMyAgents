//! End-to-end coverage for the guard layer wired into `codex-core`.
//!
//! These tests run a real session with the local-history guardian selected from
//! config, then read the per-session CSV file it writes.

use std::path::Path;
use std::path::PathBuf;
use std::time::Duration;

use anyhow::Result;
use codex_guardian::CSV_HEADER;
use codex_guardian::GuardianConfig;
use codex_guardian::GuardianMode;
use core_test_support::fs_wait::wait_for_path_exists;
use core_test_support::responses::ev_assistant_message;
use core_test_support::responses::ev_completed;
use core_test_support::responses::ev_response_created;
use core_test_support::responses::mount_sse_once;
use core_test_support::responses::sse;
use core_test_support::responses::start_mock_server;
use core_test_support::skip_if_no_network;
use core_test_support::test_codex::test_codex;
use pretty_assertions::assert_eq;

const WAIT: Duration = Duration::from_secs(10);

fn session_csv_path(codex_home: &Path, thread_id: &str) -> PathBuf {
    codex_home
        .join("guardian")
        .join("debug")
        .join(format!("{thread_id}.csv"))
}

/// Reads the session file once it has at least `expected` activity rows.
async fn read_rows(path: &Path, expected: usize) -> Result<Vec<String>> {
    wait_for_path_exists(path.to_path_buf(), WAIT).await?;
    let deadline = tokio::time::Instant::now() + WAIT;
    loop {
        let contents = tokio::fs::read_to_string(path).await?;
        let rows: Vec<String> = contents.lines().skip(1).map(str::to_string).collect();
        if rows.len() >= expected || tokio::time::Instant::now() >= deadline {
            return Ok(rows);
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

fn kind_of(row: &str) -> &str {
    // ts,thread_id,session_id,turn_id,kind,...
    row.split(',').nth(4).unwrap_or_default()
}

#[tokio::test]
async fn csv_history_records_session_prompt_and_token_activity() -> Result<()> {
    skip_if_no_network!(Ok(()));

    let server = start_mock_server().await;
    mount_sse_once(
        &server,
        sse(vec![
            ev_response_created("resp-1"),
            ev_assistant_message("msg-1", "hello back"),
            ev_completed("resp-1"),
        ]),
    )
    .await;

    let mut builder = test_codex().with_config(|config| {
        config.guardian = GuardianConfig {
            mode: GuardianMode::Csv,
            ..GuardianConfig::default()
        };
    });
    let test = builder.build(&server).await?;
    let csv_path = session_csv_path(
        test.codex_home_path(),
        &test.session_configured.thread_id.to_string(),
    );

    test.submit_turn("hello guardian").await?;

    let rows = read_rows(&csv_path, /*expected*/ 4).await?;
    let kinds: Vec<&str> = rows.iter().map(|row| kind_of(row)).collect();

    // The header is written exactly once, before any activity row.
    let contents = tokio::fs::read_to_string(&csv_path).await?;
    assert!(contents.starts_with(CSV_HEADER));
    assert_eq!(contents.matches(CSV_HEADER).count(), 1);

    assert!(
        kinds.contains(&"session_started"),
        "session start should be recorded: {kinds:?}"
    );
    assert!(
        kinds.contains(&"prompt"),
        "the prompt gate should be recorded: {kinds:?}"
    );
    assert!(
        kinds.contains(&"prompt_recorded"),
        "the admitted prompt should be recorded: {kinds:?}"
    );
    assert!(
        kinds.contains(&"token_usage") || kinds.contains(&"context_window"),
        "token or context telemetry should be recorded: {kinds:?}"
    );

    // Every recorded row carries the session correlation columns.
    let thread_id = test.session_configured.thread_id.to_string();
    assert!(
        rows.iter().all(|row| row.contains(&thread_id)),
        "every row should carry its thread id"
    );

    // The prompt text reaches the audit detail column.
    assert!(
        rows.iter()
            .any(|row| row.contains("hello guardian") && kind_of(row) == "prompt"),
        "the reviewed prompt text should appear in the guard row"
    );

    Ok(())
}

#[tokio::test]
async fn guarding_is_off_by_default_and_writes_nothing() -> Result<()> {
    skip_if_no_network!(Ok(()));

    let server = start_mock_server().await;
    mount_sse_once(
        &server,
        sse(vec![
            ev_response_created("resp-1"),
            ev_assistant_message("msg-1", "hello back"),
            ev_completed("resp-1"),
        ]),
    )
    .await;

    let mut builder = test_codex();
    let test = builder.build(&server).await?;

    assert_eq!(test.config.guardian.mode, GuardianMode::Off);

    test.submit_turn("hello").await?;

    assert!(
        !test.codex_home_path().join("guardian").exists(),
        "the default configuration must not write a guardian directory"
    );

    Ok(())
}
