// The end of an agent's turn in the chat: recorded, then checked. The agent is sent back for what
// it broke, not for what was already broken, and not again when a round changed nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const state = mkdtempSync(join(tmpdir(), "cockpit-state-"));
process.env.COCKPIT_STATE = state; // before the modules read it
const { turnChecks, otherOf } = await import("../src/chat-turn.ts");
const { isTrusted, trust, loadGuardrails } = await import("../src/guardrails.ts");
const { listTurns } = await import("../src/turns.ts");

function project(t: { after(f: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "cockpit-turn-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", root]);
  mkdirSync(join(root, ".cockpit"));
  return root;
}
const noIndex = { fresh: async () => ({ modules: [] }) as any };
function run(root: string) {
  const notes: string[] = [];
  const c = turnChecks({ root, project: basename(root), index: noIndex, workspace: () => null, note: (t) => notes.push(t) });
  const hook = { cwd: root, session_id: "s1", prompt: "do it" };
  return { c, notes, hook, edit: (f: string) => { writeFileSync(join(root, f), "x"); c.beforeEdit({ ...hook, tool_name: "Write", tool_input: { file_path: join(root, f) } }); c.afterEdit({ ...hook, tool_name: "Write", tool_input: { file_path: join(root, f) } }); } };
}

test("a turn is recorded: snapshot, files touched, closed when the agent stops", async (t) => {
  const root = project(t);
  const { c, hook, edit } = run(root);
  c.begin(hook);
  edit("a.txt");
  assert.equal(await c.end(hook), null);
  const [turn] = listTurns(basename(root));
  assert.equal(turn.status, "done");
  assert.equal(turn.prompt, "do it");
  assert.deepEqual(turn.touched.map((x) => x.file), ["a.txt"]);
  assert.notEqual(turn.before, turn.after);
});

test("guardrails: sent back for a check the turn broke, not again when nothing changed; not for one already failing", async (t) => {
  const root = project(t);
  writeFileSync(join(root, ".cockpit/guardrails.json"), JSON.stringify({
    checks: [{ id: "flag", name: "Flag", run: "test -f flag" }, { id: "old", name: "Old", run: "false" }], rules: [],
  }));
  trust(root, loadGuardrails(root).g!);
  writeFileSync(join(root, "flag"), "");
  const { c, notes, hook, edit } = run(root);

  c.begin(hook); // nothing edited: no checks
  assert.equal(await c.end(hook), null);
  assert.equal(notes.length, 0);

  c.begin(hook); edit("a.txt"); // both run; "flag" passes, "old" fails, already failing
  assert.equal(await c.end(hook), null);
  assert.ok(notes.some((n) => n.startsWith("Already failing") && n.includes("Old")));

  rmSync(join(root, "flag"));
  c.begin(hook); edit("b.txt");
  const reason = await c.end(hook);
  assert.match(reason ?? "", /This turn broke a check/);
  assert.match(reason ?? "", /Flag failed/);
  assert.doesNotMatch(reason ?? "", /Old failed/);

  assert.equal(await c.end(hook), null); // the same failure again: told, not sent back
  assert.ok(notes.some((n) => n.startsWith("Still failing")));
});

test("untrusted guardrails don't run", async (t) => {
  const root = project(t);
  writeFileSync(join(root, ".cockpit/guardrails.json"), JSON.stringify({ checks: [{ id: "x", name: "X", run: "false" }], rules: [] }));
  const { c, notes, hook, edit } = run(root);
  c.begin(hook); edit("a.txt");
  assert.equal(await c.end(hook), null);
  assert.match(notes.join("\n"), /aren't trusted yet/);
});

test("an edit of the guardrails by the agent trusts them as written", async (t) => {
  const root = project(t);
  const { c, hook } = run(root);
  c.begin(hook);
  writeFileSync(join(root, ".cockpit/guardrails.json"), JSON.stringify({ checks: [{ id: "x", name: "X", run: "true" }], rules: [] }));
  c.afterEdit({ ...hook, tool_name: "Write", tool_input: { file_path: join(root, ".cockpit/guardrails.json") } });
  assert.equal(await c.end(hook), null);
  assert.equal(isTrusted(root, loadGuardrails(root).g!), true);
});

test(".cockpit/ that doesn't match the code sends the agent back, but not twice for the same problems", async (t) => {
  const root = project(t);
  writeFileSync(join(root, ".cockpit/project.json"), JSON.stringify({ summary: "s", features: [{ id: "f", name: "F", status: "working", description: "d", modules: ["nope/mod"] }] }));
  const { c, notes, hook } = run(root);
  c.begin(hook);
  assert.match((await c.end(hook)) ?? "", /doesn't match the code.*\n- .*nope\/mod/);
  assert.equal(await c.end(hook), null);
  assert.match(notes.at(-1)!, /changed nothing/);
});

test("a file in another project of the workspace, and only there", () => {
  const ws = { dir: "/w", projects: [{ name: "here", path: "/w/a", here: true }, { name: "b", path: "/w/b", here: false }, { name: "outer", path: "/w", here: false }] } as any;
  assert.equal(otherOf(ws, "/w/b/x.ts")?.name, "b");
  assert.equal(otherOf(ws, "/w/a/x.ts"), null); // inside this project, even though /w holds it
  assert.equal(otherOf(ws, "/w/bb/x.ts")?.name, "outer");
  assert.equal(otherOf(ws, "b/x.ts"), null);
  assert.equal(otherOf(null, "/w/b/x.ts"), null);
});

test.after(() => rmSync(state, { recursive: true, force: true }));
