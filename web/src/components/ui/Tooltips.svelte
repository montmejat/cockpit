<script lang="ts">
  import { tick } from "svelte";
  // Every `title` in the page shows as cockpit's own tooltip instead of the browser's, mounted once
  // in App.svelte, so no component does anything but set `title`. Like the system's: the first one
  // waits, then while you look along a toolbar the next ones show at once. A button that is only an
  // icon waits less (what is it? you want that now), and a shortcut at the end of the text,
  // "Chat  (Ctrl+L)", is set apart. While one shows, its element's `title` is moved aside so the
  // browser doesn't draw its own too, and put back when the pointer leaves.
  const FIRST = 650, ICON = 300, WARM = 450; // ms: first wait, an icon's wait, how long the next stays instant
  let text = $state(""), keys = $state(""), x = $state(0), y = $state(0), below = $state(true), shown = $state(false);
  let el: HTMLElement | null = null, timer = 0, hidAt = 0, tip: HTMLElement | undefined = $state();

  const iconOnly = (e: HTMLElement) => e.tagName === "BUTTON" && !e.textContent?.trim();
  function release() {
    clearTimeout(timer);
    if (el?.dataset.tip !== undefined) { el.setAttribute("title", el.dataset.tip); delete el.dataset.tip; }
    if (shown) hidAt = performance.now();
    el = null; shown = false;
  }
  function over(e: PointerEvent) {
    if (e.pointerType === "touch") return;
    if (e.buttons) { release(); return; } // dragging or selecting: no tooltips on the way
    const t = (e.target as Element | null)?.closest?.("[title]") as HTMLElement | null;
    if (t === el || (el && el.contains(e.target as Node) && !t)) return;
    release();
    const words = t?.getAttribute("title");
    if (!t || !words) return;
    el = t; t.dataset.tip = words; t.removeAttribute("title");
    const m = /^([\s\S]*?)\s*\(([^()]*\b(?:Ctrl|Alt|Shift|Esc|Enter)\b[^()]*)\)\s*$/.exec(words);
    text = m ? m[1] : words; keys = m ? m[2] : "";
    const wait = performance.now() - hidAt < WARM ? 0 : iconOnly(t) ? ICON : FIRST;
    timer = window.setTimeout(place, wait);
  }
  async function place() {
    if (!el?.isConnected) return release();
    const r = el.getBoundingClientRect();
    shown = true;
    await tick();
    const w = tip?.offsetWidth ?? 0, h = tip?.offsetHeight ?? 0;
    below = r.bottom + 6 + h < innerHeight - 4;
    x = Math.max(4, Math.min(innerWidth - w - 4, r.left + r.width / 2 - w / 2));
    y = below ? r.bottom + 6 : r.top - 6 - h;
  }
  function out(e: PointerEvent) { if (el && !el.contains(e.relatedTarget as Node)) release(); }
  // A click, a key, a scroll or the window losing focus ends it; the next hover starts cold again.
  function quit() { release(); hidAt = 0; }
</script>

<svelte:window onpointerovercapture={over} onpointeroutcapture={out} onpointerdowncapture={quit} onkeydowncapture={quit} onwheelcapture={quit} onblur={quit} />

{#if shown}
  <div class="tip" class:below bind:this={tip} style:left="{x}px" style:top="{y}px" role="tooltip">{text}{#if keys}<span class="tipkeys">{keys}</span>{/if}</div>
{/if}
