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
  import Chat from "./components/Chat.svelte";
  import Inspector from "./components/Inspector.svelte";
  import { byId, openCommit, openDiagram, openFile, showRight, ui, cur, mapTab, S, saveTabs } from "./lib/state.svelte";

  let unread = $state(false);
  let term: Terminal;

  // Links can open a tab directly: ?tab=git, ?panel=features|tests, ?file=path[&line=n],
  // ?commit=sha, ?at=diagram[&box=node], or the hash the page keeps (#f=path, #c=sha, #diagram).
  const Q = new URLSearchParams(location.search), H = decodeURIComponent(location.hash.slice(1));
  if (Q.get("tab") === "git" || Q.get("tab") === "files") ui.side = Q.get("tab") as "git" | "files";
  if (Q.get("panel") === "features" || Q.get("panel") === "tests") { ui.insp = Q.get("panel") as "features" | "tests"; showRight("details"); }
  if (Q.get("file") || Q.get("diff")) openFile((Q.get("file") || Q.get("diff"))!, Q.get("line") ? +Q.get("line")! : undefined);
  else if (Q.get("commit")) openCommit(Q.get("commit")!);
  else if (H.startsWith("f=")) openFile(H.slice(2));
  else if (H.startsWith("c=")) openCommit(H.slice(2));
  else if (byId(Q.get("at"))) { openDiagram(Q.get("at")!); mapTab().code = Q.get("box") || null; }
  else if (byId(H)) openDiagram(H);

  // The address follows what's open, so a reload comes back to it.
  $effect(() => {
    const t = cur();
    const hash = t.kind === "map" ? (t.id ?? "") : t.kind === "file" ? "f=" + t.path : "c=" + t.sha;
    history.replaceState(null, "", location.pathname + (hash ? "#" + encodeURIComponent(hash) : ""));
  });
  // A diagram that disappeared from .cockpit/: the map goes back home.
  $effect(() => { const t = mapTab(); if (S.diagrams.length && !byId(t.id)) { t.id = S.diagrams.find((d) => d.kind === "loop")?.id ?? S.diagrams[0].id; t.code = null; saveTabs(); } });

  // Ctrl+` toggles the terminal drawer, Ctrl+K opens the ask line, anywhere.
  function keys(e: KeyboardEvent) {
    if (e.ctrlKey && !e.altKey && !e.metaKey && (e.code === "Backquote" || e.key === "`")) { e.preventDefault(); e.stopPropagation(); term?.toggle(); }
    else if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === "k" || e.key === "K") && !(e.target as HTMLElement).closest?.("input,textarea,.xterm")) { e.preventDefault(); term?.openAsk(); }
  }
</script>

<svelte:window onkeydowncapture={keys} />

<Header ontoggleterm={() => term?.toggle()} />
<main>
  <Sidebar />
  <section id="center">
    <TabBar />
    <div id="work">
      <MapView hidden={cur().kind !== "map"} />
      {#if cur().kind !== "map"}<CodeView />{/if}
    </div>
    <Terminal bind:this={term} />
  </section>
  <aside id="right">
    <div class="rtabs">
      <button class:on={ui.rtab === "chat"} onclick={() => { showRight("chat"); unread = false; }}>chat{#if unread}<span class="unread"></span>{/if}</button>
      <button class:on={ui.rtab === "details"} onclick={() => showRight("details")}>details</button>
    </div>
    <Chat hidden={ui.rtab !== "chat"} onactivity={(ask) => { if (ask) showRight("chat"); else if (ui.rtab !== "chat") unread = true; }} />
    {#if ui.rtab === "details"}<Inspector />{/if}
  </aside>
</main>
