<script lang="ts">
  // Ctrl+P opens a file by name (letters in order, not necessarily together: "srvts" finds
  // src/serve.ts); Ctrl+Shift+F searches the whole project (ripgrep), as text or as a regex.
  // In a workspace both cover every project: another project's files show (and match) with its
  // name in front, and open in it. ↑ ↓ choose, Enter opens, Esc closes.
  import { tick } from "svelte";
  import { api, esc } from "../lib/code";
  import { connectLive, liveOf, loaded, openTab, P, projectNames, store, tabProject, ui } from "../lib/state.svelte";

  type Hit = { project: string; path: string; line: number; col: number; text: string };
  const multi = projectNames.length > 1;
  // How a file is shown and matched: another project's with its name in front.
  const label = (project: string, path: string) => (multi && project !== P.active ? project + "/" + path : path);
  let mode: "files" | "search" | null = $state(null);
  let q = $state("");
  let sel = $state(0);
  let input: HTMLInputElement | undefined = $state();
  let list: HTMLElement | undefined = $state();
  let caseSens = $state(store.get("cockpit-search-case", "0") === "1");
  let regex = $state(store.get("cockpit-search-regex", "0") === "1");
  let hits: Hit[] = $state([]);
  let searching = $state(false);
  let searched = $state("");
  let searchError = $state(""); // the search couldn't run (no ripgrep, say)

  export async function open(m: "files" | "search") {
    mode = m; q = m === "search" ? searched : ""; sel = 0;
    for (const p of projectNames) void connectLive(p); // their file lists
    // A word selected in the editor is what you search for.
    const sel_ = m === "search" ? editor()?.selected() : "";
    if (sel_) q = sel_;
    await tick();
    input?.focus(); input?.select();
    if (m === "search" && q) run();
  }
  // The open file's editor (FileEditor.svelte), when one is showing.
  const editor = () => (window as any).__cockpitEditor as { selected: () => string; focus: () => void } | null;
  function close() { mode = null; editor()?.focus(); }

  // ---- files: subsequence match, scored ----------------------------------------
  // Letters matched at the start of a name part or right after the previous one count more;
  // matches in the file name more than in its folders; open tabs come first on ties.
  function score(path: string, query: string): { s: number; at: number[] } | null {
    const p = path.toLowerCase(), base = p.lastIndexOf("/") + 1, at: number[] = [];
    let s = 0, i = 0;
    for (const ch of query) {
      const j = p.indexOf(ch, i);
      if (j < 0) return null;
      s += 1 + (j === i && at.length ? 3 : 0) + (j === 0 || "/._-".includes(p[j - 1]) ? 4 : 0) + (j >= base ? 2 : 0);
      at.push(j); i = j + 1;
    }
    return { s: s - path.length * 0.01, at };
  }
  type Row = { project: string; path: string; label: string; at: number[]; s: number };
  // Every file of every project loaded so far, the shown project's first.
  const allFiles = $derived(projectNames.filter((p) => loaded.has(p)).sort((a, b) => (a === P.active ? -1 : b === P.active ? 1 : 0))
    .flatMap((project) => (liveOf(project).files ?? []).map((path) => ({ project, path, label: label(project, path) }))));
  const openKeys = $derived(new Set(ui.tabs.flatMap((t) => (t.kind === "file" ? [tabProject(t) + "\0" + t.path] : []))));
  const fileRows = $derived.by((): Row[] => {
    if (mode !== "files") return [];
    const query = q.toLowerCase().replace(/\s+/g, "");
    const isOpen = (f: { project: string; path: string }) => openKeys.has(f.project + "\0" + f.path);
    if (!query) return [...allFiles.filter(isOpen), ...allFiles.filter((f) => !isOpen(f))].slice(0, 50).map((f) => ({ ...f, at: [], s: 0 }));
    const out: Row[] = [];
    // The shown project's files win ties, then open tabs.
    for (const f of allFiles) { const r = score(f.label, query); if (r) out.push({ ...f, at: r.at, s: r.s + (isOpen(f) ? 0.5 : 0) + (f.project === P.active ? 0.25 : 0) }); }
    return out.sort((a, b) => b.s - a.s).slice(0, 50);
  });
  const marked = (path: string, at: number[]) => { const set = new Set(at); return [...path].map((c, i) => (set.has(i) ? "<b>" + esc(c) + "</b>" : esc(c))).join(""); };

  // ---- search ------------------------------------------------------------------
  let timer: ReturnType<typeof setTimeout>;
  let seq = 0;
  function run() {
    clearTimeout(timer);
    const query = q, n = ++seq;
    if (!query.trim()) { hits = []; searched = ""; return; }
    timer = setTimeout(async () => {
      searching = true;
      try {
        // Every project of the workspace, at once; the shown project's hits first.
        const url = `api/search?q=${encodeURIComponent(query)}&case=${caseSens ? 1 : 0}&regex=${regex ? 1 : 0}`;
        const order = [P.active, ...projectNames.filter((p) => p !== P.active)];
        let err = "";
        const each = await Promise.all(order.map((project) => api.get<Omit<Hit, "project">[] | { error: string }>(url, project)
          .then((r) => { if (!Array.isArray(r)) { err ||= r.error; return []; } return r.map((h) => ({ ...h, project })); }).catch(() => [] as Hit[])));
        if (n === seq) { hits = each.flat().slice(0, 1000); searched = query; sel = 0; searchError = err; }
      } finally { if (n === seq) searching = false; }
    }, 180);
  }
  const rows = $derived(mode === "files" ? fileRows.length : hits.length);

  function pick(i: number) {
    if (mode === "files") { const r = fileRows[i]; if (r) { mode = null; void openTab({ kind: "file", project: r.project, path: r.path }); } }
    else { const h = hits[i]; if (h) { mode = null; void openTab({ kind: "file", project: h.project, path: h.path, line: h.line, at: Date.now() }); } }
  }
  async function keys(e: KeyboardEvent) {
    if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (e.key === "ArrowDown" || (e.ctrlKey && (e.key === "n" || e.key === "j"))) { e.preventDefault(); sel = Math.min(rows - 1, sel + 1); }
    else if (e.key === "ArrowUp" || (e.ctrlKey && (e.key === "p" || e.key === "k"))) { e.preventDefault(); sel = Math.max(0, sel - 1); }
    else if (e.key === "Enter") { e.preventDefault(); pick(sel); return; }
    else return;
    await tick();
    list?.querySelector(".on")?.scrollIntoView({ block: "nearest" });
  }
</script>

{#if mode}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div id="palette" onclick={(e) => e.target === e.currentTarget && close()}>
    <div class="pbox">
      <div class="pin">
        <input type="text" bind:this={input} bind:value={q} onkeydown={keys} spellcheck="false"
          placeholder={mode === "files" ? "Open a file by name…" : multi ? "Search every project of the workspace…" : "Search the project…"} oninput={() => { sel = 0; if (mode === "search") run(); }}>
        {#if mode === "search"}
          {#if searching}<span class="muted">…</span>{/if}
          <label title="Match case"><input type="checkbox" bind:checked={caseSens} onchange={() => { store.set("cockpit-search-case", caseSens ? "1" : "0"); run(); }}>Aa</label>
          <label title="Regular expression"><input type="checkbox" bind:checked={regex} onchange={() => { store.set("cockpit-search-regex", regex ? "1" : "0"); run(); }}>.*</label>
        {/if}
      </div>
      <div class="plist" bind:this={list}>
        {#if mode === "files"}
          {#each fileRows as r, i (r.project + "\0" + r.path)}
            <button class="prow" class:on={i === sel} onmousemove={() => (sel = i)} onclick={() => pick(i)}><span class="pp">{@html marked(r.label, r.at)}</span></button>
          {:else}<p class="pnote">no file matches</p>{/each}
        {:else}
          {#each hits as h, i (h.project + ":" + h.path + ":" + h.line + ":" + h.col)}
            <button class="prow" class:on={i === sel} onmousemove={() => (sel = i)} onclick={() => pick(i)}>
              <span class="pp">{label(h.project, h.path)}</span><span class="pl">{h.line}</span><span class="pt">{h.text.trim()}</span>
            </button>
          {:else}<p class="pnote" class:bad={!!searchError}>{searchError || (q.trim() && searched === q && !searching ? "no match" : "type to search; Enter opens the hit")}</p>{/each}
          {#if hits.length >= 500}<p class="pnote">first {hits.length >= 1000 ? 1000 : 500} hits{multi ? " (at most 500 per project)" : ""}</p>{/if}
        {/if}
      </div>
    </div>
  </div>
{/if}
