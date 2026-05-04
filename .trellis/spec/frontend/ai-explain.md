# AI Explain

> Contracts for the Block Inspector "Explain with AI" path.

---

## Scenario: Block Inspector One-Shot Explain

### 1. Scope / Trigger

- Trigger: Any frontend feature that invokes an AI provider CLI to explain a
  selected terminal block.
- Applies to `src/lib/ai/aiExplain.ts`, Block Inspector explain UI, provider
  fallback selection in terminal views, and tests around the `ai_explain` Tauri
  command envelope.
- This is a cross-layer boundary: Rust returns raw CLI process output, while the
  frontend wrapper decides which responses are useful enough to render as
  successful AI thread entries.

### 2. Signatures

- Tauri command:
  `ai_explain(provider: AiExplainProvider, prompt: string): Promise<RawResult>`
- Frontend wrapper:
  `explainWithAi(args: { provider: AiExplainProvider; prompt: string }): Promise<AiExplainResult>`
- Raw result shape:
  `{ stdout: string; stderr: string; exit_code: number | null; timed_out: boolean }`
- UI entry store:
  `appendQuestion(blockId, prompt)` then `appendAnswer(blockId, text, provider, state)`

### 3. Contracts

- The prompt must be non-empty before invoking Tauri.
- The UI must show a pending user entry while the provider process is running.
- `timed_out === true` maps to an error result, regardless of stdout/stderr.
- `exit_code !== 0` maps to an error result. Prefer trimmed stderr as the error
  message; fall back to the exit code when stderr is empty.
- `exit_code === 0` with empty or whitespace-only stdout is still an error. A
  provider process that exits successfully but emits no final answer has not
  produced a useful explanation.
- Successful results returned from `explainWithAi` must contain trimmed,
  non-empty answer text.
- Shell cards must use the persisted `aiExplainDefaultProvider`; AI-provider
  cards may override that with their own terminal type.

### 4. Validation & Error Matrix

- Empty prompt -> error before invoking Tauri.
- Missing provider binary / spawn failure -> error entry with the thrown bridge
  message.
- Timeout -> error entry such as "AI provider timed out".
- Non-zero exit -> error entry with stderr or `provider exited with <code>`.
- Zero exit + empty stdout + stderr -> error entry that includes the stderr
  diagnostic.
- Zero exit + empty stdout + empty stderr -> error entry explaining that the AI
  provider returned no answer.
- Zero exit + non-empty stdout -> successful AI answer entry.

### 5. Good/Base/Bad Cases

- Good: Codex is selected as the default provider on a shell card, the provider
  emits a final answer, and Block Inspector renders that answer in the thread.
- Good: Codex exits 0 but prints only whitespace; the thread shows an error that
  the provider returned no answer, preserving stderr if available.
- Base: Claude or Gemini returns a normal answer through the same wrapper and
  receives identical success/error classification.
- Bad: rendering `"(empty response)"` as a successful AI answer after a provider
  emitted no stdout.
- Bad: silently swallowing a provider error so the user cannot tell whether the
  click did anything.

### 6. Tests Required

- Wrapper tests for success, empty prompt, non-zero exit, timeout behavior when
  mocked, and zero-exit empty stdout with and without stderr.
- Block Inspector component tests for pending UI, successful answer, non-zero
  error, zero-exit empty stdout error, and export after an error thread exists.
- Terminal view wiring tests proving shell cards fall back to
  `aiExplainDefaultProvider`, including Codex as a selected default provider.

### 7. Wrong vs Correct

Wrong:
```typescript
if (raw.exit_code === 0) {
  return { kind: 'ok', text: raw.stdout, stderr: raw.stderr };
}
```

Correct:
```typescript
if (raw.exit_code === 0) {
  const text = raw.stdout.trim();
  if (!text) {
    return { kind: 'error', message: 'AI provider returned no answer.', timedOut: false };
  }
  return { kind: 'ok', text, stderr: raw.stderr };
}
```

The correct version protects the UI and Markdown export from treating an empty
provider transcript as a useful AI explanation.
