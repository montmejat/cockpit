<script lang="ts">
  // A project's files as a tree (in a workspace, the sidebar shows one per project, under its
  // root). Folders with uncommitted changes, or holding the open file, open by themselves until you
  // open or close them; the agent's current files carry a dot. A file opens in its project: the
  // window shows that project with it.
  import { cur, foldersOf, liveOf, openTab, setFolder, statusOf, tabProject } from "../lib/state.svelte";

  let { project }: { project: string } = $props();
  const L = $derived(liveOf(project));
  const folders = $derived(foldersOf(project));

  type Dir = { name: string; path: string; dirs: Dir[]; files: { name: string; path: string }[] };
  const tree = $derived.by(() => {
    const root: Dir = { name: "", path: "", dirs: [], files: [] };
    const all = [...new Set([...(L.files ?? []), ...(L.status ?? []).map((s) => s.path)])].sort();
    for (const p of all) {
      let n = root;
      const parts = p.split("/");
      for (const d of parts.slice(0, -1)) {
        const path = n.path + d + "/";
        let next = n.dirs.find((x) => x.path === path);
        if (!next) n.dirs.push((next = { name: d, path, dirs: [], files: [] }));
        n = next;
      }
      n.files.push({ name: parts.at(-1)!, path: p });
    }
    const sort = (d: Dir) => { d.dirs.sort((a, b) => a.name.localeCompare(b.name)); d.files.sort((a, b) => a.name.localeCompare(b.name)); d.dirs.forEach(sort); };
    sort(root);
    return root;
  });
  const touched = $derived(new Set(L.live?.touched ?? []));
  // Folders holding a changed file or one the agent is editing.
  const dirty = $derived.by(() => {
    const out = new Set<string>();
    for (const p of [...(L.status ?? []).map((s) => s.path), ...touched, ...(L.review?.files.map((f) => f.path) ?? [])]) { const parts = p.split("/"); for (let i = 1; i < parts.length; i++) out.add(parts.slice(0, i).join("/") + "/"); }
    return out;
  });
  const openPath = $derived.by(() => { const t = cur(); return t.kind === "file" && tabProject(t) === project ? t.path : null; });
  const isOpen = (d: Dir) => folders[d.path] ?? (dirty.has(d.path) || (openPath ?? "").startsWith(d.path));
</script>

{#snippet dir(d: Dir)}
  {#each d.dirs as sub (sub.path)}
    {@const open = isOpen(sub)}
    <button class="folder" class:dirtydot={dirty.has(sub.path)} onclick={() => setFolder(project, sub.path, !open)}>
      <span class="chev">{open ? "▾" : "▸"}</span>{sub.name}
    </button>
    {#if open}<div class="sub">{@render dir(sub)}</div>{/if}
  {/each}
  {#each d.files as f (f.path)}
    {@const st = statusOf(f.path, L)}
    {@const rv = L.review?.files.find((x) => x.path === f.path)}
    <button class="file" class:sel={openPath === f.path} onclick={() => openTab({ kind: "file", project, path: f.path })} title={f.path}>
      {#if touched.has(f.path)}<span class="agentdot" title="the agent is editing it">◉</span>{/if}
      <span class="fname">{f.name}</span>
      {#if st}<span class="mark {st}">{st}</span>{:else if rv}<span class="mark rev" title="changed in this review">◆</span>{/if}
    </button>
  {/each}
{/snippet}

<div class="tree">{@render dir(tree)}</div>
