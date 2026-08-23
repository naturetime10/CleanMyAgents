use crate::Activity;
use crate::ActivityContext;
use crate::GuardedAction;
use crate::Verdict;

/// One line of the per-session CSV history.
///
/// The column set is fixed so the file stays trivially greppable and
/// spreadsheet-openable; anything variable lands in `detail` as JSON.
///
/// Whatever is constant for the whole file -- the thread and session it
/// belongs to, the account, the working directory -- lives in the metadata
/// sidecar instead of being repeated on every row.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ActivityRow {
    pub ts: String,
    pub turn_id: String,
    pub kind: String,
    pub phase: String,
    pub tool: String,
    pub call_id: String,
    pub decision: String,
    pub reason: String,
    pub tokens_in: String,
    pub tokens_out: String,
    pub tokens_total: String,
    pub context_used: String,
    pub context_limit: String,
    pub detail: String,
}

/// Cap on the `detail` column so one enormous tool result cannot dominate the
/// file. Truncation is marked so a reader never mistakes it for the whole value.
const MAX_DETAIL_BYTES: usize = 4096;

impl ActivityRow {
    /// Builds the row for a guard decision.
    pub fn for_action(ctx: &ActivityContext, action: &GuardedAction, verdict: &Verdict) -> Self {
        Self {
            kind: action.kind().to_string(),
            phase: "gate".to_string(),
            tool: action.tool().unwrap_or_default().to_string(),
            call_id: action.call_id().unwrap_or_default().to_string(),
            decision: verdict.label().to_string(),
            reason: verdict.reason().unwrap_or_default().to_string(),
            detail: detail_json(action),
            ..Self::base(ctx)
        }
    }

    /// Builds the row for a recorded activity.
    pub fn for_activity(ctx: &ActivityContext, activity: &Activity) -> Self {
        let mut row = Self {
            kind: activity.kind().to_string(),
            phase: "tap".to_string(),
            tool: activity.tool().unwrap_or_default().to_string(),
            call_id: activity.call_id().unwrap_or_default().to_string(),
            detail: detail_json(activity),
            ..Self::base(ctx)
        };
        match activity {
            Activity::TokenUsage {
                input_tokens,
                output_tokens,
                total_tokens,
                ..
            } => {
                row.tokens_in = input_tokens.to_string();
                row.tokens_out = output_tokens.to_string();
                row.tokens_total = total_tokens.to_string();
            }
            Activity::ContextWindow {
                active_context_tokens,
                full_context_window_limit,
                ..
            } => {
                row.context_used = active_context_tokens.to_string();
                row.context_limit = full_context_window_limit
                    .map(|limit| limit.to_string())
                    .unwrap_or_default();
            }
            Activity::ToolCallCompleted { success, .. } => {
                row.decision = if *success { "success" } else { "failure" }.to_string();
            }
            Activity::ApprovalResolved {
                decision, source, ..
            } => {
                row.decision = decision.clone();
                row.reason = source.clone();
            }
            Activity::Compacted { phase, .. } => {
                row.phase = format!("compact_{}", phase.label());
            }
            Activity::HookCompleted { status, .. } => {
                row.decision = status.clone();
            }
            _ => {}
        }
        row
    }

    fn base(ctx: &ActivityContext) -> Self {
        Self {
            ts: ctx.timestamp.to_rfc3339(),
            turn_id: ctx.turn_id.clone(),
            kind: String::new(),
            phase: String::new(),
            tool: String::new(),
            call_id: String::new(),
            decision: String::new(),
            reason: String::new(),
            tokens_in: String::new(),
            tokens_out: String::new(),
            tokens_total: String::new(),
            context_used: String::new(),
            context_limit: String::new(),
            detail: String::new(),
        }
    }

    /// Renders the row as one RFC 4180 record, newline included.
    pub fn to_csv_line(&self) -> String {
        let fields = [
            &self.ts,
            &self.turn_id,
            &self.kind,
            &self.phase,
            &self.tool,
            &self.call_id,
            &self.decision,
            &self.reason,
            &self.tokens_in,
            &self.tokens_out,
            &self.tokens_total,
            &self.context_used,
            &self.context_limit,
            &self.detail,
        ];
        let mut line = String::new();
        for (index, field) in fields.iter().enumerate() {
            if index > 0 {
                line.push(',');
            }
            line.push_str(&escape_csv_field(field));
        }
        line.push('\n');
        line
    }
}

/// Quotes a field per RFC 4180 when it contains a delimiter, quote, or newline.
fn escape_csv_field(field: &str) -> String {
    if field.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", field.replace('"', "\"\""))
    } else {
        field.to_string()
    }
}

/// Serializes a payload for the `detail` column, truncating on a char boundary.
fn detail_json(value: &impl serde::Serialize) -> String {
    let mut detail = serde_json::to_string(value).unwrap_or_else(|err| {
        format!(
            "{{\"guardian_serialize_error\":\"{}\"}}",
            err.to_string().replace('"', "'")
        )
    });
    if detail.len() > MAX_DETAIL_BYTES {
        let mut cut = MAX_DETAIL_BYTES;
        while cut > 0 && !detail.is_char_boundary(cut) {
            cut -= 1;
        }
        detail.truncate(cut);
        detail.push_str("…[truncated]");
    }
    detail
}
