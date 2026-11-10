<script lang="ts">
  import { closeTab, saveTabs, statusOf, ui } from "../lib/state.svelte";

  let bar: HTMLElement;
  const pick = (i: number) => { ui.active = i; ui.picked = null; saveTabs(); };
  // Keep the active tab in view.
  $effect(() => { void ui.active; void ui.tabs.length; queueMicrotask(() => bar?.querySelector(".on")?.scrollIntoView({ block: "nearest", inline: "nearest" })); });
</script>

<div id="tabbar" bind:this={bar}>
  {#each ui.tabs as t, i (t.kind === "map" ? "map" : t.kind === "file" ? "f:" + t.path : "c:" + t.sha)}
    {#if t.kind === "map"}
      <button class="maptab" class:on={i === ui.active} title="The map: the agents’ diagrams" onclick={() => pick(i)}>◇</button>
    {:else}
      {@const st = t.kind === "file" ? statusOf(t.path) : null}
      <div class="ctab" class:on={i === ui.active} title={t.kind === "file" ? t.path : "commit " + t.sha} role="tab" tabindex="0" aria-selected={i === ui.active}
        onclick={() => pick(i)} onauxclick={(e) => e.button === 1 && closeTab(i)} onkeydown={(e) => e.key === "Enter" && pick(i)}>
        {#if t.kind === "file"}{t.path.split("/").pop()}{:else}<span class="ti">●</span>{t.sha}{/if}
        {#if st}<span class="mark {st}">{st}</span>{/if}
        <button class="tx" title="Close" onclick={(e) => { e.stopPropagation(); closeTab(i); }}>×</button>
      </div>
    {/if}
  {/each}
</div>
