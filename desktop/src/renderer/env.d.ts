/**
 * What the preload puts on `window`, declared once for both renderers.
 *
 * Written as a global interface rather than `declare const window`, which
 * cannot redeclare the existing global and fails the moment a second renderer
 * needs the same shape.
 */
import type { Decision } from "../main/decisions.ts";
import type { Ask } from "../preload/index.ts";

declare global {
  interface Window {
    cma: {
      onAsk(fn: (a: Ask) => void): void;
      decide(d: Decision): void;
      summary(): Promise<{ wastedTokens: number; findings: number } | null>;
      rules(): Promise<Record<string, "allow" | "deny">>;
      forget(key: string): Promise<void>;
      openConsole(): void;
      demoAsk(): Promise<unknown>;
    };
  }
}

export {};
