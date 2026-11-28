<script lang="ts">
  // The project's open merge requests (lib/mrs.svelte.ts, src/mrs.ts): stacks from their base down
  // (an MR on another merges after it), in your order, each with where it stands. Full in the
  // Merge requests tab; compact in the git panel's review picker (`compact`, one line each).
  //   Your order: drag a row (a stack moves as one; MRs on the same MR among themselves), or
  //   Alt+↑ / Alt+↓ on the focused row. ↑ ↓ move between rows, Enter reviews.
  //   Filters: all, the ones waiting on your review, yours. A filtered-out MR under a shown one stays, dimmed.
  import { loadMrs, mrsOf, setOrder } from "../lib/mrs.svelte";
  import { ago, bare, moved, need, rows as rowsOf, short, standing, stepped, type Row } from "../lib/mrstack";
  import type { Project } from "../lib/projects.svelte";
  import type { TrackedMr } from "../lib/types";
  import Tab from "./ui/Tab.svelte";

  let { p, compact = false, onpick, onall }: { p: Project; compact?: boolean; onpick: (m: TrackedMr) => void; onall?: () => void } = $props();

  const X = $derived(mrsOf(p.base, p.name));
  $effect(() => {
    const b = p.base, n = p.name;
    loadMrs(b, n);
    const t = setInterval(() => loadMrs(b, n, true), 120_000);
    return () => clearInterval(t);
  });
  const me = $derived(X.t?.me ?? null), list = $derived(X.t?.list ?? []);
  type Filter = "all" | "review" | "yours";
  let filter = $state<Filter>("all");
  const counts = $derived({ review: list.filter((m) => need(m, me) === "review").length, yours: list.filter((m) => need(m, me) === "yours").length });
  const shown = $derived(rowsOf(list, X.order, filter === "all" ? undefined : (m) => need(m, me) === filter));
  const reviewing = $derived(p.L.review?.mr?.id ?? null);

  const initials = (u: string) => u.split(/[._\-\s]+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");
  const STATE = { approved: "approved", changes: "asked for changes", reviewed: "commented", waiting: "hasn't reviewed yet" } as const;
  const approvals = (m: TrackedMr) => m.approvals && m.approvals.required ? `${m.approvals.required - m.approvals.left}/${m.approvals.required}` : "";
  const tip = (m: TrackedMr, r: Row) => [
    `${m.ref} ${m.title}`, `${m.source} → ${m.target}${r.parent ? ` (on ${r.parent.ref}: merges after it)` : ""}`,
    `by ${m.author} · opened ${ago(m.created)} ago · updated ${ago(m.updated)} ago`,
    m.blocker ? "can't merge yet: " + m.blocker : m.ready ? "ready to merge" : "",
    m.labels.length ? "labels: " + m.labels.join(", ") : "",
  ].filter(Boolean).join("\n");

  // ---- your order: drag, or Alt+↑↓ --------------------------------------------------------
  let dragging = $state<string | null>(null), over = $state<{ ref: string; after: boolean } | null>(null);
  const sibling = (a: string, b: string) => shown.find((r) => r.mr.ref === a)?.parent === shown.find((r) => r.mr.ref === b)?.parent;
  function dragOver(e: DragEvent, r: Row) {
    if (!dragging || dragging === r.mr.ref || !sibling(dragging, r.mr.ref)) { over = null; return; }
    e.preventDefault();
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
    over = { ref: r.mr.ref, after: e.clientY > box.top + box.height / 2 };
  }
  function drop(e: DragEvent) {
    e.preventDefault();
    if (dragging && over) setOrder(p.base, p.name, moved(X.order.length ? X.order : shown.map((r) => r.mr.ref), rowsOf(list, X.order), dragging, over.ref, over.after));
    dragging = null; over = null;
  }
  let listEl: HTMLElement | undefined = $state();
  function keys(e: KeyboardEvent, r: Row, i: number) {
    if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      setOrder(p.base, p.name, stepped(X.order.length ? X.order : shown.map((x) => x.mr.ref), rowsOf(list, X.order), r.mr.ref, e.key === "ArrowUp" ? -1 : 1));
      requestAnimationFrame(() => listEl?.querySelector<HTMLElement>(`[data-ref="${CSS.escape(r.mr.ref)}"]`)?.focus());
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      listEl?.querySelectorAll<HTMLElement>(".mrrow2")[i + (e.key === "ArrowUp" ? -1 : 1)]?.focus();
    } else if (e.key === "Enter" && e.target === e.currentTarget) { e.preventDefault(); onpick(r.mr); }
  }
</script>

<div class="mrs" class:compact>
  {#if !compact}
    <div class="mrhead">
      <h3>Merge requests</h3>
      <div class="segs mrfilter" role="tablist">
        <Tab on={filter === "all"} onselect={() => (filter = "all")}>All<span class="gcount">{list.length}</span></Tab>
        <Tab on={filter === "review"} onselect={() => (filter = "review")} title="Waiting on your review">To review<span class="gcount">{counts.review}</span></Tab>
        <Tab on={filter === "yours"} onselect={() => (filter = "yours")} title="Opened by you">Yours<span class="gcount">{counts.yours}</span></Tab>
      </div>
      <span class="grow"></span>
      {#if X.t}<span class="muted mrat">updated {ago(new Date(X.t.at).toISOString())} ago</span>{/if}
      <button class="gicon" class:busy={X.loading} disabled={X.loading} onclick={() => loadMrs(p.base, p.name, true)} title="Ask the forge again (it refreshes every two minutes on its own)" aria-label="Refresh">{#if X.loading}<span class="spin"></span>{:else}↻{/if}</button>
    </div>
  {:else}
    <div class="mrhead">
      {#if counts.review}<span class="mrneed review" title="Waiting on your review">{counts.review} to review</span>{/if}
      <span class="grow"></span>
      {#if onall}<button class="link mrall" onclick={onall} title="All of them in a tab, with your order and where each stands">open all ↗</button>{/if}
    </div>
  {/if}

  {#if !X.t}<div class="gempty"><span class="spin"></span> asking the forge…</div>
  {:else if X.t.error && !list.length}<div class="gempty err" title={X.t.error}>{X.t.error}</div>
  {:else if !shown.length}<div class="gempty">{filter === "review" ? "nothing waiting on your review" : filter === "yours" ? "none of yours open" : "no open merge requests"}</div>{/if}

  <div class="mrlist2" bind:this={listEl} role="listbox" aria-label="Open merge requests" tabindex="-1" ondragover={(e) => dragging && e.preventDefault()} ondrop={drop}>
    {#each shown as r, i (r.mr.ref)}
      {@const m = r.mr}
      {@const s = standing(m)}
      {@const n = need(m, me)}
      <div class="mrrow2" role="option" aria-selected={reviewing === m.id} tabindex="0" data-ref={m.ref}
        class:dim={r.dim} class:on={reviewing === m.id} class:drag={dragging === m.ref}
        class:dropbefore={over?.ref === m.ref && !over.after} class:dropafter={over?.ref === m.ref && over.after}
        draggable={!compact} ondragstart={(e) => { dragging = m.ref; e.dataTransfer?.setData("text/plain", m.ref); }} ondragend={() => { dragging = null; over = null; }}
        ondragover={(e) => dragOver(e, r)} ondrop={drop} onkeydown={(e) => keys(e, r, i)}
        ondblclick={() => onpick(m)} onclick={() => compact && onpick(m)} title={tip(m, r)} style:--depth={Math.min(r.depth, 4)}>
        {#if !compact}<span class="mrgrip" aria-hidden="true"><svg viewBox="0 0 16 16" width="12" height="12"><path d="M6 4h.01M10 4h.01M6 8h.01M10 8h.01M6 12h.01M10 12h.01" /></svg></span>{/if}
        <span class="mrmain">
          {#if r.depth}<span class="mrel" aria-hidden="true"></span>{/if}
          <span class="mrref">{m.ref}</span><span class="mrtitle">{bare(m.title)}</span>
          {#if n === "review"}<span class="mrneed review" title="Waiting on your review">review</span>{:else if n === "yours" && !compact}<span class="mrneed yours" title="Opened by you">yours</span>{/if}
        </span>
        {#if compact}
          <span class="mrdot {s.tone}" title={s.word}></span>
        {:else}
          <span class="mrstate {s.tone}" title={s.word === "—" ? "GitLab hasn't checked whether it can merge yet (it does when someone opens it)" : ""}>{s.word}</span>
          <span class="mrci {m.ci ?? ''}" title={m.ci === "pass" ? "CI passed" : m.ci === "fail" ? "CI failed" : m.ci === "running" ? "CI running" : "no pipeline"}></span>
          <span class="mrrev" title={m.reviewers.length ? m.reviewers.map((x) => `${x.name}: ${STATE[x.state]}`).join("\n") : "no reviewers"}>
            {#each m.reviewers.slice(0, 4) as x}<span class="mrav {x.state}" class:me={x.name === me}>{initials(x.name)}</span>{/each}{#if m.reviewers.length > 4}<span class="mrmore">+{m.reviewers.length - 4}</span>{/if}
            {#if approvals(m)}<span class="mrappr" class:ok={m.approved}>{approvals(m)}</span>{/if}
          </span>
          <span class="mrthr" title={m.threads ? `${m.threads.open} open discussion${m.threads.open === 1 ? "" : "s"} of ${m.threads.all}` : ""}>{#if m.threads?.open}💬 {m.threads.open}{/if}</span>
          <span class="mrsize" title={m.size ? `${m.size.files} file${m.size.files === 1 ? "" : "s"}` : ""}>{#if m.size}<i class="a">+{short(m.size.add)}</i> <i class="d">−{short(m.size.del)}</i>{/if}</span>
          <span class="mrwho" title={`${m.author}, updated ${ago(m.updated)} ago`}>{initials(m.author)} · {ago(m.updated)}</span>
          <span class="mracts">
            <button class="gicon" onclick={(e) => { e.stopPropagation(); onpick(m); }} title={reviewing === m.id ? "Being reviewed" : `Review ${m.ref}: check it out and see what it changes`} disabled={reviewing === m.id} aria-label="Review">◆</button>
            <a class="gicon" href={m.url} target="_blank" rel="noreferrer" title={`Open ${m.ref} on ${X.t?.forge === "github" ? "GitHub" : "GitLab"}`} aria-label="Open on the forge" onclick={(e) => e.stopPropagation()}>↗</a>
          </span>
        {/if}
      </div>
    {/each}
  </div>
  {#if !compact && list.length}<p class="mrhint muted">Drag to set your order: a stack moves as one. Alt+↑ / Alt+↓ moves the selected one. Double-click or ◆ reviews.</p>{/if}
</div>
