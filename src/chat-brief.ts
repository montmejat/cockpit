// The brief cockpit adds to Claude Code's own system prompt: how to work inside cockpit, and what
// the project's .cockpit/ says, so the agent knows the project without reading the folder.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { ARCH_DIR, loadArch } from "./arch.ts";
import { GUARDRAILS } from "./guardrails.ts";
import { COCKPIT } from "./turns.ts";

// What .cockpit/ says, in short: the summary, each feature (status, note, modules) and each
// diagram's tldr.
export function overview(root: string) {
  const { arch } = loadArch(root);
  if (!arch) return "";
  // The modules only while that stays small (about 2k tokens): a big project lists hundreds.
  const line = (f: (typeof arch.features)[number], mods: boolean) => `- ${f.name} [${f.id}, ${f.status}]${f.note ? ": " + f.note : ""}${mods && f.modules.length ? " · " + f.modules.join(", ") : ""}`;
  let feats = arch.features.map((f) => line(f, true));
  if (feats.join("\n").length > 8000) feats = arch.features.map((f) => line(f, false));
  const diags = arch.diagrams.map((d) => `- ${d.id}: ${d.tldr ?? d.question ?? ""}`);
  return `\n\nWhat it says now:\n${arch.summary}\n\nFeatures:\n${feats.join("\n")}` + (diags.length ? `\n\nDiagrams (${ARCH_DIR}/diagrams/<id>.json):\n${diags.join("\n")}` : "");
}

export function brief(root: string) {
  const has = existsSync(join(root, ARCH_DIR, "README.md"));
  return [
    "You are working inside cockpit. Its owner watches live diagrams of this code while you work, and reads your replies in a narrow chat panel: keep replies short, outcome first, details only if asked.",
    "Create and change files with the Write and Edit tools, not shell commands: cockpit follows those tools to show your changes as you make them.",
    "The owner also works in terminals inside cockpit (build, run, the project's CLI). When they mention a command, its output, an error, or say \"that\" about something they ran, read their terminals with the mcp__cockpit__terminals tool instead of asking them to paste it.",
    "The owner reviews merge requests in cockpit too. When they ask about the review, a comment, or what a reviewer said or meant, read the review and its discussions (every comment, with file, line and replies) with the mcp__cockpit__review_threads tool, then check what is said against the code.",
    `To list every module and item cockpit knows, written exactly as ${ARCH_DIR}/ links them, run: cd ${COCKPIT} && npm run -s modules -- ${root} [filter]`,
    `To check ${ARCH_DIR}/ against the code yourself, run: cd ${COCKPIT} && npm run -s check-arch -- ${root}`,
    has
      ? `The project is described in ${ARCH_DIR}/ (features and diagrams). Take it as up to date: don't re-check it against the code or read it unless the task needs it. When your own change makes something there wrong (a feature's status or description, a diagram's boxes or links), update just that, reading ${ARCH_DIR}/README.md first for its format. A check at the end of your turn catches broken links and modules in no feature; fix what it lists.` + overview(root)
      : `This project has no ${ARCH_DIR}/ yet. When the owner asks you to describe the project, or with your first change, create it: copy ${join(COCKPIT, "templates", "cockpit-README.md")} to ${ARCH_DIR}/README.md and follow it.`,
    existsSync(join(root, GUARDRAILS))
      ? `This project has guardrails: ${GUARDRAILS} (checks run when you finish a turn that edited files, and rules with why). Read ${join(COCKPIT, "templates", "guardrails.md")} once, before you change them or when the owner corrects how code is written.`
      : `Guardrails (checks and rules in ${GUARDRAILS}) are off in this project. Set them up only when the owner asks, following ${join(COCKPIT, "templates", "guardrails.md")}.`,
  ].join("\n\n");
}
