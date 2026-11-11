// The code index of the working copy, read into a skeleton of crates (CMake projects for C++),
// modules and their items. Rust: rust-analyzer's SCIP index; C/C++: scip-clang's (indexer.ts).
// Rebuilt in the background when a source is newer than the index, so the server keeps
// answering while the indexer runs (seconds for Rust, minutes for a large C++ repo).

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { detectLang, findCompileDbs, type IndexConfig, indexProject, indexProjectAsync, isIndexedSource, readIndexConfig, skeletonFrom } from "./indexer.ts";
import { type Lang, type Skeleton, SKELETON_VERSION } from "./skeleton.ts";
import { outDir, PROTO } from "./turns.ts";

const EMPTY = (root: string, lang?: Lang): Skeleton => ({ root, lang, crates: [], modules: [], edges: [] });

// Tracked and untracked (not ignored) files, so target/, build/ and the like are never walked.
function listFiles(root: string): string[] {
  try {
    return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8", maxBuffer: 256 << 20, stdio: ["ignore", "pipe", "ignore"] })
      .split("\n").filter(Boolean);
  } catch { return readdirSync(root, { recursive: true }) as string[]; }
}
// The newest source the index depends on: for C++ the compile databases count too.
function newestSource(root: string, lang: Lang, config: IndexConfig) {
  let newest = 0;
  for (const f of listFiles(root)) if (isIndexedSource(lang, f)) try { newest = Math.max(newest, statSync(join(root, f)).mtimeMs); } catch {}
  if (lang === "cpp") for (const db of findCompileDbs(root, config)) try { newest = Math.max(newest, statSync(db).mtimeMs); } catch {}
  return newest;
}

// Where the index lives and how fresh it is. Fresh only if no source changed since indexing
// *started*: files that change while the indexer runs (a branch switch, an agent's edit) are
// newer than the start, so they count. Indexing writes a file of its own and swaps it in, so two
// processes indexing at once (the server and a check-arch run) never read a half-written index.
function indexFiles(root: string, name: string) {
  mkdirSync(outDir(name), { recursive: true });
  const scip = resolve(join(outDir(name), "index.scip"));
  const stamp = scip + ".started";
  const lang = detectLang(root);
  const config = readIndexConfig(name);
  const stale = () => {
    if (!lang) return false;
    // The stamp is "<start time> v<skeleton version>": an index from an older reader or scanner is stale too.
    const [t, v] = existsSync(scip) && existsSync(stamp) ? readFileSync(stamp, "utf8").trim().split(" ") : [];
    const started = v === `v${SKELETON_VERSION}` ? Number(t) || 0 : 0;
    return started <= newestSource(root, lang, config);
  };
  const begin = () => ({ t: Date.now(), tmp: scip.replace(/\.scip$/, `.${process.pid}.scip`) });
  const finish = (t: number, tmp: string) => { renameSync(tmp, scip); writeFileSync(stamp, `${t} v${SKELETON_VERSION}`); };
  const cleanup = (tmp: string) => { rmSync(tmp, { force: true }); rmSync(tmp.replace(/\.scip$/, ".compile_commands.json"), { force: true }); };
  return { scip, lang, config, stale, begin, finish, cleanup };
}

const toolOf = (lang: Lang, config: IndexConfig) => (lang === "rust" ? "rust-analyzer" : lang === "zig" ? "the Zig scanner" : `scip-clang${config.image ? ` in ${config.image}` : ""}`);

export function createIndex(root: string, name: string, log: (s: string) => void = console.log) {
  const f = indexFiles(root, name);
  if (!f.lang) log(`index: ${root} has no Cargo.toml (Rust), build.zig (Zig) or CMakeLists.txt (C/C++): no code index`);
  const read = () => {
    try {
      const sk = skeletonFrom(f.lang!, root, f.scip, PROTO);
      log(`index: ${sk.crates.length} ${f.lang === "cpp" ? "projects" : f.lang === "zig" ? "packages" : "crates"}, ${sk.modules.length} modules`);
      return sk;
    } catch (e) { log(`index: could not read (${e})`); return EMPTY(root, f.lang ?? undefined); }
  };

  let sk = f.lang && existsSync(f.scip) ? read() : EMPTY(root, f.lang ?? undefined);
  let running: Promise<void> | null = null;
  let lastError = "";
  const listeners = new Set<() => void>();

  // Runs the indexer when the code is newer than the index; one run at a time, and again if the
  // code changed while it ran (but not straight away after a failure: the next change retries).
  function refresh(): Promise<void> {
    if (running) return running;
    if (!f.lang || !f.stale()) return Promise.resolve();
    const lang = f.lang;
    const { t, tmp } = f.begin();
    log(`index: running ${toolOf(lang, f.config)}…`);
    let ok = false;
    running = indexProjectAsync(lang, root, tmp, { config: f.config })
      .then(() => {
        f.finish(t, tmp);
        ok = true; lastError = "";
        sk = read();
        log(`index: rebuilt in ${((Date.now() - t) / 1000).toFixed(1)} s`);
        for (const l of listeners) l();
      })
      .catch((e) => { lastError = String(e.message ?? e); log(`index: ${lastError.split("\n")[0]}`); })
      .finally(() => {
        f.cleanup(tmp);
        running = null;
        if (ok && f.stale()) void refresh();
      });
    return running;
  }

  return {
    current: () => sk,
    refresh,
    error: () => lastError,
    // The skeleton once it matches the code on disk (or the last one, if indexing fails).
    async fresh() {
      await refresh();
      while (running) await running;
      return sk;
    },
    // A change to a file the index depends on.
    affects: (path: string) => !!f.lang && isIndexedSource(f.lang, path),
    onChange(l: () => void) { listeners.add(l); return () => listeners.delete(l); },
  };
}

// For one-off tools: the index of the working copy, built now if needed.
export function indexNow(root: string, name: string, log: (s: string) => void = () => {}): Skeleton {
  const f = indexFiles(root, name);
  if (!f.lang) throw new Error(`${root}: no Cargo.toml (Rust), build.zig (Zig) or CMakeLists.txt (C/C++) found`);
  if (f.stale()) {
    log(`indexing with ${toolOf(f.lang, f.config)}…`);
    const { t, tmp } = f.begin();
    try { indexProject(f.lang, root, tmp, { config: f.config }); f.finish(t, tmp); }
    finally { f.cleanup(tmp); }
  }
  return skeletonFrom(f.lang, root, f.scip, PROTO);
}
