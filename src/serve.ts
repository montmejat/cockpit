// One server, one page: files and git on the left,
// tabs in the center (diagrams, files, commits), and what an agent is changing right now projected onto all of it.
//   npm run serve -- <project dir> [--port 4173] [--host 127.0.0.1]
// --host 0.0.0.0 makes it reachable from other machines on the network (no login).

import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { ARCH_DIR, checkArch, loadArch } from "./arch.ts";
import { itemKey } from "./describe.ts";
import { createMapApp } from "./mapapp.ts";
import { COCKPIT, listTurns } from "./turns.ts";

const args = process.argv.slice(2);
const opt = (n: string) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : undefined);
const dir = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
if (!dir) {
  console.error("usage: npm run serve -- <project dir> [--port 4173] [--host 127.0.0.1]");
  process.exit(1);
}
const root = resolve(dir);
const name = opt("name") ?? basename(root);
const map = createMapApp(root, name); // the code index (rust-analyzer), rebuilt when code changes

const tryGit = (...a: string[]) => {
  try { return execFileSync("git", a, { cwd: root, encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "ignore"] }).trimEnd(); } catch (e: any) { return String(e.stdout ?? "").trimEnd(); }
};

// ---- files ---------------------------------------------------------------

const listFiles = () => tryGit("ls-files", "--cached", "--others", "--exclude-standard").split("\n").filter(Boolean).sort();
function readSource(path: string) {
  const full = resolve(root, path);
  if (!full.startsWith(root + sep) || !listFiles().includes(path)) throw new Error("not a project file");
  if (statSync(full).size > 1 << 20) return { path, text: null, note: "file larger than 1 MB" };
  const text = readFileSync(full, "utf8");
  return text.includes("\u0000") ? { path, text: null, note: "binary file" } : { path, text };
}

// ---- git -----------------------------------------------------------------

function gitStatus() {
  // Porcelain v1: XY path, X = staged, Y = unstaged; "??" = untracked.
  return tryGit("status", "--porcelain=v1", "-z", "--untracked-files=all").split("\0").filter(Boolean).flatMap((e, i, arr) => {
    if (i > 0 && /^R|^C/.test(arr[i - 1] ?? "") && !/^.. /.test(e)) return []; // rename source, already used
    return [{ x: e[0], y: e[1], path: e.slice(3) }];
  });
}
function gitHead() {
  const branch = tryGit("symbolic-ref", "--short", "-q", "HEAD") || null;
  const upstream = tryGit("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}") || null;
  const [behind, ahead] = upstream ? tryGit("rev-list", "--left-right", "--count", "@{u}...HEAD").split(/\s+/).map(Number) : [0, 0];
  return { branch, head: tryGit("rev-parse", "--short", "HEAD"), upstream, ahead, behind };
}
// Commits of all branches, newest first, with parents: the page draws the graph.
function gitGraph() {
  return tryGit("log", "--branches", "--remotes", "--tags", "--topo-order", "-n", "200", "--format=%H%x1f%P%x1f%h%x1f%s%x1f%an%x1f%aI%x1f%D")
    .split("\n").filter(Boolean).map((l) => {
      const [hash, parents, sha, subject, author, date, refs] = l.split("\x1f");
      return { hash, parents: parents ? parents.split(" ") : [], sha, subject, author, date, refs: refs ? refs.split(", ").filter((r) => !r.startsWith("refs/cockpit")) : [] };
    });
}
function workingDiff(path: string) {
  const st = gitStatus().find((f) => f.path === path);
  if (!st) return "";
  if (st.x === "?") return tryGit("diff", "--no-index", "--", "/dev/null", path);
  return tryGit("diff", "HEAD", "--", path);
}
function commitPatch(sha: string) {
  const [meta, ...rest] = tryGit("show", "--format=%H%x1f%s%x1f%an%x1f%aI%x1f%b%x1e", "--patch", sha).split("\x1e");
  const [full, subject, author, date, body] = meta.split("\x1f");
  return { sha: full, subject, author, date, body: (body ?? "").trim(), patch: rest.join("\x1e").replace(/^\n+/, "") };
}

// ---- what is changing ----------------------------------------------------

// Lines changed but not committed, per file (new-file line numbers), from the working diff.
function changedLines(): Record<string, [number, number][]> {
  const out: Record<string, [number, number][]> = {};
  let file = "";
  for (const l of tryGit("diff", "HEAD", "-U0", "--no-color").split("\n")) {
    if (l.startsWith("+++ ")) file = l.startsWith("+++ b/") ? l.slice(6) : "";
    const m = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (m && file) {
      const start = +m[1], n = m[2] === undefined ? 1 : +m[2];
      (out[file] ??= []).push([start, start + Math.max(n, 1) - 1]); // n = 0: lines removed just after start
    }
  }
  for (const s of gitStatus()) if (s.x === "?") out[s.path] = [[1, 1e9]];
  return out;
}

// The running agent turn, if any, and the files it touched so far.
function liveTurn() {
  const t = listTurns(name).find((x) => x.status === "running");
  return t ? {
    id: t.id, prompt: t.prompt, startedAt: t.startedAt,
    touched: [...new Set(t.touched.map((x) => (x.file.startsWith(root) ? x.file.slice(root.length + 1) : x.file)))],
  } : null;
}

// Where you placed the boxes of each diagram: { diagramId: { nodeId: {x, y} } }. Kept in the
// project, so the arrangement travels with the repo.
const dlayoutPath = join(root, ARCH_DIR, "layout.json");
const readDLayout = () => (existsSync(dlayoutPath) ? JSON.parse(readFileSync(dlayoutPath, "utf8")) : {});

// What is tested: #[test] functions inside each module, and in the integration test files
// (tests/*.rs), by name.
function testsOf(sk: ReturnType<typeof map.data>["skeleton"]) {
  const unit = sk.modules.map((m) => ({ module: m.id, file: m.file, crate: m.crate, tests: m.items.filter((i) => i.test && i.kind === "Function").map((i) => ({ name: i.name, line: i.line })) }));
  const integration = listFiles().filter((f) => /(^|\/)tests\/.*\.rs$/.test(f)).map((file) => {
    const text = readFileSync(join(root, file), "utf8"), tests: { name: string; line: number }[] = [];
    const re = /#\[test\]\s*(?:#\[[^\]]*\]\s*)*(?:pub\s+)?fn\s+(\w+)/g;
    for (let m; (m = re.exec(text)); ) tests.push({ name: m[1], line: text.slice(0, m.index).split("\n").length });
    return { file, tests };
  });
  return { unit, integration };
}

// Everything the page needs, in one poll.
function state() {
  map.rebuild(); // cheap unless code changed
  const sk = map.data().skeleton;
  const loaded = loadArch(root), arch = loaded.arch;
  const lines = changedLines();
  // Items whose lines changed: lets a diagram box light up only when its own function changed.
  const changedItems: string[] = [];
  for (const m of sk.modules) {
    const ranges = lines[m.file];
    if (ranges) for (const i of m.items) if (!i.test && ranges.some(([a, b]) => a <= (i.end ?? i.line) && b >= i.line)) changedItems.push(itemKey(m.id, i));
  }
  const status = gitStatus();
  const feats = arch?.features ?? [];
  return {
    project: name,
    diagrams: arch?.diagrams ?? [],
    problems: checkArch(loaded, sk),
    modules: sk.modules.map((m) => ({ id: m.id, file: m.file, items: m.items.filter((i) => !i.test).map((i) => ({ key: itemKey(m.id, i), line: i.line, end: i.end })) })),
    layout: readDLayout(),
    live: liveTurn(),
    status, changedFiles: Object.keys(lines), changedItems,
    git: gitHead(),
    lines: sk.modules.reduce((s, m) => s + m.lines, 0),
    features: feats,
    tests: testsOf(sk),
    summary: arch?.summary ?? "",
  };
}

// ---- page ----------------------------------------------------------------

const page = () => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${name} · cockpit</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&display=swap">
<script src="https://cdnjs.cloudflare.com/ajax/libs/cytoscape/3.30.2/cytoscape.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/dagre/0.8.5/dagre.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/cytoscape-dagre@2.5.0/cytoscape-dagre.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
<style>${readFileSync(join(COCKPIT, "src", "app.css"), "utf8")}</style></head><body>
<header>
  <h1>${name}</h1>
  <a id="gitpill" class="pill" data-tab="git"></a>
  <span id="metrics" class="muted"></span>
  <span class="grow"></span>
  <span id="live"></span>
</header>
<main>
  <nav id="side">
    <div class="tabs"><button data-tab="diagrams" title="Diagrams drawn by the agents to explain the code">overview</button><button data-tab="files">files</button><button data-tab="git">git</button></div>
    <div id="sidebody"></div>
  </nav>
  <section id="center"><div id="tabbar"></div>
  <section id="canvas">
    <section class="pane" id="pane-main"><div class="ptitle"></div><div class="cyc"></div><div class="legend"></div></section>
    <section class="pane" id="pane-side" hidden><div class="ptitle"></div><div class="cyc"></div><div class="legend"></div></section>
    <div id="tip" hidden></div>
    <div id="nodiagram" hidden>Open a diagram or a file from the left.</div>
  </section>
  <section id="codeview" hidden><div class="dhead"></div><div class="dbody"></div>
    <div id="mini" hidden><div class="mhead"><span class="mtitle"></span><span class="mtabs"></span><button class="mclose" title="Fold or unfold">–</button></div><div class="mcy"></div><div class="mfoot"></div></div>
  </section>
  </section>
  <aside id="inspector"></aside>

</main>
<script>window.INIT = ${JSON.stringify(state()).replace(/</g, "\\u003c")};</script>
<script>${readFileSync(join(COCKPIT, "src", "app.js"), "utf8")}</script>
</body></html>`;

// ---- routes --------------------------------------------------------------

const json = (res: any, data: unknown, code = 200) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(data));
const readBody = (req: any) => new Promise<string>((ok) => { let b = ""; req.on("data", (c: any) => (b += c)); req.on("end", () => ok(b)); });

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const q = (k: string) => url.searchParams.get(k) ?? "";
  try {
    if (req.method === "GET" && url.pathname === "/") res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page());
    else if (req.method === "GET" && url.pathname === "/api/state") json(res, state());
    else if (req.method === "GET" && url.pathname === "/api/files") json(res, listFiles());
    else if (req.method === "GET" && url.pathname === "/api/file") {
      try { json(res, readSource(q("path"))); } catch (e) { json(res, { error: String(e) }, 400); }
    } else if (req.method === "GET" && url.pathname === "/api/git/graph") json(res, gitGraph());
    else if (req.method === "GET" && url.pathname === "/api/git/diff") {
      if (!listFiles().includes(q("path")) && !gitStatus().some((s) => s.path === q("path"))) return json(res, { error: "not a project file" }, 400);
      json(res, { patch: workingDiff(q("path")) });
    } else if (req.method === "GET" && url.pathname === "/api/git/commit") {
      if (!/^[0-9a-f]{4,40}$/.test(q("sha"))) return json(res, { error: "bad sha" }, 400);
      json(res, commitPatch(q("sha")));
    } else if (req.method === "POST" && url.pathname === "/api/diagram-layout") {
      readBody(req).then((b) => {
        try {
          const { id, positions } = JSON.parse(b);
          if (typeof id !== "string" || (positions !== null && typeof positions !== "object")) throw new Error("expected {id, positions}");
          const all = readDLayout();
          if (positions) all[id] = positions; else delete all[id];
          mkdirSync(join(root, ARCH_DIR), { recursive: true });
          writeFileSync(dlayoutPath, JSON.stringify(all, null, 1) + "\n");
          json(res, { ok: true });
        } catch (e) { res.writeHead(400).end(String(e)); }
      });
    } else res.writeHead(404).end();
  } catch (e) {
    res.writeHead(500).end(String(e));
  }
}).listen(Number(opt("port") ?? 4173), opt("host") ?? "127.0.0.1", () =>
  console.log(`serving ${name} on http://${opt("host") ?? "127.0.0.1"}:${opt("port") ?? 4173}`),
);
