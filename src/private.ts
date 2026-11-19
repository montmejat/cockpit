// Private descriptions: a project's .cockpit/ kept out of its repo (only you see it), with a
// history of its own, following your branches and synced between your machines.
//
// The descriptions live in a git store of cockpit's own, one per forge host
// (~/.local/share/cockpit/private/<host>.git), pushed to a private repo in your own namespace on
// that same host (cockpit-private): a project's notes stay on the forge its code is on. The
// project's .git only gets one line, `/.cockpit/` in .git/info/exclude.
//
// Per project (named by its first commit, the same in every clone, whatever the folder):
//   refs/cockpit/<pid>/c/<sha>     the description at that commit (saved when you commit here)
//   refs/cockpit/<pid>/b/<branch>  the latest description on that branch, uncommitted work included
//   refs/cockpit/<pid>/kept/<n>    a copy that was replaced when this machine joined (never lost)
// Switching branches saves .cockpit/ for the branch you leave and puts back the one of the branch
// you enter: its own, else the nearest commit before it that has one, else what you had (a new
// branch starts from where you were). Another machine's newer description for the branch you're
// on comes in by itself, unless you changed yours since (then the newer of the two wins, the
// other stays in the history).

import { execFile, execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { homedir, tmpdir } from "node:os";
import { ARCH_DIR } from "./arch.ts";
import { STATE } from "./turns.ts";

const REPO = "cockpit-private";
const CONFIG = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "cockpit", "private.json");
// Which hosts have a store (and its remote), which projects use it. Per machine.
type Config = { hosts: Record<string, { remote: string | null }>; projects: Record<string, boolean> };
const readConfig = (): Config => {
  try { const c = JSON.parse(readFileSync(CONFIG, "utf8")); return { hosts: c.hosts ?? {}, projects: c.projects ?? {} }; } catch { return { hosts: {}, projects: {} }; }
};
const writeConfig = (c: Config) => { mkdirSync(dirname(CONFIG), { recursive: true }); writeFileSync(CONFIG, JSON.stringify(c, null, 1) + "\n"); };

// The host of a remote URL: git@host:path, ssh://git@host:22/path, https://host/path.
export function hostOf(url: string) {
  const m = url.match(/^[\w.+-]+@([^:/]+):/) ?? url.match(/^[\w+]+:\/\/(?:[^@/]+@)?([^:/]+)/);
  return m?.[1] ?? null;
}
const ID = { GIT_AUTHOR_NAME: "cockpit", GIT_AUTHOR_EMAIL: "cockpit@localhost", GIT_COMMITTER_NAME: "cockpit", GIT_COMMITTER_EMAIL: "cockpit@localhost" };
// A branch name as one ref component ("a/b" and "a" both exist as branches; refs can't nest them).
const enc = (b: string) => b.replace(/[^\w.-]/g, (c) => "%" + c.charCodeAt(0).toString(16).padStart(2, "0"));
const run = (cmd: string, args: string[], opts: { cwd?: string; env?: Record<string, string>; timeout?: number } = {}) =>
  new Promise<string>((done, fail) => execFile(cmd, args, { cwd: opts.cwd ?? tmpdir(), timeout: opts.timeout ?? 60_000, maxBuffer: 64 << 20, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...opts.env } },
    (e, out, err) => (e ? fail(new Error(/ENOENT/.test(e.message) ? `${cmd} is not installed` : `${cmd} ${args[0]}: ` + String(err || out || e.message).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").trim().split("\n").slice(-3).join("\n"))) : done(out.trim()))));

export interface PrivateState {
  mode: "none" | "committed" | "off" | "on"; // none: no commit yet; committed: .cockpit/ is in the repo's git
  host: string | null; remote: string | null; synced: number | null;
  busy: string | null; error: string | null; note: string | null;
}

export function createPrivate(root: string, onChange: () => void) {
  const pgit = (...a: string[]) => {
    try { return execFileSync("git", a, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }).trimEnd(); } catch { return ""; }
  };
  const origin = pgit("remote", "get-url", "origin");
  const host = origin ? hostOf(origin) : null;
  const hostKey = host ?? "local"; // no remote: kept on this machine only
  const store = join(STATE, "private", hostKey.replace(/[^\w.-]/g, "_") + ".git");
  const pid = pgit("rev-list", "--max-parents=0", "HEAD").split("\n").filter(Boolean).sort()[0]?.slice(0, 16) ?? null;
  const NS = `refs/cockpit/${pid}`;
  const cref = (sha: string) => `${NS}/c/${sha}`, bref = (b: string) => `${NS}/b/${enc(b)}`;

  const sgit = (args: string[], env: Record<string, string> = {}) =>
    execFileSync("git", ["--git-dir", store, ...args], { cwd: root, encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...ID, ...env } }).trimEnd();
  const trySgit = (...a: string[]) => { try { return sgit(a); } catch { return ""; } };
  const resolveRef = (ref: string) => trySgit("rev-parse", "-q", "--verify", ref + "^{commit}");
  const treeOf = (c: string) => trySgit("rev-parse", c + "^{tree}");
  const isAncestor = (a: string, b: string) => { try { sgit(["merge-base", "--is-ancestor", a, b]); return true; } catch { return false; } };

  let busy: string | null = null, error: string | null = null, note: string | null = null, synced: number | null = null;
  const committed = () => !!pgit("ls-files", "--", ARCH_DIR);
  const enabled = () => !!pid && !!readConfig().projects[pid] && existsSync(store) && !committed();
  const remote = () => readConfig().hosts[hostKey]?.remote ?? null;

  // ---- .cockpit/ on disk -----------------------------------------------------------

  function files(dir = join(root, ARCH_DIR), out: string[] = []) {
    if (!existsSync(dir)) return out;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules") continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) files(p, out);
      else if (e.isFile()) out.push(p);
    }
    return out;
  }
  const fingerprint = () => files().map((p) => { try { const s = statSync(p); return `${p}:${s.size}:${s.mtimeMs}`; } catch { return p; } }).sort().join("\n");
  // A throwaway index in the store, so the project's own index is never touched.
  function withIndex<T>(fn: (env: Record<string, string>) => T): T {
    const tmp = mkdtempSync(join(tmpdir(), "cockpit-private-"));
    try { return fn({ GIT_INDEX_FILE: join(tmp, "index"), GIT_WORK_TREE: root }); } finally { rmSync(tmp, { recursive: true, force: true }); }
  }
  // The tree of .cockpit/ as it is now (null: nothing there).
  function workingTree(): string | null {
    const fs = files();
    if (!fs.length) return null;
    return withIndex((env) => { sgit(["add", "-f", "--", ...fs.map((f) => relative(root, f))], env); return sgit(["write-tree"], env); });
  }
  // Save what's in .cockpit/ under these refs (each keeps its history). False when nothing changed.
  function save(refs: string[], head: string, branch: string | null, tree = workingTree()) {
    if (!tree) return false;
    let did = false;
    for (const ref of refs) {
      const old = resolveRef(ref);
      if (old && treeOf(old) === tree) continue;
      const c = sgit(["commit-tree", tree, ...(old ? ["-p", old] : []), "-m", `${branch ?? "detached"} at ${head.slice(0, 10)}\n\nCode: ${head}`]);
      sgit(["update-ref", ref, c]);
      did = true;
    }
    if (did) schedulePush();
    return did;
  }
  // Put a saved description in .cockpit/: its files written, the ones it doesn't have removed
  // (what was there is always saved first).
  function restore(commit: string) {
    withIndex((env) => {
      sgit(["read-tree", commit], env);
      const want = new Set(sgit(["ls-files"], env).split("\n").filter(Boolean).map((f) => join(root, f)));
      for (const f of files()) if (!want.has(f)) rmSync(f, { force: true });
      sgit(["checkout-index", "-a", "-f"], env);
    });
  }
  // The description of the nearest commit at or before `sha` that has one.
  function nearest(sha: string) {
    const have = new Set(trySgit("for-each-ref", "--format=%(refname:lstrip=4)", `${NS}/c/`).split("\n").filter(Boolean));
    if (!have.size) return null;
    for (const s of pgit("rev-list", "--max-count=5000", sha).split("\n")) if (have.has(s)) return resolveRef(cref(s)) || null;
    return null;
  }
  const clean = () => !pgit("status", "--porcelain=v1", "--untracked-files=no");

  // ---- following git: called whenever the project may have changed ------------------------

  let last: { head: string; branch: string | null; fp: string } | null = null;
  let adopt = false; // joining: what the other machines saved wins over a stale copy here
  let saveTimer: NodeJS.Timeout | null = null;
  function saveNow(head: string, branch: string | null, withCommit: boolean) {
    const refs = branch ? [bref(branch)] : [];
    if (withCommit && clean()) refs.push(cref(head));
    if (refs.length) save(refs, head, branch);
  }
  function tick() {
    if (!enabled()) { last = null; return; }
    const head = pgit("rev-parse", "HEAD");
    if (!head) return;
    const branch = pgit("symbolic-ref", "--short", "-q", "HEAD") || null;
    const fp = fingerprint(), prev = last;
    try {
      if (!prev) {
        const theirs = (branch && resolveRef(bref(branch))) || nearest(head);
        if (!fp) { if (theirs) restore(theirs); }
        else if (adopt && theirs && treeOf(theirs) !== workingTree()) {
          // This machine had its own copy: kept in the store, the synced one put in place.
          const ref = `${NS}/kept/${Date.now()}`;
          save([ref], head, branch);
          restore(theirs);
          note = `the .cockpit/ that was here is kept in the store (${ref.split("/").slice(-2).join("/")})`;
        } else saveNow(head, branch, true);
        adopt = false;
      } else if (branch !== prev.branch) {
        // Switched: what's on disk still describes the branch you left.
        if (prev.branch) save([bref(prev.branch)], prev.head, prev.branch);
        const own = branch ? resolveRef(bref(branch)) : "";
        const target = own || (head !== prev.head ? nearest(head) : null);
        if (target && treeOf(target) !== workingTree()) restore(target);
        if (branch) save([bref(branch)], head, branch); // a new branch starts from where you were
      } else if (head !== prev.head) {
        // A commit made here describes it; a pull, reset or rebase brings the description of where
        // it lands, when there is one (else you keep yours).
        const how = pgit("reflog", "-1", "--format=%gs");
        if (/^commit/.test(how)) saveNow(head, branch, true);
        else {
          const at = resolveRef(cref(head));
          if (at && treeOf(at) !== workingTree()) restore(at);
          void sync();
        }
      } else if (fp !== prev.fp) {
        // Edited (by you or an agent): saved once it settles.
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => { saveTimer = null; try { saveNow(head, branch, false); } catch (e) { fail(e); } }, 1500);
      }
    } catch (e) { fail(e); }
    last = { head, branch, fp: fingerprint() };
  }
  const fail = (e: unknown) => { error = String((e as Error)?.message ?? e).split("\n").slice(-2).join(" "); onChange(); };

  // ---- syncing with your other machines ---------------------------------------------

  let syncing = false, pushTimer: NodeJS.Timeout | null = null;
  function schedulePush() { if (pushTimer) clearTimeout(pushTimer); pushTimer = setTimeout(() => { pushTimer = null; void sync(); }, 10_000); pushTimer.unref(); }
  const refsUnder = (prefix: string) => new Map(trySgit("for-each-ref", "--format=%(refname) %(objectname)", prefix).split("\n").filter(Boolean)
    .map((l) => { const [r, o] = l.split(" "); return [r.slice(prefix.length), o] as const; }));
  async function sync() {
    if (!enabled() || syncing || !remote()) return;
    syncing = true;
    try {
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; if (last) saveNow(last.head, last.branch, false); }
      await run("git", ["--git-dir", store, "fetch", "-q", "--prune", "origin", `+${NS}/*:refs/sync/${pid}/*`]);
      const theirs = refsUnder(`refs/sync/${pid}/`), ours = refsUnder(`${NS}/`);
      const cur = last?.branch ? bref(last.branch).slice(NS.length + 1) : null, before = cur ? ours.get(cur) : undefined;
      let behind = false;
      for (const [name, t] of theirs) {
        const o = ours.get(name);
        if (o === t || (o && isAncestor(t, o))) continue;
        const take = !o || isAncestor(o, t) || Number(trySgit("log", "-1", "--format=%ct", t)) > Number(trySgit("log", "-1", "--format=%ct", o));
        if (take) { sgit(["update-ref", `${NS}/${name}`, t]); ours.set(name, t); }
      }
      for (const [name, o] of ours) if (theirs.get(name) !== o) behind = true;
      if (behind) await run("git", ["--git-dir", store, "push", "-q", "--force", "origin", `${NS}/*:${NS}/*`]);
      // Another machine moved the branch you're on: put it in place, unless you changed yours since.
      const after = cur ? ours.get(cur) : undefined;
      if (after && after !== before && last) {
        const here = workingTree();
        if (!here || (before && here === treeOf(before))) { restore(after); last.fp = fingerprint(); }
      }
      synced = Date.now(); error = null;
    } catch (e) { error = "sync: " + String((e as Error).message ?? e); }
    finally { syncing = false; onChange(); }
  }

  // ---- turning it on ----------------------------------------------------------------

  // The private repo for this host, found or created in your namespace (gh or glab, logged in).
  async function findRemote(create: boolean): Promise<string | null> {
    if (!host) return null;
    const ssh = !/^https?:/.test(origin);
    if (host === "github.com") {
      const view = () => run("gh", ["repo", "view", REPO, "--json", "sshUrl,url"]);
      let v = await view().catch(() => null);
      if (!v && create) { await run("gh", ["repo", "create", REPO, "--private", "--description", "cockpit: private descriptions (.cockpit/) of my projects"]); v = await view(); }
      if (!v) return null;
      const j = JSON.parse(v);
      return ssh ? j.sshUrl : j.url + ".git";
    }
    // GitLab's API through glab (`glab repo create` stops to ask questions when there's no terminal).
    const env = { GITLAB_HOST: host };
    const user = JSON.parse(await run("glab", ["api", "user"], { env })).username;
    const view = () => run("glab", ["api", `projects/${encodeURIComponent(`${user}/${REPO}`)}`], { env });
    let v = await view().catch(() => null);
    if (!v && create) v = await run("glab", ["api", "-X", "POST", "projects", "-f", `path=${REPO}`, "-f", `name=${REPO}`, "-f", "visibility=private", "-f", "description=cockpit: private descriptions (.cockpit/) of my projects"], { env });
    if (!v) return null;
    const j = JSON.parse(v);
    return ssh ? j.ssh_url_to_repo : j.http_url_to_repo;
  }
  function initStore(url: string | null) {
    if (!existsSync(store)) { mkdirSync(dirname(store), { recursive: true }); execFileSync("git", ["init", "-q", "--bare", store]); }
    if (url) { if (trySgit("remote", "get-url", "origin")) sgit(["remote", "set-url", "origin", url]); else sgit(["remote", "add", "origin", url]); }
  }
  // /.cockpit/ in .git/info/exclude: out of `git status`, never in a commit, and only on this clone.
  function exclude() {
    const file = resolveIn(pgit("rev-parse", "--git-path", "info/exclude"));
    const text = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (text.split("\n").some((l) => /^\/?\.cockpit\/?$/.test(l.trim()))) return;
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, (text && !text.endsWith("\n") ? "\n" : "") + "# cockpit: .cockpit/ is kept private, see cockpit's Git tab\n/.cockpit/\n");
  }
  const resolveIn = (p: string) => (p.startsWith("/") ? p : join(root, p));

  async function enable(opts: { create: boolean } = { create: true }) {
    if (!pid) throw new Error("the project has no commit yet");
    if (committed()) throw new Error(".cockpit/ is in the project's git: everyone who clones it has it");
    busy = host ? `setting up ${REPO} on ${host}…` : "setting up…"; error = null; onChange();
    try {
      const cfg = readConfig();
      if (!cfg.hosts[hostKey]?.remote && host) cfg.hosts[hostKey] = { remote: await findRemote(opts.create) };
      else cfg.hosts[hostKey] ??= { remote: null };
      initStore(cfg.hosts[hostKey].remote);
      exclude();
      cfg.projects[pid] = true;
      writeConfig(cfg);
      adopt = true; last = null;
      busy = "syncing…"; onChange();
      await sync(); // what your other machines saved first
      tick();
      await sync();
    } catch (e) { error = String((e as Error).message ?? e); throw e; }
    finally { busy = null; onChange(); }
  }
  function disable() {
    if (!pid) return;
    const cfg = readConfig();
    delete cfg.projects[pid];
    writeConfig(cfg);
    last = null; note = null; onChange();
  }
  // On a machine that hasn't turned it on for this project: if your private repo already has it
  // (another machine did), join by itself.
  async function discover() {
    if (!pid || readConfig().projects[pid] || committed()) return;
    try {
      const url = readConfig().hosts[hostKey]?.remote ?? (host ? await findRemote(false) : null);
      if (!url) return;
      const has = await run("git", ["ls-remote", url, `${NS}/*`], { timeout: 30_000 });
      if (has) await enable({ create: false });
    } catch {}
  }

  function state(): PrivateState {
    const r = remote();
    return {
      mode: !pid ? "none" : committed() ? "committed" : enabled() ? "on" : "off",
      host, remote: r ? r.replace(/^[\w+]+:\/\/(?:[^@/]+@)?|^[\w.+-]+@/, "").replace(/\.git$/, "").replace(":", "/") : null,
      synced, busy, error, note,
    };
  }

  // The description at a commit (for review mode, comparing with what the target had).
  function at(sha: string) { return enabled() ? nearest(sha) : null; }

  setInterval(() => void sync(), 5 * 60_000).unref();
  setTimeout(() => { void (enabled() ? sync() : discover()); }, 3000).unref();
  return { tick, sync, enable, disable, state, at, store };
}
