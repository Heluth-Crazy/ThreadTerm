# Provider compatibility policy

The rules shared by the daily provider monitor, the issue maintenance automation and anyone fixing a provider
compatibility problem.

**Purpose.** Keep ThreadTerm working with new provider releases through small, reversible adapter changes. An
upstream release is never a reason to refactor, redesign or add features.

## Support window

| Provider | Adapter | Floor (oldest supported) | Target (newest verified) | Pinned dependency |
|---|---|---|---|---|
| Codex | `runtime/src/providers/codex.rs` | 0.161.0 | 0.166.0 | — |
| Claude Code | `runtime/src/providers/claude.rs`, `providers/claude-sdk/src` | 2.1.287 | 2.1.318 | `@anthropic-ai/claude-agent-sdk` 0.3.266 |
| OpenCode | `runtime/src/providers/opencode.rs` | 1.18.35 | 2.3.0 | — |
| Kimi (ACP) | `runtime/src/providers/acp.rs`, `runtime/src/providers/kimi_plan_usage.rs` | 2.0.2 | 2.0.2 | — |
| Gemini (ACP plugin) | `runtime/src/providers/acp.rs`, `runtime/plugins/gemini/` | not set | not verified | — |
| Grok | `runtime/src/providers/grok.rs` | 1.0.67 | 1.0.75 | — |
| Pi | `runtime/src/providers/pi.rs` | 1.1.0 | 1.5.2 | — |

The floors are the versions installed on the maintainer's machine on 2026-11-04. The targets were verified that day
against isolated installs (Chat smoke and live probes).
- OpenCode 2.2.5 (2026-11-09): v2 moved its server API, so the adapter speaks both dialects behind the same Chat
  contract. Live on 2.2.5: startup/attach, chat, model reporting, permission allow and reject (a rejected tool never
  runs, the turn settles, the Chat stays connected and the next prompt works), questions, subagents, terminals, fork
  and history. The 1.18.35 floor keeps its own regression tests; no floor behavior changed.
- Kimi 2.5.0 and Pi 1.5.0 could not be verified, because their copied sign-ins were rejected.

**Which binary each feature runs.**
- Claude Chat runs the CLI bundled with the pinned Agent SDK (`claude_chat_cli_path` in `claude.rs`).
- The installed `claude` CLI is used only for terminal sessions and for the version and sign-in check.
- So a Claude Code release reaches Chat only when the SDK pin is bumped.
- Every other provider runs its installed CLI for both Chat and terminals.

- Only the owner raises a floor.
- A fix may move "Target" forward, and only after it has run against that version.

## Ledger and issues

- **The ledger.** The monitor keeps one row per upstream change in `agent-change-log/compat-ledger.md` in the
  maintainer's checkout (`D:/project/ThreadTerm/ThreadTerm-v3`). That folder is not in git. Each row has a stable ID of
  the form `<provider>-<yyyymmdd>-<n>`.
- **Issues.** The monitor opens one GitHub issue per class C item, and per class B item in a stable release.
  - The issue is labelled `provider-compat` and opened by the owner's account.
  - Its title starts with `[compat <ID>]`.
- **The fixer** is the issue maintenance automation.
  - It works these issues under the rules below.
  - When it finishes an item, it updates that row in the ledger.

## Classes

Only stable releases and changes merged on the default branch count. A prerelease is at most class B; check it again
when it ships as stable.

**Evidence for class B: two quotes.**
- Quote the upstream line that changed: a diff line, schema or declaration line, or release-note sentence.
- Quote the ThreadTerm line, with its file and line number, that reads, matches on or sends that exact thing.
- If you cannot quote both, it is class A.

**These are class A, not B:**
- New values flowing through a field the adapter treats generically, for example new model IDs in a model list.
- Optional fields or events the adapter does not read.
- Upstream bug fixes inside the provider that keep its documented interface, unless ThreadTerm has code that works
  around the old behaviour. Quote that code.
- Code paths the adapter never exercises: another platform, a launcher or a subcommand it doesn't use.
- Changes in a pinned dependency's releases newer than the pin, and Claude Code CLI changes that only affect Chat.
  Mark them `relevant at next bump`. They are reviewed together when a bump is proposed.

| Class | Meaning | Action |
|---|---|---|
| A, no impact | ThreadTerm does not use the changed interface. | Ledger row only. |
| B, risk | The adapter reads or sends the exact thing that changed, and its shape or meaning changed. Examples: a field or parameter removed, renamed or retyped; a new required parameter; a new value in an enum the adapter matches on; an error code or message the adapter matches on; a changed order or count of events the adapter relies on; a CLI flag the adapter passes, removed or renamed. No evidence of a break yet. | Add a recorded fixture and a test that pins the current behaviour against the new shape. Change product code only if that test fails. |
| C, break | A fixture, a probe or a deterministic source comparison shows ThreadTerm misbehaving with a released version. | Smallest fix in the adapter, following the rules below. |
| D, opportunity | A new capability ThreadTerm could use. | Ledger row only; the owner decides. The compatibility flow never implements a D. |

## Rules for a B or C change

1. **One upstream change per branch and pull request.** Put the ledger ID in the title and the body.
2. **Fixture first.**
   - Record the new frames as JSONL under `runtime/tests/fixtures/` (loaded with `conformance::fixture`).
   - Write a test that fails for a C, or pins the behaviour for a B, before touching the adapter.
   - Never edit or delete the old fixtures: they are the floor's regression tests.
3. **Scope.**
   - Allowed: the provider's adapter, its tests and its fixtures. That is `runtime/src/providers/<provider>.rs` or
     `providers/claude-sdk/src`, plus their tests. Also allowed: the provider's row in the support window above.
   - Not allowed: shared code, another provider, or anything under `protocol/`, `renderer/` or `desktop/`. A change
     that needs any of these is not a compatibility fix; stop and escalate.
4. **Accept both shapes.**
   - Accept the old and the new shape side by side, and keep the floor working in the same change.
   - Unknown events and fields are ignored with a debug log, never treated as errors.
5. **Detect behaviour, not version numbers.**
   - Follow the pattern in `CodexApiSupport` (`codex.rs`): call the method, record `provider_method_unsupported`,
     fall back, and show one notice.
   - Use version strings only in messages to the user.
6. **Size.**
   - At most about 150 changed lines of product code; tests and fixtures don't count.
   - No renames, no reformatting, no "while I'm here" clean-ups.
7. **Pinned dependency bumps** (the Claude Agent SDK) go in their own pull request.
   - Bump only when a C needs it or a floor change requires it.
   - Bump only to a stable release that is at least 7 days old.
   - Review the `sdk.d.ts` diff between the two versions in that pull request.
8. **Never upgrade a CLI installed on the machine.**
   - Install the version under test into a scratch folder, for example `npm install --prefix <scratch> <package>@<version>`.
   - Point a debug runtime at it with `THREADTERM_QA_PROVIDER_BIN=<absolute folder holding the executable>`.
   - Run it with a scratch home or config folder that holds only a copy of the sign-in file it needs, as
     `qa/codex-compat-live.mjs` does with `CODEX_HOME`. Then a newer CLI cannot migrate the maintainer's real data.
     Delete the copy afterwards.
   - This includes a bare `--version` run: a new CLI can write logs or migrate data whenever it starts.
   - If the CLI's data cannot be isolated, don't run it, and say so.
9. **Verify.**
   - Run the module tests (`cargo test --lib providers::<provider> -- --test-threads=1`) and
     `npm run check:fast -- --working-tree`.
   - Run the provider's fixture probe (for example `qa/codex-compat-fixture.mjs`).
   - Run the live probe against the scratch install of the new version and against the floor version.
   - Run the full `npm run check` once before merging. All Rust build limits in `CLAUDE.md` apply.
10. **Close the loop.**
    - Update the ledger row with the pull request, the versions verified and the new state.
    - Move "Target" forward in the table above.

## Stop and escalate

Label the issue `maint:needs-decision`, write down why, and do not implement it, when:
- the fix needs changes outside the adapter;
- the fix drops support for the floor;
- the fix exceeds the size budget;
- the upstream change is really a new capability (a D);
- the cause cannot be pinpointed at level 2 of "widen the scope" in `CLAUDE.md`.
