// Review mode's merge request discussions: reading the forge CLI's pages, and the text the agent gets.
import { test } from "node:test";
import assert from "node:assert/strict";
import { jsonValues, threadsText, type Thread } from "../src/review.ts";

test("pages printed one after the other are split where each ends, brackets in strings kept", () => {
  assert.deepEqual(jsonValues('[{"a":"x]["}][{"b":"\\"]"}]\n'), [[{ a: "x][" }], [{ b: '"]' }]]);
  assert.deepEqual(jsonValues("[]"), [[]]);
  assert.deepEqual(jsonValues(""), []);
});

const th = (o: Partial<Thread>): Thread => ({ id: "1", path: null, line: null, oldLine: null, head: null, resolved: null, url: null, notes: [{ author: "ann", body: "looks good", at: "2026-11-23T10:00:00Z" }], ...o });

test("the agent's text says where each discussion is, its state, and quotes every note", () => {
  const text = threadsText([
    th({ path: "src/a.cpp", line: 12, resolved: false, head: "abc123", notes: [{ author: "ann", body: "why?\nreally", at: "2026-11-23T10:00:00Z" }, { author: "bob", body: "because", at: "2026-11-24T10:00:00Z" }] }),
    th({ path: "src/b.cpp", oldLine: 7, resolved: true, head: "old999" }),
    th({}),
  ], "abc123def");
  assert.match(text, /### src\/a\.cpp:12 \(unresolved\)\nann, 2026-11-23:\n> why\?\n> really\n\nbob, 2026-11-24:\n> because/);
  assert.match(text, /### src\/b\.cpp, removed line 7 \(of the old version\) \(resolved; written on old999, an older version/);
  assert.match(text, /### on the merge request\nann/);
  assert.equal(threadsText([], "x"), "No discussions on it yet.");
});
