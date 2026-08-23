import { useEffect, useState } from "react";
import type { ApplyAction, Injector, OpsSnapshot } from "./types";

const POLL_MS = 15_000;

export function useSnapshot() {
  const [snapshot, setSnapshot] = useState<OpsSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const res = await fetch("/snapshot");
      if (!res.ok) throw new Error(`snapshot ${res.status}`);
      setSnapshot(await res.json());
      setError(null);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    }
  };

  useEffect(() => {
    // Poll only once something answers. Nothing serves /snapshot today, and a
    // request every 15s forever is a console full of failures describing a
    // situation that will not change on its own.
    let t = 0;
    void load().then((ok) => { if (ok) t = setInterval(() => void load(), POLL_MS); });
    return () => clearInterval(t);
  }, []);

  return { snapshot, error, reload: load };
}

export async function apply(action: ApplyAction): Promise<boolean> {
  const res = await fetch("/apply", { method: "POST", body: JSON.stringify(action) })
    .then((r) => r.json())
    .catch(() => ({ ok: false }));
  return Boolean(res.ok);
}

/**
 * Groups hooks by the plugin that installed them and joins the measured payload.
 * Sources with a measured payload but no hook (codex core, AGENTS.md) still appear,
 * so the injected-token totals always reconcile.
 */
export function injectorsOf(s: OpsSnapshot): Injector[] {
  const by = new Map<string, Injector>();
  const get = (id: string, source: string) => {
    let g = by.get(id);
    if (!g) { g = { id, source, hooks: [], findings: 0, payload: null }; by.set(id, g); }
    return g;
  };
  for (const h of s.hooks) {
    const g = get(h.pluginId ?? (h.source === "plugin" ? "unknown-plugin" : h.source), h.source);
    g.hooks.push(h);
    g.findings += s.audit.findings.filter((f) => f.hookKey === h.key).length;
  }
  for (const p of s.injections?.sources ?? []) get(p.id, "measured").payload = p;
  return [...by.values()].sort(
    (a, b) =>
      (b.payload?.perSession ?? 0) - (a.payload?.perSession ?? 0) ||
      b.findings - a.findings ||
      b.hooks.length - a.hooks.length,
  );
}

export const kfmt = (n: number) =>
  n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(Math.round(n));
export const pct = (n: number) => `${(n * 100).toFixed(n < 0.1 ? 1 : 0)}%`;

/** Validated light categorical order; hue binds to identity, never to rank. */
const HUES = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"];
export function hueOf(name: string): string {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return HUES[h % HUES.length];
}
