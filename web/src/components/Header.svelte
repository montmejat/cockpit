<script lang="ts">
  // The top bar: project, branch, size and health at a glance (each opens its explanation), the
  // running agent, the terminal and chat toggles (with the hints on). In the desktop app it is also the window's title bar.
  import { S, dirtyFiles, plural, showRight, toggleChat, toggleInsp, ui } from "../lib/state.svelte";
  import { api } from "../lib/code";
  import { windowButtons, type WinButton } from "../lib/desktop";

  let { ontoggleterm }: { ontoggleterm: () => void } = $props();

  const tests = $derived(S.tests.unit.reduce((n, m) => n + m.tests.length, 0) + S.tests.integration.reduce((n, f) => n + f.tests.length, 0));
  const fparts = $derived(([["working", ""], ["partial", "warn"], ["broken", "bad"], ["planned", "muted"]] as const)
    .map(([st, c]) => ({ st, c, n: S.features.filter((f) => f.status === st).length })).filter((x) => x.n));

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
  // The workspace (src/workspace.ts): the other projects. In the desktop app "open" switches this
  // window to one (each project keeps its own server, so its terminals and agents go on meanwhile);
  // ↗ opens it in a window of its own.
  // How long the running agent has been at it ("40 s", "12 min", "2 h").
  let now = $state(Date.now());
  setInterval(() => (now = Date.now()), 15_000);
  function since(iso: string) {
    const s = Math.max(0, (now - Date.parse(iso)) / 1000);
    return s < 60 ? `${Math.round(s)} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`;
  }
  let wsOpen = $state(false), wsNote = $state("");
  async function openProject(path: string, newWindow = false) {
    wsNote = "";
    if (win && !newWindow) {
      if (dirtyFiles.size && !confirm(`${dirtyFiles.size} file${dirtyFiles.size > 1 ? "s have" : " has"} unsaved changes. Switch to ${path.split("/").pop()} anyway?`)) return;
      try {
        const r = await win.openProject(path);
        if (r === true) wsOpen = false; else if (r) wsNote = r.error;
      } catch (e) { wsNote = String(e); }
      return;
    }
    const r = await api.post<{ error?: string }>("api/workspace/open", { path });
    if (r.error) wsNote = r.error; else wsOpen = false;
  }
  function outside(e: MouseEvent) {
    if (wsOpen && !(e.target as HTMLElement).closest(".wsmenu,.wsbtn")) wsOpen = false;
    if (projOpen && !(e.target as HTMLElement).closest(".projmenu,.projbtn")) projOpen = false;
  }

  // Open Folder (desktop app): the project name opens a menu, another folder or a recent one;
  // the window switches to it (desktop/src/main.rs, open_project). Ctrl+O picks a folder directly.
  let projOpen = $state(false), projNote = $state(""), recent: { path: string; name: string }[] = $state([]);
  async function toggleProj() {
    projOpen = !projOpen; projNote = "";
    if (projOpen) recent = await api.get("api/recent").catch(() => []);
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
  function keys(e: KeyboardEvent) {
    if (e.key === "Escape") { wsOpen = false; projOpen = false; }
    else if (win && e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "o" && !(e.target as HTMLElement).closest?.(".cm-editor,.xterm")) { e.preventDefault(); openFolder(); }
  }
  // The numbers' popup (lines, tests, features): open while hovered, or kept open (remembered).
  let mHover = $state(false), mPinned = $state(false);
  try { mPinned = localStorage.getItem("cockpit.metrics") === "1"; } catch {}
  function pinMetrics() {
    mPinned = !mPinned;
    if (!mPinned) mHover = false; // closing by click hides it now, not when the mouse leaves
    try { localStorage.setItem("cockpit.metrics", mPinned ? "1" : "0"); } catch {}
  }
  function drag(e: MouseEvent) {
    if (!win || e.button !== 0 || (e.target as HTMLElement).closest("a,button,input,select,textarea,.mpop")) return;
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
  {#if win && wb.left.length}{@render controls(wb.left)}{/if}
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
      {#if recent.length}
        <div class="muted wshead">recent</div>
        {#each recent as r (r.path)}
          <button class="prow" role="menuitem" title={r.path} onclick={() => openFolder(r.path)}><span>{r.name}</span><span class="muted ppath">{r.path.replace(/^\/home\/[^/]+/, "~")}</span></button>
        {/each}
      {/if}
      {#if projNote}<div class="bad wsfoot">{projNote}</div>{/if}
    </div>
  {/if}
  {#if wsOpen && S.workspace}
    <div class="wsmenu">
      <div class="muted wshead">workspace <b>{S.workspace.name}</b>: the agent reads these projects too</div>
      {#each S.workspace.projects as p (p.path)}
        <div class="wsrow" class:here={p.here}>
          <div class="wsname"><b>{p.name}</b>{#if p.here}<span class="muted"> · this window</span>{:else}<button title={win ? "Show it in this window" : "Open it in the desktop app"} onclick={() => openProject(p.path)}>open</button>{#if win}<button title="Open it in a window of its own" onclick={() => openProject(p.path, true)}>↗</button>{/if}{/if}</div>
          {#if p.summary}<div class="muted wssum">{p.summary}</div>{/if}
        </div>
      {/each}
      <div class="muted wsfoot" title={S.workspace.system ?? ""}>{S.workspace.system ? "how they fit together: SYSTEM.md, kept by the agents" : "no SYSTEM.md yet: the agent writes one when it first needs it"}</div>
      {#if wsNote}<div class="bad wsfoot">{wsNote}</div>{/if}
    </div>
  {/if}
  <button class="pill" onclick={() => (ui.side = "git")} title="Git: branch, uncommitted files, history">
    ⎇ {S.git.branch ?? "detached " + S.git.head}
    {#if S.status.length}<span class="dirty"> · {S.status.length} changed</span>{/if}
    {#if S.git.ahead}<span class="ahead"> ↑{S.git.ahead}</span>{/if}
    {#if S.git.behind}<span class="ahead"> ↓{S.git.behind}</span>{/if}
  </button>
  {#if S.review}
    {@const r = S.review}
    <span class="revpill" title={(r.mr ? r.mr.ref + " " + r.mr.title + "\n" : "") + r.branch + " → " + r.target + (r.base ? " (from " + r.base + ")" : "")}>
      ◆ <button class="rt link" onclick={() => (ui.side = "git")}>{r.mr ? r.mr.ref + " " + r.mr.title : r.branch + " → " + r.target}</button>
      <span class="muted">{r.files.length} files</span>
      <button title="End the review" onclick={() => api.post("api/review/stop", { back: false })}>✕</button>
    </span>
  {/if}
  <!-- The project's numbers, out of the way: shown while the mouse is on the icon, kept open by a click. -->
  <span class="mwrap" role="presentation" onmouseenter={() => (mHover = true)} onmouseleave={() => (mHover = false)}>
    <button class="mbtn" class:on={mPinned} aria-expanded={mHover || mPinned} aria-label="Project numbers"
      title={mPinned ? "Project numbers (click to hide)" : "Project numbers (click to keep open)"} onclick={pinMetrics}>
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M3.5 12.5v-3M8 12.5v-9M12.5 12.5v-6" /></svg>
    </button>
    {#if mHover || mPinned}
      <div class="mpop"><div id="metrics" class="mbox muted">
        <div><b>{(S.lines / 1000).toFixed(1)}k</b> lines</div>
        <div><button class="mlink" class:on={ui.insp === "tests"} title="What is tested" onclick={() => toggleInsp("tests")}><b>{tests}</b> tests</button></div>
        {#if S.features.length}
          <div><button class="mlink" class:on={ui.insp === "features"} title="What the features are and where their status comes from" onclick={() => toggleInsp("features")}>features:
            {#each fparts as p, i}<span class={p.c}><b>{p.n}</b> {p.st}</span>{i < fparts.length - 1 ? ", " : ""}{/each}</button></div>
        {/if}
      </div></div>
    {/if}
  </span>
  {#if S.problems.length}
    <button class="mlink bad" class:on={ui.insp === "problems"} title="The agents’ description in .cockpit/ no longer matches the code" onclick={() => toggleInsp("problems")}>⚠ {S.problems.length} out of date</button>
  {/if}
  <span class="grow"></span>
  {#if S.live}
    {@const who = S.live.chat ? "chat agent" : "Claude Code (terminal)"}
    {@const tip = `${S.live.chat ? "The chat's agent" : "A Claude Code session outside cockpit"} is working, for ${since(S.live.startedAt)}, on:\n${S.live.prompt.slice(0, 300)}${S.live.touched.length ? "\n\nChanged so far: " + S.live.touched.join(", ") : ""}`}
    {#if S.live.chat}<button class="livepill" title={tip} onclick={() => showRight("chat")}>◉ {who}{#if S.live.touched.length} · {plural(S.live.touched.length, "file")}{/if}</button>
    {:else}<span class="livepill" title={tip}>◉ {who}{#if S.live.touched.length} · {plural(S.live.touched.length, "file")}{/if}</span>{/if}
  {/if}
  <!-- Ctrl+` opens the terminal; the button only shows with the hints on (F1) -->
  {#if ui.help}<button onclick={ontoggleterm} title="Terminal  (Ctrl+`)">▭ terminal <span class="muted">Ctrl+`</span></button>
    <button onclick={toggleChat} title="Chat  (Ctrl+L)">◧ chat <span class="muted">Ctrl+L</span></button>{/if}
  {#if win && wb.right.length}{@render controls(wb.right)}{/if}
</header>
