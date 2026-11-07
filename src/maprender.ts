// Renders the E2 map as one HTML page. The graph uses Cytoscape.js (compound
// nodes, so components can contain modules). Editing works when the page is
// served by `npm run map -- <dir> --serve`; a plain file is read-only.

import type { Skeleton } from "./skeleton.ts";
import type { MapModel, Overrides } from "./overlay.ts";

export interface MapPage {
  name: string;
  skeleton: Skeleton;
  model: MapModel;
  overrides: Overrides;
  costUsd: number;
}

const safeJson = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");

export function renderMap(p: MapPage): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Project Map</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/cytoscape/3.30.2/cytoscape.min.js"></script>
<style>
:root{--bg:#fbfaf8;--fg:#1d1c1a;--muted:#6b6760;--line:#d9d5ce;--card:#fff;--accent:#3b5bdb;--user:#c2410c;
--comp:#eef2ff;--comp-line:#9aa8e8;--node:#ffffff;--edge:#a8a29a;--hl:#f59f00}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#171614;--fg:#ece9e4;--muted:#9a958c;--line:#34312c;--card:#1f1e1b;--accent:#7b9bff;--comp:#22263a;--comp-line:#4b5795;--node:#2a2925;--edge:#6b665e}}
:root[data-theme="dark"]{--bg:#171614;--fg:#ece9e4;--muted:#9a958c;--line:#34312c;--card:#1f1e1b;--accent:#7b9bff;--comp:#22263a;--comp-line:#4b5795;--node:#2a2925;--edge:#6b665e}
*{box-sizing:border-box}html,body{height:100%}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,sans-serif;display:flex;flex-direction:column}
header{padding:12px 16px;border-bottom:1px solid var(--line);display:flex;gap:12px;align-items:center;flex-wrap:wrap}
h1{font-size:18px;margin:0}.muted{color:var(--muted)}
button,select,input,textarea{font:inherit;font-size:13px;border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:6px;padding:4px 9px}
button{cursor:pointer}button.on{border-color:var(--accent);color:var(--accent)}
.wrap{flex:1;display:flex;min-height:0}#cy{flex:1;min-width:0}
aside{width:380px;max-width:45vw;border-left:1px solid var(--line);overflow:auto;padding:14px 16px;background:var(--card)}
@media (max-width:700px){.wrap{flex-direction:column}aside{width:auto;max-width:none;border-left:0;border-top:1px solid var(--line);max-height:50vh}}
aside h2{font-size:16px;margin:0 0 4px}aside h3{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin:14px 0 4px}
.src{font-size:11px;border:1px solid currentColor;border-radius:10px;padding:0 6px;margin-left:6px}.src.user{color:var(--user)}.src.agent{color:var(--muted)}
ul{margin:0;padding-left:18px}li{margin:2px 0}code,.mono{font:12px ui-monospace,monospace}
a{color:var(--accent);cursor:pointer;text-decoration:none}
.warn{color:var(--user);font-size:13px}.row{display:flex;gap:6px;align-items:center;margin:4px 0}.row>*{flex:1}
textarea{width:100%;min-height:54px}
</style></head><body>
<header><h1>${p.name}</h1>
<span class="muted" id="stats"></span>
<span style="flex:1"></span>
<span class="muted">Zoom</span><button data-zoom="system">System</button><button data-zoom="module">Modules</button>
</header>
<div class="wrap"><div id="cy"></div><aside id="panel"></aside></div>
<script>
const SK = ${safeJson(p.skeleton)};
let MODEL = ${safeJson(p.model)};
let OV = ${safeJson(p.overrides)};
const COST = ${p.costUsd};
const editable = location.protocol.startsWith("http");
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const mod = Object.fromEntries(SK.modules.map(m => [m.id, m]));
const esc = s => String(s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"})[c]);
let zoom = location.hash === "#module" ? "module" : "system", cy;

function compOf(id) { return MODEL.components.find(c => c.modules.includes(id)); }

// Layered layout: components that use others on top, foundations at the bottom.
// The same positions are used at every zoom level, so the map keeps its shape.
function layout() {
  const names = MODEL.components.map(c => c.name);
  const w = new Map();
  for (const e of SK.edges) {
    const a = compOf(e.from)?.name, b = compOf(e.to)?.name;
    if (a && b && a !== b) w.set(a + "\u0000" + b, (w.get(a + "\u0000" + b) || 0) + e.refs);
  }
  // Drop the weaker direction of each mutual pair, then break leftover cycles with a DFS.
  const out = new Map(names.map(n => [n, []]));
  for (const [k, refs] of w) { const [a, b] = k.split("\u0000");
    if ((w.get(b + "\u0000" + a) || 0) <= refs) out.get(a).push(b); }
  const state = new Map(), dag = new Map(names.map(n => [n, []]));
  const visit = n => { state.set(n, 1);
    for (const m of out.get(n)) { if (state.get(m) === 1) continue; dag.get(n).push(m); if (!state.get(m)) visit(m); }
    state.set(n, 2); };
  const net = n => [...w].reduce((s, [k, r]) => s + (k.startsWith(n + "\u0000") ? r : 0) - (k.endsWith("\u0000" + n) ? r : 0), 0);
  [...names].sort((a, b) => net(b) - net(a)).forEach(n => { if (!state.get(n)) visit(n); });
  const rank = new Map(names.map(n => [n, 0]));
  for (let i = 0; i < names.length; i++)
    for (const [a, bs] of dag) for (const b of bs) rank.set(b, Math.max(rank.get(b), rank.get(a) + 1));
  const rows = [];
  for (const n of names) (rows[rank.get(n)] ??= []).push(n);
  // Module grid inside each component; rows sized to their tallest component.
  const CW = 190, CH = 62, GAP = 70, pos = {};
  let y = 0;
  for (const row of rows.filter(Boolean)) {
    const dims = row.map(n => { const k = MODEL.components.find(c => c.name === n).modules.length;
      const cols = Math.min(k, k > 4 ? 3 : 2) || 1; return { n, cols, rws: Math.ceil(k / cols) || 1 }; });
    const h = Math.max(...dims.map(d => d.rws)) * CH;
    let x = 0;
    for (const d of dims) {
      const wd = d.cols * CW;
      pos["c:" + d.n] = { x: x + wd / 2, y: y + h / 2 };
      MODEL.components.find(c => c.name === d.n).modules.forEach((m, i) =>
        pos["m:" + m] = { x: x + (i % d.cols) * CW + CW / 2, y: y + Math.floor(i / d.cols) * CH + CH / 2 });
      x += wd + GAP;
    }
    y += h + GAP + 30;
  }
  return pos;
}

function elements() {
  const els = [];
  if (zoom === "system") {
    const agg = new Map();
    for (const e of SK.edges) {
      const a = compOf(e.from)?.name, b = compOf(e.to)?.name;
      if (!a || !b || a === b) continue;
      agg.set(a + "\\u0000" + b, (agg.get(a + "\\u0000" + b) || 0) + e.refs);
    }
    for (const c of MODEL.components)
      els.push({ data: { id: "c:" + c.name, label: c.name + "\\n" + c.modules.length + (c.modules.length === 1 ? " module" : " modules"), kind: "comp-leaf" } });
    for (const [k, refs] of agg) { const [a, b] = k.split("\\u0000");
      els.push({ data: { id: "e:" + k, source: "c:" + a, target: "c:" + b, refs } }); }
  } else {
    for (const c of MODEL.components) els.push({ data: { id: "c:" + c.name, label: c.name, kind: "comp" } });
    for (const m of SK.modules)
      els.push({ data: { id: "m:" + m.id, label: m.id + "\\n" + m.lines + " lines", parent: "c:" + compOf(m.id)?.name, kind: "mod" } });
    for (const e of SK.edges) els.push({ data: { id: "e:" + e.from + ">" + e.to, source: "m:" + e.from, target: "m:" + e.to, refs: e.refs }, classes: "quiet" });
  }
  return els;
}

function draw() {
  document.querySelectorAll("[data-zoom]").forEach(b => b.classList.toggle("on", b.dataset.zoom === zoom));
  const totalLines = SK.modules.reduce((s, m) => s + m.lines, 0);
  document.getElementById("stats").textContent =
    SK.crates.length + " crates · " + SK.modules.length + " modules · " + totalLines + " lines · " +
    MODEL.components.length + " components · agent cost $" + COST.toFixed(4) + (editable ? "" : " · read-only (open with --serve to edit)");
  const POS = layout();
  cy?.destroy();
  cy = cytoscape({
    container: document.getElementById("cy"), elements: elements(), wheelSensitivity: 0.3, maxZoom: 1.6,
    style: [
      { selector: "node", style: { label: "data(label)", "text-wrap": "wrap", "font-size": 11, color: css("--fg"),
        "text-valign": "center", "background-color": css("--node"), "border-width": 1, "border-color": css("--line"),
        shape: "round-rectangle", width: "label", height: "label", padding: 10 } },
      { selector: 'node[kind="comp-leaf"]', style: { "background-color": css("--comp"), "border-color": css("--comp-line"), "font-size": 13, "font-weight": 600 } },
      { selector: 'node[kind="comp"]', style: { "background-color": css("--comp"), "border-color": css("--comp-line"),
        "text-valign": "top", "text-halign": "center", "font-weight": 600, "font-size": 12, padding: 14 } },
      { selector: "edge", style: { width: "mapData(refs, 1, 150, 1, 6)", "line-color": css("--edge"), "target-arrow-color": css("--edge"),
        "target-arrow-shape": "triangle", "curve-style": "bezier", opacity: 0.55, "arrow-scale": 0.8 } },
      { selector: "edge.quiet", style: { opacity: 0 } },
      { selector: ".hl", style: { "border-color": css("--hl"), "border-width": 2, "line-color": css("--hl"), "target-arrow-color": css("--hl"), opacity: 1 } },
      { selector: ".dim", style: { opacity: 0.15 } },
    ],
    layout: { name: "preset", positions: n => POS[n.id()] || { x: 0, y: 0 }, padding: 30 },
  });
  cy.on("tap", "node", ev => select(ev.target.id()));
  cy.on("tap", ev => { if (ev.target === cy) { cy.elements().removeClass("hl dim"); overview(); } });
}

function focus(nodeId) {
  cy.elements().removeClass("hl dim");
  if (zoom === "module") cy.edges().addClass("quiet");
  const n = cy.getElementById(nodeId); if (!n.length) return;
  const keep = n.closedNeighborhood().union(n.descendants()).union(n.ancestors());
  cy.elements().not(keep).addClass("dim"); n.addClass("hl"); n.connectedEdges().addClass("hl").removeClass("quiet");
}

function overview() {
  const w = MODEL.warnings.map(w => "<li class=warn>" + esc(w) + "</li>").join("");
  document.getElementById("panel").innerHTML =
    "<h2>Components</h2><p class=muted>Click a component or module. System zoom shows components; Modules zoom shows what's inside.</p>" +
    MODEL.components.map(c => "<p><a data-sel='c:" + esc(c.name) + "'><strong>" + esc(c.name) + "</strong></a><span class='src " + c.source + "'>" +
      (c.source === "user" ? "you" : "agent") + "</span><br>" + esc(c.description) + "</p>").join("") +
    (w ? "<h3>Warnings</h3><ul>" + w + "</ul>" : "");
  wire();
}

function select(id) {
  focus(id);
  if (id.startsWith("c:")) return showComp(id.slice(2));
  if (id.startsWith("m:")) return showMod(id.slice(2));
}

function showComp(name) {
  const c = MODEL.components.find(c => c.name === name); if (!c) return overview();
  document.getElementById("panel").innerHTML =
    "<p><a data-back>← all components</a></p><h2>" + esc(c.name) + "<span class='src " + c.source + "'>" + (c.source === "user" ? "you" : "agent") + "</span></h2>" +
    "<p>" + esc(c.description) + "</p><h3>Modules</h3><ul>" +
    c.modules.map(m => "<li><a data-sel='m:" + esc(m) + "' class=mono>" + esc(m) + "</a> <span class=muted>" + esc(MODEL.roles[m]?.text || "") + "</span></li>").join("") + "</ul>" +
    (editable ? "<h3>Correct it</h3><div class=row><input id=rn value='" + esc(c.name) + "'><button id=rnb>Rename</button></div>" +
      "<textarea id=ds placeholder='Description'>" + esc(c.description) + "</textarea><button id=dsb>Save description</button>" : "");
  wire();
  if (!editable) return;
  document.getElementById("rnb").onclick = () => {
    const to = document.getElementById("rn").value.trim(); if (!to || to === name) return;
    OV.modules ??= {}; for (const m of c.modules) OV.modules[m] = { ...(OV.modules[m] || {}), component: to };
    OV.components ??= {}; OV.components[to] = { ...(OV.components[name] || {}), description: OV.components[name]?.description ?? c.description };
    delete OV.components[name]; save("c:" + to);
  };
  document.getElementById("dsb").onclick = () => {
    OV.components ??= {}; OV.components[name] = { ...(OV.components[name] || {}), description: document.getElementById("ds").value.trim() };
    save("c:" + name);
  };
}

function showMod(id) {
  const m = mod[id], c = compOf(id), role = MODEL.roles[id] || { text: "", source: "agent" };
  const uses = SK.edges.filter(e => e.from === id).sort((a, b) => b.refs - a.refs);
  const usedBy = SK.edges.filter(e => e.to === id).sort((a, b) => b.refs - a.refs);
  const link = (x, n) => "<li><a data-sel='m:" + esc(x) + "' class=mono>" + esc(x) + "</a> <span class=muted>" + n + " refs</span></li>";
  const libs = Object.entries(m.libs).sort((a, b) => b[1] - a[1]).map(([l, n]) => esc(l) + " <span class=muted>(" + n + ")</span>").join(", ");
  document.getElementById("panel").innerHTML =
    "<p><a data-sel='c:" + esc(c?.name || "") + "'>← " + esc(c?.name || "") + "</a></p>" +
    "<h2 class=mono>" + esc(id) + "</h2><p class=muted class=mono>" + esc(m.file) + " · " + m.lines + " lines</p>" +
    "<p>" + esc(role.text) + "<span class='src " + role.source + "'>" + (role.source === "user" ? "you" : "agent") + "</span></p>" +
    (m.doc ? "<h3>Doc comment</h3><p>" + esc(m.doc) + "</p>" : "") +
    "<h3>Items</h3><ul>" + (m.items.filter(i => !i.owner).map(i => "<li><span class=mono>" + esc(i.name) + "</span> <span class=muted>" + esc(i.kind.toLowerCase()) +
      " · line " + i.line + "</span>" + (i.doc ? "<br><span class=muted>" + esc(i.doc) + "</span>" : "") + "</li>").join("") || "<li class=muted>none</li>") + "</ul>" +
    "<h3>Uses</h3><ul>" + (uses.map(e => link(e.to, e.refs)).join("") || "<li class=muted>nothing in the project</li>") + "</ul>" +
    "<h3>Used by</h3><ul>" + (usedBy.map(e => link(e.from, e.refs)).join("") || "<li class=muted>nothing</li>") + "</ul>" +
    (libs ? "<h3>Libraries</h3><p>" + libs + "</p>" : "") +
    (editable ? "<h3>Correct it</h3><div class=row><select id=mv>" + MODEL.components.map(x => "<option" + (x.name === c?.name ? " selected" : "") + ">" + esc(x.name) + "</option>").join("") +
      "<option value='__new'>New component…</option></select><button id=mvb>Move</button></div>" +
      "<textarea id=rl placeholder='Role'>" + esc(role.text) + "</textarea><button id=rlb>Save role</button>" : "");
  wire();
  if (!editable) return;
  document.getElementById("mvb").onclick = () => {
    let to = document.getElementById("mv").value;
    if (to === "__new") to = (prompt("Name of the new component:") || "").trim();
    if (!to) return;
    OV.modules ??= {}; OV.modules[id] = { ...(OV.modules[id] || {}), component: to }; save("m:" + id);
  };
  document.getElementById("rlb").onclick = () => {
    OV.modules ??= {}; OV.modules[id] = { ...(OV.modules[id] || {}), role: document.getElementById("rl").value.trim() }; save("m:" + id);
  };
}

function wire() {
  document.querySelectorAll("[data-sel]").forEach(a => a.onclick = () => select(a.dataset.sel));
  document.querySelectorAll("[data-back]").forEach(a => a.onclick = () => { cy.elements().removeClass("hl dim"); overview(); });
}

async function save(reselect) {
  const r = await fetch("/api/overrides", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(OV) });
  if (!r.ok) return alert("Save failed: " + await r.text());
  ({ model: MODEL, overrides: OV } = await r.json());
  draw();
  if (reselect && zoom === "system" && reselect.startsWith("m:")) zoom = "module", draw();
  select(reselect);
}

document.querySelectorAll("[data-zoom]").forEach(b => b.onclick = () => { zoom = b.dataset.zoom; draw(); overview(); });
draw(); overview();
</script></body></html>`;
}
