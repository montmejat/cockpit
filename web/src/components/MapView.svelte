<script lang="ts">
  // The map: the agents' diagrams, one at a time, drawn once and then kept up to date in place.
  // Semantic zoom: double-click a box, or scroll in past the closest zoom, and a box with ⤢ grows
  // into its detail diagram, a box without one into its code. Scroll out past the full view, press
  // Esc or use the breadcrumb to come back up: the view shrinks back into the box it came from.
  import { onMount, tick } from "svelte";
  import type { Core, NodeSingular } from "cytoscape";
  import ZoomCode from "./ZoomCode.svelte";
  import DiagramList from "./DiagramList.svelte";
  import { buildCy, legend, positionsOf, relayout, restyle, syncCy } from "../lib/diagram";
  import { byId, C, mapTab, nameOf, nodeState, parentOfDiagram, S, saveTabs, showRight, tldr, ui } from "../lib/state.svelte";
  import { api } from "../lib/code";

  let { hidden }: { hidden: boolean } = $props();

  let area: HTMLElement, box: HTMLElement;
  let cy: Core | null = null;
  let legendItems = $state<{ cls: string; text: string; help?: boolean }[]>([]);
  let tip = $state<{ html: string; x: number; y: number } | null>(null);
  let listOpen = $state(false); // the list of every diagram, over the top left of the map

  const t = $derived(mapTab());
  const d = $derived(byId(t.id));
  const codeNode = $derived(t.code && d ? d.nodes.find((n) => n.id === t.code) ?? null : null);
  const chain = $derived.by(() => {
    const out = [];
    for (let x = d, k = 0; x && k < 8; x = parentOfDiagram(x.id), k++) out.unshift(x);
    return out;
  });

  // ---- drawing -----------------------------------------------------------

  onMount(() => {
    // Size changes are handled where the diagram is built (buildCy), in the same frame.
    return () => { cy?.destroy(); cy = null; };
  });

  // The diagram itself, or where its boxes were placed, changed: update in place.
  $effect(() => {
    if (!area) return;
    const diagram = d;
    if (!diagram) return;
    const pos = S.layout?.[diagram.id];
    JSON.stringify(diagram); // follow every part of it
    if (!cy) { cy = buildCy(area, diagram, pos); wire(cy); cy.minZoom(Math.min(cy.zoom() * 0.85, 1)); }
    else if (syncCy(cy, diagram, pos)) cy.minZoom(Math.min(cy.zoom() * 0.85, 1));
    legendItems = legend(cy);
  });
  // What's changing moved (uncommitted code, the agent's files): restyle only.
  $effect(() => {
    void C.items; void C.files; void C.touched; void C.rItems; void C.rFiles; void S.review?.diagrams;
    if (cy && d) { restyle(cy, d); legendItems = legend(cy); }
  });
  // The picked box is outlined.
  $effect(() => {
    const id = ui.picked;
    if (!cy) return;
    cy.nodes().removeClass("picked");
    if (id) cy.getElementById(id).addClass("picked");
  });

  function save() {
    if (!cy || !d) return;
    const pos = positionsOf(cy);
    S.layout = { ...(S.layout ?? {}), [d.id]: pos };
    api.post("api/diagram-layout", { id: d.id, positions: pos });
  }
  function resetLayout() {
    if (!cy || !d) return;
    const rest = { ...(S.layout ?? {}) };
    delete rest[d.id];
    S.layout = rest;
    api.post("api/diagram-layout", { id: d.id, positions: null });
    relayout(cy, d);
  }

  function wire(cy: Core) {
    cy.on("dragfree", "node", save); // dragged boxes stay where you put them
    // The hover box. While the view zooms or pans, the diagram moves under a still mouse and the
    // library only notices on the next mouse move: hide the box then, and bring it back on that move.
    let hov: any = null;
    const place = (ev: MouseEvent) => {
      const r = box.getBoundingClientRect();
      return { x: Math.min(ev.clientX - r.left + 14, r.width - 350), y: ev.clientY - r.top + 14 };
    };
    const show = (target: any, ev: MouseEvent) => {
      const dd = d;
      if (!dd) return;
      cy.elements().removeClass("faded hl");
      let html = "";
      if (target.isNode()) {
        const n = dd.nodes.find((x) => x.id === target.id());
        if (!n) return;
        const ns = nodeState(n, dd.id), go = diveTarget(target), gn = go && dd.nodes.find((x) => x.id === go.id()), det = gn?.detail && byId(gn.detail);
        html = `<b>${escH(n.label)}</b><br>${escH(tldr(n, n.explain))}` +
          (ns.live ? "<br><span style='color:var(--hot)'>◉ the agent is changing it now</span>" : ns.unc ? "<br><span style='color:var(--warn)'>its code changed, not committed</span>" : "") +
          (ns.added ? "<br><span style='color:var(--add)'>new in this review</span>" : ns.rev ? "<br><span style='color:var(--rev)'>changed in this review</span>" : "") +
          (det ? `<br><span class=muted>⤢ double-click to open ${escH(nameOf(det))}</span>` : go ? "<br><span class=muted>double-click for its code</span>" : "");
        cy.elements().not(target.closedNeighborhood()).not(target.ancestors()).not(target.descendants()).addClass("faded");
        target.connectedEdges().addClass("hl");
      } else {
        const x = dd.edges[+target.id().slice(1)];
        if (!x) return;
        html = (x.next ? "<span class=muted>used in the next round</span><br>" : "") + `<b>${escH(x.label)}</b>` + (x.explain ? "<br>" + escH(x.explain) : "");
        cy.elements().not(target).not(target.connectedNodes()).not(target.connectedNodes().ancestors()).addClass("faded");
        target.addClass("hl");
      }
      tip = { html, ...place(ev) };
    };
    const hide = () => { tip = null; if (!cy.destroyed()) cy.elements().removeClass("faded hl"); };
    cy.on("mouseover", "node, edge", (e) => { hov = e.target; if (!ui.zooming) show(hov, e.originalEvent as MouseEvent); });
    cy.on("mouseout", "node, edge", () => { hov = null; hide(); });
    cy.on("viewport", () => { if (tip) hide(); });
    cy.on("mousemove", (e) => {
      if (hov && !tip && !ui.zooming && !hov.removed()) show(hov, e.originalEvent as MouseEvent);
      else if (tip) tip = { ...tip, ...place(e.originalEvent as MouseEvent) };
    });
    cy.on("tap", "node", (e) => {
      const n = d?.nodes.find((x) => x.id === e.target.id());
      if (!n || n.zone) return;
      ui.picked = n.id;
      ui.insp = null;
      showRight("details");
    });
    cy.on("tap", (e) => { if (e.target === cy) ui.picked = null; });
    // Once per double-click (events also reach the zones around a box): go where that box leads.
    // By position, so an arrow crossing a zone's empty space doesn't catch it.
    cy.on("dbltap", (e) => { const n = nodeAt(e.renderedPosition.x, e.renderedPosition.y), x = n && diveTarget(n); if (x) dive(x); });
  }
  const escH = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

  // ---- semantic zoom -----------------------------------------------------------

  const DUR = 460, EASE = "cubic-bezier(.3,.7,.2,1)";
  let zcodeEl: HTMLElement | null = $state(null);

  // The rectangle of a box inside the diagram area, in pixels.
  function boxRect(n: NodeSingular) {
    const b = n.renderedBoundingBox({}), W = area.clientWidth, H = area.clientHeight;
    return { x: b.x1, y: b.y1, w: Math.max(8, b.w), h: Math.max(8, b.h), W, H };
  }
  type R = ReturnType<typeof boxRect>;
  // Transforms that map the whole pane onto a box, and a box onto the whole pane.
  const intoBox = (r: R) => { const k = r.w / r.W; return `translate(${r.x}px, ${r.y + r.h / 2 - (k * r.H) / 2}px) scale(${k})`; };
  const outOfBox = (r: R) => { const k = r.W / r.w; return `translate(${-k * r.x}px, ${r.H / 2 - k * (r.y + r.h / 2)}px) scale(${k})`; };
  // A still picture of the diagram as it is now, laid exactly over it, to animate away.
  function still() {
    if (!cy) return null;
    const img = new Image();
    img.src = cy.png({ full: false, bg: getComputedStyle(document.documentElement).getPropertyValue("--bg").trim() });
    img.className = "zsnap";
    Object.assign(img.style, { left: area.offsetLeft + "px", top: area.offsetTop + "px", width: area.clientWidth + "px", height: area.clientHeight + "px" });
    area.parentElement!.appendChild(img);
    return img;
  }
  const play = (el: Element, frames: Keyframe[]) => el.animate(frames, { duration: DUR, easing: EASE }).finished.catch(() => {});
  // The library remembers where its box is on screen. If the mouse moves while a zoom animation
  // scales the box, clicks would land off target: measure again once it ends.
  const settle = () => cy?.resize();
  const swap = (id: string) => { const nd = byId(id)!; t.id = id; t.code = null; if (cy) { cy.scratch("_hold", true); syncCy(cy, nd, S.layout?.[id]); cy.minZoom(Math.min(cy.zoom() * 0.85, 1)); cy.scratch("_hold", false); legendItems = legend(cy); } };

  // Where going into a box leads: a diagram before code. The box's own detail diagram; else the
  // detail diagram of a zone around it (a zone like "RT thread" stands for a whole diagram, its
  // boxes for parts of it); else the box's code. Zones have no code view of their own.
  // The innermost box at a point of the view (a zone's empty space counts as the zone).
  function nodeAt(x: number, y: number): NodeSingular | null {
    if (!cy) return null;
    const under = cy.nodes().filter((n) => { const b = n.renderedBoundingBox({}); return x >= b.x1 && x <= b.x2 && y >= b.y1 && y <= b.y2; });
    const leaf = under.filter((n) => !n.isParent());
    const hit = leaf.nonempty() ? leaf.first() : under.sort((a, b) => b.ancestors().length - a.ancestors().length).first();
    return hit.nonempty() ? (hit as NodeSingular) : null;
  }

  function diveTarget(node: NodeSingular): NodeSingular | null {
    if (!d) return null;
    const data = (x: NodeSingular) => d!.nodes.find((n) => n.id === x.id());
    const has = (x: NodeSingular) => { const n = data(x); return !!(n?.detail && byId(n.detail)); };
    if (has(node)) return node;
    const zone = node.ancestors().filter((a) => has(a as NodeSingular)).first() as NodeSingular;
    if (zone.nonempty()) return zone;
    const n = data(node);
    return n && !n.zone && (n.anchors ?? []).length ? node : null;
  }

  async function dive(node: NodeSingular) {
    if (ui.zooming || !node || !d || !cy) return;
    const n = d.nodes.find((x) => x.id === node.id());
    if (!n) return;
    const target = n.detail && byId(n.detail) ? byId(n.detail)! : null;
    if (!target && (n.zone || !(n.anchors ?? []).length)) return;
    ui.zooming = true; tip = null;
    const r = boxRect(node), img = still();
    ui.picked = null;
    if (target) swap(target.id); else { t.code = n.id; ui.picked = n.id; }
    saveTabs();
    await tick(); // let the code card appear
    const layer = target ? area : zcodeEl;
    if (layer) {
      (layer as HTMLElement).style.transformOrigin = "0 0";
      await Promise.all([
        play(layer, [{ transform: intoBox(r), opacity: 0 }, { transform: "none", opacity: 1 }]),
        img && play(img, [{ transform: "none", opacity: 1 }, { transform: outOfBox(r), opacity: 0 }]),
      ]);
    }
    img?.remove();
    settle();
    ui.zooming = false;
  }

  async function ascend() {
    if (ui.zooming || !cy) return;
    tip = null;
    if (t.code) { // code back into its box
      ui.zooming = true;
      const node = cy.getElementById(t.code) as NodeSingular;
      const r = node.nonempty() ? boxRect(node) : null;
      if (r && zcodeEl) { zcodeEl.style.transformOrigin = "0 0"; await play(zcodeEl, [{ transform: "none", opacity: 1 }, { transform: intoBox(r), opacity: 0 }]); }
      t.code = null; saveTabs();
      settle();
      ui.zooming = false;
      return;
    }
    const parent = d && parentOfDiagram(d.id), pn = parent?.nodes.find((n) => n.detail === d!.id);
    if (!parent || !pn) return;
    ui.zooming = true;
    const img = still();
    swap(parent.id); ui.picked = null; saveTabs();
    const node = cy.getElementById(pn.id) as NodeSingular;
    if (node.empty()) { img?.remove(); ui.zooming = false; return; }
    const r = boxRect(node);
    area.style.transformOrigin = "0 0";
    if (img) img.style.transformOrigin = "0 0";
    await Promise.all([
      play(area, [{ transform: outOfBox(r), opacity: 0.2 }, { transform: "none", opacity: 1 }]),
      img && play(img, [{ transform: "none", opacity: 1 }, { transform: intoBox(r), opacity: 0 }]),
    ]);
    img?.remove();
    node.flashClass("picked", 900);
    settle();
    ui.zooming = false;
  }
  // Breadcrumb: go up several levels at once (or anywhere), with a simple fade.
  function jumpTo(id: string) {
    if (id === t.id && t.code) return ascend();
    swap(id); ui.picked = null; saveTabs();
    play(area, [{ opacity: 0 }, { opacity: 1 }]).then(settle);
  }

  // Scroll past the closest zoom onto a box to go in; twice past the full view to come out.
  let armed = 0;
  function wheel(ev: WheelEvent) {
    if (ui.zooming || !cy || cy.destroyed()) return;
    const z = cy.zoom(), now = Date.now();
    if (ev.deltaY < 0 && z >= cy.maxZoom() * 0.97) {
      const rect = area.getBoundingClientRect(), x = ev.clientX - rect.left, y = ev.clientY - rect.top;
      const hit = nodeAt(x, y), go = hit && diveTarget(hit);
      if (go) dive(go);
    } else if (ev.deltaY > 0 && z <= cy.minZoom() * 1.02) {
      if (now - armed < 600) { armed = 0; ascend(); } else armed = now;
    }
  }
  function keys(e: KeyboardEvent) {
    if (e.key === "Escape" && !hidden && !(e.target as HTMLElement).closest?.("input,textarea,.xterm")) { if (listOpen) listOpen = false; else ascend(); }
  }
</script>

<svelte:window onkeydown={keys} />

<section id="canvas" class:hide={hidden} bind:this={box}>
  {#if !d}<div id="nodiagram">No diagrams yet. Ask the agent to describe this project.</div>{/if}
  <div class="pane">
    <div class="ptitle">
      {#if d && S.layout?.[d.id]}<span class="pbtns"><button title="Forget where you moved the boxes" onclick={resetLayout}>reset layout</button></span>{/if}
    </div>
    <div class="cyc" bind:this={area} onwheel={wheel}></div>
    <div class="legend">{#each legendItems.filter((l) => ui.help || !l.help) as l (l.cls)}<span><i class="sw {l.cls}"></i>{l.text}</span>{/each}</div>
  </div>
  {#if tip}<div id="tip" style="left:{tip.x}px;top:{tip.y}px">{@html tip.html}</div>{/if}
  {#if d}
    <div id="crumbs">
      <button class="dtoggle" class:on={listOpen} title="All diagrams  (F1: hints)" aria-expanded={listOpen} onclick={() => (listOpen = !listOpen)}>☰</button>
      {#each chain as x, i (x.id)}
        {#if i}<span class="muted"> › </span>{/if}
        {#if i === chain.length - 1 && !codeNode}<b>{nameOf(x)}</b>{:else}<button class="link" onclick={() => jumpTo(x.id)}>{nameOf(x)}</button>{/if}
      {/each}
      {#if codeNode}<span class="muted"> › </span><b>{codeNode.label}</b>{/if}
      {#if ui.help}<span class="muted zhint"> · {chain.length > 1 || codeNode ? "Esc or scroll out to go up" : "double-click a box to go in"} · F1 hides hints</span>{/if}
    </div>
  {/if}
  {#if listOpen && S.diagrams.length}
    <DiagramList current={t.code ? null : t.id} onpick={(id) => { listOpen = false; if (id !== t.id || t.code) jumpTo(id); }} onclose={() => (listOpen = false)} />
  {/if}
  {#if codeNode && d}
    <div id="zcode" bind:this={zcodeEl}>
      <ZoomCode node={codeNode} />
    </div>
  {/if}
</section>
