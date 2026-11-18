// Guardrails: what keeps agents' work right in this project without someone re-reading every line.
// Kept in the project, next to its description:
//
//   .cockpit/guardrails.json   { checks: [...], rules: [...] }
//
// A check is a command that passes or fails (types, lint, tests, a script that drives the app).
// A rule is a decision about how the code is written, with why, and where it is enforced. The
// layers are where a rule can live, from the strongest to the weakest:
//   design        the code makes the wrong thing impossible (an API, a module boundary, a type)
//   static        a check finds it without running the program (types, lint, tests)
//   verification  a check runs the program and looks (screenshots, a driver, formal models)
//   prose         only written down (CLAUDE.md, a skill, a comment): an agent may not follow it
// A correction should move down this list, not up: from prose to a check, from a check to design.
//
// Cockpit runs the checks when an agent finishes a turn that edited files (src/chat.ts), and keeps
// the last result of each in its own state folder, not in the project.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ARCH_DIR } from "./arch.ts";
import { outDir } from "./turns.ts";

export const GUARDRAILS = `${ARCH_DIR}/guardrails.json`;
export const LAYERS = ["design", "static", "verification", "prose"] as const;
export type Layer = (typeof LAYERS)[number];

export interface Check {
  id: string; name: string;
  run: string; // a shell command, run in the project folder
  timeout?: number; // seconds, default 300
}
export interface Rule {
  id: string;
  rule: string; // the decision, in one line
  why: string; // what went wrong without it, or what it buys
  layer: Layer;
  checks?: string[]; // the checks that enforce it; none for prose
  since?: string; // YYYY-MM-DD
}
export interface Guardrails { checks: Check[]; rules: Rule[] }
export interface CheckResult { id: string; ok: boolean; exit: number | null; at: string; ms: number; output: string }
// What agents are told in writing: the prose layer's files.
export interface Instruction { path: string; lines: number; kind: "agents" | "skill" | "rules" }
export interface Problem { where: string; problem: string }

export function loadGuardrails(root: string): { g: Guardrails | null; problems: Problem[] } {
  const f = join(root, GUARDRAILS);
  if (!existsSync(f)) return { g: null, problems: [] };
  let raw: any;
  try { raw = JSON.parse(readFileSync(f, "utf8")); } catch (e) { return { g: null, problems: [{ where: GUARDRAILS, problem: `not valid JSON: ${e}` }] }; }
  const problems: Problem[] = [];
  const p = (where: string, problem: string) => problems.push({ where, problem });
  const checks: Check[] = Array.isArray(raw.checks) ? raw.checks : [];
  const rules: Rule[] = Array.isArray(raw.rules) ? raw.rules : [];
  const ids = new Set<string>();
  for (const c of checks) {
    if (!c.id || !c.run) { p("checks", `a check needs "id" and "run": ${JSON.stringify(c)}`); continue; }
    if (ids.has(c.id)) p(`check ${c.id}`, `id "${c.id}" is used twice`);
    ids.add(c.id);
  }
  for (const r of rules) {
    const w = `rule ${r.id ?? "?"}`;
    if (!r.id || !r.rule) p(w, `a rule needs "id" and "rule"`);
    if (!r.why) p(w, `say why in "why": what went wrong without it, or what it buys`);
    if (!LAYERS.includes(r.layer)) p(w, `"layer" must be one of ${LAYERS.join(", ")}`);
    if (r.layer !== "prose" && !r.checks?.length) p(w, `is "${r.layer}" but names no check that enforces it; without one it is "prose"`);
    for (const c of r.checks ?? []) if (!ids.has(c)) p(w, `check "${c}" does not exist`);
  }
  return { g: { checks: checks.filter((c) => c.id && c.run), rules }, problems };
}

// The prose layer: instruction files agents read in this project.
export function instructions(root: string): Instruction[] {
  const out: Instruction[] = [];
  const add = (path: string, kind: Instruction["kind"]) => {
    try { if (statSync(join(root, path)).isFile()) out.push({ path, kind, lines: readFileSync(join(root, path), "utf8").split("\n").length }); } catch {}
  };
  for (const f of ["CLAUDE.md", "AGENTS.md", ".claude/CLAUDE.md", ".github/copilot-instructions.md", ".cursorrules"]) add(f, "agents");
  const dir = (d: string, kind: Instruction["kind"], file?: string) => {
    try {
      for (const e of readdirSync(join(root, d))) add(file ? `${d}/${e}/${file}` : `${d}/${e}`, kind);
    } catch {}
  };
  dir(".claude/skills", "skill", "SKILL.md");
  dir(".cursor/rules", "rules");
  return out;
}

// ---- running the checks ----------------------------------------------------------------------

const resultsFile = (project: string) => join(outDir(project), "guardrails.json");

export function lastResults(project: string): Record<string, CheckResult> {
  try { return JSON.parse(readFileSync(resultsFile(project), "utf8")); } catch { return {}; }
}

// The last lines are where a failure is explained (compilers and test runners end with the summary).
const tail = (s: string, lines = 60) => s.split("\n").slice(-lines).join("\n").trim();

function runOne(root: string, c: Check): Promise<CheckResult> {
  const t0 = Date.now();
  return new Promise((done) => {
    let out = "";
    const child = spawn("sh", ["-c", c.run], { cwd: root, env: { ...process.env, CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" }, detached: true });
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => { out += `\n(stopped after ${c.timeout ?? 300}s)`; try { process.kill(-child.pid!, "SIGTERM"); } catch {} }, (c.timeout ?? 300) * 1000);
    const end = (exit: number | null) => {
      clearTimeout(timer);
      done({ id: c.id, ok: exit === 0, exit, at: new Date().toISOString(), ms: Date.now() - t0, output: tail(out) });
    };
    child.on("close", end);
    child.on("error", (e) => { out += String(e); end(null); });
  });
}

// Runs every check (or the given ones) side by side and keeps the results. `onStart` lets the
// page show which are running.
const running = new Map<string, Set<string>>();
export const runningChecks = (project: string) => [...(running.get(project) ?? [])];
export async function runChecks(root: string, project: string, g: Guardrails, only?: string[], onChange?: () => void): Promise<CheckResult[]> {
  const list = g.checks.filter((c) => !only || only.includes(c.id));
  const now = running.get(project) ?? new Set<string>();
  running.set(project, now);
  for (const c of list) now.add(c.id);
  onChange?.();
  const results = await Promise.all(list.map(async (c) => {
    const r = await runOne(root, c);
    now.delete(c.id);
    const all = lastResults(project);
    all[c.id] = r;
    mkdirSync(outDir(project), { recursive: true });
    writeFileSync(resultsFile(project), JSON.stringify(all, null, 1));
    onChange?.();
    return r;
  }));
  return results;
}

// What a failed round tells the agent: each failing check, its command and the end of its output.
export function failureReport(g: Guardrails, failed: CheckResult[]): string {
  const rulesOf = (id: string) => g.rules.filter((r) => r.checks?.includes(id));
  return failed.map((r) => {
    const c = g.checks.find((x) => x.id === r.id)!;
    const why = rulesOf(r.id).map((x) => `  rule ${x.id}: ${x.rule} (why: ${x.why})`).join("\n");
    return `## ${c.name} failed: \`${c.run}\`${r.exit !== null ? ` (exit ${r.exit})` : ""}\n${why ? why + "\n" : ""}${tail(r.output, 30)}`;
  }).join("\n\n");
}
