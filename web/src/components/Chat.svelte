<script lang="ts">
  // The agent chat. Cockpit runs the agent itself (src/chat.ts); the panel follows it live:
  // replies stream in, tool calls show as one line each (click for more), auto mode's questions
  // as Allow/Deny cards. Past conversations are a click away, in a list over the messages; several
  // agents can work at once (one per conversation), and the title says how many are working
  // elsewhere or waiting for you. The ring by "send" shows how full this conversation is, and
  // hovering it, how much of your plan's limits you've used.
  import { onMount, tick } from "svelte";
  import { api, copyTargetAt, fileRefAt, fileResolver, md, mdGrowing } from "../lib/code";
  import { openFile, S } from "../lib/state.svelte";
  import type { ChatAgent, ChatItem, ChatSession, Usage } from "../lib/types";
  import IconButton from "./ui/IconButton.svelte";
  import Menu from "./ui/Menu.svelte";

  let { hidden, onactivity }: { hidden: boolean; onactivity: (ask: boolean) => void } = $props();

  let items: ChatItem[] = $state([]);
  let busy = $state(false), model = $state("opus"), models: string[] = $state([]);
  let context = $state<{ used: number; max: number } | null>(null);
  let session: string | null = $state(null);
  let agents: ChatAgent[] = $state([]);
  // The agents working on other conversations, and those of them waiting for an Allow/Deny.
  const others = $derived(agents.filter((a) => a.session !== session && (a.busy || a.asking)));
  const othersAsking = $derived(others.filter((a) => a.asking).length);
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
  let listEl = $state<HTMLElement>(), titleEl = $state<HTMLElement>();
  const unpin = (e: PointerEvent) => {
    if (pinned && !ctxEl?.contains(e.target as Node)) pinned = false;
    if (list && !listEl?.contains(e.target as Node) && !titleEl?.contains(e.target as Node)) list = null;
  };
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
        items = e.items; busy = e.busy; model = e.model; models = e.models; context = e.context; session = e.session; agents = e.agents ?? [];
        stick(true);
      } else if (e.type === "state") { busy = e.busy; model = e.model; context = e.context; session = e.session; }
      else if (e.type === "agents") {
        const asked = e.agents.some((a: ChatAgent) => a.asking && a.session !== session && !agents.some((b) => b.session === a.session && b.asking));
        agents = e.agents;
        if (asked) onactivity(true); // another conversation's agent waits for an Allow/Deny
        if (list) refreshList();
      }
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
    if (!t && !images.length) return;
    const imgs = images.map(({ media, data, thumb }) => ({ media, data, thumb }));
    text = ""; images = []; pasteErr = ""; near = true;
    post("send", { text: t, images: imgs });
  }
  // Images pasted (Ctrl+V) or dropped into the message box go along with the message. Claude takes
  // png, jpeg, gif and webp up to 5 MB; big ones are scaled down to 1568 px, the most it looks at.
  type Pasted = { media: string; data: string; thumb: string };
  let images = $state<Pasted[]>([]), pasteErr = $state("");
  const TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
  const asUrl = (f: Blob) => new Promise<string>((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.onerror = () => no(r.error); r.readAsDataURL(f); });
  async function scaled(f: Blob, max: number, type: string, quality?: number) {
    const bmp = await createImageBitmap(f), k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close();
    return { url: c.toDataURL(type, quality), big: k < 1 };
  }
  async function addImages(files: File[]) {
    pasteErr = "";
    for (const f of files) {
      if (!TYPES.includes(f.type)) { pasteErr = `${f.type || "that file"}: only png, jpeg, gif or webp`; continue; }
      try {
        const full = await scaled(f, 1568, f.type === "image/jpeg" ? "image/jpeg" : "image/png", 0.9);
        const url = full.big || f.type === "image/png" || f.type === "image/jpeg" ? full.url : await asUrl(f);
        const [head, data] = url.split(",");
        const media = head.slice(5, head.indexOf(";"));
        if (data.length * 0.75 > 5e6) { pasteErr = "image too large (over 5 MB)"; continue; }
        images = [...images, { media, data, thumb: (await scaled(f, 240, "image/jpeg", 0.8)).url }];
      } catch (e) { pasteErr = "couldn't read the image: " + e; }
    }
  }
  function onPaste(e: ClipboardEvent) {
    const files = [...(e.clipboardData?.items ?? [])].filter((i) => i.kind === "file" && i.type.startsWith("image/")).map((i) => i.getAsFile()).filter((f): f is File => !!f);
    if (files.length) { e.preventDefault(); addImages(files); }
  }
  function onDrop(e: DragEvent) {
    const files = [...(e.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith("image/"));
    if (files.length) { e.preventDefault(); addImages(files); }
  }
  async function loadUsage() { try { usage = await api.get<Usage>("api/chat/usage"); } catch {} }
  async function showList() {
    if (list) { list = null; return; }
    list = [];
    await refreshList();
  }
  async function refreshList() { const l = await api.get<ChatSession[]>("api/chat/sessions").catch(() => null); if (l && list) list = l; }
  // Agents started here whose conversation Claude Code doesn't list yet (no transcript so far).
  const unlisted = $derived(list ? others.filter((a) => !a.session || !list!.some((s) => s.id === a.session)) : []);
  async function openSession(id: string) { list = null; await post("open", { id }); }
  // The open conversation's name ("Chat 3", or its /rename title), looked up when it changes.
  let names = $state<ChatSession[]>([]);
  $effect(() => { if (session && !names.some((x) => x.id === session)) api.get<ChatSession[]>("api/chat/sessions").then((l) => (names = l)).catch(() => {}); });
  // Deleting a past conversation takes two clicks in place, like reverting a file; leaving the row cancels.
  let arming = $state<string | null>(null);
  async function remove(id: string) {
    if (arming !== id) { arming = id; return; }
    arming = null;
    const r = await api.post<{ error?: string }>("api/chat/delete", { id }).catch((e) => ({ error: String(e) }));
    if (!r?.error && list) { list = list.filter((x) => x.id !== id); names = names.filter((x) => x.id !== id); }
  }

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
  // In a workspace window: every project, each in its own .cockpit/, and how they fit together.
  const wsNames = $derived(S.workspace?.projects.map((p) => p.name) ?? []);
  const describe = () => post("send", { text: wsNames.length > 1
    ? `Describe the projects of this workspace (${wsNames.join(", ")}), each in its own .cockpit/: the summary, the features, and the diagrams that best explain how it works, as many as each one needs. Then write how they fit together in the workspace's SYSTEM.md. Don't change the code.`
    : "Describe this project in .cockpit/: the summary, the features, and the diagrams that best explain how it works, as many as this project needs. Don't change the code." });
  const title = $derived(session ? ((list ?? names).find((x) => x.id === session)?.title ?? "Chat") : "New chat");
</script>

<svelte:window onpointerdown={unpin} onkeydown={(e) => { if (e.key === "Escape") { pinned = false; list = null; } }} />

<section id="chat" class:hide={hidden}>
  <div class="ctools">
    <button class="ctitle" class:on={!!list} bind:this={titleEl} onclick={showList} title="Your conversations in this project">
      <span class="ctname">{title}</span>
      {#if others.length}<span class="cagents" class:asking={othersAsking > 0} title={othersAsking ? `${othersAsking} waiting for you` : `${others.length} more working`}>{#if othersAsking}!{:else}<span class="spin"></span>{/if}{others.length}</span>{/if}
      <span class="chev" aria-hidden="true">▾</span>
    </button>
    <span class="grow"></span>
    <IconButton label="New conversation (this one stays in the list, and keeps working if it is)" onclick={() => { list = null; post("new"); }}>
      <path d="M8 3.5v9M3.5 8h9" />
    </IconButton>
  </div>
  {#if list}
    <div class="clist" bind:this={listEl}>
      {#if !list.length && !unlisted.length}<p class="muted">loading…</p>{/if}
      {#each unlisted as a (a.session ?? a.preview)}
        <div class="csrow"><button class="csess" disabled={!a.session} onclick={() => a.session && openSession(a.session)} title={a.preview}>
          <span class="cst">New chat<span class="muted cwhen"> · {a.asking ? "waiting for you" : "working"}</span></span>
          {#if a.preview}<span class="muted cprev">{a.preview}</span>{/if}
        </button><span class="cstate" class:asking={a.asking}>{#if a.asking}!{:else}<span class="spin"></span>{/if}</span></div>
      {/each}
      {#each list as s (s.id)}
        <div class="csrow" role="presentation" onmouseleave={() => { if (arming === s.id) arming = null; }}>
          <button class="csess" class:on={s.id === session} onclick={() => openSession(s.id)} title={s.preview}>
            <span class="cst">{s.title}<span class="muted cwhen"> · {s.asking ? "waiting for you" : s.busy ? "working" : ago(s.at)}{s.branch ? " · " + s.branch : ""}{s.here ? "" : " · terminal"}</span></span>
            {#if s.preview}<span class="muted cprev">{s.preview}</span>{/if}
          </button>
          {#if s.busy || s.asking}<span class="cstate" class:asking={s.asking}>{#if s.asking}!{:else}<span class="spin"></span>{/if}</span>{/if}
          {#if s.id !== session && !s.busy}
            {#if arming === s.id}<button class="cdel armed" onclick={() => remove(s.id)} title="Click to delete it for good (Claude Code's copy too)">Delete</button>
            {:else}<button class="cdel" onclick={() => remove(s.id)} title="Delete this conversation" aria-label="Delete this conversation">
              <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" /></svg></button>{/if}
          {/if}
        </div>
      {/each}
    </div>
  {/if}
  <div id="msgs" bind:this={msgs} onscroll={() => (near = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 60)}>
    {#each items as it (it.id)}
      {#if it.kind === "user"}<div class="cuser">{#if it.thumbs?.length || it.images}<div class="cthumbs">{#each it.thumbs ?? [] as t}<img src={t} alt="pasted" />{:else}<span class="muted">🖼 image</span>{/each}</div>{/if}{it.text}</div>
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
          <div class="kicker">{it.status === "waiting" ? "the agent asks" : it.status === "expired" ? "no answer: declined" : it.status}</div>
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
        <p>Talk to the agent here. It works in {#if wsNames.length > 1}the workspace <b>{S.workspace?.name}</b> ({wsNames.join(", ")}){:else}<b>{S.project}</b>{/if}, and what it changes lights up on the diagrams.</p>
        {#if fresh}<p class="muted">{wsNames.length > 1 ? "These projects have" : "This project has"} no description yet.</p>
          <button onclick={describe}>{wsNames.length > 1 ? `Describe the ${wsNames.length} projects` : "Describe this project"}</button>{/if}
      </div>
    {/each}
  </div>
  <form id="composer" onsubmit={(e) => { e.preventDefault(); send(); }}>
    {#if images.length || pasteErr}
      <div class="cthumbs pending">
        {#each images as img, i}<span class="cthumb"><img src={img.thumb} alt="pasted" /><button type="button" title="Remove" aria-label="Remove image" onclick={() => (images = images.filter((_, j) => j !== i))}>×</button></span>{/each}
        {#if pasteErr}<span class="bad">{pasteErr}</span>{/if}
      </div>
    {/if}
    <textarea onpaste={onPaste} ondrop={onDrop} rows="3" bind:this={ta} bind:value={text} placeholder="Ask the agent…"
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
      {#if busy && !text.trim() && !images.length}
        <button type="button" class="csend stop" onclick={() => post("stop")} title="Stop the agent" aria-label="Stop the agent">
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="4.5" y="4.5" width="7" height="7" rx="1.5" /></svg>
        </button>
      {:else}
        <button type="submit" class="csend" disabled={!text.trim() && !images.length} title="Send (Enter)" aria-label="Send">
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 13V3.5M3.75 7.5 8 3.25l4.25 4.25" /></svg>
        </button>
      {/if}
    </div>
  </form>
</section>
