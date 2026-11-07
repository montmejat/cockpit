// E2 agent layer: groupings and names proposed by a model, on top of the
// skeleton. The user's corrections (overrides) always win: they are sent to
// the model as fixed, and applied again in code afterwards.

import { existsSync, readFileSync } from "node:fs";
import { callClaude } from "./claude.ts";
import type { Skeleton } from "./skeleton.ts";

export interface Component {
  name: string;
  description: string;
  modules: string[];
}

export interface Overlay {
  components: Component[];
  roles: Record<string, string>; // module id -> one-line role
  rows?: string[][]; // how to arrange components on the map, top to bottom, by name
  layoutNote?: string; // what the arrangement means
}

// Written by the user (through the map page). Versioned with cockpit.
export interface Overrides {
  modules?: Record<string, { component?: string; role?: string }>;
  components?: Record<string, { description?: string }>;
}

export function readOverrides(path: string): Overrides {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
}

const str = { type: "string" };
const obj = (properties: Record<string, object>) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const schema = obj({
  components: {
    type: "array",
    items: obj({ name: str, description: str, modules: { type: "array", items: str } }),
  },
  roles: { type: "array", items: obj({ module: str, role: str }) },
});

const SYSTEM = `You help an engineer get a high-level view of a codebase. You get its real structure (modules, their doc comments, main items, libraries used, and how many references each module makes to others).

Group the modules into components: parts of the system a person would name when explaining the architecture on a whiteboard. Usually 3-8 components. A component may span crates if that is how the system really splits.

Output:
- components: name (2-4 words), description (1-2 sentences: what it does and why it is separate), module ids.
- roles: one line per module: what it does in the system.

Rules:
- Every module id appears in exactly one component.
- Use only what the structure shows. Do not invent features.
- Assignments marked fixed by the user must be kept as they are.
- If a previous grouping is given, keep its component names and assignments wherever they still fit. Only change what the new structure requires (e.g. place new modules).`;

export function proposeOverlay(sk: Skeleton, overrides: Overrides, cacheDir: string, previous?: Overlay) {
  const out = (id: string) =>
    Object.fromEntries(sk.edges.filter((e) => e.from === id).map((e) => [e.to, e.refs]));
  const modules = sk.modules.map((m) => ({
    id: m.id,
    lines: m.lines,
    doc: m.doc,
    items: m.items.filter((i) => !i.owner && !i.test).slice(0, 12).map((i) => i.name),
    libs: Object.entries(m.libs).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([l]) => l),
    uses: out(m.id),
  }));
  const fixed = Object.entries(overrides.modules ?? {})
    .filter(([, o]) => o.component)
    .map(([id, o]) => `${id} -> ${o.component}`);

  const res = callClaude<{ components: Component[]; roles: { module: string; role: string }[] }>({
    system: SYSTEM,
    prompt:
      `Crates: ${JSON.stringify(sk.crates)}\n\nModules:\n${JSON.stringify(modules, null, 1)}` +
      (fixed.length ? `\n\nFixed by the user:\n${fixed.join("\n")}` : "") +
      (previous ? `\n\nPrevious grouping:\n${JSON.stringify(Object.fromEntries(previous.components.map((c) => [c.name, c.modules])))}` : ""),
    schema,
    cacheDir,
  });
  const overlay: Overlay = {
    components: res.output.components,
    roles: Object.fromEntries(res.output.roles.map((r) => [r.module, r.role])),
  };
  return { overlay, costUsd: res.costUsd, cached: res.cached };
}

export interface MapModel {
  components: (Component & { source: "agent" | "user" })[];
  roles: Record<string, { text: string; source: "agent" | "user" }>;
  warnings: string[];
  rows?: string[][];
  layoutNote?: string;
}

// Final map = agent proposal, then the user's corrections on top.
export function applyOverrides(sk: Skeleton, overlay: Overlay, ov: Overrides): MapModel {
  const ids = new Set(sk.modules.map((m) => m.id));
  const warnings: string[] = [];

  const placement = new Map<string, string>(); // module -> component
  for (const c of overlay.components)
    for (const m of c.modules) {
      if (!ids.has(m)) warnings.push(`agent placed a module that doesn't exist: ${m}`);
      else if (placement.has(m)) warnings.push(`agent placed ${m} twice`);
      else placement.set(m, c.name);
    }
  const userPlaced = new Set<string>();
  for (const [m, o] of Object.entries(ov.modules ?? {})) {
    if (!ids.has(m)) {
      warnings.push(`your correction for ${m} points to a module that no longer exists`);
      continue;
    }
    if (o.component) {
      placement.set(m, o.component);
      userPlaced.add(m);
    }
  }
  for (const m of ids) if (!placement.has(m)) placement.set(m, "Unplaced");

  const descriptions = new Map(overlay.components.map((c) => [c.name, c.description]));
  const names = [...new Set(placement.values())];
  const components = names.map((name) => {
    const modules = [...placement].filter(([, c]) => c === name).map(([m]) => m).sort();
    const userDesc = ov.components?.[name]?.description;
    const isUser = !!userDesc || !descriptions.has(name) || modules.some((m) => userPlaced.has(m));
    return {
      name,
      description: userDesc ?? descriptions.get(name) ?? "",
      modules,
      source: (isUser ? "user" : "agent") as "agent" | "user",
    };
  });

  const roles: MapModel["roles"] = {};
  for (const m of ids) {
    const user = ov.modules?.[m]?.role;
    roles[m] = user ? { text: user, source: "user" } : { text: overlay.roles[m] ?? "", source: "agent" };
  }
  return { components, roles, warnings, ...(overlay.rows ? { rows: overlay.rows, layoutNote: overlay.layoutNote } : {}) };
}
