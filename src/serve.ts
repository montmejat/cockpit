// The cockpit server for one project: serves the page (web/, built with Vite) and its data, runs
// the agent chat and the terminals, and pushes what changes as it changes.
//   npm run serve -- <project dir> [--port 4173] [--host 127.0.0.1]
// --host 0.0.0.0 makes it reachable from other machines on the network. Either way only a page
// opened with the server's token gets in (auth.ts): the link it prints, or the desktop app.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { execFile, execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { WebSocketServer } from "ws";
import { ARCH_DIR, checkArch, loadArch } from "./arch.ts";
import { createChat, IMAGE_TYPES } from "./chat.ts";
import { createIndex } from "./codeindex.ts";
import { itemKey, type Skeleton } from "./skeleton.ts";
import { COCKPIT, outDir, turnsDir, type Turn } from "./turns.ts";
import { createTerminals } from "./term.ts";
import { createAsk } from "./ask.ts";
import { createReview } from "./review.ts";
import { createPrivate } from "./private.ts";
import { workspaceOf } from "./workspace.ts";
import { createGit, type Status } from "./git.ts";
import { createAuth } from "./auth.ts";
import { listPatch, type ListPatch } from "./listpatch.ts";
import { instructions, lastResults, loadGuardrails, runChecks, runningChecks } from "./guardrails.ts";

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
const chat = createChat(root, name, terms, index, () => changed()); // the agent, run by cockpit itself
const review = createReview(root, name); // reviewing a merge request against its target
// .cockpit/ kept out of the project's git, following its branches, synced between your machines
const priv = createPrivate(root, () => changed());

const git = createGit(root);
const port = Number(opt("port") ?? 4173), host = opt("host") ?? "127.0.0.1";
// The desktop app hands its token over; else one kept per project, so a page left open keeps
// working when the server restarts.
function savedToken() {
  const f = join(outDir(name), "token");
  try { return readFileSync(f, "utf8").trim(); } catch {}
  const t = randomBytes(24).toString("base64url");
  mkdirSync(outDir(name), { recursive: true });
  writeFileSync(f, t + "\n", { mode: 0o600 });
  chmodSync(f, 0o600);
  return t;
}
const auth = createAuth(port, host, process.env.COCKPIT_TOKEN || savedToken());
delete process.env.COCKPIT_TOKEN; // not passed on to the terminals and agents started from here

// ---- files ---------------------------------------------------------------

// .cockpit/ is listed even when it is kept out of git (private.ts).
const listFiles = () => git.files(ARCH_DIR);
// Tracked or untracked, not ignored: in the live list, else asked again (a file just created).
async function isProjectFile(path: unknown): Promise<boolean> {
  if (typeof path !== "string" || !resolve(root, path).startsWith(root + sep)) return false;
  return current.files.includes(path) || (await listFiles()).includes(path);
}

async function readSource(path: string, inReview = false) {
  const base = inReview ? await reviewBase() : null;
  const known = await isProjectFile(path);
  if (base && !known && (await git.read("cat-file", "-t", `${base}:${path}`)) === "blob")
    return { path, text: null, note: "deleted in this review", hunks: [] };
  if (!known) throw new Error("not a project file");
  const full = resolve(root, path);
  if (statSync(full).size > 1 << 20) return { path, text: null, note: "file larger than 1 MB", hunks: [] };
  const text = readFileSync(full, "utf8");
  if (text.includes("\u0000")) return { path, text: null, note: "binary file", hunks: [] };
  const st = (await git.status()).find((s) => s.path === path);
  const hash = hashOf(text); // what the editor saves against
  if (base) return { path, text, hash, hunks: await git.hunks(path, st?.x === "?", base) };
  return { path, text, hash, hunks: st ? await git.hunks(path, st.x === "?") : [] };
}
const hashOf = (text: string) => createHash("sha1").update(text).digest("hex");

// Saving from the editor. Only a project file, only inside the project (a symlink pointing out is
// refused), and only if the file is still what the editor loaded (`hash`): when an agent changed it
// meanwhile, the save is refused with the file as it is now, and the page asks you what to keep.
// `force` overwrites anyway.
async function saveSource(path: string, text: string, hash: string, force = false) {
  if (typeof path !== "string" || typeof text !== "string") throw new Error("expected path and text");
  if (!(await isProjectFile(path))) throw new Error("not a project file");
  const full = resolve(root, path);
  if (!realpathSync(full).startsWith(realpathSync(root) + sep)) throw new Error("outside the project");
  const now = readFileSync(full, "utf8");
  if (!force && hashOf(now) !== hash) return { conflict: true, text: now, hash: hashOf(now) };
  writeFileSync(full, text);
  return { ok: true, hash: hashOf(text) };
}

// ---- what is changing ----------------------------------------------------

// The running agent turn, if any, and the files it touched so far. Only the turns sessions point
// to as current are read, not the whole history. A turn can stay open after its agent is gone
// (the server stopped mid-reply, a terminal closed), so one whose session hasn't written to its
// transcript for a while doesn't count. `chat`: it is cockpit's own chat, not a Claude Code
// session in a terminal.
const STALE_MS = 10 * 60_000;
function liveTurn() {
  const d = turnsDir(name);
  if (!existsSync(d)) return null;
  let live: (Turn & { last: number }) | null = null;
  for (const f of readdirSync(d).filter((x) => x.startsWith(".current-"))) {
    try {
      const id = readFileSync(join(d, f), "utf8").trim();
      const t: Turn = JSON.parse(readFileSync(join(d, `${id}.json`), "utf8"));
      if (t.status !== "running") continue;
      let last = Date.parse(t.startedAt);
      try { last = Math.max(last, statSync(t.transcript).mtimeMs); } catch {}
      for (const x of t.touched) last = Math.max(last, Date.parse(x.at));
      if (Date.now() - last > STALE_MS) continue;
      if (!live || t.startedAt > live.startedAt) live = { ...t, last };
    } catch {}
  }
  if (!live) return null;
  return {
    id: live.id, prompt: live.prompt, startedAt: live.startedAt,
    chat: existsSync(join(outDir(name), "chats", `${live.session}.json`)),
    touched: [...new Set(live.touched.map((x) => (x.file.startsWith(root) ? x.file.slice(root.length + 1) : x.file)))],
  };
}
// Nothing gets written when an agent dies, so look again now and then while one shows as working.
setInterval(() => { if (current?.live) changed(); }, 60_000).unref();

// Where you placed the boxes of each diagram: { diagramId: { nodeId: {x, y} } }. Kept in the
// project, so the arrangement travels with the repo.
const dlayoutPath = join(root, ARCH_DIR, "layout.json");
const readDLayout = () => { try { return existsSync(dlayoutPath) ? JSON.parse(readFileSync(dlayoutPath, "utf8")) : {}; } catch { return {}; } };

// What is tested, by name. Rust: #[test] functions inside each module and in the integration
// test files (tests/*.rs). Zig: the test "…" blocks in each file. C/C++: test files (*_test.cpp, test_*.cpp, *Test.cpp, or anything
// under a test/ dir), with their GoogleTest / Catch2 / Boost.Test cases, else their test_*() functions
// (plain main() tests), else the file as one test.
const CXX_TEST_FILE = /(^|\/)(tests?\/.*|[^/]*[_-]test|test_[^/]*|[^/]*Tests?)\.(c|cc|cpp|cxx)$/;
const CXX_TEST_FN = /^[ \t]*(?:static\s+)?(?:inline\s+)?void\s+(test_?\w*)\s*\(\s*(?:void)?\s*\)\s*\{/gm;
const CXX_TEST_CASE = /^[ \t]*(?:TEST|TEST_F|TEST_P|TYPED_TEST|TYPED_TEST_P|TEST_CASE|SCENARIO|BOOST_AUTO_TEST_CASE|BOOST_FIXTURE_TEST_CASE)\s*\(\s*([^)]*)\)/gm;
function testsOf(sk: Skeleton, files: string[]) {
  const unit = sk.modules.map((m) => ({ module: m.id, file: m.file, crate: m.crate, tests: m.items.filter((i) => i.test && (i.kind === "Function" || i.kind === "Test")).map((i) => ({ name: i.name, line: i.line })) }));
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

// Items whose lines changed: lets a diagram box light up only when its own function changed.
function itemsIn(sk: Skeleton, lines: Record<string, [number, number][]>) {
  const out: string[] = [];
  for (const m of sk.modules) {
    const ranges = lines[m.file];
    if (ranges) for (const i of m.items) if (!i.test && ranges.some(([a, b]) => a <= (i.end ?? i.line) && b >= i.line)) out.push(itemKey(m.id, i));
  }
  return out;
}

// ---- review mode ---------------------------------------------------------------

// Where the reviewed branch left its target: the merge request's diff starts there.
const reviewBase = async () => { const r = review.current(); return r ? (await git.read("merge-base", "HEAD", r.target)) || null : null; };

// The diagrams as the target had them, by commit (they never change for a given commit).
// null when the target has no .cockpit/ (not committed, or kept out of git): nothing to compare.
const baseDiagrams = new Map<string, Map<string, { question: string; nodes: Map<string, string> }> | null>();
async function diagramsAt(base: string) {
  // .cockpit/ kept private: the description saved at (or nearest before) the base, from the store.
  const kept = (await git.read("cat-file", "-t", `${base}:${ARCH_DIR}/project.json`)) === "blob" ? null : priv.at(base);
  const key = kept ? base + "@" + kept : base;
  if (!baseDiagrams.has(key)) {
    const arch = kept ? loadArch(root, kept, priv.store).arch : loadArch(root, base).arch;
    baseDiagrams.set(key, arch ? new Map(arch.diagrams.map((d) => [d.id, { question: d.question, nodes: new Map(d.nodes.map((n) => [n.id, n.label])) }])) : null);
  }
  return baseDiagrams.get(key)!;
}

// What the review changes: files and items (committed on the branch or not), and the diagrams'
// own boxes added and removed.
async function reviewState(sk: Skeleton, status: Status[], diagrams: { id: string; question: string; nodes: { id: string; label: string }[] }[]) {
  const r = review.current();
  if (!r) return null;
  const base = await reviewBase();
  if (!base) return { ...r, base: null, error: `${r.target} and this branch share no history`, files: [], changedFiles: [], changedItems: [], impacted: [], commits: 0, diagrams: {}, removedDiagrams: [] };
  const [lines, nameStatus, short, commits] = await Promise.all([
    git.changedLines(status, base), git.read("diff", "--name-status", "--no-renames", base),
    git.read("rev-parse", "--short", base), git.read("rev-list", "--count", `${base}..HEAD`),
  ]);
  const files: { path: string; st: string }[] = nameStatus.split("\n").filter(Boolean)
    .map((l) => { const [st, path] = l.split("\t"); return { path, st: st[0] }; });
  for (const s of status) if (s.x === "?" && !files.some((f) => f.path === s.path)) files.push({ path: s.path, st: "A" });
  files.sort((a, b) => a.path.localeCompare(b.path));
  const before = await diagramsAt(base), diff: Record<string, { isNew: boolean; added: string[]; removed: { id: string; label: string }[] }> = {};
  if (before) for (const d of diagrams) {
    const b = before.get(d.id);
    const added = b ? d.nodes.filter((n) => !b.nodes.has(n.id)).map((n) => n.id) : d.nodes.map((n) => n.id);
    const removed = b ? [...b.nodes].filter(([id]) => !d.nodes.some((n) => n.id === id)).map(([id, label]) => ({ id, label })) : [];
    if (!b || added.length || removed.length) diff[d.id] = { isNew: !b, added, removed };
  }
  // What it impacts: the modules that use a changed one (one step out), not changed themselves.
  const changedFiles = new Set(Object.keys(lines));
  const changedMods = new Set(sk.modules.filter((m) => changedFiles.has(m.file)).map((m) => m.id));
  const impacted = [...new Set(sk.edges.filter((e) => changedMods.has(e.to) && !changedMods.has(e.from)).map((e) => e.from))];
  return {
    ...r, base: short, error: null,
    commits: Number(commits) || 0,
    files, changedFiles: [...changedFiles], changedItems: itemsIn(sk, lines), impacted,
    diagrams: diff, removedDiagrams: [...(before ?? [])].filter(([id]) => !diagrams.some((d) => d.id === id)).map(([id, b]) => ({ id, question: b.question })),
  };
}

// Everything the page shows, as named parts: the page gets the whole thing once, then only the
// parts that changed.
// The workspace this project is in (workspace.ts), for the header.
function workspaceState() {
  const w = workspaceOf(root);
  return w && { name: w.name, system: existsSync(w.system) ? w.system : null, projects: w.projects };
}

// Guardrails (src/guardrails.ts): the project's checks and rules, each check's last result, and
// the instruction files agents read. null when the project has none: nothing is set up for it.
function guardrailsState() {
  const { g, problems } = loadGuardrails(root);
  const told = instructions(root);
  if (!g && !problems.length) return { on: false as const, instructions: told };
  return { on: true as const, checks: g?.checks ?? [], rules: g?.rules ?? [], problems, results: lastResults(name), running: runningChecks(name), instructions: told };
}

// Git is asked side by side, off the server's thread.
async function state() {
  const sk = index.current();
  const loaded = loadArch(root), arch = loaded.arch;
  const [status, files, head] = await Promise.all([git.status(), listFiles(), git.head()]);
  const [lines, review] = await Promise.all([git.changedLines(status), reviewState(sk, status, arch?.diagrams ?? [])]);
  const changedItems = itemsIn(sk, lines);
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
    git: head,
    lines: sk.modules.reduce((s, m) => s + m.lines, 0),
    features: arch?.features ?? [],
    tests: testsOf(sk, files),
    summary: arch?.summary ?? "",
    review,
    workspace: workspaceState(),
    guardrails: guardrailsState(),
    private: priv.state(),
  };
}
type State = Awaited<ReturnType<typeof state>>;

// ---- live: watch the project, push the parts that changed ----------------------------

priv.tick();
let current: State = await state();
let currentJson: Record<string, string> = Object.fromEntries(Object.entries(current).map(([k, v]) => [k, JSON.stringify(v)]));
const pages = new Set<(e: unknown) => void>();

const unitKey = (u: State["tests"]["unit"][number]) => u.module + "\0" + u.file;
// One at a time, in order: a call while one runs queues one more (calls meanwhile share it), so
// what a route changed is in the state its answer waits for.
let chain: Promise<void> = Promise.resolve(), queued: Promise<void> | null = null;
function recompute(): Promise<void> {
  if (queued) return queued;
  const p: Promise<void> = chain.then(() => { queued = null; return recomputeNow(); }).catch((e) => console.error("state:", e));
  return (chain = queued = p);
}
async function recomputeNow() {
  const next = await state(), patch: Record<string, unknown> = {}, lists: Record<string, ListPatch> = {};
  for (const [k, v] of Object.entries(next)) {
    const j = JSON.stringify(v);
    if (currentJson[k] === j) continue;
    currentJson[k] = j;
    if (k === "modules") lists.modules = listPatch(current.modules, next.modules, (m) => m.id);
    else if (k === "tests") {
      lists["tests.unit"] = listPatch(current.tests.unit, next.tests.unit, unitKey);
      lists["tests.integration"] = listPatch(current.tests.integration, next.tests.integration, (t) => t.file);
    } else patch[k] = v;
  }
  current = next;
  if (Object.keys(patch).length || Object.keys(lists).length) for (const send of pages) send({ type: "patch", patch, lists });
}

// One watcher per folder that holds project files (not ignored ones, so never target/), plus
// git's HEAD, index and branches, and the folder where agent turns are recorded.
const watchers = new Map<string, FSWatcher>();
let debounce: NodeJS.Timeout | null = null;
function changed(code = false) {
  if (code) void index.refresh();
  if (debounce) clearTimeout(debounce);
  debounce = setTimeout(() => { debounce = null; try { priv.tick(); } catch (e) { console.error("private:", e); } void recompute().then(syncWatchers); }, 150);
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
  const boot = { ...current, root, terminals: terms.list(), desktop: desktopLook() };
  return readFileSync(file, "utf8")
    .replace("<title>cockpit</title>", `<title>${name.replace(/[<&]/g, "")} · cockpit</title>`)
    .replace("<!--boot-->", `<script>window.INIT = ${JSON.stringify(boot).replace(/</g, "\\u003c")};</script>`);
}
const TYPES: Record<string, string> = { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".woff": "font/woff", ".svg": "image/svg+xml", ".png": "image/png" };

// ---- routes --------------------------------------------------------------

const json = (res: ServerResponse, data: unknown, code = 200) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(data));
// At most 64 MB (a message with pasted images is the biggest thing the page sends).
const BODY_MAX = 64 << 20;
const readBody = (req: IncomingMessage) => new Promise<any>((ok, fail) => {
  const parts: Buffer[] = [];
  let size = 0;
  req.on("data", (c: Buffer) => {
    size += c.length;
    if (size > BODY_MAX) { fail(new Error("request too large")); req.destroy(); return; }
    parts.push(c);
  });
  req.on("end", () => { try { const b = Buffer.concat(parts).toString("utf8"); ok(b ? JSON.parse(b) : {}); } catch (e) { fail(e); } });
  req.on("error", fail);
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

// Project search, for the page's Ctrl+Shift+F: ripgrep, at most ~500 hits.
async function search(q: string, caseSensitive: boolean, regex: boolean) {
  if (!q) return [];
  const a = ["--json", "--max-count", "50", "--max-columns", "300", caseSensitive ? "--case-sensitive" : "--smart-case"];
  if (!regex) a.push("--fixed-strings");
  // exit 1 = no match: the output is used either way
  const out = await new Promise<string>((done) => { execFile("rg", [...a, "--", q, "."], { cwd: root, encoding: "utf8", maxBuffer: 64 << 20 }, (_e, o) => done(String(o ?? ""))).stdin?.end(); });
  const hits: { path: string; line: number; col: number; text: string }[] = [];
  for (const l of out.split("\n")) {
    if (hits.length >= 500) break;
    if (!l.startsWith('{"type":"match"')) continue;
    try {
      const d = JSON.parse(l).data, text: string = d.lines.text ?? "";
      const at = d.submatches?.[0]?.start ?? 0;
      hits.push({ path: String(d.path.text).replace(/^\.\//, ""), line: d.line_number, col: Buffer.from(text).subarray(0, at).toString().length + 1, text: text.replace(/\n$/, "") });
    } catch {}
  }
  return hits;
}

// The desktop's look, so the page can match the apps around it (GNOME): the accent color and
// which window buttons go where. Read once; null fields when it isn't GNOME.
let look: { accent: string | null; buttons: string | null } | null = null;
function desktopLook() {
  if (look) return look;
  const get = (schema: string, key: string) => {
    try { return execFileSync("gsettings", ["get", schema, key], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).trim().replace(/^'|'$/g, ""); }
    catch { return null; }
  };
  return (look = { accent: get("org.gnome.desktop.interface", "accent-color"), buttons: get("org.gnome.desktop.wm.preferences", "button-layout") });
}

const routes: Record<string, Handler> = {
  "GET /": (_req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page()),
  "GET /api/events": (req, res) => events(req, res, { type: "full", state: current }, (send) => { pages.add(send); return () => pages.delete(send); }),
  "GET /api/state": (_req, res) => json(res, current),
  // The desktop app's recent projects (it writes them: desktop/src/main.rs), for "Open Folder".
  "GET /api/recent": (_req, res) => {
    const f = join(process.env.XDG_CONFIG_HOME || join(process.env.HOME ?? "", ".config"), "cockpit", "recent-projects");
    let paths: string[] = [];
    try { paths = readFileSync(f, "utf8").split("\n").filter((p) => p && p !== root && existsSync(p)); } catch {}
    json(res, paths.slice(0, 10).map((path) => ({ path, name: path.split("/").pop() })));
  },
  "GET /api/file": async (_req, res, url) => { try { json(res, await readSource(q(url, "path"), q(url, "review") === "1")); } catch (e) { json(res, { error: String(e) }, 400); } },
  "GET /api/git/graph": async (_req, res) => json(res, await git.graph()),
  "GET /api/git/numstat": async (_req, res) => json(res, await git.numstat()),
  // Run the guardrails' checks now (all, or `ids`); the results arrive with the live state.
  "POST /api/guardrails/run": post(({ ids }) => {
    const { g } = loadGuardrails(root);
    if (!g) return { error: "no .cockpit/guardrails.json" };
    void runChecks(root, name, g, Array.isArray(ids) ? ids : undefined, () => changed());
    return { ok: true };
  }),
  "POST /api/git/stage": post(async ({ paths }) => { await git.stage(paths, true); await recompute(); }),
  "POST /api/git/unstage": post(async ({ paths }) => { await git.stage(paths, false); await recompute(); }),
  "POST /api/git/discard": post(async ({ paths }) => { await git.discard(paths); await recompute(); }),
  "POST /api/git/switch": post(async (body) => { const r = await git.switchTo(body ?? {}); await recompute(); return r; }),
  "POST /api/git/commit": post(async ({ message }) => { const r = await git.commit(message); await recompute(); return r; }),
  "GET /api/git/diff": async (_req, res, url) => json(res, await git.fileDiff(q(url, "path"), q(url, "staged") === "1")),
  "GET /api/git/commit": async (_req, res, url) => { try { json(res, await git.commitPatch(q(url, "sha"))); } catch (e: any) { json(res, { error: e.message }, 400); } },
  // A web link (from the chat, say) in your browser: the desktop app's window can't open one itself.
  // Another project of the workspace, in its own window of the desktop app.
  "POST /api/workspace/open": post(({ path }) => {
    const p = workspaceOf(root)?.projects.find((x) => x.path === path && !x.here);
    if (!p) throw new Error("not a project of this workspace");
    const local = join(process.env.HOME ?? "", ".local", "bin", "cockpit");
    const app = existsSync(local) ? local : "cockpit";
    return new Promise((done, fail) => {
      const c = spawn(app, [p.path], { detached: true, stdio: "ignore" });
      c.on("error", () => fail(new Error(`the desktop app isn't installed (desktop/install.sh); in a browser, run: npm run serve -- ${p.path}`)));
      c.on("spawn", () => { c.unref(); done({ ok: true }); });
    });
  }),
  "GET /api/search": async (_req, res, url) => json(res, await search(q(url, "q"), q(url, "case") === "1", q(url, "regex") === "1")),
  "POST /api/file/save": post(({ path, text, hash, force }) => saveSource(path, text, hash, !!force)),
  "POST /api/open-url": post(({ url }) => {
    if (typeof url !== "string" || !/^https?:\/\//.test(url)) throw new Error("expected an http(s) link");
    const [cmd, ...args] = process.platform === "darwin" ? ["open"] : process.platform === "win32" ? ["cmd", "/c", "start", ""] : ["xdg-open"];
    spawn(cmd, [...args, url], { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
  }),
  "POST /api/diagram-layout": post(({ id, positions }) => {
    if (typeof id !== "string" || (positions !== null && typeof positions !== "object")) throw new Error("expected {id, positions}");
    const all = readDLayout();
    if (positions) all[id] = positions; else delete all[id];
    mkdirSync(join(root, ARCH_DIR), { recursive: true });
    writeFileSync(dlayoutPath, JSON.stringify(all, null, 1) + "\n");
  }),

  // review mode
  "GET /api/review/mrs": async (_req, res) => json(res, await review.mergeRequests()),
  "GET /api/git/mr": async (_req, res, url) => { const h = await git.head(); json(res, h.branch ? await review.branchMr(h.branch + "@" + h.head, q(url, "fresh") === "1") : { mr: null }); },
  "GET /api/review/branches": async (_req, res) => json(res, await review.branches()),
  "POST /api/review/start": post(async (body) => { const r = await review.start(body ?? {}); await recompute(); return r; }),
  // .cockpit/ kept private and synced (private.ts)
  "POST /api/private/enable": post(async () => { await priv.enable(); await recompute(); }),
  "POST /api/private/disable": post(async () => { priv.disable(); await recompute(); }),
  "POST /api/private/sync": post(async () => { await priv.sync(); await recompute(); }),
  "POST /api/review/stop": post(async ({ back }) => { await review.stop(!!back); await recompute(); }),

  // the agent chat
  "GET /api/chat/events": (req, res) => events(req, res, { type: "init", ...chat.snapshot() }, chat.subscribe),
  "GET /api/chat/sessions": async (_req, res) => json(res, await chat.sessions()),
  "GET /api/chat/usage": async (_req, res) => json(res, await chat.usage()),
  "POST /api/chat/send": post(({ text, images = [] }) => {
    if (typeof text !== "string") throw new Error("expected text");
    if (!Array.isArray(images) || !images.every((i) => i && IMAGE_TYPES.includes(i.media) && typeof i.data === "string" && typeof i.thumb === "string")) throw new Error("images: expected { media, data, thumb } (png, jpeg, gif or webp)");
    chat.send(text, images);
  }),
  "POST /api/chat/answer": post(({ id, allow }) => chat.answer(String(id), !!allow)),
  "POST /api/chat/stop": post(() => chat.stop()),
  "POST /api/chat/model": post(({ model }) => chat.setModel(String(model))),
  "POST /api/chat/new": post(() => chat.reset()),
  "POST /api/chat/open": post(({ id }) => chat.open(String(id))),
  "POST /api/chat/delete": post(({ id }) => chat.remove(String(id))),

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
  const pass = auth.check(req, url);
  if (pass === "login") {
    url.searchParams.delete("token");
    return res.writeHead(303, { "set-cookie": auth.cookie, location: url.pathname + url.search, "cache-control": "no-store" }).end();
  }
  if (pass === "refused") return res.writeHead(401, { "content-type": "text/html; charset=utf-8" })
    .end(`<!doctype html><meta charset=utf-8><body style="font:14px monospace;padding:30px">Open cockpit from the desktop app, or with the link the server printed when it started (it ends in <b>?token=…</b>).`);
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
// Language servers for the editor (web/src/lib/lsp.svelte.ts): one process per page connection,
// in the project folder, killed when the page goes. LSP frames (Content-Length headers) on the
// process side, one JSON message per WebSocket message on the page side. A missing server closes
// with 4404 and the editor carries on without it.
const LSP: Record<string, string[]> = {
  rust: ["rust-analyzer"],
  typescript: ["typescript-language-server", "--stdio"],
  python: ["pyright-langserver", "--stdio"],
  zig: ["zls"],
  c: ["clangd"],
};
const lspProcs = new Set<ReturnType<typeof spawn>>();
function lsp(ws: import("ws").WebSocket, lang: string) {
  const cmd = LSP[lang];
  if (!cmd) { ws.close(4404, "no language server for " + lang); return; }
  const p = spawn(cmd[0], cmd.slice(1), { cwd: root, stdio: ["pipe", "pipe", "ignore"] });
  lspProcs.add(p);
  let buf = Buffer.alloc(0);
  p.stdout!.on("data", (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) return;
      const m = /content-length:\s*(\d+)/i.exec(buf.subarray(0, end).toString());
      if (!m) { buf = buf.subarray(end + 4); continue; }
      const len = +m[1];
      if (buf.length < end + 4 + len) return;
      const body = buf.subarray(end + 4, end + 4 + len).toString("utf8");
      buf = buf.subarray(end + 4 + len);
      if (ws.readyState === ws.OPEN) ws.send(body);
    }
  });
  p.on("error", () => { lspProcs.delete(p); ws.close(4404, cmd[0] + " not found"); });
  p.on("exit", () => { lspProcs.delete(p); if (ws.readyState === ws.OPEN) ws.close(4000, cmd[0] + " exited"); });
  p.stdin!.on("error", () => {});
  ws.on("message", (raw) => {
    const body = Buffer.from(String(raw), "utf8");
    if (p.stdin!.writable) p.stdin!.write(`Content-Length: ${body.length}\r\n\r\n`), p.stdin!.write(body);
  });
  ws.on("close", () => { p.kill(); });
}
server.on("upgrade", (req, sock, head) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (!["/api/term/ws", "/api/lsp"].includes(url.pathname) || auth.check(req, url) !== "ok" || !sameOrigin(req) || !req.headers.origin) { sock.destroy(); return; }
  wss.handleUpgrade(req, sock, head, (ws) => url.pathname === "/api/lsp" ? lsp(ws, url.searchParams.get("lang") ?? "") : terms.attach(ws, url.searchParams.get("id") ?? ""));
});
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => { terms.closeAll(); chat.close(); for (const p of lspProcs) p.kill(); process.exit(0); });
server.listen(port, host, () =>
  console.log(`serving ${name} on ${auth.link(host === "0.0.0.0" || host === "::" ? hostname() : host)}`),
);
