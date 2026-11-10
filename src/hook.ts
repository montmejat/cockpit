// Claude Code hook entry point: tsx src/hook.ts <start|tool|stop>
// For a Claude Code session running outside cockpit; cockpit's own chat records turns directly.
// Rules: be fast, print nothing (UserPromptSubmit output would reach the agent),
// and always exit 0 so a cockpit problem never blocks Claude Code.

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { turnStart, turnStop, turnTool } from "./recorder.ts";
import { STATE } from "./turns.ts";

function main() {
  const event = process.argv[2];
  const input = JSON.parse(readFileSync(0, "utf8") || "{}");
  if (event === "start") turnStart(input);
  else if (event === "tool") turnTool(input);
  else if (event === "stop") {
    const reason = turnStop(input);
    if (reason) process.stdout.write(JSON.stringify({ decision: "block", reason })); // the agent continues
  }
}

try {
  main();
} catch (e) {
  try {
    mkdirSync(STATE, { recursive: true });
    appendFileSync(join(STATE, "hook-errors.log"), `${new Date().toISOString()} ${process.argv[2]}: ${e}\n`);
  } catch {}
}
process.exit(0);
