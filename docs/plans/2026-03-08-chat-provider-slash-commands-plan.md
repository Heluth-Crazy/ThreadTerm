# Chat Provider Slash Commands Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add provider-native slash-command autocomplete to chat so Claude Code and Codex commands can be discovered and inserted in chat, then sent unchanged to the active provider.

**Architecture:** Introduce a provider-native slash-command catalog, then wire a provider-aware slash token detector into `ChatPanel` and reuse the existing command menu surface with provider-correct filtering and insertion behavior. Keep the send pipeline unchanged so the selected slash command text is forwarded exactly as chat input.

**Tech Stack:** React 18, TypeScript, JSX, Tailwind CSS, i18next, Vite

---

### Task 1: Create provider-native slash-command catalogs

**Files:**
- Create: `src/features/commands/providerSlashCommands.ts`
- Inspect: `shared/modelConstants.js`
- Inspect: provider docs or existing command references already represented in-repo

**Step 1: Define a typed catalog shape**

Create a small exported type for provider-native chat slash commands with fields for provider, name, insertText, description, aliases, and optional argumentHint.

**Step 2: Add Claude-native command entries**

Populate the Claude command catalog with only provider-native commands intended for passthrough.

**Step 3: Add Codex-native command entries**

Populate the Codex command catalog with only provider-native commands intended for passthrough.

**Step 4: Add provider filter helpers**

Export helpers such as:

- `getProviderSlashCommands(provider)`
- `filterProviderSlashCommands(provider, query)`

**Step 5: Run static validation**

Run: `npm run typecheck`
Expected: PASS

### Task 2: Add slash-token detection to chat input

**Files:**
- Modify: `src/components/chat/ChatPanel.tsx`

**Step 1: Inspect current input state handling**

Locate the chat textarea/input state, caret handling, file mention trigger logic, and current suggestion popovers.

**Step 2: Add slash token parsing near the caret**

Implement a helper that determines whether the current caret is inside a token that starts with `/`, and return the token bounds plus query text.

**Step 3: Keep slash mode independent from mention mode**

Ensure slash-command suggestion state and `@` mention state do not open simultaneously in conflicting ways.

**Step 4: Run static validation**

Run: `npm run typecheck`
Expected: PASS

### Task 3: Reuse or adapt the command menu for provider-native display

**Files:**
- Modify: `src/components/CommandMenu.jsx`
- Modify: `src/components/chat/ChatPanel.tsx`

**Step 1: Review current `CommandMenu` assumptions**

Identify the existing grouping labels and empty-state copy that currently imply built-in/project/user commands.

**Step 2: Make menu copy compatible with provider-native commands**

Update `CommandMenu` so it can render a provider-native list cleanly, including a useful empty state and optional provider-aware labels.

**Step 3: Open the menu from chat when slash mode is active**

Wire filtered provider commands into the menu and position it relative to the current chat input surface.

**Step 4: Support keyboard and mouse selection**

Ensure up/down selection, `Enter` or `Tab` insertion, `Escape` close, and mouse click selection all work.

**Step 5: Run static validation**

Run: `npm run typecheck`
Expected: PASS

### Task 4: Insert selected slash commands into chat input without changing send semantics

**Files:**
- Modify: `src/components/chat/ChatPanel.tsx`

**Step 1: Implement token replacement**

Replace only the active slash token with the chosen command’s `insertText`, preserving the rest of the message.

**Step 2: Preserve cursor usability**

After insertion, move the caret so the user can continue typing arguments naturally.

**Step 3: Keep send behavior unchanged**

Verify `sendChatMessage` continues sending the final input text exactly as entered after insertion, without local reinterpretation.

**Step 4: Run static validation**

Run: `npm run typecheck`
Expected: PASS

### Task 5: Add i18n and empty-state polish where needed

**Files:**
- Modify if needed: `src/i18n/locales/zh-CN/*.json`
- Modify if needed: `src/i18n/locales/en/*.json`
- Modify if needed: `src/i18n/locales/ja/*.json`
- Modify if needed: `src/i18n/locales/ko/*.json`

**Step 1: Add any new command-menu copy keys**

If provider-aware empty-state or label text is introduced, store it in i18n instead of hardcoding.

**Step 2: Keep copy neutral and provider-owned**

Do not imply OpenWork-specific slash commands in labels or descriptions.

**Step 3: Run static validation**

Run: `npm run typecheck`
Expected: PASS

### Task 6: Browser smoke for Claude and Codex chat command flows

**Files:**
- No code changes required unless issues are found

**Step 1: Start the dev server**

Run: `npm run dev`
Expected: frontend at `http://localhost:5174/`

**Step 2: Verify Claude chat slash commands**

Open a Claude chat session and confirm:

- typing `/` opens command suggestions
- filtering matches only Claude commands
- selection inserts exact command text
- sending forwards the inserted text normally

**Step 3: Verify Codex chat slash commands**

Open a Codex chat session and confirm the same flow, but with only Codex-native commands visible.

**Step 4: Verify no regression with `@` mentions**

Confirm file mention suggestions still work and do not conflict with slash suggestions.

**Step 5: Stop the dev server**

Terminate the dev server cleanly.

### Task 7: Final verification and scope review

**Files:**
- Review all files touched in Tasks 1-5

**Step 1: Run full validation**

Run: `npm run typecheck && npm run build`
Expected: PASS

**Step 2: Review final diff for scope discipline**

Run: `git diff -- src/components/chat/ChatPanel.tsx src/components/CommandMenu.jsx src/features/commands/providerSlashCommands.ts`
Expected: only provider-native slash-command catalog and chat autocomplete changes

**Step 3: Summarize the shipped boundary**

Explicitly note that this release:

- supports provider-native slash discovery in chat
- is provider-aware
- forwards commands unchanged
- does not add OpenWork slash commands
