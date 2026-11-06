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

## E2: project map

A map of a Rust project. The structure comes from tools, the names and groups
come from the agent, and your corrections override both.

```sh
npm run map -- ~/Projects/slipangle            # writes out/slipangle/map.html (read-only)
npm run map -- ~/Projects/slipangle --serve    # http://127.0.0.1:4173, editable
```

- **Skeleton** (`src/skeleton.ts`): `cargo metadata` gives crates and their
  dependencies. A SCIP index from `rust-analyzer scip` gives modules, items,
  doc comments, libraries used, and reference counts between modules. It is
  rebuilt whenever a source file is newer than the index.
- **Agent layer** (`src/overlay.ts`): one Haiku call groups modules into
  components and writes a one-line role for each module.
- **Your corrections**: move a module, rename a component, or rewrite a
  description or role from the page. They are saved to
  `data/<project>/overrides.json` (versioned) and always beat the agent's
  proposal, including on future runs. Corrections that point to deleted
  modules show up as warnings.
- **Page** (`src/maprender.ts`): two zoom levels (System, Modules) with the
  same positions at both. Components that use others are placed higher.
  Click anything for details down to items and line numbers.
