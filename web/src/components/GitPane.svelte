<script lang="ts">
  // Git: the branch, how it stands against its upstream and the PR/MR it has open (state, review,
  // CI); what isn't committed, split like VS
  // Code into staged and not (+ / − on a file stages or unstages it), with a commit box over the
  // staged files (Ctrl+Enter commits); and the history of all branches as a graph.
  import { api } from "../lib/code";
  import { graphRows, graphSvg } from "../lib/graph";
  import { askAboutThread, cur, openCommit, openDiff, openFile } from "../lib/state.svelte";
  import { here, type Project } from "../lib/projects.svelte";
  import type { BranchMr, Commit, MergeRequest, Thread } from "../lib/types";

  // One project's git: this window's, or (in a workspace) another one's, asked of its server (B)
  // and named on the page with its prefix (pre).
  let { p = here }: { p?: Project } = $props();
  const L = $derived(p.L), B = $derived(p.base), pre = $derived(p.prefix);

  let commits: Commit[] | null = $state(null);
  // Reload the history when HEAD or the branches move.
  $effect(() => { void L.git.head; void L.git.ahead; void L.git.behind; api.get<Commit[]>(B + "api/git/graph").then((c) => (commits = c)).catch(() => {}); });
  const rows = $derived(commits ? graphRows(commits) : []);
  const width = $derived(18 + 12 * Math.max(1, ...rows.map((r) => Math.max(r.before.length, r.after.length))));
  const selSha = $derived.by(() => { const t = cur(); return t.kind === "commit" && (t.project ?? null) === (p.here ? null : p.name) ? t.sha : null; });
  const commitOf = (sha: string) => openCommit(sha, p.here ? undefined : p.name);
  const g = $derived(L.git);

  // ---- review mode: pick a merge request, or two branches -----------------
  let picking = $state(false), busy = $state(""), err = $state(""), note = $state("");
  let mrs = $state<{ list: MergeRequest[]; forge: string | null; error?: string } | null>(null);
  let br = $state<{ branches: string[]; current: string | null; defaultTarget: string | null } | null>(null);
  let pickBranch = $state(""), pickTarget = $state("");
  function openPicker() {
    picking = !picking; err = "";
    if (!picking) return;
    mrs = null;
    api.get(B + "api/review/mrs").then((r) => (mrs = r)).catch((e) => (mrs = { list: [], forge: null, error: String(e) }));
    api.get(B + "api/review/branches").then((r) => { br = r; pickBranch ||= r.current ?? ""; pickTarget ||= r.defaultTarget ?? ""; });
  }
  async function act(label: string, path: string, body: unknown) {
    busy = label; err = ""; note = "";
    const r = await api.post(B + path, body).catch((e) => ({ error: String(e) }));
    busy = "";
    if (r?.error) err = r.error; else { picking = false; note = r?.note ?? ""; }
  }
  const startMr = (mr: MergeRequest) => act(`checking out ${mr.source}…`, "api/review/start", { mr });
  const startBranches = () => act(`checking out ${pickBranch}…`, "api/review/start", { branch: pickBranch, target: pickTarget });
  // One click: the branch's open MR, else the branch against the default one (the server decides).
  const reviewHere = () => (mr?.state === "open" ? startMr(mr) : g.branch ? act(`opening the review…`, "api/review/start", { branch: g.branch }) : openPicker());
  const reviewBranch = (b: string) => { menu = null; act(`checking out ${b}…`, "api/review/start", { branch: b }); };
  const stop = (back: boolean) => act(back ? "going back…" : "", "api/review/stop", { back });
  const R = $derived(L.review);
  // The merge request's discussions: open ones first, the whole-request ones before the line ones.
  const threads = $derived([...(R?.threads ?? [])].sort((a, b) =>
    Number(a.resolved === true) - Number(b.resolved === true) || Number(!!a.path) - Number(!!b.path) ||
    (a.path ?? "").localeCompare(b.path ?? "") || (a.line ?? a.oldLine ?? 0) - (b.line ?? b.oldLine ?? 0)));
  const threadsOn = (path: string) => (R?.threads ?? []).filter((th) => th.path === path).length;
  const whereOf = (th: Thread) => !th.path ? "on the merge request" : nameOf(th.path) + (th.line ? ":" + th.line : th.oldLine ? ` (removed line ${th.oldLine})` : "");
  let thBusy = $state(false);
  async function refreshThreads() {
    thBusy = true; err = "";
    const r = await api.post(B + "api/review/threads", {}).catch((e) => ({ error: String(e) }));
    thBusy = false;
    if (r?.error) err = r.error;
  }

  // ---- .cockpit/ kept private (src/private.ts) ---------------------------
  const P = $derived(L.private);
  const hasDesc = $derived(L.files.some((f) => f.startsWith(".cockpit/")));
  let pErr = $state("");
  const privPost = (path: string) => { pErr = ""; api.post(B + path, {}).then((r) => { if (r?.error) pErr = r.error; }).catch((e) => (pErr = String(e))); };
  const ago = (t: number) => { const s = Math.round((Date.now() - t) / 1000); return s < 60 ? "just now" : s < 3600 ? Math.round(s / 60) + " min ago" : Math.round(s / 3600) + " h ago"; };
  const ST: Record<string, string> = { A: "A", M: "M", D: "D", T: "M" };

  // ---- staged and not --------------------------------------------------------------
  // git status: x = the index (staged), y = the working tree; "??" untracked; U/AA/DD conflicts.
  const conflicted = (f: { x: string; y: string }) => f.x === "U" || f.y === "U" || (f.x === "A" && f.y === "A") || (f.x === "D" && f.y === "D");
  const conflicts = $derived(L.status.filter(conflicted));
  const staged = $derived(L.status.filter((f) => !conflicted(f) && f.x !== " " && f.x !== "?"));
  const unstaged = $derived(L.status.filter((f) => !conflicted(f) && (f.y !== " " || f.x === "?")));
  const letter = (c: string) => (c === "?" ? "A" : c === "T" ? "M" : c === "C" ? "A" : c);
  let counts = $state<{ staged: Record<string, [number, number]>; unstaged: Record<string, [number, number]> }>({ staged: {}, unstaged: {} });
  $effect(() => { void L.status; void L.fileRevs; api.get(B + "api/git/numstat").then((r) => (counts = r)).catch(() => {}); });
  let message = $state(""), gitBusy = $state(false), gitErr = $state("");
  async function git(path: string, body: unknown) {
    gitBusy = true; gitErr = "";
    const r = await api.post(B + path, body).catch((e) => ({ error: String(e) }));
    gitBusy = false;
    if (r?.error) { gitErr = r.error; return false; }
    return true;
  }
  const stage = (paths: string[]) => git("api/git/stage", { paths });
  const unstage = (paths: string[]) => git("api/git/unstage", { paths });
  // Revert a file's unstaged changes (an untracked file is deleted). There's no undo, so it takes two
  // clicks in place: the first turns the arrow into a red "Revert", the second does it; leaving the
  // row cancels.
  let arming = $state<string | null>(null);
  function discard(path: string) {
    if (arming !== path) { arming = path; return; }
    arming = null;
    git("api/git/discard", { paths: [path] });
  }
  async function commit() {
    if (!message.trim() || !staged.length || gitBusy) return;
    if (await git("api/git/commit", { message })) message = "";
  }
  // ---- the PR/MR of this branch (gh or glab), looked up again when the branch or HEAD moves
  // and every two minutes (CI and reviews change on their own).
  let mr = $state<BranchMr | null>(null), mrErr = $state(""), mrLoading = $state(false);
  async function loadMr(fresh = false) {
    mrLoading = true;
    const r = await api.get<{ mr: BranchMr | null; error?: string }>(B + "api/git/mr" + (fresh ? "?fresh=1" : "")).catch((e) => ({ mr: null, error: String(e) }));
    mrLoading = false; mr = r.mr; mrErr = r.error ?? "";
  }
  $effect(() => { void g.branch; void g.head; loadMr(); });
  $effect(() => { const t = setInterval(() => loadMr(true), 120_000); return () => clearInterval(t); });

  // ---- sections that fold (remembered in this browser)
  type Sec = "review" | "discussions" | "conflicts" | "staged" | "changes" | "history";
  const SECS: Sec[] = ["review", "discussions", "conflicts", "staged", "changes", "history"];
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
  // ---- right-click on a commit: switch to one of its branches, or to the commit itself ----
  type MenuItem = { label: string; hint?: string; off?: boolean; run: () => void } | null; // null: a separator
  let menu = $state<{ x: number; y: number; items: MenuItem[] } | null>(null);
  let swErr = $state(""), swNote = $state("");
  async function switchTo(body: { ref?: string; sha?: string }) {
    menu = null; swErr = ""; swNote = "";
    const r = await api.post(B + "api/git/switch", body).catch((e) => ({ error: String(e) }));
    if (r?.error) swErr = r.error; else swNote = r?.note ?? "";
  }
  function openMenu(e: MouseEvent, c: Commit) {
    e.preventDefault();
    const remotes = new Set(["origin", "upstream", (g.upstream ?? "").split("/")[0]].filter(Boolean));
    const isRemote = (n: string) => n.includes("/") && remotes.has(n.split("/")[0]);
    const names = c.refs.filter((x) => !x.startsWith("tag: ") && x !== "HEAD" && !x.endsWith("/HEAD")).map((x) => (x.startsWith("HEAD -> ") ? x.slice(8) : x));
    const locals = names.filter((n) => !isRemote(n));
    // a remote branch whose local one is here too is the same: only the local one is offered
    const remoteOnly = names.filter((n) => isRemote(n) && !locals.includes(n.slice(n.indexOf("/") + 1)));
    const items: MenuItem[] = [
      ...locals.map((n) => n === g.branch ? { label: n, hint: "current", off: true, run: () => {} } : { label: "Switch to " + n, run: () => switchTo({ ref: n }) }),
      ...remoteOnly.map((n) => ({ label: "Switch to " + n, hint: "new local " + n.slice(n.indexOf("/") + 1), run: () => switchTo({ ref: n }) })),
    ];
    // Review a branch: checks it out and opens its MR's review (or compares it with the default branch).
    if (!R) for (const n of [...locals, ...remoteOnly]) items.push({ label: "Review " + n, hint: "◆", run: () => reviewBranch(n) });
    if (items.length) items.push(null);
    items.push(
      { label: "Check out this commit", hint: "detached", off: c.hash.startsWith(L.git.head) && !g.branch, run: () => switchTo({ sha: c.hash }) },
      { label: "Open commit", run: () => { menu = null; commitOf(c.sha); } },
      { label: "Copy hash", hint: c.sha, run: () => { menu = null; navigator.clipboard?.writeText(c.hash).catch(() => {}); } },
    );
    menu = { x: Math.min(e.clientX, innerWidth - 250), y: Math.min(e.clientY, innerHeight - 30 - items.length * 26), items };
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
  <div class="gitrow" role="presentation" onmouseleave={() => { if (arming === f.path) arming = null; }} class:sel={cur().kind === "diff" && (cur() as { path: string; staged: boolean }).path === f.path && (cur() as { staged: boolean }).staged === staged}>
    <!-- a click shows what changed (a conflict opens the file, to resolve it) -->
    <button class="gitfile" onclick={() => (conflict ? openFile(pre + f.path) : openDiff(pre + f.path, staged))} title={(conflict ? "Open " : staged ? "Staged changes in " : "Changes in ") + f.path}>
      <span class="mark {mark}">{mark}</span><span class="gname">{nameOf(f.path)}</span><span class="gdir">{dirOf(f.path)}</span>
      {#if n}<span class="gnum">{#if n[0] < 0}bin{:else}{#if n[0]}<i class="a">+{n[0]}</i>{/if}{#if n[1]}<i class="d">−{n[1]}</i>{/if}{/if}</span>{/if}
    </button>
    {#if act === "+" && !conflict}
      {@const untracked = L.status.find((x) => x.path === f.path)?.x === "?"}
      {#if arming === f.path}
        <button class="gact grev armed" disabled={gitBusy} title={untracked ? "Click to delete this new file (it isn't in git: no undo)" : "Click to throw away these changes (no undo)"} onclick={() => discard(f.path)}>{untracked ? "Delete" : "Revert"}</button>
      {:else}
        <button class="gact grev" disabled={gitBusy} title={untracked ? "Delete this new file" : "Revert the changes"} aria-label="Revert" onclick={() => discard(f.path)}>
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M5.5 4 3 6.5 5.5 9M3.5 6.5h6a3 3 0 0 1 0 6H7" /></svg></button>
      {/if}
    {/if}
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
      {#if !R}
        <span class="gsplit">
          <button class="gghost" onclick={reviewHere} disabled={!!busy} title={mr?.state === "open" ? `Review ${mr.ref}: what it changes against ${mr.target}, on the map and in the files` : g.branch ? `Review ${g.branch}: its merge request if it has one, else against the default branch` : "Review a merge request, or compare two branches"}>◆ review{mr?.state === "open" ? " " + mr.ref : ""}</button><button class="gghost gcaret" onclick={openPicker} disabled={!!busy} title="Pick another merge request, or two branches to compare">▾</button>
        </span>
      {/if}
    </div>
    {#if mr}
      {@const kind = mr.ref.startsWith("!") ? "MR" : "PR"}
      {@const checks = mr.checks.fail ? `${mr.checks.fail} check${mr.checks.fail > 1 ? "s" : ""} failing` : mr.checks.pending ? `${mr.checks.pending} check${mr.checks.pending > 1 ? "s" : ""} running` : mr.checks.pass ? "checks passed" : ""}
      {@const review = mr.review === "approved" ? "approved" : mr.review === "changes" ? "changes requested" : mr.review === "required" ? "review required" : ""}
      <div class="gpr {mr.state}" class:draft={mr.draft && mr.state === "open"}>
        <span class="gdot"></span>
        <a href={mr.url} target="_blank" rel="noreferrer" title={[`${kind} ${mr.ref} · ${mr.draft && mr.state === "open" ? "draft" : mr.state} → ${mr.target}`, mr.title, review, checks].filter(Boolean).join("\n")}>
          <span class="gprref">{mr.ref}</span><span class="gprtitle">{mr.title}</span>
        </a>
        {#if mr.checks.fail}<span class="gsig bad" title={checks}>✗</span>{:else if mr.checks.pending}<span class="gsig warn" title={checks}>●</span>{:else if mr.checks.pass}<span class="gsig ok" title={checks}>✓</span>{/if}
        {#if mr.review === "approved"}<span class="gsig ok" title="approved">👍︎</span>{:else if mr.review === "changes"}<span class="gsig bad" title="changes requested">✎</span>{/if}
        {#if !R && mr.state === "open"}<button class="gicon" disabled={!!busy} onclick={() => startMr(mr!)} title="Review this {kind}: what it changes against {mr.target}, on the map and in the files">◆</button>{/if}
        <button class="gicon" class:busy={mrLoading} onclick={() => loadMr(true)} disabled={mrLoading} title="Refresh">{#if mrLoading}<span class="spin"></span>{:else}↻{/if}</button>
      </div>
    {:else if mrErr}<div class="gmuted" title={mrErr}>PR lookup: {mrErr}</div>{/if}
  </div>

  {#if P && (P.mode === "on" || P.busy || (P.mode === "off" && hasDesc))}
    {@const on = P.mode === "on" && !P.busy}
    <div class="gcard gpriv" class:on>
      <div class="gprow">
        <svg class="gplock" viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="7" width="9" height="7" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.3"/><path d={on ? "M5.5 7V5a2.5 2.5 0 0 1 5 0v2" : "M5.5 7V5a2.5 2.5 0 0 1 4.9-.7"} fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
        <div class="gptext">
          {#if P.busy}<div class="gptitle"><span class="spin"></span> {P.busy}</div>
          {:else if on}
            <div class="gptitle" title="Kept out of the project's git (.git/info/exclude): only you have it. It follows your branches{P.remote ? ' and is synced to ' + P.remote : ''}.">.cockpit/ is private</div>
            <div class="gpsub" title={P.remote ?? ""}>{P.remote ? (P.synced ? "synced " + ago(P.synced) : "not synced yet") + " · " + P.remote.split("/").slice(0, 1).join("") : "on this machine only"}</div>
          {:else}
            <div class="gptitle">.cockpit/ isn't in git</div>
            <div class="gpsub" title="Not in git: it stays on this branch, on this machine">this branch, this machine only</div>
          {/if}
        </div>
        {#if on && P.remote}<button class="gicon" onclick={() => privPost("api/private/sync")} title="Sync now">↻</button>
        {:else if !on && !P.busy}<button class="gpbtn" onclick={() => privPost("api/private/enable")} title={P.host ? `Keeps .cockpit/ out of the project's git, saves it per branch and commit, and syncs it through a private repo "cockpit-private" in your namespace on ${P.host} (created if needed). Nothing goes to the project's own repo.` : "Keeps .cockpit/ out of the project's git and saves it per branch and commit (this project has no remote: on this machine only)."}>Keep private</button>{/if}
      </div>
      {#if P.note}<div class="gpnote">{P.note}</div>{/if}
      {#if P.error || pErr}<div class="gperr">{pErr || P.error}</div>{/if}
    </div>
  {/if}

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
        {@const nt = threadsOn(f.path)}
        <div class="gitrow"><button class="gitfile" onclick={() => openFile(pre + f.path)} title={f.path}><span class="mark rev {ST[f.st] ?? f.st}">{ST[f.st] ?? f.st}</span><span class="gname">{nameOf(f.path)}</span><span class="gdir">{dirOf(f.path)}</span>{#if nt}<span class="gnum" title="{nt} discussion{nt > 1 ? 's' : ''} on it">💬 {nt}</span>{/if}</button></div>
      {/each}
    {/if}
  {/if}

  {#if R?.mr}
    {#snippet refreshT()}<button class="gall" disabled={thBusy} onclick={refreshThreads} title="Fetch the discussions again (they also refresh every two minutes)">{thBusy ? "…" : "↻"}</button>{/snippet}
    {@render head("discussions", "discussions", R.threads?.length ?? 0, refreshT)}
    {#if open.discussions}
      {#if R.threadsError}<div class="gempty err">{R.threadsError}</div>
      {:else if !R.threads}<div class="gempty"><span class="spin"></span> loading…</div>
      {:else if !threads.length}<div class="gempty">no discussions yet</div>{/if}
      {#each threads as th (th.id)}
        {@const first = th.notes[0]}
        <div class="gitrow thrrow" class:resolved={th.resolved === true}>
          {#if th.path}
            <button class="gitfile thr" onclick={() => openFile(pre + th.path, th.line ?? undefined)} title={th.notes.map((n) => `${n.author}: ${n.body}`).join("\n\n")}>
              <span class="tw"><b>{first?.author}</b> <span class="gdir">{whereOf(th)}</span>{#if th.notes.length > 1}<span class="gdir"> · +{th.notes.length - 1}</span>{/if}{#if th.resolved}<span class="tag">resolved</span>{/if}</span>
              <span class="tb">{first?.body.trim().split("\n")[0]}</span>
            </button>
          {:else}
            <a class="gitfile thr" href={th.url ?? R.mr.url} target="_blank" rel="noreferrer" title={th.notes.map((n) => `${n.author}: ${n.body}`).join("\n\n")}>
              <span class="tw"><b>{first?.author}</b> <span class="gdir">{whereOf(th)}</span>{#if th.notes.length > 1}<span class="gdir"> · +{th.notes.length - 1}</span>{/if}{#if th.resolved}<span class="tag">resolved</span>{/if}</span>
              <span class="tb">{first?.body.trim().split("\n")[0]}</span>
            </a>
          {/if}
          <button class="gact thrask" onclick={() => askAboutThread(th, R, p.here ? undefined : p.name)} title="Ask the agent about this discussion">ask</button>
        </div>
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
    {#each unstaged as f (f.path)}{@render row(f, letter(f.x === "?" ? "?" : f.y), counts.unstaged[f.path], "+")}{:else}<div class="gempty">{L.status.length ? "everything is staged" : "working tree clean"}</div>{/each}
  {/if}

  {@render head("history", "history", 0)}
  {#if open.history}
    {#if !commits}<div class="gempty">loading…</div>{/if}
    <div class="graph">
      {#each rows as r (r.c.hash)}
        {@const rf = refsOf(r.c.refs)}
        <button class="grow-row" class:sel={selSha === r.c.sha} onclick={() => commitOf(r.c.sha)} oncontextmenu={(e) => openMenu(e, r.c)} title={r.c.sha + "  " + r.c.subject + "\n" + r.c.author + " · " + new Date(r.c.date).toLocaleString() + (r.c.refs.length ? "\n" + r.c.refs.join(", ") : "")}>
          {@html graphSvg(r, width)}
          <span class="msg">{#each rf.shown as x}<span class="ref" class:head={x.head} class:remote={x.remote} class:synced={x.synced} title={x.synced ? `${x.name} (same as origin/${x.name})` : x.name}>{x.name}</span>{/each}{#if rf.more}<span class="ref more" title={r.c.refs.join(", ")}>+{rf.more}</span>{/if}{r.c.subject}</span>
        </button>
      {/each}
    </div>
    {#if swErr}<pre class="err gsw">{swErr}</pre>{:else if swNote}<div class="gmuted gsw">{swNote}</div>{/if}
  {/if}
</div>

{#if menu}
  <!-- closes on a click anywhere, Esc, or scrolling -->
  <div class="cmenu-back" role="presentation" onpointerdown={() => (menu = null)} oncontextmenu={(e) => { e.preventDefault(); menu = null; }}></div>
  <div class="cmenu" role="menu" style="left:{menu.x}px;top:{menu.y}px">
    {#each menu.items as it}
      {#if it}<button role="menuitem" disabled={it.off} onclick={it.run}><span class="cl">{it.label}</span>{#if it.hint}<span class="ch">{it.hint}</span>{/if}</button>
      {:else}<div class="csep"></div>{/if}
    {/each}
  </div>
{/if}
<svelte:window onkeydown={(e) => { if (menu && e.key === "Escape") menu = null; }} />
