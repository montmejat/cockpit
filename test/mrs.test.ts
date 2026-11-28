import { test } from "node:test";
import assert from "node:assert/strict";
import { fromGithub, fromGitlab, remotePath } from "../src/mrs.ts";
import { aside, blocks, landing, moved, slot, need, rows, standing, stepped } from "../web/src/lib/mrstack.ts";
import type { TrackedMr } from "../web/src/lib/types.ts";

const mr = (id: number, source: string, target: string, x: Partial<TrackedMr> = {}): TrackedMr => ({
  id, ref: "!" + id, title: "mr " + id, source, target, author: "ann", url: "", draft: false, fork: false,
  created: "2026-01-01", updated: "2026-01-0" + (id % 9 + 1), assignees: [], reviewers: [], approvals: null, approved: false,
  ci: null, ready: false, blocker: null, threads: null, size: null, labels: [], ...x,
});
const refs = (rs: { mr: TrackedMr; depth: number }[]) => rs.map((r) => "  ".repeat(r.depth) + r.mr.ref);

test("remotePath reads ssh and https remotes, subgroups included", () => {
  assert.deepEqual(remotePath("git@gitlab.example.com:team/sub/proj.git"), { host: "gitlab.example.com", path: "team/sub/proj" });
  assert.deepEqual(remotePath("https://gitlab.example.com/team/proj.git"), { host: "gitlab.example.com", path: "team/proj" });
  assert.deepEqual(remotePath("ssh://git@gitlab.example.com:2222/team/proj"), { host: "gitlab.example.com", path: "team/proj" });
});

test("fromGitlab: merge status, reviewers, threads, size", () => {
  const m = fromGitlab({
    iid: "7", title: "t", webUrl: "u", draft: false, sourceBranch: "a", targetBranch: "main", sourceProjectId: 1, targetProjectId: 1,
    author: { username: "ann" }, reviewers: { nodes: [{ username: "bob", mergeRequestInteraction: { reviewState: "APPROVED" } }, { username: "cy", mergeRequestInteraction: { reviewState: "UNREVIEWED" } }] },
    approvalsRequired: 2, approvalsLeft: 1, detailedMergeStatus: "DISCUSSIONS_NOT_RESOLVED", headPipeline: { status: "FAILED" },
    resolvableDiscussionsCount: 3, resolvedDiscussionsCount: 1, diffStatsSummary: { additions: 10, deletions: 2, fileCount: 3 }, labels: { nodes: [{ title: "bug" }] },
  });
  assert.equal(m.ref, "!7");
  assert.deepEqual(m.reviewers, [{ name: "bob", state: "approved" }, { name: "cy", state: "waiting" }]);
  assert.equal(m.blocker, "open discussions");
  assert.equal(m.ci, "fail");
  assert.deepEqual(m.threads, { open: 2, all: 3 });
  assert.deepEqual(m.approvals, { left: 1, required: 2 });
  assert.equal(fromGitlab({ iid: 1, detailedMergeStatus: "MERGEABLE" }).ready, true);
});

test("fromGithub: review requests and latest reviews, blocker from draft / decision / checks", () => {
  const p = fromGithub({
    number: 3, title: "t", url: "u", isDraft: false, headRefName: "a", baseRefName: "main", author: { login: "ann" },
    reviewRequests: [{ login: "bob" }], latestReviews: [{ author: { login: "cy" }, state: "CHANGES_REQUESTED" }],
    reviewDecision: "CHANGES_REQUESTED", statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }], mergeable: "MERGEABLE",
  });
  assert.deepEqual(p.reviewers, [{ name: "bob", state: "waiting" }, { name: "cy", state: "changes" }]);
  assert.equal(p.blocker, "changes requested");
  assert.equal(p.ci, "pass");
  assert.equal(p.ready, false);
});

test("rows: a stack from its base down, stacks in your order, the unplaced last", () => {
  const list = [mr(1, "a", "main"), mr(2, "b", "a"), mr(3, "c", "b"), mr(4, "d", "a"), mr(5, "x", "main"), mr(6, "y", "main")];
  assert.deepEqual(refs(rows(list, ["!5", "!1", "!4", "!2"])), ["!5", "!1", "  !4", "  !2", "    !3", "!6"]);
});

test("rows: a filter keeps the stack under a match, dimmed", () => {
  const list = [mr(1, "a", "main"), mr(2, "b", "a"), mr(5, "x", "main")];
  const r = rows(list, [], (m) => m.id === 2);
  assert.deepEqual(refs(r), ["!1", "  !2"]);
  assert.deepEqual(r.map((x) => x.dim), [true, false]);
});

test("rows: a cycle doesn't hide its MRs", () => {
  assert.equal(rows([mr(1, "a", "b"), mr(2, "b", "a")], []).length, 2);
});

test("moved / stepped: only among siblings; a stack moves as one", () => {
  const list = [mr(1, "a", "main"), mr(2, "b", "a"), mr(5, "x", "main")];
  const all = rows(list, ["!1", "!5"]);
  const o = moved(["!1", "!5"], all, "!5", "!1", false);
  assert.deepEqual(refs(rows(list, o)), ["!5", "!1", "  !2"]);
  assert.deepEqual(moved(["!1", "!5"], all, "!2", "!5", false), ["!1", "!5"]); // another parent: no change
  assert.deepEqual(refs(rows(list, stepped(["!1", "!5"], all, "!1", 1))), ["!5", "!1", "  !2"]);
  assert.deepEqual(stepped(["!1", "!5"], all, "!1", -1), ["!1", "!5"]); // already first
});

test("need: to review unless approved or a draft; yours", () => {
  assert.equal(need(mr(1, "a", "main", { reviewers: [{ name: "me", state: "waiting" }] }), "me"), "review");
  assert.equal(need(mr(1, "a", "main", { reviewers: [{ name: "me", state: "approved" }] }), "me"), null);
  assert.equal(need(mr(1, "a", "main", { draft: true, reviewers: [{ name: "me", state: "waiting" }] }), "me"), null);
  assert.equal(need(mr(1, "a", "main", { author: "me" }), "me"), "yours");
});

test("standing: ready, stuck, waiting", () => {
  assert.equal(standing(mr(1, "a", "m", { ready: true })).tone, "ok");
  assert.deepEqual(standing(mr(1, "a", "m", { blocker: "conflict", ci: "fail" })), { word: "conflict", tone: "bad" });
  assert.deepEqual(standing(mr(1, "a", "m", { blocker: "open discussions", ci: "fail" })), { word: "CI failing", tone: "bad" });
  assert.deepEqual(standing(mr(1, "a", "m", { blocker: "needs approval" })), { word: "needs approval", tone: "warn" });
});

test("blocks: siblings with what's stacked on them; landing and aside while dragging", () => {
  const list = [mr(1, "a", "main"), mr(2, "b", "a"), mr(3, "c", "b"), mr(5, "x", "main"), mr(6, "y", "main")];
  const all = rows(list, ["!1", "!5", "!6"]); // !1 (!2 (!3)), !5, !6
  const b = blocks(all, "!5")!;
  assert.deepEqual(b.refs, ["!1", "!5", "!6"]);
  assert.deepEqual(b.spans, [[0, 2], [3, 3], [4, 4]]);
  assert.equal(b.at, 1);
  assert.deepEqual(blocks(all, "!2")!.refs, ["!2"]); // alone on its parent: nothing to reorder
  // middles 10, 40, 60: dragging !5 (middle 40) down past 60 lands last, up past 10 first
  assert.equal(landing([10, 40, 60], 1, 65), 2);
  assert.equal(landing([10, 40, 60], 1, 5), 0);
  assert.equal(landing([10, 40, 60], 1, 41), 1);
  // !5 (height 20) dragged to the end: !6 moves up by 20, !1 stays
  assert.deepEqual([0, 1, 2].map((k) => aside(k, 1, 2, 20)), [0, 0, -20]);
  assert.deepEqual([0, 1, 2].map((k) => aside(k, 1, 0, 20)), [20, 0, 0]);
  // and the dragged block itself jumps the heights of the blocks it passes
  assert.equal(slot([60, 20, 30], 1, 0), -60);
  assert.equal(slot([60, 20, 30], 1, 2), 30);
  assert.equal(slot([60, 20, 30], 1, 1), 0);
});
