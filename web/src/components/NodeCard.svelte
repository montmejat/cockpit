<script lang="ts">
  // A card over the map's top right, in place of a details panel, so the chat stays in view: the
  // box you clicked (the hover box, kept, with its code links and more), or with no box picked, the
  // diagram on screen (from ⓘ by the breadcrumb). ✕, Esc (MapView) or a click on the empty map closes it.
  import type { Diagram } from "../lib/types";
  import { anchorChanged, explainChanges, nameOf, nodeState, openFile, S, tldr, ui, where } from "../lib/state.svelte";
  import IconButton from "./ui/IconButton.svelte";

  let { d, onclose }: { d: Diagram; onclose: () => void } = $props();
  const n = $derived(ui.picked ? d.nodes.find((x) => x.id === ui.picked) ?? null : null);
  const label = (id: string) => d.nodes.find((x) => x.id === id)?.label ?? id;
  const short = (a: string) => (a.includes("::") ? a.split("::").slice(1).join("::") : a.split("/").pop()!);
</script>

{#snippet chip(a: string)}
  {@const w = where(a)}
  {#if w}<button class="chip" class:chg={anchorChanged(a)} title={a + " · " + w.file} onclick={() => openFile(w.file, w.line, w.end)}>{short(a)}</button>
  {:else}<span class="chip muted">{short(a)}</span>{/if}
{/snippet}

<div id="ncard" class="pop" role="dialog" aria-label={n ? n.label : nameOf(d)}>
  <div class="nchead">
    <div class="kicker">{n ? nameOf(d) : "drawn by the agents" + (d.rate ? " · " + d.rate : "")}</div>
    <IconButton label="Close (Esc)" onclick={onclose}><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" /></IconButton>
  </div>
  {#if n}
    {@const ns = nodeState(n, d.id)}
    {@const ins = d.edges.filter((e) => e.to === n.id)}
    {@const outs = d.edges.filter((e) => e.from === n.id)}
    <h2>{n.label}</h2>
    <p class="lead">{tldr(n, n.explain)}</p>
    {#if ns.live}<p class="agentbox">◉ the agent is changing it now</p>{:else if ns.unc}<p class="notebox">changed, not committed</p>{/if}
    {#if ns.added}<p class="revbox add">new in this review</p>{:else if ns.rev}<p class="revbox">changed in this review</p>{/if}
    {#if ns.rev || (!S.review && ns.unc)}<p><button class="zexplain" onclick={() => explainChanges(n, d.id)}>explain the changes</button></p>{/if}
    {#if (n.anchors ?? []).length}<div class="chips">{#each n.anchors ?? [] as a}{@render chip(a)}{/each}</div>{/if}
    {#if n.tldr || tldr(n, n.explain) !== n.explain || ins.length || outs.length}
      <details class="more"><summary>more</summary>
        {#if n.tldr || tldr(n, n.explain) !== n.explain}<p>{n.explain}</p>{/if}
        {#if ins.length || outs.length}
          <h4>in and out</h4>
          {#each ins as e}<div class="io"><span class="dv">{e.next ? "↻ " : ""}{e.label}</span> ← {label(e.from)}</div>{/each}
          {#each outs as e}<div class="io"><span class="dv">{e.next ? "↻ " : ""}{e.label}</span> → {label(e.to)}</div>{/each}
        {/if}
      </details>
    {/if}
  {:else}
    {@const busy = d.nodes.filter((x) => nodeState(x).unc)}
    <h2>{nameOf(d)}</h2>
    <p class="q">{d.question}</p>
    <p class="lead">{tldr(d, d.answer)}</p>
    {#if busy.length}<p class="notebox">changed: {busy.map((x) => x.label).join(", ")}</p>{/if}
    {#if S.review}
      {@const rd = S.review.diagrams[d.id]}
      {@const rv = d.nodes.filter((x) => { const s = nodeState(x, d.id); return s.rev && !s.added; })}
      {#if rd?.isNew}<p class="revbox add">new diagram in this review</p>{/if}
      {#if rv.length}<p class="revbox">changed in this review: {rv.map((x) => x.label).join(", ")}</p>{/if}
      {#if rd && !rd.isNew && rd.added.length}<p class="revbox add">new boxes: {rd.added.map((id) => d.nodes.find((x) => x.id === id)?.label ?? id).join(", ")}</p>{/if}
      {#if rd?.removed.length}<p class="revbox del">removed boxes: {rd.removed.map((x) => x.label).join(", ")}</p>{/if}
    {/if}
    <details class="more"><summary>more</summary>
      {#if d.tldr || tldr(d, d.answer) !== d.answer}<p>{d.answer}</p>{/if}
      <p class="hint">Why a picture: {d.why}</p>
    </details>
  {/if}
</div>
