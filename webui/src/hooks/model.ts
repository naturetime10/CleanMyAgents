/**
 * Installed hook providers — anything that registers a Codex hook.
 *
 * Reads like a driver list: what is installed, where it came from, whether it is
 * trusted, which hook points it occupies, what each point injects, and what that
 * costs per session. Each point can be turned off on its own; a provider is
 * rarely all-or-nothing.
 */

/** Codex hook events a provider can register against. */
export type HookEvent =
  | "sessionStart" | "sessionEnd" | "userPromptSubmit"
  | "preToolUse" | "postToolUse" | "permissionRequest"
  | "preCompact" | "postCompact" | "subagentStart" | "subagentStop" | "stop";

export const EVENT_ORDER: HookEvent[] = [
  "sessionStart", "userPromptSubmit", "preToolUse", "permissionRequest",
  "postToolUse", "preCompact", "postCompact", "subagentStart", "subagentStop",
  "stop", "sessionEnd",
];

/**
 * Notable properties of what a hook point injects. These are what an audit is
 * actually looking for — not that text arrived, but what kind of text.
 */
export type PointFlag =
  /** Names a specific product or service the model is nudged toward. */
  | "vendor"
  /** Long enough to be worth questioning on its own. */
  | "oversized"
  /** Another installed provider injects the same thing at the same point. */
  | "duplicate"
  /** Fires on every prompt, not just once at session start. */
  | "per-prompt";

export const FLAG_LABEL: Record<PointFlag, string> = {
  vendor: "vendor content",
  oversized: "oversized",
  duplicate: "duplicate",
  "per-prompt": "every prompt",
};

export const FLAG_WHY: Record<PointFlag, string> = {
  vendor: "Names a specific product or service. Worth knowing you are paying to carry a recommendation.",
  oversized: "Over 1,000 tokens in a single block.",
  duplicate: "Another provider injects the same thing at this hook point.",
  "per-prompt": "Re-injected on every prompt, so the cost scales with turns rather than sessions.",
};

/** What a provider does at one hook point. */
export interface HookPoint {
  event: HookEvent;
  /** Tool-name matcher; undefined means every tool. */
  matcher?: string;
  /** One-line description of what it puts into the session. */
  injects: string;
  /** Tokens this point adds per session. 0 = injects nothing. */
  tokens: number;
  /** Times it fired across the scanned window. */
  fires: number;
  /** Times it blocked or rewrote a call. */
  intercepts: number;
  enabled: boolean;
  flags?: PointFlag[];
  /** The actual text injected, when there is any. */
  sample?: string;
  command: string;
}

export type Trust = "trusted" | "untrusted" | "modified" | "managed";

export interface Provider {
  id: string;
  name: string;
  version: string;
  /** Where it came from, and how to look it up. */
  publisher: string;
  repo?: string;
  description: string;
  installedAt: string;
  path: string;
  trust: Trust;
  points: HookPoint[];
}

export const providerTokens = (p: Provider) =>
  p.points.filter((h) => h.enabled).reduce((n, h) => n + h.tokens, 0);

/**
 * A point that costs tokens, fires often, and never intercepts is paying rent
 * without doing work — the case for turning it off.
 */
export const isDeadWeight = (h: HookPoint) =>
  h.enabled && h.tokens > 0 && h.fires > 0 && h.intercepts === 0;

export interface Totals {
  providers: number;
  points: number;
  enabled: number;
  tokens: number;
  reclaimable: number;
  untrusted: number;
  vendorTokens: number;
}

export function totals(list: Provider[]): Totals {
  const points = list.flatMap((p) => p.points);
  return {
    providers: list.length,
    points: points.length,
    enabled: points.filter((h) => h.enabled).length,
    tokens: points.filter((h) => h.enabled).reduce((n, h) => n + h.tokens, 0),
    reclaimable: points.filter(isDeadWeight).reduce((n, h) => n + h.tokens, 0),
    untrusted: list.filter((p) => p.trust !== "trusted" && p.trust !== "managed").length,
    vendorTokens: points
      .filter((h) => h.enabled && h.flags?.includes("vendor"))
      .reduce((n, h) => n + h.tokens, 0),
  };
}
