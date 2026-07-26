# Provider Session Catalog Performance Contracts

> Keep large provider histories searchable and complete without reading every
> transcript body before returning the first page.

---

## Scenario: Provider History Scans Stay Bounded on Large Catalogs

### 1. Scope / Trigger

- Trigger: changing Claude history discovery, metadata parsing, catalog
  pagination, or JSONL directory scanning.
- Applies to `src-tauri/src/provider_sessions.rs`,
  `src-tauri/src/agent_sessions/claude.rs`, and the
  `provider_list_agent_sessions` command path.
- The goal is to keep large histories usable without silently dropping older
  sessions or reading an entire large transcript on a Tokio request worker.

### 2. Signatures

- `parse_claude_session_meta(path: &Path) -> Option<(String, String)>`
- `jsonl_files_recent_first(root: &Path, since_ms: Option<u64>) -> Vec<SessionFileCandidate>`
- `list_claude_session_page_from_root(root, cursor, limit, query) -> AgentSessionPage`
- Metadata limits: 40 lines and `CLAUDE_META_PREFIX_MAX_BYTES = 256 KiB`.
- Catalog scan cap: `CLAUDE_FILES_SCANNED_PER_PAGE = 500`.

### 3. Contracts

- The compatibility metadata reader wraps `BufReader<File>` in
  `Read::take(CLAUDE_META_PREFIX_MAX_BYTES)` before iterating lines. A single
  malformed giant line must not allocate or read the rest of the transcript.
- A valid `sessionId` and `cwd` found inside the prefix keep their existing
  fallback behavior; metadata beyond the prefix is intentionally unavailable.
- Directory scanning may collect lightweight path and modification-time
  records for the complete catalog so cursors do not lose older sessions.
  It must not parse every transcript before returning the first page.
- Claude page loading parses only until the requested page is full or 500
  candidates have been examined. `next_cursor` is the next candidate offset,
  including candidates skipped as malformed or filtered by search.
- The public provider command runs Claude directory work in a blocking worker;
  do not move filesystem traversal back onto the async request worker.
- Parse cache entries remain bounded to 256 and are invalidated by mtime/TTL.

### 4. Validation & Error Matrix

| Condition | Result |
|-----------|--------|
| Header metadata appears inside 256 KiB | Return the same session id/cwd |
| First line exceeds 256 KiB | Return `None`; do not scan later metadata |
| 50 MiB file has a normal first-line header | Parse the header without reading the tail |
| 10,000 valid files, page size 25 | Return 25 items and cursor `25`; parse cache grows by 25 |
| Second page from cursor `25` | Return a disjoint 25 items and cursor `50` |
| Malformed or non-matching files within a page | Skip them and advance the cursor |
| Blocking task fails | Return the existing catalog error state |

### 5. Good/Base/Bad Cases

- Good: a 50 MiB transcript with normal header metadata is identified
  immediately while its body remains unread.
- Good: a 10,000-file directory returns page one after parsing only the 25
  sessions needed for that page.
- Base: a small catalog keeps the same ids, ordering, titles, previews, and
  cursor behavior.
- Bad: use `fs::read_to_string(path)` for metadata discovery.
- Bad: truncate the candidate list before cursor pagination and make older
  sessions unreachable.

### 6. Tests Required

- `parse_claude_session_meta_stops_after_finding_header_metadata` uses a real
  50 MiB logical-size fixture and asserts the header result.
- `parse_claude_session_meta_does_not_scan_past_prefix_budget` puts valid
  metadata beyond 256 KiB and asserts it is not read.
- `ten_thousand_file_catalog_pages_without_parsing_entire_directory` creates
  10,000 files, checks two disjoint pages, and asserts only 25 additional cache
  entries are parsed per page.
- Run provider/Claude targeted tests, full Cargo tests, Clippy with warnings
  denied, Rustfmt, and `git diff --check`.

### 7. Wrong vs Correct

Wrong:

```rust
for line in BufReader::new(file).lines().take(40) {
    // One line can still be tens of MiB.
}
```

Correct:

```rust
for line in BufReader::new(file)
    .take(CLAUDE_META_PREFIX_MAX_BYTES)
    .lines()
    .take(40)
{
    // Both line count and total bytes are bounded.
}
```
