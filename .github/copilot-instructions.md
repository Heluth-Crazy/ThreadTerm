# Copilot Instructions for OpenWork

OpenWork is a desktop and web UI for Claude Code, Cursor CLI, and OpenAI Codex. It runs as both a web app (Express + Vite) and an Electron desktop app.

## Commands

```bash
npm run dev                    # Start Express backend + Vite frontend with hot reload
npm run server                 # Backend only (Express on PORT, default 3001)
npm run client                 # Frontend only (Vite on VITE_PORT, default 5173)
npm run build                  # Production build (Vite → dist/)
npm run typecheck              # TypeScript type checking (no emit)
npm run electron:dev           # Electron app in development mode
npm run build:mac              # macOS Electron build
npm run build:win              # Windows Electron build
npm run rebuild:native:node    # Rebuild native modules (node-pty, better-sqlite3) for Node
npm run rebuild:native:electron # Rebuild native modules for Electron
```

There is no test command — there are no automated tests in this project.

## Architecture

### Three-Layer System

| Layer | Directory | Language | Module System |
|-------|-----------|----------|---------------|
| Frontend | `src/` | TypeScript/JSX hybrid (React 18 + Vite + Tailwind) | ESM |
| Backend | `server/` | JavaScript only | ESM (`"type": "module"`) |
| Electron | `electron/` | JavaScript (`.cjs` extension) | CommonJS |

**Do not use TypeScript in `server/` or `.cjs` format in `electron/` — the module systems are incompatible.**

### Frontend Entry Chain

```
src/main.jsx → src/App.tsx → src/components/app/AppContent.tsx
```

Context providers wrap the app in this order (App.tsx):
```
I18nextProvider → ThemeProvider → AuthProvider → WebSocketProvider → TasksSettingsProvider → TaskMasterProvider → Router
```

### Component Structure Pattern

Feature components follow this directory pattern:
```
src/components/<feature>/
  view/    # React component files
  hooks/   # Custom hooks for this feature
  types/   # TypeScript type definitions
  utils/   # Feature-specific utilities
```

Examples: `sidebar/`, `main-content/`, `terminal-grid/`

### Backend Structure

- **`server/index.js`** — Express + WebSocket server on the same HTTP server
- **`server/routes/`** — Route handlers: `agent`, `auth`, `cli-auth`, `cli-discovery`, `codex`, `commands`, `cursor`, `git`, `mcp`, `projects`, `settings`, `taskmaster`, `user`
- **`server/claude-sdk.js`** — Claude integration via `@anthropic-ai/claude-agent-sdk`
- **`server/openai-codex.js`** — Codex integration via `@openai/codex-sdk`
- **`server/cursor-cli.js`** — Cursor CLI integration
- **`server/database/db.js`** — better-sqlite3; schema in `server/database/init.sql`
- **`shared/modelConstants.js`** — Model definitions imported by both frontend and backend

### Communication Flow

- Frontend ↔ Backend: REST (`/api/*`) + WebSocket (`/ws` for chat/events, `/shell` for terminal PTY)
- In dev mode, Vite proxies `/api`, `/ws`, `/shell` to the Express backend
- In Electron, the backend is embedded and started by `electron/main.cjs`
- WebSocket messages use a type-based dispatch pattern: `{ type: 'claude-response', ... }`

Key WebSocket message types: `session-created`, `claude-response`, `codex-response`, `claude-complete`, `codex-complete`, `claude-error`, `codex-error`, `claude-permission-request`, `token-budget`, `session-aborted`

## Key Conventions

### File Extensions

- `src/` — use `.tsx` for new components (`.jsx` exists for older ones), `.ts` for non-component TypeScript
- `server/` — `.js` only (ESM)
- `electron/` — `.cjs` only (CommonJS required by Electron)

### Styling

- Tailwind with CSS custom properties (HSL): always use `hsl(var(--color-name))` format
- Dark mode via Tailwind `class` strategy (not `media`)
- CSS variables defined in `src/index.css`
- UI primitives in `src/components/ui/` using `class-variance-authority` + `tailwind-merge`

### Internationalization

All user-facing strings must go through `react-i18next`. Locales live in `src/i18n/locales/` (en, ko, zh-CN, ja). Namespaces: `common`, `settings`, `auth`, `sidebar`, `chat`, `codeEditor`, `tasks`.

### Model Constants

Never hardcode model names. Use `shared/modelConstants.js`. Note that Claude uses two formats:
- SDK format (`'sonnet'`, `'opus'`) — used by the UI and `claude-sdk.js`
- API format (`'claude-sonnet-4.5'`) — used by slash commands for display

### Commit Convention

Follow [Conventional Commits](https://conventionalcommits.org/):
```
<type>(optional scope): <description>
```
Types: `feat`, `fix`, `perf`, `refactor`, `docs`, `style`, `chore`, `ci`, `test`, `build`

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3001` | Backend port |
| `VITE_PORT` | `5173` | Frontend dev server port |
| `HOST` | `0.0.0.0` | Bind address |
| `DATABASE_PATH` | — | Custom SQLite location |
| `CLAUDE_CLI_PATH` | — | Custom Claude CLI binary path |
| `CONTEXT_WINDOW` / `VITE_CONTEXT_WINDOW` | — | Max tokens per session |
| `VITE_IS_PLATFORM` | — | Platform/hosted mode toggle |

## Prerequisites

- Node.js 22 or later (`.nvmrc` specifies `v22`)
- Claude Code CLI installed and configured
