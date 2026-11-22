// The .cockpit/ check: what an agent is sent back to fix.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkArch, type Architecture } from "../src/arch.ts";
import type { Skeleton } from "../src/skeleton.ts";

const sk: Skeleton = {
  root: "/p", lang: "ts", crates: [], edges: [],
  modules: [
    { id: "app/main", crate: "app", file: "src/main.ts", lines: 10, doc: "", libs: {}, items: [{ name: "run", kind: "Function", doc: "", line: 1, end: 5 }] },
    { id: "app/util", crate: "app", file: "src/util.ts", lines: 5, doc: "", libs: {}, items: [] },
    { id: "app/util.test", crate: "app", file: "test/util.test.ts", lines: 5, doc: "", libs: {}, items: [] },
  ],
};
const node = (id: string, anchors: string[], more = {}) => ({ id, label: id, tldr: "does a thing", explain: "it does a thing", anchors, ...more });
const good = (): Architecture => ({
  summary: "A test project.",
  features: [{ id: "run", name: "Run", status: "working", description: "runs", modules: ["app/main", "app/util"] } as any],
  diagrams: [{
    id: "main-loop", kind: "loop", question: "What runs?", tldr: "it runs once", answer: "It runs.", why: "order", rate: "once",
    nodes: [node("s", [], { start: true }), node("r", ["app/main::run"]), node("e", [], { end: true })],
    edges: [{ from: "s", to: "r", label: "args" }, { from: "r", to: "e", label: "exit code" }],
  } as any],
});
const problems = (a: Architecture) => checkArch({ arch: a, problems: [] }, sk).map((p) => `${p.where}: ${p.problem}`);

test("a description that matches the code has no problems (test modules need no feature)", () => {
  assert.deepEqual(problems(good()), []);
});

test("a module in no feature, and a link to nothing with a guess", () => {
  const a = good();
  a.features[0].modules = ["app/main"];
  a.diagrams[0].nodes[1].anchors = ["app/main::runn"];
  const p = problems(a);
  assert.ok(p.some((x) => x.includes(`module "app/util" (src/util.ts) serves no feature`)), p.join("\n"));
  assert.ok(p.some((x) => x.includes(`link "app/main::runn" matches no module or item`)), p.join("\n"));
});

test("partial needs a note, edges need labels and real ends, at most two next edges", () => {
  const a = good();
  a.features[0].status = "partial";
  a.diagrams[0].edges.push({ from: "r", to: "ghost", label: "" }, { from: "r", to: "s", label: "x", next: true }, { from: "e", to: "s", label: "x", next: true }, { from: "r", to: "r", label: "x", next: true });
  const p = problems(a).join("\n");
  assert.match(p, /is partial: say what's missing/);
  assert.match(p, /edge r -> ghost: no node "ghost"/);
  assert.match(p, /edge r -> ghost has no label/);
  assert.match(p, /3 "next" edges/);
});

test("no main loop, unknown kind", () => {
  const a = good();
  (a.diagrams[0] as any).kind = "flow";
  const p = problems(a).join("\n");
  assert.match(p, /no main loop/);
  assert.match(p, /kind "flow" is not one of/);
});
