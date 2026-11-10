<script lang="ts">
  // The project's files as a tree. Folders with uncommitted changes, or holding the open file,
  // open by themselves until you open or close them; the agent's current files carry a dot.
  import { C, cur, folders, openFile, S, setFolder, statusOf } from "../lib/state.svelte";

  type Dir = { name: string; path: string; dirs: Dir[]; files: { name: string; path: string }[] };
  const tree = $derived.by(() => {
    const root: Dir = { name: "", path: "", dirs: [], files: [] };
    const all = [...new Set([...S.files, ...S.status.map((s) => s.path)])].sort();
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
  // Folders holding a changed file or one the agent is editing.
  const dirty = $derived.by(() => {
    const out = new Set<string>();
    for (const p of [...S.status.map((s) => s.path), ...C.touched]) { const parts = p.split("/"); for (let i = 1; i < parts.length; i++) out.add(parts.slice(0, i).join("/") + "/"); }
    return out;
  });
  const openPath = $derived(cur().kind === "file" ? (cur() as { path: string }).path : null);
  const isOpen = (d: Dir) => folders[d.path] ?? (dirty.has(d.path) || (openPath ?? "").startsWith(d.path));
</script>

{#snippet dir(d: Dir)}
  {#each d.dirs as sub (sub.path)}
    {@const open = isOpen(sub)}
    <button class="folder" class:dirtydot={dirty.has(sub.path)} onclick={() => setFolder(sub.path, !open)}>
      <span class="chev">{open ? "▾" : "▸"}</span>{sub.name}
    </button>
    {#if open}<div class="sub">{@render dir(sub)}</div>{/if}
  {/each}
  {#each d.files as f (f.path)}
    {@const st = statusOf(f.path)}
    <button class="file" class:sel={openPath === f.path} onclick={() => openFile(f.path)} title={f.path}>
      {#if C.touched.has(f.path)}<span class="agentdot" title="the agent is editing it">◉</span>{/if}
      <span class="fname">{f.name}</span>
      {#if st}<span class="mark {st}">{st}</span>{/if}
    </button>
  {/each}
{/snippet}

<div class="tree">{@render dir(tree)}</div>
