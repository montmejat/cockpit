// Work page: the project map is the main view. Pick a turn and what it changed lights up
// on the map; click a component or module to go one level deeper, down to its diff.
// Polls the server so running turns and finished analyses show up on their own.

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const NUL = "\u0000";

let SK = INIT.map.skeleton, MODEL = INIT.map.model;
let turns = INIT.turns, selected = INIT.selected, detail = INIT.detail;
let zoom = "system", focusId = null, cy = null, stamp = "";
try { zoom = localStorage.getItem("cockpit-zoom") || "system"; } catch {}

const modById = () => Object.fromEntries(SK.modules.map((m) => [m.id, m]));
const compOf = (id) => MODEL.components.find((c) => c.modules.includes(id));
const stampOf = (t) => (t ? [t.id, t.status, t.touched, t.endedAt].join("|") : "");
const ago = (iso) => {
  const s = (Date.now() - new Date(iso)) / 1000;
  return s < 60 ? "just now" : s < 3600 ? Math.round(s / 60) + " min ago" : s < 86400 ? Math.round(s / 3600) + " h ago" : new Date(iso).toLocaleDateString();
};
const sign = { added: "<span class=add>+</span>", removed: "<span class=del>−</span>", changed: "<span class=chg>~</span>" };
const count = (items, ch) => items.filter((i) => i.change === ch).length;
const itemCounts = (items) => ["added", "changed", "removed"].map((ch) => [ch, count(items, ch)]).filter(([, n]) => n)
  .map(([ch, n]) => "<span class=" + { added: "add", changed: "chg", removed: "del" }[ch] + ">" + { added: "+", changed: "~", removed: "−" }[ch] + n + "</span>").join(" ");

// What the selected turn changed, keyed the way the map draws it.
function changes() {
  const a = detail?.status === "done" ? detail.analysis : null;
  const mods = new Map(), comps = new Map(), live = new Set();
  const compName = (m) => compOf(m.id)?.name ?? m.component;
  for (const m of a?.modules ?? []) {
    mods.set(m.id, m);
    const c = compName(m);
    if (!comps.has(c)) comps.set(c, []);
    comps.get(c).push(m);
  }
  if (detail?.status === "running") {
    const files = new Set(detail.touched.map((x) => x.file));
    for (const m of SK.modules) if ([...files].some((f) => f === m.file || f.endsWith("/" + m.file))) live.add(m.id);
  }
  const key = (d) => d.from + NUL + d.to;
  return {
    a, mods, comps, live, compName,
    compDeps: new Map((a?.componentDeps ?? []).map((d) => [key(d), d])),
    modDeps: new Map((a?.deps ?? []).map((d) => [key(d), d])),
    any: mods.size > 0 || live.size > 0,
  };
}

function elements(ch) {
  const els = [];
  const depClass = (d) => (d ? (d.before === 0 ? "dep-new" : d.after === 0 ? "dep-gone" : "dep-chg") : ch.any ? "quiet" : "");
  if (zoom === "system") {
    const agg = new Map();
    for (const e of SK.edges) {
      const a = compOf(e.from)?.name, b = compOf(e.to)?.name;
      if (a && b && a !== b) agg.set(a + NUL + b, (agg.get(a + NUL + b) || 0) + e.refs);
    }
    for (const c of MODEL.components) {
      const touched = ch.comps.get(c.name) ?? [];
      const live = c.modules.some((m) => ch.live.has(m));
      const sub = touched.length
        ? touched.length + (touched.length === 1 ? " module" : " modules") + " changed"
        : c.modules.length + (c.modules.length === 1 ? " module" : " modules");
      els.push({ data: { id: "c:" + c.name, label: c.name + "\n" + sub, kind: "comp-leaf" },
        classes: live ? "live" : touched.length ? (touched.every((m) => m.status === "added") ? "added" : "changed") : ch.any ? "quiet" : "" });
    }
    for (const [k, refs] of agg) {
      const [a, b] = k.split(NUL);
      els.push({ data: { id: "e:" + k, source: "c:" + a, target: "c:" + b, refs }, classes: depClass(ch.compDeps.get(k)) });
    }
  } else {
    for (const c of MODEL.components)
      els.push({ data: { id: "c:" + c.name, label: c.name, kind: "comp" }, classes: ch.comps.has(c.name) ? "touched" : "" });
    for (const m of SK.modules) {
      const t = ch.mods.get(m.id);
      const sub = t ? (t.status === "added" ? "new · " + m.lines + " lines" : t.linesBefore + " → " + t.linesAfter + " lines") : m.lines + " lines";
      els.push({ data: { id: "m:" + m.id, label: m.id + "\n" + sub, parent: "c:" + compOf(m.id)?.name, kind: "mod" },
        classes: ch.live.has(m.id) ? "live" : t ? t.status : ch.any ? "quiet" : "" });
    }
    for (const e of SK.edges) {
      const d = ch.modDeps.get(e.from + NUL + e.to);
      els.push({ data: { id: "e:" + e.from + ">" + e.to, source: "m:" + e.from, target: "m:" + e.to, refs: e.refs }, classes: d ? depClass(d) : "quiet" });
    }
  }
  return els;
}

function drawMap() {
  document.querySelectorAll("[data-zoom]").forEach((b) => b.classList.toggle("on", b.dataset.zoom === zoom));
  $("#stats").textContent = SK.modules.length + " modules · " + MODEL.components.length + " components";
  const ch = changes(), POS = mapLayout(SK, MODEL);
  cy?.destroy();
  const color = (n) => ({ selector: "." + n[0], style: { "border-color": css(n[1]), "border-width": 3 } });
  cy = cytoscape({
    container: $("#cy"), elements: elements(ch), wheelSensitivity: 0.3, maxZoom: 1.6,
    style: [
      { selector: "node", style: { label: "data(label)", "text-wrap": "wrap", "font-size": 11, color: css("--fg"),
        "text-valign": "center", "background-color": css("--node"), "border-width": 1, "border-color": css("--line"),
        shape: "round-rectangle", width: "label", height: "label", padding: 10 } },
      { selector: 'node[kind="comp-leaf"]', style: { "background-color": css("--comp"), "border-color": css("--comp-line"), "font-size": 13, "font-weight": 600 } },
      { selector: 'node[kind="comp"]', style: { "background-color": css("--comp"), "border-color": css("--comp-line"),
        "text-valign": "top", "text-halign": "center", "font-weight": 600, "font-size": 12, padding: 14 } },
      { selector: "edge", style: { width: "mapData(refs, 1, 150, 1, 6)", "line-color": css("--edge"), "target-arrow-color": css("--edge"),
        "target-arrow-shape": "triangle", "curve-style": "bezier", opacity: 0.55, "arrow-scale": 0.8 } },
      { selector: "node.quiet", style: { opacity: 0.35 } },
      { selector: "edge.quiet", style: { opacity: zoom === "system" ? 0.12 : 0 } },
      color(["added", "--add"]), color(["changed", "--chg"]), color(["removed", "--del"]), color(["live", "--accent"]),
      { selector: "node.touched", style: { "border-color": css("--chg"), "border-width": 2 } },
      { selector: "edge.dep-new", style: { "line-color": css("--add"), "target-arrow-color": css("--add"), opacity: 1, width: 3 } },
      { selector: "edge.dep-chg", style: { "line-color": css("--chg"), "target-arrow-color": css("--chg"), opacity: 1, width: 3 } },
      { selector: "node.focus", style: { "underlay-color": css("--accent"), "underlay-opacity": 0.18, "underlay-padding": 8, opacity: 1 } },
    ],
    layout: { name: "preset", positions: (n) => POS[n.id()] || { x: 0, y: 0 }, padding: 30 },
  });
  cy.on("tap", "node", (ev) => go(ev.target.id()));
  cy.on("tap", (ev) => { if (ev.target === cy) go(null); });
  markFocus();
}

function markFocus() {
  if (!cy) return;
  cy.nodes().removeClass("focus");
  if (!focusId) return;
  // At system zoom a module isn't drawn: mark its component.
  const id = focusId.startsWith("m:") && zoom === "system" ? "c:" + (compOf(focusId.slice(2))?.name ?? "") : focusId;
  cy.getElementById(id).addClass("focus");
}

function setZoom(z) {
  zoom = z;
  try { localStorage.setItem("cockpit-zoom", z); } catch {}
  drawMap();
}

// Navigation: null = the turn, "c:<component>", "m:<module>", "f:<path>" (a file's diff), "f:*" (whole diff).
function go(id) {
  focusId = id;
  history.replaceState(null, "", location.search + (id ? "#" + encodeURIComponent(id) : ""));
  if (id?.startsWith("m:") && zoom === "system" && SK.modules.some((m) => m.id === id.slice(2))) setZoom("module");
  else markFocus();
  drawPanel();
  $("#panel").scrollTop = 0;
}

function drawList() {
  const none = "<div class='turn" + (!selected ? " sel" : "") + "' data-id=''><div class=p>Just the map</div><div class=meta>no turn selected</div></div>";
  $("#list").innerHTML = none + (turns.length ? turns.map((t) =>
    "<div class='turn" + (t.id === selected ? " sel" : "") + "' data-id='" + t.id + "'>" +
    "<div class=p>" + esc(t.prompt || "(empty prompt)") + "</div>" +
    "<div class=meta><span class='chip st-" + t.status + "'>" + t.status + "</span> " + ago(t.startedAt) +
    (t.files != null ? " · " + t.files + (t.files === 1 ? " file" : " files") + " <span class=add>+" + t.added + "</span> <span class=del>−" + t.removed + "</span>" : "") +
    "</div></div>").join("")
    : "<p class='muted' style='padding:14px'>No turns yet. Send a request to Claude Code in the project and it will show up here.</p>");
  document.querySelectorAll(".turn").forEach((el) => el.onclick = () => selectTurn(el.dataset.id || null));
}

async function selectTurn(id) {
  selected = id;
  history.replaceState(null, "", id ? "?turn=" + id : location.pathname); // also drops the #focus
  stamp = "";
  focusId = null;
  await poll();
  if (!id) { detail = null; drawList(); drawMap(); drawPanel(); }
}

// ---- detail panel ----

function crumbs() {
  const parts = ["<a data-go=''>" + (detail ? "Turn" : "Map") + "</a>"];
  if (focusId?.startsWith("c:")) parts.push("<strong>" + esc(focusId.slice(2)) + "</strong>");
  if (focusId?.startsWith("m:")) {
    const id = focusId.slice(2), c = compOf(id)?.name ?? changes().mods.get(id)?.component;
    if (c) parts.push("<a data-go='c:" + esc(c) + "'>" + esc(c) + "</a>");
    parts.push("<strong class=mono>" + esc(id) + "</strong>");
  }
  if (focusId?.startsWith("f:")) parts.push("<strong class=mono>" + esc(focusId === "f:*" ? "whole diff" : focusId.slice(2)) + "</strong>");
  return "<div class=crumbs>" + parts.join("<span class=sep>›</span>") + "</div>";
}

function decisionsHtml(a) {
  if (!a.decisions.length) return "<p class=empty>No decisions in this turn.</p>";
  return a.decisions.map((d) =>
    "<details class=dec><summary><span class='lvl " + d.level + "'>" + d.level + "</span>" + esc(d.title) +
    "<span class='by " + d.decided_by + "'>" + d.decided_by + "</span></summary>" +
    "<div>Chose: " + esc(d.chose) + (d.over.length ? " <span class=muted>over " + esc(d.over.join("; ")) + "</span>" : "") + "</div>" +
    "<div class=muted>Because: " + esc(d.because) + "</div><div class='mono muted'>" + esc(d.area) + "</div></details>").join("");
}

function depLine(d, fmt) {
  const kind = d.before === 0 ? "<span class=add>new</span>" : d.after === 0 ? "<span class=del>removed</span>" : "<span class=chg>" + d.before + " → " + d.after + " refs</span>";
  return "<li>" + fmt(d.from) + " → " + fmt(d.to) + " · " + kind + "</li>";
}

function otherFiles(a) {
  const modFiles = new Set(a.modules.map((m) => m.file));
  return a.files.filter((f) => !modFiles.has(f.path));
}

function turnPanel() {
  const t = detail;
  if (!t) {
    return "<h2>Map</h2><p class=muted>Pick a turn on the left to see what it changed, or click a component to read about it.</p>" +
      MODEL.components.map((c) => "<p><a data-go='c:" + esc(c.name) + "'><strong>" + esc(c.name) + "</strong></a><br><span class=muted>" + esc(c.description) + "</span></p>").join("");
  }
  let h = "<blockquote>" + esc(t.prompt) + "</blockquote><p class=muted>" + new Date(t.startedAt).toLocaleString() +
    (t.endedAt ? " · took " + Math.max(1, Math.round((new Date(t.endedAt) - new Date(t.startedAt)) / 1000)) + " s" : "") + "</p>";
  if (t.status === "running") {
    const files = {};
    for (const x of t.touched) files[x.file] = (files[x.file] || 0) + 1;
    return h + "<p><span class='chip st-running'>agent working</span> Modules being edited are outlined in blue on the map.</p><h4>Files being changed</h4>" +
      (Object.keys(files).length ? "<ul class=live>" + Object.entries(files).map(([f, n]) => "<li>" + esc(f) + " <span class=muted>×" + n + "</span></li>").join("") + "</ul>" : "<p class=empty>None yet.</p>");
  }
  if (t.status === "analyzing") return h + "<p><span class='chip st-analyzing'>analyzing</span> Indexing the code before and after, and summarizing. Usually under a minute.</p>";
  if (t.status === "error") return h + "<p class=del>Analysis failed:</p><pre class=mono>" + esc(t.error) + "</pre>";
  const a = t.analysis, ch = changes();
  const add = a.files.reduce((s, f) => s + f.added, 0), del = a.files.reduce((s, f) => s + f.removed, 0);
  h += "<p>" + esc(a.summary) + "</p>" +
    "<div class=legend><span><i style='background:var(--add)'></i>new</span><span><i style='background:var(--chg)'></i>changed</span><span><i style='background:var(--del)'></i>removed</span>" +
    "<span>" + a.files.length + (a.files.length === 1 ? " file" : " files") + " <span class=add>+" + add + "</span> <span class=del>−" + del + "</span> · <a data-go='f:*'>whole diff</a></span></div>";
  h += "<h4>Changed</h4>";
  if (ch.comps.size) {
    h += [...ch.comps].map(([c, ms]) =>
      "<div class=tchg><a data-go='c:" + esc(c) + "'><strong>" + esc(c) + "</strong></a><span class=n>" +
      ms.map((m) => "<a class=mono data-go='m:" + esc(m.id) + "'>" + esc(m.id.split("/").pop()) + "</a>" + (m.status === "added" ? " <span class=add>new</span>" : "")).join(", ") + "</span></div>").join("");
  } else h += "<p class=empty>Nothing on the map changed (only tests or files outside the modules). See the files below.</p>";
  const other = otherFiles(a);
  if (other.length) h += "<h4>Other files</h4><ul>" + other.map((f) => "<li><a class=mono data-go='f:" + esc(f.path) + "'>" + esc(f.path) + "</a> <span class=add>+" + f.added + "</span> <span class=del>−" + f.removed + "</span></li>").join("") + "</ul>";
  if (a.componentDeps.length) h += "<h4>Between components</h4><ul>" + a.componentDeps.map((d) => depLine(d, (x) => "<a data-go='c:" + esc(x) + "'>" + esc(x) + "</a>")).join("") + "</ul>";
  const byYou = a.decisions.filter((d) => d.decided_by === "user").length;
  h += "<h4>Decisions <span class=muted>(" + a.decisions.length + ", " + byYou + " by you)</span></h4>" + decisionsHtml(a);
  return h;
}

function compPanel(name) {
  const c = MODEL.components.find((x) => x.name === name), ch = changes();
  const ms = ch.comps.get(name) ?? [];
  let h = "<h2>" + esc(name) + "</h2>" + (c ? "<p>" + esc(c.description) + "</p>" : "<p class=muted>Not on the map now.</p>");
  if (detail && ch.a) {
    h += "<h4>In this turn</h4>" + (ms.length ? ms.map((m) =>
      "<div class=tchg><a class=mono data-go='m:" + esc(m.id) + "'>" + esc(m.id) + "</a>" +
      (m.status !== "changed" ? " <span class=" + (m.status === "added" ? "add" : "del") + ">" + m.status + "</span>" : "") +
      "<span class=n>" + (itemCounts(m.items) || "<span class=muted>no named items</span>") + "</span></div>").join("") : "<p class=empty>Not changed in this turn.</p>");
    const deps = ch.a.componentDeps.filter((d) => d.from === name || d.to === name);
    if (deps.length) h += "<h4>Dependencies</h4><ul>" + deps.map((d) => depLine(d, (x) => "<a data-go='c:" + esc(x) + "'>" + esc(x) + "</a>")).join("") + "</ul>";
  }
  if (c) h += "<h4>All modules</h4><ul>" + c.modules.map((m) => "<li><a class=mono data-go='m:" + esc(m) + "'>" + esc(m) + "</a> <span class=muted>" + esc(MODEL.roles[m]?.text || "") + "</span></li>").join("") + "</ul>";
  return h;
}

function modPanel(id) {
  const m = modById()[id], ch = changes(), t = ch.mods.get(id);
  const role = MODEL.roles[id]?.text || t?.role;
  let h = "<h2 class=mono>" + esc(id) + "</h2><p class=muted>" + esc(m?.file ?? t?.file ?? "") +
    (t ? " · " + (t.status === "changed" ? t.linesBefore + " → " + t.linesAfter + " lines" : t.status) : m ? " · " + m.lines + " lines" : " · not on the map now") + "</p>" +
    (role ? "<p>" + esc(role) + "</p>" : "");
  if (t) {
    const li = (i) => "<li>" + sign[i.change] + " <span class=mono>" + esc(i.name) + "</span> <span class=muted>" + esc(i.kind.toLowerCase()) + " · line " + i.line + "</span></li>";
    const api = t.items.filter((i) => !i.test), tests = t.items.filter((i) => i.test);
    h += "<h4>Items " + itemCounts(t.items) + "</h4>" +
      (api.length ? "<ul>" + api.map(li).join("") + "</ul>" : tests.length ? "" : "<p class=empty>Changes outside any named item (imports, comments, module-level code).</p>") +
      (tests.length ? "<details><summary class=muted>Tests: " + count(tests, "added") + " added, " + count(tests, "changed") + " changed, " + count(tests, "removed") + " removed</summary><ul>" + tests.map(li).join("") + "</ul></details>" : "");
    const deps = ch.a.deps.filter((d) => d.from === id || d.to === id);
    if (deps.length) h += "<h4>Dependencies</h4><ul>" + deps.map((d) => depLine(d, (x) => "<a class=mono data-go='m:" + esc(x) + "'>" + esc(x) + "</a>")).join("") + "</ul>";
    h += "<h4>Diff</h4><div class=filediff data-path='" + esc(t.file) + "'></div>";
  } else {
    if (detail && ch.a) h += "<p class=empty>Not changed in this turn.</p>";
    if (m) {
      const uses = SK.edges.filter((e) => e.from === id).sort((a, b) => b.refs - a.refs);
      const usedBy = SK.edges.filter((e) => e.to === id).sort((a, b) => b.refs - a.refs);
      const link = (x, n) => "<li><a class=mono data-go='m:" + esc(x) + "'>" + esc(x) + "</a> <span class=muted>" + n + " refs</span></li>";
      h += "<h4>Items</h4><ul>" + (m.items.filter((i) => !i.owner && !i.test).map((i) => "<li><span class=mono>" + esc(i.name) + "</span> <span class=muted>" + esc(i.kind.toLowerCase()) + " · line " + i.line + "</span></li>").join("") || "<li class=muted>none</li>") + "</ul>" +
        "<h4>Uses</h4><ul>" + (uses.map((e) => link(e.to, e.refs)).join("") || "<li class=muted>nothing in the project</li>") + "</ul>" +
        "<h4>Used by</h4><ul>" + (usedBy.map((e) => link(e.from, e.refs)).join("") || "<li class=muted>nothing</li>") + "</ul>";
    }
  }
  return h;
}

function filePanel(path) {
  return "<div class=filediff data-path='" + esc(path) + "'></div>";
}

// One file's part of the turn's patch ("*" = all of it).
function patchFor(path) {
  const p = detail?.analysis?.patch ?? "";
  if (path === "*") return p;
  return p.split(/^(?=diff --git )/m).find((c) => c.startsWith("diff --git a/" + path + " ") || c.split("\n", 1)[0].endsWith(" b/" + path)) ?? "";
}

function drawPanel() {
  const f = focusId;
  $("#panel").innerHTML = (f ? crumbs() : "") +
    (!f ? turnPanel() : f.startsWith("c:") ? compPanel(f.slice(2)) : f.startsWith("m:") ? modPanel(f.slice(2)) : filePanel(f.slice(2)));
  for (const el of document.querySelectorAll(".filediff")) {
    const p = patchFor(el.dataset.path);
    if (!p) { el.innerHTML = "<p class=empty>No diff for this file in this turn.</p>"; continue; }
    new Diff2HtmlUI(el, p, { drawFileList: false, matching: "lines", outputFormat: "line-by-line", highlight: false,
      fileContentToggle: false, colorScheme: "auto", stickyFileHeaders: false }).draw();
  }
  if (detail?.analysis?.patchTruncated && document.querySelector(".filediff")) $("#panel").insertAdjacentHTML("beforeend", "<p class=muted>Diff truncated.</p>");
  document.querySelectorAll("[data-go]").forEach((a) => a.onclick = () => go(a.dataset.go || null));
}

// ---- polling ----

async function poll() {
  try { turns = await (await fetch("api/turns")).json(); } catch { return; }
  drawList();
  const t = turns.find((x) => x.id === selected);
  if (!t || stampOf(t) === stamp) return;
  const wasDone = detail?.id === t.id && detail.status === "done";
  stamp = stampOf(t);
  detail = await (await fetch("api/turns/" + t.id)).json();
  // A turn that just finished may have added modules: refresh the map (reindexes if needed).
  if (detail.status === "done" && !wasDone && detail.endedAt && Date.now() - new Date(detail.endedAt) < 10 * 60e3) {
    try { ({ skeleton: SK, model: MODEL } = await (await fetch("api/map?fresh=1")).json()); } catch {}
  }
  drawMap();
  drawPanel();
}

document.querySelectorAll("[data-zoom]").forEach((b) => b.onclick = () => setZoom(b.dataset.zoom));
stamp = stampOf(turns.find((x) => x.id === selected));
focusId = decodeURIComponent(location.hash.slice(1)) || null;
if (focusId?.startsWith("m:") && SK.modules.some((m) => m.id === focusId.slice(2))) zoom = "module";
drawList(); drawMap(); drawPanel();
setInterval(poll, 2000);
