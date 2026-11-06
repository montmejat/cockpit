// E1: decision recap. Two model steps:
//   1. extract: transcript events -> flat list of raw decisions (each cites events)
//   2. merge:   raw decisions -> tree of themes and groups (each lists its decisions)
// Code then checks the merge: every decision must appear exactly once.

import { callClaude } from "./claude.ts";
import { type Event, eventsForPrompt } from "./transcript.ts";

// Depth levels, from the user's notes: purpose, system, modules, code.
// They match the C4 model's context / container / component / code.
export const LEVELS = ["purpose", "system", "module", "code"] as const;
export type Level = (typeof LEVELS)[number];

export interface Decision {
  id: string;
  title: string;
  // Y-statement: "In the context of <context>, facing <concern>, we chose
  // <option> over <alternatives>, to achieve <goal>, accepting <downside>."
  context: string;
  chose: string;
  over: string[];
  because: string;
  accepting: string;
  level: Level;
  area: string; // e.g. "game/gamepad", "vehicle_sim", "build"
  decided_by: "user" | "agent";
  evidence: string[]; // event ids
}

export interface Group {
  title: string;
  summary: string;
  decisions: string[];
}

export interface Theme {
  title: string;
  summary: string;
  level: Level;
  groups: Group[];
}

export interface Recap {
  overview: string;
  themes: Theme[];
}

const str = { type: "string" };
const level = { type: "string", enum: [...LEVELS] };
const obj = (properties: Record<string, object>) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

const extractSchema = obj({
  decisions: {
    type: "array",
    items: obj({
      title: str,
      context: str,
      chose: str,
      over: { type: "array", items: str },
      because: str,
      accepting: str,
      level,
      area: str,
      decided_by: { type: "string", enum: ["user", "agent"] },
      evidence: { type: "array", items: str },
    }),
  },
});

const EXTRACT_SYSTEM = `You extract design and technical decisions from a coding session between a user and an AI coding agent.

A decision is a choice between real options that shapes the software: architecture, libraries and versions, data formats, algorithms, conventions, build setup, scope (what was left out). Not decisions: routine steps (running a build, reading a file), fixing typos.

Rules:
- Only report decisions the events show. Never invent alternatives or reasons: if none are visible, use [] for "over" and "not stated" for the text fields.
- "evidence" lists the event ids (like "e42") where the decision is made or justified. At least one.
- decided_by is "user" only if a user event makes or approves the specific choice. Otherwise "agent".
- level: purpose (what the product is for, scope), system (crates/services and their boundaries, major dependencies), module (one module's design, interfaces, data flow), code (local implementation details, constants, version pins, workarounds).
- area: a short path-like name for the part of the project, e.g. "vehicle_sim/tire", "game/ui", "build".
- One line per field. Be terse.`;

export function extractDecisions(events: Event[], cacheDir: string) {
  const res = callClaude<{ decisions: Omit<Decision, "id">[] }>({
    system: EXTRACT_SYSTEM,
    prompt: `Session events:\n\n${eventsForPrompt(events)}`,
    schema: extractSchema,
    cacheDir,
  });
  const known = new Set(events.map((e) => e.id));
  const decisions: Decision[] = res.output.decisions.map((d, i) => ({
    ...d,
    id: `d${i + 1}`,
    evidence: d.evidence.filter((id) => known.has(id)), // drop made-up ids
  }));
  return { decisions, costUsd: res.costUsd, cached: res.cached };
}

const mergeSchema = obj({
  overview: str,
  themes: {
    type: "array",
    items: obj({
      title: str,
      summary: str,
      level,
      groups: {
        type: "array",
        items: obj({ title: str, summary: str, decisions: { type: "array", items: str } }),
      },
    }),
  },
});

const MERGE_SYSTEM = `You turn a flat list of decisions from a coding session into a short recap a busy engineer can read top-down.

Output:
- overview: 2-3 sentences on what the session decided overall.
- themes: 3-7 themes. Each has a title, a 1-2 sentence summary, the highest level among its decisions, and groups.
- groups: decisions that belong together. Each group has a title, a 1-2 sentence summary that merges its decisions, and the ids of its decisions.

Rules:
- Every decision id appears in exactly one group. Do not drop or repeat any.
- A summary may only state what its decisions say. Do not add facts.
- Group by what the decisions are about, not by when they happened.
- Plain words. No filler.`;

export function mergeDecisions(decisions: Decision[], cacheDir: string) {
  const compact = decisions.map((d) => ({
    id: d.id,
    title: d.title,
    chose: d.chose,
    over: d.over,
    because: d.because,
    level: d.level,
    area: d.area,
    by: d.decided_by,
  }));
  const res = callClaude<Recap>({
    system: MERGE_SYSTEM,
    prompt: `Decisions:\n${JSON.stringify(compact, null, 1)}`,
    schema: mergeSchema,
    cacheDir,
  });
  return { recap: res.output, costUsd: res.costUsd, cached: res.cached };
}

// Checks the model's merge: decisions it dropped, repeated, or made up.
export function checkMerge(recap: Recap, decisions: Decision[]) {
  const ids = new Set(decisions.map((d) => d.id));
  const seen = new Map<string, number>();
  for (const t of recap.themes)
    for (const g of t.groups) for (const id of g.decisions) seen.set(id, (seen.get(id) ?? 0) + 1);
  return {
    missing: [...ids].filter((id) => !seen.has(id)),
    repeated: [...seen].filter(([, n]) => n > 1).map(([id]) => id),
    unknown: [...seen.keys()].filter((id) => !ids.has(id)),
  };
}
