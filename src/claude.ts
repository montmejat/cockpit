// Calls Claude through the local `claude -p` CLI, so it runs on the user's
// existing Claude Code login. Results are cached on disk by prompt hash:
// rerunning a step with the same input costs nothing.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface CallResult<T> {
  output: T;
  costUsd: number;
  cached: boolean;
}

export interface CallOptions {
  system: string;
  prompt: string;
  schema: object;
  model?: string; // default: haiku (cheap, fine for experiments)
  cacheDir: string;
}

export function callClaude<T>(opts: CallOptions): CallResult<T> {
  const model = opts.model ?? "haiku";
  const key = createHash("sha256")
    .update(JSON.stringify([model, opts.system, opts.prompt, opts.schema]))
    .digest("hex")
    .slice(0, 16);
  mkdirSync(opts.cacheDir, { recursive: true });
  const cacheFile = join(opts.cacheDir, `${key}.json`);
  if (existsSync(cacheFile)) {
    const hit = JSON.parse(readFileSync(cacheFile, "utf8"));
    return { output: hit.output, costUsd: hit.costUsd, cached: true };
  }

  const args = [
    "-p",
    "--model", model,
    "--tools", "", // no tools: one structured answer, no agent loop
    "--setting-sources", "", // skip user/project settings, hooks and CLAUDE.md
    "--strict-mcp-config", // no MCP servers
    "--no-session-persistence",
    "--system-prompt", opts.system,
    "--output-format", "json",
    "--json-schema", JSON.stringify(opts.schema),
  ];
  // Run from the temp dir so no project files get picked up.
  const proc = spawnSync("claude", args, {
    input: opts.prompt,
    cwd: tmpdir(),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 15 * 60 * 1000,
  });
  if (proc.error) throw proc.error;

  let res: any;
  try {
    res = JSON.parse(proc.stdout);
  } catch {
    throw new Error(`claude -p returned non-JSON (exit ${proc.status}): ${proc.stderr || proc.stdout}`);
  }
  if (res.is_error || !res.structured_output)
    throw new Error(`claude -p failed: ${res.result ?? JSON.stringify(res).slice(0, 500)}`);

  const out = { output: res.structured_output as T, costUsd: res.total_cost_usd ?? 0 };
  writeFileSync(cacheFile, JSON.stringify(out, null, 2));
  return { ...out, cached: false };
}
