/**
 * Why a call is worth interrupting for.
 *
 * The rule id that fires here is half of the remembered key, so these names are
 * a stable interface, not labels — renaming one silently forgets every rule a
 * user made under the old name.
 *
 * Only calls that match something are ever shown. A prompt that appears for
 * everything is one people learn to dismiss without reading, which is worse
 * than no prompt at all.
 */

export type Severity = "critical" | "warn";

export interface Rule {
  id: string;
  severity: Severity;
  /** Shown on the island. One line, no jargon, says what will happen. */
  says: string;
  test: RegExp;
}

export const RULES: Rule[] = [
  {
    id: "pipe-to-shell",
    severity: "critical",
    says: "Downloads a script and runs it",
    test: /\b(curl|wget)\b[^|]*\|\s*(ba|z|da)?sh\b/i,
  },
  {
    id: "credential-read",
    severity: "critical",
    says: "Reads credentials into the session",
    test: /\benv\b\s*\|\s*grep|\bcat\b[^|;]*(\.env|credentials|id_rsa|\.netrc)|security\s+find-generic-password/i,
  },
  {
    id: "credential-send",
    severity: "critical",
    says: "Sends a secret to the network",
    test: /\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD)\w*\}?[^|]*\b(curl|wget|nc)\b|\b(curl|wget)\b[^|]*\$\{?\w*(KEY|TOKEN|SECRET)/i,
  },
  {
    id: "destructive",
    severity: "critical",
    says: "Deletes files without asking",
    test: /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+(\/|~|\$HOME)/,
  },
  {
    id: "force-push",
    severity: "warn",
    says: "Rewrites published history",
    test: /\bgit\s+push\b[^|;]*\s(--force|-f)\b/,
  },
  {
    id: "network-write",
    severity: "warn",
    says: "Posts data to a remote host",
    test: /\b(curl|wget)\b[^|;]*\s(-X\s*(POST|PUT|PATCH)|--data|-d)\b/i,
  },
];

export interface Risk {
  rule: string;
  severity: Severity;
  says: string;
  /** The span that fired, so the island can quote rather than assert. */
  evidence: string;
}

/** The first rule this command trips, or null if it trips none. */
export function assess(command: string): Risk | null {
  for (const r of RULES) {
    const m = command.match(r.test);
    if (m) return { rule: r.id, severity: r.severity, says: r.says, evidence: m[0] };
  }
  return null;
}
