/**
 * The renderer's whole surface.
 *
 * Context isolation stays on and nothing hands out `ipcRenderer` itself: the
 * island can answer a question and read the one it was asked, and that is all
 * it needs. A renderer showing a security prompt is the last place to widen.
 */
import { contextBridge, ipcRenderer } from "electron";
import type { Decision } from "../main/decisions.ts";

export interface Ask {
  risk: { rule: string; severity: "critical" | "warn"; says: string; evidence: string };
  tool: string;
  command: string;
  timeoutMs: number;
}

contextBridge.exposeInMainWorld("cma", {
  /** Island: the question, and the answer. */
  onAsk: (fn: (a: Ask) => void) =>
    ipcRenderer.on("ask", (_e, a: Ask) => fn(a)),
  decide: (d: Decision) => ipcRenderer.send("decide", d),

  /** Panel. */
  summary: () => ipcRenderer.invoke("summary"),
  rules: () => ipcRenderer.invoke("rules"),
  forget: (key: string) => ipcRenderer.invoke("forget", key),
  openConsole: () => ipcRenderer.send("open-console"),
  demoAsk: () => ipcRenderer.invoke("demo-ask"),
});
