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
npm run map -- ~/Projects/slipangle --serve --host 0.0.0.0   # reachable from your network, no login
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

## E4: agent turns, reviewed by layer

Use Claude Code as usual in a project; cockpit records each request ("turn")
and shows what changed at every layer.

```sh
npm run serve -- ~/Projects/slipangle                   # http://127.0.0.1:4173: turns at /, map at /map
npm run serve -- ~/Projects/slipangle --host 0.0.0.0    # reachable from your network, no login
```

Setup: hooks in the project's `.claude/settings.local.json` (not committed)
call `src/hook.ts`:

- **UserPromptSubmit** (`start`): snapshots the working copy and opens a turn.
- **PostToolUse** on file edits (`tool`): records the file, for the live view.
- **Stop** (`stop`): snapshots again and starts `src/analyze.ts` in the background.

Snapshots (`src/snapshot.ts`) are commits built with a temporary index,
kept under `refs/cockpit/snap/*`. They include untracked files and never touch
your branch, index or files. Delete them anytime with
`git for-each-ref --format='%(refname)' refs/cockpit | xargs -n1 git update-ref -d`.

Each turn is shown in four layers:

| Layer | Shows | From |
|---|---|---|
| Purpose | your request, a short summary, decisions made | one Haiku call on the turn's transcript |
| System | components touched, dependencies that appeared/disappeared | code index before vs after, map components |
| Module | per module: functions, types, methods added / removed / changed | SCIP definition ranges vs diff lines |
| Code | the diff | git, rendered with diff2html |

The code index of each snapshot is built in a temporary worktree (sharing
`target/`), so it never races with the agent, and cached by tree hash.
Turns live in `out/<project>/turns/`.
