// Checks a project's architecture.json against its code: npm run check-arch -- <project dir>
// Uses the code index of the working copy (rebuilt only if the code changed).

import { readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { ARCH_FILE, checkArch } from "./arch.ts";
import { createMapApp } from "./mapapp.ts";

const dir = process.argv[2];
if (!dir) { console.error("usage: npm run check-arch -- <project dir>"); process.exit(1); }
const root = resolve(dir);
const sk = createMapApp(root, basename(root), () => {}).data().skeleton;
const problems = checkArch(readFileSync(join(root, ARCH_FILE), "utf8"), sk);
for (const p of problems) console.log(`- ${p.where}: ${p.problem}`);
console.log(problems.length ? `${problems.length} problem(s)` : "architecture.json matches the code");
process.exit(problems.length ? 1 : 0);
