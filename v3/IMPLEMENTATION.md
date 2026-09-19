# Implementation order and quality gates
1. Isolated worktree/reference manifest/contracts/task. Build real shell + independent runtime + real PTY and reconnect first.
2. All five structured Chat adapters, capability/auth probes, native history and resume.
3. Projects/worktrees, cards/history rail/inbox/follow/recent/presets/search.
4. CodeMirror files/drafts/Git/preview and persistent pane workspaces/native floats.
5. Settings/themes/i18n/shortcuts/data/devices/MCP/usage.
6. Cross-layer fault/ownership/recovery/security and UI visual validation.
7. Windows packaging and real installed application verification; document remaining environment gates honestly.

Main owns protocol and integration plus task artifacts. Initial parallel ownership: runtime foundation excludes provider implementation file; desktop/build excludes renderer/protocol/runtime; renderer owns renderer; provider worker/native adapter owns runtime/src/providers.rs and providers directory only. No commits until user requests; no changes in original checkout.
