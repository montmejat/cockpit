// One agent's turns, as its chat runs them: recorded (recorder.ts) here and in each other project of
// the workspace the turn edits, and checked when the agent stops: .cockpit/ against the code, then
// the guardrails' checks. Either may send the agent back (up to 3 rounds each per turn), but not
// again when a round changed nothing: the agent can't fix that, so it is told in the chat instead.
//
// Hooked into the agent's Claude Code session by chat.ts: begin (UserPromptSubmit), beforeEdit /
// afterEdit (Pre/PostToolUse on edits), end (Stop: what to send the agent back with, or null).

import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { ARCH_DIR, checkArch, loadArch } from "./arch.ts";
import { GUARDRAILS, failureReport, isTrusted, lastResults, loadGuardrails, runChecks, trust } from "./guardrails.ts";
import type { createIndex } from "./codeindex.ts";
import { turnEnd, turnStart, turnTool, type HookInput } from "./recorder.ts";
import { COCKPIT } from "./turns.ts";
import type { Workspace } from "./workspace.ts";
import type { Item } from "./chat-items.ts";

export type Note = (text: string, more?: Partial<Item>) => void;

// The guardrails' checks that passed when they last ran in a project.
const passing = (name: string) => new Set(Object.values(lastResults(name)).filter((r) => r.ok).map((r) => r.id));

// The workspace's other project a file is in, if it is in one (not this one).
export function otherOf(ws: Workspace | null, file: unknown) {
  if (!ws || typeof file !== "string" || !isAbsolute(file)) return null;
  const inside = (d: string) => file === d || file.startsWith(d + "/");
  const here = ws.projects.find((p) => p.here);
  return ws.projects.find((p) => !p.here && inside(p.path) && !(here && inside(here.path))) ?? null;
}

// Another project's .cockpit/ against its code, by the check-arch command (its own index, cached on
// disk, rebuilt only if the code changed), so this server neither indexes it nor waits on it.
function archProblems(path: string, name: string): Promise<{ where: string; problem: string }[]> {
  return new Promise((done) => {
    execFile(process.execPath, ["--import", "tsx", "src/check-arch.ts", path], { cwd: COCKPIT, maxBuffer: 16 << 20, timeout: 300_000 }, (err, out) => {
      if (err && (err as any).code !== 1) { done([]); return; } // it couldn't run: nothing to send back
      done(String(out).split("\n").filter((l) => l.startsWith("- ")).map((l) => {
        const i = l.indexOf(": ");
        return { where: `${name}: ${l.slice(2, i)}`, problem: l.slice(i + 2) };
      }));
    });
  });
}

const plural = (n: number, w: string) => `${n} ${w}${n > 1 ? "s" : ""}`;
const fileOf = (i: HookInput) => i.tool_input?.file_path ?? i.tool_input?.notebook_path;

// `workspace`: the one the agent's session started in (its other projects are the session's extra
// directories). `onChecks`: this project's checks changed state, for the page.
export function turnChecks(o: {
  root: string; project: string; index: Pick<ReturnType<typeof createIndex>, "fresh">;
  workspace: () => Workspace | null; note: Note; onChecks?: () => void;
}) {
  const { root, project, note } = o;
  // Per turn.
  let rounds = 0; // times the .cockpit/ check sent the agent back
  let gRounds = 0; // times the guardrails did
  let edited = false; // this project's files
  let passedBefore = new Set<string>();
  let prompt = "";
  // The workspace's other projects this turn edited: a turn is open in each, and their .cockpit/
  // and guardrails are checked at its end too.
  const others = new Map<string, { name: string; passedBefore: Set<string> }>();
  // Across turns: what the checks found last time, so the same list again means a round fixed nothing.
  let lastProblems = "";
  const gLast = new Map<string, string>(); // per project

  // The guardrails' checks of one project (this one, or another of the workspace that the turn
  // edited). Returns what to send the agent back with, or null. The agent is sent back only for
  // checks that passed before the turn: a failure that was already there is shown, not pinned on it.
  async function guard(at: string, name: string, before: Set<string>, other: boolean): Promise<string | null> {
    const { g } = loadGuardrails(at);
    if (!g?.checks.length) return null;
    const where = other ? ` of ${name}` : "";
    if (!isTrusted(at, g)) {
      note(`Guardrails${where}: their checks weren't run, since they aren't trusted yet (they run commands from the project). Look at them in the guardrails tab${other ? " of " + name : ""}.`);
      return null;
    }
    note(`Running the guardrails' checks${where} (${g.checks.map((c) => c.name).join(", ")})…`);
    const results = await runChecks(at, name, g, undefined, other ? undefined : o.onChecks);
    const failed = results.filter((r) => !r.ok);
    const broke = failed.filter((r) => before.has(r.id)), already = failed.filter((r) => !before.has(r.id));
    const nameOf = (id: string) => g.checks.find((c) => c.id === id)?.name ?? id;
    if (already.length) note(`Already failing${where} before this turn, not sent back: ${already.map((r) => nameOf(r.id)).join(", ")}.`, { detail: failureReport(g, already) });
    if (!broke.length) {
      if (!failed.length) note(`Guardrails${where}: ${plural(results.length, "check")} pass.`);
      return null;
    }
    const sig = broke.map((r) => r.id + "\t" + r.output).join("\n");
    if (sig === gLast.get(at)) {
      note(`Still failing${where} after the agent's last round, which changed nothing: ${broke.map((r) => nameOf(r.id)).join(", ")}. Not sent back again.`, { error: true, detail: failureReport(g, broke) });
      return null;
    }
    gLast.set(at, sig);
    const reason = `This turn broke ${broke.length > 1 ? "checks" : "a check"} that passed before it (${other ? join(at, GUARDRAILS) : GUARDRAILS}). Fix the cause in the code, not the check; ` +
      `if the check itself is wrong, say so instead of changing it.\n\n` + failureReport(g, broke);
    note(`This turn broke ${broke.map((r) => nameOf(r.id)).join(", ")}${where}: sent the agent back to fix it.`, { detail: reason });
    return reason;
  }

  // .cockpit/ against the code, here (against the live index, once it has caught up with the
  // agent's edits) and in each other project the turn edited.
  async function arch(): Promise<string | null> {
    const there = [...others].filter(([path]) => existsSync(join(path, ARCH_DIR)));
    const here = existsSync(join(root, ARCH_DIR));
    if (!(here || there.length) || rounds >= 3) return null;
    const problems = [
      ...(here ? checkArch(loadArch(root), await o.index.fresh()) : []),
      ...(await Promise.all(there.map(([path, x]) => archProblems(path, x.name)))).flat(),
    ];
    if (!problems.length) return null;
    const list = problems.slice(0, 30).map((x) => `- ${x.where}: ${x.problem}`).join("\n");
    const sig = problems.map((x) => x.where + "\t" + x.problem).sort().join("\n");
    if (sig === lastProblems) {
      note(`${ARCH_DIR}/ still doesn't match the code (${plural(problems.length, "problem")}), and the agent's last round changed nothing, so it wasn't sent back again.`, { error: true, detail: list });
      return null;
    }
    lastProblems = sig;
    rounds++;
    const reason = `${ARCH_DIR}/ doesn't match the code (${plural(problems.length, "problem")}). Fix it before finishing, as described in ${ARCH_DIR}/README.md:\n` + list;
    note(`${ARCH_DIR}/ doesn't match the code yet: sent the agent back to fix it.`, { detail: reason });
    return reason;
  }

  return {
    begin(i: HookInput) {
      rounds = 0; edited = false; gRounds = 0; prompt = i.prompt ?? "";
      others.clear();
      passedBefore = passing(project);
      try { turnStart(i); } catch {}
    },
    // The first edit in another project of the workspace opens a turn there too, snapshot first, so
    // its own map lights up and its history has the turn.
    beforeEdit(i: HookInput) {
      const p = otherOf(o.workspace(), fileOf(i));
      if (p && !others.has(p.path)) {
        others.set(p.path, { name: p.name, passedBefore: passing(p.name) });
        try { turnStart({ ...i, cwd: p.path, prompt }); } catch {}
      }
    },
    afterEdit(i: HookInput) {
      const f = fileOf(i), p = otherOf(o.workspace(), f), at = p?.path ?? root;
      if (!p) edited = true;
      try { turnTool({ ...i, cwd: at }); } catch {}
      // The agent changed the checks: trusted as it wrote them (guardrails.ts).
      if (typeof f === "string" && resolve(root, f) === join(at, GUARDRAILS)) { const { g } = loadGuardrails(at); if (g) trust(at, g); }
    },
    // What to send the agent back with, or null: the turn is closed, here and in the others.
    async end(i: HookInput): Promise<string | null> {
      const a = await arch();
      if (a) return a;
      if (gRounds < 3) {
        // One project after another: their checks may build the same things.
        const sent: string[] = [];
        if (edited) { const r = await guard(root, project, passedBefore, false); if (r) sent.push(r); }
        for (const [path, x] of others) { const r = await guard(path, x.name, x.passedBefore, true); if (r) sent.push(r); }
        if (sent.length) { gRounds++; return sent.join("\n\n"); }
      }
      try { turnEnd(i); } catch {}
      for (const path of others.keys()) try { turnEnd({ ...i, cwd: path }); } catch {}
      return null;
    },
  };
}
