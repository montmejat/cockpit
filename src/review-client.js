// Review page: timeline of agent turns, each readable top-down by layer.
// Polls the server so new turns and finished analyses appear on their own.

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const LAYERS = ["Purpose", "System", "Module", "Code"];
let turns = [], selected = null, detail = null, depth = 1, stamp = "";
try { depth = Number(localStorage.getItem("cockpit-depth")) || 1; } catch {}

const ago = (iso) => {
  const s = (Date.now() - new Date(iso)) / 1000;
  return s < 60 ? "just now" : s < 3600 ? Math.round(s / 60) + " min ago" : s < 86400 ? Math.round(s / 3600) + " h ago" : new Date(iso).toLocaleDateString();
};
const stampOf = (t) => t ? [t.id, t.status, t.touched, t.endedAt].join("|") : "";

async function poll() {
  try {
    turns = await (await fetch("api/turns")).json();
  } catch { return; }
  if (!selected && turns.length) selected = turns[0].id;
  drawList();
  const t = turns.find((x) => x.id === selected);
  if (stampOf(t) !== stamp) {
    stamp = stampOf(t);
    detail = t ? await (await fetch("api/turns/" + t.id)).json() : null;
    drawDetail();
  }
}

function drawList() {
  $("#list").innerHTML = turns.length ? turns.map((t) =>
    "<div class='turn" + (t.id === selected ? " sel" : "") + "' data-id='" + t.id + "'>" +
    "<div class=p>" + esc(t.prompt || "(empty prompt)") + "</div>" +
    "<div class=meta><span class='chip st-" + t.status + "'>" + t.status + "</span> " + ago(t.startedAt) +
    (t.files != null ? " · " + t.files + (t.files === 1 ? " file" : " files") + " <span class=add>+" + t.added + "</span> <span class=del>−" + t.removed + "</span>" : "") +
    (t.components?.length ? "<br>" + esc(t.components.join(", ")) : "") + "</div></div>").join("")
    : "<p class='muted' style='padding:14px'>No turns yet. Send a request to Claude Code in the project and it will show up here.</p>";
  document.querySelectorAll(".turn").forEach((el) => el.onclick = () => { selected = el.dataset.id; stamp = ""; poll(); });
}

function layer(i, body) {
  const name = LAYERS[i], lv = name.toLowerCase();
  return "<details class=layer data-depth='" + (i + 1) + "'" + (i + 1 <= depth ? " open" : "") + "><summary><span class='lvl " + lv + "'>" + lv + "</span>" +
    { Purpose: "What was asked and done", System: "Components and dependencies", Module: "Types and functions", Code: "The diff" }[name] +
    "</summary>" + body + "</details>";
}

function purpose(t, a) {
  // One line per decision; the reasoning is one click deeper.
  const decs = a.decisions.length ? a.decisions.map((d) =>
    "<details class=dec><summary><span class='lvl " + d.level + "'>" + d.level + "</span>" + esc(d.title) +
    "<span class='by " + d.decided_by + "'>" + d.decided_by + "</span></summary>" +
    "<div>Chose: " + esc(d.chose) + (d.over.length ? " <span class=muted>over " + esc(d.over.join("; ")) + "</span>" : "") + "</div>" +
    "<div class=muted>Because: " + esc(d.because) + "</div><div class='mono muted'>" + esc(d.area) + "</div></details>").join("") : "<p class=empty>No decisions in this turn.</p>";
  const byYou = a.decisions.filter((d) => d.decided_by === "user").length;
  return "<p>" + esc(a.summary) + "</p><h4>Decisions <span class=muted>(" + a.decisions.length + ", " + byYou + " by you)</span></h4>" + decs;
}

function depList(list, fmt) {
  return list.map((d) => {
    const kind = d.before === 0 ? "<span class=add>new</span>" : d.after === 0 ? "<span class=del>removed</span>" : "<span class=chg>" + d.before + " → " + d.after + " refs</span>";
    return "<li>" + fmt(d.from) + " → " + fmt(d.to) + " · " + kind + "</li>";
  }).join("");
}

function system(a) {
  if (!a.modules.length) {
    const rs = a.files.filter((f) => f.path.endsWith(".rs"));
    return rs.length
      ? "<p class=empty>Only tests or files outside the crates' modules changed (" + rs.map((f) => esc(f.path)).join(", ") + "), so the structure is the same.</p>"
      : "<p class=empty>No Rust code changed, so the structure is the same.</p>";
  }
  const added = a.modules.filter((m) => m.status === "added"), removed = a.modules.filter((m) => m.status === "removed");
  return "<p>Touched: " + a.components.map((c) => "<span class=chip>" + esc(c) + "</span>").join(" ") + "</p>" +
    (added.length ? "<p><span class=add>New modules:</span> " + added.map((m) => "<span class=mono>" + esc(m.id) + "</span>").join(", ") + "</p>" : "") +
    (removed.length ? "<p><span class=del>Removed modules:</span> " + removed.map((m) => "<span class=mono>" + esc(m.id) + "</span>").join(", ") + "</p>" : "") +
    "<h4>Between components</h4>" + (a.componentDeps.length ? "<ul>" + depList(a.componentDeps, (x) => "<strong>" + esc(x) + "</strong>") + "</ul>" : "<p class=empty>No change in how components depend on each other.</p>") +
    "<h4>Between modules</h4>" + (a.deps.length ? "<ul>" + depList(a.deps, (x) => "<span class=mono>" + esc(x) + "</span>") + "</ul>" : "<p class=empty>No notable change.</p>");
}

function moduleLayer(a) {
  const modFiles = new Set(a.modules.map((m) => m.file));
  const other = a.files.filter((f) => !modFiles.has(f.path));
  const sign = { added: "<span class=add>+</span>", removed: "<span class=del>−</span>", changed: "<span class=chg>~</span>" };
  const itemLi = (m) => (i) => "<li>" + sign[i.change] + " <a class=mono data-file='" + esc(m.file) + "'>" + esc(i.name) + "</a> <span class=muted>" + esc(i.kind.toLowerCase()) + " · line " + i.line + "</span></li>";
  // Long lists: first few, the rest behind a toggle. Tests get their own line.
  const items = (m) => {
    const api = m.items.filter((i) => !i.test), tests = m.items.filter((i) => i.test);
    const head = api.slice(0, 8), rest = api.slice(8);
    return (api.length ? "<ul>" + head.map(itemLi(m)).join("") + "</ul>" +
        (rest.length ? "<details><summary class=muted>" + rest.length + " more</summary><ul>" + rest.map(itemLi(m)).join("") + "</ul></details>" : "")
      : (tests.length ? "" : "<p class=empty>Changes outside any named item (imports, comments, module-level code).</p>")) +
      (tests.length ? "<details><summary class=muted>Tests: " + tests.filter((i) => i.change === "added").length + " added, " +
        tests.filter((i) => i.change === "changed").length + " changed, " + tests.filter((i) => i.change === "removed").length + " removed</summary><ul>" +
        tests.map(itemLi(m)).join("") + "</ul></details>" : "");
  };
  const mods = a.modules.map((m) =>
    "<div class=mod><strong class=mono>" + esc(m.id) + "</strong> <span class=chip" + (m.componentGuessed ? " title='New module, not on the map yet: placed by its references'" : "") + ">" +
    esc(m.component) + (m.componentGuessed ? " ?" : "") + "</span> " +
    "<span class=muted>" + (m.status === "changed" ? m.linesBefore + " → " + m.linesAfter + " lines" : m.status) + "</span>" +
    (m.role ? "<div class=muted>" + esc(m.role) + "</div>" : "") +
    items(m) +
    "</div>").join("");
  return (mods || "<p class=empty>No Rust modules changed.</p>") +
    (other.length ? "<h4>Other files</h4><ul>" + other.map((f) => "<li><a class=mono data-file='" + esc(f.path) + "'>" + esc(f.path) + "</a> <span class=add>+" + f.added + "</span> <span class=del>−" + f.removed + "</span></li>").join("") + "</ul>" : "");
}

function drawDetail() {
  const t = detail, el = $("#detail");
  if (!t) { el.innerHTML = ""; return; }
  let html = "<blockquote>" + esc(t.prompt) + "</blockquote><p class=muted>" + new Date(t.startedAt).toLocaleString() +
    (t.endedAt ? " · took " + Math.max(1, Math.round((new Date(t.endedAt) - new Date(t.startedAt)) / 1000)) + " s" : "") + "</p>";
  if (t.status === "running") {
    const files = {};
    for (const x of t.touched) files[x.file] = (files[x.file] || 0) + 1;
    html += "<p><span class='chip st-running'>agent working</span></p><h4>Files being changed</h4>" +
      (Object.keys(files).length ? "<ul class=live>" + Object.entries(files).map(([f, n]) => "<li>" + esc(f) + " <span class=muted>×" + n + "</span></li>").join("") + "</ul>" : "<p class=empty>None yet.</p>");
  } else if (t.status === "analyzing") {
    html += "<p><span class='chip st-analyzing'>analyzing</span> Indexing the code before and after, and summarizing. Usually under a minute.</p>";
  } else if (t.status === "error") {
    html += "<p class=del>Analysis failed:</p><pre class=mono>" + esc(t.error) + "</pre>";
  } else {
    const a = t.analysis;
    html += "<div class=bar><span class=muted>Depth</span>" + LAYERS.map((l, i) => "<button data-depth='" + (i + 1) + "'" + (i + 1 === depth ? " class=on" : "") + ">" + l + "</button>").join("") +
      "<span style='flex:1'></span><span class=muted>" + a.files.length + (a.files.length === 1 ? " file" : " files") + " · <span class=add>+" + a.files.reduce((s, f) => s + f.added, 0) + "</span> <span class=del>−" + a.files.reduce((s, f) => s + f.removed, 0) + "</span> · $" + a.costUsd.toFixed(4) + "</span></div>" +
      layer(0, purpose(t, a)) + layer(1, system(a)) + layer(2, moduleLayer(a)) +
      layer(3, a.patch ? "<div id=code></div>" + (a.patchTruncated ? "<p class=muted>Diff truncated.</p>" : "") : "<p class=empty>No file changes.</p>");
  }
  el.innerHTML = html;
  if (t.status === "done" && t.analysis.patch) {
    const ui = new Diff2HtmlUI($("#code"), t.analysis.patch, {
      drawFileList: true, matching: "lines", outputFormat: "line-by-line", highlight: false,
      fileContentToggle: true, colorScheme: "auto", stickyFileHeaders: false,
    });
    ui.draw();
  }
  document.querySelectorAll(".bar button[data-depth]").forEach((b) => b.onclick = () => setDepth(Number(b.dataset.depth)));
  document.querySelectorAll("a[data-file]").forEach((a) => a.onclick = () => jumpToFile(a.dataset.file));
}

function setDepth(n) {
  depth = n;
  try { localStorage.setItem("cockpit-depth", String(n)); } catch {}
  document.querySelectorAll("details.layer").forEach((d) => d.open = Number(d.dataset.depth) <= n);
  document.querySelectorAll(".bar button[data-depth]").forEach((b) => b.classList.toggle("on", Number(b.dataset.depth) === n));
}

function jumpToFile(path) {
  const code = document.querySelector("details.layer[data-depth='4']");
  if (code) code.open = true;
  for (const w of document.querySelectorAll(".d2h-file-wrapper")) {
    const name = w.querySelector(".d2h-file-name")?.textContent?.trim() ?? "";
    if (name === path || name.endsWith(" → " + path) || name.includes(path)) { w.scrollIntoView({ behavior: "smooth", block: "start" }); return; }
  }
}

// Draw from the embedded data right away, then keep polling.
if (window.INIT) {
  turns = INIT.turns; selected = INIT.selected; detail = INIT.detail;
  if (INIT.depth) depth = INIT.depth;
  stamp = stampOf(turns.find((x) => x.id === selected));
  drawList(); drawDetail();
}
setInterval(poll, 2000);
