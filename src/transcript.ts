// Reads a Claude Code session transcript (JSONL) and condenses it into a short
// list of numbered events. Each event keeps an id so summaries can link back to it.

import { readFileSync } from "node:fs";

export type EventKind = "user" | "say" | "tool" | "error";

export interface Event {
  id: string; // "e12"
  kind: EventKind;
  text: string; // condensed, for the model
  full: string; // longer version, shown in the page as evidence
}

// Limits keep the prompt small. Full text is kept separately for the page.
const MAX_TOOL_CHARS = 600;
const MAX_ERROR_CHARS = 300;
const MAX_FULL_CHARS = 4000;

function clip(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + ` …[+${s.length - n} chars]`;
}

function describeTool(name: string, input: any): string {
  switch (name) {
    case "Bash":
      return `$ ${input.command ?? ""}`;
    case "Write":
      return `WRITE ${input.file_path}\n${input.content ?? ""}`;
    case "Edit":
      return `EDIT ${input.file_path}\n- ${input.old_string ?? ""}\n+ ${input.new_string ?? ""}`;
    case "Read":
      return `READ ${input.file_path}`;
    default:
      return `${name} ${JSON.stringify(input)}`;
  }
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content.map((c: any) => (c.type === "text" ? c.text : "")).join("\n");
  return "";
}

// from/to: 0-based line range of the JSONL to read (one agent turn, say).
export function readTranscript(path: string, from = 0, to = Infinity): Event[] {
  const events: Event[] = [];
  const push = (kind: EventKind, full: string, short: number) => {
    const trimmed = full.trim();
    if (!trimmed) return;
    events.push({
      id: `e${events.length}`,
      kind,
      text: clip(trimmed, short),
      full: clip(trimmed, MAX_FULL_CHARS),
    });
  };

  for (const line of readFileSync(path, "utf8").split("\n").slice(from, to)) {
    if (!line.trim()) continue;
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const content = rec.message?.content;

    if (rec.type === "user") {
      // Plain prompts only; skip harness-injected messages like <command-name>.
      if (typeof content === "string") {
        if (!content.startsWith("<")) push("user", content, 2000);
        continue;
      }
      for (const block of content ?? []) {
        if (block.type === "text" && !block.text.startsWith("<")) push("user", block.text, 2000);
        // Only failed tool results carry decisions (e.g. "this version won't compile").
        if (block.type === "tool_result" && block.is_error)
          push("error", resultText(block.content), MAX_ERROR_CHARS);
      }
    } else if (rec.type === "assistant") {
      for (const block of content ?? []) {
        if (block.type === "text") push("say", block.text, 8000);
        if (block.type === "tool_use")
          push("tool", describeTool(block.name, block.input ?? {}), MAX_TOOL_CHARS);
      }
    }
  }
  return events;
}

export function eventsForPrompt(events: Event[]): string {
  return events.map((e) => `[${e.id} ${e.kind}] ${e.text}`).join("\n\n");
}
