<script lang="ts">
  // The guardrails tab: what keeps the agents' work right in this project (src/guardrails.ts). The
  // rules stand in layers, strongest at the top: what the design makes impossible, what checks
  // catch without running the program, what checks see by running it, and what is only written
  // down. Below, the checks with their last result. Nothing here changes the project: "set up" and
  // "harden" ask the chat's agent, which keeps everything in .cockpit/.
  import { api } from "../lib/code";
  import { openFile, S, showRight } from "../lib/state.svelte";
  import type { CheckResult, Layer, Rule } from "../lib/types";

  const LAYERS: { id: Layer; name: string; says: string }[] = [
    { id: "design", name: "Design", says: "the code makes the wrong thing impossible" },
    { id: "static", name: "Static checks", says: "found without running the program: types, lint, tests" },
    { id: "verification", name: "Verification", says: "found by running the program and looking" },
    { id: "prose", name: "Prose", says: "only written down: an agent may not follow it" },
  ];
  const g = $derived(S.guardrails);
  const on = $derived(g.on ? g : null);
  const rulesIn = (l: Layer) => on?.rules.filter((r) => r.layer === l) ?? [];
  const result = (id: string): CheckResult | undefined => on?.results[id];
  const isRunning = (id: string) => !!on?.running.includes(id);
  const nameOf = (id: string) => on?.checks.find((c) => c.id === id)?.name ?? id;
  const passing = $derived(on ? on.checks.filter((c) => result(c.id)?.ok).length : 0);
  const unused = $derived(on ? on.checks.filter((c) => !on.rules.some((r) => r.checks?.includes(c.id))) : []);

  // A rule holds if every check behind it passed last time.
  function ruleState(r: Rule): "ok" | "bad" | "never" | "prose" {
    if (r.layer === "prose" || !r.checks?.length) return "prose";
    const rs = r.checks.map(result);
    if (rs.some((x) => x && !x.ok)) return "bad";
    return rs.every((x) => x?.ok) ? "ok" : "never";
  }
  function ago(iso: string) {
    const s = (Date.now() - Date.parse(iso)) / 1000;
    return s < 60 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
  }
  const dur = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

  const run = (ids?: string[]) => api.post("api/guardrails/run", { ids });
  function ask(text: string) { api.post("api/chat/send", { text }); showRight("chat"); }
  const setUp = () => ask(
    "Set up guardrails for this project: read the guide in your brief, then write .cockpit/guardrails.json with checks that use the tools this project already has " +
    "(its type checker, linter, tests, build), and the rules you can see it already follows, each with why and its layer. Only .cockpit/: don't change the project's setup. " +
    "Run each check once to see that it works, and tell me which ones already fail.");
  const harden = (r: Rule) => ask(
    `The guardrail rule "${r.id}" (${r.rule}) is only prose. Make it enforced: as a check in .cockpit/guardrails.json (a script in .cockpit/checks/ if it needs one, using only what the project already has), or by design if the code can make it impossible. ` +
    `Its error message should say what to do instead. Then move the rule to its new layer.`);
</script>

<section id="guardrails">
  <div class="ghead">
    <h2>Guardrails</h2>
    {#if on}
      <span class="muted">{on.rules.length} rule{on.rules.length === 1 ? "" : "s"} · <b class={passing === on.checks.length ? "okc" : "bad"}>{passing}/{on.checks.length}</b> checks pass</span>
      <span class="grow"></span>
      <button onclick={() => run()} disabled={on.running.length > 0}>{on.running.length ? "running…" : "Run all checks"}</button>
    {/if}
  </div>
  <p class="lead">What keeps the agents' work right without re-reading every line. A correction should move <i>up</i>: from prose to a check, from a check to design.</p>

  {#if !on}
    <div class="gempty">
      <p>Off in this project: nothing runs and nothing is enforced. Guardrails live in <code>.cockpit/guardrails.json</code> only. Setting them up doesn't add configs, scripts or dependencies to the project.</p>
      <button onclick={setUp}>Ask the agent to set them up</button>
    </div>
  {:else if on.problems.length}
    <ul class="gproblems">{#each on.problems as p}<li class="bad"><b>{p.where}</b>: {p.problem}</li>{/each}</ul>
  {/if}

  <div class="pyramid">
    {#each LAYERS as l, i (l.id)}
      {@const rs = rulesIn(l.id)}
      <div class="band b-{l.id}" style:--w="{100 - i * 9}%">
        <div class="bhead"><b>{l.name}</b><span class="muted">{l.says}</span><span class="grow"></span><span class="muted">{rs.length || ""}</span></div>
        {#if rs.length}
          <div class="rules">
            {#each rs as r (r.id)}
              {@const st = ruleState(r)}
              <details class="rule r-{st}">
                <summary>
                  <span class="rdot" title={st === "ok" ? "holds: its checks passed" : st === "bad" ? "broken: a check behind it fails" : st === "never" ? "its checks haven't run yet" : "nothing checks it"}></span>
                  <span class="rtext">{r.rule}</span>
                  {#each r.checks ?? [] as c}<span class="cchip" class:ok={result(c)?.ok} class:bad={result(c) && !result(c)?.ok}>{nameOf(c)}</span>{/each}
                </summary>
                <p class="why"><span class="muted">why</span> {r.why}</p>
                <p class="muted rmeta">{r.id}{r.since ? " · since " + r.since : ""}
                  {#if r.layer === "prose"}<button class="link" onclick={() => harden(r)}>harden it →</button>{/if}</p>
              </details>
            {/each}
          </div>
        {/if}
        {#if l.id === "prose" && g.instructions.length}
          <div class="files">
            <span class="muted">what agents read:</span>
            {#each g.instructions as f (f.path)}<button class="chip" title="{f.kind} · {f.lines} lines" onclick={() => openFile(f.path)}>{f.path} <span class="muted">{f.lines}</span></button>{/each}
          </div>
        {/if}
        {#if !rs.length && !(l.id === "prose" && g.instructions.length)}<p class="muted none">nothing here yet</p>{/if}
      </div>
    {/each}
  </div>

  {#if on?.checks.length}
    <h4>Checks</h4>
    <p class="muted hint">They run when an agent finishes a turn that edited files. The agent is sent back only for a check that passed before its turn.</p>
    <div class="checks">
      {#each on.checks as c (c.id)}
        {@const r = result(c.id)}
        <details class="check" open={!!r && !r.ok}>
          <summary>
            <span class="cst" class:ok={r?.ok} class:bad={r && !r.ok} class:spin={isRunning(c.id)}>{isRunning(c.id) ? "◌" : !r ? "·" : r.ok ? "✓" : "✗"}</span>
            <b>{c.name}</b><code class="muted">{c.run}</code><span class="grow"></span>
            {#if r}<span class="muted">{ago(r.at)} · {dur(r.ms)}</span>{:else}<span class="muted">never run</span>{/if}
            <button onclick={(e) => { e.preventDefault(); run([c.id]); }} disabled={isRunning(c.id)}>run</button>
          </summary>
          {#if r?.output}<pre>{r.output}</pre>{/if}
          {#if unused.includes(c)}<p class="muted hint">No rule names this check yet.</p>{/if}
        </details>
      {/each}
    </div>
  {/if}
</section>
