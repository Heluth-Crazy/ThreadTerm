---
name: threadterm-terminal-host
description: Use a running ThreadTerm desktop through its local terminal-host MCP tools.
---

Call `terminal_host_status` first. This plugin is connect-only and must not be used to start or repair ThreadTerm. Use a stable request ID for every create and retry the same ID after an unknown outcome. Launch direct executables with args; explicitly choose a shell for scripts. `launch.cwd` is an existing absolute directory; an optional workspace placement `workspace_path` must canonicalize to the same directory, and window placement does not accept it.
