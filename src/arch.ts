// E7: architecture.json, kept in the project repo and maintained by the agents that work on it.
// Same angles as E6 (entry points, flows, data), plus the grouping of modules
// into groups inside each crate. Cockpit never writes it; it checks it against the code index.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Description, itemKey } from "./describe.ts";
import type { Overlay } from "./overlay.ts";
import type { Skeleton } from "./skeleton.ts";

export const ARCH_FILE = "architecture.json";

export interface Group { id: string; crate: string; name: string; description: string; modules: string[] }
// What the software does for its user, as it stands. Planned ones have no modules yet.
export const FEATURE_STATUS = ["working", "partial", "broken", "planned"] as const;
export interface Feature {
  id: string; name: string; status: (typeof FEATURE_STATUS)[number]; description: string;
  modules: string[]; flows?: string[]; note?: string; // note: what's missing or wrong, one line
}
// Diagrams the agents draw to explain the code (E9). A small fixed vocabulary so cockpit can
// check them against the code, draw them the same way, and light them up while agents work.
export const DIAGRAM_KINDS = ["loop", "pipeline", "dataflow", "zones"] as const;
export interface DiagramNode {
  id: string; label: string;
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
  answer: string; // the claim the picture makes, in one or two sentences
  rate?: string; // loop: what one round is and how often it repeats ("every screen frame, ~60 Hz")
  why: string; // why this is worth a diagram rather than a sentence
  nodes: DiagramNode[]; edges: DiagramEdge[];
}

export interface Architecture extends Description {
  diagrams?: Diagram[];
  groups: Group[];
  features?: Feature[];
  layout?: { rows: string[][]; note: string }; // map arrangement: rows of group ids, top to bottom
  roles?: Record<string, string>; // module id -> one line
}

export interface ArchProblem { where: string; problem: string }

export function readArch(repo: string, rev?: string): Architecture | null {
  try {
    const text = rev
      ? execFileSync("git", ["show", `${rev}:${ARCH_FILE}`], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      : existsSync(join(repo, ARCH_FILE)) ? readFileSync(join(repo, ARCH_FILE), "utf8") : null;
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

const KINDS = ["entry_points", "flows", "data"] as const;

// Everything that's wrong, phrased so an agent can fix it without guessing.
export function checkArch(text: string | null, sk: Skeleton): ArchProblem[] {
  if (text === null) return [];
  let a: Architecture;
  try { a = JSON.parse(text); } catch (e) { return [{ where: ARCH_FILE, problem: `not valid JSON: ${e}` }]; }
  const out: ArchProblem[] = [];
  const p = (where: string, problem: string) => out.push({ where, problem });
  for (const k of ["summary", "groups", ...KINDS] as const) if (!(k in a)) p(ARCH_FILE, `missing "${k}"`);
  if ("capabilities" in a) p(ARCH_FILE, `"capabilities" is no longer part of the format: move their links into flows (each flow lists its entry_points and data), then remove it`);
  if (out.length) return out;

  const mods = new Map(sk.modules.map((m) => [m.id, m]));
  const symbols = new Set<string>();
  for (const m of sk.modules) { symbols.add(m.id); for (const i of m.items) if (!i.test) symbols.add(itemKey(m.id, i)); }

  // Groups: inside one crate, every module in exactly one group.
  const seen = new Map<string, string>();
  for (const g of a.groups) {
    for (const id of g.modules) {
      const m = mods.get(id);
      if (!m) { p(`group ${g.id}`, `module "${id}" does not exist`); continue; }
      if (m.crate !== g.crate) p(`group ${g.id}`, `module "${id}" is in crate ${m.crate}, but the group is in crate ${g.crate}: groups never cross crates`);
      if (seen.has(id)) p(`group ${g.id}`, `module "${id}" is also in group ${seen.get(id)}`);
      seen.set(id, g.id);
    }
  }
  for (const m of sk.modules) if (!seen.has(m.id)) p("groups", `module "${m.id}" (${m.file}) is in no group`);

  // Layout (optional): every group placed exactly once.
  if (a.layout) {
    const groupIds = new Set(a.groups.map((g) => g.id)), placed = new Set<string>();
    for (const id of (a.layout.rows ?? []).flat()) {
      if (!groupIds.has(id)) p("layout", `"${id}" is not a group id`);
      else if (placed.has(id)) p("layout", `group "${id}" is placed twice`);
      placed.add(id);
    }
    for (const id of groupIds) if (!placed.has(id)) p("layout", `group "${id}" is not in layout.rows`);
  }

  // Features (optional): real modules and flows; built ones have code, every module serves one.
  if (a.features) {
    const flowIds = new Set(a.flows.map((f) => f.id)), served = new Set<string>();
    for (const f of a.features) {
      const w = `feature ${f.id}`;
      if (!FEATURE_STATUS.includes(f.status)) p(w, `status "${f.status}" is not one of ${FEATURE_STATUS.join(", ")}`);
      if (!Array.isArray(f.modules)) { p(w, `missing "modules" (a list of module ids, empty when planned)`); continue; }
      if (f.status !== "planned" && !f.modules.length) p(w, `is ${f.status} but lists no modules`);
      for (const id of f.modules) { if (!mods.has(id)) p(w, `module "${id}" does not exist`); served.add(id); }
      for (const id of f.flows ?? []) if (!flowIds.has(id)) p(w, `flow "${id}" does not exist`);
    }
    for (const m of sk.modules) if (!served.has(m.id)) p("features", `module "${m.id}" (${m.file}) serves no feature`);
  }

  // Diagrams (optional): known kinds, real links, edges and zones that point at real nodes.
  if (a.diagrams) {
    if (a.diagrams.length > 5) p("diagrams", `${a.diagrams.length} diagrams: keep at most 5, the ones that explain the most`);
    for (const d of a.diagrams) {
      const w = `diagram ${d.id}`;
      if (!DIAGRAM_KINDS.includes(d.kind)) p(w, `kind "${d.kind}" is not one of ${DIAGRAM_KINDS.join(", ")}`);
      for (const k of ["question", "answer", "why"] as const) if (!d[k]) p(w, `missing "${k}"`);
      if (d.kind === "loop" && !d.rate) p(w, `a loop needs "rate": what one round is and how often it repeats`);
      if (!Array.isArray(d.nodes) || !Array.isArray(d.edges)) { p(w, `needs "nodes" and "edges" lists`); continue; }
      const nodeIds = new Set<string>();
      for (const n of d.nodes) {
        if (nodeIds.has(n.id)) p(w, `node id "${n.id}" is used twice`);
        nodeIds.add(n.id);
        if (!n.explain) p(`${w} node ${n.id}`, `missing "explain" (shown on hover)`);
        if (n.detail && (n.detail === d.id || !a.diagrams.some((x) => x.id === n.detail))) p(`${w} node ${n.id}`, `"detail": "${n.detail}" is not another diagram's id`);
        if (!n.zone && !n.outside && !n.start && !n.end && !n.anchors?.length) p(`${w} node ${n.id}`, `has no code links: add anchors, or mark it "outside" if it is not code`);
        for (const s of n.anchors ?? []) if (!symbols.has(s)) p(`${w} node ${n.id}`, `link "${s}" matches no module or item (format: crate/module::Item or crate/module::Type::method)`);
      }
      for (const n of d.nodes) if (n.in && !d.nodes.some((z) => z.id === n.in && z.zone)) p(`${w} node ${n.id}`, `"in": "${n.in}" is not a zone of this diagram`);
      for (const e of d.edges) {
        for (const end of [e.from, e.to]) if (!nodeIds.has(end)) p(w, `edge ${e.from} -> ${e.to}: no node "${end}"`);
        if (!e.label) p(w, `edge ${e.from} -> ${e.to} has no label (say what moves along it)`);
      }
    }
  }

  // Ids unique; links point at real symbols; flow references exist.
  const ids = new Map<string, string>();
  for (const x of [...a.groups.map((g) => ({ id: g.id, k: "groups" })), ...(a.features ?? []).map((f) => ({ id: f.id, k: "features" })), ...KINDS.flatMap((k) => a[k].map((x) => ({ id: x.id, k })))]) {
    if (ids.has(x.id)) p(x.k, `id "${x.id}" is used twice (also in ${ids.get(x.id)})`);
    ids.set(x.id, x.k);
  }
  const link = (where: string, anchors: string[]) => {
    if (!anchors?.length) p(where, "has no code links (anchors)");
    for (const s of anchors ?? []) if (!symbols.has(s)) p(where, `link "${s}" matches no module or item (format: crate/module::Item or crate/module::Type::method)`);
  };
  for (const k of ["entry_points", "data"] as const) for (const x of a[k]) link(`${k} ${x.id}`, x.anchors);
  for (const f of a.flows) f.steps.forEach((s, i) => link(`flow ${f.id} step ${i + 1}`, s.anchors));
  const has = (k: string, id: string) => ids.get(id) === k;
  for (const f of a.flows)
    for (const k of ["entry_points", "data"] as const) {
      if (!Array.isArray(f[k])) { p(`flow ${f.id}`, `missing "${k}" (a list of ids, can be empty)`); continue; }
      for (const id of f[k]) if (!has(k, id)) p(`flow ${f.id}`, `${k} "${id}" does not exist`);
    }
  return out;
}

// The groups as a map overlay: components named "crate · group".
export function archOverlay(a: Architecture): Overlay & { groupOf: Record<string, string> } {
  const groupOf: Record<string, string> = {};
  const components = a.groups.map((g) => {
    const name = `${g.crate} · ${g.name}`;
    for (const m of g.modules) groupOf[m] = name;
    return { name, description: g.description, modules: g.modules };
  });
  const nameOf = new Map(a.groups.map((g) => [g.id, `${g.crate} · ${g.name}`]));
  const rows = a.layout?.rows?.map((r) => r.flatMap((id) => nameOf.get(id) ?? [])).filter((r) => r.length);
  return { components, roles: a.roles ?? {}, groupOf, ...(rows?.length ? { rows, layoutNote: a.layout!.note } : {}) };
}

// What the agent changed in the file during a turn, item by item.
export interface ArchChange { kind: string; id: string; name: string; change: "added" | "removed" | "changed" }
export function archDiff(before: Architecture | null, after: Architecture | null): ArchChange[] {
  if (!after) return [];
  const all = (a: Architecture | null) => new Map(
    a ? [...a.groups.map((g) => ["groups", g] as const), ...(a.features ?? []).map((f) => ["features", f] as const), ...(a.diagrams ?? []).map((d) => ["diagrams", { ...d, name: d.question }] as const), ...(a.layout ? [["layout", { id: "layout", name: "map layout", ...a.layout }] as const] : []), ...KINDS.flatMap((k) => a[k].map((x) => [k, x] as const))]
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
