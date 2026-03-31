# Installation Guide

This guide covers installation and setup for OpenWork (OpenWork) on macOS and Windows.

## Table of Contents

- [Quick Start (All Platforms)](#quick-start-all-platforms)
- [macOS Installation](#macos-installation)
- [Windows Installation](#windows-installation)
- [Verify Installation](#verify-installation)
- [Required CLI Tools](#required-cli-tools)
- [Configuration](#configuration)

---

## Quick Start (All Platforms)

### Prerequisites

Before installing OpenWork, ensure you have the following:

| Requirement | Version | Notes |
|-------------|---------|-------|
| Node.js | v22+ | Required for all installations |
| npm | v10+ | Comes with Node.js |

### Option 1: Direct Run (Recommended)

No installation required - run directly with npx:

```bash
npx @openwork/openwork
```

The server will start at `http://localhost:3001` (or your configured PORT).

### Option 2: Global Installation

For frequent use, install globally:

```bash
npm install -g @openwork/openwork
```

Then start with:

```bash
openwork
# or
openwork
```

---

## macOS Installation

### Step 1: Install Node.js

**Recommended: Using Homebrew**

```bash
# Install Homebrew if not already installed
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Install Node.js
brew install node
```

**Alternative: Using nvm**

```bash
# Install nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash

# Install Node.js
nvm install 22
nvm use 22
```

**Alternative: Direct Download**

Download from [nodejs.org](https://nodejs.org/) (LTS version).

### Step 2: Install OpenWork

```bash
# Direct run
npx @openwork/openwork

# Or install globally
npm install -g @openwork/openwork
openwork
```

### Step 3: Configure CLI Tools

OpenWork works with one or more of these CLI tools:

- **Claude Code**: [Installation Guide](https://docs.anthropic.com/en/docs/claude-code/setup)
- **Cursor CLI**: [Installation Guide](https://docs.cursor.com/en/cli/installation)
- **Codex**: [Installation Guide](https://developers.openai.com/docs/codex)

### Step 4: Verify Installation

```bash
# Check version
openwork version

# Check status
openwork status
```

---

## Windows Installation

### Step 1: Install Node.js

**Recommended: Using Winget**

```powershell
# Install Node.js LTS
winget install OpenJS.NodeJS.LTS
```

**Alternative: Using Chocolatey**

```powershell
# Install Node.js
choco install nodejs-lts
```

**Alternative: Direct Download**

Download the Windows Installer (.msi) from [nodejs.org](https://nodejs.org/) (LTS version).

### Step 2: Install Visual Studio Build Tools

Native modules (like `better-sqlite3` and `node-pty`) require Visual Studio Build Tools:

```powershell
# Using winget
winget install Microsoft.VisualStudio.BuildTools

# Or download from https://visualstudio.microsoft.com/visual-cpp-build-tools/
```

Select "Desktop development with C++" workload during installation.

### Step 3: Install OpenWork

Open PowerShell or Command Prompt:

```powershell
# Direct run
npx @openwork/openwork

# Or install globally
npm install -g @openwork/openwork
openwork
```

### Step 4: Configure CLI Tools

- **Claude Code**: [Installation Guide](https://docs.anthropic.com/en/docs/claude-code/setup)
- **Cursor CLI**: [Installation Guide](https://docs.cursor.com/en/cli/installation)
- **Codex**: [Installation Guide](https://developers.openai.com/docs/codex)

### Step 5: Verify Installation

```powershell
openwork version
openwork status
```

---

## Required CLI Tools

OpenWork requires at least one of the following CLI tools to be installed and configured:

### Claude Code (Recommended)

```bash
# Verify installation
claude --version

# If not installed, run to initialize
claude
```

### Cursor CLI

```bash
# Verify installation
cursor --version

# If not installed
npm install -g @cursor.sh/cli
```

### Codex

```bash
# Verify installation
codex --version

# If not installed
npm install -g @openai/codex-cli
```

---

## Configuration

### Environment Variables

Create a `.env` file in the project root or in your data directory:

```bash
# Copy the example configuration
cp .env.example .env
```

#### Common Configuration Options

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3001 | Backend server port |
| `VITE_PORT` | 5173 | Frontend dev server port |
| `HOST` | 0.0.0.0 | Server bind address |
| `DATABASE_PATH` | auto | Path to SQLite database |
| `CLAUDE_CLI_PATH` | claude | Custom CLI path |

### Data Directory

The application stores data in platform-specific locations:

| Platform | Default Location |
|----------|------------------|
| macOS | `~/Library/Application Support/ClaudeCodeDesktop` |
| Windows | `%APPDATA%/ClaudeCodeDesktop` |

View your data locations:

```bash
openwork status
```

---

## Next Steps

- [Development Guide](development.md) - Set up local development environment
- [Build & Release Guide](build-release.md) - Build desktop applications
- [Troubleshooting Guide](troubleshooting.md) - Common issues and solutions
