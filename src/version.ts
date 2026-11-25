// Which cockpit this is. A release (desktop/release.sh) is a tagged commit unpacked on its own,
// with a VERSION file holding its tag ("v2026.11.25.1"). Run from a checkout instead, it's "dev",
// with what git says about it ("v2026.11.25.1-3-g41b6bc5-dirty": 3 commits past that tag, edited).

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COCKPIT } from "./turns.ts";

export interface Version { version: string; release: boolean }

export let VERSION: Version = { version: "dev", release: false };
try { VERSION = { version: readFileSync(join(COCKPIT, "VERSION"), "utf8").trim(), release: true }; } catch {
  execFile("git", ["describe", "--tags", "--always", "--dirty"], { cwd: COCKPIT }, (err, out) => {
    if (!err && out.trim()) VERSION = { version: `dev ${out.trim()}`, release: false };
  });
}
