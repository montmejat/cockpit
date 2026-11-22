// Who may talk to the server: only the page opened with the server's token. A shell and an agent
// sit behind it, so a page from another site open in the same browser, a site that points its
// own name at 127.0.0.1 (DNS rebinding), or another machine on the network must get nowhere.
//
// The token comes from the desktop app (COCKPIT_TOKEN, it opens the page with it) or is made up
// here and printed in the link. The first visit carries it as ?token=…; the server answers with
// a cookie (HttpOnly, SameSite=Strict, named by port since cookies don't tell ports apart) and
// sends the page on without it, so it doesn't stay in the address bar.

import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function createAuth(port: number, listen: string, token = process.env.COCKPIT_TOKEN || randomBytes(24).toString("base64url")) {
  const name = `cockpit-${port}`;
  const same = (s: string | undefined) => {
    if (!s) return false;
    const a = Buffer.from(s), b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  // Listening on loopback only: the request must name it, else the page came through someone's
  // DNS name that resolves here.
  const hostOk = (req: IncomingMessage) => !LOOPBACK.has(listen) || LOOPBACK.has((req.headers.host ?? "").replace(/:\d+$/, ""));
  const cookieOf = (req: IncomingMessage) => {
    for (const c of (req.headers.cookie ?? "").split(/;\s*/)) {
      const i = c.indexOf("=");
      if (i > 0 && c.slice(0, i) === name) return c.slice(i + 1);
    }
    return undefined;
  };
  return {
    token,
    link: (host: string) => `http://${host}:${port}/?token=${token}`,
    // "ok": let it through. "login": the token is in the link, set the cookie and send the page on
    // to the same address without it. "refused": no or wrong token, or a host that isn't this one.
    check(req: IncomingMessage, url: URL): "ok" | "login" | "refused" {
      if (!hostOk(req)) return "refused";
      if (same(cookieOf(req))) return "ok";
      if (same(url.searchParams.get("token") ?? undefined)) return "login";
      return "refused";
    },
    cookie: `${name}=${token}; HttpOnly; SameSite=Strict; Path=/`,
  };
}
