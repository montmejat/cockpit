// Links in agent replies: file references and code names, across a workspace's projects.
import { test } from "node:test";
import assert from "node:assert/strict";
import { codeRefs, md } from "../web/src/lib/code.ts";

const refs = codeRefs([
  { name: "limb-stack", prefix: "", files: ["hal/Hal.cpp"], modules: [{ id: "hal/Hal", file: "hal/Hal.cpp", items: [{ key: "hal/Hal::Client::connected", line: 5 }] }] },
  { name: "la", prefix: "@la/", files: ["src/Node.cpp", "include/Node.hpp"], modules: [
    { id: "Node.cpp", file: "src/Node.cpp", items: [{ key: "Node.cpp::Node::gains_ok", line: 161 }, { key: "Node.cpp::Node::build_layout", line: 200 }] },
    { id: "Node.hpp", file: "include/Node.hpp", items: [{ key: "Node.hpp::Node::gains_ok", line: 40 }, { key: "Node.hpp::Robot::connected", line: 9 }] },
  ] },
]);
const links = (s: string) => [...md(s, refs).matchAll(/data-path="([^"]+)"(?: data-line=(\d+))?[^>]*>(.*?)<\/a>/g)].map((m) => `${m[3]} -> ${m[1]}:${m[2]}`);

test("a file of another project of the workspace is linked with its prefix", () => {
  assert.deepEqual(links("see src/Node.cpp:161 and la/include/Node.hpp"), ["src/Node.cpp:161 -> @la/src/Node.cpp:161", "la/include/Node.hpp -> @la/include/Node.hpp:undefined"]);
});

test("a code name links to its one definition, the .cpp rather than the header", () => {
  assert.deepEqual(links("`gains_ok()` and `build_layout()`"), ["<code>gains_ok()</code> -> @la/src/Node.cpp:161", "<code>build_layout()</code> -> @la/src/Node.cpp:200"]);
});

test("an owner narrows a name; ambiguous names, expressions and unknown names stay plain", () => {
  assert.deepEqual(links("then `Robot::connected()`"), ["<code>Robot::connected()</code> -> @la/include/Node.hpp:9"]);
  assert.deepEqual(links("`robot_->connected()` `connected() && x` `HumJointData`"), []);
});
