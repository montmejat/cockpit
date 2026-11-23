<script lang="ts">
  // The question confirmLoss() asks (lib/confirm.svelte.ts): a small dialog over the window.
  // Cancel has the focus, so Enter keeps what would be lost; Escape or a click outside cancels.
  import { asking } from "../../lib/confirm.svelte";
  let cancel = $state<HTMLButtonElement | null>(null);
  $effect(() => { if (asking.q) cancel?.focus(); });
</script>

<svelte:window onkeydown={(e) => { if (asking.q && e.key === "Escape") { e.preventDefault(); asking.q.done(false); } }} />

{#if asking.q}
  {@const q = asking.q}
  <div class="confirm" role="presentation" onpointerdown={(e) => { if (e.target === e.currentTarget) q.done(false); }}>
    <div class="cbox" role="alertdialog" aria-modal="true" aria-label={q.text}>
      <p>{q.text}</p>
      <div class="cbtns">
        <button bind:this={cancel} onclick={() => q.done(false)}>Cancel</button>
        <button class="cyes" onclick={() => q.done(true)}>{q.yes}</button>
      </div>
    </div>
  </div>
{/if}
