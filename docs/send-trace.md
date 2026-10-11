# Chat send trace

Set `THREADTERM_V3_SEND_TRACE=1` before launching ThreadTerm to append diagnostic JSON Lines records for `chat.send` and `chat.draft.save`. Every other value, including `true`, leaves the trace disabled.

The packaged desktop and runtime append to the existing `runtime.log` in the active V3 data directory. An explicit `THREADTERM_V3_DATA` selects that directory. Otherwise ThreadTerm follows `runtime-data-root.json` under Electron's user-data directory, then falls back to `%LOCALAPPDATA%\ThreadTermV3` (or the platform app-data directory when `LOCALAPPDATA` is unavailable).

Trace records use `kind: "threadterm.sendTrace"` and `schema: 1`. Correlate stages with `requestId`, `operationId`, and `sessionId`. IDs are limited to 128 ASCII letters, digits, `.`, `:`, `_`, and `-`; prompts, paths, command arguments, provider output, and file content are never recorded. `step`, `method`, and `outcome` come from fixed enumerations in the runtime.

`monotonicUs` is local to the process that emitted the record. Sort desktop records against other desktop records and runtime records against other runtime records. Never subtract a desktop `monotonicUs` value from a runtime value. Use the correlation IDs to join the two streams, and use `durationUs` or `queueWaitUs` for elapsed time.

The desktop writer is asynchronous and bounded to 256 pending records. When the queue is full or the log cannot be resolved or written, it drops diagnostic records without delaying or failing the request. A scope-exit stage such as `service.chat_send.end` has no outcome; `transport.dispatch.end`, persistence stages, provider handoff, native stdin write, and Git exit stages carry the authoritative outcome where available.

`review.checkpoint.end` with outcome `recorded` means a checkpoint row was persisted; it does not prove the baseline is ready. Read the checkpoint's canonical status before claiming successful capture. Older trace builds used the misleading label `captured` for this same persistence result.

Run the offline Windows acceptance QA against a freshly built runtime twice:

```powershell
node qa/send-trace-windows.mjs --disabled --runtime runtime/target-send-trace/release/threadterm-v3-runtime.exe
node qa/send-trace-windows.mjs --enabled --runtime runtime/target-send-trace/release/threadterm-v3-runtime.exe
```

The QA uses a local fake Codex app-server. It covers a non-Git directory, a deliberately held Git checkpoint, ordered-lane active-ahead metadata, queue-wait timing, and the disabled-by-default contract without making a provider turn.
