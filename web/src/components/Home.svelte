<script lang="ts">
  // Home: where cockpit opens. The workspace (or the lone project) by name, and its projects side by
  // side, none above the others: a card each, a click opens its map. Nothing more.
  import { homeOf, openDiagram, S, ui } from "../lib/state.svelte";
  import { projects } from "../lib/projects.svelte";

  const lead = (s: string | null | undefined) => (s ?? "").split(/(?<=[.!?])\s/)[0];
  const open = (name: string, L: { diagrams: { id: string; kind: string }[] }) => { ui.home = false; openDiagram(homeOf(L as never) ?? "", undefined, name); };
</script>

<section id="home">
  <div class="hwrap">
    <!-- the workspace's name; a lone project is named on its card already -->
    {#if S.workspace}<h1>{S.workspace.name}</h1>{/if}
    <div class="hgrid">
      {#each projects as p (p.name)}
        <button class="hcard" onclick={() => open(p.name, p.L)} title={p.path}>
          <span class="hname">{p.name}</span>
        </button>
      {/each}
    </div>
  </div>
</section>
