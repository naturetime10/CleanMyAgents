/**
 * Talks to the ops daemon when one is running, and falls back to the mock when
 * it is not.
 *
 * The fallback is deliberate rather than defensive: the console has to be
 * demonstrable on a machine with no Codex install, and a scan that silently
 * shows nothing is worse than one that says where its numbers came from. Every
 * result carries `live`, and the UI says which it is.
 */
import { mockFindings, mockSessions, scanTargets } from "./mock";
import type { Finding, SessionRef, Target } from "./model";

const BASE = import.meta.env.VITE_OPS_URL ?? "";
const TIMEOUT_MS = 4000;

export interface Savings {
  tokensPerSession: number;
  tokensPerRequest: number;
  tokensTotal: number;
  costUsd: number;
}

export interface ScanReport {
  live: boolean;
  sessions: SessionRef[];
  turnsPerSession: number;
  /**
   * Context carried into every session before anything is applied.
   *
   * The reclaim figures are meaningless without it: 8k saved is most of the
   * budget or a rounding error depending on what the budget was. Optional
   * because a daemon that does not report it should show no bar rather than a
   * guessed one.
   */
  baselinePerSession?: number;
  targets: Target[];
  findings: Finding[];
  recommended: Savings;
  pricing: { model: string; inputPerMTok: number; cachedInputPerMTok: number };
}

/** A fetch that gives up rather than leaving the button spinning forever. */
async function get<T>(path: string): Promise<T | null> {
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}${path}`, { signal: stop.signal });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null; // no daemon, wrong port, or it went away mid-scan
  } finally {
    clearTimeout(timer);
  }
}

export const fetchSessions = async (): Promise<{ live: boolean; sessions: SessionRef[] }> => {
  const live = await get<SessionRef[]>("/sessions");
  return live ? { live: true, sessions: live } : { live: false, sessions: mockSessions() };
};

export type Scope = { kind: "all" } | { kind: "sessions"; ids: string[] };

const query = (scope: Scope) =>
  scope.kind === "all" ? "scope=all" : `scope=sessions&ids=${encodeURIComponent(scope.ids.join(","))}`;

export async function fetchScan(scope: Scope): Promise<ScanReport> {
  const live = await get<Omit<ScanReport, "live">>(`/scan?${query(scope)}`);
  if (live) return { ...live, live: true };

  const sessions = mockSessions().filter((s) => scope.kind === "all" || scope.ids.includes(s.id));
  const findings = mockFindings();
  // Mock savings use the same shapes the backend does, so the summary reads the
  // same either way: carried context is linear in turns, per-prompt is not.
  const turns = 12;
  const perSession = findings.reduce((n, f) => n + (recommendedOf(f)?.reclaimsPerSession ?? 0), 0);
  const perRequest = findings.reduce((n, f) => n + (recommendedOf(f)?.reclaimsPerRequest ?? 0), 0);
  const tokensTotal = Math.round(
    (perSession * turns + perRequest * ((turns * (turns + 1)) / 2)) * Math.max(1, sessions.length),
  );
  // Everything the harness carries today: what the findings could reclaim, plus
  // the core preamble that is not removable at any setting.
  const CORE_PREAMBLE = 8_300;
  const removable = findings.reduce(
    (n, f) => n + Math.max(...f.options.map((o) => o.reclaimsPerSession)), 0,
  );

  return {
    live: false,
    sessions,
    turnsPerSession: turns,
    baselinePerSession: CORE_PREAMBLE + removable,
    targets: scanTargets(),
    findings,
    recommended: {
      tokensPerSession: perSession,
      tokensPerRequest: perRequest,
      tokensTotal,
      // gpt-5 input blended at an 80% cache hit: 0.2×1.25 + 0.8×0.125 per Mtok.
      costUsd: (tokensTotal / 1e6) * 0.35,
    },
    pricing: { model: "gpt-5", inputPerMTok: 1.25, cachedInputPerMTok: 0.125 },
  };
}

const recommendedOf = (f: Finding) => f.options.find((o) => o.id === f.recommend);

/**
 * Deep scan: the desktop backend ships the rollout log to the user's Equile
 * Grok agent and long-polls until the annotations come back. No timeout — the
 * run takes minutes — and no mock fallback: a remote annotation pass on sample
 * data would be a lie, so failure is reported as failure.
 */
export async function fetchDeepScan(): Promise<{ file: string; findings: Finding[] }> {
  const res = await fetch(`${BASE}/deep-scan`, { method: "POST" });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body) throw new Error(body?.error ?? `deep scan failed (${res.status})`);
  return body as { file: string; findings: Finding[] };
}
