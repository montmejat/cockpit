// Dev containers: when a project has a devcontainer.json (.devcontainer/devcontainer.json,
// .devcontainer.json, or .devcontainer/<name>/devcontainer.json), its shells run in that
// container: the terminals, the agent's shell commands and the editor's language servers. Files
// are still read and written on the host, as the container mounts the project (usually at the same
// path; workspaceFolder says where).
//
// The container is started with the Dev Containers CLI (@devcontainers/cli), so the config means
// what it means in VS Code: build, features, mounts, runArgs, remoteUser, remoteEnv, and the
// lifecycle commands. It carries a label of cockpit's own, so it is never VS Code's container for
// the same folder, and it keeps running when cockpit stops (the next start finds it again).
//
// A workspace can share one container between its projects: "devcontainer": "<project path>" in
// its workspace.json names the project whose config is used, and every project of the workspace
// is mounted there at its own path. Each project's server finds the same container (a lock keeps
// two of them from creating it at once).
//
// To leave a project's shells on the host: { "devcontainer": false } in
// ~/.config/cockpit/projects/<project>/settings.json.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COCKPIT, dataDir, outDir, STATE } from "./turns.ts";
import { workspaceOf } from "./workspace.ts";

const CLI = join(COCKPIT, "node_modules", ".bin", "devcontainer");
export const DC_EXEC = join(COCKPIT, "src", "dc-exec");
const SHELL = join(COCKPIT, "src", "shell", "bash"); // the chat agent's shell (CLAUDE_CODE_SHELL)

export interface Container {
  id: string; user: string; image: string; name: string;
  hostFolder: string; folder: string; // the config's project on the host, and where it is in the container
  envFile: string; // the remote environment (remoteEnv, the user's login shell), for docker exec
  shared: string | null; // the workspace sharing it
  settings: Record<string, unknown>; // customizations.vscode.settings (clangd's path and arguments)
  mounted: string[]; // host folders mounted at the same path
  tmp: string; // Claude Code's temp folder for the chat agent (CLAUDE_CODE_TMPDIR), mounted at the same path
}
export interface DevStatus {
  state: "none" | "starting" | "up" | "failed";
  name?: string; config?: string; shared?: string | null;
  container?: string; image?: string; user?: string;
  progress?: string; error?: string; log?: string;
}

interface Spec { config: string; folder: string; label: string; mounts: string[]; shared: string | null }

export function findConfig(dir: string): string | null {
  for (const p of [".devcontainer/devcontainer.json", ".devcontainer.json"]) if (existsSync(join(dir, p))) return join(dir, p);
  try {
    for (const d of readdirSync(join(dir, ".devcontainer"), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()) {
      const p = join(dir, ".devcontainer", d, "devcontainer.json");
      if (existsSync(p)) return p;
    }
  } catch {}
  return null;
}

function enabled(project: string) {
  try { return JSON.parse(readFileSync(join(dataDir(project), "settings.json"), "utf8")).devcontainer !== false; } catch { return true; }
}

// Which container a project's shells run in, if any: the workspace's shared one, else its own.
function specOf(root: string, project: string): Spec | { error: string } | null {
  if (!enabled(project)) return null;
  const ws = workspaceOf(root);
  if (ws?.devcontainer) {
    const config = findConfig(ws.devcontainer);
    if (!config) return { error: `workspace ${ws.name}: no devcontainer.json in ${ws.devcontainer}` };
    return {
      config, folder: ws.devcontainer, label: `cockpit.workspace=${ws.name}`, shared: ws.name,
      mounts: ws.projects.map((p) => p.path).filter((p) => p !== ws.devcontainer && existsSync(p)),
    };
  }
  const config = findConfig(root);
  return config ? { config, folder: root, label: `cockpit.project=${root}`, mounts: [], shared: null } : null;
}

const plain = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").trim();
const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
const envOf = (out: string) => new Map(out.split("\0").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)] as [string, string]));

// One process at a time brings up a given container: the others wait for it and then find it.
async function locked<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const lock = join(dir, "lock");
  for (;;) {
    try { mkdirSync(lock); writeFileSync(join(lock, "pid"), String(process.pid)); break; } catch {}
    let pid = 0;
    try { pid = Number(readFileSync(join(lock, "pid"), "utf8")); } catch {}
    let alive = false;
    try { if (pid) { process.kill(pid, 0); alive = true; } } catch {}
    if (!alive && (pid || Date.now() - statSync(lock).mtimeMs > 10_000)) { rmSync(lock, { recursive: true, force: true }); continue; }
    await new Promise((r) => setTimeout(r, 1000));
  }
  try { return await fn(); } finally { rmSync(lock, { recursive: true, force: true }); }
}

export function createDevcontainer(root: string, project: string, log: (s: string) => void = console.log) {
  const spec = specOf(root, project);
  let status: DevStatus = !spec ? { state: "none" } : "error" in spec ? { state: "failed", error: spec.error }
    : { state: "starting", config: spec.config, shared: spec.shared };
  let cur: Container | null = null;
  let pending: Promise<Container | null> | null = null;
  let checked = 0;
  const listeners = new Set<() => void>();
  const set = (s: DevStatus) => { status = s; for (const l of listeners) l(); };
  const key = spec && !("error" in spec) ? spec.label.replace(/[^\w.-]+/g, "_").slice(-120) : "";
  const dir = join(STATE, "devcontainers", key);
  // Claude Code keeps the shell's cwd and background output here: the agent's commands run in the
  // container, Claude Code reads them on the host (src/shell/bash). It wants a private folder.
  const tmp = join(dir, "tmp");

  // The Dev Containers CLI, its log kept in the container's folder (and its last line shown while
  // it works: a first build takes minutes).
  function cli(args: string[], logFile?: string): Promise<string> {
    return new Promise((done, fail) => {
      const p = spawn(CLI, args, { stdio: ["ignore", "pipe", "pipe"] });
      let out = "", err = "", last = 0;
      p.stdout.on("data", (c) => (out += c));
      p.stderr.on("data", (c) => {
        err += c;
        if (err.length > 2e6) err = err.slice(-1e6);
        if (logFile && Date.now() - last > 500) {
          last = Date.now();
          const line = plain(err.trimEnd().split("\n").at(-1) ?? "").slice(0, 160);
          if (line && status.state === "starting") set({ ...status, progress: line });
        }
      });
      p.on("error", fail);
      p.on("close", (code) => {
        if (logFile) try { writeFileSync(logFile, err); } catch {}
        if (code === 0) return done(out);
        let msg = "";
        try { const j = JSON.parse(out.trim().split("\n").at(-1) ?? ""); msg = [j.message, j.description].filter(Boolean).join(": "); } catch {}
        fail(new Error((msg || plain(err).split("\n").slice(-4).join("\n") || `exit ${code}`).slice(0, 1200)));
      });
    });
  }

  async function up(s: Spec, fresh = false): Promise<Container> {
    mkdirSync(dir, { recursive: true });
    const logFile = join(dir, "up.log");
    set({ state: "starting", config: s.config, shared: s.shared, log: logFile, progress: fresh ? "rebuilding" : "starting" });
    mkdirSync(tmp, { recursive: true, mode: 0o700 });
    return locked(dir, async () => {
      const base = ["--workspace-folder", s.folder, "--config", s.config, "--id-label", s.label];
      const want = [...s.mounts, tmp];
      const args = ["up", ...base, "--log-format", "text", ...want.flatMap((m) => ["--mount", `type=bind,source=${m},target=${m}`])];
      let r = JSON.parse((await cli(fresh ? [...args, "--remove-existing-container"] : args, logFile)).trim().split("\n").at(-1)!);
      if (r.outcome !== "success") throw new Error(r.message ?? "devcontainer up failed");
      // A container made before the workspace had all its projects: make it again with them.
      const have = new Set((JSON.parse(docker("inspect", "-f", "{{json .Mounts}}", r.containerId)) as { Destination: string }[]).map((m) => m.Destination));
      if (want.some((m) => !have.has(m))) {
        log(`devcontainer: ${r.containerId.slice(0, 12)} lacks ${want.filter((m) => !have.has(m)).join(", ")}: making it again`);
        r = JSON.parse((await cli([...args, "--remove-existing-container"], logFile)).trim().split("\n").at(-1)!);
      }
      const id: string = r.containerId, user: string = r.remoteUser, folder: string = r.remoteWorkspaceFolder;
      // The environment a shell gets there: what devcontainer exec sets up (remoteEnv, the user's
      // login shell), minus what the container has anyway. docker exec gets it as an env file.
      const probed = envOf(await cli(["exec", ...base, "sh", "-c", "env -0"]));
      const plainEnv = envOf(docker("exec", "-u", user, id, "env", "-0"));
      const lines = [...probed].filter(([k, v]) => plainEnv.get(k) !== v && !/^(HOSTNAME|SHLVL|PWD|OLDPWD|_|TERM)$/.test(k) && !v.includes("\n")).map(([k, v]) => `${k}=${v}`);
      const envFile = join(dir, "env");
      writeFileSync(envFile, lines.join("\n") + "\n");
      const conf = JSON.parse(await cli(["read-configuration", ...base])).configuration ?? {};
      const image = docker("inspect", "-f", "{{.Image}}", id).trim();
      const c: Container = {
        id, user, image, name: conf.name ?? project, hostFolder: s.folder, folder, envFile, shared: s.shared,
        settings: conf.customizations?.vscode?.settings ?? {}, mounted: s.mounts, tmp,
      };
      // For the agent's shell (src/shell/bash), read on every command.
      writeFileSync(join(dir, "exec"), [id, user, envFile, folder, s.folder, s.mounts.join(":")].join("\n") + "\n");
      // For the C++ indexer (indexer.ts), which runs scip-clang in the container's image.
      mkdirSync(outDir(project), { recursive: true });
      writeFileSync(join(outDir(project), "devcontainer.json"), JSON.stringify({ image, id, name: c.name }) + "\n");
      return c;
    });
  }

  function start(fresh = false): Promise<Container | null> {
    if (!spec || "error" in spec) return Promise.resolve(null);
    return (pending ??= up(spec, fresh)
      .then((c) => {
        cur = c; checked = Date.now();
        log(`devcontainer: ${c.name} up (${c.id.slice(0, 12)}, as ${c.user}${c.shared ? `, shared by workspace ${c.shared}` : ""})`);
        set({ state: "up", name: c.name, config: spec.config, shared: c.shared, container: c.id, image: c.image, user: c.user, log: join(dir, "up.log") });
        return c;
      })
      .catch((e) => {
        cur = null;
        log(`devcontainer: ${spec.config}: ${e.message}`);
        set({ state: "failed", config: spec.config, shared: spec.shared, error: String(e.message ?? e), log: join(dir, "up.log") });
        return null;
      })
      .finally(() => { pending = null; }));
  }

  // The container, once it's up. A container stopped meanwhile (docker restart, a reboot) is
  // started again; one that failed to come up isn't retried until asked (retry()).
  async function ready(): Promise<Container | null> {
    if (pending) return pending;
    if (cur && Date.now() - checked > 10_000) {
      let running = false;
      try { running = docker("inspect", "-f", "{{.State.Running}}", cur.id).trim() === "true"; } catch {}
      if (running) checked = Date.now(); else cur = null;
      if (!running) return start();
    }
    return cur ?? (status.state === "starting" ? start() : null);
  }

  // Paths between the host and the container: the config's project may sit elsewhere in the
  // container; everything else (other projects of a shared container) is at its own path.
  const toContainer = (c: Container, p: string) => (p === c.hostFolder || p.startsWith(c.hostFolder + "/") ? c.folder + p.slice(c.hostFolder.length) : p);
  const toHost = (c: Container, p: string) => (p === c.folder || p.startsWith(c.folder + "/") ? c.hostFolder + p.slice(c.folder.length) : p);
  // Whether a host path is the same path in the container (so tools that pass paths around, like
  // a language server, work across the two).
  const samePath = (c: Container, p: string) => c.folder === c.hostFolder || !(p === c.hostFolder || p.startsWith(c.hostFolder + "/"));
  const covers = (c: Container, p: string) => [c.hostFolder, ...c.mounted].some((m) => p === m || p.startsWith(m + "/"));

  // The command line that runs `argv` in the container (through dc-exec).
  function exec(c: Container, cwd: string, argv: string[], o: { tty?: boolean; stdin?: boolean; env?: Record<string, string> } = {}) {
    const flags = [...(o.tty ? ["-t"] : []), ...(o.stdin ? ["-i"] : []), ...Object.entries(o.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`])];
    return { cmd: DC_EXEC, args: [...flags, c.id, c.user, covers(c, cwd) ? toContainer(c, cwd) : c.folder, c.envFile, ...argv] };
  }

  // What the chat agent's Claude Code needs to run its shell commands in the container.
  const agentEnv = (): Record<string, string> => ({ CLAUDE_CODE_SHELL: SHELL, CLAUDE_CODE_TMPDIR: tmp, COCKPIT_DC: dir, COCKPIT_HOME: COCKPIT });

  return {
    start, ready, exec, toContainer, toHost, samePath, covers, agentEnv,
    status: () => status,
    current: () => cur,
    onChange(fn: () => void) { listeners.add(fn); return () => listeners.delete(fn); },
    // Bring it up again after a failure, or rebuild it (a new container from the config).
    retry(rebuild = false) { if (!pending) { cur = null; void start(rebuild); } },
  };
}

export type Devcontainer = ReturnType<typeof createDevcontainer>;
