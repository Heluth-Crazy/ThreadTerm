# Development Guide

This guide covers setting up a local development environment for OpenWork.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Project Setup](#project-setup)
- [Running the Application](#running-the-application)
- [Development Workflow](#development-workflow)
- [Project Structure](#project-structure)
- [Testing](#testing)
- [Code Style](#code-style)

---

## Prerequisites

### Required Software

| Software | Version | Notes |
|----------|---------|-------|
| Node.js | v22+ | LTS recommended |
| npm | v10+ | Comes with Node.js |
| Git | any | For version control |
| Claude Code CLI | latest | For testing integrations |

### Additional Requirements for Building

| Platform | Requirements |
|----------|--------------|
| macOS | Xcode Command Line Tools |
| Windows | Visual Studio Build Tools with C++ workload |

### Installing macOS Command Line Tools

```bash
# Install Xcode Command Line Tools
xcode-select --install

# Verify installation
xcode-select -p
```

### Installing Windows Build Tools

```powershell
# Using winget
winget install Microsoft.VisualStudio.2022.BuildTools

# During installation, select:
# - "Desktop development with C++"
# - "Node.js development" (optional)
```

---

## Project Setup

### 1. Clone the Repository

```bash
# Clone the repository
git clone https://source.example.com/openwork/openwork.git
cd openwork
```

### 2. Install Dependencies

```bash
# Install all dependencies
npm install
```

This will:
- Install Node.js dependencies
- Rebuild native modules (sqlite3, node-pty)
- Configure the project

### 3. Configure Environment

```bash
# Copy environment configuration
cp .env.example .env

# Edit with your preferred settings
nano .env
```

### 4. Verify Setup

```bash
# Check that everything is properly installed
npm run typecheck
```

---

## Running the Application

### Development Mode (Recommended)

Run both frontend and backend with hot reload:

```bash
npm run dev
```

This starts:
- Frontend: `http://localhost:5173` (Vite)
- Backend: `http://localhost:3001` (Express + WebSocket)

### Run Components Separately

**Backend Only:**

```bash
npm run server
```

**Frontend Only:**

```bash
npm run client
```

### Production Build

```bash
# Build the frontend
npm run build

# Start the production server
npm run start
```

---

## Development Workflow

### Recommended Workflow

1. **Start development server:**
   ```bash
   npm run dev
   ```

2. **Make changes** in the `src/` or `server/` directories

3. **Frontend changes** are hot-reloaded automatically

4. **Backend changes** require server restart:
   ```bash
   # Stop the server (Ctrl+C) and restart
   npm run dev
   ```

### Working with Electron

For desktop app development:

```bash
# Start Electron with development mode
npm run electron:dev
```

This will:
- Start the Vite dev server
- Launch Electron with the app
- Enable DevTools for debugging

### Building Native Modules

If you encounter issues with native modules:

```bash
# Rebuild all native modules
npm run rebuild
```

---

## Project Structure

```
openwork/
├── src/                    # React frontend
│   ├── components/        # UI components
│   ├── contexts/          # React contexts
│   ├── hooks/            # Custom hooks
│   ├── i18n/             # Translations
│   ├── lib/              # Libraries
│   ├── pages/            # Page components
│   ├── types/            # TypeScript types
│   └── utils/            # Utilities
├── server/               # Express backend
│   ├── routes/           # API routes
│   ├── database/        # SQLite layer
│   ├── utils/           # Server utilities
│   └── index.js         # Server entry point
├── electron/             # Electron main process
│   ├── main.cjs         # Main process entry
│   ├── preload.cjs      # Preload script
│   └── utils/           # Electron utilities
├── public/               # Static assets
├── shared/               # Shared code
├── docs/                # Documentation
└── scripts/             # Build scripts
```

---

## Testing

### End-to-End Tests

Run E2E tests with Playwright:

```bash
# Run all E2E tests
npm run test:e2e

# Run tests in development mode
npm run test:e2e:dev

# Run tests with UI
npm run test:e2e:ui

# Debug mode
npm run test:e2e:debug

# View test report
npm run test:e2e:report
```

### Test Configuration

E2E tests are configured in `playwright.config.ts`.

---

## Code Style

### Formatting

The project uses Prettier for code formatting:

```bash
# Format all files
npx prettier --write .
```

### Linting

Run type checking:

```bash
npm run typecheck
```

### Git Commit Convention

Follow Conventional Commits:

```bash
# Examples
git commit -m "feat: add new feature"
git commit -m "fix: resolve bug"
git commit -m "docs: update documentation"
```

---

## Common Development Tasks

### Adding a New API Route

1. Create the route in `server/routes/`
2. Register it in `server/index.js`
3. Add type definitions in `src/types/`

### Adding a New Frontend Component

1. Create component in `src/components/`
2. Add to appropriate page in `src/pages/`
3. Add translations in `src/i18n/`

### Adding a New CLI Integration

1. Add CLI detection logic in `server/utils/`
2. Add route handlers in `server/routes/`
3. Add UI components in `src/components/`

---

## Troubleshooting

### Common Issues

**Native module build failures:**

```bash
# Clean and reinstall
rm -rf node_modules
npm install
```

**Port already in use:**

```bash
# Find and kill process using the port
lsof -i :3001  # macOS
netstat -ano | findstr :3001  # Windows
```

**TypeScript errors:**

```bash
# Check types
npm run typecheck
```

See [Troubleshooting Guide](troubleshooting.md) for more solutions.

---

## Next Steps

- [Installation Guide](installation.md) - Initial setup
- [Build & Release Guide](build-release.md) - Building desktop apps
- [Troubleshooting Guide](troubleshooting.md) - Common issues
