<script lang="ts">
  // cockpit, one view: files and git on the side; the map, files and commits as tabs in the
  // center, like an editor; the right panel holds the agent chat and the details of what's open;
  // terminals in a drawer under the center. What is changing right now (uncommitted edits, a
  // running agent) shows on all of it.
  import Header from "./components/Header.svelte";
  import Sidebar from "./components/Sidebar.svelte";
  import TabBar from "./components/TabBar.svelte";
  import MapView from "./components/MapView.svelte";
  import CodeView from "./components/CodeView.svelte";
  import Terminal from "./components/Terminal.svelte";
  import Palette from "./components/Palette.svelte";
  import Chat from "./components/Chat.svelte";
  import Inspector from "./components/Inspector.svelte";
  import Guardrails from "./components/Guardrails.svelte";
  import { byId, openCommit, openDiagram, openFile, openGuardrails, showRight, ui, cur, mapTab, S, saveTabs, toggleChat, toggleHelp } from "./lib/state.svelte";
  import Grip, { savedWidth } from "./components/Grip.svelte";
  import { api } from "./lib/code";

  let unread = $state(false);
  let rightWidth = $state(savedWidth("cockpit-right-width", 390, 280));
  let term: Terminal;
  let palette: Palette;

  // Links can open a tab directly: ?tab=git, ?panel=features|tests, ?file=path[&line=n],
  // ?commit=sha, ?at=diagram[&box=node], or the hash the page keeps (#f=path, #c=sha, #diagram).
  const Q = new URLSearchParams(location.search), H = decodeURIComponent(location.hash.slice(1));
  if (Q.get("tab") === "git" || Q.get("tab") === "files") ui.side = Q.get("tab") as "git" | "files";
  if (Q.get("panel") === "features" || Q.get("panel") === "tests") { ui.insp = Q.get("panel") as "features" | "tests"; showRight("details"); }
  if (Q.get("file") || Q.get("diff")) openFile((Q.get("file") || Q.get("diff"))!, Q.get("line") ? +Q.get("line")! : undefined);
  else if (Q.get("commit")) openCommit(Q.get("commit")!);
  else if (H.startsWith("f=")) openFile(H.slice(2));
  else if (H.startsWith("c=")) openCommit(H.slice(2));
  else if (Q.get("tab") === "guardrails" || H === "guardrails") openGuardrails();
  else if (byId(Q.get("at"))) { openDiagram(Q.get("at")!); mapTab().code = Q.get("box") || null; }
  else if (byId(H)) openDiagram(H);

  // The address follows what's open, so a reload comes back to it.
  $effect(() => {
    const t = cur();
    const hash = t.kind === "map" ? (t.id ?? "") : t.kind === "guardrails" ? "guardrails" : t.kind === "file" || t.kind === "diff" ? "f=" + t.path : "c=" + t.sha;
    history.replaceState(null, "", location.pathname + (hash ? "#" + encodeURIComponent(hash) : ""));
  });
  // A diagram that disappeared from .cockpit/: the map goes back home.
  $effect(() => { const t = mapTab(); if (S.diagrams.length && !byId(t.id)) { t.id = S.diagrams.find((d) => d.kind === "loop")?.id ?? S.diagrams[0].id; t.code = null; saveTabs(); } });

  // Ctrl+` goes to the terminal drawer and Ctrl+L to the chat (opening it; pressed again from
  // inside, closing it), Ctrl+K opens the ask line, F1 shows or hides the hints, anywhere.
  function keys(e: KeyboardEvent) {
    const inEditor = !!(e.target as HTMLElement).closest?.(".cm-editor");
    // Ctrl+S saves the open file (and never opens the browser's "save page").
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "s") { e.preventDefault(); e.stopPropagation(); (window as any).__cockpitEditor?.save(); return; }
    if (e.ctrlKey && !e.altKey && !e.metaKey && (e.code === "Backquote" || e.key === "`")) { e.preventDefault(); e.stopPropagation(); term?.toggle(); }
    else if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === "l") { e.preventDefault(); toggleChat(); unread = false; }
    else if (e.key === "F1" && !e.ctrlKey && !e.altKey && !e.metaKey) { e.preventDefault(); toggleHelp(); }
    // In the desktop app there is no browser menu: Ctrl+R / F5 reload the page.
    // (Not in the editor, where Ctrl+R is vim's redo.)
    else if (window.cockpitDesktop && (e.key === "F5" || ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "r" && !inEditor))) { e.preventDefault(); location.reload(); }
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
    <div class="rtabs">
      <button class:on={ui.rtab === "chat"} onclick={() => { showRight("chat"); unread = false; }}>chat{#if unread}<span class="unread"></span>{/if}</button>
      <button class:on={ui.rtab === "details"} onclick={() => showRight("details")}>details</button>
    </div>
    <Chat hidden={ui.rtab !== "chat"} onactivity={(ask) => { if (ask) showRight("chat"); else if (ui.rtab !== "chat" || !ui.right) unread = true; }} />
    {#if ui.rtab === "details"}<Inspector />{/if}
  </aside>
</main>
