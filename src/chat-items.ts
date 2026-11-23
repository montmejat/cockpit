// What the chat shows of a conversation: a list of items, each added once and then replaced by id
// as it changes:
//   user · text (grows while the agent writes) · tool (running → ok/error) · ask (an Allow/Deny
//   card, when auto mode wants the user) · done (one per turn) · note
// Made here from Claude Code's messages: as they stream from a running agent (streamItems), or
// from the record of a session cockpit didn't run (itemsFromTranscript). No state besides the items.

import { relative } from "node:path";
import type { getSessionMessages } from "@anthropic-ai/claude-agent-sdk";

export type Item = { id: string; kind: string; at: string; [k: string]: unknown };
// A pasted image: what Claude gets (media type, base64), and a small preview for the chat.
export type Image = { media: "image/png" | "image/jpeg" | "image/gif" | "image/webp"; data: string; thumb: string };
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

export const now = () => new Date().toISOString();
export const textOf = (c: any): string => (typeof c === "string" ? c : Array.isArray(c) ? c.map((x: any) => (x.type === "text" ? x.text ?? "" : "")).join("\n") : "");

// A short line for a tool call, and the file it is about, if any.
export function describe(root: string, name: string, input: any): { title: string; detail?: string; file?: string } {
  const rel = (p?: string) => (p ? (p.startsWith(root + "/") ? relative(root, p) : p) : "");
  const file = input?.file_path ?? input?.notebook_path;
  switch (name) {
    case "Edit": case "MultiEdit": case "NotebookEdit": return { title: "edit " + rel(file), file: rel(file) };
    case "Write": return { title: "write " + rel(file), file: rel(file) };
    case "Read": return { title: "read " + rel(file), file: rel(file) };
    case "Bash": return { title: "$ " + String(input?.command ?? "").split("\n")[0], detail: input?.description };
    case "Grep": return { title: "search " + JSON.stringify(input?.pattern ?? "") + (input?.path ? " in " + rel(input.path) : "") };
    case "Glob": return { title: "find " + (input?.pattern ?? "") };
    case "Task": case "Agent": return { title: "agent: " + (input?.description ?? ""), detail: input?.prompt };
    case "WebFetch": return { title: "fetch " + (input?.url ?? "") };
    case "WebSearch": return { title: "search the web: " + (input?.query ?? "") };
    case "mcp__cockpit__terminals": return { title: "read your terminal" + (input?.terminal ? " " + input.terminal : "s") };
    case "mcp__cockpit__review_threads": return { title: "read the review's discussions" };
    case "TodoWrite": return { title: "plan", detail: (input?.todos ?? []).map((t: any) => (t.status === "completed" ? "✓ " : t.status === "in_progress" ? "▸ " : "· ") + t.content).join("\n") };
    default: return { title: name, detail: JSON.stringify(input ?? {}).slice(0, 400) };
  }
}

// Where streamed items go: `put` adds or replaces one by id, `delta` is more text for a text item
// already put (the page gets only the new text: sending the whole reply again on every token made
// the bytes grow with the square of its length).
export type ItemSink = { put(item: Item): void; get(id: string): Item | undefined; delta(id: string, text: string): void };

// A running agent's messages as items: its replies as they stream (then whole, once written),
// its tool calls and their results. Subagents show only as their tool calls. Other messages
// (init, result, rate limits) are the caller's: this returns false for them.
export function streamItems(root: string, out: ItemSink) {
  // Which item each text block of a message goes to: "<message id>:<n>", counted as blocks start
  // streaming, and again as the finished message arrives.
  const textSeen = new Map<string, number>(), textDone = new Map<string, number>();
  let streamMsg = "";
  return (mm: any): boolean => {
    if (mm.type === "stream_event") {
      if (mm.parent_tool_use_id) return true; // a subagent's own writing
      const ev = mm.event;
      if (ev.type === "message_start") streamMsg = ev.message.id;
      else if (ev.type === "content_block_start" && ev.content_block.type === "text") {
        const n = textSeen.get(streamMsg) ?? 0;
        textSeen.set(streamMsg, n + 1);
        out.put({ id: `${streamMsg}:${n}`, kind: "text", at: now(), text: "" });
      } else if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
        const it = out.get(`${streamMsg}:${(textSeen.get(streamMsg) ?? 1) - 1}`);
        if (it) { it.text = String(it.text) + ev.delta.text; out.delta(it.id, ev.delta.text); }
      }
      return true;
    }
    if (mm.type === "assistant") {
      const sub = !!mm.parent_tool_use_id, mid = mm.message.id;
      for (const b of mm.message.content ?? []) {
        if (b.type === "text" && !sub) {
          const n = textDone.get(mid) ?? 0;
          textDone.set(mid, n + 1);
          out.put({ ...(out.get(`${mid}:${n}`) ?? { at: now() }), id: `${mid}:${n}`, kind: "text", text: b.text });
        } else if (b.type === "tool_use") {
          out.put({ id: b.id, kind: "tool", at: now(), tool: b.name, sub, status: "running", ...describe(root, b.name, b.input) });
        }
      }
      return true;
    }
    if (mm.type === "user") {
      for (const b of Array.isArray(mm.message?.content) ? mm.message.content : []) {
        if (b.type !== "tool_result" || !out.get(b.tool_use_id)) continue;
        out.put({ ...out.get(b.tool_use_id)!, status: b.is_error ? "error" : "ok", output: textOf(b.content).slice(0, 4000) });
      }
      return true;
    }
    return false;
  };
}

// A Claude Code session cockpit didn't run (or ran before it kept items), as chat items.
export function itemsFromTranscript(root: string, msgs: Awaited<ReturnType<typeof getSessionMessages>>): Item[] {
  const items: Item[] = [], byTool = new Map<string, Item>();
  for (const m of msgs) {
    if (m.parent_tool_use_id) continue;
    const msg = m.message as any, at = now();
    if (m.type === "user") {
      if (typeof msg?.content === "string") {
        if (!msg.content.startsWith("<")) items.push({ id: m.uuid, kind: "user", at, text: msg.content }); // "<command-…>" and the like are Claude Code's own
        continue;
      }
      for (const b of msg?.content ?? []) {
        if (b.type === "text" && !String(b.text).startsWith("<")) items.push({ id: m.uuid + ":t", kind: "user", at, text: b.text });
        else if (b.type === "image") items.push({ id: m.uuid + ":i" + items.length, kind: "user", at, text: "", images: 1 });
        else if (b.type === "tool_result" && byTool.has(b.tool_use_id)) Object.assign(byTool.get(b.tool_use_id)!, { status: b.is_error ? "error" : "ok", output: textOf(b.content).slice(0, 4000) });
      }
    } else if (m.type === "assistant") {
      (msg?.content ?? []).forEach((b: any, i: number) => {
        if (b.type === "text" && b.text.trim()) items.push({ id: `${m.uuid}:${i}`, kind: "text", at, text: b.text });
        else if (b.type === "tool_use") { const it = { id: b.id, kind: "tool", at, tool: b.name, sub: false, status: "ok", ...describe(root, b.name, b.input) }; byTool.set(b.id, it); items.push(it); }
      });
    }
  }
  return items;
}
