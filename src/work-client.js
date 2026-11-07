// Work page: the project map is the main view. Pick a turn and what it changed lights up
// on the map; click a component or module to go one level deeper, down to its diff.
// Left: turns or files. Blocks can be dragged; their places are saved per zoom level.
// Polls the server so running turns and finished analyses show up on their own.

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const FONT = '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace';
const NUL = "\u0000";
const store = { get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };

let SK = INIT.map.skeleton, MODEL = INIT.map.model, LAYOUT = INIT.layout || {}, FILES = INIT.files || [];
let turns = INIT.turns, selected = INIT.selected, detail = INIT.detail;
let zoom = store.get("cockpit-zoom", "system"), tab = new URLSearchParams(location.search).get("tab") || store.get("cockpit-tab", "turns"), allArrows = store.get("cockpit-arrows", "") === "1";
let focusId = null, cy = null, stamp = "";
const openDirs = new Set();

const modById = () => Object.fromEntries(SK.modules.map((m) => [m.id, m]));
const compOf = (id) => MODEL.components.find((c) => c.modules.includes(id));
const modOfFile = (path) => SK.modules.find((m) => m.file === path);
const stampOf = (t) => (t ? [t.id, t.status, t.touched, t.endedAt].join("|") : "");
const ago = (iso) => {
  const s = (Date.now() - new Date(iso)) / 1000;
  return s < 60 ? "just now" : s < 3600 ? Math.round(s / 60) + "m ago" : s < 86400 ? Math.round(s / 3600) + "h ago" : new Date(iso).toLocaleDateString();
};
const sign = { added: "<span class=add>+</span>", removed: "<span class=del>−</span>", changed: "<span class=chg>~</span>" };
const count = (items, ch) => items.filter((i) => i.change === ch).length;
const itemCounts = (items) => ["added", "changed", "removed"].map((ch) => [ch, count(items, ch)]).filter(([, n]) => n)
  .map(([ch, n]) => "<span class=" + { added: "add", changed: "chg", removed: "del" }[ch] + ">" + { added: "+", changed: "~", removed: "−" }[ch] + n + "</span>").join(" ");

// What the selected turn changed, keyed the way the map draws it.
function changes() {
  const a = detail?.status === "done" ? detail.analysis : null;
  const mods = new Map(), comps = new Map(), live = new Set(), files = new Map();
  for (const m of a?.modules ?? []) {
    mods.set(m.id, m);
    const c = compOf(m.id)?.name ?? m.component;
    if (!comps.has(c)) comps.set(c, []);
    comps.get(c).push(m);
  }
  for (const f of a?.files ?? []) files.set(f.path, f);
  if (detail?.status === "running") {
    for (const x of detail.touched) if (!files.has(x.file)) files.set(x.file, { path: x.file, status: "live" });
    for (const m of SK.modules) if (files.has(m.file)) live.add(m.id);
  }
  const key = (d) => d.from + NUL + d.to;
  return {
    a, mods, comps, live, files,
    compDeps: new Map((a?.componentDeps ?? []).map((d) => [key(d), d])),
    modDeps: new Map((a?.deps ?? []).map((d) => [key(d), d])),
    any: mods.size > 0 || live.size > 0,
  };
}

// ---- map ----

function elements(ch) {
  const els = [];
  // Arrows: hidden unless "all arrows" is on, the turn changed that dependency, or a block is focused (see markFocus).
  const edgeClass = (d) => (d ? (d.before === 0 ? "dep-new" : d.after === 0 ? "dep-gone" : "dep-chg") : allArrows ? "" : "hidden");
  if (zoom === "system") {
    const agg = new Map();
    for (const e of SK.edges) {
      const a = compOf(e.from)?.name, b = compOf(e.to)?.name;
      if (a && b && a !== b) agg.set(a + NUL + b, (agg.get(a + NUL + b) || 0) + e.refs);
    }
    for (const c of MODEL.components) {
      const touched = ch.comps.get(c.name) ?? [];
      const live = c.modules.some((m) => ch.live.has(m));
      const sub = touched.length ? touched.length + "/" + c.modules.length + " changed" : c.modules.length + (c.modules.length === 1 ? " module" : " modules");
      els.push({ data: { id: "c:" + c.name, label: c.name + "\n" + sub, kind: "comp-leaf" },
        classes: live ? "live" : touched.length ? (touched.every((m) => m.status === "added") ? "added" : "changed") : ch.any ? "quiet" : "" });
    }
    for (const [k, refs] of agg) {
      const [a, b] = k.split(NUL);
      els.push({ data: { id: "e:" + k, source: "c:" + a, target: "c:" + b, refs }, classes: edgeClass(ch.compDeps.get(k)) });
    }
  } else {
    for (const c of MODEL.components)
      els.push({ data: { id: "c:" + c.name, label: c.name, kind: "comp" }, classes: ch.comps.has(c.name) ? "touched" : "" });
    for (const m of SK.modules) {
      const t = ch.mods.get(m.id);
      const sub = t ? (t.status === "added" ? "new · " + m.lines + "L" : t.linesBefore + "→" + t.linesAfter + "L") : m.lines + "L";
      els.push({ data: { id: "m:" + m.id, label: m.id + "\n" + sub, parent: "c:" + compOf(m.id)?.name, kind: "mod" },
        classes: ch.live.has(m.id) ? "live" : t ? t.status : ch.any ? "quiet" : "" });
    }
    for (const e of SK.edges) {
      const d = ch.modDeps.get(e.from + NUL + e.to);
      els.push({ data: { id: "e:" + e.from + ">" + e.to, source: "m:" + e.from, target: "m:" + e.to, refs: e.refs }, classes: edgeClass(d) });
    }
  }
  return els;
}

// Saved places win. A module you haven't placed yet goes under its component's lowest placed module.
function positions() {
  const POS = mapLayout(SK, MODEL), saved = LAYOUT[zoom] || {};
  const out = { ...POS };
  if (zoom === "module") {
    for (const c of MODEL.components) {
      const placed = c.modules.filter((m) => saved["m:" + m]);
      let low = placed.length ? Math.max(...placed.map((m) => saved["m:" + m].y)) : null;
      for (const m of c.modules) {
        if (saved["m:" + m]) out["m:" + m] = saved["m:" + m];
        else if (low !== null) out["m:" + m] = { x: saved["m:" + placed[0]].x, y: (low += 62) };
      }
    }
  } else Object.assign(out, saved);
  return out;
}

function drawMap() {
  document.querySelectorAll("[data-zoom]").forEach((b) => b.classList.toggle("on", b.dataset.zoom === zoom));
  $("#arrows").checked = allArrows;
  $("#stats").textContent = SK.modules.length + " modules · " + MODEL.components.length + " components";
  const ch = changes(), POS = positions();
  const view = cy && cy.data("zoom") === zoom ? { zoom: cy.zoom(), pan: cy.pan() } : null;
  cy?.destroy();
  const color = (cls, v) => ({ selector: "node." + cls, style: { "border-color": css(v), "border-width": 2 } });
  cy = cytoscape({
    container: $("#cy"), elements: elements(ch), wheelSensitivity: 0.3, maxZoom: 2,
    style: [
      { selector: "node", style: { label: "data(label)", "text-wrap": "wrap", "font-size": 11, "font-family": FONT, color: css("--fg"),
        "text-valign": "center", "background-color": css("--node"), "border-width": 1, "border-color": css("--line-strong"),
        shape: "rectangle", width: "label", height: "label", padding: 9 } },
      { selector: 'node[kind="comp-leaf"]', style: { "background-color": css("--comp"), "border-color": css("--comp-line"), "font-size": 12, "font-weight": 700 } },
      { selector: 'node[kind="comp"]', style: { "background-color": css("--comp"), "border-color": css("--comp-line"), "border-style": "dashed",
        "text-valign": "top", "text-halign": "center", "font-weight": 700, "font-size": 11, padding: 14, "text-margin-y": -2 } },
      { selector: "edge", style: { width: "mapData(refs, 1, 150, 1, 4)", "line-color": css("--edge"), "target-arrow-color": css("--edge"),
        "target-arrow-shape": "triangle", "curve-style": "bezier", opacity: 0.5, "arrow-scale": 0.7 } },
      { selector: "node.quiet", style: { opacity: 0.4 } },
      { selector: "edge.hidden", style: { display: "none" } },
      color("added", "--add"), color("changed", "--chg"), color("removed", "--del"), color("live", "--accent"),
      { selector: "node.touched", style: { "border-color": css("--chg"), "border-width": 1 } },
      { selector: "edge.dep-new", style: { "line-color": css("--add"), "target-arrow-color": css("--add"), opacity: 1, width: 2 } },
      { selector: "edge.dep-chg", style: { "line-color": css("--chg"), "target-arrow-color": css("--chg"), opacity: 1, width: 2 } },
      { selector: "edge.near", style: { display: "element", opacity: 0.8, "line-color": css("--accent"), "target-arrow-color": css("--accent") } },
      { selector: "node.focus", style: { "underlay-color": css("--accent"), "underlay-opacity": 0.2, "underlay-padding": 6, opacity: 1 } },
    ],
    layout: { name: "preset", positions: (n) => POS[n.id()] || { x: 0, y: 0 }, padding: 30, fit: !view },
  });
  cy.data("zoom", zoom);
  if (view) { cy.zoom(view.zoom); cy.pan(view.pan); }
  cy.on("tap", "node", (ev) => go(ev.target.id()));
  cy.on("tap", (ev) => { if (ev.target === cy) go(null); });
  cy.on("dragfree", "node", saveLayout);
  markFocus();
}

let saveTimer;
function saveLayout() {
  // Leaf blocks only: a component box at module zoom is just the hull of its modules.
  const pos = {};
  cy.nodes().filter((n) => !n.isParent()).forEach((n) => { const p = n.position(); pos[n.id()] = { x: Math.round(p.x), y: Math.round(p.y) }; });
  LAYOUT[zoom] = pos;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => fetch("api/layout", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(LAYOUT) }), 300);
}

// The map node that stands for the current focus (a file maps to its module, a module to its component at system zoom).
function focusNode() {
  if (!focusId) return null;
  let id = focusId;
  if (/^[fs]:/.test(id)) { const m = modOfFile(id.slice(2).replace(/:\d+$/, "")); if (!m) return null; id = "m:" + m.id; }
  if (id.startsWith("m:") && zoom === "system") id = "c:" + (compOf(id.slice(2))?.name ?? "");
  return id;
}

function markFocus() {
  if (!cy) return;
  cy.nodes().removeClass("focus");
  cy.edges().removeClass("near");
  const id = focusNode();
  if (!id) return;
  const n = cy.getElementById(id);
  n.addClass("focus");
  n.connectedEdges().addClass("near");
}

function setZoom(z) {
  zoom = z;
  store.set("cockpit-zoom", z);
  drawMap();
}

// ---- navigation ----
// null = the turn, "c:<component>", "m:<module>", "f:<path>" (a file's diff, "*" = all), "s:<path>[:<line>]" (a file's source).

function go(id) {
  focusId = id;
  history.replaceState(null, "", location.search + (id ? "#" + encodeURIComponent(id) : ""));
  const path = /^[fs]:/.test(id ?? "") ? id.slice(2).replace(/:\d+$/, "") : null;
  if (path) for (let d = path; d.includes("/"); ) openDirs.add((d = d.slice(0, d.lastIndexOf("/"))));
  const wantsModule = (id?.startsWith("m:") && SK.modules.some((m) => m.id === id.slice(2))) || (path && modOfFile(path));
  if (wantsModule && zoom === "system") setZoom("module");
  else markFocus();
  drawPanel();
  if (tab === "files") drawNav();
}

function drawNav() {
  $("#tabs").innerHTML = ["turns", "files"].map((t) => "<button data-tab=" + t + (t === tab ? " class=on" : "") + ">" + t + "</button>").join("");
  document.querySelectorAll("[data-tab]").forEach((b) => b.onclick = () => { tab = b.dataset.tab; store.set("cockpit-tab", tab); drawNav(); });
  $("#navbody").innerHTML = tab === "turns" ? turnsHtml() : filesHtml();
  document.querySelectorAll(".turn").forEach((el) => el.onclick = () => selectTurn(el.dataset.id || null));
  document.querySelectorAll("#navbody details[data-dir]").forEach((d) => d.ontoggle = () => d.open ? openDirs.add(d.dataset.dir) : openDirs.delete(d.dataset.dir));
  wireGo($("#navbody"));
}

function turnsHtml() {
  const none = "<div class='turn" + (!selected ? " sel" : "") + "' data-id=''><div class=p>just the map</div><div class=meta>no turn selected</div></div>";
  return none + (turns.length ? turns.map((t) =>
    "<div class='turn" + (t.id === selected ? " sel" : "") + "' data-id='" + t.id + "'>" +
    "<div class=p>" + esc(t.prompt || "(empty prompt)") + "</div>" +
    "<div class=meta><span class='chip st-" + t.status + "'>" + t.status + "</span> " + ago(t.startedAt) +
    (t.files != null ? " · " + t.files + "f <span class=add>+" + t.added + "</span> <span class=del>−" + t.removed + "</span>" : "") +
    "</div></div>").join("")
    : "<p class=muted style='padding:12px'>No turns yet. Send a request to Claude Code in the project and it will show up here.</p>");
}

function filesHtml() {
  const ch = changes();
  const tree = {};
  for (const f of new Set([...FILES, ...ch.files.keys()])) {
    let node = tree;
    const parts = f.split("/");
    parts.slice(0, -1).forEach((p) => (node = node[p] ??= {}));
    node[parts.at(-1)] = f;
  }
  const changedUnder = (dir) => [...ch.files.keys()].some((f) => f.startsWith(dir + "/"));
  const cur = /^[fs]:/.test(focusId ?? "") ? focusId.slice(2).replace(/:\d+$/, "") : null;
  const mark = (f) => {
    const c = ch.files.get(f);
    if (!c) return "";
    if (c.status === "live") return " <span class=live-dot>●</span>";
    return " <span class=n>" + (c.status === "A" ? "<span class=add>new</span>" : c.status === "D" ? "<span class=del>del</span>" : "<span class=add>+" + c.added + "</span><span class=del>−" + c.removed + "</span>") + "</span>";
  };
  const render = (node, prefix) => Object.keys(node)
    .sort((a, b) => (typeof node[a] === "string") - (typeof node[b] === "string") || a.localeCompare(b))
    .map((k) => {
      const v = node[k];
      if (typeof v === "string") {
        const c = ch.files.get(v);
        return "<a class='file" + (v === cur ? " sel" : "") + (c ? " ch" : "") + "' data-go='" + (c && c.status !== "live" ? "f:" : "s:") + esc(v) + "'>" + esc(k) + mark(v) + "</a>";
      }
      const dir = prefix + k;
      const open = openDirs.has(dir) || changedUnder(dir);
      return "<details data-dir='" + esc(dir) + "'" + (open ? " open" : "") + "><summary" + (changedUnder(dir) ? " class=ch" : "") + ">" + esc(k) + "/</summary><div class=sub>" + render(v, dir + "/") + "</div></details>";
    }).join("");
  return "<div class=tree>" + render(tree, "") + "</div>";
}

async function selectTurn(id) {
  selected = id;
  history.replaceState(null, "", id ? "?turn=" + id : location.pathname);
  stamp = "";
  focusId = null;
  if (!id) { detail = null; drawNav(); drawMap(); drawPanel(); return; }
  await poll();
}

// ---- detail panel ----

function crumbs() {
  const parts = ["<a data-go=''>" + (detail ? "turn" : "map") + "</a>"];
  const modCrumbs = (id) => {
    const c = compOf(id)?.name ?? changes().mods.get(id)?.component;
    if (c) parts.push("<a data-go='c:" + esc(c) + "'>" + esc(c) + "</a>");
  };
  if (focusId?.startsWith("c:")) parts.push("<strong>" + esc(focusId.slice(2)) + "</strong>");
  if (focusId?.startsWith("m:")) { modCrumbs(focusId.slice(2)); parts.push("<strong>" + esc(focusId.slice(2)) + "</strong>"); }
  if (/^[fs]:/.test(focusId ?? "")) {
    const path = focusId.slice(2).replace(/:\d+$/, ""), m = modOfFile(path);
    if (m) { modCrumbs(m.id); parts.push("<a data-go='m:" + esc(m.id) + "'>" + esc(m.id) + "</a>"); }
    parts.push("<strong>" + esc(path === "*" ? "whole diff" : path.split("/").pop()) + "</strong>");
  }
  return "<div class=crumbs>" + parts.join("<span class=sep>/</span>") + "</div>";
}

function decisionsHtml(a) {
  if (!a.decisions.length) return "<p class=empty>No decisions in this turn.</p>";
  return a.decisions.map((d) =>
    "<details class=dec><summary><span class='lvl " + d.level + "'>" + d.level + "</span>" + esc(d.title) +
    "<span class='by " + d.decided_by + "'>" + d.decided_by + "</span></summary>" +
    "<div>chose: " + esc(d.chose) + (d.over.length ? " <span class=muted>over " + esc(d.over.join("; ")) + "</span>" : "") + "</div>" +
    "<div class=muted>because: " + esc(d.because) + "</div><div class=muted>" + esc(d.area) + "</div></details>").join("");
}

function depLine(d, fmt) {
  const kind = d.before === 0 ? "<span class=add>new</span>" : d.after === 0 ? "<span class=del>removed</span>" : "<span class=chg>" + d.before + "→" + d.after + " refs</span>";
  return "<li>" + fmt(d.from) + " → " + fmt(d.to) + " · " + kind + "</li>";
}

function turnPanel() {
  const t = detail;
  if (!t) {
    return "<h2>map</h2><p class=muted>Pick a turn to see what it changed. Drag blocks to place them; places are saved.</p>" +
      MODEL.components.map((c) => "<p><a data-go='c:" + esc(c.name) + "'><strong>" + esc(c.name) + "</strong></a><br><span class=muted>" + esc(c.description) + "</span></p>").join("");
  }
  let h = "<blockquote>" + esc(t.prompt) + "</blockquote><p class=muted>" + new Date(t.startedAt).toLocaleString() +
    (t.endedAt ? " · took " + Math.max(1, Math.round((new Date(t.endedAt) - new Date(t.startedAt)) / 1000)) + "s" : "") + "</p>";
  if (t.status === "running") {
    const files = {};
    for (const x of t.touched) files[x.file] = (files[x.file] || 0) + 1;
    return h + "<p><span class='chip st-running'>agent working</span> modules being edited are outlined in blue.</p><h4>files being changed</h4>" +
      (Object.keys(files).length ? "<ul>" + Object.entries(files).map(([f, n]) => "<li><a data-go='s:" + esc(f) + "'>" + esc(f) + "</a> <span class=muted>×" + n + "</span></li>").join("") + "</ul>" : "<p class=empty>None yet.</p>");
  }
  if (t.status === "analyzing") return h + "<p><span class='chip st-analyzing'>analyzing</span> indexing the code before and after, and summarizing. Usually under a minute.</p>";
  if (t.status === "error") return h + "<p class=del>analysis failed:</p><pre>" + esc(t.error) + "</pre>";
  const a = t.analysis, ch = changes();
  const add = a.files.reduce((s, f) => s + f.added, 0), del = a.files.reduce((s, f) => s + f.removed, 0);
  h += "<p>" + esc(a.summary) + "</p>" +
    "<div class=legend><span><i style='background:var(--add)'></i>new</span><span><i style='background:var(--chg)'></i>changed</span>" +
    "<span>" + a.files.length + " files <span class=add>+" + add + "</span> <span class=del>−" + del + "</span> · <a data-go='f:*'>whole diff</a></span></div>";
  h += "<h4>changed</h4>";
  if (ch.comps.size) {
    h += [...ch.comps].map(([c, ms]) =>
      "<div class=tchg><a data-go='c:" + esc(c) + "'><strong>" + esc(c) + "</strong></a><span class=n>" +
      ms.map((m) => "<a data-go='m:" + esc(m.id) + "'>" + esc(m.id.split("/").pop()) + "</a>" + (m.status === "added" ? " <span class=add>new</span>" : "")).join(", ") + "</span></div>").join("");
  } else h += "<p class=empty>Nothing on the map changed (only tests or files outside the modules).</p>";
  const modFiles = new Set(a.modules.map((m) => m.file));
  const other = a.files.filter((f) => !modFiles.has(f.path));
  if (other.length) h += "<h4>other files</h4><ul>" + other.map((f) => "<li><a data-go='f:" + esc(f.path) + "'>" + esc(f.path) + "</a> <span class=add>+" + f.added + "</span> <span class=del>−" + f.removed + "</span></li>").join("") + "</ul>";
  if (a.componentDeps.length) h += "<h4>between components</h4><ul>" + a.componentDeps.map((d) => depLine(d, (x) => "<a data-go='c:" + esc(x) + "'>" + esc(x) + "</a>")).join("") + "</ul>";
  const byYou = a.decisions.filter((d) => d.decided_by === "user").length;
  h += "<h4>decisions <span class=muted>(" + a.decisions.length + ", " + byYou + " by you)</span></h4>" + decisionsHtml(a);
  return h;
}

function compPanel(name) {
  const c = MODEL.components.find((x) => x.name === name), ch = changes();
  const ms = ch.comps.get(name) ?? [];
  let h = "<h2>" + esc(name) + "</h2>" + (c ? "<p>" + esc(c.description) + "</p>" : "<p class=muted>Not on the map now.</p>");
  if (detail && ch.a) {
    h += "<h4>in this turn</h4>" + (ms.length ? ms.map((m) =>
      "<div class=tchg><a data-go='m:" + esc(m.id) + "'>" + esc(m.id) + "</a>" +
      (m.status !== "changed" ? " <span class=" + (m.status === "added" ? "add" : "del") + ">" + m.status + "</span>" : "") +
      "<span class=n>" + (itemCounts(m.items) || "<span class=muted>no named items</span>") + "</span></div>").join("") : "<p class=empty>Not changed in this turn.</p>");
    const deps = ch.a.componentDeps.filter((d) => d.from === name || d.to === name);
    if (deps.length) h += "<h4>dependencies</h4><ul>" + deps.map((d) => depLine(d, (x) => "<a data-go='c:" + esc(x) + "'>" + esc(x) + "</a>")).join("") + "</ul>";
  }
  if (c) h += "<h4>modules</h4><ul>" + c.modules.map((m) => "<li><a data-go='m:" + esc(m) + "'>" + esc(m) + "</a> <span class=muted>" + esc(MODEL.roles[m]?.text || "") + "</span></li>").join("") + "</ul>";
  return h;
}

function modPanel(id) {
  const m = modById()[id], ch = changes(), t = ch.mods.get(id);
  const role = MODEL.roles[id]?.text || t?.role, file = m?.file ?? t?.file;
  let h = "<h2>" + esc(id) + "</h2><p class=muted><a data-go='s:" + esc(file) + "'>" + esc(file) + "</a>" +
    (t ? " · " + (t.status === "changed" ? t.linesBefore + "→" + t.linesAfter + " lines" : t.status) : m ? " · " + m.lines + " lines" : " · not on the map now") + "</p>" +
    (role ? "<p>" + esc(role) + "</p>" : "");
  const src = (line) => "s:" + esc(file) + ":" + line;
  if (t) {
    const li = (i) => "<li>" + sign[i.change] + " <a data-go='" + (i.change === "removed" ? "f:" + esc(file) : src(i.line)) + "'>" + esc(i.name) + "</a> <span class=muted>" + esc(i.kind.toLowerCase()) + " :" + i.line + "</span></li>";
    const api = t.items.filter((i) => !i.test), tests = t.items.filter((i) => i.test);
    h += "<h4>items " + itemCounts(t.items) + "</h4>" +
      (api.length ? "<ul>" + api.map(li).join("") + "</ul>" : tests.length ? "" : "<p class=empty>Changes outside any named item (imports, comments, module-level code).</p>") +
      (tests.length ? "<details><summary class=muted>tests: " + count(tests, "added") + " added, " + count(tests, "changed") + " changed, " + count(tests, "removed") + " removed</summary><ul>" + tests.map(li).join("") + "</ul></details>" : "");
    const deps = ch.a.deps.filter((d) => d.from === id || d.to === id);
    if (deps.length) h += "<h4>dependencies</h4><ul>" + deps.map((d) => depLine(d, (x) => "<a data-go='m:" + esc(x) + "'>" + esc(x) + "</a>")).join("") + "</ul>";
    h += "<h4>diff</h4><div class=filediff data-path='" + esc(t.file) + "'></div>";
  } else {
    if (detail && ch.a) h += "<p class=empty>Not changed in this turn.</p>";
    if (m) {
      const uses = SK.edges.filter((e) => e.from === id).sort((a, b) => b.refs - a.refs);
      const usedBy = SK.edges.filter((e) => e.to === id).sort((a, b) => b.refs - a.refs);
      const link = (x, n) => "<li><a data-go='m:" + esc(x) + "'>" + esc(x) + "</a> <span class=muted>" + n + " refs</span></li>";
      h += "<h4>items</h4><ul>" + (m.items.filter((i) => !i.owner && !i.test).map((i) => "<li><a data-go='" + src(i.line) + "'>" + esc(i.name) + "</a> <span class=muted>" + esc(i.kind.toLowerCase()) + " :" + i.line + "</span></li>").join("") || "<li class=muted>none</li>") + "</ul>" +
        "<h4>uses</h4><ul>" + (uses.map((e) => link(e.to, e.refs)).join("") || "<li class=muted>nothing in the project</li>") + "</ul>" +
        "<h4>used by</h4><ul>" + (usedBy.map((e) => link(e.from, e.refs)).join("") || "<li class=muted>nothing</li>") + "</ul>";
    }
  }
  return h;
}

// A file: its diff in this turn ("f:") or its current source ("s:"), with a switch when both exist.
function filePanel(kind, rest) {
  const [, path, line] = rest.match(/^(.*?)(?::(\d+))?$/);
  if (path === "*") return "<div class=filediff data-path='*'></div>";
  const changed = changes().files.has(path) && changes().files.get(path).status !== "live";
  const sw = changed ? "<div class=switch><button data-go='f:" + esc(path) + "'" + (kind === "f" ? " class=on" : "") + ">diff</button><button data-go='s:" + esc(path) + "'" + (kind === "s" ? " class=on" : "") + ">file</button></div>" : "";
  return "<h2>" + esc(path) + "</h2>" + sw +
    (kind === "f" ? "<div class=filediff data-path='" + esc(path) + "'></div>" : "<div class=source data-path='" + esc(path) + "' data-line='" + (line ?? "") + "'><p class=muted>loading…</p></div>");
}

// One file's part of the turn's patch ("*" = all of it).
function patchFor(path) {
  const p = detail?.analysis?.patch ?? "";
  if (path === "*") return p;
  return p.split(/^(?=diff --git )/m).find((c) => c.startsWith("diff --git a/" + path + " ") || c.split("\n", 1)[0].endsWith(" b/" + path)) ?? "";
}

async function loadSource(el) {
  const r = await (await fetch("api/file?path=" + encodeURIComponent(el.dataset.path))).json();
  if (r.error || r.text == null) { el.innerHTML = "<p class=empty>" + esc(r.error || r.note) + "</p>"; return; }
  const want = Number(el.dataset.line) || 0;
  el.innerHTML = "<pre class=code>" + r.text.split("\n").map((l, i) =>
    "<span class='ln" + (i + 1 === want ? " hit" : "") + "' id=L" + (i + 1) + "><i>" + (i + 1) + "</i>" + esc(l) + "\n</span>").join("") + "</pre>";
  if (want) el.querySelector("#L" + want)?.scrollIntoView({ block: "center" });
}

function wireGo(root) {
  root.querySelectorAll("[data-go]").forEach((a) => a.onclick = (e) => { e.preventDefault(); go(a.dataset.go || null); });
}

function drawPanel() {
  const f = focusId;
  $("#panel").innerHTML = (f ? crumbs() : "") +
    (!f ? turnPanel() : f.startsWith("c:") ? compPanel(f.slice(2)) : f.startsWith("m:") ? modPanel(f.slice(2)) : filePanel(f[0], f.slice(2)));
  for (const el of document.querySelectorAll(".filediff")) {
    const p = patchFor(el.dataset.path);
    if (!p) { el.innerHTML = "<p class=empty>No diff for this file in this turn.</p>"; continue; }
    new Diff2HtmlUI(el, p, { drawFileList: false, matching: "lines", outputFormat: "line-by-line", highlight: false,
      fileContentToggle: false, colorScheme: "auto", stickyFileHeaders: false }).draw();
  }
  for (const el of document.querySelectorAll(".source")) loadSource(el);
  if (detail?.analysis?.patchTruncated && document.querySelector(".filediff")) $("#panel").insertAdjacentHTML("beforeend", "<p class=muted>diff truncated.</p>");
  wireGo($("#panel"));
  if (!/^s:.*:\d+$/.test(f ?? "")) $("#panel").scrollTop = 0;
}

// ---- polling ----

async function poll() {
  try { turns = await (await fetch("api/turns")).json(); } catch { return; }
  const t = turns.find((x) => x.id === selected);
  if (!t || stampOf(t) === stamp) { if (tab === "turns") drawNav(); return; }
  const wasDone = detail?.id === t.id && detail.status === "done";
  stamp = stampOf(t);
  detail = await (await fetch("api/turns/" + t.id)).json();
  // A turn that just finished may have added modules or files: refresh the map (reindexes if needed).
  if (detail.status === "done" && !wasDone && detail.endedAt && Date.now() - new Date(detail.endedAt) < 10 * 60e3) {
    try { ({ skeleton: SK, model: MODEL } = await (await fetch("api/map?fresh=1")).json()); FILES = await (await fetch("api/files")).json(); } catch {}
  }
  drawNav(); drawMap(); drawPanel();
}

document.querySelectorAll("[data-zoom]").forEach((b) => b.onclick = () => setZoom(b.dataset.zoom));
$("#arrows").onchange = (e) => { allArrows = e.target.checked; store.set("cockpit-arrows", allArrows ? "1" : ""); drawMap(); };
$("#reset").onclick = () => {
  delete LAYOUT[zoom];
  fetch("api/layout", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(LAYOUT) });
  cy?.destroy(); cy = null; drawMap();
};
stamp = stampOf(turns.find((x) => x.id === selected));
focusId = decodeURIComponent(location.hash.slice(1)) || null;
if (focusId) {
  const p = /^[fs]:/.test(focusId) ? focusId.slice(2).replace(/:\d+$/, "") : null;
  if ((focusId.startsWith("m:") && SK.modules.some((m) => m.id === focusId.slice(2))) || (p && modOfFile(p))) zoom = "module";
  if (p) for (let d = p; d.includes("/"); ) openDirs.add((d = d.slice(0, d.lastIndexOf("/"))));
}
drawNav(); drawMap(); drawPanel();
setInterval(poll, 2000);
