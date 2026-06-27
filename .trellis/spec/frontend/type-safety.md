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

<spec-entry category="contract" keywords="git-branch,git-worktree,tauri-command,rust-typescript,project-sidebar,worktreePath" date="2026-06-26" source="src-tauri/src/git.rs:29">

## Scenario: Git Branch Worktree Tauri IPC Contract

### 1. Scope / Trigger
- Trigger: Any change to git branch discovery, worktree creation,
  `WorktreeInfo`/`BranchRow` Rust-TypeScript shape, or ProjectSidebar branch
  terminal entries.
- Applies to `src-tauri/src/git.rs`, `src-tauri/src/lib.rs`,
  `src/lib/tauri-bridge.ts`, `src/components/terminal/useProjectBranches.ts`,
  `src/components/terminal/useProjectWorktrees.ts`, and
  `src/components/terminal/ProjectSidebar.tsx`.

### 2. Signatures
- Rust commands:
  - `git_worktree_list(project_path: String) -> Result<Vec<WorktreeInfo>, String>`
  - `git_branch_overview(project_path: String) -> Result<Vec<BranchRow>, String>`
  - `git_worktree_add(project_path: String, branch: String, worktree_path: Option<String>) -> Result<WorktreeInfo, String>`
- Rust structs serialized with `#[serde(rename_all = "camelCase")]`:
  - `WorktreeInfo { path, head, branch, is_main, is_detached, is_bare, is_locked }`
  - `BranchRow { branch, head, is_current, worktree_path, is_main_worktree, last_commit_unix, upstream }`
- TypeScript bridge:
  - `git.branches.overview(projectPath: string): Promise<BranchRow[]>`
  - `git.worktrees.list(projectPath: string): Promise<WorktreeInfo[]>`
  - `git.worktrees.add(projectPath: string, branch: string, worktreePath?: string): Promise<WorktreeInfo>`

### 3. Contracts
- `project_path` must be an existing absolute directory before running git.
- Branch overview runs `git -C <project_path> for-each-ref --sort=-committerdate
  --format=%(refname:short)%00%(objectname)%00%(HEAD)%00%(committerdate:unix)%00%(upstream:short)
  refs/heads`, then joins branch rows to `git worktree list --porcelain` by
  exact local branch name.
- Non-git directories, missing `git`, and unsuccessful list/overview git exits
  return `Ok([])` so the sidebar can silently omit branch affordances.
- `git_worktree_add` defaults the target path to
  `<repo_root.parent>/<repo_basename>-worktrees/<branch with / and \ replaced by ->`
  unless `worktree_path` is supplied.
- Worktree creation must keep cards grouped by the original `projectPath`.
  Opening any branch worktree creates a shell card with
  `worktreePath = WorktreeInfo.path` and leaves `projectPath` unchanged.
- ProjectSidebar renders a collapsed branch tree per project. Existing
  `BranchRow.worktreePath` rows open a terminal; rows without a worktree create
  one first, clear branch/worktree caches, refresh branches, then open terminal.

### 4. Validation & Error Matrix
- Empty `project_path` -> backend returns an error.
- Relative `project_path` -> backend returns an error.
- Existing non-git directory -> branch/worktree overview returns `[]`.
- Missing git binary -> overview/list returns `[]`; create returns an error.
- `git worktree add` target already exists -> backend returns an error.
- Supplied or default target path escapes the sibling worktrees directory
  through `..` or an absolute path outside the base -> backend returns an error.
- Existing branch with `worktreePath` clicked -> new card has
  `terminalType: 'shell'` and the selected `worktreePath`.
- Branch without `worktreePath` clicked -> backend creates a worktree, caches
  are cleared, branches refresh, then the new card opens in the created path.

### 5. Good/Base/Bad Cases
- Good: a repo with `main` at `/repo/app` and `feature/x` at
  `/repo/app-worktrees/feature-x` renders both branches; clicking either opens a
  terminal in that branch's cwd.
- Good: a branch without a worktree creates
  `/repo/app-worktrees/<sanitized-branch>` and opens a shell terminal there.
- Base: a non-git project renders exactly like before, with no branch toggle and
  no error toast.
- Bad: changing Rust fields to snake_case without updating TypeScript; the UI
  will read `isCurrent`, `worktreePath`, or `isMainWorktree` as undefined.
- Bad: creating branch terminal cards with `projectPath = worktree.path`; this
  splits one repository into multiple project groups instead of preserving the
  project rollup.

### 6. Tests Required
- Rust unit tests for `parse_worktree_porcelain()`, branch ref parsing,
  branch-worktree merge ordering, branch sanitization, default target derivation,
  and escape-path rejection.
- Hook tests for `useProjectBranches()` covering load/cache/refresh and
  non-Tauri no-op behavior; keep `useProjectWorktrees()` cache tests intact.
- ProjectSidebar tests for no branch toggle on non-git projects, opening an
  existing branch worktree terminal, and creating a missing worktree before
  opening the terminal.
- Verification gates: `npm run typecheck`, targeted Vitest tests for sidebar /
  branch hook, `cargo test --manifest-path src-tauri/Cargo.toml git::`,
  `cargo check --manifest-path src-tauri/Cargo.toml`, and `npm run build`.

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

Wrong:
```rust
let target = repo_root.join("worktrees").join(branch);
```

Correct:
```rust
let base = worktree_base_dir(&repo_root)?;
let target = match worktree_path {
    Some(path) => checked_worktree_target(&base, Path::new(&path))?,
    None => default_worktree_path(&repo_root, &branch)?,
};
```

</spec-entry>

(To be filled by the team)
