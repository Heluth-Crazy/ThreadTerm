#!/bin/bash
set -euo pipefail

# Load an optional GitHub token for ThreadTerm release automation.
if [[ -f .env ]]; then
  token_line=$(grep -E '^GITHUB_TOKEN=' .env || true)
  if [[ -n "$token_line" ]]; then
    export "$token_line"
  fi
fi

exec npx release-it "$@"
