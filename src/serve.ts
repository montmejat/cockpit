// The cockpit server for one project: serves the page (web/, built with Vite) and its data, runs
// the agent chat and the terminals, and pushes what changes as it changes.
//   npm run serve -- <project dir> [--port 4173] [--host 127.0.0.1]
// --host 0.0.0.0 makes it reachable from other machines on the network (no login).

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { WebSocketServer } from "ws";
import { ARCH_DIR, checkArch, loadArch } from "./arch.ts";
import { createChat } from "./chat.ts";
import { createIndex } from "./codeindex.ts";
import { itemKey, type Skeleton } from "./skeleton.ts";
import { COCKPIT, turnsDir, type Turn } from "./turns.ts";
import { createTerminals } from "./term.ts";
import { createAsk } from "./ask.ts";

const args = process.argv.slice(2);
const opt = (n: string) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : undefined);
const dir = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
if (!dir) {
  console.error("usage: npm run serve -- <project dir> [--port 4173] [--host 127.0.0.1]");
  process.exit(1);
}
const root = resolve(dir);
const name = opt("name") ?? basename(root);
const WEB = join(COCKPIT, "web", "dist");
const index = createIndex(root, name); // the code index (rust-analyzer or scip-clang), rebuilt when code changes
const terms = createTerminals(root, name); // shells in the bottom drawer, readable by the agent
const ask = createAsk(root); // the terminal's ask line: words → a command
const chat = createChat(root, name, terms, index); // the agent, run by cockpit itself

// No optional locks: `git status` must not rewrite .git/index, which the watcher below follows.
const tryGit = (...a: string[]) => {
  try {
    return execFileSync("git", a, { cwd: root, encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }).trimEnd();
  } catch (e: any) { return String(e.stdout ?? "").trimEnd(); }
};

// ---- files ---------------------------------------------------------------

const listFiles = () => tryGit("ls-files", "--cached", "--others", "--exclude-standard").split("\n").filter(Boolean).sort();
const isProjectFile = (path: string) => {
  const full = resolve(root, path);
  return full.startsWith(root + sep) && listFiles().includes(path);
};

// What changed in a file since the last commit, as hunks over the current text: lines added or
// changed, and the old lines removed at each place. The page draws them in the file itself.
type Hunk = { at: number; added: number; removed: string[] };
function hunksOf(path: string, untracked: boolean): Hunk[] {
  if (untracked) return [{ at: 1, added: 1e9, removed: [] }]; // all new
  const out: Hunk[] = [];
  for (const l of tryGit("diff", "HEAD", "-U0", "--no-color", "--no-ext-diff", "--", path).split("\n")) {
    const m = l.match(/^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (m) out.push({ at: +m[2] + (m[3] === "0" ? 1 : 0), added: m[3] === undefined ? 1 : +m[3], removed: [] });
    else if (out.length && l.startsWith("-") && !l.startsWith("---")) out.at(-1)!.removed.push(l.slice(1));
  }
  return out;
}
function readSource(path: string) {
  if (!isProjectFile(path)) throw new Error("not a project file");
  const full = resolve(root, path);
  if (statSync(full).size > 1 << 20) return { path, text: null, note: "file larger than 1 MB", hunks: [] };
  const text = readFileSync(full, "utf8");
  if (text.includes("\u0000")) return { path, text: null, note: "binary file", hunks: [] };
  const st = gitStatus().find((s) => s.path === path);
  return { path, text, hunks: st ? hunksOf(path, st.x === "?") : [] };
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
function commitPatch(sha: string) {
  const [meta, ...rest] = tryGit("show", "--format=%H%x1f%s%x1f%an%x1f%aI%x1f%b%x1e", "--patch", sha).split("\x1e");
  const [full, subject, author, date, body] = meta.split("\x1f");
  return { sha: full, subject, author, date, body: (body ?? "").trim(), patch: rest.join("\x1e").replace(/^\n+/, "") };
}

// ---- what is changing ----------------------------------------------------

// Lines changed but not committed, per file (new-file line numbers), from the working diff.
function changedLines(status: ReturnType<typeof gitStatus>): Record<string, [number, number][]> {
  const out: Record<string, [number, number][]> = {};
  let file = "";
  for (const l of tryGit("diff", "HEAD", "-U0", "--no-color", "--no-ext-diff").split("\n")) {
    if (l.startsWith("+++ ")) file = l.startsWith("+++ b/") ? l.slice(6) : "";
    const m = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (m && file) {
      const start = +m[1], n = m[2] === undefined ? 1 : +m[2];
      (out[file] ??= []).push([start, start + Math.max(n, 1) - 1]); // n = 0: lines removed just after start
    }
  }
  for (const s of status) if (s.x === "?") out[s.path] = [[1, 1e9]];
  return out;
}

// The running agent turn, if any, and the files it touched so far. Only the turns sessions point
// to as current are read, not the whole history.
function liveTurn() {
  const d = turnsDir(name);
  if (!existsSync(d)) return null;
  for (const f of readdirSync(d).filter((x) => x.startsWith(".current-"))) {
    try {
      const id = readFileSync(join(d, f), "utf8").trim();
      const t: Turn = JSON.parse(readFileSync(join(d, `${id}.json`), "utf8"));
      if (t.status === "running")
        return { id: t.id, prompt: t.prompt, startedAt: t.startedAt, touched: [...new Set(t.touched.map((x) => (x.file.startsWith(root) ? x.file.slice(root.length + 1) : x.file)))] };
    } catch {}
  }
  return null;
}

// Where you placed the boxes of each diagram: { diagramId: { nodeId: {x, y} } }. Kept in the
// project, so the arrangement travels with the repo.
const dlayoutPath = join(root, ARCH_DIR, "layout.json");
const readDLayout = () => { try { return existsSync(dlayoutPath) ? JSON.parse(readFileSync(dlayoutPath, "utf8")) : {}; } catch { return {}; } };

// What is tested, by name. Rust: #[test] functions inside each module and in the integration
// test files (tests/*.rs). C/C++: test files (*_test.cpp, test_*.cpp, *Test.cpp, or anything
// under a test/ dir), with their GoogleTest / Catch2 / Boost.Test cases, else their test_*() functions
// (plain main() tests), else the file as one test.
const CXX_TEST_FILE = /(^|\/)(tests?\/.*|[^/]*[_-]test|test_[^/]*|[^/]*Tests?)\.(c|cc|cpp|cxx)$/;
const CXX_TEST_FN = /^[ \t]*(?:static\s+)?(?:inline\s+)?void\s+(test_?\w*)\s*\(\s*(?:void)?\s*\)\s*\{/gm;
const CXX_TEST_CASE = /^[ \t]*(?:TEST|TEST_F|TEST_P|TYPED_TEST|TYPED_TEST_P|TEST_CASE|SCENARIO|BOOST_AUTO_TEST_CASE|BOOST_FIXTURE_TEST_CASE)\s*\(\s*([^)]*)\)/gm;
function testsOf(sk: Skeleton, files: string[]) {
  const unit = sk.modules.map((m) => ({ module: m.id, file: m.file, crate: m.crate, tests: m.items.filter((i) => i.test && i.kind === "Function").map((i) => ({ name: i.name, line: i.line })) }));
  const integration = files.filter((f) => /(^|\/)tests\/.*\.rs$/.test(f)).flatMap((file) => {
    try {
      const text = readFileSync(join(root, file), "utf8"), tests: { name: string; line: number }[] = [];
      const re = /#\[test\]\s*(?:#\[[^\]]*\]\s*)*(?:pub\s+)?fn\s+(\w+)/g;
      for (let m; (m = re.exec(text)); ) tests.push({ name: m[1], line: text.slice(0, m.index).split("\n").length });
      return [{ file, tests }];
    } catch { return []; }
  });
  if (sk.lang === "cpp") for (const file of files.filter((f) => CXX_TEST_FILE.test(f))) {
    let text: string;
    try { text = readFileSync(join(root, file), "utf8"); } catch { continue; }
    const tests: { name: string; line: number }[] = [];
    for (let m; (m = CXX_TEST_CASE.exec(text)); ) {
      const args = m[1].split(",").map((a) => a.trim().replace(/^"|"$/g, ""));
      tests.push({ name: args.length > 1 && !/^"/.test(m[1].trim()) ? `${args[0]}.${args[1]}` : args[0], line: text.slice(0, m.index).split("\n").length });
    }
    if (!tests.length) for (let m; (m = CXX_TEST_FN.exec(text)); ) tests.push({ name: m[1], line: text.slice(0, m.index).split("\n").length });
    integration.push({ file, tests: tests.length ? tests : [{ name: file.split("/").pop()!.replace(/\.[^.]+$/, ""), line: 1 }] });
  }
  return { unit, integration };
}

// Everything the page shows, as named parts: the page gets the whole thing once, then only the
// parts that changed.
function state() {
  const sk = index.current();
  const loaded = loadArch(root), arch = loaded.arch;
  const status = gitStatus(), files = listFiles();
  const lines = changedLines(status);
  // Items whose lines changed: lets a diagram box light up only when its own function changed.
  const changedItems: string[] = [];
  for (const m of sk.modules) {
    const ranges = lines[m.file];
    if (ranges) for (const i of m.items) if (!i.test && ranges.some(([a, b]) => a <= (i.end ?? i.line) && b >= i.line)) changedItems.push(itemKey(m.id, i));
  }
  // When each changed file was last written: the page reloads an open file when this moves.
  const fileRevs: Record<string, number> = {};
  for (const f of Object.keys(lines)) try { fileRevs[f] = Math.round(statSync(join(root, f)).mtimeMs); } catch { fileRevs[f] = 0; }
  return {
    project: name,
    diagrams: arch?.diagrams ?? [],
    problems: sk.modules.length ? checkArch(loaded, sk) : loaded.problems,
    modules: sk.modules.map((m) => ({ id: m.id, file: m.file, items: m.items.filter((i) => !i.test).map((i) => ({ key: itemKey(m.id, i), line: i.line, end: i.end })) })),
    layout: readDLayout(),
    live: liveTurn(),
    files,
    status, changedFiles: Object.keys(lines), changedItems, fileRevs,
    git: gitHead(),
    lines: sk.modules.reduce((s, m) => s + m.lines, 0),
    features: arch?.features ?? [],
    tests: testsOf(sk, files),
    summary: arch?.summary ?? "",
  };
}
type State = ReturnType<typeof state>;

// ---- live: watch the project, push the parts that changed ----------------------------

let current: State = state();
let currentJson: Record<string, string> = Object.fromEntries(Object.entries(current).map(([k, v]) => [k, JSON.stringify(v)]));
const pages = new Set<(e: unknown) => void>();

function recompute() {
  const next = state(), patch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(next)) {
    const j = JSON.stringify(v);
    if (currentJson[k] !== j) { patch[k] = v; currentJson[k] = j; }
  }
  current = next;
  if (Object.keys(patch).length) for (const send of pages) send({ type: "patch", patch });
}

// One watcher per folder that holds project files (not ignored ones, so never target/), plus
// git's HEAD, index and branches, and the folder where agent turns are recorded.
const watchers = new Map<string, FSWatcher>();
let debounce: NodeJS.Timeout | null = null;
function changed(code = false) {
  if (code) void index.refresh();
  if (debounce) clearTimeout(debounce);
  debounce = setTimeout(() => { debounce = null; try { recompute(); syncWatchers(); } catch (e) { console.error("state:", e); } }, 150);
}
function syncWatchers() {
  const want = new Map<string, (f: string) => void>();
  const project = (f: string) => changed(index.affects(f));
  for (const f of current.files) want.set(dirname(join(root, f)), project);
  want.set(root, project);
  want.set(join(root, ARCH_DIR), project);
  want.set(join(root, ARCH_DIR, "diagrams"), project);
  const gitDir = join(root, ".git");
  want.set(gitDir, (f) => { if (["HEAD", "index", "packed-refs", "ORIG_HEAD", "MERGE_HEAD"].includes(f)) changed(); });
  want.set(join(gitDir, "refs"), () => changed());
  mkdirSync(turnsDir(name), { recursive: true });
  want.set(turnsDir(name), () => changed());
  for (const [d, w] of watchers) if (!want.has(d)) { w.close(); watchers.delete(d); }
  for (const [d, fn] of want) {
    if (watchers.has(d) || !existsSync(d)) continue;
    try {
      const w = watch(d, { recursive: d === join(gitDir, "refs") }, (_e, f) => fn(String(f ?? "")));
      w.on("error", () => { w.close(); watchers.delete(d); });
      watchers.set(d, w);
    } catch {}
  }
}
syncWatchers();
index.onChange(() => changed());
void index.refresh();
setInterval(() => changed(), 20_000); // in case a watcher missed something

// ---- page ----------------------------------------------------------------

function page() {
  const file = join(WEB, "index.html");
  if (!existsSync(file)) return `<!doctype html><meta charset=utf-8><body style="font:14px monospace;padding:30px">The page isn't built yet: run <b>npm run build</b> in ${COCKPIT}.`;
  const boot = { ...current, terminals: terms.list() };
  return readFileSync(file, "utf8")
    .replace("<title>cockpit</title>", `<title>${name.replace(/[<&]/g, "")} · cockpit</title>`)
    .replace("<!--boot-->", `<script>window.INIT = ${JSON.stringify(boot).replace(/</g, "\\u003c")};</script>`);
}
const TYPES: Record<string, string> = { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".woff": "font/woff", ".svg": "image/svg+xml", ".png": "image/png" };

// ---- routes --------------------------------------------------------------

const json = (res: ServerResponse, data: unknown, code = 200) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(data));
const readBody = (req: IncomingMessage) => new Promise<any>((ok, fail) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => { try { ok(b ? JSON.parse(b) : {}); } catch (e) { fail(e); } });
});
// Server-sent events: a first message, then each one `subscribe` hands over.
function events(req: IncomingMessage, res: ServerResponse, first: unknown, subscribe: (send: (e: unknown) => void) => () => void) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const send = (e: unknown) => res.write("data: " + JSON.stringify(e) + "\n\n");
  send(first);
  const off = subscribe(send);
  const ping = setInterval(() => res.write(": ping\n\n"), 20000);
  req.on("close", () => { off(); clearInterval(ping); });
}

// Only the page itself may act: a page from another site, open in the same browser, could
// otherwise talk to the agent or open a shell here.
const sameOrigin = (req: IncomingMessage) => { const o = req.headers.origin; if (!o) return true; try { return new URL(o).host === req.headers.host; } catch { return false; } };

type Handler = (req: IncomingMessage, res: ServerResponse, url: URL) => unknown;
const q = (url: URL, k: string) => url.searchParams.get(k) ?? "";
const post = (fn: (body: any, res: ServerResponse) => unknown): Handler => async (req, res) => {
  try { const r = await fn(await readBody(req), res); if (!res.headersSent) json(res, r ?? { ok: true }); }
  catch (e: any) { if (!res.headersSent) json(res, { error: String(e?.message ?? e) }, 400); }
};

const routes: Record<string, Handler> = {
  "GET /": (_req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page()),
  "GET /api/events": (req, res) => events(req, res, { type: "full", state: current }, (send) => { pages.add(send); return () => pages.delete(send); }),
  "GET /api/state": (_req, res) => json(res, current),
  "GET /api/file": (_req, res, url) => { try { json(res, readSource(q(url, "path"))); } catch (e) { json(res, { error: String(e) }, 400); } },
  "GET /api/git/graph": (_req, res) => json(res, gitGraph()),
  "GET /api/git/commit": (_req, res, url) => (/^[0-9a-f]{4,40}$/.test(q(url, "sha")) ? json(res, commitPatch(q(url, "sha"))) : json(res, { error: "bad sha" }, 400)),
  "POST /api/diagram-layout": post(({ id, positions }) => {
    if (typeof id !== "string" || (positions !== null && typeof positions !== "object")) throw new Error("expected {id, positions}");
    const all = readDLayout();
    if (positions) all[id] = positions; else delete all[id];
    mkdirSync(join(root, ARCH_DIR), { recursive: true });
    writeFileSync(dlayoutPath, JSON.stringify(all, null, 1) + "\n");
  }),

  // the agent chat
  "GET /api/chat/events": (req, res) => events(req, res, { type: "init", ...chat.snapshot() }, chat.subscribe),
  "GET /api/chat/sessions": async (_req, res) => json(res, await chat.sessions()),
  "GET /api/chat/usage": async (_req, res) => json(res, await chat.usage()),
  "POST /api/chat/send": post(({ text }) => { if (typeof text !== "string") throw new Error("expected text"); chat.send(text); }),
  "POST /api/chat/answer": post(({ id, allow }) => chat.answer(String(id), !!allow)),
  "POST /api/chat/stop": post(() => chat.stop()),
  "POST /api/chat/model": post(({ model }) => chat.setModel(String(model))),
  "POST /api/chat/new": post(() => chat.reset()),
  "POST /api/chat/open": post(({ id }) => chat.open(String(id))),

  // terminals
  "GET /api/term/list": (_req, res) => json(res, terms.list()),
  "POST /api/term/new": post(({ cols, rows }) => ({ id: terms.open(cols, rows) })),
  "POST /api/term/close": post(({ id }) => terms.close(String(id))),
  "POST /api/term/ask": post(async ({ id, text }) => {
    if (typeof text !== "string" || !text.trim()) throw new Error("expected text");
    const r = terms.recent(String(id ?? ""));
    return ask(text.trim(), r.cwd, r.text);
  }),
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (req.method !== "GET" && !sameOrigin(req)) return res.writeHead(403).end("cross-origin request refused");
  try {
    const h = routes[`${req.method} ${url.pathname}`];
    if (h) return await h(req, res, url);
    // The built page's own files (scripts, styles, fonts), named by content hash.
    if (req.method === "GET" && url.pathname.startsWith("/assets/")) {
      const file = resolve(WEB, "." + url.pathname), type = TYPES[extname(file)];
      if (!file.startsWith(join(WEB, "assets") + sep) || !type || !existsSync(file)) return res.writeHead(404).end();
      return res.writeHead(200, { "content-type": type, "cache-control": "max-age=31536000, immutable" }).end(readFileSync(file));
    }
    res.writeHead(404).end();
  } catch (e) {
    if (!res.headersSent) res.writeHead(500).end(String(e));
  }
});
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, sock, head) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname !== "/api/term/ws" || !sameOrigin(req) || !req.headers.origin) { sock.destroy(); return; }
  wss.handleUpgrade(req, sock, head, (ws) => terms.attach(ws, url.searchParams.get("id") ?? ""));
});
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => { terms.closeAll(); process.exit(0); });
server.listen(Number(opt("port") ?? 4173), opt("host") ?? "127.0.0.1", () =>
  console.log(`serving ${name} on http://${opt("host") ?? "127.0.0.1"}:${opt("port") ?? 4173}`),
);
