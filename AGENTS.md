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

