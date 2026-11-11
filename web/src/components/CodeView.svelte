<script lang="ts">
  // The open file or commit, in the center.
  //   A file shows its uncommitted changes in place, like an editor: a bar in the margin by lines
  //   added (green) or changed (blue), a red mark where lines were removed. Click a mark to see the
  //   old lines; "show removed" shows them all. It follows the file live while an agent edits it.
  //   A commit shows its patch.
  import MiniMap from "./MiniMap.svelte";
  import { api, hlLines, langOf, parsePatch } from "../lib/code";
  import { cur, openFile, S, statusOf, store } from "../lib/state.svelte";
  import type { Hunk } from "../lib/types";

  type FileData = { path: string; text: string | null; note?: string; error?: string; hunks: Hunk[] };
  type CommitData = { sha: string; subject: string; author: string; date: string; body: string; patch: string; error?: string };

  const tab = $derived(cur());
  const path = $derived(tab.kind === "file" ? tab.path : null);
  const sha = $derived(tab.kind === "commit" ? tab.sha : null);
  // The file is loaded again when it changes on disk, when HEAD moves, or when a review starts or
  // ends (in review mode its changes are against the review's target, not the last commit).
  const rev = $derived(path ? (S.fileRevs[path] ?? 0) + "@" + S.git.head + "@" + (statusOf(path) ?? "") + "@" + (S.review?.base ?? "") : "");

  // Recent files, so switching tabs shows them at once; the last version stays on screen while
  // a new one loads.
  const files = new Map<string, { rev: string; data: FileData }>();
  let file: FileData | null = $state(null);
  let commit: CommitData | null = $state(null);
  let body: HTMLElement | undefined = $state();
  const scrolls = new Map<string, number>(); // where each tab was scrolled to

  $effect(() => {
    if (!path) return;
    const p = path, r = rev, hit = files.get(p);
    if (hit) file = hit.data; else if (file?.path !== p) file = null;
    if (hit?.rev === r) return;
    api.get<FileData>("api/file?path=" + encodeURIComponent(p) + (S.review?.base ? "&review=1" : "")).then((data) => {
      files.set(p, { rev: r, data });
      if (files.size > 12) files.delete(files.keys().next().value!);
      if (path === p) file = data;
    }).catch(() => {});
  });
  $effect(() => {
    if (!sha) return;
    const s = sha;
    if (commit?.sha.startsWith(s)) return;
    commit = null;
    api.get<CommitData>("api/git/commit?sha=" + encodeURIComponent(s)).then((c) => { if (sha === s) commit = c; });
  });

  // ---- the file, with its changes ------------------------------------------------

  let showAll = $state(store.get("cockpit-show-removed", "0") === "1");
  let opened: Record<string, boolean> = $state({});
  const hunkKey = (h: Hunk) => h.at + ":" + h.added + ":" + h.removed.length;

  type Row = { key: string; kind: "line" | "del"; n?: number; html: string; mark?: "add" | "mod"; delBefore?: Hunk; hunk?: Hunk };
  const lang = $derived(path ? langOf(path) : null);
  const lines = $derived(file?.text != null ? hlLines(file.text.replace(/\n$/, ""), lang) : []);
  const rows = $derived.by(() => {
    if (!file || file.text == null) return [];
    const marks = new Map<number, "add" | "mod">(), delAt = new Map<number, Hunk>(), inHunk = new Map<number, Hunk>();
    for (const h of file.hunks) {
      for (let k = 0; k < h.added && h.at + k <= lines.length; k++) { marks.set(h.at + k, h.removed.length ? "mod" : "add"); inHunk.set(h.at + k, h); }
      if (h.removed.length) delAt.set(h.at, h);
    }
    const out: Row[] = [];
    const removed = (h: Hunk) => {
      if (!(showAll || opened[hunkKey(h)])) return;
      h.removed.forEach((l, i) => out.push({ key: `d${h.at}:${i}`, kind: "del", html: hlLines(l, lang)[0] ?? "" }));
    };
    lines.forEach((html, i) => {
      const n = i + 1, h = delAt.get(n);
      if (h) removed(h);
      out.push({ key: "L" + n, kind: "line", n, html, mark: marks.get(n), delBefore: h && !h.added ? h : undefined, hunk: inHunk.get(n) ?? (h && !h.added ? h : undefined) });
    });
    const tail = delAt.get(lines.length + 1);
    if (tail) removed(tail);
    return out;
  });
  const hunkAt = $derived(new Map((file?.hunks ?? []).map((h) => [h.at, h])));
  const changes = $derived((file?.hunks ?? []).filter((h) => h.added < 1e9));

  // Requested lines (from a diagram link or a test) are highlighted and scrolled to.
  const want = $derived(tab.kind === "file" ? { a: tab.line ?? -1, b: tab.end ?? tab.line ?? -1 } : { a: -1, b: -1 });
  let placed = "";
  $effect(() => {
    if (!path || !rows.length || !body) return;
    const key = path + ":" + (tab.kind === "file" ? tab.line ?? "" : "");
    if (placed === key) return;
    placed = key;
    queueMicrotask(() => {
      if (tab.kind === "file" && tab.line) body.querySelector(`[data-n="${tab.line}"]`)?.scrollIntoView({ block: "center" });
      else if (body) body.scrollTop = scrolls.get(path!) ?? 0;
      visible();
    });
  });

  function jump(dir: 1 | -1) {
    if (!body) return;
    const top = body.scrollTop + 40, rowsEls = [...body.querySelectorAll<HTMLElement>("tr.first")];
    const target = dir > 0 ? rowsEls.find((r) => r.offsetTop > top + 4) : rowsEls.reverse().find((r) => r.offsetTop < top - 4);
    (target ?? (dir > 0 ? rowsEls[0] : rowsEls.at(-1)))?.scrollIntoView({ block: "center", behavior: "smooth" });
  }
  const firstOfHunk = (r: Row) => r.kind === "line" && r.n && (hunkAt.has(r.n) && (r.mark || r.delBefore));

  // ---- the floating diagram: which lines are on screen, which box is hovered ----------

  let view = $state<[number, number]>([0, 0]);
  let boxLines = $state<[number, number][]>([]);
  let tick = 0;
  function visible() {
    if (!body) return;
    const box = body.getBoundingClientRect();
    let lo = Infinity, hi = -Infinity;
    for (const tr of body.querySelectorAll<HTMLElement>("tr[data-n]")) {
      const r = tr.getBoundingClientRect();
      if (r.bottom < box.top) continue;
      if (r.top > box.bottom) break;
      lo = Math.min(lo, +tr.dataset.n!); hi = Math.max(hi, +tr.dataset.n!);
    }
    view = [lo, hi];
  }
  function scrolled() {
    if (path && body) scrolls.set(path, body.scrollTop);
    cancelAnimationFrame(tick); tick = requestAnimationFrame(visible);
  }
  const inBox = (n?: number) => !!n && boxLines.some(([a, b]) => n >= a && n <= b);
  const files_ = $derived(commit ? parsePatch(commit.patch) : []);
</script>

<section id="codeview">
  {#if path}
    <div class="dhead">
      <span class="path">{path}</span>
      {#if statusOf(path)}<span class="mark {statusOf(path)}">{statusOf(path)}</span>{/if}
      {#if changes.length}
        <span class="grow"></span>
        <span class="muted">{changes.length} change{changes.length > 1 ? "s" : ""}{S.review?.base && file?.path === path ? " vs " + S.review.target : ""}</span>
        <button title="Previous change" onclick={() => jump(-1)}>↑</button><button title="Next change" onclick={() => jump(1)}>↓</button>
        <label class="muted toggle"><input type="checkbox" bind:checked={showAll} onchange={() => store.set("cockpit-show-removed", showAll ? "1" : "0")}> show removed</label>
      {/if}
    </div>
    <div class="dbody" bind:this={body} onscroll={scrolled}>
      {#if !file}<p class="dnote">loading…</p>
      {:else if file.error || file.text == null}<p class="dnote">{file.error ?? file.note}</p>
      {:else}
        <table class="code"><tbody>
          {#each rows as r (r.key)}
            {#if r.kind === "del"}
              <tr class="del"><td class="ln"></td><td class="gut"><span class="g del"></span></td><td class="c">{@html r.html}</td></tr>
            {:else}
              {@const h = r.hunk}
              <tr data-n={r.n} class:hl={r.n! >= want.a && r.n! <= want.b} class:chg={!!r.mark} class:boxhl={inBox(r.n)} class:first={firstOfHunk(r)}>
                <td class="ln">{r.n}</td>
                <td class="gut">
                  {#if r.mark || r.delBefore}
                    {#if h?.removed.length}
                      <button class="g {r.mark ?? ''}" class:delmark={!!r.delBefore} title={opened[hunkKey(h)] || showAll ? "Hide the removed lines" : `Show the ${h.removed.length} removed line${h.removed.length > 1 ? "s" : ""}`}
                        onclick={() => (opened[hunkKey(h)] = !opened[hunkKey(h)])}></button>
                    {:else}<span class="g {r.mark ?? ''}"></span>{/if}
                  {/if}
                </td>
                <td class="c">{@html r.html}</td>
              </tr>
            {/if}
          {/each}
        </tbody></table>
      {/if}
    </div>
    <MiniMap {path} {view} onlines={(ls) => (boxLines = ls)} onjump={(n) => body?.querySelector(`[data-n="${n}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" })} />
  {:else if sha}
    <div class="dhead"><span class="path">commit {sha}</span></div>
    <div class="dbody">
      {#if !commit}<p class="dnote">loading…</p>
      {:else if commit.error}<p class="dnote">{commit.error}</p>
      {:else}
        <div class="commitmeta"><b>{commit.subject}</b><div class="muted">{commit.author} · {new Date(commit.date).toLocaleString()} · {commit.sha.slice(0, 10)}</div>{#if commit.body}<pre>{commit.body}</pre>{/if}</div>
        {#each files_ as f (f.path)}
          <div class="fhead"><button class="link" onclick={() => openFile(f.path)}>{f.path}</button></div>
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
