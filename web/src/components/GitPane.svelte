<script lang="ts">
  // Git: the branch, how it stands against its upstream and the PR/MR it has open (state, review,
  // CI); what isn't committed, split like VS
  // Code into staged and not (+ / − on a file stages or unstages it), with a commit box over the
  // staged files (Ctrl+Enter commits); and the history of all branches as a graph.
  import { api } from "../lib/code";
  import { graphRows, graphSvg } from "../lib/graph";
  import { cur, openCommit, openDiff, openFile, S } from "../lib/state.svelte";
  import type { BranchMr, Commit, MergeRequest } from "../lib/types";

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
  // ---- the PR/MR of this branch (gh or glab), looked up again when the branch or HEAD moves
  // and every two minutes (CI and reviews change on their own).
  let mr = $state<BranchMr | null>(null), mrErr = $state(""), mrLoading = $state(false);
  async function loadMr(fresh = false) {
    mrLoading = true;
    const r = await api.get<{ mr: BranchMr | null; error?: string }>("api/git/mr" + (fresh ? "?fresh=1" : "")).catch((e) => ({ mr: null, error: String(e) }));
    mrLoading = false; mr = r.mr; mrErr = r.error ?? "";
  }
  $effect(() => { void g.branch; void g.head; loadMr(); });
  $effect(() => { const t = setInterval(() => loadMr(true), 120_000); return () => clearInterval(t); });

  // ---- sections that fold (remembered in this browser)
  type Sec = "review" | "conflicts" | "staged" | "changes" | "history";
  const SECS: Sec[] = ["review", "conflicts", "staged", "changes", "history"];
  const shut: string[] = (() => { try { return JSON.parse(localStorage.getItem("cockpit.git.shut") ?? "[]"); } catch { return []; } })();
  let open = $state(Object.fromEntries(SECS.map((k) => [k, !shut.includes(k)])) as Record<Sec, boolean>);
  function toggle(k: Sec) {
    open[k] = !open[k];
    try { localStorage.setItem("cockpit.git.shut", JSON.stringify(SECS.filter((x) => !open[x]))); } catch {}
  }

  // A commit's refs, made short for the narrow panel: origin/X folds into X when both point here,
  // origin/HEAD goes, the checked-out branch comes first, and only one is shown (+n for the rest).
  function refsOf(refs: string[]) {
    // git log's short decorations don't say which refs are remote; a remote's name prefix does.
    const remotes = new Set(["origin", "upstream", (g.upstream ?? "").split("/")[0]].filter(Boolean));
    const isRemote = (n: string) => n.includes("/") && remotes.has(n.split("/")[0]);
    const all = refs.filter((x) => !x.endsWith("/HEAD")).map((x) => ({
      name: x.startsWith("HEAD -> ") ? x.slice(8) : x.replace("tag: ", ""), head: x.startsWith("HEAD -> ") || x === "HEAD", tag: x.startsWith("tag: "),
    }));
    const local = new Set(all.filter((x) => !x.tag && !isRemote(x.name)).map((x) => x.name));
    const out = all
      .filter((x) => x.tag || !isRemote(x.name) || !local.has(x.name.slice(x.name.indexOf("/") + 1)))
      .map((x) => ({ ...x, remote: !x.tag && isRemote(x.name), synced: !x.tag && !isRemote(x.name) && all.some((y) => isRemote(y.name) && y.name.slice(y.name.indexOf("/") + 1) === x.name) }));
    out.sort((a, b) => +b.head - +a.head || +a.remote - +b.remote);
    return { shown: out.slice(0, 1), more: Math.max(0, out.length - 1) };
  }
  // A commit's age in a few characters: the panel is narrow, the hash is in the tooltip.
  function ago(d: string) {
    const m = (Date.now() - new Date(d).getTime()) / 60_000;
    return m < 60 ? Math.max(1, Math.round(m)) + "m" : m < 1440 ? Math.round(m / 60) + "h" : m < 43_200 ? Math.round(m / 1440) + "d" : m < 525_600 ? Math.round(m / 43_200) + "mo" : Math.round(m / 525_600) + "y";
  }
  const nameOf = (p: string) => p.split("/").pop()!;
  const dirOf = (p: string) => p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
</script>

{#snippet head(key: Sec, label: string, n: number, extra?: import("svelte").Snippet)}
  <div class="ghead">
    <button class="gtoggle" onclick={() => toggle(key)} aria-expanded={open[key]}><span class="chev" class:shut={!open[key]}>▾</span>{label}{#if n}<span class="gcount">{n}</span>{/if}</button>
    {#if extra && open[key]}{@render extra()}{/if}
  </div>
{/snippet}

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
  <!-- where you are: branch, upstream, and the PR/MR this branch has open -->
  <div class="gcard gbranch">
    <div class="gbline">
      <span class="gbname" title={g.branch ?? "detached HEAD"}>⎇ {g.branch ?? "detached"}</span>
      <span class="sha">{g.head}</span>
    </div>
    <div class="gbline gsub">
      {#if g.upstream}
        <!-- origin/<this branch> says nothing the branch name doesn't: just the remote then -->
        <span class="gup" title="upstream: {g.upstream}">{g.upstream === "origin/" + g.branch ? "origin" : g.upstream}</span>
        {#if g.ahead}<span class="chip-s ahead" title="{g.ahead} commit{g.ahead > 1 ? 's' : ''} to push">↑{g.ahead}</span>{/if}
        {#if g.behind}<span class="chip-s behind" title="{g.behind} commit{g.behind > 1 ? 's' : ''} to pull">↓{g.behind}</span>{/if}
        {#if !g.ahead && !g.behind}<span class="chip-s" title="nothing to push or pull">✓ in sync</span>{/if}
      {:else}<span class="gup">no upstream</span>{/if}
      {#if !R}<button class="gghost" onclick={openPicker} disabled={!!busy} title="Review a merge request, or compare two branches">◆ review</button>{/if}
    </div>
    {#if mr}
      <div class="gpr {mr.state}" class:draft={mr.draft}>
        <div class="gprtop">
          <a class="gprref" href={mr.url} target="_blank" rel="noreferrer" title="Open {mr.ref} on the forge">{mr.ref}</a>
          <span class="gprstate">{mr.state === "open" ? (mr.draft ? "draft" : "open") : mr.state}</span>
          <span class="grow"></span>
          <button class="gicon" onclick={() => loadMr(true)} disabled={mrLoading} title="Refresh">{#if mrLoading}<span class="spin"></span>{:else}↻{/if}</button>
        </div>
        <a class="gprtitle" href={mr.url} target="_blank" rel="noreferrer" title={mr.title}>{mr.title}</a>
        <div class="gprmeta">
          <span title="merges into">→ {mr.target}</span>
          {#if mr.review === "approved"}<span class="ok">✓ approved</span>
          {:else if mr.review === "changes"}<span class="bad">✗ changes requested</span>
          {:else if mr.review === "required" && mr.state === "open"}<span class="warn">review required</span>{/if}
          {#if mr.checks.fail}<span class="bad" title="checks failing">✗ {mr.checks.fail} failing</span>
          {:else if mr.checks.pending}<span class="warn" title="checks running"><span class="dot"></span> {mr.checks.pending} running</span>
          {:else if mr.checks.pass}<span class="ok" title="checks passed">✓ checks</span>{/if}
        </div>
        {#if !R && mr.state === "open"}<button class="gghost gprrev" disabled={!!busy} onclick={() => startMr(mr!)} title="Show what {mr.ref} changes against {mr.target} on the map and in the files">◆ review this {mr.ref.startsWith("!") ? "MR" : "PR"}</button>{/if}
      </div>
    {:else if mrErr}<div class="gmuted" title={mrErr}>PR lookup: {mrErr}</div>{/if}
  </div>

  {#if R || busy || err || note}
    <div class="gcard review">
      {#if R}
        <div class="rhead"><b>◆ reviewing</b>{#if R.mr}<a href={R.mr.url} target="_blank" rel="noreferrer">{R.mr.ref}</a>{/if}</div>
        {#if R.mr}<div class="rtitle">{R.mr.title}</div>{/if}
        <div class="gmuted">{R.branch} → {R.target}{R.base ? ` · from ${R.base} · ${R.commits} commit${R.commits === 1 ? "" : "s"}` : ""}</div>
        {#if R.error}<div class="err">{R.error}</div>{/if}
        <div class="rbtns">
          <button onclick={() => stop(false)} disabled={!!busy}>end review</button>
          {#if R.returnTo && R.returnTo !== g.branch}<button onclick={() => stop(true)} disabled={!!busy} title="Check out {R.returnTo} again">end, back to {R.returnTo}</button>{/if}
        </div>
      {/if}
      {#if busy}<div class="gmuted"><span class="spin"></span> {busy}</div>{/if}
      {#if err}<div class="err">{err}</div>{/if}
      {#if note}<div class="note">{note}</div>{/if}
    </div>
  {/if}

  {#if picking && !R}
    <div class="gcard review">
      <div class="rhead"><b>◆ review</b><span class="grow"></span><button class="gicon" onclick={() => (picking = false)} title="Close">✕</button></div>
      <h4>open merge requests</h4>
      {#if !mrs}<div class="gmuted"><span class="spin"></span> loading…</div>
      {:else if mrs.error}<div class="gmuted">{mrs.error}</div>
      {:else if !mrs.list.length}<div class="gmuted">none open</div>{/if}
      <div class="mrlist">
        {#each mrs?.list ?? [] as m (m.id)}
          <button class="mrrow" disabled={!!busy} onclick={() => startMr(m)} title={m.title + "\n" + m.source + " → " + m.target + " · " + m.author}>
            <span class="mt"><b>{m.ref}</b> {m.title}{#if m.draft}<span class="tag">draft</span>{/if}{#if m.fork}<span class="tag">fork</span>{/if}</span>
            <span class="mm">{m.source} → {m.target} · {m.author}</span>
          </button>
        {/each}
      </div>
      <h4>or compare two branches</h4>
      {#if br}
        <label class="gmuted">review<select bind:value={pickBranch}>{#each br.branches as b}<option value={b}>{b}</option>{/each}</select></label>
        <label class="gmuted">against<select bind:value={pickTarget}>{#each br.branches as b}<option value={b}>{b}</option>{/each}</select></label>
        <div class="rbtns"><button disabled={!!busy || !pickBranch || !pickTarget || pickBranch === pickTarget} onclick={startBranches}>compare</button></div>
      {:else}<div class="gmuted">loading branches…</div>{/if}
    </div>
  {/if}

  {#if R}
    {@render head("review", `in this review`, R.files.length)}
    {#if open.review}
      {#each R.files as f (f.path)}
        <div class="gitrow"><button class="gitfile" onclick={() => openFile(f.path)} title={f.path}><span class="mark rev {ST[f.st] ?? f.st}">{ST[f.st] ?? f.st}</span><span class="gname">{nameOf(f.path)}</span><span class="gdir">{dirOf(f.path)}</span></button></div>
      {/each}
    {/if}
  {/if}

  <!-- commit -->
  <div class="commitbox">
    <textarea rows="2" bind:value={message} disabled={gitBusy} placeholder={staged.length ? `Message (Ctrl+Enter commits ${staged.length} file${staged.length > 1 ? "s" : ""})` : "Message (stage files first)"}
      onkeydown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commit(); } }}></textarea>
    <button class="commitbtn" disabled={gitBusy || !staged.length || !message.trim()} onclick={commit}
      title={!staged.length ? "Nothing staged" : !message.trim() ? "Write a message first" : "Commit the staged files"}>{gitBusy ? "…" : "✓ Commit"}{staged.length ? ` ${staged.length} file${staged.length > 1 ? "s" : ""}` : ""}</button>
    {#if gitErr}<pre class="err">{gitErr}</pre>{/if}
  </div>

  {#if conflicts.length}
    {@render head("conflicts", "conflicts", conflicts.length)}
    {#if open.conflicts}{#each conflicts as f (f.path)}{@render row(f, "C", undefined, "+")}{/each}{/if}
  {/if}
  {#if staged.length}
    {#snippet unstageAll()}<button class="gall" disabled={gitBusy} onclick={() => unstage(staged.map((f) => f.path))} title="Unstage all">− all</button>{/snippet}
    {@render head("staged", "staged", staged.length, unstageAll)}
    {#if open.staged}{#each staged as f (f.path)}{@render row(f, letter(f.x), counts.staged[f.path], "−")}{/each}{/if}
  {/if}
  {#snippet stageAll()}{#if unstaged.length}<button class="gall" disabled={gitBusy} onclick={() => stage(unstaged.map((f) => f.path))} title="Stage all">+ all</button>{/if}{/snippet}
  {@render head("changes", "changes", unstaged.length, stageAll)}
  {#if open.changes}
    {#each unstaged as f (f.path)}{@render row(f, letter(f.x === "?" ? "?" : f.y), counts.unstaged[f.path], "+")}{:else}<div class="gempty">{S.status.length ? "everything is staged" : "working tree clean"}</div>{/each}
  {/if}

  {@render head("history", "history", 0)}
  {#if open.history}
    {#if !commits}<div class="gempty">loading…</div>{/if}
    <div class="graph">
      {#each rows as r (r.c.hash)}
        {@const rf = refsOf(r.c.refs)}
        <button class="grow-row" class:sel={selSha === r.c.sha} onclick={() => openCommit(r.c.sha)} title={r.c.sha + "  " + r.c.subject + "\n" + r.c.author + " · " + new Date(r.c.date).toLocaleString() + (r.c.refs.length ? "\n" + r.c.refs.join(", ") : "")}>
          {@html graphSvg(r, width)}
          <span class="msg">{#each rf.shown as x}<span class="ref" class:head={x.head} class:remote={x.remote} class:synced={x.synced} title={x.synced ? `${x.name} (same as origin/${x.name})` : x.name}>{x.name}</span>{/each}{#if rf.more}<span class="ref more" title={r.c.refs.join(", ")}>+{rf.more}</span>{/if}{r.c.subject}</span>
          <span class="gage">{ago(r.c.date)}</span>
        </button>
      {/each}
    </div>
  {/if}
</div>
