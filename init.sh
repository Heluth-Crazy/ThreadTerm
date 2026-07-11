#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_DIR"

required_node_major=22

echo "ThreadTerm Tauri desktop setup"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js $required_node_major LTS is required."
  exit 1
fi

node_major="$(node -v | sed 's/^v//' | cut -d. -f1)"
if [ "$node_major" -lt "$required_node_major" ]; then
  echo "Node.js $required_node_major+ is required; found $(node -v)."
  exit 1
fi

if ! command -v cargo >/dev/null 2>&1; then
  echo "Rust/Cargo is required. Install from https://rustup.rs"
  exit 1
fi

if [[ "$(uname -s)" == "Darwin" ]] && ! xcode-select -p >/dev/null 2>&1; then
  echo "Xcode Command Line Tools are required. Run: xcode-select --install"
  exit 1
fi

npm install
npm run typecheck
npm run build
npm run build:mobile
cargo check --manifest-path src-tauri/Cargo.toml

echo
echo "Setup complete."
echo "Run the desktop app with: npm run tauri:dev"
echo "Build packages with:     npm run tauri:build"
