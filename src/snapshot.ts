// Snapshots of a working copy, for diffing what an agent turn changed.
// A snapshot is a git commit of every file (untracked ones included, ignored
// ones not), built with a temporary index. It never touches the user's branch,
// index or files. It is kept alive under refs/cockpit/snap/<hash>.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSkeleton, SKELETON_VERSION, type Skeleton } from "./skeleton.ts";

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

export function snapshot(repo: string, label: string): string {
  const tmp = mkdtempSync(join(tmpdir(), "cockpit-index-"));
  try {
    const env = { GIT_INDEX_FILE: join(tmp, "index") };
    git(repo, ["add", "-A"], env);
    const tree = git(repo, ["write-tree"], env);
    let head = "";
    try {
      head = git(repo, ["rev-parse", "--verify", "-q", "HEAD"]);
    } catch {}
    const commit = git(
      repo,
      ["commit-tree", tree, ...(head ? ["-p", head] : []), "-m", `cockpit snapshot: ${label}`],
      { GIT_AUTHOR_NAME: "cockpit", GIT_AUTHOR_EMAIL: "cockpit@localhost", GIT_COMMITTER_NAME: "cockpit", GIT_COMMITTER_EMAIL: "cockpit@localhost" },
    );
    git(repo, ["update-ref", `refs/cockpit/snap/${commit}`, commit]);
    return commit;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export function treeOf(repo: string, commit: string): string {
  return git(repo, ["rev-parse", `${commit}^{tree}`]);
}

export interface FileChange {
  path: string;
  oldPath?: string;
  added: number;
  removed: number;
  status: string; // A, M, D, R
}

export function changedFiles(repo: string, a: string, b: string): FileChange[] {
  const status = git(repo, ["diff", "--name-status", "-M", a, b]).split("\n").filter(Boolean);
  const nums = git(repo, ["diff", "--numstat", "-M", a, b]).split("\n").filter(Boolean);
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
  return git(repo, ["diff", "-M", "--no-color", "-U3", a, b]);
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
export function skeletonOf(repo: string, commit: string, cacheDir: string, protoPath: string): Skeleton {
  const tree = treeOf(repo, commit);
  mkdirSync(cacheDir, { recursive: true });
  const cached = join(cacheDir, `v${SKELETON_VERSION}-${tree}.json`);
  if (existsSync(cached)) return JSON.parse(readFileSync(cached, "utf8"));

  const wt = mkdtempSync(join(tmpdir(), "cockpit-wt-"));
  try {
    git(repo, ["worktree", "add", "--detach", "--force", wt, commit]);
    const scip = join(wt, ".cockpit-index.scip");
    execFileSync("rust-analyzer", ["scip", ".", "--output", scip], {
      cwd: wt,
      stdio: "ignore",
      env: { ...process.env, CARGO_TARGET_DIR: join(repo, "target") },
    });
    const sk = buildSkeleton(wt, scip, protoPath);
    sk.root = repo;
    writeFileSync(cached, JSON.stringify(sk));
    return sk;
  } finally {
    try {
      git(repo, ["worktree", "remove", "--force", wt]);
    } catch {
      rmSync(wt, { recursive: true, force: true });
      git(repo, ["worktree", "prune"]);
    }
  }
}
