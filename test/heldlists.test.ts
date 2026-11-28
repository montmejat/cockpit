import { test } from "node:test";
import assert from "node:assert/strict";
import { heldView } from "../web/src/lib/heldlists.ts";

const paths = (xs: { path: string; moved: boolean }[]) => xs.map((x) => x.path + (x.moved ? "*" : ""));

test("not held: the lists as git has them", () => {
  const v = heldView(["a"], ["b", "c"], null);
  assert.deepEqual(paths(v.staged), ["a"]);
  assert.deepEqual(paths(v.unstaged), ["b", "c"]);
});

test("a file staged while held stays in its row, marked moved, and doesn't join the staged list", () => {
  const v = heldView(["b"], ["a", "c"], { staged: [], unstaged: ["a", "b", "c"] });
  assert.deepEqual(paths(v.unstaged), ["a", "b*", "c"]);
  assert.deepEqual(paths(v.staged), []);
});

test("unstaging works the same way back", () => {
  const v = heldView(["a"], ["b"], { staged: ["a", "b"], unstaged: [] });
  assert.deepEqual(paths(v.staged), ["a", "b*"]);
  assert.deepEqual(paths(v.unstaged), []);
});

test("a partly staged file is in both lists and neither row is moved", () => {
  const v = heldView(["a"], ["a"], { staged: ["a"], unstaged: ["a"] });
  assert.deepEqual(paths(v.staged), ["a"]);
  assert.deepEqual(paths(v.unstaged), ["a"]);
});

test("a new file joins at the end; a file with no changes left goes", () => {
  const v = heldView([], ["a", "n"], { staged: [], unstaged: ["a", "gone"] });
  assert.deepEqual(paths(v.unstaged), ["a", "n"]);
});
