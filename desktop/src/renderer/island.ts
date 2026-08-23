/**
 * The approval island.
 *
 * Four answers, weighted by how often they are the right one. Once-answers are
 * the two big buttons; the standing ones are small, because "always" is a
 * policy and a policy should cost a deliberate click.
 */
import type { Decision } from "../main/decisions.ts";

const $ = (id: string) => document.getElementById(id)!;
let ticking = 0;

window.cma.onAsk((a) => {
  $("root").hidden = false;
  $("says").textContent = a.risk.says;
  $("tool").textContent = a.tool;
  $("cmd").textContent = a.command;
  $("dot").setAttribute("data-sev", a.risk.severity);
  // Name the rule, because that is what an "always" answer will be about — not
  // this command.
  $("why").textContent = `remembers ${a.tool} · ${a.risk.rule}`;

  const until = Date.now() + a.timeoutMs;
  clearInterval(ticking);
  const tick = () => {
    const left = Math.max(0, Math.ceil((until - Date.now()) / 1000));
    $("clock").textContent = `${left}s`;
    if (left === 0) clearInterval(ticking);
  };
  tick();
  ticking = setInterval(tick, 250) as unknown as number;
});

const answer = (d: Decision) => {
  clearInterval(ticking);
  $("root").hidden = true;
  window.cma.decide(d);
};

for (const d of ["deny-once", "allow-once", "deny-always", "allow-always"] as const) {
  $(d).addEventListener("click", () => answer(d));
}

// Escape is deny-once: the safe answer should be the reflex one.
addEventListener("keydown", (e) => {
  if (e.key === "Escape") answer("deny-once");
});
