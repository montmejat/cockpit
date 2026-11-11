<script lang="ts">
  // The right panel's details: a short line first, more on click. It explains the box you picked
  // on the map, the diagram on screen, or the features, tests and problems from the header.
  import { api } from "../lib/code";
  import { anchorChanged, byId, cur, mapTab, nameOf, nodeState, openDiagram, openFile, plural, S, showRight, tldr, ui, where } from "../lib/state.svelte";

  const ORDER = ["broken", "partial", "working", "planned"] as const;
  const fileOfModule = (id: string) => S.modules.find((m) => m.id === id)?.file;
  const unitTestsIn = (mods: string[]) => S.tests.unit.filter((u) => mods.includes(u.module)).reduce((n, u) => n + u.tests.length, 0);
  const d = $derived(byId(mapTab().id));
  const n = $derived(ui.picked && d ? d.nodes.find((x) => x.id === ui.picked) : null);
  const parent = $derived(d ? S.diagrams.find((x) => x.nodes.some((m) => m.detail === d.id)) : null);
  const label = (id: string) => d?.nodes.find((x) => x.id === id)?.label ?? id;
  const short = (a: string) => (a.includes("::") ? a.split("::").slice(1).join("::") : a.split("/").pop()!);
  const back = () => (ui.insp = null);

  const t = $derived(S.tests);
  const unitN = $derived(t.unit.reduce((k, m) => k + m.tests.length, 0)), intN = $derived(t.integration.reduce((k, f) => k + f.tests.length, 0));
  const bare = $derived(S.features.filter((f) => f.status !== "planned" && !unitTestsIn(f.modules)));

  // "Update": hand the list to the chat's agent, which fixes .cockpit/ (not the code).
  let asked = $state("");
  const problemsKey = $derived(S.problems.map((p) => p.problem + "@" + p.where).join("\n"));
  function update() {
    const list = S.problems.map((p) => `- ${p.problem} (${p.where})`).join("\n");
    api.post("api/chat/send", { text: `The description in .cockpit/ no longer matches the code here:\n${list}\n\nUpdate .cockpit/ so it matches the code again: fix the anchors, features and diagrams these point to. Don't change the code.` });
    asked = problemsKey;
    showRight("chat");
  }
</script>

{#snippet chip(a: string)}
  {@const w = where(a)}
  {#if w}<button class="chip" class:chg={anchorChanged(a)} title={a + " · " + w.file} onclick={() => openFile(w.file, w.line, w.end)}>{short(a)}</button>
  {:else}<span class="chip muted">{short(a)}</span>{/if}
{/snippet}
{#snippet testLink(file: string, x: { name: string; line: number })}
  <button class="tname" onclick={() => openFile(file, x.line)}>{x.name}</button>
{/snippet}

<aside id="inspector">
  {#if ui.insp === "features"}
    <button class="back link" onclick={back}>← back</button>
    <h2>Features</h2><p class="lead">What it does today, as the agents see it.</p>
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
  {:else if ui.insp === "problems"}
    <button class="back link" onclick={back}>← back</button>
    <h2>Out of date</h2><p class="lead">Where the agents’ description in .cockpit/ no longer matches the code.</p>
    <p class="updrow"><button disabled={asked === problemsKey} onclick={update}>{asked === problemsKey ? "asked the agent ✓" : "Update"}</button> <span class="hint">the chat's agent fixes .cockpit/, not the code</span></p>
    <details class="more"><summary>what happens next</summary><p class="hint">An agent finishing a turn gets this list and must fix it before stopping. "Update" asks the chat's agent to do it now.</p></details>
    {#each S.problems as p}<div class="trow"><span>{p.problem}</span></div><p class="hint" style="margin:0 0 6px">{p.where}</p>{/each}
  {:else if ui.insp === "tests"}
    <button class="back link" onclick={back}>← back</button>
    <h2>Tests</h2>
    <p class="lead">{unitN} unit, {intN} integration. {#if bare.length}<span class="bad">{plural(bare.length, "feature")} with none.</span>{:else}Every feature has some.{/if}</p>
    <details class="more"><summary>how this is counted</summary><p class="hint">#[test] functions in the code: where tests exist, not how much they cover.</p></details>
    {#if S.features.length}
      <h4>by feature</h4>
      {#each S.features.filter((f) => f.status !== "planned").map((f) => ({ f, k: unitTestsIn(f.modules) })).sort((a, b) => a.k - b.k) as { f, k } (f.id)}
        {@const mods = t.unit.filter((u) => f.modules.includes(u.module) && u.tests.length)}
        <details class="row"><summary><span class="rname">{f.name}</span><span class="rcount" class:bad={!k}>{k || "none"}</span></summary>
          {#each mods as u}{#each u.tests as x}{@render testLink(u.file, x)}{/each}{:else}<p class="hint">No #[test] in its modules.</p>{/each}
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
  {:else if cur().kind !== "map"}
    <p class="hint">Details follow the map: hover or click a box there.</p>
  {:else if !d}
    <p class="hint">No diagrams yet.</p>
  {:else}
    {#if parent}<button class="back link" onclick={() => openDiagram(parent.id)}>↑ {nameOf(parent)}</button>{/if}
    {#if n}
      {@const ns = nodeState(n, d.id)}
      {@const ins = d.edges.filter((e) => e.to === n.id)}
      {@const outs = d.edges.filter((e) => e.from === n.id)}
      <div class="kicker">{nameOf(d)}</div>
      <h2>{n.label}</h2>
      <p class="lead">{tldr(n, n.explain)}</p>
      {#if ns.live}<p class="agentbox">◉ the agent is changing it now</p>{:else if ns.unc}<p class="notebox">changed, not committed</p>{/if}
      {#if ns.added}<p class="revbox add">new in this review</p>{:else if ns.rev}<p class="revbox">changed in this review</p>{/if}
      {#if (n.anchors ?? []).length}<div class="chips">{#each n.anchors ?? [] as a}{@render chip(a)}{/each}</div>{/if}
      <details class="more"><summary>more</summary>
        {#if n.tldr || tldr(n, n.explain) !== n.explain}<p>{n.explain}</p>{/if}
        {#if ins.length || outs.length}
          <h4>in and out</h4>
          {#each ins as e}<div class="io"><span class="dv">{e.next ? "↻ " : ""}{e.label}</span> ← {label(e.from)}</div>{/each}
          {#each outs as e}<div class="io"><span class="dv">{e.next ? "↻ " : ""}{e.label}</span> → {label(e.to)}</div>{/each}
        {/if}
      </details>
    {:else}
      {@const busy = d.nodes.filter((x) => nodeState(x).unc)}
      <div class="kicker">drawn by the agents{d.rate ? " · " + d.rate : ""}</div>
      <h2>{nameOf(d)}</h2>
      <p class="q">{d.question}</p>
      <p class="lead">{tldr(d, d.answer)}</p>
      {#if busy.length}<p class="notebox">changed: {busy.map((x) => x.label).join(", ")}</p>{/if}
      {#if S.review}
        {@const rd = S.review.diagrams[d.id]}
        {@const rv = d.nodes.filter((x) => { const s = nodeState(x, d.id); return s.rev && !s.added; })}
        {#if rd?.isNew}<p class="revbox add">new diagram in this review</p>{/if}
        {#if rv.length}<p class="revbox">changed in this review: {rv.map((x) => x.label).join(", ")}</p>{/if}
        {#if rd && !rd.isNew && rd.added.length}<p class="revbox add">new boxes: {rd.added.map((id) => d.nodes.find((x) => x.id === id)?.label ?? id).join(", ")}</p>{/if}
        {#if rd?.removed.length}<p class="revbox del">removed boxes: {rd.removed.map((x) => x.label).join(", ")}</p>{/if}
      {/if}
      <details class="more"><summary>more</summary>
        {#if d.tldr || tldr(d, d.answer) !== d.answer}<p>{d.answer}</p>{/if}
        <p class="hint">Why a picture: {d.why}</p>
      </details>
      {#if ui.help}<p class="hint">Hover a box · click for its details · double-click to go in</p>{/if}
    {/if}
  {/if}
</aside>
