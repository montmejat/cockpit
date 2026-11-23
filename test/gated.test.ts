import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { createAuth } from "../src/auth.ts";
import { gatedServer } from "../src/http.ts";

// A real server on a free port: what reaches the handlers, and what the gate stops first.
async function serve() {
  let reached = 0, upgraded = 0;
  const auth = createAuth(0, "127.0.0.1", "secret");
  const server = gatedServer(auth, (_req, res) => { reached++; res.end("ok"); }, (_req, sock) => { upgraded++; sock.destroy(); });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as AddressInfo).port;
  const get = (headers: Record<string, string>, path = "/api/state") => new Promise<number>((ok, fail) =>
    request({ port, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (r) => { r.resume(); ok(r.statusCode ?? 0); }).on("error", fail).end());
  // A WebSocket handshake; the counts say whether it reached the handler.
  const ws = (headers: Record<string, string>) => new Promise<void>((ok) => {
    const r = request({ port, path: "/api/term/ws", headers: { host: `127.0.0.1:${port}`, connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", ...headers } });
    r.on("error", () => ok()); r.on("close", () => ok()); r.end();
  });
  return { port, get, ws, counts: () => ({ reached, upgraded }), close: () => server.close() };
}

test("gatedServer: a request without the token's cookie never reaches the handler", async () => {
  const s = await serve();
  try {
    assert.equal(await s.get({}), 401);
    assert.equal(await s.get({ cookie: "cockpit-0=wrong" }), 401);
    assert.equal(await s.get({ host: "evil.example", cookie: "cockpit-0=secret" }), 401);
    assert.equal(s.counts().reached, 0);
    assert.equal(await s.get({ cookie: "cockpit-0=secret" }), 200);
    assert.equal(s.counts().reached, 1);
  } finally { s.close(); }
});

test("gatedServer: a WebSocket needs the cookie and the page's own origin", async () => {
  const s = await serve();
  try {
    await s.ws({ origin: "http://127.0.0.1" }); // no cookie
    await s.ws({ cookie: "cockpit-0=secret" }); // no origin
    await s.ws({ cookie: "cockpit-0=secret", origin: "http://evil.example" });
    assert.equal(s.counts().upgraded, 0);
    await s.ws({ cookie: "cockpit-0=secret", origin: `http://127.0.0.1:${s.port}` });
    assert.equal(s.counts().upgraded, 1);
  } finally { s.close(); }
});
