# Agent browser preview bindings

ThreadTerm owns the browser surface, scoped tool host and page-comment routing. Plugins declare which compatible agent receives the tools; they do not load browser-driver code into the application. The bundled Codex binding is enabled by default. User plugins remain opt-in. See [plugin installation and manifest reference](plugins.md).

## A complete binding-only plugin

Save this manifest as `threadterm-plugin.json` inside a user plugin folder. Target a provider with a supported MCP handoff. Codex, Claude, Kimi, Grok, Gemini and enabled ACP plugin agents have that transport; a terminal-only agent or an unsupported adapter cannot gain it through a manifest declaration.

```json
{
  "schemaVersion": 1,
  "id": "example-preview",
  "name": "Example local preview",
  "version": "1.0.0",
  "contributes": {
    "browserBindings": [{
      "id": "example-codex-preview",
      "bindingVersion": 1,
      "providerId": "codex",
      "requires": { "threadterm.preview": 1 },
      "transport": "mcp-stdio",
      "tools": ["preview_present", "preview_status"],
      "workflow": "threadterm.preview.after-server-ready.v1"
    }]
  }
}
```

This example competes with the bundled Codex binding. Enable it and explicitly select the desired binding in Settings → Plugins. A unique eligible binding is selected automatically; multiple candidates never use folder-order precedence. Selection or updates apply at the next provider open. Disabling a plugin immediately revokes its current preview authority; reenabling does not restore an old grant.

## Tool contract

```text
preview_present({ requestId: string, url: string, title?: string })
preview_status({ requestId: string })
```

Request IDs are nonempty, control-character-free strings of at most 256 UTF-8 bytes. Initial URLs must be HTTP(S) loopback addresses without embedded credentials, up to 8192 bytes. Titles are optional, at most 512 bytes. Arguments accept no session/window/credential fields: the runtime supplies identity. Unsupported arguments are rejected.

The agent starts its development server and verifies the intended URL with its available tools before presenting it. Instructions are guidance, not a server-readiness test. `preview_status` reads a recorded request and does not navigate or retry it. Use status after a pending result or a user request, without idle polling.

The MCP result uses standard text content containing JSON and `isError`. A successful operation has this shape:

```json
{
  "requestId": "checkout-preview-1",
  "previewId": "runtime-generated-id",
  "state": "presented",
  "sequence": 2,
  "navigation": "load_observed",
  "applicationReady": "unknown",
  "contentVerified": false,
  "documentGeneration": 1
}
```

`state` is `accepted`, `presented`, `closed`, `failed`, `unavailable` or `interrupted`. `accepted` means queued; `presented` requires a saved tab and mounted browser beside its owning Chat. The renderer waits for the main process to create the native view and confirm its visible placeholder; it does not wait for the document to finish loading. Navigation observations report that later result separately. `navigation` is `not_started`, `pending`, `load_observed` or `failed`. A native-page load event does not establish application readiness or verified content. Optional `observedUrl` and `observedTitle` reflect an actual document observation, never a guess from the configured address. Known failures include an `error` object with `code`, `message` and `retryable`.

Identical retries within the same provider open return the existing operation. Changed payloads with the same ID are rejected. Closing a tab does not permit an old request to reopen it; a new explicit request is required. Each provider open has bounded request capacity; hitting that limit is an explicit error, not eviction followed by unintended replay. UI detach interrupts pending work without destroying a running Chat. Reattachment admits future explicit calls but never automatically replays old navigation.

## Browser tabs and comments

An existing eligible browser pane receives another page tab without consuming an additional workspace pane. Creating a missing browser pane respects the four-pane limit and preserves the owning Chat. Manual pages and other tabs remain intact. Distinct sessions do not share ownership solely because their URLs match.

Agent-created tabs have a separate runtime association. Ordinary web `ContentRef` records save the current HTTP(S) URL and an optional page title; titles have control characters stripped and are limited to 512 UTF-8 bytes. Navigating to `about:blank` or a page-minted `blob:` URL keeps the last saved HTTP(S) URL and title for restart. Page comments retain their source preview, session and document/navigation context. Adding comments to their owner requires no confirmation. Choosing another session, including one using the same provider, requires a source/destination confirmation. The action adds to that session's draft and does not send a model message. Cancellation or failure retains the pending comments and screenshots. Confirmed transfer retains source provenance and does not reassign page ownership. Manual and legacy comments require an explicit destination when their owner is unknown.

## Public conformance fixtures

[The ACP preview fixture](../qa/fixtures/browser-plugins/threadterm-plugin.json) contributes a normal ACP agent plus the same browser binding. Its agent reads the standard `mcpServers` entries from `session/new` or `session/load`, launches the supplied stdio host and calls the public tools. It requires no core provider-ID special case.

After rebuilding runtime/MCP and the desktop, run the isolated actual-app acceptance harness:

```powershell
cargo build --manifest-path runtime/Cargo.toml -j 2 --bins
npm run build
node qa/agent-browser-plugins.mjs
```

The harness uses deterministic providers, isolated profiles and a local test server, without live model turns. The runtime's unit suite separately exercises caller/generation fencing, duplicate operations, revoked queued requests, missing UI, reconnect and truthful navigation state.

## Stage 1 browser surface

Presented pages now use a native `WebContentsView` over a renderer placeholder instead of an iframe. Pages that send `X-Frame-Options: DENY` or `Content-Security-Policy: frame-ancestors 'none'` can therefore render. A persistent browser-only profile retains its cookies and storage across app restarts; it is separate from the app profile.

The page has no preload or app IPC and is sandboxed with web security enabled. Stage 1 allows HTTP(S), `about:blank`, and page-minted `blob:` top-level pages; it refuses other schemes with an in-tab explanation. User-gesture popups open an adjacent browser tab. Downloads use the browser profile's Downloads destination and do not auto-open.

The native page paints above renderer DOM. While an app menu, dialog, Quick Open, or another overlay is open, ThreadTerm captures the attached page and loads the still image into the placeholder before detaching the native view. The renderer acknowledges image readiness with a capture generation; late captures or acknowledgements cannot detach a page after its overlay closes, its tab hides, or a newer capture starts. Passive notices use this same path only when they intersect a page. Repeated overlap checks keep the current capture rather than starting another. The native page is restored after the final overlay closes. The stage also owns the browser toolbar, persistent page tabs, find, zoom, idle unload, and page-comment integration.

When a navigation is cancelled or becomes a download, the stopped page retains Chromium's current document URL rather than the attempted destination. Idle unload and LRU eviction preserve that URL and the title; showing the tab creates a new view, loads its saved URL, and reports a fresh `pending` → `load_observed` transition. Native history is not preserved across unloading.

Stage 1 does not include page data handoff to Chat, agent sharing or actions, console access, CDP, screenshots as agent tools, dev-server detection, device emulation, per-project profiles, or certificate bypass.

After building the runtime and desktop, run the native browser acceptance harness:

```powershell
cargo build --manifest-path runtime/Cargo.toml -j 2 --bins
npm run build
node qa/browser-view-visual.mjs
```
