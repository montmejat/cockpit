// Every module and item cockpit knows in a project, written exactly as .cockpit/ links them:
//   npm run modules -- <project dir> [filter]
// Agents use it before writing links, so a link names something real on the first try.
// A filter (a substring, case-insensitive) keeps the modules whose id or file contains it.

import { basename, resolve } from "node:path";
import { indexNow } from "./codeindex.ts";
import { isTestPath, itemKey } from "./skeleton.ts";

const [dir, filter] = process.argv.slice(2);
if (!dir) { console.error("usage: npm run modules -- <project dir> [filter]"); process.exit(1); }
const root = resolve(dir);
const sk = indexNow(root, basename(root));
const f = filter?.toLowerCase();
const mods = sk.modules.filter((m) => !f || m.id.toLowerCase().includes(f) || m.file.toLowerCase().includes(f));

const group = sk.lang === "cpp" ? "project" : sk.lang === "zig" ? "package" : "crate";
console.log(`${sk.modules.length} modules in ${sk.crates.length} ${group}s${f ? `, ${mods.length} matching "${filter}"` : ""}. Links are the ids below.`);
console.log(`Test modules (marked [test]) need no feature.\n`);
for (const c of sk.crates) {
  const ms = mods.filter((m) => m.crate === c.name);
  if (!ms.length) continue;
  console.log(`## ${group} ${c.name}${c.deps.length ? `  (uses ${c.deps.join(", ")})` : ""}`);
  for (const m of ms) {
    console.log(`${m.id}${isTestPath(m.file) ? "  [test]" : ""}  (${m.file}, ${m.lines} lines)${m.doc ? ` - ${m.doc.slice(0, 100)}` : ""}`);
    for (const i of m.items.filter((i) => !i.test)) console.log(`  ${itemKey(m.id, i)}  [${i.kind}]`);
  }
  console.log();
}
