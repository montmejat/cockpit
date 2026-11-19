// The file editor (CodeMirror 6): languages, colors that match the rest of the page, and the
// pieces FileEditor.svelte puts together: change bars in the margin from git's hunks (kept in
// place while you type), the removed lines under a clicked bar, and highlighted line ranges.

import { EditorView, Decoration, type DecorationSet, gutter, GutterMarker, WidgetType } from "@codemirror/view";
import { RangeSet, StateEffect, StateField, type Extension, type Text } from "@codemirror/state";
import { HighlightStyle, LanguageSupport, StreamLanguage, syntaxHighlighting, type StreamParser } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { rust } from "@codemirror/lang-rust";
import { cpp } from "@codemirror/lang-cpp";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { yaml } from "@codemirror/lang-yaml";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { cmake } from "@codemirror/legacy-modes/mode/cmake";
import { swift } from "@codemirror/legacy-modes/mode/swift";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { shader, objectiveC, objectiveCpp } from "@codemirror/legacy-modes/mode/clike";
import type { Hunk } from "./types";

// ---- Zig: CodeMirror has none ------------------------------------------------------

const ZIG_KEYWORDS = new Set("addrspace align allowzero and anyframe anytype asm break callconv catch comptime const continue defer else enum errdefer error export extern fn for if inline linksection noalias noinline nosuspend opaque or orelse packed pub resume return struct suspend switch test threadlocal try union unreachable usingnamespace var volatile while async await".split(" "));
const ZIG_ATOMS = new Set(["true", "false", "null", "undefined"]);
const ZIG_TYPES = new Set("bool void noreturn type anyerror anyopaque comptime_int comptime_float isize usize c_char c_short c_ushort c_int c_uint c_long c_ulong c_longlong c_ulonglong c_longdouble f16 f32 f64 f80 f128".split(" "));
const zigParser: StreamParser<{ afterFn: boolean }> = {
  name: "zig",
  startState: () => ({ afterFn: false }),
  token(stream, state) {
    if (stream.eatSpace()) return null;
    if (stream.match("//")) { stream.skipToEnd(); return "comment"; }
    if (stream.match("\\\\")) { stream.skipToEnd(); return "string"; }
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) return "string";
    if (stream.match(/^'(?:[^'\\]|\\.)+'/)) return "string";
    if (stream.match(/^@[A-Za-z_]\w*/)) return "builtin";
    if (stream.match(/^@"(?:[^"\\]|\\.)*"/)) return "variable";
    if (stream.match(/^(?:0x[\da-fA-F_]+(?:\.[\da-fA-F_]*)?(?:[pP][+-]?\d+)?|0o[0-7_]+|0b[01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)/)) return "number";
    const w = stream.match(/^[A-Za-z_]\w*/) as RegExpMatchArray | null;
    if (w) {
      const word = w[0], fnName = state.afterFn;
      state.afterFn = word === "fn";
      if (ZIG_KEYWORDS.has(word)) return "keyword";
      if (ZIG_ATOMS.has(word)) return "atom";
      if (fnName) return "fnName";
      if (ZIG_TYPES.has(word) || /^[iu]\d+$/.test(word) || /^[A-Z]/.test(word)) return "type";
      return "variable";
    }
    stream.next();
    return null;
  },
  tokenTable: { fnName: t.function(t.definition(t.variableName)) },
  languageData: { commentTokens: { line: "//" } },
};

const legacy = (p: StreamParser<any>) => new LanguageSupport(StreamLanguage.define(p));
const BY_EXT: Record<string, () => Extension> = {
  rs: rust, ron: rust,
  c: cpp, h: cpp, cc: cpp, cpp: cpp, cxx: cpp, hh: cpp, hpp: cpp, hxx: cpp, ipp: cpp, inl: cpp, tpp: cpp, metal: cpp,
  ts: () => javascript({ typescript: true }), mts: () => javascript({ typescript: true }), js: javascript, mjs: javascript, cjs: javascript,
  json: json, md: markdown, py: python, css: css, html: html, svelte: html, yml: yaml, yaml: yaml,
  toml: () => legacy(toml), sh: () => legacy(shell), bash: () => legacy(shell), cmake: () => legacy(cmake), swift: () => legacy(swift),
  glsl: () => legacy(shader), vert: () => legacy(shader), frag: () => legacy(shader), comp: () => legacy(shader), geom: () => legacy(shader),
  m: () => legacy(objectiveC), mm: () => legacy(objectiveCpp), zig: () => legacy(zigParser), zon: () => legacy(zigParser),
};
const BY_NAME: Record<string, () => Extension> = { "CMakeLists.txt": () => legacy(cmake), Dockerfile: () => legacy(dockerFile), Makefile: () => legacy(shell) };
export function languageFor(path: string): Extension {
  const name = path.split("/").pop() ?? "";
  const f = BY_NAME[name] ?? BY_EXT[name.split(".").pop() ?? ""];
  return f ? f() : [];
}

// ---- look: the page's colors (they follow light and dark) -------------------------------

const colors = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.definitionKeyword, t.modifier, t.self, t.meta, t.processingInstruction, t.macroName], color: "var(--k)" },
  { tag: [t.string, t.special(t.string), t.character, t.regexp, t.escape], color: "var(--s)" },
  { tag: [t.number, t.bool, t.null, t.atom, t.unit, t.attributeName], color: "var(--n)" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "var(--c)", fontStyle: "italic" },
  { tag: [t.typeName, t.className, t.namespace, t.standard(t.variableName), t.standard(t.typeName), t.tagName], color: "var(--t)" },
  { tag: [t.function(t.variableName), t.function(t.definition(t.variableName)), t.function(t.propertyName)], color: "var(--f)" },
  { tag: t.heading, fontWeight: "600" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "600" },
  { tag: t.link, color: "var(--accent)" },
]);

export const look: Extension = [
  syntaxHighlighting(colors),
  EditorView.theme({
    "&": { height: "100%", fontSize: "var(--fs-code)", backgroundColor: "var(--card)", color: "var(--fg)" },
    "&.cm-focused": { outline: "none" },
    ".cm-scroller": { fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace', lineHeight: "1.55" },
    ".cm-content": { caretColor: "var(--fg)" },
    ".cm-gutters": { backgroundColor: "var(--card)", color: "var(--muted)", borderRight: "1px solid var(--line)", position: "relative" },
    ".cm-lineNumbers .cm-gutterElement": { padding: "0 8px 0 10px", opacity: ".8" },
    ".cm-activeLine": { backgroundColor: "color-mix(in oklab, var(--fg) 4%, transparent)" },
    ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--fg)", fontWeight: "600" },
    "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "var(--sel) !important" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--fg)" },
    ".cm-fat-cursor": { background: "color-mix(in oklab, var(--accent) 55%, transparent) !important", outline: "none !important" },
    "&:not(.cm-focused) .cm-fat-cursor": { background: "none !important", outline: "1px solid color-mix(in oklab, var(--accent) 55%, transparent) !important" },
    ".cm-panels": { backgroundColor: "var(--bg)", color: "var(--fg)" },
    ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--line)" },
    ".cm-vim-panel": { padding: "2px 8px", fontFamily: "inherit" },
    ".cm-vim-panel input": { fontFamily: "inherit", color: "var(--fg)" },
    ".cm-searchMatch": { backgroundColor: "color-mix(in oklab, var(--warn) 30%, transparent)" },
    ".cm-searchMatch-selected": { backgroundColor: "color-mix(in oklab, var(--warn) 55%, transparent)" },
    ".cm-matchingBracket": { backgroundColor: "color-mix(in oklab, var(--accent) 20%, transparent)", outline: "none" },
    // lines asked for (a diagram link, a test) and lines of the box hovered on the floating diagram
    ".cm-want": { backgroundColor: "color-mix(in oklab, var(--accent) 10%, transparent)" },
    ".cm-boxhl": { backgroundColor: "color-mix(in oklab, var(--accent) 9%, transparent)", boxShadow: "inset 3px 0 0 var(--accent)" },
    // the change bars and the removed lines
    ".cm-chg-gutter": { width: "6px" },
    ".cm-chg-gutter .cm-gutterElement": { padding: "0", position: "relative" },
    ".cm-chg": { position: "absolute", left: "1px", top: "0", bottom: "0", width: "4px" },
    ".cm-chg.add": { background: "var(--add)" },
    ".cm-chg.mod": { background: "var(--accent)" },
    ".cm-chg.del": { background: "var(--del)", opacity: ".6", top: "-2px", bottom: "auto", height: "4px" },
    ".cm-chg.click": { cursor: "pointer" },
    ".cm-hunk": { borderTop: "1px solid var(--line)", borderBottom: "1px solid var(--line)", margin: "2px 0" },
    ".cm-hunkbar": { display: "flex", alignItems: "center", gap: "8px", padding: "1px 8px", fontSize: "var(--fs-s)", color: "var(--muted)", backgroundColor: "var(--bg)", fontFamily: "inherit" },
    ".cm-hunkbar button": { font: "inherit", fontSize: "var(--fs-s)", padding: "0 6px", cursor: "pointer", color: "var(--fg)", background: "var(--card)", border: "1px solid var(--line)", borderRadius: "4px" },
    ".cm-hunkbar button:first-of-type:hover": { borderColor: "var(--del)", color: "var(--del)" },
    ".cm-hunkbar button:last-of-type": { marginLeft: "auto", border: "0", background: "none", color: "var(--muted)" },
    ".cm-chg.click:hover": { width: "6px" },
    ".cm-removed": { backgroundColor: "var(--del-bg)", whiteSpace: "pre", padding: "0 6px 0 2px", color: "var(--fg)" },
  }),
];

// ---- change bars: from the hunks of the last version on disk, moved along as you type --------

class Bar extends GutterMarker {
  constructor(readonly kind: "add" | "mod" | "del", readonly hunk: Hunk) { super(); }
  eq(o: Bar) { return o.kind === this.kind && o.hunk === this.hunk; }
  toDOM() { const s = document.createElement("span"); s.className = "cm-chg click " + this.kind; s.title = "Show this change (old lines, revert)"; return s; }
}
export const setHunks = StateEffect.define<Hunk[]>();
const dropHunk = StateEffect.define<Hunk>(); // a reverted change: its bars and strip go
export const toggleRemoved = StateEffect.define<{ hunk?: Hunk; all?: boolean }>();
const lineStart = (doc: Text, n: number) => (n <= doc.lines ? doc.line(n).from : doc.length);

const barsField = StateField.define<RangeSet<Bar>>({
  create: () => RangeSet.empty,
  update(set, tr) {
    for (const e of tr.effects) if (e.is(setHunks)) {
      const doc = tr.state.doc, ranges = [];
      for (const h of e.value) {
        if (!h.added) { if (h.removed.length) ranges.push(new Bar("del", h).range(lineStart(doc, h.at))); continue; }
        const kind = h.removed.length ? "mod" : "add";
        for (let k = 0; k < h.added && h.at + k <= doc.lines; k++) ranges.push(new Bar(kind, h).range(doc.line(h.at + k).from));
      }
      return RangeSet.of(ranges, true);
    }
    set = set.map(tr.changes);
    for (const e of tr.effects) if (e.is(dropHunk)) set = set.update({ filter: (_f, _t, m) => m.hunk !== e.value });
    return set;
  },
});

// Revert one change in the buffer: its lines back to what the last commit has. Undoable; it
// reaches the file when you save.
function revert(view: EditorView, h: Hunk) {
  const doc = view.state.doc, lines: number[] = [];
  view.state.field(barsField).between(0, doc.length, (from, _to, m) => { if (m.hunk === h) lines.push(doc.lineAt(from).number); });
  const old = h.removed.join("\n");
  let change: { from: number; to: number; insert: string };
  if (!h.added) {
    // Lines were removed here: put them back above the line the mark is on (or at the end).
    const at = lines[0] ?? h.at;
    change = at > doc.lines || (lines.length === 0 && h.at > doc.lines)
      ? { from: doc.length, to: doc.length, insert: "\n" + old }
      : { from: doc.line(at).from, to: doc.line(at).from, insert: old + "\n" };
  } else {
    if (!lines.length) return;
    const first = doc.line(Math.min(...lines)), last = doc.line(Math.max(...lines));
    if (h.removed.length) change = { from: first.from, to: last.to, insert: old };
    // Added lines only: take them out, with their line breaks.
    else if (last.number < doc.lines) change = { from: first.from, to: last.to + 1, insert: "" };
    else change = { from: Math.max(0, first.from - 1), to: last.to, insert: "" };
  }
  view.dispatch({ changes: change, effects: dropHunk.of(h), userEvent: "input.revert" });
  view.focus();
}

// The strip above a change: a revert button, then the removed lines. Opened by clicking the
// change's bar; "show removed" opens it on every change that removed lines.
class Removed extends WidgetType {
  constructor(readonly hunk: Hunk) { super(); }
  eq(o: Removed) { return o.hunk === this.hunk; }
  toDOM(view: EditorView) {
    const d = document.createElement("div"), h = this.hunk;
    d.className = "cm-hunk";
    const bar = document.createElement("div");
    bar.className = "cm-hunkbar";
    const what = document.createElement("span");
    what.textContent = !h.added ? `${h.removed.length} line${h.removed.length > 1 ? "s" : ""} removed`
      : !h.removed.length ? `${h.added} line${h.added > 1 ? "s" : ""} added` : `${h.removed.length} line${h.removed.length > 1 ? "s" : ""} changed` + (h.added !== h.removed.length ? ` to ${h.added}` : "");
    const b = document.createElement("button");
    b.textContent = "revert";
    b.title = "Put back what the last commit has here (u undoes it; :w or Ctrl+S saves it)";
    b.onmousedown = (e) => { e.preventDefault(); revert(view, h); };
    const x = document.createElement("button");
    x.textContent = "×"; x.title = "Close";
    x.onmousedown = (e) => { e.preventDefault(); view.dispatch({ effects: toggleRemoved.of({ hunk: h }) }); };
    bar.append(what, b, x);
    d.append(bar);
    for (const l of h.removed) { const r = document.createElement("div"); r.className = "cm-removed"; r.textContent = l || " "; d.append(r); }
    return d;
  }
  ignoreEvent() { return true; }
}
const openField = StateField.define<{ open: Set<Hunk>; all: boolean; hunks: Hunk[] }>({
  create: () => ({ open: new Set(), all: false, hunks: [] }),
  update(v, tr) {
    for (const e of tr.effects) {
      if (e.is(setHunks)) v = { ...v, hunks: e.value, open: new Set([...v.open].filter((h) => e.value.includes(h))) };
      if (e.is(dropHunk)) v = { ...v, hunks: v.hunks.filter((h) => h !== e.value), open: new Set([...v.open].filter((h) => h !== e.value)) };
      if (e.is(toggleRemoved)) {
        if (e.value.all != null) v = { ...v, all: e.value.all };
        else if (e.value.hunk) { const h = e.value.hunk, open = new Set(v.open); if (open.has(h)) open.delete(h); else open.add(h); v = { ...v, open }; }
      }
    }
    return v;
  },
});
const removedField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(set, tr) {
    if (!tr.effects.some((e) => e.is(setHunks) || e.is(toggleRemoved) || e.is(dropHunk))) return set.map(tr.changes);
    const { open, all, hunks } = tr.state.field(openField), doc = tr.state.doc;
    // Placed where the bars are now, so they follow your edits.
    const at = new Map<Hunk, number>();
    tr.state.field(barsField).between(0, doc.length, (from, _to, m) => { if (!at.has(m.hunk)) at.set(m.hunk, from); });
    const ds = hunks.filter((h) => open.has(h) || (all && h.removed.length))
      // Lines removed at the very end go after the last line; the others above their line.
      .map((h) => (h.at > doc.lines
        ? Decoration.widget({ widget: new Removed(h), block: true, side: 1 }).range(doc.length)
        : Decoration.widget({ widget: new Removed(h), block: true, side: -1 }).range(at.get(h) ?? lineStart(doc, h.at))))
      .sort((a, b) => a.from - b.from);
    return Decoration.set(ds);
  },
  provide: (f) => EditorView.decorations.from(f),
});

export function changeBars(): Extension {
  return [
    barsField, openField, removedField,
    gutter({
      class: "cm-chg-gutter",
      markers: (v) => v.state.field(barsField),
      domEventHandlers: {
        mousedown(view, line) {
          let hit: Hunk | null = null;
          view.state.field(barsField).between(line.from, line.from, (_f, _t, m) => { hit = m.hunk; });
          if (!hit) return false;
          view.dispatch({ effects: toggleRemoved.of({ hunk: hit }) });
          return true;
        },
      },
    }),
  ];
}
/** Where each change starts now (for ↑↓): the first line of each hunk's bars. */
export function changeStarts(view: EditorView): number[] {
  const out: number[] = [], seen = new Set<Hunk>();
  view.state.field(barsField).between(0, view.state.doc.length, (from, _to, m) => { if (!seen.has(m.hunk)) { seen.add(m.hunk); out.push(from); } });
  return out;
}

// ---- highlighted line ranges (asked-for lines, the hovered box's lines) ----------------------

export function lineMarks(name: string) {
  const set = StateEffect.define<[number, number][]>();
  const field = StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(deco, tr) {
      for (const e of tr.effects) if (e.is(set)) {
        const doc = tr.state.doc, ds = [], mark = Decoration.line({ class: name });
        for (const [a, b] of e.value) for (let n = Math.max(1, a); n <= Math.min(b, doc.lines); n++) ds.push(mark.range(doc.line(n).from));
        return Decoration.set(ds, true);
      }
      return deco.map(tr.changes);
    },
    provide: (f) => EditorView.decorations.from(f),
  });
  return { field, set };
}
