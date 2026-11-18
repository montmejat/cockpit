<script lang="ts">
  import { closeTab, dirtyFiles, fkey, P, pickTab, projectNames, statusOf, tabKey, tabProject, ui } from "../lib/state.svelte";

  let bar: HTMLElement;
  // A tab of another project of the workspace switches the window to it (lib/state, setActive).
  const pick = (i: number) => { void pickTab(i); };
  const other = (t: (typeof ui.tabs)[number]) => projectNames.length > 1 && t.kind !== "map" && tabProject(t) !== P.active;
  // Keep the active tab in view.
  $effect(() => { void ui.active; void ui.tabs.length; queueMicrotask(() => bar?.querySelector(".on")?.scrollIntoView({ block: "nearest", inline: "nearest" })); });
</script>

<div id="tabbar" bind:this={bar}>
  {#each ui.tabs as t, i (tabKey(t))}
    {#if t.kind === "map"}
      <button class="maptab" class:on={i === ui.active} title="The map: the agents’ diagrams" onclick={() => pick(i)}>◇</button>
    {:else}
      {@const st = t.kind === "file" && !other(t) ? statusOf(t.path) : null}
      <div class="ctab" class:on={i === ui.active} class:other={other(t)} title={(projectNames.length > 1 ? tabProject(t) + ": " : "") + (t.kind === "file" ? t.path : t.kind === "diff" ? (t.staged ? "staged changes in " : "changes in ") + t.path : "commit " + t.sha)} role="tab" tabindex="0" aria-selected={i === ui.active}
        onclick={() => pick(i)} onauxclick={(e) => e.button === 1 && closeTab(i)} onkeydown={(e) => e.key === "Enter" && pick(i)}>
        {#if other(t)}<span class="tproj">{tabProject(t)}/</span>{/if}
        {#if t.kind === "file"}{t.path.split("/").pop()}{:else if t.kind === "diff"}<span class="ti" title={t.staged ? "staged" : "not staged"}>Δ</span>{t.path.split("/").pop()}{#if t.staged}<span class="muted tstaged">staged</span>{/if}{:else}<span class="ti">●</span>{t.sha}{/if}
        {#if st}<span class="mark {st}">{st}</span>{/if}
        {#if t.kind === "file" && dirtyFiles.has(fkey(tabProject(t), t.path))}<span class="unsaved" title="Unsaved changes">●</span>{/if}
        <button class="tx" title="Close" onclick={(e) => { e.stopPropagation(); closeTab(i); }}>×</button>
      </div>
    {/if}
  {/each}
</div>
