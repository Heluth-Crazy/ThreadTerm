import path from 'path';
import { WebSocket } from 'ws';
import { logger } from '../utils/logger.js';
import { connectedClients } from './fileWatcher.js';

const IGNORED_PATTERNS = [
  '**/node_modules/**',
  '**/.git/**',
  '**/__pycache__/**',
  '**/.DS_Store',
  '**/*.log',
  '**/dist/**',
  '**/build/**',
  '**/*.tmp',
  '**/*.swp',
];

const DEBOUNCE_MS = 500;

// Map of normalized projectPath → { watcher, debounceTimer }
const activeWatchers = new Map();

function broadcast(message) {
  const payload = JSON.stringify(message);
  connectedClients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

/**
 * Start watching a project directory for file changes.
 * Emits 'file-changed' and 'git-status-changed' WS messages.
 */
export async function startProjectWatcher(projectPath) {
  const normalized = path.normalize(projectPath);

  if (activeWatchers.has(normalized)) {
    logger.debug(`[ProjectFileWatcher] Already watching: ${normalized}`);
    return;
  }

  try {
    const chokidar = (await import('chokidar')).default;

    const watcher = chokidar.watch(normalized, {
      ignored: IGNORED_PATTERNS,
      persistent: true,
      ignoreInitial: true,
      followSymlinks: false,
      depth: 20,
      awaitWriteFinish: {
        stabilityThreshold: 150,
        pollInterval: 50,
      },
    });

    let debounceTimer = null;
    let pendingEvents = [];

    const flushEvents = () => {
      if (pendingEvents.length === 0) return;

      // Deduplicate: keep the last event per filePath
      const seen = new Map();
      for (const evt of pendingEvents) {
        seen.set(evt.filePath, evt);
      }
      const events = Array.from(seen.values());
      pendingEvents = [];

      // Emit individual file-changed events
      for (const evt of events) {
        broadcast({
          type: 'file-changed',
          projectPath: normalized,
          eventType: evt.eventType,
          filePath: evt.filePath,
        });
      }

      // Emit a single git-status-changed event
      broadcast({
        type: 'git-status-changed',
        projectPath: normalized,
      });
    };

    const onEvent = (eventType, filePath) => {
      const relativePath = path.relative(normalized, filePath);
      pendingEvents.push({ eventType, filePath: relativePath });

      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
      debounceTimer = setTimeout(flushEvents, DEBOUNCE_MS);
    };

    watcher
      .on('add', (fp) => onEvent('add', fp))
      .on('change', (fp) => onEvent('change', fp))
      .on('unlink', (fp) => onEvent('unlink', fp))
      .on('addDir', (fp) => onEvent('addDir', fp))
      .on('unlinkDir', (fp) => onEvent('unlinkDir', fp))
      .on('error', (error) => {
        logger.error(`[ProjectFileWatcher] Error for ${normalized}:`, error);
      });

    activeWatchers.set(normalized, { watcher, debounceTimer: null });
    logger.info(`[ProjectFileWatcher] Started watching: ${normalized}`);
  } catch (error) {
    logger.error(`[ProjectFileWatcher] Failed to start watcher for ${normalized}:`, error);
  }
}

/**
 * Stop watching a project directory.
 */
export async function stopProjectWatcher(projectPath) {
  const normalized = path.normalize(projectPath);
  const entry = activeWatchers.get(normalized);

  if (!entry) {
    logger.debug(`[ProjectFileWatcher] Not watching: ${normalized}`);
    return;
  }

  try {
    if (entry.debounceTimer) {
      clearTimeout(entry.debounceTimer);
    }
    await entry.watcher.close();
  } catch (error) {
    logger.warn(`[ProjectFileWatcher] Error closing watcher for ${normalized}:`, error);
  }

  activeWatchers.delete(normalized);
  logger.info(`[ProjectFileWatcher] Stopped watching: ${normalized}`);
}

/**
 * Stop all active project file watchers.
 */
export async function stopAllProjectWatchers() {
  const paths = Array.from(activeWatchers.keys());
  await Promise.all(paths.map((p) => stopProjectWatcher(p)));
  logger.info('[ProjectFileWatcher] All watchers stopped');
}
