// E6: a description of the software from four angles that hold for any project
// (after the 4+1 views / arc42), each item pointing at real code:
//   capabilities  what it does, for whom
//   entry points  how it is started and driven
//   flows         what happens at run time, step by step
//   data          what state exists, what is saved
// The fifth angle, structure, is the existing map. One model call writes it;
// code then checks every code link against the index and measures coverage.
//
//   npm run describe -- <project dir> [--model haiku|sonnet]
// Writes out/<name>/description.json. Needs the map built first (npm run map / serve).

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { callClaude } from "./claude.ts";
import type { Skeleton } from "./skeleton.ts";
import { COCKPIT, outDir } from "./turns.ts";

export interface Anchored { anchors: string[] }
export interface Capability extends Anchored { id: string; name: string; description: string; entry_points: string[]; flows: string[]; data: string[] }
export interface EntryPoint extends Anchored { id: string; name: string; kind: string; description: string }
export interface Step extends Anchored { text: string }
export interface Flow { id: string; name: string; description: string; trigger: string; steps: Step[] }
export interface Datum extends Anchored { id: string; name: string; description: string; persisted: boolean }
export interface Description {
  summary: string;
  capabilities: Capability[];
  entry_points: EntryPoint[];
  flows: Flow[];
  data: Datum[];
}
export interface Check {
  anchors: number;
  fixed: Record<string, string>; // what the model wrote -> the real symbol it meant
  unknown: string[]; // links to nothing, dropped
  badRefs: string[]; // capability -> flow/data/entry ids that don't exist, dropped
  coverage: { items: number; itemsLinked: number; modules: number; modulesLinked: number; unlinkedModules: string[] };
}

// Symbol keys the model may link to: "game/sim" (a module) or "game/sim::SimState::reset" (an item).
export const itemKey = (mod: string, i: { owner?: string; name: string }) => `${mod}::${i.owner ? i.owner + "::" : ""}${i.name}`;

const str = { type: "string" };
const arr = (items: object) => ({ type: "array", items });
const obj = (properties: Record<string, object>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const anchors = arr(str);
const schema = obj({
  summary: str,
  capabilities: arr(obj({ id: str, name: str, description: str, anchors, entry_points: arr(str), flows: arr(str), data: arr(str) })),
  entry_points: arr(obj({ id: str, name: str, kind: str, description: str, anchors })),
  flows: arr(obj({ id: str, name: str, description: str, trigger: str, steps: arr(obj({ text: str, anchors })) })),
  data: arr(obj({ id: str, name: str, description: str, persisted: { type: "boolean" }, anchors })),
});

const SYSTEM = `You describe a software project for a developer who is new to it, from four angles that apply to any software:

- capabilities: what the software does and for whom, in user terms (4-8). Link each to the entry points, flows and data it involves, by id.
- entry_points: how it is started and driven: binaries/main, user input, network endpoints, CLI commands, public library API, tests used as tools (3-8). kind: one or two words.
- flows: what happens at run time, as ordered steps from a trigger to an effect (3-6 flows, 3-8 steps each). These are the paths a developer must understand to change behavior safely.
- data: the important state and data formats: what it holds, who owns it, what is saved to disk or sent over a network (4-10). persisted = written to disk or sent outside the process.

Rules:
- Every item and every step links to code through anchors, copied EXACTLY from the symbol list (e.g. "game/sim::step_sim", "vehicle_sim/vehicle::Vehicle::step", or a whole module like "game/ui"). Prefer specific functions and types over whole modules. 1-4 anchors each. Never invent a symbol.
- ids: short kebab-case, unique across the whole description.
- Plain, concrete words; one or two sentences per description; one line per step. Name real values when they matter (rates, file formats, keys).
- summary: 2-3 sentences: what this is, how it is built, what is most important to know.
- Only what the code and docs show.`;

function sourceOf(root: string, sk: Skeleton) {
  // Non-test code of every module, with line numbers, so flows can follow real calls.
  return sk.modules.map((m) => {
    const lines = readFileSync(join(root, m.file), "utf8").split("\n");
    const cut = lines.findIndex((l) => /^#\[cfg\(test\)\]/.test(l));
    const body = (cut >= 0 ? lines.slice(0, cut) : lines).map((l, i) => `${i + 1}: ${l}`).join("\n");
    return `=== ${m.id} (${m.file}) ===\n${body}`;
  }).join("\n\n");
}

function symbolList(sk: Skeleton) {
  return sk.modules.map((m) =>
    `${m.id}\n` + m.items.filter((i) => !i.test).map((i) => `  ${itemKey(m.id, i)}  [${i.kind}]`).join("\n")).join("\n");
}

function docsOf(root: string) {
  const files = ["README.md", ...(existsSync(join(root, "docs")) ? readdirSync(join(root, "docs")).filter((f) => f.endsWith(".md")).map((f) => "docs/" + f) : [])];
  return files.filter((f) => existsSync(join(root, f))).map((f) => `=== ${f} ===\n${readFileSync(join(root, f), "utf8")}`).join("\n\n");
}

// Keep links that exist, repair obvious near-misses, drop the rest, and report all of it.
export function check(d: Description, sk: Skeleton): Check {
  const valid = new Set<string>();
  const byTail = new Map<string, string[]>();
  for (const m of sk.modules) {
    valid.add(m.id);
    for (const i of m.items.filter((i) => !i.test)) {
      const k = itemKey(m.id, i);
      valid.add(k);
      for (const tail of [i.name, (i.owner ? i.owner + "::" : "") + i.name]) byTail.set(tail, [...(byTail.get(tail) ?? []), k]);
    }
  }
  const fixed: Record<string, string> = {}, unknown: string[] = [];
  let total = 0;
  const repair = (a: string): string | null => {
    const s = a.trim().replace(/\(\)$/, "").replace(/^crate::/, "");
    if (valid.has(s)) return s;
    const viaPath = s.replace(/::/, "/"); // "game::sim::step_sim" -> "game/sim::step_sim"
    if (valid.has(viaPath)) return viaPath;
    const tail = s.split("::").slice(-2).join("::"), last = s.split("::").pop()!;
    const hits = byTail.get(tail) ?? byTail.get(last) ?? [];
    return hits.length === 1 ? hits[0] : null;
  };
  const clean = (x: Anchored) => {
    x.anchors = [...new Set(x.anchors.flatMap((a) => {
      total++;
      const r = repair(a);
      if (r === null) { unknown.push(a); return []; }
      if (r !== a) fixed[a] = r;
      return [r];
    }))];
  };
  d.capabilities.forEach(clean); d.entry_points.forEach(clean); d.data.forEach(clean);
  d.flows.forEach((f) => f.steps.forEach(clean));

  const ids = { entry_points: new Set(d.entry_points.map((x) => x.id)), flows: new Set(d.flows.map((x) => x.id)), data: new Set(d.data.map((x) => x.id)) };
  const badRefs: string[] = [];
  for (const c of d.capabilities)
    for (const k of ["entry_points", "flows", "data"] as const)
      c[k] = c[k].filter((id) => ids[k].has(id) || (badRefs.push(`${c.id} -> ${id}`), false));

  // Coverage: which code the description reaches. A linked module counts all its items as reached.
  const linked = new Set([...d.capabilities, ...d.entry_points, ...d.data, ...d.flows.flatMap((f) => f.steps)].flatMap((x) => x.anchors));
  const items = sk.modules.flatMap((m) => m.items.filter((i) => !i.test && !i.owner).map((i) => ({ m: m.id, k: itemKey(m.id, i), name: i.name })));
  const reached = items.filter((i) => linked.has(i.m) || linked.has(i.k) || [...linked].some((l) => l.startsWith(i.k + "::")));
  const modsLinked = new Set([...linked].map((l) => l.split("::")[0]));
  return {
    anchors: total, fixed, unknown, badRefs,
    coverage: {
      items: items.length, itemsLinked: reached.length,
      modules: sk.modules.length, modulesLinked: sk.modules.filter((m) => modsLinked.has(m.id)).length,
      unlinkedModules: sk.modules.filter((m) => !modsLinked.has(m.id)).map((m) => m.id),
    },
  };
}

function main() {
  const args = process.argv.slice(2);
  const opt = (n: string) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : undefined);
  const dir = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
  if (!dir) { console.error("usage: npm run describe -- <project dir> [--model haiku|sonnet]"); process.exit(1); }
  const root = resolve(dir), name = opt("name") ?? basename(root);
  const mapFile = join(outDir(name), "map.json");
  if (!existsSync(mapFile)) { console.error(`no map for ${name}: run npm run map -- ${dir} first`); process.exit(1); }
  const sk: Skeleton = JSON.parse(readFileSync(mapFile, "utf8")).skeleton;

  const prompt = `Project: ${name}\n\nSymbols you may link to (module, then its items):\n${symbolList(sk)}\n\n` +
    `Docs:\n${docsOf(root)}\n\nSource (non-test code, numbered lines):\n${sourceOf(root, sk)}`;
  console.log(`describing ${name}: ${sk.modules.length} modules, prompt ≈${Math.round(prompt.length / 4 / 1000)}k tokens…`);
  const res = callClaude<Description>({ system: SYSTEM, prompt, schema, model: opt("model"), cacheDir: join(COCKPIT, "out", ".cache") });
  const d = res.output;
  const c = check(d, sk);
  writeFileSync(join(outDir(name), "description.json"), JSON.stringify({ description: d, check: c, costUsd: res.costUsd, model: opt("model") ?? "haiku" }, null, 1));
  console.log(`${d.capabilities.length} capabilities, ${d.entry_points.length} entry points, ${d.flows.length} flows, ${d.data.length} data · $${res.costUsd.toFixed(4)}${res.cached ? " (cached)" : ""}`);
  console.log(`links: ${c.anchors} written, ${Object.keys(c.fixed).length} repaired, ${c.unknown.length} unknown${c.unknown.length ? " (" + c.unknown.slice(0, 8).join(", ") + ")" : ""}, ${c.badRefs.length} bad refs`);
  console.log(`coverage: ${c.coverage.itemsLinked}/${c.coverage.items} top-level items, ${c.coverage.modulesLinked}/${c.coverage.modules} modules` +
    (c.coverage.unlinkedModules.length ? ` (not linked: ${c.coverage.unlinkedModules.join(", ")})` : ""));
}

if (process.argv[1]?.endsWith("describe.ts")) main();
