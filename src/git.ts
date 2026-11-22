// Git for one project, run as child processes. Reads are async and run side by side, so a large
// repo doesn't stall the server (the terminals, the chat stream and the editor's language servers
// share its one thread). The parsers are pure functions, tested on their own (test/git.test.ts).

import { execFile } from "node:child_process";

export type Status = { x: string; y: string; path: string };
export type Hunk = { at: number; added: number; removed: string[] };
export type Lines = Record<string, [number, number][]>;

// `git status --porcelain=v1 -z`: XY path, X = staged, Y = unstaged; "??" = untracked. A rename
// or copy is followed by its source path, which is skipped.
export function parseStatus(z: string): Status[] {
  return z.split("\0").filter(Boolean).flatMap((e, i, arr) => {
    if (i > 0 && /^R|^C/.test(arr[i - 1] ?? "") && !/^.. /.test(e)) return [];
    return [{ x: e[0], y: e[1], path: e.slice(3) }];
  });
}

// `git diff --numstat`: lines added and removed per file (binary files count as -1). A rename is
// "old => new" or "dir/{old => new}/rest": the new path is kept.
export function parseNumstat(out: string) {
  const r: Record<string, [number, number]> = {};
  const newPath = (p: string) => p.includes("{") ? p.replace(/\{[^{}]* => ([^{}]*)\}/, "$1").replace(/\/\//g, "/") : p.replace(/^.* => /, "");
  for (const l of out.split("\n")) {
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/.exec(l);
    if (m) r[newPath(m[3])] = [m[1] === "-" ? -1 : +m[1], m[2] === "-" ? -1 : +m[2]];
  }
  return r;
}

// One file's `git diff -U0` as hunks over the current text: lines added or changed, and the old
// lines removed at each place.
export function parseHunks(diff: string): Hunk[] {
  const out: Hunk[] = [];
  for (const l of diff.split("\n")) {
    const m = l.match(/^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (m) out.push({ at: +m[2] + (m[3] === "0" ? 1 : 0), added: m[3] === undefined ? 1 : +m[3], removed: [] });
    else if (out.length && l.startsWith("-") && !l.startsWith("---")) out.at(-1)!.removed.push(l.slice(1));
  }
  return out;
}

// A whole `git diff -U0`: the changed line ranges per file, in new-file line numbers. A hunk that
// only removes lines marks the line just after the removal.
export function parseChangedLines(diff: string): Lines {
  const out: Lines = {};
  let file = "";
  for (const l of diff.split("\n")) {
    if (l.startsWith("+++ ")) file = l.startsWith("+++ b/") ? l.slice(6) : "";
    const m = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (m && file) {
      const start = +m[1], n = m[2] === undefined ? 1 : +m[2];
      (out[file] ??= []).push([start, start + Math.max(n, 1) - 1]);
    }
  }
  return out;
}

export const GRAPH_FORMAT = "%H%x1f%P%x1f%h%x1f%s%x1f%an%x1f%aI%x1f%D";
export function parseGraph(out: string) {
  return out.split("\n").filter(Boolean).map((l) => {
    const [hash, parents, sha, subject, author, date, refs] = l.split("\x1f");
    return { hash, parents: parents ? parents.split(" ") : [], sha, subject, author, date, refs: refs ? refs.split(", ").filter((r) => !r.startsWith("refs/cockpit")) : [] };
  });
}

const SHA = /^[0-9a-f]{4,40}$/i;
const strings = (paths: unknown): string[] => {
  if (!Array.isArray(paths) || !paths.length || !paths.every((p) => typeof p === "string")) throw new Error("expected paths");
  return paths;
};

export function createGit(root: string) {
  // No optional locks: `git status` must not rewrite .git/index, which the server's watcher follows.
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
  // Git whose failure means "nothing": its output even when it fails (a diff before the first commit).
  const read = (...a: string[]) => new Promise<string>((done) => {
    const c = execFile("git", a, { cwd: root, encoding: "utf8", maxBuffer: 64 << 20, env }, (_e, out) => done(String(out ?? "").trimEnd()));
    c.stdin?.end();
  });
  // Git that must work (staging, committing): fails with git's own message.
  const run = (args: string[], input?: string) => new Promise<string>((done, fail) => {
    const c = execFile("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 << 20 }, (e, out, err) =>
      e ? fail(new Error(String(err || out || e.message).trim().split("\n").slice(-6).join("\n"))) : done(String(out).trimEnd()));
    c.stdin?.end(input);
  });

  const status = async () => parseStatus(await read("status", "--porcelain=v1", "-z", "--untracked-files=all"));

  // Tracked and untracked files, not ignored ones; `alsoIgnored` folders are listed even when
  // ignored (.cockpit/ kept out of git, private.ts).
  async function files(alsoIgnored: string) {
    const [listed, kept] = await Promise.all([
      read("ls-files", "--cached", "--others", "--exclude-standard"),
      read("ls-files", "--others", "--ignored", "--exclude-standard", "--", alsoIgnored),
    ]);
    return [...new Set([...listed.split("\n"), ...kept.split("\n").filter((f) => !f.includes("/node_modules/"))])].filter(Boolean).sort();
  }

  async function head() {
    const [branch, upstream, sha] = await Promise.all([
      read("symbolic-ref", "--short", "-q", "HEAD"),
      read("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"),
      read("rev-parse", "--short", "HEAD"),
    ]);
    const [behind, ahead] = upstream ? (await read("rev-list", "--left-right", "--count", "@{u}...HEAD")).split(/\s+/).map(Number) : [0, 0];
    return { branch: branch || null, head: sha, upstream: upstream || null, ahead, behind };
  }

  // Lines changed but not committed (or since `against`), per file; an untracked file is all new.
  async function changedLines(st: Status[], against = "HEAD") {
    const out = parseChangedLines(await read("diff", against, "-U0", "--no-color", "--no-ext-diff"));
    for (const s of st) if (s.x === "?") out[s.path] = [[1, 1e9]];
    return out;
  }

  async function hunks(path: string, untracked: boolean, against = "HEAD"): Promise<Hunk[]> {
    if (untracked) return [{ at: 1, added: 1e9, removed: [] }];
    return parseHunks(await read("diff", against, "-U0", "--no-color", "--no-ext-diff", "--", path));
  }

  // Staging from the git tab. Only paths git reports as changed.
  async function stage(paths: unknown, on: boolean) {
    const ps = strings(paths);
    const known = new Set((await status()).map((s) => s.path));
    const bad = ps.filter((p) => !known.has(p));
    if (bad.length) throw new Error("not changed: " + bad.join(", "));
    if (on) await run(["add", "-A", "--", ...ps]);
    else if (await read("rev-parse", "-q", "--verify", "HEAD")) await run(["restore", "--staged", "--", ...ps]);
    else await run(["rm", "-r", "-q", "--cached", "--", ...ps]); // no commit yet
  }

  // Reverting from the git tab: a file's unstaged changes go back to what is staged (or
  // committed); an untracked file is deleted (git clean). Only paths with unstaged changes.
  async function discard(paths: unknown) {
    const ps = strings(paths);
    const st = new Map((await status()).filter((s) => s.y !== " ").map((s) => [s.path, s]));
    const bad = ps.filter((p) => !st.has(p));
    if (bad.length) throw new Error("no unstaged changes: " + bad.join(", "));
    const untracked = ps.filter((p) => st.get(p)!.y === "?"), tracked = ps.filter((p) => st.get(p)!.y !== "?");
    if (tracked.length) await run(["restore", "--worktree", "--", ...tracked]);
    if (untracked.length) await run(["clean", "-f", "-q", "--", ...untracked]);
  }

  // Switching from the history's right-click menu: to a branch (a remote one gets a local branch
  // tracking it), or to a commit, detached. Only refs git lists; git itself refuses when local
  // changes would be overwritten.
  async function switchTo({ ref, sha }: { ref?: unknown; sha?: unknown }) {
    if (typeof sha === "string") {
      if (!SHA.test(sha)) throw new Error("not a commit");
      await run(["switch", "-q", "--detach", sha]);
      return {};
    }
    if (typeof ref !== "string") throw new Error("expected a branch");
    const [local, remote] = (await Promise.all([
      read("for-each-ref", "--format=%(refname:short)", "refs/heads"),
      read("for-each-ref", "--format=%(refname:short)", "refs/remotes"),
    ])).map((o) => o.split("\n"));
    if (local.includes(ref)) { await run(["switch", "-q", ref]); return {}; }
    if (!remote.includes(ref) || !ref.includes("/")) throw new Error(`no branch ${ref}`);
    const name = ref.slice(ref.indexOf("/") + 1);
    if (local.includes(name)) throw new Error(`a local ${name} exists already, at another commit: switch to it, then pull`);
    await run(["switch", "-q", "-c", name, "--track", ref]);
    return { note: `new local branch ${name}, tracking ${ref}` };
  }

  async function commit(message: unknown) {
    if (typeof message !== "string" || !message.trim()) throw new Error("write a commit message");
    if (!(await status()).some((s) => s.x !== " " && s.x !== "?")) throw new Error("nothing staged");
    await run(["commit", "-q", "-F", "-"], message.trim() + "\n");
    return { head: await read("rev-parse", "--short", "HEAD") };
  }

  async function numstat() {
    const [staged, unstaged] = await Promise.all([read("diff", "--cached", "--numstat"), read("diff", "--numstat")]);
    return { staged: parseNumstat(staged), unstaged: parseNumstat(unstaged) };
  }

  // Commits of all branches, newest first, with parents: the page draws the graph.
  const graph = async () => parseGraph(await read("log", "--branches", "--remotes", "--tags", "--topo-order", "-n", "200", `--format=${GRAPH_FORMAT}`));

  // A changed file's diff: staged (the index against HEAD), or not (the working tree against the
  // index; an untracked file shows whole, as added). Only for files git reports as changed.
  async function fileDiff(path: string, staged: boolean) {
    const st = (await status()).find((s) => s.path === path);
    if (!st) return { path, staged, patch: "", note: "no changes" };
    const patch = staged ? await read("diff", "--cached", "--no-color", "--no-ext-diff", "--", path)
      : st.x === "?" ? await read("diff", "--no-index", "--no-color", "--no-ext-diff", "--", "/dev/null", path)
      : await read("diff", "--no-color", "--no-ext-diff", "--", path);
    return { path, staged, patch, note: patch ? undefined : "no changes" + (staged ? " staged" : " outside the index") };
  }

  async function commitPatch(sha: string) {
    if (!SHA.test(sha)) throw new Error("bad sha");
    const [meta, ...rest] = (await read("show", "--format=%H%x1f%s%x1f%an%x1f%aI%x1f%b%x1e", "--patch", sha)).split("\x1e");
    const [full, subject, author, date, body] = meta.split("\x1f");
    return { sha: full, subject, author, date, body: (body ?? "").trim(), patch: rest.join("\x1e").replace(/^\n+/, "") };
  }

  return { read, run, status, files, head, changedLines, hunks, stage, discard, switchTo, commit, numstat, graph, fileDiff, commitPatch };
}

export type Git = ReturnType<typeof createGit>;
