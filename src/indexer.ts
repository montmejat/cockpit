// Turns a project into a SCIP index and a skeleton, whatever its language.
//   Rust: rust-analyzer scip
//   C/C++: scip-clang over the project's compile_commands.json files, merged into one.
//
// C++ needs the compiler's view of the code (include paths, defines), so it reads the compile
// databases the build already writes (CMake: -DCMAKE_EXPORT_COMPILE_COMMANDS=ON). When those
// paths only exist inside a build container, set "image" in the project's index.json (in
// ~/.config/cockpit/projects/<project>/, see dataDir in turns.ts) and scip-clang runs in that
// image, with the repo mounted at the same path:
//
//   { "image": "my-build-image:latest",                   // optional: run scip-clang in this image
//     "compdb": ["engine/build/compile_commands.json"] }   // optional: else found by looking

import { execFile, execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, delimiter, dirname, join } from "node:path";
import { homedir } from "node:os";
import { buildSkeleton, type Lang, type Skeleton } from "./skeleton.ts";
import { buildCppSkeleton, CXX_SOURCE } from "./skeleton-cpp.ts";
import { dataDir } from "./turns.ts";

export interface IndexConfig { image?: string; compdb?: string[] }

export function readIndexConfig(project: string): IndexConfig {
  const p = join(dataDir(project), "index.json");
  const cfg: IndexConfig = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
  if (!cfg.image && process.env.COCKPIT_CXX_IMAGE) cfg.image = process.env.COCKPIT_CXX_IMAGE;
  return cfg;
}

// Rust when there's a Cargo.toml at the top; C/C++ when there's CMake or a compile database.
export function detectLang(root: string): Lang | null {
  if (existsSync(join(root, "Cargo.toml"))) return "rust";
  if (existsSync(join(root, "CMakeLists.txt")) || existsSync(join(root, "compile_commands.json"))) return "cpp";
  for (const d of readdirSync(root, { withFileTypes: true }))
    if (d.isDirectory() && !d.name.startsWith(".") && existsSync(join(root, d.name, "CMakeLists.txt"))) return "cpp";
  return null;
}

// Files whose change makes the index stale.
export function isIndexedSource(lang: Lang, path: string): boolean {
  if (lang === "rust") return !/(^|\/)target\//.test(path) && (path.endsWith(".rs") || path.endsWith("Cargo.toml"));
  return CXX_SOURCE.test(path) || /(^|\/)CMakeLists\.txt$|\.cmake$/.test(path);
}

// The compile databases of a C++ repo: given in the config, or found where CMake usually puts
// them (<dir>/build[/<variant>]/compile_commands.json). Cross-compiling ones (arm, aarch64) go
// last, so a file built for both is indexed with the host compiler's flags.
export function findCompileDbs(root: string, cfg: IndexConfig = {}): string[] {
  if (cfg.compdb?.length) return cfg.compdb.map((p) => join(root, p)).filter((p) => existsSync(p));
  const dirs = [root];
  for (const d of readdirSync(root, { withFileTypes: true })) if (d.isDirectory() && !d.name.startsWith(".")) dirs.push(join(root, d.name));
  const found: string[] = [];
  for (const d of dirs) {
    for (const cand of [join(d, "compile_commands.json"), join(d, "build", "compile_commands.json")]) if (existsSync(cand)) found.push(cand);
    const build = join(d, "build");
    if (existsSync(build) && statSync(build).isDirectory())
      for (const v of readdirSync(build, { withFileTypes: true })) if (v.isDirectory()) {
        const cand = join(build, v.name, "compile_commands.json");
        if (existsSync(cand)) found.push(cand);
      }
  }
  const cross = (p: string) => /arm|aarch64|cross/i.test(p) ? 1 : 0;
  const unique = new Map<string, string>();
  for (const p of found.sort((a, b) => cross(realpathSync(a)) - cross(realpathSync(b)))) {
    const real = realpathSync(p);
    if (!unique.has(real)) unique.set(real, p);
  }
  return [...unique.values()];
}

// One compile database for the whole repo, each file once. `remap` moves source paths to a
// snapshot worktree; paths into build trees stay, since a worktree has no build outputs.
function mergeCompileDbs(dbs: string[], remap?: { from: string; to: string }) {
  const seen = new Set<string>(), out: any[] = [];
  const BUILD = /(^|\/)(build[^/]*|cmake-build-[^/]*|_deps)\//;
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const move = (s: string) => remap
    ? s.replace(new RegExp(esc(remap.from) + "/([^\\s\"']*)", "g"), (m, rest) => (BUILD.test(rest) ? m : `${remap.to}/${rest}`))
    : s;
  for (const db of dbs) for (const e of JSON.parse(readFileSync(db, "utf8"))) {
    const file = e.file.startsWith("/") ? e.file : join(e.directory, e.file);
    if (seen.has(file)) continue;
    seen.add(file);
    out.push({
      directory: e.directory, file: move(file),
      ...(e.arguments ? { arguments: e.arguments.map(move) } : { command: move(e.command) }),
    });
  }
  return out;
}

function findScipClang(): string {
  for (const d of [...(process.env.PATH ?? "").split(delimiter), join(homedir(), ".local", "bin")]) {
    const p = join(d, "scip-clang");
    if (d && existsSync(p)) return p;
  }
  throw new Error("scip-clang not found: download it from https://github.com/sourcegraph/scip-clang/releases into ~/.local/bin");
}

// The command that indexes `dir` (the repo, or a snapshot worktree of `repo`) into `scip`. For
// C++ this also writes the merged compile database next to `scip`; remove it after the run.
type Run = { cmd: string; args: string[]; cwd: string; env?: NodeJS.ProcessEnv; tool: string };
function indexCommand(lang: Lang, dir: string, scip: string, opts: { repo?: string; config?: IndexConfig }): Run {
  const repo = opts.repo ?? dir;
  if (lang === "rust") return {
    cmd: "rust-analyzer", args: ["scip", ".", "--output", scip], cwd: dir, tool: "rust-analyzer",
    env: dir === repo ? process.env : { ...process.env, CARGO_TARGET_DIR: join(repo, "target") },
  };
  const cfg = opts.config ?? {};
  const dbs = findCompileDbs(repo, cfg);
  if (!dbs.length) throw new Error(`no compile_commands.json under ${repo}: configure CMake with -DCMAKE_EXPORT_COMPILE_COMMANDS=ON, or list them in "compdb" of ${join(dataDir(basename(repo)), "index.json")}`);
  const merged = scip.replace(/\.scip$/, "") + ".compile_commands.json";
  writeFileSync(merged, JSON.stringify(mergeCompileDbs(dbs, dir === repo ? undefined : { from: repo, to: dir }), null, 1));

  const bin = findScipClang();
  const args = [`--compdb-path=${merged}`, `--index-output-path=${scip}`];
  if (!cfg.image) return { cmd: bin, args, cwd: dir, tool: "scip-clang" };
  // In the build image: the repo (and worktree) at their own paths, read-only; the output dir writable.
  const uid = process.getuid?.() ?? 1000, gid = process.getgid?.() ?? 1000;
  const mounts = [...new Set([repo, dir])].flatMap((p) => ["-v", `${p}:${p}:ro`]);
  return { cmd: "docker", cwd: dir, tool: "scip-clang", args: ["run", "--rm", "-u", `${uid}:${gid}`, ...mounts, "-v", `${dirname(scip)}:${dirname(scip)}`,
    "-v", `${bin}:/usr/local/bin/scip-clang:ro`, "-w", dir, "--entrypoint", "/usr/local/bin/scip-clang", cfg.image, ...args] };
}
const failed = (r: Run, e: any) => new Error(`${r.tool} failed: ${String(e.stderr || e.message).trim().split("\n").slice(-5).join("\n")}`);

// Index now, blocking: for one-off tools and turn snapshots.
export function indexProject(lang: Lang, dir: string, scip: string, opts: { repo?: string; config?: IndexConfig } = {}) {
  const r = indexCommand(lang, dir, scip, opts);
  try { execFileSync(r.cmd, r.args, { cwd: r.cwd, env: r.env, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 << 20 }); }
  catch (e) { throw failed(r, e); }
}

// Index in the background, so a server keeps answering while the indexer runs (minutes for C++).
export function indexProjectAsync(lang: Lang, dir: string, scip: string, opts: { repo?: string; config?: IndexConfig } = {}): Promise<void> {
  return new Promise((done, fail) => {
    let r: Run;
    try { r = indexCommand(lang, dir, scip, opts); } catch (e) { return fail(e); }
    execFile(r.cmd, r.args, { cwd: r.cwd, env: r.env, maxBuffer: 256 << 20 }, (e, _out, stderr) => (e ? fail(failed(r, { stderr, message: e.message })) : done()));
  });
}

export function skeletonFrom(lang: Lang, root: string, scip: string, proto: string): Skeleton {
  return lang === "rust" ? buildSkeleton(root, scip, proto) : buildCppSkeleton(root, scip, proto);
}
