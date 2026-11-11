<script lang="ts" module>
  import { store } from "../lib/state.svelte";
  const clamp = (w: number, min: number) => Math.round(Math.max(min, Math.min(w, window.innerWidth * 0.6)));
  // A panel's width as you left it last time.
  export const savedWidth = (key: string, def: number, min = 200) => clamp(+store.get(key, String(def)) || def, min);
</script>

<script lang="ts">
  // The resize handle on a panel's edge: drag it (the width is kept between visits), double-click
  // it for the default width. `edge` is the side of the panel it sits on.
  let { width = $bindable(), def, key, edge, min = 200 }: { width: number; def: number; key: string; edge: "left" | "right"; min?: number } = $props();
  let dragging = $state(false);

  function drag(e: PointerEvent) {
    e.preventDefault();
    const grip = e.currentTarget as HTMLElement, x0 = e.clientX, w0 = width, sign = edge === "right" ? 1 : -1;
    grip.setPointerCapture(e.pointerId);
    dragging = true;
    const move = (m: PointerEvent) => (width = clamp(w0 + sign * (m.clientX - x0), min));
    const up = () => { dragging = false; store.set(key, String(width)); grip.removeEventListener("pointermove", move); grip.removeEventListener("pointerup", up); };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
  }
  function reset() { width = def; store.set(key, String(width)); }
</script>

<div class="sgrip {edge}" class:dragging role="separator" aria-orientation="vertical" title="Drag to resize · double-click for the default width" onpointerdown={drag} ondblclick={reset}></div>
