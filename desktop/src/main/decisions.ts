/**
 * Remembered approval decisions.
 *
 * A rule is keyed by what was asked and why it was flagged — `Bash|pipe-to-shell`
 * — not by the command text. Keying on the command would mean answering the same
 * question again for every URL, and the thing being decided is not "is this URL
 * safe" but "do I let this tool pipe a download into a shell".
 *
 * Only the two "always" answers are written. A once-answer is deliberately not
 * remembered: it was an answer about this call, and inferring a standing rule
 * from it is how a prompt stops meaning anything.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type Decision = "allow-once" | "deny-once" | "allow-always" | "deny-always";

/**
 * What the caller gets back: the answer, and where it came from.
 *
 * Provenance is part of the answer. "Denied because you said so once" and
 * "denied because nobody was at the keyboard" are different facts, and a caller
 * that cannot tell them apart cannot report honestly either.
 */
export type Verdict =
  | { allow: true; verdict: "rule-allow" | "user-allow" | "not-risky" }
  | { allow: false; verdict: "rule-deny" | "user-deny" | "timeout" | "busy" };

export type Rules = Record<string, "allow" | "deny">;

/** `<tool>|<rule>` — the shape of the thing being decided, not the instance. */
export const ruleKey = (tool: string, rule: string) => `${tool}|${rule}`;

export const isStanding = (d: Decision) => d === "allow-always" || d === "deny-always";

export function applyDecision(rules: Rules, key: string, d: Decision): Rules {
  if (!isStanding(d)) return rules;
  return { ...rules, [key]: d === "allow-always" ? "allow" : "deny" };
}

export function verdictFor(d: Decision): Verdict {
  return d === "allow-once" || d === "allow-always"
    ? { allow: true, verdict: "user-allow" }
    : { allow: false, verdict: "user-deny" };
}

/** A standing answer, when one exists. */
export function lookup(rules: Rules, key: string): Verdict | null {
  const r = rules[key];
  if (r === "allow") return { allow: true, verdict: "rule-allow" };
  if (r === "deny") return { allow: false, verdict: "rule-deny" };
  return null;
}

export class DecisionStore {
  private path: string;
  private rules: Rules = {};

  constructor(path: string) {
    this.path = path;
  }

  async load(): Promise<Rules> {
    try {
      const raw = JSON.parse(await readFile(this.path, "utf8")) as unknown;
      // A corrupt or hand-edited file must not take the app down, and must not
      // silently become "allow everything" either — an unreadable file is no
      // rules, which means asking.
      this.rules = sanitise(raw);
    } catch {
      this.rules = {};
    }
    return this.rules;
  }

  all(): Rules {
    return { ...this.rules };
  }

  lookup(key: string): Verdict | null {
    return lookup(this.rules, key);
  }

  async remember(key: string, d: Decision): Promise<void> {
    const next = applyDecision(this.rules, key, d);
    if (next === this.rules) return;
    this.rules = next;
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, `${JSON.stringify(this.rules, null, 1)}\n`);
  }

  async forget(key: string): Promise<void> {
    if (!(key in this.rules)) return;
    const { [key]: _gone, ...rest } = this.rules;
    this.rules = rest;
    await writeFile(this.path, `${JSON.stringify(this.rules, null, 1)}\n`);
  }
}

/** Keeps only entries that mean something; anything else is dropped. */
export function sanitise(raw: unknown): Rules {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Rules = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v === "allow" || v === "deny") out[k] = v;
  }
  return out;
}
