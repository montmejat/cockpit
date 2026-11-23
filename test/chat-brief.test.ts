// The brief the agent gets: what the project's .cockpit/ says, or how to start one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brief } from "../src/chat-brief.ts";

test("no .cockpit/: the agent is told to create it, and that guardrails are off", (t) => {
  const root = mkdtempSync(join(tmpdir(), "cockpit-brief-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const b = brief(root);
  assert.match(b, /has no \.cockpit\/ yet/);
  assert.match(b, /Guardrails .* are off/);
});

test("a described project: its summary, features with modules, diagrams and guardrails", (t) => {
  const root = mkdtempSync(join(tmpdir(), "cockpit-brief-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".cockpit/diagrams"), { recursive: true });
  writeFileSync(join(root, ".cockpit/README.md"), "");
  writeFileSync(join(root, ".cockpit/guardrails.json"), "{}");
  writeFileSync(join(root, ".cockpit/project.json"), JSON.stringify({
    summary: "A tool.", features: [{ id: "f", name: "Feat", status: "partial", note: "half done", description: "", modules: ["x/a", "x/b"] }],
  }));
  writeFileSync(join(root, ".cockpit/diagrams/flow.json"), JSON.stringify({ tldr: "how it flows", nodes: [], edges: [] }));
  const b = brief(root);
  assert.match(b, /What it says now:\nA tool\./);
  assert.match(b, /- Feat \[f, partial\]: half done · x\/a, x\/b/);
  assert.match(b, /- flow: how it flows/);
  assert.match(b, /This project has guardrails/);
});
