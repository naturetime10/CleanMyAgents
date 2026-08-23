use super::TurnError;
use codex_protocol::protocol::GuardianDecision;
use crate::JsonSchema;
use crate::RequestId;
use crate::TS;
use serde::Deserialize;
use serde::Serialize;

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct DeprecationNoticeNotification {
    /// Concise summary of what is deprecated.
    pub summary: String,
    /// Optional extra guidance, such as migration steps or rationale.
    pub details: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct WarningNotification {
    /// Optional thread target when the warning applies to a specific thread.
    pub thread_id: Option<String>,
    /// Concise warning message for the user.
    pub message: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct GuardianWarningNotification {
    /// Thread target for the guardian warning.
    pub thread_id: String,
    /// Concise guardian warning message for the user.
    pub message: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct GuardianVerdictNotification {
    /// Thread target for the guard decision.
    pub thread_id: String,
    /// What the guard decided.
    pub decision: GuardianDecision,
    /// What was reviewed, in the user's words: `prompt`, `tool call`, ...
    pub action: String,
    /// Tool or MCP server the action is about, when it has one.
    pub tool: Option<String>,
    /// The guard's justification, when it gave one.
    pub reason: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct StrictReviewRequiredNotification {
    pub thread_id: String,
    pub turn_id: String,
    /// Unix timestamp (in milliseconds) when this review started.
    #[ts(type = "number")]
    pub started_at_ms: i64,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct ErrorNotification {
    pub error: TurnError,
    // Set to true if the error is transient and the app-server process will automatically retry.
    // If true, this will not interrupt a turn.
    pub will_retry: bool,
    pub thread_id: String,
    pub turn_id: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct ServerRequestResolvedNotification {
    pub thread_id: String,
    pub request_id: RequestId,
}
