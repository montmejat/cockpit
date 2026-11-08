// Recording agent turns: shared by the Claude Code hooks (hook.ts) and cockpit's own chat (chat.ts).
//   turnStart: snapshot the code, open a turn
//   turnTool:  note which file changed, for the live view
//   turnStop:  snapshot again, close the turn, start the analysis in the background. If the repo's
//              .cockpit/ doesn't match the code, returns the problems instead and leaves the turn
//              open, so the agent can be sent back once to fix them.

import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { ARCH_DIR, checkArch, loadArch } from "./arch.ts";
import { repoRoot, skeletonOf, snapshot } from "./snapshot.ts";
import { COCKPIT, currentTurn, outDir, PROTO, saveTurn, setCurrent, type Turn } from "./turns.ts";

function lineCount(path: string): number {
  try {
    return readFileSync(path, "utf8").split("\n").length - 1;
  } catch {
    return 0;
  }
}

function startAnalysis(t: Turn) {
  const log = join(outDir(t.project), "analyze.log");
  const child = spawn(
    join(COCKPIT, "node_modules", ".bin", "tsx"),
    [join(COCKPIT, "src", "analyze.ts"), t.project, t.id],
    { cwd: COCKPIT, detached: true, stdio: ["ignore", "ignore", "ignore"] },
  );
  child.unref();
  appendFileSync(log, `${new Date().toISOString()} started analysis of ${t.id} (pid ${child.pid})\n`);
}

function closeTurn(t: Turn, after: string, transcriptTo: number) {
  t.after = after;
  t.transcriptTo = transcriptTo;
  t.endedAt = new Date().toISOString();
  t.status = "analyzing";
  saveTurn(t);
  startAnalysis(t);
}

export interface HookInput {
  cwd?: string;
  session_id?: string;
  transcript_path?: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: any;
  stop_hook_active?: boolean;
}

function ctx(input: HookInput) {
  const repo = repoRoot(input.cwd ?? process.cwd());
  const project = basename(repo);
  mkdirSync(outDir(project), { recursive: true });
  return { repo, project, session: input.session_id ?? "unknown" };
}

export function turnStart(input: HookInput) {
  const { repo, project, session } = ctx(input);
  const snap = snapshot(repo, "turn start");
  // A turn still open here was interrupted (Stop doesn't fire on Esc): close it now.
  const open = currentTurn(project, session);
  if (open?.status === "running") closeTurn(open, snap, lineCount(open.transcript));
  const now = new Date();
  const id = "t" + now.toISOString().replace(/[-:T]/g, "").slice(0, 14).replace(/(\d{8})/, "$1-");
  const t: Turn = {
    id,
    project,
    repo,
    session,
    transcript: input.transcript_path ?? "",
    transcriptFrom: Math.max(0, lineCount(input.transcript_path ?? "") - 1),
    prompt: input.prompt ?? "",
    startedAt: now.toISOString(),
    before: snap,
    touched: [],
    status: "running",
  };
  saveTurn(t);
  setCurrent(project, session, id);
}

export function turnTool(input: HookInput) {
  const { repo, project, session } = ctx(input);
  const t = currentTurn(project, session);
  const file = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
  if (t?.status === "running" && file) {
    t.touched.push({ tool: input.tool_name ?? "", file: relative(repo, file), at: new Date().toISOString() });
    saveTurn(t);
  }
}

/** The problems to send the agent back with, or null when the turn is closed. */
export function turnStop(input: HookInput): string | null {
  const { repo, project, session } = ctx(input);
  const t = currentTurn(project, session);
  if (t?.status !== "running") return null;
  const snap = snapshot(repo, "turn end");
  if (existsSync(join(repo, ARCH_DIR)) && !input.stop_hook_active) {
    // Same cache as the analysis, so this index build isn't wasted.
    const sk = skeletonOf(repo, snap, join(outDir(project), "skeletons"), PROTO);
    const problems = checkArch(loadArch(repo), sk);
    if (problems.length) {
      const list = problems.slice(0, 30).map((x) => `- ${x.where}: ${x.problem}`).join("\n");
      return `${ARCH_DIR}/ doesn't match the code (${problems.length} problem${problems.length > 1 ? "s" : ""}). ` +
        `Fix it before finishing, as described in ${ARCH_DIR}/README.md:\n${list}`;
    }
  }
  closeTurn(t, snap, lineCount(t.transcript));
  return null;
}
