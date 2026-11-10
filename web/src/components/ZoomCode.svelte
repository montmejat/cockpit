<script lang="ts">
  // The deepest level of the map: the code of one box, cut to its own functions.
  import { anchorChanged, openFile, S, tldr, where } from "../lib/state.svelte";
  import { api, hlLines, langOf } from "../lib/code";
  import type { DiagramNode } from "../lib/types";

  let { node }: { node: DiagramNode } = $props();
  let texts: Record<string, string> = $state({});

  const parts = $derived((node.anchors ?? []).map((a) => ({ a, w: where(a) })).filter((x) => x.w) as { a: string; w: NonNullable<ReturnType<typeof where>> }[]);
  // Load each file once, and again when it changes on disk.
  $effect(() => {
    for (const { w } of parts) {
      const rev = S.fileRevs[w.file] ?? S.git.head, key = w.file + "@" + rev;
      if (key in texts) continue;
      api.get("api/file?path=" + encodeURIComponent(w.file)).then((r) => (texts[key] = r.text ?? "")).catch(() => (texts[key] = ""));
    }
  });
  const textOf = (file: string) => texts[file + "@" + (S.fileRevs[file] ?? S.git.head)];
  const slice = (file: string, line?: number, end?: number) => {
    const lines = hlLines((textOf(file) ?? "").replace(/\n$/, ""), langOf(file));
    const from = line ? Math.max(1, line) : 1, to = line ? Math.min(lines.length, end ?? line) : Math.min(lines.length, 40);
    return { from, rows: lines.slice(from - 1, to), more: !line && lines.length > to ? lines.length - to : 0 };
  };
</script>

<div class="zcard">
  <div class="zhead"><b>{node.label}</b><span class="muted"> · {tldr(node, node.explain)}</span></div>
  <div class="zbody">
    {#each parts as { a, w } (a)}
      <div class="zpart">
        <div class="zfile">
          <button class="link" onclick={() => openFile(w.file, w.line, w.end)}>{a}</button>
          {#if anchorChanged(a)}<span class="chg"> ● changed</span>{/if}
          <span class="muted"> · {w.file}{w.line ? ":" + w.line : ""}</span>
        </div>
        {#if textOf(w.file) === undefined}<p class="dnote">loading…</p>
        {:else}
          {@const s = slice(w.file, w.line, w.end)}
          <table class="code"><tbody>
            {#each s.rows as l, i}<tr><td class="ln">{s.from + i}</td><td class="c">{@html l}</td></tr>{/each}
          </tbody></table>
          {#if s.more}<p class="dnote">… {s.more} more lines: open the file</p>{/if}
        {/if}
      </div>
    {:else}
      <p class="dnote">No code linked.</p>
    {/each}
  </div>
</div>
