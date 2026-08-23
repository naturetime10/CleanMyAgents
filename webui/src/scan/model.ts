/**
 * One scan of the harness: what it looks at, what it found, and what can be
 * done about each finding.
 *
 * A finding is never presented as a verdict. It carries the evidence and two or
 * three ways to act, because the right answer differs — a vendor preamble is
 * waste to one person and a wanted default to another. The last option is
 * always to keep things as they are.
 */

/** Same vocabulary as the backend contract, so reports need no translation. */
export type Severity = "critical" | "warn" | "info";

/** What the scan was reading when it found this. */
export type Source = "hook" | "mcp" | "session";

export const SOURCE_LABEL: Record<Source, string> = {
  hook: "Hooks",
  mcp: "MCP",
  session: "Sessions",
};

/**
 * One way to resolve a finding.
 *
 * `reclaims` is tokens per session. `cost` is what you give up — stated for
 * every option, including the ones we recommend, so the trade is visible
 * before the switch is thrown rather than after.
 */
export interface FixOption {
  id: string;
  label: string;
  detail: string;
  /**
   * Two cost shapes, not two units. Carried context — a session-start preamble,
   * or MCP tool schema — is re-sent with every request, so it costs
   * tokens × requests. Per-prompt context is injected afresh each turn and
   * accumulates, so it costs tokens × requests(requests+1)/2. Which is why a
   * small per-prompt hook outgrows a large session-start one.
   */
  reclaimsPerSession: number;
  reclaimsPerRequest: number;
  cost: string;
  /** Removes something from disk rather than just switching it off. */
  destructive?: boolean;
}

/** Total tokens one option reclaims, for ranking options against each other. */
export const reclaimsOf = (o: FixOption) => o.reclaimsPerSession + o.reclaimsPerRequest;

/** One rollout file, as offered for selection. */
export interface SessionRef {
  id: string;
  path: string;
  startedAt: string;
  day: string;
  bytes: number;
}

export interface Finding {
  id: string;
  source: Source;
  severity: Severity;
  title: string;
  /** Which provider, server or file this is about. */
  where: string;
  /** The measurement that makes this a finding. */
  evidence: string;
  /** Verbatim, when there is text worth reading yourself. */
  excerpt?: string;
  options: FixOption[];
  /** Option pre-selected when results appear. Never a destructive one. */
  recommend: string;
}

/**
 * One thing the scan reads, in the order it reads them.
 *
 * `finds` ties a finding to the item that produced it, so a result appears the
 * moment its own file scrolls past rather than on a timer. It is the difference
 * between a progress bar and a scan.
 */
export interface Target {
  source: Source;
  label: string;
  finds?: string;
}

/** The passes a scan makes, in order. */
export const PHASES: { source: Source; label: string }[] = [
  { source: "hook", label: "Hooks" },
  { source: "mcp", label: "MCP servers" },
  { source: "session", label: "Sessions" },
];

export const countBySource = (targets: Target[]) =>
  PHASES.map((p) => ({ ...p, n: targets.filter((t) => t.source === p.source).length }));

export const optionOf = (f: Finding, id: string | undefined) =>
  f.options.find((o) => o.id === id);

/** Tokens the current selection would stop paying, per session. */
export function reclaimOf(findings: Finding[], picks: Record<string, string>) {
  return findings.reduce((n, f) => {
    const o = optionOf(f, picks[f.id]);
    return n + (o ? reclaimsOf(o) : 0);
  }, 0);
}

/** Findings whose selection actually changes something. */
export function actionable(findings: Finding[], picks: Record<string, string>) {
  return findings.filter((f) => picks[f.id] && picks[f.id] !== "keep");
}

export const defaultPicks = (findings: Finding[]): Record<string, string> =>
  Object.fromEntries(findings.map((f) => [f.id, f.recommend]));
