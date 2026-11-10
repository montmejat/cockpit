<script lang="ts">
  // The agent chat. Cockpit runs the agent itself (src/chat.ts); the panel follows it live:
  // replies stream in, tool calls show as one line each (click for more), auto mode's questions
  // as Allow/Deny cards. Past conversations are a click away; the bar under the box shows how full
  // this conversation is, and how much of your plan's limits you've used.
  import { onMount, tick } from "svelte";
  import { api, md } from "../lib/code";
  import { openFile, S } from "../lib/state.svelte";
  import type { ChatItem, ChatSession, Usage } from "../lib/types";

  let { hidden, onactivity }: { hidden: boolean; onactivity: (ask: boolean) => void } = $props();

  let items: ChatItem[] = $state([]);
  let busy = $state(false), model = $state("sonnet"), models: string[] = $state([]);
  let context: { used: number; max: number } | null = $state(null);
  let session: string | null = $state(null);
  let text = $state("");
  let msgs: HTMLElement;
  let near = true;
  let list: ChatSession[] | null = $state(null); // the conversations list, when open
  let usage: Usage | null = $state(null);

  const stick = async (force = false) => { await tick(); if (msgs && (force || near)) msgs.scrollTop = msgs.scrollHeight; };

  onMount(() => {
    const es = new EventSource("api/chat/events");
    es.onmessage = (m) => {
      const e = JSON.parse(m.data);
      if (e.type === "init") {
        items = e.items; busy = e.busy; model = e.model; models = e.models; context = e.context; session = e.session;
        stick(true);
      } else if (e.type === "state") { busy = e.busy; model = e.model; context = e.context; session = e.session; }
      else if (e.type === "item") {
        const i = items.findIndex((x) => x.id === e.item.id);
        if (i >= 0) items[i] = e.item; else items.push(e.item);
        stick();
        if (e.item.kind !== "user") onactivity(e.item.kind === "ask" && e.item.status === "waiting");
        if (e.item.kind === "done") loadUsage();
      }
    };
    loadUsage();
    const t = setInterval(loadUsage, 5 * 60_000);
    return () => { es.close(); clearInterval(t); };
  });
  $effect(() => { if (!hidden) stick(true); });

  const post = (what: string, body: unknown = {}) => api.post("api/chat/" + what, body);
  function send() {
    const t = text.trim();
    if (!t) return;
    text = ""; near = true;
    post("send", { text: t });
  }
  async function loadUsage() { try { usage = await api.get<Usage>("api/chat/usage"); } catch {} }
  async function showList() {
    if (list) { list = null; return; }
    list = [];
    list = await api.get<ChatSession[]>("api/chat/sessions");
  }
  async function openSession(id: string) { list = null; await post("open", { id }); }

  const k = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(n % 1e6 ? 1 : 0) + "M" : n >= 1000 ? Math.round(n / 1000) + "k" : String(n));
  const ago = (ms: number) => {
    const s = (Date.now() - ms) / 1000;
    return s < 90 ? "just now" : s < 3600 ? Math.round(s / 60) + " min ago" : s < 86400 ? Math.round(s / 3600) + " h ago" : s < 86400 * 14 ? Math.round(s / 86400) + " d ago" : new Date(ms).toLocaleDateString();
  };
  const resets = (iso: string | null) => {
    if (!iso) return "";
    const m = Math.max(0, (new Date(iso).getTime() - Date.now()) / 60000);
    return "resets in " + (m < 90 ? Math.round(m) + " min" : m < 48 * 60 ? Math.round(m / 60) + " h" : Math.round(m / 1440) + " days");
  };
  const level = (pct: number) => (pct >= 90 ? "bad" : pct >= 70 ? "warn" : "");
  const toolIcon: Record<string, string> = { running: "<span class='spin'></span>", ok: "<span class=ok>✓</span>", error: "<span class=bad>✗</span>" };
  const fresh = $derived(!S.diagrams.length);
  const title = $derived(items.find((x) => x.kind === "user")?.text?.split("\n")[0] ?? "new conversation");
</script>

<section id="chat" class:hide={hidden}>
  <div class="ctools">
    <button class="ctitle" onclick={showList} title="Your conversations in this project">
      <span class="chev">{list ? "▾" : "▸"}</span><span class="ctname">{title}</span>
    </button>
    <select bind:value={model} onchange={() => post("model", { model })} title="model">{#each models as m}<option>{m}</option>{/each}</select>
    <button onclick={() => post("new")} title="Start a new conversation (this one stays in the list)">new</button>
  </div>
  {#if list}
    <div class="clist">
      {#if !list.length}<p class="muted">loading…</p>{/if}
      {#each list as s (s.id)}
        <button class="csess" class:on={s.id === session} onclick={() => openSession(s.id)} title={s.title}>
          <span class="cst">{s.title}</span>
          <span class="muted">{ago(s.at)}{s.branch ? " · " + s.branch : ""}{s.here ? "" : " · terminal"}</span>
        </button>
      {/each}
    </div>
  {/if}
  <div id="msgs" bind:this={msgs} onscroll={() => (near = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 60)}>
    {#each items as it (it.id)}
      {#if it.kind === "user"}<div class="cuser">{it.text}</div>
      {:else if it.kind === "text"}{#if it.text}<div class="ctext">{@html md(it.text)}</div>{/if}
      {:else if it.kind === "tool"}
        <div class="ctool" class:sub={it.sub}>
          {@html toolIcon[it.status] ?? ""}
          {#if it.detail || it.output}
            <details><summary>{it.title}</summary>{#if it.detail}<pre>{it.detail}</pre>{/if}{#if it.output}<pre>{it.output}</pre>{/if}</details>
          {:else}<span>{it.title}</span>{/if}
          {#if it.file}<button class="chip" onclick={() => openFile(it.file)}>open</button>{/if}
        </div>
      {:else if it.kind === "ask"}
        <div class="cask {it.status}">
          <div class="kicker">{it.status === "waiting" ? "the agent asks" : it.status}</div>
          <div class="mono">{it.title}</div>
          {#if it.reason}<p class="muted">{it.reason}</p>{/if}
          {#if it.detail}<p class="muted">{it.detail}</p>{/if}
          {#if it.status === "waiting"}<div class="crow"><button onclick={() => post("answer", { id: it.id, allow: true })}>Allow</button><button onclick={() => post("answer", { id: it.id, allow: false })}>Deny</button></div>{/if}
        </div>
      {:else if it.kind === "done"}
        <div class="cdone">{#if it.error}<span class="bad">{it.error}</span> · {/if}{it.ms ? Math.round(it.ms / 1000) + " s" : ""}</div>
      {:else if it.kind === "note"}
        <div class="cnote" class:bad={it.error}>{it.text}{#if it.detail}<details><summary>why</summary><pre>{it.detail}</pre></details>{/if}</div>
      {/if}
    {:else}
      <div class="cempty">
        <p>Talk to the agent here. It works in <b>{S.project}</b>, and what it changes lights up on the diagrams.</p>
        {#if fresh}<p class="muted">This project has no description yet.</p>
          <button onclick={() => post("send", { text: "Describe this project in .cockpit/: the summary, the features, and the 2 or 3 diagrams that best explain how it works. Don't change the code." })}>Describe this project</button>{/if}
      </div>
    {/each}
  </div>
  <form id="composer" onsubmit={(e) => { e.preventDefault(); send(); }}>
    <textarea rows="3" bind:value={text} placeholder="Ask the agent…  Enter sends, Shift+Enter for a new line"
      onkeydown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } }}></textarea>
    <div class="crow">
      {#if busy}<span class="muted"><span class="spin"></span> working…</span>{/if}
      <span class="grow"></span>
      {#if busy}<button type="button" onclick={() => post("stop")}>stop</button>{/if}
      <button type="submit">send</button>
    </div>
    <div class="meters">
      <div class="meter" title={context ? `This conversation uses ${context.used.toLocaleString()} of ${context.max.toLocaleString()} tokens of context. Near the end, Claude Code compacts it.` : "Context size shows after the agent's next reply"}>
        <span class="mlabel">context</span>
        <span class="bar"><i style="width:{context ? Math.min(100, (100 * context.used) / context.max) : 0}%" class={context ? level((100 * context.used) / context.max) : ""}></i></span>
        <span class="mval">{context ? k(context.used) + " / " + k(context.max) : "–"}</span>
      </div>
      {#each usage?.windows ?? [] as w (w.name)}
        <div class="meter" title="Your {usage?.plan ?? 'Claude'} plan: {w.pct}% of the {w.name} limit used, {resets(w.resets)}">
          <span class="mlabel">{w.name}</span>
          <span class="bar"><i style="width:{Math.min(100, w.pct)}%" class={level(w.pct)}></i></span>
          <span class="mval">{Math.round(w.pct)}%</span>
        </div>
      {/each}
    </div>
  </form>
</section>
