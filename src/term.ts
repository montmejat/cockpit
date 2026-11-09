// Terminals: real shells in the project folder, shown in the page's bottom drawer (xterm.js over a
// WebSocket) and readable by the agent. A small bash hook marks each command's start, text, folder
// and exit code (the OSC 133/633 marks VS Code uses), so cockpit knows commands, not just bytes.
// They live as long as the server: reloading the page reattaches and replays the screen.

import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawn as ptySpawn, type IPty } from "node-pty";
import type { WebSocket } from "ws";
import { outDir } from "./turns.ts";

export type Cmd = { n: number; cmd: string; cwd: string; start: string; end?: string; exit?: number; out: string };
type Term = {
  id: string; n: number; pty: IPty; cwd: string; exited: number | null;
  screen: string; // raw output, for replay
  cmds: Cmd[]; cur: Cmd | null; pend: string; nextCmd: string;
  clients: Set<WebSocket>;
};

const SCREEN_MAX = 400_000, OUT_MAX = 100_000, CMDS_MAX = 50;

// Sourced instead of ~/.bashrc: the user's own setup first, then the marks.
const RC = `[ -f ~/.bashrc ] && . ~/.bashrc
__ck_cmd() { local c; c=$(HISTTIMEFORMAT= builtin history 1); c="\${c#*[0-9]  }"; printf '\\e]633;E;%s\\a\\e]133;C\\a' "$c"; }
__ck_prompt() { local e=$?; printf '\\e]133;D;%s\\a\\e]7;file://%s%s\\a' "$e" "$HOSTNAME" "$PWD"; return $e; }
PROMPT_COMMAND="__ck_prompt\${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
PS0='$(__ck_cmd)'
PS1="\\[\\e]133;A\\a\\]$PS1\\[\\e]133;B\\a\\]"
`;

// Output as text an agent can read: no colors or cursor moves, and a line redrawn with \r
// (progress bars) keeps only its last state.
export function plain(s: string) {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[()][0-9A-Za-z]|\x1b[=>78]/g, "")
    .replace(/\r\n/g, "\n")
    .split("\n").map((l) => { const parts = l.split("\r").filter((p, i, a) => p || i === a.length - 1); return parts[parts.length - 1] ?? ""; })
    .join("\n");
}

export function createTerminals(root: string, project: string) {
  const terms = new Map<string, Term>();
  let count = 0;
  const rcFile = join(outDir(project), "bashrc");
  mkdirSync(outDir(project), { recursive: true });
  writeFileSync(rcFile, RC);

  const env = () => {
    const e: Record<string, string> = { ...(process.env as Record<string, string>), TERM: "xterm-256color", COLORTERM: "truecolor", COCKPIT: "1" };
    // The project's own binaries first, so `keel ps` works after `cargo build`.
    const bins = ["target/debug", "node_modules/.bin"].map((p) => join(root, p)).filter(existsSync);
    if (bins.length) e.PATH = bins.join(":") + ":" + (e.PATH ?? "");
    delete e.NODE_OPTIONS;
    return e;
  };
  const send = (t: Term, msg: string) => { for (const c of t.clients) if (c.readyState === 1) c.send(msg); };
  const meta = (t: Term) => ({ id: t.id, n: t.n, cwd: t.cwd, running: t.cur?.cmd ?? null, exited: t.exited, last: t.cmds.at(-1) ? { cmd: t.cmds.at(-1)!.cmd, exit: t.cmds.at(-1)!.exit } : null });

  // Follow the marks in the output. Data can split a mark in two, so an unfinished one waits.
  function scan(t: Term, data: string) {
    let s = t.pend + data;
    t.pend = "";
    const re = /\x1b\](133|633|7);([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
    let at = 0, changed = false;
    for (let m; (m = re.exec(s)); ) {
      if (t.cur) t.cur.out += s.slice(at, m.index);
      at = re.lastIndex;
      const [, code, arg] = m;
      if (code === "633" && arg.startsWith("E;")) t.nextCmd = arg.slice(2);
      else if (code === "133" && arg === "C") {
        t.cur = { n: t.cmds.length ? t.cmds.at(-1)!.n + 1 : 1, cmd: t.nextCmd, cwd: t.cwd, start: new Date().toISOString(), out: "" };
        t.nextCmd = ""; changed = true;
      } else if (code === "133" && arg.startsWith("D")) {
        if (t.cur) {
          t.cur.exit = Number(arg.split(";")[1] ?? 0); t.cur.end = new Date().toISOString();
          t.cmds.push(t.cur); if (t.cmds.length > CMDS_MAX) t.cmds.shift();
          t.cur = null; changed = true;
        }
      } else if (code === "7") {
        const p = arg.replace(/^file:\/\/[^/]*/, "");
        if (p) { t.cwd = decodeURIComponent(p); changed = true; }
      }
    }
    let rest = s.slice(at);
    const open = rest.lastIndexOf("\x1b]");
    if (open >= 0 && !/\x07|\x1b\\/.test(rest.slice(open)) && rest.length - open < 4096) { t.pend = rest.slice(open); rest = rest.slice(0, open); }
    if (t.cur) { t.cur.out += rest; if (t.cur.out.length > OUT_MAX) t.cur.out = t.cur.out.slice(-OUT_MAX); }
    if (changed) send(t, "m" + JSON.stringify(meta(t)));
  }

  function open(cols = 100, rows = 24) {
    const n = ++count, id = "t" + n;
    const pty = ptySpawn("bash", ["--rcfile", rcFile, "-i"], { name: "xterm-256color", cols, rows, cwd: root, env: env() });
    const t: Term = { id, n, pty, cwd: root, exited: null, screen: "", cmds: [], cur: null, pend: "", nextCmd: "", clients: new Set() };
    pty.onData((d) => {
      t.screen += d;
      if (t.screen.length > SCREEN_MAX) t.screen = t.screen.slice(-SCREEN_MAX * 0.75);
      scan(t, d);
      send(t, "o" + d);
    });
    pty.onExit(({ exitCode }) => { t.exited = exitCode; send(t, "m" + JSON.stringify(meta(t))); for (const c of t.clients) c.close(); terms.delete(id); });
    terms.set(id, t);
    return id;
  }

  // One page connection to one terminal: "o…" output, "m{…}" what it is doing; the page sends
  // {t:"in",d} keys and {t:"size",cols,rows}.
  function attach(ws: WebSocket, id: string) {
    const t = terms.get(id);
    if (!t) { ws.close(4404, "no such terminal"); return; }
    t.clients.add(ws);
    ws.send("o" + t.screen);
    ws.send("m" + JSON.stringify(meta(t)));
    ws.on("message", (raw) => {
      try {
        const m = JSON.parse(String(raw));
        if (m.t === "in" && typeof m.d === "string") t.pty.write(m.d);
        else if (m.t === "size" && m.cols > 1 && m.rows > 1) t.pty.resize(Math.min(500, m.cols | 0), Math.min(200, m.rows | 0));
      } catch {}
    });
    ws.on("close", () => t.clients.delete(ws));
  }

  // What the agent reads: for each terminal (or one), its last few commands with their output,
  // and what is running now.
  function read(id?: string, last = 3) {
    const list = id ? [terms.get(id)].filter(Boolean) as Term[] : [...terms.values()];
    if (!list.length) return id ? `No terminal ${id}.` : "The owner has no terminal open in cockpit.";
    const tail = (s: string, max = 6000) => { const p = plain(s).trimEnd(); return p.length > max ? "…" + p.slice(-max) : p; };
    return list.map((t) => {
      const lines = [`## terminal ${t.id} (cwd ${t.cwd})`];
      for (const c of t.cmds.slice(-last)) lines.push(`$ ${c.cmd}    [exit ${c.exit}, ${c.start.slice(11, 19)} → ${c.end?.slice(11, 19)}, in ${c.cwd}]`, tail(c.out) || "(no output)");
      if (t.cur) lines.push(`$ ${t.cur.cmd}    [still running since ${t.cur.start.slice(11, 19)}]`, tail(t.cur.out) || "(no output yet)");
      if (!t.cmds.length && !t.cur) lines.push("(no commands yet)");
      return lines.join("\n");
    }).join("\n\n");
  }

  // A short account for the ask line: the last commands and how they ended, the latest output.
  function recent(id: string) {
    const t = terms.get(id);
    if (!t) return { cwd: root, text: "" };
    const cmds = t.cmds.slice(-6).map((c) => `$ ${c.cmd}   [exit ${c.exit}]`);
    const last = t.cmds.at(-1), out = last ? plain(last.out).trimEnd().slice(-1500) : "";
    return { cwd: t.cwd, text: cmds.join("\n") + (out ? "\nlast output:\n" + out : "") };
  }

  return {
    open,
    recent,
    attach,
    read,
    list: () => [...terms.values()].map(meta),
    close(id: string) { terms.get(id)?.pty.kill(); },
    closeAll() { for (const t of terms.values()) t.pty.kill(); },
  };
}

export type Terminals = ReturnType<typeof createTerminals>;
