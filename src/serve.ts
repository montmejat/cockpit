// The cockpit server for one project: serves the page (web/, built with Vite) and its data, runs
// the agent chat and the terminals, and pushes what changes as it changes.
//   npm run serve -- <project dir> [--port 4173] [--host 127.0.0.1]
// --host 0.0.0.0 makes it reachable from other machines on the network (no login).

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { WebSocketServer } from "ws";
import { ARCH_DIR, checkArch, loadArch } from "./arch.ts";
import { createChat } from "./chat.ts";
import { createIndex } from "./codeindex.ts";
import { itemKey, type Skeleton } from "./skeleton.ts";
import { COCKPIT, outDir, turnsDir, type Turn } from "./turns.ts";
import { createTerminals } from "./term.ts";
import { createAsk } from "./ask.ts";
import { createReview } from "./review.ts";
import { createPrivate } from "./private.ts";
import { workspaceOf } from "./workspace.ts";
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

// No optional locks: `git status` must not rewrite .git/index, which the watcher below follows.
const tryGit = (...a: string[]) => {
  try {
    return execFileSync("git", a, { cwd: root, encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }).trimEnd();
  } catch (e: any) { return String(e.stdout ?? "").trimEnd(); }
};

// Git that must work: throws with git's own message (for staging and committing from the page).
const runGit = (args: string[], input?: string) => {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 << 20, input, stdio: [input == null ? "ignore" : "pipe", "pipe", "pipe"] }).trimEnd();
  } catch (e: any) { throw new Error(String(e.stderr || e.stdout || e.message).trim().split("\n").slice(-6).join("\n")); }
};

// ---- files ---------------------------------------------------------------

// .cockpit/ is listed even when it is kept out of git (private.ts).
const listFiles = () => [...new Set([
  ...tryGit("ls-files", "--cached", "--others", "--exclude-standard").split("\n"),
  ...tryGit("ls-files", "--others", "--ignored", "--exclude-standard", "--", ARCH_DIR).split("\n").filter((f) => !f.includes("/node_modules/")),
])].filter(Boolean).sort();
const isProjectFile = (path: string) => {
  const full = resolve(root, path);
  return full.startsWith(root + sep) && listFiles().includes(path);
};

// What changed in a file since the last commit (or since `against`, in review mode), as hunks over
// the current text: lines added or changed, and the old lines removed at each place. The page
// draws them in the file itself.
type Hunk = { at: number; added: number; removed: string[] };
function hunksOf(path: string, untracked: boolean, against = "HEAD"): Hunk[] {
  if (untracked) return [{ at: 1, added: 1e9, removed: [] }]; // all new
  const out: Hunk[] = [];
  for (const l of tryGit("diff", against, "-U0", "--no-color", "--no-ext-diff", "--", path).split("\n")) {
    const m = l.match(/^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (m) out.push({ at: +m[2] + (m[3] === "0" ? 1 : 0), added: m[3] === undefined ? 1 : +m[3], removed: [] });
    else if (out.length && l.startsWith("-") && !l.startsWith("---")) out.at(-1)!.removed.push(l.slice(1));
  }
  return out;
}
function readSource(path: string, inReview = false) {
  const base = inReview ? reviewBase() : null;
  if (base && !isProjectFile(path) && tryGit("cat-file", "-t", `${base}:${path}`) === "blob")
    return { path, text: null, note: "deleted in this review", hunks: [] };
  if (!isProjectFile(path)) throw new Error("not a project file");
  const full = resolve(root, path);
  if (statSync(full).size > 1 << 20) return { path, text: null, note: "file larger than 1 MB", hunks: [] };
  const text = readFileSync(full, "utf8");
  if (text.includes("\u0000")) return { path, text: null, note: "binary file", hunks: [] };
  const st = gitStatus().find((s) => s.path === path);
  const hash = hashOf(text); // what the editor saves against
  if (base) return { path, text, hash, hunks: hunksOf(path, st?.x === "?", base) };
  return { path, text, hash, hunks: st ? hunksOf(path, st.x === "?") : [] };
}
const hashOf = (text: string) => createHash("sha1").update(text).digest("hex");

// Saving from the editor. Only a project file, only inside the project (a symlink pointing out is
// refused), and only if the file is still what the editor loaded (`hash`): when an agent changed it
// meanwhile, the save is refused with the file as it is now, and the page asks you what to keep.
// `force` overwrites anyway.
function saveSource(path: string, text: string, hash: string, force = false) {
  if (typeof path !== "string" || typeof text !== "string") throw new Error("expected path and text");
  if (!isProjectFile(path)) throw new Error("not a project file");
  const full = resolve(root, path);
  if (!realpathSync(full).startsWith(realpathSync(root) + sep)) throw new Error("outside the project");
  const now = readFileSync(full, "utf8");
  if (!force && hashOf(now) !== hash) return { conflict: true, text: now, hash: hashOf(now) };
  writeFileSync(full, text);
  return { ok: true, hash: hashOf(text) };
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
// Staging and committing from the git tab. Only paths git reports as changed can be (un)staged.
function stagePaths(paths: unknown, stage: boolean) {
  if (!Array.isArray(paths) || !paths.length || !paths.every((p) => typeof p === "string")) throw new Error("expected paths");
  const known = new Set(gitStatus().map((s) => s.path));
  const bad = (paths as string[]).filter((p) => !known.has(p));
  if (bad.length) throw new Error("not changed: " + bad.join(", "));
  if (stage) runGit(["add", "-A", "--", ...(paths as string[])]);
  else if (tryGit("rev-parse", "-q", "--verify", "HEAD")) runGit(["restore", "--staged", "--", ...(paths as string[])]);
  else runGit(["rm", "-r", "-q", "--cached", "--", ...(paths as string[])]); // no commit yet
}
// Switching from the history's right-click menu: to a branch (a remote one gets a local branch
// tracking it), or to a commit, detached. Only refs git lists; git itself refuses when local
// changes would be overwritten.
function switchTo({ ref, sha }: { ref?: unknown; sha?: unknown }) {
  if (typeof sha === "string") {
    if (!/^[0-9a-f]{4,40}$/i.test(sha)) throw new Error("not a commit");
    runGit(["switch", "-q", "--detach", sha]);
    return {};
  }
  if (typeof ref !== "string") throw new Error("expected a branch");
  const local = tryGit("for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n");
  if (local.includes(ref)) { runGit(["switch", "-q", ref]); return {}; }
  const remote = tryGit("for-each-ref", "--format=%(refname:short)", "refs/remotes").split("\n");
  if (!remote.includes(ref) || !ref.includes("/")) throw new Error(`no branch ${ref}`);
  const name = ref.slice(ref.indexOf("/") + 1);
  if (local.includes(name)) throw new Error(`a local ${name} exists already, at another commit: switch to it, then pull`);
  runGit(["switch", "-q", "-c", name, "--track", ref]);
  return { note: `new local branch ${name}, tracking ${ref}` };
}
function commitStaged(message: unknown) {
  if (typeof message !== "string" || !message.trim()) throw new Error("write a commit message");
  if (!gitStatus().some((s) => s.x !== " " && s.x !== "?")) throw new Error("nothing staged");
  runGit(["commit", "-q", "-F", "-"], message.trim() + "\n");
  return { head: tryGit("rev-parse", "--short", "HEAD") };
}
// Lines added and removed per file, staged and not (binary files count as -1).
function numstat() {
  const parse = (out: string) => {
    const r: Record<string, [number, number]> = {};
    // A rename is "old => new" or "dir/{old => new}/rest": keep the new path.
    const newPath = (p: string) => p.includes("{") ? p.replace(/\{[^{}]* => ([^{}]*)\}/, "$1").replace(/\/\//g, "/") : p.replace(/^.* => /, "");
    for (const l of out.split("\n")) { const m = /^(-|\d+)\t(-|\d+)\t(.*)$/.exec(l); if (m) r[newPath(m[3])] = [m[1] === "-" ? -1 : +m[1], m[2] === "-" ? -1 : +m[2]]; }
    return r;
  };
  return { staged: parse(tryGit("diff", "--cached", "--numstat")), unstaged: parse(tryGit("diff", "--numstat")) };
}

// Commits of all branches, newest first, with parents: the page draws the graph.
function gitGraph() {
  return tryGit("log", "--branches", "--remotes", "--tags", "--topo-order", "-n", "200", "--format=%H%x1f%P%x1f%h%x1f%s%x1f%an%x1f%aI%x1f%D")
    .split("\n").filter(Boolean).map((l) => {
      const [hash, parents, sha, subject, author, date, refs] = l.split("\x1f");
      return { hash, parents: parents ? parents.split(" ") : [], sha, subject, author, date, refs: refs ? refs.split(", ").filter((r) => !r.startsWith("refs/cockpit")) : [] };
    });
}
// A changed file's diff, for the Git tab: staged (the index against HEAD), or not staged (the
// working tree against the index; an untracked file shows whole, as added). Only for files git
// reports as changed.
function fileDiff(path: string, staged: boolean) {
  const st = gitStatus().find((s) => s.path === path);
  if (!st) return { path, staged, patch: "", note: "no changes" };
  const patch = staged ? tryGit("diff", "--cached", "--no-color", "--no-ext-diff", "--", path)
    : st.x === "?" ? tryGit("diff", "--no-index", "--no-color", "--no-ext-diff", "--", "/dev/null", path)
    : tryGit("diff", "--no-color", "--no-ext-diff", "--", path);
  return { path, staged, patch, note: patch ? undefined : "no changes" + (staged ? " staged" : " outside the index") };
}

function commitPatch(sha: string) {
  const [meta, ...rest] = tryGit("show", "--format=%H%x1f%s%x1f%an%x1f%aI%x1f%b%x1e", "--patch", sha).split("\x1e");
  const [full, subject, author, date, body] = meta.split("\x1f");
  return { sha: full, subject, author, date, body: (body ?? "").trim(), patch: rest.join("\x1e").replace(/^\n+/, "") };
}

// ---- what is changing ----------------------------------------------------

// Lines changed but not committed (or since `against`), per file (new-file line numbers), from
// the working diff.
function changedLines(status: ReturnType<typeof gitStatus>, against = "HEAD"): Record<string, [number, number][]> {
  const out: Record<string, [number, number][]> = {};
  let file = "";
  for (const l of tryGit("diff", against, "-U0", "--no-color", "--no-ext-diff").split("\n")) {
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
const reviewBase = () => { const r = review.current(); return r ? tryGit("merge-base", "HEAD", r.target) || null : null; };

// The diagrams as the target had them, by commit (they never change for a given commit).
// null when the target has no .cockpit/ (not committed, or kept out of git): nothing to compare.
const baseDiagrams = new Map<string, Map<string, { question: string; nodes: Map<string, string> }> | null>();
function diagramsAt(base: string) {
  // .cockpit/ kept private: the description saved at (or nearest before) the base, from the store.
  const kept = tryGit("cat-file", "-t", `${base}:${ARCH_DIR}/project.json`) === "blob" ? null : priv.at(base);
  const key = kept ? base + "@" + kept : base;
  if (!baseDiagrams.has(key)) {
    const arch = kept ? loadArch(root, kept, priv.store).arch : loadArch(root, base).arch;
    baseDiagrams.set(key, arch ? new Map(arch.diagrams.map((d) => [d.id, { question: d.question, nodes: new Map(d.nodes.map((n) => [n.id, n.label])) }])) : null);
  }
  return baseDiagrams.get(key)!;
}

// What the review changes: files and items (committed on the branch or not), and the diagrams'
// own boxes added and removed.
function reviewState(sk: Skeleton, status: ReturnType<typeof gitStatus>, diagrams: { id: string; question: string; nodes: { id: string; label: string }[] }[]) {
  const r = review.current();
  if (!r) return null;
  const base = reviewBase();
  if (!base) return { ...r, base: null, error: `${r.target} and this branch share no history`, files: [], changedFiles: [], changedItems: [], impacted: [], commits: 0, diagrams: {}, removedDiagrams: [] };
  const lines = changedLines(status, base);
  const files: { path: string; st: string }[] = tryGit("diff", "--name-status", "--no-renames", base).split("\n").filter(Boolean)
    .map((l) => { const [st, path] = l.split("\t"); return { path, st: st[0] }; });
  for (const s of status) if (s.x === "?" && !files.some((f) => f.path === s.path)) files.push({ path: s.path, st: "A" });
  files.sort((a, b) => a.path.localeCompare(b.path));
  const before = diagramsAt(base), diff: Record<string, { isNew: boolean; added: string[]; removed: { id: string; label: string }[] }> = {};
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
    ...r, base: tryGit("rev-parse", "--short", base), error: null,
    commits: Number(tryGit("rev-list", "--count", `${base}..HEAD`)) || 0,
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

function state() {
  const sk = index.current();
  const loaded = loadArch(root), arch = loaded.arch;
  const status = gitStatus(), files = listFiles();
  const lines = changedLines(status);
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
    git: gitHead(),
    lines: sk.modules.reduce((s, m) => s + m.lines, 0),
    features: arch?.features ?? [],
    tests: testsOf(sk, files),
    summary: arch?.summary ?? "",
    review: reviewState(sk, status, arch?.diagrams ?? []),
    workspace: workspaceState(),
    guardrails: guardrailsState(),
    private: priv.state(),
  };
}
type State = ReturnType<typeof state>;

// ---- live: watch the project, push the parts that changed ----------------------------

priv.tick();
let current: State = state();
let currentJson: Record<string, string> = Object.fromEntries(Object.entries(current).map(([k, v]) => [k, JSON.stringify(v)]));
const pages = new Set<(e: unknown) => void>();

// Big lists go out as the entries that changed, by key: a large project's modules and tests are
// ~1 MB and an edit shifts the lines of one file only. Sending them whole on every save stalled
// the page (WebKit reads the event stream on its main thread) for 100-180 ms.
type ListPatch = { set: unknown[]; del: string[]; keys?: string[] };
function listPatch<T>(before: T[], after: T[], key: (x: T) => string): ListPatch {
  const old = new Map(before.map((x) => [key(x), JSON.stringify(x)]));
  const set = after.filter((x) => old.get(key(x)) !== JSON.stringify(x));
  const now = new Set(after.map(key)), del = [...old.keys()].filter((k) => !now.has(k));
  const same = !del.length && !set.some((x) => !old.has(key(x)));
  return same ? { set, del } : { set, del, keys: after.map(key) };
}
const unitKey = (u: State["tests"]["unit"][number]) => u.module + "\0" + u.file;
function recompute() {
  const next = state(), patch: Record<string, unknown> = {}, lists: Record<string, ListPatch> = {};
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
  debounce = setTimeout(() => { debounce = null; try { priv.tick(); recompute(); syncWatchers(); } catch (e) { console.error("state:", e); } }, 150);
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

// Project search, for the page's Ctrl+Shift+F: ripgrep, at most ~500 hits.
function search(q: string, caseSensitive: boolean, regex: boolean) {
  if (!q) return [];
  const a = ["--json", "--max-count", "50", "--max-columns", "300", caseSensitive ? "--case-sensitive" : "--smart-case"];
  if (!regex) a.push("--fixed-strings");
  let out = "";
  try { out = execFileSync("rg", [...a, "--", q, "."], { cwd: root, encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "ignore"] }); }
  catch (e: any) { out = String(e.stdout ?? ""); } // exit 1 = no match
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
  "GET /api/file": (_req, res, url) => { try { json(res, readSource(q(url, "path"), q(url, "review") === "1")); } catch (e) { json(res, { error: String(e) }, 400); } },
  "GET /api/git/graph": (_req, res) => json(res, gitGraph()),
  "GET /api/git/numstat": (_req, res) => json(res, numstat()),
  // Run the guardrails' checks now (all, or `ids`); the results arrive with the live state.
  "POST /api/guardrails/run": post(({ ids }) => {
    const { g } = loadGuardrails(root);
    if (!g) return { error: "no .cockpit/guardrails.json" };
    void runChecks(root, name, g, Array.isArray(ids) ? ids : undefined, () => changed());
    return { ok: true };
  }),
  "POST /api/git/stage": post(({ paths }) => { stagePaths(paths, true); recompute(); }),
  "POST /api/git/unstage": post(({ paths }) => { stagePaths(paths, false); recompute(); }),
  "POST /api/git/switch": post((body) => { const r = switchTo(body ?? {}); recompute(); return r; }),
  "POST /api/git/commit": post(({ message }) => { const r = commitStaged(message); recompute(); return r; }),
  "GET /api/git/diff": (_req, res, url) => json(res, fileDiff(q(url, "path"), q(url, "staged") === "1")),
  "GET /api/git/commit": (_req, res, url) => (/^[0-9a-f]{4,40}$/.test(q(url, "sha")) ? json(res, commitPatch(q(url, "sha"))) : json(res, { error: "bad sha" }, 400)),
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
  "GET /api/search": (_req, res, url) => json(res, search(q(url, "q"), q(url, "case") === "1", q(url, "regex") === "1")),
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
  "GET /api/git/mr": async (_req, res, url) => { const h = gitHead(); json(res, h.branch ? await review.branchMr(h.branch + "@" + h.head, q(url, "fresh") === "1") : { mr: null }); },
  "GET /api/review/branches": async (_req, res) => json(res, await review.branches()),
  "POST /api/review/start": post(async (body) => { const r = await review.start(body ?? {}); recompute(); return r; }),
  // .cockpit/ kept private and synced (private.ts)
  "POST /api/private/enable": post(async () => { await priv.enable(); recompute(); }),
  "POST /api/private/disable": post(() => { priv.disable(); recompute(); }),
  "POST /api/private/sync": post(async () => { await priv.sync(); recompute(); }),
  "POST /api/review/stop": post(async ({ back }) => { await review.stop(!!back); recompute(); }),

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
  if (!["/api/term/ws", "/api/lsp"].includes(url.pathname) || !sameOrigin(req) || !req.headers.origin) { sock.destroy(); return; }
  wss.handleUpgrade(req, sock, head, (ws) => url.pathname === "/api/lsp" ? lsp(ws, url.searchParams.get("lang") ?? "") : terms.attach(ws, url.searchParams.get("id") ?? ""));
});
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => { terms.closeAll(); for (const p of lspProcs) p.kill(); process.exit(0); });
server.listen(Number(opt("port") ?? 4173), opt("host") ?? "127.0.0.1", () =>
  console.log(`serving ${name} on http://${opt("host") ?? "127.0.0.1"}:${opt("port") ?? 4173}`),
);
