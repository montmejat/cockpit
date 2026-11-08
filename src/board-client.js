// The board (E8): features as tiles sized by their code, a timeline of how they grew,
// and what the agent is touching right now. Plain browser JS, inlined by serve.ts.

let B = INIT.board, stamp = JSON.stringify(B);
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const store = { get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };

let mode = store.get("board-mode", "status"); // status | activity | tests
let sel = decodeURIComponent(location.hash.slice(1)) || null; // a feature id
let at = null; // commit index shown, null = now
let hoverCol = null, playing = null;

// ---- derived data -------------------------------------------------------

const modById = () => new Map(B.modules.map((m) => [m.id, m]));
const built = () => B.features.filter((f) => f.status !== "planned" && f.modules.length);
const filesOf = (f) => { const mm = modById(); return [...new Set(f.modules.map((id) => mm.get(id)?.file).filter(Boolean))]; };
// A module serving several features counts for each of them in equal parts.
function shares() {
  const n = new Map();
  for (const f of built()) for (const m of f.modules) n.set(m, (n.get(m) || 0) + 1);
  return n;
}
// Lines of each file after commit k (k = null: the code as it is now).
function linesAt(k) {
  const out = new Map();
  if (k === null) { for (const m of B.modules) out.set(m.file, m.lines); return out; }
  for (let i = 0; i <= k; i++) for (const [p, d] of Object.entries(B.commits[i].net)) out.set(p, (out.get(p) || 0) + d);
  return out;
}
function sizeAt(f, k, lines = linesAt(k), sh = shares()) {
  const mm = modById();
  return f.modules.reduce((s, id) => s + Math.max(0, lines.get(mm.get(id)?.file) || 0) / (sh.get(id) || 1), 0);
}
const fullLines = (f, lines) => filesOf(f).reduce((s, p) => s + Math.max(0, lines.get(p) || 0), 0);
const testsOf = (f) => { const mm = modById(); return f.modules.reduce((s, id) => s + (mm.get(id)?.tests || 0), 0); };
// Lines changed in a feature's files by commit i (i = commits.length: not committed yet).
function churn(f, i) {
  const ch = i === B.commits.length ? B.work : B.commits[i].files;
  return filesOf(f).reduce((s, p) => s + (ch[p] || 0), 0);
}
const otherChurn = (i) => {
  const mine = new Set(B.modules.map((m) => m.file)), ch = i === B.commits.length ? B.work : B.commits[i].files;
  return Object.entries(ch).reduce((s, [p, n]) => s + (mine.has(p) ? 0 : n), 0);
};
const liveFiles = () => new Set((B.live?.touched ?? []).map((t) => t.file));
const liveOn = (f) => { const lf = liveFiles(); return filesOf(f).filter((p) => lf.has(p)); };
const uncommitted = (f) => filesOf(f).filter((p) => B.work[p]);
// Commits since the last change: 0 = the shown commit touched it.
function lastTouch(f, k) {
  const end = k ?? B.commits.length - 1;
  for (let i = end; i >= 0; i--) if (churn(f, i)) return end - i;
  return null;
}

// ---- colors -------------------------------------------------------------

const STATUS = { working: "var(--ok)", partial: "var(--warn)", broken: "var(--bad)", planned: "var(--muted)" };
const heat = (t) => `color-mix(in oklab, var(--hot) ${Math.round(t * 100)}%, var(--cold))`;
function colorOf(f, k) {
  if (mode === "status") return STATUS[f.status];
  if (mode === "tests") {
    const lines = fullLines(f, linesAt(null)) || 1, per100 = (testsOf(f) / lines) * 100;
    return `color-mix(in oklab, var(--ok) ${Math.round(Math.min(1, per100 / 2) * 100)}%, var(--bad))`;
  }
  // activity: lines changed in the last three commits up to the shown one, recent counting more
  const end = k ?? B.commits.length;
  let s = 0;
  for (let i = end, w = 1; i >= 0 && w > 0.2; i--, w -= 0.3) if (i <= B.commits.length) s += w * churn(f, i);
  const max = Math.max(1, ...built().map((g) => { let t = 0; for (let i = end, w = 1; i >= 0 && w > 0.2; i--, w -= 0.3) if (i <= B.commits.length) t += w * churn(g, i); return t; }));
  return heat(Math.sqrt(s / max));
}

// ---- treemap ------------------------------------------------------------

// Squarified treemap: rows of tiles kept as close to square as possible.
function squarify(items, x, y, w, h) {
  const total = items.reduce((s, i) => s + i.v, 0), out = [];
  if (!total) return out;
  let rest = items.map((i) => ({ ...i, a: (i.v * w * h) / total })), row = [];
  const worst = (r, side) => {
    const s = r.reduce((a, n) => a + n.a, 0), mx = Math.max(...r.map((n) => n.a)), mn = Math.min(...r.map((n) => n.a));
    return Math.max((side * side * mx) / (s * s), (s * s) / (side * side * mn));
  };
  const flush = () => {
    const s = row.reduce((a, n) => a + n.a, 0);
    if (w >= h) { const cw = s / h; let yy = y; for (const n of row) { const hh = n.a / cw; out.push({ ...n, x, y: yy, w: cw, h: hh }); yy += hh; } x += cw; w -= cw; }
    else { const rh = s / w; let xx = x; for (const n of row) { const ww = n.a / rh; out.push({ ...n, x: xx, y, w: ww, h: rh }); xx += ww; } y += rh; h -= rh; }
    row = [];
  };
  while (rest.length) {
    const side = Math.min(w, h), n = rest[0];
    if (!row.length || worst([...row, n], side) <= worst(row, side)) { row.push(n); rest.shift(); } else flush();
  }
  if (row.length) flush();
  return out;
}

function drawMap() {
  const el = $("#tiles"), W = el.clientWidth, H = el.clientHeight;
  const lines = linesAt(at), sh = shares(), now = linesAt(null);
  // Order by today's size, so tiles keep their place while you move through time.
  const feats = built().sort((a, b) => sizeAt(b, null, now, sh) - sizeAt(a, null, now, sh));
  const rects = new Map(squarify(feats.map((f) => ({ f, v: sizeAt(f, at, lines, sh) })).filter((x) => x.v > 0), 0, 0, W, H).map((r) => [r.f.id, r]));
  const touched = hoverCol !== null ? new Set(feats.filter((f) => churn(f, hoverCol)).map((f) => f.id)) : null;
  for (const f of feats) {
    let t = el.querySelector(`[data-id="${CSS.escape(f.id)}"]`);
    if (!t) { t = document.createElement("div"); t.className = "tile"; t.dataset.id = f.id; t.onclick = () => select(f.id); el.append(t); }
    const r = rects.get(f.id), G = 3;
    if (!r) { t.classList.add("gone"); continue; }
    t.classList.remove("gone");
    Object.assign(t.style, { left: r.x + G + "px", top: r.y + G + "px", width: Math.max(0, r.w - 2 * G) + "px", height: Math.max(0, r.h - 2 * G) + "px" });
    t.style.setProperty("--c", colorOf(f, at));
    const big = r.w > 170 && r.h > 90, mid = r.w > 110 && r.h > 54;
    const lv = at === null ? liveOn(f) : [], unc = at === null ? uncommitted(f) : [];
    const lt = lastTouch(f, at), tests = testsOf(f), ln = fullLines(f, lines);
    t.classList.toggle("live", lv.length > 0);
    t.classList.toggle("sel", sel === f.id);
    t.classList.toggle("dim", (touched && !touched.has(f.id)) || (!!sel && sel !== f.id && !touched));
    t.classList.toggle("hot", !!touched?.has(f.id));
    t.title = f.name + " · " + f.description;
    t.innerHTML =
      "<div class=nm>" + esc(f.name) + (f.status !== "working" ? " <span class=st>" + esc(f.status) + "</span>" : "") + "</div>" +
      (mid ? "<div class=meta><b>" + ln.toLocaleString() + "</b> lines · " + (tests ? "<b>" + tests + "</b> tests" : "<span class=warn>no tests</span>") + "</div>" : "") +
      (big && f.note ? "<div class=note>" + esc(f.note) + "</div>" : "") +
      (lv.length ? "<div class=agent>◉ agent on " + esc(lv.map((p) => p.split("/").pop()).join(", ")) + "</div>"
        : unc.length && mid ? "<div class=unc>● " + unc.length + " uncommitted</div>"
        : big && lt === 0 ? "<div class=fresh>changed in " + (at === null ? "the last commit" : "this commit") + "</div>" : "") +
      (mid ? spark(f) : "") + inner(f, r, lines, big);
  }
  // Features that no longer exist in architecture.json.
  for (const t of el.querySelectorAll(".tile")) if (!feats.some((f) => f.id === t.dataset.id)) t.remove();
  $("#empty").hidden = rects.size > 0;
}

// Inside a big tile: its modules, as a smaller treemap of their own.
function inner(f, r, lines, big) {
  const top = f.note ? 92 : 58, w = r.w - 28, h = r.h - top - 34;
  if (!big || w < 80 || h < 40 || f.modules.length < 1) return "";
  const mm = modById(), lv = liveFiles();
  const mods = f.modules.map((id) => mm.get(id)).filter(Boolean).map((m) => ({ m, v: Math.max(0, lines.get(m.file) || 0) })).filter((x) => x.v).sort((a, b) => b.v - a.v);
  return "<div class=inner style='top:" + top + "px;height:" + h + "px'>" + squarify(mods, 0, 0, w, h).map((x) =>
    "<a class='mod" + (lv.has(x.m.file) ? " live" : "") + (at === null && B.work[x.m.file] ? " unc" : "") + "' href='work#m:" + esc(x.m.id) + "' onclick='event.stopPropagation()' title='" + esc(x.m.file + " · " + x.v + " lines" + (x.m.tests ? " · " + x.m.tests + " tests" : "")) + "' style='left:" + (x.x + 1) + "px;top:" + (x.y + 1) + "px;width:" + Math.max(0, x.w - 2) + "px;height:" + Math.max(0, x.h - 2) + "px'>" +
    (x.w > 60 && x.h > 18 ? esc(x.m.file.split("/").pop()) : "") + "</a>").join("") + "</div>";
}

// Lines changed per commit, as tiny bars along the bottom of a tile.
function spark(f) {
  const n = B.commits.length, vals = Array.from({ length: n + 1 }, (_, i) => churn(f, i));
  const mx = Math.max(1, ...vals), end = at ?? n;
  return "<div class=spark>" + vals.map((v, i) => "<i style='height:" + (v ? 2 + (v / mx) * 16 : 0) + "px'" + (i > end ? " class=future" : i === n ? " class=now" : "") + "></i>").join("") + "</div>";
}

function drawPlanned() {
  const p = B.features.filter((f) => f.status === "planned" || !f.modules.length);
  $("#planned").innerHTML = p.length ? "<span class=lbl>planned</span>" + p.map((f) =>
    "<button class='chip-p" + (sel === f.id ? " sel" : "") + "' data-f='" + esc(f.id) + "' title='" + esc(f.description) + "'>" + esc(f.name) + "</button>").join("") : "";
  for (const b of $("#planned").querySelectorAll("[data-f]")) b.onclick = () => select(b.dataset.f);
}

// ---- timeline -----------------------------------------------------------

function drawTimeline() {
  const n = B.commits.length, cols = n + 1, feats = built().sort((a, b) => fullLines(b, linesAt(null)) - fullLines(a, linesAt(null)));
  const lanes = [...feats.map((f) => ({ f, name: f.name, v: (i) => churn(f, i), c: colorOf(f, null) })),
    { f: null, name: "docs, tests & config", v: otherChurn, c: "var(--muted)" }];
  const mx = Math.max(1, ...lanes.flatMap((l) => Array.from({ length: cols }, (_, i) => l.v(i))));
  const cur = at ?? n;
  const head = Array.from({ length: cols }, (_, i) => {
    const c = B.commits[i], isNow = i === n;
    return "<div class='ch" + (i === cur ? " cur" : "") + (isNow && B.live ? " livecol" : "") + "' data-col=" + i + " title='" +
      esc(isNow ? (B.live ? "agent working: " + B.live.prompt : "not committed yet") : c.sha + " · " + c.subject + (c.turn ? "\n\nagent turn: " + c.turn.prompt : "")) + "'>" +
      (isNow ? (B.live ? "◉" : "now") : (c.turn ? "<span class=bot>◆</span>" : "") + c.sha.slice(0, 4)) + "</div>";
  }).join("");
  const rows = lanes.map((l) =>
    "<div class='ln" + (l.f && sel === l.f.id ? " sel" : "") + "'" + (l.f ? " data-f='" + esc(l.f.id) + "'" : "") + "><span class=lname>" + esc(l.name) + "</span>" +
    Array.from({ length: cols }, (_, i) => {
      const v = l.v(i), d = v ? 6 + Math.sqrt(v / mx) * 18 : 0;
      return "<span class='cell" + (i === cur ? " cur" : "") + (i > cur ? " future" : "") + "' data-col=" + i + ">" +
        (v ? "<i style='width:" + d + "px;height:" + d + "px;background:" + l.c + "' title='" + v + " lines changed'></i>" : "") + "</span>";
    }).join("") + "</div>").join("");
  const el = $("#timeline");
  el.style.setProperty("--cols", cols);
  el.innerHTML = "<div class=ln><span class=lname><button id=play title='Replay how the project grew'>" + (playing ? "❚❚" : "▶") + "</button></span>" + head + "</div>" + rows;
  for (const c of el.querySelectorAll("[data-col]")) {
    const i = +c.dataset.col;
    c.onmouseenter = () => { hoverCol = i; drawMap(); showCol(i); };
    c.onmouseleave = () => { hoverCol = null; drawMap(); showCol(null); };
    c.onclick = () => { stop(); setAt(i === n ? null : i); };
  }
  for (const r of el.querySelectorAll(".ln[data-f]")) r.querySelector(".lname").onclick = () => select(r.dataset.f);
  $("#play").onclick = () => (playing ? stop() : play());
}

function showCol(i) {
  const el = $("#colinfo"), n = B.commits.length;
  if (i === null) i = at ?? n;
  const c = B.commits[i];
  el.innerHTML = i === n
    ? (B.live ? "<span class=livepill>◉ agent working</span> " + esc(B.live.prompt.slice(0, 140)) : "<b>now</b> · " + (Object.keys(B.work).length ? Object.keys(B.work).length + " files not committed" : "everything committed"))
    : "<b>" + esc(c.sha) + "</b> " + esc(c.subject) + " <span class=muted>· " + new Date(c.date).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) + "</span>" +
      (c.turn ? " <span class=bot>◆ agent turn</span>" : "");
}

function setAt(k) {
  at = k;
  $("#when").textContent = at === null ? "now" : "as of " + B.commits[at].sha + " (" + (at + 1) + "/" + B.commits.length + ")";
  drawAll();
}
function play() {
  let i = 0;
  setAt(0);
  playing = setInterval(() => { i++; if (i >= B.commits.length) { stop(); setAt(null); } else setAt(i); }, 900);
  drawTimeline();
}
function stop() { if (playing) { clearInterval(playing); playing = null; drawTimeline(); } }

// ---- side panel ---------------------------------------------------------

function select(id) {
  sel = sel === id ? null : id;
  history.replaceState(null, "", location.pathname + location.search + (sel ? "#" + encodeURIComponent(sel) : ""));
  drawAll();
}

function overview() {
  const now = linesAt(null), feats = B.features, b = built();
  const total = B.modules.reduce((s, m) => s + m.lines, 0), tests = B.modules.reduce((s, m) => s + m.tests, 0);
  const byStatus = ["working", "partial", "broken"].map((s) => ({ s, v: b.filter((f) => f.status === s).reduce((t, f) => t + sizeAt(f, null, now), 0) }));
  const sum = byStatus.reduce((t, x) => t + x.v, 0) || 1;
  const attention = feats.filter((f) => f.status === "partial" || f.status === "broken");
  const untested = b.filter((f) => f.status === "working" && !testsOf(f));
  const turns = B.commits.filter((c) => c.turn).length;
  return "<div class=kicker>" + esc(B.project) + "</div><p class='sum clamp' onclick='this.classList.toggle(\"clamp\")' title='click to read it all'>" + esc(B.summary) + "</p>" +
    "<div class=stats>" +
    stat(total.toLocaleString(), "lines") + stat(tests, "unit tests") +
    stat(b.filter((f) => f.status === "working").length + "<small>/" + feats.length + "</small>", "features working") +
    stat(B.commits.length + (turns ? "<small> · " + turns + "◆</small>" : ""), "commits · by agents") + "</div>" +
    "<div class=bar>" + byStatus.filter((x) => x.v).map((x) => "<i style='flex:" + x.v + ";background:" + STATUS[x.s] + "' title='" + x.s + ": " + Math.round((x.v / sum) * 100) + "% of the code'></i>").join("") + "</div>" +
    "<div class=legend>" + byStatus.filter((x) => x.v).map((x) => "<span><i style='background:" + STATUS[x.s] + "'></i>" + x.s + " " + Math.round((x.v / sum) * 100) + "%</span>").join("") + "</div>" +
    (attention.length || untested.length ? "<h4>needs a look</h4>" : "") +
    attention.map((f) => "<a class=att data-f='" + esc(f.id) + "'><span class=dot style='background:" + STATUS[f.status] + "'></span><span><b>" + esc(f.name) + "</b><br><span class=why2>" + esc(f.note || f.status) + "</span></span></a>").join("") +
    (untested.length ? "<div class=att><span class=dot style='background:var(--bad)'></span><span><b>no unit tests</b><br>" + untested.map((f) => "<a data-f='" + esc(f.id) + "'>" + esc(f.name) + "</a>").join(", ") + "</span></div>" : "") +
    (B.live ? "<h4>agent at work</h4><a class=att href='work?turn=" + esc(B.live.id) + "'><span class='dot pulse'></span>" + esc(B.live.prompt.slice(0, 120)) + "<span class=why>" + B.live.touched.length + " edits so far</span></a>" : "") +
    "<p class=hint>Tiles are features, sized by their code. Click one to open it; hover the timeline to see what each commit touched; ▶ replays how it grew.</p>";
}
const stat = (v, l) => "<div class=stat><b>" + v + "</b><span>" + l + "</span></div>";

function featurePanel(f) {
  const mm = modById(), now = linesAt(null), lv = liveOn(f), unc = uncommitted(f);
  const mods = f.modules.map((id) => mm.get(id)).filter(Boolean).sort((a, b) => b.lines - a.lines);
  const mx = Math.max(1, ...mods.map((m) => m.lines)), sh = shares();
  const hist = B.commits.map((c, i) => ({ c, v: churn(f, i) })).filter((x) => x.v).reverse();
  const flowName = new Map(B.flows.map((x) => [x.id, x.name]));
  return "<a class=back data-f=''>← overview</a>" +
    "<div class=kicker><span class=dot style='background:" + STATUS[f.status] + "'></span>" + esc(f.status) + "</div>" +
    "<h2>" + esc(f.name) + "</h2><p>" + esc(f.description) + "</p>" +
    (f.note ? "<p class=notebox>" + esc(f.note) + "</p>" : "") +
    (lv.length ? "<p class=agentbox>◉ the agent is editing " + lv.map(esc).join(", ") + "</p>" : "") +
    (mods.length ? "<div class=stats>" + stat(fullLines(f, now).toLocaleString(), "lines") + stat(testsOf(f), "unit tests") + stat(mods.length, mods.length > 1 ? "modules" : "module") + "</div>" +
      "<h4>code</h4>" + mods.map((m) => "<a class=modrow href='work#m:" + esc(m.id) + "' title='" + esc(m.file) + "'><span class=mn>" + esc(m.id) + (sh.get(m.id) > 1 ? " <span class=shared title='also serves other features'>shared</span>" : "") +
        (unc.includes(m.file) ? " <span class=uncd>●</span>" : "") + "</span><span class=mbar><i style='width:" + (m.lines / mx) * 100 + "%'></i></span><span class=mv>" + m.lines + (m.tests ? " · " + m.tests + "t" : "") + "</span></a>").join("") : "<p class=muted>Not started: no code yet.</p>") +
    ((f.flows ?? []).length ? "<h4>how it runs</h4><div class=chips>" + f.flows.map((id) => "<a class=flowchip href='work?view=map&tab=flows#d:" + esc(id) + "'>⇢ " + esc(flowName.get(id) ?? id) + "</a>").join("") + "</div>" : "") +
    (hist.length ? "<h4>history</h4>" + hist.map(({ c, v }) => "<a class=hrow href='work?tab=git#k:" + esc(c.sha) + "'><span class=sha>" + esc(c.sha) + "</span><span class=hs>" + (c.turn ? "<span class=bot>◆</span> " : "") + esc(c.subject) + "</span><span class=mv>±" + v + "</span></a>").join("") : "");
}

function drawPanel() {
  const f = B.features.find((x) => x.id === sel);
  $("#panel").innerHTML = f ? featurePanel(f) : overview();
  for (const a of $("#panel").querySelectorAll("[data-f]")) a.onclick = () => select(a.dataset.f || sel);
}

// ---- header and wiring --------------------------------------------------

function drawHead() {
  $("#live").innerHTML = B.live ? "<a href='work?turn=" + esc(B.live.id) + "' class=livepill title='" + esc(B.live.prompt) + "'>◉ agent working · " + B.live.touched.length + " edits</a>" : "";
  for (const b of document.querySelectorAll("[data-mode]")) b.classList.toggle("on", b.dataset.mode === mode);
  $("#legend").innerHTML = mode === "status" ? ["working", "partial", "broken"].map((s) => "<span><i style='background:" + STATUS[s] + "'></i>" + s + "</span>").join("")
    : mode === "tests" ? "<span><i style='background:var(--bad)'></i>no tests</span><span class=grad style='--a:var(--bad);--b:var(--ok)'></span><span><i style='background:var(--ok)'></i>2+ per 100 lines</span>"
    : "<span><i style='background:var(--cold)'></i>quiet</span><span class=grad style='--a:var(--cold);--b:var(--hot)'></span><span><i style='background:var(--hot)'></i>changed a lot lately</span>";
}

// Map last: its size depends on how tall the planned chips and the timeline are.
function drawAll() { drawHead(); drawPlanned(); drawTimeline(); drawPanel(); showCol(null); drawMap(); }

for (const b of document.querySelectorAll("[data-mode]")) b.onclick = () => { mode = b.dataset.mode; store.set("board-mode", mode); drawAll(); };
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && sel) select(sel);
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    stop();
    const n = B.commits.length, cur = at ?? n, next = Math.max(0, Math.min(n, cur + (e.key === "ArrowLeft" ? -1 : 1)));
    setAt(next === n ? null : next);
  }
});
new ResizeObserver(() => drawMap()).observe($("#tiles"));

// Live: the agent's edits and new commits show up without a reload.
async function poll() {
  try {
    const r = await fetch("api/board");
    if (r.ok) { const nb = await r.json(), s = JSON.stringify(nb); if (s !== stamp) { B = nb; stamp = s; drawAll(); } }
  } catch {}
  setTimeout(poll, B.live ? 1500 : 4000);
}
drawAll();
setTimeout(poll, 2000);
