// The server runs on one thread: terminals, the chat stream and the language servers wait while it
// waits on a command run synchronously (execFileSync, execSync, spawnSync). Git goes through
// src/git.ts (async), other tools through execFile. The places below still do it, each for a
// reason; they may not grow, and no other file may start. Fails with what to use instead.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

// file: [most sync calls allowed, why]. Lower a number when you remove one; never raise it.
const KNOWN = {
  "src/snapshot.ts": [4, "turn snapshots, also run by the Claude Code hook (a command of its own)"],
  "src/indexer.ts": [4, "builds the code index (rust-analyzer, scip-clang); also run as a command"],
  "src/private.ts": [3, "the private store's git, on checkout and sync"],
  "src/arch.ts": [1, "git show of .cockpit/ at a past turn"],
  "src/ask.ts": [1, "--help of the project's own programs, for Ctrl+K"],
  "src/codeindex.ts": [1, "git ls-files before an index"],
  "src/skeleton.ts": [1, "indexing"],
  "src/skeleton-ts.ts": [1, "indexing"],
  "src/skeleton-zig.ts": [1, "indexing"],
};
// Commands of their own (not the server): they may wait.
const COMMANDS = new Set(["src/check-arch.ts", "src/modules.ts", "src/hook.ts"]);

const root = resolve(import.meta.dirname, "../..");
const files = readdirSync(join(root, "src"), { withFileTypes: true, recursive: true })
  .filter((e) => e.isFile() && e.name.endsWith(".ts")).map((e) => relative(root, join(e.parentPath, e.name)));

const bad = [];
for (const f of files) {
  if (COMMANDS.has(f)) continue;
  const lines = readFileSync(join(root, f), "utf8").split("\n");
  const at = [];
  lines.forEach((l, i) => { if (/\b(execFileSync|execSync|spawnSync)\s*\(/.test(l.replace(/\/\/.*$/, ""))) at.push(i + 1); });
  const [max] = KNOWN[f] ?? [0];
  if (at.length > max) bad.push(`${f}:${at.join(",")}: ${at.length} synchronous command${at.length > 1 ? "s" : ""}${max ? ` (at most ${max})` : ""}. Use git() from src/git.ts for git, or execFile from node:child_process, and await it.`);
}
if (bad.length) { console.log(bad.join("\n")); process.exit(1); }
console.log("no new synchronous commands in the server");
