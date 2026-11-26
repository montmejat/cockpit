// Updating an installed release from the page. desktop/release.sh writes the checkout it came from
// into the release (CHECKOUT); from there the newest tag is looked up (every half hour) and, on
// request, installed with that same script. Run from a checkout, or a release from before CHECKOUT
// existed, there's nothing to offer.

import { execFile, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COCKPIT } from "./turns.ts";
import { VERSION } from "./version.ts";

export interface Update { latest: string | null; busy: boolean; installed: string | null; error: string | null }

let checkout: string | null = null;
try { checkout = readFileSync(join(COCKPIT, "CHECKOUT"), "utf8").trim() || null; } catch {}

const st: Update = { latest: null, busy: false, installed: null, error: null };
export const update = (): Update => ({ ...st });

const git = (...a: string[]) => new Promise<string>((done) =>
  execFile("git", ["-C", checkout!, ...a], { encoding: "utf8" }, (_e, out) => done(String(out ?? "").trim())));

// The newest tag, when it isn't the one running.
async function look(onChange: () => void) {
  if (!checkout || !VERSION.release || st.busy) return;
  await git("fetch", "--tags", "--quiet", "origin");
  const newest = (await git("tag", "--list", "v*", "--sort=-v:refname")).split("\n")[0] || null;
  const latest = newest && newest !== VERSION.version && newest !== st.installed ? newest : null;
  if (latest !== st.latest) { st.latest = latest; onChange(); }
}
export function watchUpdates(onChange: () => void) {
  if (!checkout || !VERSION.release) return;
  look(onChange);
  setInterval(() => look(onChange), 30 * 60_000).unref();
}

// Install the newest tag (its own build, a minute or two); a restart then runs it.
export function installUpdate(onChange: () => void): { error?: string } {
  if (!checkout || !st.latest) return { error: "no update to install" };
  if (st.busy) return {};
  const tag = st.latest;
  st.busy = true; st.error = null; onChange();
  let out = "";
  const c = spawn("sh", [join(checkout, "desktop", "release.sh"), tag], { cwd: checkout, stdio: ["ignore", "pipe", "pipe"] });
  c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (d) => (out += d));
  c.on("close", (code) => {
    st.busy = false;
    if (code === 0) { st.installed = tag; st.latest = null; }
    else st.error = out.trim().split("\n").slice(-4).join("\n") || `release.sh exited ${code}`;
    onChange();
  });
  return {};
}
