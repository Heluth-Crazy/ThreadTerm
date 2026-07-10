# Stage 6 — AI Inline + Bottom Action Bar Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Wire real AI invocation into the Block Inspector (so "Explain with AI" stops being a placeholder), inject AI answers as virtual blocks with safe Run-as-command, and ship the contextual chip strip (`BottomActionBar`) at the bottom of the focused-card view.

**Status**: Complete (Stage 6 batch 2026-05-02): 6.1 ai_explain Tauri command (one-shot tokio process spawn, 30s timeout, 8KB prompt cap) + explainWithAi frontend wrapper + aiThreadStore (in-memory, FIFO 20 entries) + AiThreadView (two-step Run-as-command) + BlockInspector wired to real provider invocation; 6.2 chipRegistry pure builder + BottomActionBar (ResizeObserver overflow + ArrowLeft/Right/Home/End/Enter keyboard nav) + 6 chips (notifications/bookmarks/workflows-placeholder/file-explorer/rich-input-placeholder/remote-control); persist v6→v7 with aiExplainDefaultProvider='claude' migration; 4-locale i18n parity for aiThread.* and bottomBar.*; settings toggle for chip strip visibility; typecheck/vitest/build/cargo check/cargo test all green.

**Architecture:** Spawn a one-shot non-interactive CLI per Explain via a new Tauri command (`ai_explain`); render the answer thread inside `BlockInspector` (no xterm overlay, no PTY mutation, no persistence in v1); compose `BottomActionBar` as a stateless chip strip driven by a pure `chipRegistry.ts` builder, with a ResizeObserver-driven overflow menu. Defaults stay backward-compatible — if the AI CLI is missing, Explain reports a friendly error; if `bottomBarHidden` is true the chip strip simply isn't mounted.

**Tech Stack:** Rust (`tokio::process::Command` with `process` feature), Tauri 2 invoke, React 18 + Zustand (in-memory `aiThreadStore`), shadcn-ui buttons, Lucide icons, react-i18next, vitest + Testing Library.

---

## Architectural Decisions (locked)

These are settled before any task — every task below assumes them.

### Decision 1 — AI invocation path: one-shot CLI per Explain

Three options were considered:

| Path | Idea | Verdict |
|---|---|---|
| A | New Tauri command that talks to provider HTTP APIs directly | ❌ Requires API keys + new auth + new dependency surface |
| B | Reuse existing AI CLI cards (open a card, type the prompt, scrape the output) | ❌ Pollutes user's card grid; tightly couples Explain to PTY scroll-back parsing |
| **C** | **Spawn one-shot non-interactive CLI (`claude -p`, `codex exec`, `gemini -p`) via a new Tauri command** | ✅ Reuses user's already-configured CLI auth, no new auth/secret surface, clean stdout/stderr capture, no PTY pollution |

**Chosen: Path C.** A new Rust module `src-tauri/src/ai_explain.rs` exposes a single Tauri command `ai_explain(provider, prompt) -> AiExplainResult`. It uses `tokio::process::Command`, kills on 30 s timeout, captures stdout/stderr separately, returns `{ stdout, stderr, exit_code, timed_out }`.

### Decision 2 — Virtual block placement: inside `BlockInspector`

Three options:

| Option | Idea | Verdict |
|---|---|---|
| Inline xterm overlay | Inject AI answer into the scroll surface as a fake block | ❌ Breaks PTY semantics, fights xterm decoration API |
| **Inspector panel** | **Add an "AI Thread" section in `BlockInspector` below metadata** | ✅ Already context-rich (panel knows the block); reuses existing right-side panel; visually distinct from PTY |
| Chat-style overlay | New full-height chat sidebar | ❌ Heavy UI surface for a Stage-6 first cut |

**Chosen: Inspector panel.** Each block has its own AI thread (Q/A list, in-memory only). When the inspector is open and a block is selected, the thread renders below the metadata and output sections.

### Decision 3 — Run-as-command: 1.5 s two-step confirm + same-card PTY inject

- Target card: `block.cardId` (the card the block came from). Blocks only exist on shell cards (OSC 133 doesn't fire in AI CLI cards), so injection is always into a shell PTY.
- Confirmation: identical pattern to Stage 4 Re-run — first click flips a `data-pending` visual + 1.5 s timer, second click within the window invokes `pty_input` with `command + '\n'`. Timer expiry resets state.
- Hard rules: never mutate the answer text before confirm; never run automatically; never send to a non-shell card.

### Decision 4 — Provider selection: focused-card biased, with global default

- If the focused card's `terminalType` is one of `claude` / `codex` / `gemini`, use that provider.
- Otherwise read `aiExplainDefaultProvider` from the terminal store (default `'claude'`).
- No in-UI picker in Stage 6; Settings tab follows in Stage 8.

### Decision 5 — `BottomActionBar` chip list

Six chips, all wired to existing capabilities (no new features):

| id | Label key | Icon | Action |
|---|---|---|---|
| `notifications` | `bottomBar.notifications` | `Bell` / `BellDot` | `toggleNotificationCentre()` (existing) |
| `bookmarks` | `bottomBar.bookmarks` | `Star` | `setBookmarksOpen(prev => !prev)` (existing) |
| `workflows` | `bottomBar.workflows` | `Workflow` | Opens placeholder modal — Stage 7 hookup point |
| `file-explorer` | `bottomBar.fileExplorer` | `FolderOpen` | `tauri-plugin-shell` `open(card.cwd)` |
| `rich-input` | `bottomBar.richInput` | `MessageSquare` | Placeholder modal — Stage 9 hookup point |
| `remote-control` | `bottomBar.remoteControl` | `Smartphone` | Opens existing bridge settings panel |

Visibility rules:
- All chips visible by default in focus mode only (not in card grid view).
- Card-level toggle `bottomBarHidden: boolean` in store; default `false`.
- `ResizeObserver` watches the strip; chips that overflow collapse into a `…` overflow menu.

---

## Pre-flight

- Branch: continue on `codex/implementation-plan-stage2-stage3` (current branch).
- Worktree: not required — Stage 6 only touches `src-tauri/src/`, `src/components/terminal/`, `src/stores/`, `src/i18n/`, and adds new files under `src/components/ai/` + `src/components/bottombar/`.
- Verification baseline (must pass at every commit boundary): `npm run typecheck`, `npx vitest run`, `npm run build`, `cargo check`, `cargo test`.

---

## Task 1 — Rust: `ai_explain` Tauri command

**Files:**
- Create: `src-tauri/src/ai_explain.rs`
- Modify: `src-tauri/src/lib.rs:7` (add `mod ai_explain;`) and `src-tauri/src/lib.rs:48-80` (register `ai_explain::ai_explain` in `generate_handler!`)
- Modify: `src-tauri/Cargo.toml:42` (extend `tokio` features with `"process"`)

**Step 1 — Write failing test**

Append to `src-tauri/src/ai_explain.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn returns_stdout_for_successful_command() {
        // /bin/echo is on every macOS / Linux box; Windows tests are skipped.
        let result = run_one_shot(
            "/bin/echo",
            &["hello world".to_string()],
            std::time::Duration::from_secs(5),
        )
        .await
        .expect("echo should succeed");
        assert_eq!(result.stdout.trim(), "hello world");
        assert_eq!(result.exit_code, Some(0));
        assert!(!result.timed_out);
    }

    #[tokio::test]
    async fn reports_timeout() {
        let result = run_one_shot(
            "/bin/sleep",
            &["10".to_string()],
            std::time::Duration::from_millis(150),
        )
        .await
        .expect("sleep should be killable");
        assert!(result.timed_out, "expected timed_out=true, got {:?}", result);
    }

    #[tokio::test]
    async fn returns_stderr_and_nonzero_exit_for_missing_binary() {
        let result =
            run_one_shot("/usr/bin/false", &[], std::time::Duration::from_secs(5)).await;
        // /usr/bin/false exits 1, not a spawn error.
        let result = result.expect("false should spawn");
        assert_eq!(result.exit_code, Some(1));
    }
}
```

**Step 2 — Run tests, verify they fail**

```bash
cd src-tauri && cargo test ai_explain::tests 2>&1 | tail -20
```

Expected: `error[E0432]: unresolved import` / module not found.

**Step 3 — Write minimal implementation**

Replace `src-tauri/src/ai_explain.rs` content with:

```rust
//! One-shot, non-interactive AI CLI invocation for "Explain with AI".
//!
//! Stage 6 design: re-uses the user's already-installed CLI (claude / codex /
//! gemini) via headless flags. We never touch the user's PTY cards; this is a
//! side-channel process spawn whose stdout/stderr are returned to the renderer
//! as a single chunk.

use serde::{Deserialize, Serialize};
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::time::timeout;

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AiExplainProvider {
    Claude,
    Codex,
    Gemini,
}

#[derive(Debug, Serialize)]
pub struct AiExplainResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
}

/// Resolve `(binary, args)` for a given provider + prompt, using each CLI's
/// non-interactive flag. Keep the prompt as a single argv slot — never join
/// into a shell string.
fn resolve_invocation(provider: AiExplainProvider, prompt: &str) -> (&'static str, Vec<String>) {
    match provider {
        AiExplainProvider::Claude => ("claude", vec!["-p".into(), prompt.to_string()]),
        AiExplainProvider::Codex => ("codex", vec!["exec".into(), prompt.to_string()]),
        AiExplainProvider::Gemini => ("gemini", vec!["-p".into(), prompt.to_string()]),
    }
}

pub(crate) async fn run_one_shot(
    bin: &str,
    args: &[String],
    deadline: Duration,
) -> Result<AiExplainResult, String> {
    let mut cmd = Command::new(bin);
    cmd.args(args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);

    let mut child = cmd.spawn().map_err(|e| format!("spawn failed: {e}"))?;
    let mut stdout = child.stdout.take().expect("piped");
    let mut stderr = child.stderr.take().expect("piped");

    let collect = async move {
        let mut so = String::new();
        let mut se = String::new();
        let _ = stdout.read_to_string(&mut so).await;
        let _ = stderr.read_to_string(&mut se).await;
        let status = child.wait().await.map_err(|e| format!("wait: {e}"))?;
        Ok::<_, String>((so, se, status.code()))
    };

    match timeout(deadline, collect).await {
        Ok(Ok((so, se, code))) => Ok(AiExplainResult {
            stdout: so,
            stderr: se,
            exit_code: code,
            timed_out: false,
        }),
        Ok(Err(e)) => Err(e),
        Err(_) => Ok(AiExplainResult {
            stdout: String::new(),
            stderr: "timed out after 30s".into(),
            exit_code: None,
            timed_out: true,
        }),
    }
}

#[tauri::command]
pub async fn ai_explain(
    provider: AiExplainProvider,
    prompt: String,
) -> Result<AiExplainResult, String> {
    if prompt.trim().is_empty() {
        return Err("prompt is empty".into());
    }
    if prompt.len() > 8192 {
        return Err("prompt too long (>8192 chars)".into());
    }
    let (bin, args) = resolve_invocation(provider, &prompt);
    run_one_shot(bin, &args, Duration::from_secs(30)).await
}
```

In `src-tauri/Cargo.toml`, change `tokio = { version = "1", features = ["macros", "net", "rt-multi-thread", "sync", "time"] }` to add `"process"`.

In `src-tauri/src/lib.rs`, add `mod ai_explain;` near the other top-level `mod` declarations and add `ai_explain::ai_explain,` inside `generate_handler!`.

**Step 4 — Run tests, verify they pass**

```bash
cd src-tauri && cargo test ai_explain::tests 2>&1 | tail -20
```

Expected: `test result: ok. 3 passed`.

Then run the full Rust suite to make sure registration didn't regress anything:

```bash
cd src-tauri && cargo test 2>&1 | tail -10
```

Expected: all green.

**Step 5 — Commit**

```bash
git add src-tauri/src/ai_explain.rs src-tauri/src/lib.rs src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "feat(stage6): add ai_explain Tauri command for one-shot CLI"
```

---

## Task 2 — Frontend wrapper `aiExplain.ts`

**Files:**
- Create: `src/lib/ai/aiExplain.ts`
- Create: `src/lib/ai/aiExplain.test.ts`

**Step 1 — Write failing test**

```ts
import { describe, expect, it, vi } from 'vitest';
import { explainWithAi } from './aiExplain';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string, payload: { provider: string; prompt: string }) => {
    if (cmd !== 'ai_explain') throw new Error(`unexpected cmd ${cmd}`);
    if (payload.provider === 'claude') {
      return { stdout: 'echo lists files', stderr: '', exit_code: 0, timed_out: false };
    }
    return { stdout: '', stderr: 'boom', exit_code: 1, timed_out: false };
  }),
}));

describe('explainWithAi', () => {
  it('returns stdout for a successful claude invocation', async () => {
    const r = await explainWithAi({ provider: 'claude', prompt: 'explain ls' });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.text).toContain('echo lists files');
  });

  it('returns an error envelope when the CLI errors', async () => {
    const r = await explainWithAi({ provider: 'codex', prompt: 'explain ls' });
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.message).toContain('boom');
  });

  it('rejects empty prompt before invoking', async () => {
    const r = await explainWithAi({ provider: 'claude', prompt: '   ' });
    expect(r.kind).toBe('error');
  });
});
```

**Step 2 — Run, verify fail**

```bash
npx vitest run src/lib/ai/aiExplain.test.ts 2>&1 | tail -10
```

Expected: `Cannot find module './aiExplain'`.

**Step 3 — Implement minimal**

```ts
// src/lib/ai/aiExplain.ts
import { invoke } from '@tauri-apps/api/core';

export type AiExplainProvider = 'claude' | 'codex' | 'gemini';

export interface AiExplainOk {
  kind: 'ok';
  text: string;
  stderr: string;
}
export interface AiExplainError {
  kind: 'error';
  message: string;
  timedOut: boolean;
}
export type AiExplainResult = AiExplainOk | AiExplainError;

interface RawResult {
  stdout: string;
  stderr: string;
  exit_code: number | null;
  timed_out: boolean;
}

export interface ExplainArgs {
  provider: AiExplainProvider;
  prompt: string;
}

export async function explainWithAi({ provider, prompt }: ExplainArgs): Promise<AiExplainResult> {
  if (!prompt.trim()) {
    return { kind: 'error', message: 'prompt is empty', timedOut: false };
  }
  try {
    const raw = (await invoke('ai_explain', { provider, prompt })) as RawResult;
    if (raw.timed_out) {
      return { kind: 'error', message: 'AI provider timed out', timedOut: true };
    }
    if (raw.exit_code !== 0) {
      return {
        kind: 'error',
        message: raw.stderr.trim() || `provider exited with ${raw.exit_code}`,
        timedOut: false,
      };
    }
    return { kind: 'ok', text: raw.stdout, stderr: raw.stderr };
  } catch (e) {
    return { kind: 'error', message: e instanceof Error ? e.message : String(e), timedOut: false };
  }
}
```

**Step 4 — Run, verify pass**

```bash
npx vitest run src/lib/ai/aiExplain.test.ts 2>&1 | tail -10
```

Expected: 3 passed.

**Step 5 — Commit**

```bash
git add src/lib/ai/aiExplain.ts src/lib/ai/aiExplain.test.ts
git commit -m "feat(stage6): add explainWithAi frontend wrapper"
```

---

## Task 3 — In-memory AI thread store

**Files:**
- Create: `src/stores/aiThreadStore.ts`
- Create: `src/stores/aiThreadStore.test.ts`

**Step 1 — Write failing test**

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { useAiThreadStore } from './aiThreadStore';

describe('aiThreadStore', () => {
  beforeEach(() => {
    useAiThreadStore.setState({ threads: {} });
  });

  it('appends Q and A entries to the thread for a block', () => {
    const s = useAiThreadStore.getState();
    s.appendQuestion('block-1', 'why did this fail?');
    s.appendAnswer('block-1', 'because exit code 1', 'claude');
    const thread = useAiThreadStore.getState().threads['block-1'];
    expect(thread.entries).toHaveLength(2);
    expect(thread.entries[0]).toMatchObject({ role: 'user', text: 'why did this fail?' });
    expect(thread.entries[1]).toMatchObject({ role: 'ai', provider: 'claude' });
  });

  it('caps a thread at 20 entries (FIFO trim)', () => {
    const s = useAiThreadStore.getState();
    for (let i = 0; i < 25; i++) s.appendQuestion('b', `q${i}`);
    expect(useAiThreadStore.getState().threads['b'].entries).toHaveLength(20);
    expect(useAiThreadStore.getState().threads['b'].entries[0].text).toBe('q5');
  });

  it('clearThread removes the entry', () => {
    const s = useAiThreadStore.getState();
    s.appendQuestion('b', 'q');
    s.clearThread('b');
    expect(useAiThreadStore.getState().threads['b']).toBeUndefined();
  });
});
```

**Step 2 — Run, verify fail**

```bash
npx vitest run src/stores/aiThreadStore.test.ts 2>&1 | tail -10
```

**Step 3 — Implement minimal**

```ts
import { create } from 'zustand';
import type { AiExplainProvider } from '../lib/ai/aiExplain';

export interface AiThreadEntry {
  id: string;
  role: 'user' | 'ai';
  text: string;
  provider?: AiExplainProvider;
  createdAt: number;
  state?: 'pending' | 'ok' | 'error';
}

export interface AiThread {
  blockId: string;
  entries: AiThreadEntry[];
}

interface AiThreadState {
  threads: Record<string, AiThread>;
  appendQuestion: (blockId: string, text: string) => string;
  appendAnswer: (
    blockId: string,
    text: string,
    provider: AiExplainProvider,
    state?: 'ok' | 'error',
  ) => void;
  setEntryState: (blockId: string, entryId: string, state: 'pending' | 'ok' | 'error') => void;
  clearThread: (blockId: string) => void;
}

const MAX_ENTRIES = 20;

function trim(entries: AiThreadEntry[]): AiThreadEntry[] {
  if (entries.length <= MAX_ENTRIES) return entries;
  return entries.slice(entries.length - MAX_ENTRIES);
}

export const useAiThreadStore = create<AiThreadState>((set) => ({
  threads: {},
  appendQuestion: (blockId, text) => {
    const id = `q-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    set((s) => {
      const prev = s.threads[blockId]?.entries ?? [];
      return {
        threads: {
          ...s.threads,
          [blockId]: {
            blockId,
            entries: trim([
              ...prev,
              { id, role: 'user', text, createdAt: Date.now(), state: 'pending' },
            ]),
          },
        },
      };
    });
    return id;
  },
  appendAnswer: (blockId, text, provider, state = 'ok') =>
    set((s) => {
      const prev = s.threads[blockId]?.entries ?? [];
      const id = `a-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      return {
        threads: {
          ...s.threads,
          [blockId]: {
            blockId,
            entries: trim([
              ...prev,
              { id, role: 'ai', text, provider, createdAt: Date.now(), state },
            ]),
          },
        },
      };
    }),
  setEntryState: (blockId, entryId, state) =>
    set((s) => {
      const t = s.threads[blockId];
      if (!t) return s;
      return {
        threads: {
          ...s.threads,
          [blockId]: {
            ...t,
            entries: t.entries.map((e) => (e.id === entryId ? { ...e, state } : e)),
          },
        },
      };
    }),
  clearThread: (blockId) =>
    set((s) => {
      if (!s.threads[blockId]) return s;
      const next = { ...s.threads };
      delete next[blockId];
      return { threads: next };
    }),
}));
```

**Step 4 — Run, verify pass**

```bash
npx vitest run src/stores/aiThreadStore.test.ts 2>&1 | tail -10
```

**Step 5 — Commit**

```bash
git add src/stores/aiThreadStore.ts src/stores/aiThreadStore.test.ts
git commit -m "feat(stage6): add in-memory AI thread store"
```

---

## Task 4 — `AiThreadView.tsx` (presentational)

**Files:**
- Create: `src/components/ai/AiThreadView.tsx`
- Create: `src/components/ai/AiThreadView.test.tsx`

**Step 1 — Write failing test**

```tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AiThreadView } from './AiThreadView';

describe('AiThreadView', () => {
  it('renders empty state when no entries', () => {
    render(<AiThreadView entries={[]} onRunCommand={vi.fn()} />);
    expect(screen.getByTestId('ai-thread-empty')).toBeInTheDocument();
  });

  it('renders user and ai entries with role distinction', () => {
    render(
      <AiThreadView
        entries={[
          { id: 'u1', role: 'user', text: 'why?', createdAt: 1, state: 'ok' },
          { id: 'a1', role: 'ai', text: 'because', provider: 'claude', createdAt: 2, state: 'ok' },
        ]}
        onRunCommand={vi.fn()}
      />,
    );
    expect(screen.getByTestId('ai-thread-entry-u1')).toHaveAttribute('data-role', 'user');
    expect(screen.getByTestId('ai-thread-entry-a1')).toHaveAttribute('data-role', 'ai');
  });

  it('Run-as-command requires two clicks within 1500ms', () => {
    vi.useFakeTimers();
    const onRunCommand = vi.fn();
    render(
      <AiThreadView
        entries={[
          {
            id: 'a1',
            role: 'ai',
            text: '`ls -la`',
            provider: 'claude',
            createdAt: 1,
            state: 'ok',
          },
        ]}
        onRunCommand={onRunCommand}
      />,
    );
    const btn = screen.getByTestId('ai-run-as-command-a1');
    fireEvent.click(btn);
    expect(onRunCommand).not.toHaveBeenCalled();
    fireEvent.click(btn);
    expect(onRunCommand).toHaveBeenCalledWith('ls -la');
    vi.useRealTimers();
  });

  it('Run-as-command resets after 1500ms timeout', () => {
    vi.useFakeTimers();
    const onRunCommand = vi.fn();
    render(
      <AiThreadView
        entries={[
          {
            id: 'a1',
            role: 'ai',
            text: '`echo hi`',
            provider: 'claude',
            createdAt: 1,
            state: 'ok',
          },
        ]}
        onRunCommand={onRunCommand}
      />,
    );
    fireEvent.click(screen.getByTestId('ai-run-as-command-a1'));
    vi.advanceTimersByTime(1600);
    fireEvent.click(screen.getByTestId('ai-run-as-command-a1'));
    expect(onRunCommand).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
```

**Step 2 — Run, verify fail**

```bash
npx vitest run src/components/ai/AiThreadView.test.tsx 2>&1 | tail -10
```

**Step 3 — Implement minimal**

```tsx
// src/components/ai/AiThreadView.tsx
import { useState, useRef, useEffect, useMemo } from 'react';
import { Bot, Play, User } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AiThreadEntry } from '../../stores/aiThreadStore';

const RERUN_CONFIRM_MS = 1500;
const FENCE_RE = /```(?:\w+)?\n([\s\S]+?)\n```|`([^`\n]+)`/m;

function extractFirstCommand(text: string): string | null {
  const m = text.match(FENCE_RE);
  if (!m) return null;
  return (m[1] ?? m[2] ?? '').trim() || null;
}

interface Props {
  entries: AiThreadEntry[];
  onRunCommand: (command: string) => void;
}

export function AiThreadView({ entries, onRunCommand }: Props) {
  const { t } = useTranslation('terminal');
  if (entries.length === 0) {
    return (
      <div data-testid="ai-thread-empty" className="text-[10px] text-muted-foreground italic">
        {t('aiThread.empty', { defaultValue: 'Ask AI to explain — answers appear here.' })}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {entries.map((e) => (
        <Entry key={e.id} entry={e} onRunCommand={onRunCommand} />
      ))}
    </div>
  );
}

function Entry({ entry, onRunCommand }: { entry: AiThreadEntry; onRunCommand: (c: string) => void }) {
  const { t } = useTranslation('terminal');
  const [pending, setPending] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cmd = useMemo(() => (entry.role === 'ai' ? extractFirstCommand(entry.text) : null), [entry]);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const onClickRun = () => {
    if (!cmd) return;
    if (!pending) {
      setPending(true);
      timer.current = setTimeout(() => setPending(false), RERUN_CONFIRM_MS);
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    setPending(false);
    onRunCommand(cmd);
  };

  return (
    <div
      data-testid={`ai-thread-entry-${entry.id}`}
      data-role={entry.role}
      className={
        entry.role === 'user'
          ? 'rounded-md border border-border bg-muted/30 p-2 text-[11px]'
          : 'rounded-md border border-violet-500/30 bg-violet-500/5 p-2 text-[11px]'
      }
    >
      <div className="mb-1 flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground">
        {entry.role === 'user' ? <User className="h-3 w-3" /> : <Bot className="h-3 w-3" />}
        <span>{entry.role === 'user' ? 'You' : `AI · ${entry.provider ?? 'unknown'}`}</span>
      </div>
      <pre className="whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed">
        {entry.state === 'pending' ? '…' : entry.text}
      </pre>
      {cmd && entry.state === 'ok' && (
        <button
          type="button"
          data-testid={`ai-run-as-command-${entry.id}`}
          data-pending={pending ? 'true' : 'false'}
          onClick={onClickRun}
          className={
            'mt-1 inline-flex items-center gap-1 rounded px-2 py-0.5 text-[10px] ' +
            (pending
              ? 'bg-amber-500/20 text-amber-600'
              : 'bg-muted text-muted-foreground hover:bg-accent hover:text-accent-foreground')
          }
        >
          <Play className="h-3 w-3" />
          {pending
            ? t('aiThread.runAsCommandConfirm', { defaultValue: 'Click again to run' })
            : t('aiThread.runAsCommand', { defaultValue: 'Run as command' })}
        </button>
      )}
    </div>
  );
}
```

**Step 4 — Run, verify pass**

```bash
npx vitest run src/components/ai/AiThreadView.test.tsx 2>&1 | tail -10
```

**Step 5 — Commit**

```bash
git add src/components/ai/AiThreadView.tsx src/components/ai/AiThreadView.test.tsx
git commit -m "feat(stage6): add AiThreadView with two-step Run-as-command"
```

---

## Task 5 — Wire `BlockInspector` to real AI invocation

**Files:**
- Modify: `src/components/terminal/BlockInspector.tsx`
- Modify: `src/components/terminal/BlockInspector.test.tsx`

**Step 1 — Write failing test (extend existing)**

Add to `BlockInspector.test.tsx`:

```tsx
it('clicking Explain enqueues a question and renders the answer entry', async () => {
  const explainSpy = vi.fn(async () => ({ kind: 'ok', text: 'short answer', stderr: '' }));
  render(
    <BlockInspector
      block={{ ...sampleBlock, id: 'b1' }}
      onExplain={() => explainSpy()}
    />,
  );
  fireEvent.click(screen.getByTestId('block-inspector-explain'));
  await waitFor(() => expect(explainSpy).toHaveBeenCalled());
});
```

(Adjust `sampleBlock` import to match the existing test file's fixture.)

**Step 2 — Run, verify fail.**

**Step 3 — Implement minimal**

In `BlockInspector.tsx`:
1. Import `useAiThreadStore` + `AiThreadView` + `explainWithAi`.
2. Replace the bottom "AI Explain placeholder" block with two pieces:
   - The `Explain` button now calls a local `handleExplain()` which:
     - reads `provider = props.providerOverride ?? 'claude'` (passed in from caller)
     - appends a question via `appendQuestion(block.id, prompt)` where `prompt` = `Explain this command and its output:\n\nCommand: ${block.command}\nCwd: ${block.cwd}\nExit code: ${block.exitCode}\nOutput:\n${block.output ?? '(none)'}`
     - awaits `explainWithAi({ provider, prompt })`
     - appends the answer (or an error entry with `state: 'error'`).
   - Below the button, render `<AiThreadView entries={thread?.entries ?? []} onRunCommand={props.onRunCommand} />`.
3. New optional props:
   - `providerOverride?: AiExplainProvider`
   - `onRunCommand?: (command: string) => void`
4. Delete the `onExplain` prop entirely (it was a Stage-4 placeholder; nothing in production sets it now).

**Step 4 — Run, verify pass.**

**Step 5 — Commit**

```bash
git add src/components/terminal/BlockInspector.tsx src/components/terminal/BlockInspector.test.tsx
git commit -m "feat(stage6): wire BlockInspector to ai_explain + AiThreadView"
```

---

## Task 6 — Wire provider selection + Run-as-command into `TerminalView`

**Files:**
- Modify: `src/components/terminal/TerminalView.tsx`
- Modify: `src/stores/terminalStore.ts` (add `aiExplainDefaultProvider: AiExplainProvider`, default `'claude'`, and a setter; persist version 6 → 7)

**Step 1 — Write failing test**

Add a focused test (`TerminalView.test.tsx` or new `TerminalView.aiExplain.test.tsx`):

```tsx
it('passes the focused card terminalType as provider when AI', () => {
  // arrange a card with terminalType='codex' and a selected block;
  // assert BlockInspector receives providerOverride='codex'.
});
it('falls back to aiExplainDefaultProvider when card is shell', () => {
  // arrange a shell card; assert providerOverride='claude' (default).
});
it('Run-as-command pumps text to pty_input for the focused card', async () => {
  // mock @tauri-apps/api/core invoke; click the run button twice; assert
  // invoke('pty_input', { ptyId, data: 'ls\n' }) was called.
});
```

**Step 2 — Run, verify fail.**

**Step 3 — Implement minimal**

In `TerminalView.tsx`:
- Read `aiExplainDefaultProvider` and `card.terminalType` from store.
- Compute `providerOverride = (['claude','codex','gemini'] as const).includes(card.terminalType) ? card.terminalType : aiExplainDefaultProvider`.
- Pass `providerOverride` and `onRunCommand={(cmd) => invoke('pty_input', { ptyId: card.ptyId, data: cmd + '\n' })}` to `<BlockInspector />`.

In `terminalStore.ts`:
- Add field + action; bump persist `version: 6` → `7` and add migration that fills `aiExplainDefaultProvider: 'claude'` for older snapshots.

**Step 4 — Run, verify pass.**

**Step 5 — Commit**

```bash
git add src/components/terminal/TerminalView.tsx src/stores/terminalStore.ts src/components/terminal/TerminalView.aiExplain.test.tsx
git commit -m "feat(stage6): wire provider selection + Run-as-command in TerminalView"
```

---

## Task 7 — i18n keys (4 locales)

**Files:**
- Modify: `src/i18n/locales/en/terminal.json`
- Modify: `src/i18n/locales/zh-CN/terminal.json`
- Modify: `src/i18n/locales/ja/terminal.json`
- Modify: `src/i18n/locales/ko/terminal.json`

**Step 1 — No new test needed (covered by component tests via fallback strings).**

**Step 2 — Add keys** under `aiThread.*`:

| key | en | zh-CN | ja | ko |
|---|---|---|---|---|
| `aiThread.empty` | Ask AI to explain — answers appear here. | 让 AI 解释，回答会出现在这里。 | AI に解説を依頼すると、回答がここに表示されます。 | AI에게 설명을 요청하면 답변이 여기에 표시됩니다. |
| `aiThread.runAsCommand` | Run as command | 作为命令运行 | コマンドとして実行 | 명령으로 실행 |
| `aiThread.runAsCommandConfirm` | Click again to run | 再次点击以运行 | もう一度クリックして実行 | 다시 클릭하여 실행 |
| `aiThread.error` | AI error: {{message}} | AI 错误：{{message}} | AI エラー：{{message}} | AI 오류: {{message}} |
| `aiThread.timedOut` | AI timed out | AI 超时 | AI がタイムアウトしました | AI 시간 초과 |

**Step 3 — Commit**

```bash
git add src/i18n/locales/*/terminal.json
git commit -m "feat(stage6): add aiThread i18n keys (4 locales)"
```

---

## Task 8 — Pure `chipRegistry.ts`

**Files:**
- Create: `src/components/bottombar/chipRegistry.ts`
- Create: `src/components/bottombar/chipRegistry.test.ts`

**Step 1 — Write failing test**

```ts
import { describe, expect, it } from 'vitest';
import { buildChipRegistry } from './chipRegistry';

describe('buildChipRegistry', () => {
  it('emits all six default chips when context is full', () => {
    const chips = buildChipRegistry({
      cardCwd: '/home/u',
      bridgeAvailable: true,
      bookmarkCount: 3,
      unreadNotifications: 0,
    });
    expect(chips.map((c) => c.id)).toEqual([
      'notifications',
      'bookmarks',
      'workflows',
      'file-explorer',
      'rich-input',
      'remote-control',
    ]);
  });

  it('hides file-explorer when cwd is empty', () => {
    const chips = buildChipRegistry({
      cardCwd: '',
      bridgeAvailable: true,
      bookmarkCount: 0,
      unreadNotifications: 0,
    });
    expect(chips.find((c) => c.id === 'file-explorer')).toBeUndefined();
  });

  it('marks notifications dot when unread > 0', () => {
    const chips = buildChipRegistry({
      cardCwd: '/x',
      bridgeAvailable: true,
      bookmarkCount: 0,
      unreadNotifications: 4,
    });
    const n = chips.find((c) => c.id === 'notifications');
    expect(n?.badge).toBe(4);
  });
});
```

**Step 2 — Run, verify fail.**

**Step 3 — Implement minimal**

```ts
export type ChipId =
  | 'notifications'
  | 'bookmarks'
  | 'workflows'
  | 'file-explorer'
  | 'rich-input'
  | 'remote-control';

export interface ChipDescriptor {
  id: ChipId;
  labelKey: string;
  iconKey: string;
  badge?: number;
}

export interface ChipContext {
  cardCwd: string;
  bridgeAvailable: boolean;
  bookmarkCount: number;
  unreadNotifications: number;
}

export function buildChipRegistry(ctx: ChipContext): ChipDescriptor[] {
  const out: ChipDescriptor[] = [];
  out.push({
    id: 'notifications',
    labelKey: 'bottomBar.notifications',
    iconKey: 'bell',
    badge: ctx.unreadNotifications > 0 ? ctx.unreadNotifications : undefined,
  });
  out.push({
    id: 'bookmarks',
    labelKey: 'bottomBar.bookmarks',
    iconKey: 'star',
    badge: ctx.bookmarkCount > 0 ? ctx.bookmarkCount : undefined,
  });
  out.push({ id: 'workflows', labelKey: 'bottomBar.workflows', iconKey: 'workflow' });
  if (ctx.cardCwd) out.push({ id: 'file-explorer', labelKey: 'bottomBar.fileExplorer', iconKey: 'folder' });
  out.push({ id: 'rich-input', labelKey: 'bottomBar.richInput', iconKey: 'message' });
  if (ctx.bridgeAvailable)
    out.push({ id: 'remote-control', labelKey: 'bottomBar.remoteControl', iconKey: 'phone' });
  return out;
}
```

**Step 4 — Run, verify pass.**

**Step 5 — Commit**

```bash
git add src/components/bottombar/chipRegistry.ts src/components/bottombar/chipRegistry.test.ts
git commit -m "feat(stage6): add pure chipRegistry builder"
```

---

## Task 9 — `BottomActionBar.tsx` with overflow menu + keyboard nav

**Files:**
- Create: `src/components/bottombar/BottomActionBar.tsx`
- Create: `src/components/bottombar/BottomActionBar.test.tsx`

**Step 1 — Write failing test**

```tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BottomActionBar } from './BottomActionBar';

const handlers = {
  notifications: vi.fn(),
  bookmarks: vi.fn(),
  workflows: vi.fn(),
  'file-explorer': vi.fn(),
  'rich-input': vi.fn(),
  'remote-control': vi.fn(),
};

describe('BottomActionBar', () => {
  it('renders chips for the current context', () => {
    render(
      <BottomActionBar
        cardCwd="/home/u"
        bridgeAvailable
        bookmarkCount={1}
        unreadNotifications={0}
        onChipActivate={(id) => handlers[id]()}
      />,
    );
    expect(screen.getByTestId('chip-notifications')).toBeInTheDocument();
    expect(screen.getByTestId('chip-bookmarks')).toBeInTheDocument();
  });

  it('ArrowRight moves focus to next chip', () => {
    render(
      <BottomActionBar
        cardCwd="/x"
        bridgeAvailable
        bookmarkCount={0}
        unreadNotifications={0}
        onChipActivate={vi.fn()}
      />,
    );
    const first = screen.getByTestId('chip-notifications');
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(screen.getByTestId('chip-bookmarks'));
  });

  it('Enter activates the focused chip', () => {
    const onChipActivate = vi.fn();
    render(
      <BottomActionBar
        cardCwd="/x"
        bridgeAvailable
        bookmarkCount={0}
        unreadNotifications={0}
        onChipActivate={onChipActivate}
      />,
    );
    const c = screen.getByTestId('chip-bookmarks');
    c.focus();
    fireEvent.keyDown(c, { key: 'Enter' });
    expect(onChipActivate).toHaveBeenCalledWith('bookmarks');
  });
});
```

**Step 2 — Run, verify fail.**

**Step 3 — Implement minimal**

Component:
- Builds the chip list via `buildChipRegistry`.
- Renders chips horizontally via flex.
- Each chip is a `<button data-testid={\`chip-\${id}\`} role="button" tabIndex={0}>` with icon + label + optional badge.
- Keydown handler on the strip: `ArrowLeft` / `ArrowRight` / `Home` / `End` move focus among visible chips; `Enter` / ` ` calls `onChipActivate(id)`.
- ResizeObserver: if `scrollWidth > clientWidth`, last N chips collapse into a `…` button that opens a popover with the overflow chips. (Use shadcn's `Popover` already vendored.)
- Icon mapping uses Lucide: `bell→Bell` / `BellDot` if `badge>0`, `star→Star`, `workflow→Workflow`, `folder→FolderOpen`, `message→MessageSquare`, `phone→Smartphone`.

**Step 4 — Run, verify pass.**

**Step 5 — Commit**

```bash
git add src/components/bottombar/BottomActionBar.tsx src/components/bottombar/BottomActionBar.test.tsx
git commit -m "feat(stage6): add BottomActionBar chip strip + keyboard nav"
```

---

## Task 10 — Mount `BottomActionBar` in `TerminalView`

**Files:**
- Modify: `src/components/terminal/TerminalView.tsx`
- Modify: `src/stores/terminalStore.ts` (add `bottomBarHidden: Record<string, boolean>` keyed by cardId, default empty; toggle action)

**Step 1 — Write failing test**

`TerminalView.test.tsx`:
```tsx
it('renders BottomActionBar in focus mode', () => {
  // mount TerminalView with focused card; assert chip-bookmarks present.
});
it('omits BottomActionBar when bottomBarHidden[cardId] is true', () => {
  // set store; assert chip-bookmarks not present.
});
```

**Step 2 — Run, verify fail.**

**Step 3 — Implement minimal**

- Import `BottomActionBar`.
- Wire chip handlers:
  - `notifications` → `toggleNotificationCentre()`
  - `bookmarks` → `setBookmarksOpen(prev => !prev)` (call the existing toggle from `TerminalManager` via a callback prop, OR move the toggle setters into the store so `TerminalView` can call directly. Choose the store-setter approach for cleanliness; add `setBookmarksOpen` etc. to store.)
  - `workflows` → opens an `<AlertDialog>` with "Workflows arrive in Stage 7" copy.
  - `file-explorer` → `import { open } from '@tauri-apps/plugin-shell'; await open(card.cwd);`
  - `rich-input` → opens an `<AlertDialog>` with "Rich Input arrives in Stage 9" copy.
  - `remote-control` → `setSettingsOpen('bridge')` (existing tab).
- Render the bar at the bottom of focus mode only, behind a guard `if (!bottomBarHidden[card.id]) <BottomActionBar … />`.

**Step 4 — Run, verify pass.**

**Step 5 — Commit**

```bash
git add src/components/terminal/TerminalView.tsx src/stores/terminalStore.ts src/components/terminal/TerminalView.test.tsx
git commit -m "feat(stage6): mount BottomActionBar with chip handlers in focus mode"
```

---

## Task 11 — Settings toggle for chip strip

**Files:**
- Modify: `src/components/Settings.jsx` (or the existing tab file)
- Modify: `src/i18n/locales/*/terminal.json`

**Step 1** — Add a row in the existing Appearance settings tab: "Show chip strip at the bottom of focused cards" (default ON).

**Step 2** — Wire toggle to a new store action `setBottomBarHiddenForCard(cardId, hidden)`. (For v1 simplicity, the toggle is global, not per-card: a single boolean `bottomBarHidden` on the settings slice. Per-card override deferred to Stage 9 if requested.)

**Step 3 — Commit**

```bash
git add src/components/Settings.jsx src/i18n/locales/*/terminal.json src/stores/terminalStore.ts
git commit -m "feat(stage6): add Settings toggle for bottom chip strip"
```

---

## Task 12 — i18n keys for chip strip (4 locales)

| key | en | zh-CN | ja | ko |
|---|---|---|---|---|
| `bottomBar.notifications` | Notifications | 通知 | 通知 | 알림 |
| `bottomBar.bookmarks` | Bookmarks | 书签 | ブックマーク | 북마크 |
| `bottomBar.workflows` | Workflows | 工作流 | ワークフロー | 워크플로우 |
| `bottomBar.fileExplorer` | File explorer | 文件管理器 | ファイラー | 파일 탐색기 |
| `bottomBar.richInput` | Rich input | 富文本输入 | リッチ入力 | 리치 입력 |
| `bottomBar.remoteControl` | Remote control | 远程控制 | リモートコントロール | 원격 제어 |
| `bottomBar.overflow` | More | 更多 | その他 | 더 보기 |
| `bottomBar.workflowsComingSoon` | Workflows arrive in Stage 7. | 工作流将在 Stage 7 提供。 | ワークフローはステージ 7 で提供されます。 | 워크플로우는 Stage 7에서 제공됩니다. |
| `bottomBar.richInputComingSoon` | Rich input arrives in Stage 9. | 富文本输入将在 Stage 9 提供。 | リッチ入力はステージ 9 で提供されます。 | 리치 입력은 Stage 9에서 제공됩니다. |

**Commit:**

```bash
git add src/i18n/locales/*/terminal.json
git commit -m "feat(stage6): add bottomBar i18n keys (4 locales)"
```

---

## Task 13 — Verification + plan status

**Step 1 — Full verification matrix**

```bash
npm run typecheck
npx vitest run
npm run build
cd src-tauri && cargo check && cargo test
```

All must pass. If any fail, fix in place and re-commit before continuing.

**Step 2 — Update `IMPLEMENTATION_PLAN.md`**

Set Stage 6 status to `Complete` with a summary block matching the Stage 4/5 conventions:

```markdown
**Status**: Complete (Stage 6 batch 2026-05-02): 6.1 ai_explain Tauri command (one-shot tokio process spawn, 30s timeout, 8KB prompt cap) + explainWithAi frontend wrapper + aiThreadStore (in-memory, FIFO 20 entries) + AiThreadView (two-step Run-as-command) + BlockInspector wired to real provider invocation; 6.2 chipRegistry pure builder + BottomActionBar (ResizeObserver overflow + ArrowLeft/Right/Home/End/Enter keyboard nav) + 6 chips (notifications/bookmarks/workflows-placeholder/file-explorer/rich-input-placeholder/remote-control); persist v6→v7 with aiExplainDefaultProvider='claude' migration; 4-locale i18n parity for aiThread.* and bottomBar.*; settings toggle for chip strip visibility; typecheck/vitest/build/cargo check/cargo test all green.
```

**Step 3 — Commit**

```bash
git add IMPLEMENTATION_PLAN.md
git commit -m "docs: mark Stage 6 complete"
```

---

## Out of scope (deferred)

- Stage 6 does **not** implement: persistent AI thread storage (lost on app restart); AI thread export to markdown (Stage 8.3 will cover); per-card chip strip toggle (Stage 9 if needed); rich-input composer (Stage 9); Workflows runtime (Stage 7); inline xterm AI overlay (rejected per Decision 2); HTTP API path to providers (rejected per Decision 1).
- No new dependencies are added on the JS side; on the Rust side the only change is adding the `process` feature to the existing `tokio` crate.

---

## Rollback

Stage 6 is fully additive. To roll back: revert commits in reverse order; the only persistence-format change is bumping the store version to `7`, and the migration is forward-compatible — older snapshots simply pick up `aiExplainDefaultProvider: 'claude'`. No data migrations on the SQLite side. The Rust handler list grows by one entry; removing it doesn't break any other command.
