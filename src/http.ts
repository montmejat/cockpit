// The server's HTTP plumbing: JSON answers, request bodies (bounded), server-sent events, and the
// shape of a route.

import type { IncomingMessage, ServerResponse } from "node:http";

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

