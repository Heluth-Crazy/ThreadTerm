#!/usr/bin/env bash
# ============================================================
# OpenWork — One-click launcher (macOS / Linux)
# ============================================================
set -e

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; NC='\033[0m'

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
REQUIRED_NODE_MAJOR=18
ENV_FILE="$PROJECT_DIR/.env"

info()  { echo -e "${CYAN}[INFO]${NC} $1"; }
ok()    { echo -e "${GREEN}[OK]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
fail()  { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

echo ""
echo -e "${CYAN}========================================${NC}"
echo -e "${CYAN}  OpenWork — Launcher${NC}"
echo -e "${CYAN}========================================${NC}"
echo ""

# --- Step 1: Load nvm ---
info "Checking Node.js environment..."
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
for p in "$NVM_DIR/nvm.sh" "/opt/homebrew/opt/nvm/nvm.sh" "/usr/local/opt/nvm/nvm.sh"; do
  [ -s "$p" ] && { source "$p"; break; }
done

# --- Step 2: Check / install Node.js ---
if ! command -v node &>/dev/null; then
  if command -v nvm &>/dev/null; then
    info "Installing Node.js v20 via nvm..."
    nvm install 20 && nvm use 20
  else
    fail "Node.js not found. Install Node.js 18+ or nvm first."
  fi
fi

NODE_MAJOR=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_MAJOR" -lt "$REQUIRED_NODE_MAJOR" ]; then
  if command -v nvm &>/dev/null; then
    warn "Node $(node -v) too old, upgrading..."
    nvm install 20 && nvm use 20
  else
    fail "Node.js $REQUIRED_NODE_MAJOR+ required, found $(node -v)"
  fi
fi
ok "Node.js $(node -v)"

# --- Step 3: Check build tools ---
info "Checking build tools..."
if [[ "$OSTYPE" == "darwin"* ]]; then
  if ! xcode-select -p &>/dev/null; then
    warn "Xcode CLT not found. Installing..."
    xcode-select --install
    echo "Re-run this script after installation."
    exit 0
  fi
  ok "Xcode CLT found"
else
  command -v gcc &>/dev/null || fail "gcc not found. Run: sudo apt install build-essential python3"
  ok "Build tools found"
fi

# --- Step 4: Setup .env ---
cd "$PROJECT_DIR"
info "Checking .env..."

if [ ! -f "$ENV_FILE" ]; then
  cp .env.example .env
  JWT=$(openssl rand -hex 32)
  printf '\n# Auto-generated JWT secret\nJWT_SECRET=%s\n' "$JWT" >> .env
  ok ".env created with JWT_SECRET"
else
  ok ".env exists"
  if ! grep -q "^JWT_SECRET=" "$ENV_FILE"; then
    JWT=$(openssl rand -hex 32)
    printf '\n# Auto-generated JWT secret\nJWT_SECRET=%s\n' "$JWT" >> "$ENV_FILE"
    ok "JWT_SECRET added"
  fi
fi

# --- Step 5: Install dependencies ---
info "Checking dependencies..."
if [ ! -d "node_modules" ]; then
  info "Running npm install (may take a few minutes)..."
  npm install
  ok "Dependencies installed"
else
  ok "node_modules exists"
fi

# --- Step 6: Check CLI tools ---
echo ""
info "Checking CLI tools..."
command -v claude &>/dev/null && ok "claude CLI found" || warn "claude CLI not found (install: npm i -g @anthropic-ai/claude-code)"
command -v codex  &>/dev/null && ok "codex CLI found"  || warn "codex CLI not found (optional: npm i -g @openai/codex)"
echo ""

# --- Step 7: Launch ---
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  Starting OpenWork${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
info "Frontend: http://localhost:${VITE_PORT:-5174}"
info "Backend:  http://localhost:${PORT:-3002}"
echo ""

npm run dev
