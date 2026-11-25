// A project's guardrail checks (.cockpit/guardrails.json) run outside cockpit, all of them, side by side:
//   npm run guardrails -- [project dir] [check id...]
// CI runs cockpit's own this way (.github/workflows/ci.yml), so the checks an agent is held to at
// the end of a turn are the ones a push is held to. It runs them as written: no trust step (you
// asked for it) and no results kept in cockpit's state folder. Exits 1 when one fails.

import { resolve } from "node:path";
import { failureReport, loadGuardrails, runOne } from "./guardrails.ts";

const [dir = ".", ...only] = process.argv.slice(2);
const root = resolve(dir);
const { g, problems } = loadGuardrails(root);
for (const p of problems) console.error(`guardrails.json: ${p.where}: ${p.problem}`);
if (!g) { console.error(`no .cockpit/guardrails.json in ${root}`); process.exit(1); }
if (problems.length) process.exit(1);

const list = g.checks.filter((c) => !only.length || only.includes(c.id));
const unknown = only.filter((id) => !g.checks.some((c) => c.id === id));
if (unknown.length) { console.error(`no such check: ${unknown.join(", ")}`); process.exit(1); }

const results = await Promise.all(list.map(async (c) => {
  const r = await runOne(root, c);
  console.log(`${r.ok ? "ok  " : "FAIL"} ${c.name} (${(r.ms / 1000).toFixed(1)}s)`);
  return r;
}));
const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.log("\n" + failureReport(g, failed));
  process.exit(1);
}
console.log(`\nall ${results.length} checks pass`);
