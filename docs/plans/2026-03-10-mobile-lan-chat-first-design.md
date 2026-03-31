# Mobile LAN Chat-First Design

**Date:** 2026-03-10

## Goal

Deliver a mobile-first LAN experience for OpenWork where users can quickly switch projects, switch sessions, and reply to messages from a phone browser or home-screen shortcut, while a desktop host machine keeps OpenWork and CLI services running.

## Scope

This design covers:

- mobile information architecture and navigation priorities
- mobile layout behavior for the existing workbench shell
- session/project switching flow in mobile chat scenarios
- LAN connectivity expectations and mobile error handling
- validation checklist for mobile usability

This design does not cover:

- native iOS application packaging
- external-network access architecture
- backend protocol changes
- full mobile parity for heavy IDE workflows (file tree, git, hybrid terminal)

## Product Direction

Primary scenario:

- phone and desktop are on the same LAN
- desktop runs OpenWork continuously
- phone is a lightweight remote control surface

Task priority on mobile:

1. switch project quickly
2. switch session quickly
3. read/reply in chat quickly

Terminal remains available but secondary.

## Approaches Considered

### 1) LAN Responsive Web Only

Pros:

- lowest implementation cost
- matches current architecture and deployment
- no app-store lifecycle

Cons:

- weaker app-entry feel on iOS home screen

### 2) LAN Responsive Web + PWA Entry (Recommended)

Pros:

- keeps Web architecture while improving mobile entry experience
- supports home-screen launch and app-like framing
- minimal operational overhead compared with native

Cons:

- still depends on browser and host uptime

### 3) Native iOS Wrapper / App

Pros:

- strongest native shell and distribution controls

Cons:

- high delivery/maintenance cost
- little benefit for chat-first LAN control use case
- introduces signing, packaging, and app lifecycle complexity too early

## Recommended Approach

Use approach #2:

- implement mobile-first responsive flow in current React app
- keep LAN browser access as the foundation
- optimize for optional "Add to Home Screen" usage as a PWA-style entry

## Information Architecture

Mobile first-level navigation should be task-centric:

- `Projects`
- `Sessions`
- `Chat`

Flow:

1. select project
2. select session
3. continue chat

Secondary capabilities (`terminal`, `files`, `git`, `settings`, `extensions`) move to secondary entry points and do not dominate the primary mobile path.

## UI and Interaction Design

Mobile shell behavior:

- single-column main surface (no persistent three-column workbench)
- bottom tab bar for `Projects / Sessions / Chat`
- top context strip in `Chat` for current project/session quick switching

Interaction targets:

- one-tap recent project and recent session access
- persistent chat input visibility during keyboard open
- fast resume to last active project/session on re-entry

Desktop behavior remains unchanged.

## Architecture and Data Flow

No backend API contract changes are required.

Frontend adaptations:

- add a viewport-aware shell branch at app-shell level
- reuse existing `projects`, `selectedProject`, `selectedSession`, and `activeTab` state from `useProjectsState`
- keep existing chat transport model (`WebSocketContext`) and message buffering

Persistence:

- persist last selected project/session for mobile resume
- clear persisted selection when resource no longer exists

## Connectivity and Error Handling

Expected network model:

- host machine reachable on LAN
- mobile device uses host IP/port

Error handling behavior:

- host unreachable: show LAN guidance with explicit "same network + host running" instruction
- websocket disconnected: show non-blocking reconnect state and auto-retry
- session missing/deleted: fallback to session list for selected project
- project missing/deleted: fallback to projects list and clear stale local state
- network switched off LAN: show connectivity loss state and recovery hint

## Validation Plan

Functional smoke:

- open on phone and reach project list
- switch project and see sessions update
- switch session and enter chat quickly
- send/receive chat messages after reconnect
- app resumes recent context after reopening

Device behavior smoke:

- iPhone narrow viewport portrait
- iPhone landscape
- keyboard open/close while composing
- home-screen launch path (PWA-style)
- safe-area top/bottom correctness

Regression smoke:

- desktop three-column workbench remains unchanged
- existing tabs still function in desktop workspace

## Risks

1. viewport/keyboard resize behavior can cause chat input jumps
2. mobile shell branching can accidentally regress desktop layout
3. stale selection persistence can produce dead-end screens

## Success Criteria

This design is successful when:

- users can reach chat from mobile in a few taps
- project/session switching is fast and reliable
- disconnected/invalid state recovery is obvious and safe
- desktop workflows remain stable
- native iOS packaging is not required to satisfy the target scenario
