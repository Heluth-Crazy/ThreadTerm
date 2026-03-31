#!/bin/bash
# OpenWork Desktop - Development Environment Setup
set -e

echo "🚀 OpenWork Desktop - Setting up development environment..."

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check Node.js version
echo -e "${YELLOW}Checking Node.js version...${NC}"
NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo -e "${RED}Error: Node.js 18+ required. Current: $(node -v)${NC}"
    exit 1
fi
echo -e "${GREEN}✓ Node.js $(node -v)${NC}"

# Check if running on macOS or Linux
PLATFORM=$(uname -s)
if [ "$PLATFORM" == "Darwin" ]; then
    echo -e "${GREEN}✓ Platform: macOS${NC}"
elif [ "$PLATFORM" == "Linux" ]; then
    echo -e "${GREEN}✓ Platform: Linux${NC}"
else
    echo -e "${YELLOW}⚠ Platform: $PLATFORM (some features may not work)${NC}"
fi

# Install dependencies
echo -e "${YELLOW}Installing npm dependencies...${NC}"
npm install

# Rebuild native modules for Electron
echo -e "${YELLOW}Rebuilding native modules for Electron...${NC}"
npm run rebuild

# Create data directory
echo -e "${YELLOW}Creating data directory...${NC}"
mkdir -p data

# Build frontend
echo -e "${YELLOW}Building frontend...${NC}"
npm run build

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}✓ Setup complete!${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo "Development commands:"
echo "  npm run electron:dev     - Start in development mode"
echo "  npm run electron:build   - Build for production"
echo "  npm run build:mac        - Build for macOS"
echo "  npm run build:win        - Build for Windows"
echo ""
echo "Starting development server..."
npm run electron:dev
