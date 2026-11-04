<!-- TRELLIS:START -->
# Trellis Instructions

These instructions are for AI assistants working in this project.

This project is managed by Trellis. The working knowledge you need lives under `.trellis/`:

- `.trellis/workflow.md` — development phases, when to create tasks, skill routing
- `.trellis/spec/` — package- and layer-scoped coding guidelines (read before writing code in a given layer)
- `.trellis/workspace/` — per-developer journals and session traces
- `.trellis/tasks/` — active and archived tasks (PRDs, research, jsonl context)

If a Trellis command is available on your platform (e.g. `/trellis:finish-work`, `/trellis:continue`), prefer it over manual steps. Not every platform exposes every command.

If you're using Codex or another agent-capable tool, additional project-scoped helpers may live in:
- `.agents/skills/` — reusable Trellis skills
- `.codex/agents/` — optional custom subagents

Managed by Trellis. Edits outside this block are preserved; edits inside may be overwritten by a future `trellis update`.

<!-- TRELLIS:END -->

<!-- codegraph:start -->
# CodeGraph — Code Intelligence

GitNexus is retired. This project is indexed by **CodeGraph** (`.codegraph/`, local and gitignored; a daemon keeps
the index in sync with file changes). In PowerShell/cmd run `codegraph <command>`; from Git Bash on Windows run
`cmd //c "codegraph.cmd <command> ..."`.

## Always Do

- **Run impact before editing.** `codegraph impact <symbol> -d 2` (add `codegraph callers <symbol>` when needed) for
  every function, method, component or type you change. Record callers, affected files and risk in the active task's
  artifacts (`.trellis/tasks/<task>/`) before making the change.
- **Trace flows with the graph first.** `codegraph explore "<concept>"`, `codegraph node <symbol>`,
  `codegraph callees <symbol>`. Fall back to text search for literals and for links the graph cannot resolve:
  string-dispatched protocol methods (`request('git.discard', …)` ↔ the Rust `match` arm), TS ↔ Rust boundaries,
  plain-object property access.
- **An empty caller set means unknown, not unused.** Confirm with a text search before treating a symbol as safe to
  change or delete.
- **Before committing,** run `codegraph affected <changed files>` and run the tests it lists, plus
  `npm run check:fast -- --working-tree`.
- Index looks stale → `codegraph sync`; check with `codegraph status`.

## Never Do

- Never edit a symbol before running impact on it.
- Never rename with blind find-and-replace; trace callers first.
<!-- codegraph:end -->

## Before committing

Before committing: `npm run check:fast -- --working-tree`; before packaging or after runtime changes: `npm run check`.

Exception for stacked feature branches that are not merged yet:
- **Each commit:** run the Rust tests of the modules you changed (`cargo test --lib <module>`).
- **Once, before merging into `main`:** run the full `npm run check`, including all Rust tests, on the top of the
  stack. It sets its own `-j 2 --test-threads=2`.

## Rust builds (this PC is short on memory)

- Build settings:
  - set `CARGO_BUILD_JOBS=1` and `CARGO_PROFILE_DEV_DEBUG=line-tables-only` in the environment;
  - run tests single-threaded with `-- --test-threads=1`, not by exporting `RUST_TEST_THREADS`. Test helpers that
    start the test binary inherit that variable, and on `main` it breaks some bootstrap, provider and PTY tests;
  - run one build or test command at a time;
  - start a Rust build or an Electron probe only with at least 8 GB of free memory, otherwise wait.
- Batch the Rust work:
  - write all of a task's runtime code and its tests first;
  - then run `cargo test --lib <module>` once per changed module;
  - build the runtime once with `cargo build --bin threadterm-v3-runtime` and copy it to `runtime/target-qa/debug/`
    for the probes;
  - the TypeScript work after that needs no Rust compile.
- Compile again only when a fix touches Rust code. Work without runtime changes compiles no Rust.

## When a problem cannot be pinpointed, widen the scope

A problem is **pinpointed** when you can name its cause, a focused test or trace reproduces it, and the fix makes
that reproduction pass. An intermittent failure is not pinpointed.

Until then, do not retry at the same scope or guess a fix. Move to the next level, and record the level you reached
in the task's validation notes.

| Level | Investigation | Tests |
|---|---|---|
| 1 | The changed function and the failing test. | That one test. |
| 2 | Its callers and callees: `codegraph impact <symbol> -d 2`, `codegraph callees <symbol>`. | The module's tests: `cargo test --lib <module>` and the component's test files. |
| 3 | The flow across layers: `codegraph explore`, the TS ↔ Rust boundary and string-dispatched methods. Compare with `main`. | The tests `codegraph affected` lists, `npm run check:fast -- --working-tree` and the related Electron probes. Run the same check on `main` to rule out a failure that already exists there. |
| 4 | The whole product. | The full `cargo test --lib`, `npm run check` and the probes that pass on `main`. |

Widening the scope comes before the build batching above: compile again whenever the next level needs it.

