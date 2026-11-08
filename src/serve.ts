// One server for a project: the board (home), the work view (map + turns), the turns page, and the map.
//   npm run serve -- <project dir> [--port 4173] [--host 127.0.0.1]
// --host 0.0.0.0 makes it reachable from other machines on the network (no login).

import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { ARCH_FILE, checkArch, readArch } from "./arch.ts";
import { boardData } from "./board.ts";
import { check, itemKey } from "./describe.ts";
import { createMapApp } from "./mapapp.ts";
import { COCKPIT, listTurns, loadTurn } from "./turns.ts";

const args = process.argv.slice(2);
const opt = (n: string) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : undefined);
const dir = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
if (!dir) {
  console.error("usage: npm run serve -- <project dir> [--port 4173] [--host 127.0.0.1]");
  process.exit(1);
}
const root = resolve(dir);
const name = opt("name") ?? basename(root);
const map = createMapApp(root, name);

// Where you placed the blocks, per zoom level. Saved as you drag.
const layoutPath = join(COCKPIT, "data", name, "layout.json");
const readLayout = () => (existsSync(layoutPath) ? JSON.parse(readFileSync(layoutPath, "utf8")) : {});

// The description: the repo's architecture.json (E7, kept by the agents) if there is one,
// else the one-shot draft from npm run describe (E6).
function readDesc() {
  const text = existsSync(join(root, ARCH_FILE)) ? readFileSync(join(root, ARCH_FILE), "utf8") : null;
  if (text !== null) {
    const sk = map.data().skeleton;
    const problems = checkArch(text, sk);
    let arch: any = null;
    try { arch = JSON.parse(text); } catch {}
    if (!arch || problems.some((p) => p.problem.startsWith("not valid JSON") || p.problem.startsWith("missing"))) return { source: "repo", problems, description: null };
    return { source: "repo", problems, description: arch, check: check(structuredClone(arch), sk) };
  }
  const f = join(COCKPIT, "out", name, "description.json");
  return existsSync(f) ? { source: "draft", problems: [], ...JSON.parse(readFileSync(f, "utf8")) } : null;
}

// Files the project tracks, plus new files not ignored by git.
const listFiles = () =>
  execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8", maxBuffer: 32 << 20 })
    .split("\n").filter(Boolean).sort();
function readSource(path: string) {
  const full = resolve(root, path);
  if (!full.startsWith(root + sep) || !listFiles().includes(path)) throw new Error("not a project file");
  if (statSync(full).size > 1 << 20) return { path, text: null, note: "file larger than 1 MB" };
  const text = readFileSync(full, "utf8");
  return text.includes("\u0000") ? { path, text: null, note: "binary file" } : { path, text };
}
// The repo's git state: branch, upstream, uncommitted files, recent commits, other branches.
const git = (...a: string[]) => execFileSync("git", a, { cwd: root, encoding: "utf8", maxBuffer: 64 << 20 });
const tryGit = (...a: string[]) => {
  try { return execFileSync("git", a, { cwd: root, encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return ""; }
};
function gitState() {
  const branch = tryGit("symbolic-ref", "--short", "-q", "HEAD") || null;
  const upstream = tryGit("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}") || null;
  const [behind, ahead] = upstream ? tryGit("rev-list", "--left-right", "--count", "@{u}...HEAD").split(/\s+/).map(Number) : [0, 0];
  // Porcelain v1: XY path, X = staged, Y = unstaged; "??" = untracked.
  const status = tryGit("status", "--porcelain=v1", "-z", "--untracked-files=all").split("\0").filter(Boolean).flatMap((e, i, arr) => {
    if (i > 0 && /^R|^C/.test(arr[i - 1] ?? "") && !/^.. /.test(e)) return []; // rename source, already used
    return [{ x: e[0], y: e[1], path: e.slice(3) }];
  });
  const log = (rev: string, n: number) => tryGit("log", rev, "-n", String(n), "--format=%h%x1f%s%x1f%an%x1f%aI%x1f%D").split("\n").filter(Boolean)
    .map((l) => { const [sha, subject, author, date, refs] = l.split("\x1f"); return { sha, subject, author, date, refs: refs.split(", ").filter((r) => r && !r.startsWith("refs/cockpit")) }; });
  const branches = tryGit("for-each-ref", "--sort=-committerdate", "--format=%(refname:short)%1f%(objectname:short)%1f%(committerdate:iso-strict)%1f%(subject)", "refs/heads")
    .split("\n").filter(Boolean).map((l) => { const [name, sha, date, subject] = l.split("\x1f"); return { name, sha, date, subject, current: name === branch }; });
  return { branch, head: tryGit("rev-parse", "--short", "HEAD"), upstream, ahead, behind, status, commits: log("HEAD", 30), branches };
}
// Uncommitted changes of one file (staged + unstaged, against HEAD); new files against nothing.
function workingDiff(path: string) {
  const st = gitState().status.find((f) => f.path === path);
  if (!st) throw new Error("no uncommitted changes in that file");
  if (st.x === "?") { try { git("diff", "--no-index", "--", "/dev/null", path); } catch (e: any) { return String(e.stdout ?? ""); } return ""; }
  return git("diff", "HEAD", "--", path);
}
const readBody = (req: any) => new Promise<string>((ok) => { let b = ""; req.on("data", (c: any) => (b += c)); req.on("end", () => ok(b)); });

// First paint uses embedded data (no wait for the first poll). ?turn=<id>&depth=1-4 pick what to show.
function turnList() {
  return listTurns(name).map((t) => ({
    id: t.id, prompt: t.prompt, status: t.status, startedAt: t.startedAt, endedAt: t.endedAt,
    touched: t.touched.length,
    files: t.analysis?.files.length,
    added: t.analysis?.files.reduce((s, f) => s + f.added, 0),
    removed: t.analysis?.files.reduce((s, f) => s + f.removed, 0),
    components: t.analysis?.components,
  }));
}
function initData(url: URL) {
  const turns = turnList();
  const want = url.searchParams.get("turn");
  const id = want && turns.some((t) => t.id === want) ? want : turns[0]?.id;
  return { turns, selected: id ?? null, detail: id ? loadTurn(name, id) : null, depth: Number(url.searchParams.get("depth")) || null };
}

const reviewPage = (url: URL) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent Turns</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/diff2html@3.4.48/bundles/css/diff2html.min.css">
<script src="https://cdn.jsdelivr.net/npm/diff2html@3.4.48/bundles/js/diff2html-ui-base.min.js"></script>
<style>${readFileSync(join(COCKPIT, "src", "review.css"), "utf8")}</style></head><body>
<header><h1>${name}</h1><span class="muted">agent turns</span><span style="flex:1"></span><a href="map">Map →</a></header>
<div class="wrap"><nav id="list"></nav><main id="detail"></main></div>
<script>window.INIT = ${JSON.stringify(initData(url)).replace(/</g, "\\u003c")};</script>
<script>${readFileSync(join(COCKPIT, "src", "review-client.js"), "utf8")}</script>
</body></html>`;

// Work page: the map is the main view; a selected turn lights up what it changed, down to the diff.
const workPage = (url: URL) => {
  map.rebuild(); // cheap unless code changed: picks up a new architecture.json too
  const init = { ...initData(url), map: map.data(), layout: readLayout(), files: listFiles(), git: gitState(), desc: readDesc() };
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cockpit</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/diff2html@3.4.48/bundles/css/diff2html.min.css">
<script src="https://cdn.jsdelivr.net/npm/diff2html@3.4.48/bundles/js/diff2html-ui-base.min.js"></script>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&display=swap">
<script src="https://cdnjs.cloudflare.com/ajax/libs/cytoscape/3.30.2/cytoscape.min.js"></script>
<style>${readFileSync(join(COCKPIT, "src", "review.css"), "utf8")}${readFileSync(join(COCKPIT, "src", "work.css"), "utf8")}</style></head><body>
<header><h1>${name}</h1><span class="nav"><a href="./">board</a> <a href="diagrams">diagrams</a></span><a id="gitbar" class="gitbar"></a><span class="muted" id="stats"></span><span style="flex:1"></span>
<span class="seg"><button data-view="desc">description</button><button data-view="map">map</button></span>
<span class="mapctl"><label class="muted"><input type="checkbox" id="arrows"> all arrows</label>
<button id="reset" title="Forget where you placed the blocks at this zoom level">reset layout</button>
</span></header>
<div class="wrap work"><nav><div id="tabs" class="tabs"></div><div id="navbody"></div></nav><div id="cy"></div><div id="desc" hidden></div><div id="split" title="drag to resize"></div><aside id="panel"></aside></div>
<script>window.INIT = ${JSON.stringify(init).replace(/</g, "\\u003c")};</script>
<script>${readFileSync(join(COCKPIT, "src", "map-layout.js"), "utf8")}</script>
<script>${readFileSync(join(COCKPIT, "src", "desc-client.js"), "utf8")}</script>
<script>${readFileSync(join(COCKPIT, "src", "work-client.js"), "utf8")}</script>
</body></html>`;
};

// The board (E8): features, how they grew, what the agent is on. Home page.
const board = () => { map.rebuild(); return boardData(root, name, map.data().skeleton); };
const boardPage = () => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${name} · board</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&display=swap">
<style>${readFileSync(join(COCKPIT, "src", "board.css"), "utf8")}</style></head><body>
<header><h1>${name}</h1><span class="nav"><a class="on" href="./">board</a><a href="diagrams">diagrams</a><a href="work">work</a></span><span id="live"></span>
<span style="flex:1"></span><span id="legend"></span>
<span class="seg"><button data-mode="status">status</button><button data-mode="activity">activity</button><button data-mode="tests">tests</button></span></header>
<main><div class="left"><div id="when">now</div><div id="tiles"><div id="empty" hidden>No features yet: add a <code>features</code> list to architecture.json.</div></div>
<div id="planned"></div><div class="tl"><div id="colinfo"></div><div id="timeline"></div></div></div><aside id="panel"></aside></main>
<script>window.INIT = ${JSON.stringify({ board: board() }).replace(/</g, "\\u003c")};</script>
<script>${readFileSync(join(COCKPIT, "src", "board-client.js"), "utf8")}</script>
</body></html>`;

// Diagrams (E9): the agents' pictures from architecture.json, with what's needed to link and light them.
function diagramsData() {
  const b = board(), sk = map.data().skeleton;
  const text = existsSync(join(root, ARCH_FILE)) ? readFileSync(join(root, ARCH_FILE), "utf8") : null;
  return {
    diagrams: readArch(root)?.diagrams ?? [],
    problems: checkArch(text, sk).filter((p) => p.where.startsWith("diagram")),
    modules: sk.modules.map((m) => ({ id: m.id, file: m.file, items: m.items.filter((i) => !i.test).map((i) => ({ key: itemKey(m.id, i), line: i.line })) })),
    live: b.live, work: b.work,
  };
}
const diagramsPage = () => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${name} · diagrams</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&display=swap">
<script src="https://cdnjs.cloudflare.com/ajax/libs/cytoscape/3.30.2/cytoscape.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/dagre/0.8.5/dagre.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/cytoscape-dagre@2.5.0/cytoscape-dagre.min.js"></script>
<style>${readFileSync(join(COCKPIT, "src", "board.css"), "utf8")}</style></head><body>
<header><h1>${name}</h1><span class="nav"><a href="./">board</a><a class="on" href="diagrams">diagrams</a><a href="work">work</a></span><span id="live"></span></header>
<div class="dwrap"><nav id="dside"><div id="dlist"></div><div id="problems"></div></nav>
<div class="dmain"><div id="cy"></div><div id="tip" hidden></div><div id="empty" hidden>No diagram selected.</div></div><aside id="panel"></aside></div>
<script>window.INIT = ${JSON.stringify({ diagrams: diagramsData() }).replace(/</g, "\\u003c")};</script>
<script>${readFileSync(join(COCKPIT, "src", "diagrams-client.js"), "utf8")}</script>
</body></html>`;

const json = (res: any, data: unknown, code = 200) =>
  res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(data));

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  try {
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(boardPage());
    } else if (req.method === "GET" && url.pathname === "/diagrams") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(diagramsPage());
    } else if (req.method === "GET" && url.pathname === "/api/diagrams") {
      json(res, diagramsData());
    } else if (req.method === "GET" && url.pathname === "/api/board") {
      json(res, board());
    } else if (req.method === "GET" && url.pathname === "/work") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(workPage(url));
    } else if (req.method === "GET" && url.pathname === "/turns") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(reviewPage(url));
    } else if (req.method === "GET" && url.pathname === "/api/map") {
      if (url.searchParams.get("fresh")) map.rebuild(); // reindexes only if the code changed
      json(res, map.data());
    } else if (req.method === "GET" && url.pathname === "/map") {
      // Rebuilds only what is stale: reindexes if code changed; the agent's grouping is cached.
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(map.rebuild().html);
    } else if (req.method === "GET" && url.pathname === "/api/git") {
      json(res, gitState());
    } else if (req.method === "GET" && url.pathname === "/api/git/diff") {
      try { json(res, { patch: workingDiff(url.searchParams.get("path") ?? "") }); } catch (e) { json(res, { error: String(e) }, 400); }
    } else if (req.method === "GET" && url.pathname === "/api/git/commit") {
      const sha = url.searchParams.get("sha") ?? "";
      if (!/^[0-9a-f]{4,40}$/.test(sha)) return json(res, { error: "bad sha" }, 400);
      try {
        const [meta, ...rest] = git("show", "--format=%H%x1f%s%x1f%an%x1f%aI%x1f%b%x1e", "--patch", sha).split("\x1e");
        const [full, subject, author, date, body] = meta.split("\x1f");
        json(res, { sha: full, subject, author, date, body: body.trim(), patch: rest.join("\x1e").replace(/^\n+/, "") });
      } catch (e) { json(res, { error: String(e) }, 400); }
    } else if (req.method === "GET" && url.pathname === "/api/desc") {
      json(res, readDesc());
    } else if (req.method === "GET" && url.pathname === "/api/files") {
      json(res, listFiles());
    } else if (req.method === "GET" && url.pathname === "/api/file") {
      try { json(res, readSource(url.searchParams.get("path") ?? "")); } catch (e) { json(res, { error: String(e) }, 400); }
    } else if (req.method === "POST" && url.pathname === "/api/layout") {
      readBody(req).then((b) => {
        try {
          const v = JSON.parse(b);
          if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error("expected an object");
          mkdirSync(join(COCKPIT, "data", name), { recursive: true });
          writeFileSync(layoutPath, JSON.stringify(v, null, 1) + "\n");
          json(res, { ok: true });
        } catch (e) { res.writeHead(400).end(String(e)); }
      });
    } else if (req.method === "GET" && url.pathname === "/api/turns") {
      json(res, turnList());
    } else if (req.method === "GET" && url.pathname.startsWith("/api/turns/")) {
      const id = url.pathname.split("/").pop()!;
      if (!/^t[\d-]+$/.test(id)) return json(res, { error: "bad id" }, 400);
      json(res, loadTurn(name, id));
    } else if (req.method === "POST" && url.pathname === "/api/overrides") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          json(res, map.save(JSON.parse(body)));
        } catch (e) {
          res.writeHead(400).end(String(e));
        }
      });
    } else res.writeHead(404).end();
  } catch (e) {
    res.writeHead(500).end(String(e));
  }
}).listen(Number(opt("port") ?? 4173), opt("host") ?? "127.0.0.1", () =>
  console.log(`serving ${name} on http://${opt("host") ?? "127.0.0.1"}:${opt("port") ?? 4173} (board at /, work view at /work, turns at /turns, map at /map)`),
);
