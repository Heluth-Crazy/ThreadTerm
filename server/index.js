#!/usr/bin/env node
// Load environment variables before other imports execute
import './load-env.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const installMode = fs.existsSync(path.join(__dirname, '..', '.git')) ? 'git' : 'npm';

// ANSI color codes for terminal output
const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    cyan: '\x1b[36m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    dim: '\x1b[2m',
};

const c = {
    info: (text) => `${colors.cyan}${text}${colors.reset}`,
    ok: (text) => `${colors.green}${text}${colors.reset}`,
    warn: (text) => `${colors.yellow}${text}${colors.reset}`,
    tip: (text) => `${colors.blue}${text}${colors.reset}`,
    bright: (text) => `${colors.bright}${text}${colors.reset}`,
    dim: (text) => `${colors.dim}${text}${colors.reset}`,
};

console.log('PORT from env:', process.env.PORT);

import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import os from 'os';
import http from 'http';
import cors from 'cors';
import { promises as fsPromises } from 'fs';
import { spawn, spawnSync } from 'child_process';
import pty from 'node-pty';
import fetch from 'node-fetch';
import mime from 'mime-types';

import { getProjects, getSessions, getSessionMessages, renameProject, deleteSession, deleteProject, addProjectManually, extractProjectDirectory, clearProjectDirectoryCache } from './projects.js';
import { queryClaudeSDK, abortClaudeSDKSession, isClaudeSDKSessionActive, getActiveClaudeSDKSessions, resolveToolApproval } from './claude-sdk.js';
import { queryCodex, abortCodexSession, isCodexSessionActive, getActiveCodexSessions, resolveCodexExecutablePath } from './openai-codex.js';
import gitRoutes from './routes/git.js';
import authRoutes from './routes/auth.js';
import commandsRoutes from './routes/commands.js';
import agentRoutes from './routes/agent.js';
import projectsRoutes, { WORKSPACES_ROOT, validateWorkspacePath } from './routes/projects.js';
import cliAuthRoutes from './routes/cli-auth.js';
import userRoutes from './routes/user.js';
import codexRoutes from './routes/codex.js';
import cliDiscoveryRoutes from './routes/cli-discovery.js';
import skillsRoutes from './routes/skills.js';
import mcpRoutes from './routes/mcp.js';
import cursorRoutes from './routes/cursor.js';
import mcpUtilsRoutes from './routes/mcp-utils.js';
import { initializeDatabase } from './database/db.js';
import { validateApiKey, authenticateToken, authenticateWebSocket } from './middleware/auth.js';
import { IS_PLATFORM } from './constants/config.js';
import { FILE_ACCESS_MODE_HEADER, listProjectFileTree, readTextFileWithMode, readBinaryFileWithMode, writeTextFileWithMode, createDirectoryWithMode, getPathInfoWithMode } from './utils/file-access.js';

// File system watchers for provider project/session folders
const PROVIDER_WATCH_PATHS = [
    { provider: 'claude', rootPath: path.join(os.homedir(), '.claude', 'projects') },
    { provider: 'codex', rootPath: path.join(os.homedir(), '.codex', 'sessions') }
];
const WATCHER_IGNORED_PATTERNS = [
    '**/node_modules/**',
    '**/.git/**',
    '**/dist/**',
    '**/build/**',
    '**/*.tmp',
    '**/*.swp',
    '**/.DS_Store'
];
const WATCHER_DEBOUNCE_MS = 300;
let projectsWatchers = [];
let projectsWatcherDebounceTimer = null;
const connectedClients = new Set();
let isGetProjectsRunning = false; // Flag to prevent reentrant calls
let isServerShuttingDown = false;
let shutdownServerResourcesPromise = null;

// Broadcast progress to all connected WebSocket clients
function broadcastProgress(progress) {
    const message = JSON.stringify({
        type: 'loading_progress',
        ...progress
    });
    connectedClients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

// Setup file system watchers for Claude and Codex project/session folders
async function setupProjectsWatcher() {
    const chokidar = (await import('chokidar')).default;

    if (projectsWatcherDebounceTimer) {
        clearTimeout(projectsWatcherDebounceTimer);
        projectsWatcherDebounceTimer = null;
    }

    await Promise.all(
        projectsWatchers.map(async (watcher) => {
            try {
                await watcher.close();
            } catch (error) {
                console.error('[WARN] Failed to close watcher:', error);
            }
        })
    );
    projectsWatchers = [];

    const debouncedUpdate = (eventType, filePath, provider, rootPath) => {
        if (projectsWatcherDebounceTimer) {
            clearTimeout(projectsWatcherDebounceTimer);
        }

        projectsWatcherDebounceTimer = setTimeout(async () => {
            // Prevent reentrant calls
            if (isGetProjectsRunning) {
                return;
            }

            try {
                isGetProjectsRunning = true;

                // Clear project directory cache when files change
                clearProjectDirectoryCache();

                // Get updated projects list
                const updatedProjects = await getProjects(broadcastProgress);

                // Notify all connected clients about the project changes
                const updateMessage = JSON.stringify({
                    type: 'projects_updated',
                    projects: updatedProjects,
                    timestamp: new Date().toISOString(),
                    changeType: eventType,
                    changedFile: path.relative(rootPath, filePath),
                    watchProvider: provider
                });

                connectedClients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(updateMessage);
                    }
                });

            } catch (error) {
                console.error('[ERROR] Error handling project changes:', error);
            } finally {
                isGetProjectsRunning = false;
            }
        }, WATCHER_DEBOUNCE_MS);
    };

    for (const { provider, rootPath } of PROVIDER_WATCH_PATHS) {
        try {
            // chokidar v4 emits ENOENT via the "error" event for missing roots and will not auto-recover.
            // Ensure provider folders exist before creating the watcher so watching stays active.
            await fsPromises.mkdir(rootPath, { recursive: true });

            // Initialize chokidar watcher with optimized settings
            const watcher = chokidar.watch(rootPath, {
                ignored: WATCHER_IGNORED_PATTERNS,
                persistent: true,
                ignoreInitial: true, // Don't fire events for existing files on startup
                followSymlinks: false,
                depth: 10, // Reasonable depth limit
                awaitWriteFinish: {
                    stabilityThreshold: 100, // Wait 100ms for file to stabilize
                    pollInterval: 50
                }
            });

            // Set up event listeners
            watcher
                .on('add', (filePath) => debouncedUpdate('add', filePath, provider, rootPath))
                .on('change', (filePath) => debouncedUpdate('change', filePath, provider, rootPath))
                .on('unlink', (filePath) => debouncedUpdate('unlink', filePath, provider, rootPath))
                .on('addDir', (dirPath) => debouncedUpdate('addDir', dirPath, provider, rootPath))
                .on('unlinkDir', (dirPath) => debouncedUpdate('unlinkDir', dirPath, provider, rootPath))
                .on('error', (error) => {
                    console.error(`[ERROR] ${provider} watcher error:`, error);
                })
                .on('ready', () => {
                });

            projectsWatchers.push(watcher);
        } catch (error) {
            console.error(`[ERROR] Failed to setup ${provider} watcher for ${rootPath}:`, error);
        }
    }

    if (projectsWatchers.length === 0) {
        console.error('[ERROR] Failed to setup any provider watchers');
    }
}

async function closeProjectsWatchers() {
    if (projectsWatcherDebounceTimer) {
        clearTimeout(projectsWatcherDebounceTimer);
        projectsWatcherDebounceTimer = null;
    }

    const watchersToClose = projectsWatchers;
    projectsWatchers = [];

    await Promise.all(
        watchersToClose.map(async (watcher) => {
            try {
                await watcher.close();
            } catch (error) {
                console.error('[WARN] Failed to close watcher during shutdown:', error);
            }
        })
    );
}

function closeConnectedChatClients() {
    connectedClients.forEach((client) => {
        try {
            if (client.readyState === WebSocket.OPEN) {
                client.close(1001, 'Server shutting down');
            }

            if (client.readyState !== WebSocket.CLOSED && typeof client.terminate === 'function') {
                client.terminate();
            }
        } catch (error) {
            console.error('[WARN] Failed to close chat WebSocket client during shutdown:', error);
        }
    });

    connectedClients.clear();
}

function terminateAllPtySessions() {
    for (const [sessionKey, session] of ptySessionsMap.entries()) {
        try {
            if (session.timeoutId) {
                clearTimeout(session.timeoutId);
            }
            session.timeoutId = null;

            if (session.ws && session.ws.readyState === WebSocket.OPEN) {
                session.ws.send(JSON.stringify({
                    type: 'output',
                    data: '\r\n\x1b[33m[Server shutting down]\x1b[0m\r\n'
                }));
                session.ws.close(1001, 'Server shutting down');
            }
        } catch (error) {
            console.error('[WARN] Failed to close shell WebSocket during shutdown:', error);
        }

        try {
            if (session.pty && session.pty.kill) {
                session.pty.kill();
            }
        } catch (error) {
            console.error(`[WARN] Failed to kill PTY session ${sessionKey}:`, error);
        }
    }

    ptySessionsMap.clear();
}

function closeWebSocketServer(timeout = 1500) {
    return new Promise((resolve) => {
        let resolved = false;
        const finish = (ok) => {
            if (resolved) return;
            resolved = true;
            resolve(ok);
        };

        const timeoutId = setTimeout(() => {
            console.warn('[WARN] WebSocket server close timed out');
            finish(false);
        }, timeout);

        try {
            if (wss && wss.clients) {
                wss.clients.forEach((client) => {
                    try {
                        if (client.readyState === WebSocket.OPEN) {
                            client.close(1001, 'Server shutting down');
                        }

                        if (client.readyState !== WebSocket.CLOSED && typeof client.terminate === 'function') {
                            client.terminate();
                        }
                    } catch (error) {
                        console.error('[WARN] Failed to terminate WebSocket client:', error);
                    }
                });
            }

            wss.close((error) => {
                clearTimeout(timeoutId);
                if (error) {
                    console.error('[WARN] Error closing WebSocket server:', error);
                    finish(false);
                    return;
                }
                finish(true);
            });
        } catch (error) {
            clearTimeout(timeoutId);
            console.error('[WARN] Failed to close WebSocket server:', error);
            finish(false);
        }
    });
}

function closeHttpServer(timeout = 5000) {
    return new Promise((resolve) => {
        if (!server.listening) {
            resolve(true);
            return;
        }

        let resolved = false;
        const finish = (ok) => {
            if (resolved) return;
            resolved = true;
            resolve(ok);
        };

        const timeoutId = setTimeout(() => {
            console.warn('[WARN] HTTP server close timed out');
            try {
                if (typeof server.closeAllConnections === 'function') {
                    server.closeAllConnections();
                }
                if (typeof server.closeIdleConnections === 'function') {
                    server.closeIdleConnections();
                }
            } catch (error) {
                console.error('[WARN] Error forcing HTTP connection close:', error);
            }
            finish(false);
        }, timeout);

        try {
            if (typeof server.closeIdleConnections === 'function') {
                server.closeIdleConnections();
            }

            server.close((error) => {
                clearTimeout(timeoutId);
                if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') {
                    console.error('[WARN] Error closing HTTP server:', error);
                    finish(false);
                    return;
                }
                finish(true);
            });
        } catch (error) {
            clearTimeout(timeoutId);
            console.error('[WARN] Failed to close HTTP server:', error);
            finish(false);
        }
    });
}

async function shutdownServerResources(options = {}) {
    if (shutdownServerResourcesPromise) {
        return shutdownServerResourcesPromise;
    }

    const timeout = Number(options.timeout) > 0 ? Number(options.timeout) : 5000;
    isServerShuttingDown = true;

    shutdownServerResourcesPromise = (async () => {
        console.log('[INFO] Shutting down backend server resources...');

        await closeProjectsWatchers();
        closeConnectedChatClients();
        terminateAllPtySessions();
        await closeWebSocketServer(Math.min(1500, timeout));

        const httpClosed = await closeHttpServer(timeout);
        console.log(`[INFO] Backend shutdown completed (httpClosed=${httpClosed})`);
        return httpClosed;
    })();

    try {
        return await shutdownServerResourcesPromise;
    } finally {
        shutdownServerResourcesPromise = null;
    }
}


const app = express();
const server = http.createServer(app);

const ptySessionsMap = new Map();
const PTY_SESSION_TIMEOUT = 30 * 60 * 1000;
const SHELL_URL_PARSE_BUFFER_LIMIT = 32768;
const ANSI_ESCAPE_SEQUENCE_REGEX = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g;
const TRAILING_URL_PUNCTUATION_REGEX = /[)\]}>.,;:!?]+$/;
const IS_WINDOWS = os.platform() === 'win32';

// Periodic PTY session cleanup (runs every 10 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [sessionId, session] of ptySessionsMap.entries()) {
    if (session.lastDataAt && (now - session.lastDataAt) > PTY_SESSION_TIMEOUT) {
      console.log(`[PTY GC] Cleaning up stale session: ${sessionId}`);
      try {
        session.pty?.kill();
      } catch (e) { /* ignore */ }
      ptySessionsMap.delete(sessionId);
    }
  }
}, 10 * 60 * 1000);

function isPtyProcessAlive(ptyProcess) {
    if (!ptyProcess || typeof ptyProcess.pid !== 'number') {
        return false;
    }

    try {
        process.kill(ptyProcess.pid, 0);
        return true;
    } catch (error) {
        // EPERM means the process exists but current process cannot signal it.
        if (error && error.code === 'EPERM') {
            return true;
        }
        return false;
    }
}

function escapePowerShellSingleQuoted(value = '') {
    return String(value).replace(/'/g, "''");
}

function toPowerShellSingleQuoted(value = '') {
    return `'${escapePowerShellSingleQuoted(value)}'`;
}

function escapePosixSingleQuoted(value = '') {
    return String(value).replace(/'/g, `'"'"'`);
}

function toPosixSingleQuoted(value = '') {
    return `'${escapePosixSingleQuoted(value)}'`;
}

function normalizeSessionLaunchArgs(rawArgs) {
    if (!Array.isArray(rawArgs)) {
        return [];
    }

    return rawArgs
        .map((arg) => (typeof arg === 'string' ? arg.trim() : ''))
        .filter((arg) => arg.length > 0)
        .slice(0, 32);
}

const BYPASS_PERMISSION_LAUNCH_FLAGS = new Set([
    '--dangerously-skip-permissions',
    '--dangerously-bypass-approvals-and-sandbox',
]);

function formatPowerShellArgs(args = []) {
    return args.map((arg) => toPowerShellSingleQuoted(arg)).join(' ');
}

function formatPosixArgs(args = []) {
    return args.map((arg) => toPosixSingleQuoted(arg)).join(' ');
}

function appendCommandArgs(baseCommand, argsText) {
    return argsText ? `${baseCommand} ${argsText}` : baseCommand;
}

function getAdditionalCliPaths() {
    const homeDir = os.homedir();
    const detectBundledRipgrepPath = () => {
        const ripgrepCandidates = [
            path.join(__dirname, '..', 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'vendor', 'ripgrep', 'x64-win32'),
            path.join(process.resourcesPath || '', 'app.asar.unpacked', 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'vendor', 'ripgrep', 'x64-win32'),
            path.join(process.resourcesPath || '', 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'vendor', 'ripgrep', 'x64-win32'),
        ];

        for (const candidate of ripgrepCandidates) {
            if (!candidate) continue;
            const rgExe = path.join(candidate, 'rg.exe');
            if (fs.existsSync(rgExe)) {
                return candidate;
            }
        }

        return null;
    };

    if (IS_WINDOWS) {
        const localAppData = process.env.LOCALAPPDATA || `${homeDir}\\AppData\\Local`;
        const appData = process.env.APPDATA || `${homeDir}\\AppData\\Roaming`;
        const programFiles = process.env.PROGRAMFILES || 'C:\\Program Files';
        const programFilesX86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
        const bundledRipgrepPath = detectBundledRipgrepPath();

        const paths = [
            `${appData}\\npm`,
            `${homeDir}\\scoop\\shims`,
            `${localAppData}\\Microsoft\\WindowsApps`,
            `${programFiles}\\Git\\usr\\bin`,
            `${programFilesX86}\\Git\\usr\\bin`,
            `${programFiles}\\nodejs`,
            `${programFilesX86}\\nodejs`,
        ];

        if (bundledRipgrepPath) {
            paths.unshift(bundledRipgrepPath);
        }

        return paths;
    }

    return [
        '/opt/homebrew/bin',
        '/usr/local/bin',
        '/usr/bin',
        `${homeDir}/.local/bin`,
        `${homeDir}/.bun/bin`,
        `${homeDir}/.npm-global/bin`,
        `${homeDir}/.volta/bin`,
    ];
}

function buildEnhancedPath(existingPath = '') {
    const pathDelimiter = path.delimiter;
    const existingParts = existingPath
        .split(pathDelimiter)
        .map((item) => item.trim())
        .filter(Boolean);

    const additionalParts = getAdditionalCliPaths()
        .map((item) => item.trim())
        .filter(Boolean);

    if (!IS_WINDOWS) {
        // Add concrete nvm node bins (e.g. ~/.nvm/versions/node/v20.18.0/bin).
        const nvmVersionsRoot = path.join(os.homedir(), '.nvm', 'versions', 'node');
        if (fs.existsSync(nvmVersionsRoot)) {
            try {
                const nvmBins = fs.readdirSync(nvmVersionsRoot, { withFileTypes: true })
                    .filter((entry) => entry.isDirectory())
                    .map((entry) => path.join(nvmVersionsRoot, entry.name, 'bin'))
                    .filter((binPath) => fs.existsSync(binPath));
                additionalParts.push(...nvmBins);
            } catch (error) {
                console.warn('[PATH] Failed to scan nvm versions:', error?.message || error);
            }
        }
    }

    const normalizeKey = (value) => (IS_WINDOWS ? value.toLowerCase() : value);

    // Ensure preferred CLI paths always stay at the front, even if they already
    // exist later in PATH (common when launched via npm scripts).
    const uniqueAdditionalParts = [];
    const additionalSeen = new Set();
    for (const item of additionalParts) {
        const key = normalizeKey(item);
        if (!additionalSeen.has(key)) {
            uniqueAdditionalParts.push(item);
            additionalSeen.add(key);
        }
    }

    const filteredExistingParts = existingParts.filter((item) => {
        const key = normalizeKey(item);
        return !additionalSeen.has(key);
    });

    return [...uniqueAdditionalParts, ...filteredExistingParts].join(pathDelimiter);
}

function normalizeWorkingDirectory(inputPath, fallbackPath = process.cwd()) {
    const fallback = path.resolve(fallbackPath || process.cwd());

    if (!inputPath || typeof inputPath !== 'string') {
        return fallback;
    }

    const candidate = path.resolve(inputPath.trim());
    try {
        const stats = fs.statSync(candidate);
        if (stats.isDirectory()) {
            return candidate;
        }
        if (stats.isFile()) {
            const parent = path.dirname(candidate);
            if (fs.existsSync(parent) && fs.statSync(parent).isDirectory()) {
                return parent;
            }
        }
    } catch {
        const parent = path.dirname(candidate);
        try {
            if (fs.existsSync(parent) && fs.statSync(parent).isDirectory()) {
                return parent;
            }
        } catch {
            // Keep fallback below.
        }
    }

    return fallback;
}

function sanitizeAgentOptions(options = {}) {
    const normalizedCwd = normalizeWorkingDirectory(
        options.cwd || options.projectPath,
        process.cwd(),
    );
    const sessionArgs = normalizeSessionLaunchArgs(options.sessionArgs);
    const rawPermissionMode = typeof options.permissionMode === 'string'
        ? options.permissionMode
        : 'default';
    const shouldBypassPermissions = sessionArgs.some((arg) =>
        BYPASS_PERMISSION_LAUNCH_FLAGS.has(arg.trim().toLowerCase()),
    );

    return {
        ...options,
        cwd: normalizedCwd,
        projectPath: normalizedCwd,
        sessionArgs,
        permissionMode:
            shouldBypassPermissions && rawPermissionMode === 'default'
                ? 'bypassPermissions'
                : rawPermissionMode,
    };
}

function checkNodeAvailability() {
    const probe = spawnSync('node', ['-v'], {
        env: process.env,
        encoding: 'utf8',
    });
    if (probe.error) {
        return { available: false, reason: probe.error.message };
    }
    if (probe.status !== 0) {
        return { available: false, reason: (probe.stderr || '').trim() || `exit ${probe.status}` };
    }
    return { available: true, version: (probe.stdout || '').trim() };
}

// Ensure background SDK integrations can spawn "node" even when app starts from Finder.
const originalPath = process.env.PATH || '';
process.env.PATH = buildEnhancedPath(originalPath);
const nodeProbe = checkNodeAvailability();
if (nodeProbe.available) {
    console.log(`[PATH] node available: ${nodeProbe.version}`);
} else {
    console.warn(`[PATH] node unavailable after PATH enhancement: ${nodeProbe.reason}`);
}

function stripAnsiSequences(value = '') {
    return value.replace(ANSI_ESCAPE_SEQUENCE_REGEX, '');
}

function normalizeDetectedUrl(url) {
    if (!url || typeof url !== 'string') return null;

    const cleaned = url.trim().replace(TRAILING_URL_PUNCTUATION_REGEX, '');
    if (!cleaned) return null;

    try {
        const parsed = new URL(cleaned);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return null;
        }
        return parsed.toString();
    } catch {
        return null;
    }
}

function extractUrlsFromText(value = '') {
    const directMatches = value.match(/https?:\/\/[^\s<>"'`\\\x1b\x07]+/gi) || [];

    // Handle wrapped terminal URLs split across lines by terminal width.
    const wrappedMatches = [];
    const continuationRegex = /^[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+$/;
    const lines = value.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        const startMatch = line.match(/https?:\/\/[^\s<>"'`\\\x1b\x07]+/i);
        if (!startMatch) continue;

        let combined = startMatch[0];
        let j = i + 1;
        while (j < lines.length) {
            const continuation = lines[j].trim();
            if (!continuation) break;
            if (!continuationRegex.test(continuation)) break;
            combined += continuation;
            j++;
        }

        wrappedMatches.push(combined.replace(/\r?\n\s*/g, ''));
    }

    return Array.from(new Set([...directMatches, ...wrappedMatches]));
}

function shouldAutoOpenUrlFromOutput(value = '') {
    const normalized = value.toLowerCase();
    return (
        normalized.includes('browser didn\'t open') ||
        normalized.includes('open this url') ||
        normalized.includes('continue in your browser') ||
        normalized.includes('press enter to open') ||
        normalized.includes('open_url:')
    );
}

// Single WebSocket server that handles both paths
const wss = new WebSocketServer({
    server,
    verifyClient: (info) => {
        console.log('WebSocket connection attempt to:', info.req.url);

        // SIMPLIFIED: Always allow WebSocket connections without authentication
        // Try to get user info if token is provided (backward compatibility)
        const url = new URL(info.req.url, 'http://localhost');
        const token = url.searchParams.get('token') ||
            info.req.headers.authorization?.split(' ')[1];

        const user = authenticateWebSocket(token);
        info.req.user = user;
        console.log('[OK] WebSocket connected for user:', user.username || 'anonymous');
        return true;
    }
});

// Make WebSocket server available to routes
app.locals.wss = wss;

const allowedOrigins = [
  /^http:\/\/localhost(:\d+)?$/,
  /^app:\/\//,
  /^file:\/\//,
];
if (process.env.CORS_ORIGIN) {
  process.env.CORS_ORIGIN.split(',').forEach(o => allowedOrigins.push(o.trim()));
}
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true); // same-origin / non-browser
    const allowed = allowedOrigins.some(p =>
      typeof p === 'string' ? p === origin : p.test(origin)
    );
    callback(allowed ? null : new Error('CORS: origin not allowed'), allowed);
  },
  credentials: true,
}));
app.use(express.json({
  limit: '50mb',
  type: (req) => {
    // Skip multipart/form-data requests (for file uploads like images)
    const contentType = req.headers['content-type'] || '';
    if (contentType.includes('multipart/form-data')) {
      return false;
    }
    return contentType.includes('json');
  }
}));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Public health check endpoint (no authentication required)
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    installMode
  });
});

// Optional API key validation (if configured)
app.use('/api', validateApiKey);

// Authentication routes (public)
app.use('/api/auth', authRoutes);

// Projects API Routes (protected)
app.use('/api/projects', authenticateToken, projectsRoutes);

// Git API Routes (protected)
app.use('/api/git', authenticateToken, gitRoutes);

// Commands API Routes (protected)
app.use('/api/commands', authenticateToken, commandsRoutes);

// CLI Authentication API Routes (protected)
app.use('/api/cli', authenticateToken, cliAuthRoutes);

// User API Routes (protected)
app.use('/api/user', authenticateToken, userRoutes);

// Codex API Routes (protected)
app.use('/api/codex', authenticateToken, codexRoutes);

// Skills API Routes (protected)
app.use('/api/skills', authenticateToken, skillsRoutes);

// MCP API Routes (protected)
app.use('/api/mcp', authenticateToken, mcpRoutes);
app.use('/api/cursor', authenticateToken, cursorRoutes);
app.use('/api/mcp-utils', authenticateToken, mcpUtilsRoutes);

// Agent API Routes (uses API key authentication)
app.use('/api/agent', agentRoutes);
app.use('/api/cli', cliDiscoveryRoutes);

// Serve public files (like api-docs.html)
app.use(express.static(path.join(__dirname, '../public')));

// Static files served after API routes
// Add cache control: HTML files should not be cached, but assets can be cached
app.use(express.static(path.join(__dirname, '../dist'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      // Prevent HTML caching to avoid service worker issues after builds
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    } else if (filePath.match(/\.(js|css|woff2?|ttf|eot|svg|png|jpg|jpeg|gif|ico)$/)) {
      // Cache static assets for 1 year (they have hashed names)
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  }
}));

// API Routes (protected)
// /api/config endpoint removed - no longer needed
// Frontend now uses window.location for WebSocket URLs

// System update endpoint
app.post('/api/system/update', authenticateToken, async (req, res) => {
    try {
        // Get the project root directory (parent of server directory)
        const projectRoot = path.join(__dirname, '..');

        console.log('Starting system update from directory:', projectRoot);

        // Run the update command based on install mode
        const isWindows = os.platform() === 'win32';
        const updateCommand = installMode === 'git'
            ? (
                isWindows
                    ? 'git checkout main; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; git pull; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; npm install'
                    : 'git checkout main && git pull && npm install'
            )
            : 'npm install -g @openwork/openwork@latest';

        const shellBinary = isWindows ? 'powershell.exe' : 'sh';
        const shellArgs = isWindows
            ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', updateCommand]
            : ['-c', updateCommand];

        const child = spawn(shellBinary, shellArgs, {
            cwd: installMode === 'git' ? projectRoot : os.homedir(),
            env: process.env
        });

        let output = '';
        let errorOutput = '';

        child.stdout.on('data', (data) => {
            const text = data.toString();
            output += text;
            console.log('Update output:', text);
        });

        child.stderr.on('data', (data) => {
            const text = data.toString();
            errorOutput += text;
            console.error('Update error:', text);
        });

        child.on('close', (code) => {
            if (code === 0) {
                res.json({
                    success: true,
                    output: output || 'Update completed successfully',
                    message: 'Update completed. Please restart the server to apply changes.'
                });
            } else {
                res.status(500).json({
                    success: false,
                    error: 'Update command failed',
                    output: output,
                    errorOutput: errorOutput
                });
            }
        });

        child.on('error', (error) => {
            console.error('Update process error:', error);
            res.status(500).json({
                success: false,
                error: error.message
            });
        });

    } catch (error) {
        console.error('System update error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

app.get('/api/projects', authenticateToken, async (req, res) => {
    try {
        const projects = await getProjects(broadcastProgress);
        res.json(projects);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/projects/:projectName/sessions', authenticateToken, async (req, res) => {
    try {
        const { limit = 5, offset = 0 } = req.query;
        const result = await getSessions(req.params.projectName, parseInt(limit), parseInt(offset));
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get messages for a specific session
app.get('/api/projects/:projectName/sessions/:sessionId/messages', authenticateToken, async (req, res) => {
    try {
        const { projectName, sessionId } = req.params;
        const { limit, offset } = req.query;
        
        // Parse limit and offset if provided
        const parsedLimit = limit ? parseInt(limit, 10) : null;
        const parsedOffset = offset ? parseInt(offset, 10) : 0;
        
        const result = await getSessionMessages(projectName, sessionId, parsedLimit, parsedOffset);
        
        // Handle both old and new response formats
        if (Array.isArray(result)) {
            // Backward compatibility: no pagination parameters were provided
            res.json({ messages: result });
        } else {
            // New format with pagination info
            res.json(result);
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Rename project endpoint
app.put('/api/projects/:projectName/rename', authenticateToken, async (req, res) => {
    try {
        const { displayName } = req.body;
        await renameProject(req.params.projectName, displayName);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Delete session endpoint
app.delete('/api/projects/:projectName/sessions/:sessionId', authenticateToken, async (req, res) => {
    try {
        const { projectName, sessionId } = req.params;
        console.log(`[API] Deleting session: ${sessionId} from project: ${projectName}`);
        await deleteSession(projectName, sessionId);
        console.log(`[API] Session ${sessionId} deleted successfully`);
        res.json({ success: true });
    } catch (error) {
        console.error(`[API] Error deleting session ${req.params.sessionId}:`, error);
        res.status(500).json({ error: error.message });
    }
});

// Delete project endpoint (force=true to delete with sessions)
app.delete('/api/projects/:projectName', authenticateToken, async (req, res) => {
    try {
        const { projectName } = req.params;
        const force = req.query.force === 'true';
        await deleteProject(projectName, force);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Create project endpoint
app.post('/api/projects/create', authenticateToken, async (req, res) => {
    try {
        const { path: projectPath } = req.body;

        if (!projectPath || !projectPath.trim()) {
            return res.status(400).json({ error: 'Project path is required' });
        }

        const project = await addProjectManually(projectPath.trim());
        res.json({ success: true, project });
    } catch (error) {
        console.error('Error creating project:', error);
        res.status(500).json({ error: error.message });
    }
});

const expandWorkspacePath = (inputPath) => {
    if (!inputPath) return inputPath;
    if (inputPath === '~') {
        return WORKSPACES_ROOT;
    }
    if (inputPath.startsWith('~/') || inputPath.startsWith('~\\')) {
        return path.join(WORKSPACES_ROOT, inputPath.slice(2));
    }
    return inputPath;
};

app.get('/api/browse-roots', authenticateToken, async (req, res) => {
    try {
        if (IS_WINDOWS) {
            const roots = [];
            const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

            await Promise.all(
                letters.map(async (letter) => {
                    const drivePath = `${letter}:\\`;
                    try {
                        await fsPromises.access(drivePath);
                        const stats = await fsPromises.stat(drivePath);
                        if (stats.isDirectory()) {
                            roots.push({
                                name: `${letter}:`,
                                path: drivePath,
                                type: 'directory'
                            });
                        }
                    } catch {
                        // Drive not available, ignore.
                    }
                })
            );

            roots.sort((a, b) => a.name.localeCompare(b.name));
            return res.json({ roots });
        }

        const unixRoots = [
            { name: '/', path: '/', type: 'directory' },
            { name: 'home', path: WORKSPACES_ROOT, type: 'directory' }
        ];
        return res.json({ roots: unixRoots });
    } catch (error) {
        console.error('Error listing filesystem roots:', error);
        return res.status(500).json({ error: 'Failed to list filesystem roots' });
    }
});

// Browse filesystem endpoint for project suggestions - uses existing getFileTree
app.get('/api/browse-filesystem', authenticateToken, async (req, res) => {
    try {
        const { path: dirPath } = req.query;
        
        console.log('[API] Browse filesystem request for path:', dirPath);
        console.log('[API] WORKSPACES_ROOT is:', WORKSPACES_ROOT);
        // Default to home directory if no path provided
        const defaultRoot = WORKSPACES_ROOT;
        let targetPath = dirPath ? expandWorkspacePath(dirPath) : defaultRoot;
        
        // Resolve and normalize the path
        targetPath = path.resolve(targetPath);

        // Security check - ensure path is allowed for workspace operations
        const validation = await validateWorkspacePath(targetPath);
        if (!validation.valid) {
            return res.status(403).json({ error: validation.error });
        }
        const resolvedPath = validation.resolvedPath || targetPath;
        const requestedMode = req.headers[FILE_ACCESS_MODE_HEADER];
        
        // Security check - ensure path is accessible
        try {
            const pathInfo = await getPathInfoWithMode(resolvedPath, { requestedMode });
            if (!pathInfo.isDirectory) {
                return res.status(400).json({ error: 'Path is not a directory' });
            }
        } catch (err) {
            return res.status(404).json({ error: 'Directory not accessible' });
        }
        
        const { items: fileTree, mode: effectiveMode } = await listProjectFileTree(resolvedPath, {
            requestedMode,
            maxDepth: 1,
            showHidden: false,
        });
        applyFileAccessModeHeader(res, effectiveMode);
        
        // Filter only directories and format for suggestions
        const directories = fileTree
            .filter(item => item.type === 'directory')
            .map(item => ({
                path: item.path,
                name: item.name,
                type: 'directory'
            }))
            .sort((a, b) => {
                const aHidden = a.name.startsWith('.');
                const bHidden = b.name.startsWith('.');
                if (aHidden && !bHidden) return 1;
                if (!aHidden && bHidden) return -1;
                return a.name.localeCompare(b.name);
            });
            
        // Add common directories if browsing home directory
        const suggestions = [];
        let resolvedWorkspaceRoot = defaultRoot;
        try {
            resolvedWorkspaceRoot = await fsPromises.realpath(defaultRoot);
        } catch (error) {
            // Use default root as-is if realpath fails
        }
        if (resolvedPath === resolvedWorkspaceRoot) {
            const commonDirs = ['Desktop', 'Documents', 'Projects', 'Development', 'Dev', 'Code', 'workspace'];
            const existingCommon = directories.filter(dir => commonDirs.includes(dir.name));
            const otherDirs = directories.filter(dir => !commonDirs.includes(dir.name));
            
            suggestions.push(...existingCommon, ...otherDirs);
        } else {
            suggestions.push(...directories);
        }
        
        res.json({
            path: resolvedPath,
            suggestions: suggestions
        });
        
    } catch (error) {
        console.error('Error browsing filesystem:', error);
        res.status(500).json({ error: 'Failed to browse filesystem' });
    }
});

app.post('/api/create-folder', authenticateToken, async (req, res) => {
    try {
        const { path: folderPath } = req.body;
        if (!folderPath) {
            return res.status(400).json({ error: 'Path is required' });
        }

        const expandedPath = expandWorkspacePath(folderPath);
        const resolvedInput = path.resolve(expandedPath);
        const validation = await validateWorkspacePath(resolvedInput);
        if (!validation.valid) {
            return res.status(403).json({ error: validation.error });
        }

        const targetPath = validation.resolvedPath || resolvedInput;
        const requestedMode = req.headers[FILE_ACCESS_MODE_HEADER];
        const { mode: effectiveMode } = await createDirectoryWithMode(targetPath, {
            requestedMode,
        });

        applyFileAccessModeHeader(res, effectiveMode);
        res.json({ success: true, path: targetPath });
    } catch (error) {
        console.error('Error creating folder:', error);
        return sendProjectFileError(res, error, {
            notFound: 'Parent directory does not exist',
            alreadyExists: 'Folder already exists',
            fallback: 'Failed to create folder',
        });
    }
});

// Read file content endpoint
app.get('/api/projects/:projectName/file', authenticateToken, async (req, res) => {
    try {
        const { projectName } = req.params;
        const { filePath } = req.query;

        const { resolved } = await resolveProjectScopedPath(projectName, filePath, {
            allowRelative: true,
        });

        const requestedMode = req.headers[FILE_ACCESS_MODE_HEADER];
        const { content, mode: effectiveMode } = await readTextFileWithMode(resolved, {
            requestedMode,
        });

        applyFileAccessModeHeader(res, effectiveMode);
        res.json({ content, path: resolved });
    } catch (error) {
        console.error('Error reading file:', error);
        return sendProjectFileError(res, error, {
            notFound: 'File not found',
        });
    }
});

// Serve binary file content endpoint (for images, etc.)
app.get('/api/projects/:projectName/files/content', authenticateToken, async (req, res) => {
    try {
        const { projectName } = req.params;
        const { path: filePath } = req.query;

        const { resolved } = await resolveProjectScopedPath(projectName, filePath, {
            allowRelative: false,
        });

        const requestedMode = req.headers[FILE_ACCESS_MODE_HEADER];
        const { content, mode: effectiveMode } = await readBinaryFileWithMode(resolved, {
            requestedMode,
        });

        const mimeType = mime.lookup(resolved) || 'application/octet-stream';
        applyFileAccessModeHeader(res, effectiveMode);
        res.setHeader('Content-Type', mimeType);
        res.setHeader('Content-Length', String(content.length));
        res.send(content);
    } catch (error) {
        console.error('Error serving binary file:', error);
        if (res.headersSent) {
            return;
        }
        return sendProjectFileError(res, error, {
            notFound: 'File not found',
            fallback: 'Error reading file',
        });
    }
});

// Save file content endpoint
app.put('/api/projects/:projectName/file', authenticateToken, async (req, res) => {
    try {
        const { projectName } = req.params;
        const { filePath, content } = req.body;

        if (!filePath) {
            return res.status(400).json({ error: 'Invalid file path' });
        }

        if (content === undefined) {
            return res.status(400).json({ error: 'Content is required' });
        }

        const { resolved } = await resolveProjectScopedPath(projectName, filePath, {
            allowRelative: true,
        });

        const requestedMode = req.headers[FILE_ACCESS_MODE_HEADER];
        const { mode: effectiveMode } = await writeTextFileWithMode(resolved, content, {
            requestedMode,
        });

        applyFileAccessModeHeader(res, effectiveMode);
        res.json({
            success: true,
            path: resolved,
            message: 'File saved successfully'
        });
    } catch (error) {
        console.error('Error saving file:', error);
        return sendProjectFileError(res, error, {
            notFound: 'File or directory not found',
        });
    }
});

app.get('/api/projects/:projectName/files', authenticateToken, async (req, res) => {
    try {
        let actualPath;
        try {
            actualPath = await extractProjectDirectory(req.params.projectName);
        } catch (error) {
            console.error('Error extracting project directory:', error);
            actualPath = req.params.projectName.replace(/-/g, '/');
        }

        try {
            await fsPromises.access(actualPath);
        } catch (e) {
            return res.status(404).json({ error: `Project path not found: ${actualPath}` });
        }

        const requestedMode = req.headers[FILE_ACCESS_MODE_HEADER];
        const { items: files, mode: effectiveMode } = await listProjectFileTree(actualPath, {
            requestedMode,
            maxDepth: 10,
            showHidden: true,
        });

        res.setHeader('X-OpenWork-File-Access-Mode', effectiveMode);
        res.json(files);
    } catch (error) {
        console.error('[ERROR] File tree error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// WebSocket connection handler that routes based on URL path
wss.on('connection', (ws, request) => {
    const url = request.url;
    console.log('[INFO] Client connected to:', url);

    // Parse URL to get pathname without query parameters
    const urlObj = new URL(url, 'http://localhost');
    const pathname = urlObj.pathname;

    if (pathname === '/shell') {
        handleShellConnection(ws);
    } else if (pathname === '/ws') {
        handleChatConnection(ws);
    } else {
        console.log('[WARN] Unknown WebSocket path:', pathname);
        ws.close();
    }
});

/**
 * WebSocket Writer - Wrapper for WebSocket to match SSEStreamWriter interface
 */
class WebSocketWriter {
  constructor(ws) {
    this.ws = ws;
    this.sessionId = null;
    this.isWebSocketWriter = true;  // Marker for transport detection
  }

  send(data) {
    if (this.ws.readyState === 1) { // WebSocket.OPEN
      // Providers send raw objects, we stringify for WebSocket
      this.ws.send(JSON.stringify(data));
    }
  }

  setSessionId(sessionId) {
    this.sessionId = sessionId;
  }

  getSessionId() {
    return this.sessionId;
  }
}

// Handle chat WebSocket connections
function handleChatConnection(ws) {
    console.log('[INFO] Chat WebSocket connected');

    // Add to connected clients for project updates
    connectedClients.add(ws);

    // Wrap WebSocket with writer for consistent interface with SSEStreamWriter
    const writer = new WebSocketWriter(ws);

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);

            if (data.type === 'claude-command') {
                const safeOptions = sanitizeAgentOptions(data.options);
                console.log('[DEBUG] User message:', data.command || '[Continue/Resume]');
                console.log('棣冩惂 Project:', safeOptions.projectPath || 'Unknown');
                console.log('棣冩敡 Session:', safeOptions.sessionId ? 'Resume' : 'New');

                // Use Claude Agents SDK
                await queryClaudeSDK(data.command, safeOptions, writer);
            } else if (data.type === 'codex-command') {
                const safeOptions = sanitizeAgentOptions(data.options);
                console.log('[DEBUG] Codex message:', data.command || '[Continue/Resume]');
                console.log('棣冩惂 Project:', safeOptions.projectPath || safeOptions.cwd || 'Unknown');
                console.log('棣冩敡 Session:', safeOptions.sessionId ? 'Resume' : 'New');
                console.log('棣冾樆 Model:', safeOptions.model || 'default');
                await queryCodex(data.command, safeOptions, writer);
            } else if (data.type === 'abort-session') {
                console.log('[DEBUG] Abort session request:', data.sessionId);
                const provider = data.provider || 'claude';
                let success;

                if (provider === 'codex') {
                    success = abortCodexSession(data.sessionId);
                } else {
                    // Use Claude Agents SDK
                    success = await abortClaudeSDKSession(data.sessionId);
                }

                writer.send({
                    type: 'session-aborted',
                    sessionId: data.sessionId,
                    provider,
                    success
                });
            } else if (data.type === 'claude-permission-response') {
                // Relay UI approval decisions back into the SDK control flow.
                // This does not persist permissions; it only resolves the in-flight request,
                // introduced so the SDK can resume once the user clicks Allow/Deny.
                if (data.requestId) {
                    resolveToolApproval(data.requestId, {
                        allow: Boolean(data.allow),
                        updatedInput: data.updatedInput,
                        message: data.message,
                        rememberEntry: data.rememberEntry
                    });
                }
            } else if (data.type === 'check-session-status') {
                // Check if a specific session is currently processing
                const provider = data.provider || 'claude';
                const sessionId = data.sessionId;
                let isActive;

                if (provider === 'codex') {
                    isActive = isCodexSessionActive(sessionId);
                } else {
                    // Use Claude Agents SDK
                    isActive = isClaudeSDKSessionActive(sessionId);
                }

                writer.send({
                    type: 'session-status',
                    sessionId,
                    provider,
                    isProcessing: isActive
                });
            } else if (data.type === 'get-active-sessions') {
                // Get all currently active sessions
                const activeSessions = {
                    claude: getActiveClaudeSDKSessions(),
                    codex: getActiveCodexSessions()
                };
                writer.send({
                    type: 'active-sessions',
                    sessions: activeSessions
                });
            }
        } catch (error) {
            console.error('[ERROR] Chat WebSocket error:', error.message);
            writer.send({
                type: 'error',
                error: error.message
            });
        }
    });

    ws.on('close', () => {
        console.log('棣冩敳 Chat client disconnected');
        // Remove from connected clients
        connectedClients.delete(ws);
    });
}
// Handle shell WebSocket connections
function handleShellConnection(ws) {
    console.log('[INFO] Shell client connected');
    let shellProcess = null;
    let ptySessionKey = null;
    let urlDetectionBuffer = '';
    const announcedAuthUrls = new Set();

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            console.log('[INFO] Shell message received:', data.type);

            if (data.type === 'init') {
                const projectPath = normalizeWorkingDirectory(data.projectPath, process.cwd());
                const requestedSessionMode = typeof data.sessionMode === 'string'
                    ? data.sessionMode.toLowerCase()
                    : null;
                const rawHasSession = Boolean(data.hasSession);
                const wantsResume = requestedSessionMode
                    ? requestedSessionMode === 'resume'
                    : rawHasSession;
                const rawSessionId = typeof data.sessionId === 'string' ? data.sessionId : null;
                const isTemporarySession = Boolean(rawSessionId && rawSessionId.startsWith('new-session-'));
                const sessionId = wantsResume && !isTemporarySession ? rawSessionId : null;
                const hasSession = Boolean(wantsResume && sessionId);
                const provider = data.provider || 'claude';
                const sessionLaunchArgs = normalizeSessionLaunchArgs(data.sessionArgs);
                const initialCommand = data.initialCommand;
                const isPlainShell = data.isPlainShell || (!!initialCommand && !hasSession) || provider === 'plain-shell';
                const forceNew = data.forceNew || false;
                urlDetectionBuffer = '';
                announcedAuthUrls.clear();

                // Login commands (provider auth) should never reuse cached sessions
                const isLoginCommand = initialCommand && (
                    initialCommand.includes('setup-token') ||
                    initialCommand.includes('auth login')
                );

                // Include provider in session key to avoid cross-provider PTY collisions.
                const providerKey = isPlainShell ? 'plain-shell' : provider;

                // Include command hash in session key so different commands get separate sessions
                const commandSuffix = isPlainShell && initialCommand
                    ? `_cmd_${Buffer.from(initialCommand).toString('base64').slice(0, 16)}`
                    : '';
                const paneId = data.paneId || null;
                const paneSuffix = paneId ? `_pane${paneId}` : '';
                ptySessionKey = `${projectPath}_${providerKey}_${sessionId || 'default'}${commandSuffix}${paneSuffix}`;

                // Kill any existing session when forceNew or login command
                if (isLoginCommand || forceNew) {
                    const oldSession = ptySessionsMap.get(ptySessionKey);
                    if (oldSession) {
                        console.log('[INFO] Cleaning up existing session:', ptySessionKey);
                        if (oldSession.timeoutId) clearTimeout(oldSession.timeoutId);
                        if (oldSession.pty && oldSession.pty.kill) oldSession.pty.kill();
                        ptySessionsMap.delete(ptySessionKey);
                    }
                }

                // Provider terminals (Claude/Codex) are resumed by CLI session id and should start fresh
                // to avoid attaching to stale PTYs after UI reconnects.
                const shouldReusePtySession = !isLoginCommand && !forceNew && isPlainShell;
                const existingSession = ptySessionsMap.get(ptySessionKey);
                if (existingSession && !shouldReusePtySession) {
                    console.log('[INFO] Discarding cached PTY for fresh provider shell:', ptySessionKey);
                    if (existingSession.timeoutId) clearTimeout(existingSession.timeoutId);
                    if (isPtyProcessAlive(existingSession.pty) && existingSession.pty && existingSession.pty.kill) {
                        existingSession.pty.kill();
                    }
                    ptySessionsMap.delete(ptySessionKey);
                }

                if (existingSession && shouldReusePtySession) {
                    if (!isPtyProcessAlive(existingSession.pty)) {
                        console.log('[WARN] Existing PTY session is stale, starting a new one:', ptySessionKey);
                        if (existingSession.timeoutId) clearTimeout(existingSession.timeoutId);
                        ptySessionsMap.delete(ptySessionKey);
                    } else {
                        console.log('[INFO] Reconnecting to existing PTY session:', ptySessionKey);
                        shellProcess = existingSession.pty;

                        clearTimeout(existingSession.timeoutId);

                        ws.send(JSON.stringify({
                            type: 'output',
                            data: `\x1b[36m[Reconnected to existing session]\x1b[0m\r\n`
                        }));

                        if (existingSession.bufferEnabled && existingSession.buffer && existingSession.buffer.length > 0) {
                            existingSession.buffer.forEach(bufferedData => {
                                ws.send(JSON.stringify({
                                    type: 'output',
                                    data: bufferedData
                                }));
                            });
                        } else if (existingSession.pty && typeof existingSession.pty.write === 'function') {
                            // Force redraw for full-screen TUIs instead of replaying stale ANSI buffer.
                            existingSession.pty.write('\x0c');
                        }

                        existingSession.ws = ws;

                        return;
                    }
                }

                console.log('[INFO] Starting shell in:', projectPath);
                console.log('[INFO] Session info:', hasSession ? `Resume session ${sessionId}` : (isPlainShell ? 'Plain shell mode' : 'New session'));
                console.log('[INFO] Provider:', isPlainShell ? 'plain-shell' : provider);
                if (initialCommand) {
                    console.log('[INFO] Initial command:', initialCommand);
                }

                // First send a welcome message
                let welcomeMsg;
                if (isPlainShell) {
                    welcomeMsg = `\x1b[36mStarting terminal in: ${projectPath}\x1b[0m\r\n`;
                } else {
                    const providerName = provider === 'codex' ? 'Codex' : 'Claude';
                    welcomeMsg = hasSession ?
                        `\x1b[36mResuming ${providerName} session ${sessionId} in: ${projectPath}\x1b[0m\r\n` :
                        `\x1b[36mStarting new ${providerName} session in: ${projectPath}\x1b[0m\r\n`;
                }

                ws.send(JSON.stringify({
                    type: 'output',
                    data: welcomeMsg
                }));

                try {
                    // Prepare the shell command adapted to the platform and provider
                    const shell = IS_WINDOWS ? 'powershell.exe' : (process.env.SHELL || '/bin/zsh');
                    const powerShellLaunchArgs = formatPowerShellArgs(sessionLaunchArgs);
                    const posixLaunchArgs = formatPosixArgs(sessionLaunchArgs);
                    let shellCommand;
                    if (isPlainShell) {
                        // Plain shell mode - interactive shell or one-off command
                        if (initialCommand) {
                            if (IS_WINDOWS) {
                                shellCommand = `Set-Location -Path ${toPowerShellSingleQuoted(projectPath)}; ${initialCommand}`;
                            } else {
                                shellCommand = `cd ${toPosixSingleQuoted(projectPath)} && ${initialCommand}`;
                            }
                        } else {
                            // No command - spawn interactive shell in project dir
                            shellCommand = null;
                        }
                    } else if (provider === 'codex') {
                        const codexExecutablePath = resolveCodexExecutablePath();

                        if (IS_WINDOWS) {
                            // Prefer PATH codex command and fall back to resolved binary when needed.
                            const fallbackCodexInvocation = codexExecutablePath
                                ? `& ${toPowerShellSingleQuoted(codexExecutablePath)}`
                                : null;
                            if (codexExecutablePath) {
                                console.log('[Codex] Terminal fallback executable:', codexExecutablePath);
                            }

                            if (hasSession && sessionId) {
                                const codexResumeCommand = appendCommandArgs(`codex resume ${toPowerShellSingleQuoted(sessionId)}`, powerShellLaunchArgs);
                                const codexFallbackCommand = appendCommandArgs('codex', powerShellLaunchArgs);
                                const systemCommand = `${codexResumeCommand}; if ($LASTEXITCODE -ne 0) { ${codexFallbackCommand} }`;
                                if (fallbackCodexInvocation) {
                                    const fallbackResume = appendCommandArgs(`${fallbackCodexInvocation} resume ${toPowerShellSingleQuoted(sessionId)}`, powerShellLaunchArgs);
                                    const fallbackStart = appendCommandArgs(fallbackCodexInvocation, powerShellLaunchArgs);
                                    shellCommand = `Set-Location -Path ${toPowerShellSingleQuoted(projectPath)}; if (Get-Command codex -ErrorAction SilentlyContinue) { ${systemCommand} } else { ${fallbackResume}; if ($LASTEXITCODE -ne 0) { ${fallbackStart} } }`;
                                } else {
                                    shellCommand = `Set-Location -Path ${toPowerShellSingleQuoted(projectPath)}; ${systemCommand}`;
                                }
                            } else {
                                const codexCommand = appendCommandArgs('codex', powerShellLaunchArgs);
                                if (fallbackCodexInvocation) {
                                    const fallbackCommand = appendCommandArgs(fallbackCodexInvocation, powerShellLaunchArgs);
                                    shellCommand = `Set-Location -Path ${toPowerShellSingleQuoted(projectPath)}; if (Get-Command codex -ErrorAction SilentlyContinue) { ${codexCommand} } else { ${fallbackCommand} }`;
                                } else {
                                    shellCommand = `Set-Location -Path ${toPowerShellSingleQuoted(projectPath)}; ${codexCommand}`;
                                }
                            }
                        } else {
                            const codexInvocation = codexExecutablePath
                                ? toPosixSingleQuoted(codexExecutablePath)
                                : 'codex';
                            // Use login shell (-l) to load shell profiles which sets up nvm/fnm paths
                            const shellProfile = shell.includes('zsh') ? '~/.zshrc' : '~/.bashrc';
                            if (hasSession && sessionId) {
                                const codexResumeCommand = appendCommandArgs(`${codexInvocation} resume ${toPosixSingleQuoted(sessionId)}`, posixLaunchArgs);
                                const codexFallbackCommand = appendCommandArgs(codexInvocation, posixLaunchArgs);
                                shellCommand = `source ${shellProfile} 2>/dev/null; cd ${toPosixSingleQuoted(projectPath)} && ${codexResumeCommand} || ${codexFallbackCommand}`;
                            } else {
                                const codexCommand = appendCommandArgs(codexInvocation, posixLaunchArgs);
                                shellCommand = `source ${shellProfile} 2>/dev/null; cd ${toPosixSingleQuoted(projectPath)} && ${codexCommand}`;
                            }
                        }
                    } else {
                        // Use claude command (default) or initialCommand if provided
                        const command = initialCommand || 'claude';
                        if (IS_WINDOWS) {
                            if (hasSession && sessionId) {
                                const claudeResumeCommand = appendCommandArgs(`claude -r ${toPowerShellSingleQuoted(sessionId)}`, powerShellLaunchArgs);
                                const claudeLegacyResumeCommand = appendCommandArgs(`claude --resume ${toPowerShellSingleQuoted(sessionId)}`, powerShellLaunchArgs);
                                const claudeFallbackCommand = appendCommandArgs('claude', powerShellLaunchArgs);
                                shellCommand = `Set-Location -Path ${toPowerShellSingleQuoted(projectPath)}; ${claudeResumeCommand}; if ($LASTEXITCODE -ne 0) { ${claudeLegacyResumeCommand}; if ($LASTEXITCODE -ne 0) { ${claudeFallbackCommand} } }`;
                            } else {
                                const commandWithArgs = initialCommand ? command : appendCommandArgs(command, powerShellLaunchArgs);
                                shellCommand = `Set-Location -Path ${toPowerShellSingleQuoted(projectPath)}; ${commandWithArgs}`;
                            }
                        } else {
                            if (hasSession && sessionId) {
                                const claudeResumeCommand = appendCommandArgs(`claude -r ${toPosixSingleQuoted(sessionId)}`, posixLaunchArgs);
                                const claudeLegacyResumeCommand = appendCommandArgs(`claude --resume ${toPosixSingleQuoted(sessionId)}`, posixLaunchArgs);
                                const claudeFallbackCommand = appendCommandArgs('claude', posixLaunchArgs);
                                shellCommand = `cd ${toPosixSingleQuoted(projectPath)} && (${claudeResumeCommand} || ${claudeLegacyResumeCommand} || ${claudeFallbackCommand})`;
                            } else {
                                const commandWithArgs = initialCommand ? command : appendCommandArgs(command, posixLaunchArgs);
                                shellCommand = `cd ${toPosixSingleQuoted(projectPath)} && ${commandWithArgs}`;
                            }
                        }
                    }

                    console.log('[INFO] Executing shell command:', shellCommand);

                    // Use appropriate shell based on platform
                    const termCols = data.cols || 80;
                    const termRows = data.rows || 24;
                    console.log('[INFO] Using terminal dimensions:', termCols, 'x', termRows);

                    let shellArgs;
                    let shellCwd;
                    if (shellCommand) {
                        // One-off command mode
                        if (IS_WINDOWS) {
                            // Keep provider terminals open after startup failures for easier troubleshooting.
                            const keepProviderShellOpen = !isPlainShell;
                            if (keepProviderShellOpen) {
                                shellArgs = ['-ExecutionPolicy', 'Bypass', '-NoExit', '-Command', shellCommand];
                            } else {
                                shellArgs = ['-ExecutionPolicy', 'Bypass', '-NoProfile', '-Command', shellCommand];
                            }
                        } else {
                            shellArgs = ['-c', shellCommand];
                        }
                        shellCwd = os.homedir();
                    } else {
                        // Interactive shell mode - cd into project dir (or home if no project)
                        shellArgs = [];
                        shellCwd = projectPath || os.homedir();
                    }

                    // Ensure PATH includes common CLI installation directories
                    const existingPath = process.env.PATH || '';
                    const enhancedPath = buildEnhancedPath(existingPath);

                    // Build environment variables for shell process
                    const shellEnv = {
                        ...process.env,
                        PATH: enhancedPath,
                        TERM: 'xterm-256color',
                        COLORTERM: 'truecolor',
                        FORCE_COLOR: '3'
                    };

                    shellProcess = pty.spawn(shell, shellArgs, {
                        name: 'xterm-256color',
                        cols: termCols,
                        rows: termRows,
                        cwd: shellCwd,
                        env: shellEnv
                    });
                    const currentShellProcess = shellProcess;

                    console.log('[INFO] Shell process started with PTY, PID:', currentShellProcess.pid);

                    ptySessionsMap.set(ptySessionKey, {
                        pty: currentShellProcess,
                        ws: ws,
                        buffer: [],
                        bufferEnabled: isPlainShell,
                        timeoutId: null,
                        projectPath,
                        provider: providerKey,
                        sessionId,
                        createdAt: Date.now(),
                        lastDataAt: Date.now(),
                    });

                    // Handle data output
                    currentShellProcess.onData((data) => {
                        const session = ptySessionsMap.get(ptySessionKey);
                        if (!session || session.pty !== currentShellProcess) return;
                        session.lastDataAt = Date.now();

                        if (session.bufferEnabled) {
                            if (session.buffer.length < 5000) {
                                session.buffer.push(data);
                            } else {
                                session.buffer.shift();
                                session.buffer.push(data);
                            }
                        }

                        if (session.ws && session.ws.readyState === WebSocket.OPEN) {
                            let outputData = data;

                            const cleanChunk = stripAnsiSequences(data);
                            urlDetectionBuffer = `${urlDetectionBuffer}${cleanChunk}`.slice(-SHELL_URL_PARSE_BUFFER_LIMIT);

                            outputData = outputData.replace(
                                /OPEN_URL:\s*(https?:\/\/[^\s\x1b\x07]+)/g,
                                '[INFO] Opening in browser: $1'
                            );

                            const emitAuthUrl = (detectedUrl, autoOpen = false) => {
                                const normalizedUrl = normalizeDetectedUrl(detectedUrl);
                                if (!normalizedUrl) return;

                                const isNewUrl = !announcedAuthUrls.has(normalizedUrl);
                                if (isNewUrl) {
                                    announcedAuthUrls.add(normalizedUrl);
                                    session.ws.send(JSON.stringify({
                                        type: 'auth_url',
                                        url: normalizedUrl,
                                        autoOpen
                                    }));
                                }

                            };

                            const normalizedDetectedUrls = extractUrlsFromText(urlDetectionBuffer)
                                .map((url) => normalizeDetectedUrl(url))
                                .filter(Boolean);

                            // Prefer the most complete URL if shorter prefix variants are also present.
                            const dedupedDetectedUrls = Array.from(new Set(normalizedDetectedUrls)).filter((url, _, urls) =>
                                !urls.some((otherUrl) => otherUrl !== url && otherUrl.startsWith(url))
                            );

                            dedupedDetectedUrls.forEach((url) => emitAuthUrl(url, false));

                            if (shouldAutoOpenUrlFromOutput(cleanChunk) && dedupedDetectedUrls.length > 0) {
                                const bestUrl = dedupedDetectedUrls.reduce((longest, current) =>
                                    current.length > longest.length ? current : longest
                                );
                                emitAuthUrl(bestUrl, true);
                            }

                            // Send regular output
                            session.ws.send(JSON.stringify({
                                type: 'output',
                                data: outputData
                            }));
                        }
                    });

                    // Handle process exit
                    currentShellProcess.onExit((exitCode) => {
                        console.log('[INFO] Shell process exited with code:', exitCode.exitCode, 'signal:', exitCode.signal);
                        const session = ptySessionsMap.get(ptySessionKey);
                        if (!session || session.pty !== currentShellProcess) {
                            return;
                        }
                        if (session && session.ws && session.ws.readyState === WebSocket.OPEN) {
                            session.ws.send(JSON.stringify({
                                type: 'output',
                                data: `\r\n\x1b[33mProcess exited with code ${exitCode.exitCode}${exitCode.signal ? ` (${exitCode.signal})` : ''}\x1b[0m\r\n`
                            }));
                        }
                        if (session && session.timeoutId) {
                            clearTimeout(session.timeoutId);
                        }
                        ptySessionsMap.delete(ptySessionKey);
                        if (shellProcess === currentShellProcess) {
                            shellProcess = null;
                        }
                    });

                } catch (spawnError) {
                    console.error('[ERROR] Error spawning process:', spawnError);
                    ws.send(JSON.stringify({
                        type: 'output',
                        data: `\r\n\x1b[31mError: ${spawnError.message}\x1b[0m\r\n`
                    }));
                }

            } else if (data.type === 'input') {
                // Send input to shell process
                if (shellProcess && shellProcess.write) {
                    try {
                        if (!isPtyProcessAlive(shellProcess)) {
                            throw new Error('PTY process is not alive');
                        }
                        shellProcess.write(data.data);
                    } catch (error) {
                        console.error('Error writing to shell:', error);
                        if (ws.readyState === WebSocket.OPEN) {
                            ws.send(JSON.stringify({
                                type: 'output',
                                data: `\r\n\x1b[31mTerminal input failed: ${error.message}\x1b[0m\r\n`
                            }));
                        }
                    }
                } else {
                    console.warn('No active shell process to send input to');
                }
            } else if (data.type === 'resize') {
                // Handle terminal resize
                if (shellProcess && shellProcess.resize) {
                    console.log('Terminal resize requested:', data.cols, 'x', data.rows);
                    shellProcess.resize(data.cols, data.rows);
                }
            }
        } catch (error) {
            console.error('[ERROR] Shell WebSocket error:', error.message);
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: 'output',
                    data: `\r\n\x1b[31mError: ${error.message}\x1b[0m\r\n`
                }));
            }
        }
    });

    ws.on('close', () => {
        console.log('[INFO] Shell client disconnected');

        if (ptySessionKey) {
            const session = ptySessionsMap.get(ptySessionKey);
            if (session) {
                if (isServerShuttingDown) {
                    if (session.timeoutId) {
                        clearTimeout(session.timeoutId);
                    }
                    if (session.pty && session.pty.kill) {
                        session.pty.kill();
                    }
                    ptySessionsMap.delete(ptySessionKey);
                    return;
                }

                console.log('[INFO] PTY session kept alive, will timeout in 30 minutes:', ptySessionKey);
                session.ws = null;

                session.timeoutId = setTimeout(() => {
                    console.log('[INFO] PTY session timeout, killing process:', ptySessionKey);
                    if (session.pty && session.pty.kill) {
                        session.pty.kill();
                    }
                    ptySessionsMap.delete(ptySessionKey);
                }, PTY_SESSION_TIMEOUT);
            }
        }
    });

    ws.on('error', (error) => {
        console.error('[ERROR] Shell WebSocket error:', error);
    });
}
// Audio transcription endpoint
app.post('/api/transcribe', authenticateToken, async (req, res) => {
    try {
        const multer = (await import('multer')).default;
        const upload = multer({ storage: multer.memoryStorage() });

        // Handle multipart form data
        upload.single('audio')(req, res, async (err) => {
            if (err) {
                return res.status(400).json({ error: 'Failed to process audio file' });
            }

            if (!req.file) {
                return res.status(400).json({ error: 'No audio file provided' });
            }

            const apiKey = process.env.OPENAI_API_KEY;
            if (!apiKey) {
                return res.status(500).json({ error: 'OpenAI API key not configured. Please set OPENAI_API_KEY in server environment.' });
            }

            try {
                // Create form data for OpenAI
                const FormData = (await import('form-data')).default;
                const formData = new FormData();
                formData.append('file', req.file.buffer, {
                    filename: req.file.originalname,
                    contentType: req.file.mimetype
                });
                formData.append('model', 'whisper-1');
                formData.append('response_format', 'json');
                formData.append('language', 'en');

                // Make request to OpenAI
                const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${apiKey}`,
                        ...formData.getHeaders()
                    },
                    body: formData
                });

                if (!response.ok) {
                    const errorData = await response.json().catch(() => ({}));
                    throw new Error(errorData.error?.message || `Whisper API error: ${response.status}`);
                }

                const data = await response.json();
                let transcribedText = data.text || '';

                // Check if enhancement mode is enabled
                const mode = req.body.mode || 'default';

                // If no transcribed text, return empty
                if (!transcribedText) {
                    return res.json({ text: '' });
                }

                // If default mode, return transcribed text without enhancement
                if (mode === 'default') {
                    return res.json({ text: transcribedText });
                }

                // Handle different enhancement modes
                try {
                    const OpenAI = (await import('openai')).default;
                    const openai = new OpenAI({ apiKey });

                    let prompt, systemMessage, temperature = 0.7, maxTokens = 800;

                    switch (mode) {
                        case 'prompt':
                            systemMessage = 'You are an expert prompt engineer who creates clear, detailed, and effective prompts.';
                            prompt = `You are an expert prompt engineer. Transform the following rough instruction into a clear, detailed, and context-aware AI prompt.

Your enhanced prompt should:
1. Be specific and unambiguous
2. Include relevant context and constraints
3. Specify the desired output format
4. Use clear, actionable language
5. Include examples where helpful
6. Consider edge cases and potential ambiguities

Transform this rough instruction into a well-crafted prompt:
"${transcribedText}"

Enhanced prompt:`;
                            break;

                        case 'vibe':
                        case 'instructions':
                        case 'architect':
                            systemMessage = 'You are a helpful assistant that formats ideas into clear, actionable instructions for AI agents.';
                            temperature = 0.5; // Lower temperature for more controlled output
                            prompt = `Transform the following idea into clear, well-structured instructions that an AI agent can easily understand and execute.

IMPORTANT RULES:
- Format as clear, step-by-step instructions
- Add reasonable implementation details based on common patterns
- Only include details directly related to what was asked
- Do NOT add features or functionality not mentioned
- Keep the original intent and scope intact
- Use clear, actionable language an agent can follow

Transform this idea into agent-friendly instructions:
"${transcribedText}"

Agent instructions:`;
                            break;

                        default:
                            // No enhancement needed
                            break;
                    }

                    // Only make GPT call if we have a prompt
                    if (prompt) {
                        const completion = await openai.chat.completions.create({
                            model: 'gpt-4o-mini',
                            messages: [
                                { role: 'system', content: systemMessage },
                                { role: 'user', content: prompt }
                            ],
                            temperature: temperature,
                            max_tokens: maxTokens
                        });

                        transcribedText = completion.choices[0].message.content || transcribedText;
                    }

                } catch (gptError) {
                    console.error('GPT processing error:', gptError);
                    // Fall back to original transcription if GPT fails
                }

                res.json({ text: transcribedText });

            } catch (error) {
                console.error('Transcription error:', error);
                res.status(500).json({ error: error.message });
            }
        });
    } catch (error) {
        console.error('Endpoint error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Image upload endpoint
app.post('/api/projects/:projectName/upload-images', authenticateToken, async (req, res) => {
    try {
        const multer = (await import('multer')).default;
        const path = (await import('path')).default;
        const fs = (await import('fs')).promises;
        const os = (await import('os')).default;

        // Configure multer for image uploads
        const storage = multer.diskStorage({
            destination: async (req, file, cb) => {
                const uploadDir = path.join(os.tmpdir(), 'claude-ui-uploads', String(req.user.id));
                await fs.mkdir(uploadDir, { recursive: true });
                cb(null, uploadDir);
            },
            filename: (req, file, cb) => {
                const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
                const sanitizedName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
                cb(null, uniqueSuffix + '-' + sanitizedName);
            }
        });

        const fileFilter = (req, file, cb) => {
            const allowedMimes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'];
            if (allowedMimes.includes(file.mimetype)) {
                cb(null, true);
            } else {
                cb(new Error('Invalid file type. Only JPEG, PNG, GIF, WebP, and SVG are allowed.'));
            }
        };

        const upload = multer({
            storage,
            fileFilter,
            limits: {
                fileSize: 5 * 1024 * 1024, // 5MB
                files: 5
            }
        });

        // Handle multipart form data
        upload.array('images', 5)(req, res, async (err) => {
            if (err) {
                return res.status(400).json({ error: err.message });
            }

            if (!req.files || req.files.length === 0) {
                return res.status(400).json({ error: 'No image files provided' });
            }

            try {
                // Process uploaded images
                const processedImages = await Promise.all(
                    req.files.map(async (file) => {
                        // Read file and convert to base64
                        const buffer = await fs.readFile(file.path);
                        const base64 = buffer.toString('base64');
                        const mimeType = file.mimetype;

                        // Clean up temp file immediately
                        await fs.unlink(file.path);

                        return {
                            name: file.originalname,
                            data: `data:${mimeType};base64,${base64}`,
                            size: file.size,
                            mimeType: mimeType
                        };
                    })
                );

                res.json({ images: processedImages });
            } catch (error) {
                console.error('Error processing images:', error);
                // Clean up any remaining files
                await Promise.all(req.files.map(f => fs.unlink(f.path).catch(() => { })));
                res.status(500).json({ error: 'Failed to process images' });
            }
        });
    } catch (error) {
        console.error('Error in image upload endpoint:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get token usage for a specific session
app.get('/api/projects/:projectName/sessions/:sessionId/token-usage', authenticateToken, async (req, res) => {
  try {
    const { projectName, sessionId } = req.params;
    const { provider = 'claude' } = req.query;
    const homeDir = os.homedir();

    // Allow only safe characters in sessionId
    const safeSessionId = String(sessionId).replace(/[^a-zA-Z0-9._-]/g, '');
    if (!safeSessionId) {
      return res.status(400).json({ error: 'Invalid sessionId' });
    }

    // Handle Codex sessions
    if (provider === 'codex') {
      const codexSessionsDir = path.join(homeDir, '.codex', 'sessions');

      // Find the session file by searching for the session ID
      const findSessionFile = async (dir) => {
        try {
          const entries = await fsPromises.readdir(dir, { withFileTypes: true });
          for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              const found = await findSessionFile(fullPath);
              if (found) return found;
            } else if (entry.name.includes(safeSessionId) && entry.name.endsWith('.jsonl')) {
              return fullPath;
            }
          }
        } catch (error) {
          // Skip directories we can't read
        }
        return null;
      };

      const sessionFilePath = await findSessionFile(codexSessionsDir);

      if (!sessionFilePath) {
        return res.status(404).json({ error: 'Codex session file not found', sessionId: safeSessionId });
      }

      // Read and parse the Codex JSONL file
      let fileContent;
      try {
        fileContent = await fsPromises.readFile(sessionFilePath, 'utf8');
      } catch (error) {
        if (error.code === 'ENOENT') {
          return res.status(404).json({ error: 'Session file not found', path: sessionFilePath });
        }
        throw error;
      }
      const lines = fileContent.trim().split('\n');
      let totalTokens = 0;
      let contextWindow = 200000; // Default for Codex/OpenAI

      // Find the latest token_count event with info (scan from end)
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const entry = JSON.parse(lines[i]);

          // Codex stores token info in event_msg with type: "token_count"
          if (entry.type === 'event_msg' && entry.payload?.type === 'token_count' && entry.payload?.info) {
            const tokenInfo = entry.payload.info;
            if (tokenInfo.total_token_usage) {
              totalTokens = tokenInfo.total_token_usage.total_tokens || 0;
            }
            if (tokenInfo.model_context_window) {
              contextWindow = tokenInfo.model_context_window;
            }
            break; // Stop after finding the latest token count
          }
        } catch (parseError) {
          // Skip lines that can't be parsed
          continue;
        }
      }

      return res.json({
        used: totalTokens,
        total: contextWindow
      });
    }

    // Handle Claude sessions (default)
    // Extract actual project path
    let projectPath;
    try {
      projectPath = await extractProjectDirectory(projectName);
    } catch (error) {
      console.error('Error extracting project directory:', error);
      return res.status(500).json({ error: 'Failed to determine project path' });
    }

    // Construct the JSONL file path
    // Claude stores session files in ~/.claude/projects/[encoded-project-path]/[session-id].jsonl
    // The encoding replaces /, spaces, ~, and _ with -
    const encodedPath = projectPath.replace(/[\\/:\s~_]/g, '-');
    const projectDir = path.join(homeDir, '.claude', 'projects', encodedPath);

    const jsonlPath = path.join(projectDir, `${safeSessionId}.jsonl`);

    // Constrain to projectDir
    const rel = path.relative(path.resolve(projectDir), path.resolve(jsonlPath));
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      return res.status(400).json({ error: 'Invalid path' });
    }

    // Read and parse the JSONL file
    let fileContent;
    try {
      fileContent = await fsPromises.readFile(jsonlPath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') {
        return res.status(404).json({ error: 'Session file not found', path: jsonlPath });
      }
      throw error; // Re-throw other errors to be caught by outer try-catch
    }
    const lines = fileContent.trim().split('\n');

    const parsedContextWindow = parseInt(process.env.CONTEXT_WINDOW, 10);
    const contextWindow = Number.isFinite(parsedContextWindow) ? parsedContextWindow : 160000;
    let inputTokens = 0;
    let cacheCreationTokens = 0;
    let cacheReadTokens = 0;

    // Find the latest assistant message with usage data (scan from end)
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);

        // Only count assistant messages which have usage data
        if (entry.type === 'assistant' && entry.message?.usage) {
          const usage = entry.message.usage;

          // Use token counts from latest assistant message only
          inputTokens = usage.input_tokens || 0;
          cacheCreationTokens = usage.cache_creation_input_tokens || 0;
          cacheReadTokens = usage.cache_read_input_tokens || 0;

          break; // Stop after finding the latest assistant message
        }
      } catch (parseError) {
        // Skip lines that can't be parsed
        continue;
      }
    }

    // Calculate total context usage (excluding output_tokens, as per ccusage)
    const totalUsed = inputTokens + cacheCreationTokens + cacheReadTokens;

    res.json({
      used: totalUsed,
      total: contextWindow,
      breakdown: {
        input: inputTokens,
        cacheCreation: cacheCreationTokens,
        cacheRead: cacheReadTokens
      }
    });
  } catch (error) {
    console.error('Error reading session token usage:', error);
    res.status(500).json({ error: 'Failed to read session token usage' });
  }
});

// Serve React app for all other routes (excluding static files)
app.get('*', (req, res) => {
  // Skip requests for static assets (files with extensions)
  if (path.extname(req.path)) {
    return res.status(404).send('Not found');
  }

  // Only serve index.html for HTML routes, not for static assets
  // Static assets should already be handled by express.static middleware above
  const indexPath = path.join(__dirname, '../dist/index.html');

  // Check if dist/index.html exists (production build available)
  if (fs.existsSync(indexPath)) {
    // Set no-cache headers for HTML to prevent service worker issues
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.sendFile(indexPath);
  } else {
    // In development, redirect to Vite dev server only if dist doesn't exist
    res.redirect(`http://localhost:${process.env.VITE_PORT || 5173}`);
  }
});

const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || '0.0.0.0';
// Show localhost in URL when binding to all interfaces (0.0.0.0 isn't a connectable address)
const DISPLAY_HOST = HOST === '0.0.0.0' ? 'localhost' : HOST;

// Initialize database and start server
async function startServer() {
    try {
        isServerShuttingDown = false;

        // Initialize authentication database
        await initializeDatabase();

        // Check if running in production mode (dist folder exists)
        const distIndexPath = path.join(__dirname, '../dist/index.html');
        const isProduction = fs.existsSync(distIndexPath);

        // Log Claude implementation mode
        console.log(`${c.info('[INFO]')} Using Claude Agents SDK for Claude integration`);
        console.log(`${c.info('[INFO]')} Running in ${c.bright(isProduction ? 'PRODUCTION' : 'DEVELOPMENT')} mode`);

        if (!isProduction) {
            console.log(`${c.warn('[WARN]')} Note: Requests will be proxied to Vite dev server at ${c.dim('http://localhost:' + (process.env.VITE_PORT || 5173))}`);
        }

        server.listen(PORT, HOST, async () => {
            const appInstallPath = path.join(__dirname, '..');

            console.log('');
            console.log(c.dim('='.repeat(63)));
            console.log(`  ${c.bright('OpenWork Server - Ready')}`);
            console.log(c.dim('='.repeat(63)));
            console.log('');
            console.log(`${c.info('[INFO]')} Server URL:  ${c.bright('http://' + DISPLAY_HOST + ':' + PORT)}`);
            console.log(`${c.info('[INFO]')} Installed at: ${c.dim(appInstallPath)}`);
            console.log(`${c.tip('[TIP]')}  Run "openwork status" for full configuration details`);
            console.log('');

            // Start watching the projects folder for changes
            await setupProjectsWatcher();
        });
    } catch (error) {
        console.error('[ERROR] Failed to start server:', error);
        process.exit(1);
    }
}

// Export for external use (e.g., Electron embedded server)
export { app, server, startServer, shutdownServerResources };

// Auto-start server only if this file is run directly (not imported).
// Use normalized absolute paths so Windows separators don't break detection.
const currentModulePath = path.resolve(fileURLToPath(import.meta.url));
const entryArgPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
const normalizeModulePath = (value) => (IS_WINDOWS ? value.toLowerCase() : value);
const isMainModule =
  Boolean(entryArgPath) &&
  normalizeModulePath(currentModulePath) === normalizeModulePath(entryArgPath);

if (isMainModule) {
  startServer();
}



