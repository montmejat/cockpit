<script lang="ts">
  // The left side: files, git, and the project (features, tests, guardrails), as icon tabs.
  // A tab's badge says when it needs a look: uncommitted files on git, something wrong on project.
  import FileTree from "./FileTree.svelte";
  import GitPane from "./GitPane.svelte";
  import ProjectPane from "./ProjectPane.svelte";
  import Grip, { savedWidth } from "./Grip.svelte";
  import IconButton from "./ui/IconButton.svelte";
  import { collapseAll, S, store, ui, type Side } from "../lib/state.svelte";

  $effect(() => store.set("cockpit-tab", ui.side));

  // Its width: drag the right edge (kept between visits), double-click the edge for the default.
  let width = $state(savedWidth("cockpit-side-width", 280));
  // Every folder in the tree, for "collapse all".
  const dirs = $derived.by(() => {
    const out = new Set<string>();
    for (const p of S.files) { const parts = p.split("/"); for (let i = 1; i < parts.length; i++) out.add(parts.slice(0, i).join("/") + "/"); }
    return [...out];
  });
  const gr = $derived(S.guardrails);
  const wrong = $derived(S.problems.length + (gr.on ? gr.checks.filter((c) => gr.results[c.id] && !gr.results[c.id].ok).length : 0));
  const tabs: { id: Side; label: string; icon: string }[] = [
    { id: "files", label: "Files", icon: "M4 2.5h5l3 3v8h-8zM9 2.5v3h3" },
    { id: "git", label: "Git: changes and history", icon: "M5 3v10M5 9c0-2 6-1 6-4.5M5 3.2a1.2 1.2 0 1 0 0 .1M11 4.3a1.2 1.2 0 1 0 0 .1M5 12.8a1.2 1.2 0 1 0 0 .1" },
    { id: "project", label: "Project: features, tests, guardrails", icon: "M8 2.5l5.5 3-5.5 3-5.5-3zM2.5 8.5l5.5 3 5.5-3M2.5 11.5l5.5 3 5.5-3" },
  ];
  const badge = (id: Side) => (id === "git" ? S.status.length : id === "project" ? wrong : 0);
</script>

<nav id="side" style:width="{width}px">
  <Grip bind:width def={280} key="cockpit-side-width" edge="right" />
  <div class="stabs" role="tablist">
    {#each tabs as x (x.id)}
      <span class="stab" class:bad={x.id === "project"} role="presentation">
        <IconButton label={x.label} on={ui.side === x.id} onclick={() => (ui.side = x.id)}><path d={x.icon} /></IconButton>
        {#if badge(x.id)}<span class="sbadge">{badge(x.id)}</span>{/if}
      </span>
    {/each}
    <span class="grow"></span>
    {#if ui.side === "files"}
      <IconButton label="Collapse all folders" onclick={() => collapseAll(dirs)}><path d="M4.5 6.5 8 3l3.5 3.5M4.5 13 8 9.5l3.5 3.5" /></IconButton>
    {/if}
  </div>
  <div id="sidebody">
    {#if ui.side === "files"}<FileTree />{:else if ui.side === "git"}<GitPane />{:else}<ProjectPane />{/if}
  </div>
</nav>
