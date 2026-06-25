# Type Safety

> Type safety patterns in this project.

---

## Overview

<!--
Document your project's type safety conventions here.

Questions to answer:
- What type system do you use?
- How are types organized?
- What validation library do you use?
- How do you handle type inference?
-->

(To be filled by the team)

---

## Type Organization

<!-- Where types are defined, shared types vs local types -->

(To be filled by the team)

---

## Validation

<!-- Runtime validation patterns (Zod, Yup, io-ts, etc.) -->

(To be filled by the team)

---

## Common Patterns

<!-- Type utilities, generics, type guards -->

(To be filled by the team)

---

## Forbidden Patterns

<!-- any, type assertions, etc. -->

<spec-entry category="quality" keywords="mobile-bridge,protocol-contract,rust-typescript,version-lockstep" date="2026-05-30" source="src/mobile/bridge/protocol.contract.test.ts:1">

## Scenario: Mobile Bridge Rust ↔ TypeScript Protocol Contract

### 1. Scope / Trigger
- Trigger: Any change to `src-tauri/src/bridge/protocol.rs`, `src/mobile/bridge/protocol.ts`, websocket bridge message parsing, or mobile bridge protocol versioning.

### 2. Signatures
- Rust version constant: `PROTOCOL_VERSION: u16`.
- TypeScript version constant: `BRIDGE_PROTOCOL_VERSION`.
- TypeScript kind manifests: `CLIENT_MESSAGE_KINDS`, `SERVER_MESSAGE_KINDS`.
- Contract test: `src/mobile/bridge/protocol.contract.test.ts`.

### 3. Contracts
- Rust and TypeScript protocol versions must be byte-equal.
- Every Rust `ClientMessage` variant must have a matching TypeScript client `kind`.
- Every Rust `ServerMessage` variant must have a matching TypeScript server `kind`.
- The contract test must read the Rust protocol source and compare the generated snake_case kind names to the TypeScript manifests.
- Do not add a new bridge message kind only on one side of the boundary.

### 4. Validation & Error Matrix
- Rust version changed without TypeScript version -> protocol contract test fails.
- New Rust enum variant without TypeScript kind -> protocol contract test fails.
- New TypeScript kind without Rust enum variant -> protocol contract test fails.
- Websocket runtime receives missing or mismatched `protocol_version` -> existing parser rejects with protocol version mismatch.

### 5. Good/Base/Bad Cases
- Good: add a Rust `ServerMessage` variant, add the matching TypeScript union member, update `SERVER_MESSAGE_KINDS`, then update tests.
- Base: no protocol shape change; `protocol.contract.test.ts` passes without updating manifests.
- Bad: change only `src/mobile/bridge/protocol.ts` and rely on manual review to notice Rust drift.

### 6. Tests Required
- `npm exec vitest run src/mobile/bridge/protocol.contract.test.ts src/mobile/bridge/wsClient.test.ts`.
- `cargo test --manifest-path src-tauri/Cargo.toml bridge::protocol`.
- Full frontend typecheck when manifests or message unions change.

### 7. Wrong vs Correct

Wrong:
```typescript
export type ServerCommand =
  | { kind: 'new_event'; payload: string };
```

Correct:
```typescript
export type ServerCommand =
  | { kind: 'new_event'; payload: string };

export const SERVER_MESSAGE_KINDS = [
  'new_event',
] as const satisfies readonly ServerCommand['kind'][];
```

Also add the matching Rust enum variant and keep the contract test passing.

</spec-entry>

<spec-entry category="contract" keywords="git-worktree,tauri-command,rust-typescript,project-sidebar,worktreePath" date="2026-06-25" source="src-tauri/src/git.rs:117">

## Scenario: Git Worktree List Tauri IPC Contract

### 1. Scope / Trigger
- Trigger: Any change to git worktree discovery, `git_worktree_list`, the
  `WorktreeInfo` Rust/TypeScript shape, or ProjectSidebar worktree terminal
  entries.
- Applies to `src-tauri/src/git.rs`, `src-tauri/src/lib.rs`,
  `src/lib/tauri-bridge.ts`, `src/components/terminal/useProjectWorktrees.ts`,
  and `src/components/terminal/ProjectSidebar.tsx`.

### 2. Signatures
- Rust command: `git_worktree_list(project_path: String) -> Result<Vec<WorktreeInfo>, String>`
- Rust struct serialized with `#[serde(rename_all = "camelCase")]`:
  `WorktreeInfo { path, head, branch, is_main, is_detached, is_bare, is_locked }`
- TypeScript bridge: `git.worktrees.list(projectPath: string): Promise<WorktreeInfo[]>`
- TypeScript type:
  `WorktreeInfo = { path: string; head: string; branch?: string | null; isMain: boolean; isDetached: boolean; isBare: boolean; isLocked: boolean }`

### 3. Contracts
- `project_path` must be an existing absolute directory before running git.
- The backend runs `git -C <project_path> worktree list --porcelain`.
- Non-git directories, missing `git`, and unsuccessful git exits return
  `Ok([])` so the sidebar can silently omit the worktree section.
- Porcelain parsing treats records as blank-line separated. Supported keys:
  `worktree <path>`, `HEAD <sha>`, `branch refs/heads/<name>`, `detached`,
  `bare`, and `locked [reason]`.
- The first parsed record is `isMain: true`; later records are linked
  worktrees.
- ProjectSidebar must keep cards grouped by the original `projectPath`. Opening
  a worktree terminal creates a shell card with `worktreePath = WorktreeInfo.path`
  and leaves `projectPath` unchanged.

### 4. Validation & Error Matrix
- Empty `project_path` -> backend returns an error.
- Relative `project_path` -> backend returns an error.
- Existing non-git directory -> backend returns `[]`.
- Missing git binary -> backend returns `[]`.
- Git command non-zero exit -> backend returns `[]`.
- Root worktree path equals project path -> ProjectSidebar hides that row.
- Linked worktree row clicked -> new card has `terminalType: 'shell'` and the
  selected `worktreePath`.

### 5. Good/Base/Bad Cases
- Good: a repo with `/repo/app` and `/repo/app-feature` renders only
  `/repo/app-feature` under the project and opens a terminal in that cwd.
- Base: a non-git project renders exactly like before, with no error toast.
- Bad: changing the Rust struct to snake_case without updating the TypeScript
  bridge; the UI will read `isMain`/`isDetached` as undefined.
- Bad: creating worktree cards with `projectPath = worktree.path`; this splits
  one repository into multiple project groups instead of preserving the project
  rollup.

### 6. Tests Required
- Rust unit tests for `parse_worktree_porcelain()` covering main, linked branch,
  detached, bare, and locked records.
- Hook tests for `useProjectWorktrees()` covering load/cache/refresh and
  non-Tauri no-op behavior.
- ProjectSidebar tests for hiding the root worktree and opening a shell card
  with the linked worktree path.
- Verification gates: `npm run typecheck`, targeted Vitest tests for sidebar /
  hook, `cargo test --manifest-path src-tauri/Cargo.toml git::`, and
  `cargo check --manifest-path src-tauri/Cargo.toml`.

### 7. Wrong vs Correct

Wrong:
```typescript
createCard({
  projectName,
  projectPath: worktree.path,
  terminalType: 'shell',
});
```

Correct:
```typescript
createCard({
  projectName,
  projectPath,
  worktreePath: worktree.path,
  terminalType: 'shell',
});
```

</spec-entry>

(To be filled by the team)
