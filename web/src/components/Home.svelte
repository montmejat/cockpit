<script lang="ts">
  // Home: where cockpit opens. The workspace (or the lone project) by name, and its projects side by
  // side, none above the others: a card each, a click opens its map. In a workspace, also where it
  // is kept (its workspace.json), and its projects managed: one more, one out, the window reloaded.
  // Adding and removing are the host's (src/workspace-host.ts): it starts or stops that project's
  // server; the page learns its projects when it loads, so it loads again.
  import { homeOf, openDiagram, S, ui } from "../lib/state.svelte";
  import { projects } from "../lib/projects.svelte";
  import { api } from "../lib/code";
  import { confirmLoss } from "../lib/confirm.svelte";

  const open = (name: string, L: { diagrams: { id: string; kind: string }[] }) => { ui.home = false; openDiagram(homeOf(L as never) ?? "", undefined, name); };
  const tilde = (p: string) => p.replace(/^\/home\/[^/]+/, "~");
  const win = window.cockpitDesktop;

  const file = $derived(S.workspace ? S.workspace.dir + "/workspace.json" : "");
  let note = $state(""), adding = $state(false), path = $state(""), busy = $state(false), copied = $state(false);
  // The workspace's file changed since the page loaded (a project added or removed elsewhere).
  const stale = $derived(!!S.workspace && S.workspace.projects.map((p) => p.name).join("\0") !== projects.map((p) => p.name).join("\0"));

  async function call(route: string, body: unknown) {
    busy = true; note = "";
    const r = await api.post<{ error?: string }>(route, body).catch((e) => ({ error: String(e?.message ?? e) }));
    busy = false;
    if (r?.error) { note = r.error; return false; }
    return true;
  }
  async function add(p?: string | null) {
    p ??= win ? await win.pickFolder() : null;
    if (!p) return;
    if (await call("/api/workspace/add", { path: p })) location.reload();
  }
  async function remove(name: string, here: boolean) {
    const what = here ? "This window runs from it: it switches to another project." : "Its folder stays as it is.";
    if (!await confirmLoss(`Take ${name} out of the workspace ${S.workspace!.name}? ${what}`, "Remove")) return;
    // "/" goes to the project viewed last, or the first one when that was the removed one.
    if (await call("/api/workspace/remove", { name })) { if (here) location.href = "/"; else location.reload(); }
  }
  async function copy() { await navigator.clipboard?.writeText(file); copied = true; setTimeout(() => (copied = false), 1200); }
</script>

<section id="home">
  <div class="hwrap">
    <!-- the workspace's name; a lone project is named on its card already -->
    {#if S.workspace}<h1>{S.workspace.name}</h1>{/if}
    <div class="hgrid">
      {#each projects as p (p.name)}
        <div class="hrow">
          <button class="hcard" onclick={() => open(p.name, p.L)} title={p.path}>
            <span class="hname">{p.name}</span>
          </button>
          {#if S.workspace && projects.length > 1}
            <button class="hdel" title="Remove {p.name} from the workspace (its folder stays)" aria-label="Remove {p.name}" disabled={busy} onclick={() => remove(p.name, p.here)}>✕</button>
          {/if}
        </div>
      {/each}
    </div>

    {#if S.workspace}
      <div class="hws">
        {#if adding}
          <form class="hadd" onsubmit={(e) => { e.preventDefault(); add(path); }}>
            <!-- svelte-ignore a11y_autofocus -->
            <input bind:value={path} placeholder="~/path/to/project" autofocus spellcheck="false" />
            <button type="submit" disabled={busy || !path.trim()}>Add</button>
            <button type="button" class="link" onclick={() => { adding = false; path = ""; note = ""; }}>Cancel</button>
          </form>
        {:else}
          <div class="hacts">
            <button disabled={busy} onclick={() => (win ? add() : (adding = true))}>+ Add project</button>
            {#if win}<button class="link" onclick={() => (adding = true)}>type a path</button>{/if}
            <span class="grow"></span>
            <button class="link" class:hstale={stale} title="Load the page again, with the projects its workspace.json lists now" onclick={() => location.reload()}>{stale ? "Reload: the workspace changed" : "Reload"}</button>
          </div>
        {/if}
        {#if note}<p class="hnote">{note}</p>{/if}
        <p class="hfile muted">
          Kept in <button class="link mono" title="Copy the path" onclick={copy}>{tilde(file)}</button>{#if copied}<span> (copied)</span>{/if}
          {#if S.workspace.system}<br />Shared note: <span class="mono">{tilde(S.workspace.system)}</span>{/if}
        </p>
      </div>
    {:else}
      <p class="hfile muted">Not part of a workspace. Make one from the project menu (the name in the top bar).</p>
    {/if}
  </div>
</section>
