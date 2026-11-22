// What the project's code says about itself beyond its modules: its tests, by name, and which
// items a set of changed lines falls in.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { itemKey, type Skeleton } from "./skeleton.ts";

// What is tested, by name. Rust: #[test] functions inside each module and in the integration
// test files (tests/*.rs). Zig: the test "…" blocks in each file. C/C++: test files (*_test.cpp, test_*.cpp, *Test.cpp, or anything
// under a test/ dir), with their GoogleTest / Catch2 / Boost.Test cases, else their test_*() functions
// (plain main() tests), else the file as one test.
const CXX_TEST_FILE = /(^|\/)(tests?\/.*|[^/]*[_-]test|test_[^/]*|[^/]*Tests?)\.(c|cc|cpp|cxx)$/;
const CXX_TEST_FN = /^[ \t]*(?:static\s+)?(?:inline\s+)?void\s+(test_?\w*)\s*\(\s*(?:void)?\s*\)\s*\{/gm;
const CXX_TEST_CASE = /^[ \t]*(?:TEST|TEST_F|TEST_P|TYPED_TEST|TYPED_TEST_P|TEST_CASE|SCENARIO|BOOST_AUTO_TEST_CASE|BOOST_FIXTURE_TEST_CASE)\s*\(\s*([^)]*)\)/gm;
export function testsOf(root: string, sk: Skeleton, files: string[]) {
  const unit = sk.modules.map((m) => ({ module: m.id, file: m.file, crate: m.crate, tests: m.items.filter((i) => i.test && (i.kind === "Function" || i.kind === "Test")).map((i) => ({ name: i.name, line: i.line })) }));
  const integration = files.filter((f) => /(^|\/)tests\/.*\.rs$/.test(f)).flatMap((file) => {
    try {
      const text = readFileSync(join(root, file), "utf8"), tests: { name: string; line: number }[] = [];
      const re = /#\[test\]\s*(?:#\[[^\]]*\]\s*)*(?:pub\s+)?fn\s+(\w+)/g;
      for (let m; (m = re.exec(text)); ) tests.push({ name: m[1], line: text.slice(0, m.index).split("\n").length });
      return [{ file, tests }];
    } catch { return []; }
  });
  if (sk.lang === "cpp") for (const file of files.filter((f) => CXX_TEST_FILE.test(f))) {
    let text: string;
    try { text = readFileSync(join(root, file), "utf8"); } catch { continue; }
    const tests: { name: string; line: number }[] = [];
    for (let m; (m = CXX_TEST_CASE.exec(text)); ) {
      const args = m[1].split(",").map((a) => a.trim().replace(/^"|"$/g, ""));
      tests.push({ name: args.length > 1 && !/^"/.test(m[1].trim()) ? `${args[0]}.${args[1]}` : args[0], line: text.slice(0, m.index).split("\n").length });
    }
    if (!tests.length) for (let m; (m = CXX_TEST_FN.exec(text)); ) tests.push({ name: m[1], line: text.slice(0, m.index).split("\n").length });
    integration.push({ file, tests: tests.length ? tests : [{ name: file.split("/").pop()!.replace(/\.[^.]+$/, ""), line: 1 }] });
  }
  return { unit, integration };
}

// Items whose lines changed: lets a diagram box light up only when its own function changed.
export function itemsIn(sk: Skeleton, lines: Record<string, [number, number][]>) {
  const out: string[] = [];
  for (const m of sk.modules) {
    const ranges = lines[m.file];
    if (ranges) for (const i of m.items) if (!i.test && ranges.some(([a, b]) => a <= (i.end ?? i.line) && b >= i.line)) out.push(itemKey(m.id, i));
  }
  return out;
}

