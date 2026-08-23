// Mirrors the OpsSnapshot contract served by backend/ (`GET /snapshot`).
// Keep in sync with clownfish/src/contracts.ts — this is the wire boundary.

export type Severity = "info" | "warn" | "critical";
export type TrustStatus = "managed" | "untrusted" | "trusted" | "modified";

export interface HookMeta {
  key: string;
  eventName: string;
  type: "command" | "mcp_tool" | "prompt" | "agent";
  source: string;
  sourcePath?: string;
  pluginId?: string;
  matcher?: string;
  enabled: boolean;
  trustStatus: TrustStatus;
  currentHash?: string;
  command?: string[];
}

export interface Finding {
  hookKey: string;
  rule: string;
  severity: Severity;
  evidence: string;
}

export interface McpServerStatus {
  id: string;
  enabled: boolean;
  runtimeStatus: string;
  toolNames: string[];
  command?: string;
  url?: string;
  schemaBytes?: number;
}

export interface BudgetRow {
  server: string;
  tools: number;
  tokens: number;
  calls: number;
  enabled: boolean;
  runtimeStatus: string;
  lastUsed?: string;
}

export interface DailyPoint {
  date: string;
  sessions: number;
  calls: number;
  failed: number;
}

export interface InjectionSource {
  id: string;
  label: string;
  blocks: number;
  tokens: number;
  perSession: number;
  maxTokens: number;
  sample: string;
}

export interface OpsSnapshot {
  generatedAt: string;
  audit: { hookCount: number; findings: Finding[] };
  stats: { sessions: number; toolCalls: number; mcp: { server: string; calls: number; lastUsed?: string }[] };
  servers: McpServerStatus[];
  hooks: HookMeta[];
  budget: { totalTools: number; totalTokens: number; wastedTokens: number; perServer: BudgetRow[] };
  efficiency: {
    sessions: number; toolCalls: number; failed: number; failureRate: number;
    repeatedCalls: number; peakTokens: number;
    byTool: { tool: string; calls: number; failed: number }[];
    repeats: { command: string; count: number }[];
    daily: DailyPoint[];
  };
  injections: { sessions: number; totalTokens: number; sources: InjectionSource[] };
  recommendations: unknown[];
}

export type ApplyAction =
  | { kind: "disable-mcp"; server: string }
  | { kind: "enable-mcp"; server: string }
  | { kind: "compact"; threadId: string };

/** One injector: hooks it owns plus the payload measured in session history. */
export interface Injector {
  id: string;
  source: string;
  hooks: HookMeta[];
  findings: number;
  payload: InjectionSource | null;
}
