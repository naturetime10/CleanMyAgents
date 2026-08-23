//! End-to-end coverage for the guard layer wired into `codex-core`.
//!
//! These tests run a real session with the local-history guardian selected from
//! config, then read the per-session CSV file and metadata sidecar it writes.

use std::path::Path;
use std::path::PathBuf;
use std::time::Duration;

use anyhow::Result;
use codex_guardian::CSV_HEADER;
use codex_guardian::GuardianConfig;
use codex_guardian::GuardianMode;
use codex_guardian::SESSION_META_VERSION;
use codex_guardian::SessionMeta;
use codex_guardian::read_session_metas;
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

fn debug_dir(codex_home: &Path) -> PathBuf {
    codex_home.join("guardian").join("debug")
}

fn session_csv_path(codex_home: &Path, thread_id: &str) -> PathBuf {
    debug_dir(codex_home).join(format!("{thread_id}.csv"))
}

/// Reads the sidecar for `thread_id` once the scan can see it.
async fn read_meta(codex_home: &Path, thread_id: &str) -> Result<SessionMeta> {
    let dir = debug_dir(codex_home);
    let deadline = tokio::time::Instant::now() + WAIT;
    loop {
        let found = read_session_metas(&dir)
            .await?
            .into_iter()
            .find(|meta| meta.thread_id == thread_id);
        match found {
            Some(meta) => return Ok(meta),
            None if tokio::time::Instant::now() >= deadline => {
                anyhow::bail!("no session metadata for {thread_id} in {dir:?}")
            }
            None => tokio::time::sleep(Duration::from_millis(25)).await,
        }
    }
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
    // ts,turn_id,kind,...
    row.split(',').nth(2).unwrap_or_default()
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

    // Correlation lives in the sidecar, so no row repeats the thread id.
    let thread_id = test.session_configured.thread_id.to_string();
    assert!(
        rows.iter().all(|row| !row.contains(&thread_id)),
        "the thread id belongs to the sidecar, not to every row"
    );
    assert_eq!(
        read_meta(test.codex_home_path(), &thread_id)
            .await?
            .thread_id,
        thread_id
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
async fn session_metadata_sidecar_identifies_the_history_file() -> Result<()> {
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
    let thread_id = test.session_configured.thread_id.to_string();

    test.submit_turn("hello guardian").await?;
    read_rows(
        &session_csv_path(test.codex_home_path(), &thread_id),
        /*expected*/ 4,
    )
    .await?;

    let meta = read_meta(test.codex_home_path(), &thread_id).await?;
    assert_eq!(meta.schema_version, SESSION_META_VERSION);
    assert_eq!(meta.thread_id, thread_id);
    assert_eq!(
        meta.session_id,
        test.session_configured.session_id.to_string()
    );
    assert_eq!(meta.csv_file, format!("{thread_id}.csv"));

    // The model and originator are not columns in the history, so the sidecar
    // is the only place a reader can recover them.
    assert_eq!(meta.model, test.session_configured.model);
    assert!(
        !meta.originator.is_empty(),
        "the sidecar should name the originator"
    );
    assert!(meta.rows > 0, "the sidecar should count the rows written");

    Ok(())
}

/// Debug builds record without being configured to, so a developer running
/// from source has a session trail. Tests are debug builds, which is why this
/// asserts the recording default rather than the shipped one.
#[tokio::test]
async fn a_debug_build_records_history_without_being_configured() -> Result<()> {
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

    assert_eq!(test.config.guardian.mode, GuardianMode::Csv);

    test.submit_turn("hello").await?;

    let thread_id = test.session_configured.thread_id.to_string();
    let rows = read_rows(
        &session_csv_path(test.codex_home_path(), &thread_id),
        /*expected*/ 1,
    )
    .await?;
    assert!(!rows.is_empty(), "the default should record activity");

    Ok(())
}

#[tokio::test]
async fn turning_the_mode_off_writes_nothing() -> Result<()> {
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
            mode: GuardianMode::Off,
            ..GuardianConfig::default()
        };
    });
    let test = builder.build(&server).await?;

    test.submit_turn("hello").await?;

    assert!(
        !test.codex_home_path().join("guardian").exists(),
        "an explicitly disabled guard must not write a guardian directory"
    );

    Ok(())
}
