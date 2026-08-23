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
use core_test_support::test_codex::TurnInputRequest;
use core_test_support::test_codex::test_codex;
use core_test_support::wait_for_event_with_timeout;
use codex_protocol::protocol::EventMsg;
use codex_protocol::protocol::GuardianDecision;
use codex_protocol::protocol::GuardianVerdictEvent;
use codex_protocol::user_input::UserInput;
use pretty_assertions::assert_eq;
use wiremock::Mock;
use wiremock::MockServer;
use wiremock::ResponseTemplate;
use wiremock::matchers::method;
use wiremock::matchers::path;
use wiremock::matchers::path_regex;

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

/// The out-of-the-box default is the REST backend, and it is fail-closed. With
/// nothing listening on the default loopback endpoint, that posture is what
/// decides the turn -- this pins down what an unconfigured session actually
/// does so the behaviour cannot change unnoticed.
#[tokio::test]
async fn the_default_delegates_to_the_rest_backend() -> Result<()> {
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

    assert_eq!(test.config.guardian.mode, GuardianMode::Api);
    assert!(test.config.guardian.fail_closed);

    test.codex
        .start_or_steer_turn(TurnInputRequest::user_input(vec![UserInput::Text {
            text: "hello".into(),
            text_elements: Vec::new(),
        }]))
        .await?;

    let verdicts = collect_verdicts(&test.codex).await;

    // Nothing is listening on the default endpoint, so the fail-closed posture
    // denies the prompt and says so rather than admitting it silently.
    assert!(
        verdicts.iter().any(|verdict| {
            verdict.decision == GuardianDecision::Denied
                && verdict.action == "prompt"
                && verdict.reason.is_some()
        }),
        "an unreachable fail-closed guardian should deny and explain: {verdicts:?}"
    );
    assert!(
        !test.codex_home_path().join("guardian").join("debug").exists(),
        "the REST default should not write local CSV history"
    );

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

/// The REST guardian has to reach the backend at `{endpoint}/v1/reviews`, under
/// whatever path prefix the endpoint carries, for every guard gate a turn goes
/// through -- not only in the client's own unit tests, but with the guardian
/// selected from config and wired into a real session.
#[tokio::test]
async fn api_mode_submits_guarded_actions_to_the_reviews_endpoint() -> Result<()> {
    skip_if_no_network!(Ok(()));

    let guardian_server = MockServer::start().await;
    mount_reviews(&guardian_server, serde_json::json!({ "decision": "allow" })).await;
    mount_activities(&guardian_server).await;

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

    // A prefixed base proves the client joins under the configured path rather
    // than posting to the host root.
    let endpoint = format!("{}/guardian", guardian_server.uri());
    let mut builder = test_codex().with_config(move |config| {
        config.guardian = GuardianConfig {
            mode: GuardianMode::Api,
            endpoint: Some(endpoint.clone()),
            ..GuardianConfig::default()
        };
    });
    let test = builder.build(&server).await?;

    test.submit_turn("hello guardian").await?;

    let reviews = reviews_received(&guardian_server).await;
    assert!(
        !reviews.is_empty(),
        "the session should have submitted at least one review"
    );

    let prompt = reviews
        .iter()
        .find(|body| body["action"]["action"] == "prompt")
        .unwrap_or_else(|| panic!("no prompt review among {reviews:#?}"));
    assert_eq!(prompt["action"]["text"], "hello guardian");
    assert_eq!(
        prompt["context"]["thread_id"],
        test.session_configured.thread_id.to_string()
    );
    assert_eq!(prompt["context"]["model"], test.session_configured.model);

    Ok(())
}

/// A verdict the backend returns has to actually take effect, and the user has
/// to be told: a guard that decides silently is indistinguishable from one that
/// is not running.
#[tokio::test]
async fn a_denied_prompt_is_blocked_and_reported_with_its_reason() -> Result<()> {
    skip_if_no_network!(Ok(()));

    let guardian_server = MockServer::start().await;
    mount_reviews(
        &guardian_server,
        serde_json::json!({ "decision": "deny", "reason": "leaks a credential" }),
    )
    .await;
    mount_activities(&guardian_server).await;

    // Deliberately left unmounted: a denied prompt must never reach the model,
    // so any request here fails the turn rather than being answered.
    let server = start_mock_server().await;

    let endpoint = guardian_server.uri();
    let mut builder = test_codex().with_config(move |config| {
        config.guardian = GuardianConfig {
            mode: GuardianMode::Api,
            endpoint: Some(endpoint.clone()),
            ..GuardianConfig::default()
        };
    });
    let test = builder.build(&server).await?;

    test.codex
        .start_or_steer_turn(TurnInputRequest::user_input(vec![UserInput::Text {
            text: "here is my api key".into(),
            text_elements: Vec::new(),
        }]))
        .await?;

    let verdicts = collect_verdicts(&test.codex).await;

    assert!(
        verdicts.contains(&GuardianVerdictEvent {
            decision: GuardianDecision::Denied,
            action: "prompt".to_string(),
            tool: None,
            reason: Some("leaks a credential".to_string()),
        }),
        "the verdict and its reason should be reported to the user: {verdicts:?}"
    );
    assert!(
        server.received_requests().await.unwrap_or_default().is_empty(),
        "a denied prompt must not reach the model"
    );

    Ok(())
}

/// Answers every review with `verdict`, and records the request for inspection.
async fn mount_reviews(server: &MockServer, verdict: serde_json::Value) {
    Mock::given(method("POST"))
        .and(path("/v1/reviews"))
        .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
            "review_id": "rev-1",
            "status": "decided",
            "verdict": verdict,
        })))
        .mount(server)
        .await;
    Mock::given(method("POST"))
        .and(path("/guardian/v1/reviews"))
        .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
            "review_id": "rev-1",
            "status": "decided",
            "verdict": verdict,
        })))
        .mount(server)
        .await;
}

/// Recording is log-only; it just has to not fail loudly.
async fn mount_activities(server: &MockServer) {
    Mock::given(method("POST"))
        .and(path_regex(r".*/v1/activities$"))
        .respond_with(ResponseTemplate::new(204))
        .mount(server)
        .await;
}

/// The bodies of every review the session submitted, in arrival order.
async fn reviews_received(server: &MockServer) -> Vec<serde_json::Value> {
    server
        .received_requests()
        .await
        .unwrap_or_default()
        .iter()
        .filter(|request| request.url.path().ends_with("/v1/reviews"))
        .filter_map(|request| serde_json::from_slice(&request.body).ok())
        .collect()
}

/// Drains the turn's events, keeping the guard decisions reported to the user.
async fn collect_verdicts(codex: &codex_core::CodexThread) -> Vec<GuardianVerdictEvent> {
    let mut verdicts = Vec::new();
    wait_for_event_with_timeout(
        codex,
        |event| {
            if let EventMsg::GuardianVerdict(verdict) = event {
                verdicts.push(verdict.clone());
            }
            matches!(event, EventMsg::TurnComplete(_))
        },
        WAIT,
    )
    .await;
    verdicts
}
