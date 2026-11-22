// What the server sends (src/serve.ts state()), and the shapes the page passes around.

export interface DiagramNode {
  id: string; label: string; tldr?: string; explain: string; anchors?: string[];
  in?: string; zone?: boolean; outside?: boolean; focus?: boolean; total?: boolean;
  start?: boolean; end?: boolean; carries?: boolean; detail?: string;
}
export interface DiagramEdge { from: string; to: string; label: string; explain?: string; next?: boolean }
export interface Diagram {
  id: string; question: string; kind: "loop" | "pipeline" | "dataflow" | "zones";
  tldr?: string; answer: string; rate?: string; why: string;
  nodes: DiagramNode[]; edges: DiagramEdge[];
}
export interface Feature { id: string; name: string; status: "working" | "partial" | "broken" | "planned"; description: string; modules: string[]; note?: string }
export interface GitFile { x: string; y: string; path: string }
export interface Live {
  root?: string; // the project folder (for the language servers)
  desktop?: { accent: string | null; buttons: string | null }; // GNOME's accent and window buttons
  project: string;
  diagrams: Diagram[];
  problems: { where: string; problem: string }[];
  modules: { id: string; file: string; items: { key: string; line: number; end?: number }[] }[];
  layout: Record<string, Record<string, { x: number; y: number }>>;
  live: { id: string; prompt: string; startedAt: string; chat: boolean; touched: string[] } | null;
  files: string[];
  status: GitFile[];
  changedFiles: string[];
  changedItems: string[];
  fileRevs: Record<string, number>;
  git: { branch: string | null; head: string; upstream: string | null; ahead: number; behind: number };
  lines: number;
  features: Feature[];
  tests: {
    unit: { module: string; file: string; crate: string; tests: { name: string; line: number }[] }[];
    integration: { file: string; tests: { name: string; line: number }[] }[];
  };
  summary: string;
  review: Review | null;
  workspace: Workspace | null;
  guardrails: Guardrails;
  // .cockpit/ kept out of the project's git, following its branches, synced (src/private.ts)
  private: { mode: "none" | "committed" | "off" | "on"; host: string | null; remote: string | null; synced: number | null; busy: string | null; error: string | null; note: string | null };
}
// Guardrails (src/guardrails.ts): checks and rules in .cockpit/guardrails.json, by layer.
export type Layer = "design" | "static" | "verification" | "prose";
export interface Check { id: string; name: string; run: string; timeout?: number }
export interface Rule { id: string; rule: string; why: string; layer: Layer; checks?: string[]; since?: string }
export interface CheckResult { id: string; ok: boolean; exit: number | null; at: string; ms: number; output: string }
export interface Instruction { path: string; lines: number; kind: "agents" | "skill" | "rules" }
export type Guardrails =
  | { on: false; instructions: Instruction[] }
  | { on: true; checks: Check[]; rules: Rule[]; problems: { where: string; problem: string }[]; results: Record<string, CheckResult>; running: string[]; instructions: Instruction[]; trusted: boolean };
// The workspace this project is in (src/workspace.ts): projects that work together.
export interface Workspace { name: string; system: string | null; projects: { name: string; path: string; summary: string | null; here: boolean }[] }
export interface MergeRequest { id: number; ref: string; title: string; source: string; target: string; author: string; url: string; draft: boolean; fork: boolean }
export interface BranchMr extends MergeRequest { state: "open" | "merged" | "closed"; review: "approved" | "changes" | "required" | null; checks: { pass: number; fail: number; pending: number } }
// Review mode (src/review.ts): what the checked-out branch changes against its target.
export interface Review {
  mr: MergeRequest | null; branch: string; target: string; returnTo: string | null;
  base: string | null; error: string | null; commits: number;
  files: { path: string; st: string }[];
  changedFiles: string[]; changedItems: string[];
  impacted: string[]; // modules that use changed ones
  diagrams: Record<string, { isNew: boolean; added: string[]; removed: { id: string; label: string }[] }>;
  removedDiagrams: { id: string; question: string }[];
}
export interface TermMeta { id: string; n: number; cwd: string; running: string | null; exited?: number | null; last: { cmd: string; exit?: number } | null }

// Center tabs. The map is always the first one; files and commits open next to the active tab.
export type Tab =
  | { kind: "map"; id: string | null; code: string | null }
  | { kind: "file"; path: string; line?: number; end?: number; mini?: string; at?: number }
  | { kind: "commit"; sha: string; project?: string } // project: another project of the workspace (projects.svelte.ts)
  | { kind: "diff"; path: string; staged: boolean }
  | { kind: "guardrails" };

export interface Hunk { at: number; added: number; removed: string[] }
export interface Commit { hash: string; parents: string[]; sha: string; subject: string; author: string; date: string; refs: string[] }

export interface ChatItem { id: string; kind: string; at: string; [k: string]: any }
export interface ChatSession { id: string; n: number; title: string; preview: string; at: number; branch: string | null; here: boolean; busy?: boolean; asking?: boolean }
// The agents cockpit holds (src/chat.ts, AgentInfo): the open conversation's and any still working elsewhere.
export interface ChatAgent { session: string | null; busy: boolean; asking: boolean; preview: string }
export interface Usage { plan?: string | null; windows: { name: string; pct: number; resets: string | null }[]; error?: string }
