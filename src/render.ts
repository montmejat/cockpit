// Renders a recap as one self-contained HTML page (no dependencies).
// Depth: overview -> themes -> groups -> decisions -> evidence (raw events).

import type { Event } from "./transcript.ts";
import type { Decision, Recap } from "./recap.ts";

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

interface PageInput {
  title: string;
  source: string;
  recap: Recap;
  decisions: Decision[];
  events: Event[];
  check: { missing: string[]; repeated: string[]; unknown: string[] };
  costUsd: number;
}

export function renderPage(p: PageInput): string {
  const byId = new Map(p.decisions.map((d) => [d.id, d]));
  const evById = new Map(p.events.map((e) => [e.id, e]));

  const flags = (node: string) =>
    `<span class="flags" data-node="${node}">` +
    ["wrong", "missing detail", "useful"].map((f) => `<button data-flag="${f}">${f}</button>`).join("") +
    `</span>`;

  const evidence = (d: Decision) =>
    d.evidence
      .map((id) => evById.get(id))
      .filter((e): e is Event => !!e)
      .map((e) => `<div class="ev"><span class="tag">${e.id} · ${e.kind}</span><pre>${esc(e.full)}</pre></div>`)
      .join("") || `<p class="muted">No evidence linked.</p>`;

  const decision = (d: Decision) => `
    <details class="d4 decision" data-depth="4">
      <summary><span class="lvl ${d.level}">${d.level}</span> ${esc(d.title)}
        <span class="area">${esc(d.area)}</span><span class="by ${d.decided_by}">${d.decided_by}</span></summary>
      <dl>
        <dt>Context</dt><dd>${esc(d.context)}</dd>
        <dt>Chose</dt><dd>${esc(d.chose)}</dd>
        ${d.over.length ? `<dt>Over</dt><dd>${d.over.map(esc).join("; ")}</dd>` : ""}
        <dt>Because</dt><dd>${esc(d.because)}</dd>
        <dt>Accepting</dt><dd>${esc(d.accepting)}</dd>
      </dl>
      ${flags(d.id)}
      <details class="d5" data-depth="5"><summary>Evidence (${d.evidence.length})</summary>${evidence(d)}</details>
    </details>`;

  const themes = p.recap.themes
    .map(
      (t, ti) => `
    <details class="d2 theme" data-depth="2">
      <summary><span class="lvl ${t.level}">${t.level}</span> <strong>${esc(t.title)}</strong></summary>
      <p>${esc(t.summary)}</p>${flags(`t${ti}`)}
      ${t.groups
        .map(
          (g, gi) => `
        <details class="d3 group" data-depth="3">
          <summary>${esc(g.title)} <span class="muted">(${g.decisions.length})</span></summary>
          <p>${esc(g.summary)}</p>${flags(`t${ti}g${gi}`)}
          ${g.decisions.map((id) => byId.get(id)).filter((d): d is Decision => !!d).map(decision).join("")}
        </details>`,
        )
        .join("")}
    </details>`,
    )
    .join("");

  const problems = [
    p.check.missing.length && `dropped by the merge: ${p.check.missing.join(", ")}`,
    p.check.repeated.length && `in more than one group: ${p.check.repeated.join(", ")}`,
    p.check.unknown.length && `made-up ids: ${p.check.unknown.join(", ")}`,
  ].filter(Boolean);
  const orphans = p.check.missing.map((id) => byId.get(id)).filter((d): d is Decision => !!d);

  const byLevel = Object.fromEntries(
    ["purpose", "system", "module", "code"].map((l) => [l, p.decisions.filter((d) => d.level === l).length]),
  );
  const byUser = p.decisions.filter((d) => d.decided_by === "user").length;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Decision Recap</title>
<style>
:root{--bg:#fbfaf8;--fg:#1d1c1a;--muted:#6b6760;--line:#e3e0da;--card:#fff;--accent:#3b5bdb;
--purpose:#9c36b5;--system:#1971c2;--module:#2b8a3e;--code:#7c6f64;--user:#c2410c;--agent:#6b6760;--flag:#fff3bf}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#171614;--fg:#ece9e4;--muted:#9a958c;--line:#2e2c28;--card:#1f1e1b;--accent:#7b9bff;--flag:#4a3f12}}
:root[data-theme="dark"]{--bg:#171614;--fg:#ece9e4;--muted:#9a958c;--line:#2e2c28;--card:#1f1e1b;--accent:#7b9bff;--flag:#4a3f12}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:860px;margin:0 auto;padding:24px 16px 80px}
h1{font-size:22px;margin:0 0 4px}.muted{color:var(--muted)}.src{font-size:13px;color:var(--muted);word-break:break-all}
.bar{position:sticky;top:0;background:var(--bg);padding:10px 0;border-bottom:1px solid var(--line);margin:16px 0;display:flex;gap:6px;flex-wrap:wrap;align-items:center;z-index:1}
.bar button,.flags button{font:inherit;font-size:13px;border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:6px;padding:3px 9px;cursor:pointer}
.bar button.on{border-color:var(--accent);color:var(--accent)}
details{border-left:2px solid var(--line);margin:6px 0 6px 4px;padding:2px 0 2px 12px}
summary{cursor:pointer;padding:3px 0}details.theme{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px 14px;margin:10px 0}
.lvl{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:var(--card);background:var(--muted);border-radius:4px;padding:1px 6px}
.lvl.purpose{background:var(--purpose)}.lvl.system{background:var(--system)}.lvl.module{background:var(--module)}.lvl.code{background:var(--code)}
.area{font:12px ui-monospace,monospace;color:var(--muted);margin-left:6px}
.by{font-size:11px;margin-left:6px;border:1px solid currentColor;border-radius:10px;padding:0 6px}.by.user{color:var(--user)}.by.agent{color:var(--agent)}
dl{display:grid;grid-template-columns:90px 1fr;gap:2px 10px;margin:6px 0;font-size:14px}dt{color:var(--muted)}dd{margin:0}
pre{white-space:pre-wrap;word-break:break-word;font:12px/1.45 ui-monospace,monospace;background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:8px;max-height:320px;overflow:auto;margin:4px 0}
.tag{font:11px ui-monospace,monospace;color:var(--muted)}.flags{display:inline-flex;gap:4px;margin:2px 0 4px}.flags button.on{background:var(--flag)}
.warn{border:1px solid var(--user);border-radius:8px;padding:8px 12px;margin:12px 0}
.stats{display:flex;gap:14px;flex-wrap:wrap;font-size:13px;color:var(--muted)}
</style></head><body><main>
<h1>${esc(p.title)}</h1>
<div class="src">${esc(p.source)}</div>
<p>${esc(p.recap.overview)}</p>${flags("overview")}
<div class="stats"><span>${p.decisions.length} decisions</span>
<span>purpose ${byLevel.purpose} · system ${byLevel.system} · module ${byLevel.module} · code ${byLevel.code}</span>
<span>${byUser} decided by you</span><span>${p.events.length} transcript events</span><span>model cost $${p.costUsd.toFixed(4)}</span></div>
${problems.length ? `<div class="warn"><strong>Merge check:</strong> ${problems.join("; ")}</div>` : ""}
<div class="bar"><span class="muted">Depth</span>
${["Themes", "Groups", "Decisions", "Evidence"].map((l, i) => `<button data-depth="${i + 1}">${l}</button>`).join("")}
<span style="flex:1"></span><button id="copy">Copy flags</button></div>
${themes}
${orphans.length ? `<details class="d2 theme" data-depth="2"><summary><strong>Not in any group</strong></summary>${orphans.map(decision).join("")}</details>` : ""}
</main>
<script>
const KEY = "cockpit-flags:" + ${JSON.stringify(p.source)};
let flags = {}; try { flags = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch {}
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(flags)); } catch {} };
document.querySelectorAll(".flags").forEach(el => {
  const node = el.dataset.node;
  el.querySelectorAll("button").forEach(b => {
    const f = b.dataset.flag;
    if ((flags[node] || []).includes(f)) b.classList.add("on");
    b.onclick = () => {
      const set = new Set(flags[node] || []);
      set.has(f) ? set.delete(f) : set.add(f);
      flags[node] = [...set]; if (!set.size) delete flags[node];
      b.classList.toggle("on"); save();
    };
  });
});
function setDepth(n) {
  document.querySelectorAll("details[data-depth]").forEach(d => d.open = Number(d.dataset.depth) <= n);
  document.querySelectorAll(".bar button[data-depth]").forEach(b => b.classList.toggle("on", Number(b.dataset.depth) === n));
}
document.querySelectorAll(".bar button[data-depth]").forEach(b => b.onclick = () => setDepth(Number(b.dataset.depth)));
setDepth(1);
document.getElementById("copy").onclick = () => {
  const text = JSON.stringify(flags, null, 1);
  navigator.clipboard?.writeText(text).then(() => alert("Flags copied. Paste them back to Claude."), () => prompt("Copy:", text));
};
</script></body></html>`;
}
