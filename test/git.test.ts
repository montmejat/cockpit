import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGit, parseChangedLines, parseGraph, parseHunks, parseNumstat, parseStatus } from "../src/git.ts";

test("status: staged, unstaged, untracked; a rename's source path is skipped", () => {
  const z = ["M  a.ts", " M b.ts", "?? new.ts", "R  moved.ts", "old.ts", "MM c.ts", ""].join("\0");
  assert.deepEqual(parseStatus(z), [
    { x: "M", y: " ", path: "a.ts" },
    { x: " ", y: "M", path: "b.ts" },
    { x: "?", y: "?", path: "new.ts" },
    { x: "R", y: " ", path: "moved.ts" },
    { x: "M", y: "M", path: "c.ts" },
  ]);
});

test("numstat: counts, binary files, renames keep the new path", () => {
  const out = ["3\t1\tsrc/a.ts", "-\t-\timg.png", "2\t0\tsrc/{old => new}/x.ts", "1\t1\tsrc/{ => sub}/y.ts", "4\t4\tfrom.ts => to.ts"].join("\n");
  assert.deepEqual(parseNumstat(out), {
    "src/a.ts": [3, 1], "img.png": [-1, -1], "src/new/x.ts": [2, 0], "src/sub/y.ts": [1, 1], "to.ts": [4, 4],
  });
});

test("hunks: added lines, a pure removal, the old lines kept", () => {
  const diff = [
    "diff --git a/f b/f", "--- a/f", "+++ b/f",
    "@@ -2 +2,2 @@", "-old two", "+new two", "+new three",
    "@@ -9,2 +10,0 @@", "-gone a", "-gone b",
    "@@ -20 +20 @@", "-x", "+y",
  ].join("\n");
  assert.deepEqual(parseHunks(diff), [
    { at: 2, added: 2, removed: ["old two"] },
    { at: 11, added: 0, removed: ["gone a", "gone b"] },
    { at: 20, added: 1, removed: ["x"] },
  ]);
});

test("changed lines: per file, a removal marks one line, deleted files are left out", () => {
  const diff = [
    "diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", "@@ -1,0 +2,3 @@", "@@ -10,2 +12,0 @@",
    "diff --git a/gone.ts b/gone.ts", "--- a/gone.ts", "+++ /dev/null", "@@ -1,4 +0,0 @@",
    "diff --git a/b.ts b/b.ts", "--- a/b.ts", "+++ b/b.ts", "@@ -5 +5 @@",
  ].join("\n");
  assert.deepEqual(parseChangedLines(diff), { "a.ts": [[2, 4], [12, 12]], "b.ts": [[5, 5]] });
});

test("graph: parents, refs, cockpit's own refs hidden", () => {
  const l = ["h1", "p1 p2", "abc", "merge it", "Ann", "2026-01-01T00:00:00Z", "HEAD -> master, refs/cockpit/x/b/master, tag: v1"].join("\x1f");
  assert.deepEqual(parseGraph(l + "\n"), [{ hash: "h1", parents: ["p1", "p2"], sha: "abc", subject: "merge it", author: "Ann", date: "2026-01-01T00:00:00Z", refs: ["HEAD -> master", "tag: v1"] }]);
});

// The git tab's actions, against a real repository.
test("stage, commit, discard and their refusals, in a real repo", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cockpit-git-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sh = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
  sh("init", "-q", "-b", "main");
  sh("config", "user.email", "t@t"); sh("config", "user.name", "t");
  writeFileSync(join(dir, "a.txt"), "one\n");
  const git = createGit(dir);

  assert.deepEqual(await git.status(), [{ x: "?", y: "?", path: "a.txt" }]);
  await assert.rejects(git.commit("first"), /nothing staged/);
  await assert.rejects(git.stage(["nope.txt"], true), /not changed: nope.txt/);
  await assert.rejects(git.stage("a.txt", true), /expected paths/);
  await git.stage(["a.txt"], true);
  const { head } = await git.commit("first");
  assert.match(head, /^[0-9a-f]+$/);
  assert.equal((await git.head()).branch, "main");

  writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
  writeFileSync(join(dir, "b.txt"), "new\n");
  assert.deepEqual(await git.changedLines(await git.status()), { "a.txt": [[2, 2]], "b.txt": [[1, 1e9]] });
  assert.deepEqual((await git.numstat()).unstaged, { "a.txt": [1, 0] });

  await git.discard(["a.txt", "b.txt"]);
  assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "one\n");
  assert.equal(existsSync(join(dir, "b.txt")), false);
  await assert.rejects(git.discard(["a.txt"]), /no unstaged changes/);
  await assert.rejects(git.switchTo({ sha: "--orphan" }), /not a commit/);
  await assert.rejects(git.switchTo({ ref: "nowhere" }), /no branch nowhere/);
  await assert.rejects(git.commitPatch("HEAD; rm"), /bad sha/);
});
