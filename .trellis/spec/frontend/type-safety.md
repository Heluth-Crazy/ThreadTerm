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

(To be filled by the team)
