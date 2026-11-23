// The projects shown in this window. Alone, just this one. In a workspace (src/workspace.ts), the
// page is the viewed project's, at /p/<name>/, and the workspace's other projects are there too,
// side by side like an editor's multi-root workspace: their files and git, from their own servers,
// which the workspace's host passes through under /p/<name>/ (src/workspace-servers.ts).
//
// A file of another project is written "@<name>/<path>" everywhere on the page (tabs, the tree,
// links), so the rest of the page keeps one string per file; `split` says which project it is in,
// its path there, and where to ask for it.

import { dirtyFiles, S } from "./state.svelte";
import type { Live } from "./types";

// What the page needs of a project's live state to show its files and git.
export type Lite = Pick<Live, "project" | "files" | "status" | "fileRevs" | "git" | "review" | "private" | "root">;

export class Project {
  name: string; base: string; prefix: string; here: boolean; path: string;
  // Live, from the project's server: replaced whole on each change (never deeply reactive).
  data = $state.raw<Lite>({ project: "", files: [], status: [], fileRevs: {}, git: { branch: null, head: "", upstream: null, ahead: 0, behind: 0 }, review: null, private: null as any, root: "" });
  constructor(name: string, path: string, here: boolean) {
    this.name = name; this.path = path; this.here = here;
    this.base = here ? "" : `/p/${encodeURIComponent(name)}/`;
    this.prefix = here ? "" : `@${name}/`;
    if (!here) this.connect();
  }
  // The live state of this project, as S is for the window's own: S itself for this one.
  get L(): Lite { return this.here ? S : this.data; }
  private connect() {
    const es = new EventSource(this.base + "api/events");
    es.onmessage = (m) => {
      const e = JSON.parse(m.data);
      // Its modules and tests (the lists sent as patches) aren't shown here: only its files and git.
      if (e.type === "full") this.data = { ...e.state, root: this.path };
      else this.data = { ...this.data, ...e.patch };
    };
  }
}

// The workspace's projects in its order, this one among them; alone, just this one.
export const projects: Project[] = S.workspace?.projects.some((p) => p.here)
  ? S.workspace.projects.map((p) => new Project(p.here ? S.project : p.name, p.here ? S.root ?? p.path : p.path, p.here))
  : [new Project(S.project, S.root ?? "", true)];
export const many = projects.length > 1;
export const here = projects.find((p) => p.here)!;

// View another project of the workspace: its page, from its server (the host serves it at /p/<name>/).
export function viewProject(name: string) {
  if (dirtyFiles.size && !confirm(`${dirtyFiles.size} file${dirtyFiles.size > 1 ? "s have" : " has"} unsaved changes. Switch to ${name} anyway?`)) return;
  location.href = `/p/${encodeURIComponent(name)}/`;
}

// Which project a page path is in, and its path there.
export function split(path: string): { p: Project; path: string } {
  if (path.startsWith("@")) for (const p of projects) if (!p.here && path.startsWith(p.prefix)) return { p, path: path.slice(p.prefix.length) };
  return { p: here, path };
}
export const projectNamed = (name?: string) => projects.find((p) => p.name === name && !p.here) ?? here;
