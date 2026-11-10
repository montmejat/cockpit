// One structured answer from Claude through the local `claude -p` CLI, so it runs on the user's
// existing Claude Code login. No tools, no settings, no saved session: just the answer.

import { spawn } from "node:child_process";
import { tmpdir } from "node:os";

export interface CallResult<T> {
  output: T;
  costUsd: number;
}

export interface CallOptions {
  system: string;
  prompt: string;
  schema: object;
  model?: string; // default: haiku
}

export function callClaudeAsync<T>(opts: CallOptions): Promise<CallResult<T>> {
  const args = [
    "-p", "--model", opts.model ?? "haiku", "--tools", "", "--setting-sources", "", "--strict-mcp-config",
    "--no-session-persistence", "--system-prompt", opts.system, "--output-format", "json", "--json-schema", JSON.stringify(opts.schema),
  ];
  return new Promise((ok, fail) => {
    // From the temp dir, so no project files get picked up.
    const proc = spawn("claude", args, { cwd: tmpdir(), stdio: ["pipe", "pipe", "pipe"], timeout: 120_000 });
    let out = "", err = "";
    proc.stdout.on("data", (c) => (out += c));
    proc.stderr.on("data", (c) => (err += c));
    proc.on("error", fail);
    proc.on("close", (code) => {
      try {
        const res = JSON.parse(out);
        if (res.is_error || !res.structured_output) return fail(new Error(res.result ?? "no answer"));
        ok({ output: res.structured_output as T, costUsd: res.total_cost_usd ?? 0 });
      } catch { fail(new Error(`claude -p returned non-JSON (exit ${code}): ${(err || out).slice(0, 300)}`)); }
    });
    proc.stdin.end(opts.prompt);
  });
}
