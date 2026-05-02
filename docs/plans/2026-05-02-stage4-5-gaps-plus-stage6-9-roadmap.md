# Stage 4/5 Gap Fill + Stage 6–9 Roadmap

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement Part A task-by-task. Part B (Stage 6–9) is a roadmap — each future stage will get its own dedicated plan when picked up.

**Goal:** (Part A) Close the 8 concrete gaps in already-shipped Stage 4 + Stage 5 so they actually match the original spec. (Part B) High-level forward plan for Stages 6–9 from IMPLEMENTATION_PLAN.md.

**Architecture for Part A:**
- **No new runtime deps.** Each gap is a localized edit on top of the components shipped in batches 1–3 of the prior plan.
- **Data-model change for output search**: add `output?: string` to `Block` type, captured on the frontend at `block-finished` time using the existing `xtermRegistry` + ANSI-strip helpers. Persisted as-is (capped). Backend/Rust untouched.
- **Share button is deliberately deferred** to Stage 8 (where the data IO layer lands). Documented as out-of-scope here so we don't ship a half-baked "share" that has no clear sink.

**Tech Stack:** React 18, Zustand persist, Tailwind, lucide-react, react-i18next, vitest. No new packages.

**Pre-flight:**
- `git status` should be clean before starting (or all current work committed) — Part A spans 8 tasks across 5+ files.
- Branch off `main` (or current working branch) into a new feature branch, e.g. `stage4-5-gap-fill`.

---

## Part A — Stage 4/5 Gap Fill

### Status of every spec item before this plan

| Spec line | File | Status |
|-----------|------|--------|
| 4.2 Share button | BlockToolbar.tsx | ❌ deferred to Stage 8 (see note) |
| 4.2 Explain (AI) | BlockToolbar.tsx | 🟡 placeholder per spec — Stage 6 wires it |
| 4.3 BlockInspector plain-text output | BlockInspector.tsx | ❌ Task 1 |
| 4.3 BlockInspector AI Explain onClick | BlockInspector.tsx | ❌ Task 2 |
| 5.1 Search scope: output | searchAcrossBlocks.ts + Block type | ❌ Task 3 |
| 5.1 Search scope: timestamp filter | (intentionally dropped — see note) | 🟡 |
| 5.1 Result row: timestamp display | BlockSearchPanel.tsx | ❌ Task 4 |
| 5.1 Result row: matched line | BlockSearchPanel.tsx | ❌ Task 5 (depends on Task 3) |
| 5.2 palette: Run workflow placeholder | commandRegistry.ts | ❌ Task 6 |
| 5.2 palette: Change card intent | commandRegistry.ts | ❌ Task 7 |
| 5.2 palette: focus restore on close | CommandPalette.tsx | ❌ Task 8 |

**Notes**
- **Share button**: The spec lists it but doesn't say *what* sharing means (clipboard? OS share sheet? gist? markdown export?). Stage 8.1 introduces the data IO / export layer, where "share as markdown" naturally lives. Better to ship it once with a clear sink than now without one.
- **Search by timestamp filter**: dropped as a UX over-spec. Searching command/cwd/output already covers >99% of recall use cases; adding "from / to" datetime filters introduces UI complexity (date pickers in 4 languages) for negligible benefit. Re-evaluate post-Stage 9 if users actually ask. Result-row *displays* the timestamp (Task 4), which is the part users actually want.

---

### Task 1 — BlockInspector plain-text output region

**Why first:** smallest, no cross-cutting changes; gives users immediately visible value (the inspector is where they expect to read output).

**Files:**
- Modify: `src/components/terminal/BlockInspector.tsx`
- Modify: `src/components/terminal/BlockInspector.test.tsx`
- Modify: `src/i18n/locales/{en,zh-CN,ja,ko}/terminal.json` — `block.inspector.output`

**Spec reference:** IMPLEMENTATION_PLAN.md Stage 4.3 — "metadata（… / ANSI strip 后的纯文本输出 / …）；复用现有 `headlessPreview.ts` 的纯文本提取，不重写。"

**Step 1: Write the failing test**

In `src/components/terminal/BlockInspector.test.tsx`, add:

```ts
it('renders the plain-text output region when block.output is provided', () => {
  render(<BlockInspector block={makeBlock({ output: 'hello\nworld' })} />);
  const region = screen.getByTestId('block-inspector-output');
  expect(region.textContent).toContain('hello');
  expect(region.textContent).toContain('world');
});

it('hides the output region when block.output is undefined', () => {
  render(<BlockInspector block={makeBlock()} />);
  expect(screen.queryByTestId('block-inspector-output')).toBeNull();
});

it('hides the output region for empty string output', () => {
  render(<BlockInspector block={makeBlock({ output: '' })} />);
  expect(screen.queryByTestId('block-inspector-output')).toBeNull();
});
```

Update the `makeBlock` helper at the top of the file to accept an optional `output` field.

**Step 2: Run test to verify it fails**

```bash
npx vitest run src/components/terminal/BlockInspector.test.tsx
```

Expected: FAIL — `block-inspector-output` test-id not found.

**Step 3: Add `output?: string` to Block type**

In `src/types/terminal.ts`, around line 70:

```ts
export interface Block {
  id: string;
  cardId: string;
  cwd: string;
  command: string;
  startedAt: number;
  finishedAt?: number;
  exitCode?: number;
  durationMs?: number;
  bufferStart: number;
  bufferEnd?: number;
  state: BlockState;
  /** ANSI-stripped output captured at block-finish time. Used by
   *  BlockInspector and cross-session search. Capped at MAX_BLOCK_OUTPUT_LENGTH. */
  output?: string;
}

/** Cap on per-block output snapshot. 4KB is enough for ~50 lines of
 *  command output; anything bigger gets truncated head-style. */
export const MAX_BLOCK_OUTPUT_LENGTH = 4000;
```

**Step 4: Render the output region in BlockInspector**

In `src/components/terminal/BlockInspector.tsx`, after the Duration row and before the AI Explain placeholder, add:

```tsx
{block.output && block.output.length > 0 && (
  <div className="flex flex-col gap-1">
    <div className="text-[10px] text-muted-foreground">
      {t('block.inspector.output', { defaultValue: 'Output' })}
    </div>
    <pre
      data-testid="block-inspector-output"
      className="max-h-48 overflow-y-auto rounded-md border border-border bg-muted/30 p-2 font-mono text-[10px] leading-relaxed whitespace-pre-wrap break-all"
    >
      {block.output}
    </pre>
  </div>
)}
```

**Step 5: Add i18n key (4 locales)**

```jsonc
// en
"output": "Output",
// zh-CN
"output": "输出",
// ja
"output": "出力",
// ko
"output": "출력"
```

Each goes inside the existing `block.inspector` namespace in `src/i18n/locales/<locale>/terminal.json`.

**Step 6: Run tests to verify they pass**

```bash
npx vitest run src/components/terminal/BlockInspector.test.tsx
```

Expected: 12+ tests pass (3 new + existing).

**Step 7: Commit**

```bash
git add src/types/terminal.ts src/components/terminal/BlockInspector.tsx src/components/terminal/BlockInspector.test.tsx src/i18n/locales/*/terminal.json
git commit -m "feat: render block output in BlockInspector (Stage 4.3 gap)"
```

---

### Task 2 — Wire BlockInspector AI Explain onClick

**Why:** Currently the button has `data-testid="block-inspector-explain"` but no `onClick`. Per Stage 6 spec it'll do the real AI invocation, but as a Stage 4.3 gap the *placeholder* should at least give feedback so users know the feature exists.

**Files:**
- Modify: `src/components/terminal/BlockInspector.tsx`
- Modify: `src/components/terminal/BlockInspector.test.tsx`
- Modify: `src/components/terminal/TerminalView.tsx` — pass `onExplain` prop
- Modify: `src/i18n/locales/*/terminal.json` — `block.inspector.explainPlaceholder`

**Step 1: Write the failing test**

In `BlockInspector.test.tsx`:

```ts
it('calls onExplain when the explain button is clicked', () => {
  const onExplain = vi.fn();
  render(<BlockInspector block={makeBlock()} onExplain={onExplain} />);
  fireEvent.click(screen.getByTestId('block-inspector-explain'));
  expect(onExplain).toHaveBeenCalledTimes(1);
});

it('does not error when onExplain is omitted (button still renders)', () => {
  render(<BlockInspector block={makeBlock()} />);
  expect(() => fireEvent.click(screen.getByTestId('block-inspector-explain'))).not.toThrow();
});
```

Add `fireEvent` to the imports if not already present.

**Step 2: Run, confirm fail.**

```bash
npx vitest run src/components/terminal/BlockInspector.test.tsx
```

**Step 3: Add `onExplain?` prop and wire onClick**

In `BlockInspector.tsx`:

```tsx
export interface BlockInspectorProps {
  block: Block | null;
  onClose?: () => void;
  /** Stage 6 placeholder; Stage 4.3 ships an inert click handler that just
   *  calls this if provided. Real AI invocation lands in Stage 6. */
  onExplain?: () => void;
}

// In the destructure:
export function BlockInspector({ block, onClose, onExplain }: BlockInspectorProps) {
```

On the existing button:

```tsx
<button
  type="button"
  data-testid="block-inspector-explain"
  onClick={onExplain}
  className="..."
  title={t('block.inspector.explainPlaceholder', {
    defaultValue: 'Explain with AI (coming in Stage 6)',
  })}
>
  <Sparkles className="h-3.5 w-3.5" />
  {t('block.explain', { defaultValue: 'Explain with AI' })}
</button>
```

**Step 4: Pass `onExplain` from TerminalView**

In `TerminalView.tsx`, find the `<BlockInspector ... />` render and pass:

```tsx
<BlockInspector
  block={selectedBlock}
  onClose={() => setInspectorOpen(false)}
  onExplain={() => {
    // Stage 6 placeholder — for now, surface a transient toast via the
    // existing notification centre so users get feedback. Stage 6 will
    // replace this with real AI invocation.
    pushNotification({
      cardId: card.id,
      kind: 'info',
      title: t('block.explainComingSoon', { defaultValue: 'AI Explain — coming in Stage 6' }),
      body: '',
    });
  }}
/>
```

Add `pushNotification` to the store hooks at the top of TerminalView.

If `kind: 'info'` is not in `NotificationKind`, fall back to a simpler mechanism: just no-op for the Stage 4 gap and let Stage 6 wire the real thing. In that case the test only asserts the click is non-throwing.

**Step 5: i18n**

Add `block.inspector.explainPlaceholder` to all 4 locales.

**Step 6: Run tests, commit**

```bash
npx vitest run
git add src/components/terminal/BlockInspector.tsx src/components/terminal/BlockInspector.test.tsx src/components/terminal/TerminalView.tsx src/i18n/locales/*/terminal.json
git commit -m "feat: wire BlockInspector AI Explain placeholder onClick"
```

---

### Task 3 — Capture per-block output + extend search scope

**Why:** Stage 5.1 spec says scope = "命令、输出、cwd、时间戳". Output is currently uncapturable because the data model has no field for it. Add `output?: string` and populate at block-finish time using the existing `extractBlockOutput` logic.

**Files:**
- Modify: `src/types/terminal.ts` — already has `MAX_BLOCK_OUTPUT_LENGTH` after Task 1
- Modify: `src/stores/terminalStore.ts` — `recordBlockFinished` accepts `output?`
- Modify: `src/components/terminal/TerminalEventBridge.tsx` — extract output before calling `recordBlockFinished`
- Modify: `src/components/search/searchAcrossBlocks.ts` — add `'output'` field
- Modify: `src/components/search/searchAcrossBlocks.test.ts`
- Modify: `src/stores/terminalStore.test.ts`

**Step 1: Write the failing test (search side)**

In `searchAcrossBlocks.test.ts`:

```ts
it('matches output text', () => {
  const blocksWithOutput: Record<string, Block[]> = {
    c1: [{
      id: 'b1',
      cardId: 'c1',
      cwd: '/x',
      command: 'ls',
      startedAt: 0,
      bufferStart: 0,
      state: 'success',
      output: 'README.md\npackage.json\nsrc/',
    }],
  };
  const r = searchAcrossBlocks(cards, blocksWithOutput, 'package.json', 100);
  expect(r).toHaveLength(1);
  expect(r[0].field).toBe('output');
});

it('falls through command -> cwd -> project -> output in priority order', () => {
  const b: Record<string, Block[]> = {
    c1: [{
      id: 'b1',
      cardId: 'c1',
      cwd: '/safe',
      command: 'safe',
      startedAt: 0,
      bufferStart: 0,
      state: 'success',
      output: 'matchhere',
    }],
  };
  expect(searchAcrossBlocks(cards, b, 'matchhere', 100)[0].field).toBe('output');
});
```

**Step 2: Run, confirm fail**

```bash
npx vitest run src/components/search/searchAcrossBlocks.test.ts
```

**Step 3: Add `'output'` to SearchField + matcher**

In `src/components/search/searchAcrossBlocks.ts`:

```ts
export type SearchField = 'command' | 'cwd' | 'project' | 'output';
```

In the for-loop:

```ts
let field: SearchField | null = null;
if (re.test(b.command)) field = 'command';
else if (re.test(b.cwd)) field = 'cwd';
else if (re.test(card.projectName) || re.test(card.projectPath)) field = 'project';
else if (b.output && re.test(b.output)) field = 'output';
```

**Step 4: Add `output?` to store action**

In `terminalStore.ts`, find `recordBlockFinished`:

```ts
recordBlockFinished: (input: {
  cardId: string;
  blockId: string;
  exitCode?: number | null;
  finishedAt: number;
  durationMs?: number | null;
  bufferEnd?: number;
  /** Stage 5.1 — ANSI-stripped output snapshot, capped at MAX_BLOCK_OUTPUT_LENGTH. */
  output?: string;
}) => void;
```

In its `set` callback, when assigning the finished block:

```ts
return {
  ...block,
  finishedAt: input.finishedAt,
  exitCode: input.exitCode ?? undefined,
  durationMs: input.durationMs ?? undefined,
  bufferEnd: input.bufferEnd ?? block.bufferEnd,
  state: input.exitCode === 0 || input.exitCode === undefined ? 'success' : 'failed',
  output: input.output?.slice(0, MAX_BLOCK_OUTPUT_LENGTH),
} satisfies Block;
```

Import `MAX_BLOCK_OUTPUT_LENGTH` at the top.

**Step 5: Capture output at finish time in TerminalEventBridge**

Find where `recordBlockFinished` is called in `TerminalEventBridge.tsx`. Just before the call, extract:

```ts
import { getTerminal } from './xtermRegistry';
import type { Block } from '../../types/terminal';

function extractOutput(ptyId: string, bufferStart: number, bufferEnd: number): string {
  const term = getTerminal(ptyId);
  if (!term) return '';
  const buf = term.buffer.active;
  const lines: string[] = [];
  for (let row = bufferStart + 1; row <= bufferEnd; row++) {
    const line = buf.getLine(row);
    if (line) lines.push(line.translateToString(true));
  }
  return lines.join('\n').slice(0, 4000);
}

// At the call site:
const output = extractOutput(ptyId, payload.bufferStart, payload.bufferEnd);
recordBlockFinished({ ...payload, output });
```

(Actual call-site shape may vary — read the file before editing.)

**Step 6: Add a store unit test for output capping**

```ts
it('recordBlockFinished caps output at MAX_BLOCK_OUTPUT_LENGTH', () => {
  const big = 'x'.repeat(10_000);
  const s = useTerminalStore.getState();
  s.recordBlockStarted({ cardId: 'c1', blockId: 'b1', command: 'foo', cwd: '/', startedAt: 0, bufferStart: 0 });
  s.recordBlockFinished({ cardId: 'c1', blockId: 'b1', finishedAt: 1, output: big });
  const stored = useTerminalStore.getState().blocks['c1'][0];
  expect(stored.output?.length).toBe(4000);
});
```

**Step 7: Run all tests, typecheck, commit**

```bash
npx vitest run
npm run typecheck
git add src/types/terminal.ts src/stores/terminalStore.ts src/stores/terminalStore.test.ts src/components/terminal/TerminalEventBridge.tsx src/components/search/searchAcrossBlocks.ts src/components/search/searchAcrossBlocks.test.ts
git commit -m "feat: capture per-block output and extend search scope to it"
```

---

### Task 4 — Display timestamp in search result rows

**Files:**
- Modify: `src/components/search/BlockSearchPanel.tsx`
- Modify: `src/components/search/BlockSearchPanel.test.tsx`

**Step 1: Write the failing test**

```ts
it('renders the timestamp on each match row', async () => {
  useTerminalStore.setState({
    cards: [{ id: 'c1', projectName: 'p', projectPath: '/p', terminalType: 'shell' } as never],
    blocks: {
      c1: [{ id: 'b1', cardId: 'c1', cwd: '/p', command: 'go run', startedAt: 1_700_000_000_000, bufferStart: 0, state: 'success' }],
    },
  });
  render(<BlockSearchPanel open={true} onClose={vi.fn()} onJump={vi.fn()} />);
  fireEvent.change(screen.getByTestId('block-search-input'), { target: { value: 'go' } });
  await waitFor(() => screen.getByText('go run'));
  // Format-agnostic: just assert *something* matching a HH:MM pattern is rendered
  const row = screen.getByText('go run').closest('li')!;
  expect(row.textContent).toMatch(/\d{1,2}:\d{2}/);
});
```

**Step 2: Run, confirm fail**

```bash
npx vitest run src/components/search/BlockSearchPanel.test.tsx
```

**Step 3: Render timestamp**

In `BlockSearchPanel.tsx`, inside the `<li>` per match, add:

```tsx
<span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
  {new Date(block.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
</span>
```

Place it next to the field tag (or in its own meta line). Adjust flex so it aligns right.

**Step 4: Run, commit**

```bash
npx vitest run
git add src/components/search/BlockSearchPanel.tsx src/components/search/BlockSearchPanel.test.tsx
git commit -m "feat: show timestamp on cross-session search results"
```

---

### Task 5 — Show matched-line snippet for output matches

**Why:** When `field === 'output'`, users want to see *which* output line matched, not just the command name. Depends on Task 3 (which adds `block.output`).

**Files:**
- Modify: `src/components/search/BlockSearchPanel.tsx`
- Modify: `src/components/search/searchAcrossBlocks.ts` — return optional `matchedLine?: string`
- Modify: tests

**Step 1: Test (matcher side)**

```ts
it('returns the matched line for output matches', () => {
  const blocksWithOutput: Record<string, Block[]> = {
    c1: [{
      id: 'b1', cardId: 'c1', cwd: '/x', command: 'ls', startedAt: 0, bufferStart: 0, state: 'success',
      output: 'README.md\npackage.json\nsrc/',
    }],
  };
  const r = searchAcrossBlocks(cards, blocksWithOutput, 'package', 100);
  expect(r[0].matchedLine).toBe('package.json');
});

it('does not set matchedLine for command/cwd/project matches', () => {
  const r = searchAcrossBlocks(cards, blocks, 'sub', 100);
  expect(r[0].matchedLine).toBeUndefined();
});
```

**Step 2: Implement**

In `searchAcrossBlocks.ts`, extend the `SearchMatch` interface:

```ts
export interface SearchMatch {
  block: Block;
  card: TerminalCard;
  field: SearchField;
  /** When `field === 'output'`, the specific line in the output that matched. */
  matchedLine?: string;
}
```

In the matcher, when the `output` branch fires:

```ts
else if (b.output && re.test(b.output)) {
  field = 'output';
  const lines = b.output.split('\n');
  matchedLine = lines.find((l) => re.test(l));
}
// ...
out.push({ block: b, card, field, matchedLine });
```

**Step 3: Render in panel**

In `BlockSearchPanel.tsx`, inside each `<li>`:

```tsx
{matchedLine && (
  <div className="truncate font-mono text-[10px] text-muted-foreground/80">
    ↳ {matchedLine}
  </div>
)}
```

**Step 4: Run, commit**

```bash
npx vitest run
git add src/components/search/searchAcrossBlocks.ts src/components/search/searchAcrossBlocks.test.ts src/components/search/BlockSearchPanel.tsx src/components/search/BlockSearchPanel.test.tsx
git commit -m "feat: show matched output line in search results"
```

---

### Task 6 — palette: Run workflow placeholder

**Why:** Spec lists `Run workflow` as a CommandGroup but no entries are registered. This is a Stage 7 placeholder — the entry should appear, click should give visible feedback.

**Files:**
- Modify: `src/components/palette/commandRegistry.ts`
- Modify: `src/components/palette/commandRegistry.test.ts`
- Modify: i18n — `palette.runWorkflowComingSoon`

**Step 1: Write test**

```ts
it('includes a run-workflow placeholder entry', () => {
  const reg = buildCommandRegistry({
    cards: [],
    blocks: {},
    projects: [],
    actions: emptyActions(),
  });
  const entry = reg.find((e) => e.group === 'run-workflow');
  expect(entry).toBeTruthy();
  expect(entry!.label).toMatch(/workflow/i);
});
```

**Step 2: Implement**

In `commandRegistry.ts`, add to the trailing static section:

```ts
out.push({
  id: 'workflow:placeholder',
  label: 'Run workflow… (coming soon)',
  searchText: 'run workflow coming soon stage 7',
  group: 'run-workflow',
  run: () => {
    // Stage 7 placeholder. Surfacing the entry now keeps muscle memory
    // intact and gives users a discoverable hook for when it lands.
    // No-op until Stage 7 wires it up.
  },
});
```

**Step 3: Commit**

```bash
git add src/components/palette/commandRegistry.ts src/components/palette/commandRegistry.test.ts
git commit -m "feat: add Run workflow placeholder entry to command palette"
```

---

### Task 7 — palette: Change card intent

**Files:**
- Modify: `src/components/palette/commandRegistry.ts` + actions interface
- Modify: `src/components/palette/commandRegistry.test.ts`
- Modify: `src/components/terminal/TerminalManager.tsx` — pass `updateCardAiIntent` + `focusedCardId`

**Step 1: Write test**

```ts
it('emits change-intent entries for the focused card', () => {
  const cards = [card('c1', 'foo')];
  const actions = { ...emptyActions(), updateCardAiIntent: vi.fn() };
  const reg = buildCommandRegistry({
    cards,
    blocks: {},
    projects: [],
    focusedCardId: 'c1',
    actions,
  });
  const intentEntries = reg.filter((e) => e.group === 'change-intent');
  expect(intentEntries.length).toBeGreaterThan(0);
  intentEntries[0].run();
  expect(actions.updateCardAiIntent).toHaveBeenCalledWith('c1', expect.any(String));
});

it('skips change-intent entries when no card is focused', () => {
  const reg = buildCommandRegistry({
    cards: [card('c1', 'foo')],
    blocks: {},
    projects: [],
    focusedCardId: null,
    actions: emptyActions(),
  });
  expect(reg.filter((e) => e.group === 'change-intent')).toHaveLength(0);
});
```

**Step 2: Implement**

In `commandRegistry.ts`:

```ts
export interface CommandRegistryActions {
  // ... existing
  updateCardAiIntent: (cardId: string, intent: TerminalAiIntent | null) => void;
}

export interface CommandRegistryInput {
  // ... existing
  focusedCardId: string | null;
}
```

After the existing toggle/settings entries:

```ts
const INTENTS: Array<TerminalAiIntent | null> = ['review', 'fix', 'research', 'test', 'docs', null];
if (input.focusedCardId) {
  for (const intent of INTENTS) {
    out.push({
      id: `intent:${intent ?? 'none'}`,
      label: intent ? `Set intent: ${intent}` : 'Clear intent',
      searchText: `set intent ${intent ?? 'clear none'}`.toLowerCase(),
      group: 'change-intent',
      run: () => input.actions.updateCardAiIntent(input.focusedCardId!, intent),
    });
  }
}
```

**Step 3: Wire from TerminalManager**

```ts
const updateCardAiIntent = useTerminalStore((s) => s.updateCardAiIntent);

const paletteEntries = useMemo(
  () => buildCommandRegistry({
    cards,
    blocks,
    projects: paletteProjects,
    focusedCardId,
    actions: { ..., updateCardAiIntent },
  }),
  [..., focusedCardId, updateCardAiIntent],
);
```

**Step 4: Commit**

```bash
npx vitest run
git add src/components/palette/ src/components/terminal/TerminalManager.tsx
git commit -m "feat: add Change card intent entries to command palette"
```

---

### Task 8 — palette: focus restore on close

**Why:** Spec says "关闭后焦点回到原卡片". Currently the palette grabs focus on open and never restores; pressing Esc leaves focus on `<body>`, which breaks keyboard flow back to the terminal.

**Files:**
- Modify: `src/components/palette/CommandPalette.tsx`
- Modify: `src/components/palette/CommandPalette.test.tsx`

**Step 1: Test**

```ts
it('restores focus to the previously focused element on close', async () => {
  const trigger = document.createElement('button');
  trigger.textContent = 'host';
  document.body.appendChild(trigger);
  trigger.focus();
  expect(document.activeElement).toBe(trigger);

  const onClose = vi.fn();
  const { rerender } = render(<CommandPalette open={true} entries={makeEntries()} onClose={onClose} />);
  // input is auto-focused by the palette
  await waitFor(() => expect(document.activeElement).not.toBe(trigger));
  rerender(<CommandPalette open={false} entries={makeEntries()} onClose={onClose} />);
  await waitFor(() => expect(document.activeElement).toBe(trigger));

  trigger.remove();
});
```

**Step 2: Implement**

In `CommandPalette.tsx`, add a ref for the previously focused element:

```ts
const previouslyFocusedRef = useRef<HTMLElement | null>(null);

useEffect(() => {
  if (open) {
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
    requestAnimationFrame(() => inputRef.current?.focus());
  } else {
    setQuery('');
    setSelectedIndex(0);
    const target = previouslyFocusedRef.current;
    previouslyFocusedRef.current = null;
    if (target && typeof target.focus === 'function') {
      // Defer until after React commits the unmount so focus lands correctly.
      requestAnimationFrame(() => target.focus());
    }
  }
}, [open]);
```

**Step 3: Apply same fix to BlockSearchPanel** (same UX gap, same fix)

```bash
# Mirror the changes in src/components/search/BlockSearchPanel.tsx
```

**Step 4: Commit**

```bash
git add src/components/palette/CommandPalette.tsx src/components/palette/CommandPalette.test.tsx src/components/search/BlockSearchPanel.tsx
git commit -m "feat: restore previous focus when palette/search panel close"
```

---

### Final verification (after all 8 tasks)

```bash
npx vitest run            # expect ≥217 tests pass (209 + 8 new tests minimum)
npm run typecheck         # clean
npm run build             # clean
cargo check  --manifest-path src-tauri/Cargo.toml
cargo test   --manifest-path src-tauri/Cargo.toml
```

Update `IMPLEMENTATION_PLAN.md`:
- Stage 4 status note: append "+ Stage 4.3 输出区域 + AI Explain onClick 占位 (gap-fill 批次)"
- Stage 5 status note: append "+ 5.1 output search + matched-line + timestamp 显示 + 5.2 workflow placeholder + change-intent 条目 + 焦点还原 (gap-fill 批次)"
- Document the deliberately-deferred items (Share button → Stage 8, timestamp filter → not planned).

```bash
git add IMPLEMENTATION_PLAN.md
git commit -m "docs: note Stage 4/5 gap-fill completion"
```

---

## Part B — Stage 6–9 Roadmap

Each of these is its own multi-task plan when picked up. The summaries below come straight from `IMPLEMENTATION_PLAN.md`. Pick **one** stage at a time; do not parallelize. Each gets its own dedicated `docs/plans/YYYY-MM-DD-stage<N>-*.md` written via the writing-plans skill before execution.

### Stage 6 · AI Inline + 底部动作栏 (status: Not Started)

**Goal:** AI moves from "separate card" to "next to the block". Centralize all context actions in a chip strip.

**Sub-modules:**
- 6.1 **AI 对块发问** — Wire `BlockToolbar.Explain` and `BlockInspector.Explain` to actually call the configured provider (Claude / Codex / Gemini, reusing v0.3 logic). AI replies render as a "virtual block" inserted below the source block (not written into PTY). One-click "Run as command" injects the suggested command with mandatory **1.5s confirmation countdown**.
- 6.2 **底部动作 chip 栏** — `BottomActionBar.tsx` fixed at the card bottom: notifications toggle / `/remote-control` / File explorer / Rich Input / Workflows / Bookmarks. **Surface only — no new functionality.** Centralizes existing capabilities behind chips. Hidden when card setting opts out.

**Critical guardrails:**
- AI replies must be visually unmistakable from PTY output (independent color + `AI · Claude` style label).
- "Run as command" → 1.5s countdown + cancel option, **always**.
- Chip strip must be keyboard-reachable and overflow gracefully on narrow screens.

**Tests required:** `aiInlineBlock.test.tsx` (insertion / deletion / Run-as-command countdown), `bottomActionBar.test.tsx` (keyboard nav + width adaptation).

**Estimated work:** Medium. Reuses existing `providerSession.ts` + AI provider plumbing.

**Dependencies:** Stages 1–5 ✅. None blocking.

---

### Stage 7 · Workflows (Warp schema 兼容) (status: Not Started)

**Goal:** Eliminate "open project → manually create same 3-4 cards / commands every time" friction.

**Protocol:**
- Adopt **[warpdotdev/workflows](https://github.com/warpdotdev/workflows)** YAML schema as-is: `name / command / tags / description / arguments[]`.
- ThreadTerm extensions: `intent` (for AI cards) and optional `cwd`. Parser **must ignore unknown fields** so the schema can grow.

**Features:**
- Right-click on project sidebar → "Edit project preset…" — set of workflow YAMLs scoped to that project.
- "Apply preset" button: one-click create matching cards. **Dedupe by `cwd + command`; never overwrite existing cards.**
- Command palette `Run workflow` group lists `~/.threadterm/workflows` + project-scoped workflows.
- One-click import from a URL (https-only). Preview diff before commit.

**Tests required:** `workflowParse.test.ts`, `applyPreset.test.ts`, `workflowImport.test.ts`.

**Estimated work:** Small. Schema is fixed; UI is mostly forms + a YAML parser (`js-yaml` is already in deps via Tauri / not — verify before adding).

**Dependencies:** Stages 1–5 ✅. The "Run workflow" palette entry from Task 6 of this gap-fill plan becomes the activation point.

---

### Stage 8 · 数据 IO 与自动恢复 (status: Not Started)

**Goal:** Settings/theme/preset import-export, AI session export, opt-in card auto-restart.

**Sub-modules:**
- 8.1 **设置/主题导入导出** — Single JSON file. Selective overwrite via diff view on import. **Whitelist serialization** — bridge tokens, pairing history, AI provider keys are NEVER exported.
- 8.2 **卡片自动重启** — Off by default. When enabled per-card: max retries (default 3), exponential backoff (cap 30s). Retry history shown in card status bar; max-retries-reached fires a notification.
- 8.3 **AI 会话 Markdown 导出** — Right-click on AI card / inline on block. Output: markdown with metadata (intent / provider / session id / timestamps) + ordered prompt/reply pairs in fenced code. **No network calls** — `dialog.save` only. Reuses `providerSession.ts` segmentation.

**Critical guardrails:** Sensitive-field whitelist is the load-bearing test in 8.1.

**Tests required:** `settingsImportExport.test.ts`, `autoRestart.test.ts`, `exportAiSession.test.ts`.

**Estimated work:** Medium. Three independent sub-modules.

**Dependencies:** Stage 7 ✅ (presets sit in the import/export surface). **The Share button from Stage 4.2 lands here** (as 8.3 markdown export → "Share AI session as markdown").

---

### Stage 9 · 体验长尾 (status: Not Started)

**Goal:** Polish and scope-completion.

**Sub-modules:**
- 9.1 **Token / 成本面板** — New `provider_usage.rs` (Rust). Whitelist regex extracts `tokens / cost` from Claude / Codex / Gemini CLI output; parse failures **silently** ignored. Display in card status bar + project sidebar bottom; one-click off → zero overhead.
- 9.2 **AI Reply 富预览** — Lightweight regex on top of `headlessPreview.ts`: detect ` ```fenced``` ` code blocks and `diff` headers, color them with existing theme tokens. **No markdown parser dep.** Per-card opt-out → fall back to plain-text preview.
- 9.3 **DND / 通知静默时段** — `NotificationSettings.tsx`: time window (HH:mm — HH:mm, can cross midnight), per-project mute, per-intent mute. During silent window: desktop OS notifications suppressed; notification centre still records, marked "Silenced". All defaults off.
- 9.4 **Linux 兼容性矩阵** — `docs/linux-compatibility.md`: verified DEs / known limits (global hotkeys / overlay / shell integration). Issue template adds Linux self-check (DE name, `xdotool` available?, shell type). **Documentation-only — no code commitment to fix.**

**Tests required:** `providerUsage.test.ts` (≥3 real masked outputs per provider, including parse-fail case), `headlessPreview.test.ts` extended (fenced/diff detection, no-match zero-change), `notificationDND.test.ts` (cross-midnight window, project mute precedence).

**Estimated work:** Medium. Four independent sub-modules.

**Dependencies:** Stages 1–8 ✅.

---

## Final Cleanup (after Stage 9)

Per IMPLEMENTATION_PLAN.md global rules:
- Delete `IMPLEMENTATION_PLAN.md` once all stages are Complete.
- Move any deferred-but-still-wanted items into `ROADMAP.md`.
- Tag a release.

---

## Plan Document Conventions

- **One stage per plan file** when picking up Stages 6–9. Use `docs/plans/YYYY-MM-DD-stage<N>-<feature>.md`.
- **Pre-flight check before each stage**: ROADMAP baseline must be green (typecheck / vitest / build / cargo check / cargo test).
- **i18n parity** is a hard release gate: every new key present in `en / zh-CN / ja / ko` before stage is marked Complete. Add a CI script `scripts/check-i18n-parity.sh` if drift becomes recurring.
- **Stage 4/5 gap-fill (this plan, Part A)** is the only legitimate way to "amend" a previously-Complete stage. Future stages declared Complete must stay Complete; new gaps go into a new gap-fill plan.
