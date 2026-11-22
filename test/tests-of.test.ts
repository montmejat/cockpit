// What the project tab lists as tests, and which items changed lines fall in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { itemsIn, testsOf } from "../src/tests-of.ts";
import type { Skeleton } from "../src/skeleton.ts";

const sk = (lang: Skeleton["lang"]): Skeleton => ({
  root: "/p", lang, crates: [], edges: [],
  modules: [{ id: "c/m", crate: "c", file: "src/m.rs", lines: 40, doc: "", libs: {}, items: [
    { name: "step", kind: "Function", doc: "", line: 3, end: 10 },
    { name: "eval", kind: "Function", doc: "", line: 12, end: 20, owner: "Curve" },
    { name: "it_steps", kind: "Function", doc: "", line: 30, end: 33, test: true },
  ] }],
});

test("unit tests per module, Rust integration tests, C++ test cases", (t) => {
  const root = mkdtempSync(join(tmpdir(), "cockpit-tests-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "tests")); mkdirSync(join(root, "test"));
  writeFileSync(join(root, "tests/run.rs"), "#[test]\nfn runs() {}\n\n#[test]\n#[ignore]\npub fn slow() {}\n");
  writeFileSync(join(root, "test/world_test.cpp"), 'TEST(World, Steps) {}\nTEST_CASE("loads a file") {}\n');
  writeFileSync(join(root, "test/plain_test.cpp"), "void test_add(void) {\n}\nint main() {}\n");

  const rs = testsOf(root, sk("rust"), ["tests/run.rs"]);
  assert.deepEqual(rs.unit, [{ module: "c/m", file: "src/m.rs", crate: "c", tests: [{ name: "it_steps", line: 30 }] }]);
  assert.deepEqual(rs.integration, [{ file: "tests/run.rs", tests: [{ name: "runs", line: 1 }, { name: "slow", line: 4 }] }]);

  const cpp = testsOf(root, sk("cpp"), ["test/world_test.cpp", "test/plain_test.cpp", "src/m.cpp"]);
  assert.deepEqual(cpp.integration, [
    { file: "test/world_test.cpp", tests: [{ name: "World.Steps", line: 1 }, { name: "loads a file", line: 2 }] },
    { file: "test/plain_test.cpp", tests: [{ name: "test_add", line: 1 }] },
  ]);
});

test("changed lines light up the items they touch, not tests", () => {
  assert.deepEqual(itemsIn(sk("rust"), { "src/m.rs": [[10, 12]] }), ["c/m::step", "c/m::Curve::eval"]);
  assert.deepEqual(itemsIn(sk("rust"), { "src/m.rs": [[31, 31]], "other.rs": [[1, 1e9]] }), []);
});
