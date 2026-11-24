<script lang="ts">
  // A tab, or a segment of a segmented control: quiet until hovered, raised like a card when it's
  // the open one. Every tab strip is made of these (the center tabs, the terminal's, the sidebar's
  // segments), so they look and behave alike: put them in a .segs strip, which leaves the raised
  // tab's ring room so a scrolling strip doesn't clip it. The look is the .seg rules in app.css;
  // the raised look itself (.raised, .seg.on) is written once there.
  import type { Snippet } from "svelte";
  let { on, title, label, onselect, onclose, closeLabel = "Close", fill = false, class: cls = "", children }: {
    on: boolean; title?: string; label?: string; onselect: () => void;
    onclose?: () => void; closeLabel?: string; fill?: boolean; class?: string; children: Snippet;
  } = $props();
</script>

<div class="seg {cls}" class:on class:fill role="tab" tabindex="0" aria-selected={on} aria-label={label} {title}
  onclick={onselect} onauxclick={(e) => { if (e.button === 1 && onclose) { e.preventDefault(); onclose(); } }}
  onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onselect(); } }}>
  {@render children()}
  {#if onclose}
    <button type="button" class="segx" title={closeLabel} aria-label={closeLabel} onclick={(e) => { e.stopPropagation(); onclose(); }}>
      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" /></svg>
    </button>
  {/if}
</div>
