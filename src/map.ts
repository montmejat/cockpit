// E2 CLI: npm run map -- <project dir> [--name slipangle] [--serve] [--port 4173] [--host 127.0.0.1]
// --host 0.0.0.0 makes the page reachable from other machines on the network (no login: trusted networks only).
// Generated files go to out/<name>/ (regenerable); your corrections go to
// data/<name>/overrides.json (versioned).

import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { buildSkeleton } from "./skeleton.ts";
import { applyOverrides, type Overrides, proposeOverlay, readOverrides } from "./overlay.ts";
import { renderMap } from "./maprender.ts";

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(`--${n}`);
const opt = (n: string) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : undefined);
const dir = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
if (!dir) {
  console.error("usage: npm run map -- <project dir> [--name x] [--serve] [--port 4173] [--host 127.0.0.1]");
  process.exit(1);
}

const root = resolve(dir);
const name = opt("name") ?? basename(root);
const outDir = join("out", name);
const dataDir = join("data", name);
const scip = join(outDir, "index.scip");
const overridesPath = join(dataDir, "overrides.json");
mkdirSync(outDir, { recursive: true });
mkdirSync(dataDir, { recursive: true });

// Reindex when any Rust source is newer than the index, so the skeleton never goes stale.
function newestSource(): number {
  let newest = 0;
  for (const f of readdirSync(root, { recursive: true }) as string[]) {
    if (f.startsWith("target") || f.includes("/target/") || !(f.endsWith(".rs") || f.endsWith("Cargo.toml"))) continue;
    newest = Math.max(newest, statSync(join(root, f)).mtimeMs);
  }
  return newest;
}
if (!existsSync(scip) || statSync(scip).mtimeMs < newestSource()) {
  console.log("indexing with rust-analyzer…");
  execFileSync("rust-analyzer", ["scip", ".", "--output", resolve(scip)], { cwd: root, stdio: "ignore" });
}

const skeleton = buildSkeleton(root, scip, "vendor/scip.proto");
console.log(`skeleton: ${skeleton.crates.length} crates, ${skeleton.modules.length} modules, ${skeleton.edges.length} edges`);

let overrides = readOverrides(overridesPath);
const { overlay, costUsd, cached } = proposeOverlay(skeleton, overrides, join("out", ".cache"));
console.log(`agent: ${overlay.components.length} components, $${costUsd.toFixed(4)}${cached ? " (cached)" : ""}`);

const page = () => {
  const model = applyOverrides(skeleton, overlay, overrides);
  return { model, html: renderMap({ name, skeleton, model, overrides, costUsd }) };
};
const first = page();
for (const w of first.model.warnings) console.log(`warning: ${w}`);
writeFileSync(join(outDir, "map.json"), JSON.stringify({ skeleton, overlay, model: first.model }, null, 2));
writeFileSync(join(outDir, "map.html"), first.html);
console.log(`wrote ${resolve(outDir, "map.html")}`);

if (flag("serve")) {
  const port = Number(opt("port") ?? 4173);
  const host = opt("host") ?? "127.0.0.1";
  createServer((req, res) => {
    if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page().html);
    } else if (req.method === "POST" && req.url === "/api/overrides") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          const next = JSON.parse(body) as Overrides;
          if (typeof next !== "object" || next === null || Array.isArray(next)) throw new Error("expected an object");
          overrides = next;
          writeFileSync(overridesPath, JSON.stringify(overrides, null, 2) + "\n");
          res.writeHead(200, { "content-type": "application/json" })
            .end(JSON.stringify({ model: page().model, overrides }));
        } catch (e) {
          res.writeHead(400).end(String(e));
        }
      });
    } else res.writeHead(404).end();
  }).listen(port, host, () => console.log(`serving on http://${host}:${port} (Ctrl+C to stop)`));
}
