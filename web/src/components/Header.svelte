<script lang="ts">
  // The top bar: the project, a review in progress, the running agent, a failing guardrail; only what
  // changes (branch and changes are on the git tab, features and tests on the project tab), and the
  // terminal and chat toggles with the hints on. In the desktop app it is also the window's title bar.
  import { S, dirtyFiles, openGuardrails, plural, showChat, toggleChat, ui } from "../lib/state.svelte";
  import { api } from "../lib/code";
  import { windowButtons, type WinButton } from "../lib/desktop";
  import { projects } from "../lib/projects.svelte";
  import { homeOf, openDiagram } from "../lib/state.svelte";

  let { ontoggleterm }: { ontoggleterm: () => void } = $props();


  // Desktop app (desktop/, GTK 4): no system title bar, so the header drags the window.
  const win = window.cockpitDesktop;
  let maximized = $state(false);
  const wb = windowButtons(); // GNOME's layout: which buttons, which side
  if (win) {
    document.body.classList.add("desktop");
    const sync = async () => { maximized = (await win.state()).maximized; };
    addEventListener("resize", sync);
    sync();
  }
  // The workspace this window shows (src/workspace.ts), when it was opened as one: its projects.
  // How long the running agent has been at it ("40 s", "12 min", "2 h").
  let now = $state(Date.now());
  setInterval(() => (now = Date.now()), 15_000);
  function since(iso: string) {
    const s = Math.max(0, (now - Date.parse(iso)) / 1000);
    return s < 60 ? `${Math.round(s)} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`;
  }
  function outside(e: MouseEvent) {
    if (projOpen && !(e.target as HTMLElement).closest(".projmenu,.projbtn")) projOpen = false;
  }
  // A project of the workspace, from the menu: its diagrams on the map.
  function showOnMap(name: string) {
    const p = projects.find((x) => x.name === name);
    if (!p) return;
    projOpen = false;
    openDiagram(homeOf(p.L) ?? "", undefined, p.name);
  }
  const tilde = (p: string) => p.replace(/^\/home\/[^/]+/, "~");

  // Open Folder (desktop app): the project name opens a menu, another folder or a recent one;
  // the window switches to it (desktop/src/main.rs, open_project). Ctrl+O picks a folder directly.
  let projOpen = $state(false), projNote = $state(""), recent: { path: string; name: string; workspace: boolean }[] = $state([]);
  let workspaces: { name: string; dir: string; projects: string[] }[] = $state([]);
  const others = $derived(workspaces.filter((w) => w.dir !== S.workspace?.dir));
  const recents = $derived(recent.filter((r) => !r.workspace));
  async function toggleProj() {
    projOpen = !projOpen; projNote = ""; naming = false;
    if (projOpen) [recent, workspaces] = await Promise.all([api.get<typeof recent>("api/recent").catch(() => []), api.get<typeof workspaces>("api/workspaces").catch(() => [])]);
  }
  // Workspaces: open one (its folder), make one from what this window shows, add a project to it.
  let naming = $state(false), wsName = $state("");
  async function createWs() {
    projNote = "";
    const r: { dir?: string; error?: string } = await api.post<{ dir?: string; error?: string }>("api/workspaces/create", { name: wsName }).catch((e) => ({ error: String(e) }));
    if (r.error || !r.dir) { projNote = r.error ?? "couldn't create it"; return; }
    naming = false; wsName = "";
    if (win) openFolder(r.dir); else projNote = `created: open it with npm run serve -- ${r.dir}`;
  }
  async function addFolder() {
    projNote = "";
    const path = win ? await win.pickFolder() : null;
    if (!path) return;
    const r = await api.post<{ error?: string }>("/api/workspace/add", { path }).catch((e) => ({ error: String(e) }));
    if (r?.error) { projNote = r.error; return; }
    location.reload(); // the page learns its projects when it loads (the host's: src/workspace-host.ts)
  }
  async function openFolder(path?: string) {
    if (dirtyFiles.size && !confirm(`${dirtyFiles.size} file${dirtyFiles.size > 1 ? "s have" : " has"} unsaved changes. Open another folder anyway?`)) return;
    projNote = "";
    try {
      const r = await win!.openProject(path ?? null);
      if (r === true) projOpen = false;
      else if (r) { projNote = r.error; projOpen = true; }
    } catch (e) { projNote = String(e); projOpen = true; }
  }
  // Another window (desktop app): it asks which project. Ctrl+Shift+N, like VS Code.
  async function newWindow() {
    projNote = "";
    try { const r = await win!.newWindow(); if (r === true) projOpen = false; else if (r) { projNote = r.error; projOpen = true; } }
    catch (e) { projNote = String(e); projOpen = true; }
  }
  function keys(e: KeyboardEvent) {
    if (e.key === "Escape") projOpen = false;
    else if (win && e.ctrlKey && e.shiftKey && !e.altKey && e.key.toLowerCase() === "n") { e.preventDefault(); newWindow(); }
    else if (win && e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "o" && !(e.target as HTMLElement).closest?.(".cm-editor,.xterm")) { e.preventDefault(); openFolder(); }
  }
  function drag(e: MouseEvent) {
    if (!win || e.button !== 0 || (e.target as HTMLElement).closest("a,button,input,select,textarea")) return;
    if (e.detail === 2) win.toggleMaximize(); else win.startDragging();
  }
</script>

<svelte:window onmousedown={outside} onkeydown={keys} />
{#snippet controls(list: WinButton[])}
  <span class="winctl">
    {#each list as b (b)}
      {#if b === "minimize"}<button title="Minimize" aria-label="Minimize" onclick={() => win!.minimize()}><svg viewBox="0 0 16 16" width="16" height="16"><path d="M4 10h8v2H4z" /></svg></button>
      {:else if b === "maximize"}<button title={maximized ? "Restore" : "Maximize"} aria-label={maximized ? "Restore" : "Maximize"} onclick={() => win!.toggleMaximize()}>
          <svg viewBox="0 0 16 16" width="16" height="16">{#if maximized}<path d="M5 5v6h6V5zm2 2h2v2H7z" />{:else}<path d="M4 4v8h8V4zm2 2h4v4H6z" />{/if}</svg></button>
      {:else}<button title="Close" aria-label="Close" onclick={() => win!.close()}><svg viewBox="0 0 16 16" width="16" height="16"><path d="m4 4h1c.254.012.512.129.688.313L8 6.594l2.313-2.281c.265-.231.445-.305.687-.313h1v1c0 .285-.035.551-.25.75L9.469 8.031l2.25 2.25c.188.188.281.453.281.719v1h-1c-.266 0-.531-.094-.719-.281L8 9.438l-2.281 2.281c-.188.188-.453.281-.719.281H4v-1c0-.266.094-.531.281-.719l2.281-2.25L4.281 5.75C4.07 5.555 3.977 5.281 4 5z" /></svg></button>{/if}
    {/each}
  </span>
{/snippet}
<header onmousedown={drag} role="presentation" class:wleft={!!win && wb.left.length > 0}>
  <!-- three columns, the project's name in the middle like a GNOME title bar: what's going on
       (review, failing checks) on the left, the agent and the toggles on the right -->
  <div class="hside hl">
  {#if win && wb.left.length}{@render controls(wb.left)}{/if}
  {#if S.review}
    {@const r = S.review}
    <span class="revpill" title={(r.mr ? r.mr.ref + " " + r.mr.title + "\n" : "") + r.branch + " → " + r.target + (r.base ? " (from " + r.base + ")" : "")}>
      ◆ <button class="rt link" onclick={() => (ui.side = "git")}>{r.mr ? r.mr.ref + " " + r.mr.title : r.branch + " → " + r.target}</button>
      <span class="muted">{r.files.length} files</span>
      <button title="End the review" onclick={() => api.post("api/review/stop", { back: false })}>✕</button>
    </span>
  {/if}
  <!-- Guardrails speak up only when a check fails; otherwise they live in the sidebar's project tab -->
  {#if S.guardrails.on}
    {@const gr = S.guardrails}
    {@const fail = gr.checks.filter((c) => gr.results[c.id] && !gr.results[c.id].ok).length}
    {#if fail}<button class="pill gpill bad" title="Guardrails: {fail} of {gr.checks.length} checks failing" onclick={openGuardrails}>◈ {fail} failing</button>{/if}
  {/if}
  </div>
  <div class="htitle">
  <!-- the window's name: the workspace (all its projects), or the project; in the desktop app a
       menu to open another folder, a workspace or a recent project -->
  {#snippet title()}
    {#if S.workspace}<svg class="tico" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="2" y="2" width="5" height="5" rx="1" /><rect x="9" y="2" width="5" height="5" rx="1" /><rect x="2" y="9" width="5" height="5" rx="1" /><rect x="9" y="9" width="5" height="5" rx="1" /></svg>{/if}
    <h1>{S.workspace?.name ?? S.project}</h1>
  {/snippet}
  {#if win}
    <button class="projbtn" class:on={projOpen} title={S.workspace ? `Workspace ${S.workspace.name}: ${S.workspace.projects.map((p) => p.name).join(", ")}` : "Open another folder  (Ctrl+O)"} aria-expanded={projOpen} aria-haspopup="menu" onclick={toggleProj}>
      {@render title()}<svg class="chev" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4 6l4 4 4-4" /></svg>
    </button>
  {:else}<span class="projbtn static" title={S.workspace ? `Workspace ${S.workspace.name}: ${S.workspace.projects.map((p) => p.name).join(", ")}` : S.project}>{@render title()}</span>{/if}
  {#if projOpen}
    <div class="pop projmenu" role="menu">
      {#if S.workspace}
        <div class="pmsec">
          <div class="pmhead"><span>Workspace</span><span class="pmhint" title={S.workspace.dir + "/workspace.json"}>{tilde(S.workspace.dir)}</span></div>
          {#each S.workspace.projects as p (p.path)}
            <button class="pmrow" role="menuitem" title="{p.path}{p.summary ? '\n\n' + p.summary : ''}" onclick={() => showOnMap(p.name)}>
              <svg class="pmico" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M2.5 4.5a1 1 0 0 1 1-1h3l1.5 1.5h4.5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z" /></svg>
              <span class="pmtext"><span class="pmname">{p.name}</span><span class="pmsub">{tilde(p.path)}</span></span>
            </button>
          {/each}
          <button class="pmrow pmact" role="menuitem" onclick={addFolder}>
            <svg class="pmico" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9" /></svg><span class="pmname">Add Folder to Workspace…</span>
          </button>
        </div>
      {/if}
      <div class="pmsec">
        <button class="pmrow pmact" role="menuitem" onclick={() => openFolder()}>
          <svg class="pmico" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M2.5 4.5a1 1 0 0 1 1-1h3l1.5 1.5h4.5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z" /></svg>
          <span class="pmname">Open Folder…</span><kbd>Ctrl+O</kbd>
        </button>
        <button class="pmrow pmact" role="menuitem" onclick={newWindow}>
          <svg class="pmico" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><rect x="2.5" y="3.5" width="11" height="9" rx="1.5" /><path d="M2.5 6h11" /></svg>
          <span class="pmname">New Window</span><kbd>Ctrl+Shift+N</kbd>
        </button>
      </div>
      <div class="pmsec">
        <div class="pmhead"><span>{S.workspace ? "Other workspaces" : "Workspaces"}</span></div>
        {#each others as w (w.dir)}
          <button class="pmrow" role="menuitem" title={w.projects.join("\n")} onclick={() => openFolder(w.dir)}>
            <svg class="pmico" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" /><rect x="9" y="2.5" width="4.5" height="4.5" rx="1" /><rect x="2.5" y="9" width="4.5" height="4.5" rx="1" /><rect x="9" y="9" width="4.5" height="4.5" rx="1" /></svg>
            <span class="pmtext"><span class="pmname">{w.name}</span><span class="pmsub">{w.projects.map((p) => p.split("/").pop()).join(" · ")}</span></span>
          </button>
        {/each}
        {#if naming}
          <form class="pmnew" onsubmit={(e) => { e.preventDefault(); createWs(); }}>
            <!-- svelte-ignore a11y_autofocus -->
            <input bind:value={wsName} placeholder="workspace name" autofocus />
            <button type="submit" disabled={!wsName.trim()}>Create</button>
          </form>
        {:else}
          <button class="pmrow pmact" role="menuitem" onclick={() => (naming = true)} title={S.workspace ? "A new workspace with this one's projects" : `A new workspace with ${S.project} in it; add more projects to it from here`}>
            <svg class="pmico" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9" /></svg><span class="pmname">New Workspace…</span>
          </button>
        {/if}
      </div>
      {#if recents.length}
        <div class="pmsec">
          <div class="pmhead"><span>Recent</span></div>
          {#each recents as r (r.path)}
            <button class="pmrow" role="menuitem" title={r.path} onclick={() => openFolder(r.path)}>
              <svg class="pmico" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="5.5" /><path d="M8 5v3l2 1.5" /></svg>
              <span class="pmtext"><span class="pmname">{r.name}</span><span class="pmsub">{tilde(r.path)}</span></span>
            </button>
          {/each}
        </div>
      {/if}
      {#if projNote}<div class="pmnote bad">{projNote}</div>{/if}
    </div>
  {/if}
  </div>
  <div class="hside hr">
  {#if S.live}
    {@const who = S.live.chat ? "chat agent" : "Claude Code (terminal)"}
    {@const tip = `${S.live.chat ? "The chat's agent" : "A Claude Code session outside cockpit"} is working, for ${since(S.live.startedAt)}, on:\n${S.live.prompt.slice(0, 300)}${S.live.touched.length ? "\n\nChanged so far: " + S.live.touched.join(", ") : ""}`}
    {#if S.live.chat}<button class="livepill" title={tip} onclick={showChat}>◉ {who}{#if S.live.touched.length} · {plural(S.live.touched.length, "file")}{/if}</button>
    {:else}<span class="livepill" title={tip}>◉ {who}{#if S.live.touched.length} · {plural(S.live.touched.length, "file")}{/if}</span>{/if}
  {/if}
  <!-- Ctrl+` opens the terminal; the button only shows with the hints on (F1) -->
  {#if ui.help}<button onclick={ontoggleterm} title="Terminal  (Ctrl+`)">▭ terminal <span class="muted">Ctrl+`</span></button>
    <button onclick={() => toggleChat(true)} title="Chat  (Ctrl+L)">◧ chat <span class="muted">Ctrl+L</span></button>{/if}
  {#if win && wb.right.length}{@render controls(wb.right)}{/if}
  </div>
</header>
