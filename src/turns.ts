// A turn = one request to the agent and everything it did until it stopped: the code before and
// after (snapshot commits) and the files it touched. Stored as out/<project>/turns/<id>.json.
// The page uses the running turn to light up what the agent is changing.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const COCKPIT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const PROTO = join(COCKPIT, "vendor", "scip.proto");
export const outDir = (project: string) => join(COCKPIT, "out", project);
export const turnsDir = (project: string) => join(outDir(project), "turns");

export interface Touch {
  tool: string;
  file: string;
  at: string;
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
  status: "running" | "done";
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
