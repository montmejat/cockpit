// The agent chat: cockpit runs Claude Code itself (Claude Agent SDK, on the user's own Claude Code
// login), so a project needs no other session and no hooks installed.
//
// Conversations are Claude Code sessions, stored where Claude Code keeps them (~/.claude): the
// page lists the project's sessions, including ones started in a terminal, and any of them can be
// reopened and continued. Cockpit keeps its own view of each one (the items below) in
// out/<project>/chats/<session>.json; a session it didn't run is read from Claude Code's record.
//
// What the page gets is a list of items (chat-items.ts). The agent's turns are recorded and checked
// at their end by chat-turn.ts; its brief is chat-brief.ts; plan usage is chat-usage.ts.
//
// Several agents can work at once: each conversation has its own Claude Code process while it
// works. The page shows them in panes, stacked (one by default; split to add one below): each
// pane shows one conversation. Opening another in a pane or starting a new one leaves the others
// running, and the page gets a short list of them (working, waiting for you). An agent that
// finishes its turn while no pane shows it is put away (its process ends); opening it again
// resumes its session.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createSdkMcpServer, deleteSession, getSessionMessages, listSessions, query, tool,
  type Query, type SDKMessage, type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { createIndex } from "./codeindex.ts";
import type { HookInput } from "./recorder.ts";
import { COCKPIT, outDir } from "./turns.ts";
import type { Terminals } from "./term.ts";
import { workspaceBrief, type Workspace } from "./workspace.ts";
import { brief } from "./chat-brief.ts";
import { attachedBlock, describe, itemsFromTranscript, now, streamItems, type Attached, type Image, type Item } from "./chat-items.ts";
import { turnChecks } from "./chat-turn.ts";
import { createUsage } from "./chat-usage.ts";

export { IMAGE_TYPES, type Image, type Item } from "./chat-items.ts";
type Context = { used: number; max: number } | null;
// What runs besides the open conversation: every agent cockpit holds, the open one included.
// `pane`: the pane showing it, if one does.
export type AgentInfo = { session: string | null; busy: boolean; asking: boolean; preview: string; pane: number | null };
// What a pane shows: its conversation, whole.
// A job the agent left running in the background (a shell command, a subagent), and since when.
export type Background = { id: string; description: string; type: string; since: string };
type PaneSnap = { pane: number; items: Item[]; busy: boolean; background: Background[]; model: string; models: string[]; context: Context; session: string | null };
type Event =
  | { type: "item"; pane: number; item: Item }
  | { type: "delta"; pane: number; id: string; text: string } // more text for a streamed reply
  | { type: "state"; pane: number; busy: boolean; background: Background[]; model: string; context: Context; session: string | null }
  | { type: "pane" } & PaneSnap // a pane now shows another conversation
  | { type: "panes"; ids: number[] } // panes split or closed, top to bottom
  | { type: "agents"; agents: AgentInfo[] }
  | { type: "init"; panes: PaneSnap[]; agents: AgentInfo[] };

const MAX_PANES = 4;
const EDITS = "Edit|Write|MultiEdit|NotebookEdit";
export const MODELS = ["haiku", "sonnet", "opus"];
// An Allow/Deny card left unanswered this long is denied, so a turn doesn't wait forever (the
// agent is told, and can ask again or go another way).
const ASK_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_MODEL = "opus"; // until a model is picked in the chat; the pick is kept per project

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

// Tools cockpit gives the agent: read the owner's terminals, and the review in progress with its
// merge request's discussions.
function cockpitTools(terms: Terminals, review: () => Promise<string>) {
  return createSdkMcpServer({
    name: "cockpit",
    tools: [tool(
      "terminals",
      "Read the owner's terminals in cockpit: for each one, the last commands they ran with exit codes and output (colors stripped), and what is running now. Use it when the owner refers to something they ran.",
      { terminal: z.string().optional().describe("one terminal id, like t1; all terminals when left out"), last: z.number().int().min(1).max(20).optional().describe("how many recent commands per terminal, default 3") },
      async ({ terminal, last }) => ({ content: [{ type: "text", text: terms.read(terminal, last ?? 3) }] }),
      { annotations: { readOnlyHint: true } },
    ), tool(
      "review_threads",
      "The merge request (or pull request) the owner is reviewing in cockpit, its diff command, and every discussion on it as the forge has it now: who commented, on which file and line (or on the whole request), what they said, the replies, and whether it is resolved. Use it when the owner asks about the review or about someone's comment.",
      {},
      async () => ({ content: [{ type: "text", text: await review() }] }),
      { annotations: { readOnlyHint: true } },
    )],
  });
}

// `workspace`: the workspace this project is viewed in, if any (workspace.ts). `review`: the review
// in progress and its discussions, as text (project-server.ts).
export function createChat(root: string, project: string, terms: Terminals, index: ReturnType<typeof createIndex>, onChecks?: () => void, workspace: () => Workspace | null = () => null,
  review: () => Promise<string> = async () => "No review in progress in cockpit.") {
  const dir = join(outDir(project), "chats");
  mkdirSync(dir, { recursive: true });
  // Conversation ids are Claude Code's session UUIDs; anything else from the page is refused, so
  // an id can't name a file outside this folder.
  const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const fileOf = (id: string) => {
    if (!SESSION_ID.test(id)) throw new Error("not a conversation id");
    return join(dir, `${id}.json`);
  };
  // Which conversations the panes show, and the model picked, survive a restart.
  const metaFile = join(dir, "current.json");
  const legacy = join(outDir(project), "chat.json");
  if (existsSync(legacy) && !existsSync(metaFile)) { // cockpit's single conversation, before the list
    try {
      const old = JSON.parse(readFileSync(legacy, "utf8"));
      if (old.sessionId) writeFileSync(fileOf(old.sessionId), JSON.stringify({ items: old.items ?? [], context: null }));
      writeFileSync(metaFile, JSON.stringify({ sessions: [old.sessionId ?? null], model: old.model ?? DEFAULT_MODEL }));
      renameSync(legacy, legacy + ".old");
    } catch {}
  }
  const meta = (() => { try { return JSON.parse(readFileSync(metaFile, "utf8")); } catch { return {}; } })();
  // Each conversation's number ("Chat n"), given once; `last`: the highest ever given, so a
  // deleted conversation's number isn't given again.
  const numbersFile = join(dir, "numbers.json");
  const numbers: { last: number; of: Record<string, number> } = (() => {
    try { const v = JSON.parse(readFileSync(numbersFile, "utf8")); if (typeof v.last === "number" && v.of) return v; } catch {}
    return { last: 0, of: {} };
  })();
  let model: string = MODELS.includes(meta.model) ? meta.model : DEFAULT_MODEL;
  const listeners = new Set<(e: Event) => void>();
  const emit = (e: Event) => { for (const l of listeners) l(e); };

  // ---- one agent: a conversation, and its Claude Code process while it works ----------------

  type Agent = ReturnType<typeof agent>;
  const agents: Agent[] = [];
  // The panes, top to bottom; ids stay with a pane while others are closed.
  type Pane = { id: number; agent: Agent };
  const panes: Pane[] = [];
  let paneSeq = 0;
  const paneOf = (id: unknown) => panes.find((p) => p.id === Number(id)) ?? panes[0]; // none given: the top one
  const isShown = (a: Agent) => panes.some((p) => p.agent === a);
  const snap = (p: Pane): PaneSnap => ({ pane: p.id, ...p.agent.snapshot() });
  const saveMeta = () => writeFileSync(metaFile, JSON.stringify({ sessions: panes.map((p) => p.agent.session), model }));
  const info = (): AgentInfo[] => agents.map((a) => ({ session: a.session, busy: a.busy, asking: a.asking(), preview: a.preview(), pane: panes.find((p) => p.agent === a)?.id ?? null }));
  let lastInfo = "";
  const agentsChanged = () => { const j = JSON.stringify(info()); if (j !== lastInfo) { lastInfo = j; emit({ type: "agents", agents: info() }); } };

  // `from`: what to show of a session cockpit didn't run (read from Claude Code's record).
  function agent(startSession: string | null, from: Item[] = []) {
    let session = startSession;
    let items: Item[] = from;
    let context: Context = null;
    if (session) {
      try { if (existsSync(fileOf(session))) ({ items, context } = { context: null, ...JSON.parse(readFileSync(fileOf(session), "utf8")) }); } catch {}
    }
    let busy = false;
    let background: Background[] = []; // its live background jobs, as the session last listed them
    let q: Query | null = null;
    let box: ReturnType<typeof inbox> | null = null;
    let abort: AbortController | null = null;
    const waiting = new Map<string, (allow: boolean) => void>();
    let ws: Workspace | null = null; // the workspace its session started in
    let seq = 0; // for item ids made here (notes): two in the same millisecond must not collide
    const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

    const shown = () => isShown(self);
    // To each pane showing this conversation (usually one, none when it works out of sight).
    const toPanes = (e: { type: "item"; item: Item } | { type: "delta"; id: string; text: string } | { type: "state"; busy: boolean; background: Background[]; model: string; context: Context; session: string | null }) => {
      for (const p of panes) if (p.agent === self) emit({ ...e, pane: p.id } as Event);
    };
    let saveTimer: NodeJS.Timeout | null = null;
    const flush = () => {
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
      if (session) writeFileSync(fileOf(session), JSON.stringify({ items, context }));
      if (shown()) saveMeta();
    };
    const save = () => { if (!saveTimer) saveTimer = setTimeout(flush, 300); };
    const state = () => { toPanes({ type: "state", busy, background, model, context, session }); agentsChanged(); };
    const put = (item: Item) => {
      const i = items.findIndex((x) => x.id === item.id);
      if (i >= 0) items[i] = item; else items.push(item);
      toPanes({ type: "item", item });
      if (item.kind === "ask") agentsChanged();
      save();
    };
    const get = (id: string) => items.find((x) => x.id === id);
    const note = (text: string, more: Partial<Item> = {}) => put({ id: uid("note"), kind: "note", at: now(), text, ...more });
    const stream = streamItems(root, { put, get, delta: (id, text) => toPanes({ type: "delta", id, text }) });
    const turn = turnChecks({ root, project, index, workspace: () => ws, note, onChecks });

    // A conversation cockpit hasn't measured yet: its size from the last reply's token counts, out
    // of the window the model had then (from the session's own record, else the model's usual one).
    async function estimate() {
      const id = session;
      if (!id || context) return;
      try {
        const msgs = await getSessionMessages(id, { dir: root });
        for (let i = msgs.length - 1; i >= 0; i--) {
          const m = msgs[i].message as any;
          if (msgs[i].type !== "assistant" || !m?.usage || msgs[i].parent_tool_use_id) continue;
          const u = m.usage, used = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0);
          const max = await plan.windowOf(m.model);
          if (session === id && !context && max) { context = { used, max }; save(); state(); }
          return;
        }
      } catch {}
    }
    // How full the conversation's context is, asked of the running session after each turn.
    async function measure() {
      try {
        const c = await q?.getContextUsage({ detail: "summary" });
        if (c) { context = { used: c.totalTokens, max: c.maxTokens }; save(); state(); }
      } catch {}
    }

    function start() {
      ws = workspace();
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
          // In a workspace (workspace.ts) the agent also reads and edits the other projects, and keeps the
          // workspace's SYSTEM.md; the brief says what each project is. Read when a conversation
          // starts, so a change to the workspace shows from the next one.
          ...(ws ? { additionalDirectories: [...ws.projects.filter((p) => !p.here).map((p) => p.path), ws.dir] } : {}),
          systemPrompt: { type: "preset", preset: "claude_code", append: brief(root) + (ws ? "\n\n" + workspaceBrief(ws, COCKPIT) : "") },
          disallowedTools: ["AskUserQuestion"], // the agent asks in the chat instead
          mcpServers: { cockpit: cockpitTools(terms, review) },
          allowedTools: ["mcp__cockpit__terminals", "mcp__cockpit__review_threads"],
          ...(session ? { resume: session } : {}),
          canUseTool: async (tool, input, { signal, decisionReason }) => {
            const id = "ask-" + Math.random().toString(36).slice(2, 10);
            put({ id, kind: "ask", at: now(), tool, ...describe(root, tool, input), reason: decisionReason ?? null, status: "waiting" });
            let expired = false;
            const allow = await new Promise<boolean>((res) => {
              signal.addEventListener("abort", () => res(false));
              const t = setTimeout(() => { expired = true; res(false); }, ASK_TIMEOUT_MS);
              signal.addEventListener("abort", () => clearTimeout(t));
              waiting.set(id, (a) => { clearTimeout(t); res(a); });
            });
            waiting.delete(id);
            put({ ...get(id)!, status: allow ? "allowed" : expired ? "expired" : "denied" });
            agentsChanged();
            return allow ? { behavior: "allow", updatedInput: input }
              : { behavior: "deny", message: expired ? `Nobody answered in cockpit within ${ASK_TIMEOUT_MS / 60_000} minutes, so it was declined. Ask in the chat if you still need it.` : "The owner declined this in cockpit." };
          },
          hooks: {
            UserPromptSubmit: [{ hooks: [async (i) => { turn.begin(i as HookInput); return {}; }] }],
            PreToolUse: [{ matcher: EDITS, hooks: [async (i) => { turn.beforeEdit(i as HookInput); return {}; }] }],
            PostToolUse: [{ matcher: EDITS, hooks: [async (i) => { turn.afterEdit(i as HookInput); return {}; }] }],
            Stop: [{ hooks: [async (i) => { const reason = await turn.end(i as HookInput); return reason ? { decision: "block", reason } : {}; }] }],
          },
        },
      });
      const mine = q;
      pump(mine).catch((e) => { if (q === mine) note("The agent stopped: " + String(e?.message ?? e), { error: true }); })
        .finally(() => { if (q === mine) { q = null; box = null; busy = false; background = []; state(); } });
    }

    async function pump(cur: Query) {
      for await (const m of cur as AsyncIterable<SDKMessage>) {
        if (cur !== q) return; // stopped
        const mm = m as any;
        if (mm.type === "system" && mm.subtype === "init") {
          if (session !== mm.session_id) { session = mm.session_id; state(); }
          save();
          continue;
        }
        if (mm.type === "rate_limit_event") { plan.forget(); continue; } // read it fresh next time
        // The whole list of live background jobs, each time it changes (housekeeping ones left out).
        if (mm.type === "system" && mm.subtype === "background_tasks_changed") {
          const since = new Map(background.map((b) => [b.id, b.since]));
          background = (mm.tasks ?? []).filter((t: any) => !t.ambient)
            .map((t: any) => ({ id: t.task_id, description: t.description, type: t.task_type, since: since.get(t.task_id) ?? now() }));
          state();
          continue;
        }
        if (mm.parent_tool_use_id && mm.type !== "user" && mm.type !== "assistant") continue;
        if (stream(mm)) continue;
        if (mm.type === "result") {
          busy = false;
          put({ id: "done-" + mm.uuid, kind: "done", at: now(), ms: mm.duration_ms, turns: mm.num_turns, error: mm.subtype !== "success" ? mm.subtype : null });
          state();
          plan.forget();
          // Done while you look elsewhere: put away (opening it again resumes the session).
          if (!shown()) { flush(); stop(); drop(self); }
          else void measure();
        }
      }
    }

    function stop() {
      for (const r of waiting.values()) r(false);
      abort?.abort();
      q = null; box = null; busy = false; background = [];
    }

    const self = {
      get session() { return session; },
      get busy() { return busy; },
      get q() { return q; },
      asking: () => items.some((x) => x.kind === "ask" && x.status === "waiting"),
      // Its first message, for the list of running agents (a new one isn't in Claude Code's list yet).
      preview: () => String(items.find((x) => x.kind === "user")?.text ?? "").slice(0, 200),
      snapshot: () => ({ items, busy, background, model, models: MODELS, context, session }),
      send(text: string, images: Image[], attached: Attached[] = []) {
        put({ id: uid("u"), kind: "user", at: now(), text, ...(images.length ? { thumbs: images.map((i) => i.thumb) } : {}), ...(attached.length ? { chips: attached.map((a) => a.label) } : {}) });
        if (!q) start();
        const content = images.length || attached.length
          ? [
              ...attached.map((a) => ({ type: "text" as const, text: attachedBlock(a) })),
              ...images.map((i) => ({ type: "image" as const, source: { type: "base64" as const, media_type: i.media, data: i.data } })),
              ...(text.trim() ? [{ type: "text" as const, text }] : []),
            ]
          : text;
        box!.push({ type: "user", message: { role: "user", content }, parent_tool_use_id: null } as SDKUserMessage);
        busy = true;
        state();
      },
      answer(id: string, allow: boolean) { const r = waiting.get(id); r?.(allow); return !!r; },
      async interrupt() { for (const r of waiting.values()) r(false); await q?.interrupt().catch(() => {}); },
      async setModel(m: string) { await q?.setModel(m).catch(() => {}); },
      stop, flush, estimate,
    };
    return self;
  }

  function drop(a: Agent) {
    const i = agents.indexOf(a);
    if (i >= 0 && !isShown(a)) agents.splice(i, 1);
    agentsChanged();
  }
  // An agent no pane shows any more: it keeps working if it is; idle, it is put away.
  function putAway(a: Agent) { if (!isShown(a) && !a.busy) { a.flush(); a.stop(); drop(a); } }
  // Show `a` in a pane: the page gets its whole conversation there.
  function show(pane: Pane, a: Agent) {
    const was = pane.agent;
    pane.agent = a;
    if (!agents.includes(a)) agents.push(a);
    if (was !== a) putAway(was);
    saveMeta();
    emit({ type: "pane", ...snap(pane) });
    agentsChanged();
    void a.estimate();
  }

  const plan = createUsage(root, () => model, () => agents.find((a) => a.q)?.q ?? null);

  const opened: unknown[] = Array.isArray(meta.sessions) ? meta.sessions.slice(0, MAX_PANES) : [meta.session];
  for (const s of opened.length ? opened : [null]) {
    const id = typeof s === "string" && SESSION_ID.test(s) ? s : null;
    const a = (id && agents.find((x) => x.session === id)) || agent(id);
    if (!agents.includes(a)) { agents.push(a); void a.estimate(); }
    panes.push({ id: ++paneSeq, agent: a });
  }
  const panesChanged = () => { saveMeta(); emit({ type: "panes", ids: panes.map((p) => p.id) }); agentsChanged(); };

  return {
    snapshot: () => ({ panes: panes.map(snap), agents: info() }),
    subscribe(l: (e: Event) => void) { listeners.add(l); return () => { listeners.delete(l); }; },
    // A message to the open conversation, with images pasted into it (sent to Claude as image
    // blocks before the text; the chat keeps only small previews of them).
    send(pane: unknown, text: string, images: Image[] = [], attached: Attached[] = []) {
      if (!text.trim() && !images.length && !attached.length) return;
      paneOf(pane).agent.send(text, images, attached);
    },
    // An Allow/Deny card: whichever agent asked.
    answer(id: string, allow: boolean) { for (const a of agents) if (a.answer(id, allow)) return; },
    async stop(pane: unknown) { await paneOf(pane).agent.interrupt(); },
    // The model is the project's: every pane's agent switches.
    async setModel(m: string) {
      if (!MODELS.includes(m)) return;
      model = m;
      await Promise.all(panes.map((p) => p.agent.setModel(m)));
      saveMeta();
      for (const p of panes) { const { busy, background, context, session } = p.agent.snapshot(); emit({ type: "state", pane: p.id, busy, background, model, context, session }); }
    },
    usage: plan.usage,
    // The project's Claude Code sessions, newest first: cockpit's and ones run elsewhere. Each is
    // "Chat n", numbered in the order they were started (Claude Code's own titles are summaries),
    // with its first message as a preview, and whether its agent is working now. A number is given
    // once and kept (numbers.json): deleting a conversation leaves a gap, it doesn't renumber the others.
    async sessions() {
      const list = await listSessions({ dir: root, limit: 500 });
      const born = (s: (typeof list)[number]) => s.createdAt ?? s.lastModified;
      let added = false;
      for (const s of [...list].sort((a, b) => born(a) - born(b)))
        if (!(s.sessionId in numbers.of)) { numbers.of[s.sessionId] = ++numbers.last; added = true; }
      if (added) writeFileSync(numbersFile, JSON.stringify(numbers));
      return list.slice(0, 80).map((s) => {
        const a = agents.find((x) => x.session === s.sessionId), n = numbers.of[s.sessionId];
        return {
          id: s.sessionId, n, title: `Chat ${n}`,
          preview: s.firstPrompt || s.summary || "", at: s.lastModified,
          branch: s.gitBranch ?? null, here: SESSION_ID.test(s.sessionId) && existsSync(fileOf(s.sessionId)),
          busy: !!a?.busy, asking: !!a?.asking(),
        };
      });
    },
    // Delete a past conversation: Claude Code's transcript and cockpit's copy. Not one a pane
    // shows, nor one whose agent is working.
    async remove(id: string) {
      const f = fileOf(id); // checks the id
      if (panes.some((p) => p.agent.session === id)) throw new Error("that conversation is open: start a new one first");
      const a = agents.find((x) => x.session === id);
      if (a?.busy) throw new Error("its agent is working: stop it first");
      if (a) { a.stop(); drop(a); }
      await deleteSession(id, { dir: root });
      rmSync(f, { force: true });
      delete numbers.of[id]; // its number stays used (numbers.last)
      writeFileSync(numbersFile, JSON.stringify(numbers));
    },
    // Open another conversation in a pane: its agent if one is running, else its record (the next
    // message resumes it).
    async open(pane: unknown, id: string) {
      fileOf(id); // checks the id
      const p = paneOf(pane);
      if (id === p.agent.session) return;
      const running = agents.find((x) => x.session === id);
      if (running) return show(p, running);
      show(p, existsSync(fileOf(id)) ? agent(id) : agent(id, itemsFromTranscript(root, await getSessionMessages(id, { dir: root }))));
    },
    // A fresh conversation in a pane, with an agent of its own. The one left keeps working.
    reset(pane: unknown) { show(paneOf(pane), agent(null)); },
    // Split: a new pane below the others, on a fresh conversation.
    split() {
      if (panes.length >= MAX_PANES) throw new Error(`at most ${MAX_PANES} chats side by side`);
      const p: Pane = { id: ++paneSeq, agent: agent(null) };
      panes.push(p); agents.push(p.agent);
      emit({ type: "pane", ...snap(p) });
      panesChanged();
      return { pane: p.id };
    },
    // Close a pane (not the last one): its conversation stays in the list, and keeps working if it is.
    closePane(id: unknown) {
      const i = panes.findIndex((p) => p.id === Number(id));
      if (i < 0 || panes.length < 2) return;
      const [p] = panes.splice(i, 1);
      putAway(p.agent);
      panesChanged();
    },
    // The server is stopping: every agent's process goes with it.
    close() { for (const a of agents) { a.flush(); a.stop(); } },
  };
}
