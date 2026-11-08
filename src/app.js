// cockpit, one view: the agents' diagrams, files and git on the side, code and diffs in a drawer,
// and what is changing right now (uncommitted edits, a running agent) projected onto all of it.

let S = INIT, stamp = JSON.stringify(S);
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const store = { get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
const byId = (id) => S.diagrams.find((d) => d.id === id);
const plural = (n, w) => n + " " + w + (n === 1 ? "" : "s");

let tab = store.get("cockpit-tab", "diagrams");
let [main, side] = decodeURIComponent(location.hash.slice(1)).split(",");
if (!byId(main)) main = (S.diagrams.find((d) => d.kind === "loop") ?? S.diagrams[0])?.id ?? null;
if (!byId(side)) side = null;
let picked = null; // { pane, id }
let insp = null; // the right panel shows "features" or "tests" instead of the diagram
const panes = { main: null, side: null };
let graph = null, graphHead = null, files = null, drawer = null; // drawer: { kind, path?, line?, end?, sha?, view? }

// ---- what is changing ----------------------------------------------------

const changed = () => ({ items: new Set(S.changedItems), files: new Set(S.changedFiles), touched: new Set(S.live?.touched ?? []) });
function where(a) {
  const [mod] = a.split("::"), m = S.modules.find((x) => x.id === mod);
  if (!m) return null;
  const it = a.includes("::") ? m.items.find((i) => i.key === a) : null;
  return { file: m.file, line: it?.line, end: it?.end };
}
// A link changed if its own lines did: a whole module when the file changed, an item (or any
// method of a type) when lines inside it changed.
function anchorChanged(a, c = changed()) {
  const w = where(a);
  if (!w) return false;
  if (!a.includes("::")) return c.files.has(w.file);
  if (c.items.has(a)) return true;
  for (const k of c.items) if (k.startsWith(a + "::")) return true;
  return false;
}
function nodeState(n, c = changed()) {
  const anchors = n.anchors ?? [], hit = anchors.filter((a) => anchorChanged(a, c));
  return { unc: hit.length > 0, live: !!S.live && hit.some((a) => c.touched.has(where(a)?.file)) };
}
const filesOfNode = (n) => [...new Set((n.anchors ?? []).map(where).filter(Boolean).map((w) => w.file))];

// ---- header --------------------------------------------------------------

function drawHeader() {
  const g = S.git, dirty = S.status.length;
  $("#gitpill").innerHTML = "⎇ " + esc(g.branch ?? "detached " + g.head) + (dirty ? " <span class=dirty>· " + dirty + " changed</span>" : "") +
    (g.ahead ? " <span class=ahead>↑" + g.ahead + "</span>" : "") + (g.behind ? " <span class=ahead>↓" + g.behind + "</span>" : "");
  const nTests = S.tests.unit.reduce((n, m) => n + m.tests.length, 0) + S.tests.integration.reduce((n, f) => n + f.tests.length, 0);
  const by = (st) => S.features.filter((f) => f.status === st).length;
  const fparts = [["working", ""], ["partial", "warn"], ["broken", "bad"], ["planned", "muted"]].filter(([st]) => by(st)).map(([st, c]) => "<span class='" + c + "'><b>" + by(st) + "</b> " + st + "</span>");
  $("#metrics").innerHTML = "<b>" + (S.lines / 1000).toFixed(1) + "k</b> lines · <a class='mlink" + (insp === "tests" ? " on" : "") + "' data-insp=tests title='What is tested'><b>" + nTests + "</b> tests</a>" +
    (S.features.length ? " · <a class='mlink" + (insp === "features" ? " on" : "") + "' data-insp=features title='What the features are and where their status comes from'>features: " + fparts.join(", ") + "</a>" : "");
  for (const a of document.querySelectorAll("#metrics [data-insp]")) a.onclick = () => { insp = insp === a.dataset.insp ? null : a.dataset.insp; drawHeader(); drawInspector(); };
  $("#live").innerHTML = S.live ? "<span class=livepill title='" + esc(S.live.prompt) + "'>◉ agent working · " + plural(S.live.touched.length, "file") + "</span>" : "";
}

// ---- sidebar -------------------------------------------------------------

function drawSide() {
  for (const b of document.querySelectorAll(".tabs button")) b.classList.toggle("on", b.dataset.tab === tab);
  const el = $("#sidebody"), sc = el.scrollTop;
  el.innerHTML = tab === "diagrams" ? diagramsList() : tab === "files" ? filesTree() : gitPane();
  el.scrollTop = sc;
  wire(el);
  if (tab === "git" && (!graph || graphHead !== S.git.head)) loadGraph();
  if (tab === "files" && !files) loadFiles();
}

function diagramsList() {
  // Children right under the diagram that zooms into them.
  const parentOf = new Map();
  for (const d of S.diagrams) for (const n of d.nodes) if (n.detail && byId(n.detail) && !parentOf.has(n.detail)) parentOf.set(n.detail, d.id);
  const depth = (id, k = 0) => (parentOf.has(id) && k < 5 ? depth(parentOf.get(id), k + 1) : k);
  const ordered = [], seen = new Set();
  const visit = (d) => { if (seen.has(d.id)) return; seen.add(d.id); ordered.push(d); for (const c of S.diagrams.filter((x) => parentOf.get(x.id) === d.id)) visit(c); };
  for (const d of S.diagrams.filter((x) => !parentOf.has(x.id))) visit(d);
  for (const d of S.diagrams) visit(d);
  const probs = S.problems;
  return "<div class=dl>" + (ordered.length ? ordered.map((d) => {
    const dp = depth(d.id);
    return "<a class='q" + (d.id === main ? " on" : d.id === side ? " on2" : "") + (dp === 1 ? " sub" : dp > 1 ? " sub2" : "") + "' data-open='" + esc(d.id) + "'><span class=k>" + esc(d.kind) + "</span>" + esc(d.question) + "</a>";
  }).join("") : "<p class=muted>No diagrams yet.</p>") +
    (probs.length ? "<details class=probs><summary>⚠ " + plural(probs.length, "thing") + " in .cockpit/ don't match the code</summary>" + probs.slice(0, 30).map((p) => "<p class=prob>" + esc(p.where) + ": " + esc(p.problem) + "</p>").join("") + "</details>" : "") + "</div>";
}

async function loadFiles() { try { files = await (await fetch("api/files")).json(); if (tab === "files") drawSide(); } catch {} }
function statusOf(path) {
  const s = S.status.find((x) => x.path === path);
  if (!s) return null;
  return s.x === "?" || s.x === "A" ? "A" : s.x === "D" || s.y === "D" ? "D" : "M";
}
function filesTree() {
  if (!files) return "<p class='muted' style='padding:12px'>loading…</p>";
  const all = [...new Set([...files, ...S.status.map((s) => s.path)])].sort();
  const root = {};
  for (const p of all) { let n = root; const parts = p.split("/"); parts.slice(0, -1).forEach((d) => (n = n[d + "/"] ??= {})); n[parts.at(-1)] = p; }
  const touched = new Set(S.live?.touched ?? []);
  const dirty = (n) => Object.values(n).some((v) => (typeof v === "string" ? statusOf(v) || touched.has(v) : dirty(v)));
  const cur = drawer?.path;
  const render = (n, prefix) => Object.keys(n).sort((a, b) => (b.endsWith("/") - a.endsWith("/")) || a.localeCompare(b)).map((k) => {
    const v = n[k];
    if (typeof v !== "string") {
      const open = dirty(v) || (cur ?? "").startsWith(prefix + k) || prefix === "";
      return "<details" + (open ? " open" : "") + "><summary" + (dirty(v) ? " class=dirtydot" : "") + ">" + esc(k) + "</summary><div class=sub>" + render(v, prefix + k) + "</div></details>";
    }
    const st = statusOf(v);
    return "<a class='file" + (cur === v ? " sel" : "") + "' data-file='" + esc(v) + "'>" + (touched.has(v) ? "<span class=agentdot title='the agent is editing it'>◉</span>" : "") + esc(k) +
      (st ? "<span class='mark " + st + "'>" + st + "</span>" : "") + "</a>";
  }).join("");
  return "<div class=tree>" + render(root, "") + "</div>";
}

async function loadGraph() {
  graphHead = S.git.head;
  try { graph = await (await fetch("api/git/graph")).json(); if (tab === "git") drawSide(); } catch {}
}
// Lanes like `git log --graph`: each lane waits for a commit; a commit takes its lane and
// hands it to its first parent; other parents get lanes of their own.
function graphRows(commits) {
  let lanes = [];
  return commits.map((c) => {
    let col = lanes.indexOf(c.hash);
    if (col < 0) { col = lanes.indexOf(null); if (col < 0) col = lanes.length; lanes[col] = c.hash; }
    const before = lanes.slice();
    const merging = before.map((h, i) => (h === c.hash && i !== col ? i : -1)).filter((i) => i >= 0);
    lanes = lanes.map((h, i) => (merging.includes(i) ? null : h));
    lanes[col] = c.parents[0] ?? null;
    const parentCols = [col];
    for (const p of c.parents.slice(1)) {
      let j = lanes.indexOf(p);
      if (j < 0) { j = lanes.indexOf(null); if (j < 0) j = lanes.length; lanes[j] = p; }
      parentCols.push(j);
    }
    while (lanes.length && lanes.at(-1) === null) lanes.pop();
    return { c, col, before, after: lanes.slice(), merging, parentCols };
  });
}
const LANE = ["#2f6fde", "#d9622b", "#2a9d6f", "#a35bd1", "#c79a1c", "#d1477a", "#3a9fb5"];
function graphSvg(r, width) {
  const X = (i) => 9 + i * 12, H = 24, M = 12;
  let s = "";
  r.before.forEach((h, i) => {
    if (!h || h === r.c.hash) return;
    const j = r.after.indexOf(h);
    if (j >= 0) s += `<path d="M${X(i)} 0 C${X(i)} ${M} ${X(j)} ${M} ${X(j)} ${H}" stroke="${LANE[i % 7]}" fill="none" stroke-width="1.6"/>`;
  });
  const topIn = r.before[r.col] === r.c.hash;
  if (topIn) s += `<line x1="${X(r.col)}" y1="0" x2="${X(r.col)}" y2="${M}" stroke="${LANE[r.col % 7]}" stroke-width="1.6"/>`;
  for (const i of r.merging) s += `<path d="M${X(i)} 0 C${X(i)} ${M / 2} ${X(r.col)} ${M / 2} ${X(r.col)} ${M}" stroke="${LANE[i % 7]}" fill="none" stroke-width="1.6"/>`;
  r.parentCols.forEach((j, k) => { if (r.c.parents[k]) s += `<path d="M${X(r.col)} ${M} C${X(r.col)} ${H} ${X(j)} ${M} ${X(j)} ${H}" stroke="${LANE[j % 7]}" fill="none" stroke-width="1.6"/>`; });
  s += `<circle cx="${X(r.col)}" cy="${M}" r="4" fill="${LANE[r.col % 7]}" stroke="var(--card)" stroke-width="1.5"/>`;
  return `<svg width="${width}" height="${H}">${s}</svg>`;
}
function gitPane() {
  const g = S.git, st = S.status;
  let h = "<div class=gitpane><div class=sec><b>⎇ " + esc(g.branch ?? "detached") + "</b> <span class=muted>at " + esc(g.head) + "</span>" +
    (g.upstream ? "<div class=muted>" + esc(g.upstream) + (g.ahead || g.behind ? ": " + (g.ahead ? g.ahead + " to push" : "") + (g.ahead && g.behind ? ", " : "") + (g.behind ? g.behind + " to pull" : "") : ": in sync") + "</div>" : "<div class=muted>no upstream</div>") + "</div>";
  h += "<div class=sec><h4>not committed" + (st.length ? " · " + st.length : "") + "</h4></div>" +
    (st.length ? st.map((f) => "<a class=gitfile data-diff='" + esc(f.path) + "'><span class='mark " + statusOf(f.path) + "'>" + statusOf(f.path) + "</span>" + esc(f.path) + "</a>").join("") : "<div class='sec muted'>clean</div>");
  h += "<div class=sec><h4>history</h4></div>";
  if (!graph) return h + "<div class='sec muted'>loading…</div></div>";
  const rows = graphRows(graph), width = 18 + 12 * Math.max(1, ...rows.map((r) => Math.max(r.before.length, r.after.length)));
  h += "<div class=graph>" + rows.map((r) => {
    const refs = r.c.refs.map((x) => x.startsWith("HEAD -> ") ? "<span class='ref head'>" + esc(x.slice(8)) + "</span>" : x === "HEAD" ? "<span class='ref head'>HEAD</span>" :
      "<span class='ref" + (x.includes("/") && !x.startsWith("tag:") ? " remote" : "") + "'>" + esc(x.replace("tag: ", "")) + "</span>").join("");
    return "<div class='grow-row" + (drawer?.sha === r.c.sha ? " sel" : "") + "' data-commit='" + esc(r.c.sha) + "' title='" + esc(r.c.subject + "\n" + r.c.author + " · " + new Date(r.c.date).toLocaleString()) + "'>" +
      graphSvg(r, width) + "<span class=msg><span class=sha>" + esc(r.c.sha) + "</span>" + refs + esc(r.c.subject) + "</span></div>";
  }).join("") + "</div></div>";
  return h;
}

// ---- diagrams ------------------------------------------------------------

function setHash() { history.replaceState(null, "", location.pathname + location.search + (main ? "#" + encodeURIComponent([main, side].filter(Boolean).join(",")) : "")); }
function openDiagram(id, node) { main = id; side = null; picked = node ? { pane: "main", id: node } : null; setHash(); drawDiagrams(); }
function zoom(id) { side = id; picked = null; setHash(); drawDiagrams(); }

function elements(d) {
  const c = changed(), els = [];
  for (const n of d.nodes) {
    const ns = nodeState(n, c);
    const cls = [n.zone ? "zone" : n.outside ? "outside" : "part", n.focus && "focus", n.total && "total", n.carries && "carries",
      (n.start || n.end) && "terminal", n.detail && byId(n.detail) && "zoomable", ns.live && "live", ns.unc && "unc"].filter(Boolean).join(" ");
    els.push({ data: { id: n.id, label: n.label + (n.detail && byId(n.detail) ? "  ⤢" : ""), parent: n.in }, classes: cls });
  }
  // Labels where they can't collide: by the source if it's the only edge leaving it, else by
  // the target if it's the only one arriving, else in the middle. Dataflow arrows take the
  // color of the box they leave, so each can be followed by eye.
  const flows = d.edges.filter((e) => !e.next), outN = (id) => flows.filter((e) => e.from === id).length, inN = (id) => flows.filter((e) => e.to === id).length;
  const PAL = ["#2b7bd6", "#d9622b", "#2a9d6f", "#a35bd1", "#c79a1c", "#d1477a", "#3a9fb5", "#7a8a2a"];
  const srcs = [...new Set(d.edges.map((e) => e.from))], df = d.kind === "dataflow";
  d.edges.forEach((e, i) => els.push({ data: { id: "e" + i, source: e.from, target: e.to, label: e.next ? "↻ " + e.label : e.label,
    pos: df || e.next ? "mid" : outN(e.from) === 1 ? "src" : inN(e.to) === 1 ? "tgt" : "mid", c: df ? PAL[srcs.indexOf(e.from) % PAL.length] : "" },
    classes: (e.next ? "edge next" : "edge") + (df ? " colored" : "") }));
  // Reads and writes of a carried state go to many boxes: faint until a box is hovered.
  const carried = new Set(d.nodes.filter((n) => n.carries).map((n) => n.id));
  if (d.kind === "loop") {
    const first = d.nodes.find((n) => !n.zone && !n.outside && !n.carries && !n.start && !n.end)?.id;
    for (const el of els) if (el.data.source && (carried.has(el.data.source) || carried.has(el.data.target) || (el.classes.includes("next") && el.data.target !== first))) el.classes += " aux";
  } else if (df) for (const el of els) if (el.data.source && carried.has(el.data.source) && !el.classes.includes("next")) el.classes += " aux";
  // Loops and pipelines read in node order: invisible links keep that order top to bottom.
  if (d.kind === "pipeline" || d.kind === "loop") {
    const steps = d.nodes.filter((n) => !n.zone && !n.outside && !(d.kind === "loop" && n.carries));
    for (let i = 1; i < steps.length; i++)
      if (!d.edges.some((e) => !e.next && e.from === steps[i - 1].id && e.to === steps[i].id))
        els.push({ data: { id: "o" + i, source: steps[i - 1].id, target: steps[i].id }, classes: "order" });
  }
  return els;
}

function style() {
  const ink = css("--fg"), soft = css("--muted"), panel = css("--card"), line = css("--line"), sig = css("--hot"), data = css("--accent"), warn = css("--warn");
  return [
    { selector: "node", style: { shape: "round-rectangle", label: "data(label)", "font-family": "JetBrains Mono, monospace", "font-size": 13, color: ink,
      "text-wrap": "wrap", "text-max-width": 160, "text-valign": "center", "text-halign": "center", width: "label", height: "label", padding: 12,
      "background-color": panel, "border-width": 1.3, "border-color": ink } },
    { selector: "node.zone", style: { "text-valign": "top", "text-margin-y": -6, "font-weight": 700, "border-style": "dashed", "border-color": soft, "background-opacity": 0.35, "background-color": line, padding: 22 } },
    { selector: "node.outside", style: { "border-width": 0, "background-opacity": 0, color: soft, "font-style": "italic" } },
    { selector: "node.terminal", style: { shape: "ellipse", "background-color": ink, color: panel, "border-width": 0, padding: 14, "font-weight": 700 } },
    { selector: "node.carries", style: { shape: "cut-rectangle", "border-style": "dashed", "border-color": data, "border-width": 2, color: data, "background-color": data, "background-opacity": 0.06 } },
    { selector: "node.total", style: { shape: "barrel", "background-color": data, "background-opacity": 0.12, "border-color": data, "border-width": 2, "font-weight": 700 } },
    { selector: "node.zoomable", style: { "border-style": "double", "border-width": 5 } },
    { selector: "node.focus", style: { "border-color": sig, "border-width": 2.4, "background-color": sig, "background-opacity": 0.12, "font-weight": 700 } },
    { selector: "node.unc", style: { "border-style": "dashed", "border-color": warn, "border-width": 2.4 } },
    { selector: "node.live", style: { "border-color": sig, "border-width": 3, "underlay-color": sig, "underlay-opacity": 0.3, "underlay-padding": 9 } },
    { selector: "node.picked", style: { "border-color": data, "border-width": 3 } },
    { selector: "node.infile", style: { "border-color": data, "border-width": 2, "background-color": data, "background-opacity": 0.07 } },
    { selector: "node.inview", style: { "border-color": data, "border-width": 3.5, "background-opacity": 0.18, "underlay-color": data, "underlay-opacity": 0.22, "underlay-padding": 8 } },
    { selector: "edge", style: { width: 1.4, "line-color": soft, "target-arrow-color": soft, "target-arrow-shape": "triangle", "arrow-scale": 0.9,
      "curve-style": "bezier", label: "data(label)", "font-family": "JetBrains Mono, monospace", "font-size": 11.5, color: data,
      "text-background-color": panel, "text-background-opacity": 1, "text-background-padding": 2, "text-wrap": "wrap", "text-max-width": 130 } },
    { selector: "edge.flow", style: { "curve-style": "taxi", "taxi-direction": "downward", "taxi-turn": "70%", "taxi-turn-min-distance": 14 } },
    { selector: 'edge.flow[pos="src"]', style: { label: "", "source-label": "data(label)", "source-text-offset": 30 } },
    { selector: 'edge.flow[pos="tgt"]', style: { label: "", "target-label": "data(label)", "target-text-offset": 30 } },
    { selector: "edge.order", style: { visibility: "hidden" } },
    { selector: "edge.next", style: { "line-style": "dashed", "line-dash-pattern": [6, 4], "curve-style": "unbundled-bezier", "control-point-distances": [240], "control-point-weights": [0.5],
      color: data, "line-color": data, "target-arrow-color": data, "font-weight": 700 } },
    { selector: "edge.colored", style: { "line-color": "data(c)", "target-arrow-color": "data(c)", color: "data(c)", width: 1.8 } },
    { selector: "edge.aux", style: { opacity: 0.12, label: "", "source-label": "", "target-label": "" } },
    { selector: "edge.aux.hl", style: { opacity: 1, label: "data(label)" } },
    { selector: "edge.hl", style: { "line-color": data, "target-arrow-color": data, width: 2.4 } },
    { selector: ".faded", style: { opacity: 0.2 } },
  ];
}

function legend(cy) {
  const has = (sel) => cy.$(sel).nonempty(), items = [];
  const sw = (cls, txt) => items.push("<span><i class='sw " + cls + "'></i>" + txt + "</span>");
  if (has("node.terminal")) sw("terminal", "start / end");
  if (has("node.focus")) sw("focus", "what this diagram is about");
  if (has("node.carries")) sw("carries", "kept for the next round");
  if (has("node.total")) sw("total", "shared total, many parts add in");
  if (has("node.zoomable")) sw("zoomable", "⤢ click to zoom in");
  if (has("edge.next")) sw("next", "↻ used in the next round");
  if (has("node.unc")) sw("unc", "its code changed, not committed");
  if (has("node.live")) sw("live", "the agent is changing it now");
  return items.join("");
}

// A diagram laid out in a container: the same picture in a pane or in the floating window.
function buildCy(container, d) {
  const cy = cytoscape({ container, elements: elements(d), wheelSensitivity: 0.2, minZoom: 0.2, maxZoom: 2.5, style: style() });
  const df = d.kind === "dataflow";
  if (d.kind === "pipeline" || d.kind === "loop") cy.edges().not(".next").addClass("flow");
  cy.elements().not(".next").layout({ name: "dagre", rankDir: "TB", nodeSep: df ? 110 : 60, rankSep: df ? 130 : 50, edgeSep: df ? 40 : 20, padding: 24 }).run();
  if (df) cy.edges().not(".next").style({ "curve-style": "bezier", "control-point-step-size": 60 });
  if (d.kind === "loop") { // the carried state sits beside the loop, not in it
    const bb = cy.nodes().not(".carries").boundingBox();
    cy.nodes(".carries").forEach((n, i) => n.position({ x: bb.x2 + 140, y: bb.y1 + bb.h / 2 + i * 70 }));
  }
  const saved = S.layout?.[d.id];
  if (saved) cy.nodes().forEach((n) => { if (saved[n.id()] && !n.isParent()) n.position(saved[n.id()]); });
  cy.fit(undefined, 30);
  return cy;
}

function drawPane(which) {
  const d = byId(which === "main" ? main : side), box = $("#pane-" + which);
  if (panes[which]) { panes[which].destroy(); panes[which] = null; }
  if (!d) return;
  $(".ptitle", box).innerHTML = "<span class=k>" + esc(d.kind) + (d.rate ? " · " + esc(d.rate) : "") + "</span>" + esc(d.question) +
    "<span class=pbtns><button class=reset title='Forget where you moved the boxes'" + (S.layout?.[d.id] ? "" : " hidden") + ">reset layout</button>" +
    (which === "side" ? "<button class=x title='Close'>×</button>" : "") + "</span>";
  $(".x", box)?.addEventListener("click", () => { side = null; picked = null; setHash(); drawDiagrams(); });
  $(".reset", box).addEventListener("click", () => {
    if (S.layout) delete S.layout[d.id];
    stamp = JSON.stringify(S);
    fetch("api/diagram-layout", { method: "POST", body: JSON.stringify({ id: d.id, positions: null }) });
    drawPane(which);
  });
  const cy = buildCy($(".cyc", box), d);
  panes[which] = cy;
  if (picked?.pane === which) cy.$id(picked.id).addClass("picked");
  $(".legend", box).innerHTML = legend(cy);

  cy.on("dragfree", "node", () => { // dragged boxes stay where you put them
    const pos = {};
    cy.nodes().forEach((n) => { if (!n.isParent()) pos[n.id()] = { x: Math.round(n.position("x")), y: Math.round(n.position("y")) }; });
    S.layout = { ...(S.layout ?? {}), [d.id]: pos };
    stamp = JSON.stringify(S);
    fetch("api/diagram-layout", { method: "POST", body: JSON.stringify({ id: d.id, positions: pos }) });
    $(".reset", box).hidden = false;
  });
  const tip = $("#tip"), area = $("#canvas");
  const place = (ev) => { const r = area.getBoundingClientRect(); tip.style.left = Math.min(ev.clientX - r.left + 14, r.width - 350) + "px"; tip.style.top = ev.clientY - r.top + 14 + "px"; };
  cy.on("mouseover", "node", (e) => {
    const n = d.nodes.find((x) => x.id === e.target.id()), ns = nodeState(n);
    tip.innerHTML = "<b>" + esc(n.label) + "</b><br>" + esc(tldr(n, n.explain)) +
      (ns.live ? "<br><span style='color:var(--hot)'>◉ the agent is changing it now</span>" : ns.unc ? "<br><span style='color:var(--warn)'>its code changed, not committed</span>" : "") +
      (n.detail && byId(n.detail) ? "<br><span class=muted>click to zoom in: " + esc(byId(n.detail).question) + "</span>" : "");
    tip.hidden = false; place(e.originalEvent);
    cy.elements().not(e.target.closedNeighborhood()).not(e.target.ancestors()).not(e.target.descendants()).addClass("faded");
    e.target.connectedEdges().addClass("hl");
  });
  cy.on("mouseover", "edge", (e) => {
    const x = d.edges[+e.target.id().slice(1)];
    if (!x) return;
    tip.innerHTML = (x.next ? "<span class=muted>used in the next round</span><br>" : "") + "<b>" + esc(x.label) + "</b>" + (x.explain ? "<br>" + esc(x.explain) : "");
    tip.hidden = false; place(e.originalEvent);
    cy.elements().not(e.target).not(e.target.connectedNodes()).not(e.target.connectedNodes().ancestors()).addClass("faded");
    e.target.addClass("hl");
  });
  cy.on("mousemove", (e) => place(e.originalEvent));
  cy.on("mouseout", "node, edge", () => { tip.hidden = true; cy.elements().removeClass("faded hl"); });
  cy.on("tap", "node", (e) => {
    const n = d.nodes.find((x) => x.id === e.target.id());
    if (n.detail && byId(n.detail)) { if (which === "side") main = d.id; zoom(n.detail); return; }
    picked = { pane: which, id: n.id };
    if (insp) { insp = null; drawHeader(); }
    for (const c of Object.values(panes)) c?.nodes().removeClass("picked");
    e.target.addClass("picked");
    drawInspector();
  });
  cy.on("tap", (e) => { if (e.target === cy) { picked = null; cy.nodes().removeClass("picked"); drawInspector(); } });
}

// Both panes get their size before either is drawn, so each fits its own half.
function drawDiagrams() {
  $("#nodiagram").hidden = S.diagrams.length > 0;
  $("#pane-main").hidden = !byId(main);
  $("#pane-side").hidden = !byId(side);
  $("#canvas").classList.toggle("split", !!byId(side));
  drawPane("main"); drawPane("side");
  drawInspector();
  if (tab === "diagrams") drawSide();
}
// Only what's changing moved: restyle the boxes in place, keep zoom and positions.
function restyle() {
  const c = changed();
  if (mini.cy && mini.d) for (const n of mini.d.nodes) { const ns = nodeState(n, c); mini.cy.$id(n.id).toggleClass("live", ns.live).toggleClass("unc", ns.unc); }
  for (const [which, cy] of Object.entries(panes)) {
    const d = cy && byId(which === "main" ? main : side);
    if (!d) continue;
    for (const n of d.nodes) { const ns = nodeState(n, c); cy.$id(n.id).toggleClass("live", ns.live).toggleClass("unc", ns.unc); }
    $("#pane-" + which + " .legend").innerHTML = legend(cy);
  }
}

// ---- inspector -----------------------------------------------------------

// ---- the right panel: a short line first, more on click -------------------

// The agents write a short "tldr"; until they do, the first sentence stands in.
const tldr = (x, long) => x.tldr || (long ?? "").split(/(?<=[.!?])\s/)[0];
const more = (label, body) => body ? "<details class=more><summary>" + label + "</summary>" + body + "</details>" : "";
const fileOfModule = (id) => S.modules.find((m) => m.id === id)?.file;
const unitTestsIn = (mods) => S.tests.unit.filter((u) => mods.includes(u.module)).reduce((n, u) => n + u.tests.length, 0);
const ORDER = ["broken", "partial", "working", "planned"];
const backLink = "<a class=back data-closeinsp>← overview</a>";

function featuresPanel() {
  let h = backLink + "<h2>Features</h2><p class=lead>What it does today, as the agents see it.</p>" +
    more("where this comes from", "<p class=hint>The agents keep this list in .cockpit/project.json. They set each status and must say what's missing when a feature is partial or broken. Cockpit checks that the code they point to exists.</p>");
  for (const st of ORDER) {
    const fs = S.features.filter((f) => f.status === st);
    if (!fs.length) continue;
    h += "<h4><span class='dot st-" + st + "'></span> " + st + " · " + fs.length + "</h4>" + fs.map((f) => {
      const n = unitTestsIn(f.modules);
      return "<details class=row><summary><span class=rname>" + esc(f.name) + "</span>" + (f.note ? "<span class=rnote>" + esc(f.note) + "</span>" : "") + "</summary>" +
        "<p class=hint>" + esc(f.description) + "</p>" +
        (f.modules.length ? "<div class=chips>" + f.modules.map((m) => "<a class=chip data-file='" + esc(fileOfModule(m) ?? "") + "'>" + esc(m) + "</a>").join("") + "</div>" +
          "<p class='" + (n ? "hint" : "bad") + "'>" + (n ? n + " unit tests" : "no unit tests") + "</p>" : "") + "</details>";
    }).join("");
  }
  return h;
}

function testsPanel() {
  const t = S.tests, unitN = t.unit.reduce((n, m) => n + m.tests.length, 0), intN = t.integration.reduce((n, f) => n + f.tests.length, 0);
  const tested = t.unit.filter((m) => m.tests.length), untested = t.unit.filter((m) => !m.tests.length);
  const bare = S.features.filter((f) => f.status !== "planned" && !unitTestsIn(f.modules));
  let h = backLink + "<h2>Tests</h2><p class=lead>" + unitN + " unit, " + intN + " integration. " +
    (bare.length ? "<span class=bad>" + plural(bare.length, "feature") + " with none.</span>" : "Every feature has some.") + "</p>" +
    more("how this is counted", "<p class=hint>#[test] functions in the code: where tests exist, not how much they cover.</p>");
  if (S.features.length) h += "<h4>by feature</h4>" + S.features.filter((f) => f.status !== "planned").map((f) => ({ f, n: unitTestsIn(f.modules) })).sort((a, b) => a.n - b.n)
    .map(({ f, n }) => {
      const mods = t.unit.filter((u) => f.modules.includes(u.module) && u.tests.length);
      return "<details class=row><summary><span class=rname>" + esc(f.name) + "</span><span class='rcount " + (n ? "" : "bad") + "'>" + (n || "none") + "</span></summary>" +
        (mods.length ? mods.map((u) => u.tests.map((x) => "<a class=tname data-file='" + esc(u.file) + "' data-line=" + x.line + ">" + esc(x.name) + "</a>").join("")).join("") : "<p class=hint>No #[test] in its modules.</p>") + "</details>";
    }).join("");
  h += more("modules with no unit tests · " + untested.length, "<div class=chips>" + untested.map((m) => "<a class=chip data-file='" + esc(m.file) + "'>" + esc(m.module) + (t.unit.filter((x) => x.module === m.module).length > 1 ? " (" + esc(m.file.split("/").pop()) + ")" : "") + "</a>").join("") + "</div>");
  h += more("all unit tests · " + unitN, tested.map((m) => "<details class=row><summary><span class=rname>" + esc(m.module) + "</span><span class=rcount>" + m.tests.length + "</span></summary>" +
    m.tests.map((x) => "<a class=tname data-file='" + esc(m.file) + "' data-line=" + x.line + ">" + esc(x.name) + "</a>").join("") + "</details>").join(""));
  if (t.integration.length) h += more("integration tests · " + intN, t.integration.map((f) => "<details class=row><summary><span class=rname>" + esc(f.file) + "</span><span class=rcount>" + f.tests.length + "</span></summary>" +
    f.tests.map((x) => "<a class=tname data-file='" + esc(f.file) + "' data-line=" + x.line + ">" + esc(x.name) + "</a>").join("") + "</details>").join(""));
  return h;
}

// A code link as a small chip: the last part of the name, the full one on hover.
function codeChip(a, c) {
  const w = where(a), short = a.includes("::") ? a.split("::").slice(1).join("::") : a.split("/").pop();
  if (!w) return "<span class='chip muted'>" + esc(short) + "</span>";
  return "<a class='chip" + (anchorChanged(a, c) ? " chg" : "") + "' title='" + esc(a + " · " + w.file) + "' data-file='" + esc(w.file) + "'" +
    (w.line ? " data-line='" + w.line + "' data-end='" + (w.end ?? w.line) + "'" : "") + ">" + esc(short) + "</a>";
}

function drawInspector() {
  const el = $("#inspector");
  if (insp) {
    el.innerHTML = insp === "features" ? featuresPanel() : testsPanel();
    for (const a of el.querySelectorAll("[data-closeinsp]")) a.onclick = () => { insp = null; drawHeader(); drawInspector(); };
    wire(el);
    return;
  }
  const d = byId(picked ? (picked.pane === "main" ? main : side) : side ?? main);
  if (!d) { el.innerHTML = "<p class=hint>The agents haven't drawn anything yet.</p>"; return; }
  const n = picked && d.nodes.find((x) => x.id === picked.id), c = changed();
  const parent = S.diagrams.find((x) => x.nodes.some((m) => m.detail === d.id));
  let h = (parent ? "<a class=back data-open='" + esc(parent.id) + "'>↑ " + esc(parent.question) + "</a>" : "");
  if (n) {
    const ns = nodeState(n, c);
    const ins = d.edges.filter((e) => e.to === n.id), outs = d.edges.filter((e) => e.from === n.id), lab = (id) => esc(d.nodes.find((x) => x.id === id)?.label ?? id);
    const row = (e, dir) => "<div class=io><span class=dv>" + (e.next ? "↻ " : "") + esc(e.label) + "</span> " + (dir === "from" ? "← " + lab(e.from) : "→ " + lab(e.to)) + "</div>";
    h += "<div class=kicker>" + esc(d.question) + "</div><h2>" + esc(n.label) + "</h2><p class=lead>" + esc(tldr(n, n.explain)) + "</p>" +
      (ns.live ? "<p class=agentbox>◉ the agent is changing it now</p>" : ns.unc ? "<p class=notebox>changed, not committed</p>" : "") +
      ((n.anchors ?? []).length ? "<div class=chips>" + n.anchors.map((a) => codeChip(a, c)).join("") + "</div>" : "") +
      more("more", (n.tldr || tldr(n, n.explain) !== n.explain ? "<p>" + esc(n.explain) + "</p>" : "") +
        (ins.length || outs.length ? "<h4>in and out</h4>" + ins.map((e) => row(e, "from")).join("") + outs.map((e) => row(e, "to")).join("") : ""));
  } else {
    const busy = d.nodes.filter((x) => nodeState(x, c).unc);
    h += "<div class=kicker>drawn by the agents" + (d.rate ? " · " + esc(d.rate) : "") + "</div><h2>" + esc(d.question) + "</h2><p class=lead>" + esc(tldr(d, d.answer)) + "</p>" +
      (busy.length ? "<p class=notebox>changed: " + busy.map((x) => esc(x.label)).join(", ") + "</p>" : "") +
      more("more", (d.tldr || tldr(d, d.answer) !== d.answer ? "<p>" + esc(d.answer) + "</p>" : "") + "<p class=hint>Why a picture: " + esc(d.why) + "</p>") +
      "<p class=hint>Hover a box · click for its code · ⤢ zooms in</p>";
  }
  el.innerHTML = h;
  wire(el);
}

// ---- drawer: code and diffs ----------------------------------------------

const LANGS = { rs: "rust", ron: "rust", ts: "typescript", js: "javascript", json: "json", toml: "ini", md: "markdown", yml: "yaml", yaml: "yaml", sh: "bash", py: "python", css: "css", html: "xml" };
const langOf = (p) => LANGS[p.split(".").pop()] ?? null;
// Highlight the whole text, then cut the HTML into lines, closing and reopening spans at each
// line break so multi-line comments and strings keep their color.
function hlLines(text, lang) {
  let html;
  try { html = lang && window.hljs ? hljs.highlight(text, { language: lang, ignoreIllegals: true }).value : esc(text); } catch { html = esc(text); }
  const out = [], stack = [], re = /(<span[^>]*>)|(<\/span>)|(\n)|([^<\n]+)/g;
  let cur = "", m;
  while ((m = re.exec(html))) {
    if (m[1]) { stack.push(m[1]); cur += m[1]; }
    else if (m[2]) { stack.pop(); cur += m[2]; }
    else if (m[3]) { out.push(cur + "</span>".repeat(stack.length)); cur = stack.join(""); }
    else cur += m[4];
  }
  out.push(cur + "</span>".repeat(stack.length));
  return out;
}
const hlLine = (line, lang) => { try { return lang && window.hljs ? hljs.highlight(line, { language: lang, ignoreIllegals: true }).value : esc(line); } catch { return esc(line); } };

// A unified diff as a table: old and new line numbers in their own cells, so they scroll with the code.
function diffHtml(patch) {
  if (!patch.trim()) return "<p class=dnote>No changes.</p>";
  let h = "", lang = null, o = 0, n = 0, open = false;
  const close = () => { if (open) { h += "</table>"; open = false; } };
  for (const l of patch.split("\n")) {
    if (l.startsWith("diff --git")) {
      close();
      const p = l.split(" b/").pop();
      lang = langOf(p);
      h += "<div class=fhead><a data-file='" + esc(p) + "'>" + esc(p) + "</a></div><table class=code>"; open = true;
    } else if (/^(index |--- |\+\+\+ |new file|deleted file|similarity|rename |old mode|new mode)/.test(l)) continue;
    else if (l.startsWith("@@")) {
      const m = l.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
      if (m) { o = +m[1]; n = +m[2]; }
      if (!open) { h += "<table class=code>"; open = true; }
      h += "<tr class=hunk><td colspan=4>" + esc(l) + "</td></tr>";
    } else if (l.startsWith("\\")) continue;
    else if (open && (l[0] === "+" || l[0] === "-" || l[0] === " ")) {
      const k = l[0] === "+" ? "add" : l[0] === "-" ? "del" : "";
      h += "<tr class='" + k + "'" + (k === "del" ? "" : " data-n=" + n) + "><td class=ln>" + (k === "add" ? "" : o++) + "</td><td class=ln>" + (k === "del" ? "" : n++) + "</td><td class=sg>" + (k ? l[0] : "") + "</td><td class=c>" + hlLine(l.slice(1), lang) + "</td></tr>";
    }
  }
  close();
  return h;
}

// Which diagram boxes point into this file, to jump back from code to the picture.
function boxesIn(path) {
  const out = [];
  for (const d of S.diagrams) for (const n of d.nodes) if (filesOfNode(n).includes(path)) out.push({ d, n });
  return out;
}

async function showDrawer(spec) {
  drawer = spec;
  const el = $("#drawer"), head = $(".dhead", el), body = $(".dbody", el);
  el.hidden = false;
  const close = "<span class=grow></span><button class=dclose title='Close (Esc)'>×</button>";
  if (spec.kind === "commit") {
    head.innerHTML = "<span class=path>commit " + esc(spec.sha) + "</span>" + close;
    body.innerHTML = "<p class=dnote>loading…</p>";
    const c = await (await fetch("api/git/commit?sha=" + encodeURIComponent(spec.sha))).json();
    if (drawer !== spec) return;
    body.innerHTML = c.error ? "<p class=dnote>" + esc(c.error) + "</p>" :
      "<div class=commitmeta><b>" + esc(c.subject) + "</b><div class=muted>" + esc(c.author) + " · " + new Date(c.date).toLocaleString() + " · " + esc(c.sha.slice(0, 10)) + "</div>" + (c.body ? "<pre>" + esc(c.body) + "</pre>" : "") + "</div>" + diffHtml(c.patch);
  } else {
    const changedFile = S.changedFiles.includes(spec.path) || S.status.some((s) => s.path === spec.path);
    const view = spec.view ?? (changedFile && !spec.line ? "diff" : "file");
    spec.view = view;
    const boxes = boxesIn(spec.path);
    head.innerHTML = "<span class=path>" + esc(spec.path) + "</span>" + (statusOf(spec.path) ? "<span class='mark " + statusOf(spec.path) + "'>" + statusOf(spec.path) + "</span>" : "") +
      (changedFile ? "<span class=seg><button data-view=diff" + (view === "diff" ? " class=on" : "") + ">changes</button><button data-view=file" + (view === "file" ? " class=on" : "") + ">file</button></span>" : "") + close +
      (boxes.length ? "<div class=inchips><span class=muted>in diagrams:</span>" + boxes.map(({ d, n }) => "<a data-open='" + esc(d.id) + "' data-node='" + esc(n.id) + "' title='" + esc(d.question) + "'>" + esc(n.label) + "</a>").join("") + "</div>" : "");
    for (const b of head.querySelectorAll("[data-view]")) b.onclick = () => showDrawer({ ...spec, view: b.dataset.view });
    body.innerHTML = "<p class=dnote>loading…</p>";
    if (view === "diff") {
      const r = await (await fetch("api/git/diff?path=" + encodeURIComponent(spec.path))).json();
      if (drawer !== spec) return;
      body.innerHTML = r.error ? "<p class=dnote>" + esc(r.error) + "</p>" : diffHtml(r.patch);
    } else {
      const r = await (await fetch("api/file?path=" + encodeURIComponent(spec.path))).json();
      if (drawer !== spec) return;
      if (r.error || r.text === null) { body.innerHTML = "<p class=dnote>" + esc(r.error ?? r.note) + "</p>"; }
      else {
        const lines = hlLines(r.text.replace(/\n$/, ""), langOf(spec.path)), a = spec.line ?? -1, b = spec.end ?? a;
        body.innerHTML = "<table class=code>" + lines.map((l, i) => "<tr id=L" + (i + 1) + " data-n=" + (i + 1) + (i + 1 >= a && i + 1 <= b ? " class=hl" : "") + "><td class=ln>" + (i + 1) + "</td><td class=c>" + l + "</td></tr>").join("") + "</table>";
        if (a > 0) $("#L" + a, body)?.scrollIntoView({ block: "center" });
      }
    }
  }
  $(".dclose", head).onclick = closeDrawer;
  if (spec.kind === "file") showMini(spec.path); else hideMini();
  wire(el);
  if (tab !== "diagrams") drawSide();
}
function closeDrawer() { drawer = null; $("#drawer").hidden = true; hideMini(); if (tab !== "diagrams") drawSide(); }

// ---- the floating overview over the code ---------------------------------
// While a file is open, a small diagram floats over it: boxes in this file are outlined, the
// ones whose code is on screen light up as you scroll. Hover a box to see its lines, click it to
// go there. Drag the title bar to move it, the corner to resize it.

const mini = { cy: null, d: null, path: null };
const miniGeo = () => { try { return JSON.parse(store.get("cockpit-mini", "null")); } catch { return null; } };
const diagramsIn = (path) => S.diagrams.filter((d) => d.nodes.some((n) => filesOfNode(n).includes(path)));
// The lines a box covers in this file; a whole-module link covers the file but isn't "on screen".
function rangesIn(n, path) {
  return (n.anchors ?? []).map(where).filter((w) => w && w.file === path).map((w) => (w.line ? [w.line, w.end ?? w.line] : null));
}
function hideMini() { $("#mini").hidden = true; if (mini.cy) { mini.cy.destroy(); mini.cy = null; } mini.path = null; }
function showMini(path, id) {
  const el = $("#mini"), ds = diagramsIn(path);
  if (!ds.length) return hideMini();
  const d = ds.find((x) => x.id === id) || (mini.path === path && ds.find((x) => x.id === mini.d?.id)) || ds.find((x) => x.id === main) || ds.find((x) => x.id === side) || ds[0];
  el.hidden = false;
  const g = miniGeo();
  if (g) Object.assign(el.style, { left: g.left + "px", top: g.top + "px", width: g.width + "px", height: g.height + "px", right: "auto", bottom: "auto" });
  $(".mtitle", el).textContent = d.question;
  $(".mtabs", el).innerHTML = ds.length > 1 ? ds.map((x) => "<button data-mini='" + esc(x.id) + "'" + (x.id === d.id ? " class=on" : "") + " title='" + esc(x.question) + "'>" + esc(x.id.replace(/-/g, " ")) + "</button>").join("") : "";
  for (const b of el.querySelectorAll("[data-mini]")) b.onclick = (e) => { e.stopPropagation(); showMini(path, b.dataset.mini); };
  if (mini.cy) mini.cy.destroy();
  mini.d = d; mini.path = path;
  const cy = (mini.cy = buildCy($(".mcy", el), d));
  cy.nodes().forEach((x) => { const n = d.nodes.find((m) => m.id === x.id()); if (n && filesOfNode(n).includes(path)) x.addClass("infile"); });
  const rows = () => [...document.querySelectorAll("#drawer .dbody tr[data-n]")];
  const mark = (n, on) => {
    const rs = rangesIn(n, path).filter(Boolean);
    for (const tr of rows()) { const k = +tr.dataset.n; tr.classList.toggle("boxhl", on && rs.some(([a, b]) => k >= a && k <= b)); }
  };
  cy.on("mouseover", "node", (e) => { const n = d.nodes.find((m) => m.id === e.target.id()); if (!n) return; $(".mfoot", el).textContent = n.label + ": " + tldr(n, n.explain); mark(n, true); });
  cy.on("mouseout", "node", (e) => { const n = d.nodes.find((m) => m.id === e.target.id()); $(".mfoot", el).textContent = ""; if (n) mark(n, false); });
  cy.on("tap", "node", (e) => {
    const n = d.nodes.find((m) => m.id === e.target.id());
    if (!n) return;
    const here = rangesIn(n, path).find(Boolean);
    if (here) { const tr = document.querySelector("#drawer .dbody tr[data-n='" + here[0] + "']"); tr?.scrollIntoView({ block: "center", behavior: "smooth" }); return; }
    const w = (n.anchors ?? []).map(where).find(Boolean);
    if (w) showDrawer({ kind: "file", path: w.file, line: w.line, end: w.end });
  });
  syncMini();
}
// Which boxes have code on screen right now.
function syncMini() {
  if (!mini.cy || !mini.d) return;
  const body = $("#drawer .dbody"), box = body.getBoundingClientRect();
  let lo = Infinity, hi = -Infinity;
  for (const tr of body.querySelectorAll("tr[data-n]")) {
    const r = tr.getBoundingClientRect();
    if (r.bottom < box.top) continue;
    if (r.top > box.bottom) break;
    lo = Math.min(lo, +tr.dataset.n); hi = Math.max(hi, +tr.dataset.n);
  }
  for (const n of mini.d.nodes) {
    const on = lo <= hi && rangesIn(n, mini.path).some((r) => r && r[0] <= hi && r[1] >= lo);
    mini.cy.$id(n.id).toggleClass("inview", on);
  }
}
let miniTick = 0;
$("#drawer .dbody").addEventListener("scroll", () => { cancelAnimationFrame(miniTick); miniTick = requestAnimationFrame(syncMini); });
// Move by the title bar; resize from the corner (CSS); both remembered.
(function () {
  const el = $("#mini"), head = $(".mhead", el), save = () => {
    const r = el.getBoundingClientRect(), p = el.offsetParent.getBoundingClientRect();
    store.set("cockpit-mini", JSON.stringify({ left: r.left - p.left, top: r.top - p.top, width: r.width, height: r.height }));
  };
  head.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button")) return;
    const r = el.getBoundingClientRect(), p = el.offsetParent.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
    const move = (ev) => {
      el.style.left = Math.max(0, Math.min(p.width - 80, ev.clientX - p.left - dx)) + "px";
      el.style.top = Math.max(0, Math.min(p.height - 30, ev.clientY - p.top - dy)) + "px";
      el.style.right = "auto"; el.style.bottom = "auto";
    };
    const up = () => { removeEventListener("pointermove", move); removeEventListener("pointerup", up); save(); };
    addEventListener("pointermove", move); addEventListener("pointerup", up);
  });
  let t = 0;
  new ResizeObserver(() => { if (!mini.cy || el.hidden) return; mini.cy.resize(); clearTimeout(t); t = setTimeout(() => { mini.cy?.fit(undefined, 16); save(); }, 120); }).observe(el);
  $(".mclose", el).onclick = () => el.classList.toggle("collapsed");
})();

// ---- wiring --------------------------------------------------------------

function wire(el) {
  for (const a of el.querySelectorAll("[data-file]")) a.onclick = (e) => { e.preventDefault(); showDrawer({ kind: "file", path: a.dataset.file, line: a.dataset.line ? +a.dataset.line : undefined, end: a.dataset.end ? +a.dataset.end : undefined }); };
  for (const a of el.querySelectorAll("[data-diff]")) a.onclick = () => showDrawer({ kind: "file", path: a.dataset.diff, view: "diff" });
  for (const a of el.querySelectorAll("[data-commit]")) a.onclick = () => showDrawer({ kind: "commit", sha: a.dataset.commit });
  for (const a of el.querySelectorAll("[data-open]")) a.onclick = (e) => { e.preventDefault(); closeDrawer(); openDiagram(a.dataset.open, a.dataset.node); };
}
for (const b of document.querySelectorAll("[data-tab]")) b.addEventListener("click", () => { tab = b.dataset.tab; store.set("cockpit-tab", tab); drawSide(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && drawer) closeDrawer(); });
window.addEventListener("hashchange", () => {
  const [a, b] = decodeURIComponent(location.hash.slice(1)).split(",");
  if (a !== main || (b || null) !== side) { main = byId(a) ? a : main; side = byId(b) ? b : null; drawDiagrams(); }
});

// Live: poll everything in one request; redraw only what changed.
async function poll() {
  try {
    const r = await fetch("api/state");
    if (r.ok) {
      const ns = await r.json(), s = JSON.stringify(ns);
      if (s !== stamp) {
        const sameDiagrams = JSON.stringify(ns.diagrams) === JSON.stringify(S.diagrams) && JSON.stringify(ns.layout) === JSON.stringify(S.layout);
        const filesMoved = JSON.stringify(ns.status) !== JSON.stringify(S.status);
        S = ns; stamp = s;
        if (filesMoved) files = null;
        if (!byId(main)) main = (S.diagrams.find((d) => d.kind === "loop") ?? S.diagrams[0])?.id ?? null;
        if (!byId(side)) side = null;
        drawHeader();
        if (sameDiagrams) { restyle(); drawInspector(); } else { drawDiagrams(); if (drawer?.kind === "file") showMini(drawer.path); }
        drawSide();
      }
    }
  } catch {}
  setTimeout(poll, S.live ? 1500 : 4000);
}
// Links can open a tab or the drawer directly: ?tab=git, ?file=path[&line=n], ?diff=path, ?commit=sha.
const Q = new URLSearchParams(location.search);
if (["diagrams", "files", "git"].includes(Q.get("tab"))) tab = Q.get("tab");
if (["features", "tests"].includes(Q.get("panel"))) insp = Q.get("panel");
drawHeader(); drawDiagrams(); drawSide();
if (Q.get("file")) showDrawer({ kind: "file", path: Q.get("file"), line: Q.get("line") ? +Q.get("line") : undefined });
else if (Q.get("diff")) showDrawer({ kind: "file", path: Q.get("diff"), view: "diff" });
else if (Q.get("commit")) showDrawer({ kind: "commit", sha: Q.get("commit") });
setTimeout(poll, 2000);
