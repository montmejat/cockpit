<script lang="ts">
  // Real shells in the project folder (src/term.ts), in a drawer under the center. They outlive the
  // page: a reload reattaches to them. Keys first: Ctrl+` shows and hides the drawer, Ctrl+Shift+`
  // opens another shell, Ctrl+PageUp/PageDown go between them, Ctrl+K opens the ask line, which
  // turns words into a command on the prompt (src/ask.ts) and never runs anything. The slim bar
  // above has a tab per shell (middle-click closes one), ask and new on the right.
  // Each command is a block (the shell's OSC 133 marks): hovering one offers to send it, with its
  // output, to the chat; a failed one gets a pill with the same; Ctrl+L sends the selection, or
  // else the last command, and goes to the chat.
  import { onMount } from "svelte";
  import { Terminal as XTerm, type IMarker } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import { api, wsUrl } from "../lib/code";
  import { attachToChat, initialTerminals, S, store, type ChatAttached } from "../lib/state.svelte";
  import type { TermMeta } from "../lib/types";
  import IconButton from "./ui/IconButton.svelte";
  import Tab from "./ui/Tab.svelte";

  // A command: its prompt line (a), where its output starts (c), where it ended (d; `back` 1 when
  // the end mark came at the start of a new line), its text and exit code.
  type Block = { a: IMarker; c?: IMarker; d?: IMarker; back: number; cmd: string; exit?: number };
  type View = { id: string; meta: TermMeta; el: HTMLElement; term: XTerm; fit: FitAddon; ws: WebSocket; opened: boolean; size: string; blocks: Block[] };

  let open = $state(false);
  // Its height: dragged from its top edge and kept; until then a good share of the window (it opens
  // when needed and closes after, so it can be generous).
  const defH = Math.max(260, Math.round(innerHeight * 0.45));
  let h = $state(Math.max(120, +store.get("cockpit-term-h", String(defH)) || defH));
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
    const ws = new WebSocket(wsUrl("api/term/ws?id=" + encodeURIComponent(meta.id)));
    const v: View = { id: meta.id, meta, el, term, fit, ws, opened: false, size: "", blocks: [] };
    track(v);
    // Ctrl+Shift+C copies; Ctrl+Shift+V is left to the browser, which pastes into the terminal.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === "keydown" && e.ctrlKey && e.shiftKey && (e.key === "C" || e.key === "c")) { navigator.clipboard?.writeText(term.getSelection()).catch(() => {}); return false; }
      if (e.ctrlKey && e.shiftKey && (e.key === "V" || e.key === "v")) return false;
      if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === "k" || e.key === "K")) { if (e.type === "keydown") openAsk(); return false; }
      if (e.ctrlKey && (e.code === "Backquote" || e.key === "`")) return false;
      if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === "PageUp" || e.key === "PageDown")) { if (e.type === "keydown") cycle(e.key === "PageDown" ? 1 : -1); return false; }
      // Ctrl+L goes to the chat with the selection or the last command (App.svelte; `clear` still clears the screen).
      if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && (e.key === "l" || e.key === "L")) return false;
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
  // ---- command blocks, from the marks of the shell hook (src/term.ts) ----
  let rev = $state(0); // bumped when a command starts or ends
  function track(v: View) {
    const { term } = v;
    let next = "";
    const mark = () => term.registerMarker(0);
    term.parser.registerOscHandler(633, (d) => { if (d.startsWith("E;")) next = d.slice(2); return false; });
    term.parser.registerOscHandler(133, (d) => {
      const bs = v.blocks, last = bs.at(-1);
      if (d === "A") {
        // A prompt with no command run since the last one only moves.
        if (last && !last.c) { last.a.dispose(); const m = mark(); if (m) last.a = m; else bs.pop(); }
        else { const m = mark(); if (m) bs.push({ a: m, back: 0, cmd: "" }); }
        while (bs.length && bs[0].a.isDisposed) bs.shift(); // scrolled out of the scrollback
      } else if (d === "C") {
        const m = mark();
        if (!m) return false;
        if (last && !last.c) { last.c = m; last.cmd = next; } else bs.push({ a: m, c: m, back: 0, cmd: next });
        next = ""; rev++;
      } else if (d.startsWith("D") && last?.c && !last.d) {
        const m = mark();
        if (m) { last.d = m; last.back = term.buffer.active.cursorX === 0 ? 1 : 0; last.exit = Number(d.split(";")[1] ?? 0); rev++; }
      }
      return false;
    });
    term.onScroll(() => requestAnimationFrame(rehover));
  }
  const live = (b: Block) => !!b.c && !b.a.isDisposed && !b.c.isDisposed;
  const endOf = (v: View, b: Block) => (b.d && !b.d.isDisposed ? Math.max(b.c!.line, b.d.line - b.back) : v.term.buffer.active.baseY + v.term.buffer.active.cursorY);
  const failedExit = (b: Block) => b.d != null && b.exit !== 0 && b.exit !== 130 && b.exit !== 148; // not Ctrl+C, Ctrl+Z
  // Lines as text, wrapped lines joined back.
  function linesOf(term: XTerm, from: number, to: number) {
    const buf = term.buffer.active;
    let out = "";
    for (let i = from; i <= to; i++) { const l = buf.getLine(i); if (l) out += (i === from || l.isWrapped ? "" : "\n") + l.translateToString(true); }
    return out.replace(/\s+$/, "");
  }
  // Long output keeps its start (where compilers put the first error) and its end.
  function clip(s: string) {
    if (s.length <= 16000) return s;
    const head = s.slice(0, 4000), tail = s.slice(-11000), cut = s.slice(4000, -11000).split("\n").length;
    return head + `\n… (${cut} lines left out) …\n` + tail;
  }
  const short = (c: string) => (c.length > 48 ? c.slice(0, 47) + "…" : c) || "(command)";
  function blockCtx(v: View, b: Block): ChatAttached {
    const status = b.d ? (b.exit === 0 ? "ok" : `exit ${b.exit}`) : "running";
    const out = linesOf(v.term, b.c!.line, endOf(v, b));
    return {
      label: `$ ${short(b.cmd)} · ${status}`, bad: failedExit(b),
      text: `From the owner's terminal ${v.id} (cwd ${v.meta.cwd || "?"}): a command, ${b.d ? (b.exit === 0 ? "finished (exit 0)" : `failed (exit ${b.exit})`) : "still running"}, and its output.\n$ ${b.cmd}\n${clip(out) || "(no output)"}`,
    };
  }
  function selCtx(v: View): ChatAttached | null {
    const sel = v.term.getSelection().replace(/\s+$/, "");
    if (!sel.trim()) return null;
    const n = sel.split("\n").length;
    return { label: `terminal selection · ${n} line${n > 1 ? "s" : ""}`, text: `Selected in the owner's terminal ${v.id} (cwd ${v.meta.cwd || "?"}):\n${clip(sel)}` };
  }
  const lastBlock = (v: View) => v.blocks.findLast(live);
  // Ctrl+L from the terminal (App.svelte): the selection if there is one, else the last command.
  export function toChat() {
    const v = views.get(active ?? "");
    if (!v) return;
    const s = selCtx(v), b = lastBlock(v);
    if (s) { attachToChat(s); v.term.clearSelection(); }
    else if (b && v.term.buffer.active.type === "normal") attachToChat(blockCtx(v, b));
  }
  const FIX = "This command failed. Find out why, and fix it if the cause is in the code.";
  function send(b: Block, fix = false) {
    const v = views.get(active ?? "");
    if (v && live(b)) attachToChat(blockCtx(v, b), fix ? FIX : undefined);
    hov = null;
  }

  // The block under the mouse, outlined, with its buttons.
  let termEl: HTMLElement;
  let hov: { b: Block; top: number; height: number; left: number; width: number; bad: boolean } | null = $state(null);
  let mouse: { x: number; y: number } | null = null;
  function rehover() {
    const v = views.get(active ?? "");
    if (!mouse || !v || !v.opened || v.term.buffer.active.type !== "normal") { hov = null; return; }
    const scr = v.el.querySelector(".xterm-screen") as HTMLElement | null;
    if (!scr) return;
    const r = scr.getBoundingClientRect(), T = termEl.getBoundingClientRect(), ch = r.height / v.term.rows;
    if (mouse.y < r.top || mouse.y > r.bottom || mouse.x < r.left - 8 || mouse.x > r.right + 8) { hov = null; return; }
    const vy = v.term.buffer.active.viewportY, line = vy + Math.floor((mouse.y - r.top) / ch);
    const b = v.blocks.findLast((x) => live(x) && x.a.line <= line && line <= endOf(v, x));
    if (!b) { hov = null; return; }
    const from = Math.max(b.a.line - vy, 0), to = Math.min(endOf(v, b) - vy, v.term.rows - 1);
    hov = { b, top: r.top - T.top + from * ch, height: (to - from + 1) * ch, left: r.left - T.left - 6, width: r.width + 6, bad: failedExit(b) };
  }
  function onMove(e: MouseEvent) {
    if ((e.target as HTMLElement).closest?.(".thov")) return; // on the buttons: keep the block
    mouse = { x: e.clientX, y: e.clientY };
    rehover();
  }
  // The last command, if it failed: a pill until the next one starts or you close it.
  const dismissed = new WeakSet<Block>();
  let dismissRev = $state(0);
  const failed = $derived.by(() => {
    rev; active; dismissRev;
    const v = views.get(active ?? ""), b = v && lastBlock(v);
    return b && failedExit(b) && !dismissed.has(b) ? b : null;
  });

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
  // Ctrl+PageUp/PageDown: the previous or next shell, wrapping around.
  function cycle(d: number) {
    const ids = [...views.keys()], i = ids.indexOf(active ?? "");
    if (ids.length > 1) showView(ids[(i + d + ids.length) % ids.length]);
  }
  // In a workspace of several projects, a new terminal first asks which one it starts in.
  const projects = $derived(S.workspace && S.workspace.projects.length > 1 ? S.workspace.projects : []);
  let picking = $state(false), pick = $state(0);
  let pickEl: HTMLElement | undefined = $state();
  function newTerm() {
    if (!projects.length) return startTerm();
    pick = Math.max(0, projects.findIndex((p) => p.here));
    picking = true;
    requestAnimationFrame(() => pickEl?.focus());
  }
  async function startTerm(project?: string) {
    picking = false;
    const { id } = await api.post("api/term/new", { cols: 100, rows: 20, project });
    view({ id, n: 0, cwd: "", running: null, last: null });
    showView(id);
  }
  function pickKeys(e: KeyboardEvent) {
    const n = projects.length;
    if (e.key === "Escape") { e.preventDefault(); picking = false; if (!views.size) show(false); else views.get(active ?? "")?.term.focus(); }
    else if (["l", "j", "ArrowRight", "ArrowDown"].includes(e.key)) { e.preventDefault(); pick = (pick + 1) % n; }
    else if (["h", "k", "ArrowLeft", "ArrowUp"].includes(e.key)) { e.preventDefault(); pick = (pick + n - 1) % n; }
    else if (e.key === "Enter") { e.preventDefault(); startTerm(projects[pick].name); }
    else if (/^[1-9]$/.test(e.key) && +e.key <= n) { e.preventDefault(); startTerm(projects[+e.key - 1].name); }
  }
  async function show(o: boolean) {
    open = o;
    store.set("cockpit-term-open-" + S.project, o ? "1" : "0");
    if (!o) picking = false;
    if (o && !views.size) await newTerm();
    else if (o) showView(active ?? [...views.keys()][0]);
  }
  // Ctrl+`: open the terminal and go to it; when it's open but you're elsewhere (the chat, the
  // editor), go to it; close it only when you're in it already. A button (`plain`) just shows or hides it.
  // Ctrl+Shift+`: another shell (opening the drawer if it's shut).
  export async function another() {
    if (!open) { open = true; store.set("cockpit-term-open-" + S.project, "1"); }
    await newTerm();
  }
  export function toggle(plain = false) {
    if (open && !plain && !document.activeElement?.closest?.("#term")) { const v = views.get(active ?? ""); picking ? pickEl?.focus() : asking ? input?.focus() : v?.term.focus(); return; }
    show(!open);
  }

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

  const metaFailed = (m: TermMeta) => !m.running && m.last != null && m.last.exit !== 0 && m.last.exit !== undefined;
  const tilde = (p: string) => p.replace(/^\/home\/[^/]+/, "~");
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
      const r = await api.post("api/term/ask", { id: active, text });
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

{#snippet tstate(m: TermMeta)}
  {#if m.running}<span class="trun" title="running {m.running}"><span class="spin"></span></span>{:else if metaFailed(m)}<span class="tbad" title="last command failed (exit {m.last?.exit})">!</span>{/if}
{/snippet}
<div id="tsplit" class:hide={!open} onpointerdown={split} role="separator"></div>
<section id="term" class:hide={!open} style="height:{h}px" bind:this={termEl} onmousemove={onMove} onmouseleave={() => { mouse = null; hov = null; }} role="presentation">
  <div class="tbar">
    <div class="segs" role="tablist">
      {#each metas as m (m.id)}
        <Tab on={m.id === active} title={(m.running ?? tilde(m.cwd)) + "  (Ctrl+PageUp / Ctrl+PageDown to switch)"} onselect={() => showView(m.id)}
          onclose={() => api.post("api/term/close", { id: m.id })} closeLabel="Close this shell">
          {@render tstate(m)}<span class="ctname">{label(m)}</span>
        </Tab>
      {/each}
    </div>
    <!-- a new shell: which project it opens in, picked right here in the bar -->
    {#if picking}
      <div id="tpick" bind:this={pickEl} tabindex="-1" role="listbox" aria-label="Open the terminal in" onkeydown={pickKeys}>
          {#each projects as p, i (p.name)}
          <button class="tpproj" class:on={i === pick} title={p.path} role="option" aria-selected={i === pick} onclick={() => startTerm(p.name)} onmouseenter={() => (pick = i)}>{p.name}</button>
        {/each}
      </div>
    {/if}
    <span class="grow"></span>
    <IconButton label="Ask for a command  (Ctrl+K)" onclick={openAsk} on={asking}>
      <path d="M8 2.5l1.2 3.3 3.3 1.2-3.3 1.2L8 11.5 6.8 8.2 3.5 7l3.3-1.2zM12.5 11v3M11 12.5h3" />
    </IconButton>
    <IconButton label="New shell  (Ctrl+Shift+`)" onclick={newTerm}><path d="M8 3.5v9M3.5 8h9" /></IconButton>
  </div>
  <div id="tbody" bind:this={tbody}></div>
  {#if hov}
    <div class="tblock" class:bad={hov.bad} style="top:{hov.top}px;height:{hov.height}px;left:{hov.left}px;width:{hov.width}px"></div>
    <div class="thov" style="top:{Math.max(hov.top, 0)}px;right:14px">
      {#if hov.bad}<button title="Send this command and its output to the agent, asking it to fix it" onclick={() => send(hov!.b, true)}>✦ fix</button>{/if}
      <button title="Add this command and its output to the chat  (Ctrl+L on the last one)" onclick={() => send(hov!.b)}>→ chat</button>
    </div>
  {/if}
  {#if failed && !hov}
    {@const f = failed}
    <div class="tfail thov">
      <span class="bad">✕</span><code>{short(f.cmd)}</code><span class="muted">exit {f.exit}</span>
      <button title="Add it and its output to the chat  (Ctrl+L)" onclick={() => send(f)}>→ chat</button>
      <button title="Send it to the agent, asking it to fix it" onclick={() => send(f, true)}>✦ fix</button>
      <button class="tx" title="Dismiss" onclick={() => { dismissed.add(f); dismissRev++; }}>×</button>
    </div>
  {/if}
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
