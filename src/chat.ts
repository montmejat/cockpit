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
//
// Several agents can work at once: each conversation has its own Claude Code process while it
// works. The page shows one (the open one); opening another or starting a new one leaves the
// others running, and the page gets a short list of them (working, waiting for you). An agent
// that finishes its turn while you look elsewhere is put away (its process ends); opening it
// again resumes its session.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  createSdkMcpServer, deleteSession, getSessionMessages, listSessions, query, tool,
  type Query, type SDKMessage, type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { ARCH_DIR, checkArch, loadArch } from "./arch.ts";
import { GUARDRAILS, failureReport, isTrusted, lastResults, loadGuardrails, runChecks, trust } from "./guardrails.ts";
import type { createIndex } from "./codeindex.ts";
import { turnEnd, turnStart, turnTool, type HookInput } from "./recorder.ts";
import { COCKPIT, outDir } from "./turns.ts";
import type { Terminals } from "./term.ts";
import { workspaceBrief, type Workspace } from "./workspace.ts";

export type Item = { id: string; kind: string; at: string; [k: string]: unknown };
// A pasted image: what Claude gets (media type, base64), and a small preview for the chat.
export type Image = { media: "image/png" | "image/jpeg" | "image/gif" | "image/webp"; data: string; thumb: string };
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
type Context = { used: number; max: number } | null;
// What runs besides the open conversation: every agent cockpit holds, the open one included.
export type AgentInfo = { session: string | null; busy: boolean; asking: boolean; preview: string };
type Event =
  | { type: "item"; item: Item }
  | { type: "delta"; id: string; text: string } // more text for a streamed reply
  | { type: "state"; busy: boolean; model: string; context: Context; session: string | null }
  | { type: "agents"; agents: AgentInfo[] }
  | { type: "init"; items: Item[]; busy: boolean; model: string; models: string[]; context: Context; session: string | null; agents: AgentInfo[] };

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
async function* never(): AsyncGenerator<SDKUserMessage> { await new Promise(() => {}); }

// The brief added to Claude Code's own system prompt.
function brief(root: string) {
  const has = existsSync(join(root, ARCH_DIR, "README.md"));
  return [
    "You are working inside cockpit. Its owner watches live diagrams of this code while you work, and reads your replies in a narrow chat panel: keep replies short, outcome first, details only if asked.",
    "Create and change files with the Write and Edit tools, not shell commands: cockpit follows those tools to show your changes as you make them.",
    "The owner also works in terminals inside cockpit (build, run, the project's CLI). When they mention a command, its output, an error, or say \"that\" about something they ran, read their terminals with the mcp__cockpit__terminals tool instead of asking them to paste it.",
    "The owner reviews merge requests in cockpit too. When they ask about the review, a comment, or what a reviewer said or meant, read the review and its discussions (every comment, with file, line and replies) with the mcp__cockpit__review_threads tool, then check what is said against the code.",
    `To list every module and item cockpit knows, written exactly as ${ARCH_DIR}/ links them, run: cd ${COCKPIT} && npm run -s modules -- ${root} [filter]`,
    `To check ${ARCH_DIR}/ against the code yourself, run: cd ${COCKPIT} && npm run -s check-arch -- ${root}`,
    has
      ? `The project is described in ${ARCH_DIR}/ (features and diagrams). Read ${ARCH_DIR}/README.md before you start and keep the folder true as you work.`
      : `This project has no ${ARCH_DIR}/ yet. When the owner asks you to describe the project, or with your first change, create it: copy ${join(COCKPIT, "templates", "cockpit-README.md")} to ${ARCH_DIR}/README.md and follow it.`,
    existsSync(join(root, GUARDRAILS))
      ? `This project has guardrails: ${GUARDRAILS} (checks run when you finish a turn that edited files, and rules with why). Read ${join(COCKPIT, "templates", "guardrails.md")} once, before you change them or when the owner corrects how code is written.`
      : `Guardrails (checks and rules in ${GUARDRAILS}) are off in this project. Set them up only when the owner asks, following ${join(COCKPIT, "templates", "guardrails.md")}.`,
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
    case "mcp__cockpit__review_threads": return { title: "read the review's discussions" };
    case "TodoWrite": return { title: "plan", detail: (input?.todos ?? []).map((t: any) => (t.status === "completed" ? "✓ " : t.status === "in_progress" ? "▸ " : "· ") + t.content).join("\n") };
    default: return { title: name, detail: JSON.stringify(input ?? {}).slice(0, 400) };
  }
}

const now = () => new Date().toISOString();
const textOf = (c: any): string => (typeof c === "string" ? c : Array.isArray(c) ? c.map((x: any) => (x.type === "text" ? x.text ?? "" : "")).join("\n") : "");

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
  // Which conversation is open, and the model picked, survive a restart.
  const metaFile = join(dir, "current.json");
  const legacy = join(outDir(project), "chat.json");
  if (existsSync(legacy) && !existsSync(metaFile)) { // cockpit's single conversation, before the list
    try {
      const old = JSON.parse(readFileSync(legacy, "utf8"));
      if (old.sessionId) writeFileSync(fileOf(old.sessionId), JSON.stringify({ items: old.items ?? [], context: null }));
      writeFileSync(metaFile, JSON.stringify({ session: old.sessionId ?? null, model: old.model ?? DEFAULT_MODEL }));
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
  let current: Agent;
  const saveMeta = () => writeFileSync(metaFile, JSON.stringify({ session: current.session, model }));
  const info = (): AgentInfo[] => agents.map((a) => ({ session: a.session, busy: a.busy, asking: a.asking(), preview: a.preview() }));
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
    let q: Query | null = null;
    let box: ReturnType<typeof inbox> | null = null;
    let abort: AbortController | null = null;
    const waiting = new Map<string, (allow: boolean) => void>();
    // Streaming text: which item each text block of a message goes to.
    const textSeen = new Map<string, number>(), textDone = new Map<string, number>();
    let streamMsg = "";
    let checks = 0; // times the .cockpit/ check sent the agent back this turn
    let lastProblems = ""; // what that check found last time (this turn or an earlier one): the same list again means a round fixed nothing
    // Guardrails (src/guardrails.ts), only in a project that has .cockpit/guardrails.json. A turn that
    // edited files runs its checks; the agent is sent back only for checks that passed before the
    // turn (a failure that was already there is shown in cockpit, not pinned on this agent).
    let edited = false, gRounds = 0, gLast = "";
    let passedBefore = new Set<string>();
    let seq = 0; // for item ids made here (notes): two in the same millisecond must not collide
    const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

    const shown = () => current === self;
    let saveTimer: NodeJS.Timeout | null = null;
    const flush = () => {
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
      if (session) writeFileSync(fileOf(session), JSON.stringify({ items, context }));
      if (shown()) saveMeta();
    };
    const save = () => { if (!saveTimer) saveTimer = setTimeout(flush, 300); };
    const state = () => { if (shown()) emit({ type: "state", busy, model, context, session }); agentsChanged(); };
    const put = (item: Item) => {
      const i = items.findIndex((x) => x.id === item.id);
      if (i >= 0) items[i] = item; else items.push(item);
      if (shown()) emit({ type: "item", item });
      if (item.kind === "ask") agentsChanged();
      save();
    };
    const get = (id: string) => items.find((x) => x.id === id);
    const note = (text: string, more: Partial<Item> = {}) => put({ id: uid("note"), kind: "note", at: now(), text, ...more });

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
          const max = WINDOW[m.model] ?? await windowOf(m.model);
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
      const ws = workspace();
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
            UserPromptSubmit: [{ hooks: [async (i) => {
              checks = 0; edited = false; gRounds = 0;
              passedBefore = new Set(Object.values(lastResults(project)).filter((r) => r.ok).map((r) => r.id));
              try { turnStart(i as HookInput); } catch {}
              return {};
            }] }],
            PostToolUse: [{ matcher: "Edit|Write|MultiEdit|NotebookEdit", hooks: [async (i: any) => {
              edited = true;
              try { turnTool(i as HookInput); } catch {}
              // The agent changed the checks: trusted as it wrote them (guardrails.ts).
              const f = i.tool_input?.file_path;
              if (typeof f === "string" && resolve(root, f) === join(root, GUARDRAILS)) { const { g } = loadGuardrails(root); if (g) trust(root, g); }
              return {};
            }] }],
            Stop: [{ hooks: [async (i) => {
              // .cockpit/ must match the code: up to 3 rounds of "fix what the check found" per
              // turn, against the live index once it has caught up with the agent's edits. A round
              // that leaves exactly the same problems means the agent can't fix them (say, links into
              // code cockpit doesn't index): stop there instead of sending it back again.
              if (existsSync(join(root, ARCH_DIR)) && checks < 3) {
                const problems = checkArch(loadArch(root), await index.fresh());
                const sig = problems.map((x) => x.where + "\t" + x.problem).sort().join("\n");
                if (problems.length && sig === lastProblems) {
                  note(`${ARCH_DIR}/ still doesn't match the code (${problems.length} problem${problems.length > 1 ? "s" : ""}), and the agent's last round changed nothing, so it wasn't sent back again.`,
                    { error: true, detail: problems.slice(0, 30).map((x) => `- ${x.where}: ${x.problem}`).join("\n") });
                } else if (problems.length) {
                  lastProblems = sig;
                  checks++;
                  const reason = `${ARCH_DIR}/ doesn't match the code (${problems.length} problem${problems.length > 1 ? "s" : ""}). ` +
                    `Fix it before finishing, as described in ${ARCH_DIR}/README.md:\n` + problems.slice(0, 30).map((x) => `- ${x.where}: ${x.problem}`).join("\n");
                  note(`${ARCH_DIR}/ doesn't match the code yet: sent the agent back to fix it.`, { detail: reason });
                  return { decision: "block", reason };
                }
              }
              const sent = await guard();
              if (sent) return { decision: "block", reason: sent };
              try { turnEnd(i as HookInput); } catch {}
              return {};
            }] }],
          },
        },
      });
      const mine = q;
      pump(mine).catch((e) => { if (q === mine) note("The agent stopped: " + String(e?.message ?? e), { error: true }); })
        .finally(() => { if (q === mine) { q = null; box = null; busy = false; state(); } });
    }

    // The guardrails' checks at the end of a turn that edited files. Returns what to send the agent
    // back with, or null. At most 3 rounds, and not again when a round changed nothing.
    async function guard(): Promise<string | null> {
      const { g } = loadGuardrails(root);
      if (!g?.checks.length || !edited || gRounds >= 3) return null;
      if (!isTrusted(root, g)) {
        note("Guardrails: their checks weren't run, since they aren't trusted yet (they run commands from the project). Look at them in the guardrails tab.");
        return null;
      }
      note(`Running the guardrails' checks (${g.checks.map((c) => c.name).join(", ")})…`);
      const results = await runChecks(root, project, g, undefined, onChecks);
      const failed = results.filter((r) => !r.ok);
      const broke = failed.filter((r) => passedBefore.has(r.id)), already = failed.filter((r) => !passedBefore.has(r.id));
      const name = (id: string) => g.checks.find((c) => c.id === id)?.name ?? id;
      if (already.length) note(`Already failing before this turn, not sent back: ${already.map((r) => name(r.id)).join(", ")}.`, { detail: failureReport(g, already) });
      if (!broke.length) {
        if (!failed.length) note(`Guardrails: ${results.length} check${results.length > 1 ? "s" : ""} pass.`);
        return null;
      }
      const sig = broke.map((r) => r.id + "\t" + r.output).join("\n");
      if (sig === gLast) {
        note(`Still failing after the agent's last round, which changed nothing: ${broke.map((r) => name(r.id)).join(", ")}. Not sent back again.`, { error: true, detail: failureReport(g, broke) });
        return null;
      }
      gLast = sig; gRounds++;
      const reason = `This turn broke ${broke.length > 1 ? "checks" : "a check"} that passed before it (${GUARDRAILS}). Fix the cause in the code, not the check; ` +
        `if the check itself is wrong, say so instead of changing it.\n\n` + failureReport(g, broke);
      note(`This turn broke ${broke.map((r) => name(r.id)).join(", ")}: sent the agent back to fix it.`, { detail: reason });
      return reason;
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
            // Only the new text goes to the page: sending the whole reply again on every token made
            // the bytes grow with the square of its length.
            if (it) { it.text = String(it.text) + ev.delta.text; if (shown()) emit({ type: "delta", id: it.id, text: ev.delta.text }); }
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
          lastUsage = null;
          // Done while you look elsewhere: put away (opening it again resumes the session).
          if (!shown()) { flush(); stop(); drop(self); }
          else void measure();
        }
      }
    }

    function stop() {
      for (const r of waiting.values()) r(false);
      abort?.abort();
      q = null; box = null; busy = false;
    }

    const self = {
      get session() { return session; },
      get busy() { return busy; },
      get q() { return q; },
      asking: () => items.some((x) => x.kind === "ask" && x.status === "waiting"),
      // Its first message, for the list of running agents (a new one isn't in Claude Code's list yet).
      preview: () => String(items.find((x) => x.kind === "user")?.text ?? "").slice(0, 200),
      snapshot: () => ({ items, busy, model, models: MODELS, context, session }),
      send(text: string, images: Image[]) {
        put({ id: uid("u"), kind: "user", at: now(), text, ...(images.length ? { thumbs: images.map((i) => i.thumb) } : {}) });
        if (!q) start();
        const content = images.length
          ? [...images.map((i) => ({ type: "image" as const, source: { type: "base64" as const, media_type: i.media, data: i.data } })), ...(text.trim() ? [{ type: "text" as const, text }] : [])]
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
    if (i >= 0 && a !== current) agents.splice(i, 1);
    agentsChanged();
  }
  // Show `a`: the page gets its whole conversation. The one left keeps working if it is; idle, it
  // is put away.
  function show(a: Agent) {
    const was = current;
    current = a;
    if (!agents.includes(a)) agents.push(a);
    if (was && was !== a && !was.busy) { was.flush(); was.stop(); drop(was); }
    saveMeta();
    emit({ type: "init", ...a.snapshot(), agents: info() });
    void a.estimate();
  }

  // ---- shared: context windows, plan usage -----------------------------------------------

  // The context window of a model, asked of a short-lived idle session (no message is sent).
  const WINDOW: Record<string, number> = {};
  async function windowOf(model: string) {
    const probe = query({ prompt: never(), options: { cwd: root, model, settingSources: [] } });
    try { const c = await probe.getContextUsage({ detail: "summary" }); return (WINDOW[model] = c.maxTokens); }
    catch { return 0; } finally { probe.close(); }
  }

  // Plan usage (the numbers behind /usage), cached for a minute. Asked of a running session, or
  // of a short-lived idle one: no message is sent, so it costs nothing.
  let lastUsage: { at: number; data: unknown } | null = null;
  async function usage() {
    if (lastUsage && Date.now() - lastUsage.at < 60_000) return lastUsage.data;
    let probe: Query | null = null;
    try {
      const src = agents.find((a) => a.q)?.q ?? (probe = query({ prompt: never(), options: { cwd: root, model, settingSources: [] } }));
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

  current = agent(typeof meta.session === "string" && SESSION_ID.test(meta.session) ? meta.session : null);
  agents.push(current);
  void current.estimate();

  return {
    snapshot: () => ({ ...current.snapshot(), agents: info() }),
    subscribe(l: (e: Event) => void) { listeners.add(l); return () => { listeners.delete(l); }; },
    // A message to the open conversation, with images pasted into it (sent to Claude as image
    // blocks before the text; the chat keeps only small previews of them).
    send(text: string, images: Image[] = []) {
      if (!text.trim() && !images.length) return;
      current.send(text, images);
    },
    // An Allow/Deny card: whichever agent asked.
    answer(id: string, allow: boolean) { for (const a of agents) if (a.answer(id, allow)) return; },
    async stop() { await current.interrupt(); },
    async setModel(m: string) {
      if (!MODELS.includes(m)) return;
      model = m;
      await current.setModel(m);
      saveMeta();
      const { busy, context, session } = current.snapshot();
      emit({ type: "state", busy, model, context, session });
    },
    usage,
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
    // Delete a past conversation: Claude Code's transcript and cockpit's copy. Not the open one,
    // nor one whose agent is working.
    async remove(id: string) {
      const f = fileOf(id); // checks the id
      if (id === current.session) throw new Error("that conversation is open: start a new one first");
      const a = agents.find((x) => x.session === id);
      if (a?.busy) throw new Error("its agent is working: stop it first");
      if (a) { a.stop(); drop(a); }
      await deleteSession(id, { dir: root });
      rmSync(f, { force: true });
      delete numbers.of[id]; // its number stays used (numbers.last)
      writeFileSync(numbersFile, JSON.stringify(numbers));
    },
    // Open another conversation: its agent if one is running, else its record (the next message
    // resumes it).
    async open(id: string) {
      fileOf(id); // checks the id
      if (id === current.session) return;
      const running = agents.find((x) => x.session === id);
      if (running) return show(running);
      show(existsSync(fileOf(id)) ? agent(id) : agent(id, itemsFromTranscript(root, await getSessionMessages(id, { dir: root }))));
    },
    // A fresh conversation, with an agent of its own. The one left keeps working.
    reset() { show(agent(null)); },
    // The server is stopping: every agent's process goes with it.
    close() { for (const a of agents) { a.flush(); a.stop(); } },
  };
}
