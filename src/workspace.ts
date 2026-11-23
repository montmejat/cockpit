// Workspaces: projects that work together, like an editor's multi-root workspace. Opening a
// workspace (its folder, below, or from the project menu) shows all its projects in one window,
// none of them first: a host (workspace-host.ts) runs a server per project, and the window shows
// every project's files, git and diagrams side by side. Each project's chat agent knows what the others are and keeps one shared note
// on how they fit together. Opening one of its projects alone opens just that project.
//
// A workspace is a folder in your settings, outside every repo (and outside this one):
//   ~/.config/cockpit/workspaces/<name>/workspace.json   { "projects": ["~/src/engine", "~/src/tools"] }
//   ~/.config/cockpit/workspaces/<name>/SYSTEM.md        how the projects fit together
// Paths are absolute or start with ~.

import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
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

const FILE = "workspace.json";
const pathsIn = (dir: string): string[] | null => {
  try { return (JSON.parse(readFileSync(join(dir, FILE), "utf8")).projects ?? []).map(String).map(expand); } catch { return null; }
};
// A folder holding a workspace.json is a workspace.
export const isWorkspace = (dir: string) => existsSync(join(dir, FILE));

// The workspace in `dir`, seen from `here` (one of its projects), or from none of them.
export function loadWorkspace(dir: string, here?: string): Workspace | null {
  const paths = pathsIn(dir);
  if (!paths?.length) return null;
  const me = here ? real(here) : null;
  return {
    name: basename(dir), dir, system: join(dir, "SYSTEM.md"),
    projects: paths.map((p) => ({ name: basename(p), path: p, summary: summaryOf(p), here: p === me })),
  };
}

// Your workspaces, by name, with their projects' folders.
export function listWorkspaces() {
  if (!existsSync(WORKSPACES)) return [];
  return readdirSync(WORKSPACES).sort().flatMap((name) => {
    const dir = join(WORKSPACES, name), paths = pathsIn(dir);
    return paths ? [{ name, dir, projects: paths }] : [];
  });
}

// A new workspace with these projects.
export function createWorkspace(name: string, paths: string[]) {
  if (!/^[\w.-]{1,60}$/.test(name)) throw new Error("a name of letters, digits, dots, dashes or underscores");
  const dir = join(WORKSPACES, name);
  if (existsSync(dir)) throw new Error(`there is a workspace ${name} already`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, FILE), JSON.stringify({ projects: paths.map(tilde) }, null, 1) + "\n");
  return dir;
}
// One more project in a workspace.
export function addToWorkspace(dir: string, path: string) {
  const paths = pathsIn(dir);
  if (!paths) throw new Error("not a workspace");
  const p = real(path);
  if (!existsSync(p)) throw new Error(`${path} doesn't exist`);
  if (paths.includes(p)) throw new Error(`${basename(p)} is in this workspace already`);
  if (paths.some((x) => basename(x) === basename(p))) throw new Error(`there is a project named ${basename(p)} in this workspace already`);
  writeFileSync(join(dir, FILE), JSON.stringify({ projects: [...paths, p].map(tilde) }, null, 1) + "\n");
}
const tilde = (p: string) => (p.startsWith(homedir() + "/") ? "~" + p.slice(homedir().length) : p);

// The first workspace (by name) a project is in, opened or not: the code index reads its other
// projects' headers (indexer.ts).
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
    `This project is part of the workspace "${w.name}": projects that work together as one system, all open in the owner's cockpit window.`,
    w.projects.map((p) => `- ${p.name}${p.here ? " (this project)" : ""}: ${p.path}${p.summary ? " — " + p.summary : ""}`).join("\n"),
    `You can read and change every project of the workspace: follow calls, types and messages across them instead of guessing, make a change that spans projects in each of them, and say which project a file is in. Their own ${ARCH_DIR}/ folders describe them; their module lists come from: cd ${cockpit} && npm run -s modules -- <project path> [filter]`,
    `How the projects fit together is kept in ${w.system}, shared by every project of the workspace: which project owns what, who calls whom and through which interface (library, protocol, topic, file), what they share, and how they are built together. Keep it short and true as you learn things; it is yours to edit, no need to ask.` +
      (note ? ` Its content now:\n\n${note}` : ` It doesn't exist yet: write a first version the first time this matters, from what the projects' code and docs say.`),
  ].join("\n\n");
}
