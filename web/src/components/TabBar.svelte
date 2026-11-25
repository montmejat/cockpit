<script lang="ts">
  import { closeTab, dirtyFiles, saveTabs, statusOf, tabKey, ui } from "../lib/state.svelte";
  import Tab from "./ui/Tab.svelte";

  let bar: HTMLElement;
  const pick = (i: number) => { ui.home = false; ui.active = i; ui.picked = null; saveTabs(); };
  // Keep the active tab in view.
  $effect(() => { void ui.active; void ui.tabs.length; queueMicrotask(() => bar?.querySelector(".on")?.scrollIntoView({ block: "nearest", inline: "nearest" })); });
</script>

<div id="tabbar" class="segs" bind:this={bar}>
  <Tab class="maptab" on={ui.home} title="Home" label="Home" onselect={() => (ui.home = true)}>
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M2.5 7.5 8 3l5.5 4.5M4 6.5v6.25c0 .4.3.75.75.75h2.5v-3.5h1.5v3.5h2.5c.4 0 .75-.35.75-.75V6.5" /></svg>
  </Tab>
  {#each ui.tabs as t, i (tabKey(t))}
    {#if t.kind === "map"}
      <Tab class="maptab" on={!ui.home && i === ui.active} title="The map: the agents’ diagrams" label="Map" onselect={() => pick(i)}>
        <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><rect x="1.75" y="2.25" width="5" height="3.5" rx="1" /><rect x="9.25" y="2.25" width="5" height="3.5" rx="1" /><rect x="5.5" y="10.25" width="5" height="3.5" rx="1" /><path d="M4.25 5.75v1.5a1 1 0 0 0 1 1h5.5a1 1 0 0 0 1-1v-1.5M8 8.25v2" /></svg>
      </Tab>
    {:else}
      {@const st = t.kind === "file" ? statusOf(t.path) : null}
      <Tab class="ctab" on={!ui.home && i === ui.active} title={t.kind === "guardrails" ? "Guardrails: what keeps the agents' work right" : t.kind === "file" ? t.path : t.kind === "diff" ? (t.staged ? "staged changes in " : "changes in ") + t.path : "commit " + t.sha}
        onselect={() => pick(i)} onclose={() => closeTab(i)}>
        {#if t.kind === "guardrails"}<svg class="ti" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M8 1.75l5 2v4c0 3-2.2 5.3-5 6.5-2.8-1.2-5-3.5-5-6.5v-4z" /></svg>guardrails{:else if t.kind === "file"}{t.path.split("/").pop()}{:else if t.kind === "diff"}<span class="ti" title={t.staged ? "staged" : "not staged"}>Δ</span>{t.path.split("/").pop()}{#if t.staged}<span class="muted tstaged">staged</span>{/if}{:else}<span class="ti">●</span>{t.sha}{/if}
        {#if st}<span class="mark {st}">{st}</span>{/if}
        {#if t.kind === "file" && dirtyFiles.has(t.path)}<span class="unsaved" title="Unsaved changes">●</span>{/if}
      </Tab>
    {/if}
  {/each}
</div>
