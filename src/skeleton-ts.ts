// E2 skeleton for TypeScript / JavaScript projects, read straight from the sources like Zig's
// (skeleton-zig.ts): the TypeScript in node_modules (7, the native compiler) has no JS API to ask,
// and the declarations the map needs are regular enough for a scanner.
//   groups ("crates") -> packages: the repo and every dir with its own package.json
//   modules           -> one per source file (.ts .tsx .js .jsx .mjs .svelte .vue, not .d.ts);
//                        id = package/path under the package without the extension and without a
//                        leading src/, so src/serve.ts in package cockpit is "cockpit/serve", and a
//                        folder's index.ts is the folder
//   items             -> top-level functions, classes, interfaces, types, enums and variables, and
//                        a class's methods with the class as owner ("cockpit/x::Store::save"); in
//                        .svelte / .vue files, what the <script> blocks declare
//   edges             -> relative imports between files, weighted by how often the imported names
//                        are used; bare imports are libraries (node built-ins left out)
// Known gaps: JSX text with a quote in it ("don't") can throw the masking off for the rest of the
// file, and tsconfig path aliases (@/x, $lib) aren't followed.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, normalize } from "node:path";
import { type Crate, type Edge, isTestPath, type Item, type Module, type Skeleton } from "./skeleton.ts";

export const TS_SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|svelte|vue)$/;
const DECLARATION = /\.d\.[mc]?ts$/;
// Build outputs, and .cockpit/ (the project's description and its check scripts, not its code).
const SKIP = /(^|\/)(node_modules|dist|coverage|\.svelte-kit|\.next|\.nuxt)\/|^\.cockpit\//;
const isSource = (p: string) => TS_SOURCE.test(p) && !DECLARATION.test(p) && !SKIP.test(p);
// Files whose change makes the index stale.
export const isTsIndexed = (p: string) => isSource(p) || (/(^|\/)package\.json$/.test(p) && !SKIP.test(p));

function listFiles(root: string): string[] {
  try {
    return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8", maxBuffer: 256 << 20, stdio: ["ignore", "pipe", "ignore"] })
      .split("\n").filter(Boolean);
  } catch {
    const out: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(join(root, d), { withFileTypes: true })) {
        if (e.name.startsWith(".") || e.name === "node_modules") continue;
        const p = d ? `${d}/${e.name}` : e.name;
        if (e.isDirectory()) walk(p); else out.push(p);
      }
    };
    walk("");
    return out;
  }
}

// A .svelte / .vue file's <script> blocks, everything else blanked (newlines kept, so lines match).
function scriptsOf(src: string): string {
  const out = src.replace(/[^\n]/g, " ").split("");
  for (const m of src.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
    const at = m.index! + m[0].indexOf(">") + 1;
    for (let k = 0; k < m[1].length; k++) out[at + k] = m[1][k];
  }
  return out.join("");
}

const REGEX_BEFORE = /(^|[(,=:[!&|?{};+\-*%<>~^]|\b(?:return|typeof|case|in|of|yield|await|void|delete|throw|new|else|do))\s*$/;

// The text with comments, strings, template literals and regex literals blanked out (same
// length, newlines kept), so braces and keywords inside them don't count.
export function mask(src: string): string {
  const out = src.split("");
  const n = src.length;
  const blank = (a: number, b: number) => { for (let k = a; k < b; k++) if (out[k] !== "\n") out[k] = " "; };
  // From an opening quote at i, the index just past the closing one.
  const string = (i: number) => {
    const q = src[i];
    let k = i + 1;
    while (k < n && src[k] !== q && src[k] !== "\n") k += src[k] === "\\" ? 2 : 1;
    return k + 1;
  };
  // From a backtick at i, the index just past the closing one; ${…} may hold strings and templates.
  const template = (i: number): number => {
    let k = i + 1;
    while (k < n && src[k] !== "`") {
      if (src[k] === "\\") k += 2;
      else if (src[k] === "$" && src[k + 1] === "{") {
        let depth = 1;
        k += 2;
        while (k < n && depth > 0) {
          const c = src[k];
          if (c === "{") depth++;
          else if (c === "}") depth--;
          if (depth === 0) break;
          if (c === '"' || c === "'") k = string(k);
          else if (c === "`") k = template(k);
          else k++;
        }
        k++;
      } else k++;
    }
    return k + 1;
  };
  let i = 0, code = ""; // code: the unmasked text so far, to tell a regex from a division
  let codeFrom = 0;
  while (i < n) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") { const e = src.indexOf("\n", i); const end = e < 0 ? n : e; blank(i, end); i = end; }
    else if (c === "/" && src[i + 1] === "*") { const e = src.indexOf("*/", i + 2); const end = e < 0 ? n : e + 2; blank(i, end); i = end; }
    else if (c === '"' || c === "'") { const end = string(i); blank(i + 1, Math.min(end - 1, n)); i = end; }
    else if (c === "`") { const end = template(i); blank(i + 1, Math.min(end - 1, n)); i = end; }
    else if (c === "/") {
      code += out.slice(codeFrom, i).join(""); codeFrom = i;
      if (REGEX_BEFORE.test(code.slice(-40))) {
        let k = i + 1, inClass = false;
        while (k < n && src[k] !== "\n" && (inClass || src[k] !== "/")) {
          if (src[k] === "\\") k++;
          else if (src[k] === "[") inClass = true;
          else if (src[k] === "]") inClass = false;
          k++;
        }
        if (src[k] === "/") { blank(i + 1, k); i = k + 1; continue; }
      }
      i++;
    } else i++;
  }
  return out.join("");
}

const NAME = String.raw`([A-Za-z_$][\w$]*)`;
const LEAD = String.raw`^[ \t]*(?:export\s+)?(?:default\s+)?(?:declare\s+)?`;
const DECLS: [RegExp, string][] = [
  [new RegExp(LEAD + String.raw`(?:async\s+)?function\s*\*?\s*` + NAME), "Function"],
  [new RegExp(LEAD + String.raw`(?:abstract\s+)?class\s+` + NAME), "Class"],
  [new RegExp(LEAD + String.raw`interface\s+` + NAME), "Interface"],
  [new RegExp(LEAD + String.raw`type\s+` + NAME + String.raw`\s*[=<]`), "TypeAlias"],
  [new RegExp(LEAD + String.raw`(?:const\s+)?enum\s+` + NAME), "Enum"],
  [new RegExp(LEAD + String.raw`(const|let|var)\s+` + NAME + String.raw`\b(.*)`), "Variable"],
];
// What a variable holds when it's a function: `= (a) =>`, `= async x =>`, `= function`, `= <T>(`.
// Not `= (() => …)()`: that runs once and holds what it returns.
const FN_VALUE = /^\s*(?::[^=]*)?=\s*(?:async\s*)?(?:function\b|\((?!\()[^)]*\)\s*(?::[^=]*)?=>|[A-Za-z_$][\w$]*\s*=>|<|\($)/;
const METHOD = new RegExp(String.raw`^[ \t]*(?:(?:public|private|protected|static|readonly|override|abstract|async|declare|accessor)\s+)*(?:(?:get|set)\s+)?\*?\s*(#?[A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*(\(|=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]*)?=>)`);
const NOT_METHOD = new Set(["if", "for", "while", "switch", "catch", "return", "super", "function", "new", "await", "typeof"]);
const TEST_CALL = /^[ \t]*(?:it|test|describe)(?:\.\w+)?\(\s*["'`]([^"'`\n]+)/;

const lineStarts = (s: string) => { const r = [0]; for (let i = 0; i < s.length; i++) if (s[i] === "\n") r.push(i + 1); return r; };
const lineAt = (starts: number[], pos: number) => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (starts[m] <= pos) lo = m; else hi = m - 1; } return lo + 1; };

// The comment right above a line (1-based): // lines or a /* … */ block; its first 200 characters.
function docAbove(lines: string[], line: number): string {
  let l = line - 2;
  const out: string[] = [];
  if (l >= 0 && /\*\/\s*$/.test(lines[l])) {
    for (; l >= 0; l--) { out.unshift(lines[l]); if (/^\s*\/\*/.test(lines[l])) break; }
    return out.join(" ").replace(/\/\*+|\*+\//g, "").replace(/(^|\s)\*\s?/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
  }
  for (; l >= 0 && /^\s*\/\/(?!\/)/.test(lines[l]); l--) out.unshift(lines[l].replace(/^\s*\/\/\s?/, ""));
  return out.join(" ").replace(/\s+/g, " ").trim().slice(0, 200);
}

// Items of one file, from its masked text.
export function tsItems(src: string, masked: string, test: boolean): Item[] {
  const starts = lineStarts(masked), lines = src.split("\n"), mlines = masked.split("\n");
  // For each line: the innermost open brace at its start (-1: top level).
  const encAt: number[] = [];
  const close = new Map<number, number>();
  const stack: number[] = [];
  let line = 0;
  encAt[0] = -1;
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if (c === "{") stack.push(i);
    else if (c === "}") { const o = stack.pop(); if (o != null) close.set(o, i); }
    else if (c === "\n") encAt[++line] = stack.at(-1) ?? -1;
  }
  // The last line of the declaration starting at pos: where its brackets close and the statement ends.
  const endOf = (pos: number) => {
    const indent = (masked.slice(starts[lineAt(starts, pos) - 1]).match(/^[ \t]*/)?.[0] ?? "").length;
    let depth = 0;
    for (let i = pos; i < masked.length; i++) {
      const c = masked[i];
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") {
        if (--depth < 0) return lineAt(starts, i - 1);
        if (depth === 0 && c === "}" && !/^[ \t]*[.,)(?:\]]/.test(masked.slice(i + 1, i + 40))) return lineAt(starts, i);
      } else if (depth === 0 && c === ";") return lineAt(starts, i);
      else if (depth === 0 && c === "\n") {
        const before = masked.slice(Math.max(0, i - 40), i).trimEnd();
        const next = /\n([ \t]*)(\S)/.exec(masked.slice(i, i + 400));
        if (!next) return lineAt(starts, i);
        if (next[1].length <= indent && !/[.?:|&+\-*/=,)\]}>]/.test(next[2]) && !/[=,([{+\-*/|&?:<>]$/.test(before)) return lineAt(starts, i);
      }
    }
    return lineAt(starts, masked.length - 1);
  };

  const classes = new Map<number, string>(); // the open brace of a class body -> its name
  const items: Item[] = [];
  const seen = new Set<string>();
  const add = (it: Item) => {
    const key = (it.owner ?? "") + "::" + it.name + (it.kind === "Test" ? "#" + it.line : "");
    if (seen.has(key)) return; // overloads: the first signature stands for them all
    seen.add(key);
    items.push(it);
  };
  for (let l = 0; l < mlines.length; l++) {
    const text = mlines[l], enc = encAt[l], at = starts[l];
    if (!text.trim()) continue;
    const base = (name: string, kind: string) => ({ name, kind, doc: docAbove(lines, l + 1), line: l + 1, end: endOf(at), ...(test ? { test } : {}) });
    if (enc < 0) {
      if (test) { const t = TEST_CALL.exec(lines[l]); if (t) { add({ ...base(t[1].trim(), "Test"), test: true }); continue; } }
      for (const [re, kind] of DECLS) {
        const m = re.exec(text);
        if (!m) continue;
        if (kind === "Variable") {
          const isFn = FN_VALUE.test(m[3]);
          add(base(m[2], isFn ? "Function" : m[1] === "const" ? "Constant" : "Variable"));
        } else {
          add(base(m[1], kind));
          if (kind === "Class") { const open = masked.indexOf("{", at); if (open >= 0) classes.set(open, m[1]); }
        }
        break;
      }
    } else if (classes.has(enc)) {
      const m = METHOD.exec(text);
      if (!m || NOT_METHOD.has(m[1])) continue;
      add({ ...base(m[1], "Method"), owner: classes.get(enc)! });
    }
  }
  return items.sort((a, b) => a.line - b.line);
}

// The comment a file starts with, first paragraph: what the file is.
function fileDoc(src: string): string {
  const lines = src.split("\n");
  const head: string[] = [];
  let l = 0;
  while (l < lines.length && (!lines[l].trim() || /^#!/.test(lines[l]))) l++;
  if (/^\s*\/\*/.test(lines[l] ?? "")) {
    for (; l < lines.length; l++) { head.push(lines[l]); if (/\*\//.test(lines[l])) break; }
    return head.join("\n").replace(/\/\*+|\*+\//g, "").replace(/^\s*\*\s?/gm, "").trim().split(/\n\s*\n/)[0].replace(/\s+/g, " ").slice(0, 400);
  }
  for (; l < lines.length && /^\s*\/\//.test(lines[l]); l++) head.push(lines[l].replace(/^\s*\/\/+\s?/, ""));
  return head.join("\n").split(/\n\s*\n/)[0].replace(/\s+/g, " ").trim().slice(0, 400);
}

// import … from "x", export … from "x", import "x", import("x"), require("x").
const IMPORT = /\b(?:import|export)\s+([\w$\s,*{}]*?)\s*from\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']|\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g;
// The local names an import clause binds: `X`, `* as X`, `{ a as b, type c }`.
function bindings(clause: string): string[] {
  const out: string[] = [];
  const c = clause.replace(/\btype\s+/g, " ");
  for (const m of c.matchAll(/\*\s*as\s+([\w$]+)/g)) out.push(m[1]);
  const braces = /\{([^}]*)\}/.exec(c);
  if (braces) for (const part of braces[1].split(",")) { const p = part.trim().split(/\s+as\s+/).pop()!.trim(); if (/^[\w$]+$/.test(p)) out.push(p); }
  const dflt = /^\s*([\w$]+)\s*(?:,|$)/.exec(c.replace(/\{[^}]*\}|\*\s*as\s+[\w$]+/g, ""));
  if (dflt && dflt[1] !== "type") out.push(dflt[1]);
  return out;
}

// What one file says, kept while the file doesn't change (its modification time and size).
type Scanned = { lines: number; doc: string; items: Item[]; imports: { spec: string; uses: number }[] };
const scanned = new Map<string, { key: string; data: Scanned }>();
function scan(full: string, rel: string): Scanned | null {
  let key: string;
  try { const st = statSync(full); key = st.mtimeMs + ":" + st.size; } catch { return null; }
  const hit = scanned.get(full);
  if (hit?.key === key) return hit.data;
  let raw: string;
  try { raw = readFileSync(full, "utf8"); } catch { return null; }
  const src = /\.(svelte|vue)$/.test(rel) ? scriptsOf(raw) : raw;
  const masked = mask(src);
  const imports: Scanned["imports"] = [];
  for (const m of src.matchAll(IMPORT)) {
    if (masked.slice(m.index!, m.index! + 6) !== src.slice(m.index!, m.index! + 6)) continue; // in a comment or string
    const spec = m[2] ?? m[3] ?? m[4];
    const names = m[1] && /^\s*import/.test(m[0]) ? bindings(m[1]) : [];
    let uses = 0;
    for (const nm of names) uses += Math.max(0, (masked.match(new RegExp(String.raw`(?<![\w$.])` + nm.replace(/\$/g, "\\$") + String.raw`(?![\w$])`, "g"))?.length ?? 1) - 1);
    imports.push({ spec, uses: Math.max(1, uses) });
  }
  const data: Scanned = { lines: raw.split("\n").length, doc: fileDoc(src), items: tsItems(src, masked, isTestPath(rel)), imports };
  scanned.set(full, { key, data });
  return data;
}

const BUILTIN = new Set(builtinModules);
// The library a bare import names: @codemirror/view -> codemirror, svelte/store -> svelte.
function libOf(spec: string): string | null {
  if (spec.startsWith("node:") || BUILTIN.has(spec.split("/")[0])) return null;
  if (/^[$~#]|^@\//.test(spec)) return null; // a path alias, not a library
  if (spec.startsWith("@")) return spec.slice(1).split("/")[0];
  return spec.split("/")[0];
}
const EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".svelte", ".vue"];

export function buildTsSkeleton(root: string): Skeleton {
  const files = listFiles(root);
  const sources = files.filter(isSource);
  // Packages: dirs holding a package.json. The deepest one owns a file.
  const pkgDirs = new Map<string, string>(); // dir ("" = root) -> name
  for (const f of files) {
    if (!/(^|\/)package\.json$/.test(f) || SKIP.test(f)) continue;
    const dir = f.includes("/") ? dirname(f) : "";
    let name = "";
    try { name = String(JSON.parse(readFileSync(join(root, f), "utf8")).name ?? ""); } catch {}
    name = name.split("/").pop()!.replace(/[^\w.-]/g, "-") || (dir ? dir.split("/").pop()! : root.split("/").pop()!);
    pkgDirs.set(dir, name);
  }
  if (!pkgDirs.has("")) pkgDirs.set("", root.split("/").pop()!);
  const dirsDeepFirst = [...pkgDirs.keys()].sort((a, b) => b.length - a.length);
  const pkgOf = (f: string) => dirsDeepFirst.find((d) => d === "" || f.startsWith(d + "/"))!;

  // Ids: package/path-under-the-package, without src/ and the extension. Two files that would
  // get the same id (Chat.ts, Chat.svelte) keep their extension.
  const idOf = new Map<string, string>();
  const used = new Set<string>();
  const sourceSet = new Set(sources);
  for (const f of sources.sort()) {
    const dir = pkgOf(f), pkg = pkgDirs.get(dir)!;
    const relExt = (dir ? f.slice(dir.length + 1) : f).replace(/^src\//, "");
    let rel = relExt.replace(/\.[^./]+$/, "");
    // A folder's index file is the folder, unless a file next to the folder already has its name.
    if (/(^|\/)index$/.test(rel) && !(rel.includes("/") && EXTS.some((e) => sourceSet.has(f.replace(/\/index\.[^./]+$/, e))))) rel = rel.replace(/\/?index$/, "");
    let id = rel ? `${pkg}/${rel}` : pkg;
    if (used.has(id)) id = `${pkg}/${relExt}`;
    used.add(id);
    idOf.set(f, id);
  }
  // A relative import to the file it means: as written, .js written for .ts, an extension added, or index.
  const resolveImport = (from: string, spec: string): string | undefined => {
    const base = normalize(join(dirname(from), spec));
    const cands = [base, base.replace(/\.(m|c)?jsx?$/, (_e, k) => `.${k ?? ""}ts`), base.replace(/\.jsx$/, ".tsx"),
      ...EXTS.map((e) => base + e), ...EXTS.map((e) => `${base}/index${e}`)];
    return cands.find((c) => idOf.has(c));
  };

  const modules: Module[] = [];
  const edgeCount = new Map<string, number>();
  for (const f of sources) {
    const sc = scan(join(root, f), f);
    if (!sc) continue;
    const id = idOf.get(f)!;
    const libs: Record<string, number> = {};
    for (const { spec, uses } of sc.imports) {
      if (spec.startsWith(".") || spec.startsWith("/")) {
        const to = resolveImport(f, spec);
        const toId = to ? idOf.get(to) : undefined;
        if (toId && toId !== id) { const k = id + "\u0000" + toId; edgeCount.set(k, (edgeCount.get(k) ?? 0) + uses); }
        continue;
      }
      const lib = libOf(spec);
      if (lib) libs[lib] = (libs[lib] ?? 0) + uses;
    }
    modules.push({ id, crate: pkgDirs.get(pkgOf(f))!, file: f, lines: sc.lines, doc: sc.doc, items: structuredClone(sc.items), libs });
  }

  const edges: Edge[] = [...edgeCount].map(([k, refs]) => { const [from, to] = k.split("\u0000"); return { from, to, refs }; });
  const crateOfId = new Map(modules.map((m) => [m.id, m.crate]));
  const deps = new Map<string, Set<string>>();
  for (const m of modules) deps.set(m.crate, deps.get(m.crate) ?? new Set());
  for (const e of edges) { const a = crateOfId.get(e.from)!, b = crateOfId.get(e.to)!; if (a !== b) deps.get(a)!.add(b); }
  const crates: Crate[] = [...deps].map(([name, d]) => ({ name, deps: [...d].sort() })).sort((a, b) => a.name.localeCompare(b.name));
  modules.sort((a, b) => a.id.localeCompare(b.id));
  return { root, lang: "ts", crates, modules, edges };
}

// A TypeScript project often has a part in Rust beside it (a desktop shell, a native module):
// the top-level dirs with their own Cargo.toml, indexed with rust-analyzer and added in.
export const rustParts = (root: string): string[] =>
  existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith(".") && d.name !== "node_modules" && existsSync(join(root, d.name, "Cargo.toml"))).map((d) => d.name) : [];
