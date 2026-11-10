<script lang="ts">
  // Git, read only: the branch and how it stands against its upstream, what isn't committed, and
  // the history of all branches as a graph.
  import { api } from "../lib/code";
  import { graphRows, graphSvg } from "../lib/graph";
  import { cur, openCommit, openFile, S, statusOf } from "../lib/state.svelte";
  import type { Commit } from "../lib/types";

  let commits: Commit[] | null = $state(null);
  // Reload the history when HEAD or the branches move.
  $effect(() => { void S.git.head; void S.git.ahead; void S.git.behind; api.get<Commit[]>("api/git/graph").then((c) => (commits = c)).catch(() => {}); });
  const rows = $derived(commits ? graphRows(commits) : []);
  const width = $derived(18 + 12 * Math.max(1, ...rows.map((r) => Math.max(r.before.length, r.after.length))));
  const selSha = $derived(cur().kind === "commit" ? (cur() as { sha: string }).sha : null);
  const g = $derived(S.git);
</script>

<div class="gitpane">
  <div class="sec">
    <b>⎇ {g.branch ?? "detached"}</b> <span class="muted">at {g.head}</span>
    <div class="muted">
      {#if g.upstream}{g.upstream}: {#if g.ahead || g.behind}{g.ahead ? g.ahead + " to push" : ""}{g.ahead && g.behind ? ", " : ""}{g.behind ? g.behind + " to pull" : ""}{:else}in sync{/if}
      {:else}no upstream{/if}
    </div>
  </div>
  <div class="sec"><h4>not committed{S.status.length ? " · " + S.status.length : ""}</h4></div>
  {#each S.status as f (f.path)}
    <button class="gitfile" onclick={() => openFile(f.path)} title={f.path}><span class="mark {statusOf(f.path)}">{statusOf(f.path)}</span>{f.path}</button>
  {:else}
    <div class="sec muted">clean</div>
  {/each}
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
