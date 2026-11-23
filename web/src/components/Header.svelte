<script lang="ts">
  // The top bar: the project, a review in progress, the running agent, a failing guardrail; only what
  // changes (branch and changes are on the git tab, features and tests on the project tab), and the
  // terminal and chat toggles with the hints on. In the desktop app it is also the window's title bar.
  import { S, dirtyFiles, openGuardrails, plural, showChat, toggleChat, ui } from "../lib/state.svelte";
  import { api } from "../lib/code";
  import { windowButtons, type WinButton } from "../lib/desktop";

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
  let wsOpen = $state(false), wsNote = $state("");
  function outside(e: MouseEvent) {
    if (wsOpen && !(e.target as HTMLElement).closest(".wsmenu,.wsbtn")) wsOpen = false;
    if (projOpen && !(e.target as HTMLElement).closest(".projmenu,.projbtn")) projOpen = false;
  }

  // Open Folder (desktop app): the project name opens a menu, another folder or a recent one;
  // the window switches to it (desktop/src/main.rs, open_project). Ctrl+O picks a folder directly.
  let projOpen = $state(false), projNote = $state(""), recent: { path: string; name: string; workspace: boolean }[] = $state([]);
  let workspaces: { name: string; dir: string; projects: string[] }[] = $state([]);
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
    const r = await api.post<{ error?: string }>("api/workspace/add", { path }).catch((e) => ({ error: String(e) }));
    if (r?.error) { projNote = r.error; return; }
    location.reload(); // the page learns its projects when it loads
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
    if (e.key === "Escape") { wsOpen = false; projOpen = false; }
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
      {#if b === "minimize"}<button title="Minimize" aria-label="Minimize" onclick={() => win!.minimize()}><svg viewBox="0 0 16 16" width="16" height="16"><path d="M4.5 8.5h7" /></svg></button>
      {:else if b === "maximize"}<button title={maximized ? "Restore" : "Maximize"} aria-label={maximized ? "Restore" : "Maximize"} onclick={() => win!.toggleMaximize()}>
          <svg viewBox="0 0 16 16" width="16" height="16">{#if maximized}<rect x="4.5" y="6" width="5.5" height="5.5" rx="1" /><path d="M6.5 4.5h4a1 1 0 0 1 1 1v4" />{:else}<rect x="4.5" y="4.5" width="7" height="7" rx="1.2" />{/if}</svg></button>
      {:else}<button title="Close" aria-label="Close" onclick={() => win!.close()}><svg viewBox="0 0 16 16" width="16" height="16"><path d="M5 5l6 6M11 5l-6 6" /></svg></button>{/if}
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
  {#if S.workspace}
    <button class="wsbtn" class:on={wsOpen} title="Workspace {S.workspace.name}: the projects that work with this one" aria-expanded={wsOpen} onclick={() => { wsOpen = !wsOpen; wsNote = ""; }}>{S.workspace.name} ▾</button><span class="muted wssep">/</span>
  {/if}
  {#if win}
    <button class="projbtn" class:on={projOpen} title="Open another folder  (Ctrl+O)" aria-expanded={projOpen} aria-haspopup="menu" onclick={toggleProj}>
      <h1>{S.project}</h1><svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4 6l4 4 4-4" /></svg>
    </button>
  {:else}<h1>{S.project}</h1>{/if}
  {#if projOpen}
    <div class="wsmenu projmenu" role="menu">
      <button class="prow" role="menuitem" onclick={() => openFolder()}><span>Open Folder…</span><span class="muted">Ctrl+O</span></button>
      <button class="prow" role="menuitem" onclick={newWindow}><span>New Window</span><span class="muted">Ctrl+Shift+N</span></button>
      <div class="muted wshead">workspaces</div>
      {#each workspaces as w (w.dir)}
        {@const here = w.dir === S.workspace?.dir}
        <button class="prow" role="menuitem" disabled={here} title={w.projects.join("\n")} onclick={() => openFolder(w.dir)}>
          <span>{w.name}</span><span class="muted ppath">{here ? "this window" : w.projects.map((p) => p.split("/").pop()).join(", ")}</span></button>
      {/each}
      {#if S.workspace}<button class="prow" role="menuitem" onclick={addFolder}><span>Add Folder to Workspace…</span></button>{/if}
      {#if naming}
        <form class="prow wsnew" onsubmit={(e) => { e.preventDefault(); createWs(); }}>
          <!-- svelte-ignore a11y_autofocus -->
          <input bind:value={wsName} placeholder="workspace name" autofocus />
          <button type="submit" disabled={!wsName.trim()}>Create</button>
        </form>
      {:else}
        <button class="prow" role="menuitem" onclick={() => (naming = true)} title={S.workspace ? "A new workspace with this one's projects" : `A new workspace with ${S.project} in it; add more projects to it from here`}><span>New Workspace…</span></button>
      {/if}
      {#if recent.filter((r) => !r.workspace).length}
        <div class="muted wshead">recent</div>
        {#each recent.filter((r) => !r.workspace) as r (r.path)}
          <button class="prow" role="menuitem" title={r.path} onclick={() => openFolder(r.path)}><span>{r.name}</span><span class="muted ppath">{r.path.replace(/^\/home\/[^/]+/, "~")}</span></button>
        {/each}
      {/if}
      {#if projNote}<div class="bad wsfoot">{projNote}</div>{/if}
    </div>
  {/if}
  {#if wsOpen && S.workspace}
    <div class="wsmenu">
      <div class="muted wshead">workspace <b>{S.workspace.name}</b>: its projects, all in this window</div>
      {#each S.workspace.projects as p (p.path)}
        <div class="wsrow" class:here={p.here}>
          <div class="wsname"><b>{p.name}</b>{#if p.here}<span class="muted"> · its map, terminals and chat</span>{/if}</div>
          {#if p.summary}<div class="muted wssum">{p.summary}</div>{/if}
        </div>
      {/each}
      <div class="muted wsfoot" title="the workspace's file: which projects it holds">{S.workspace.dir.replace(/^\/home\/[^/]+/, "~")}/workspace.json</div>
      <div class="muted wsfoot" title={S.workspace.system ?? ""}>{S.workspace.system ? "how they fit together: SYSTEM.md, kept by the agents" : "no SYSTEM.md yet: the agent writes one when it first needs it"}</div>
      {#if wsNote}<div class="bad wsfoot">{wsNote}</div>{/if}
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
