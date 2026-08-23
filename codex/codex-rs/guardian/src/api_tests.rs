use std::path::PathBuf;
use std::time::Duration;

use codex_http_client::HttpClientFactory;
use codex_http_client::OutboundProxyPolicy;
use pretty_assertions::assert_eq;
use wiremock::Mock;
use wiremock::MockServer;
use wiremock::Request;
use wiremock::ResponseTemplate;
use wiremock::matchers::header;
use wiremock::matchers::method;
use wiremock::matchers::path;

use super::*;

fn context() -> ActivityContext {
    ActivityContext::new(
        "thread-api",
        "session-1",
        "turn-1",
        PathBuf::from("/repo"),
        "gpt-5",
        "codex_cli_rs",
        Some("dev@example.com".to_string()),
    )
}

fn tool_call() -> GuardedAction {
    GuardedAction::ToolCall {
        tool_name: "Bash".to_string(),
        matcher_aliases: Vec::new(),
        call_id: "call-1".to_string(),
        tool_input: serde_json::json!({ "command": "rm -rf /" }),
    }
}

fn guardian_for(server: &MockServer, token: Option<&str>) -> ApiGuardian {
    guardian_with_timeout(server, token, Duration::from_secs(5))
}

fn guardian_with_timeout(
    server: &MockServer,
    token: Option<&str>,
    timeout: Duration,
) -> ApiGuardian {
    let endpoint = ApiEndpoint::parse(&server.uri()).expect("endpoint");
    let factory = HttpClientFactory::new(OutboundProxyPolicy::ReqwestDefault);
    let client = factory
        .build_client(endpoint.base().as_str(), ClientRouteClass::Other)
        .expect("client");
    ApiGuardian::with_client(
        endpoint,
        client,
        token.map(str::to_string),
        timeout,
        /*fail_closed*/ true,
    )
}

/// A base URL with a path prefix has to keep it: a deployment mounted at
/// `/guardian` is not the same host as one mounted at the root.
#[test]
fn endpoints_resolve_under_the_configured_base() {
    let cases = [
        (
            "https://guard.example",
            "https://guard.example/v1/reviews",
            "https://guard.example/v1/activities",
        ),
        (
            "https://guard.example/",
            "https://guard.example/v1/reviews",
            "https://guard.example/v1/activities",
        ),
        (
            "https://guard.example/guardian",
            "https://guard.example/guardian/v1/reviews",
            "https://guard.example/guardian/v1/activities",
        ),
        (
            "  http://127.0.0.1:8080/api/  ",
            "http://127.0.0.1:8080/api/v1/reviews",
            "http://127.0.0.1:8080/api/v1/activities",
        ),
    ];
    for (base, reviews, activities) in cases {
        let endpoint = ApiEndpoint::parse(base).unwrap_or_else(|err| panic!("{base}: {err}"));
        assert_eq!(endpoint.reviews().as_str(), reviews, "{base}");
        assert_eq!(endpoint.activities().as_str(), activities, "{base}");
    }
}

#[test]
fn an_unusable_endpoint_is_rejected() {
    assert!(matches!(
        ApiEndpoint::parse("guard.example"),
        Err(ApiEndpointError::Malformed(_))
    ));
    assert!(matches!(
        ApiEndpoint::parse("ftp://guard.example"),
        Err(ApiEndpointError::UnsupportedScheme(_))
    ));
}

#[tokio::test]
async fn a_decided_review_returns_the_backends_verdict() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/reviews"))
        .and(header(
            "idempotency-key",
            "thread-api/turn-1/tool_call/call-1",
        ))
        .and(header("authorization", "Bearer secret-token"))
        .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
            "review_id": "rev-1",
            "status": "decided",
            "verdict": { "decision": "deny", "reason": "destroys the working tree" },
        })))
        .expect(1)
        .mount(&server)
        .await;

    let guardian = guardian_for(&server, Some("secret-token"));
    let verdict = guardian
        .review(&context(), &tool_call())
        .await
        .expect("verdict");
    assert_eq!(
        verdict,
        Verdict::Deny {
            reason: "destroys the working tree".to_string()
        }
    );
}

/// The request body is the whole guard protocol, so the shape the backend has
/// to parse is pinned here rather than left to inference.
#[tokio::test]
async fn the_review_body_carries_the_context_and_the_action() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/reviews"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "verdict": { "decision": "allow" },
        })))
        .mount(&server)
        .await;

    let guardian = guardian_for(&server, None);
    let verdict = guardian
        .review(&context(), &tool_call())
        .await
        .expect("verdict");
    assert_eq!(verdict, Verdict::Allow);

    let body: serde_json::Value = server.received_requests().await.expect("requests")[0]
        .body_json()
        .expect("json body");
    assert_eq!(body["context"]["thread_id"], "thread-api");
    assert_eq!(body["context"]["session_id"], "session-1");
    assert_eq!(body["context"]["account"], "dev@example.com");
    assert_eq!(body["action"]["action"], "tool_call");
    assert_eq!(body["action"]["tool_name"], "Bash");
    assert_eq!(body["action"]["tool_input"]["command"], "rm -rf /");
}

/// A backend that needs a human answers `202` and is polled until it decides.
/// Without this the pending review would read as `Defer`, which on a tool-call
/// gate is indistinguishable from `Allow`.
#[tokio::test]
async fn a_pending_review_is_polled_until_it_is_decided() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/reviews"))
        .respond_with(
            ResponseTemplate::new(202)
                .insert_header("location", "/v1/reviews/rev-2")
                .insert_header("retry-after", "0")
                .set_body_json(serde_json::json!({
                    "review_id": "rev-2",
                    "status": "pending",
                    "verdict": { "decision": "defer" },
                })),
        )
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/v1/reviews/rev-2"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "review_id": "rev-2",
            "status": "decided",
            "verdict": { "decision": "allow" },
        })))
        .expect(1..)
        .mount(&server)
        .await;

    let guardian = guardian_for(&server, None);
    let verdict = guardian
        .review(&context(), &tool_call())
        .await
        .expect("verdict");
    assert_eq!(verdict, Verdict::Allow);
}

/// An approval nobody answers must expire into `Timeout`, which the call site
/// then turns into a denial under a fail-closed posture.
#[tokio::test]
async fn a_review_that_stays_pending_times_out() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/reviews"))
        .respond_with(
            ResponseTemplate::new(202)
                .insert_header("location", "/v1/reviews/rev-3")
                .set_body_json(serde_json::json!({ "status": "pending" })),
        )
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/v1/reviews/rev-3"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "status": "pending",
        })))
        .mount(&server)
        .await;

    let guardian = guardian_with_timeout(&server, None, Duration::from_millis(600));
    let err = guardian
        .review(&context(), &tool_call())
        .await
        .expect_err("deadline");
    assert_eq!(err, GuardianError::Timeout);
    assert_eq!(
        Verdict::on_error(&err, guardian.failure_posture()).label(),
        "deny"
    );
}

/// Nothing a failing backend says may be read as permission.
#[tokio::test]
async fn failures_map_onto_the_error_the_fail_posture_acts_on() {
    let cases: Vec<(u16, Option<serde_json::Value>, GuardianError)> = vec![
        (
            400,
            None,
            GuardianError::Protocol("400 Bad Request: 400 Bad Request".to_string()),
        ),
        (
            401,
            None,
            GuardianError::Unavailable(
                "backend rejected our credentials: 401 Unauthorized".to_string(),
            ),
        ),
        (
            429,
            None,
            GuardianError::Unavailable(
                "backend is shedding load: 429 Too Many Requests".to_string(),
            ),
        ),
        (
            503,
            None,
            GuardianError::Unavailable("503 Service Unavailable".to_string()),
        ),
        (504, None, GuardianError::Timeout),
        // A backend that names the variant itself is believed over the status.
        (
            422,
            Some(serde_json::json!({
                "title": "unknown action kind",
                "detail": "action=\"browser_navigate\"",
                "guardian_error": "protocol",
            })),
            GuardianError::Protocol("action=\"browser_navigate\"".to_string()),
        ),
    ];

    for (status, problem, expected) in cases {
        let server = MockServer::start().await;
        let mut response = ResponseTemplate::new(status);
        if let Some(problem) = problem {
            response = response.set_body_json(problem);
        }
        Mock::given(method("POST"))
            .and(path("/v1/reviews"))
            .respond_with(response)
            .mount(&server)
            .await;

        let guardian = guardian_for(&server, None);
        let err = guardian
            .review(&context(), &tool_call())
            .await
            .expect_err("{status}");
        assert_eq!(err, expected, "status {status}");
        assert_eq!(
            Verdict::on_error(&err, guardian.failure_posture()).label(),
            "deny",
            "status {status}"
        );
    }
}

/// A success without a verdict is a protocol error, not an admission.
#[tokio::test]
async fn a_decided_review_without_a_verdict_is_a_protocol_error() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/reviews"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(serde_json::json!({ "status": "decided" })),
        )
        .mount(&server)
        .await;

    let guardian = guardian_for(&server, None);
    let err = guardian
        .review(&context(), &tool_call())
        .await
        .expect_err("no verdict");
    assert!(matches!(err, GuardianError::Protocol(_)), "{err:?}");
}

#[tokio::test]
async fn activities_are_posted_as_a_batch_and_flushed() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/activities"))
        .respond_with(ResponseTemplate::new(202))
        .mount(&server)
        .await;

    let guardian = guardian_for(&server, None);
    let ctx = context();
    guardian.record(&ctx, &Activity::SessionStarted).await;
    guardian
        .record(
            &ctx,
            &Activity::TokenUsage {
                input_tokens: 10,
                cached_input_tokens: 0,
                output_tokens: 5,
                reasoning_output_tokens: 0,
                total_tokens: 15,
            },
        )
        .await;
    guardian.record(&ctx, &Activity::SessionEnded).await;
    guardian.flush().await;

    let requests = server.received_requests().await.expect("requests");
    let kinds: Vec<String> = requests
        .iter()
        .flat_map(|request: &Request| {
            let body: serde_json::Value = request.body_json().expect("json body");
            body["items"]
                .as_array()
                .expect("items array")
                .iter()
                .map(|item| item["activity"]["activity"].as_str().unwrap().to_string())
                .collect::<Vec<_>>()
        })
        .collect();
    assert_eq!(
        kinds,
        vec!["session_started", "token_usage", "session_ended"]
    );
    assert_eq!(
        requests[0].body_json::<serde_json::Value>().expect("json")["items"][0]["context"]["thread_id"],
        "thread-api"
    );
}

/// Recording is log-only: a backend that rejects a batch must not surface as a
/// failure on the turn path.
#[tokio::test]
async fn a_rejected_batch_is_absorbed() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/activities"))
        .respond_with(ResponseTemplate::new(500))
        .mount(&server)
        .await;

    let guardian = guardian_for(&server, None);
    guardian.record(&context(), &Activity::SessionStarted).await;
    guardian.flush().await;
}
