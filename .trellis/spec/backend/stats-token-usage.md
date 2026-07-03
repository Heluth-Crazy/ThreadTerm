# Stats Token Usage

<spec-entry category="contract" keywords="stats,token-usage,usage-records,parser-version,codex,claude,frontend-payload" date="2026-07-03" source="src-tauri/src/stats/types.rs:12">

## Scenario: Token Usage Aggregation Payload

### 1. Scope / Trigger
- Trigger: Any change to token usage ingestion, `usage_records` aggregation,
  parser-version rebuild behavior, or the stats payload consumed by the
  frontend.
- Applies to `src-tauri/src/stats/**`, `src/types/stats.ts`,
  `src/components/stats/StatsPanel.tsx`, and stats store tests.

### 2. Signatures
- Rust usage shape: `UsageSummary { input, output, cache_creation, cache_read }`
- Rust aggregate payload: `AgentStats { total_tokens, input_output_tokens, cache_tokens, total_cost_usd, total_calls, session_count, usage, by_model, by_project, by_session }`
- Rust bucket payload: `StatBucket { key, label, usage, total_tokens, input_output_tokens, cache_tokens, cost_usd, calls }`
- TypeScript mirrors: `AgentStats` and `StatBucket` in `src/types/stats.ts`
- Parser rebuild gate: `STATS_PARSER_VERSION` in `src-tauri/src/stats/sync.rs`

### 3. Contracts
- `total_tokens` is the real total: `input + output + cache_creation + cache_read`.
- `input_output_tokens` is only `input + output`.
- `cache_tokens` is only `cache_creation + cache_read`.
- Codex rows are stored with `input` already normalized to fresh input; do not
  subtract cache-read tokens again during aggregation.
- Parser fixes that change stored rows must bump `STATS_PARSER_VERSION` so
  `usage_records` and `session_log_sync` are rebuilt on the next stats scan.
- Missing Codex model names must be serialized as `"unknown"`, not an empty
  bucket key.

### 4. Validation & Error Matrix
- Parser version matches stored version -> keep existing rows and sync cursors.
- Parser version differs -> delete `usage_records` and `session_log_sync`, then
  re-ingest from current parser logic.
- Missing Codex model -> bucket under `"unknown"`.
- Duplicate cumulative Codex token snapshot -> zero delta, no row.
- Existing frontend payload consumer without the new fields -> typecheck must
  fail until fixtures/types are updated.

### 5. Good/Base/Bad Cases
- Good: Stats panel shows real tokens plus the input/output and cache split.
- Good: A parser accuracy fix bumps `STATS_PARSER_VERSION` and has a regression
  test for the affected log shape.
- Base: Cost remains based on the local pricing table and may differ from other
  tools with different pricing data.
- Bad: Reusing `total_tokens` to mean `input + output` in one component while
  backend emits real total.
- Bad: Advancing `session_log_sync` after a parser bug without a later version
  bump, because missed rows remain frozen.

### 6. Tests Required
- Rust aggregate test asserting `total_tokens`, `input_output_tokens`, and
  `cache_tokens` for rows with cache.
- Rust parser test for legacy Codex token-count logs with duplicate cumulative
  snapshots and missing model.
- Rust sync test for parser-version rebuild behavior.
- Frontend typecheck plus StatsPanel rendering test for the split token totals.
- Locale JSON validation when new stats labels are added.

### 7. Wrong vs Correct

Wrong:
```rust
let total_tokens = usage.input + usage.output;
```

Correct:
```rust
let total_tokens = usage.total();
let input_output_tokens = usage.input_output_tokens();
let cache_tokens = usage.cache_tokens();
```

Wrong:
```rust
let codex_input = row.input_tokens.saturating_sub(row.cache_read_tokens);
```

Correct:
```rust
let codex_input = row.input_tokens;
```

</spec-entry>
