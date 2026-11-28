<script lang="ts" module>
  // The pane is remounted each time the git tab opens: what it last fetched, per project server, so
  // it opens with that at once (then refreshes) instead of empty and growing as each answer lands.
  type Seen = { commits?: unknown; mrBy?: Record<string, unknown>; counts?: unknown };
  const seen = new Map<string, Seen>();
  const seenOf = (base: string) => { let s = seen.get(base); if (!s) seen.set(base, (s = {})); return s; };
</script>

<script lang="ts">
  // Git: the branch, how it stands against its upstream and the PR/MR it has open (state, review,
  // CI); what isn't committed, split like VS
  // Code into staged and not (+ / − on a file stages or unstages it), with a commit box over the
  // staged files (Ctrl+Enter commits); and the history of all branches as a graph.
  import { heldView, type Held } from "../lib/heldlists";
  import { ahead, commitUrl, diffTag, diffUrl } from "../lib/ahead";
  import { api } from "../lib/code";
  import { graphRows, graphSvg } from "../lib/graph";
  import { askAboutThread, cur, openCommit, openDiff, openFile, store } from "../lib/state.svelte";
  import Tab from "./ui/Tab.svelte";
  import { here, type Project } from "../lib/projects.svelte";
  import type { BranchMr, Commit, MergeRequest, Thread } from "../lib/types";

  // One project's git: this window's, or (in a workspace) another one's, asked of its server (B)
  // and named on the page with its prefix (pre).
  let { p = here }: { p?: Project } = $props();
  const L = $derived(p.L), B = $derived(p.base), pre = $derived(p.prefix);

  // svelte-ignore state_referenced_locally
  const S = seenOf(p.base);
  let commits: Commit[] | null = $state((S.commits as Commit[]) ?? null);
  // Reload the history when HEAD or the branches move.
  $effect(() => { void L.git.head; void L.git.ahead; void L.git.behind; api.get<Commit[]>(B + "api/git/graph").then((c) => (commits = S.commits = c)).catch(() => {}); });
  const rows = $derived(commits ? graphRows(commits) : []);
  const width = $derived(18 + 12 * Math.max(1, ...rows.map((r) => Math.max(r.before.length, r.after.length))));
  const selSha = $derived.by(() => { const t = cur(); return t.kind === "commit" && (t.project ?? null) === (p.here ? null : p.name) ? t.sha : null; });
  const commitOf = (sha: string) => openCommit(sha, p.here ? undefined : p.name);
  // Reaching a row asks for what a click on it shows, so it opens at once (lib/ahead.ts).
  const soonDiff = (path: string, staged: boolean) => ahead(diffUrl(B, path, staged), diffTag(L, path)).catch(() => {});
  const soonCommit = (sha: string) => ahead(commitUrl(B, sha)).catch(() => {});
  const g = $derived(L.git);

  // ---- review mode: this branch, or a merge request picked from the open ones ----
  let picking = $state(false), busy = $state(""), err = $state(""), note = $state("");
  let mrs = $state<{ list: MergeRequest[]; forge: string | null; error?: string } | null>(null);
  function openPicker() {
    picking = !picking; err = "";
    if (!picking) return;
    mrs = null;
    api.get(B + "api/review/mrs").then((r) => (mrs = r)).catch((e) => (mrs = { list: [], forge: null, error: String(e) }));
  }
  // The server answers before its new state reaches the page: the busy line stays until the review
  // has started or ended here too (or 4 s), so the card doesn't blink out in between.
  let awaitReview: boolean | null = $state(null), awaitTimer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => { if (awaitReview !== null && !!L.review === awaitReview) { awaitReview = null; busy = ""; clearTimeout(awaitTimer); } });
  async function act(label: string, path: string, body: unknown) {
    busy = label || "ending the review…"; err = ""; note = "";
    const r = await api.post(B + path, body).catch((e) => ({ error: String(e) }));
    if (r?.error) { busy = ""; err = r.error; return; }
    picking = false; note = r?.note ?? "";
    const want = path.endsWith("/start");
    if (!!L.review === want) { busy = ""; return; }
    awaitReview = want; clearTimeout(awaitTimer);
    awaitTimer = setTimeout(() => { awaitReview = null; busy = ""; }, 4000);
  }
  const startMr = (mr: MergeRequest) => act(`checking out ${mr.source}…`, "api/review/start", { mr });
  // One click: the branch's open MR, else the branch against the default one (the server decides).
  const reviewHere = () => (mr?.state === "open" ? startMr(mr) : g.branch ? act(`opening the review…`, "api/review/start", { branch: g.branch }) : openPicker());
  const reviewBranch = (b: string) => { menu = null; act(`checking out ${b}…`, "api/review/start", { branch: b }); };
  const stop = (back: boolean) => act(back ? "going back…" : "", "api/review/stop", { back });
  const R = $derived(L.review);
  // Ending a review goes back to the branch you were on before it, when that was another one.
  const goBack = $derived(!!R?.returnTo && R.returnTo !== g.branch);
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
  // Private and nothing to say (a sync running included): just an icon on the branch line.
  const quietPriv = $derived(!!P && P.mode === "on" && !P.note && !P.error && !pErr);
  const privPost = (path: string) => { pErr = ""; api.post(B + path, {}).then((r) => { if (r?.error) pErr = r.error; }).catch((e) => (pErr = String(e))); };
  const ago = (t: number) => { const s = Math.round((Date.now() - t) / 1000); return s < 60 ? "just now" : s < 3600 ? Math.round(s / 60) + " min ago" : Math.round(s / 3600) + " h ago"; };
  const ST: Record<string, string> = { A: "A", M: "M", D: "D", T: "M" };

  // ---- staged and not --------------------------------------------------------------
  // git status: x = the index (staged), y = the working tree; "??" untracked; U/AA/DD conflicts.
  const conflicted = (f: { x: string; y: string }) => f.x === "U" || f.y === "U" || (f.x === "A" && f.y === "A") || (f.x === "D" && f.y === "D");
  const conflicts = $derived(L.status.filter(conflicted));
  const staged = $derived(L.status.filter((f) => !conflicted(f) && f.x !== " " && f.x !== "?"));
  const unstaged = $derived(L.status.filter((f) => !conflicted(f) && (f.y !== " " || f.x === "?")));
  const letter = (c: string) => (c === "?" ? "U" : c === "T" ? "M" : c === "C" ? "A" : c);
  type Counts = { staged: Record<string, [number, number]>; unstaged: Record<string, [number, number]> };
  let counts = $state<Counts>((S.counts as Counts) ?? { staged: {}, unstaged: {} });
  $effect(() => { void L.status; void L.fileRevs; api.get(B + "api/git/numstat").then((r) => (counts = S.counts = r)).catch(() => {}); });
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
  // A row's + or − holds both lists still until the pointer or focus leaves them (lib/heldlists.ts);
  // "+ all" and "− all" move everything, so they don't.
  let held = $state<Held | null>(null);
  const lists = $derived(heldView(staged.map((f) => f.path), unstaged.map((f) => f.path), held));
  const byPath = $derived(new Map(L.status.map((f) => [f.path, f])));
  const hold = () => (held ??= { staged: staged.map((f) => f.path), unstaged: unstaged.map((f) => f.path) });
  const release = () => (held = null);
  // Focus moved elsewhere; not lost to nowhere, as when the clicked button turns disabled while git runs.
  const leaving = (e: FocusEvent) => { const to = e.relatedTarget as Node | null; if (to && !(e.currentTarget as HTMLElement).contains(to)) release(); };
  // Revert a file's unstaged changes (an untracked file is deleted), in one click.
  const discard = (path: string) => git("api/git/discard", { paths: [path] });
  async function commit() {
    if (!message.trim() || !staged.length || gitBusy) return;
    if (await git("api/git/commit", { message })) message = "";
  }
  // ---- the PR/MR of this branch (gh or glab), looked up again when the branch or HEAD moves
  // and every two minutes (CI and reviews change on their own).
  // Kept per branch: on a switch the new branch's last known PR shows at once (none if never seen),
  // never the old branch's while the lookup runs; an answer for a branch since left is dropped.
  // svelte-ignore state_referenced_locally
  const mrBy = (S.mrBy ??= {}) as Record<string, { mr: BranchMr | null; err: string }>;
  // svelte-ignore state_referenced_locally
  let mr = $state<BranchMr | null>(mrBy[g.branch ?? ""]?.mr ?? null), mrErr = $state(mrBy[g.branch ?? ""]?.err ?? ""), mrLoading = $state(false);
  // The lookup's error in a few words (the whole of it on hover): not signed in to gh/glab is the usual one.
  const mrNote = $derived(/auth|to get started|not logged|log ?in/i.test(mrErr) ? "PR info off: sign in with gh or glab" : "Couldn't look up the PR");
  // `shown`: a click on refresh, which spins; the lookups on their own (switch, every 2 min) are quiet.
  async function loadMr(fresh = false, shown = false) {
    const b = g.branch ?? "";
    if (shown) mrLoading = true;
    const r = await api.get<{ mr: BranchMr | null; error?: string }>(B + "api/git/mr" + (fresh ? "?fresh=1" : "")).catch((e) => ({ mr: null, error: String(e) }));
    mrLoading = false;
    if ((g.branch ?? "") !== b) return;
    mr = r.mr; mrErr = r.error ?? ""; mrBy[b] = { mr, err: mrErr };
  }
  // svelte-ignore state_referenced_locally
  let mrFor = g.branch ?? "";
  $effect(() => {
    const b = g.branch ?? ""; void g.head;
    if (b !== mrFor) { mrFor = b; mr = mrBy[b]?.mr ?? null; mrErr = mrBy[b]?.err ?? ""; }
    loadMr();
  });
  // The PR line: while reviewing this branch's MR, the review's own copy of it stands in until the
  // lookup has it (no checks yet), so the line never shows another branch's PR or blinks out.
  const prMr = $derived.by((): BranchMr | null => {
    const rm = R?.mr;
    if (!rm || R!.branch !== g.branch || mr?.ref === rm.ref) return mr;
    return { ...rm, state: "open", review: null, checks: { pass: 0, fail: 0, pending: 0 } };
  });
  // The review's MR is already on the PR line: the review card doesn't say it again.
  const shownAbove = $derived(!!R?.mr && prMr?.ref === R.mr.ref);
  $effect(() => { const t = setInterval(() => loadMr(true), 120_000); return () => clearInterval(t); });

  // ---- while reviewing, tabs pick what's over the history: the changes and the commit box, or the
  // review's files and discussions (remembered in this browser).
  type View = "changes" | "review";
  let view = $state<View>(store.get("cockpit-git-view", "changes") === "review" ? "review" : "changes");
  const pick = (v: View) => { view = v; store.set("cockpit-git-view", v); };
  const shown = $derived<View>(R ? view : "changes");

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
  // A commit's branches: the local ones, and the remote ones with no local one of the same name.
  function branchesOf(c: Commit) {
    const remotes = new Set(["origin", "upstream", (g.upstream ?? "").split("/")[0]].filter(Boolean));
    const isRemote = (n: string) => n.includes("/") && remotes.has(n.split("/")[0]);
    const names = c.refs.filter((x) => !x.startsWith("tag: ") && x !== "HEAD" && !x.endsWith("/HEAD")).map((x) => (x.startsWith("HEAD -> ") ? x.slice(8) : x));
    const locals = names.filter((n) => !isRemote(n));
    // a remote branch whose local one is here too is the same: only the local one is offered
    const remoteOnly = names.filter((n) => isRemote(n) && !locals.includes(n.slice(n.indexOf("/") + 1)));
    return { locals, remoteOnly };
  }
  // The branches a click on a row's checkout button can switch to (the current one left out).
  const switchable = (c: Commit) => { const b = branchesOf(c); return [...b.locals.filter((n) => n !== g.branch), ...b.remoteOnly]; };
  // One branch: switch to it; more: the row's menu, which lists them.
  function checkoutRow(e: MouseEvent, c: Commit) {
    e.stopPropagation();
    const s = switchable(c);
    if (s.length === 1) switchTo({ ref: s[0] }); else openMenu(e, c);
  }
  function openMenu(e: MouseEvent, c: Commit) {
    e.preventDefault();
    const { locals, remoteOnly } = branchesOf(c);
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

{#snippet head(label: string, n: number, extra?: import("svelte").Snippet)}
  <div class="ghead">
    <span class="glabel">{label}{#if n}<span class="gcount">{n}</span>{/if}</span>
    {#if extra}{@render extra()}{/if}
  </div>
{/snippet}

{#snippet row(f: { path: string }, mark: string, n: [number, number] | undefined, act: "+" | "−", moved = false)}
  {@const staged = act === "−"}
  {@const conflict = mark === "C"}
  <div class="gitrow" class:gmoved={moved} class:sel={cur().kind === "diff" && (cur() as { path: string; staged: boolean }).path === f.path && (cur() as { staged: boolean }).staged === staged}>
    <!-- a click shows what changed (a conflict opens the file, to resolve it) -->
    <button class="gitfile" onpointerenter={() => { if (!conflict) soonDiff(f.path, staged); }} onclick={() => (conflict ? openFile(pre + f.path) : openDiff(pre + f.path, staged))} title={(conflict ? "Open " : staged ? "Staged changes in " : "Changes in ") + f.path}>
      <span class="mark {mark === 'U' ? 'A' : mark}">{mark}</span><span class="gname" class:gdel={mark === "D"}>{nameOf(f.path)}</span><span class="gdir">{dirOf(f.path)}</span>{#if moved}<span class="gwent">{staged ? "staged" : "unstaged"}</span>{/if}
      {#if n}<span class="gnum">{#if n[0] < 0}bin{:else}{#if n[0]}<i class="a">+{n[0]}</i>{/if}{#if n[1]}<i class="d">−{n[1]}</i>{/if}{/if}</span>{/if}
    </button>
    {#if act === "+" && !conflict}
      {@const untracked = L.status.find((x) => x.path === f.path)?.x === "?"}
      <button class="gact grev" disabled={gitBusy} title={untracked ? "Delete this new file (no undo)" : "Revert the changes (no undo)"} aria-label="Revert" onclick={() => discard(f.path)}>
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M5.5 4 3 6.5 5.5 9M3.5 6.5h6a3 3 0 0 1 0 6H7" /></svg></button>
    {/if}
    <button class="gact gstage" disabled={gitBusy} title={(act === "+" ? "Stage" : "Unstage") + (moved ? " again" : "")} aria-label={act === "+" ? "Stage" : "Unstage"} onclick={() => { if (!conflict) hold(); act === "+" ? stage([f.path]) : unstage([f.path]); }}>
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d={act === "+" ? "M8 3.5v9M3.5 8h9" : "M3.5 8h9"} /></svg></button>
  </div>
{/snippet}

<div class="gitpane">
  <!-- where you are: branch, upstream, and the PR/MR this branch has open -->
  <div class="gcard gbranch">
    <!-- one line: the branch (HEAD's hash and the upstream on hover), how it stands, review -->
    <div class="gbline">
      <span class="gbname" title="{g.branch ?? 'detached HEAD'} at {g.head}{g.upstream ? '\nupstream: ' + g.upstream : '\nno upstream'}">⎇ {g.branch ?? "detached " + g.head}</span>
      {#if g.upstream}
        <!-- origin/<this branch> says nothing the branch name doesn't: shown only when it's another one -->
        {#if g.upstream !== "origin/" + g.branch}<span class="gup" title="upstream: {g.upstream}">{g.upstream}</span>{/if}
        {#if g.ahead}<span class="chip-s ahead" title="{g.ahead} commit{g.ahead > 1 ? 's' : ''} to push to {g.upstream}">↑{g.ahead}</span>{/if}
        {#if g.behind}<span class="chip-s behind" title="{g.behind} commit{g.behind > 1 ? 's' : ''} to pull from {g.upstream}">↓{g.behind}</span>{/if}
        {#if !g.ahead && !g.behind}<span class="gsync" title="in sync with {g.upstream}">✓</span>{/if}
      {:else}<span class="gup" title="this branch has no upstream">local</span>{/if}
      <span class="grow"></span>
      <!-- no PR info: a faint mark, the reason on hover -->
      {#if !prMr && mrErr}<span class="gproff" title={mrNote + "\n" + mrErr}><svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4.5 3v10M11.5 7v6M4.5 3.2a1.3 1.3 0 1 0 0 .1M11.5 12.8a1.3 1.3 0 1 0 0 .1M11.5 7c0-2-1-3-3-3H7" /></svg></span>{/if}
      {#if quietPriv}
        <!-- .cockpit/ kept private: a lock that syncs on a click (spins while syncing); the rest on hover -->
        {@const tip = `.cockpit/ is private: kept out of the project's git (.git/info/exclude), it follows your branches${P!.remote ? ` and syncs to ${P!.remote}\n${P!.synced ? "synced " + ago(P!.synced) : "not synced yet"} · click to sync now` : "\non this machine only"}`}
        <button class="gpicon" class:busy={!!P!.busy} disabled={!P!.remote || !!P!.busy} onclick={() => privPost("api/private/sync")} title={P!.busy || tip} aria-label=".cockpit/ private: sync">
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="3.5" y="7" width="9" height="7" rx="1.6" /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" /></svg>
          {#if P!.remote}<svg class="gpsync" viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v2.5h-2.5" /></svg>{/if}
        </button>
      {/if}
      {#if !R}
        <!-- review: a small link, as quiet as the line's other marks -->
        <span class="gsplit">
          <button class="gghost" onclick={reviewHere} disabled={!!busy} title={mr?.state === "open" ? `Review ${mr.ref}: what it changes against ${mr.target}, on the map and in the files` : g.branch ? `Review ${g.branch}: its merge request if it has one, else against the default branch` : "Review a merge request"}>◆ review{mr?.state === "open" ? " " + mr.ref : ""}</button><button class="gghost gcaret" class:on={picking} onclick={openPicker} disabled={!!busy} title="Review another merge request" aria-label="Review another merge request">
            <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true"><path d="M4 6l4 4 4-4" /></svg></button>
        </span>
      {/if}
    </div>
    {#if prMr}{@const pm = prMr}
      {@const kind = pm.ref.startsWith("!") ? "MR" : "PR"}
      {@const checks = pm.checks.fail ? `${pm.checks.fail} check${pm.checks.fail > 1 ? "s" : ""} failing` : pm.checks.pending ? `${pm.checks.pending} check${pm.checks.pending > 1 ? "s" : ""} running` : pm.checks.pass ? "checks passed" : ""}
      {@const review = pm.review === "approved" ? "approved" : pm.review === "changes" ? "changes requested" : pm.review === "required" ? "review required" : ""}
      <div class="gpr {pm.state}" class:draft={pm.draft && pm.state === "open"}>
        <span class="gdot"></span>
        <a href={pm.url} target="_blank" rel="noreferrer" title={[`${kind} ${pm.ref} · ${pm.draft && pm.state === "open" ? "draft" : pm.state} → ${pm.target}`, pm.title, review, checks].filter(Boolean).join("\n")}>
          <span class="gprref">{pm.ref}</span><span class="gprtitle">{pm.title}</span>
        </a>
        {#if pm.checks.fail}<span class="gsig bad" title={checks}>✗</span>{:else if pm.checks.pending}<span class="gsig warn" title={checks}>●</span>{:else if pm.checks.pass}<span class="gsig ok" title={checks}>✓</span>{/if}
        {#if pm.review === "approved"}<span class="gsig ok" title="approved">👍︎</span>{:else if pm.review === "changes"}<span class="gsig bad" title="changes requested">✎</span>{/if}
        {#if !R && pm.state === "open"}<button class="gicon" disabled={!!busy} onclick={() => startMr(pm!)} title="Review this {kind}: what it changes against {pm.target}, on the map and in the files">◆</button>{/if}
        <button class="gicon" class:busy={mrLoading} onclick={() => loadMr(true, true)} disabled={mrLoading} title="Refresh">{#if mrLoading}<span class="spin"></span>{:else}↻{/if}</button>
      </div>
    {/if}
  </div>

  {#if P && !quietPriv && (P.mode === "on" || P.busy || (P.mode === "off" && hasDesc))}
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
    <div class="gcard review rnow">
      <!-- one line, the same height busy or not (the busy text and a spinner take the place of what
           it reviews and of the end button): what the branch and PR lines above don't already say -->
      <div class="rhead">
        <b>◆ {R ? "reviewing" : "review"}</b>
        {#if busy}<span class="rwhat">{busy}</span><span class="spin"></span>
        {:else if R}
          {#if R.mr && !shownAbove}<a href={R.mr.url} target="_blank" rel="noreferrer" title={R.mr.title}>{R.mr.ref}</a>{/if}
          <span class="rwhat" title="{R.branch} → {R.target}{R.base ? `\nfrom ${R.base}` : ''}">{R.branch === g.branch ? "" : R.branch + " "}→ {R.target}{R.base ? ` · ${R.commits} commit${R.commits === 1 ? "" : "s"}` : ""}</span>
          <!-- one way out: back to the branch you were on before the review, if it was another one -->
          <button class="rend" onclick={() => stop(goBack)} title={goBack ? `End the review and check out ${R.returnTo} again` : "End the review"}>end</button>
        {:else}<span class="rwhat"></span>{/if}
      </div>
      {#if R?.mr && !shownAbove}<div class="rtitle">{R.mr.title}</div>{/if}
      {#if R?.error}<div class="err">{R.error}</div>{/if}
      {#if err}<div class="err">{err}</div>{/if}
      {#if note}<div class="note">{note}</div>{/if}
    </div>
  {/if}

  {#if picking && !R}
    <div class="gcard review">
      <div class="rhead"><b>◆ open merge requests</b><span class="grow"></span><button class="gx" onclick={() => (picking = false)} title="Close" aria-label="Close">
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" /></svg></button></div>
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
    </div>
  {/if}

  {#if R}
    <div class="gviews segs" role="tablist">
      <Tab fill on={shown === "changes"} onselect={() => pick("changes")} title="What isn't committed, and the commit box">Changes{#if L.status.length}<span class="gcount">{L.status.length}</span>{/if}</Tab>
      <Tab fill on={shown === "review"} onselect={() => pick("review")} title="The review's files and discussions">◆ Review<span class="gcount">{R.files.length}</span></Tab>
    </div>
  {/if}

  {#if shown === "review" && R}
    <!-- the review's files and discussions, one block like the work's (tinted with the review's colour) -->
    <div class="grev">
    <!-- the Review tab already names and counts these: no header of their own -->
    <div class="gsec">
      {#each R.files as f (f.path)}
        {@const nt = threadsOn(f.path)}
        <div class="gitrow"><button class="gitfile" onclick={() => openFile(pre + f.path)} title={f.path}><span class="mark rev {ST[f.st] ?? f.st}">{ST[f.st] ?? f.st}</span><span class="gname" class:gdel={f.st === "D"}>{nameOf(f.path)}</span><span class="gdir">{dirOf(f.path)}</span>{#if nt}<span class="gnum" title="{nt} discussion{nt > 1 ? 's' : ''} on it">💬 {nt}</span>{/if}</button></div>
      {/each}
    </div>
    {#if R.mr}
    {#snippet refreshT()}<button class="gall" disabled={thBusy} onclick={refreshThreads} title="Fetch the discussions again (they also refresh every two minutes)">{thBusy ? "…" : "↻"}</button>{/snippet}
    {@render head("discussions", R.threads?.length ?? 0, refreshT)}
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

  </div>
  {:else}
  <!-- the work: message, commit, staged and changes, one block (history is another) -->
  <div class="gwork">
  <!-- commit -->
  <div class="commitbox">
    <textarea rows="2" bind:value={message} disabled={gitBusy} placeholder={staged.length ? `Message (Ctrl+Enter commits ${staged.length} file${staged.length > 1 ? "s" : ""})` : "Message (stage files first)"}
      onkeydown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commit(); } }}></textarea>
    <button class="commitbtn" disabled={gitBusy || !staged.length || !message.trim()} onclick={commit}
      title={!staged.length ? "Nothing staged" : !message.trim() ? "Write a message first" : "Commit the staged files"}>{gitBusy ? "…" : "✓ Commit"}{staged.length ? ` ${staged.length} file${staged.length > 1 ? "s" : ""}` : ""}</button>
    {#if gitErr}<pre class="err">{gitErr}</pre>{/if}
  </div>

  {#if conflicts.length}
    {@render head("conflicts", conflicts.length)}
    <div class="gsec">{#each conflicts as f (f.path)}{@render row(f, "C", undefined, "+")}{/each}</div>
  {/if}
  <!-- a moved row shows where its file went: in the staged list, a file unstaged; in changes, one staged -->
  {#snippet stagedRow(p: string, moved: boolean)}{@const f = byPath.get(p)!}{#if moved}{@render row(f, letter(f.x === "?" ? "?" : f.y), counts.unstaged[p], "+", true)}{:else}{@render row(f, letter(f.x), counts.staged[p], "−")}{/if}{/snippet}
  {#snippet changeRow(p: string, moved: boolean)}{@const f = byPath.get(p)!}{#if moved}{@render row(f, letter(f.x), counts.staged[p], "−", true)}{:else}{@render row(f, letter(f.x === "?" ? "?" : f.y), counts.unstaged[p], "+")}{/if}{/snippet}
  <div class="glists" role="group" onpointerleave={release} onfocusout={leaving}>
  {#if lists.staged.length}
    {#snippet unstageAll()}<button class="gall" disabled={gitBusy} onclick={() => { release(); unstage(staged.map((f) => f.path)); }} title="Unstage all">− all</button>{/snippet}
    {@render head("staged", staged.length, unstageAll)}
    <div class="gsec">{#each lists.staged as x (x.path)}{@render stagedRow(x.path, x.moved)}{/each}</div>
  {/if}
  {#snippet stageAll()}{#if unstaged.length}<button class="gall" disabled={gitBusy} onclick={() => { release(); stage(unstaged.map((f) => f.path)); }} title="Stage all">+ all</button>{/if}{/snippet}
  {@render head("changes", unstaged.length, stageAll)}
  <div class="gsec">
    {#each lists.unstaged as x (x.path)}{@render changeRow(x.path, x.moved)}{:else}<div class="gempty">{L.status.length ? "everything is staged" : "working tree clean"}</div>{/each}
  </div>
  </div>
  </div>
  {/if}

  {@render head("history", 0)}
    <div class="graph gsec">
      {#if !commits}<div class="gempty">loading…</div>{/if}
      {#each rows as r (r.c.hash)}
        {@const rf = refsOf(r.c.refs)}
        {@const sw = switchable(r.c)}
        <div class="grow-wrap">
        {#if sw.length}<button class="gco raised" title={sw.length === 1 ? `Switch to ${sw[0]}` : `Switch to one of ${sw.join(", ")}`} aria-label="Switch branch" onclick={(e) => checkoutRow(e, r.c)}>
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M5 3v10M5 9c0-2 6-1 6-4.5M5 3.2a1.2 1.2 0 1 0 0 .1M11 4.3a1.2 1.2 0 1 0 0 .1M5 12.8a1.2 1.2 0 1 0 0 .1" /></svg>checkout</button>{/if}
        <button class="grow-row" class:sel={selSha === r.c.sha} onpointerenter={() => soonCommit(r.c.sha)} onclick={() => commitOf(r.c.sha)} oncontextmenu={(e) => openMenu(e, r.c)} title={r.c.sha + "  " + r.c.subject + "\n" + r.c.author + " · " + new Date(r.c.date).toLocaleString() + (r.c.refs.length ? "\n" + r.c.refs.join(", ") : "")}>
          {@html graphSvg(r, width)}
          <span class="msg">{#each rf.shown as x}<span class="ref" class:head={x.head} class:remote={x.remote} class:synced={x.synced} class:tag={x.tag} title={x.synced ? `${x.name} (same as origin/${x.name})` : x.tag ? "tag " + x.name : x.name}>{#if x.tag}<svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true"><path d="M2.5 2.5h5.2l5.8 5.8-5.2 5.2-5.8-5.8zM5.5 5.5h.01" /></svg>{:else}{x.name}{/if}</span>{/each}{#if rf.more}<span class="ref more" title={r.c.refs.join(", ")}>+{rf.more}</span>{/if}{r.c.subject}</span>
        </button>
        </div>
      {/each}
    </div>
    {#if swErr}<pre class="err gsw">{swErr}</pre>{:else if swNote}<div class="gmuted gsw">{swNote}</div>{/if}
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
