<script lang="ts">
  // The Merge requests tab: the project's open MRs in full (MrList.svelte). Reviewing one checks it
  // out and starts the review, as the git panel's picker does, then shows the git panel, where the
  // review's files and discussions are.
  import MrList from "./MrList.svelte";
  import { api } from "../lib/code";
  import { cur, ui } from "../lib/state.svelte";
  import { projectNamed } from "../lib/projects.svelte";
  import type { TrackedMr } from "../lib/types";

  const t = $derived(cur());
  const p = $derived(projectNamed(t.kind === "mrs" ? t.project : undefined));
  let busy = $state(""), err = $state("");
  async function review(m: TrackedMr) {
    if (busy) return;
    busy = `checking out ${m.source}…`; err = "";
    const r = await api.post(p.base + "api/review/start", { mr: m }).catch((e) => ({ error: String(e) }));
    busy = "";
    if (r?.error) err = r.error; else ui.side = "git";
  }
</script>

<div class="dbody mrtab">
  {#if busy}<p class="mrbusy"><span class="spin"></span> {busy}</p>{/if}
  {#if err}<pre class="err mrerr">{err}</pre>{/if}
  <MrList {p} onpick={review} />
</div>
