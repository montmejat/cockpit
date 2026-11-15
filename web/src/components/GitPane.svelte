<script lang="ts">
  // Git: the branch and how it stands against its upstream; what isn't committed, split like VS
  // Code into staged and not (+ / − on a file stages or unstages it), with a commit box over the
  // staged files (Ctrl+Enter commits); and the history of all branches as a graph.
  import { api } from "../lib/code";
  import { graphRows, graphSvg } from "../lib/graph";
  import { cur, openCommit, openDiff, openFile, S } from "../lib/state.svelte";
  import type { Commit, MergeRequest } from "../lib/types";

  let commits: Commit[] | null = $state(null);
  // Reload the history when HEAD or the branches move.
  $effect(() => { void S.git.head; void S.git.ahead; void S.git.behind; api.get<Commit[]>("api/git/graph").then((c) => (commits = c)).catch(() => {}); });
  const rows = $derived(commits ? graphRows(commits) : []);
  const width = $derived(18 + 12 * Math.max(1, ...rows.map((r) => Math.max(r.before.length, r.after.length))));
  const selSha = $derived(cur().kind === "commit" ? (cur() as { sha: string }).sha : null);
  const g = $derived(S.git);

  // ---- review mode: pick a merge request, or two branches -----------------
  let picking = $state(false), busy = $state(""), err = $state(""), note = $state("");
  let mrs = $state<{ list: MergeRequest[]; forge: string | null; error?: string } | null>(null);
  let br = $state<{ branches: string[]; current: string | null; defaultTarget: string | null } | null>(null);
  let pickBranch = $state(""), pickTarget = $state("");
  function openPicker() {
    picking = !picking; err = "";
    if (!picking) return;
    mrs = null;
    api.get("api/review/mrs").then((r) => (mrs = r)).catch((e) => (mrs = { list: [], forge: null, error: String(e) }));
    api.get("api/review/branches").then((r) => { br = r; pickBranch ||= r.current ?? ""; pickTarget ||= r.defaultTarget ?? ""; });
  }
  async function act(label: string, path: string, body: unknown) {
    busy = label; err = ""; note = "";
    const r = await api.post(path, body).catch((e) => ({ error: String(e) }));
    busy = "";
    if (r?.error) err = r.error; else { picking = false; note = r?.note ?? ""; }
  }
  const startMr = (mr: MergeRequest) => act(`checking out ${mr.source}…`, "api/review/start", { mr });
  const startBranches = () => act(`checking out ${pickBranch}…`, "api/review/start", { branch: pickBranch, target: pickTarget });
  const stop = (back: boolean) => act(back ? "going back…" : "", "api/review/stop", { back });
  const R = $derived(S.review);
  const ST: Record<string, string> = { A: "A", M: "M", D: "D", T: "M" };

  // ---- staged and not --------------------------------------------------------------
  // git status: x = the index (staged), y = the working tree; "??" untracked; U/AA/DD conflicts.
  const conflicted = (f: { x: string; y: string }) => f.x === "U" || f.y === "U" || (f.x === "A" && f.y === "A") || (f.x === "D" && f.y === "D");
  const conflicts = $derived(S.status.filter(conflicted));
  const staged = $derived(S.status.filter((f) => !conflicted(f) && f.x !== " " && f.x !== "?"));
  const unstaged = $derived(S.status.filter((f) => !conflicted(f) && (f.y !== " " || f.x === "?")));
  const letter = (c: string) => (c === "?" ? "A" : c === "T" ? "M" : c === "C" ? "A" : c);
  let counts = $state<{ staged: Record<string, [number, number]>; unstaged: Record<string, [number, number]> }>({ staged: {}, unstaged: {} });
  $effect(() => { void S.status; void S.fileRevs; api.get("api/git/numstat").then((r) => (counts = r)).catch(() => {}); });
  let message = $state(""), gitBusy = $state(false), gitErr = $state("");
  async function git(path: string, body: unknown) {
    gitBusy = true; gitErr = "";
    const r = await api.post(path, body).catch((e) => ({ error: String(e) }));
    gitBusy = false;
    if (r?.error) { gitErr = r.error; return false; }
    return true;
  }
  const stage = (paths: string[]) => git("api/git/stage", { paths });
  const unstage = (paths: string[]) => git("api/git/unstage", { paths });
  async function commit() {
    if (!message.trim() || !staged.length || gitBusy) return;
    if (await git("api/git/commit", { message })) message = "";
  }
  const nameOf = (p: string) => p.split("/").pop()!;
  const dirOf = (p: string) => p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
</script>

{#snippet row(f: { path: string }, mark: string, n: [number, number] | undefined, act: "+" | "−")}
  {@const staged = act === "−"}
  {@const conflict = mark === "C"}
  <div class="gitrow" class:sel={cur().kind === "diff" && (cur() as { path: string; staged: boolean }).path === f.path && (cur() as { staged: boolean }).staged === staged}>
    <!-- a click shows what changed (a conflict opens the file, to resolve it) -->
    <button class="gitfile" onclick={() => (conflict ? openFile(f.path) : openDiff(f.path, staged))} title={(conflict ? "Open " : staged ? "Staged changes in " : "Changes in ") + f.path}>
      <span class="mark {mark}">{mark}</span><span class="gname">{nameOf(f.path)}</span><span class="gdir">{dirOf(f.path)}</span>
      {#if n}<span class="gnum">{#if n[0] < 0}bin{:else}{#if n[0]}<i class="a">+{n[0]}</i>{/if}{#if n[1]}<i class="d">−{n[1]}</i>{/if}{/if}</span>{/if}
    </button>
    <button class="gact" disabled={gitBusy} title={act === "+" ? "Stage" : "Unstage"} onclick={() => (act === "+" ? stage([f.path]) : unstage([f.path]))}>{act}</button>
  </div>
{/snippet}

<div class="gitpane">
  <div class="sec">
    <b>⎇ {g.branch ?? "detached"}</b> <span class="muted">at {g.head}</span>
    <div class="muted">
      {#if g.upstream}{g.upstream}: {#if g.ahead || g.behind}{g.ahead ? g.ahead + " to push" : ""}{g.ahead && g.behind ? ", " : ""}{g.behind ? g.behind + " to pull" : ""}{:else}in sync{/if}
      {:else}no upstream{/if}
    </div>
  </div>
  <div class="sec review">
    {#if R}
      <div class="rhead"><b>◆ review</b>{#if R.mr}<a class="muted" href={R.mr.url} target="_blank" rel="noreferrer">{R.mr.ref}</a>{/if}</div>
      {#if R.mr}<div>{R.mr.title}</div>{/if}
      <div class="muted">{R.branch} → {R.target}{R.base ? ` · from ${R.base} · ${R.commits} commit${R.commits === 1 ? "" : "s"}` : ""}</div>
      {#if R.error}<div class="err">{R.error}</div>{/if}
      <div class="rbtns">
        <button onclick={() => stop(false)} disabled={!!busy}>end review</button>
        {#if R.returnTo && R.returnTo !== g.branch}<button onclick={() => stop(true)} disabled={!!busy} title="Check out {R.returnTo} again">end, back to {R.returnTo}</button>{/if}
      </div>
    {:else}
      <button onclick={openPicker} disabled={!!busy}>◆ review a merge request…</button>
    {/if}
    {#if busy}<div class="muted"><span class="spin"></span> {busy}</div>{/if}
    {#if err}<div class="err">{err}</div>{/if}
    {#if note}<div class="note">{note}</div>{/if}
  </div>
  {#if picking && !R}
    <div class="sec"><h4>open merge requests</h4></div>
    {#if !mrs}<div class="sec muted"><span class="spin"></span> loading…</div>
    {:else if mrs.error}<div class="sec muted">{mrs.error}</div>
    {:else if !mrs.list.length}<div class="sec muted">none open</div>{/if}
    {#each mrs?.list ?? [] as mr (mr.id)}
      <button class="mrrow" disabled={!!busy} onclick={() => startMr(mr)} title={mr.title + "\n" + mr.source + " → " + mr.target + " · " + mr.author}>
        <span class="mt">{mr.ref} {mr.title}{#if mr.draft}<span class="tag">draft</span>{/if}{#if mr.fork}<span class="tag">fork</span>{/if}</span>
        <span class="mm">{mr.source} → {mr.target} · {mr.author}</span>
      </button>
    {/each}
    <div class="sec"><h4>or compare two branches</h4>
      {#if br}
        <label class="muted">review<select bind:value={pickBranch}>{#each br.branches as b}<option value={b}>{b}</option>{/each}</select></label>
        <label class="muted">against<select bind:value={pickTarget}>{#each br.branches as b}<option value={b}>{b}</option>{/each}</select></label>
        <div class="rbtns"><button disabled={!!busy || !pickBranch || !pickTarget || pickBranch === pickTarget} onclick={startBranches}>compare</button></div>
      {:else}<div class="muted">loading branches…</div>{/if}
    </div>
  {/if}
  {#if R}
    <div class="sec"><h4>in this review · {R.files.length}</h4></div>
    {#each R.files as f (f.path)}
      <button class="gitfile" onclick={() => openFile(f.path)} title={f.path}><span class="mark rev {ST[f.st] ?? f.st}">{ST[f.st] ?? f.st}</span>{f.path}</button>
    {/each}
  {/if}
  <div class="sec commitbox">
    <textarea rows="2" bind:value={message} disabled={gitBusy} placeholder={staged.length ? `Message (Ctrl+Enter commits ${staged.length} staged file${staged.length > 1 ? "s" : ""})` : "Message (stage files first)"}
      onkeydown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commit(); } }}></textarea>
    <button class="commitbtn" disabled={gitBusy || !staged.length || !message.trim()} onclick={commit}
      title={!staged.length ? "Nothing staged" : !message.trim() ? "Write a message first" : "Commit the staged files"}>{gitBusy ? "…" : "✓ commit"}{staged.length ? ` (${staged.length})` : ""}</button>
    {#if gitErr}<pre class="err">{gitErr}</pre>{/if}
  </div>
  {#if conflicts.length}
    <div class="sec ghead"><h4>conflicts · {conflicts.length}</h4></div>
    {#each conflicts as f (f.path)}{@render row(f, "C", undefined, "+")}{/each}
  {/if}
  <div class="sec ghead"><h4>staged{staged.length ? " · " + staged.length : ""}</h4>{#if staged.length}<button class="gall" disabled={gitBusy} onclick={() => unstage(staged.map((f) => f.path))}>unstage all</button>{/if}</div>
  {#each staged as f (f.path)}{@render row(f, letter(f.x), counts.staged[f.path], "−")}{:else}<div class="sec muted">nothing staged</div>{/each}
  <div class="sec ghead"><h4>changes{unstaged.length ? " · " + unstaged.length : ""}</h4>{#if unstaged.length}<button class="gall" disabled={gitBusy} onclick={() => stage(unstaged.map((f) => f.path))}>stage all</button>{/if}</div>
  {#each unstaged as f (f.path)}{@render row(f, letter(f.x === "?" ? "?" : f.y), counts.unstaged[f.path], "+")}{:else}<div class="sec muted">{S.status.length ? "everything is staged" : "clean"}</div>{/each}
  <div class="sec"><h4>history</h4></div>
  {#if !commits}<div class="sec muted">loading…</div>{/if}
  <div class="graph">
    {#each rows as r (r.c.hash)}
      <button class="grow-row" class:sel={selSha === r.c.sha} onclick={() => openCommit(r.c.sha)} title={r.c.subject + "\n" + r.c.author + " · " + new Date(r.c.date).toLocaleString()}>
        {@html graphSvg(r, width)}
        <span class="msg"><span class="sha">{r.c.sha}</span>{#each r.c.refs as x}{#if x.startsWith("HEAD -> ")}<span class="ref head">{x.slice(8)}</span>{:else if x === "HEAD"}<span class="ref head">HEAD</span>{:else}<span class="ref" class:remote={x.includes("/") && !x.startsWith("tag:")}>{x.replace("tag: ", "")}</span>{/if}{/each}{r.c.subject}</span>
      </button>
    {/each}
  </div>
</div>
