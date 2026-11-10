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
  project: string;
  diagrams: Diagram[];
  problems: { where: string; problem: string }[];
  modules: { id: string; file: string; items: { key: string; line: number; end?: number }[] }[];
  layout: Record<string, Record<string, { x: number; y: number }>>;
  live: { id: string; prompt: string; startedAt: string; touched: string[] } | null;
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
}
export interface TermMeta { id: string; n: number; cwd: string; running: string | null; exited?: number | null; last: { cmd: string; exit?: number } | null }

// Center tabs. The map is always the first one; files and commits open next to the active tab.
export type Tab =
  | { kind: "map"; id: string | null; code: string | null }
  | { kind: "file"; path: string; line?: number; end?: number; mini?: string }
  | { kind: "commit"; sha: string };

export interface Hunk { at: number; added: number; removed: string[] }
export interface Commit { hash: string; parents: string[]; sha: string; subject: string; author: string; date: string; refs: string[] }

export interface ChatItem { id: string; kind: string; at: string; [k: string]: any }
export interface ChatSession { id: string; title: string; at: number; branch: string | null; here: boolean }
export interface Usage { plan?: string | null; windows: { name: string; pct: number; resets: string | null }[]; error?: string }
