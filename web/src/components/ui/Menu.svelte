<script lang="ts" generics="T extends string">
  // A small menu: a quiet trigger showing the current choice, a popover of options. For settings
  // you rarely change, so they don't take a toolbar's room. Closes on a pick, a click outside, Escape.
  let { value, options, label, onpick, up = false }: { value: T; options: readonly T[]; label: string; onpick: (v: T) => void; up?: boolean } = $props();
  let open = $state(false), root: HTMLElement;
  const outside = (e: PointerEvent) => { if (open && !root?.contains(e.target as Node)) open = false; };
</script>

<svelte:window onpointerdown={outside} onkeydown={(e) => e.key === "Escape" && (open = false)} />

<span class="menu" bind:this={root}>
  <button type="button" class="mtrig" class:on={open} title={label} aria-haspopup="listbox" aria-expanded={open} onclick={() => (open = !open)}>
    {value}<span class="chev" aria-hidden="true">▾</span>
  </button>
  {#if open}
    <div class="pop mlist" class:up role="listbox" aria-label={label}>
      {#each options as o}
        <button type="button" role="option" aria-selected={o === value} class:on={o === value} onclick={() => { open = false; if (o !== value) onpick(o); }}>{o}</button>
      {/each}
    </div>
  {/if}
</span>
