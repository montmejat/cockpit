// E2 skeleton for Zig projects, read straight from the sources: there's no maintained SCIP
// indexer for Zig (zigtools/scip-zig is an experiment from 2022), and Zig's syntax is regular
// enough that a scanner gets what the map needs.
//   groups ("crates") -> packages: the repo and every dir with its own build.zig.zon / build.zig
//   modules           -> one per .zig file; id = package/path under its src/ without ".zig",
//                        so src/terminal/Terminal.zig in package ghostty is "ghostty/terminal/Terminal",
//                        and a folder's main.zig is the folder: src/font/main.zig is "ghostty/font"
//   items             -> fns, container types (struct/enum/union/opaque), and tests, with the
//                        enclosing type as owner; a file is a struct itself, so its top-level fns
//                        have no owner ("ghostty/terminal/Terminal::print")
//   edges             -> @import("x.zig") between files, weighted by how often the import's name
//                        is used; @import("pkg") of another package's root counts too, else it's a library

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import type { Crate, Edge, Item, Module, Skeleton } from "./skeleton.ts";

export const ZIG_SOURCE = /\.(zig|zon)$/;

function listZig(root: string): string[] {
  try {
    return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "*.zig", "*.zon", "**/*.zig", "**/*.zon"], { cwd: root, encoding: "utf8", maxBuffer: 256 << 20, stdio: ["ignore", "pipe", "ignore"] })
      .split("\n").filter(Boolean);
  } catch { return (readdirSync(root, { recursive: true }) as string[]).filter((f) => ZIG_SOURCE.test(f) && !/(^|\/)(zig-out|\.zig-cache|zig-cache)\//.test(f)); }
}

// The text with comments and string/char contents blanked out (same length, newlines kept), so
// braces and keywords inside them don't count. Doc comments are read from the original text.
export function mask(src: string): string {
  const out = src.split("");
  const n = src.length;
  let i = 0;
  const blank = (a: number, b: number) => { for (let k = a; k < b; k++) if (out[k] !== "\n") out[k] = " "; };
  while (i < n) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") { const e = src.indexOf("\n", i); const end = e < 0 ? n : e; blank(i, end); i = end; }
    else if (c === "\\" && src[i + 1] === "\\") { const e = src.indexOf("\n", i); const end = e < 0 ? n : e; blank(i, end); i = end; }
    else if (c === '"' || c === "'") {
      let k = i + 1;
      while (k < n && src[k] !== c && src[k] !== "\n") k += src[k] === "\\" ? 2 : 1;
      blank(i + 1, Math.min(k, n)); i = k + 1;
    } else i++;
  }
  return out.join("");
}

const lineStarts = (s: string) => { const r = [0]; for (let i = 0; i < s.length; i++) if (s[i] === "\n") r.push(i + 1); return r; };
const lineAt = (starts: number[], pos: number) => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (starts[m] <= pos) lo = m; else hi = m - 1; } return lo + 1; };

// The /// lines right above a line (1-based), joined; the first sentence is enough.
function docAbove(lines: string[], line: number): string {
  const out: string[] = [];
  for (let l = line - 2; l >= 0 && /^\s*\/\/\/(?!\/)/.test(lines[l]); l--) out.unshift(lines[l].replace(/^\s*\/\/\/\s?/, ""));
  return out.join(" ").trim().slice(0, 200);
}

const NAME = String.raw`([A-Za-z_]\w*|@"[^"]*")`;
const FN = new RegExp(String.raw`^[ \t]*(?:pub\s+)?(?:(?:export|inline|noinline)\s+|extern(?:\s+"[^"]*")?\s+)*fn\s+` + NAME, "gm");
const CONTAINER = new RegExp(String.raw`^[ \t]*(?:pub\s+)?(?:const|var)\s+` + NAME + String.raw`\s*(?::[^=]*)?=\s*(?:extern\s+|packed\s+)?(struct|enum|union|opaque)\b`, "gm");
const TEST = /^[ \t]*test\b\s*(?:"|([A-Za-z_]\w*)|\{)/gm;
const KIND: Record<string, string> = { struct: "Struct", enum: "Enum", union: "Union", opaque: "Opaque" };

// Items of one file, from its masked text.
export function zigItems(src: string, masked: string): Item[] {
  const starts = lineStarts(src), lines = src.split("\n");
  // Matching braces, and for each position which brace encloses it.
  const close = new Map<number, number>(), parentOf = new Map<number, number>(); // open -> close, open -> enclosing open
  const stack: number[] = [];
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] === "{") { parentOf.set(i, stack.at(-1) ?? -1); stack.push(i); }
    else if (masked[i] === "}") { const o = stack.pop(); if (o != null) close.set(o, i); }
  }
  const opens = [...close.keys()].sort((a, b) => a - b);
  const enclosing = (pos: number) => { // innermost open brace before pos whose close is after it
    let lo = 0, hi = opens.length - 1, best = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (opens[m] < pos) { best = m; lo = m + 1; } else hi = m - 1; }
    for (let k = best; k >= 0; ) { const o = opens[k]; if (close.get(o)! > pos) return o; const p = parentOf.get(o)!; k = p < 0 ? -1 : opens.indexOf(p); }
    return -1;
  };
  // The brace that opens a declaration's body: the first { (or ; for a body-less one) after `from`, outside parens.
  const bodyOf = (from: number): number => {
    let depth = 0;
    for (let i = from; i < masked.length; i++) {
      const c = masked[i];
      if (c === "(" || c === "[") depth++;
      else if (c === ")" || c === "]") depth--;
      else if (depth <= 0 && c === "{") return i;
      else if (depth <= 0 && c === ";") return -1;
    }
    return -1;
  };

  // Containers first: they are the owners.
  const containers: { name: string; open: number; close: number }[] = [];
  const decls: { name: string; kind: string; at: number; open: number }[] = [];
  for (const m of masked.matchAll(CONTAINER)) {
    const at = m.index! + m[0].length - m[2].length;
    const open = bodyOf(at);
    if (open < 0) continue;
    containers.push({ name: m[1], open, close: close.get(open) ?? open });
    decls.push({ name: m[1], kind: KIND[m[2]], at: m.index! + m[0].search(/\S/), open });
  }
  // A fn returning `type` is a generic: the struct it returns is a container named after the fn,
  // so `fn Renderer(comptime T: type) type { return struct { fn drawFrame… } }` gives Renderer::drawFrame.
  const RETURNS = /\breturn\s+(?:extern\s+|packed\s+)?(struct|enum|union|opaque)\b/g;
  for (const m of masked.matchAll(FN)) {
    const open = bodyOf(m.index! + m[0].length);
    let kind = "Function";
    if (open >= 0 && /\)\s*type\s*$/.test(masked.slice(m.index!, open))) {
      RETURNS.lastIndex = open;
      for (let r; (r = RETURNS.exec(masked)) && r.index < (close.get(open) ?? 0); ) {
        if (enclosing(r.index) !== open) continue;
        const body = bodyOf(r.index + r[0].length);
        if (body < 0) continue;
        containers.push({ name: m[1], open: body, close: close.get(body) ?? body });
        kind = KIND[r[1]];
        break;
      }
    }
    decls.push({ name: m[1], kind, at: m.index! + m[0].search(/\S/), open });
  }
  for (const m of masked.matchAll(TEST)) {
    // The test's name is in the original text (the masked one has the string blanked).
    const at = m.index! + m[0].search(/\S/);
    const name = /test\s*"([^"]*)"/.exec(src.slice(at, at + 300))?.[1] ?? m[1] ?? "test";
    decls.push({ name, kind: "Test", at, open: bodyOf(at) });
  }

  const byOpen = new Map(containers.map((c) => [c.open, c]));
  const items: Item[] = [], seen = new Set<string>();
  for (const d of decls.sort((a, b) => a.at - b.at)) {
    // Only declarations of the file or of a container count, not ones inside a fn body.
    const enc = enclosing(d.at);
    const owner = enc < 0 ? undefined : byOpen.get(enc);
    if (enc >= 0 && !owner) continue;
    // Owner path: every enclosing container, outermost first. A generic's struct sits in its fn's
    // body, so step over that brace: it belongs to the same container.
    const chain: string[] = [];
    for (let o: number = enc; o >= 0; o = parentOf.get(o) ?? -1) {
      const c = byOpen.get(o);
      if (!c) break;
      chain.unshift(c.name);
      const up = parentOf.get(o) ?? -1;
      if (up >= 0 && !byOpen.has(up)) { const fnBody = decls.find((x) => x.open === up && x.name === c.name); if (fnBody) o = up; }
    }
    const name = d.name.replace(/^@"(.*)"$/, "$1");
    const key = chain.join("::") + "::" + name + (d.kind === "Test" ? "#test" : "");
    if (seen.has(key)) continue; // comptime branches defining the same fn twice
    seen.add(key);
    const line = lineAt(starts, d.at);
    const end = d.open >= 0 && close.has(d.open) ? lineAt(starts, close.get(d.open)!) : line;
    items.push({ name, kind: d.kind, doc: docAbove(lines, line), line, end, ...(chain.length ? { owner: chain.join("::") } : {}), ...(d.kind === "Test" ? { test: true } : {}) });
  }
  return items;
}

// A package's name from its build.zig.zon: `.name = .ghostty` or `.name = "ghostty"`.
function zonName(file: string): string | null {
  try { return /\.name\s*=\s*(?:\.@?"?([\w-]+)"?|"([^"]+)")/.exec(readFileSync(file, "utf8"))?.slice(1).find(Boolean) ?? null; } catch { return null; }
}

export function buildZigSkeleton(root: string): Skeleton {
  const files = listZig(root);
  const zigFiles = files.filter((f) => f.endsWith(".zig"));
  // Packages: dirs holding a build.zig.zon or build.zig. The deepest one owns a file.
  const pkgDirs = new Map<string, string>(); // dir ("" = root) -> name
  for (const f of files) {
    const base = f.split("/").pop()!;
    if (base !== "build.zig.zon" && base !== "build.zig") continue;
    const dir = f.includes("/") ? dirname(f) : "";
    if (pkgDirs.has(dir) && base === "build.zig") continue;
    const name = (base === "build.zig.zon" && zonName(join(root, f))) || (dir ? dir.split("/").pop()! : root.split("/").pop()!);
    pkgDirs.set(dir, name);
  }
  if (!pkgDirs.has("")) pkgDirs.set("", root.split("/").pop()!);
  const dirsDeepFirst = [...pkgDirs.keys()].sort((a, b) => b.length - a.length);
  const pkgOf = (f: string) => dirsDeepFirst.find((d) => d === "" || f.startsWith(d + "/"))!;

  // Ids: package/path-under-src-without-.zig. Two packages with the same name keep their dir.
  const idOf = new Map<string, string>();
  const used = new Set<string>();
  for (const f of zigFiles) {
    const dir = pkgOf(f), pkg = pkgDirs.get(dir)!;
    let rel = dir ? f.slice(dir.length + 1) : f;
    rel = rel.replace(/^src\//, "").replace(/\.zig$/, "");
    // A folder's main.zig is the folder (like Rust's mod.rs): font/main.zig is "ghostty/font",
    // unless a font.zig next to the folder already has that name.
    if (rel.endsWith("/main") && !zigFiles.includes(f.replace(/\/main\.zig$/, ".zig"))) rel = rel.slice(0, -"/main".length);
    let id = `${pkg}/${rel}`;
    if (used.has(id)) id = `${dir || pkg}/${f.replace(/\.zig$/, "")}`;
    used.add(id);
    idOf.set(f, id);
  }
  // A package's root file, for @import("pkgname"): src/main.zig, src/root.zig, src/lib.zig, or <name>.zig.
  const rootOfPkg = new Map<string, string>();
  for (const [dir, name] of pkgDirs) {
    const p = (s: string) => (dir ? dir + "/" : "") + s;
    const cand = [p("src/main.zig"), p("src/root.zig"), p("src/lib.zig"), p(`src/${name}.zig`), p("main.zig"), p(`${name}.zig`)].find((c) => idOf.has(c));
    if (cand) rootOfPkg.set(name, cand);
  }

  const modules: Module[] = [];
  const edgeCount = new Map<string, number>();
  const IMPORT = /(?:(?:pub\s+)?(?:const|var)\s+([A-Za-z_]\w*)\s*(?::[^=]*)?=\s*)?@import\(\s*"([^"]+)"\s*\)/g;
  for (const f of zigFiles) {
    let src: string;
    try { src = readFileSync(join(root, f), "utf8"); } catch { continue; }
    const masked = mask(src);
    const id = idOf.get(f)!;
    const libs: Record<string, number> = {};
    // Imports read from the original (the masked text has the strings blanked), skipping ones in comments.
    for (const m of src.matchAll(IMPORT)) {
      if (masked.slice(m.index!, m.index! + 7) !== src.slice(m.index!, m.index! + 7)) continue; // in a comment
      const [, alias, target] = m;
      let to: string | undefined;
      if (target.endsWith(".zig")) to = normalize(join(dirname(f), target));
      else to = rootOfPkg.get(target);
      // How much the file uses it: the alias's later mentions (at least the import itself).
      let uses = 1;
      if (alias) uses = Math.max(1, (masked.match(new RegExp(String.raw`(?<![\w.])` + alias + String.raw`\b`, "g"))?.length ?? 1) - 1);
      const toId = to ? idOf.get(to) : undefined;
      if (toId && toId !== id) { const k = id + "\u0000" + toId; edgeCount.set(k, (edgeCount.get(k) ?? 0) + uses); }
      else if (!toId && !target.endsWith(".zig") && target !== "builtin" && target !== "root") libs[target] = (libs[target] ?? 0) + uses;
    }
    const head: string[] = [];
    for (const l of src.split("\n")) { if (/^\s*\/\/!/.test(l)) head.push(l.replace(/^\s*\/\/!\s?/, "")); else if (head.length || l.trim()) break; }
    modules.push({
      id, crate: pkgDirs.get(pkgOf(f))!, file: f, lines: src.split("\n").length,
      doc: head.join("\n").split("\n\n")[0].replace(/\s+/g, " ").trim().slice(0, 400),
      items: zigItems(src, masked), libs,
    });
  }

  const edges: Edge[] = [...edgeCount].map(([k, refs]) => { const [from, to] = k.split("\u0000"); return { from, to, refs }; });
  const crateOfId = new Map(modules.map((m) => [m.id, m.crate]));
  const deps = new Map<string, Set<string>>();
  for (const m of modules) deps.set(m.crate, deps.get(m.crate) ?? new Set());
  for (const e of edges) { const a = crateOfId.get(e.from)!, b = crateOfId.get(e.to)!; if (a !== b) deps.get(a)!.add(b); }
  const crates: Crate[] = [...deps].map(([name, d]) => ({ name, deps: [...d].sort() })).sort((a, b) => a.name.localeCompare(b.name));
  modules.sort((a, b) => a.id.localeCompare(b.id));
  return { root, lang: "zig", crates, modules, edges };
}
