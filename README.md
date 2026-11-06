# cockpit

Experiments in how a human and AI agents work on software together. The human
leads at whatever depth they choose (purpose, system, module, code) and can
always go one level deeper.

## E1: decision recap

Turns a Claude Code session transcript into a recap you read top-down:
overview, then themes, then groups, then individual decisions, then the
transcript events behind each one.

```sh
npm install
npm run recap -- ~/.claude/projects/<project>/<session>.jsonl --title "..."
# writes out/<session>/recap.html (+ events/decisions/recap .json)
```

How it works:

1. `src/transcript.ts` condenses the JSONL into numbered events (prompts,
   agent messages, tool calls, failed tool results).
2. `src/recap.ts` makes two model calls: **extract** (events to decisions, in
   Y-statement form, each citing event ids) and **merge** (decisions to themes
   and groups). Code then checks that every decision appears exactly once.
3. `src/render.ts` writes one self-contained HTML page with a depth control and
   flag buttons (wrong / missing detail / useful) for judging the recap.

Model calls go through `claude -p` (your Claude Code login), use Haiku by
default, and are cached in `out/.cache/`, so a rerun with the same input is
free.

Levels follow the C4 model: purpose = context, system = containers,
module = components, code = code.
