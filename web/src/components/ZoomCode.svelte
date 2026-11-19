<script lang="ts">
  // The deepest level of the map: the code of one box, cut to its own functions. What changed in
  // them shows in place, the whole function kept around it: lines added or changed are marked, the
  // old lines appear where they were removed. In review mode that is everything the branch changes
  // against its target (as the editor shows it), otherwise the uncommitted edits.
  import { C, anchorChanged, explainChanges, openFile, S, tldr, where } from "../lib/state.svelte";
  import { api, hlLines, langOf } from "../lib/code";
  import type { DiagramNode, Hunk } from "../lib/types";

  let { node, diagram }: { node: DiagramNode; diagram?: string } = $props();
  type Src = { text: string; hunks: Hunk[] };
  let srcs: Record<string, Src> = $state({});

  const parts = $derived((node.anchors ?? []).map((a) => ({ a, w: where(a) })).filter((x) => x.w) as { a: string; w: NonNullable<ReturnType<typeof where>> }[]);
  const base = $derived(S.review?.base ?? "");
  // Load each file once, and again when it changes on disk, HEAD moves, or a review starts or ends.
  const keyOf = (file: string) => file + "@" + (S.fileRevs[file] ?? S.git.head) + "@" + base;
  $effect(() => {
    for (const { w } of parts) {
      const key = keyOf(w.file);
      if (key in srcs) continue;
      api.get("api/file?path=" + encodeURIComponent(w.file) + (base ? "&review=1" : ""))
        .then((r) => (srcs[key] = { text: r.text ?? "", hunks: r.hunks ?? [] }))
        .catch(() => (srcs[key] = { text: "", hunks: [] }));
    }
  });
  const srcOf = (file: string): Src | undefined => srcs[keyOf(file)];

  type Row = { kind: "ctx" | "add" | "del"; n?: number; html: string };
  // The part's lines, with the changes inside it: removed lines before the line they were removed at,
  // added or changed lines marked. A whole module shows the whole file when it changed, else its start.
  function rowsOf(file: string, line?: number, end?: number) {
    const src = srcOf(file)!, lang = langOf(file);
    const lines = hlLines(src.text.replace(/\n$/, ""), lang);
    const changed = src.hunks.length > 0;
    const from = line ? Math.max(1, line) : 1;
    const to = line ? Math.min(lines.length, end ?? line) : changed ? lines.length : Math.min(lines.length, 40);
    const inside = src.hunks.filter((h) => h.at + Math.max(h.added, 1) - 1 >= from && h.at <= to);
    const rows: Row[] = [];
    let adds = 0, dels = 0;
    for (let i = from; i <= to; i++) {
      for (const h of inside) if (h.at === i && h.removed.length) {
        hlLines(h.removed.join("\n"), lang).forEach((html) => rows.push({ kind: "del", html }));
        dels += h.removed.length;
      }
      const add = inside.some((h) => i >= h.at && i < h.at + h.added);
      if (add) adds++;
      rows.push({ kind: add ? "add" : "ctx", n: i, html: lines[i - 1] ?? "" });
    }
    return { rows, adds, dels, more: !line && !changed && lines.length > to ? lines.length - to : 0 };
  }
  // Changed in the review, or (outside one) not committed.
  const changedHere = (a: string) => (S.review ? anchorChanged(a, C.rFiles, C.rItems) : anchorChanged(a));
  const anyChange = $derived(parts.some(({ a }) => changedHere(a)));
</script>

<div class="zcard">
  <div class="zhead">
    <b>{node.label}</b><span class="muted"> · {tldr(node, node.explain)}</span>
    {#if anyChange}<button class="zexplain" title={"Ask the chat's agent what " + (S.review ? "this review" : "the uncommitted edits") + " changed in this code, and what to look at"} onclick={() => explainChanges(node, diagram)}>explain the changes</button>{/if}
  </div>
  <div class="zbody">
    {#each parts as { a, w } (a)}
      {@const src = srcOf(w.file)}
      {@const s = src ? rowsOf(w.file, w.line, w.end) : null}
      <div class="zpart">
        <div class="zfile">
          <button class="link" onclick={() => openFile(w.file, w.line, w.end)}>{a}</button>
          {#if changedHere(a)}<span class={S.review ? "rev" : "chg"}> {S.review ? "◆ changed in this review" : "● changed"}</span>{/if}
          {#if s && (s.adds || s.dels)}<span class="zstat">{#if s.adds}<span class="a">+{s.adds}</span>{/if}{#if s.dels}<span class="d">−{s.dels}</span>{/if}</span>{/if}
          <span class="muted"> · {w.file}{w.line ? ":" + w.line : ""}</span>
        </div>
        {#if !s}<p class="dnote">loading…</p>
        {:else}
          <table class="code"><tbody>
            {#each s.rows as r}<tr class={r.kind === "ctx" ? "" : r.kind}><td class="ln">{r.n ?? ""}</td><td class="sg">{r.kind === "add" ? "+" : r.kind === "del" ? "−" : ""}</td><td class="c">{@html r.html}</td></tr>{/each}
          </tbody></table>
          {#if s.more}<p class="dnote">… {s.more} more lines: open the file</p>{/if}
        {/if}
      </div>
    {:else}
      <p class="dnote">No code linked.</p>
    {/each}
  </div>
</div>
