<script lang="ts">
  // cockpit, one view: files and git on the side; the map, files and commits as tabs in the
  // center, like an editor; the right panel holds the agent chat (the details of a box are a card on the map);
  // terminals in a drawer under the center. What is changing right now (uncommitted edits, a
  // running agent) shows on all of it.
  import Header from "./components/Header.svelte";
  import Sidebar from "./components/Sidebar.svelte";
  import TabBar from "./components/TabBar.svelte";
  import MapView from "./components/MapView.svelte";
  import CodeView from "./components/CodeView.svelte";
  import Terminal from "./components/Terminal.svelte";
  import Palette from "./components/Palette.svelte";
  import Confirm from "./components/ui/Confirm.svelte";
  import Chats from "./components/Chats.svelte";
  import Guardrails from "./components/Guardrails.svelte";
  import { byId, homeOf, M, openCommit, openDiagram, openFile, openGuardrails, showChat, showProject, ui, cur, mapTab, saveTabs, toggleChat, toggleHelp } from "./lib/state.svelte";
  import { projects } from "./lib/projects.svelte";
  import Grip, { savedWidth } from "./components/Grip.svelte";
  import { api } from "./lib/code";
  import { tick } from "svelte";

  let rightWidth = $state(savedWidth("cockpit-right-width", 390, 280));
  let term: Terminal;
  let palette: Palette;

  // Links can open a tab directly: ?tab=git, ?panel=features|tests, ?file=path[&line=n],
  // ?commit=sha, ?at=diagram[&box=node], or the hash the page keeps (#f=path, #c=sha, #diagram).
  const Q = new URLSearchParams(location.search), H = decodeURIComponent(location.hash.slice(1));
  if (Q.get("tab") === "git" || Q.get("tab") === "files" || Q.get("tab") === "project") ui.side = Q.get("tab") as "git" | "files" | "project";
  if (Q.get("panel") === "features" || Q.get("panel") === "tests") showProject(Q.get("panel") as "features" | "tests");
  if (Q.get("file") || Q.get("diff")) openFile((Q.get("file") || Q.get("diff"))!, Q.get("line") ? +Q.get("line")! : undefined);
  else if (Q.get("commit")) openCommit(Q.get("commit")!);
  else if (H.startsWith("f=")) openFile(H.slice(2));
  else if (H.startsWith("c=")) openCommit(H.slice(2));
  else if (Q.get("tab") === "guardrails" || H === "guardrails") openGuardrails();
  else if (byId(Q.get("at"))) { openDiagram(Q.get("at")!); mapTab().code = Q.get("box") || null; }
  else if (/^[^:=]+:./.test(H) && projects.some((p) => !p.here && p.name === H.split(":")[0])) openDiagram(H.slice(H.indexOf(":") + 1), undefined, H.split(":")[0]); // another project's (its diagrams arrive once its server answers)
  else if (byId(H)) openDiagram(H);

  // The address follows what's open, so a reload comes back to it.
  $effect(() => {
    const t = cur();
    const hash = t.kind === "map" ? (t.project ? t.project + ":" : "") + (t.id ?? "") : t.kind === "guardrails" ? "guardrails" : t.kind === "file" || t.kind === "diff" ? "f=" + t.path : "c=" + t.sha;
    history.replaceState(null, "", location.pathname + (hash ? "#" + encodeURIComponent(hash) : ""));
  });
  // A diagram that disappeared from .cockpit/: the map goes back home.
  $effect(() => { const t = mapTab(); if (M.diagrams.length && !byId(t.id)) { t.id = homeOf(M); t.code = null; saveTabs(); } });

  // Ctrl+` goes to the terminal drawer (Ctrl+Shift+` opens another shell) and Ctrl+L to the chat (opening it; pressed again from
  // inside, closing it), Ctrl+K opens the ask line, F1 shows or hides the hints, anywhere.
  // Focus the open file's editor; from another tab, go back to the last file tab first.
  async function focusEditor() {
    if (ui.tabs[ui.active]?.kind !== "file") {
      const i = ui.tabs.findLastIndex((t) => t.kind === "file");
      if (i < 0) return;
      ui.active = i; ui.picked = null; saveTabs();
      await tick();
    }
    (window as any).__cockpitEditor?.focus();
  }

  function keys(e: KeyboardEvent) {
    const inEditor = !!(e.target as HTMLElement).closest?.(".cm-editor");
    // Ctrl+S saves the open file (and never opens the browser's "save page").
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "s") { e.preventDefault(); e.stopPropagation(); (window as any).__cockpitEditor?.save(); return; }
    if (e.ctrlKey && !e.altKey && !e.metaKey && (e.code === "Backquote" || e.key === "`")) { e.preventDefault(); e.stopPropagation(); if (e.shiftKey) term?.another(); else term?.toggle(); }
    // From the terminal, Ctrl+L also takes the selection, or else the last command and its output, to the chat.
    else if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === "l") { e.preventDefault(); if ((e.target as HTMLElement).closest?.("#term")) term?.toChat(); toggleChat(); }
    else if (e.key === "F1" && !e.ctrlKey && !e.altKey && !e.metaKey) { e.preventDefault(); toggleHelp(); }
    // Ctrl+1, as in VS Code: back to the editor (by key position, so it works on AZERTY too).
    else if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.code === "Digit1") { e.preventDefault(); e.stopPropagation(); focusEditor(); }
    // In the desktop app there is no browser menu: Ctrl+R / F5 reload the page.
    // (Not in the editor, where Ctrl+R is vim's redo, nor in the terminal, where it searches the shell's history.)
    else if (window.cockpitDesktop && (e.key === "F5" || ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "r" && !inEditor && !(e.target as HTMLElement).closest?.("#term")))) { e.preventDefault(); location.reload(); }
    // Ctrl+P opens a file by name, Ctrl+Shift+F searches the project.
    else if (e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && e.key.toLowerCase() === "p") { e.preventDefault(); e.stopPropagation(); palette?.open("files"); }
    else if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === "f") { e.preventDefault(); e.stopPropagation(); palette?.open("search"); }
    else if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === "k" || e.key === "K") && !inEditor && !(e.target as HTMLElement).closest?.("input,textarea,.xterm")) { e.preventDefault(); term?.openAsk(); }
  }

  // Web links (in the chat, the details) open in your browser. A plain browser tab does that by
  // itself; the desktop app's window can't, so the server opens them.
  function outLink(e: MouseEvent) {
    if (!window.cockpitDesktop || (e.type === "auxclick" && e.button !== 1)) return;
    const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (!a || !/^https?:$/.test(a.protocol) || a.origin === location.origin) return;
    e.preventDefault();
    api.post("api/open-url", { url: a.href }).catch(() => {});
  }
</script>

<svelte:window onkeydowncapture={keys} onclickcapture={outLink} onauxclickcapture={outLink} />

<Palette bind:this={palette} />
<Confirm />
<Header ontoggleterm={() => term?.toggle(true)} />
<main>
  <Sidebar />
  <section id="center">
    <TabBar />
    <div id="work">
      <MapView hidden={cur().kind !== "map"} />
      {#if cur().kind === "guardrails"}<Guardrails />{:else if cur().kind !== "map"}<CodeView />{/if}
    </div>
    <Terminal bind:this={term} />
  </section>
  <!-- kept mounted when closed, so the chat keeps following the agent -->
  <aside id="right" class:hide={!ui.right} style:width="{rightWidth}px">
    <Grip bind:width={rightWidth} def={390} key="cockpit-right-width" edge="left" min={280} />
    <Chats hidden={!ui.right} onactivity={(ask) => { if (ask) showChat(); }} />
  </aside>
</main>
