// The project's open merge requests and where each stands, for the tracker (web: MrList.svelte):
// who reviews it and how far they got, CI on its head, whether it can merge and if not why, its
// size. GitLab through one GraphQL query (`glab api graphql`), GitHub through `gh pr list`; both
// turned into one shape here. Kept for a minute; `fresh` asks again. Which MR stacks on which is
// worked out in the page (an MR whose target is another's source sits on it).

import { run, type MergeRequest } from "./review.ts";

export type ReviewState = "approved" | "changes" | "reviewed" | "waiting";
export interface TrackedMr extends MergeRequest {
  created: string; updated: string;
  assignees: string[];
  reviewers: { name: string; state: ReviewState }[];
  approvals: { left: number; required: number } | null; // GitLab's approval rules; null on GitHub
  approved: boolean;
  ci: "pass" | "fail" | "running" | null; // null: no pipeline
  ready: boolean; // can be merged now
  blocker: string | null; // why not, in a few words ("conflict", "draft", "open discussions"…); null: ready or not known yet
  threads: { open: number; all: number } | null;
  size: { add: number; del: number; files: number } | null;
  labels: string[];
}
export interface Tracker { forge: "gitlab" | "github" | null; me: string | null; list: TrackedMr[]; error?: string; at: number }

// ---- GitLab ---------------------------------------------------------------------------------
export const GITLAB_QUERY = `query($p: ID!) { currentUser { username }
  project(fullPath: $p) { mergeRequests(state: opened, first: 100, sort: UPDATED_DESC) { nodes {
    iid title webUrl draft sourceBranch targetBranch createdAt updatedAt sourceProjectId targetProjectId
    author { username } assignees { nodes { username } }
    reviewers { nodes { username mergeRequestInteraction { reviewState } } }
    approved approvalsRequired approvalsLeft detailedMergeStatus conflicts headPipeline { status }
    resolvableDiscussionsCount resolvedDiscussionsCount
    diffStatsSummary { additions deletions fileCount } labels { nodes { title } } } } } }`;

// GitLab's detailedMergeStatus in a few words; null for "can merge" and "still working it out".
const BLOCKERS: Record<string, string | null> = {
  MERGEABLE: null, CHECKING: null, UNCHECKED: null, PREPARING: null,
  CONFLICT: "conflict", DRAFT_STATUS: "draft", DISCUSSIONS_NOT_RESOLVED: "open discussions",
  NOT_APPROVED: "needs approval", REQUESTED_CHANGES: "changes requested", CI_MUST_PASS: "CI must pass",
  CI_STILL_RUNNING: "CI running", NEED_REBASE: "needs rebase", BLOCKED_STATUS: "blocked by another MR",
  NOT_OPEN: "not open", MERGE_REQUEST_BLOCKED: "blocked by another MR", EXTERNAL_STATUS_CHECKS: "status checks",
};
const REVIEW: Record<string, ReviewState> = { APPROVED: "approved", REQUESTED_CHANGES: "changes", REVIEWED: "reviewed" };
const ciOf = (s?: string | null): TrackedMr["ci"] =>
  !s ? null : s === "SUCCESS" || s === "success" ? "pass" : /^(failed|canceled)$/i.test(s) ? "fail" : /^skipped$/i.test(s) ? null : "running";

export function fromGitlab(n: any): TrackedMr {
  const st = String(n.detailedMergeStatus ?? "UNCHECKED");
  const all = n.resolvableDiscussionsCount ?? null, done = n.resolvedDiscussionsCount ?? 0;
  return {
    id: +n.iid, ref: "!" + n.iid, title: n.title, source: n.sourceBranch, target: n.targetBranch,
    author: n.author?.username ?? "", url: n.webUrl, draft: !!n.draft, fork: n.sourceProjectId !== n.targetProjectId,
    created: n.createdAt ?? "", updated: n.updatedAt ?? "",
    assignees: (n.assignees?.nodes ?? []).map((a: any) => a.username),
    reviewers: (n.reviewers?.nodes ?? []).map((r: any) => ({ name: r.username, state: REVIEW[r.mergeRequestInteraction?.reviewState] ?? "waiting" })),
    approvals: n.approvalsRequired != null ? { left: n.approvalsLeft ?? 0, required: n.approvalsRequired } : null,
    approved: !!n.approved,
    ci: ciOf(n.headPipeline?.status),
    ready: st === "MERGEABLE",
    blocker: st in BLOCKERS ? BLOCKERS[st] : st.toLowerCase().replace(/_/g, " "),
    threads: all == null ? null : { open: all - done, all },
    size: n.diffStatsSummary ? { add: n.diffStatsSummary.additions, del: n.diffStatsSummary.deletions, files: n.diffStatsSummary.fileCount } : null,
    labels: (n.labels?.nodes ?? []).map((l: any) => l.title),
  };
}

// The project's path and host from its remote: git@host:group/sub/name.git, https://host/group/name(.git).
export function remotePath(url: string): { host: string; path: string } | null {
  const m = /^(?:[\w.-]+@)?([^:/]+):(?!\/\/)(.+?)(?:\.git)?\/?$/.exec(url) ?? /^\w+:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/.exec(url);
  return m ? { host: m[1], path: m[2] } : null;
}

// ---- GitHub ---------------------------------------------------------------------------------
const GH_FIELDS = "number,title,url,isDraft,headRefName,baseRefName,author,isCrossRepository,createdAt,updatedAt,assignees,reviewRequests,latestReviews,reviewDecision,statusCheckRollup,mergeable,additions,deletions,changedFiles,labels";

export function checksOf(rollup: any[]): { pass: number; fail: number; pending: number } {
  const c = { pass: 0, fail: 0, pending: 0 };
  for (const x of rollup ?? []) {
    const r = String(x.conclusion || x.state || "").toUpperCase(), done = x.__typename !== "CheckRun" || x.status === "COMPLETED";
    if (!done || r === "PENDING" || r === "EXPECTED" || !r) c.pending++;
    else if (["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(r)) c.fail++;
    else if (r !== "SKIPPED" && r !== "NEUTRAL") c.pass++;
  }
  return c;
}

export function fromGithub(p: any): TrackedMr {
  const c = checksOf(p.statusCheckRollup), ci: TrackedMr["ci"] = c.fail ? "fail" : c.pending ? "running" : c.pass ? "pass" : null;
  const reviewers = new Map<string, ReviewState>();
  for (const r of p.reviewRequests ?? []) if (r.login) reviewers.set(r.login, "waiting");
  for (const r of p.latestReviews ?? []) {
    const who = r.author?.login; if (!who) continue;
    reviewers.set(who, r.state === "APPROVED" ? "approved" : r.state === "CHANGES_REQUESTED" ? "changes" : "reviewed");
  }
  const rd = p.reviewDecision, approved = rd === "APPROVED";
  const blocker = p.isDraft ? "draft" : p.mergeable === "CONFLICTING" ? "conflict" : rd === "CHANGES_REQUESTED" ? "changes requested"
    : rd === "REVIEW_REQUIRED" ? "needs approval" : ci === "fail" ? "CI failing" : ci === "running" ? "CI running" : null;
  return {
    id: p.number, ref: "#" + p.number, title: p.title, source: p.headRefName, target: p.baseRefName,
    author: p.author?.login ?? "", url: p.url, draft: !!p.isDraft, fork: !!p.isCrossRepository,
    created: p.createdAt ?? "", updated: p.updatedAt ?? "",
    assignees: (p.assignees ?? []).map((a: any) => a.login),
    reviewers: [...reviewers].map(([name, state]) => ({ name, state })),
    approvals: null, approved,
    ci, ready: !blocker && p.mergeable === "MERGEABLE", blocker,
    threads: null,
    size: { add: p.additions ?? 0, del: p.deletions ?? 0, files: p.changedFiles ?? 0 },
    labels: (p.labels ?? []).map((l: any) => l.name),
  };
}

// ---- the tracker ----------------------------------------------------------------------------
export function createTracker(root: string) {
  let last: { at: number; v: Promise<Tracker> } | null = null;

  async function load(): Promise<Tracker> {
    const at = Date.now();
    const url = await run("git", ["remote", "get-url", "origin"], root).catch(() => "");
    if (!url) return { forge: null, me: null, list: [], error: "no remote named origin", at };
    const forge = /github\.com[:/]/.test(url) ? "github" : "gitlab", cli = forge === "gitlab" ? "glab" : "gh";
    try {
      if (forge === "gitlab") {
        const rp = remotePath(url);
        if (!rp) return { forge, me: null, list: [], error: "can't read the project from origin's URL", at };
        const out = JSON.parse(await run("glab", ["api", "graphql", "--hostname", rp.host, "-f", "query=" + GITLAB_QUERY, "-f", "p=" + rp.path], root, 30_000));
        if (out.errors?.length) return { forge, me: null, list: [], error: "glab: " + out.errors.map((e: any) => e.message).join("; "), at };
        const nodes = out.data?.project?.mergeRequests?.nodes;
        if (!nodes) return { forge, me: null, list: [], error: `glab: no project ${rp.path} on ${rp.host}`, at };
        return { forge, me: out.data.currentUser?.username ?? null, list: nodes.map(fromGitlab), at };
      }
      const [list, me] = await Promise.all([
        run("gh", ["pr", "list", "--state", "open", "--limit", "100", "--json", GH_FIELDS], root, 30_000),
        run("gh", ["api", "user", "-q", ".login"], root, 15_000).catch(() => ""),
      ]);
      return { forge, me: me.trim() || null, list: JSON.parse(list).map(fromGithub), at };
    } catch (e: any) {
      return { forge, me: null, list: [], error: /ENOENT/.test(e.message) ? `${cli} is not installed` : `${cli}: ${e.message}`, at };
    }
  }

  return {
    get(fresh = false): Promise<Tracker> {
      if (last && !fresh && Date.now() - last.at < 60_000) return last.v;
      const v = load();
      last = { at: Date.now(), v };
      v.then((t) => { if (t.error && last?.v === v) last = null; }); // don't keep a failure
      return v;
    },
  };
}
