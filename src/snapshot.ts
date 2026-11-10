// Snapshots of a working copy, for diffing what an agent turn changed.
// A snapshot is a git commit of every file (untracked ones included, ignored
// ones not), built with a temporary index. It lives in cockpit's own git store
// (~/.local/share/cockpit/snapshots/<project>-<hash>.git, a bare repo with the project as its work
// tree), so nothing of it lands in the project's .git: no objects, no refs, no
// worktrees. It is kept alive there under refs/cockpit/snap/<hash>.
//
// The store follows the project's .gitignore files and its .git/info/exclude,
// except for .cockpit/: a project that keeps it out of git locally still gets
// it in snapshots, so turns can show what the agent changed there.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { SKELETON_VERSION, type Skeleton } from "./skeleton.ts";
import { detectLang, indexProject, readIndexConfig, skeletonFrom } from "./indexer.ts";
import { STATE } from "./turns.ts";

export const git = (repo: string, args: string[], env: Record<string, string> = {}) =>
  execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, ...env },
    maxBuffer: 256 * 1024 * 1024,
  }).trim();

export function repoRoot(dir: string): string {
  return git(dir, ["rev-parse", "--show-toplevel"]);
}

// cockpit's git store for a project, created on first use. Self-contained (no alternates into
// the project's objects), so the project's own gc can never break it.
export function snapStore(repo: string): string {
  const store = join(STATE, "snapshots", `${basename(repo)}-${createHash("sha1").update(repo).digest("hex").slice(0, 8)}.git`);
  if (!existsSync(join(store, "HEAD"))) {
    mkdirSync(store, { recursive: true });
    execFileSync("git", ["init", "-q", "--bare", store]);
  }
  // The project's local excludes, minus .cockpit/ (see above). Refreshed on every snapshot.
  let exclude = "";
  try {
    const own = join(git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]), "info", "exclude");
    if (existsSync(own)) exclude = readFileSync(own, "utf8").split("\n").filter((l) => !/^\/?\.cockpit\/?\s*$/.test(l.trim())).join("\n");
  } catch {}
  mkdirSync(join(store, "info"), { recursive: true });
  writeFileSync(join(store, "info", "exclude"), exclude);
  return store;
}

// Git on snapshot commits: in cockpit's store, or in the project for snapshots taken before the
// store existed (they were kept under the project's refs/cockpit/snap/).
export function snapGitDir(repo: string, ...revs: string[]): string | undefined {
  const store = snapStore(repo);
  const inStore = revs.every((r) => {
    try { execFileSync("git", ["--git-dir", store, "cat-file", "-e", `${r}^{commit}`], { stdio: "ignore" }); return true; } catch { return false; }
  });
  return inStore ? store : undefined;
}
export const snapGit = (repo: string, revs: string[], args: string[]) => {
  const dir = snapGitDir(repo, ...revs);
  return git(repo, args, dir ? { GIT_DIR: dir, GIT_WORK_TREE: repo } : {});
};

export function snapshot(repo: string, label: string): string {
  const tmp = mkdtempSync(join(tmpdir(), "cockpit-index-"));
  try {
    const env = { GIT_DIR: snapStore(repo), GIT_WORK_TREE: repo, GIT_INDEX_FILE: join(tmp, "index") };
    git(repo, ["add", "-A"], env);
    const tree = git(repo, ["write-tree"], env);
    // No parent: the project's HEAD is not in the store, and diffs only need the trees.
    const commit = git(
      repo,
      ["commit-tree", tree, "-m", `cockpit snapshot: ${label}`],
      { ...env, GIT_AUTHOR_NAME: "cockpit", GIT_AUTHOR_EMAIL: "cockpit@localhost", GIT_COMMITTER_NAME: "cockpit", GIT_COMMITTER_EMAIL: "cockpit@localhost" },
    );
    git(repo, ["update-ref", `refs/cockpit/snap/${commit}`, commit], env);
    return commit;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export function treeOf(repo: string, commit: string): string {
  return snapGit(repo, [commit], ["rev-parse", `${commit}^{tree}`]);
}

export interface FileChange {
  path: string;
  oldPath?: string;
  added: number;
  removed: number;
  status: string; // A, M, D, R
}

export function changedFiles(repo: string, a: string, b: string): FileChange[] {
  const status = snapGit(repo, [a, b], ["diff", "--name-status", "-M", a, b]).split("\n").filter(Boolean);
  const nums = snapGit(repo, [a, b], ["diff", "--numstat", "-M", a, b]).split("\n").filter(Boolean);
  return status.map((line, i) => {
    const [st, p1, p2] = line.split("\t");
    const [add, del] = (nums[i] ?? "").split("\t");
    return {
      status: st[0],
      path: p2 ?? p1,
      oldPath: p2 ? p1 : undefined,
      added: Number(add) || 0,
      removed: Number(del) || 0,
    };
  });
}

export function patch(repo: string, a: string, b: string): string {
  return snapGit(repo, [a, b], ["diff", "-M", "--no-color", "-U3", a, b]);
}

// Changed line numbers per file, on each side: old side for removed lines,
// new side for added lines. Used to find which functions a diff touched.
export function changedLines(repo: string, a: string, b: string) {
  const out = new Map<string, { old: number[]; new: number[] }>();
  let file = "", oldFile = "", o = 0, n = 0;
  for (const line of patch(repo, a, b).split("\n")) {
    if (line.startsWith("--- ")) oldFile = line.slice(6);
    else if (line.startsWith("+++ ")) {
      file = line.startsWith("+++ /dev/null") ? oldFile : line.slice(6);
      if (!out.has(file)) out.set(file, { old: [], new: [] });
    } else if (line.startsWith("@@")) {
      const m = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)/);
      if (m) (o = Number(m[1])), (n = Number(m[2]));
    } else if (file && line.startsWith("-")) out.get(file)!.old.push(o++);
    else if (file && line.startsWith("+")) out.get(file)!.new.push(n++);
    else if (file && line.startsWith(" ")) o++, n++;
  }
  return out;
}

// The skeleton (E2) of a snapshot, cached by tree hash. Indexing runs in a
// temporary worktree so it never races with an agent editing the real files.
// It shares the repo's target/ dir so dependencies are not rebuilt.
export function skeletonOf(repo: string, commit: string, cacheDir: string, protoPath: string, project?: string): Skeleton {
  const tree = treeOf(repo, commit);
  mkdirSync(cacheDir, { recursive: true });
  const cached = join(cacheDir, `v${SKELETON_VERSION}-${tree}.json`);
  if (existsSync(cached)) return JSON.parse(readFileSync(cached, "utf8"));

  const wt = mkdtempSync(join(tmpdir(), "cockpit-wt-"));
  const scip = join(cacheDir, `index-${tree}.scip`);
  // The worktree belongs to whichever git holds the commit: the store, or (old snapshots) the project.
  const dir = snapGitDir(repo, commit);
  const wtGit = (args: string[]) => (dir ? execFileSync("git", ["--git-dir", dir, ...args], { stdio: "ignore" }) : git(repo, args));
  try {
    wtGit(["worktree", "add", "--detach", "--force", wt, commit]);
    const lang = detectLang(wt) ?? "rust";
    // Rust shares the repo's target/; C++ reuses the repo's compile databases, pointed at the worktree.
    indexProject(lang, wt, scip, { repo, config: readIndexConfig(project ?? basename(repo)) });
    const sk = skeletonFrom(lang, wt, scip, protoPath);
    sk.root = repo;
    writeFileSync(cached, JSON.stringify(sk));
    return sk;
  } finally {
    rmSync(scip, { force: true });
    rmSync(scip.replace(/\.scip$/, ".compile_commands.json"), { force: true });
    try {
      wtGit(["worktree", "remove", "--force", wt]);
    } catch {
      rmSync(wt, { recursive: true, force: true });
      wtGit(["worktree", "prune"]);
    }
  }
}
