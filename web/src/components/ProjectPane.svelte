<script lang="ts">
  // The sidebar's project tab: what the project is and how it stands, things that rarely move.
  // A list of rows (about, features, tests, out of date, guardrails, size); a row opens its section here,
  // guardrails open as a tab in the center.
  import { api } from "../lib/code";
  import { M as S, mapFile, mp, openFile as openPageFile, openGuardrails, plural, showChat, ui } from "../lib/state.svelte";
  // The project the map shows (in a workspace, any of its projects): its files are named for the page.
  const openFile = (f: string, line?: number) => openPageFile(mapFile(f), line);
  import IconButton from "./ui/IconButton.svelte";

  const ORDER = ["broken", "partial", "working", "planned"] as const;
  const fileOfModule = (id: string) => S.modules.find((m) => m.id === id)?.file;
  const unitTestsIn = (mods: string[]) => S.tests.unit.filter((u) => mods.includes(u.module)).reduce((n, u) => n + u.tests.length, 0);
  const back = () => (ui.insp = null);

  const t = $derived(S.tests);
  const unitN = $derived(t.unit.reduce((k, m) => k + m.tests.length, 0)), intN = $derived(t.integration.reduce((k, f) => k + f.tests.length, 0));
  const bare = $derived(S.features.filter((f) => f.status !== "planned" && !unitTestsIn(f.modules)));
  const fcount = $derived(ORDER.map((st) => ({ st, n: S.features.filter((f) => f.status === st).length })).filter((x) => x.n));
  const gr = $derived(S.guardrails);
  const fail = $derived(gr.on ? gr.checks.filter((c) => gr.results[c.id] && !gr.results[c.id].ok).length : 0);

  // "Update": hand the list to the chat's agent, which fixes .cockpit/ (not the code).
  let asked = $state("");
  const problemsKey = $derived(S.problems.map((p) => p.problem + "@" + p.where).join("\n"));
  function update() {
    const list = S.problems.map((p) => `- ${p.problem} (${p.where})`).join("\n");
    api.post("api/chat/send", { text: `The description in .cockpit/ no longer matches the code ${mp().prefix ? `of ${mp().name} (${S.root})` : "here"}:\n${list}\n\nUpdate .cockpit/ so it matches the code again: fix the anchors, features and diagrams these point to. Don't change the code.` });
    asked = problemsKey;
    showChat();
  }
</script>

<!-- a section's top: back to the list, and its name -->
{#snippet head(title: string)}
  <div class="subhead">
    <IconButton label="Back to the project" onclick={back}><path d="M9.5 3.5 5 8l4.5 4.5" /></IconButton>
    <h2>{title}</h2>
  </div>
{/snippet}

{#snippet testLink(file: string, x: { name: string; line: number })}
  <button class="tname" onclick={() => openFile(file, x.line)}>{x.name}</button>
{/snippet}

<div id="project">
  {#if ui.insp === "features"}
    {@render head("Features")}<p class="lead">What it does today, as the agents see it.</p>
    <details class="more"><summary>where this comes from</summary><p class="hint">The agents keep this list in .cockpit/project.json. They set each status and must say what's missing when a feature is partial or broken. Cockpit checks that the code they point to exists.</p></details>
    {#each ORDER as st}
      {@const fs = S.features.filter((f) => f.status === st)}
      {#if fs.length}
        <h4><span class="dot st-{st}"></span> {st} · {fs.length}</h4>
        {#each fs as f (f.id)}
          {@const k = unitTestsIn(f.modules)}
          <details class="row"><summary><span class="rname">{f.name}</span>{#if f.note}<span class="rnote">{f.note}</span>{/if}</summary>
            <p class="hint">{f.description}</p>
            {#if f.modules.length}
              <div class="chips">{#each f.modules as m}<button class="chip" onclick={() => fileOfModule(m) && openFile(fileOfModule(m)!)}>{m}</button>{/each}</div>
              <p class={k ? "hint" : "bad"}>{k ? k + " unit tests" : "no unit tests"}</p>
            {/if}
          </details>
        {/each}
      {/if}
    {/each}
  {:else if ui.insp === "about"}
    {@render head("About")}
    <div class="pcard"><p class="about">{S.summary}</p></div>
    <details class="more"><summary>where this comes from</summary><p class="hint">The agents write it in .cockpit/project.json, from the code and the project's own docs.</p></details>
  {:else if ui.insp === "problems"}
    {@render head("Out of date")}<p class="lead">Where the agents’ description in .cockpit/ no longer matches the code.</p>
    <p class="updrow"><button disabled={asked === problemsKey} onclick={update}>{asked === problemsKey ? "asked the agent ✓" : "Update"}</button> <span class="hint">the chat's agent fixes .cockpit/, not the code</span></p>
    <details class="more"><summary>what happens next</summary><p class="hint">An agent finishing a turn gets this list and must fix it before stopping. "Update" asks the chat's agent to do it now.</p></details>
    {#each S.problems as p}<div class="trow"><span>{p.problem}</span></div><p class="hint" style="margin:0 0 6px">{p.where}</p>{/each}
  {:else if ui.insp === "tests"}
    {@render head("Tests")}
    <p class="lead">{unitN} unit, {intN} integration. {#if bare.length}<span class="bad">{plural(bare.length, "feature")} with none.</span>{:else}Every feature has some.{/if}</p>
    <details class="more"><summary>how this is counted</summary><p class="hint">Test functions found in the code: where tests exist, not how much they cover.</p></details>
    {#if S.features.length}
      <h4>by feature</h4>
      {#each S.features.filter((f) => f.status !== "planned").map((f) => ({ f, k: unitTestsIn(f.modules) })).sort((a, b) => a.k - b.k) as { f, k } (f.id)}
        {@const mods = t.unit.filter((u) => f.modules.includes(u.module) && u.tests.length)}
        <details class="row"><summary><span class="rname">{f.name}</span><span class="rcount" class:bad={!k}>{k || "none"}</span></summary>
          {#each mods as u}{#each u.tests as x}{@render testLink(u.file, x)}{/each}{:else}<p class="hint">No tests in its modules.</p>{/each}
        </details>
      {/each}
    {/if}
    {@const untested = t.unit.filter((m) => !m.tests.length)}
    <details class="more"><summary>modules with no unit tests · {untested.length}</summary>
      <div class="chips">{#each untested as m}<button class="chip" onclick={() => openFile(m.file)}>{m.module}{t.unit.filter((x) => x.module === m.module).length > 1 ? " (" + m.file.split("/").pop() + ")" : ""}</button>{/each}</div>
    </details>
    <details class="more"><summary>all unit tests · {unitN}</summary>
      {#each t.unit.filter((m) => m.tests.length) as m}
        <details class="row"><summary><span class="rname">{m.module}</span><span class="rcount">{m.tests.length}</span></summary>{#each m.tests as x}{@render testLink(m.file, x)}{/each}</details>
      {/each}
    </details>
    {#if t.integration.length}
      <details class="more"><summary>integration tests · {intN}</summary>
        {#each t.integration as f}<details class="row"><summary><span class="rname">{f.file}</span><span class="rcount">{f.tests.length}</span></summary>{#each f.tests as x}{@render testLink(f.file, x)}{/each}</details>{/each}
      </details>
    {/if}
  {:else}
    <!-- a grouped list, like iOS settings: one row per thing, its value on the right; the
         summary is a row too (its first words), read in full on its own page -->
    <div class="plist">
      {#if S.summary}
        <button class="lrow" onclick={() => (ui.insp = "about")} title={S.summary}><span>About</span><span class="pval psum">{S.summary}</span><span class="pchev">›</span></button>
      {/if}
      {#if S.features.length}
        <button class="lrow" onclick={() => (ui.insp = "features")}><span>Features</span>
          <span class="pval">{#each fcount as c}<span class="pdot"><span class="dot st-{c.st}"></span>{c.n}</span>{/each}</span><span class="pchev">›</span></button>
      {/if}
      <button class="lrow" onclick={() => (ui.insp = "tests")}><span>Tests</span><span class="pval" class:bad={bare.length > 0}>{unitN + intN}</span><span class="pchev">›</span></button>
      {#if S.problems.length}
        <button class="lrow" onclick={() => (ui.insp = "problems")}><span>Out of date</span><span class="pval bad">{S.problems.length}</span><span class="pchev">›</span></button>
      {/if}
      <button class="lrow" onclick={openGuardrails}><span>Guardrails</span>
        <span class="pval" class:bad={fail > 0 || (gr.on && !gr.trusted)}>{!gr.on ? "off" : !gr.trusted ? "not trusted" : gr.running.length ? "checking…" : fail ? `${fail} failing` : "✓"}</span><span class="pchev">›</span></button>
      <div class="lrow static"><span>Size</span><span class="pval">{(S.lines / 1000).toFixed(1)}k lines</span></div>
    </div>
  {/if}
</div>
