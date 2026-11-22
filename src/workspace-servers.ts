// The other projects of a workspace, in this window: like an editor's multi-root workspace, the
// page shows every project's files and git side by side. Each other project keeps a server of its
// own (its index, git, watchers, as when opened alone), started here as a child on a free port,
// and the page reaches it through this server under /p/<name>/…: requests, live events and
// WebSockets (terminals, language servers) are passed through with the child's own token.
//
// The children run with COCKPIT_CHILD=1, so they don't start servers for the workspace again, and
// stop when their stdin closes: this server is gone, however it ended.

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { request } from "node:http";
import { connect, createServer as netServer } from "node:net";
import type { Duplex } from "node:stream";
import { COCKPIT } from "./turns.ts";
import type { Workspace } from "./workspace.ts";

type Child = { name: string; path: string; port: number; token: string; proc: ChildProcess; ready: Promise<void> };

const freePort = () => new Promise<number>((done, fail) => {
  const s = netServer().listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => done(p)); });
  s.on("error", fail);
});

// Answers once something listens on the port (the child indexes first; that can take a while).
function listening(port: number, proc: ChildProcess) {
  return new Promise<void>((done, fail) => {
    let dead = false;
    proc.once("exit", (c) => { dead = true; fail(new Error(`exited (${c})`)); });
    const tryIt = () => {
      if (dead) return;
      const s = connect(port, "127.0.0.1", () => { s.destroy(); done(); });
      s.on("error", () => setTimeout(tryIt, 200));
    };
    tryIt();
  });
}

export function createWorkspaceServers(ws: Workspace | null) {
  const children = new Map<string, Child>();
  const others = ws && !process.env.COCKPIT_CHILD ? ws.projects.filter((p) => !p.here) : [];

  async function start(name: string, path: string) {
    const port = await freePort(), token = randomBytes(24).toString("base64url");
    const proc = spawn(process.execPath, ["--import", "tsx", "src/serve.ts", path, "--port", String(port)], {
      cwd: COCKPIT, env: { ...process.env, COCKPIT_TOKEN: token, COCKPIT_CHILD: "1" }, stdio: ["pipe", "pipe", "pipe"], // stdin: closes when this server goes
    });
    for (const s of [proc.stdout!, proc.stderr!]) s.on("data", (d) => process.stderr.write(String(d).replace(/^(?=.)/gm, `[${name}] `)));
    const c: Child = { name, path, port, token, proc, ready: listening(port, proc) };
    c.ready.catch((e) => console.error(`[${name}] server: ${e.message}`));
    children.set(name, c);
  }
  for (const p of others) void start(p.name, p.path);

  // The request as the child expects it: its own host, origin and token.
  const headersFor = (c: Child, h: IncomingMessage["headers"]) => {
    const out: Record<string, string | string[] | undefined> = { ...h, host: `127.0.0.1:${c.port}`, cookie: `cockpit-${c.port}=${c.token}` };
    if (h.origin) out.origin = `http://127.0.0.1:${c.port}`;
    return out;
  };
  const route = (url: string) => {
    const m = /^\/p\/([^/?]+)(\/[^?]*)?(\?.*)?$/.exec(url);
    const c = m && children.get(decodeURIComponent(m[1]));
    return c ? { c, path: (m![2] || "/") + (m![3] ?? "") } : null;
  };

  return {
    // The other projects, for the page: name, folder, and whether its server answers yet.
    list: () => others.map((p) => ({ name: p.name, path: p.path })),
    // An HTTP request under /p/<name>/: passed through, answer streamed back (live events too).
    async http(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
      const r = route(req.url ?? "");
      if (!r) return false;
      try { await r.c.ready; } catch (e: any) { res.writeHead(502).end(`${r.c.name}: its server didn't start (${e.message})`); return true; }
      const up = request({ host: "127.0.0.1", port: r.c.port, method: req.method, path: r.path, headers: headersFor(r.c, req.headers) }, (ans) => {
        res.writeHead(ans.statusCode ?? 502, ans.headers);
        ans.pipe(res);
      });
      up.on("error", (e) => { if (!res.headersSent) res.writeHead(502).end(String(e)); else res.destroy(); });
      res.on("close", () => up.destroy());
      req.pipe(up);
      return true;
    },
    // A WebSocket under /p/<name>/: the upgrade request rewritten, then bytes both ways.
    async upgrade(req: IncomingMessage, sock: Duplex, head: Buffer): Promise<boolean> {
      const r = route(req.url ?? "");
      if (!r) return false;
      try { await r.c.ready; } catch { sock.destroy(); return true; }
      const up = connect(r.c.port, "127.0.0.1", () => {
        const h = headersFor(r.c, req.headers);
        const lines = [`${req.method} ${r.path} HTTP/1.1`];
        for (const [k, v] of Object.entries(h)) for (const x of Array.isArray(v) ? v : v == null ? [] : [v]) lines.push(`${k}: ${x}`);
        up.write(lines.join("\r\n") + "\r\n\r\n");
        if (head.length) up.write(head);
        up.pipe(sock); sock.pipe(up);
      });
      const end = () => { up.destroy(); sock.destroy(); };
      up.on("error", end); sock.on("error", end); up.on("close", end); sock.on("close", end);
      return true;
    },
    stopAll() { for (const c of children.values()) c.proc.kill("SIGTERM"); },
  };
}
