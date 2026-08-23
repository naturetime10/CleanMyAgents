//! REST client guardian: relays every guarded action and recorded activity to
//! an HTTP backend named by `[guardian] endpoint`.
//!
//! Two endpoints carry the whole guard protocol, mirroring the two halves of
//! the [`Guardian`] trait:
//!
//! * `POST {endpoint}/v1/reviews` — submits a [`GuardedAction`] and returns the
//!   [`Verdict`]. A backend that needs a human to decide answers `202` with a
//!   `Location`, which this client polls until the request deadline.
//! * `POST {endpoint}/v1/activities` — reports [`Activity`] records. Batched on
//!   a background task so the turn path never waits on the network.
//!
//! Reads (sessions, threads, history) are deliberately absent: they belong to
//! whatever renders a session, not to the guard a turn runs through.
//!
//! Every action and activity body carries prompts and tool output, so this
//! guardian is opt-in only — `mode` defaults to `off` outside debug builds and
//! never selects a network backend on its own.

use std::time::Duration;

use codex_http_client::ClientRouteClass;
use codex_http_client::HttpClient;
use codex_http_client::HttpClientFactory;
use reqwest::StatusCode;
use serde::Deserialize;
use serde::Serialize;
use tokio::sync::mpsc;
use tokio::sync::oneshot;
use url::Url;

use crate::Activity;
use crate::ActivityContext;
use crate::FailurePosture;
use crate::GuardedAction;
use crate::Guardian;
use crate::GuardianError;
use crate::GuardianFuture;
use crate::Verdict;

/// Collection every guarded action is submitted to.
const REVIEWS_PATH: &str = "v1/reviews";
/// Collection every recorded activity is posted to.
const ACTIVITIES_PATH: &str = "v1/activities";

/// Bounded so a slow backend cannot grow the queue without limit. Unlike the
/// CSV writer this drops on overflow instead of applying backpressure: a
/// record is log-only, and a remote monitor is far likelier to stall than the
/// local disk is.
const QUEUE_DEPTH: usize = 512;

/// Cap on how many activities one request carries. Batches are formed from
/// whatever is already queued, so this bounds request size without adding
/// latency of its own.
const MAX_BATCH: usize = 64;

/// How long to wait before re-polling a pending review when the backend did
/// not send a usable `Retry-After`.
const DEFAULT_POLL_INTERVAL: Duration = Duration::from_millis(250);

/// Longest honoured `Retry-After`. A backend asking for more than the request
/// deadline allows is answered by the deadline instead.
const MAX_POLL_INTERVAL: Duration = Duration::from_secs(5);

/// Why an endpoint could not be turned into a usable base URL.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ApiEndpointError {
    /// The configured string is not a URL.
    Malformed(String),
    /// The URL parsed but is not something requests can be sent to.
    UnsupportedScheme(String),
}

impl std::fmt::Display for ApiEndpointError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Malformed(detail) => write!(f, "not a valid URL: {detail}"),
            Self::UnsupportedScheme(scheme) => {
                write!(f, "unsupported scheme `{scheme}`, expected http or https")
            }
        }
    }
}

impl std::error::Error for ApiEndpointError {}

/// The two collection URLs derived once from the configured base.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ApiEndpoint {
    base: Url,
    reviews: Url,
    activities: Url,
}

impl ApiEndpoint {
    /// Resolves the collection URLs under `base`.
    ///
    /// A base without a trailing slash still keeps its path: `https://h/guard`
    /// yields `https://h/guard/v1/reviews`, not `https://h/v1/reviews`, which
    /// is what a plain [`Url::join`] would produce.
    pub fn parse(base: &str) -> Result<Self, ApiEndpointError> {
        let trimmed = base.trim();
        let mut normalized = Url::parse(trimmed)
            .map_err(|err| ApiEndpointError::Malformed(format!("{trimmed}: {err}")))?;
        match normalized.scheme() {
            "http" | "https" => {}
            scheme => return Err(ApiEndpointError::UnsupportedScheme(scheme.to_string())),
        }
        if !normalized.path().ends_with('/') {
            let with_slash = format!("{}/", normalized.path());
            normalized.set_path(&with_slash);
        }

        let reviews = normalized
            .join(REVIEWS_PATH)
            .map_err(|err| ApiEndpointError::Malformed(err.to_string()))?;
        let activities = normalized
            .join(ACTIVITIES_PATH)
            .map_err(|err| ApiEndpointError::Malformed(err.to_string()))?;
        Ok(Self {
            base: normalized,
            reviews,
            activities,
        })
    }

    pub fn base(&self) -> &Url {
        &self.base
    }

    pub fn reviews(&self) -> &Url {
        &self.reviews
    }

    pub fn activities(&self) -> &Url {
        &self.activities
    }
}

/// Guardian that delegates every decision to an HTTP backend.
///
/// One pooled client serves the whole process, so per-event cost is a request
/// on a warm connection rather than a fresh handshake.
#[derive(Debug)]
pub struct ApiGuardian {
    endpoint: ApiEndpoint,
    client: HttpClient,
    bearer_token: Option<String>,
    timeout: Duration,
    failure_posture: FailurePosture,
    tx: mpsc::Sender<RecordCmd>,
}

impl ApiGuardian {
    /// Builds a guardian pointed at `endpoint`, borrowing the process-wide
    /// client factory so outbound proxy and custom-CA policy match every other
    /// Codex request.
    pub fn new(
        endpoint: ApiEndpoint,
        factory: &HttpClientFactory,
        bearer_token: Option<String>,
        timeout: Duration,
        fail_closed: bool,
    ) -> Result<Self, codex_http_client::BuildRouteAwareHttpClientError> {
        let client = factory.build_client(endpoint.base().as_str(), ClientRouteClass::Other)?;
        Ok(Self::with_client(
            endpoint,
            client,
            bearer_token,
            timeout,
            fail_closed,
        ))
    }

    /// Same, for a caller that already owns a client — the seam the tests use.
    pub fn with_client(
        endpoint: ApiEndpoint,
        client: HttpClient,
        bearer_token: Option<String>,
        timeout: Duration,
        fail_closed: bool,
    ) -> Self {
        let (tx, rx) = mpsc::channel(QUEUE_DEPTH);
        tokio::spawn(record_loop(
            RecordSender {
                client: client.clone(),
                url: endpoint.activities().clone(),
                bearer_token: bearer_token.clone(),
                timeout,
            },
            rx,
        ));
        Self {
            endpoint,
            client,
            bearer_token,
            timeout,
            failure_posture: if fail_closed {
                FailurePosture::FailClosed
            } else {
                FailurePosture::FailOpen
            },
            tx,
        }
    }

    pub fn endpoint(&self) -> &ApiEndpoint {
        &self.endpoint
    }

    /// Correlates a retry with the review it is retrying.
    ///
    /// A client-side timeout leaves the backend's verdict unknown, and asking
    /// again without a key would let a retry produce a *different* answer than
    /// the one already recorded. The key is derived rather than random so a
    /// retry after a process restart still matches.
    fn idempotency_key(ctx: &ActivityContext, action: &GuardedAction) -> String {
        format!(
            "{}/{}/{}/{}",
            ctx.thread_id,
            ctx.turn_id,
            action.kind(),
            action.call_id().unwrap_or("-")
        )
    }

    async fn submit_review(
        &self,
        ctx: &ActivityContext,
        action: &GuardedAction,
    ) -> Result<Verdict, GuardianError> {
        let request = self
            .client
            .post(self.endpoint.reviews().clone())
            .header("idempotency-key", Self::idempotency_key(ctx, action))
            .header(reqwest::header::ACCEPT, "application/json")
            .timeout(self.timeout)
            .json(&ReviewRequest {
                context: ctx,
                action,
            });
        let response = authorize(request, self.bearer_token.as_deref())
            .send()
            .await
            .map_err(transport_error)?;

        let status = response.status();
        if status == StatusCode::ACCEPTED {
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .map(str::to_string);
            let retry_after = retry_after(&response);
            let Some(location) = location else {
                return Err(GuardianError::Protocol(
                    "202 pending review without a Location header".to_string(),
                ));
            };
            let poll_url = self
                .endpoint
                .reviews()
                .join(&location)
                .map_err(|err| GuardianError::Protocol(format!("unusable Location: {err}")))?;
            return self.poll_review(poll_url, retry_after).await;
        }
        if !status.is_success() {
            return Err(status_error(status, response.text().await.ok()));
        }
        decided_verdict(parse_review(response).await?)
    }

    /// Waits out a backend that needs a human to decide.
    ///
    /// Bounded by the same deadline as the initial request, applied by the
    /// caller: an approval nobody answers becomes a [`GuardianError::Timeout`]
    /// and then whatever the fail posture says, never a silent admission.
    async fn poll_review(
        &self,
        url: Url,
        first_delay: Option<Duration>,
    ) -> Result<Verdict, GuardianError> {
        let mut delay = first_delay.unwrap_or(DEFAULT_POLL_INTERVAL);
        loop {
            tokio::time::sleep(delay).await;
            let request = self
                .client
                .get(url.clone())
                .header(reqwest::header::ACCEPT, "application/json")
                .timeout(self.timeout);
            let response = authorize(request, self.bearer_token.as_deref())
                .send()
                .await
                .map_err(transport_error)?;
            let status = response.status();
            if !status.is_success() {
                return Err(status_error(status, response.text().await.ok()));
            }
            delay = retry_after(&response).unwrap_or(DEFAULT_POLL_INTERVAL);
            let review = parse_review(response).await?;
            if review.status == ReviewStatus::Pending {
                continue;
            }
            return decided_verdict(review);
        }
    }
}

impl Guardian for ApiGuardian {
    fn review<'a>(
        &'a self,
        ctx: &'a ActivityContext,
        action: &'a GuardedAction,
    ) -> GuardianFuture<'a, Result<Verdict, GuardianError>> {
        Box::pin(async move {
            // One deadline covers the submission and any polling it turns into,
            // so a pending approval cannot outlive the turn's budget.
            match tokio::time::timeout(self.timeout, self.submit_review(ctx, action)).await {
                Ok(result) => result,
                Err(_) => Err(GuardianError::Timeout),
            }
        })
    }

    fn record<'a>(
        &'a self,
        ctx: &'a ActivityContext,
        activity: &'a Activity,
    ) -> GuardianFuture<'a, ()> {
        Box::pin(async move {
            let envelope = ActivityEnvelope {
                context: ctx.clone(),
                activity: activity.clone(),
            };
            // Never awaited to completion against a full queue: recording is
            // log-only and must not become the reason a turn stalls.
            if let Err(err) = self.tx.try_send(RecordCmd::Activity(Box::new(envelope))) {
                tracing::warn!("guardian api record dropped: {err}");
            }
        })
    }

    fn failure_posture(&self) -> FailurePosture {
        self.failure_posture
    }

    fn flush(&self) -> GuardianFuture<'_, ()> {
        Box::pin(async move {
            let (ack_tx, ack_rx) = oneshot::channel();
            if self.tx.send(RecordCmd::Flush(ack_tx)).await.is_ok() {
                let _ = ack_rx.await;
            }
        })
    }
}

/// Adds the bearer token when one is configured.
fn authorize(
    request: codex_http_client::RequestBuilder,
    token: Option<&str>,
) -> codex_http_client::RequestBuilder {
    match token {
        Some(token) => request.bearer_auth(token),
        None => request,
    }
}

/// Maps a transport failure onto the error the call site's posture acts on.
fn transport_error(err: reqwest::Error) -> GuardianError {
    if err.is_timeout() {
        GuardianError::Timeout
    } else if err.is_decode() || err.is_body() {
        GuardianError::Protocol(err.to_string())
    } else {
        GuardianError::Unavailable(err.to_string())
    }
}

/// Maps a non-success status onto a [`GuardianError`].
///
/// A backend that answers `application/problem+json` names the variant itself
/// through `guardian_error`; otherwise the status decides. Nothing here can
/// produce a verdict, so an unrecognized failure always reaches the fail
/// posture rather than being read as permission.
fn status_error(status: StatusCode, body: Option<String>) -> GuardianError {
    let problem = body
        .as_deref()
        .and_then(|body| serde_json::from_str::<ProblemDetails>(body).ok());
    let detail = problem
        .as_ref()
        .and_then(ProblemDetails::message)
        .map(str::to_string)
        .or_else(|| body.filter(|body| !body.trim().is_empty()))
        .unwrap_or_else(|| status.to_string());

    if let Some(kind) = problem.as_ref().and_then(|problem| problem.guardian_error) {
        return match kind {
            ProblemKind::Unavailable => GuardianError::Unavailable(detail),
            ProblemKind::Timeout => GuardianError::Timeout,
            ProblemKind::Protocol => GuardianError::Protocol(detail),
        };
    }

    match status {
        StatusCode::GATEWAY_TIMEOUT | StatusCode::REQUEST_TIMEOUT => GuardianError::Timeout,
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => {
            GuardianError::Unavailable(format!("backend rejected our credentials: {detail}"))
        }
        StatusCode::TOO_MANY_REQUESTS => {
            GuardianError::Unavailable(format!("backend is shedding load: {detail}"))
        }
        status if status.is_server_error() => GuardianError::Unavailable(detail),
        _ => GuardianError::Protocol(format!("{status}: {detail}")),
    }
}

/// Reads a `Retry-After` expressed in seconds, ignoring the HTTP-date form and
/// anything longer than [`MAX_POLL_INTERVAL`].
fn retry_after(response: &reqwest::Response) -> Option<Duration> {
    let seconds: u64 = response
        .headers()
        .get(reqwest::header::RETRY_AFTER)?
        .to_str()
        .ok()?
        .trim()
        .parse()
        .ok()?;
    Some(Duration::from_secs(seconds).min(MAX_POLL_INTERVAL))
}

async fn parse_review(response: reqwest::Response) -> Result<ReviewResponse, GuardianError> {
    response
        .json::<ReviewResponse>()
        .await
        .map_err(|err| GuardianError::Protocol(err.to_string()))
}

/// Unwraps the verdict of a decided review.
///
/// A decided review without a verdict is a protocol error rather than a
/// [`Verdict::Defer`]: on a tool-call gate `Defer` is indistinguishable from
/// `Allow`, so treating a malformed answer as one would turn an unreachable
/// intent into silent permission.
fn decided_verdict(review: ReviewResponse) -> Result<Verdict, GuardianError> {
    match review.verdict {
        Some(verdict) => Ok(verdict),
        None => Err(GuardianError::Protocol(
            "decided review carried no verdict".to_string(),
        )),
    }
}

/// `POST /v1/reviews` body. Borrowed so the turn path serializes in place.
#[derive(Debug, Serialize)]
struct ReviewRequest<'a> {
    context: &'a ActivityContext,
    action: &'a GuardedAction,
}

/// What `/v1/reviews` answers with, on creation and on every poll.
#[derive(Debug, Deserialize)]
struct ReviewResponse {
    #[serde(default)]
    #[allow(dead_code)]
    review_id: Option<String>,
    #[serde(default)]
    status: ReviewStatus,
    #[serde(default)]
    verdict: Option<Verdict>,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum ReviewStatus {
    /// The backend has an answer. The default, so a backend that never needs a
    /// human can omit the field entirely.
    #[default]
    Decided,
    /// A human still has to decide; poll `Location` until this changes.
    Pending,
}

/// RFC 9457 error body, with the field that names a [`GuardianError`] variant.
#[derive(Debug, Deserialize)]
struct ProblemDetails {
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    detail: Option<String>,
    #[serde(default)]
    guardian_error: Option<ProblemKind>,
}

impl ProblemDetails {
    fn message(&self) -> Option<&str> {
        self.detail.as_deref().or(self.title.as_deref())
    }
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ProblemKind {
    Unavailable,
    Timeout,
    Protocol,
}

/// One entry of the `POST /v1/activities` batch.
#[derive(Debug, Serialize)]
struct ActivityEnvelope {
    context: ActivityContext,
    activity: Activity,
}

/// `POST /v1/activities` body. Always a batch, even of one, so the backend has
/// a single shape to parse.
#[derive(Debug, Serialize)]
struct ActivityBatch<'a> {
    items: &'a [ActivityEnvelope],
}

enum RecordCmd {
    Activity(Box<ActivityEnvelope>),
    Flush(oneshot::Sender<()>),
}

/// Everything the background task needs to post a batch.
struct RecordSender {
    client: HttpClient,
    url: Url,
    bearer_token: Option<String>,
    timeout: Duration,
}

impl RecordSender {
    async fn send(&self, items: &[ActivityEnvelope]) {
        if items.is_empty() {
            return;
        }
        let request = self
            .client
            .post(self.url.clone())
            .header(reqwest::header::ACCEPT, "application/json")
            .timeout(self.timeout)
            .json(&ActivityBatch { items });
        match authorize(request, self.bearer_token.as_deref())
            .send()
            .await
        {
            Ok(response) if response.status().is_success() => {}
            Ok(response) => {
                tracing::debug!(
                    "guardian api rejected {} activities: {}",
                    items.len(),
                    response.status()
                );
            }
            Err(err) => {
                tracing::debug!("guardian api record dropped: {err}");
            }
        }
    }
}

/// Drains the queue, coalescing whatever is already waiting into one request.
///
/// Batches form from the backlog rather than on a timer, so a quiet session
/// still posts each activity immediately and a busy one amortizes the network
/// cost without adding latency of its own.
async fn record_loop(sender: RecordSender, mut rx: mpsc::Receiver<RecordCmd>) {
    let mut batch: Vec<ActivityEnvelope> = Vec::new();
    while let Some(cmd) = rx.recv().await {
        let mut pending_ack = None;
        match cmd {
            RecordCmd::Activity(envelope) => batch.push(*envelope),
            RecordCmd::Flush(ack) => pending_ack = Some(ack),
        }
        while batch.len() < MAX_BATCH && pending_ack.is_none() {
            match rx.try_recv() {
                Ok(RecordCmd::Activity(envelope)) => batch.push(*envelope),
                Ok(RecordCmd::Flush(ack)) => pending_ack = Some(ack),
                Err(_) => break,
            }
        }
        sender.send(&batch).await;
        batch.clear();
        if let Some(ack) = pending_ack {
            let _ = ack.send(());
        }
    }
}

#[cfg(test)]
#[path = "api_tests.rs"]
mod tests;
