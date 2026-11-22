<script lang="ts">
  // The agent chat. Cockpit runs the agent itself (src/chat.ts); the panel follows it live:
  // replies stream in, tool calls show as one line each (click for more), auto mode's questions
  // as Allow/Deny cards. Past conversations are a click away; the ring by "send" shows how full this
  // conversation is, and hovering it, how much of your plan's limits you've used.
  import { onMount, tick } from "svelte";
  import { api, copyTargetAt, fileRefAt, fileResolver, md, mdGrowing } from "../lib/code";
  import { openFile, S } from "../lib/state.svelte";
  import type { ChatItem, ChatSession, Usage } from "../lib/types";
  import IconButton from "./ui/IconButton.svelte";
  import Menu from "./ui/Menu.svelte";

  let { hidden, onactivity }: { hidden: boolean; onactivity: (ask: boolean) => void } = $props();

  let items: ChatItem[] = $state([]);
  let busy = $state(false), model = $state("opus"), models: string[] = $state([]);
  let context = $state<{ used: number; max: number } | null>(null);
  let session: string | null = $state(null);
  let text = $state("");
  let msgs: HTMLElement;
  // The composer grows with what's typed (whole pixels, up to its max-height) instead of scrolling:
  // a scrolled textarea re-renders its text at fractional offsets in WebKitGTK and looks blurry.
  let ta: HTMLTextAreaElement;
  $effect(() => {
    text;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.ceil(ta.scrollHeight + ta.offsetHeight - ta.clientHeight) + "px";
  });
  let near = true;
  let list: ChatSession[] | null = $state(null); // the conversations list, when open
  let usage: Usage | null = $state(null);
  let hover = $state(false), pinned = $state(false), ctxEl: HTMLElement;
  const ctxPct = $derived(context ? Math.min(100, (100 * context.used) / context.max) : null);
  const unpin = (e: PointerEvent) => { if (pinned && !ctxEl?.contains(e.target as Node)) pinned = false; };
  const resolve = $derived(fileResolver(S.files ?? []));
  // Copy a code block; the button shows a tick for a moment.
  async function copy(button: HTMLElement, text: string) {
    try { await navigator.clipboard.writeText(text); }
    catch { // no clipboard API (not a secure context): the old way
      const t = document.createElement("textarea");
      t.value = text; document.body.append(t); t.select(); document.execCommand("copy"); t.remove();
    }
    button.classList.add("done");
    setTimeout(() => button.classList.remove("done"), 1200);
  }
  // A click on a file reference in a reply opens that file at that line.
  function clickRef(e: MouseEvent) {
    const c = copyTargetAt(e.target);
    if (c) return copy(c.button, c.text);
    const r = fileRefAt(e.target);
    if (!r) return;
    e.preventDefault();
    openFile(r.path, r.line, r.end);
  }

  const pending = new Map<string, string>();
  let flushing = false;
  function flushDeltas() {
    flushing = false;
    for (const [id, add] of pending) { const it = items.find((x) => x.id === id); if (it) it.text = String(it.text ?? "") + add; }
    if (pending.size) { pending.clear(); stick(); onactivity(false); }
  }

  const stick = async (force = false) => { await tick(); if (msgs && (force || near)) msgs.scrollTop = msgs.scrollHeight; };

  onMount(() => {
    const es = new EventSource("api/chat/events");
    es.onmessage = (m) => {
      const e = JSON.parse(m.data);
      if (e.type === "init") {
        items = e.items; busy = e.busy; model = e.model; models = e.models; context = e.context; session = e.session;
        stick(true);
      } else if (e.type === "state") { busy = e.busy; model = e.model; context = e.context; session = e.session; }
      else if (e.type === "delta") {
        // A streamed reply's new text: gathered, and shown once per frame.
        pending.set(e.id, (pending.get(e.id) ?? "") + e.text);
        if (!flushing) { flushing = true; requestAnimationFrame(flushDeltas); }
      }
      else if (e.type === "item") {
        if (pending.has(e.item.id)) pending.delete(e.item.id); // the whole item supersedes them
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

<svelte:window onpointerdown={unpin} onkeydown={(e) => e.key === "Escape" && (pinned = false)} />

<section id="chat" class:hide={hidden}>
  <div class="ctools">
    <button class="ctitle" onclick={showList} title="Your conversations in this project">
      <span class="chev">{list ? "▾" : "▸"}</span><span class="ctname">{title}</span>
    </button>
    <IconButton label="New conversation (this one stays in the list)" onclick={() => post("new")}>
      <path d="M8 3.5v9M3.5 8h9" />
    </IconButton>
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
      {:else if it.kind === "text"}{#if it.text}{@const [kept, rest] = mdGrowing(it.id, it.text, resolve)}<div class="ctext" onclick={clickRef} role="presentation">{@html kept}{@html rest}</div>{/if}
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
          <button onclick={() => post("send", { text: "Describe this project in .cockpit/: the summary, the features, and the diagrams that best explain how it works, as many as this project needs. Don't change the code." })}>Describe this project</button>{/if}
      </div>
    {/each}
  </div>
  <form id="composer" onsubmit={(e) => { e.preventDefault(); send(); }}>
    <textarea rows="3" bind:this={ta} bind:value={text} placeholder="Ask the agent…  Enter sends, Shift+Enter for a new line"
      onkeydown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } }}></textarea>
    <div class="crow">
      {#if busy}<span class="muted"><span class="spin"></span> working…</span>{/if}
      <span class="grow"></span>
      {#if models.length > 1}<Menu up label="Model the agent answers with" value={model} options={models} onpick={(m) => { model = m; post("model", { model }); }} />{/if}
      <!-- how full the context is: a ring by "send"; hovering shows the numbers and plan usage, a click keeps them open -->
      <span class="ctx" bind:this={ctxEl} role="group" onmouseenter={() => (hover = true)} onmouseleave={() => (hover = false)}>
        <button type="button" class="ring {ctxPct == null ? '' : level(ctxPct)}" onclick={() => (pinned = !pinned)}
          aria-label={context ? `Context ${Math.round(ctxPct ?? 0)}% used; plan usage` : "Context and plan usage"} aria-expanded={hover || pinned}>
          <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
            <circle class="track" cx="10" cy="10" r="7.5" />
            {#if ctxPct != null}<circle class="fill" cx="10" cy="10" r="7.5" pathLength="100" stroke-dasharray="{Math.max(1, ctxPct)} 100" transform="rotate(-90 10 10)" />{/if}
          </svg>
        </button>
        {#if hover || pinned}
          <div class="ctxpop">
            <div class="ctxline">
              {#if context}<b>{Math.round(ctxPct ?? 0)}%</b> of context: {k(context.used)} / {k(context.max)} tokens. Near the end, Claude Code compacts it.
              {:else}Context size shows after the agent's next reply.{/if}
            </div>
            {#if usage?.windows?.length}
              <div class="meters">
                {#each usage.windows as w (w.name)}
                  <div class="meter" title="{w.pct}% of the {w.name} limit used, {resets(w.resets)}">
                    <span class="mlabel">{w.name}</span>
                    <span class="bar"><i style="width:{Math.min(100, w.pct)}%" class={level(w.pct)}></i></span>
                    <span class="mval">{Math.round(w.pct)}%</span>
                  </div>
                {/each}
              </div>
              <div class="ctxnote">Your {usage.plan ?? "Claude"} plan</div>
            {/if}
          </div>
        {/if}
      </span>
      <!-- one round button in a fixed spot: stop while the agent works and nothing is typed, send otherwise
           (a message typed mid-turn reaches the agent while it works) -->
      {#if busy && !text.trim()}
        <button type="button" class="csend stop" onclick={() => post("stop")} title="Stop the agent" aria-label="Stop the agent">
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="4.5" y="4.5" width="7" height="7" rx="1.5" /></svg>
        </button>
      {:else}
        <button type="submit" class="csend" disabled={!text.trim()} title="Send (Enter)" aria-label="Send">
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 13V3.5M3.75 7.5 8 3.25l4.25 4.25" /></svg>
        </button>
      {/if}
    </div>
  </form>
</section>
