// The cockpit server: serves the page (web/, built with Vite) and the projects it shows.
//   npm run serve -- <project dir> [--port 4173] [--host 127.0.0.1]
// --host 0.0.0.0 makes it reachable from other machines on the network (no login).
//
// It hosts the project you open and, when that project is in a workspace (workspace.ts), the
// other projects of the workspace too, so one window shows them all: each project (project.ts)
// answers under /p/<name>/ (its state, files, git, chat, terminals, language servers), the one
// you opened also at the old unprefixed /api/. The other projects start the first time the page
// asks for one of them, and they all stop with the server.

import { createServer, type IncomingMessage } from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, extname, join, resolve, sep } from "node:path";
import { WebSocketServer } from "ws";
import { COCKPIT } from "./turns.ts";
import { workspaceOf } from "./workspace.ts";
import { createProject, post, type Handler, type Project } from "./project.ts";

const args = process.argv.slice(2);
const opt = (n: string) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : undefined);
const dir = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
if (!dir) {
  console.error("usage: npm run serve -- <project dir> [--port 4173] [--host 127.0.0.1]");
  process.exit(1);
}
const root = resolve(dir);
const WEB = join(COCKPIT, "web", "dist");

// ---- the projects ------------------------------------------------------------

const main = createProject(root, opt("name") ?? basename(root));
const ws = workspaceOf(root);
// The workspace's projects by name (the folder's), the one you opened among them.
const paths = new Map<string, string>([[main.name, root]]);
for (const p of ws?.projects ?? []) if (!p.here && existsSync(p.path) && !paths.has(p.name)) paths.set(p.name, p.path);
const projects = new Map<string, Project>([[main.name, main]]);
function project(name: string): Project | null {
  const path = paths.get(name);
  if (!path) return null;
  let p = projects.get(name);
  if (!p) { console.log(`starting ${name} (${path}), workspace ${ws?.name}`); projects.set(name, (p = createProject(path, name))); }
  return p;
}

// ---- the page ----------------------------------------------------------------

// The desktop's look, so the page can match the apps around it (GNOME): the accent color and
// which window buttons go where. Read once; null fields when it isn't GNOME.
let look: { accent: string | null; buttons: string | null } | null = null;
function desktopLook() {
  if (look) return look;
  const get = (schema: string, key: string) => {
    try { return execFileSync("gsettings", ["get", schema, key], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).trim().replace(/^'|'$/g, ""); }
    catch { return null; }
  };
  return (look = { accent: get("org.gnome.desktop.interface", "accent-color"), buttons: get("org.gnome.desktop.wm.preferences", "button-layout") });
}

// The page, showing one project first (?project=<name>, else the one you opened); it switches
// between them by itself.
function page(p: Project) {
  const file = join(WEB, "index.html");
  if (!existsSync(file)) return `<!doctype html><meta charset=utf-8><body style="font:14px monospace;padding:30px">The page isn't built yet: run <b>npm run build</b> in ${COCKPIT}.`;
  const boot = { ...p.state(), terminals: p.terminals(), desktop: desktopLook(), opened: main.name, projects: [...paths.keys()] };
  return readFileSync(file, "utf8")
    .replace("<title>cockpit</title>", `<title>${p.name.replace(/[<&]/g, "")} · cockpit</title>`)
    .replace("<!--boot-->", `<script>window.INIT = ${JSON.stringify(boot).replace(/</g, "\\u003c")};</script>`);
}
const TYPES: Record<string, string> = { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".woff": "font/woff", ".svg": "image/svg+xml", ".png": "image/png" };

// Routes of the server itself, not of a project.
const routes: Record<string, Handler> = {
  "GET /": (_req, res, url) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page(project(url.searchParams.get("project") ?? "") ?? main)),
  // A web link (from the chat, say) in your browser: the desktop app's window can't open one itself.
  "POST /api/open-url": post(({ url }) => {
    if (typeof url !== "string" || !/^https?:\/\//.test(url)) throw new Error("expected an http(s) link");
    const [cmd, ...args] = process.platform === "darwin" ? ["open"] : process.platform === "win32" ? ["cmd", "/c", "start", ""] : ["xdg-open"];
    spawn(cmd, [...args, url], { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
  }),
};

// Which project a path is for, and the path within it: /p/<name>/api/… or the opened one's /api/….
function route(pathname: string): { p: Project; path: string } | null {
  const m = /^\/p\/([^/]+)(\/.*)$/.exec(pathname);
  if (!m) return { p: main, path: pathname };
  const p = project(decodeURIComponent(m[1]));
  return p && { p, path: m[2] };
}

// Only the page itself may act: a page from another site, open in the same browser, could
// otherwise talk to the agent or open a shell here.
const sameOrigin = (req: IncomingMessage) => { const o = req.headers.origin; if (!o) return true; try { return new URL(o).host === req.headers.host; } catch { return false; } };

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (req.method !== "GET" && !sameOrigin(req)) return res.writeHead(403).end("cross-origin request refused");
  try {
    // The server's own routes answer under a project's prefix too (the page sends everything there).
    const r = route(url.pathname);
    const own = routes[`${req.method} ${url.pathname}`] ?? (r && r.path.startsWith("/api/") ? routes[`${req.method} ${r.path}`] : undefined);
    if (own) return await own(req, res, url);
    const h = r?.p.routes[`${req.method} ${r.path}`];
    if (r && h) return await h(req, res, url);
    // The built page's own files (scripts, styles, fonts), named by content hash.
    if (req.method === "GET" && url.pathname.startsWith("/assets/")) {
      const file = resolve(WEB, "." + url.pathname), type = TYPES[extname(file)];
      if (!file.startsWith(join(WEB, "assets") + sep) || !type || !existsSync(file)) return res.writeHead(404).end();
      return res.writeHead(200, { "content-type": type, "cache-control": "max-age=31536000, immutable" }).end(readFileSync(file));
    }
    res.writeHead(404).end();
  } catch (e) {
    if (!res.headersSent) res.writeHead(500).end(String(e));
  }
});

// Terminals and language servers, over WebSockets: /[p/<name>/]api/term/ws and /[p/<name>/]api/lsp.
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, sock, head) => {
  const url = new URL(req.url ?? "/", "http://x");
  const r = route(url.pathname);
  if (!r || !["/api/term/ws", "/api/lsp"].includes(r.path) || !sameOrigin(req) || !req.headers.origin) { sock.destroy(); return; }
  wss.handleUpgrade(req, sock, head, (w) => r.p.upgrade(r.path, url, w));
});
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => { for (const p of projects.values()) p.close(); process.exit(0); });
server.listen(Number(opt("port") ?? 4173), opt("host") ?? "127.0.0.1", () =>
  console.log(`serving ${main.name}${paths.size > 1 ? ` and ${[...paths.keys()].filter((n) => n !== main.name).join(", ")} (workspace ${ws?.name})` : ""} on http://${opt("host") ?? "127.0.0.1"}:${opt("port") ?? 4173}`),
);
