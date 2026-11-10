<script lang="ts">
  // The top bar: project, branch, size and health at a glance (each opens its explanation), the
  // running agent, the terminal toggle. In the desktop app it is also the window's title bar.
  import { S, plural, toggleInsp, ui } from "../lib/state.svelte";

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
  function drag(e: MouseEvent) {
    if (!win || e.button !== 0 || (e.target as HTMLElement).closest("a,button,input,select,textarea")) return;
    if (e.detail === 2) win.toggleMaximize(); else win.startDragging();
  }
</script>

<header onmousedown={drag} role="presentation">
  <h1>{S.project}</h1>
  <button class="pill" onclick={() => (ui.side = "git")} title="Git: branch, uncommitted files, history">
    ⎇ {S.git.branch ?? "detached " + S.git.head}
    {#if S.status.length}<span class="dirty"> · {S.status.length} changed</span>{/if}
    {#if S.git.ahead}<span class="ahead"> ↑{S.git.ahead}</span>{/if}
    {#if S.git.behind}<span class="ahead"> ↓{S.git.behind}</span>{/if}
  </button>
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
  <button onclick={ontoggleterm} title="Terminal  (Ctrl+`)">▭ terminal</button>
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
