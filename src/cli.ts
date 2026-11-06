// Usage: npm run recap -- <transcript.jsonl> [--title "..."] [--model haiku]
// Writes out/<session>/{events,decisions,recap}.json and recap.html.

import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { readTranscript } from "./transcript.ts";
import { checkMerge, extractDecisions, mergeDecisions } from "./recap.ts";
import { renderPage } from "./render.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const [cmd, file] = process.argv.slice(2);
if (cmd !== "recap" || !file) {
  console.error('usage: npm run recap -- <transcript.jsonl> [--title "..."]');
  process.exit(1);
}

const source = resolve(file);
const outDir = join("out", basename(source, ".jsonl").slice(0, 8));
const cacheDir = join("out", ".cache");
mkdirSync(outDir, { recursive: true });

const events = readTranscript(source);
console.log(`${events.length} events`);

const ex = extractDecisions(events, cacheDir);
console.log(`extract: ${ex.decisions.length} decisions, $${ex.costUsd.toFixed(4)}${ex.cached ? " (cached)" : ""}`);

const mg = mergeDecisions(ex.decisions, cacheDir);
const check = checkMerge(mg.recap, ex.decisions);
console.log(`merge: ${mg.recap.themes.length} themes, $${mg.costUsd.toFixed(4)}${mg.cached ? " (cached)" : ""}`, check);

const json = (name: string, data: unknown) => writeFileSync(join(outDir, name), JSON.stringify(data, null, 2));
json("events.json", events);
json("decisions.json", ex.decisions);
json("recap.json", mg.recap);

const page = join(outDir, "recap.html");
writeFileSync(
  page,
  renderPage({
    title: arg("title") ?? "Decision recap",
    source,
    recap: mg.recap,
    decisions: ex.decisions,
    events,
    check,
    costUsd: ex.costUsd + mg.costUsd,
  }),
);
console.log(`wrote ${resolve(page)}`);
