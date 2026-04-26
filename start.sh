#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_DIR"

required_node_major=22

info() { printf '[INFO] %s\n' "$1"; }
fail() { printf '[ERROR] %s\n' "$1" >&2; exit 1; }

info "Checking Node.js"
command -v node >/dev/null 2>&1 || fail "Node.js $required_node_major LTS is required."
node_major="$(node -v | sed 's/^v//' | cut -d. -f1)"
[ "$node_major" -ge "$required_node_major" ] || fail "Node.js $required_node_major+ is required; found $(node -v)."

info "Checking Rust"
command -v cargo >/dev/null 2>&1 || fail "Rust/Cargo is required. Install from https://rustup.rs"

if [ ! -d node_modules ]; then
  info "Installing npm dependencies"
  npm install
fi

info "Starting ThreadTerm Tauri desktop app"
npm run tauri:dev
