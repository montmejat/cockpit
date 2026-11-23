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
// The merge request of the checked-out branch, with where it stands (like Claude Code's footer).
export interface BranchMr extends MergeRequest {
  state: "open" | "merged" | "closed";
  review: "approved" | "changes" | "required" | null; // GitHub's review decision
  checks: { pass: number; fail: number; pending: number }; // CI on its head
}
export interface Review {
  mr: MergeRequest | null; // null: two branches picked by hand
  branch: string; // the branch checked out for the review
  target: string; // what it is compared with, e.g. origin/main
  returnTo: string | null; // the branch (or commit) you were on before
}
// A discussion on the merge request, as the forge has it: on a line of a file (path, and line in
// the new version, or oldLine when it is on a removed line), or on the merge request as a whole
// (path null). `head`: the commit it was written against (its line may have moved since).
export interface Thread {
  id: string; path: string | null; line: number | null; oldLine: number | null; head: string | null;
  resolved: boolean | null; // null: the forge doesn't say (GitHub without GraphQL)
  url: string | null;
  notes: { author: string; body: string; at: string }[];
}

// The threads as plain text for the agent: where each one is, who said what.
export function threadsText(threads: Thread[], headSha: string) {
  if (!threads.length) return "No discussions on it yet.";
  const where = (t: Thread) => !t.path ? "on the merge request" : t.line ? `${t.path}:${t.line}` : `${t.path}, removed line ${t.oldLine} (of the old version)`;
  return threads.map((t) => {
    const older = t.head && headSha && !headSha.startsWith(t.head) && !t.head.startsWith(headSha);
    const tags = [t.resolved === true ? "resolved" : t.resolved === false ? "unresolved" : "", older ? `written on ${t.head!.slice(0, 8)}, an older version: the line may have moved` : ""].filter(Boolean);
    return `### ${where(t)}${tags.length ? ` (${tags.join("; ")})` : ""}\n` +
      t.notes.map((n) => `${n.author}, ${n.at.slice(0, 10)}:\n${n.body.trim().split("\n").map((l) => "> " + l).join("\n")}`).join("\n\n");
  }).join("\n\n");
}

const run = (cmd: string, args: string[], cwd: string, timeout = 60_000) => new Promise<string>((done, fail) =>
  execFile(cmd, args, { cwd, timeout, maxBuffer: 64 << 20, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (e, out, err) =>
    e ? fail(new Error(String(err || e.message).trim().split("\n").slice(-3).join("\n"))) : done(out.trimEnd())));
const git = (root: string, ...a: string[]) => run("git", a, root);
const ok = (p: Promise<unknown>) => p.then(() => true, () => false);

// JSON values one after the other, as `glab api --paginate` and `gh api --paginate` print the
// pages of a list ("[…][…]"): split where each top-level value ends, strings skipped over.
export function jsonValues(s: string): any[] {
  const out: any[] = [];
  let depth = 0, start = -1, inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (c === "\\") i++; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "[" || c === "{") { if (depth++ === 0) start = i; }
    else if ((c === "]" || c === "}") && --depth === 0) out.push(JSON.parse(s.slice(start, i + 1)));
  }
  return out;
}

// `onThreads`: the merge request's discussions changed (fetched again).
export function createReview(root: string, project: string, onThreads: () => void = () => {}) {
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

  // The merge request whose source is the checked-out branch, or null. The forge CLI resolves
  // the branch itself (its push target, forks included). Kept for a minute per branch and head;
  // `fresh` asks again.
  const mrCache = new Map<string, { at: number; v: Promise<{ mr: BranchMr | null; error?: string }> }>();
  function branchMr(key: string, fresh = false) {
    const hit = mrCache.get(key);
    if (hit && !fresh && Date.now() - hit.at < 60_000) return hit.v;
    const v = lookupBranchMr();
    mrCache.clear(); mrCache.set(key, { at: Date.now(), v });
    return v;
  }
  async function lookupBranchMr(): Promise<{ mr: BranchMr | null; error?: string }> {
    const f = await forge();
    if (!f) return { mr: null };
    const none = /no (pull|merge) requests? found|no open merge request|not found/i;
    try {
      if (f === "gitlab") {
        const m = JSON.parse(await run("glab", ["mr", "view", "-F", "json"], root, 20_000));
        const p = m.head_pipeline?.status as string | undefined;
        return { mr: {
          id: m.iid, ref: "!" + m.iid, title: m.title, source: m.source_branch, target: m.target_branch,
          author: m.author?.username ?? "", url: m.web_url, draft: !!m.draft, fork: m.source_project_id !== m.target_project_id,
          state: m.state === "merged" ? "merged" : m.state === "closed" ? "closed" : "open", review: null,
          checks: { pass: p === "success" ? 1 : 0, fail: p === "failed" ? 1 : 0, pending: p && !["success", "failed", "canceled", "skipped"].includes(p) ? 1 : 0 },
        } };
      }
      const p = JSON.parse(await run("gh", ["pr", "view", "--json", "number,title,url,state,isDraft,baseRefName,headRefName,author,isCrossRepository,reviewDecision,statusCheckRollup"], root, 20_000));
      const checks = { pass: 0, fail: 0, pending: 0 };
      for (const c of p.statusCheckRollup ?? []) {
        const r = String(c.conclusion || c.state || "").toUpperCase(), done = c.__typename !== "CheckRun" || c.status === "COMPLETED";
        if (!done || r === "PENDING" || r === "EXPECTED" || !r) checks.pending++;
        else if (["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(r)) checks.fail++;
        else if (r !== "SKIPPED" && r !== "NEUTRAL") checks.pass++;
      }
      const rd = p.reviewDecision;
      return { mr: {
        id: p.number, ref: "#" + p.number, title: p.title, source: p.headRefName, target: p.baseRefName,
        author: p.author?.login ?? "", url: p.url, draft: !!p.isDraft, fork: !!p.isCrossRepository,
        state: p.state === "MERGED" ? "merged" : p.state === "CLOSED" ? "closed" : "open",
        review: rd === "APPROVED" ? "approved" : rd === "CHANGES_REQUESTED" ? "changes" : rd === "REVIEW_REQUIRED" ? "required" : null,
        checks,
      } };
    } catch (e: any) {
      if (none.test(e.message)) return { mr: null };
      const cli = f === "gitlab" ? "glab" : "gh";
      return { mr: null, error: /ENOENT/.test(e.message) ? `${cli} is not installed` : `${cli}: ${e.message}` };
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
  // A branch alone: its open merge request when it has one, else against the remote's default branch.
  async function start(opts: { mr?: MergeRequest; branch?: string; target?: string }) {
    if (opts.branch && !opts.target && !opts.mr) {
      const b = opts.branch.replace(/^origin\//, "");
      const mr = (await mergeRequests()).list.find((m) => m.source === b);
      if (mr) opts = { mr };
      else {
        const def = (await git(root, "symbolic-ref", "--short", "refs/remotes/origin/HEAD").catch(() => "")) || "";
        if (!def) throw new Error("no default branch known (origin/HEAD): pick what to compare with");
        if (def.replace(/^origin\//, "") === b) throw new Error(`${b} is the default branch: nothing to compare it with`);
        opts = { branch: b, target: def };
      }
    }
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
    refreshThreads();
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
    threadsOf = null; threadsJson = ""; threadsError = null;
  }

  // ---- the merge request's discussions ------------------------------------------------------
  // Fetched when a review starts, again every two minutes while it lasts, and when asked (the
  // page's refresh, the agent's tool). Kept in memory only: the forge is where they live.
  let threadsOf: { mr: number; list: Thread[] } | null = null, threadsJson = "", threadsError: string | null = null;
  let fetching: Promise<void> | null = null;
  function refreshThreads(): Promise<void> {
    const mr = current?.mr;
    if (!mr) return Promise.resolve();
    if (fetching) return fetching;
    fetching = (async () => {
      try {
        const list = await fetchThreads(mr);
        if (current?.mr?.id !== mr.id) return;
        const j = JSON.stringify(list), was = threadsOf?.mr === mr.id;
        threadsOf = { mr: mr.id, list };
        if (!was || j !== threadsJson || threadsError) { threadsJson = j; threadsError = null; onThreads(); }
      } catch (e: any) {
        const cli = (await forge()) === "github" ? "gh" : "glab";
        const err = /ENOENT/.test(e.message) ? `${cli} is not installed` : `${cli}: ${e.message}`;
        if (err !== threadsError) { threadsError = err; onThreads(); }
      } finally { fetching = null; }
    })();
    return fetching;
  }
  setInterval(() => { if (current?.mr) refreshThreads(); }, 120_000).unref();
  if (current?.mr) refreshThreads();

  async function fetchThreads(mr: MergeRequest): Promise<Thread[]> {
    const pages = async (cmd: string, path: string) => jsonValues(await run(cmd, ["api", "--paginate", path], root, 30_000)).flat();
    if ((await forge()) === "gitlab") {
      const raw = await pages("glab", `projects/:id/merge_requests/${mr.id}/discussions?per_page=100`);
      return raw.flatMap((d: any) => {
        const notes = (d.notes ?? []).filter((n: any) => !n.system);
        if (!notes.length) return [];
        const p = notes[0].position;
        const resolvable = notes.some((n: any) => n.resolvable);
        return [{
          id: String(d.id), path: p ? p.new_path ?? p.old_path ?? null : null,
          line: p?.new_line ?? null, oldLine: p?.new_line == null ? p?.old_line ?? null : null, head: p?.head_sha ?? null,
          resolved: resolvable ? notes.every((n: any) => !n.resolvable || n.resolved) : null,
          url: `${mr.url}#note_${notes[0].id}`,
          notes: notes.map((n: any) => ({ author: n.author?.username ?? "", body: n.body ?? "", at: n.created_at ?? "" })),
        }];
      });
    }
    // GitHub: line comments (grouped into threads by what they reply to), the reviews' own
    // words and the conversation's comments.
    const repo = `repos/{owner}/{repo}`;
    const [lineC, reviews, issueC] = await Promise.all([
      pages("gh", `${repo}/pulls/${mr.id}/comments?per_page=100`),
      pages("gh", `${repo}/pulls/${mr.id}/reviews?per_page=100`),
      pages("gh", `${repo}/issues/${mr.id}/comments?per_page=100`),
    ]);
    const out: Thread[] = [], byId = new Map<number, Thread>();
    for (const c of lineC) {
      const note = { author: c.user?.login ?? "", body: c.body ?? "", at: c.created_at ?? "" };
      const parent = c.in_reply_to_id ? byId.get(c.in_reply_to_id) : null;
      if (parent) { parent.notes.push(note); byId.set(c.id, parent); continue; }
      const left = c.side === "LEFT", line = c.line ?? null; // line null: outdated, original_line is where it was
      const t: Thread = {
        id: String(c.id), path: c.path ?? null,
        line: left ? null : line ?? c.original_line ?? null, oldLine: left ? line ?? c.original_line ?? null : null,
        head: line == null ? c.original_commit_id ?? null : c.commit_id ?? null, resolved: null, url: c.html_url ?? null, notes: [note],
      };
      byId.set(c.id, t); out.push(t);
    }
    const whole = (id: string, c: any, at: string): Thread => ({ id, path: null, line: null, oldLine: null, head: null, resolved: null, url: c.html_url ?? null, notes: [{ author: c.user?.login ?? "", body: c.body ?? "", at }] });
    for (const r of reviews) if (r.body?.trim()) out.push(whole("r" + r.id, r, r.submitted_at ?? ""));
    for (const c of issueC) out.push(whole("c" + c.id, c, c.created_at ?? ""));
    return out;
  }

  // The review's threads as last fetched (list null: not fetched yet, or no merge request).
  const threads = () => ({ list: current?.mr && threadsOf?.mr === current.mr.id ? threadsOf.list : null, error: current?.mr ? threadsError : null });

  return { current: () => current, mergeRequests, branchMr, branches, start, stop, threads, refreshThreads };
}
