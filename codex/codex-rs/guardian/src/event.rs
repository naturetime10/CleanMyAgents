use std::path::PathBuf;

use chrono::DateTime;
use chrono::Utc;
use serde::Deserialize;
use serde::Serialize;

/// Correlation and identity carried by every guarded action and recorded
/// activity.
///
/// The hook payloads Codex already emits carry session/turn correlation but not
/// the authenticated account, so the guard layer enriches every event with the
/// account and originator taken from the session.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActivityContext {
    pub thread_id: String,
    pub session_id: String,
    pub turn_id: String,
    pub cwd: PathBuf,
    pub model: String,
    pub originator: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
    pub timestamp: DateTime<Utc>,
}

impl ActivityContext {
    /// Builds a context stamped with the current time.
    pub fn new(
        thread_id: impl Into<String>,
        session_id: impl Into<String>,
        turn_id: impl Into<String>,
        cwd: impl Into<PathBuf>,
        model: impl Into<String>,
        originator: impl Into<String>,
        account: Option<String>,
    ) -> Self {
        Self {
            thread_id: thread_id.into(),
            session_id: session_id.into(),
            turn_id: turn_id.into(),
            cwd: cwd.into(),
            model: model.into(),
            originator: originator.into(),
            account,
            timestamp: Utc::now(),
        }
    }
}

/// An action the guard decides on *before* it happens. One variant per guard
/// gate in `codex-core`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum GuardedAction {
    /// A user prompt about to enter history and be sent to the model.
    /// `Rewrite` replaces the prompt text.
    Prompt { text: String },
    /// A tool or MCP call about to be dispatched. `Rewrite` replaces the tool
    /// input JSON.
    ToolCall {
        tool_name: String,
        matcher_aliases: Vec<String>,
        call_id: String,
        tool_input: serde_json::Value,
    },
    /// A completed tool result about to become model-visible. This is the only
    /// place a tool result can be sanitized. `Rewrite` replaces the
    /// model-visible text with `payload` rendered as a string.
    ToolOutput {
        tool_name: String,
        call_id: String,
        tool_input: serde_json::Value,
        tool_response: serde_json::Value,
    },
    /// A permission request. `Defer` falls through to hooks, the automated
    /// review, and finally the user.
    Approval {
        tool_name: String,
        run_id: String,
        tool_input: serde_json::Value,
    },
    /// An MCP server about to be admitted for the turn. Denying here prevents
    /// the server from ever connecting.
    McpAdmission {
        server_name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        connector_id: Option<String>,
    },
    /// Context compaction about to run. Denying vetoes the compaction.
    Compaction { trigger: String },
}

impl GuardedAction {
    /// Stable label for the CSV `kind` column and the IPC wire.
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Prompt { .. } => "prompt",
            Self::ToolCall { .. } => "tool_call",
            Self::ToolOutput { .. } => "tool_output",
            Self::Approval { .. } => "approval",
            Self::McpAdmission { .. } => "mcp_admission",
            Self::Compaction { .. } => "compaction",
        }
    }

    /// Tool (or server) this action is about, when it has one.
    pub fn tool(&self) -> Option<&str> {
        match self {
            Self::ToolCall { tool_name, .. }
            | Self::ToolOutput { tool_name, .. }
            | Self::Approval { tool_name, .. } => Some(tool_name.as_str()),
            Self::McpAdmission { server_name, .. } => Some(server_name.as_str()),
            Self::Prompt { .. } | Self::Compaction { .. } => None,
        }
    }

    /// Call id correlating this action with its result, when it has one.
    pub fn call_id(&self) -> Option<&str> {
        match self {
            Self::ToolCall { call_id, .. } | Self::ToolOutput { call_id, .. } => {
                Some(call_id.as_str())
            }
            Self::Approval { run_id, .. } => Some(run_id.as_str()),
            Self::Prompt { .. } | Self::McpAdmission { .. } | Self::Compaction { .. } => None,
        }
    }
}

/// Which side of a compaction an activity describes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CompactionPhase {
    Pre,
    Post,
}

impl CompactionPhase {
    pub fn label(self) -> &'static str {
        match self {
            Self::Pre => "pre",
            Self::Post => "post",
        }
    }
}

/// Something that already happened. Recording an activity never blocks or
/// changes behavior; it is the append-only audit narrative.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "activity", rename_all = "snake_case")]
pub enum Activity {
    SessionStarted,
    SessionEnded,
    /// A turn finished, carrying the assistant's last message.
    TurnStopped {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        last_assistant_message: Option<String>,
    },
    /// A prompt was admitted and recorded into history (post-rewrite).
    PromptRecorded {
        text: String,
    },
    /// A tool call finished executing.
    ToolCallCompleted {
        tool_name: String,
        call_id: String,
        success: bool,
        tool_response: serde_json::Value,
    },
    /// An approval was resolved, by whichever layer had the final say.
    ApprovalResolved {
        tool_name: String,
        call_id: String,
        decision: String,
        source: String,
    },
    /// Cumulative token spend reported after a model response. Not observable
    /// from the hook path, which is why this is a code-level tap.
    TokenUsage {
        input_tokens: i64,
        cached_input_tokens: i64,
        output_tokens: i64,
        reasoning_output_tokens: i64,
        total_tokens: i64,
    },
    /// Live context occupancy, distinct from cumulative token spend.
    ContextWindow {
        active_context_tokens: i64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        full_context_window_limit: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        base_window_tokens_remaining: Option<i64>,
        limit_reached: bool,
    },
    /// Compaction ran; pair `Pre` and `Post` to see what context was dropped.
    Compacted {
        phase: CompactionPhase,
        trigger: String,
    },
    /// Firehose: every completed hook run, sync and async.
    HookCompleted {
        hook_event: String,
        handler: String,
        status: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        duration_ms: Option<u64>,
    },
}

impl Activity {
    /// Stable label for the CSV `kind` column and the IPC wire.
    pub fn kind(&self) -> &'static str {
        match self {
            Self::SessionStarted => "session_started",
            Self::SessionEnded => "session_ended",
            Self::TurnStopped { .. } => "turn_stopped",
            Self::PromptRecorded { .. } => "prompt_recorded",
            Self::ToolCallCompleted { .. } => "tool_call_completed",
            Self::ApprovalResolved { .. } => "approval_resolved",
            Self::TokenUsage { .. } => "token_usage",
            Self::ContextWindow { .. } => "context_window",
            Self::Compacted { .. } => "compacted",
            Self::HookCompleted { .. } => "hook_completed",
        }
    }

    pub fn tool(&self) -> Option<&str> {
        match self {
            Self::ToolCallCompleted { tool_name, .. }
            | Self::ApprovalResolved { tool_name, .. } => Some(tool_name.as_str()),
            Self::HookCompleted { hook_event, .. } => Some(hook_event.as_str()),
            _ => None,
        }
    }

    pub fn call_id(&self) -> Option<&str> {
        match self {
            Self::ToolCallCompleted { call_id, .. } | Self::ApprovalResolved { call_id, .. } => {
                Some(call_id.as_str())
            }
            _ => None,
        }
    }
}

/// Inputs available when sandbox permissions are being resolved for one
/// request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SandboxContext<'a> {
    pub thread_id: &'a str,
    pub turn_id: &'a str,
    pub tool_name: &'a str,
    pub agent_type: Option<&'a str>,
}

/// A containment tightening the guard asks for. `PreToolUse`-style denial only
/// vetoes an action; this confines one that is allowed to run.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SandboxProfileOverride {
    /// Run with the strictest available sandbox regardless of ambient policy.
    ReadOnly,
    /// Refuse to run rather than run unsandboxed.
    RequireSandbox,
}
