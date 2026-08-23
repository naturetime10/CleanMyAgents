/** The tray panel: what it costs, what has been decided, and a way in. */
const $ = (id: string) => document.getElementById(id)!;
const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

async function render() {
  const s = await window.cma.summary();
  $("figures").innerHTML = s
    ? `<div><b>${k(s.wastedTokens)}</b><span>wasted per request</span></div>
       <div><b class="${s.findings ? "crit" : ""}">${s.findings}</b><span>findings</span></div>`
    // Not an error: the console simply is not running.
    : `<p class="none">No daemon answering on this machine.</p>`;

  const rules = await window.cma.rules();
  const entries = Object.entries(rules);
  $("rules").innerHTML = entries.length
    ? entries.map(([key, v]) =>
        `<li data-key="${key}"><span class="v ${v}">${v}</span><code>${key}</code><button>forget</button></li>`).join("")
    : `<li class="none">Nothing standing — every prompt still asks.</li>`;
}

$("rules").addEventListener("click", async (e) => {
  const li = (e.target as HTMLElement).closest("li[data-key]");
  if (!li || (e.target as HTMLElement).tagName !== "BUTTON") return;
  await window.cma.forget(li.getAttribute("data-key")!);
  void render();
});

$("console").addEventListener("click", () => window.cma.openConsole());
$("demo").addEventListener("click", () => void window.cma.demoAsk());
void render();
