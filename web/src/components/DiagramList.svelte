<script lang="ts">
  // Every diagram, as a small tree over the map: the ones no other diagram zooms into at the top
  // (the branch that reaches the main loop first), each followed by the diagrams its boxes zoom
  // into. Click one to go there; Esc, the ☰ button or a click elsewhere closes it.
  import type { Diagram } from "../lib/types";
  import { byId, home, nameOf, reviewCount, S, tldr } from "../lib/state.svelte";

  let { current, onpick, onclose }: { current: string | null; onpick: (id: string) => void; onclose: () => void } = $props();

  const childrenOf = (d: Diagram) => [...new Set(d.nodes.map((n) => n.detail).filter((id): id is string => !!id && id !== d.id && !!byId(id)))];
  const rows = $derived.by(() => {
    const isChild = new Set(S.diagrams.flatMap(childrenOf));
    const reaches = (d: Diagram, seen = new Set<string>()): boolean =>
      d.id === home() || (!seen.has(d.id) && (seen.add(d.id), childrenOf(d).some((c) => reaches(byId(c)!, seen))));
    const roots = S.diagrams.filter((d) => !isChild.has(d.id)).sort((a, b) => +reaches(b) - +reaches(a));
    const out: { d: Diagram; depth: number }[] = [], shown = new Set<string>();
    const walk = (d: Diagram, depth: number) => {
      if (shown.has(d.id)) return;
      shown.add(d.id); out.push({ d, depth });
      for (const c of childrenOf(d)) walk(byId(c)!, depth + 1);
    };
    for (const d of roots) walk(d, 0);
    for (const d of S.diagrams) walk(d, 0); // diagrams in a cycle with no root
    return out;
  });

  let el: HTMLElement;
  function outside(e: PointerEvent) {
    const t = e.target as HTMLElement;
    if (el && !el.contains(t) && !t.closest?.(".dtoggle")) onclose();
  }
</script>

<svelte:window onpointerdown={outside} />

<div id="dlist" bind:this={el}>
  {#each rows as { d, depth } (d.id)}
    <button class:on={d.id === current} style:padding-left="{10 + depth * 12}px" title={d.question + (tldr(d, d.answer) ? "\n" + tldr(d, d.answer) : "")} onclick={() => onpick(d.id)}>{nameOf(d)}{#if S.review?.diagrams[d.id]?.isNew}<span class="rn">new</span>{:else if reviewCount(d)}<span class="rc" title="boxes changed in this review">◆ {reviewCount(d)}</span>{/if}</button>
  {/each}
</div>
