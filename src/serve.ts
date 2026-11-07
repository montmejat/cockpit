// One server for a project: the work view (map + turns), the turns page, and the map.
//   npm run serve -- <project dir> [--port 4173] [--host 127.0.0.1]
// --host 0.0.0.0 makes it reachable from other machines on the network (no login).

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { createMapApp } from "./mapapp.ts";
import { COCKPIT, listTurns, loadTurn } from "./turns.ts";

const args = process.argv.slice(2);
const opt = (n: string) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : undefined);
const dir = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
if (!dir) {
  console.error("usage: npm run serve -- <project dir> [--port 4173] [--host 127.0.0.1]");
  process.exit(1);
}
const root = resolve(dir);
const name = opt("name") ?? basename(root);
const map = createMapApp(root, name);

// First paint uses embedded data (no wait for the first poll). ?turn=<id>&depth=1-4 pick what to show.
function turnList() {
  return listTurns(name).map((t) => ({
    id: t.id, prompt: t.prompt, status: t.status, startedAt: t.startedAt, endedAt: t.endedAt,
    touched: t.touched.length,
    files: t.analysis?.files.length,
    added: t.analysis?.files.reduce((s, f) => s + f.added, 0),
    removed: t.analysis?.files.reduce((s, f) => s + f.removed, 0),
    components: t.analysis?.components,
  }));
}
function initData(url: URL) {
  const turns = turnList();
  const want = url.searchParams.get("turn");
  const id = want && turns.some((t) => t.id === want) ? want : turns[0]?.id;
  return { turns, selected: id ?? null, detail: id ? loadTurn(name, id) : null, depth: Number(url.searchParams.get("depth")) || null };
}

const reviewPage = (url: URL) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent Turns</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/diff2html@3.4.48/bundles/css/diff2html.min.css">
<script src="https://cdn.jsdelivr.net/npm/diff2html@3.4.48/bundles/js/diff2html-ui-base.min.js"></script>
<style>${readFileSync(join(COCKPIT, "src", "review.css"), "utf8")}</style></head><body>
<header><h1>${name}</h1><span class="muted">agent turns</span><span style="flex:1"></span><a href="map">Map →</a></header>
<div class="wrap"><nav id="list"></nav><main id="detail"></main></div>
<script>window.INIT = ${JSON.stringify(initData(url)).replace(/</g, "\\u003c")};</script>
<script>${readFileSync(join(COCKPIT, "src", "review-client.js"), "utf8")}</script>
</body></html>`;

// Work page: the map is the main view; a selected turn lights up what it changed, down to the diff.
const workPage = (url: URL) => {
  const init = { ...initData(url), map: map.data() };
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cockpit</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/diff2html@3.4.48/bundles/css/diff2html.min.css">
<script src="https://cdn.jsdelivr.net/npm/diff2html@3.4.48/bundles/js/diff2html-ui-base.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/cytoscape/3.30.2/cytoscape.min.js"></script>
<style>${readFileSync(join(COCKPIT, "src", "review.css"), "utf8")}${readFileSync(join(COCKPIT, "src", "work.css"), "utf8")}</style></head><body>
<header><h1>${name}</h1><span class="muted" id="stats"></span><span style="flex:1"></span>
<span class="muted">Zoom</span><button data-zoom="system">System</button><button data-zoom="module">Modules</button>
<a href="turns">Turns</a><a href="map">Map</a></header>
<div class="wrap work"><nav id="list"></nav><div id="cy"></div><aside id="panel"></aside></div>
<script>window.INIT = ${JSON.stringify(init).replace(/</g, "\\u003c")};</script>
<script>${readFileSync(join(COCKPIT, "src", "map-layout.js"), "utf8")}</script>
<script>${readFileSync(join(COCKPIT, "src", "work-client.js"), "utf8")}</script>
</body></html>`;
};

const json = (res: any, data: unknown, code = 200) =>
  res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(data));

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  try {
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(workPage(url));
    } else if (req.method === "GET" && url.pathname === "/turns") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(reviewPage(url));
    } else if (req.method === "GET" && url.pathname === "/api/map") {
      if (url.searchParams.get("fresh")) map.rebuild(); // reindexes only if the code changed
      json(res, map.data());
    } else if (req.method === "GET" && url.pathname === "/map") {
      // Rebuilds only what is stale: reindexes if code changed; the agent's grouping is cached.
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(map.rebuild().html);
    } else if (req.method === "GET" && url.pathname === "/api/turns") {
      json(res, turnList());
    } else if (req.method === "GET" && url.pathname.startsWith("/api/turns/")) {
      const id = url.pathname.split("/").pop()!;
      if (!/^t[\d-]+$/.test(id)) return json(res, { error: "bad id" }, 400);
      json(res, loadTurn(name, id));
    } else if (req.method === "POST" && url.pathname === "/api/overrides") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          json(res, map.save(JSON.parse(body)));
        } catch (e) {
          res.writeHead(400).end(String(e));
        }
      });
    } else res.writeHead(404).end();
  } catch (e) {
    res.writeHead(500).end(String(e));
  }
}).listen(Number(opt("port") ?? 4173), opt("host") ?? "127.0.0.1", () =>
  console.log(`serving ${name} on http://${opt("host") ?? "127.0.0.1"}:${opt("port") ?? 4173} (work view at /, turns at /turns, map at /map)`),
);
