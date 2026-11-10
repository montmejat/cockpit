// The code index of the working copy: rust-analyzer's SCIP index, read into a skeleton of crates,
// modules and their items. Rebuilt in the background when a Rust file or Cargo.toml is newer than
// the index, so the server keeps answering while rust-analyzer runs (it can take seconds).

import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildSkeleton, type Skeleton } from "./skeleton.ts";
import { outDir, PROTO } from "./turns.ts";

const EMPTY = (root: string): Skeleton => ({ root, crates: [], modules: [], edges: [] });

// Tracked and untracked (not ignored) files, so target/ and the like are never walked.
function sourceFiles(root: string) {
  try {
    return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "ignore"] })
      .split("\n").filter((f) => f.endsWith(".rs") || f.endsWith("Cargo.toml"));
  } catch { return []; }
}
function newestSource(root: string) {
  let newest = 0;
  for (const f of sourceFiles(root)) try { newest = Math.max(newest, statSync(join(root, f)).mtimeMs); } catch {}
  return newest;
}

export function createIndex(root: string, name: string, log: (s: string) => void = console.log) {
  mkdirSync(outDir(name), { recursive: true });
  const scip = resolve(join(outDir(name), "index.scip"));
  const stale = () => !existsSync(scip) || statSync(scip).mtimeMs < newestSource(root);
  const read = () => {
    try {
      const sk = buildSkeleton(root, scip, PROTO);
      log(`index: ${sk.crates.length} crates, ${sk.modules.length} modules`);
      return sk;
    } catch (e) { log(`index: could not read (${e})`); return EMPTY(root); }
  };

  let sk = existsSync(scip) ? read() : EMPTY(root);
  let running: Promise<void> | null = null;
  const listeners = new Set<() => void>();

  // Runs rust-analyzer when the code is newer than the index; one run at a time, and again if the
  // code changed while it ran.
  function refresh(): Promise<void> {
    if (running) return running;
    if (!stale()) return Promise.resolve();
    running = new Promise<void>((done) => {
      const started = Date.now();
      execFile("rust-analyzer", ["scip", ".", "--output", scip], { cwd: root }, (err) => {
        if (err) log(`index: rust-analyzer failed (${err.message.split("\n")[0]})`);
        else { sk = read(); log(`index: rebuilt in ${((Date.now() - started) / 1000).toFixed(1)} s`); for (const l of listeners) l(); }
        done();
      });
    }).finally(() => {
      running = null;
      if (stale()) void refresh();
    });
    return running;
  }

  return {
    current: () => sk,
    refresh,
    // The skeleton once it matches the code on disk.
    async fresh() { while (running || stale()) await refresh(); return sk; },
    onChange(l: () => void) { listeners.add(l); return () => listeners.delete(l); },
  };
}

// For one-off tools: the index of the working copy, built now if needed.
export function indexNow(root: string, name: string): Skeleton {
  mkdirSync(outDir(name), { recursive: true });
  const scip = resolve(join(outDir(name), "index.scip"));
  if (!existsSync(scip) || statSync(scip).mtimeMs < newestSource(root)) execFileSync("rust-analyzer", ["scip", ".", "--output", scip], { cwd: root, stdio: "ignore" });
  return buildSkeleton(root, scip, PROTO);
}
