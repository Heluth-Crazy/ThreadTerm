# ThreadTerm

ThreadTerm is an Electron desktop application with a React/TypeScript interface
and a Rust runtime. All commands below run from the repository root.

## Development

Use Node.js 22 (see `.nvmrc`) and the Rust toolchain. On Windows, Rust also needs
the MSVC build tools.
Committing selected files requires Git 2.36 or newer; install or update it from [git-scm.com](https://git-scm.com), then restart ThreadTerm.

```powershell
npm install
npm run dev
```

## Project layout

| Directory | Purpose |
| --- | --- |
| `desktop/` | Electron main process, preload, and installer configuration |
| `renderer/` | React interface |
| `runtime/` | Rust runtime and MCP executable |
| `protocol/` | Shared contracts, schemas, and validators |
| `providers/` | Provider sidecars, including the Claude SDK host |
| `qa/` | Tests and isolated integration checks |
| `reference/` | Preserved prototype and design references |

`package.json` manages the npm workspaces. Build outputs such as `desktop-dist/`,
`runtime/target/`, and `release/` are ignored by Git.

## Build and check

```powershell
npm run check:fast   # protocol freshness, typechecks and every test except the Rust runtime
npm run check        # the full gate: the same steps plus cargo test
npm run build
npm run build:runtime
```

Both gates verify the committed tree (HEAD) by default so uncommitted scratch files cannot change the verdict; add
`-- --working-tree` to verify the edits you are about to commit. Before committing: `npm run check:fast -- --working-tree`;
before packaging or after runtime changes: `npm run check`.

Create a Windows installer with `npm run dist:win`. It runs the full gate first and stops on failure; the only escape
hatch is `THREADTERM_SKIP_CHECK=1`, which prints a loud warning.

See [ARCHITECTURE.md](ARCHITECTURE.md) and [REQUIREMENTS.md](REQUIREMENTS.md) for
the application contracts. The historical V3 package names, executable names,
and data namespace remain stable so existing sessions and settings stay usable.
