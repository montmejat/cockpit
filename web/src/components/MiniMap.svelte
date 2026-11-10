<script lang="ts">
  // A small diagram floats over the code in file tabs: boxes with code in this file are outlined,
  // the ones whose code is on screen light up as you scroll. Hover a box to see its lines, click it
  // to go there. Drag the title bar to move it, the corner to resize it; both are remembered.
  import { onMount } from "svelte";
  import type { Core } from "cytoscape";
  import { buildCy, fitCapped, restyle, syncCy } from "../lib/diagram";
  import { C, filesOfNode, nameOf, openFile, S, store, tldr, where } from "../lib/state.svelte";
  import type { Diagram, DiagramNode } from "../lib/types";

  let { path, view, onlines, onjump }: { path: string; view: [number, number]; onlines: (l: [number, number][]) => void; onjump: (line: number) => void } = $props();

  let el: HTMLElement, mcy: HTMLElement;
  let cy: Core | null = null;
  let folded = $state(false);
  let foot = $state("hover a box to see its lines");
  let chosen: Record<string, string> = $state({}); // which diagram, per file, when several fit

  const here = (d: Diagram) => d.nodes.filter((n) => filesOfNode(n).includes(path)).length;
  const ds = $derived(S.diagrams.filter(here).sort((a, b) => here(b) - here(a)));
  const d = $derived(ds.find((x) => x.id === chosen[path]) ?? ds[0] ?? null);
  // The lines a box covers in this file; a whole-module link covers the file but isn't "on screen".
  const ranges = (n: DiagramNode) => (n.anchors ?? []).map(where).filter((w) => w && w.file === path && w.line).map((w) => [w!.line!, w!.end ?? w!.line!] as [number, number]);

  onMount(() => {
    try { const g = JSON.parse(store.get("cockpit-mini", "null")); if (g) Object.assign(el.style, { left: g.left + "px", top: g.top + "px", width: g.width + "px", height: g.height + "px", right: "auto", bottom: "auto" }); } catch {}
    let t: ReturnType<typeof setTimeout>;
    const ro = new ResizeObserver(() => { if (!cy) return; cy.resize(); clearTimeout(t); t = setTimeout(() => { if (cy) fitCapped(cy, 16); keep(); }, 120); });
    ro.observe(el);
    return () => { ro.disconnect(); cy?.destroy(); cy = null; };
  });
  const keep = () => {
    const r = el.getBoundingClientRect(), p = (el.offsetParent as HTMLElement).getBoundingClientRect();
    store.set("cockpit-mini", JSON.stringify({ left: r.left - p.left, top: r.top - p.top, width: r.width, height: r.height }));
  };

  $effect(() => {
    const dd = d;
    if (!mcy || !dd) return;
    JSON.stringify(dd); void path;
    const pos = S.layout?.[dd.id];
    if (!cy) { cy = buildCy(mcy, dd, pos); wire(cy); } else syncCy(cy, dd, pos);
    cy.nodes().forEach((x) => { const n = dd.nodes.find((m) => m.id === x.id()); x.toggleClass("infile", !!n && filesOfNode(n).includes(path)); });
  });
  $effect(() => { void C.items; void C.files; void C.touched; if (cy && d) restyle(cy, d); });
  // Boxes whose code is on screen.
  $effect(() => {
    const [lo, hi] = view;
    if (!cy || !d) return;
    for (const n of d.nodes) cy.getElementById(n.id).toggleClass("inview", lo <= hi && ranges(n).some(([a, b]) => a <= hi && b >= lo));
  });

  function wire(cy: Core) {
    const node = (id: string) => d?.nodes.find((m) => m.id === id);
    cy.on("mouseover", "node", (e) => { const n = node(e.target.id()); if (!n) return; foot = n.label + ": " + tldr(n, n.explain); onlines(ranges(n)); });
    cy.on("mouseout", "node", () => { foot = "hover a box to see its lines"; onlines([]); });
    cy.on("tap", "node", (e) => {
      const n = node(e.target.id());
      if (!n) return;
      const r = ranges(n)[0];
      if (r) return onjump(r[0]);
      const w = (n.anchors ?? []).map(where).find(Boolean);
      if (w) openFile(w.file, w.line, w.end);
    });
  }

  function drag(e: PointerEvent) {
    if ((e.target as HTMLElement).closest("button")) return;
    const r = el.getBoundingClientRect(), p = (el.offsetParent as HTMLElement).getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
    const move = (ev: PointerEvent) => {
      el.style.left = Math.max(0, Math.min(p.width - 80, ev.clientX - p.left - dx)) + "px";
      el.style.top = Math.max(0, Math.min(p.height - 30, ev.clientY - p.top - dy)) + "px";
      el.style.right = "auto"; el.style.bottom = "auto";
    };
    const up = () => { removeEventListener("pointermove", move); removeEventListener("pointerup", up); keep(); cy?.resize(); };
    addEventListener("pointermove", move); addEventListener("pointerup", up);
  }
</script>

<div id="mini" bind:this={el} class:collapsed={folded} hidden={!d}>
  <div class="mhead" onpointerdown={drag} role="presentation">
    <span class="mtitle" title={d?.question}>{nameOf(d)}</span>
    {#if ds.length > 1}<span class="mtabs">{#each ds as x (x.id)}<button class:on={x.id === d?.id} title={x.question} onclick={() => (chosen[path] = x.id)}>{nameOf(x)}</button>{/each}</span>{/if}
    <button class="mclose" title="Fold or unfold" onclick={() => (folded = !folded)}>{folded ? "+" : "–"}</button>
  </div>
  <div class="mcy" bind:this={mcy}></div>
  <div class="mfoot">{foot}</div>
</div>
