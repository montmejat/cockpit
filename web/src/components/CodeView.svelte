<script lang="ts">
  // The open file or commit, in the center.
  //   A file opens in the editor (FileEditor.svelte, vim keys): its uncommitted changes show in place,
  //   a bar in the margin by lines added (green) or changed (blue), a red mark where lines were
  //   removed. Click a mark to see the old lines and revert that change; "show removed" shows them all. It follows the file
  //   live while an agent edits it, as long as you have no unsaved changes.
  //   A commit shows its patch.
  // In a workspace a file can be another project's ("@name/path", projects.svelte.ts): it is asked
  // of that project's server, with that project's git.
  import MiniMap from "./MiniMap.svelte";
  import FileEditor from "./FileEditor.svelte";
  import { api, parsePatch } from "../lib/code";
  import { cur, openFile, S, store, dirtyFiles } from "../lib/state.svelte";
  import { projectNamed, split } from "../lib/projects.svelte";
  import { lspKey, lspStatus, serverOf } from "../lib/lsp.svelte";
  import type { Hunk } from "../lib/types";

  type FileData = { path: string; text: string | null; hash?: string; note?: string; error?: string; hunks: Hunk[] };
  type CommitData = { sha: string; subject: string; author: string; date: string; body: string; patch: string; error?: string };

  const tab = $derived(cur());
  const path = $derived(tab.kind === "file" ? tab.path : null);
  const sha = $derived(tab.kind === "commit" ? tab.sha : null);
  const cproj = $derived(tab.kind === "commit" ? projectNamed(tab.project) : null);
  // The project the open file or diff is in, its path there, and its live state.
  const at = $derived(split(tab.kind === "file" || tab.kind === "diff" ? tab.path : ""));
  const L = $derived(at.p.L);
  const statusOf = (p: string) => { const s = L.status.find((x) => x.path === split(p).path); return !s ? null : s.x === "?" || s.x === "A" ? "A" : s.x === "D" || s.y === "D" ? "D" : "M"; };
  // A changed file's diff (from the Git tab): reloaded when the file, the index or HEAD moves.
  const dtab = $derived(tab.kind === "diff" ? tab : null);
  type DiffData = { path: string; staged: boolean; patch: string; note?: string };
  let diff = $state<DiffData | null>(null);
  const dkey = $derived(dtab ? dtab.path + "@" + dtab.staged + "@" + (L.fileRevs[at.path] ?? 0) + "@" + L.git.head + "@" + JSON.stringify(L.status.find((x) => x.path === at.path) ?? null) : "");
  $effect(() => {
    if (!dtab) return;
    const k = dkey, d = dtab, a = at;
    if (diff && (diff.path !== d.path || diff.staged !== d.staged)) diff = null;
    api.get<DiffData>(`${a.p.base}api/git/diff?path=${encodeURIComponent(a.path)}&staged=${d.staged ? 1 : 0}`).then((r) => { if (dkey === k) diff = { ...r, path: d.path }; }).catch(() => {});
  });
  const dfiles = $derived(diff?.patch ? parsePatch(diff.patch) : []);
  // The file is loaded again when it changes on disk, when HEAD moves, or when a review starts or
  // ends (in review mode its changes are against the review's target, not the last commit).
  const rev = $derived(path ? (L.fileRevs[at.path] ?? 0) + "@" + L.git.head + "@" + (statusOf(path) ?? "") + "@" + (L.review?.base ?? "") : "");

  // Recent files, so switching tabs shows them at once; the last version stays on screen while
  // a new one loads.
  const files = new Map<string, { rev: string; data: FileData }>();
  let file = $state<FileData | null>(null);
  let commit = $state<CommitData | null>(null);
  let shownFor: unknown = null; // the project the commit on screen is from

  $effect(() => {
    if (!path) return;
    const p = path, r = rev, hit = files.get(p), a = at;
    // The cached copy only when switching files: for the same file it is older than what the
    // editor has (just saved, say), and showing it would bring the old text back until the new one loads.
    if (file?.path !== p) file = hit?.data ?? null;
    if (hit?.rev === r) return;
    api.get<FileData>(a.p.base + "api/file?path=" + encodeURIComponent(a.path) + (a.p.L.review?.base ? "&review=1" : "")).then((d) => {
      const data = { ...d, path: p }; // the page's name for it (with its project's prefix)
      files.set(p, { rev: r, data });
      if (files.size > 12) files.delete(files.keys().next().value!);
      if (path === p) file = data;
    }).catch(() => {});
  });
  $effect(() => {
    if (!sha) return;
    const s = sha, c = cproj!;
    if (commit?.sha.startsWith(s) && shownFor === c) return;
    commit = null; shownFor = c;
    api.get<CommitData>(c.base + "api/git/commit?sha=" + encodeURIComponent(s)).then((x) => { if (sha === s) commit = x; });
  });

  // ---- the file: an editor (FileEditor.svelte) ------------------------------------------

  let editor: ReturnType<typeof FileEditor> | undefined = $state();
  let showAll = $state(store.get("cockpit-show-removed", "0") === "1");
  // The file's language server, in the header: ready, starting, or not installed.
  const LSPCMD: Record<string, string> = { rust: "rust-analyzer", typescript: "typescript-language-server", python: "pyright", zig: "zls", c: "clangd" };
  const srv = $derived(path ? serverOf(path)?.server ?? null : null);
  const lsp = $derived(srv ? lspStatus[lspKey(at.p.base, srv)] ?? "starting" : null);
  let vimOn = $state(store.get("cockpit-vim", "1") === "1");
  let changes = $state(0), changeAt = $state(0);
  // Requested lines (from a diagram link or a test) are highlighted and scrolled to.
  const want = $derived(tab.kind === "file" ? { line: tab.line, end: tab.end, at: tab.at } : {});

  // ---- the floating diagram: which lines are on screen, which box is hovered, where you are ----
  let view = $state<[number, number]>([0, 0]);
  let boxLines = $state<[number, number][]>([]);
  // The line under the mouse, else the line the cursor is on. The floating diagram lights up the
  // box that holds it.
  let hoverLine = $state(0), caretLine = $state(0);
  const cursor = $derived(hoverLine || caretLine);
  $effect(() => { void path; hoverLine = 0; caretLine = 0; });
  const files_ = $derived(commit ? parsePatch(commit.patch) : []);
</script>

<section id="codeview">
  {#if path}
    <div class="dhead">
      <span class="path">{path}</span>
      {#if statusOf(path)}<span class="mark {statusOf(path)}">{statusOf(path)}</span>{/if}
      {#if dirtyFiles.has(path)}<button class="esave" title="Save (Ctrl+S, or :w in vim)" onclick={() => editor?.saveNow()}>● save</button>{/if}
      <span class="grow"></span>
      {#if srv && lsp}<span class="lsp {lsp}" title={lsp === "ready" ? `${srv} language server: hover, completion, diagnostics; F12 / gd definition, Shift+F12 / gr references, F2 / Space rn rename, Shift+Alt+F / Space f format` : lsp === "missing" ? `No ${srv} language server installed (${LSPCMD[srv] ?? srv})` : `${srv} language server ${lsp}`}>{srv}{lsp === "ready" ? "" : lsp === "missing" ? " ×" : " …"}</span>{/if}
      <button class="vimtoggle" class:on={vimOn} title={vimOn ? "Vim keys on: :w saves, :q closes, :wq both. Click to turn off." : "Vim keys off. Click to turn on."}
        onclick={() => { vimOn = !vimOn; store.set("cockpit-vim", vimOn ? "1" : "0"); }}>vim</button>
      {#if changes}
        <span class="muted">{changeAt ? changeAt + "/" : ""}{changes} change{changes > 1 ? "s" : ""}{S.review?.base && file?.path === path ? " vs " + S.review.target : ""}</span>
        <button title="Previous change ([c in vim)" onclick={() => editor?.jump(-1)}>↑</button><button title="Next change (]c in vim)" onclick={() => editor?.jump(1)}>↓</button>
        <label class="muted toggle"><input type="checkbox" bind:checked={showAll} onchange={() => store.set("cockpit-show-removed", showAll ? "1" : "0")}> show removed</label>
      {/if}
    </div>
    {#if !file}<div class="dbody"><p class="dnote">loading…</p></div>
    {:else if file.path === path && (file.error || file.text == null)}<div class="dbody"><p class="dnote">{file.error ?? file.note}</p></div>
    {/if}
    <div class="ewrap" hidden={!file || (file.path === path && file.text == null)}>
      <FileEditor bind:this={editor} {path} data={file} {want} {boxLines} {showAll} {vimOn}
        onview={(v) => (view = v)} oncursor={(n) => (caretLine = n)} onhover={(n) => (hoverLine = n)} onchanges={(n, at) => { changes = n; changeAt = at; }} />
    </div>
    <MiniMap {path} {view} {cursor} onlines={(ls) => (boxLines = ls)} onjump={(n) => editor?.scrollToLine(n)} />
  {:else if dtab}
    <div class="dhead">
      <span class="path">{dtab.path}</span>
      <span class="muted">{dtab.staged ? "staged" : "not staged"}</span>
      <span class="grow"></span>
      <button title="Open the file in the editor" onclick={() => openFile(dtab.path)}>open file</button>
    </div>
    <div class="dbody">
      {#if !diff}<p class="dnote">loading…</p>
      {:else if !dfiles.length}<p class="dnote">{diff.note ?? "no changes"}</p>
      {:else}
        {#each dfiles as f (f.path)}
          <table class="code"><tbody>
            {#each f.rows as r}
              {#if r.kind === "hunk"}<tr class="hunk"><td colspan="4">{@html r.html}</td></tr>
              {:else}<tr class={r.kind}><td class="ln">{r.o ?? ""}</td><td class="ln">{r.n ?? ""}</td><td class="sg">{r.kind === "add" ? "+" : r.kind === "del" ? "-" : ""}</td><td class="c">{@html r.html}</td></tr>{/if}
            {/each}
          </tbody></table>
        {/each}
      {/if}
    </div>
  {:else if sha}
    <div class="dhead"><span class="path">commit {sha}</span></div>
    <div class="dbody">
      {#if !commit}<p class="dnote">loading…</p>
      {:else if commit.error}<p class="dnote">{commit.error}</p>
      {:else}
        <div class="commitmeta"><b>{commit.subject}</b><div class="muted">{commit.author} · {new Date(commit.date).toLocaleString()} · {commit.sha.slice(0, 10)}</div>{#if commit.body}<pre>{commit.body}</pre>{/if}</div>
        {#each files_ as f (f.path)}
          <div class="fhead"><button class="link" onclick={() => openFile((cproj?.prefix ?? "") + f.path)}>{f.path}</button></div>
          <table class="code"><tbody>
            {#each f.rows as r}
              {#if r.kind === "hunk"}<tr class="hunk"><td colspan="4">{@html r.html}</td></tr>
              {:else}<tr class={r.kind}><td class="ln">{r.o ?? ""}</td><td class="ln">{r.n ?? ""}</td><td class="sg">{r.kind === "add" ? "+" : r.kind === "del" ? "-" : ""}</td><td class="c">{@html r.html}</td></tr>{/if}
            {/each}
          </tbody></table>
        {/each}
      {/if}
    </div>
  {/if}
</section>
