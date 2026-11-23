// The page never opens the browser's dialogs (confirm, alert, prompt): actions act in one click,
// and what would lose unsaved work asks through confirmLoss() (web/src/lib/confirm.svelte.ts).
// Fails with where, and what to use instead.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const files = readdirSync(join(root, "web/src"), { withFileTypes: true, recursive: true })
  .filter((e) => e.isFile() && /\.(ts|svelte)$/.test(e.name)).map((e) => join(e.parentPath, e.name));

const bad = [];
for (const f of files) {
  readFileSync(f, "utf8").split("\n").forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, "").replace(/<!--.*?-->/g, "");
    for (const m of code.matchAll(/(?<![\w.$])(?:window\.)?(confirm|alert|prompt)\s*\(/g))
      bad.push(`${relative(root, f)}:${i + 1}: ${m[1]}(). Act in one click; if the click loses unsaved work, ask with confirmLoss() from web/src/lib/confirm.svelte.ts.`);
  });
}
if (bad.length) { console.log(bad.join("\n")); process.exit(1); }
console.log("no browser dialogs");
