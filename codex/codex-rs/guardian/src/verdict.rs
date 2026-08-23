use serde::Deserialize;
use serde::Serialize;

/// What a [`crate::Guardian`] decided about one guarded action.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "decision", rename_all = "snake_case")]
pub enum Verdict {
    /// Admit the action unchanged; the hook layer runs next.
    Allow,
    /// Block the action. `reason` is surfaced to the model or the user.
    Deny { reason: String },
    /// Admit the action, but with this payload substituted for its input or
    /// output. The shape of `payload` matches the action being reviewed: tool
    /// input for a tool call, the model-visible text for a tool output, and the
    /// prompt text for a prompt.
    Rewrite {
        payload: serde_json::Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        note: Option<String>,
    },
    /// No opinion. Approval gates fall through to Hooks -> review -> user; other
    /// gates treat this exactly like [`Verdict::Allow`].
    #[default]
    Defer,
}

impl Verdict {
    /// Maps a transport/protocol failure onto a verdict using the call site's
    /// fail posture. Gates pass [`FailurePosture::FailClosed`] so an
    /// unreachable monitor blocks the action instead of silently admitting it.
    pub fn on_error(err: &GuardianError, posture: FailurePosture) -> Self {
        match posture {
            FailurePosture::FailOpen => Self::Defer,
            FailurePosture::FailClosed => Self::Deny {
                reason: format!("codex-guardian unavailable (fail-closed): {err}"),
            },
        }
    }

    /// Returns the short label recorded in the `decision` column of the CSV
    /// history and in analytics.
    pub fn label(&self) -> &'static str {
        match self {
            Self::Allow => "allow",
            Self::Deny { .. } => "deny",
            Self::Rewrite { .. } => "rewrite",
            Self::Defer => "defer",
        }
    }

    /// Human-readable justification, when the verdict carries one.
    pub fn reason(&self) -> Option<&str> {
        match self {
            Self::Deny { reason } => Some(reason.as_str()),
            Self::Rewrite { note, .. } => note.as_deref(),
            Self::Allow | Self::Defer => None,
        }
    }
}

/// Why a guardian could not produce a verdict.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GuardianError {
    /// The monitor could not be reached (socket missing, refused, closed).
    Unavailable(String),
    /// The monitor did not answer within the configured deadline.
    Timeout,
    /// The monitor answered with something that is not a verdict.
    Protocol(String),
}

impl std::fmt::Display for GuardianError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unavailable(detail) => write!(f, "monitor unavailable: {detail}"),
            Self::Timeout => write!(f, "monitor timed out"),
            Self::Protocol(detail) => write!(f, "monitor protocol error: {detail}"),
        }
    }
}

impl std::error::Error for GuardianError {}

/// How a call site reacts when [`crate::Guardian::review`] fails.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FailurePosture {
    /// Let the action proceed. Used by recording taps and by gates when the
    /// operator has opted out of enforcement.
    FailOpen,
    /// Deny the action. The default for enforcing gates.
    FailClosed,
}
