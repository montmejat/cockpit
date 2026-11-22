// The live state's list patches: what the server sends (src/listpatch.ts) and how the page merges
// it (web/src/lib/listmerge.ts) must give back the server's list, in its order.
import { test } from "node:test";
import assert from "node:assert/strict";
import { listPatch } from "../src/listpatch.ts";
import { merge } from "../web/src/lib/listmerge.ts";

type M = { id: string; lines: number };
const key = (m: M) => m.id;
const roundTrip = (before: M[], after: M[]) => merge(before, listPatch(before, after, key) as { set: M[]; del: string[]; keys?: string[] }, key);

test("an edit sends only the entry that changed, no order", () => {
  const before = [{ id: "a", lines: 1 }, { id: "b", lines: 2 }];
  const after = [{ id: "a", lines: 1 }, { id: "b", lines: 3 }];
  assert.deepEqual(listPatch(before, after, key), { set: [{ id: "b", lines: 3 }], del: [] });
  assert.deepEqual(roundTrip(before, after), after);
});

test("added, removed and reordered entries come back in the server's order", () => {
  const before = [{ id: "a", lines: 1 }, { id: "b", lines: 2 }, { id: "c", lines: 3 }];
  const after = [{ id: "c", lines: 3 }, { id: "new", lines: 9 }, { id: "a", lines: 1 }];
  const p = listPatch(before, after, key);
  assert.deepEqual(p.del, ["b"]);
  assert.deepEqual(p.keys, ["c", "new", "a"]);
  assert.deepEqual(roundTrip(before, after), after);
});

test("nothing changed: an empty patch", () => {
  const l = [{ id: "a", lines: 1 }];
  assert.deepEqual(listPatch(l, l, key), { set: [], del: [] });
  assert.deepEqual(roundTrip([], []), []);
});
