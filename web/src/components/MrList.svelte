<script lang="ts">
  // The project's open merge requests (lib/mrs.svelte.ts, src/mrs.ts): stacks from their base down
  // (an MR on another merges after it), in your order, each with where it stands. Full in the
  // Merge requests tab; compact in the git panel's review picker (`compact`, one line each).
  //   Your order: drag a row (a stack moves as one; MRs on the same MR among themselves), or
  //   Alt+k / Alt+j on the focused row. j k move between rows, Enter reviews (arrows work too).
  //   Filters: all, the ones waiting on your review, yours. A filtered-out MR under a shown one stays, dimmed.
  import { loadMrs, mrsOf, setOrder } from "../lib/mrs.svelte";
  import { ago, aside, bare, blocks, landing, moved, slot, need, rows as rowsOf, short, standing, stepped, type Row } from "../lib/mrstack";
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

  // ---- your order: drag (pointer), or Alt+j / Alt+k ------------------------------------------
  // The dragged MR, with the ones stacked on it, lifts and slides into the slot under the pointer;
  // its siblings slide aside to make room (nothing overlaps); on release it stays there. Starts
  // after a few pixels, so a click stays a click.
  type Drag = { ref: string; y0: number; scroll0: number; spans: [number, number][]; refs: string[]; at: number; to: number; h: number; hs: number[]; mids: number[] };
  let drag = $state<Drag | null>(null), settling = $state(false);
  let press: { ref: string; y: number; id: number; el: HTMLElement } | null = null;
  const scroller = () => listEl?.closest<HTMLElement>(".mrtab") ?? null;
  function down(e: PointerEvent, r: Row) {
    if (compact || e.button !== 0 || (e.target as Element).closest("button, a")) return;
    press = { ref: r.mr.ref, y: e.clientY, id: e.pointerId, el: e.currentTarget as HTMLElement };
  }
  function begin(e: PointerEvent) {
    const b = blocks(shown, press!.ref), els = [...(listEl?.querySelectorAll<HTMLElement>(".mrrow2") ?? [])];
    if (!b || b.refs.length < 2 || !els.length) { press = null; return; }
    const box = (k: number) => els[k].getBoundingClientRect();
    const top = (sp: [number, number]) => box(sp[0]).top, bottom = (sp: [number, number]) => box(sp[1]).bottom;
    const sp = b.spans[b.at];
    const hs = b.spans.map((s) => bottom(s) - top(s));
    drag = {
      ref: press!.ref, y0: press!.y, scroll0: scroller()?.scrollTop ?? 0, spans: b.spans, refs: b.refs, at: b.at, to: b.at,
      h: hs[b.at], hs, mids: b.spans.map((s) => (top(s) + bottom(s)) / 2),
    };
    press!.el.setPointerCapture(e.pointerId);
  }
  function move(e: PointerEvent) {
    if (press && !drag && !(e.buttons & 1)) { press = null; return; } // released elsewhere before it started
    if (press && !drag && Math.abs(e.clientY - press.y) > 4) begin(e);
    if (!drag) return;
    const sc = scroller();
    // near the scroller's edge: scroll along
    if (sc) { const r = sc.getBoundingClientRect(); if (e.clientY < r.top + 40) sc.scrollTop -= 12; else if (e.clientY > r.bottom - 40) sc.scrollTop += 12; }
    // where the pointer is, in the list as it was when the drag began
    const y = drag.mids[drag.at] + e.clientY - drag.y0 + (sc?.scrollTop ?? 0) - drag.scroll0;
    drag.to = landing(drag.mids, drag.at, y);
  }
  function up() {
    const d = drag;
    press = null;
    if (!d) return;
    if (d.to !== d.at) {
      // the new place shows at once, with no slide back from where the rows were pushed aside
      settling = true;
      setOrder(p.base, p.name, moved(X.order.length ? X.order : shown.map((r) => r.mr.ref), rowsOf(list, X.order), d.ref, d.refs[d.to], d.to > d.at));
      requestAnimationFrame(() => requestAnimationFrame(() => (settling = false)));
    }
    drag = null;
  }
  // How far row i moves while dragging: with the dragged block, or aside for it.
  function offset(i: number): number {
    if (!drag) return 0;
    const k = drag.spans.findIndex(([a, b]) => i >= a && i <= b);
    if (k < 0) return 0;
    return k === drag.at ? slot(drag.hs, drag.at, drag.to) : aside(k, drag.at, drag.to, drag.h);
  }
  const lifted = (i: number) => !!drag && drag.spans[drag.at][0] <= i && i <= drag.spans[drag.at][1];
  let listEl: HTMLElement | undefined = $state();
  function keys(e: KeyboardEvent, r: Row, i: number) {
    if (e.ctrlKey || e.metaKey) return;
    const up = e.key === "k" || e.key === "K" || e.key === "ArrowUp", down = e.key === "j" || e.key === "J" || e.key === "ArrowDown";
    if (e.altKey && (up || down)) {
      e.preventDefault();
      setOrder(p.base, p.name, stepped(X.order.length ? X.order : shown.map((x) => x.mr.ref), rowsOf(list, X.order), r.mr.ref, up ? -1 : 1));
      requestAnimationFrame(() => listEl?.querySelector<HTMLElement>(`[data-ref="${CSS.escape(r.mr.ref)}"]`)?.focus());
    } else if (up || down) {
      e.preventDefault();
      listEl?.querySelectorAll<HTMLElement>(".mrrow2")[i + (up ? -1 : 1)]?.focus();
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
  {/if}

  {#if !X.t}<div class="gempty"><span class="spin"></span> asking the forge…</div>
  {:else if X.t.error && !list.length}<div class="gempty err" title={X.t.error}>{X.t.error}</div>
  {:else if !shown.length}<div class="gempty">{filter === "review" ? "nothing waiting on your review" : filter === "yours" ? "none of yours open" : "no open merge requests"}</div>{/if}

  <div class="mrlist2" class:dragging={!!drag} bind:this={listEl} role="listbox" aria-label="Open merge requests" tabindex="-1">
    {#each shown as r, i (r.mr.ref)}
      {@const m = r.mr}
      {@const s = standing(m)}
      {@const n = need(m, me)}
      <div class="mrrow2" role="option" aria-selected={reviewing === m.id} tabindex="0" data-ref={m.ref}
        class:dim={r.dim} class:on={reviewing === m.id} class:lifted={lifted(i)} class:still={settling}
        style:transform={drag && offset(i) ? `translateY(${offset(i)}px)` : null}
        onpointerdown={(e) => down(e, r)} onpointermove={move} onpointerup={up} onpointercancel={up} onkeydown={(e) => keys(e, r, i)}
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
  <!-- compact: all of them in a tab, as the list's quiet last line -->
  {#if compact && onall && list.length}<button class="mrall" onclick={onall} title="All of them in a tab, with your order and where each stands">
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M9.5 2.5h4v4M13.5 2.5 8 8M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3" /></svg>Open all in a tab</button>{/if}
</div>
