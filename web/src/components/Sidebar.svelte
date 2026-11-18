<script lang="ts">
  // The side panel: files and git. In a workspace (src/serve.ts hosts all its projects) the strip
  // on top shows which project the window follows (map, git, chat, terminals) and switches it, and
  // the files tree holds every project, each under a root you open and close, like an editor's
  // multi-root workspace: a file opens in its own project.
  import FileTree from "./FileTree.svelte";
  import GitPane from "./GitPane.svelte";
  import Grip, { savedWidth } from "./Grip.svelte";
  import { collapseAll, liveOf, loaded, P, plural, projectNames, roots, S, setActive, setRoot, store, ui } from "../lib/state.svelte";

  $effect(() => store.set("cockpit-tab", ui.side));
  const multi = projectNames.length > 1;

  // Its width: drag the right edge (kept between visits), double-click the edge for the default.
  let width = $state(savedWidth("cockpit-side-width", 280));
  // Every folder of a project's tree, for "collapse all".
  const dirsOf = (files: string[]) => {
    const out = new Set<string>();
    for (const p of files) { const parts = p.split("/"); for (let i = 1; i < parts.length; i++) out.add(parts.slice(0, i).join("/") + "/"); }
    return [...out];
  };
  function collapse() { for (const name of projectNames) if (loaded.has(name)) collapseAll(name, dirsOf(liveOf(name).files ?? [])); }
  const fileCount = $derived(multi ? projectNames.reduce((n, p) => n + (loaded.has(p) && roots[p] ? liveOf(p).files?.length ?? 0 : 0), 0) : S.files.length);
</script>

<nav id="side" style:width="{width}px">
  <Grip bind:width def={280} key="cockpit-side-width" edge="right" />
  {#if multi}
    <div class="projects" role="tablist" aria-label="Projects of the workspace">
      {#each projectNames as name (name)}
        <button class:on={name === P.active} role="tab" aria-selected={name === P.active} title="Show {name} in this window: its map, git, chat and terminals" onclick={() => setActive(name)}>{name}</button>
      {/each}
    </div>
  {/if}
  <div class="tabs">
    <button class:on={ui.side === "files"} onclick={() => (ui.side = "files")}>files</button>
    <button class:on={ui.side === "git"} onclick={() => (ui.side = "git")}>git{#if multi}<span class="muted"> · {P.active}</span>{/if}</button>
  </div>
  {#if ui.side === "files"}
    <div class="sidetools">
      <span class="muted">{fileCount} files</span>
      <span class="grow"></span>
      <button class="icon" title="Collapse all folders" onclick={collapse}>⊟ collapse</button>
    </div>
  {/if}
  <div id="sidebody">
    {#if ui.side === "git"}<GitPane />
    {:else if !multi}<FileTree project={P.active} />
    {:else}
      {#each projectNames as name (name)}
        {@const L = liveOf(name)}
        {@const open = !!roots[name]}
        {@const changed = loaded.has(name) ? L.status?.length ?? 0 : 0}
        <button class="root" class:here={name === P.active} aria-expanded={open} title={open ? `Close ${name}` : `Open ${name}'s files`} onclick={() => setRoot(name, !open)}>
          <span class="chev">{open ? "▾" : "▸"}</span><span class="rname">{name}</span>
          {#if loaded.has(name) && L.live}<span class="agentdot" title="an agent is working in {name}">◉</span>{/if}
          {#if changed}<span class="muted rchg" title="{plural(changed, 'uncommitted file')}">{changed}</span>{/if}
        </button>
        {#if open}
          <div class="rbody">{#if loaded.has(name)}<FileTree project={name} />{:else}<p class="muted rload">loading…</p>{/if}</div>
        {/if}
      {/each}
    {/if}
  </div>
</nav>
