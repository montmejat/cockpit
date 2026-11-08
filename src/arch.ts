// The project's own description, kept in its repo under .cockpit/ by the agents that work on it.
// Cockpit never writes it (except layout.json, where you dragged the boxes); it checks it
// against the code index.
//
//   .cockpit/README.md            the brief for agents: what to keep here and when
//   .cockpit/project.json         { summary, features }
//   .cockpit/diagrams/<id>.json   one diagram per file
//   .cockpit/layout.json          where people placed diagram boxes (written by cockpit)

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { itemKey } from "./describe.ts";
import type { Overlay } from "./overlay.ts";
import type { Skeleton } from "./skeleton.ts";

export const ARCH_DIR = ".cockpit";
const PROJECT = `${ARCH_DIR}/project.json`, DIAGRAMS = `${ARCH_DIR}/diagrams`;

// What the software does for its user, as it stands. Planned ones have no modules yet.
export const FEATURE_STATUS = ["working", "partial", "broken", "planned"] as const;
export interface Feature {
  id: string; name: string; status: (typeof FEATURE_STATUS)[number]; description: string;
  modules: string[]; note?: string; // note: what's missing or wrong, one line
}
// Diagrams the agents draw to explain the code. A small fixed vocabulary so cockpit can check
// them against the code, draw them the same way, and light them up while agents work.
export const DIAGRAM_KINDS = ["loop", "pipeline", "dataflow", "zones"] as const;
export interface DiagramNode {
  id: string; label: string;
  tldr: string; // what it is, in a few words: the first thing people read
  explain: string; // one or two sentences, shown on hover: what this is, in plain words
  anchors?: string[]; // code it stands for; empty only for things outside the code (a gamepad, a file on disk)
  in?: string; // zones: id of the zone node that contains it
  zone?: boolean; // zones: this node is a zone that contains others
  outside?: boolean; // not code: the world around it
  focus?: boolean; // the one thing the diagram is about
  total?: boolean; // a shared total that several parts add into (an accumulator, a buffer, a shared state)
  start?: boolean; // where it begins (program start, a request arriving)
  end?: boolean; // where it stops
  carries?: boolean; // state that survives from one round to the next
  detail?: string; // id of another diagram that zooms into this box
}
// next: the value is used in the next round (next step, next frame, next request), not this one.
export interface DiagramEdge { from: string; to: string; label: string; explain?: string; next?: boolean }
export interface Diagram {
  id: string; question: string; kind: (typeof DIAGRAM_KINDS)[number];
  tldr: string; // the answer in about ten words: the first thing people read
  answer: string; // the claim the picture makes, in one or two sentences
  rate?: string; // loop: what one round is and how often it repeats ("every screen frame, ~60 Hz")
  why: string; // why this is worth a diagram rather than a sentence
  nodes: DiagramNode[]; edges: DiagramEdge[];
}
export interface Architecture { summary: string; features: Feature[]; diagrams: Diagram[] }
export interface ArchProblem { where: string; problem: string }

// Read .cockpit/ from the working tree, or from a commit (rev) for turn snapshots.
export function loadArch(repo: string, rev?: string): { arch: Architecture | null; problems: ArchProblem[] } {
  const git = (...a: string[]) => {
    try { return execFileSync("git", a, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch { return null; }
  };
  const read = (p: string) => (rev ? git("show", `${rev}:${p}`) : existsSync(join(repo, p)) ? readFileSync(join(repo, p), "utf8") : null);
  const list = (d: string) => rev
    ? (git("ls-tree", "--name-only", `${rev}:${d}`) ?? "").split("\n").filter(Boolean)
    : existsSync(join(repo, d)) ? readdirSync(join(repo, d)) : [];
  const text = read(PROJECT);
  if (text === null) return { arch: null, problems: [] };
  const problems: ArchProblem[] = [];
  const parse = (where: string, t: string) => { try { return JSON.parse(t); } catch (e) { problems.push({ where, problem: `not valid JSON: ${e}` }); return null; } };
  const project = parse(PROJECT, text) ?? {};
  const diagrams: Diagram[] = [];
  for (const f of list(DIAGRAMS).filter((f) => f.endsWith(".json")).sort()) {
    const d = parse(`${DIAGRAMS}/${f}`, read(`${DIAGRAMS}/${f}`) ?? "");
    if (d) diagrams.push({ ...d, id: f.slice(0, -5) }); // the file name is the id
  }
  // The main loop comes first.
  diagrams.sort((a, b) => Number(b.kind === "loop") - Number(a.kind === "loop"));
  return { arch: { summary: project.summary ?? "", features: project.features ?? [], diagrams }, problems };
}
export const readArch = (repo: string, rev?: string) => loadArch(repo, rev).arch;

// Everything that's wrong, phrased so an agent can fix it without guessing.
export function checkArch(loaded: { arch: Architecture | null; problems: ArchProblem[] }, sk: Skeleton): ArchProblem[] {
  const a = loaded.arch;
  if (!a) return loaded.problems;
  const out = [...loaded.problems];
  const p = (where: string, problem: string) => out.push({ where, problem });
  if (!a.summary) p(PROJECT, `missing "summary"`);

  const mods = new Map(sk.modules.map((m) => [m.id, m]));
  const symbols = new Set<string>();
  for (const m of sk.modules) { symbols.add(m.id); for (const i of m.items) if (!i.test) symbols.add(itemKey(m.id, i)); }

  // Features: real modules; built ones have code; every module serves one.
  const served = new Set<string>(), ids = new Set<string>();
  for (const f of a.features) {
    const w = `feature ${f.id}`;
    if (ids.has(f.id)) p(w, `id "${f.id}" is used twice`);
    ids.add(f.id);
    if (!FEATURE_STATUS.includes(f.status)) p(w, `status "${f.status}" is not one of ${FEATURE_STATUS.join(", ")}`);
    if (!Array.isArray(f.modules)) { p(w, `missing "modules" (a list of module ids, empty when planned)`); continue; }
    if (f.status !== "planned" && !f.modules.length) p(w, `is ${f.status} but lists no modules`);
    if ((f.status === "partial" || f.status === "broken") && !f.note) p(w, `is ${f.status}: say what's missing or wrong in "note"`);
    for (const id of f.modules) { if (!mods.has(id)) p(w, `module "${id}" does not exist`); served.add(id); }
  }
  if (a.features.length) for (const m of sk.modules) if (!served.has(m.id)) p("features", `module "${m.id}" (${m.file}) serves no feature`);

  // Diagrams: known kinds, real links, edges and zones that point at real nodes.
  if (a.diagrams.length > 5) p("diagrams", `${a.diagrams.length} diagrams: keep at most 5, the ones that explain the most`);
  if (a.diagrams.length && !a.diagrams.some((d) => d.kind === "loop")) p("diagrams", `no main loop: the first diagram is the program's main loop, kind "loop"`);
  for (const d of a.diagrams) {
    const w = `diagram ${d.id}`;
    if (!DIAGRAM_KINDS.includes(d.kind)) p(w, `kind "${d.kind}" is not one of ${DIAGRAM_KINDS.join(", ")}`);
    for (const k of ["question", "tldr", "answer", "why"] as const) if (!d[k]) p(w, `missing "${k}"`);
    const words = (t: string) => t.trim().split(/\s+/).length;
    if (d.tldr && words(d.tldr) > 14) p(w, `"tldr" has ${words(d.tldr)} words: keep it to about 10, the details go in "answer"`);
    if (d.kind === "loop" && !d.rate) p(w, `a loop needs "rate": what one round is and how often it repeats`);
    if (!Array.isArray(d.nodes) || !Array.isArray(d.edges)) { p(w, `needs "nodes" and "edges" lists`); continue; }
    const nodeIds = new Set<string>();
    for (const n of d.nodes) {
      if (nodeIds.has(n.id)) p(w, `node id "${n.id}" is used twice`);
      nodeIds.add(n.id);
      if (!n.explain) p(`${w} node ${n.id}`, `missing "explain"`);
      if (!n.tldr && !n.zone) p(`${w} node ${n.id}`, `missing "tldr" (a few words, shown first)`);
      else if (n.tldr && words(n.tldr) > 12) p(`${w} node ${n.id}`, `"tldr" has ${words(n.tldr)} words: keep it to about 8, the details go in "explain"`);
      if (n.detail && (n.detail === d.id || !a.diagrams.some((x) => x.id === n.detail))) p(`${w} node ${n.id}`, `"detail": "${n.detail}" is not another diagram's id (the id is the file name in .cockpit/diagrams/)`);
      if (!n.zone && !n.outside && !n.start && !n.end && !n.anchors?.length) p(`${w} node ${n.id}`, `has no code links: add anchors, or mark it "outside" if it is not code`);
      for (const s of n.anchors ?? []) if (!symbols.has(s)) p(`${w} node ${n.id}`, `link "${s}" matches no module or item (format: crate/module::Item or crate/module::Type::method)`);
    }
    for (const n of d.nodes) if (n.in && !d.nodes.some((z) => z.id === n.in && z.zone)) p(`${w} node ${n.id}`, `"in": "${n.in}" is not a zone of this diagram`);
    // Only what goes around is "next"; several of them mean the carried state wants its own box.
    const nexts = d.edges.filter((e) => e.next);
    if (nexts.length > 2) p(w, `${nexts.length} "next" edges: only the edge that closes a round is "next" (writes and reads within the same round are plain edges). Draw the state kept between rounds as one "carries" node: plain edges from it to what reads it, one "next" edge into it from where the new state is written`);
    for (const e of d.edges) {
      for (const end of [e.from, e.to]) if (!nodeIds.has(end)) p(w, `edge ${e.from} -> ${e.to}: no node "${end}"`);
      if (!e.label) p(w, `edge ${e.from} -> ${e.to} has no label (say what moves along it)`);
    }
  }
  return out;
}

// Map components without a model call: one per crate.
export function crateOverlay(sk: Skeleton): Overlay & { groupOf: Record<string, string> } {
  const groupOf: Record<string, string> = {};
  for (const m of sk.modules) groupOf[m.id] = m.crate;
  const components = [...new Set(sk.modules.map((m) => m.crate))].map((c) => ({ name: c, description: "", modules: sk.modules.filter((m) => m.crate === c).map((m) => m.id) }));
  return { components, roles: {}, groupOf };
}

// What the agent changed in .cockpit/ during a turn, item by item.
export interface ArchChange { kind: string; id: string; name: string; change: "added" | "removed" | "changed" }
export function archDiff(before: Architecture | null, after: Architecture | null): ArchChange[] {
  if (!after) return [];
  const all = (a: Architecture | null) => new Map(
    a ? [...a.features.map((f) => ["features", f] as const), ...a.diagrams.map((d) => ["diagrams", { ...d, name: d.question }] as const)]
      .map(([k, x]) => [`${k}\u0000${x.id}`, { k, x }]) : [],
  );
  const b = all(before), a = all(after), out: ArchChange[] = [];
  for (const [key, { k, x }] of a) {
    const old = b.get(key);
    if (!old) out.push({ kind: k, id: x.id, name: x.name, change: "added" });
    else if (JSON.stringify(old.x) !== JSON.stringify(x)) out.push({ kind: k, id: x.id, name: x.name, change: "changed" });
  }
  for (const [key, { k, x }] of b) if (!a.has(key)) out.push({ kind: k, id: x.id, name: x.name, change: "removed" });
  if (before && before.summary !== after.summary) out.push({ kind: "summary", id: "summary", name: "summary", change: "changed" });
  return out;
}
