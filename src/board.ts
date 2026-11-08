// E8: the board. What the project does right now, feature by feature, and how it got there.
// Features come from architecture.json (kept by the agents); sizes, tests and history from
// the code index and git; live activity from the running agent turn.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Architecture, readArch } from "./arch.ts";
import type { Skeleton } from "./skeleton.ts";
import { listTurns } from "./turns.ts";

export interface BoardCommit {
  sha: string; subject: string; date: string;
  turn?: { id: string; prompt: string }; // the agent turn that produced exactly this tree
  files: Record<string, number>; // path -> lines added + removed
  net: Record<string, number>; // path -> lines added - removed
}

export function boardData(root: string, project: string, sk: Skeleton) {
  const arch: Architecture | null = readArch(root);
  const git = (...a: string[]) => {
    try { return execFileSync("git", a, { cwd: root, encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "ignore"] }); } catch { return ""; }
  };

  // History, oldest first, with lines changed per file.
  const commits: BoardCommit[] = [];
  for (const block of git("log", "--reverse", "--no-merges", "--format=\x1e%h\x1f%s\x1f%aI\x1f%T", "--numstat", "HEAD").split("\x1e").slice(1)) {
    const [head, ...rest] = block.split("\n");
    const [sha, subject, date, tree] = head.split("\x1f");
    const files: Record<string, number> = {}, net: Record<string, number> = {};
    for (const l of rest) {
      const m = l.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
      if (!m || m[1] === "-") continue;
      const path = m[3].includes(" => ") ? renamed(m[3]) : m[3];
      files[path] = +m[1] + +m[2];
      net[path] = +m[1] - +m[2];
    }
    commits.push({ sha, subject, date, files, net, ...({ tree } as any) });
  }

  // Which commits are exactly what an agent turn left behind.
  const turns = listTurns(project);
  const byTree = new Map<string, { id: string; prompt: string }>();
  for (const t of turns) {
    if (!t.after || !t.analysis?.files.length) continue; // a turn that only read leaves the tree as it was
    const tree = git("rev-parse", `${t.after}^{tree}`).trim();
    if (tree) byTree.set(tree, { id: t.id, prompt: t.prompt });
  }
  for (const c of commits as any[]) { const t = byTree.get(c.tree); if (t) c.turn = t; delete c.tree; }

  // Not committed yet: tracked changes plus new files.
  const work: Record<string, number> = {};
  for (const l of git("diff", "HEAD", "--numstat").split("\n")) {
    const m = l.match(/^(\d+)\t(\d+)\t(.+)$/);
    if (m) work[m[3]] = +m[1] + +m[2];
  }
  for (const f of git("ls-files", "--others", "--exclude-standard").split("\n").filter(Boolean)) {
    try { work[f] = readFileSync(join(root, f), "utf8").split("\n").length; } catch {}
  }

  // An agent at work: the running turn and the files it touched so far.
  const running = turns.find((t) => t.status === "running");
  const live = running ? {
    id: running.id, prompt: running.prompt, status: running.status, startedAt: running.startedAt,
    touched: running.touched.map((x) => ({ file: x.file.startsWith(root) ? x.file.slice(root.length + 1) : x.file, tool: x.tool, at: x.at })),
  } : null;

  const modules = sk.modules.map((m) => ({
    id: m.id, crate: m.crate, file: m.file, lines: m.lines,
    tests: m.items.filter((i) => i.test).length,
    items: m.items.filter((i) => !i.test).length,
  }));
  const testFiles = existsSync(root) ? git("ls-files").split("\n").filter((f) => /(^|\/)tests\/.*\.rs$/.test(f)) : [];

  return {
    project, summary: arch?.summary ?? "",
    features: arch?.features ?? [],
    flows: (arch?.flows ?? []).map((f) => ({ id: f.id, name: f.name })),
    modules, commits, work, live, testFiles,
  };
}

// "src/{a => b}.rs" or "a => b" -> the new path.
function renamed(p: string) {
  const m = p.match(/^(.*)\{(.*) => (.*)\}(.*)$/);
  return m ? (m[1] + m[3] + m[4]).replace(/\/\//g, "/") : p.split(" => ")[1];
}
