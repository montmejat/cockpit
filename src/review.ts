// Review mode: look at a merge request (or any branch) against the branch it goes into. Cockpit
// checks the branch out (only when nothing is uncommitted), then everything that shows what is
// changing (diagram boxes, files, their gutters) compares with the point where the branch left
// its target, like the merge request's own diff, uncommitted edits included.
//
// Open merge requests come from the project's forge, with the CLI you're logged in with:
// glab (GitLab, any host) or gh (GitHub). The review in progress is kept in the project's
// state dir (turns.ts), so it survives a restart.

import { execFile } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { outDir } from "./turns.ts";

export interface MergeRequest {
  id: number; ref: string; title: string; source: string; target: string;
  author: string; url: string; draft: boolean; fork: boolean;
}
export interface Review {
  mr: MergeRequest | null; // null: two branches picked by hand
  branch: string; // the branch checked out for the review
  target: string; // what it is compared with, e.g. origin/main
  returnTo: string | null; // the branch (or commit) you were on before
}

const run = (cmd: string, args: string[], cwd: string, timeout = 60_000) => new Promise<string>((done, fail) =>
  execFile(cmd, args, { cwd, timeout, maxBuffer: 64 << 20, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (e, out, err) =>
    e ? fail(new Error(String(err || e.message).trim().split("\n").slice(-3).join("\n"))) : done(out.trimEnd())));
const git = (root: string, ...a: string[]) => run("git", a, root);
const ok = (p: Promise<unknown>) => p.then(() => true, () => false);

export function createReview(root: string, project: string) {
  const file = () => join(outDir(project), "review.json");
  let current: Review | null = null;
  try { if (existsSync(file())) current = JSON.parse(readFileSync(file(), "utf8")); } catch {}
  const save = (r: Review | null) => { current = r; if (r) writeFileSync(file(), JSON.stringify(r, null, 1)); else rmSync(file(), { force: true }); };

  async function forge(): Promise<"github" | "gitlab" | null> {
    const url = await git(root, "remote", "get-url", "origin").catch(() => "");
    if (!url) return null;
    return /github\.com[:/]/.test(url) ? "github" : "gitlab";
  }

  // Open merge requests, newest first.
  async function mergeRequests(): Promise<{ forge: string | null; list: MergeRequest[]; error?: string }> {
    const f = await forge();
    if (!f) return { forge: null, list: [], error: "no remote named origin" };
    try {
      if (f === "gitlab") {
        const raw = JSON.parse(await run("glab", ["mr", "list", "-F", "json", "-P", "50"], root, 30_000));
        return { forge: f, list: raw.map((m: any) => ({
          id: m.iid, ref: "!" + m.iid, title: m.title, source: m.source_branch, target: m.target_branch,
          author: m.author?.username ?? "", url: m.web_url, draft: !!m.draft, fork: m.source_project_id !== m.target_project_id,
        })) };
      }
      const raw = JSON.parse(await run("gh", ["pr", "list", "--limit", "50", "--json", "number,title,headRefName,baseRefName,author,url,isDraft,isCrossRepository"], root, 30_000));
      return { forge: f, list: raw.map((p: any) => ({
        id: p.number, ref: "#" + p.number, title: p.title, source: p.headRefName, target: p.baseRefName,
        author: p.author?.login ?? "", url: p.url, draft: !!p.isDraft, fork: !!p.isCrossRepository,
      })) };
    } catch (e: any) {
      const cli = f === "gitlab" ? "glab" : "gh";
      return { forge: f, list: [], error: /ENOENT/.test(e.message) ? `${cli} is not installed` : `${cli}: ${e.message}` };
    }
  }

  // Local and remote branches, for comparing by hand; the remote's default branch first.
  async function branches() {
    const all = (await git(root, "for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads", "refs/remotes")).split("\n").filter((b) => b && !b.endsWith("/HEAD") && b !== "origin");
    const def = (await git(root, "symbolic-ref", "--short", "refs/remotes/origin/HEAD").catch(() => "")) || null;
    return { branches: all, current: (await git(root, "symbolic-ref", "--short", "-q", "HEAD").catch(() => "")) || null, defaultTarget: def };
  }

  const exists = (ref: string) => ok(git(root, "rev-parse", "--verify", "-q", ref + "^{commit}"));
  const dirty = async () => (await git(root, "status", "--porcelain=v1", "--untracked-files=no")).length > 0;

  // Start reviewing a merge request, or `branch` against `target` (both branch names, local or remote).
  async function start(opts: { mr?: MergeRequest; branch?: string; target?: string }) {
    const before = (await git(root, "symbolic-ref", "--short", "-q", "HEAD").catch(() => "")) || (await git(root, "rev-parse", "--short", "HEAD"));
    let branch: string, target: string;
    if (opts.mr) {
      const mr = opts.mr, f = await forge();
      if (mr.fork) {
        // A merge request from a fork: its head is published on the target project.
        branch = `review/${mr.id}`;
        const head = f === "github" ? `pull/${mr.id}/head` : `refs/merge-requests/${mr.id}/head`;
        if (before === branch) await git(root, "fetch", "origin", mr.target);
        else await git(root, "fetch", "origin", `+${head}:refs/heads/${branch}`, mr.target);
      } else {
        branch = mr.source;
        await git(root, "fetch", "origin", mr.source, mr.target);
      }
      target = mr.target;
    } else {
      if (!opts.branch || !opts.target) throw new Error("pick a branch to review and one to compare with");
      branch = opts.branch.replace(/^origin\//, "");
      target = opts.target;
      await git(root, "fetch", "origin").catch(() => {}); // offline is fine: compare what's here
    }
    const targetRef = (await exists(`origin/${target.replace(/^origin\//, "")}`)) ? `origin/${target.replace(/^origin\//, "")}` : target;
    if (!(await exists(targetRef))) throw new Error(`no branch ${target}`);

    let note = "";
    if (before !== branch) {
      if (await dirty()) throw new Error("you have uncommitted changes: commit or stash them before switching to the review's branch");
      if (await exists(`refs/heads/${branch}`)) {
        await git(root, "checkout", branch);
        // Bring it up to date with the remote when that's a fast-forward; say so when it isn't.
        if (await exists(`origin/${branch}`)) await git(root, "merge", "--ff-only", `origin/${branch}`).catch(() => { note = `your local ${branch} differs from origin/${branch}: reviewing the local one`; });
      } else if (await exists(`origin/${branch}`)) await git(root, "checkout", "-b", branch, "--track", `origin/${branch}`);
      else throw new Error(`no branch ${branch}`);
    }
    save({ mr: opts.mr ?? null, branch, target: targetRef, returnTo: before !== branch ? before : current?.returnTo ?? null });
    return { note };
  }

  // Stop reviewing; with `back`, check out the branch you were on before (only when nothing is uncommitted).
  async function stop(back: boolean) {
    const r = current;
    if (back && r?.returnTo) {
      if (await dirty()) throw new Error("you have uncommitted changes: commit or stash them before going back");
      await git(root, "checkout", r.returnTo);
    }
    save(null);
  }

  return { current: () => current, mergeRequests, branches, start, stop };
}
