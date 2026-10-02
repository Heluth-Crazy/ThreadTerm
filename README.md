# ThreadTerm

ThreadTerm is an Electron desktop application with a React/TypeScript interface
and a Rust runtime. All commands below run from the repository root.

## Development

Use Node.js 22 (see `.nvmrc`) and the Rust toolchain. On Windows, Rust also needs
the MSVC build tools.

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
npm run typecheck
npm run build
npm run build:runtime
npm run test:protocol
npm run test:desktop
```

Create a Windows installer with `npm run dist:win`.

See [ARCHITECTURE.md](ARCHITECTURE.md) and [REQUIREMENTS.md](REQUIREMENTS.md) for
the application contracts. The historical V3 package names, executable names,
and data namespace remain stable so existing sessions and settings stay usable.
