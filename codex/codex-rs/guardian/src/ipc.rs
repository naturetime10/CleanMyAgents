use std::path::Path;
use std::path::PathBuf;
use std::time::Duration;

use codex_uds::UnixStream;
use serde::Deserialize;
use serde::Serialize;
use tokio::io::AsyncBufReadExt;
use tokio::io::AsyncWriteExt;
use tokio::io::BufReader;

use crate::Activity;
use crate::ActivityContext;
use crate::FailurePosture;
use crate::GuardedAction;
use crate::Guardian;
use crate::GuardianError;
use crate::GuardianFuture;
use crate::Verdict;

/// Wire protocol version sent with every request.
pub const PROTOCOL_VERSION: u32 = 1;

/// One request written to the socket as a single JSON line.
///
/// Borrowed on the sending side to keep the turn path allocation-light; a
/// daemon parses the same wire shape with [`OwnedGuardianRequest`].
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum GuardianRequest<'a> {
    /// Asks for a verdict; the daemon must answer with a [`GuardianResponse`].
    Review {
        v: u32,
        ctx: &'a ActivityContext,
        action: &'a GuardedAction,
    },
    /// Reports an activity; no answer is expected.
    Record {
        v: u32,
        ctx: &'a ActivityContext,
        activity: &'a Activity,
    },
}

/// Owned mirror of [`GuardianRequest`], for the process on the other end.
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum OwnedGuardianRequest {
    Review {
        v: u32,
        ctx: ActivityContext,
        action: GuardedAction,
    },
    Record {
        v: u32,
        ctx: ActivityContext,
        activity: Activity,
    },
}

/// The answer to a review request, one JSON line.
#[derive(Debug, Serialize, Deserialize)]
pub struct GuardianResponse {
    pub verdict: Verdict,
}

/// Guardian that delegates every decision to a resident local process over a
/// Unix domain socket, using newline-delimited JSON.
///
/// One connection is opened per event: the daemon is expected to be resident and
/// local, and per-event connections keep a stalled peer from wedging unrelated
/// turns. Every call is deadline-bounded, and any transport failure surfaces as
/// a [`GuardianError`] so enforcing gates can fail closed.
#[derive(Debug)]
pub struct IpcGuardian {
    socket_path: PathBuf,
    timeout: Duration,
    failure_posture: FailurePosture,
}

impl IpcGuardian {
    pub fn new(socket_path: impl Into<PathBuf>, timeout: Duration, fail_closed: bool) -> Self {
        Self {
            socket_path: socket_path.into(),
            timeout,
            failure_posture: if fail_closed {
                FailurePosture::FailClosed
            } else {
                FailurePosture::FailOpen
            },
        }
    }

    pub fn socket_path(&self) -> &Path {
        &self.socket_path
    }

    async fn request(
        &self,
        payload: String,
        await_reply: bool,
    ) -> Result<Option<String>, GuardianError> {
        let deadline = self.timeout;
        let socket_path = self.socket_path.clone();
        let exchange = async move {
            let mut stream = UnixStream::connect(&socket_path)
                .await
                .map_err(|err| GuardianError::Unavailable(err.to_string()))?;
            stream
                .write_all(payload.as_bytes())
                .await
                .map_err(|err| GuardianError::Unavailable(err.to_string()))?;
            stream
                .flush()
                .await
                .map_err(|err| GuardianError::Unavailable(err.to_string()))?;
            if !await_reply {
                return Ok(None);
            }
            let mut reader = BufReader::new(stream);
            let mut line = String::new();
            let read = reader
                .read_line(&mut line)
                .await
                .map_err(|err| GuardianError::Unavailable(err.to_string()))?;
            if read == 0 {
                return Err(GuardianError::Unavailable(
                    "connection closed before a verdict arrived".to_string(),
                ));
            }
            Ok(Some(line))
        };

        match tokio::time::timeout(deadline, exchange).await {
            Ok(result) => result,
            Err(_) => Err(GuardianError::Timeout),
        }
    }
}

impl Guardian for IpcGuardian {
    fn review<'a>(
        &'a self,
        ctx: &'a ActivityContext,
        action: &'a GuardedAction,
    ) -> GuardianFuture<'a, Result<Verdict, GuardianError>> {
        Box::pin(async move {
            let request = GuardianRequest::Review {
                v: PROTOCOL_VERSION,
                ctx,
                action,
            };
            let mut payload = serde_json::to_string(&request)
                .map_err(|err| GuardianError::Protocol(err.to_string()))?;
            payload.push('\n');

            let line = self
                .request(payload, /*await_reply*/ true)
                .await?
                .ok_or_else(|| GuardianError::Protocol("missing response".to_string()))?;
            let response: GuardianResponse = serde_json::from_str(line.trim())
                .map_err(|err| GuardianError::Protocol(err.to_string()))?;
            Ok(response.verdict)
        })
    }

    fn record<'a>(
        &'a self,
        ctx: &'a ActivityContext,
        activity: &'a Activity,
    ) -> GuardianFuture<'a, ()> {
        Box::pin(async move {
            let request = GuardianRequest::Record {
                v: PROTOCOL_VERSION,
                ctx,
                activity,
            };
            let Ok(mut payload) = serde_json::to_string(&request) else {
                return;
            };
            payload.push('\n');
            // Recording is log-only: a missing daemon must never disturb a turn.
            if let Err(err) = self.request(payload, /*await_reply*/ false).await {
                tracing::debug!("guardian record dropped: {err}");
            }
        })
    }

    fn failure_posture(&self) -> FailurePosture {
        self.failure_posture
    }
}

#[cfg(test)]
#[path = "ipc_tests.rs"]
mod tests;
