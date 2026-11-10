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

for (const [n, l] of Object.entries({ rust, typescript, javascript, json, ini, markdown, yaml, bash, python, css, xml })) hljs.registerLanguage(n, l);

export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const LANGS: Record<string, string> = { rs: "rust", ron: "rust", ts: "typescript", js: "javascript", svelte: "xml", json: "json", toml: "ini", md: "markdown", yml: "yaml", yaml: "yaml", sh: "bash", py: "python", css: "css", html: "xml" };
export const langOf = (p: string) => LANGS[p.split(".").pop() ?? ""] ?? null;

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

// Just enough Markdown for agent replies: code blocks, inline code, bold, links, lists, headings.
export function md(src: string) {
  const inline = (t: string) => esc(t)
    .replace(/`([^`]+)`/g, (_, c) => "<code>" + c + "</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, "$1<i>$2</i>")
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, "<a href='$2' target=_blank rel=noopener>$1</a>");
  const out: string[] = [], lines = String(src ?? "").split("\n");
  let list: string | null = null, para: string[] = [];
  const flush = () => { if (para.length) out.push("<p>" + para.map(inline).join("<br>") + "</p>"); para = []; if (list) { out.push("</" + list + ">"); list = null; } };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^```/.test(l)) {
      flush();
      const code: string[] = [];
      while (++i < lines.length && !/^```/.test(lines[i])) code.push(lines[i]);
      out.push("<pre>" + esc(code.join("\n")) + "</pre>");
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
  return out.join("");
}

export const api = {
  get: <T = any>(path: string): Promise<T> => fetch(path).then((r) => r.json()),
  post: <T = any>(path: string, body: unknown = {}): Promise<T> => fetch(path, { method: "POST", body: JSON.stringify(body) }).then((r) => r.json()),
};
