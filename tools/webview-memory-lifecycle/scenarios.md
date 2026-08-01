# Fixed Business Scenarios — WebView Memory Lifecycle

Use the **same machine**, **same Release build**, **same user-data copy**, and
**same settle times** before/after every optimization batch.

Privacy: record counts and memory only. Do not paste transcripts, paths under
home directories, tokens, or message text into reports.

## Common setup

1. Build Release for the platform under test.
2. Launch ThreadTerm Release (not `cargo run` / not Vite-only).
3. Confirm the app is ready (main window interactive).
4. For each sample, run the platform sampler and capture
   `window.__threadtermLifecycleDiagnostics()`.
5. After disruptive operations, wait the listed settle window before sampling.

## S0 — Cold start

1. Fully quit ThreadTerm (no residual process for the app).
2. Launch Release.
3. Do not open selector/float/settings.
4. Wait **5 / 30 / 120 s** and sample each.

Expect: only the main WebView (Windows prewarm default is off). Record process
roles and app diagnostics.

## S1 — Hot card set (37 cards)

1. Restore or create a project with **37 terminal cards** (or the closest fixed
   fixture available on the machine).
2. Do not focus more than needed to hydrate the grid.
3. Sample at 5 / 30 / 120 s idle.

Record: card count, active PTY count, mounted terminal surfaces, xterm/WebGL
counts.

## S2 — Sequential focus of 6 terminals

1. From the hot set, open/focus **6 different terminal cards** one by one.
2. Leave each visible long enough for xterm/WebGL to mount.
3. End on the 6th card.
4. Sample peak after the 6th focus, then 5 / 30 / 120 s.

Record: mounted surfaces (pre-opt may be up to 6), warm/cold (post-opt), PTY
still running for background cards.

## S3 — Dual window same PTY

1. Focus a terminal in the main window.
2. Open float for the **same** card so both surfaces show one PTY.
3. Sample while both are visible.
4. Close float; sample at 5 / 30 / 120 s after close.

Must prove main+float visible surfaces are both protected (post-opt).

## S4 — Terminal switch thrash (20 rounds)

One round =

1. Cycle focus across the same 6 terminals.
2. Open then close selector (if hotkey available).
3. Open then close float once.
4. Switch two workspace editor tabs (if available).
5. Toggle a long Claude/Codex chat card once if present.

Repeat **20 rounds**. After each round sample once at **T+0**. After rounds
1, 10, and 20 also sample **T+120 s**.

Success metric (final gate): 120 s stable memory after round 20 ≤ 110% of
round-1 120 s stable; no linear climb across rounds.

## S5 — Selector / float / settings lifecycle

1. Cold-ish state (main only).
2. Open selector via hotkey; sample; close; sample at 5 / 30 / 120 s.
3. Open float; sample; close; sample at 5 / 30 / 120 s (float idle destroy is
   60 s — include a sample after 70 s).
4. Open settings; sample; close; sample at 5 / 30 / 120 s.

## S6 — Multi editor + long chat

1. Open several clean workspace files across cards.
2. Ensure at least one dirty tab exists (do not close it).
3. Load a long Claude and/or Codex conversation (≥1000 items when available).
4. Hide the chat card (focus elsewhere) and confirm notifications still fire.
5. Sample 5 / 30 / 120 s.

## Diagnostics fields every sample should include

From process sampler:

- `appGroupPrivateMb` / `webviewPrivateMb` / per-role private MB
- process counts (renderer/GPU/utility/browser)
- main process private MB

From `window.__threadtermLifecycleDiagnostics()`:

- card totals, active PTY / runtime counts
- terminal surfaces: visible / warm / cold / mounted ids
- xterm instance count, WebGL instance count
- headless preview count
- selector / float / settings lifecycle state (if known)
- CodeMirror / editor instance estimates
- Claude/Codex mounted item counts and pending requests

## Pass / fail for Batch 0

Batch 0 only establishes the pipeline and pre-optimization baselines.
It **must not** change product behavior. Completion means:

- scripts and templates land in-repo
- at least one full Windows Release S0–S4 sample set is saved under
  `docs/artifacts/webview-memory-lifecycle/` (or a documented blocker if the
  operator cannot run Release on this machine)
- macOS steps are written so a macOS operator can produce the same fields
