// Checks a project's .cockpit/ against its code: npm run check-arch -- <project dir>
// Uses the code index of the working copy (rebuilt only if the code changed).

import { basename, resolve } from "node:path";
import { checkArch, loadArch } from "./arch.ts";
import { indexNow } from "./codeindex.ts";

const dir = process.argv[2];
if (!dir) { console.error("usage: npm run check-arch -- <project dir>"); process.exit(1); }
const root = resolve(dir);
const problems = checkArch(loadArch(root), indexNow(root, basename(root)));
for (const p of problems) console.log(`- ${p.where}: ${p.problem}`);
console.log(problems.length ? `${problems.length} problem(s)` : ".cockpit/ matches the code");
process.exit(problems.length ? 1 : 0);
