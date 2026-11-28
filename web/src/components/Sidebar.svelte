<script lang="ts">
  // The left side: files, git, and the project (features, tests, guardrails), as a segmented control.
  // A tab's badge says when it needs a look: uncommitted files on git, something wrong on project.
  import FileTree from "./FileTree.svelte";
  import GitPane from "./GitPane.svelte";
  import ProjectPane from "./ProjectPane.svelte";
  import Grip, { savedWidth } from "./Grip.svelte";
  import IconButton from "./ui/IconButton.svelte";
  import Tab from "./ui/Tab.svelte";
  import { collapseAll, folders, M, S, store, ui, type Side } from "../lib/state.svelte";
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
  // The fold button says when there's nothing left to fold, and its chevrons close up when it folds.
  const anyOpen = $derived(dirs.some((d) => folders[d]));
  let folding = $state(false);
  const foldAll = () => { if (anyOpen) folding = true; collapseAll(dirs); };
  const gr = $derived(M.guardrails);
  const wrong = $derived(M.problems.length + (gr.on ? gr.checks.filter((c) => gr.results[c.id] && !gr.results[c.id].ok).length : 0));
  const tabs: { id: Side; word: string; label: string; icon: string }[] = [
    { id: "files", word: "Files", label: "Files", icon: "M4 2.5h5l3 3v8h-8zM9 2.5v3h3" },
    { id: "git", word: "Git", label: "Git: changes and history", icon: "M5 3v10M5 9c0-2 6-1 6-4.5M5 3.2a1.2 1.2 0 1 0 0 .1M11 4.3a1.2 1.2 0 1 0 0 .1M5 12.8a1.2 1.2 0 1 0 0 .1" },
    { id: "project", word: "Project", label: "Project: features, tests, guardrails", icon: "M8 2.5l5.5 3-5.5 3-5.5-3zM2.5 8.5l5.5 3 5.5-3M2.5 11.5l5.5 3 5.5-3" },
  ];
  // In a workspace, one project's git at a time, picked from a tab per project (remembered).
  let gitProj = $state(store.get("cockpit-git-project", ""));
  const gitP = $derived(projects.find((x) => x.name === gitProj) ?? projects.find((x) => x.here) ?? projects[0]);
  const pickGit = (name: string) => { gitProj = name; store.set("cockpit-git-project", name); gpMenu = null; };
  let gpMenu = $state<{ x: number; y: number; w: number } | null>(null);
  const badge = (id: Side) => (id === "git" ? projects.reduce((n, x) => n + x.L.status.length, 0) : id === "project" ? wrong : 0);
</script>

<nav id="side" style:width="{width}px">
  <Grip bind:width def={280} key="cockpit-side-width" edge="right" />
  <div class="stabs segs" role="tablist">
    {#each tabs as x (x.id)}
      <!-- clicking the files tab while on it folds every folder -->
      <Tab fill class={x.id === "project" ? "stab bad" : "stab"} on={ui.side === x.id} title={x.label === x.word ? undefined : x.label}
        onselect={() => { if (x.id === "files" && ui.side === "files") foldAll(); else ui.side = x.id; }}>
        <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d={x.icon} /></svg>{x.word}
        {#if badge(x.id)}<span class="sbadge">{badge(x.id)}</span>{/if}
      </Tab>
    {/each}
  </div>
  <div id="sidebody">
    {#if ui.side === "files"}
      <!-- over the tree: what it is of, and the fold button (shown while the pointer is over the sidebar) -->
      <div class="ftop"><span class="ftname" title={S.workspace ? "Workspace " + S.workspace.name : S.project}>{S.workspace?.name ?? S.project}</span>
        <button type="button" class="ftfold" class:done={!anyOpen} class:folding title={anyOpen ? "Fold every folder" : "Every folder is folded"} aria-label="Fold every folder" onclick={foldAll} onanimationend={() => (folding = false)}>
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M4.5 6.5 8 3l3.5 3.5M4.5 13 8 9.5l3.5 3.5" /></svg></button></div>
      <FileTree />{:else if ui.side === "git"}
      <!-- the git pane fills the side's height: its history takes what's left and scrolls in itself -->
      <div class="gitwrap">
      {#if many}
        <!-- one repository shown, picked from a list of the projects (any number fits; their
             uncommitted counts are in the list): a flat title button, the name and a chevron -->
        <button class="gprojpick" class:on={!!gpMenu} title={gitP.path} onclick={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); gpMenu = gpMenu ? null : { x: r.left, y: r.bottom + 4, w: Math.max(200, r.width) };
        }}>
          <span class="gpname">{gitP.name}</span>
          <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true"><path d="M4 6l4 4 4-4" /></svg>
        </button>
        {#key gitP.name}<GitPane p={gitP} />{/key}
      {:else}<GitPane />{/if}
      </div>{:else}<ProjectPane />{/if}
  </div>
</nav>
{#if gpMenu}
  <div class="cmenu-back" role="presentation" onpointerdown={() => (gpMenu = null)}></div>
  <div class="cmenu gprojmenu" role="menu" style="left:{gpMenu.x}px;top:{gpMenu.y}px;width:{gpMenu.w}px">
    {#each projects as p (p.name)}
      <button role="menuitem" class:cur={p === gitP} onclick={() => pickGit(p.name)} title={p.path}>
        <span class="cl">{p.name}</span>{#if p.L.status.length}<span class="gcount">{p.L.status.length}</span>{/if}
      </button>
    {/each}
  </div>
{/if}
<svelte:window onkeydown={(e) => { if (gpMenu && e.key === "Escape") gpMenu = null; }} />
