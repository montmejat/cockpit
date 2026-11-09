// The terminal's ask line (Ctrl+K): "run the arm sim and record it" → a command to put on the
// prompt, never run. What the model knows about the project: its own command-line programs and
// their --help, its scripts, its config files, the agent's .cockpit/commands.json if there is
// one, and what was just run in that terminal.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ARCH_DIR } from "./arch.ts";
import { callClaudeAsync } from "./claude.ts";

export type Suggestion = { command: string; why: string };
export type Answer = { suggestions: Suggestion[]; note: string; costUsd: number; ms: number };

const run = (cmd: string, args: string[], cwd: string, timeout = 5000) => {
  try { return execFileSync(cmd, args, { cwd, encoding: "utf8", timeout, maxBuffer: 8 << 20, stdio: ["ignore", "pipe", "pipe"] }); } catch (e: any) { return String(e.stdout ?? ""); }
};

export function createAsk(root: string) {
  // --help of each program, kept until the binary is rebuilt.
  const helpCache = new Map<string, { mtime: number; text: string }>();
  let binsCache: { at: number; bins: { name: string; pkg: string }[] } | null = null;

  // The project's own programs: cargo [[bin]] targets (not examples), and package.json bins.
  function programs() {
    if (binsCache && Date.now() - binsCache.at < 60_000) return binsCache.bins;
    const bins: { name: string; pkg: string }[] = [];
    if (existsSync(join(root, "Cargo.toml"))) {
      try {
        const meta = JSON.parse(run("cargo", ["metadata", "--no-deps", "--format-version", "1", "--offline"], root, 20000));
        for (const p of meta.packages) for (const t of p.targets) if (t.kind.includes("bin")) bins.push({ name: t.name, pkg: p.name });
      } catch {}
    }
    binsCache = { at: Date.now(), bins };
    return bins;
  }
  function help(bin: string) {
    const path = join(root, "target", "debug", bin);
    if (!existsSync(path)) return null;
    const mtime = statSync(path).mtimeMs, hit = helpCache.get(bin);
    if (hit && hit.mtime === mtime) return hit.text;
    let text = run(path, ["--help"], root, 3000).trim();
    // Each subcommand's own help too (clap and most CLIs list them under "Commands:"), so the
    // model sees real arguments instead of guessing them. Compact: usage, arguments, options.
    const subs = text.match(/\n(?:Commands|Subcommands|SUBCOMMANDS):\n([\s\S]*?)(?:\n\n|$)/)?.[1] ?? "";
    for (const m of subs.matchAll(/^ {2}([a-z][\w-]*)/gm)) {
      if (m[1] === "help") continue;
      const h = run(path, [m[1], "--help"], root, 3000).trim().split("\n").filter((l) => l.trim() && !/^\s*-h, --help/.test(l)).join("\n");
      text += `\n\n$ ${bin} ${m[1]} --help\n` + h.slice(0, 2500);
    }
    if (text.length > 40000) text = text.slice(0, 40000) + "\n…";
    helpCache.set(bin, { mtime, text });
    return text;
  }

  function context(cwd: string, recent: string) {
    const parts: string[] = [];
    const proj = join(root, ARCH_DIR, "project.json");
    if (existsSync(proj)) { try { parts.push("## What the project is\n" + JSON.parse(readFileSync(proj, "utf8")).summary); } catch {} }
    const cmds = join(root, ARCH_DIR, "commands.json");
    if (existsSync(cmds)) parts.push("## Commands the project's agents wrote down (.cockpit/commands.json)\n" + readFileSync(cmds, "utf8").slice(0, 8000));

    const bins = programs();
    if (bins.length) {
      const lines = ["## The project's programs (built ones are on PATH, from target/debug)"];
      for (const b of bins) {
        const h = help(b.name);
        lines.push(h ? `### ${b.name} (built; package ${b.pkg})\n$ ${b.name} --help\n${h}` : `### ${b.name} (not built: \`cargo run -p ${b.pkg} --bin ${b.name} -- …\`, or \`cargo build -p ${b.pkg}\` first)`);
      }
      parts.push(lines.join("\n\n"));
    }
    const pkg = join(root, "package.json");
    if (existsSync(pkg)) { try { const s = JSON.parse(readFileSync(pkg, "utf8")).scripts; if (s) parts.push("## npm scripts\n" + Object.entries(s).map(([k, v]) => `npm run ${k}   # ${v}`).join("\n")); } catch {} }
    const mk = join(root, "Makefile");
    if (existsSync(mk)) parts.push("## make targets\n" + [...readFileSync(mk, "utf8").matchAll(/^([A-Za-z0-9_.-]+):(?!=)/gm)].map((m) => m[1]).join(" "));

    // Files a command might take: configs and data outside the source tree.
    const files = run("git", ["ls-files"], root).split("\n")
      .filter((f) => /\.(ya?ml|toml|json|xml|urdf|mjcf|csv|ron)$/.test(f) && !/(^|\/)(Cargo|package(-lock)?)\.(toml|json)$/.test(f) && !f.startsWith(ARCH_DIR + "/"));
    if (files.length) parts.push("## Config and data files in the repo\n" + files.slice(0, 150).join("\n") + (files.length > 150 ? `\n… ${files.length - 150} more` : ""));
    parts.push(`## The terminal\nbash, current folder: ${cwd} (project root: ${root})\n` + (recent || "(nothing run yet)"));
    return parts.join("\n\n");
  }

  const SYSTEM = [
    "You turn the owner's request into a bash command they will review and run in their terminal. You do not run anything.",
    "Use the project's own programs, scripts and files listed below. Take flags and subcommands only from the --help text shown: never invent them. If a program is not built, use its cargo run form, or build it first with &&.",
    "Paths are relative to the terminal's current folder.",
    "Give the best command first, then up to two different alternatives only if they are really different ways to do it. `why` is at most 12 words: what the command does, not a restatement of the request.",
    "`note` is usually empty. Fill it only when the owner must know something before running the command, or when nothing listed can do the request: at most 15 words. Use a <PLACEHOLDER> for a value you can't know, rather than explaining.",
  ].join("\n");
  const SCHEMA = {
    type: "object", additionalProperties: false, required: ["suggestions", "note"],
    properties: {
      suggestions: { type: "array", maxItems: 3, items: { type: "object", additionalProperties: false, required: ["command", "why"], properties: { command: { type: "string" }, why: { type: "string" } } } },
      note: { type: "string" },
    },
  };

  return async function ask(text: string, cwd: string, recent: string): Promise<Answer> {
    const t0 = Date.now();
    const r = await callClaudeAsync<{ suggestions: Suggestion[]; note: string }>({ system: SYSTEM, prompt: context(cwd, recent) + "\n\n## The request\n" + text, schema: SCHEMA, model: "haiku" });
    return { ...r.output, costUsd: r.costUsd, ms: Date.now() - t0 };
  };
}
