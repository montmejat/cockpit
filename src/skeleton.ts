// E2 skeleton: the project's real structure, from tools rather than a model.
//   cargo metadata -> crates and their declared dependencies
//   SCIP index     -> modules, their items, and which module references which
// Rust-only for now; SCIP indexers exist for other languages too.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import protobuf from "protobufjs";

export interface Item {
  name: string;
  kind: string; // Struct, Enum, Trait, Function, ...
  doc: string; // first line of the doc comment
  line: number; // 1-based
}

export interface Module {
  id: string; // "vehicle_sim/tire"; crate root is just "vehicle_sim"
  crate: string;
  file: string; // path relative to the project root
  lines: number;
  doc: string; // module doc comment, first paragraph
  items: Item[];
  libs: Record<string, number>; // external library -> reference count
}

export interface Edge {
  from: string; // module id
  to: string;
  refs: number; // how many references
}

export interface Crate {
  name: string;
  deps: string[]; // declared dependencies (workspace and external)
}

export interface Skeleton {
  root: string;
  crates: Crate[];
  modules: Module[];
  edges: Edge[];
}

const TOP_KINDS = new Set([
  "Struct", "Enum", "Trait", "Function", "Constant", "TypeAlias", "Macro", "Union", "StaticVariable",
]);

// Fold related crates into one library name: bevy_ecs -> bevy, sdl3_sys -> sdl3.
function libFamily(pkg: string): string | null {
  if (["core", "std", "alloc"].includes(pkg)) return null;
  return pkg.replace(/[-_](sys|internal|macros|derive|impl|core)$/, "").split(/[-_]/)[0];
}

// A SCIP symbol is "<scheme> <manager> <package> <version> <descriptors>".
function parseSymbol(sym: string) {
  if (sym.startsWith("local ")) return null;
  const parts = sym.split(" ");
  if (parts.length < 5) return null;
  const descriptor = parts.slice(4).join(" ");
  const slash = descriptor.lastIndexOf("/");
  return { pkg: parts[2], modulePath: slash >= 0 ? descriptor.slice(0, slash) : "", descriptor };
}

function moduleId(crate: string, modulePath: string): string {
  return modulePath && modulePath !== "crate" ? `${crate}/${modulePath}` : crate;
}

export function buildSkeleton(root: string, scipPath: string, protoPath: string): Skeleton {
  // Crates in the workspace, with what they declare in Cargo.toml.
  const meta = JSON.parse(
    execFileSync("cargo", ["metadata", "--format-version", "1", "--no-deps"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    }),
  );
  const crates: Crate[] = meta.packages.map((p: any) => ({
    name: p.name,
    deps: p.dependencies.filter((d: any) => d.kind !== "dev").map((d: any) => d.name),
  }));
  const local = new Set(crates.map((c) => c.name));

  const Index = protobuf.loadSync(protoPath).lookupType("scip.Index");
  const index: any = Index.toObject(Index.decode(readFileSync(scipPath)), {
    enums: String,
    longs: Number,
    defaults: true,
  });

  const modules: Module[] = [];
  const edgeCount = new Map<string, number>();

  for (const doc of index.documents) {
    if (/(^|\/)(tests|benches|examples)\//.test(doc.relativePath)) continue; // not part of the crate itself
    // Which module is this file? Its own module symbol is the definition at line 0.
    const own = doc.symbols.find((s: any) => s.kind === "Module");
    const parsed = own ? parseSymbol(own.symbol) : null;
    if (!parsed || !local.has(parsed.pkg)) continue; // e.g. integration tests
    const crate = parsed.pkg;
    const id = moduleId(crate, parsed.modulePath === "crate" ? "" : parsed.modulePath);

    const defLine = new Map<string, number>();
    for (const o of doc.occurrences) if (o.symbolRoles & 1) defLine.set(o.symbol, o.range[0] + 1);

    const items: Item[] = [];
    for (const s of doc.symbols) {
      const p = parseSymbol(s.symbol);
      if (!p || !s.displayName || !TOP_KINDS.has(s.kind)) continue;
      // Top level only: "tire/Curve#", not "tire/impl#[Curve]from_peak()."
      if (p.descriptor.slice(p.modulePath.length + 1).match(/[#.(]/g)?.length !== 1) continue;
      items.push({
        name: s.displayName,
        kind: s.kind,
        doc: (s.documentation[0] ?? "").split("\n")[0].slice(0, 200),
        line: defLine.get(s.symbol) ?? 0,
      });
    }

    const libs: Record<string, number> = {};
    for (const o of doc.occurrences) {
      if (o.symbolRoles & 1) continue; // definitions are not references
      const p = parseSymbol(o.symbol);
      if (!p) continue;
      if (local.has(p.pkg)) {
        const to = moduleId(p.pkg, p.modulePath);
        if (to !== id) edgeCount.set(`${id}\u0000${to}`, (edgeCount.get(`${id}\u0000${to}`) ?? 0) + 1);
      } else {
        const lib = libFamily(p.pkg);
        if (lib) libs[lib] = (libs[lib] ?? 0) + 1;
      }
    }

    const text = readFileSync(join(root, doc.relativePath), "utf8");
    modules.push({
      id,
      crate,
      file: doc.relativePath,
      lines: text.split("\n").length,
      doc: (own.documentation[0] ?? "").split("\n\n")[0].replace(/\s+/g, " ").slice(0, 400),
      items: items.sort((a, b) => a.line - b.line),
      libs,
    });
  }

  const ids = new Set(modules.map((m) => m.id));
  const edges: Edge[] = [...edgeCount]
    .map(([k, refs]) => {
      const [from, to] = k.split("\u0000");
      return { from, to, refs };
    })
    .filter((e) => ids.has(e.to)); // drop references to modules with no file of their own

  modules.sort((a, b) => a.id.localeCompare(b.id));
  return { root, crates, modules, edges };
}
