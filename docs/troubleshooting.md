# Troubleshooting Guide

This guide covers common issues and their solutions when using OpenWork.

## Table of Contents

- [Installation Issues](#installation-issues)
- [Startup Issues](#startup-issues)
- [Runtime Issues](#runtime-issues)
- [CLI Integration Issues](#cli-integration-issues)
- [Desktop App Issues](#desktop-app-issues)
- [Database Issues](#database-issues)
- [Network Issues](#network-issues)
- [Getting Help](#getting-help)

---

## Installation Issues

### Node.js Version Issues

**Problem:** "Node.js version is too old" or similar error

**Solution:**

```bash
# Check current Node.js version
node --version

# Update Node.js using nvm (recommended)
nvm install 22
nvm use 22

# Or update via package manager
# macOS
brew upgrade node
# Windows
winget upgrade OpenJS.NodeJS.LTS
```

### npm Install Fails

**Problem:** `npm install` fails or hangs

**Solutions:**

```bash
# Clear npm cache
npm cache clean --force

# Delete node_modules and reinstall
rm -rf node_modules
npm install

# Use yarn instead
npm install -g yarn
yarn install
```

### Permission Denied Errors (Linux/macOS)

**Problem:** "EACCES: permission denied"

**Solutions:**

```bash
# Fix npm permissions
mkdir ~/.npm-global
npm config set prefix '~/.npm-global'
export PATH=~/.npm-global/bin:$PATH

# Or use nvm to avoid system-wide installs
```

---

## Startup Issues

### Port Already in Use

**Problem:** "Port 3001 is already in use"

**Solutions:**

```bash
# Find process using the port
# macOS
lsof -i :3001

# Windows
netstat -ano | findstr :3001

# Kill the process
kill -9 <PID>

# Or use a different port
PORT=3002 npm run dev
```

### Database Locked

**Problem:** "SQLITE_BUSY: database is locked"

**Solutions:**

```bash
# Ensure no other instances are running
# Check for running processes
ps aux | grep openwork
# or
tasklist | findstr node

# Delete the lock file
rm -f data/*.db-journal

# Restart the application
npm run dev
```

### Missing Dependencies

**Problem:** "Cannot find module" errors

**Solution:**

```bash
# Reinstall all dependencies
rm -rf node_modules package-lock.json
npm install
```

---

## Runtime Issues

### White Screen / Blank Page

**Problem:** Application loads but shows a blank white screen

**Solutions:**

1. Check browser console for errors
2. Clear browser cache
3. Check if the backend is running
4. Verify API is accessible

```bash
# Test API endpoint
curl http://localhost:3001/api/health
```

### WebSocket Connection Failed

**Problem:** Chat messages not loading or sending

**Solutions:**

1. Check WebSocket connection in browser DevTools
2. Verify the backend is running
3. Check for firewall/proxy blocking WebSocket

```bash
# Test WebSocket
# Using wscat
npm install -g wscat
wscat -c ws://localhost:3001
```

### Slow Performance

**Problem:** Application is sluggish or unresponsive

**Solutions:**

- Close unnecessary browser tabs
- Clear application cache
- Check database size (may need cleanup)

```bash
# Clear cache
rm -rf data/cache/*
```

---

## CLI Integration Issues

### No Projects Found

**Problem:** "No Claude projects found" or empty project list

**Solutions:**

1. Ensure Claude Code is installed:
   ```bash
   claude --version
   ```

2. Run Claude Code in at least one project:
   ```bash
   cd your-project
   claude
   ```

3. Verify projects directory exists:
   ```bash
   # macOS/Linux
   ls ~/.claude/projects/

   # Windows
   dir %USERPROFILE%\.claude\projects\
   ```

4. Check CLI path configuration:
   ```bash
   # In .env file
   CLAUDE_CLI_PATH=claude
   ```

### Claude Code Not Responding

**Problem:** CLI commands time out or hang

**Solutions:**

1. Verify Claude Code is working independently:
   ```bash
   claude --version
   claude -p "Hello"
   ```

2. Check Claude Code configuration:
   ```bash
   claude config list
   ```

3. Restart Claude Code daemon:
   ```bash
   # Kill any running Claude processes
   pkill -f claude
   ```

### Cursor/Codex Integration Issues

**Problem:** Cursor CLI or Codex not detected

**Solutions:**

```bash
# Verify installation
cursor --version
codex --version

# Check CLI paths
which cursor    # macOS/Linux
where cursor    # Windows

# Configure custom path in .env
CURSOR_CLI_PATH=/custom/path/cursor
CODEX_CLI_PATH=/custom/path/codex
```

---

## Desktop App Issues

### Application Won't Start

**Problem:** Desktop app crashes on launch

**Solutions:**

1. Check application logs:
   ```bash
   # macOS
   ~/Library/Logs/ClaudeCodeDesktop/

   # Windows
   %APPDATA%/ClaudeCodeDesktop/logs/
   ```

2. Run in development mode to see errors:
   ```bash
   npm run electron:dev
   ```

3. Reinstall the application

### Window Not Visible

**Problem:** App is running but window doesn't appear

**Solutions:**

1. Check if window is off-screen:
   ```bash
   # Delete window state file
   rm -f ~/Library/Application\ Support/ClaudeCodeDesktop/window-state.json
   ```

2. Reset window position

### Native Modules Not Working

**Problem:** Terminal or database features not working in desktop app

**Solutions:**

```bash
# Rebuild native modules
npm run rebuild

# For Electron specifically
npx electron-rebuild
```

---

## Database Issues

### Database Corruption

**Problem:** Application errors or crashes related to database

**Solutions:**

1. Backup existing data:
   ```bash
   cp data/auth.db data/auth.db.backup
   ```

2. Delete the database (will lose data):
   ```bash
   rm data/auth.db
   # Restart the application
   ```

3. Recreate database by running the app

### Database Migration Errors

**Problem:** "Migration failed" or similar errors

**Solutions:**

```bash
# Backup and reset database
cp data/auth.db data/auth.db.backup
rm data/auth.db
npm run dev
```

---

## Network Issues

### Cannot Connect to API

**Problem:** Frontend cannot reach backend API

**Solutions:**

1. Verify backend is running:
   ```bash
   curl http://localhost:3001/api/health
   ```

2. Check firewall settings
3. Verify host binding in `.env`:
   ```env
   HOST=0.0.0.0
   ```

### SSL/Certificate Errors

**Problem:** "SSL certificate error" in production

**Solutions:**

1. Use a reverse proxy (nginx, Apache)
2. Configure SSL certificates
3. Use Let's Encrypt for free certificates

### CORS Errors

**Problem:** "Cross-Origin Request Blocked" errors

**Solutions:**

Check CORS configuration in `server/index.js`:

```javascript
const cors = require('cors');
app.use(cors({
  origin: ['http://localhost:5173', 'http://localhost:3001'],
  credentials: true
}));
```

---

## Getting Help

### Collecting Debug Information

When reporting issues, include:

1. Application logs:
   ```bash
   # Backend logs
   cat logs/server.log

   # Desktop app logs
   # macOS
   cat ~/Library/Logs/ClaudeCodeDesktop/main.log
   # Windows
   type %APPDATA%/ClaudeCodeDesktop/logs/main.log
   ```

2. System information:
   ```bash
   node --version
   npm --version
   uname -a    # macOS/Linux
   systeminfo  # Windows
   ```

3. Browser console errors (F12)

### Reporting Issues

1. Search [existing issues](https://source.example.com/openwork/openwork/issues)
2. Create a new issue with:
   - Clear description
   - Steps to reproduce
   - Expected vs actual behavior
   - Debug information

### Community Support

- [source hosting Discussions](https://source.example.com/openwork/openwork/discussions)
- [Discord Community](https://discord.gg/openwork)

---

## Additional Resources

- [Installation Guide](installation.md)
- [Development Guide](development.md)
- [Build & Release Guide](build-release.md)
- [API Documentation](../public/api-docs.html)
