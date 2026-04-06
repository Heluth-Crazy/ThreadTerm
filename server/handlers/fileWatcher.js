import path from 'path';
import os from 'os';
import { promises as fsPromises } from 'fs';
import { WebSocket } from 'ws';
import { logger } from '../utils/logger.js';
import { getProjects, clearProjectDirectoryCache } from '../projects.js';

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
export const connectedClients = new Set();
let isGetProjectsRunning = false; // Flag to prevent reentrant calls

// Broadcast progress to all connected WebSocket clients
export function broadcastProgress(progress) {
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
export async function setupProjectsWatcher() {
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
                logger.warn('Failed to close watcher:', error);
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
                logger.error('Error handling project changes:', error);
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
                    logger.error(`${provider} watcher error:`, error);
                })
                .on('ready', () => {
                });

            projectsWatchers.push(watcher);
        } catch (error) {
            logger.error(`Failed to setup ${provider} watcher for ${rootPath}:`, error);
        }
    }

    if (projectsWatchers.length === 0) {
        logger.error('Failed to setup any provider watchers');
    }
}

export async function closeProjectsWatchers() {
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
                logger.warn('Failed to close watcher during shutdown:', error);
            }
        })
    );
}
