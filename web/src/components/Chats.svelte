<script lang="ts">
  // The chat panes, stacked top to bottom (one by default; "split" adds one below). The server
  // (src/chat.ts) decides which conversation each pane shows; this follows its one event stream
  // and hands each pane what is meant for it.
  import { onMount } from "svelte";
  import { chatFocus } from "../lib/state.svelte";
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

<div class="chats" class:hide={hidden}>
  {#each ids as id (id)}
    <Chat pane={id} {hidden} {onactivity} {agents} {listen} closable={ids.length > 1} />
  {/each}
</div>
