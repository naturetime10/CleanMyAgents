/**
 * Agent annotations on individual log rows.
 *
 * One log is read by several agents at once, each answering the same two
 * questions about every record it sees: is this paying for nothing, and does it
 * do something that costs money or reaches a credential. Their verdicts come
 * back keyed by record, which is why they can be drawn on the trajectory rather
 * than in a separate report — the row is the evidence.
 *
 * Data is mock.
 */
import type { Record_ } from "./model";

/**
 * Waste and security are kept apart because the answer differs.
 *
 * Waste is a budget question with a reversible answer: switch it off, and if
 * the session gets worse, switch it back. Security is not — a hook that spends
 * money or reads a credential has already done so by the time you see the row.
 */
export type Kind = "waste" | "security";

export const KIND_LABEL: Record<Kind, string> = {
  waste: "Paying for nothing",
  security: "Spends or reaches out",
};

export type Severity = "critical" | "warn" | "info";

export interface Annotation {
  /** The record this is about. */
  rowId: string;
  kind: Kind;
  severity: Severity;
  /** Which of the parallel agents returned it. */
  agent: string;
  title: string;
  detail: string;
  /** Quoted from the record, so the claim can be checked against the row. */
  evidence?: string;
  /** Tokens this row costs, when the point is the cost. */
  tokens?: number;
  /**
   * Whether blocking is offered.
   *
   * A hook can be blocked before it runs. A model turn or a user message
   * cannot — offering a button that does nothing is worse than offering none.
   */
  blockable: boolean;
}

/** How many agents read this log, for the header. */
export const AGENT_COUNT = 8;

/** An annotation before it knows which row it belongs to. */
type Rule = Omit<Annotation, "rowId"> & {
  /** Finds the record this is about. Matching beats hardcoding an index: the
   *  first version pinned row ids by hand and quietly stuck a credentials
   *  warning on a context block. */
  match: (r: Record_) => boolean;
};

const RULES: Rule[] = [
  {
    match: (r) => r.kind === "hook" && r.hook?.plugin === "ponytail@ponytail" && r.turn > 1,
    kind: "waste",
    severity: "warn",
    agent: "agent-2",
    title: "Injected again on this prompt, and never changes the outcome",
    detail:
      "1,307 tokens at session start and the same block again on each prompt. Fired 41 times " +
      "across the window and blocked or rewrote nothing. Cost grows with the square of the turns.",
    evidence: "ponytail@ponytail · userPromptSubmit",
    tokens: 1307,
    blockable: true,
  },
  {
    match: (r) => r.kind === "hook" && r.hook?.plugin === "frugal@frugal" && r.text.includes("Injected"),
    kind: "waste",
    severity: "info",
    agent: "agent-2",
    title: "Second preamble on the same event",
    detail:
      "Injected alongside another plugin's preamble at the same hook point. Both are carried " +
      "for the rest of the session.",
    evidence: "frugal@frugal · 510 tokens",
    tokens: 510,
    blockable: true,
  },
  {
    match: (r) => r.kind === "tool" && /env\s*\|\s*grep/.test(r.text),
    kind: "security",
    severity: "critical",
    agent: "agent-5",
    title: "Reads the environment, including credentials",
    detail:
      "Greps the whole environment. Anything that matches lands in context and is sent to the " +
      "model with every later request in this session.",
    evidence: "env | grep CODEX",
    blockable: true,
  },
  {
    match: (r) => r.kind === "hook" && r.text.includes("Allowed"),
    kind: "waste",
    severity: "warn",
    agent: "agent-1",
    title: "Ran, and decided nothing",
    detail: "Matched Bash, allowed the call, returned no output. It costs a process start per tool call.",
    evidence: "frugal@frugal · Allowed · matcher Bash",
    blockable: true,
  },
  {
    match: (r) => r.kind === "tool" && r.text.includes("mcp list"),
    kind: "waste",
    severity: "critical",
    agent: "agent-4",
    title: "Four servers connected, one ever called",
    detail:
      "The rest ship their tool schema with every request in every session, whether or not the " +
      "model has any use for them.",
    evidence: '"codex_apps" "node_repl" "codex-security" "dataAnalyticsWidgets"',
    tokens: 408,
    blockable: false,
  },
  {
    match: (r) => r.kind === "context" && r.tokens >= 5000,
    kind: "waste",
    severity: "critical",
    agent: "agent-3",
    title: "Superseded, and still billed",
    detail:
      "This snapshot supersedes the earlier one, but the earlier one stays in context. Both are " +
      "re-sent on every request for the rest of the session.",
    tokens: 8300,
    blockable: false,
  },
  {
    match: (r) => r.kind === "hook" && r.text.includes("Recorded"),
    kind: "security",
    severity: "warn",
    agent: "agent-5",
    title: "Writes the session's tool output to disk",
    detail:
      "Records tool output to a file outside the workspace. Nothing leaves the machine, but the " +
      "transcript outlives the session.",
    evidence: "warp@claude-code-warp · Recorded tool output",
    blockable: true,
  },
];

/**
 * Resolves each rule against the session.
 *
 * A rule that matches nothing produces nothing — silently dropping is right
 * here, because the alternative is an annotation pointing at a row that does
 * not exist.
 */
export function annotate(records: Record_[]): Annotation[] {
  return RULES.flatMap(({ match, ...note }) => {
    const row = records.find(match);
    return row ? [{ ...note, rowId: row.id }] : [];
  });
}

/** Marks the user made themselves, on a range they picked. */
export const YOU = "you";

export function userNote(rowIds: string[], kind: Kind, detail: string): Annotation[] {
  return rowIds.map((rowId) => ({
    rowId,
    kind,
    // A person marking a row is stating it, not estimating it.
    severity: kind === "security" ? "critical" : "warn",
    agent: YOU,
    title: kind === "security" ? "Marked: spends or reaches out" : "Marked: paying for nothing",
    detail: detail || "Marked by hand.",
    blockable: true,
  }));
}

export const byRow = (list: Annotation[]) => {
  const m = new Map<string, Annotation[]>();
  for (const a of list) m.set(a.rowId, [...(m.get(a.rowId) ?? []), a]);
  return m;
};

/** Worst severity on a row, for the marker. */
export const worst = (list: Annotation[]): Severity =>
  list.some((a) => a.severity === "critical") ? "critical"
  : list.some((a) => a.severity === "warn") ? "warn"
  : "info";
