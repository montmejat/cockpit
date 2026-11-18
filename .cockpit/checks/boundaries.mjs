// cockpit's two halves stay apart: the page (web/) is bundled for the browser, the server (src/)
// runs on node. Fails with what to do instead.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const files = (d) => readdirSync(join(root, d), { withFileTypes: true, recursive: true })
  .filter((e) => e.isFile() && /\.(ts|svelte)$/.test(e.name)).map((e) => relative(root, join(e.parentPath, e.name)));
const imports = (f) => [...readFileSync(join(root, f), "utf8").matchAll(/(?:import|export)[^"'`]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1] ?? m[2]);

const bad = [];
for (const f of files("web/src")) for (const i of imports(f)) {
  if (i.startsWith("node:")) bad.push(`${f}: imports ${i}. The page runs in the browser: ask the server for it (a route in src/serve.ts, called with api.get/api.post).`);
  else if (i.startsWith(".") && relative(root, resolve(root, f, "..", i)).startsWith("src/")) bad.push(`${f}: imports server code ${i}. Share the shape in web/src/lib/types.ts and get the data from a route in src/serve.ts.`);
}
for (const f of files("src")) for (const i of imports(f)) {
  if (i.startsWith(".") && relative(root, resolve(root, f, "..", i)).startsWith("web/")) bad.push(`${f}: imports page code ${i}. The server doesn't load the page's modules: move what both need into src/ and send it to the page in the live state.`);
}
if (bad.length) { console.log(bad.join("\n")); console.log(`\n${bad.length} import(s) across the page/server boundary`); process.exit(1); }
console.log("web/ and src/ stay apart");
