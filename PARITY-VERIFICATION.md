# Prototype parity verification — September 10, 2026

The production renderer uses the approved prototype's layout and styles. Comparison is of application content at the same CSS viewport, theme and QA state. The prototype's wallpaper, clock, mock titlebar and desktop margins are excluded. Native Electron chrome remains functional in production; no mock desktop or fixed demonstration-window cap is embedded.

## Evidence

- `qa/results/parity-review.html`: local side-by-side review gallery, 17 screens × 3 viewports × 2 themes = 102 distinct pairs.
- `qa/results/parity/2026-09-10T15-13-58-304Z/`: 96-pair main matrix, covering project, terminals, inbox, workbench, workspace, files, diff, session creation, five settings sections, usage, follow and worktree dialogs.
- `qa/results/parity/2026-09-10T15-42-48-023Z/`: 30-pair refresh after catalog, presets, worktree and device changes. Worktree dialog bounds and radius now match the reference.
- `qa/results/parity/2026-09-10T15-49-43-736Z/`: six-pair tools refresh after correcting header styling.
- `qa/results/parity-actions/2026-09-10T14-40-54-606Z/report.json`: account/palette keyboard flows, theme/control settings, real browser settings download, invalid import and cancellation.
- `qa/results/parity-workspace-actions/2026-09-10T15-17-08-048Z/report.json`: split/save/exit; dirty Cancel/Discard/Save; Markdown and HTML preview; diff line/hunk revert, undo and save.
- `qa/results/parity-catalog-actions/2026-09-10T15-42-49-204Z/report.json`: six catalog flows including keyboard focus, rename, active-session rejection, archive/parent restore and catalog-only deletion.
- `qa/results/parity-catalog-actions/2026-09-10T15-48-01-357Z/report.json`: edited project file retained; archive rejected before any visibility mutation. The earlier failure in this added test was a missing click on Browse files in the test driver, corrected before this pass.
- `qa/results/preset-restore-ui-final/2026-09-10T16-16-03-087Z/report.json`: scope/layout pruning, checked-command review, ended/imported history without claim/create/resume/input, and Chat history plus live rapid-navigation draft saving and live-to-ended text retention all pass.
- `qa/results/legacy-root-results/parity-runtime-smoke-2026-09-10T15-49-19-140Z/report.json`: packaged Electron, actual Git worktree creation through the UI, exact real PTY echo output, canonical catalog archive/restore and local data status. Unique temporary data/profile/pipe; no provider prompt.
- `qa/results/parity-runtime-smoke-2026-09-10T16-22-17-928Z/report.json`: latest renderer packaged with the real runtime; eight checks including loaded production CSS (1,535 rules, grid shell, 240px sidebar), real worktree UI, PTY input/output, archive/restore and data status.
- `qa/results/active-parity-preview.json`: visible user preview, exact main executable/process, CSS asset and real project; screenshot captured directly from this window. This resolves the user's report that the running preview differed from the debugging build.
- `qa/results/installed-smoke.json` (16:49 UTC): final safe installer, actual plain-directory sidebar navigation and PTY input/output, bundled SDK host without external Node, isolated uninstall and retained external SQLite data.
- `qa/results/installer-isolation/report.json`: unrelated preview processes, V2 registration and restored V2 shortcuts preserved; `legacy-guard.json` proves rejection of an unsafe inherited uninstaller. `css-build-identity.json` records matching debug/preview/package stylesheet hashes.

The visual harness is deliberately QA-only and never loads production main/preload or a real runtime. These reports demonstrate interface behavior with deterministic fixtures, not backend success. The packaged-runtime report and installed QA are separate evidence for actual desktop/runtime operations.

## Implemented contracts

- Project/worktree/session catalog menus retain stable IDs, preserve files and native provider history, and provide parent restoration menus. Active sessions and edited files block archive/delete in their scope.
- Session archive uses one organization revision across sidebar and terminal list APIs. Generic restore updates archive/removal state atomically with one outbox event and preserves pinned/bookmark/intent/order fields.
- Presets restore existing view IDs and selected scopes. Deselected sessions and their file/diff views are removed from the restored layout. No implicit provider creation, resume, or command execution occurs. Command review checkboxes retain independent identities even for duplicate command text.
- Dirty confirmation completes before preset route/layout changes. Ended and imported histories are viewable, with input control restricted to live sessions.
- Real worktree creation keeps the reference's two-field dialog and supports an existing branch or a new branch, with an automatically suggested editable directory.
- Ordinary non-Git directories show their real sessions directly in the sidebar without synthetic worktree records; archived worktree filtering cannot trigger this fallback. The installed test exposed and verified this fix.
- Settings use the reference navigation and surfaces; local tools, data relocation, device pairing/rename/renew/revoke and directory actions use typed production operations.

## Validation and limits

Runtime: 95 tests; Cargo formatting and Clippy with warnings denied. Protocol: 6 tests. Desktop output fanout: 2 tests. Preset/catalog/input helper tests: 6 tests, including historical-view eligibility, missing/removed rejection and scope pruning. Control lease/draft writer tests: 3. Desktop and renderer typechecks and production/release builds passed; final package verification is recorded with delivery.

The sole common automated token difference is the transparent prototype wrapper versus the painted production shell; child surfaces carry the same theme tokens. All-terminals grid height also varies with actual output/history text. Screenshot review supplements measurements; no aggregate pixel-percentage claim is made.

Usage/history content in the visual fixture is intentionally empty where it cannot be derived from real data. Production does not ship the prototype's fabricated usage totals, sparklines, pairing devices or connection simulations. Recorded usage is shown when available; unknown values remain unknown. Demo-only instructions are replaced with truthful production behavior.

Commercialization and AI Markdown download remain excluded. Phone and extension interfaces remain deferred. Existing provider setup limits remain: Claude SDK authentication absent, Gemini CLI absent, successful OpenCode paid turn unverified after HTTP 401. Hosted account and automatic-update services remain unconfigured. This pass sends no additional paid provider prompts.

The first NSIS attempt exposed a stock name-based process-termination fallback: it interrupted the earlier preview and a parallel test. The previous preview was reopened with its original runtime/data, and the fresh visible preview was verified from the new package. The installer now uses a directory-scoped read-only process check and rejects unsafe inherited uninstallers. The separate safe installer passed actual installation, upgrade and uninstall verification. Existing V2 shortcuts overwritten by the test installer were backed up and restored to the installed V2 executable; subsequent V3 install/uninstall preserved them. Work remains uncommitted as requested; task archival/auto-commit is not performed.
