<script lang="ts">
  import FileTree from "./FileTree.svelte";
  import GitPane from "./GitPane.svelte";
  import Grip, { savedWidth } from "./Grip.svelte";
  import { collapseAll, P, projectNames, S, setActive, store, ui } from "../lib/state.svelte";

  $effect(() => store.set("cockpit-tab", ui.side));

  // Its width: drag the right edge (kept between visits), double-click the edge for the default.
  let width = $state(savedWidth("cockpit-side-width", 280));
  // Every folder in the tree, for "collapse all".
  const dirs = $derived.by(() => {
    const out = new Set<string>();
    for (const p of S.files) { const parts = p.split("/"); for (let i = 1; i < parts.length; i++) out.add(parts.slice(0, i).join("/") + "/"); }
    return [...out];
  });
</script>

<nav id="side" style:width="{width}px">
  <Grip bind:width def={280} key="cockpit-side-width" edge="right" />
  <!-- the workspace's projects (src/serve.ts hosts them all): one click shows another one -->
  {#if projectNames.length > 1}
    <div class="projects" role="tablist" aria-label="Projects of the workspace">
      {#each projectNames as name (name)}
        <button class:on={name === P.active} role="tab" aria-selected={name === P.active} title="Show {name} in this window" onclick={() => setActive(name)}>{name}</button>
      {/each}
    </div>
  {/if}
  <div class="tabs">
    <button class:on={ui.side === "files"} onclick={() => (ui.side = "files")}>files</button>
    <button class:on={ui.side === "git"} onclick={() => (ui.side = "git")}>git</button>
  </div>
  {#if ui.side === "files"}
    <div class="sidetools">
      <span class="muted">{S.files.length} files</span>
      <span class="grow"></span>
      <button class="icon" title="Collapse all folders" onclick={() => collapseAll(dirs)}>⊟ collapse</button>
    </div>
  {/if}
  <div id="sidebody">
    {#if ui.side === "files"}<FileTree />{:else}<GitPane />{/if}
  </div>
</nav>
