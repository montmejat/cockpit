<script lang="ts">
  // Real shells in the project folder (src/term.ts), in a drawer under the center. They outlive the
  // page: a reload reattaches to them. Ctrl+` shows and hides the drawer; Ctrl+K opens the ask line,
  // which turns words into a command on the prompt (src/ask.ts) and never runs anything.
  import { onMount } from "svelte";
  import { Terminal as XTerm } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import { api } from "../lib/code";
  import { initialTerminals, S, store } from "../lib/state.svelte";
  import type { TermMeta } from "../lib/types";

  type View = { id: string; meta: TermMeta; el: HTMLElement; term: XTerm; fit: FitAddon; ws: WebSocket; opened: boolean; size: string };

  let open = $state(false);
  let h = $state(Math.max(120, +store.get("cockpit-term-h", "260") || 260));
  let metas: TermMeta[] = $state([]);
  let active: string | null = $state(null);
  const views = new Map<string, View>();
  let tbody: HTMLElement;

  const css = (v: string) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const theme = () => ({
    background: css("--card"), foreground: css("--fg"), cursor: css("--fg"), cursorAccent: css("--card"), selectionBackground: css("--sel"),
    black: css("--muted"), red: css("--bad"), green: css("--ok"), yellow: css("--warn"), blue: css("--accent"), magenta: css("--k"), cyan: css("--t"), white: css("--fg"),
    brightBlack: css("--muted"), brightRed: css("--bad"), brightGreen: css("--ok"), brightYellow: css("--warn"), brightBlue: css("--accent"), brightMagenta: css("--k"), brightCyan: css("--t"), brightWhite: css("--fg"),
  });
  const syncMetas = () => (metas = [...views.values()].map((v) => v.meta));

  function view(meta: TermMeta): View {
    if (views.has(meta.id)) return views.get(meta.id)!;
    const el = document.createElement("div");
    el.className = "tview"; el.hidden = true;
    tbody.append(el);
    const term = new XTerm({ fontFamily: '"JetBrains Mono", ui-monospace, monospace', fontSize: 12.5, lineHeight: 1.2, cursorBlink: true, scrollback: 5000, theme: theme(), allowProposedApi: true });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/api/term/ws?id=" + encodeURIComponent(meta.id));
    const v: View = { id: meta.id, meta, el, term, fit, ws, opened: false, size: "" };
    // Ctrl+Shift+C copies; Ctrl+Shift+V is left to the browser, which pastes into the terminal.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === "keydown" && e.ctrlKey && e.shiftKey && (e.key === "C" || e.key === "c")) { navigator.clipboard?.writeText(term.getSelection()).catch(() => {}); return false; }
      if (e.ctrlKey && e.shiftKey && (e.key === "V" || e.key === "v")) return false;
      if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === "k" || e.key === "K")) { if (e.type === "keydown") openAsk(); return false; }
      if (e.ctrlKey && (e.code === "Backquote" || e.key === "`")) return false;
      return true;
    });
    term.onData((d) => ws.readyState === 1 && ws.send(JSON.stringify({ t: "in", d })));
    ws.onopen = () => { v.size = ""; fitView(v); };
    ws.onmessage = (e) => {
      const d = String(e.data);
      if (d[0] === "o") term.write(d.slice(1));
      else if (d[0] === "m") { v.meta = JSON.parse(d.slice(1)); syncMetas(); }
    };
    ws.onclose = () => gone(v.id);
    views.set(meta.id, v);
    syncMetas();
    return v;
  }
  function gone(id: string) {
    const v = views.get(id);
    if (!v) return;
    v.term.dispose(); v.el.remove(); views.delete(id);
    syncMetas();
    if (active === id) active = [...views.keys()].at(-1) ?? null;
    if (!views.size) show(false); else showView(active!);
  }
  function fitView(v?: View) {
    if (!v || v.el.hidden || !v.opened) return;
    try { v.fit.fit(); } catch { return; }
    const size = v.term.cols + "x" + v.term.rows;
    if (size !== v.size && v.ws.readyState === 1) { v.size = size; v.ws.send(JSON.stringify({ t: "size", cols: v.term.cols, rows: v.term.rows })); }
  }
  function showView(id: string) {
    active = id;
    for (const v of views.values()) v.el.hidden = v.id !== id;
    const v = views.get(id);
    if (v && !v.opened) { v.term.open(v.el); v.opened = true; }
    requestAnimationFrame(() => { fitView(v); if (open) v?.term.focus(); });
  }
  async function newTerm() {
    const { id } = await api.post("/api/term/new", { cols: 100, rows: 20 });
    view({ id, n: 0, cwd: "", running: null, last: null });
    showView(id);
  }
  async function show(o: boolean) {
    open = o;
    store.set("cockpit-term-open-" + S.project, o ? "1" : "0");
    if (o && !views.size) await newTerm();
    else if (o) showView(active ?? [...views.keys()][0]);
  }
  export function toggle() { show(!open); }

  onMount(() => {
    for (const m of initialTerminals) view(m);
    active = initialTerminals.at(-1)?.id ?? null;
    if (store.get("cockpit-term-open-" + S.project, "0") === "1") show(true);
    const ro = new ResizeObserver(() => fitView(views.get(active ?? "")));
    ro.observe(tbody);
    const mq = matchMedia("(prefers-color-scheme: dark)"), recolor = () => { for (const v of views.values()) v.term.options.theme = theme(); };
    mq.addEventListener("change", recolor);
    // Cells are measured with the font: measure again once it has loaded.
    document.fonts.ready.then(() => { for (const v of views.values()) if (v.opened) { v.term.options.fontFamily = v.term.options.fontFamily + ""; v.size = ""; } fitView(views.get(active ?? "")); });
    return () => { ro.disconnect(); mq.removeEventListener("change", recolor); };
  });

  function split(e: PointerEvent) {
    e.preventDefault();
    const y0 = e.clientY, h0 = h, max = () => (tbody.closest("#center") as HTMLElement).clientHeight - 120;
    const move = (ev: PointerEvent) => (h = Math.max(100, Math.min(max(), h0 + y0 - ev.clientY)));
    const up = () => { removeEventListener("pointermove", move); removeEventListener("pointerup", up); store.set("cockpit-term-h", String(h)); };
    addEventListener("pointermove", move); addEventListener("pointerup", up);
  }

  const label = (m: TermMeta) => (m.running ? m.running.split(/\s+/).slice(0, 2).join(" ") : m.cwd.split("/").pop() || "/");

  // ---- the ask line ----
  let asking = $state(false), q = $state(""), asked = "", picks: { command: string; why: string }[] = $state([]), sel = $state(0), note = $state(""), status = $state(""), waiting = false;
  let input: HTMLInputElement | undefined = $state();
  export async function openAsk() {
    if (!open) await show(true);
    asking = true;
    requestAnimationFrame(() => { input?.focus(); input?.select(); fitView(views.get(active ?? "")); });
  }
  function closeAsk(refocus = true) {
    asking = false; picks = []; asked = ""; note = "";
    const v = views.get(active ?? "");
    requestAnimationFrame(() => { fitView(v); if (refocus) v?.term.focus(); });
  }
  function insert(i: number) {
    const p = picks[i], v = views.get(active ?? "");
    if (!p || !v || v.ws.readyState !== 1) return;
    // Ctrl+E Ctrl+U empties the prompt line first, unless a program is running and reading keys.
    v.ws.send(JSON.stringify({ t: "in", d: (v.meta.running ? "" : "\x05\x15") + p.command }));
    closeAsk();
  }
  async function submit(e: Event) {
    e.preventDefault();
    const text = q.trim();
    if (!text) return;
    if (picks.length && text === asked) return insert(sel);
    if (waiting) return;
    waiting = true; asked = text; picks = []; note = ""; status = "thinking…";
    try {
      const r = await api.post("/api/term/ask", { id: active, text });
      if (r.error) throw new Error(r.error);
      picks = r.suggestions; sel = 0; note = r.note ?? "";
      status = (r.ms / 1000).toFixed(1) + " s";
    } catch (err: any) { asked = ""; note = "Couldn't get a command: " + err.message; status = ""; }
    finally { waiting = false; requestAnimationFrame(() => fitView(views.get(active ?? ""))); }
  }
  function askKeys(e: KeyboardEvent) {
    if (e.key === "Escape") { e.preventDefault(); closeAsk(); }
    else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && picks.length) { e.preventDefault(); sel = (sel + (e.key === "ArrowDown" ? 1 : picks.length - 1)) % picks.length; }
  }
</script>

<div id="tsplit" class:hide={!open} onpointerdown={split} role="separator"></div>
<section id="term" class:hide={!open} style="height:{h}px">
  <div class="ttabs">
    <span id="tlist">
      {#each metas as m (m.id)}
        <span class="ttab" class:on={m.id === active} title={m.running ?? m.cwd} role="tab" tabindex="0" aria-selected={m.id === active} onclick={() => showView(m.id)} onkeydown={(e) => e.key === "Enter" && showView(m.id)}>
          {#if m.running}<span class="trun" title="running">●</span>{:else if m.last && m.last.exit !== 0 && m.last.exit !== undefined}<span class="tbad" title="last command failed (exit {m.last.exit})">✕</span>{/if}
          {label(m)}
          <button class="tx" title="Close this terminal" onclick={(e) => { e.stopPropagation(); api.post("/api/term/close", { id: m.id }); }}>×</button>
        </span>
      {/each}
    </span>
    <button title="New terminal" onclick={newTerm}>+</button>
    <span class="grow"></span>
    <button title="Ask for a command  (Ctrl+K)" onclick={openAsk}>✦ ask</button>
    <button title="Hide  (Ctrl+`)" onclick={() => show(false)}>hide</button>
  </div>
  <div id="tbody" bind:this={tbody}></div>
  {#if asking && (picks.length || note)}
    <div id="tsugg">
      {#each picks as p, i}<button class="tpick" class:on={i === sel} onclick={() => insert(i)}><code>{p.command}</code><span class="muted">{p.why}</span></button>{/each}
      {#if note}<div class="tnote">{note}</div>{/if}
    </div>
  {/if}
  {#if asking}
    <form id="task" onsubmit={submit}>
      <span class="tk">✦</span>
      <input bind:this={input} bind:value={q} onkeydown={askKeys} autocomplete="off" spellcheck="false" placeholder="What do you want to run?  Enter asks · ↑↓ pick · Enter puts it on the prompt · Esc">
      <span class="tstate muted">{status}</span>
    </form>
  {/if}
</section>
