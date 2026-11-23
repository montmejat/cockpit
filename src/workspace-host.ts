// A workspace's window, served (workspace.ts): the host is none of its projects. It runs a server
// for each of them (workspace-servers.ts) and the window's page comes from one of them, at
// /p/<name>/ (the one opened last; its terminals and chat), showing every project's files, git
// and diagrams side by side (web/src/lib/projects.svelte.ts).
//   npm run serve -- ~/.config/cockpit/workspaces/<name> [--port 4173] [--host 127.0.0.1]

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { createAuth } from "./auth.ts";
import { asset, gatedServer, post, type Handler } from "./http.ts";
import { outDir } from "./turns.ts";
import { addToWorkspace, loadWorkspace } from "./workspace.ts";
import { createWorkspaceServers } from "./workspace-servers.ts";

const args = process.argv.slice(2);
const opt = (n: string) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : undefined);
const dir = resolve(args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"))!);
const ws0 = loadWorkspace(dir);
if (!ws0) { console.error(`${dir}/workspace.json lists no projects`); process.exit(1); }
const workspace = () => loadWorkspace(dir) ?? ws0;
const port = Number(opt("port") ?? 4173), host = opt("host") ?? "127.0.0.1";
const servers = createWorkspaceServers(ws0);

// The host's own files: its token (when the desktop app doesn't hand one over) and the project
// viewed last.
const out = outDir(`workspace-${ws0.name}`);
mkdirSync(out, { recursive: true });
function savedToken() {
  const f = join(out, "token");
  try { return readFileSync(f, "utf8").trim(); } catch {}
  const t = randomBytes(24).toString("base64url");
  writeFileSync(f, t + "\n", { mode: 0o600 });
  chmodSync(f, 0o600);
  return t;
}
const auth = createAuth(port, host, process.env.COCKPIT_TOKEN || savedToken());
delete process.env.COCKPIT_TOKEN;
const viewedFile = join(out, "viewing");
const viewed = () => {
  const names = workspace().projects.map((p) => p.name);
  try { const n = readFileSync(viewedFile, "utf8").trim(); if (names.includes(n)) return n; } catch {}
  return names[0];
};
const view = encodeURIComponent;

const routes: Record<string, Handler> = {
  "GET /": (_req, res) => res.writeHead(302, { location: `/p/${view(viewed())}/`, "cache-control": "no-store" }).end(),
  // A project added to the workspace: its server starts; the page loads again to show it.
  "POST /api/workspace/add": post(({ path }) => {
    if (typeof path !== "string") throw new Error("expected a folder");
    addToWorkspace(dir, path);
    const p = workspace().projects.at(-1)!;
    servers.add(p.name, p.path);
  }),
};

const server = gatedServer(auth, async (req, res, url) => {
  const h = routes[`${req.method} ${url.pathname}`];
  if (h) return await h(req, res, url);
  if (asset(req, res, url)) return;
  const m = /^\/p\/([^/]+)(\/?)$/.exec(url.pathname);
  if (req.method === "GET" && m && servers.has(decodeURIComponent(m[1]))) {
    // A project's page: /p/<name>/, with the slash its page's relative links need.
    if (!m[2]) return res.writeHead(301, { location: url.pathname + "/" + url.search }).end();
    writeFileSync(viewedFile, decodeURIComponent(m[1]) + "\n");
  }
  if (await servers.http(req, res)) return;
  res.writeHead(404).end();
}, (req, sock, head, url) => {
  if (!url.pathname.startsWith("/p/")) { sock.destroy(); return; }
  void servers.upgrade(req, sock, head);
});
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => { servers.stopAll(); process.exit(0); });
server.listen(port, host, () =>
  console.log(`serving workspace ${ws0.name} (${ws0.projects.map((p) => p.name).join(", ")}) on ${auth.link(host === "0.0.0.0" || host === "::" ? hostname() : host)}`),
);
