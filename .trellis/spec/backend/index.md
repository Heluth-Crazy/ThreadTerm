# Backend (Rust / Tauri) Development Guidelines

> Best practices for the Rust/Tauri side of ThreadTerm (`src-tauri/`).

---

## Overview

This directory contains conventions for the Rust backend: Tauri command/IPC
contracts, the macOS overlay window plumbing, the PTY/supervisor subsystems,
and the bridge server.

---

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [macOS Overlay / NSPanel](./macos-overlay-nspanel.md) | objc2 rules for selector/float/pet panels; forbidden private-API KVC | Active |
| [Overlay Lightweight Mode](./overlay-lightweight-mode.md) | Cross-layer contract for disabling selector/float WebViews and global overlay shortcuts | Active |
| [Windows Build Resources](./windows-build-resources.md) | MSVC app/libtest manifest, icon/version resource, and fresh-target validation contract | Active |
| [Windows Background Processes](./windows-background-processes.md) | Hidden stdio services versus user-visible ConPTY process contracts | Active |
| [Stats OpenCode Usage Ingestion](./stats-opencode.md) | OpenCode SQLite token usage ingestion and `opencode` provider contracts | Active |
| [Stats Token Usage](./stats-token-usage.md) | Token usage aggregation payloads, parser-version rebuilds, and frontend stats contracts | Active |

---

## How to Fill These Guidelines

1. Document the project's **actual conventions** (not ideals).
2. Include **code examples** from `src-tauri/`.
3. List **forbidden patterns** and why (with the crash/commit that proved it).
4. Add **common mistakes**.

---

**Language**: All documentation should be written in **English**.
