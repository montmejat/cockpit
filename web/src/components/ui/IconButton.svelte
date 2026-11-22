<script lang="ts">
  // A square button showing one icon: for actions you repeat (new, close, more). The label is
  // required: it's the tooltip and what screen readers say.
  import type { Snippet } from "svelte";
  let { label, onclick, on = false, children }: { label: string; onclick: (e: MouseEvent) => void; on?: boolean; children: Snippet } = $props();
</script>

<button type="button" class="ibtn" class:on title={label} aria-label={label} {onclick}>
  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">{@render children()}</svg>
</button>
