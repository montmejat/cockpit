// Diagrams (E9): the pictures the agents keep in architecture.json, drawn with Cytoscape + dagre.
// Hover a box for its explanation, click it for its code; boxes glow while an agent edits their code.

let D = INIT.diagrams, stamp = JSON.stringify(D);
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
let cur = decodeURIComponent(location.hash.slice(1)) || D.diagrams[0]?.id || null, picked = null, cy = null;
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

// Where an anchor lives: "game/sim" (a module) or "game/sim::SimState::reset" (an item).
function where(a) {
  const [mod] = a.split("::"), m = D.modules.find((x) => x.id === mod);
  if (!m) return null;
  const it = a.includes("::") ? m.items.find((i) => i.key === a) : null;
  return { file: m.file, line: it?.line, go: "s:" + m.file + (it ? ":" + it.line : "") };
}
const filesOf = (n) => [...new Set((n.anchors ?? []).map(where).filter(Boolean).map((w) => w.file))];
const liveFiles = () => new Set((D.live?.touched ?? []).map((t) => t.file));
const diagram = () => D.diagrams.find((d) => d.id === cur);

function drawList() {
  $("#dlist").innerHTML = D.diagrams.length
    ? D.diagrams.map((d) => "<a class='q" + (d.id === cur ? " on" : "") + "' href='#" + esc(d.id) + "'><span class=k>" + esc(d.kind) + "</span>" + esc(d.question) + "</a>").join("")
    : "<p class=muted>No diagrams yet. Agents add them to architecture.json (see CLAUDE.md).</p>";
  for (const a of $("#dlist").querySelectorAll("a")) a.onclick = (e) => { e.preventDefault(); show(a.getAttribute("href").slice(1)); };
  $("#problems").innerHTML = D.problems.length ? "<h4>doesn't match the code</h4>" + D.problems.map((p) => "<p class=prob>" + esc(p.where) + ": " + esc(p.problem) + "</p>").join("") : "";
}

function show(id) {
  cur = id; picked = null;
  history.replaceState(null, "", location.pathname + "#" + encodeURIComponent(id));
  drawList(); drawGraph(); drawPanel();
}

function elements(d) {
  const lf = liveFiles(), els = [];
  for (const n of d.nodes) {
    const files = filesOf(n);
    const cls = [n.zone ? "zone" : n.outside ? "outside" : "part", n.focus ? "focus" : "", n.total ? "total" : "",
      files.some((f) => lf.has(f)) ? "live" : "", files.some((f) => D.work[f]) ? "unc" : ""].filter(Boolean).join(" ");
    els.push({ data: { id: n.id, label: n.label, parent: n.in }, classes: cls });
  }
  // Put each label where it can't collide: by the source if it's the only edge leaving it,
  // else by the target if it's the only one arriving, else in the middle.
  const flows = d.edges.filter((e) => !e.next), outN = (id) => flows.filter((e) => e.from === id).length, inN = (id) => flows.filter((e) => e.to === id).length;
  d.edges.forEach((e, i) => els.push({ data: { id: "e" + i, source: e.from, target: e.to, label: e.next ? "↻" : e.label,
    pos: e.next ? "mid" : outN(e.from) === 1 ? "src" : inN(e.to) === 1 ? "tgt" : "mid" }, classes: e.next ? "edge next" : "edge" }));
  // Pipelines read in node order: invisible links keep the stages stacked in that order.
  if (d.kind === "pipeline") {
    const steps = d.nodes.filter((n) => !n.zone && !n.outside);
    for (let i = 1; i < steps.length; i++)
      if (!d.edges.some((e) => e.from === steps[i - 1].id && e.to === steps[i].id))
        els.push({ data: { id: "o" + i, source: steps[i - 1].id, target: steps[i].id }, classes: "order" });
  }
  return els;
}

function drawGraph() {
  const d = diagram();
  $("#empty").hidden = !!d;
  if (cy) { cy.destroy(); cy = null; }
  if (!d) return;
  const ink = css("--fg"), soft = css("--muted"), panel = css("--card"), line = css("--line"), sig = css("--hot"), data = css("--accent"), ok = css("--warn");
  cy = cytoscape({
    container: $("#cy"), elements: elements(d), wheelSensitivity: 0.2, minZoom: 0.3, maxZoom: 2.5,
    style: [
      { selector: "node", style: { shape: "round-rectangle", label: "data(label)", "font-family": "JetBrains Mono, monospace", "font-size": 13, color: ink,
        "text-wrap": "wrap", "text-max-width": 150, "text-valign": "center", "text-halign": "center", width: "label", height: "label", padding: 12,
        "background-color": panel, "border-width": 1.3, "border-color": ink } },
      { selector: "node.zone", style: { "text-valign": "top", "text-halign": "center", "text-margin-y": -6, "font-weight": 700, "border-style": "dashed",
        "border-color": soft, "background-opacity": 0.35, "background-color": line, padding: 22 } },
      { selector: "node.outside", style: { "border-width": 0, "background-opacity": 0, color: soft, "font-style": "italic" } },
      { selector: "node.focus", style: { "border-color": sig, "border-width": 2.4, "background-color": sig, "background-opacity": 0.12, "font-weight": 700 } },
      { selector: "node.total", style: { shape: "barrel", "background-color": data, "background-opacity": 0.12, "border-color": data, "border-width": 2, "font-weight": 700 } },
      { selector: "node.unc", style: { "border-style": "dashed", "border-color": ok } },
      { selector: "node.live", style: { "border-color": sig, "border-width": 3, "underlay-color": sig, "underlay-opacity": 0.25, "underlay-padding": 8 } },
      { selector: "node.picked", style: { "border-color": data, "border-width": 2.6 } },
      { selector: "edge", style: { width: 1.4, "line-color": soft, "target-arrow-color": soft, "target-arrow-shape": "triangle", "arrow-scale": 0.9,
        "curve-style": "bezier", label: "data(label)", "font-family": "JetBrains Mono, monospace", "font-size": 11.5, color: data,
        "text-background-color": panel, "text-background-opacity": 1, "text-background-padding": 2, "text-wrap": "wrap", "text-max-width": 120 } },
      { selector: "edge.order", style: { visibility: "hidden" } },
      { selector: "edge.flow", style: { "curve-style": "taxi", "taxi-direction": "downward", "taxi-turn": "70%", "taxi-turn-min-distance": 14,
      } },
      { selector: 'edge.flow[pos="src"]', style: { label: "", "source-label": "data(label)", "source-text-offset": 30 } },
      { selector: 'edge.flow[pos="tgt"]', style: { label: "", "target-label": "data(label)", "target-text-offset": 30 } },
      { selector: "edge.next", style: { "line-style": "dashed", "line-dash-pattern": [6, 4], "curve-style": "unbundled-bezier", "control-point-distances": [260], "control-point-weights": [0.5],
        color: soft, "font-size": 15, "text-background-opacity": 0 } },
      { selector: "edge.hl", style: { "line-color": data, "target-arrow-color": data, width: 2.2 } },
      { selector: ".faded", style: { opacity: 0.25 } },
    ],
  });
  if (d.kind !== "zones") cy.edges().not(".next").addClass("flow");
  cy.elements().not(".next").layout({ name: "dagre", rankDir: "TB", nodeSep: d.kind === "zones" ? 60 : 60, rankSep: d.kind === "pipeline" ? 50 : 90, edgeSep: 20, padding: 24 }).run();
  cy.fit(undefined, 30);
  const tip = $("#tip");
  cy.on("mouseover", "node", (e) => {
    const n = d.nodes.find((x) => x.id === e.target.id());
    tip.innerHTML = "<b>" + esc(n.label) + "</b><br>" + esc(n.explain);
    tip.hidden = false;
    const nb = e.target.closedNeighborhood();
    cy.elements().not(nb).not(e.target.ancestors()).not(e.target.descendants()).addClass("faded");
    e.target.connectedEdges().addClass("hl");
  });
  cy.on("mousemove", (e) => { const r = $("#cy").getBoundingClientRect(); tip.style.left = e.originalEvent.clientX - r.left + 14 + "px"; tip.style.top = e.originalEvent.clientY - r.top + 14 + "px"; });
  cy.on("mouseout", "node", () => { tip.hidden = true; cy.elements().removeClass("faded hl"); });
  cy.on("mouseover", "edge", (e) => {
    const x = d.edges[+e.target.id().slice(1)];
    if (!x) return;
    tip.innerHTML = (x.next ? "<span class=muted>used in the next step</span><br>" : "") + "<b>" + esc(x.label) + "</b>" + (x.explain ? "<br>" + esc(x.explain) : "");
    tip.hidden = false;
  });
  cy.on("mouseout", "edge", () => (tip.hidden = true));
  cy.on("tap", "node", (e) => { picked = e.target.id(); cy.nodes().removeClass("picked"); e.target.addClass("picked"); drawPanel(); });
  cy.on("tap", (e) => { if (e.target === cy) { picked = null; cy.nodes().removeClass("picked"); drawPanel(); } });
}

function drawPanel() {
  const d = diagram();
  if (!d) { $("#panel").innerHTML = ""; return; }
  const n = picked && d.nodes.find((x) => x.id === picked), lf = liveFiles();
  let h = "<div class=kicker>" + esc(d.kind) + "</div><h2>" + esc(d.question) + "</h2><p>" + esc(d.answer) + "</p>" +
    "<p class=why><span>why a picture</span> " + esc(d.why) + "</p>";
  if (n) {
    const files = filesOf(n);
    h += "<div class=node><h3>" + esc(n.label) + "</h3><p>" + esc(n.explain) + "</p>" +
      (files.some((f) => lf.has(f)) ? "<p class=agentbox>◉ an agent is editing this code now</p>" : "") +
      (files.some((f) => D.work[f]) ? "<p class=notebox>changed, not committed yet</p>" : "") +
      ((n.anchors ?? []).length ? "<h4>code</h4>" + n.anchors.map((a) => { const w = where(a); return "<a class=code href='work#" + esc(w?.go ?? "") + "'>" + esc(a) + "</a>"; }).join("") : "") +
      (() => {
        const ins = d.edges.filter((e) => e.to === n.id), outs = d.edges.filter((e) => e.from === n.id), lab = (id) => esc(d.nodes.find((x) => x.id === id)?.label ?? id);
        return (ins.length ? "<h4>gets</h4>" + ins.map((e) => "<div class=io><span class=dv>" + esc(e.label) + "</span> from " + lab(e.from) + "</div>").join("") : "") +
          (outs.length ? "<h4>gives</h4>" + outs.map((e) => "<div class=io><span class=dv>" + esc(e.label) + "</span> to " + lab(e.to) + "</div>").join("") : "");
      })() + "</div>";
  } else h += "<p class=hint>Hover a box for what it is. Click it for its code and what goes in and out.</p>";
  $("#panel").innerHTML = h;
}

function drawHead() {
  $("#live").innerHTML = D.live ? "<a href='work?turn=" + esc(D.live.id) + "' class=livepill title='" + esc(D.live.prompt) + "'>◉ agent working · " + D.live.touched.length + " edits</a>" : "";
}

window.addEventListener("hashchange", () => { const id = decodeURIComponent(location.hash.slice(1)); if (id && id !== cur) show(id); });
async function poll() {
  try {
    const r = await fetch("api/diagrams");
    if (r.ok) {
      const nd = await r.json(), s = JSON.stringify(nd);
      if (s !== stamp) {
        const same = JSON.stringify(nd.diagrams) === JSON.stringify(D.diagrams);
        D = nd; stamp = s;
        if (!D.diagrams.some((d) => d.id === cur)) cur = D.diagrams[0]?.id ?? null;
        drawHead(); drawList(); drawPanel();
        if (same && cy) { // only the live state changed: restyle, keep the view
          const lf = liveFiles(), d = diagram();
          for (const n of d.nodes) { const f = filesOf(n); cy.$id(n.id).toggleClass("live", f.some((x) => lf.has(x))).toggleClass("unc", f.some((x) => D.work[x])); }
        } else drawGraph();
      }
    }
  } catch {}
  setTimeout(poll, D.live ? 1500 : 4000);
}
drawHead(); drawList(); drawGraph(); drawPanel();
setTimeout(poll, 2000);
