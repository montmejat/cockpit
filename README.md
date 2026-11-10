# cockpit

A control center for software written with AI agents. The agents keep a description of the
project in its repo (`.cockpit/`: features and a few diagrams of how the code works); cockpit
shows it live, with what is changing right now projected onto it, next to the files, git,
terminals and the agent chat. You lead at whatever depth you choose and can always go one level
deeper: diagram → detail diagram → the code of one box.

## Run it

```sh
npm install
npm run build                               # the page (web/ → web/dist)
npm run serve -- ~/Projects/slipangle       # http://127.0.0.1:4173
npm run serve -- ~/Projects/slipangle --host 0.0.0.0   # reachable from your network, no login
```

Desktop app (Linux), a Tauri 2 window around the same server:

```sh
desktop/install.sh            # once: needs webkit2gtk4.1-devel libsoup3-devel gtk3-devel librsvg2-devel
cockpit ~/Projects/slipangle  # or open "cockpit" from the app menu (reopens the last project)
cockpit --pick                # choose another project ("Open project…" on the launcher icon)
```

It starts the server on a free port, shows the page, and stops the server when the window
closes. Everything is bundled, so it works offline. The plan is to move the server to Rust piece
by piece, and the UI later once it stops changing.

Working on the page: `npm run dev:web` rebuilds it on every change; reload to see it (Ctrl+R or
F5 in the desktop app).

## Where cockpit keeps things

Nothing about the projects you open is kept in this checkout:

- settings and your corrections: `~/.config/cockpit/projects/<project>/` (`index.json`);
- what cockpit generates (code index, turns, chats) under
  `~/.local/share/cockpit/projects/<project>/` (`$COCKPIT_STATE` moves it), turn snapshots in
  `~/.local/share/cockpit/snapshots/` (a git store of cockpit's own: no objects, refs or
  worktrees in the project's `.git`), model-call cache in `~/.local/share/cockpit/.cache/`.

`data/<project>/` and `out/<project>/` in the checkout are still used for projects that already
have them.

## What's on the page

- **Map** (first tab): the agents' diagrams. Hover a box for what it is, click it for details,
  double-click (or scroll in) to go into its detail diagram or its code; Esc, scrolling out or the
  breadcrumb comes back up. ☰ by the breadcrumb lists every diagram as a small tree (by which
  box zooms into which); click one to go there. Drag boxes to arrange them; the arrangement is saved in
  `.cockpit/layout.json`. Boxes whose code changed (not committed) are dashed amber; boxes the
  agent is editing glow.
- **Files**: open a file and its uncommitted changes show in place, like an editor: a green bar
  by added lines, blue by changed ones, a red mark where lines were removed (click it to see
  them, or tick "show removed"). ↑ ↓ jump between changes. A small diagram floats over the code
  and lights up the boxes whose code is on screen.
- **Git**: branch, what isn't committed, and the history of all branches as a graph; a commit
  opens as its patch.
- **Header**: lines, tests and features at a glance; each opens what's behind it on the right.
- **Terminals** (Ctrl+`): real shells in the project. The agent can read them. Ctrl+K asks for a
  command in words and puts it on the prompt, never runs it.
- **Chat**: an agent cockpit runs itself (below).

Links: `?file=path&line=n`, `?commit=sha`, `?tab=git`, `?panel=features|tests`, `?at=diagram&box=node`.

## Agent chat

Cockpit runs Claude Code through the Claude Agent SDK, on your Claude Code login (no API key),
with your user and project settings. Auto mode decides what it may do; when it wants you, an
Allow/Deny card shows in the chat. Model picker (haiku/sonnet/opus) and a stop button.

- **Conversations** are Claude Code sessions: the title at the top lists this project's sessions,
  including ones started in a terminal, and reopens any of them. "new" starts another; the old one
  stays in the list. Cockpit keeps its own view of each in `chats/` in the project's state dir.
- **Meters** under the message box: how full this conversation's context is, and how much of your
  plan's 5-hour and weekly limits you've used (the numbers behind `/usage`; it reads them through
  an experimental SDK call, and hides them if that stops working).
- While the agent works, turns are recorded (`turns/` in the project's state dir) so its files light up live.
- When it stops, the `.cockpit/` check runs against the live code index; if the description no
  longer matches the code, the agent is sent back to fix it (up to 3 times), with the likely
  right link for each wrong one. On a project without `.cockpit/`, "Describe this project" starts
  it from `templates/cockpit-README.md`.

A Claude Code session outside cockpit can be recorded too, with hooks in the project's
`.claude/settings.local.json` that call `src/hook.ts start|tool|stop`.

## The project's description (`.cockpit/`)

Written and kept true by the agents, never by hand (the brief they follow is
`.cockpit/README.md`, copied from `templates/cockpit-README.md`):

- `project.json`: a summary and the features, each with a status (working, partial, broken,
  planned), the modules it lives in, and a note on what's missing.
- `diagrams/<id>.json`: as many diagrams as the project needs, each answering one question where a
  picture beats two sentences. Kinds: loop, pipeline, dataflow, zones. Every box links to code
  ("crate/module" or "crate/module::Type::fn"; for C/C++ "project/path/File.cpp::Type::fn"), and
  has a short tldr.
- `layout.json`: where you placed the boxes (written by cockpit).

`npm run check-arch -- <project dir>` checks it against the code by hand (no model call).
`npm run modules -- <project dir> [filter]` lists every module and item exactly as links must
write them; the agent's brief tells it to use it before writing links. Test code needs no feature.

## C and C++ projects

A repo with a `CMakeLists.txt` at the top or in a top-level folder (and no `Cargo.toml`) is read
as C/C++ (`src/indexer.ts`, `src/skeleton-cpp.ts`), into the same skeleton shape as Rust, so the
map, chat, turns and checks work unchanged:

- **Index**: [scip-clang](https://github.com/sourcegraph/scip-clang/releases) (put the binary in
  `~/.local/bin`) over the project's `compile_commands.json` files, found as
  `<dir>/build[/<variant>]/compile_commands.json` and merged into one; cross-compile ones (arm,
  aarch64) lose to host ones. CMake writes them with `-DCMAKE_EXPORT_COMPILE_COMMANDS=ON`. The
  server indexes in the background (minutes on a large repo); the page fills in when it's done.
- **Groups** are the top-level folders with a `CMakeLists.txt` (the "crates"); **modules** are
  files (`engine/World.hpp`, `engine/World.cpp`, without `src/` or `include/`); **edges** are
  "uses something defined in" plus `#include`s. Installed copies of project headers
  (`build/.../include/...`) count as the source file they were copied from. Libraries are named
  after their outermost namespace (`Eigen`, `boost`, `nlohmann`); `std` is left out.
- **Build containers**: when the compile commands point at paths that only exist in an image (a
  devcontainer), say so in `~/.config/cockpit/projects/<project>/index.json`; scip-clang then runs
  in that image, with the repo mounted read-only at the same path:

  ```json
  { "image": "my-build-image:latest",
    "compdb": ["engine/build/compile_commands.json"] }
  ```

  Both keys are optional (`COCKPIT_CXX_IMAGE` also sets the image). Without `compdb`, every
  compile database found is used.
- Turn snapshots reuse the repo's compile databases, with source paths moved to the snapshot;
  files added in a turn are only indexed once the build has seen them.
- Tests: `*_test.cpp`, `test_*.cpp`, `*Test.cpp` or anything under `test/`, with their
  GoogleTest / Catch2 / Boost.Test cases, else their `test_*()` functions (plain `main()` tests),
  else the file as one test.

## How it works

- `src/serve.ts`: the server. It watches the project's folders and git, works out the page's state
  (diagrams, features, tests, git, what changed down to the function), and pushes only the parts
  that changed over server-sent events.
- `src/codeindex.ts`: the SCIP index of the working copy (rust-analyzer, or scip-clang through
  `src/indexer.ts`), read into crates, modules and items (`src/skeleton.ts`,
  `src/skeleton-cpp.ts`); rebuilt in the background when a source file changes.
- `src/arch.ts`: reads and checks `.cockpit/`.
- `src/chat.ts`, `src/term.ts`, `src/ask.ts`: the agent, the terminals, the ask line.
- `web/`: the page, in Svelte 5 + TypeScript, built with Vite. Diagrams are drawn with Cytoscape
  and updated in place, never torn down, so the view doesn't jump while things change.

## History

Earlier experiments (decision recaps, a generated module map, layered turn reviews, a generated
description, a feature board) shaped this and were removed once the one view replaced them; they
are in the git history before November 10, 2026.
