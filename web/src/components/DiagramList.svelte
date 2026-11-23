<script lang="ts">
  // Every diagram, as a small tree over the map: the ones no other diagram zooms into at the top
  // (the branch that reaches the main loop first), each followed by the diagrams its boxes zoom
  // into, with how many of its boxes have uncommitted changes. In a workspace, a section per
  // project (projects.svelte.ts), like the git tab's. Click one to go there; Esc, the ☰ button or a
  // click elsewhere closes it.
  import type { Diagram } from "../lib/types";
  import { diagramChanges, homeOf, M, mp, nameOf, reviewCount, tldr } from "../lib/state.svelte";
  import { many, projects } from "../lib/projects.svelte";

  let { current, onpick, onclose }: { current: string | null; onpick: (id: string, project: string) => void; onclose: () => void } = $props();

  function rowsOf(all: Diagram[]) {
    const byId = (id: string) => all.find((d) => d.id === id);
    const childrenOf = (d: Diagram) => [...new Set(d.nodes.map((n) => n.detail).filter((id): id is string => !!id && id !== d.id && !!byId(id)))];
    const isChild = new Set(all.flatMap(childrenOf));
    const home = homeOf({ diagrams: all });
    const reaches = (d: Diagram, seen = new Set<string>()): boolean =>
      d.id === home || (!seen.has(d.id) && (seen.add(d.id), childrenOf(d).some((c) => reaches(byId(c)!, seen))));
    const roots = all.filter((d) => !isChild.has(d.id)).sort((a, b) => +reaches(b) - +reaches(a));
    const out: { d: Diagram; depth: number }[] = [], shown = new Set<string>();
    const walk = (d: Diagram, depth: number) => {
      if (shown.has(d.id)) return;
      shown.add(d.id); out.push({ d, depth });
      for (const c of childrenOf(d)) walk(byId(c)!, depth + 1);
    };
    for (const d of roots) walk(d, 0);
    for (const d of all) walk(d, 0); // diagrams in a cycle with no root
    return out;
  }
  const sections = $derived(projects.map((p) => ({ name: p.name, rows: rowsOf(p.L.diagrams), loading: !p.L.project })));

  let el: HTMLElement;
  function outside(e: PointerEvent) {
    const t = e.target as HTMLElement;
    if (el && !el.contains(t) && !t.closest?.(".dtoggle")) onclose();
  }
</script>

<svelte:window onpointerdown={outside} />

<div id="dlist" bind:this={el}>
  {#each sections as sec (sec.name)}
    {@const mine = sec.name === mp().name}
    {#if many}<div class="dsec">{sec.name}</div>{/if}
    {#each sec.rows as { d, depth } (d.id)}
      <!-- what changed is known for the project on the map -->
      <button class:on={mine && d.id === current} style:padding-left="{(many ? 16 : 10) + depth * 12}px" title={d.question + (tldr(d, d.answer) ? "\n" + tldr(d, d.answer) : "")} onclick={() => onpick(d.id, sec.name)}>{nameOf(d)}{#if mine}{#if M.review?.diagrams[d.id]?.isNew}<span class="rn">new</span>{:else if reviewCount(d)}<span class="rc" title="boxes changed in this review">◆ {reviewCount(d)}</span>{:else if !M.review}{@const ch = diagramChanges(d)}{#if ch.n}<span class="dchg" class:live={ch.live} title="{ch.n} box{ch.n > 1 ? 'es' : ''} with uncommitted changes{ch.live ? ', the agent is editing now' : ''}">{ch.n}</span>{/if}{/if}{/if}</button>
    {:else}
      {#if many}<p class="dnone muted">{sec.loading ? "loading…" : "no diagrams yet"}</p>{/if}
    {/each}
  {/each}
</div>
