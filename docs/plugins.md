# ThreadTerm agent plugins

ThreadTerm plugins let an agent author add a terminal command and, optionally, an ACP Chat agent without changing ThreadTerm. A version 1 plugin is declarative: it is a folder containing `threadterm-plugin.json`, an optional SVG icon, and any files launched by its command. ThreadTerm does not load plugin JavaScript, Rust, or UI code.

Version 1 supports `agents` and `browserBindings`. An agent can provide a terminal command and, optionally, ACP Chat. A browser binding declares a supported external-tool transport for ThreadTerm-owned local preview tools; it cannot provide executable hooks, renderer IPC, approval policy, or credentials. Future releases may add declarative contribution types such as themes, terminal profiles, prompts, model prices, MCP server definitions, and file viewers. Executable code, panels, commands, settings sections, a marketplace, signing, and distribution are not part of version 1.

## Folder layout

Each immediate child folder of a plugin directory is one plugin:

```text
plugins/
  my-agent/
    threadterm-plugin.json
    icon.svg
    agent.mjs
```

ThreadTerm scans its data directory at `plugins/*`, and also every directory in `THREADTERM_V3_PLUGIN_DIRS`. The environment variable uses the operating system path-list separator (`;` on Windows, `:` on macOS and Linux); each entry contains plugin folders, rather than being a plugin folder itself. It is intended for development and QA.

Bundled plugins ship with ThreadTerm and start enabled. User plugins start disabled. In Settings → Plugins, review every command line a plugin can run, enable only plugins you trust, then choose Reload after changing plugin files.

## Manifest reference

The following complete manifest describes the Echo example:

```json
{
  "schemaVersion": 1,
  "id": "echo-acp",
  "name": "Echo (ACP example)",
  "version": "0.1.0",
  "publisher": "ThreadTerm",
  "description": "A tiny ACP agent that echoes your messages.",
  "homepage": "https://example.invalid/echo",
  "contributes": {
    "agents": [{
      "id": "echo",
      "name": "Echo",
      "icon": "icon.svg",
      "command": "node",
      "args": ["{pluginDir}/agent.mjs"],
      "versionArgs": ["--version"],
      "terminal": { "args": [], "resumeArgs": ["--resume", "{sessionId}"] },
      "chat": { "protocol": "acp", "args": ["--acp"] },
      "signIn": { "args": ["login"] },
      "homepage": "https://example.invalid/echo"
    }]
  }
}
```

Top-level fields are:

| Field | Required | Meaning |
| --- | --- | --- |
| `schemaVersion` | yes | Must be `1`. A future schema version is rejected. |
| `id` | yes | Plugin identifier, matching `^[a-z0-9][a-z0-9.-]{1,63}$`. |
| `name` | yes | Plugin display name, at most 60 characters. |
| `version` | yes | Plugin version displayed in Settings. |
| `publisher` | no | Publisher displayed in Settings. |
| `description` | no | Description, at most 500 characters. |
| `homepage` | no | Plugin homepage. An agent may override it. |
| `contributes.agents` | no | One to eight agent declarations. |
| `contributes.browserBindings` | no | One to eight preview-tool bindings. A plugin must have at least one valid agent or browser binding. |

Unknown top-level fields are ignored. An unknown `contributes` type produces a visible “not supported by this ThreadTerm” issue, but valid `agents` in the same plugin still load. A malformed manifest or unsupported schema contributes no agents.

### Browser bindings

`browserBindings` is a declarative contract for ThreadTerm's preview capability. It is available only through the `mcp-stdio` transport. The runtime owns the two tool implementations, grants, approval behavior, and target selection; a plugin merely identifies a compatible provider and workflow.

```json
{
  "id": "example-preview",
  "bindingVersion": 1,
  "providerId": "example",
  "requires": { "threadterm.preview": 1 },
  "transport": "mcp-stdio",
  "tools": ["preview_present", "preview_status"],
  "workflow": "threadterm.preview.after-server-ready.v1"
}
```

Every field in that example is required. `id` matches the plugin-id pattern; `providerId` matches the agent-id pattern. Version 1 accepts only `bindingVersion: 1`, exactly `{ "threadterm.preview": 1 }`, `mcp-stdio`, exactly the two listed tools, and the listed workflow identifier. Invalid bindings are reported in Settings and do not prevent valid agent contributions from loading.

A binding-only plugin is valid. Bundled bindings are enabled by default; user bindings remain disabled until the user enables the containing plugin. A single enabled compatible binding activates automatically. When several enabled bindings target the same provider and transport, ThreadTerm reports a conflict until exactly one binding is selected in its persisted plugin settings. It never chooses by folder order. Disabling a plugin immediately makes its binding unavailable for future browser grants; saved pages remain ordinary user workspace content.

Each agent declaration has these fields:

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Registry-wide agent identifier matching `^[a-z][a-z0-9-]{1,31}$`. It must not be a built-in id or `shell`, `custom`, or `threadterm`. |
| `name` | yes | Agent display name, at most 60 characters. |
| `command` | yes | A non-empty, whitespace-free bare executable resolved from `PATH`, or `{pluginDir}/` followed by a relative executable inside the plugin folder. |
| `args` | no | Base command arguments. Defaults to `[]`. |
| `versionArgs` | no | Arguments appended for an installation/version probe. Defaults to `["--version"]`. |
| `terminal` | no | Terminal support. Omit it for the base command, or use `false` to disable terminal mode. |
| `terminal.args` | no | Arguments appended when starting a terminal session. Defaults to `[]`. |
| `terminal.resumeArgs` | no | Arguments appended while resuming a native session. Defaults to `[]`; when non-empty, it contains exactly one `{sessionId}`. |
| `chat` | no | Chat support. In version 1 it must be `{ "protocol": "acp", "args": [...] }`; `args` defaults to `[]`. Omit it for a terminal-only agent. |
| `signIn` | no | `{ "args": [...] }` for the sign-in command exposed in Settings; `args` defaults to `[]`. |
| `icon` | no | Path to an SVG inside the plugin folder. ThreadTerm serves it as a data URL. |
| `homepage` | no | Agent homepage, overriding the plugin homepage. |

ThreadTerm builds commands in this order:

```text
base command       = command + args
version probe      = base command + versionArgs
terminal launch    = base command + terminal.args
terminal resume    = terminal launch + terminal.resumeArgs
ACP Chat launch    = base command + chat.args
sign-in launch     = base command + signIn.args
```

`{pluginDir}` expands to the absolute plugin folder in `command` and in any argument, including a value such as `--directory={pluginDir}/output`. Argument values are ordinary CLI values and do not need to exist. `{sessionId}` is permitted only in `terminal.resumeArgs`; when resume arguments are present, it appears exactly once and ThreadTerm validates its value before launch. `command` cannot be an absolute path, contain `..`, or escape the plugin folder after canonicalisation. A plugin-relative command must exist inside that folder. No other placeholders are accepted. There are no plugin-defined environment variables in version 1; child processes inherit ThreadTerm’s environment.

Manifests and SVG icons are each limited to 64 KiB. Icons must have a `.svg` extension and resolve within the plugin folder. Every argument list has at most 32 values, each at most 512 characters, and arguments cannot contain control characters. ThreadTerm scans at most 64 user-plugin folders in total across its data directory and every development root; the bundled Gemini plugin is compiled separately. Agent ids must be unique across the registry: built-ins win; then plugins are considered in plugin-id order and the losing plugin receives an issue. Invalid plugins never prevent ThreadTerm or other plugins from starting.

## Trust model

A plugin can run the command lines in its manifest with your account, files, network access, and inherited environment. ThreadTerm validates paths and manifest structure, but it does not sandbox an executable or verify a publisher. Read the displayed commands and source, use a development directory only for code you control, and enable a plugin only when you trust it. Disabling a plugin removes its agents from new sessions and pickers; existing running chats remain alive until they finish.

## ACP Chat support

ThreadTerm starts the Chat command as newline-delimited JSON-RPC 2.0. It calls `initialize`, sends the `initialized` notification, then uses `session/new` for new chats or `session/load` (falling back to `session/resume` when advertised) for resumed chats. It sends `session/prompt`, `session/cancel`, and reads `session/update` notifications. For history it calls `session/list` and `session/load` in a temporary ACP process.

Return `agentCapabilities.sessionCapabilities.list` and `.load` from `initialize` when those methods are implemented. A `session/prompt` response should include `{ "stopReason": "end_turn" }`; stream text with this notification shape:

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "native-session-id",
    "update": {
      "sessionUpdate": "agent_message_chunk",
      "content": { "type": "text", "text": "Reply text" }
    }
  }
}
```

On `session/load`, replay user and agent text as `user_message_chunk` and `agent_message_chunk` updates before returning the session id. Session-list rows should include `sessionId`; `title`, `cwd`, and `updatedAt` make the history picker more useful. Keep native session identifiers stable and validate them before using them as file names or paths.

ACP agents can also expose optional runtime UI and approval support:

- To request user approval, send a JSON-RPC request (with an `id`) named `session/request_permission`. Include `sessionId` and `options`, where each option has an `optionId`, `name`, and an ACP permission `kind`. ThreadTerm displays those choices and responds to the request with `{ "outcome": { "outcome": "selected", "optionId": "..." } }`.
- To expose selectable settings, return `configOptions` from `session/new` or `session/load`, or send a `session/update` whose `sessionUpdate` is `config_options_update`. Each option uses `configId`, `name`, `currentValue`, and an optional `options` array of `{ "value", "name" }` values. ThreadTerm calls `session/set_config_option` with `sessionId`, `configId`, and `value`, and uses the returned configuration as authoritative.
- For compatibility with older ACP agents, if `session/set_config_option` returns JSON-RPC error `-32601` for the `model` option only, ThreadTerm calls `session/set_model` with `sessionId` and `modelId`. Do not rely on that fallback for other setting ids or errors.
- To update slash-command UI, send a `session/update` whose `sessionUpdate` is `available_commands_update` and whose `availableCommands` entries provide `name` (with or without a leading `/`) and an optional `description`.

## Echo walkthrough

[`examples/plugins/echo-acp`](../examples/plugins/echo-acp) is a dependency-free Node example. It provides a terminal REPL, ACP Chat, list/load history, terminal `--resume`, and a `login` command that explains no sign-in is needed. ACP history is stored outside the plugin directory, under a path derived from the installed plugin location in the OS temporary directory. Set `THREADTERM_ECHO_STORE_DIR` to an isolated directory when testing it.

To try it in development, point ThreadTerm at the example’s parent directory, start the app, open Settings → Plugins, select Reload, and enable “Echo (ACP example)”. On PowerShell:

```powershell
$env:THREADTERM_V3_PLUGIN_DIRS = (Resolve-Path examples/plugins)
# Start ThreadTerm from this shell, then use Settings → Plugins → Reload.
```

Check the command directly before opening the app:

```powershell
node examples/plugins/echo-acp/agent.mjs --version
node examples/plugins/echo-acp/agent.mjs
```

For ACP testing, write JSON-RPC lines to `node examples/plugins/echo-acp/agent.mjs --acp`. Start with `initialize`, then `session/new`, `session/prompt`, `session/list`, and `session/load`. The example has no dependencies and is intended as a protocol reference, not a production-quality persistence implementation.
