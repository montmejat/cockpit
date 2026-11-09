// The agent chat: cockpit runs Claude Code itself (Claude Agent SDK, on the user's own login),
// so a project needs no other session and no hooks installed. One conversation per project,
// kept in out/<project>/chat.json; the page follows it over server-sent events.
//
// What the page gets is a list of items, each added once and then replaced by id as it changes:
//   user · text (grows while the agent writes) · tool (running → ok/error) · ask (an Allow/Deny
//   card, when auto mode wants the user) · done (one per turn, with its cost) · note

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { createSdkMcpServer, query, tool, type Query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { ARCH_DIR } from "./arch.ts";
import { turnStart, turnTool, type HookInput } from "./recorder.ts";
import { COCKPIT, outDir } from "./turns.ts";
import type { Terminals } from "./term.ts";

export type Item = { id: string; kind: string; at: string; [k: string]: unknown };
type Event = { type: "item"; item: Item } | { type: "state"; busy: boolean; model: string; cost: number };

export const MODELS = ["haiku", "sonnet", "opus"];

// A queue the SDK reads the user's messages from; it stays open between turns.
function inbox() {
  const buf: SDKUserMessage[] = [];
  let wake: (() => void) | null = null;
  return {
    push(m: SDKUserMessage) { buf.push(m); wake?.(); wake = null; },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (buf.length) yield buf.shift()!;
        await new Promise<void>((r) => (wake = r));
      }
    },
  };
}

// The brief added to Claude Code's own system prompt.
function brief(root: string) {
  const has = existsSync(join(root, ARCH_DIR, "README.md"));
  return [
    "You are working inside cockpit. Its owner watches live diagrams of this code while you work, and reads your replies in a narrow chat panel: keep replies short, outcome first, details only if asked.",
    "Create and change files with the Write and Edit tools, not shell commands: cockpit follows those tools to show your changes as you make them.",
    "The owner also works in terminals inside cockpit (build, run, the project's CLI). When they mention a command, its output, an error, or say \"that\" about something they ran, read their terminals with the mcp__cockpit__terminals tool instead of asking them to paste it.",
    `To check ${ARCH_DIR}/ against the code yourself, run: cd ${COCKPIT} && npm run -s check-arch -- ${root}`,
    has
      ? `The project is described in ${ARCH_DIR}/ (features and diagrams). Read ${ARCH_DIR}/README.md before you start and keep the folder true as you work.`
      : `This project has no ${ARCH_DIR}/ yet. When the owner asks you to describe the project, or with your first change, create it: copy ${join(COCKPIT, "templates", "cockpit-README.md")} to ${ARCH_DIR}/README.md and follow it.`,
  ].join("\n\n");
}

// A short line for a tool call, and the file it is about, if any.
function describe(root: string, name: string, input: any): { title: string; detail?: string; file?: string } {
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
    case "TodoWrite": return { title: "plan", detail: (input?.todos ?? []).map((t: any) => (t.status === "completed" ? "✓ " : t.status === "in_progress" ? "▸ " : "· ") + t.content).join("\n") };
    default: return { title: name, detail: JSON.stringify(input ?? {}).slice(0, 400) };
  }
}

const now = () => new Date().toISOString();

// Tools cockpit gives the agent: read the owner's terminals.
function cockpitTools(terms: Terminals) {
  return createSdkMcpServer({
    name: "cockpit",
    tools: [tool(
      "terminals",
      "Read the owner's terminals in cockpit: for each one, the last commands they ran with exit codes and output (colors stripped), and what is running now. Use it when the owner refers to something they ran.",
      { terminal: z.string().optional().describe("one terminal id, like t1; all terminals when left out"), last: z.number().int().min(1).max(20).optional().describe("how many recent commands per terminal, default 3") },
      async ({ terminal, last }) => ({ content: [{ type: "text", text: terms.read(terminal, last ?? 3) }] }),
      { annotations: { readOnlyHint: true } },
    )],
  });
}

export function createChat(root: string, project: string, terms: Terminals) {
  const file = join(outDir(project), "chat.json");
  const saved = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  let items: Item[] = saved.items ?? [];
  let sessionId: string | null = saved.sessionId ?? null;
  let model: string = saved.model ?? "sonnet";
  let cost: number = saved.cost ?? 0;
  let busy = false;
  let q: Query | null = null;
  let box: ReturnType<typeof inbox> | null = null;
  let abort: AbortController | null = null;
  const listeners = new Set<(e: Event) => void>();
  const waiting = new Map<string, (allow: boolean) => void>();
  // Streaming text: which item each text block of a message goes to.
  const textSeen = new Map<string, number>(), textDone = new Map<string, number>();
  let streamMsg = "";
  let checks = 0; // times the .cockpit/ check sent the agent back this turn

  let saveTimer: NodeJS.Timeout | null = null;
  const save = () => {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      mkdirSync(outDir(project), { recursive: true });
      writeFileSync(file, JSON.stringify({ sessionId, model, cost, items }, null, 1));
    }, 300);
  };
  const emit = (e: Event) => { for (const l of listeners) l(e); };
  const state = () => emit({ type: "state", busy, model, cost });
  const put = (item: Item) => {
    const i = items.findIndex((x) => x.id === item.id);
    if (i >= 0) items[i] = item; else items.push(item);
    emit({ type: "item", item });
    save();
  };
  const get = (id: string) => items.find((x) => x.id === id);

  // The Stop check can build the code index (seconds), so it runs in its own process.
  const stopCheck = (input: HookInput) => new Promise<string | null>((ok) => {
    const p = spawn("node", ["--import", "tsx", join(COCKPIT, "src", "hook.ts"), "stop"], { cwd: COCKPIT, stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    p.stdout.on("data", (c) => (out += c));
    p.on("close", () => { try { ok(out ? JSON.parse(out).reason ?? null : null); } catch { ok(null); } });
    p.stdin.end(JSON.stringify(input));
  });

  function start() {
    box = inbox();
    abort = new AbortController();
    q = query({
      prompt: box,
      options: {
        cwd: root,
        model,
        permissionMode: "auto",
        includePartialMessages: true,
        abortController: abort,
        // Not "local": that is where cockpit's hooks for outside Claude Code sessions live.
        settingSources: ["user", "project"],
        systemPrompt: { type: "preset", preset: "claude_code", append: brief(root) },
        disallowedTools: ["AskUserQuestion"], // the agent asks in the chat instead
        mcpServers: { cockpit: cockpitTools(terms) },
        allowedTools: ["mcp__cockpit__terminals"],
        ...(sessionId ? { resume: sessionId } : {}),
        canUseTool: async (tool, input, { signal, decisionReason }) => {
          const id = "ask-" + Math.random().toString(36).slice(2, 10);
          put({ id, kind: "ask", at: now(), tool, ...describe(root, tool, input), reason: decisionReason ?? null, status: "waiting" });
          const allow = await new Promise<boolean>((res) => {
            waiting.set(id, res);
            signal.addEventListener("abort", () => res(false));
          });
          waiting.delete(id);
          put({ ...get(id)!, status: allow ? "allowed" : "denied" });
          return allow ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: "The owner declined this in cockpit." };
        },
        hooks: {
          UserPromptSubmit: [{ hooks: [async (i) => { checks = 0; try { turnStart(i as HookInput); } catch {} return {}; }] }],
          PostToolUse: [{ matcher: "Edit|Write|MultiEdit|NotebookEdit", hooks: [async (i) => { try { turnTool(i as HookInput); } catch {} return {}; }] }],
          Stop: [{ hooks: [async (i) => {
            // Up to 3 rounds of "fix what the check found" per turn, then let it stop.
            const reason = await stopCheck({ ...(i as HookInput), stop_hook_active: checks >= 3 });
            if (!reason) return {};
            checks++;
            put({ id: "note-" + Date.now(), kind: "note", at: now(), text: `${ARCH_DIR}/ doesn't match the code yet: sent the agent back to fix it.`, detail: reason });
            return { decision: "block", reason };
          }] }],
        },
      },
    });
    pump(q).catch((e) => put({ id: "err-" + Date.now(), kind: "note", at: now(), text: "The agent stopped: " + String(e?.message ?? e), error: true }))
      .finally(() => { q = null; box = null; busy = false; state(); });
  }

  async function pump(cur: Query) {
    for await (const m of cur as AsyncIterable<SDKMessage>) {
      const mm = m as any;
      if (mm.type === "system" && mm.subtype === "init") { sessionId = mm.session_id; save(); continue; }
      if (mm.parent_tool_use_id && mm.type !== "user" && mm.type !== "assistant") continue;
      if (mm.type === "stream_event") {
        if (mm.parent_tool_use_id) continue; // a subagent's own writing
        const ev = mm.event;
        if (ev.type === "message_start") streamMsg = ev.message.id;
        else if (ev.type === "content_block_start" && ev.content_block.type === "text") {
          const n = textSeen.get(streamMsg) ?? 0;
          textSeen.set(streamMsg, n + 1);
          put({ id: `${streamMsg}:${n}`, kind: "text", at: now(), text: "" });
        } else if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
          const it = get(`${streamMsg}:${(textSeen.get(streamMsg) ?? 1) - 1}`);
          if (it) { it.text = String(it.text) + ev.delta.text; emit({ type: "item", item: it }); }
        }
      } else if (mm.type === "assistant") {
        const sub = !!mm.parent_tool_use_id, mid = mm.message.id;
        for (const b of mm.message.content ?? []) {
          if (b.type === "text" && !sub) {
            const n = textDone.get(mid) ?? 0;
            textDone.set(mid, n + 1);
            put({ ...(get(`${mid}:${n}`) ?? { at: now() }), id: `${mid}:${n}`, kind: "text", text: b.text });
          } else if (b.type === "tool_use") {
            put({ id: b.id, kind: "tool", at: now(), tool: b.name, sub, status: "running", ...describe(root, b.name, b.input) });
          }
        }
      } else if (mm.type === "user" && Array.isArray(mm.message?.content)) {
        for (const b of mm.message.content) {
          if (b.type !== "tool_result" || !get(b.tool_use_id)) continue;
          const text = typeof b.content === "string" ? b.content : (b.content ?? []).map((c: any) => c.text ?? "").join("\n");
          put({ ...get(b.tool_use_id)!, status: b.is_error ? "error" : "ok", output: text.slice(0, 4000) });
        }
      } else if (mm.type === "result") {
        cost += mm.total_cost_usd ?? 0;
        busy = false;
        put({ id: "done-" + mm.uuid, kind: "done", at: now(), cost: mm.total_cost_usd ?? 0, ms: mm.duration_ms, turns: mm.num_turns, error: mm.subtype !== "success" ? mm.subtype : null });
        state();
      }
    }
  }

  return {
    items: () => items,
    snapshot: () => ({ items, busy, model, cost, models: MODELS }),
    subscribe(l: (e: Event) => void) { listeners.add(l); return () => listeners.delete(l); },
    send(text: string) {
      if (!text.trim()) return;
      put({ id: "u-" + Date.now(), kind: "user", at: now(), text });
      if (!q) start();
      box!.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null } as SDKUserMessage);
      busy = true;
      state();
    },
    answer(id: string, allow: boolean) { waiting.get(id)?.(allow); },
    async stop() { for (const r of waiting.values()) r(false); await q?.interrupt().catch(() => {}); },
    async setModel(m: string) {
      if (!MODELS.includes(m)) return;
      model = m;
      await q?.setModel(m).catch(() => {});
      save(); state();
    },
    reset() {
      abort?.abort();
      q = null; box = null; busy = false; sessionId = null; cost = 0; items = [];
      save(); emit({ type: "state", busy, model, cost });
      for (const l of listeners) l({ type: "item", item: { id: "reset", kind: "reset", at: now() } });
    },
  };
}
