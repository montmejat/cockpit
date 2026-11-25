<script lang="ts">
  // The project's files as a tree, laid out like VS Code's: one column for a folder's chevron or a
  // file's icon, so every name starts at the same place; indent guides; changed files colored by
  // their git status. Folders with uncommitted changes, or holding the open file, open by themselves
  // until you open or close them; the agent's current files carry a dot. In a workspace, each
  // project is a root folder of its own (projects.svelte.ts), like VS Code's multi-root workspace.
  import { C, cur, folders, openFile, S, setFolder } from "../lib/state.svelte";
  import { fileIcon, SHAPES } from "../lib/fileicons";
  import { many, projects, type Lite } from "../lib/projects.svelte";

  const STEP = 12, PAD = 8; // indent per level, left padding
  // The indent guides of a row at depth d: one faint line per level, under its folder's chevron.
  const guides = (d: number) => Array.from({ length: d }, (_, i) => `linear-gradient(var(--guide),var(--guide)) ${PAD + i * STEP + 7}px 0/1px 100% no-repeat`).join(",") || "none";
  const rowStyle = (d: number) => `padding-left:${PAD + d * STEP}px;--guides:${guides(d)}`;

  type Dir = { name: string; path: string; dirs: Dir[]; files: { name: string; path: string }[] };
  // A project's files as a tree; paths carry its prefix ("@name/" for another project).
  function treeOf(L: Lite, pre: string): Dir {
    const root: Dir = { name: "", path: pre, dirs: [], files: [] };
    const all = [...new Set([...L.files, ...L.status.map((s) => s.path)])].sort();
    for (const rel of all) {
      const p = pre + rel;
      let n = root;
      const parts = rel.split("/");
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
  }
  const trees = $derived(projects.map((p) => ({ p, tree: treeOf(p.L, p.prefix) })));
  // git status letters by page path, for every project shown
  const statuses = $derived.by(() => {
    const m = new Map<string, "U" | "A" | "D" | "M">();
    for (const p of projects) for (const s of p.L.status) m.set(p.prefix + s.path, s.x === "?" ? "U" : s.x === "A" ? "A" : s.x === "D" || s.y === "D" ? "D" : "M");
    return m;
  });
  const statusOf = (path: string) => statuses.get(path) ?? null;
  // Folders holding a changed file or one the agent is editing.
  const dirty = $derived.by(() => {
    const out = new Set<string>();
    const changed = [...projects.flatMap((p) => p.L.status.map((s) => p.prefix + s.path)), ...C.touched, ...(S.review?.files.map((f) => f.path) ?? [])];
    for (const p of changed) { const parts = p.split("/"); for (let i = 1; i < parts.length; i++) out.add(parts.slice(0, i).join("/") + "/"); }
    return out;
  });
  // A project's root row is open unless you closed it ("@name/" for another one, "@/" for this one).
  const rootKey = (pre: string) => pre || "@/";
  const openPath = $derived(cur().kind === "file" ? (cur() as { path: string }).path : null);
  const isOpen = (d: Dir) => folders[d.path] ?? (dirty.has(d.path) || (openPath ?? "").startsWith(d.path));
</script>

{#snippet dir(d: Dir, depth: number)}
  {#each d.dirs as sub (sub.path)}
    {@const open = isOpen(sub)}
    <button class="trow folder" class:changed={dirty.has(sub.path)} style={rowStyle(depth)} onclick={() => setFolder(sub.path, !open)} title={sub.path}>
      <span class="tlead"><svg class="chev" class:open viewBox="0 0 16 16"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
      <span class="tname">{sub.name}</span>
    </button>
    {#if open}{@render dir(sub, depth + 1)}{/if}
  {/each}
  {#each d.files as f (f.path)}
    {@const st = statusOf(f.path)}
    {@const rv = S.review?.files.find((x) => x.path === f.path)}
    {@const ic = fileIcon(f.name)}
    <button class="trow file st-{st === 'U' ? 'A' : st ?? (rv ? 'rev' : '')}" class:sel={openPath === f.path} style={rowStyle(depth)} onclick={() => openFile(f.path)} title={f.path}>
      <span class="tlead fi fi-{ic.color}">
        {#if C.touched.has(f.path)}<span class="agentdot" title="the agent is editing it">◉</span>
        {:else if ic.shape}<svg viewBox="0 0 16 16">{@html SHAPES[ic.shape]}</svg>
        {:else}<span class="fl" class:long={ic.label!.length > 1}>{ic.label}</span>{/if}
      </span>
      <span class="tname">{f.name}</span>
      {#if st}<span class="mark {st === 'U' ? 'A' : st}" title={st === "U" ? "new, not in git yet" : st === "A" ? "added" : st === "D" ? "deleted" : "modified"}>{st}</span>{:else if rv}<span class="mark rev" title="changed in this review">◆</span>{/if}
    </button>
  {/each}
{/snippet}

<div class="tree">
  {#if many}
    {#each trees as { p, tree } (p.name)}
      {@const open = folders[rootKey(p.prefix)] ?? true}
      <button class="trow folder troot" class:changed={p.L.status.length > 0} onclick={() => setFolder(rootKey(p.prefix), !open)} title={p.path}>
        <span class="tlead"><svg class="chev" class:open viewBox="0 0 16 16"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
        <span class="tname">{p.name}</span>
      </button>
      {#if open}{@render dir(tree, 1)}{/if}
    {/each}
  {:else}{@render dir(trees[0].tree, 0)}{/if}
</div>
