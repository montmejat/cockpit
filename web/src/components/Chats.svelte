<script lang="ts">
  // The chat panes, stacked top to bottom (one by default; "split" adds one below). The server
  // (src/chat.ts) decides which conversation each pane shows; this follows its one event stream
  // and hands each pane what is meant for it. With several, the line between two drags to resize
  // them and a pane's bar drags it up or down; both are kept (here, in the page's storage).
  import { onMount } from "svelte";
  import { chatFocus, store } from "../lib/state.svelte";
  import type { ChatAgent } from "../lib/types";
  import Chat from "./Chat.svelte";

  let { hidden, onactivity }: { hidden: boolean; onactivity: (ask: boolean) => void } = $props();

  type Ev = { type: string; pane?: number; [k: string]: any };
  let ids = $state<number[]>([]);
  let agents = $state<ChatAgent[]>([]);
  // Each pane's latest whole conversation, for a pane that mounts after it came; and its listener.
  const snaps = new Map<number, Ev>();
  const subs = new Map<number, (e: Ev) => void>();
  function listen(pane: number, f: (e: Ev) => void) {
    subs.set(pane, f);
    const s = snaps.get(pane);
    if (s) f(s);
    return () => { if (subs.get(pane) === f) subs.delete(pane); };
  }
  function setIds(next: number[]) {
    ids = next;
    if (!next.includes(chatFocus.pane)) chatFocus.pane = next[0] ?? 0;
  }

  // Order and sizes, by pane id. A pane the order doesn't know yet goes last.
  const load = <T,>(k: string, d: T): T => { try { return JSON.parse(store.get(k, "")) ?? d; } catch { return d; } };
  let order = $state<number[]>(load("cockpit-chat-order", []));
  let weights = $state<Record<number, number>>(load("cockpit-chat-weights", {}));
  const rank = (id: number) => { const i = order.indexOf(id); return i < 0 ? 1e6 + id : i; };
  const shown = $derived([...ids].sort((a, b) => rank(a) - rank(b)));
  const MIN = 120;
  let box: HTMLElement;
  const paneEl = (id: number) => box.querySelector<HTMLElement>(`[data-cpane="${id}"]`)!;
  function follow(move: (e: PointerEvent) => void, done: (e: PointerEvent) => void) {
    const up = (e: PointerEvent) => { removeEventListener("pointermove", move); removeEventListener("pointerup", up); done(e); };
    addEventListener("pointermove", move); addEventListener("pointerup", up);
  }

  // The line between two panes: share their height between them.
  function resize(e: PointerEvent, i: number) {
    if (e.button !== 0) return;
    e.preventDefault();
    const a = shown[i - 1], b = shown[i], ha = paneEl(a).offsetHeight, hb = paneEl(b).offsetHeight, y0 = e.clientY;
    const w = (weights[a] ?? 1) + (weights[b] ?? 1);
    follow((ev) => {
      const h = Math.max(MIN, Math.min(ha + hb - MIN, ha + ev.clientY - y0));
      weights = { ...weights, [a]: (w * h) / (ha + hb), [b]: (w * (ha + hb - h)) / (ha + hb) };
    }, () => store.set("cockpit-chat-weights", JSON.stringify(weights)));
  }
  // A pane's bar (not its buttons' clicks): past a few pixels it drags, and drops between the others.
  let drag = $state<{ id: number; at: number; y: number } | null>(null);
  function grab(e: PointerEvent, id: number) {
    const t = e.target as HTMLElement;
    if (shown.length < 2 || e.button !== 0 || !t.closest(".ctools") || t.closest(".ibtn")) return;
    const y0 = e.clientY;
    follow((ev) => {
      if (!drag && Math.abs(ev.clientY - y0) < 5) return;
      // where it would land: before the first pane whose middle is below the pointer
      const top = box.getBoundingClientRect().top;
      let at = shown.length, y = box.scrollHeight;
      for (let i = 0; i < shown.length; i++) {
        const r = paneEl(shown[i]).getBoundingClientRect();
        if (ev.clientY < r.top + r.height / 2) { at = i; y = r.top - top; break; }
      }
      drag = { id, at, y };
    }, () => {
      if (!drag) return;
      const rest = shown.filter((x) => x !== drag!.id), from = shown.indexOf(drag.id);
      rest.splice(drag.at > from ? drag.at - 1 : drag.at, 0, drag.id);
      order = rest;
      store.set("cockpit-chat-order", JSON.stringify(order));
      drag = null;
      // the press was a drag, not a click on the title
      const eat = (c: MouseEvent) => { c.stopPropagation(); c.preventDefault(); };
      addEventListener("click", eat, { capture: true, once: true });
      setTimeout(() => removeEventListener("click", eat, { capture: true }));
    });
  }

  onMount(() => {
    const es = new EventSource("api/chat/events");
    es.onmessage = (m) => {
      const e: Ev = JSON.parse(m.data);
      if (e.type === "init") {
        for (const p of e.panes) { const s = { ...p, type: "pane" }; snaps.set(p.pane, s); subs.get(p.pane)?.(s); }
        agents = e.agents;
        setIds(e.panes.map((p: Ev) => p.pane));
      } else if (e.type === "panes") setIds(e.ids);
      else if (e.type === "agents") {
        // a conversation no pane shows started waiting for an Allow/Deny
        const asked = e.agents.some((a: ChatAgent) => a.asking && a.pane == null && !agents.some((b) => b.session === a.session && b.asking));
        agents = e.agents;
        if (asked) onactivity(true);
      } else if (e.pane != null) {
        if (e.type === "pane") snaps.set(e.pane, e);
        subs.get(e.pane)?.(e);
      }
    };
    return () => es.close();
  });
</script>

<div class="chats" class:hide={hidden} class:many={shown.length > 1} class:dragging={!!drag} bind:this={box}>
  {#each shown as id, i (id)}
    {#if i > 0}<div class="csplit" role="separator" aria-orientation="horizontal" onpointerdown={(e) => resize(e, i)}></div>{/if}
    <div class="cpane" class:lifted={drag?.id === id} data-cpane={id} style:flex-grow={weights[id] ?? 1} onpointerdown={(e) => grab(e, id)} role="presentation">
      <Chat pane={id} {hidden} {onactivity} {agents} {listen} closable={ids.length > 1} />
    </div>
  {/each}
  {#if drag}<div class="cdrop" style:top="{drag.y}px"></div>{/if}
</div>
