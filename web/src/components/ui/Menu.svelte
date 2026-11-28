<script lang="ts" generics="T extends string">
  // A small menu: a quiet trigger showing the current choice, a popover of options. For settings
  // you rarely change, so they don't take a toolbar's room. Closes on a pick, a click outside, Escape.
  // From the keyboard: j / ↓ or Enter on the trigger opens it on the current choice, j k (or ↓ ↑),
  // Home End move, Enter picks, Escape or Tab closes (Escape back to the trigger).
  import { tick } from "svelte";
  let { value, options, label, onpick, up = false }: { value: T; options: readonly T[]; label: string; onpick: (v: T) => void; up?: boolean } = $props();
  let open = $state(false), root: HTMLElement, trig: HTMLButtonElement, list: HTMLElement | undefined = $state();
  const outside = (e: PointerEvent) => { if (open && !root?.contains(e.target as Node)) open = false; };
  const items = () => [...(list?.querySelectorAll<HTMLButtonElement>("[role=option]") ?? [])];
  async function show() {
    open = true;
    await tick();
    (items().find((b) => b.classList.contains("on")) ?? items()[0])?.focus();
  }
  function close(back = true) { open = false; if (back) trig?.focus(); }
  function trigKeys(e: KeyboardEvent) {
    if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "j" || e.key === "k")) { e.preventDefault(); show(); }
  }
  function listKeys(e: KeyboardEvent) {
    const all = items(), i = all.indexOf(document.activeElement as HTMLButtonElement);
    const down = e.key === "ArrowDown" || e.key === "j", up = e.key === "ArrowUp" || e.key === "k";
    const to = down ? (i + 1) % all.length : up ? (i - 1 + all.length) % all.length
      : e.key === "Home" ? 0 : e.key === "End" ? all.length - 1 : -1;
    if (to >= 0) { e.preventDefault(); all[to]?.focus(); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === "Tab") close(false);
  }
</script>

<svelte:window onpointerdown={outside} onkeydown={(e) => e.key === "Escape" && open && close()} />

<span class="menu" bind:this={root}>
  <button type="button" class="mtrig" class:on={open} bind:this={trig} title={label} aria-haspopup="listbox" aria-expanded={open}
    onclick={() => (open ? close(false) : show())} onkeydown={trigKeys}>
    {value}<span class="chev" aria-hidden="true">▾</span>
  </button>
  {#if open}
    <div class="pop mlist" class:up bind:this={list} role="listbox" tabindex="-1" aria-label={label} onkeydown={listKeys}>
      {#each options as o}
        <button type="button" role="option" aria-selected={o === value} class:on={o === value} onclick={() => { close(); if (o !== value) onpick(o); }}>{o}</button>
      {/each}
    </div>
  {/if}
</span>
