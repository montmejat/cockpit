// The chat's items, made from Claude Code's messages: streamed from a running agent, or read back
// from a session's record. What the page shows of a conversation is only these.
import { test } from "node:test";
import assert from "node:assert/strict";
import { describe, itemsFromTranscript, streamItems, type Item } from "../src/chat-items.ts";

const root = "/p";

function sink() {
  const items: Item[] = [], deltas: string[] = [];
  const get = (id: string) => items.find((x) => x.id === id);
  const put = (it: Item) => { const i = items.findIndex((x) => x.id === it.id); if (i >= 0) items[i] = it; else items.push(it); };
  return { items, deltas, out: { put, get, delta: (_: string, t: string) => deltas.push(t) } };
}

test("tool calls get a short title, paths inside the project relative", () => {
  assert.deepEqual(describe(root, "Edit", { file_path: "/p/src/a.ts" }), { title: "edit src/a.ts", file: "src/a.ts" });
  assert.deepEqual(describe(root, "Read", { file_path: "/elsewhere/b.ts" }), { title: "read /elsewhere/b.ts", file: "/elsewhere/b.ts" });
  assert.equal(describe(root, "Bash", { command: "npm test\nmore", description: "run" }).title, "$ npm test");
  assert.equal(describe(root, "TodoWrite", { todos: [{ status: "completed", content: "a" }, { status: "in_progress", content: "b" }, { status: "pending", content: "c" }] }).detail, "✓ a\n▸ b\n· c");
  assert.equal(describe(root, "Unknown", { x: 1 }).detail, '{"x":1}');
});

test("a streamed reply grows by deltas, then the finished message replaces it in place", () => {
  const { items, deltas, out } = sink();
  const feed = streamItems(root, out);
  const ev = (event: unknown) => feed({ type: "stream_event", event, parent_tool_use_id: null });
  ev({ type: "message_start", message: { id: "m1" } });
  ev({ type: "content_block_start", content_block: { type: "text" } });
  ev({ type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } });
  ev({ type: "content_block_delta", delta: { type: "text_delta", text: "lo" } });
  assert.deepEqual(deltas, ["Hel", "lo"]);
  assert.equal(items[0].text, "Hello");
  const at = items[0].at;
  feed({ type: "assistant", parent_tool_use_id: null, message: { id: "m1", content: [{ type: "text", text: "Hello." }] } });
  assert.equal(items.length, 1);
  assert.deepEqual({ id: items[0].id, text: items[0].text, at: items[0].at }, { id: "m1:0", text: "Hello.", at });
});

test("a tool call runs, then its result marks it ok or error; a subagent shows only as tool calls", () => {
  const { items, out } = sink();
  const feed = streamItems(root, out);
  feed({ type: "assistant", parent_tool_use_id: null, message: { id: "m", content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/p/x" } }] } });
  assert.equal(items[0].status, "running");
  feed({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: [{ type: "text", text: "no such file" }] }] } });
  assert.deepEqual([items[0].status, items[0].output], ["error", "no such file"]);

  feed({ type: "stream_event", parent_tool_use_id: "t9", event: { type: "content_block_start", content_block: { type: "text" } } });
  feed({ type: "assistant", parent_tool_use_id: "t9", message: { id: "s", content: [{ type: "text", text: "sub's words" }, { type: "tool_use", id: "t2", name: "Grep", input: { pattern: "x" } }] } });
  assert.deepEqual(items.map((x) => [x.id, x.sub ?? null]), [["t1", false], ["t2", true]]);

  assert.equal(feed({ type: "result" }), false); // the caller's
});

test("a session's record reads back as items, without Claude Code's own messages or subagents", () => {
  const msgs = [
    { type: "user", uuid: "u1", parent_tool_use_id: null, message: { content: "fix it" } },
    { type: "user", uuid: "u2", parent_tool_use_id: null, message: { content: "<command-name>/clear</command-name>" } },
    { type: "assistant", uuid: "a1", parent_tool_use_id: null, message: { content: [{ type: "text", text: "On it" }, { type: "tool_use", id: "t1", name: "Write", input: { file_path: "/p/f" } }] } },
    { type: "assistant", uuid: "a2", parent_tool_use_id: "t1", message: { content: [{ type: "text", text: "subagent" }] } },
    { type: "user", uuid: "u3", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "done" }, { type: "image" }] } },
  ];
  const items = itemsFromTranscript(root, msgs as any);
  assert.deepEqual(items.map((x) => [x.kind, x.text ?? x.title]), [["user", "fix it"], ["text", "On it"], ["tool", "write f"], ["user", ""]]);
  assert.deepEqual([items[2].status, items[2].output], ["ok", "done"]);
});
