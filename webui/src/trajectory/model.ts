/**
 * Session trajectory model. Ours, but deliberately shaped like the ledger a
 * coding-agent harness produces: an ordered list of records, each belonging to a
 * turn, each projected onto one of four lanes in the overview strip.
 *
 * Lanes: input (system/user/context) · model (assistant/compacted) · tools ·
 * hooks. The hook lane is the one that matters here — hooks fire inside the
 * session, inject context, and can block a call, and that is what we audit.
 */

export type Kind =
  | "system" | "user" | "context" | "assistant" | "compacted" | "tool" | "subtool" | "hook";

export type Status = "completed" | "failed" | "blocked" | "running";

export const LANES = ["Input", "Model", "Tools", "Hooks"] as const;

export function laneOf(kind: Kind): 0 | 1 | 2 | 3 {
  if (kind === "hook") return 3;
  if (kind === "tool" || kind === "subtool") return 2;
  if (kind === "assistant" || kind === "compacted") return 1;
  return 0;
}

export const KIND_LABEL: Record<Kind, string> = {
  system: "SYSTEM", user: "USER", context: "CONTEXT", assistant: "ASSISTANT",
  compacted: "COMPACTED", tool: "TOOL", subtool: "SUBTOOL", hook: "HOOK",
};

export interface Record_ {
  id: string;
  kind: Kind;
  turn: number;
  step: number;
  status: Status;
  /** Row body. For tools this is the call; `result` is appended after an arrow. */
  text: string;
  /** Tool or plugin name, shown before the body in monospace. */
  name?: string;
  result?: string;
  /** ms offset from session start, and how long the record took. */
  startedAt: number;
  durationMs: number;
  /** Context this record adds, in tokens. */
  tokens: number;
  payload?: string;
  schema?: { name: string; description: string };
  hook?: { plugin: string; event: string; matcher?: string; blocked?: boolean };
  /**
   * Set when the system refused this call. `source` names the layer that
   * decided (guard, hook, fail posture — the codex-side precedence is
   * Guard -> Hooks -> review -> user), `reason` is the string that layer
   * surfaced, and `savedTokens` is the context the refusal kept out:
   * measured output size when the result was withheld after the run,
   * the median result of completed calls to the same tool when the call
   * never ran.
   */
  block?: { source: string; reason: string; savedTokens: number };
  hierarchy?: string;
}

export interface Session {
  title: string;
  mode: string;
  model: string;
  reasoning: string;
  records: Record_[];
}

/** Detail tabs vary by record kind. */
export function tabsFor(r: Record_): { id: string; label: string }[] {
  if (r.kind === "hook") {
    return [
      { id: "summary", label: "Summary" },
      { id: "injected", label: "Injected" },
      { id: "owner", label: "Owner" },
      { id: "timing", label: "Timing" },
    ];
  }
  if (r.kind === "tool" || r.kind === "subtool") {
    return [
      { id: "summary", label: "Summary" },
      { id: "payload", label: "Payload" },
      { id: "result", label: "Result" },
      { id: "schema", label: "Schema" },
      { id: "timing", label: "Timing" },
    ];
  }
  if (r.kind === "compacted") {
    return [{ id: "summary", label: "Summary" }, { id: "raw", label: "Raw Output" }];
  }
  return [{ id: "summary", label: "Summary" }, { id: "raw", label: "Raw" }];
}

/**
 * Marks tool calls the system would skip: from the third identical call on,
 * the context cost is pure duplicate, so `savedTokens` is the record's own
 * measured cost — not an estimate. Sessions recorded before the guardian get
 * their skips derived here; a feed that already sets `block` is left alone.
 */
export function markSystemSkips(records: Record_[]): Record_[] {
  const seen = new Map<string, number>();
  return records.map((r) => {
    if (r.kind !== "tool" && r.kind !== "subtool") return r;
    const n = (seen.get(r.text) ?? 0) + 1;
    seen.set(r.text, n);
    if (n < 3 || r.block) return r;
    return { ...r, block: {
      source: "system · duplicate-call breaker",
      reason: `Identical call already ran ${n - 1} times this session.`,
      savedTokens: r.tokens,
    } };
  });
}

export const sessionEnd = (s: Session) =>
  Math.max(1, ...s.records.map((r) => r.startedAt + r.durationMs));

export interface HookRow {
  plugin: string;
  fires: number;
  tokens: number;
  blocked: number;
  events: string[];
}

/** Per-plugin aggregate: the question the ledger exists to answer. */
export function hookRows(s: Session): HookRow[] {
  const by = new Map<string, HookRow>();
  for (const r of s.records) {
    if (r.kind !== "hook" || !r.hook) continue;
    const row = by.get(r.hook.plugin) ?? { plugin: r.hook.plugin, fires: 0, tokens: 0, blocked: 0, events: [] };
    row.fires += 1;
    row.tokens += r.tokens;
    if (r.hook.blocked) row.blocked += 1;
    if (!row.events.includes(r.hook.event)) row.events.push(r.hook.event);
    by.set(r.hook.plugin, row);
  }
  return [...by.values()].sort((a, b) => b.tokens - a.tokens || b.fires - a.fires);
}

export interface Totals {
  turns: number;
  steps: number;
  llmMs: number;
  toolMs: number;
  hookTokens: number;
  inputTokens: number;
  outputTokens: number;
  blockedCalls: number;
  /** Estimated context the blocks kept out. Sum of per-record estimates. */
  savedTokens: number;
}

export function totals(s: Session): Totals {
  const t: Totals = { turns: 0, steps: 0, llmMs: 0, toolMs: 0, hookTokens: 0, inputTokens: 0, outputTokens: 0, blockedCalls: 0, savedTokens: 0 };
  for (const r of s.records) {
    t.turns = Math.max(t.turns, r.turn);
    t.steps += 1;
    if (r.kind === "assistant") { t.llmMs += r.durationMs; t.outputTokens += r.tokens; }
    else if (r.kind === "tool" || r.kind === "subtool") t.toolMs += r.durationMs;
    else t.inputTokens += r.tokens;
    if (r.kind === "hook") t.hookTokens += r.tokens;
    if (r.block) { t.blockedCalls += 1; t.savedTokens += r.block.savedTokens; }
  }
  return t;
}
