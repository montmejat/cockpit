// Diagrams (E9): the pictures the agents keep in architecture.json, drawn with Cytoscape + dagre.
// A box can zoom into another diagram: it opens beside the first, so you see "when" and "what"
// together. Hover a box for its explanation, click it for its code; boxes glow while an agent
// edits their code.

let D = INIT.diagrams, stamp = JSON.stringify(D);
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const byId = (id) => D.diagrams.find((d) => d.id === id);

// The URL hash holds the open diagrams: "#main" or "#main,detail".
let [main, side] = decodeURIComponent(location.hash.slice(1)).split(",");
if (!byId(main)) main = (D.diagrams.find((d) => d.kind === "loop") ?? D.diagrams[0])?.id ?? null;
if (!byId(side)) side = null;
let picked = null; // { pane, id }
const panes = { main: null, side: null }; // cytoscape instances

function where(a) {
  const [mod] = a.split("::"), m = D.modules.find((x) => x.id === mod);
  if (!m) return null;
  const it = a.includes("::") ? m.items.find((i) => i.key === a) : null;
  return { file: m.file, line: it?.line, go: "s:" + m.file + (it ? ":" + it.line : "") };
}
const filesOf = (n) => [...new Set((n.anchors ?? []).map(where).filter(Boolean).map((w) => w.file))];
const liveFiles = () => new Set((D.live?.touched ?? []).map((t) => t.file));

function setHash() { history.replaceState(null, "", location.pathname + "#" + encodeURIComponent([main, side].filter(Boolean).join(","))); }
function open(id) { main = id; side = null; picked = null; setHash(); drawAll(); }
function zoom(id) { side = id; picked = null; setHash(); drawAll(); }

function drawList() {
  const zoomTargets = new Set(D.diagrams.flatMap((d) => d.nodes.map((n) => n.detail).filter(Boolean)));
  $("#dlist").innerHTML = D.diagrams.length
    ? D.diagrams.map((d) => "<a class='q" + (d.id === main ? " on" : d.id === side ? " on2" : "") + (zoomTargets.has(d.id) ? " sub" : "") + "' href='#" + esc(d.id) + "'><span class=k>" + esc(d.kind) + (d.rate ? " · " + esc(d.rate) : "") + "</span>" + esc(d.question) + "</a>").join("")
    : "<p class=muted>No diagrams yet. Agents add them to architecture.json (see CLAUDE.md).</p>";
  for (const a of $("#dlist").querySelectorAll("a")) a.onclick = (e) => { e.preventDefault(); open(a.getAttribute("href").slice(1)); };
  $("#problems").innerHTML = D.problems.length ? "<h4>doesn't match the code</h4>" + D.problems.map((p) => "<p class=prob>" + esc(p.where) + ": " + esc(p.problem) + "</p>").join("") : "";
}

function elements(d) {
  const lf = liveFiles(), els = [];
  for (const n of d.nodes) {
    const files = filesOf(n);
    const cls = [n.zone ? "zone" : n.outside ? "outside" : "part", n.focus && "focus", n.total && "total", n.carries && "carries",
      (n.start || n.end) && "terminal", n.detail && byId(n.detail) && "zoomable",
      files.some((f) => lf.has(f)) && "live", files.some((f) => D.work[f]) && "unc"].filter(Boolean).join(" ");
    els.push({ data: { id: n.id, label: n.label + (n.detail && byId(n.detail) ? "  ⤢" : ""), parent: n.in }, classes: cls });
  }
  // Labels go where they can't collide: by the source if it's the only edge leaving it,
  // else by the target if it's the only one arriving, else in the middle.
  const flows = d.edges.filter((e) => !e.next), outN = (id) => flows.filter((e) => e.from === id).length, inN = (id) => flows.filter((e) => e.to === id).length;
  // Dataflow: each arrow takes the color of the box it leaves, so it can be followed by eye.
  const PAL = ["#2b7bd6", "#d9622b", "#2a9d6f", "#a35bd1", "#c79a1c", "#d1477a", "#3a9fb5", "#7a8a2a"];
  const srcs = [...new Set(d.edges.map((e) => e.from))], colorOf = (id) => PAL[srcs.indexOf(id) % PAL.length];
  d.edges.forEach((e, i) => els.push({ data: { id: "e" + i, source: e.from, target: e.to, label: e.next ? "↻ " + e.label : e.label,
    pos: d.kind === "dataflow" ? "mid" : e.next ? "mid" : outN(e.from) === 1 ? "src" : inN(e.to) === 1 ? "tgt" : "mid",
    c: d.kind === "dataflow" ? colorOf(e.from) : "" }, classes: (e.next ? "edge next" : "edge") + (d.kind === "dataflow" ? " colored" : "") }));
  // Reads of a carried state ("the car at t") go to many boxes: faint until hovered.
  const carried = new Set(d.nodes.filter((n) => n.carries).map((n) => n.id));
  if (d.kind === "dataflow") for (const el of els) if (el.data.source && carried.has(el.data.source) && !el.classes.includes("next")) el.classes += " aux";
  // A loop shows its spine: the steps in order and the one arrow back to the first step.
  // Reads and writes of the carried state stay faint until you hover a box.
  if (d.kind === "loop") {
    const steps = d.nodes.filter((n) => !n.zone && !n.outside && !n.carries && !n.start && !n.end), first = steps[0]?.id;
    const carried = new Set(d.nodes.filter((n) => n.carries).map((n) => n.id));
    for (const el of els) if (el.data.source && (carried.has(el.data.source) || carried.has(el.data.target) || (el.classes.includes("next") && el.data.target !== first))) el.classes += " aux";
  }
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
    { selector: "node.unc", style: { "border-style": "dashed", "border-color": warn } },
    { selector: "node.live", style: { "border-color": sig, "border-width": 3, "underlay-color": sig, "underlay-opacity": 0.25, "underlay-padding": 8 } },
    { selector: "node.picked", style: { "border-color": data, "border-width": 3 } },
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
    { selector: "edge.hl", style: { "line-color": data, "target-arrow-color": data, width: 2.2 } },
    { selector: ".faded", style: { opacity: 0.25 } },
  ];
}

// What the markings in this diagram mean, listing only the ones it uses.
function legend(d, cy) {
  const has = (sel) => cy.$(sel).nonempty(), items = [];
  const sw = (cls, txt) => items.push("<span><i class='sw " + cls + "'></i>" + txt + "</span>");
  if (has("node.terminal")) sw("terminal", "start / end");
  if (has("node.focus")) sw("focus", "what this diagram is about");
  if (has("node.carries")) sw("carries", "kept for the next round");
  if (has("node.total")) sw("total", "shared total, many parts add in");
  if (has("node.zoomable")) sw("zoomable", "⤢ click to zoom in");
  if (has("edge.next")) sw("next", "↻ used in the next round");
  if (has("node.live")) sw("live", "an agent is editing it");
  if (has("node.unc")) sw("unc", "changed, not committed");
  return items.join("");
}

function drawPane(which) {
  const id = which === "main" ? main : side, d = byId(id), box = $("#pane-" + which);
  if (panes[which]) { panes[which].destroy(); panes[which] = null; }
  box.hidden = !d;
  $(".dmain").classList.toggle("split", !!side && !!byId(side));
  if (!d) return;
  box.querySelector(".ptitle").innerHTML = "<span class=k>" + esc(d.kind) + (d.rate ? " · " + esc(d.rate) : "") + "</span>" + esc(d.question) +
    "<span class=pbtns><button class=reset title='Forget where you moved the boxes'" + (D.layout?.[d.id] ? "" : " hidden") + ">reset layout</button>" +
    (which === "side" ? "<button class=x title='Close'>×</button>" : "") + "</span>";
  box.querySelector(".x")?.addEventListener("click", () => { side = null; picked = null; setHash(); drawAll(); });
  box.querySelector(".reset").addEventListener("click", () => {
    if (D.layout) delete D.layout[d.id];
    fetch("api/diagram-layout", { method: "POST", body: JSON.stringify({ id: d.id, positions: null }) });
    drawPane(which);
  });
  const cy = cytoscape({ container: box.querySelector(".cyc"), elements: elements(d), wheelSensitivity: 0.2, minZoom: 0.25, maxZoom: 2.5, style: style() });
  panes[which] = cy;
  if (d.kind === "pipeline" || d.kind === "loop") cy.edges().not(".next").addClass("flow");
  const df = d.kind === "dataflow";
  cy.elements().not(".next").layout({ name: "dagre", rankDir: "TB", nodeSep: df ? 110 : 60, rankSep: df ? 130 : 50, edgeSep: df ? 40 : 20, padding: 24 }).run();
  if (df) cy.edges().not(".next").style({ "curve-style": "bezier", "control-point-step-size": 60 });
  if (d.kind === "loop") {
    const spine = cy.nodes().not(".carries"), bb = spine.boundingBox();
    cy.nodes(".carries").forEach((n, i) => n.position({ x: bb.x2 + 140, y: bb.y1 + bb.h / 2 + i * 70 }));
  }
  const saved = D.layout?.[d.id];
  if (saved) cy.nodes().forEach((n) => { if (saved[n.id()] && !n.isParent()) n.position(saved[n.id()]); });
  cy.fit(undefined, 30);
  // Dragging a box keeps it there, for everyone opening this diagram.
  cy.on("dragfree", "node", () => {
    const pos = {};
    cy.nodes().forEach((n) => { if (!n.isParent()) pos[n.id()] = { x: Math.round(n.position("x")), y: Math.round(n.position("y")) }; });
    D.layout = { ...(D.layout ?? {}), [d.id]: pos };
    fetch("api/diagram-layout", { method: "POST", body: JSON.stringify({ id: d.id, positions: pos }) });
    box.querySelector(".reset").hidden = false;
  });
  box.querySelector(".legend2").innerHTML = legend(d, cy);

  const tip = $("#tip"), area = $(".dmain");
  const place = (ev) => { const r = area.getBoundingClientRect(); tip.style.left = ev.clientX - r.left + 14 + "px"; tip.style.top = ev.clientY - r.top + 14 + "px"; };
  cy.on("mouseover", "node", (e) => {
    const n = d.nodes.find((x) => x.id === e.target.id());
    tip.innerHTML = "<b>" + esc(n.label) + "</b><br>" + esc(n.explain) + (n.detail && byId(n.detail) ? "<br><span class=muted>click to zoom in: " + esc(byId(n.detail).question) + "</span>" : "");
    tip.hidden = false; place(e.originalEvent);
    cy.elements().not(e.target.closedNeighborhood()).not(e.target.ancestors()).not(e.target.descendants()).addClass("faded");
    e.target.connectedEdges().addClass("hl");
  });
  cy.on("mousemove", (e) => place(e.originalEvent));
  cy.on("mouseout", "node", () => { tip.hidden = true; cy.elements().removeClass("faded hl"); });
  cy.on("mouseover", "edge", (e) => {
    const x = d.edges[+e.target.id().slice(1)];
    if (!x) return;
    tip.innerHTML = (x.next ? "<span class=muted>used in the next round</span><br>" : "") + "<b>" + esc(x.label) + "</b>" + (x.explain ? "<br>" + esc(x.explain) : "");
    tip.hidden = false; place(e.originalEvent);
  });
  cy.on("mouseover", "edge", (e) => {
    cy.elements().not(e.target).not(e.target.connectedNodes()).not(e.target.connectedNodes().ancestors()).addClass("faded");
    e.target.addClass("hl");
  });
  cy.on("mouseout", "edge", () => { tip.hidden = true; cy.elements().removeClass("faded hl"); });
  cy.on("tap", "node", (e) => {
    const n = d.nodes.find((x) => x.id === e.target.id());
    picked = { pane: which, id: n.id };
    for (const c of Object.values(panes)) c?.nodes().removeClass("picked");
    e.target.addClass("picked");
    if (n.detail && byId(n.detail)) {
      if (which === "side") main = d.id; // keep zooming: this diagram moves to the left pane
      zoom(n.detail);
      return;
    }
    drawPanel();
  });
  cy.on("tap", (e) => { if (e.target === cy) { picked = null; cy.nodes().removeClass("picked"); drawPanel(); } });
}

function drawPanel() {
  const d = byId(picked ? (picked.pane === "main" ? main : side) : side ?? main);
  if (!d) { $("#panel").innerHTML = ""; return; }
  const n = picked && d.nodes.find((x) => x.id === picked.id), lf = liveFiles();
  const parent = D.diagrams.find((x) => x.nodes.some((m) => m.detail === d.id));
  let h = (parent ? "<a class=back href='#" + esc(parent.id) + "'>↑ part of: " + esc(parent.question) + "</a>" : "") +
    "<div class=kicker>" + esc(d.kind) + (d.rate ? " · " + esc(d.rate) : "") + "</div><h2>" + esc(d.question) + "</h2><p>" + esc(d.answer) + "</p>" +
    "<p class=why><span>why a picture</span> " + esc(d.why) + "</p>";
  const focus = d.nodes.find((x) => x.focus);
  if (focus && !n) h += "<p class=why><span>highlighted</span> <b>" + esc(focus.label) + "</b>: " + esc(focus.explain) + "</p>";
  if (n) {
    const files = filesOf(n);
    h += "<div class=node><h3>" + esc(n.label) + "</h3>" + (n.focus ? "<p class=muted>The box this diagram is about.</p>" : "") + "<p>" + esc(n.explain) + "</p>" +
      (files.some((f) => lf.has(f)) ? "<p class=agentbox>◉ an agent is editing this code now</p>" : "") +
      (files.some((f) => D.work[f]) ? "<p class=notebox>changed, not committed yet</p>" : "") +
      ((n.anchors ?? []).length ? "<h4>code</h4>" + n.anchors.map((a) => { const w = where(a); return "<a class=code href='work#" + esc(w?.go ?? "") + "'>" + esc(a) + "</a>"; }).join("") : "") +
      (() => {
        const ins = d.edges.filter((e) => e.to === n.id), outs = d.edges.filter((e) => e.from === n.id), lab = (id) => esc(d.nodes.find((x) => x.id === id)?.label ?? id);
        const row = (e, dir) => "<div class=io><span class=dv>" + (e.next ? "↻ " : "") + esc(e.label) + "</span> " + dir + " " + lab(dir === "from" ? e.from : e.to) + (e.next ? " <span class=muted>(next round)</span>" : "") + "</div>";
        return (ins.length ? "<h4>gets</h4>" + ins.map((e) => row(e, "from")).join("") : "") + (outs.length ? "<h4>gives</h4>" + outs.map((e) => row(e, "to")).join("") : "");
      })() + "</div>";
  } else h += "<p class=hint>Hover a box for what it is. Click it for its code, or to zoom in when it has ⤢.</p>";
  $("#panel").innerHTML = h;
  $("#panel").querySelector(".back")?.addEventListener("click", (e) => { e.preventDefault(); open(parent.id); });
}

function drawHead() {
  $("#live").innerHTML = D.live ? "<a href='work?turn=" + esc(D.live.id) + "' class=livepill title='" + esc(D.live.prompt) + "'>◉ agent working · " + D.live.touched.length + " edits</a>" : "";
}
// Both panes get their size before either is drawn, so each fits its own half.
function drawAll() {
  drawHead(); drawList();
  $("#pane-side").hidden = !byId(side);
  $(".dmain").classList.toggle("split", !!byId(side));
  drawPane("main"); drawPane("side"); drawPanel();
}

window.addEventListener("hashchange", () => {
  const [a, b] = decodeURIComponent(location.hash.slice(1)).split(",");
  if (a !== main || (b || null) !== side) { main = byId(a) ? a : main; side = byId(b) ? b : null; drawAll(); }
});
async function poll() {
  try {
    const r = await fetch("api/diagrams");
    if (r.ok) {
      const nd = await r.json(), s = JSON.stringify(nd);
      if (s !== stamp) {
        const same = JSON.stringify(nd.diagrams) === JSON.stringify(D.diagrams) && JSON.stringify(nd.layout) === JSON.stringify(D.layout);
        D = nd; stamp = s;
        if (!byId(main)) main = D.diagrams[0]?.id ?? null;
        if (!byId(side)) side = null;
        if (same) { // only the live state changed: restyle in place, keep the view
          const lf = liveFiles();
          for (const [which, cy] of Object.entries(panes)) {
            const d = cy && byId(which === "main" ? main : side);
            if (!d) continue;
            for (const n of d.nodes) { const f = filesOf(n); cy.$id(n.id).toggleClass("live", f.some((x) => lf.has(x))).toggleClass("unc", f.some((x) => D.work[x])); }
            $("#pane-" + which + " .legend2").innerHTML = legend(d, cy);
          }
          drawHead(); drawPanel();
        } else drawAll();
      }
    }
  } catch {}
  setTimeout(poll, D.live ? 1500 : 4000);
}
drawAll();
setTimeout(poll, 2000);
