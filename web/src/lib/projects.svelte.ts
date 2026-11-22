// The projects shown in this window. Alone, just this one. In a workspace (src/workspace.ts), its
// other projects too, side by side like an editor's multi-root workspace: their files and git, from
// their own servers, which this window's server passes through under p/<name>/
// (src/workspace-servers.ts).
//
// A file of another project is written "@<name>/<path>" everywhere on the page (tabs, the tree,
// links), so the rest of the page keeps one string per file; `split` says which project it is in,
// its path there, and where to ask for it.

import { S } from "./state.svelte";
import type { Live } from "./types";

// What the page needs of a project's live state to show its files and git.
export type Lite = Pick<Live, "project" | "files" | "status" | "fileRevs" | "git" | "review" | "private" | "root">;

export class Project {
  name: string; base: string; prefix: string; here: boolean; path: string;
  // Live, from the project's server: replaced whole on each change (never deeply reactive).
  data = $state.raw<Lite>({ project: "", files: [], status: [], fileRevs: {}, git: { branch: null, head: "", upstream: null, ahead: 0, behind: 0 }, review: null, private: null as any, root: "" });
  constructor(name: string, path: string, here: boolean) {
    this.name = name; this.path = path; this.here = here;
    this.base = here ? "" : `p/${encodeURIComponent(name)}/`;
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

// This project first, then the workspace's others in its order.
export const projects: Project[] = [
  new Project(S.project, S.root ?? "", true),
  ...(S.workspace?.projects ?? []).filter((p) => !p.here).map((p) => new Project(p.name, p.path, false)),
];
export const many = projects.length > 1;
export const here = projects[0];

// Which project a page path is in, and its path there.
export function split(path: string): { p: Project; path: string } {
  if (path.startsWith("@")) for (const p of projects) if (!p.here && path.startsWith(p.prefix)) return { p, path: path.slice(p.prefix.length) };
  return { p: here, path };
}
export const projectNamed = (name?: string) => projects.find((p) => p.name === name && !p.here) ?? here;
