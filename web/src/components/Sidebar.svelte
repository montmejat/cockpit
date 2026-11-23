<script lang="ts">
  // The left side: files, git, and the project (features, tests, guardrails), as a segmented control.
  // A tab's badge says when it needs a look: uncommitted files on git, something wrong on project.
  import FileTree from "./FileTree.svelte";
  import GitPane from "./GitPane.svelte";
  import ProjectPane from "./ProjectPane.svelte";
  import Grip, { savedWidth } from "./Grip.svelte";
  import IconButton from "./ui/IconButton.svelte";
  import { collapseAll, M, store, ui, type Side } from "../lib/state.svelte";
  import { many, projects } from "../lib/projects.svelte";

  $effect(() => store.set("cockpit-tab", ui.side));

  // Its width: drag the right edge (kept between visits), double-click the edge for the default.
  let width = $state(savedWidth("cockpit-side-width", 280));
  // Every folder in the tree, folded by the ⌃ button over the tree (shown on hover) or a click on the files tab while on it.
  const dirs = $derived.by(() => {
    const out = new Set<string>();
    for (const x of projects) for (const f of x.L.files) { const parts = (x.prefix + f).split("/"); for (let i = 1; i < parts.length; i++) out.add(parts.slice(0, i).join("/") + "/"); }
    return [...out];
  });
  const gr = $derived(M.guardrails);
  const wrong = $derived(M.problems.length + (gr.on ? gr.checks.filter((c) => gr.results[c.id] && !gr.results[c.id].ok).length : 0));
  const tabs: { id: Side; word: string; label: string; icon: string }[] = [
    { id: "files", word: "Files", label: "Files (click again to fold every folder)", icon: "M4 2.5h5l3 3v8h-8zM9 2.5v3h3" },
    { id: "git", word: "Git", label: "Git: changes and history", icon: "M5 3v10M5 9c0-2 6-1 6-4.5M5 3.2a1.2 1.2 0 1 0 0 .1M11 4.3a1.2 1.2 0 1 0 0 .1M5 12.8a1.2 1.2 0 1 0 0 .1" },
    { id: "project", word: "Project", label: "Project: features, tests, guardrails", icon: "M8 2.5l5.5 3-5.5 3-5.5-3zM2.5 8.5l5.5 3 5.5-3M2.5 11.5l5.5 3 5.5-3" },
  ];
  // The scrollbar's width (0 when the list fits), so the collapse button sits just left of it either way.
  let body: HTMLElement, bar = $state(0);
  $effect(() => {
    if (!body) return;
    // GTK's overlay scrollbars take no width (offsetWidth = clientWidth) but still draw over the
    // right edge when the list scrolls: leave them room then.
    const measure = () => (bar = body.scrollHeight > body.clientHeight ? Math.max(body.offsetWidth - body.clientWidth, 10) : 0);
    const ro = new ResizeObserver(measure);
    ro.observe(body);
    for (const c of body.children) ro.observe(c);
    const mo = new MutationObserver(() => { for (const c of body.children) ro.observe(c); measure(); });
    mo.observe(body, { childList: true });
    measure();
    return () => { ro.disconnect(); mo.disconnect(); };
  });
  // In a workspace, each project's git section folds from its name (remembered).
  let gitShut = $state<string[]>((() => { try { return JSON.parse(store.get("cockpit-git-projects-shut", "[]")); } catch { return []; } })());
  const foldGit = (name: string) => {
    gitShut = gitShut.includes(name) ? gitShut.filter((x) => x !== name) : [...gitShut, name];
    store.set("cockpit-git-projects-shut", JSON.stringify(gitShut));
  };
  const badge = (id: Side) => (id === "git" ? projects.reduce((n, x) => n + x.L.status.length, 0) : id === "project" ? wrong : 0);
</script>

<nav id="side" style:width="{width}px">
  <Grip bind:width def={280} key="cockpit-side-width" edge="right" />
  <div class="stabs" role="tablist">
    {#each tabs as x (x.id)}
      <!-- clicking the files tab while on it folds every folder -->
      <button type="button" class="stab" class:on={ui.side === x.id} class:bad={x.id === "project"} role="tab" aria-selected={ui.side === x.id} title={x.label}
        onclick={() => { if (x.id === "files" && ui.side === "files") collapseAll(dirs); else ui.side = x.id; }}>
        <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d={x.icon} /></svg>{x.word}
        {#if badge(x.id)}<span class="sbadge">{badge(x.id)}</span>{/if}
      </button>
    {/each}
  </div>
  <!-- over the tree but outside its scroller, clear of the scrollbar -->
  {#if ui.side === "files"}
    <div class="sfloat" style:right="{bar + 6}px"><IconButton label="Collapse all folders" onclick={() => collapseAll(dirs)}><path d="M4.5 6.5 8 3l3.5 3.5M4.5 13 8 9.5l3.5 3.5" /></IconButton></div>
  {/if}
  <div id="sidebody" bind:this={body}>
    {#if ui.side === "files"}<FileTree />{:else if ui.side === "git"}
      {#if many}
        <!-- one repository per project, like VS Code's source control in a multi-root workspace -->
        {#each projects as p (p.name)}
          {@const shut = gitShut.includes(p.name)}
          <div class="gproj">
            <button class="gprojhead" onclick={() => foldGit(p.name)} title={p.path} aria-expanded={!shut}>
              <svg class="chev" class:open={!shut} viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M6 4l4 4-4 4" /></svg>
              <span>{p.name}</span>{#if p.L.status.length}<span class="gcount">{p.L.status.length}</span>{/if}
            </button>
            {#if !shut}<GitPane {p} />{/if}
          </div>
        {/each}
      {:else}<GitPane />{/if}{:else}<ProjectPane />{/if}
  </div>
</nav>
