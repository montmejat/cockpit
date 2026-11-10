// E2 skeleton for C and C++ projects, from a scip-clang index.
//   groups ("crates") -> the CMake projects in the repo: top-level dirs with a CMakeLists.txt
//   modules           -> one per source or header file
//   edges             -> file A uses a symbol defined in file B, or includes B
//
// scip-clang leaves out what rust-analyzer fills in: every symbol has package ".", no kind,
// no display name and no enclosing range. So "is it ours" comes from where a symbol is
// defined, the kind and name from the descriptor (plus a look at the source line), and the
// end of a definition from matching braces.

import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import protobuf from "protobufjs";
import type { Crate, Edge, Item, Module, Skeleton } from "./skeleton.ts";

export const CXX_SOURCE = /\.(c|cc|cpp|cxx|c\+\+|h|hh|hpp|hxx|h\+\+|ipp|inl|tpp)$/i;
const NO_DOC = "No documentation available.";
// Build trees and vendored code: indexed when included, but not part of the project's own code.
const NOT_OURS = /(^|\/)(build[^/]*|cmake-build-[^/]*|_deps|third_party|3rdparty|external|vendor)\//;
const HEADER = /\.(h|hh|hpp|hxx|h\+\+|ipp|inl|tpp)$/i;

// "cxx . . $ engine/physics/World#step(ba88)." -> the descriptor after the 4 header fields.
function descriptorOf(sym: string): string | null {
  if (!sym.startsWith("cxx ")) return null;
  const parts = sym.split(" ");
  return parts.length < 5 ? null : parts.slice(4).join(" ");
}

// Split a descriptor into its parts, keeping `backquoted names` and (hashes) intact.
// Each part ends with its suffix: "/" namespace, "#" type, "." term, "()." method, "!" macro.
function partsOf(desc: string): { name: string; suffix: string }[] {
  const out: { name: string; suffix: string }[] = [];
  let i = 0;
  while (i < desc.length) {
    let name = "";
    if (desc[i] === "`") {
      const close = desc.indexOf("`", i + 1);
      if (close < 0) return [];
      name = desc.slice(i + 1, close);
      i = close + 1;
    } else {
      const m = /^[^/#.(!`]+/.exec(desc.slice(i));
      if (!m) return [];
      name = m[0];
      i += name.length;
    }
    let suffix = desc[i] ?? "";
    if (suffix === "(") {
      const close = desc.indexOf(")", i);
      if (close < 0 || desc[close + 1] !== ".") return [];
      suffix = "().";
      i = close + 2;
    } else i += 1;
    out.push({ name, suffix });
  }
  return out;
}

// The library a symbol belongs to: its outermost namespace, with the C++ runtime left out.
function libOf(desc: string): string | null {
  const first = partsOf(desc)[0];
  if (!first || first.suffix !== "/") return null;
  if (["std", "__gnu_cxx", "__cxxabiv1", "__gnu_debug"].includes(first.name) || first.name.startsWith("<")) return null;
  return first.name;
}

// What a definition is, from the source line it starts on.
function kindOf(suffix: string, nested: boolean, line: string, name: string): string | null {
  if (suffix === "().") return nested ? "Method" : "Function";
  if (suffix === "#") {
    const before = line.slice(0, Math.max(0, line.indexOf(name)));
    if (/\benum\b/.test(before)) return "Enum";
    if (/\bunion\b/.test(before)) return "Union";
    if (/\bstruct\b/.test(before)) return "Struct";
    if (/\bclass\b/.test(before)) return "Class";
    if (/\b(using|typedef)\b/.test(line)) return "TypeAlias";
    return "Class";
  }
  if (suffix === "." && !nested) return /\b(constexpr|const)\b/.test(line) ? "Constant" : "StaticVariable";
  return null;
}

// Last line (1-based) of the definition starting at `line`: the brace that closes it, or the
// ";" that ends a declaration. Skips comments and string literals well enough for a map.
function endOf(text: string[], line: number): number {
  let depth = 0, opened = false, inBlock = false;
  for (let l = line - 1; l < text.length && l < line - 1 + 5000; l++) {
    const s = text[l];
    for (let c = 0; c < s.length; c++) {
      const ch = s[c];
      if (inBlock) { if (ch === "*" && s[c + 1] === "/") { inBlock = false; c++; } continue; }
      if (ch === "/" && s[c + 1] === "/") break;
      if (ch === "/" && s[c + 1] === "*") { inBlock = true; c++; continue; }
      if (ch === '"' || ch === "'") { const q = ch; for (c++; c < s.length && s[c] !== q; c++) if (s[c] === "\\") c++; continue; }
      if (ch === "{") { depth++; opened = true; }
      else if (ch === "}") { depth--; if (opened && depth <= 0) return l + 1; }
      else if (ch === ";" && !opened) return l + 1;
    }
  }
  return line;
}

// The CMake project a file belongs to: the top-level dir holding a CMakeLists.txt, else the repo.
function crateFinder(root: string) {
  const rootName = basename(root);
  const cache = new Map<string, string>();
  return (path: string) => {
    const top = path.includes("/") ? path.split("/")[0] : "";
    if (!cache.has(top)) cache.set(top, top && existsSync(join(root, top, "CMakeLists.txt")) ? top : rootName);
    return cache.get(top)!;
  };
}

// Module id: "<crate>/<path inside the crate>", without the conventional src/ or include/ level.
function moduleIdOf(crate: string, path: string): string {
  const inner = path.startsWith(crate + "/") ? path.slice(crate.length + 1) : path;
  return `${crate}/${inner.replace(/^(src|include)\//, "")}`;
}

export function buildCppSkeleton(root: string, scipPath: string, protoPath: string): Skeleton {
  const Index = protobuf.loadSync(protoPath).lookupType("scip.Index");
  const index: any = Index.toObject(Index.decode(readFileSync(scipPath)), { enums: String, longs: Number, defaults: true });

  const ours = index.documents.filter((d: any) => CXX_SOURCE.test(d.relativePath) && !NOT_OURS.test(d.relativePath) && existsSync(join(root, d.relativePath)));
  const ourPaths = new Set<string>(ours.map((d: any) => d.relativePath));

  // An installed copy of a project header (build/include/mylib/X.hpp) stands for the source
  // it was copied from (mylib/include/mylib/X.hpp): the longest path suffix
  // that matches exactly one file of ours.
  const bySuffix = new Map<string, string[]>();
  for (const p of ourPaths) {
    const segs = p.split("/");
    for (let i = 1; i < segs.length; i++) { const k = segs.slice(i).join("/"); bySuffix.set(k, [...(bySuffix.get(k) ?? []), p]); }
  }
  const sourceOf = (path: string): string | null => {
    if (ourPaths.has(path)) return path;
    const segs = path.split("/");
    for (let i = 1; i < segs.length - 1; i++) { const hit = bySuffix.get(segs.slice(i).join("/")); if (hit?.length === 1) return hit[0]; }
    return null;
  };

  // Where each symbol is defined, mapped back to a file of ours.
  const definedIn = new Map<string, string>();
  // Every file that defines it: scip-clang gives same-named functions in different .cpp files
  // (main, file-local helpers) one symbol, so those are not links between the files.
  const definedAll = new Map<string, Set<string>>();
  for (const d of index.documents) {
    const src = sourceOf(d.relativePath);
    if (!src) continue;
    // Namespaces are "defined" in every file that opens them: never a link between files.
    for (const o of d.occurrences) if (o.symbolRoles & 1 && !o.symbol.startsWith("local ") && !o.symbol.endsWith("/")) {
      if (!definedIn.has(o.symbol) || d.relativePath === src) definedIn.set(o.symbol, src);
      definedAll.set(o.symbol, (definedAll.get(o.symbol) ?? new Set()).add(src));
    }
  }

  // A namespace the project defines a type or function in (its full path: "acme/util", not
  // "acme", which a library may share) is the project's own, not a library, even for names with no definition of their
  // own (implicit operators, lambdas, test-only friends). Forward declarations are not
  // definitions, so a library the project forward-declares stays a library.
  const nsOf = (parts: { name: string; suffix: string }[]) => { const ns: string[] = []; for (const p of parts) { if (p.suffix !== "/") break; ns.push(p.name); } return ns.join("/"); };
  const ownNamespaces = new Set<string>();
  for (const sym of definedIn.keys()) {
    const parts = partsOf(descriptorOf(sym) ?? ""), last = parts.at(-1);
    if (last && (last.suffix === "#" || last.suffix === "().") && parts.length > 1) ownNamespaces.add(nsOf(parts));
  }
  const isOwn = (parts: { name: string; suffix: string }[]) => {
    const ns = nsOf(parts);
    for (let p = ns; p; p = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "") if (ownNamespaces.has(p)) return true;
    return false;
  };

  const crateOf = crateFinder(root);
  const idOf = new Map<string, string>([...ourPaths].map((p) => [p, moduleIdOf(crateOf(p), p)]));
  const docOf = new Map<string, any>(index.symbols?.map?.((s: any) => [s.symbol, s]) ?? []);
  for (const d of index.documents) for (const s of d.symbols) docOf.set(s.symbol, s);

  const modules: Module[] = [];
  const edgeCount = new Map<string, number>();
  const bump = (from: string, to: string, n = 1) => { if (from !== to) edgeCount.set(`${from}\u0000${to}`, (edgeCount.get(`${from}\u0000${to}`) ?? 0) + n); };

  for (const doc of ours) {
    const path: string = doc.relativePath;
    const id = idOf.get(path)!;
    const text = readFileSync(join(root, path), "utf8").split("\n");

    const items: Item[] = [];
    const seen = new Set<string>();
    for (const o of doc.occurrences) {
      if (!(o.symbolRoles & 1) || o.symbol.startsWith("local ")) continue;
      const desc = descriptorOf(o.symbol);
      if (!desc || desc.endsWith("!") || desc.startsWith("`<file>")) continue; // macros, the file itself
      const parts = partsOf(desc);
      const last = parts.at(-1);
      if (!last || last.name.startsWith("<")) continue;
      // Owner: the enclosing types ("World" for World#step, "World::Body" for nested).
      const types = parts.slice(0, -1).filter((p) => p.suffix === "#").map((p) => p.name);
      if (parts.slice(0, -1).some((p) => p.suffix === "()." || p.suffix === ".")) continue; // inside a function body
      const line = o.range[0] + 1;
      const kind = kindOf(last.suffix, types.length > 0, text[line - 1] ?? "", last.name);
      if (!kind) continue; // fields, enum values
      if (kind !== "Method" && types.length) continue; // nested types: their methods carry them as owner
      const owner = types.length ? types.join("::") : undefined;
      const key = `${owner ?? ""}::${last.name}`; // overloads count once
      if (seen.has(key)) continue;
      seen.add(key);
      const raw = (docOf.get(o.symbol)?.documentation ?? []).find((t: string) => t && t !== NO_DOC) ?? "";
      items.push({ name: last.name, kind, doc: raw.split("\n")[0].slice(0, 200), line, end: endOf(text, line), ...(owner ? { owner } : {}) });
    }

    // Methods a class in this file declares but defines elsewhere (usually its .cpp): their first
    // mention inside the class body, so the header lists its interface.
    const classes = items.filter((i) => !i.owner && /^(Class|Struct|Union)$/.test(i.kind));
    for (const o of doc.occurrences) {
      if (o.symbolRoles & 1 || o.symbol.startsWith("local ")) continue;
      const desc = descriptorOf(o.symbol);
      const parts = desc ? partsOf(desc) : [];
      const last = parts.at(-1);
      if (!last || last.suffix !== "()." || last.name.startsWith("<")) continue;
      const types = parts.slice(0, -1).filter((p) => p.suffix === "#").map((p) => p.name);
      const line = o.range[0] + 1;
      const cls = classes.find((c) => c.name === types[0] && c.line <= line && line <= c.end);
      if (!cls || parts.slice(0, -1).some((p) => p.suffix === "().")) continue;
      const owner = types.join("::"), key = `${owner}::${last.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const raw = (docOf.get(o.symbol)?.documentation ?? []).find((t: string) => t && t !== NO_DOC) ?? "";
      items.push({ name: last.name, kind: "Method", doc: raw.split("\n")[0].slice(0, 200), line, end: endOf(text, line), owner });
    }

    const libs: Record<string, number> = {};
    for (const o of doc.occurrences) {
      if (o.symbolRoles & 1 || o.symbol.startsWith("local ")) continue;
      const desc = descriptorOf(o.symbol);
      if (!desc) continue;
      const inc = /^`<file>\/(.*)`\/$/.exec(desc); // an #include
      if (inc) { const to = sourceOf(inc[1]); if (to) bump(id, idOf.get(to)!); continue; }
      if (desc.endsWith("/")) continue; // a namespace name: neither a link nor a library use
      const def = definedIn.get(o.symbol);
      // A header naming something a .cpp defines is a declaration, not a use of that .cpp.
      if (def) {
        const all = definedAll.get(o.symbol)!;
        const sources = [...all].filter((f) => !HEADER.test(f));
        const local = all.has(path) || sources.length > 1;
        if (!local && !(HEADER.test(path) && !HEADER.test(def))) bump(id, idOf.get(def)!);
        continue;
      }
      const lib = libOf(desc);
      if (lib && !isOwn(partsOf(desc))) libs[lib] = (libs[lib] ?? 0) + 1;
    }

    // File comment: the leading comment block, the closest thing C++ has to a module doc.
    const head: string[] = [];
    for (const l of text) {
      const t = l.trim();
      if (/^(\/\/+|\/\*+|\*+\/?)/.test(t)) { const s = t.replace(/^(\/\/+!?|\/\*+!?|\*+\/?)\s?/, "").replace(/\*\/$/, "").trim(); if (s || head.length) head.push(s); }
      else if (t === "" && !head.length) continue;
      else break;
    }
    const docText = head.join("\n").split("\n\n")[0].replace(/\s+/g, " ").trim();

    modules.push({
      id, crate: crateOf(path), file: path, lines: text.length,
      doc: /^(copyright|spdx|\(c\))/i.test(docText) ? "" : docText.slice(0, 400),
      items: items.sort((a, b) => a.line - b.line),
      libs,
    });
  }

  const ids = new Set(modules.map((m) => m.id));
  const edges: Edge[] = [...edgeCount]
    .map(([k, refs]) => { const [from, to] = k.split("\u0000"); return { from, to, refs }; })
    .filter((e) => ids.has(e.from) && ids.has(e.to));

  // A group depends on another when its code uses it.
  const crateOfId = new Map(modules.map((m) => [m.id, m.crate]));
  const deps = new Map<string, Set<string>>();
  for (const m of modules) deps.set(m.crate, deps.get(m.crate) ?? new Set());
  for (const e of edges) { const a = crateOfId.get(e.from)!, b = crateOfId.get(e.to)!; if (a !== b) deps.get(a)!.add(b); }
  const crates: Crate[] = [...deps].map(([name, d]) => ({ name, deps: [...d].sort() })).sort((a, b) => a.name.localeCompare(b.name));

  modules.sort((a, b) => a.id.localeCompare(b.id));
  return { root, lang: "cpp", crates, modules, edges };
}
