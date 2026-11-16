<script lang="ts">
  // The open file, editable (CodeMirror 6, vim keys unless you turn them off). It keeps showing
  // the file's uncommitted changes like before: bars in the margin, click one for the removed lines.
  //   Save: :w (vim), Ctrl+S. :q closes the tab, :wq / :x saves and closes.
  //   While you have no unsaved changes, it follows the file live (an agent editing it). When the
  //   file changed on disk and you have unsaved changes too, a bar asks which to keep; saving never
  //   overwrites a newer version without asking.
  //   One buffer per file, kept while you switch tabs (undo history included).
  import { onMount } from "svelte";
  import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, drawSelection } from "@codemirror/view";
  import { Compartment, EditorState, Text } from "@codemirror/state";
  import { bracketMatching, indentOnInput, indentUnit } from "@codemirror/language";
  import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
  import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
  import { vim, Vim } from "@replit/codemirror-vim";
  import { findReferences, formatDocument, jumpToDefinition, renameSymbol } from "@codemirror/lsp-client";
  import { lspFor, onLsp, pathOfUri, setDisplayFile } from "../lib/lsp.svelte";
  import { changeBars, changeStarts, languageFor, lineMarks, look, setHunks, toggleRemoved } from "../lib/editor";
  import { api } from "../lib/code";
  import { closeTab, dirtyFiles, openFile, S, ui } from "../lib/state.svelte";
  import type { Hunk } from "../lib/types";

  type FileData = { path: string; text: string | null; hash?: string; hunks: Hunk[] };
  let { path, data, want, boxLines, showAll, vimOn, onview, oncursor, onhover, onchanges }: {
    path: string; data: FileData | null; want: { line?: number; end?: number; at?: number };
    boxLines: [number, number][]; showAll: boolean; vimOn: boolean;
    onview: (v: [number, number]) => void; oncursor: (line: number) => void; onhover: (line: number) => void; onchanges: (n: number, at: number) => void;
  } = $props();

  // ---- buffers --------------------------------------------------------------------------
  // `before`: the version this editor last saved over, and when: a copy of it arriving in the next
  // few seconds is a late answer, not the file going back (a git checkout later still shows).
  type Buf = { state: EditorState; saved: string; hash: string; scroll: number; disk?: { text: string; hash: string }; before?: { hash: string; at: number } };
  const bufs = new Map<string, Buf>();
  let el: HTMLElement;
  let view: EditorView | null = null;
  let shown: string | null = null; // the path the view shows
  let conflict: { text: string; hash: string } | null = $state(null);
  let saving = $state(false), error = $state("");
  const vimSlot = new Compartment(), lspSlot = new Compartment();
  const wantMarks = lineMarks("cm-want"), boxMarks = lineMarks("cm-boxhl");

  // Indentation the file already uses: tabs, else its smallest common step of spaces.
  function indentOf(text: string) {
    let tabs = 0, spaces = 0; const steps = new Map<number, number>();
    for (const l of text.split("\n", 2000)) {
      if (l[0] === "\t") tabs++;
      else if (l[0] === " ") { spaces++; const n = l.length - l.trimStart().length; if (n === 2 || n === 4) steps.set(n, (steps.get(n) ?? 0) + 1); }
    }
    if (tabs > spaces) return "\t";
    return " ".repeat((steps.get(2) ?? 0) > (steps.get(4) ?? 0) / 2 && steps.has(2) ? 2 : 4);
  }

  function newState(p: string, text: string) {
    return EditorState.create({
      doc: text,
      extensions: [
        vimSlot.of(vimOn ? vim({ status: true }) : []),
        lineNumbers(), highlightActiveLineGutter(), highlightSpecialChars(), history(), drawSelection(),
        indentOnInput(), bracketMatching(), highlightActiveLine(), highlightSelectionMatches(),
        indentUnit.of(indentOf(text)), EditorState.tabSize.of(4),
        keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
        languageFor(p), lspSlot.of(lspFor(S.root, p)), look, changeBars(), wantMarks.field, boxMarks.field,
        EditorView.updateListener.of((u) => {
          if (u.docChanged) markDirty();
          if (u.selectionSet || u.docChanged) reportChanges();
          if (u.selectionSet && (u.transactions.some((t) => t.isUserEvent("select") || t.isUserEvent("input") || t.isUserEvent("delete")) || u.view.hasFocus))
            oncursor(u.state.doc.lineAt(u.state.selection.main.head).number);
          if (u.docChanged || u.viewportChanged || u.geometryChanged) reportView();
        }),
      ],
    });
  }
  // Unsaved: the text differs from the last saved one. Compared as CodeMirror texts, without
  // building the whole file as a string on every keystroke.
  let savedDoc: { path: string; saved: string; doc: Text } | null = null;
  function dirtyNow() {
    const b = shown ? bufs.get(shown) : null;
    if (!view || !b) return false;
    if (view.state.doc.length !== b.saved.length) return true;
    if (savedDoc?.path !== shown || savedDoc.saved !== b.saved) savedDoc = { path: shown!, saved: b.saved, doc: Text.of(b.saved.split("\n")) };
    return !view.state.doc.eq(savedDoc.doc);
  }
  function markDirty() {
    if (!shown) return;
    if (dirtyNow()) dirtyFiles.add(shown); else dirtyFiles.delete(shown);
  }

  // Put a new text in the buffer, touching only the part that changed, so the cursor and scroll stay.
  function replaceDoc(text: string) {
    if (!view) return;
    const old = view.state.doc.toString();
    if (old === text) return;
    let a = 0; while (a < old.length && a < text.length && old[a] === text[a]) a++;
    let b = 0; while (b < old.length - a && b < text.length - a && old[old.length - 1 - b] === text[text.length - 1 - b]) b++;
    view.dispatch({ changes: { from: a, to: old.length - b, insert: text.slice(a, text.length - b) }, annotations: [] });
  }

  // Show `p` in the view: its buffer, or a new one from `d`.
  function show(p: string, d: FileData) {
    if (!view) return;
    if (shown && bufs.has(shown)) { const b = bufs.get(shown)!; b.state = view.state; b.scroll = view.scrollDOM.scrollTop; }
    let b = bufs.get(p);
    // A buffer whose unsaved changes were thrown away (tab closed and confirmed): start again.
    if (b && b.state.doc.toString() !== b.saved && !dirtyFiles.has(p)) { bufs.delete(p); b = undefined; }
    const fresh = !b;
    if (!b) { b = { state: newState(p, d.text ?? ""), saved: d.text ?? "", hash: d.hash ?? "", scroll: 0 }; bufs.set(p, b); }
    shown = p;
    view.setState(b.state);
    connectLsp();
    conflict = b.disk ?? null;
    error = "";
    // A new buffer gets its change bars; a kept one has them already, moved along with your edits.
    if (fresh) view.dispatch({ effects: setHunks.of(d.hunks) });
    else arrived(d);
    view.dispatch({ effects: toggleRemoved.of({ all: showAll }) });
    requestAnimationFrame(() => { if (view && shown === p) { view.scrollDOM.scrollTop = b!.scroll; reportView(); } });
    if (bufs.size > 24) for (const [k] of bufs) { if (k !== p && !dirtyFiles.has(k)) { bufs.delete(k); break; } }
  }

  // The shown file's language server, once it's up (lsp.svelte.ts); a jump to another file waits
  // for that file to show.
  function connectLsp() {
    if (!view || !shown) return;
    const l = lspFor(S.root, shown);
    if (lspSlot.get(view.state) !== l) view.dispatch({ effects: lspSlot.reconfigure(l) });
    for (const ok of waiting.get(shown) ?? []) ok(view);
    waiting.delete(shown);
  }
  const waiting = new Map<string, ((v: EditorView) => void)[]>();
  onLsp(() => connectLsp());
  setDisplayFile((uri) => {
    const p = S.root ? pathOfUri(S.root, uri) : null;
    if (!p || !S.files.includes(p)) return Promise.resolve(null);
    if (p === shown && view) return Promise.resolve(view);
    return new Promise((ok) => { (waiting.get(p) ?? waiting.set(p, []).get(p)!).push(ok); openFile(p); });
  });

  // A newer version of the shown file arrived (from disk).
  function arrived(d: FileData) {
    const b = bufs.get(d.path);
    if (!view || !b || d.text == null) return;
    if (d.hash && b.before?.hash === d.hash && Date.now() - b.before.at < 5000) return; // older than your last save, arriving late
    const dirty = dirtyFiles.has(d.path);
    if (d.text === view.state.doc.toString()) { b.saved = d.text; b.hash = d.hash ?? b.hash; b.disk = undefined; conflict = null; markDirty(); }
    else if (d.text === b.saved) { b.hash = d.hash ?? b.hash; return; } // your edits stand; their bars already follow them
    else if (!dirty) { replaceDoc(d.text); b.saved = d.text; b.hash = d.hash ?? ""; markDirty(); }
    else { b.disk = { text: d.text, hash: d.hash ?? "" }; conflict = b.disk; return; }
    view.dispatch({ effects: setHunks.of(d.hunks) });
  }

  $effect(() => {
    const d = data, p = path;
    if (!view || !d || d.path !== p || d.text == null) return;
    if (shown !== p) show(p, d); else arrived(d);
  });

  // ---- saving -------------------------------------------------------------------------
  async function save(force = false): Promise<boolean> {
    if (!view || !shown) return false;
    const p = shown, b = bufs.get(p)!, text = view.state.doc.toString();
    if (!force && text === b.saved) return true;
    saving = true; error = "";
    try {
      const r = await api.post<{ ok?: boolean; hash?: string; conflict?: boolean; text?: string; error?: string }>("api/file/save", { path: p, text, hash: b.hash, force });
      if (r.error) { error = r.error; return false; }
      if (r.conflict) { b.disk = { text: r.text!, hash: r.hash! }; if (shown === p) conflict = b.disk; return false; }
      if (b.hash && b.hash !== r.hash) b.before = { hash: b.hash, at: Date.now() };
      b.saved = text; b.hash = r.hash!; b.disk = undefined;
      if (shown === p) { conflict = null; markDirty(); }
      return true;
    } catch (e) { error = String(e); return false; }
    finally { saving = false; }
  }
  // Conflict: keep yours (save over the disk version) or take the disk version (lose yours).
  async function keepMine() { const b = shown ? bufs.get(shown) : null; if (b?.disk) { b.hash = b.disk.hash; await save(true); } }
  function takeTheirs() {
    const b = shown ? bufs.get(shown) : null;
    if (!b?.disk || !view) return;
    const d = b.disk; b.disk = undefined; conflict = null;
    replaceDoc(d.text); b.saved = d.text; b.hash = d.hash; markDirty();
  }

  // vim's :w, :q, :wq, :x act on whichever editor is showing (there's one).
  const closeShown = () => { const i = ui.tabs.findIndex((t) => t.kind === "file" && t.path === shown); if (i > 0) closeTab(i); };
  // What's selected (one line, short), for the project search to start from.
  const selected = () => { const r = view?.state.selection.main; return view && r && !r.empty && r.to - r.from < 200 ? view.state.sliceDoc(r.from, r.to).split("\n")[0] : ""; };
  const api_ = { save, closeShown, jump: (d: 1 | -1) => jump(d), selected, focus: () => view?.focus() };
  if (!(window as any).__cockpitVim) {
    (window as any).__cockpitVim = true;
    const me = () => (window as any).__cockpitEditor as typeof api_;
    Vim.defineEx("write", "w", () => { me()?.save(); });
    Vim.defineEx("quit", "q", () => { me()?.closeShown(); });
    Vim.defineEx("wq", "wq", async () => { if (await me()?.save()) me()?.closeShown(); });
    Vim.defineEx("xit", "x", async () => { if (await me()?.save()) me()?.closeShown(); });
    // ]c and [c: next and previous change, as in vim's diff mode.
    Vim.defineAction("nextChange", () => { me()?.jump(1); });
    Vim.defineAction("prevChange", () => { me()?.jump(-1); });
    Vim.mapCommand("]c", "action", "nextChange", {}, { context: "normal" });
    Vim.mapCommand("[c", "action", "prevChange", {}, { context: "normal" });
    // The language server, from vim: gd definition, gr references, <Space>rn rename, <Space>f format.
    Vim.defineAction("lspDefinition", (cm: any) => { jumpToDefinition(cm.cm6); });
    Vim.defineAction("lspReferences", (cm: any) => { findReferences(cm.cm6); });
    Vim.defineAction("lspRename", (cm: any) => { renameSymbol(cm.cm6); });
    Vim.defineAction("lspFormat", (cm: any) => { formatDocument(cm.cm6); });
    Vim.mapCommand("gd", "action", "lspDefinition", {}, { context: "normal" });
    Vim.mapCommand("gr", "action", "lspReferences", {}, { context: "normal" });
    Vim.mapCommand("<Space>rn", "action", "lspRename", {}, { context: "normal" });
    Vim.mapCommand("<Space>f", "action", "lspFormat", {}, { context: "normal" });
  }

  // Vim keys on or off (the header's "vim" button): every buffer follows.
  let vimWas: boolean | null = null;
  $effect(() => {
    const on = vimOn;
    if (vimWas === null || vimWas === on) { vimWas = on; return; }
    vimWas = on;
    const ext = () => (on ? vim({ status: true }) : []);
    view?.dispatch({ effects: vimSlot.reconfigure(ext()) });
    for (const [k, b] of bufs) if (k !== shown) b.state = b.state.update({ effects: vimSlot.reconfigure(ext()) }).state;
    view?.focus();
  });
  export const isSaving = () => saving;
  export function saveNow() { return save(); }

  // How many changes, and which one the cursor is on (the last one starting at or above it; 0 above all).
  function reportChanges() {
    if (!view) return;
    const doc = view.state.doc, cur = doc.lineAt(view.state.selection.main.head).number;
    const starts = changeStarts(view).map((s) => doc.lineAt(s).number);
    let at = 0;
    starts.forEach((n, i) => { if (n <= cur) at = i + 1; });
    onchanges(starts.length, at);
  }

  // ---- what the rest of the page sees: lines on screen, the line you're on, the changes ---------
  let raf = 0, lastView: [number, number] = [0, 0];
  function reportView() {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      if (!view) return;
      const top = view.scrollDOM.scrollTop, h = view.scrollDOM.clientHeight, doc = view.state.doc;
      const lo = doc.lineAt(view.lineBlockAtHeight(top).from).number, hi = doc.lineAt(view.lineBlockAtHeight(top + h - 1).from).number;
      if (lo !== lastView[0] || hi !== lastView[1]) { lastView = [lo, hi]; onview([lo, hi]); }
      reportChanges();
    });
  }
  // The next or previous change from the cursor, wrapping around at the ends; the cursor goes there.
  export function jump(dir: 1 | -1) {
    if (!view) return;
    const doc = view.state.doc, line = doc.lineAt(view.state.selection.main.head);
    const starts = changeStarts(view).map((s) => doc.lineAt(s).number);
    if (!starts.length) return;
    const to = dir > 0 ? starts.find((n) => n > line.number) ?? starts[0] : [...starts].reverse().find((n) => n < line.number) ?? starts.at(-1)!;
    const pos = doc.line(to).from;
    view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "center" }), userEvent: "select" });
    view.focus();
  }
  export function scrollToLine(n: number) {
    if (!view) return;
    const pos = view.state.doc.line(Math.max(1, Math.min(n, view.state.doc.lines))).from;
    view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: "center" }) });
  }

  // Asked-for lines: highlighted, scrolled to, the cursor put there.
  let placed = "";
  $effect(() => {
    const w = want, p = path, ready = !!data && data.path === p;
    if (!view || !ready || shown !== p) return;
    const key = p + ":" + (w.line ?? "") + ":" + (w.at ?? "");
    if (placed === key) return;
    placed = key;
    view.dispatch({ effects: wantMarks.set.of(w.line ? [[w.line, w.end ?? w.line]] : []) });
    if (w.line) {
      const pos = view.state.doc.line(Math.min(w.line, view.state.doc.lines)).from;
      view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "center" }) });
    }
  });
  $effect(() => { const ls = boxLines; view?.dispatch({ effects: boxMarks.set.of(ls) }); });
  $effect(() => { const all = showAll; view?.dispatch({ effects: toggleRemoved.of({ all }) }); });

  // The line under the mouse, for the floating diagram.
  // Scrolling moves the lines under a still mouse, and WebKit sends a mousemove for that: those
  // are skipped (same pointer position), and a scroll drops the hovered line, so the diagram shows
  // the cursor's box instead of hopping between boxes (and fading their highlights) every frame.
  let hoverLine = 0, lastX = -1, lastY = -1;
  function hover(e: MouseEvent) {
    if (!view || (e.clientX === lastX && e.clientY === lastY)) return;
    lastX = e.clientX; lastY = e.clientY;
    const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
    const n = pos == null ? 0 : view.state.doc.lineAt(pos).number;
    if (n !== hoverLine) { hoverLine = n; dispatchHover(n); }
  }
  const dispatchHover = (n: number) => onhover(n);

  onMount(() => {
    view = new EditorView({ parent: el, state: EditorState.create({ doc: "" }) });
    (window as any).__cockpitEditor = api_;
    view.scrollDOM.addEventListener("scroll", () => { if (hoverLine) { hoverLine = 0; dispatchHover(0); } reportView(); }, { passive: true });
    if (data && data.path === path && data.text != null) show(path, data);
    return () => { view?.destroy(); view = null; if ((window as any).__cockpitEditor === api_) (window as any).__cockpitEditor = null; };
  });

  // Leaving the page with unsaved changes asks first.
  const leave = (e: BeforeUnloadEvent) => { if (dirtyFiles.size) { e.preventDefault(); e.returnValue = ""; } };
</script>

<svelte:window onbeforeunload={leave} />

{#if conflict}
  <div class="econflict">
    <span><b>Changed on disk</b> while you have unsaved changes here (an agent, or another editor).</span>
    <button onclick={keepMine} title="Save your version over the one on disk">keep mine</button>
    <button onclick={takeTheirs} title="Load the version on disk; your unsaved changes are lost">take the disk version</button>
  </div>
{/if}
{#if error}<div class="econflict bad">{error}</div>{/if}
<div class="editor" bind:this={el} onmousemove={hover} onmouseleave={() => { hoverLine = 0; dispatchHover(0); }} role="presentation"></div>
