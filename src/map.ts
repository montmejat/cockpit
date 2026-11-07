// E2 CLI: npm run map -- <project dir> [--name slipangle]
// Writes out/<name>/map.html (read-only). For the editable map, use `npm run serve`.

import { basename, resolve } from "node:path";
import { createMapApp } from "./mapapp.ts";

const args = process.argv.slice(2);
const opt = (n: string) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : undefined);
const dir = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
if (!dir) {
  console.error("usage: npm run map -- <project dir> [--name x]");
  process.exit(1);
}
const root = resolve(dir);
const app = createMapApp(root, opt("name") ?? basename(root));
for (const w of app.render().model.warnings) console.log(`warning: ${w}`);
console.log(`wrote ${resolve(app.outDir, "map.html")}`);
