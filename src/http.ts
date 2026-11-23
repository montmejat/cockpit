// The server's HTTP plumbing: JSON answers, request bodies (bounded), server-sent events, the
// shape of a route, the token gate's answers and the built page's files. Shared by a project's
// server (project-server.ts) and a workspace's host (workspace-host.ts).

import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import type { createAuth } from "./auth.ts";
import { COCKPIT } from "./turns.ts";

export const json = (res: ServerResponse, data: unknown, code = 200) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(data));
// At most 64 MB (a message with pasted images is the biggest thing the page sends).
const BODY_MAX = 64 << 20;
export const readBody = (req: IncomingMessage) => new Promise<any>((ok, fail) => {
  const parts: Buffer[] = [];
  let size = 0;
  req.on("data", (c: Buffer) => {
    size += c.length;
    if (size > BODY_MAX) { fail(new Error("request too large")); req.destroy(); return; }
    parts.push(c);
  });
  req.on("end", () => { try { const b = Buffer.concat(parts).toString("utf8"); ok(b ? JSON.parse(b) : {}); } catch (e) { fail(e); } });
  req.on("error", fail);
});
// Server-sent events: a first message, then each one `subscribe` hands over.
export function events(req: IncomingMessage, res: ServerResponse, first: unknown, subscribe: (send: (e: unknown) => void) => () => void) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const send = (e: unknown) => res.write("data: " + JSON.stringify(e) + "\n\n");
  send(first);
  const off = subscribe(send);
  const ping = setInterval(() => res.write(": ping\n\n"), 20000);
  req.on("close", () => { off(); clearInterval(ping); });
}

// Only the page itself may act: a page from another site, open in the same browser, could
// otherwise talk to the agent or open a shell here.
export const sameOrigin = (req: IncomingMessage) => { const o = req.headers.origin; if (!o) return true; try { return new URL(o).host === req.headers.host; } catch { return false; } };

export type Handler = (req: IncomingMessage, res: ServerResponse, url: URL) => unknown;
export const q = (url: URL, k: string) => url.searchParams.get(k) ?? "";
export const post = (fn: (body: any, res: ServerResponse) => unknown): Handler => async (req, res) => {
  try { const r = await fn(await readBody(req), res); if (!res.headersSent) json(res, r ?? { ok: true }); }
  catch (e: any) { if (!res.headersSent) json(res, { error: String(e?.message ?? e) }, 400); }
};


// The token gate (auth.ts), answered: true when the request was handled here (a login that sets
// the cookie, a refusal), false when it may go on.
export function gate(auth: ReturnType<typeof createAuth>, req: IncomingMessage, res: ServerResponse, url: URL): boolean {
  const pass = auth.check(req, url);
  if (pass === "login") {
    url.searchParams.delete("token");
    // Not a 303: a redirect stays part of the navigation that brought the link, and when that
    // came from another site (the desktop app's loading page) the SameSite=Strict cookie is held
    // back from it. The page moving itself on is a navigation from here, so the cookie goes along.
    res.writeHead(200, { "set-cookie": auth.cookie, "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" })
      .end(`<!doctype html><meta charset=utf-8><script>location.replace(${JSON.stringify(url.pathname + url.search).replace(/</g, "\\u003c")})</script>`);
    return true;
  }
  if (pass === "refused") {
    res.writeHead(401, { "content-type": "text/html; charset=utf-8" })
      .end(`<!doctype html><meta charset=utf-8><body style="font:14px monospace;padding:30px">Open cockpit from the desktop app, or with the link the server printed when it started (it ends in <b>?token=…</b>).`);
    return true;
  }
  if (req.method !== "GET" && !sameOrigin(req)) { res.writeHead(403).end("cross-origin request refused"); return true; }
  return false;
}

// The built page (web/dist), and its own files (scripts, styles, fonts), named by content hash.
export const WEB = join(COCKPIT, "web", "dist");
const TYPES: Record<string, string> = { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".woff": "font/woff", ".svg": "image/svg+xml", ".png": "image/png" };
export function asset(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
  if (req.method !== "GET" || !url.pathname.startsWith("/assets/")) return false;
  const file = resolve(WEB, "." + url.pathname), type = TYPES[extname(file)];
  if (!file.startsWith(join(WEB, "assets") + sep) || !type || !existsSync(file)) res.writeHead(404).end();
  else res.writeHead(200, { "content-type": type, "cache-control": "max-age=31536000, immutable" }).end(readFileSync(file));
  return true;
}
