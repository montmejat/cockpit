import { test } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { createAuth } from "../src/auth.ts";

const req = (host: string, cookie?: string) => ({ headers: { host, ...(cookie ? { cookie } : {}) } }) as IncomingMessage;
const at = (path: string) => new URL(path, "http://x");

test("on loopback: the token's cookie gets in, nothing else does", () => {
  const a = createAuth(4000, "127.0.0.1", "secret");
  assert.equal(a.check(req("127.0.0.1:4000"), at("/api/state")), "refused");
  assert.equal(a.check(req("127.0.0.1:4000", "cockpit-4000=wrong"), at("/")), "refused");
  assert.equal(a.check(req("127.0.0.1:4000", "other=1; cockpit-4000=secret"), at("/")), "ok");
  assert.equal(a.check(req("localhost:4000", "cockpit-4000=secret"), at("/")), "ok");
  // another cockpit's cookie on the same host (cookies don't tell ports apart)
  assert.equal(a.check(req("127.0.0.1:4000", "cockpit-4001=secret"), at("/")), "refused");
});

test("the link's token logs in once, a wrong one doesn't", () => {
  const a = createAuth(4000, "127.0.0.1", "secret");
  assert.equal(a.check(req("127.0.0.1:4000"), at("/?token=secret")), "login");
  assert.equal(a.check(req("127.0.0.1:4000"), at("/?token=secre")), "refused");
  assert.match(a.cookie, /^cockpit-4000=secret; HttpOnly; SameSite=Strict; Path=\/$/);
  assert.equal(a.link("127.0.0.1"), "http://127.0.0.1:4000/?token=secret");
});

test("DNS rebinding: another name for 127.0.0.1 is refused even with the token", () => {
  const a = createAuth(4000, "127.0.0.1", "secret");
  assert.equal(a.check(req("evil.example:4000", "cockpit-4000=secret"), at("/")), "refused");
  assert.equal(a.check(req("evil.example:4000"), at("/?token=secret")), "refused");
});

test("on the network: any host name, still only with the token", () => {
  const a = createAuth(4000, "0.0.0.0", "secret");
  assert.equal(a.check(req("laptop.lan:4000"), at("/api/state")), "refused");
  assert.equal(a.check(req("laptop.lan:4000", "cockpit-4000=secret"), at("/")), "ok");
});
