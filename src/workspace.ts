// Workspaces: projects that work together, like an editor's multi-root workspace. Each project
// still opens in its own window, with its own server, index, chat and terminals; the workspace
// only tells each one about the others. The chat's agent can read them all, knows what each one
// is, and keeps one shared note on how they fit together.
//
// A workspace is a folder in your settings, outside every repo (and outside this one):
//   ~/.config/cockpit/workspaces/<name>/workspace.json   { "projects": ["~/src/engine", "~/src/tools"] }
//   ~/.config/cockpit/workspaces/<name>/SYSTEM.md        how the projects fit together
// Paths are absolute or start with ~. A project may be in several workspaces; the first one
// (by name) wins.

import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { ARCH_DIR } from "./arch.ts";

export interface WorkspaceProject { name: string; path: string; summary: string | null; here: boolean }
export interface Workspace { name: string; dir: string; system: string; projects: WorkspaceProject[] }

export const WORKSPACES = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "cockpit", "workspaces");

const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };
const expand = (p: string) => real(p.replace(/^~(?=$|\/)/, homedir()));

// The project's one-line summary: from its .cockpit/project.json, else its README's first paragraph.
const firstSentence = (t: string) => { const s = t.replace(/\s+/g, " ").trim(); const m = s.match(/^.{20,240}?[.!?](?=\s|$)/); return m ? m[0] : s.length > 240 ? s.slice(0, 239) + "…" : s; };
function summaryOf(root: string): string | null {
  try {
    const s = JSON.parse(readFileSync(join(root, ARCH_DIR, "project.json"), "utf8")).summary;
    if (typeof s === "string" && s.trim()) return firstSentence(s);
  } catch {}
  try {
    const para = readFileSync(join(root, "README.md"), "utf8").split(/\n\s*\n/).find((b) => b.trim() && !/^\s*(#|!\[|\[!|<|```|\|)/.test(b));
    return para ? firstSentence(para) : null;
  } catch { return null; }
}

export function workspaceOf(root: string): Workspace | null {
  if (!existsSync(WORKSPACES)) return null;
  const me = real(root);
  for (const name of readdirSync(WORKSPACES).sort()) {
    const dir = join(WORKSPACES, name);
    let paths: string[];
    try { paths = (JSON.parse(readFileSync(join(dir, "workspace.json"), "utf8")).projects ?? []).map(String).map(expand); } catch { continue; }
    if (!paths.includes(me)) continue;
    return {
      name, dir, system: join(dir, "SYSTEM.md"),
      projects: paths.map((p) => ({ name: basename(p), path: p, summary: summaryOf(p), here: p === me })),
    };
  }
  return null;
}

// What the chat's agent is told about the workspace, after its usual brief.
export function workspaceBrief(w: Workspace, cockpit: string): string {
  const others = w.projects.filter((p) => !p.here);
  const note = existsSync(w.system) ? readFileSync(w.system, "utf8").trim() : "";
  return [
    `This project is part of the workspace "${w.name}": projects that work together as one system. Each one is open in its own cockpit window.`,
    w.projects.map((p) => `- ${p.name}${p.here ? " (this project)" : ""}: ${p.path}${p.summary ? " — " + p.summary : ""}`).join("\n"),
    `You can read the other projects directly: follow calls, types and messages across them instead of guessing, and say which project a file is in. Change files only in this project; an edit in another one needs the owner's yes. Their own ${ARCH_DIR}/ folders describe them; their module lists come from: cd ${cockpit} && npm run -s modules -- <project path> [filter]`,
    `How the projects fit together is kept in ${w.system}, shared by every project of the workspace: which project owns what, who calls whom and through which interface (library, protocol, topic, file), what they share, and how they are built together. Keep it short and true as you learn things; it is yours to edit, no need to ask.` +
      (note ? ` Its content now:\n\n${note}` : ` It doesn't exist yet: write a first version the first time this matters, from what the projects' code and docs say.`),
  ].join("\n\n");
}
