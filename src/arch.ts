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
import { isTestPath, itemKey, type Skeleton } from "./skeleton.ts";
import { snapGitDir } from "./snapshot.ts";

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
  // A rev is a turn snapshot: read it from cockpit's snapshot store when it is there.
  const gitDir = rev ? snapGitDir(repo, rev) : undefined;
  const git = (...a: string[]) => {
    try { return execFileSync("git", gitDir ? ["--git-dir", gitDir, ...a] : a, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch { return null; }
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
    for (const id of f.modules) {
      if (!mods.has(id)) { const guess = closestLink(id, mods); p(w, `module "${id}" does not exist` + (guess ? `: did you mean "${guess}"?` : ` (module ids look like crate/module; for C++, project/path/File.hpp; for Zig, package/path/File)`)); }
      served.add(id);
    }
  }
  // Test code needs no feature: cockpit lists it in the tests view. Nor do build scripts. A feature
  // that lists a folder module (ghostty/font) covers the modules under it (ghostty/font/Atlas).
  const covered = (id: string) => { for (let i = id.length; i > 0; i = id.lastIndexOf("/", i - 1)) if (served.has(id.slice(0, i))) return true; return false; };
  const isBuild = (f: string) => /(^|\/)build\.zig$/.test(f);
  if (a.features.length) for (const m of sk.modules) if (!covered(m.id) && !isTestPath(m.file) && !isBuild(m.file)) p("features", `module "${m.id}" (${m.file}) serves no feature`);

  // Diagrams: known kinds, real links, edges and zones that point at real nodes.
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
      for (const s of n.anchors ?? []) if (!symbols.has(s)) {
        const guess = closestLink(s, symbols);
        p(`${w} node ${n.id}`, `link "${s}" matches no module or item` + (guess ? `: did you mean "${guess}"?` : ` (format: crate/module::Item or crate/module::Type::method; for C++, project/path/File.cpp::Type::method; for Zig, package/path/File::Type::fn)`));
      }
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

// The real link a wrong one most likely meant: the usual slips are "::" or "_" where cockpit wants
// "crate/module" with the crate's own name, or a missing module; else the one item with that name.
export function closestLink(s: string, symbols: { has(k: string): boolean; keys(): IterableIterator<string> }): string | null {
  const tries = new Set<string>();
  for (const base of [s, s.replace(/_/g, "-"), s.replace(/-/g, "_")]) {
    tries.add(base);
    const parts = base.split("::");
    for (let i = 1; i < parts.length; i++) tries.add(parts.slice(0, i).join("/") + (i < parts.length ? "::" + parts.slice(i).join("::") : ""));
    tries.add(parts.join("/"));
  }
  for (const t of tries) if (symbols.has(t)) return t;
  // Same item name and parent anywhere: Type::method or Item; first within the module the link
  // names (generic::drawFrame -> generic::Renderer::drawFrame, not Metal's drawFrame).
  const tail = s.split("::").slice(-2).join("::"), last = s.split("::").pop()!, mod = s.split("::")[0] + "::";
  for (const key of [tail, last]) {
    const hits = [...symbols.keys()].filter((x) => x.endsWith("::" + key) || x.endsWith("/" + key));
    if (hits.length === 1) return hits[0];
    const inMod = hits.filter((x) => x.startsWith(mod));
    if (inMod.length === 1) return inMod[0];
  }
  // A method cockpit doesn't index: link the type it belongs to.
  const parts = s.split("::");
  return parts.length > 2 ? closestLink(parts.slice(0, -1).join("::"), symbols) : null;
}
