<script lang="ts">
  // The top bar: project, branch, size and health at a glance (each opens its explanation), the
  // running agent, the terminal and chat toggles (with the hints on). In the desktop app it is also the window's title bar.
  import { S, plural, toggleChat, toggleInsp, ui } from "../lib/state.svelte";
  import { api } from "../lib/code";

  let { ontoggleterm }: { ontoggleterm: () => void } = $props();

  const tests = $derived(S.tests.unit.reduce((n, m) => n + m.tests.length, 0) + S.tests.integration.reduce((n, f) => n + f.tests.length, 0));
  const fparts = $derived(([["working", ""], ["partial", "warn"], ["broken", "bad"], ["planned", "muted"]] as const)
    .map(([st, c]) => ({ st, c, n: S.features.filter((f) => f.status === st).length })).filter((x) => x.n));

  // Desktop app (desktop/, Tauri): no system title bar, so the header drags the window.
  const tauri = window.__TAURI__;
  const win = tauri?.window.getCurrentWindow();
  let maximized = $state(false);
  if (win) {
    document.body.classList.add("desktop");
    const sync = async () => (maximized = await win.isMaximized());
    addEventListener("resize", sync);
    sync();
  }
  // The workspace (src/workspace.ts): the other projects, each opened in its own window.
  let wsOpen = $state(false), wsNote = $state("");
  async function openProject(path: string) {
    wsNote = "";
    const r = await api.post<{ error?: string }>("api/workspace/open", { path });
    if (r.error) wsNote = r.error; else wsOpen = false;
  }
  function outside(e: MouseEvent) { if (wsOpen && !(e.target as HTMLElement).closest(".wsmenu,.wsbtn")) wsOpen = false; }
  function drag(e: MouseEvent) {
    if (!win || e.button !== 0 || (e.target as HTMLElement).closest("a,button,input,select,textarea")) return;
    if (e.detail === 2) win.toggleMaximize(); else win.startDragging();
  }
</script>

<svelte:window onmousedown={outside} onkeydown={(e) => e.key === "Escape" && (wsOpen = false)} />
<header onmousedown={drag} role="presentation">
  {#if S.workspace}
    <button class="wsbtn" class:on={wsOpen} title="Workspace {S.workspace.name}: the projects that work with this one" aria-expanded={wsOpen} onclick={() => { wsOpen = !wsOpen; wsNote = ""; }}>{S.workspace.name} ▾</button><span class="muted wssep">/</span>
  {/if}
  <h1>{S.project}</h1>
  {#if wsOpen && S.workspace}
    <div class="wsmenu">
      <div class="muted wshead">workspace <b>{S.workspace.name}</b>: the agent reads these projects too</div>
      {#each S.workspace.projects as p (p.path)}
        <div class="wsrow" class:here={p.here}>
          <div class="wsname"><b>{p.name}</b>{#if p.here}<span class="muted"> · this window</span>{:else}<button onclick={() => openProject(p.path)}>open</button>{/if}</div>
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
  <span id="metrics" class="muted">
    <b>{(S.lines / 1000).toFixed(1)}k</b> lines ·
    <button class="mlink" class:on={ui.insp === "tests"} title="What is tested" onclick={() => toggleInsp("tests")}><b>{tests}</b> tests</button>
    {#if S.features.length}
      · <button class="mlink" class:on={ui.insp === "features"} title="What the features are and where their status comes from" onclick={() => toggleInsp("features")}>features:
        {#each fparts as p, i}<span class={p.c}><b>{p.n}</b> {p.st}</span>{i < fparts.length - 1 ? ", " : ""}{/each}</button>
    {/if}
  </span>
  {#if S.problems.length}
    <button class="mlink bad" class:on={ui.insp === "problems"} title="The agents’ description in .cockpit/ no longer matches the code" onclick={() => toggleInsp("problems")}>⚠ {S.problems.length} out of date</button>
  {/if}
  <span class="grow"></span>
  {#if S.live}<span class="livepill" title={S.live.prompt}>◉ agent working · {plural(S.live.touched.length, "file")}</span>{/if}
  <!-- Ctrl+` opens the terminal; the button only shows with the hints on (F1) -->
  {#if ui.help}<button onclick={ontoggleterm} title="Terminal  (Ctrl+`)">▭ terminal <span class="muted">Ctrl+`</span></button>
    <button onclick={toggleChat} title="Chat  (Ctrl+L)">◧ chat <span class="muted">Ctrl+L</span></button>{/if}
  {#if win}
    <span id="winctl">
      <button title="minimize" onclick={() => win.minimize()}><svg viewBox="0 0 16 16" width="16" height="16"><path d="M4 8h8" /></svg></button>
      <button title={maximized ? "restore" : "maximize"} onclick={() => win.toggleMaximize()}>
        <svg viewBox="0 0 16 16" width="16" height="16">
          {#if maximized}<rect x="4.5" y="6" width="5.5" height="5.5" rx="1" /><path d="M6.5 4.5h4a1 1 0 0 1 1 1v4" />{:else}<rect x="4.5" y="4.5" width="7" height="7" rx="1" />{/if}
        </svg>
      </button>
      <button class="close" title="close" onclick={() => win.close()}><svg viewBox="0 0 16 16" width="16" height="16"><path d="M5 5l6 6M11 5l-6 6" /></svg></button>
    </span>
  {/if}
</header>
