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

logger.debug('PORT from env:', process.env.PORT);

import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import os from 'os';
import http from 'http';
import cors from 'cors';
import { promises as fsPromises } from 'fs';
import { spawn } from 'child_process';
import fetch from 'node-fetch';
import mime from 'mime-types';

import { getProjects, getSessions, getSessionMessages, renameProject, renameSession, deleteSession, deleteProject, addProjectManually, extractProjectDirectory } from './projects.js';
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
import { logger } from './utils/logger.js';
import { connectedClients, broadcastProgress, setupProjectsWatcher, closeProjectsWatchers } from './handlers/fileWatcher.js';
import { startProjectWatcher, stopProjectWatcher, stopAllProjectWatchers } from './handlers/projectFileWatcher.js';
import { setupWsHandler, handleChatConnection } from './handlers/wsHandler.js';
import { ptySessionsMap, IS_WINDOWS, buildEnhancedPath, sanitizeAgentOptions, isPtyProcessAlive, terminateAllPtySessions, setupShellHandler } from './handlers/ptyHandler.js';
import slashCommandsRoutes from './routes/slash-commands.js';

let isServerShuttingDown = false;
let shutdownServerResourcesPromise = null;

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
            logger.warn('Failed to close chat WebSocket client during shutdown:', error);
        }
    });

    connectedClients.clear();
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
            logger.warn('WebSocket server close timed out');
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
                        logger.warn('Failed to terminate WebSocket client:', error);
                    }
                });
            }

            wss.close((error) => {
                clearTimeout(timeoutId);
                if (error) {
                    logger.warn('Error closing WebSocket server:', error);
                    finish(false);
                    return;
                }
                finish(true);
            });
        } catch (error) {
            clearTimeout(timeoutId);
            logger.warn('Failed to close WebSocket server:', error);
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
            logger.warn('HTTP server close timed out');
            try {
                if (typeof server.closeAllConnections === 'function') {
                    server.closeAllConnections();
                }
                if (typeof server.closeIdleConnections === 'function') {
                    server.closeIdleConnections();
                }
            } catch (error) {
                logger.warn('Error forcing HTTP connection close:', error);
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
                    logger.warn('Error closing HTTP server:', error);
                    finish(false);
                    return;
                }
                finish(true);
            });
        } catch (error) {
            clearTimeout(timeoutId);
            logger.warn('Failed to close HTTP server:', error);
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
        logger.info('Shutting down backend server resources...');

        await closeProjectsWatchers();
        await stopAllProjectWatchers();
        closeConnectedChatClients();
        terminateAllPtySessions();
        await closeWebSocketServer(Math.min(1500, timeout));

        const httpClosed = await closeHttpServer(timeout);
        logger.info(`Backend shutdown completed (httpClosed=${httpClosed})`);
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

// Single WebSocket server that handles both paths
const wss = new WebSocketServer({
    server,
    verifyClient: (info) => {
        logger.debug('WebSocket connection attempt to:', info.req.url);

        // SIMPLIFIED: Always allow WebSocket connections without authentication
        // Try to get user info if token is provided (backward compatibility)
        const url = new URL(info.req.url, 'http://localhost');
        const token = url.searchParams.get('token') ||
            info.req.headers.authorization?.split(' ')[1];

        const user = authenticateWebSocket(token);
        info.req.user = user;
        logger.debug('WebSocket connected for user:', user.username || 'anonymous');
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

// Custom slash commands API Routes (protected)
app.use('/api/slash-commands', authenticateToken, slashCommandsRoutes);

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

        logger.debug('Starting system update from directory:', projectRoot);

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
            logger.debug('Update output:', text);
        });

        child.stderr.on('data', (data) => {
            const text = data.toString();
            errorOutput += text;
            logger.warn('Update error output:', text);
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
            logger.error('Update process error:', error);
            res.status(500).json({
                success: false,
                error: error.message
            });
        });

    } catch (error) {
        logger.error('System update error:', error);
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

// Rename session endpoint
app.put('/api/projects/:projectName/sessions/:sessionId/rename', authenticateToken, async (req, res) => {
    try {
        const { projectName, sessionId } = req.params;
        const { title } = req.body;
        await renameSession(projectName, sessionId, title);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Delete session endpoint
app.delete('/api/projects/:projectName/sessions/:sessionId', authenticateToken, async (req, res) => {
    try {
        const { projectName, sessionId } = req.params;
        logger.debug(`Deleting session: ${sessionId} from project: ${projectName}`);
        await deleteSession(projectName, sessionId);
        logger.debug(`Session ${sessionId} deleted successfully`);
        res.json({ success: true });
    } catch (error) {
        logger.error(`Error deleting session ${req.params.sessionId}:`, error);
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
        logger.error('Error creating project:', error);
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
        logger.error('Error listing filesystem roots:', error);
        return res.status(500).json({ error: 'Failed to list filesystem roots' });
    }
});

// Browse filesystem endpoint for project suggestions - uses existing getFileTree
app.get('/api/browse-filesystem', authenticateToken, async (req, res) => {
    try {
        const { path: dirPath } = req.query;
        
        logger.debug('Browse filesystem request for path:', dirPath);
        logger.debug('WORKSPACES_ROOT is:', WORKSPACES_ROOT);
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
        logger.error('Error browsing filesystem:', error);
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
        logger.error('Error creating folder:', error);
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
        logger.error('Error reading file:', error);
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
        logger.error('Error serving binary file:', error);
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
        logger.error('Error saving file:', error);
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
            logger.error('Error extracting project directory:', error);
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
        logger.error('File tree error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Wire up WebSocket handlers from extracted modules
setupWsHandler(wss, sanitizeAgentOptions);
setupShellHandler(wss, () => isServerShuttingDown);

// WebSocket connection handler that routes based on URL path
wss.on('connection', (ws, request) => {
    const url = request.url;
    logger.info('Client connected to:', url);

    // Parse URL to get pathname without query parameters
    const urlObj = new URL(url, 'http://localhost');
    const pathname = urlObj.pathname;

    if (pathname === '/shell') {
        wss._handleShellConnection(ws);
    } else if (pathname === '/ws') {
        wss._handleChatConnection(ws);
    } else {
        logger.warn('Unknown WebSocket path:', pathname);
        ws.close();
    }
});

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
                    logger.error('GPT processing error:', gptError);
                    // Fall back to original transcription if GPT fails
                }

                res.json({ text: transcribedText });

            } catch (error) {
                logger.error('Transcription error:', error);
                res.status(500).json({ error: error.message });
            }
        });
    } catch (error) {
        logger.error('Endpoint error:', error);
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
                logger.error('Error processing images:', error);
                // Clean up any remaining files
                await Promise.all(req.files.map(f => fs.unlink(f.path).catch(() => { })));
                res.status(500).json({ error: 'Failed to process images' });
            }
        });
    } catch (error) {
        logger.error('Error in image upload endpoint:', error);
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
      logger.error('Error extracting project directory:', error);
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
    logger.error('Error reading session token usage:', error);
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
        logger.error('Failed to start server:', error);
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



