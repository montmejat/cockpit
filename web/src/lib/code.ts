// Code on the page: syntax colors, line by line, and diffs as rows.

import hljs from "highlight.js/lib/core";
import rust from "highlight.js/lib/languages/rust";
import typescript from "highlight.js/lib/languages/typescript";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import ini from "highlight.js/lib/languages/ini";
import markdown from "highlight.js/lib/languages/markdown";
import yaml from "highlight.js/lib/languages/yaml";
import bash from "highlight.js/lib/languages/bash";
import python from "highlight.js/lib/languages/python";
import css from "highlight.js/lib/languages/css";
import xml from "highlight.js/lib/languages/xml";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import cmake from "highlight.js/lib/languages/cmake";
import glsl from "highlight.js/lib/languages/glsl";
import swift from "highlight.js/lib/languages/swift";
import nix from "highlight.js/lib/languages/nix";
import objectivec from "highlight.js/lib/languages/objectivec";
import zig from "./lang/zig";

for (const [n, l] of Object.entries({ rust, typescript, javascript, json, ini, markdown, yaml, bash, python, css, xml, c, cpp, cmake, glsl, swift, nix, objectivec, zig })) hljs.registerLanguage(n, l);

export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// XML and the robotics/ROS/OROCOS formats written in it (also used by the editor, editor.ts).
export const XML_EXTS = ["xml", "xsd", "xsl", "xslt", "svg", "plist", "urdf", "xacro", "srdf", "sdf", "launch", "cpf"];
const LANGS: Record<string, string> = { rs: "rust", ron: "rust", ts: "typescript", js: "javascript", svelte: "xml", json: "json", toml: "ini", md: "markdown", yml: "yaml", yaml: "yaml", sh: "bash", py: "python", css: "css", html: "xml",
  c: "c", cc: "cpp", cpp: "cpp", cxx: "cpp", h: "cpp", hh: "cpp", hpp: "cpp", hxx: "cpp", ipp: "cpp", inl: "cpp", tpp: "cpp", cmake: "cmake",
  zig: "zig", zon: "zig", glsl: "glsl", vert: "glsl", frag: "glsl", comp: "glsl", geom: "glsl", metal: "cpp", swift: "swift", nix: "nix", m: "objectivec", mm: "objectivec",
  ...Object.fromEntries(XML_EXTS.map((e) => [e, "xml"])) };
// By whole name, for files without a telling extension.
const NAMES: Record<string, string> = { "CMakeLists.txt": "cmake", Dockerfile: "bash", Makefile: "bash" };
export const langOf = (p: string) => NAMES[p.split("/").pop() ?? ""] ?? LANGS[p.split(".").pop() ?? ""] ?? null;

// Highlight the whole text, then cut the HTML into lines, closing and reopening spans at each
// line break so multi-line comments and strings keep their color.
export function hlLines(text: string, lang: string | null): string[] {
  let html: string;
  try { html = lang ? hljs.highlight(text, { language: lang, ignoreIllegals: true }).value : esc(text); } catch { html = esc(text); }
  const out: string[] = [], stack: string[] = [], re = /(<span[^>]*>)|(<\/span>)|(\n)|([^<\n]+)/g;
  let cur = "", m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (m[1]) { stack.push(m[1]); cur += m[1]; }
    else if (m[2]) { stack.pop(); cur += m[2]; }
    else if (m[3]) { out.push(cur + "</span>".repeat(stack.length)); cur = stack.join(""); }
    else cur += m[4];
  }
  out.push(cur + "</span>".repeat(stack.length));
  return out;
}
export const hlLine = (line: string, lang: string | null) => { try { return lang ? hljs.highlight(line, { language: lang, ignoreIllegals: true }).value : esc(line); } catch { return esc(line); } };

// A patch (git show) as files of rows, old and new line numbers in their own cells.
export type DiffRow = { kind: "hunk" | "add" | "del" | "ctx"; o?: number; n?: number; html: string };
export function parsePatch(patch: string): { path: string; rows: DiffRow[] }[] {
  const files: { path: string; rows: DiffRow[] }[] = [];
  let lang: string | null = null, o = 0, n = 0;
  for (const l of patch.split("\n")) {
    if (l.startsWith("diff --git")) {
      const p = l.split(" b/").pop()!;
      lang = langOf(p);
      files.push({ path: p, rows: [] });
    } else if (/^(index |--- |\+\+\+ |new file|deleted file|similarity|rename |old mode|new mode|\\)/.test(l) || !files.length) continue;
    else if (l.startsWith("@@")) {
      const m = l.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) { o = +m[1]; n = +m[2]; }
      files.at(-1)!.rows.push({ kind: "hunk", html: esc(l) });
    } else if (l[0] === "+" || l[0] === "-" || l[0] === " ") {
      const kind = l[0] === "+" ? "add" : l[0] === "-" ? "del" : "ctx";
      files.at(-1)!.rows.push({ kind, o: kind === "add" ? undefined : o++, n: kind === "del" ? undefined : n++, html: hlLine(l.slice(1), lang) });
    }
  }
  return files;
}

// A code block with a copy button in its corner (Chat handles the click).
const COPY_ICON = `<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><rect x="5" y="5" width="9" height="9" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M3 11V3.5A1.5 1.5 0 0 1 4.5 2H11" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>`;
const copyable = (pre: string) => `<div class=cblock>${pre}<button class=copy type=button title="Copy" aria-label="Copy">${COPY_ICON}</button></div>`;

/** The text a copy button stands for, if the click landed on one. */
export function copyTargetAt(target: EventTarget | null): { button: HTMLElement; text: string } | null {
  const b = (target as HTMLElement | null)?.closest?.("button.copy") as HTMLElement | null;
  const pre = b?.parentElement?.querySelector("pre");
  return b && pre ? { button: b, text: pre.textContent ?? "" } : null;
}

// A fenced block: a diff (```diff, or lines that all look like one) colors its added and removed
// lines; a known language (```ts, ```cpp…) is highlighted; anything else stays plain.
function codeBlock(code: string[], tag: string) {
  const diffy = code.some((c) => c[0] === "+") && code.some((c) => c[0] === "-") && code.every((c) => /^([+\- @]|$|\\ No newline)/.test(c));
  if (tag === "diff" || tag === "patch" || (!tag && diffy)) {
    const cls = (c: string) => /^@@/.test(c) ? "dh" : /^(\+\+\+|---) /.test(c) ? "df" : c[0] === "+" ? "da" : c[0] === "-" ? "dd" : "";
    return "<pre class=diff>" + code.map((c) => `<span class="${cls(c)}">${esc(c) || " "}</span>`).join("") + "</pre>";
  }
  const lang = tag && (hljs.getLanguage(tag) ? tag : LANGS[tag] ?? null);
  return "<pre>" + (lang ? hlLines(code.join("\n"), lang).join("\n") : esc(code.join("\n"))) + "</pre>";
}

// File references in agent replies ("src/a.zig:30", "a.zig:30-42", "src/a.zig") become links
// that open the file at that line. Only names that resolve to one of the projects' files are linked:
// the exact path, or the one file whose path ends with that name. In a workspace every project
// counts (the page's own first); another project's file is "@name/path", as everywhere on the page.
export type FileRef = { path: string; line?: number; end?: number };
export type RefProject = { name: string; prefix: string; files: string[]; modules: { id: string; file: string; items: { key: string; line: number; end?: number }[] }[] };
export function fileResolver(projects: RefProject[]) {
  const sets = projects.map((p) => new Set(p.files)), cache = new Map<string, string | null>();
  return (name: string): string | null => {
    name = name.replace(/^\.\//, "");
    if (cache.has(name)) return cache.get(name)!;
    let r: string | null = null;
    // "path" in a project, or "<project>/path"
    for (let i = 0; i < projects.length && !r; i++) {
      const p = projects[i], own = name.startsWith(p.name + "/") ? name.slice(p.name.length + 1) : null;
      if (sets[i].has(name)) r = p.prefix + name;
      else if (own && sets[i].has(own)) r = p.prefix + own;
    }
    // the one file ending with that name, in the page's project first, then in all of them
    if (!r) {
      const hits = (p: RefProject) => p.files.filter((f) => f.endsWith("/" + name)).map((f) => p.prefix + f);
      const mine = projects[0] ? hits(projects[0]) : [];
      const all = mine.length ? mine : projects.slice(1).flatMap(hits);
      r = all.length === 1 ? all[0] : null;
    }
    cache.set(name, r);
    return r;
  };
}

// Code names in agent replies (`legacy_gains_ok()`, `Node::build_layout`, `robot_->connected()`)
// become links to their definition, from the code index (the modules' items). Only inline code
// that is just a name, maybe qualified and called, and only names that resolve to one definition:
// the "Type::" or "x->" before it narrows by owner; a declaration and its definition (a header and
// its .cpp) count as one, opening the definition.
const HEADER = /\.(h|hh|hpp|hxx|h\+\+|d\.ts)$/;
export function symbolResolver(projects: RefProject[]) {
  type Def = FileRef & { owner?: string; q: string };
  let byName: Map<string, Def[]> | null = null;
  const build = () => {
    byName = new Map();
    for (const p of projects) for (const m of p.modules) for (const it of m.items) {
      const parts = it.key.slice(m.id.length + 2).split("::"), name = parts.pop()!, owner = parts.at(-1);
      if (!name) continue;
      const d: Def = { path: p.prefix + m.file, line: it.line, end: it.end, owner, q: p.prefix + [...parts, name].join("::") };
      (byName.get(name) ?? byName.set(name, []).get(name)!).push(d);
    }
    return byName;
  };
  const cache = new Map<string, FileRef | null>();
  return (code: string): FileRef | null => {
    const c = code.trim().replace(/\((?:[^()]|\([^()]*\))*\)$/, "");
    if (!/^~?[A-Za-z_]\w*(?:(?:::|->|\.)~?[A-Za-z_]\w*)*$/.test(c)) return null;
    if (cache.has(c)) return cache.get(c)!;
    const parts = c.split(/::|->|\./), name = parts.at(-1)!, owner = parts.at(-2);
    let hits = (byName ?? build()).get(name) ?? [];
    if (owner) { const o = hits.filter((h) => h.owner === owner); if (o.length) hits = o; }
    const one = new Set(hits.map((h) => h.q)).size === 1;
    const r = one ? (hits.find((h) => !HEADER.test(h.path)) ?? hits[0]) : null;
    const ref = r ? { path: r.path, line: r.line, end: r.end } : null;
    cache.set(c, ref);
    return ref;
  };
}
export type Refs = { file: (name: string) => string | null; symbol?: (code: string) => FileRef | null };
export const codeRefs = (projects: RefProject[]): Refs => ({ file: fileResolver(projects), symbol: symbolResolver(projects) });
const refLink = (r: FileRef, label: string, title: string) =>
  `<a class=fref data-path="${esc(r.path)}"${r.line ? ` data-line=${r.line}` : ""}${r.end ? ` data-end=${r.end}` : ""} title="${esc(title)}">${label}</a>`;
function linkSymbols(html: string, symbol: (code: string) => FileRef | null) {
  // Inline code outside links whose text is a name ("&gt;" is the escaped "->").
  return html.replace(/(<a\b[\s\S]*?<\/a>)|<code>([^<]+)<\/code>/g, (m, a, code) => {
    if (a != null) return m;
    const r = symbol(code.replace(/&gt;/g, ">"));
    return r ? refLink(r, m, `Open ${r.path.replace(/^@/, "")}${r.line ? " at line " + r.line : ""}`) : m;
  });
}
const REF = /(^|[\s(`'"[])((?:\.?\.?\/)?[\w@+-][\w@+.\/-]*\.[A-Za-z][\w]{0,9})(?::(\d+)(?:[-:](\d+))?)?(?=$|[\s),.;:!?`'"\]])/g;
function linkFiles(html: string, resolve: (n: string) => string | null) {
  // Only touch text, never inside tags or existing links.
  return html.replace(/(<a\b[\s\S]*?<\/a>)|(<[^>]+>)|([^<]+)/g, (m, a, tag, text) => text == null ? m :
    text.replace(REF, (all: string, pre: string, name: string, l?: string, e?: string) => {
      const path = resolve(name);
      if (!path) return all;
      const ref = name + (l ? ":" + l + (e ? "-" + e : "") : "");
      return pre + refLink({ path, line: l ? +l : undefined, end: e ? +e : undefined }, ref, `Open ${path.replace(/^@/, "")}${l ? " at line " + l : ""}`);
    }));
}
/** The file reference a click landed on, if any (for links made by md with a resolver). */
export function fileRefAt(target: EventTarget | null): FileRef | null {
  const a = (target as HTMLElement | null)?.closest?.("a.fref") as HTMLElement | null;
  if (!a) return null;
  const n = (k: string) => (a.dataset[k] ? Number(a.dataset[k]) : undefined);
  return { path: a.dataset.path!, line: n("line"), end: n("end") };
}

// Just enough Markdown for agent replies: code blocks, inline code, bold, links, lists, headings, tables.
// With refs, file references and code names in the text become links (see linkFiles, linkSymbols).
export function md(src: string, refs?: Refs) {
  const inline = (t: string) => esc(t)
    .replace(/`([^`]+)`/g, (_, c) => "<code>" + c + "</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, "$1<i>$2</i>")
    .replace(/\[((?:[^[\]]|\[[^[\]]*\])+)\]\((https?:[^)\s]+)\)/g, "<a href='$2' target=_blank rel=noopener>$1</a>");
  const out: string[] = [], lines = String(src ?? "").split("\n");
  // The lists open at this point, outermost first, each with its last item still open. An item
  // indented past its list's starts a list inside that item.
  const lists: { kind: string; indent: number }[] = [];
  let para: string[] = [];
  const close = () => { while (lists.length) out.push("</li></" + lists.pop()!.kind + ">"); };
  const flush = () => { if (para.length) out.push("<p>" + para.map(inline).join("<br>") + "</p>"); para = []; close(); };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^```/.test(l)) {
      flush();
      const code: string[] = [], tag = l.slice(3).trim().toLowerCase();
      while (++i < lines.length && !/^```/.test(lines[i])) code.push(lines[i]);
      out.push(copyable(codeBlock(code, tag)));
    } else if (/^\s*\|.*\|\s*$/.test(l) && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1] ?? "")) {
      // A table: a header row, the |---|:--:| line (which sets each column's alignment), then rows.
      flush();
      const cells = (r: string) => r.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
      const align = cells(lines[i + 1]).map((c) => (c.endsWith(":") ? (c.startsWith(":") ? "center" : "right") : ""));
      const row = (r: string, tag: string) => "<tr>" + cells(r).map((c, k) => `<${tag}${align[k] ? ` style="text-align:${align[k]}"` : ""}>${inline(c)}</${tag}>`).join("") + "</tr>";
      let html = "<div class=mdtable><table><thead>" + row(l, "th") + "</thead><tbody>";
      for (i += 2; i < lines.length && /^\s*\|/.test(lines[i]); i++) html += row(lines[i], "td");
      i--;
      out.push(html + "</tbody></table></div>");
    } else if (/^#{1,4}\s/.test(l)) { flush(); out.push("<h4>" + inline(l.replace(/^#+\s*/, "")) + "</h4>"); }
    else if (/^\s*([-*]|\d+\.)\s+/.test(l)) {
      if (para.length) flush();
      const m = /^(\s*)([-*]|(\d+)\.)\s+/.exec(l)!, indent = m[1].length, kind = m[3] ? "ol" : "ul";
      while (lists.length && lists[lists.length - 1].indent > indent) out.push("</li></" + lists.pop()!.kind + ">");
      const top = lists[lists.length - 1];
      if (top && top.indent === indent && top.kind !== kind) out.push("</li></" + lists.pop()!.kind + ">");
      if (lists.length && lists[lists.length - 1].indent === indent) out.push("</li>");
      // A numbered list starts at its first number: a reply's "2." after a blank line or a nested list is still 2.
      else { out.push("<" + kind + (m[3] && m[3] !== "1" ? ` start=${+m[3]}` : "") + ">"); lists.push({ kind, indent }); }
      out.push("<li>" + inline(l.slice(m[0].length)));
    } else if (!l.trim()) flush();
    else if (/^\s*`[^`]+`\s*$/.test(l) && !lists.length) {
      // A line that is only code ("Please run:\n`sudo dnf install x`") is a command to copy.
      flush();
      out.push(copyable("<pre>" + esc(l.trim().slice(1, -1)) + "</pre>"));
    }
    else { close(); para.push(l); }
  }
  flush();
  const html = out.join("");
  if (!refs) return html;
  // Code blocks stay as they are; everything else gets its file references, then its code names, linked.
  return html.split(/(<pre[\s\S]*?<\/pre>)/).map((part) => {
    if (part.startsWith("<pre")) return part;
    const f = linkFiles(part, refs.file);
    return refs.symbol ? linkSymbols(f, refs.symbol) : f;
  }).join("");
}

// md for a message that keeps growing (a streamed reply): the part up to its last blank line
// outside a code block is rendered once and kept, only the rest again. md starts afresh after a
// blank line, so the result is the same as md of the whole text; rendering the whole of a long
// reply on every token cost ~13 ms at 24k characters.
const grown = new Map<string, { pre: string; html: string }>();
// Returned as two parts, the kept one and the rest, so the page can leave the kept part's DOM alone.
export function mdGrowing(key: string, src: string, refs?: Refs): [string, string] {
  let cut = -1, fences = 0, i = 0;
  for (;;) {
    const nl = src.indexOf("\n", i);
    const line = src.slice(i, nl < 0 ? undefined : nl);
    if (line.startsWith("```")) fences++;
    if (nl < 0) break;
    if (!line.trim() && i > 0 && fences % 2 === 0) cut = i - 1; // the "\n" before this blank line
    i = nl + 1;
  }
  if (cut <= 0) return ["", md(src, refs)];
  const pre = src.slice(0, cut);
  let hit = grown.get(key);
  if (hit?.pre !== pre) {
    hit = { pre, html: md(pre, refs) };
    grown.set(key, hit);
    if (grown.size > 50) grown.delete(grown.keys().next().value!);
  }
  return [hit.html, md(src.slice(cut + 1), refs)];
}

// A reply that isn't JSON (a route this server doesn't have, an older server still running) says
// so, instead of WebKit's "The string did not match the expected pattern".
async function replyOf<T>(r: Response, path: string): Promise<T> {
  const text = await r.text();
  try { return JSON.parse(text) as T; } catch {
    throw new Error(`${path}: the server answered ${r.status}${text ? "" : " with nothing"}${r.status === 404 || !text ? " (restart the server if cockpit was just updated)" : ""}`);
  }
}
export const api = {
  get: <T = any>(path: string): Promise<T> => fetch(path).then((r) => replyOf<T>(r, path)),
  post: <T = any>(path: string, body: unknown = {}): Promise<T> => fetch(path, { method: "POST", body: JSON.stringify(body) }).then((r) => replyOf<T>(r, path)),
};
// A WebSocket's address, relative to the page like the API's: in a workspace the page is at
// /p/<name>/ and its sockets go to that project's server.
export const wsUrl = (path: string) => { const u = new URL(path, location.href); u.protocol = u.protocol === "https:" ? "wss:" : "ws:"; return u.href; };
