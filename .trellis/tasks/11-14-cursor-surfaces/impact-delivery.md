# Delivery impact record

2026-11-14

- `FileCommentsHost` — 82 known consumers, including page/file review surfaces and `SessionWorkspace`. Risk: adding an optional `send` member is backwards compatible; only Design Mode invokes it.
- `SessionWorkspace` — callers: `App` / `MachineApp`. Risk: its comments host must only submit the visible receiver after the established insertion routine opens and focuses it.
- `registerChatInputTarget` / `ChatView` — ChatView and fixture/probe consumers. Risk: `submitChat` calls the same registered composer submit function, preserving existing normal-versus-queued follow-up behavior.
- `formatReviewComments` — multiple file/review/browser consumers. No behavior change made here; design delivery uses this existing formatter so page context remains one delivery path.

Commands run from the indexed checkout before edits:

```
codegraph impact SessionWorkspace -d 2
codegraph impact formatReviewComments -d 2
codegraph impact FileCommentsHost -d 2
codegraph impact registerChatInputTarget -d 2
codegraph impact ChatView -d 2
```

Validation: bundled `renderer/src/pageComments.test.ts` through the local esbuild binary and Node test runner: 18/18 passing, including computed styles, multi-pick, CSS edit, and text edit formatter coverage. Renderer typecheck was also run; concurrent work-in-progress references (`DesignNoteCard` and `mockBridge.inspectPageTarget`) prevent a clean whole-tree result at this checkpoint.

Follow-up validation: `node --test qa/design-delivery.test.mjs` passes 3/3: one batched send and release, failed send retains notes, and To chat only inserts. `npm run typecheck:renderer` later reached only a concurrent `PageComments.tsx` incomplete-reference error.

Final follow-up: `ChatMessageImages` impact was reviewed before adding a reusable requested-attachment API. Design-note chips now use that API for both inline images and persisted image references, so the existing `chat.image.read` validation path loads a referenced screenshot before the viewer opens. `npm run typecheck:renderer` passes; page comments 18/18, delivery 3/3, and design-chip parser 2/2 pass.

Final integration supersedes provisional validation notes above: check:fast passes all 13 stages; delivery QA is 6/6, chip parser and local/remote promotion tests pass. Sent screenshots now use the existing durable attachment store and the native 5-note test verifies every chip after transient captures are removed/reload. Accepted receipts are full canonical per-note tuples (not hashes), preserving cleanup-only retries for a partially released batch. Dedicated send/queue acceptance is terminal even if the view changes afterward.
