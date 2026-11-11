// The agent chat: cockpit runs Claude Code itself (Claude Agent SDK, on the user's own Claude Code
// login), so a project needs no other session and no hooks installed.
//
// Conversations are Claude Code sessions, stored where Claude Code keeps them (~/.claude): the
// page lists the project's sessions, including ones started in a terminal, and any of them can be
// reopened and continued. Cockpit keeps its own view of each one (the items below) in
// out/<project>/chats/<session>.json; a session it didn't run is read from Claude Code's record.
//
// What the page gets is a list of items, each added once and then replaced by id as it changes:
//   user · text (grows while the agent writes) · tool (running → ok/error) · ask (an Allow/Deny
//   card, when auto mode wants the user) · done (one per turn) · note

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  createSdkMcpServer, getSessionMessages, listSessions, query, tool,
  type Query, type SDKMessage, type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { ARCH_DIR, checkArch, loadArch } from "./arch.ts";
import type { createIndex } from "./codeindex.ts";
import { turnEnd, turnStart, turnTool, type HookInput } from "./recorder.ts";
import { COCKPIT, outDir } from "./turns.ts";
import type { Terminals } from "./term.ts";
import { workspaceBrief, workspaceOf } from "./workspace.ts";

export type Item = { id: string; kind: string; at: string; [k: string]: unknown };
type Context = { used: number; max: number } | null;
type Event =
  | { type: "item"; item: Item }
  | { type: "state"; busy: boolean; model: string; context: Context; session: string | null }
  | { type: "init"; items: Item[]; busy: boolean; model: string; models: string[]; context: Context; session: string | null };

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
async function* never(): AsyncGenerator<SDKUserMessage> { await new Promise(() => {}); }

// The brief added to Claude Code's own system prompt.
function brief(root: string) {
  const has = existsSync(join(root, ARCH_DIR, "README.md"));
  return [
    "You are working inside cockpit. Its owner watches live diagrams of this code while you work, and reads your replies in a narrow chat panel: keep replies short, outcome first, details only if asked.",
    "Create and change files with the Write and Edit tools, not shell commands: cockpit follows those tools to show your changes as you make them.",
    "The owner also works in terminals inside cockpit (build, run, the project's CLI). When they mention a command, its output, an error, or say \"that\" about something they ran, read their terminals with the mcp__cockpit__terminals tool instead of asking them to paste it.",
    `To list every module and item cockpit knows, written exactly as ${ARCH_DIR}/ links them, run: cd ${COCKPIT} && npm run -s modules -- ${root} [filter]`,
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
const textOf = (c: any): string => (typeof c === "string" ? c : Array.isArray(c) ? c.map((x: any) => (x.type === "text" ? x.text ?? "" : "")).join("\n") : "");

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

// A Claude Code session cockpit didn't run (or ran before it kept items), as chat items.
function itemsFromTranscript(root: string, msgs: Awaited<ReturnType<typeof getSessionMessages>>): Item[] {
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

export function createChat(root: string, project: string, terms: Terminals, index: ReturnType<typeof createIndex>) {
  const dir = join(outDir(project), "chats");
  mkdirSync(dir, { recursive: true });
  const fileOf = (id: string) => join(dir, `${id}.json`);
  // Which conversation is open, and the model picked, survive a restart.
  const metaFile = join(dir, "current.json");
  const legacy = join(outDir(project), "chat.json");
  if (existsSync(legacy) && !existsSync(metaFile)) { // cockpit's single conversation, before the list
    try {
      const old = JSON.parse(readFileSync(legacy, "utf8"));
      if (old.sessionId) writeFileSync(fileOf(old.sessionId), JSON.stringify({ items: old.items ?? [], context: null }));
      writeFileSync(metaFile, JSON.stringify({ session: old.sessionId ?? null, model: old.model ?? "sonnet" }));
      renameSync(legacy, legacy + ".old");
    } catch {}
  }
  const meta = existsSync(metaFile) ? JSON.parse(readFileSync(metaFile, "utf8")) : {};
  let session: string | null = meta.session ?? null;
  let model: string = meta.model ?? "sonnet";
  let items: Item[] = [];
  let context: Context = null;
  if (session && existsSync(fileOf(session))) ({ items, context } = { context: null, ...JSON.parse(readFileSync(fileOf(session), "utf8")) });

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
  let lastProblems = ""; // what that check found last time (this turn or an earlier one): the same list again means a round fixed nothing

  let saveTimer: NodeJS.Timeout | null = null;
  const save = () => {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      writeFileSync(metaFile, JSON.stringify({ session, model }));
      if (session) writeFileSync(fileOf(session), JSON.stringify({ items, context }));
    }, 300);
  };
  const emit = (e: Event) => { for (const l of listeners) l(e); };
  const state = () => emit({ type: "state", busy, model, context, session });
  const snapshot = () => ({ items, busy, model, models: MODELS, context, session });
  const put = (item: Item) => {
    const i = items.findIndex((x) => x.id === item.id);
    if (i >= 0) items[i] = item; else items.push(item);
    emit({ type: "item", item });
    save();
  };
  const get = (id: string) => items.find((x) => x.id === id);

  // A conversation cockpit hasn't measured yet: its size from the last reply's token counts, out
  // of the window the model had then (from the session's own record, else the model's usual one).
  const WINDOW: Record<string, number> = {};
  async function estimate() {
    const id = session;
    if (!id || context) return;
    try {
      const msgs = await getSessionMessages(id, { dir: root });
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i].message as any;
        if (msgs[i].type !== "assistant" || !m?.usage || msgs[i].parent_tool_use_id) continue;
        const u = m.usage, used = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0);
        const max = WINDOW[m.model] ?? await windowOf(m.model);
        if (session === id && !context && max) { context = { used, max }; save(); state(); }
        return;
      }
    } catch {}
  }
  // The context window of a model, asked of a short-lived idle session (no message is sent).
  async function windowOf(model: string) {
    const probe = query({ prompt: never(), options: { cwd: root, model, settingSources: [] } });
    try { const c = await probe.getContextUsage({ detail: "summary" }); return (WINDOW[model] = c.maxTokens); }
    catch { return 0; } finally { probe.close(); }
  }

  // How full the conversation's context is, asked of the running session after each turn.
  async function measure() {
    try {
      const c = await q?.getContextUsage({ detail: "summary" });
      if (c) { context = { used: c.totalTokens, max: c.maxTokens }; save(); state(); }
    } catch {}
  }

  function start() {
    const ws = workspaceOf(root);
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
        // In a workspace (workspace.ts) the agent also reads the other projects, and keeps the
        // workspace's SYSTEM.md; the brief says what each project is. Read when a conversation
        // starts, so a change to the workspace shows from the next one.
        ...(ws ? { additionalDirectories: [...ws.projects.filter((p) => !p.here).map((p) => p.path), ws.dir] } : {}),
        systemPrompt: { type: "preset", preset: "claude_code", append: brief(root) + (ws ? "\n\n" + workspaceBrief(ws, COCKPIT) : "") },
        disallowedTools: ["AskUserQuestion"], // the agent asks in the chat instead
        mcpServers: { cockpit: cockpitTools(terms) },
        allowedTools: ["mcp__cockpit__terminals"],
        ...(session ? { resume: session } : {}),
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
          // Edits in the workspace's other projects need the owner's yes (an Allow/Deny card),
          // even in auto mode; the workspace's own notes (SYSTEM.md) don't.
          PreToolUse: [{ matcher: "Edit|Write|MultiEdit|NotebookEdit", hooks: [async (i: any) => {
            const f = i.tool_input?.file_path ?? i.tool_input?.notebook_path;
            if (!ws || typeof f !== "string") return {};
            const abs = isAbsolute(f) ? f : resolve(root, f);
            const inside = (d: string) => abs === d || abs.startsWith(d + "/");
            const other = ws.projects.find((p) => !p.here && inside(p.path));
            if (!other || inside(root)) return {};
            return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: `edits ${other.name}, another project of the workspace` } };
          }] }],
          UserPromptSubmit: [{ hooks: [async (i) => { checks = 0; try { turnStart(i as HookInput); } catch {} return {}; }] }],
          PostToolUse: [{ matcher: "Edit|Write|MultiEdit|NotebookEdit", hooks: [async (i) => { try { turnTool(i as HookInput); } catch {} return {}; }] }],
          Stop: [{ hooks: [async (i) => {
            // .cockpit/ must match the code: up to 3 rounds of "fix what the check found" per
            // turn, against the live index once it has caught up with the agent's edits. A round
            // that leaves exactly the same problems means the agent can't fix them (say, links into
            // code cockpit doesn't index): stop there instead of sending it back again.
            if (existsSync(join(root, ARCH_DIR)) && checks < 3) {
              const problems = checkArch(loadArch(root), await index.fresh());
              const sig = problems.map((x) => x.where + "\t" + x.problem).sort().join("\n");
              if (problems.length && sig === lastProblems) {
                put({ id: "note-" + Date.now(), kind: "note", at: now(), error: true,
                  text: `${ARCH_DIR}/ still doesn't match the code (${problems.length} problem${problems.length > 1 ? "s" : ""}), and the agent's last round changed nothing, so it wasn't sent back again.`,
                  detail: problems.slice(0, 30).map((x) => `- ${x.where}: ${x.problem}`).join("\n") });
              } else if (problems.length) {
                lastProblems = sig;
                checks++;
                const reason = `${ARCH_DIR}/ doesn't match the code (${problems.length} problem${problems.length > 1 ? "s" : ""}). ` +
                  `Fix it before finishing, as described in ${ARCH_DIR}/README.md:\n` + problems.slice(0, 30).map((x) => `- ${x.where}: ${x.problem}`).join("\n");
                put({ id: "note-" + Date.now(), kind: "note", at: now(), text: `${ARCH_DIR}/ doesn't match the code yet: sent the agent back to fix it.`, detail: reason });
                return { decision: "block", reason };
              }
            }
            try { turnEnd(i as HookInput); } catch {}
            return {};
          }] }],
        },
      },
    });
    const mine = q;
    pump(mine).catch((e) => { if (q === mine) put({ id: "err-" + Date.now(), kind: "note", at: now(), text: "The agent stopped: " + String(e?.message ?? e), error: true }); })
      .finally(() => { if (q === mine) { q = null; box = null; busy = false; state(); } });
  }

  async function pump(cur: Query) {
    for await (const m of cur as AsyncIterable<SDKMessage>) {
      if (cur !== q) return; // another conversation was opened
      const mm = m as any;
      if (mm.type === "system" && mm.subtype === "init") {
        if (session !== mm.session_id) { session = mm.session_id; state(); }
        save();
        continue;
      }
      if (mm.type === "rate_limit_event") { lastUsage = null; continue; } // read it fresh next time
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
          put({ ...get(b.tool_use_id)!, status: b.is_error ? "error" : "ok", output: textOf(b.content).slice(0, 4000) });
        }
      } else if (mm.type === "result") {
        busy = false;
        put({ id: "done-" + mm.uuid, kind: "done", at: now(), ms: mm.duration_ms, turns: mm.num_turns, error: mm.subtype !== "success" ? mm.subtype : null });
        state();
        void measure();
        lastUsage = null;
      }
    }
  }

  // Plan usage (the numbers behind /usage), cached for a minute. Asked of the running session, or
  // of a short-lived idle one: no message is sent, so it costs nothing.
  let lastUsage: { at: number; data: unknown } | null = null;
  async function usage() {
    if (lastUsage && Date.now() - lastUsage.at < 60_000) return lastUsage.data;
    let probe: Query | null = null;
    try {
      const src = q ?? (probe = query({ prompt: never(), options: { cwd: root, model, settingSources: [] } }));
      const u = await src.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
      const w = (x: any) => (x && x.utilization != null ? { pct: x.utilization, resets: x.resets_at } : null);
      const r = u.rate_limits;
      const data = u.rate_limits_available && r ? {
        plan: u.subscription_type,
        windows: [
          { name: "5 hours", ...w(r.five_hour) },
          { name: "week", ...w(r.seven_day) },
          ...(r.seven_day_opus ? [{ name: "week · opus", ...w(r.seven_day_opus) }] : []),
          ...(r.seven_day_sonnet ? [{ name: "week · sonnet", ...w(r.seven_day_sonnet) }] : []),
          ...(r.model_scoped ?? []).filter((m) => m.utilization).map((m) => ({ name: "week · " + m.display_name.toLowerCase(), ...w(m) })),
        ].filter((x: any) => x.pct != null),
      } : { plan: u.subscription_type, windows: [] };
      lastUsage = { at: Date.now(), data };
      return data;
    } catch (e: any) {
      return { error: String(e?.message ?? e), windows: [] };
    } finally {
      probe?.close();
    }
  }

  function stopRunning() {
    for (const r of waiting.values()) r(false);
    abort?.abort();
    q = null; box = null; busy = false;
  }

  void estimate();

  return {
    snapshot,
    subscribe(l: (e: Event) => void) { listeners.add(l); return () => { listeners.delete(l); }; },
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
    usage,
    // The project's Claude Code sessions, newest first: cockpit's and ones run elsewhere.
    async sessions() {
      const list = await listSessions({ dir: root, limit: 60 });
      return list.map((s) => ({
        id: s.sessionId, title: s.customTitle || s.summary || s.firstPrompt || "(empty)", at: s.lastModified,
        branch: s.gitBranch ?? null, here: existsSync(fileOf(s.sessionId)),
      }));
    },
    // Open another conversation; the next message continues it.
    async open(id: string) {
      if (id === session) return;
      stopRunning();
      session = id; context = null; items = [];
      if (existsSync(fileOf(id))) ({ items, context } = { context: null, ...JSON.parse(readFileSync(fileOf(id), "utf8")) });
      else items = itemsFromTranscript(root, await getSessionMessages(id, { dir: root }));
      save();
      emit({ type: "init", ...snapshot() });
      void estimate();
    },
    // A fresh conversation. The old one stays in the list.
    reset() {
      stopRunning();
      session = null; context = null; items = [];
      save();
      emit({ type: "init", ...snapshot() });
    },
  };
}
