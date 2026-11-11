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

for (const [n, l] of Object.entries({ rust, typescript, javascript, json, ini, markdown, yaml, bash, python, css, xml, c, cpp, cmake })) hljs.registerLanguage(n, l);

export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const LANGS: Record<string, string> = { rs: "rust", ron: "rust", ts: "typescript", js: "javascript", svelte: "xml", json: "json", toml: "ini", md: "markdown", yml: "yaml", yaml: "yaml", sh: "bash", py: "python", css: "css", html: "xml",
  c: "c", cc: "cpp", cpp: "cpp", cxx: "cpp", h: "cpp", hh: "cpp", hpp: "cpp", hxx: "cpp", ipp: "cpp", inl: "cpp", tpp: "cpp", cmake: "cmake" };
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
// that open the file at that line. Only names that resolve to one of the project's files are linked:
// the exact path, or the one file whose path ends with that name.
export type FileRef = { path: string; line?: number; end?: number };
export function fileResolver(files: string[]) {
  const set = new Set(files), cache = new Map<string, string | null>();
  return (name: string): string | null => {
    name = name.replace(/^\.\//, "");
    if (set.has(name)) return name;
    if (cache.has(name)) return cache.get(name)!;
    const hits = files.filter((f) => f.endsWith("/" + name));
    const r = hits.length === 1 ? hits[0] : null;
    cache.set(name, r);
    return r;
  };
}
const REF = /(^|[\s(`'"[])((?:\.?\.?\/)?[\w@+-][\w@+.\/-]*\.[A-Za-z][\w]{0,9})(?::(\d+)(?:[-:](\d+))?)?(?=$|[\s),.;:!?`'"\]])/g;
function linkFiles(html: string, resolve: (n: string) => string | null) {
  // Only touch text, never inside tags or existing links.
  return html.replace(/(<a\b[\s\S]*?<\/a>)|(<[^>]+>)|([^<]+)/g, (m, a, tag, text) => text == null ? m :
    text.replace(REF, (all: string, pre: string, name: string, l?: string, e?: string) => {
      const path = resolve(name);
      if (!path) return all;
      const ref = name + (l ? ":" + l + (e ? "-" + e : "") : "");
      return `${pre}<a class=fref data-path="${esc(path)}"${l ? ` data-line=${l}` : ""}${e ? ` data-end=${e}` : ""} title="Open ${esc(path)}${l ? " at line " + l : ""}">${ref}</a>`;
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
// With a resolver, file references in the text become links (see linkFiles).
export function md(src: string, resolve?: (name: string) => string | null) {
  const inline = (t: string) => esc(t)
    .replace(/`([^`]+)`/g, (_, c) => "<code>" + c + "</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, "$1<i>$2</i>")
    .replace(/\[((?:[^[\]]|\[[^[\]]*\])+)\]\((https?:[^)\s]+)\)/g, "<a href='$2' target=_blank rel=noopener>$1</a>");
  const out: string[] = [], lines = String(src ?? "").split("\n");
  let list: string | null = null, para: string[] = [];
  const flush = () => { if (para.length) out.push("<p>" + para.map(inline).join("<br>") + "</p>"); para = []; if (list) { out.push("</" + list + ">"); list = null; } };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^```/.test(l)) {
      flush();
      const code: string[] = [], tag = l.slice(3).trim().toLowerCase();
      while (++i < lines.length && !/^```/.test(lines[i])) code.push(lines[i]);
      out.push(codeBlock(code, tag));
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
      if (para.length) { const keep = list; list = null; flush(); list = keep; }
      const kind = /^\s*\d+\./.test(l) ? "ol" : "ul";
      if (list !== kind) { if (list) out.push("</" + list + ">"); out.push("<" + kind + ">"); list = kind; }
      out.push("<li>" + inline(l.replace(/^\s*([-*]|\d+\.)\s+/, "")) + "</li>");
    } else if (!l.trim()) flush();
    else { if (list) { out.push("</" + list + ">"); list = null; } para.push(l); }
  }
  flush();
  const html = out.join("");
  if (!resolve) return html;
  // Code blocks stay as they are; everything else gets its file references linked.
  return html.split(/(<pre[\s\S]*?<\/pre>)/).map((part) => part.startsWith("<pre") ? part : linkFiles(part, resolve)).join("");
}

export const api = {
  get: <T = any>(path: string): Promise<T> => fetch(path).then((r) => r.json()),
  post: <T = any>(path: string, body: unknown = {}): Promise<T> => fetch(path, { method: "POST", body: JSON.stringify(body) }).then((r) => r.json()),
};
