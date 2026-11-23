// Workspaces are explicit: a folder with a workspace.json, listing its projects.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("create a workspace, add a project, load it from its folder", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "cockpit-ws-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  process.env.XDG_CONFIG_HOME = join(home, "config"); // before the module reads it
  const a = join(home, "a"), b = join(home, "b");
  mkdirSync(a); mkdirSync(b);
  const { addToWorkspace, createWorkspace, isWorkspace, listWorkspaces, loadWorkspace } = await import("../src/workspace.ts");

  assert.throws(() => createWorkspace("no spaces", [a]), /letters, digits/);
  const dir = createWorkspace("both", [a]);
  assert.equal(isWorkspace(dir), true);
  assert.equal(isWorkspace(a), false);
  assert.throws(() => createWorkspace("both", [b]), /already/);

  addToWorkspace(dir, b);
  assert.throws(() => addToWorkspace(dir, b), /already/);
  assert.throws(() => addToWorkspace(dir, join(home, "missing")), /doesn't exist/);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "workspace.json"), "utf8")).projects.length, 2);

  const w = loadWorkspace(dir)!;
  assert.equal(w.name, "both");
  assert.deepEqual(w.projects.map((p) => [p.name, p.here]), [["a", false], ["b", false]]); // the host's view: none is its own
  assert.deepEqual(loadWorkspace(dir, b)!.projects.map((p) => [p.name, p.here]), [["a", false], ["b", true]]);
  assert.deepEqual(listWorkspaces().map((x) => x.name), ["both"]);
});
