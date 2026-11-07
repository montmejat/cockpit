// Claude Code hook entry point: tsx src/hook.ts <start|tool|stop>
//   start (UserPromptSubmit): snapshot the code, open a turn
//   tool  (PostToolUse on file edits): note which file changed, for the live view
//   stop  (Stop): snapshot again, close the turn, start the analysis in the background.
//         If the repo has an architecture.json that doesn't match the code, the agent is sent
//         back once with the problems (Claude Code's stop_hook_active prevents a loop).
// Rules: be fast, print nothing (UserPromptSubmit output would reach the agent),
// and always exit 0 so a cockpit problem never blocks Claude Code.

import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { ARCH_FILE, checkArch } from "./arch.ts";
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

function main() {
  const event = process.argv[2];
  const input = JSON.parse(readFileSync(0, "utf8") || "{}");
  const repo = repoRoot(input.cwd ?? process.cwd());
  const project = basename(repo);
  const session: string = input.session_id ?? "unknown";
  mkdirSync(outDir(project), { recursive: true });

  if (event === "start") {
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
  } else if (event === "tool") {
    const t = currentTurn(project, session);
    const file = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
    if (t?.status === "running" && file) {
      t.touched.push({ tool: input.tool_name, file: relative(repo, file), at: new Date().toISOString() });
      saveTurn(t);
    }
  } else if (event === "stop") {
    const t = currentTurn(project, session);
    if (t?.status !== "running") return;
    const snap = snapshot(repo, "turn end");
    const archPath = join(repo, ARCH_FILE);
    if (existsSync(archPath) && !input.stop_hook_active) {
      // Same cache as the analysis, so this index build isn't wasted.
      const sk = skeletonOf(repo, snap, join(outDir(project), "skeletons"), PROTO);
      const problems = checkArch(readFileSync(archPath, "utf8"), sk);
      if (problems.length) {
        const list = problems.slice(0, 30).map((x) => `- ${x.where}: ${x.problem}`).join("\n");
        process.stdout.write(JSON.stringify({
          decision: "block",
          reason: `${ARCH_FILE} doesn't match the code (${problems.length} problem${problems.length > 1 ? "s" : ""}). ` +
            `Fix it before finishing, as described in CLAUDE.md:\n${list}`,
        }));
        return; // the turn stays open: the agent continues
      }
    }
    closeTurn(t, snap, lineCount(t.transcript));
  }
}

try {
  main();
} catch (e) {
  try {
    appendFileSync(join(COCKPIT, "out", "hook-errors.log"), `${new Date().toISOString()} ${process.argv[2]}: ${e}\n`);
  } catch {}
}
process.exit(0);
