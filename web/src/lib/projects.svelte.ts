// The projects shown in this window. Alone, just this one. In a workspace (src/workspace.ts), the
// page is the viewed project's, at /p/<name>/, and the workspace's other projects are there too,
// side by side like an editor's multi-root workspace: their files and git, from their own servers,
// which the workspace's host passes through under /p/<name>/ (src/workspace-servers.ts).
//
// A file of another project is written "@<name>/<path>" everywhere on the page (tabs, the tree,
// links), so the rest of the page keeps one string per file; `split` says which project it is in,
// its path there, and where to ask for it.

import { S, setMapSource } from "./state.svelte";
import { merge } from "./listmerge";
import type { Live } from "./types";

// A project's live state: its files and git, and its diagrams and code index for the map.
export type Lite = Live;
const EMPTY = { project: "", diagrams: [], problems: [], modules: [], layout: {}, live: null, files: [], status: [], changedFiles: [], changedItems: [], fileRevs: {},
  git: { branch: null, head: "", upstream: null, ahead: 0, behind: 0 }, lines: 0, features: [], tests: { unit: [], integration: [] }, summary: "", review: null,
  workspace: null, guardrails: { on: false, instructions: [] }, private: null, root: "" } as unknown as Live;

export class Project {
  name: string; base: string; prefix: string; here: boolean; path: string;
  // Live, from the project's server: replaced whole on each change (never deeply reactive).
  data = $state.raw<Live>({ ...EMPTY, project: "" });
  constructor(name: string, path: string, here: boolean) {
    this.name = name; this.path = path; this.here = here;
    this.base = here ? "" : `/p/${encodeURIComponent(name)}/`;
    this.prefix = here ? "" : `@${name}/`;
    if (!here) this.connect();
  }
  // The live state of this project, as S is for the window's own: S itself for this one.
  get L(): Live { return this.here ? S : this.data; }
  private connect() {
    const es = new EventSource(this.base + "api/events");
    es.onmessage = (m) => {
      const e = JSON.parse(m.data);
      const d: Live = e.type === "full" ? { ...e.state, root: this.path } : { ...this.data, ...e.patch };
      // Big lists come as their changed entries (src/project-server.ts, listPatch).
      const l = e.lists ?? {};
      if (l.modules) d.modules = merge(this.data.modules, l.modules, (x) => x.id);
      if (l["tests.unit"]) d.tests = { ...d.tests, unit: merge(this.data.tests.unit, l["tests.unit"], (u) => u.module + "\0" + u.file) };
      if (l["tests.integration"]) d.tests = { ...d.tests, integration: merge(this.data.tests.integration, l["tests.integration"], (t) => t.file) };
      this.data = d;
    };
  }
}

// The workspace's projects in its order, this one among them; alone, just this one.
export const projects: Project[] = S.workspace?.projects.some((p) => p.here)
  ? S.workspace.projects.map((p) => new Project(p.here ? S.project : p.name, p.here ? S.root ?? p.path : p.path, p.here))
  : [new Project(S.project, S.root ?? "", true)];
export const many = projects.length > 1;
export const here = projects.find((p) => p.here)!;


// Which project a page path is in, and its path there.
export function split(path: string): { p: Project; path: string } {
  if (path.startsWith("@")) for (const p of projects) if (!p.here && path.startsWith(p.prefix)) return { p, path: path.slice(p.prefix.length) };
  return { p: here, path };
}
export const projectNamed = (name?: string) => projects.find((p) => p.name === name && !p.here) ?? here;

// The map can show any of them (state.svelte.ts, M): this page's own, or another's from its server.
setMapSource((name) => {
  const p = projectNamed(name);
  return { name: p.name, base: p.base, prefix: p.prefix, L: p.L, set: (k, v) => { if (p.here) (S as any)[k] = v; else p.data = { ...p.data, [k]: v }; } };
});
