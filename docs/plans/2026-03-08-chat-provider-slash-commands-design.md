# Chat Provider Slash Commands Design

**Date:** 2026-03-08

## Goal

Bring terminal-style `/` command discovery into the chat input so Claude Code and Codex sessions can expose their native slash-command vocabulary inside chat, while preserving the current chat send pipeline and forwarding the final command text unchanged to the underlying provider.

## User Requirement

The chat surface should not lose capability compared with the terminal surface. When the user types `/` in chat:

- they should get command suggestions and autocomplete
- the visible command list must follow the current provider (`claude` or `codex`)
- selecting a suggestion should insert the command into the chat input
- sending the message should forward the command text unchanged to Claude Code or Codex
- OpenWork must not introduce its own slash-command layer in this phase

## Scope

This design covers only provider-native slash commands inside chat:

- command catalog for Claude Code
- command catalog for Codex
- provider-aware filtering in the chat input
- slash-command autocomplete menu behavior
- raw passthrough of the chosen command text during send

This design does **not** cover:

- OpenWork-defined slash commands
- `.claude/commands` custom command execution
- command semantic interpretation on the OpenWork side
- command validation beyond lightweight autocomplete filtering
- parameter wizard UIs or argument forms

## Problem Statement

The current chat UI supports plain-text sending, file mentions, and provider switching, but it does not surface provider-native slash commands at the input layer. This causes a capability mismatch:

- terminal users can rely on provider-native slash commands
- chat users must remember commands manually or switch surfaces
- command discoverability differs across chat and terminal

The result is that chat feels like a reduced interface even when the user wants the same provider behavior.

## Design Principles

### 1. Provider-native only

The first version must strictly mirror provider-native slash commands. No OpenWork command namespace should be mixed into the menu, otherwise the feature boundary becomes unclear immediately.

### 2. Suggest, do not reinterpret

OpenWork should help the user discover and insert commands, but must not become the command executor. The exact text inserted into the input is what gets sent downstream.

### 3. Provider-aware and impossible to confuse

If the active provider is `claude`, the menu must only show Claude-native commands. If the active provider is `codex`, the menu must only show Codex-native commands. This avoids the failure mode where a user selects a command that looks available but is invalid for the current session.

### 4. Catalog-driven, not shell-parsed

The command vocabulary should live in explicit provider catalogs under source control. Parsing CLI help output at runtime is too brittle, too platform-dependent, and too slow for a reliable first implementation.

## Recommended Approach

Implement a catalog-driven slash-command layer with provider filtering and chat-input autocomplete.

This means:

- create a typed command catalog for `claude` and `codex`
- expose a shared filter function for matching user input after `/`
- reuse the existing `CommandMenu` presentation where practical, but adapt grouping and copy to provider-native commands
- on selection, insert the command text into the input and keep the caret positioned for the user to continue typing arguments
- on send, do nothing special beyond current chat behavior

This is the smallest approach that closes the chat-vs-terminal capability gap without adding a second command runtime.

## Architecture

### Command Catalog Layer

Create a provider-native slash-command catalog in a dedicated shared module, for example:

- `src/features/commands/providerSlashCommands.ts`

Each command entry should contain only the fields needed by autocomplete and insertion:

- `provider`: `claude` or `codex`
- `name`: slash command name without ambiguity
- `insertText`: exact command text inserted into the chat input, e.g. `/model`
- `description`: concise explanation for display
- `aliases`: optional array for search matching only
- `argumentHint`: optional suffix hint for UI display
- `group`: optional provider-local grouping if needed later

The catalog should be versioned in code so missing commands are easy to audit and update.

### Chat Input Detection Layer

Inside `ChatPanel`, detect whether the current caret position is within a slash-command token:

- only trigger on a token starting with `/`
- only consider the active token near the caret, not arbitrary earlier text
- ignore plain slashes embedded in paths or prose if they are not at token start

The detection output should include:

- whether slash mode is active
- the raw query after `/`
- token start/end positions

### Autocomplete Layer

When slash mode is active:

- filter the current provider catalog against the query
- open the command menu under the input
- support mouse selection and keyboard navigation
- keep the selected row visible while navigating
- close on `Escape`, blur, or when the token no longer qualifies

Selection behavior:

- replace only the active slash token, not the full input
- insert the command text exactly as defined in the catalog
- if appropriate, append a trailing space so the user can continue typing arguments immediately

### Send Behavior

The send path remains intentionally simple:

- chat input text is sent exactly as typed after insertion
- OpenWork does not parse the slash command before sending
- Claude Code or Codex remains the command interpreter

This preserves the user mental model: chat is now command-capable, but the provider still owns command semantics.

## UI Design

### Menu Content

The menu should communicate provider ownership clearly:

- header or empty-state copy should mention the active provider
- command rows should show command name plus a concise description
- optional argument hint may appear as muted inline text

### Grouping

Because this phase is provider-native only, the current `builtin/project/user/other` grouping from `CommandMenu` is misleading.

Recommended first step:

- render a single provider-native list
- optionally keep a lightweight “frequently used” group later if already supported cleanly

### Empty State

If the user types `/` and no command matches:

- show a non-empty menu state such as “No matching Claude commands” or “No matching Codex commands”
- do not silently close the menu

## Data Integrity and “No Missing Commands” Requirement

The highest-risk requirement is coverage completeness.

To support that requirement, the implementation should keep the provider command data:

- centralized in one place
- provider-separated
- typed and easy to diff
- reviewed against provider-native command references before shipping

The system cannot guarantee future completeness unless the catalogs are maintained, but it can make omissions visible and easy to patch.

For this phase, that is the correct engineering tradeoff.

## Error Handling

### Missing Catalog Entries

If the active provider has no catalog entries loaded:

- fail closed with an empty-state menu
- do not break normal chat input or sending

### Unknown Provider

If the provider state is neither `claude` nor `codex`:

- do not open slash-command suggestions
- preserve plain input behavior

### Selection Failures

If token replacement fails unexpectedly:

- leave the current input unchanged
- close the menu gracefully
- do not block sending normal messages

## Testing Strategy

### Static Validation

- `npm run typecheck`
- `npm run build`

### Browser Validation

For both Claude and Codex chat sessions:

- typing `/` opens the menu
- filtering narrows the current provider command list only
- selecting a command inserts exact command text into the input
- pressing `Enter` sends the inserted slash command unchanged
- slash suggestions do not appear for the wrong provider

### Regression Checks

- file mention `@` behavior still works
- normal text sending still works
- chat scroll and input focus behavior remain stable
- no conflict with existing suggestion popovers

## Risks

### 1. Command catalog incompleteness

This is the biggest product risk. The implementation must isolate catalogs so updates are straightforward.

### 2. UI conflicts with existing `@` file mention flow

The chat input already supports another suggestion mode. Slash suggestions and file mentions must remain mutually predictable.

### 3. Caret/token replacement edge cases

Slash detection must operate around the live caret, not only on full-input prefix matching.

## Success Criteria

This feature is successful if:

- typing `/` in chat exposes provider-native commands
- Claude chat shows only Claude-native commands
- Codex chat shows only Codex-native commands
- selecting a command inserts the exact command text
- sending forwards the exact text unchanged to the provider
- chat no longer feels weaker than terminal for provider-native slash commands
