// Description view (E6/E7): the software from three angles (entry points, flows, data),
// each linked to code. Loaded before work-client.js; uses its globals at call time only.

let DESC = INIT.desc; // { source: "repo" | "draft", description, check, problems, costUsd?, model? } or null

const KINDS = [["entry_points", "entry point"], ["flows", "flow"], ["data", "data"]];
const descItems = () => (DESC?.description ? KINDS.flatMap(([k, label]) => (DESC.description[k] ?? []).map((x) => ({ ...x, ekind: x.kind, kind: k, label }))) : []);
const descById = (id) => descItems().find((x) => x.id === id);
const anchorsOf = (x) => (x.kind === "flows" ? [...new Set(x.steps.flatMap((s) => s.anchors))] : x.anchors);

// Where an anchor lives: a module ("game/ui") or an item ("game/sim::SimState::reset").
function resolveAnchor(a) {
  const [mod, ...rest] = a.split("::");
  const m = SK.modules.find((x) => x.id === mod);
  if (!m) return null;
  if (!rest.length) return { module: m, go: "m:" + m.id };
  const i = m.items.find((i) => mod + "::" + (i.owner ? i.owner + "::" : "") + i.name === a);
  return { module: m, item: i, go: "s:" + m.file + (i ? ":" + i.line : "") };
}

// Which anchors the selected turn touched (or is touching right now).
function descHits() {
  const ch = changes(), keys = new Set(), mods = new Set();
  for (const m of ch.a?.modules ?? []) {
    mods.add(m.id);
    for (const i of m.items) if (!i.test) keys.add(m.id + "::" + i.name);
  }
  for (const id of ch.live) mods.add(id);
  const hit = (a) => {
    if (keys.has(a)) return true;
    if (!a.includes("::")) return mods.has(a);
    for (const k of keys) if (k.startsWith(a + "::")) return true; // a method of this type changed
    return ch.live.has(a.split("::")[0]);
  };
  const direct = new Set(descItems().filter((x) => anchorsOf(x).some(hit)).map((x) => x.id));
  // A flow is touched through its entry points and data too.
  const via = new Set((DESC.description.flows ?? []).filter((f) => !direct.has(f.id) && [...(f.entry_points ?? []), ...(f.data ?? [])].some((id) => direct.has(id))).map((f) => f.id));
  return { hit, direct, via, any: direct.size > 0 };
}

// Items related to the focused one: a flow with its entry points and data, or an item with the flows that use it.
function descRelated(id) {
  if (!id) return null;
  const flows = DESC.description.flows;
  const f = flows.find((x) => x.id === id);
  if (f) return new Set([f.id, ...(f.entry_points ?? []), ...(f.data ?? [])]);
  return new Set([id, ...flows.filter((x) => [...(x.entry_points ?? []), ...(x.data ?? [])].includes(id)).map((x) => x.id)]);
}
const flowsUsing = (id) => DESC.description.flows.filter((f) => [...(f.entry_points ?? []), ...(f.data ?? [])].includes(id));

function drawDesc() {
  const el = $("#desc");
  if (!DESC) {
    el.innerHTML = "<div class=dview><h2>no description yet</h2><p class=muted>Run <code>npm run describe -- &lt;project dir&gt;</code> in cockpit, then reload.</p></div>";
    return;
  }
  if (!DESC.description) {
    el.innerHTML = "<div class=dview><h2>architecture.json can't be read</h2><ul>" + DESC.problems.map((p) => "<li>" + esc(p.where) + ": " + esc(p.problem) + "</li>").join("") + "</ul></div>";
    return;
  }
  const d = DESC.description, c = DESC.check, h = descHits();
  const focus = focusId?.startsWith("d:") ? focusId.slice(2) : null, rel = descRelated(focus);
  const cls = (x) => [
    "card", x.kind,
    h.direct.has(x.id) ? "changed" : h.via.has(x.id) ? "via" : h.any ? "quiet" : "",
    focus === x.id ? "focus" : rel ? (rel.has(x.id) ? "rel" : "dim") : "",
  ].join(" ");
  const card = (x, body) => "<div class='" + cls(x) + "' data-go='d:" + esc(x.id) + "'><div class=t>" + esc(x.name) +
    (x.kind === "entry_points" ? " <span class=badge>" + esc(x.ekind) + "</span>" : "") +
    (x.kind === "data" && x.persisted ? " <span class=badge>saved</span>" : "") + "</div>" + body + "</div>";
  const items = descItems(), of = (k) => items.filter((x) => x.kind === k);
  el.innerHTML = "<div class=dview>" +
    "<p class=summary>" + esc(d.summary) + "</p>" +
    "<div class=cols>" +
    "<section><h5>entry points <span class=muted>· how it's driven</span></h5>" + of("entry_points").map((x) => card(x, "<div class=dsc>" + esc(x.description) + "</div>")).join("") + "</section>" +
    "<section class=wide><h5>flows <span class=muted>· what happens at run time</span></h5>" + of("flows").map((x) => card(x,
      "<div class=trig>" + esc(x.trigger) + "</div><ol>" + x.steps.map((s) => "<li" + (s.anchors.some(h.hit) ? " class=hit" : "") + ">" + esc(s.text) + "</li>").join("") + "</ol>")).join("") + "</section>" +
    "<section><h5>data <span class=muted>· what it holds</span></h5>" + of("data").map((x) => card(x, "<div class=dsc>" + esc(x.description) + "</div>")).join("") + "</section>" +
    "</div>" +
    (DESC.source === "repo"
      ? "<p class='muted foot'>kept by the agents working on the code, in <a data-go='s:architecture.json'>architecture.json</a> · " +
        (DESC.problems.length ? "<span class=del>" + DESC.problems.length + " problem" + (DESC.problems.length > 1 ? "s" : "") + "</span>: " + DESC.problems.slice(0, 3).map((p) => esc(p.where + ": " + p.problem)).join("; ") : "matches the code") +
        " · " + c.anchors + " code links"
      : "<p class='muted foot'>one-shot draft by " + esc(DESC.model) + " for $" + DESC.costUsd.toFixed(3) + " · " + c.anchors + " code links, " +
        (c.unknown.length ? c.unknown.length + " pointed at nothing and were dropped" : "all real")) +
    " · reaches " + c.coverage.modulesLinked + "/" + c.coverage.modules + " modules, " + c.coverage.itemsLinked + "/" + c.coverage.items + " top-level items" +
    (c.coverage.unlinkedModules.length ? " · not described: " + c.coverage.unlinkedModules.map(esc).join(", ") : "") + "</p></div>";
  wireGo(el);
  el.querySelector(".card.focus")?.scrollIntoView({ block: "nearest" });
}

function descPanel(id) {
  const x = descById(id);
  if (!x) return "<p class=empty>Not in the description.</p>";
  const h = descHits(), d = DESC.description;
  const chip = (a) => {
    const r = resolveAnchor(a), hit = h.hit(a);
    return "<a class='anchor" + (hit ? " hit" : "") + "' data-go='" + esc(r?.go ?? "") + "'>" + esc(a) + "</a>" +
      (hit && r && changes().files.has(r.module.file) ? " <a class=difflink data-go='f:" + esc(r.module.file) + "'>diff</a>" : "");
  };
  const link = (k, ids) => ids.length ? "<h4>" + k + "</h4><ul>" + ids.map((i) => { const y = descById(i); return "<li><a data-go='d:" + esc(i) + "'>" + esc(y?.name ?? i) + "</a>" + (h.direct.has(i) ? " <span class=chg>changed</span>" : "") + "</li>"; }).join("") + "</ul>" : "";
  let html = "<div class=muted>" + x.label + (x.kind === "data" && x.persisted ? " · saved or sent outside" : "") + (x.kind === "entry_points" ? " · " + esc(x.ekind) : "") + "</div>" +
    "<h2>" + esc(x.name) + "</h2>" +
    (h.direct.has(id) ? "<p class=chg>changed in this turn</p>" : h.via.has(id) ? "<p class=chg>touched in this turn through what it uses</p>" : "") +
    "<p>" + esc(x.description) + "</p>";
  if (x.kind === "flows") {
    html += (view === "map" ? "<p class=muted>Drawn on the map: numbers are steps, ▶ entry points, ◆ data.</p>" : "") +
      link("starts from", x.entry_points ?? []) + link("data", x.data ?? []) +
      "<h4>trigger</h4><p>" + esc(x.trigger) + "</p><h4>steps</h4><ol class=steps>" +
      x.steps.map((s) => "<li" + (s.anchors.some(h.hit) ? " class=hit" : "") + ">" + esc(s.text) + "<div>" + s.anchors.map(chip).join(" ") + "</div></li>").join("") + "</ol>";
  } else html += "<h4>code</h4><div>" + x.anchors.map(chip).join(" ") + "</div>";
  if (x.kind !== "flows") html += link(x.kind === "entry_points" ? "starts" : "used by", flowsUsing(id).map((f) => f.id));
  return html;
}
