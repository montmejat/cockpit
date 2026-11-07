// A turn = one request to the agent and everything it did until it stopped.
// Stored as out/<project>/turns/<id>.json.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FileChange } from "./snapshot.ts";

export const COCKPIT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const PROTO = join(COCKPIT, "vendor", "scip.proto");
export const outDir = (project: string) => join(COCKPIT, "out", project);
export const turnsDir = (project: string) => join(outDir(project), "turns");

export interface Touch {
  tool: string;
  file: string;
  at: string;
}

export interface ItemChange {
  name: string; // "Curve::eval" or "TireModel"
  kind: string;
  test?: boolean;
  change: "added" | "removed" | "changed";
  line: number; // in the new file (old file for removed)
}

export interface ModuleChange {
  id: string;
  component: string;
  componentGuessed?: boolean; // module isn't on the map yet: placed by its references
  file: string;
  status: "added" | "removed" | "changed";
  linesBefore: number;
  linesAfter: number;
  items: ItemChange[];
  role?: string;
}

export interface DepChange {
  from: string;
  to: string;
  before: number; // reference count
  after: number;
}

export interface TurnDecision {
  title: string;
  chose: string;
  over: string[];
  because: string;
  level: string;
  area: string;
  decided_by: string;
}

export interface Analysis {
  files: FileChange[];
  summary: string;
  decisions: TurnDecision[];
  components: string[]; // touched components
  modules: ModuleChange[];
  deps: DepChange[]; // module dependencies that appeared, disappeared or changed a lot
  componentDeps: DepChange[];
  patch: string;
  patchTruncated: boolean;
  costUsd: number;
}

export interface Turn {
  id: string;
  project: string;
  repo: string;
  session: string;
  transcript: string;
  transcriptFrom: number; // JSONL line count when the turn started
  transcriptTo?: number;
  prompt: string;
  startedAt: string;
  endedAt?: string;
  before: string; // snapshot commit
  after?: string;
  touched: Touch[];
  status: "running" | "analyzing" | "done" | "error";
  error?: string;
  analysis?: Analysis;
}

export function saveTurn(t: Turn) {
  const dir = turnsDir(t.project);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${t.id}.tmp`);
  writeFileSync(tmp, JSON.stringify(t, null, 1));
  renameSync(tmp, join(dir, `${t.id}.json`)); // atomic, so the page never reads half a file
}

export function loadTurn(project: string, id: string): Turn {
  return JSON.parse(readFileSync(join(turnsDir(project), `${id}.json`), "utf8"));
}

export function listTurns(project: string): Turn[] {
  const dir = turnsDir(project);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^t[\d-]+\.json$/.test(f))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Turn)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

// Which turn is running in a given Claude Code session.
const currentFile = (project: string, session: string) => join(turnsDir(project), `.current-${session}`);

export function currentTurn(project: string, session: string): Turn | null {
  const f = currentFile(project, session);
  if (!existsSync(f)) return null;
  const id = readFileSync(f, "utf8").trim();
  return existsSync(join(turnsDir(project), `${id}.json`)) ? loadTurn(project, id) : null;
}

export function setCurrent(project: string, session: string, id: string) {
  mkdirSync(turnsDir(project), { recursive: true });
  writeFileSync(currentFile(project, session), id);
}
