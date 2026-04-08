/**
 * OpenAI Codex SDK Integration
 * =============================
 *
 * This module provides integration with the OpenAI Codex SDK for non-interactive
 * chat sessions. It mirrors the pattern used in claude-sdk.js for consistency.
 *
 * ## Usage
 *
 * - queryCodex(command, options, ws) - Execute a prompt with streaming via WebSocket
 * - abortCodexSession(sessionId) - Cancel an active session
 * - isCodexSessionActive(sessionId) - Check if a session is running
 * - getActiveCodexSessions() - List all active sessions
 */

import { Codex } from '@openai/codex-sdk';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

// Track active sessions
const activeCodexSessions = new Map();
const moduleRequire = createRequire(import.meta.url);

const PLATFORM_PACKAGE_BY_TARGET = {
  'x86_64-unknown-linux-musl': '@openai/codex-linux-x64',
  'aarch64-unknown-linux-musl': '@openai/codex-linux-arm64',
  'x86_64-apple-darwin': '@openai/codex-darwin-x64',
  'aarch64-apple-darwin': '@openai/codex-darwin-arm64',
  'x86_64-pc-windows-msvc': '@openai/codex-win32-x64',
  'aarch64-pc-windows-msvc': '@openai/codex-win32-arm64',
};

function isAsarPath(candidatePath) {
  if (!candidatePath) return false;
  return candidatePath.includes(`${path.sep}app.asar${path.sep}`) || candidatePath.endsWith(`${path.sep}app.asar`);
}

function resolvePackagedResourceCodexBinary(targetTriple) {
  if (!targetTriple || !process.resourcesPath) {
    return null;
  }

  const binaryName = process.platform === 'win32' ? 'codex.exe' : 'codex';
  const archFolder = process.platform === 'win32' && process.arch === 'arm64' ? 'win-arm64' : 'win-x64';
  const resourceCandidate = path.join(
    process.resourcesPath,
    'codex-binary',
    archFolder,
    binaryName,
  );

  if (fs.existsSync(resourceCandidate)) {
    return resourceCandidate;
  }

  return null;
}

function getCodexTargetTriple() {
  const { platform: currentPlatform, arch } = process;

  if (currentPlatform === 'darwin') {
    if (arch === 'x64') return 'x86_64-apple-darwin';
    if (arch === 'arm64') return 'aarch64-apple-darwin';
  }

  if (currentPlatform === 'win32') {
    if (arch === 'x64') return 'x86_64-pc-windows-msvc';
    if (arch === 'arm64') return 'aarch64-pc-windows-msvc';
  }

  if (currentPlatform === 'linux' || currentPlatform === 'android') {
    if (arch === 'x64') return 'x86_64-unknown-linux-musl';
    if (arch === 'arm64') return 'aarch64-unknown-linux-musl';
  }

  return null;
}

function resolveCodexBinaryFromPackageJson(codexPackageJsonPath) {
  const targetTriple = getCodexTargetTriple();
  if (!targetTriple || !codexPackageJsonPath) {
    return null;
  }

  const platformPackage = PLATFORM_PACKAGE_BY_TARGET[targetTriple];
  if (!platformPackage) {
    return null;
  }

  try {
    const codexRequire = createRequire(codexPackageJsonPath);
    const platformPackageJsonPath = codexRequire.resolve(`${platformPackage}/package.json`);
    const vendorRoot = path.join(path.dirname(platformPackageJsonPath), 'vendor');
    const binaryName = process.platform === 'win32' ? 'codex.exe' : 'codex';
    const binaryPath = path.join(vendorRoot, targetTriple, 'codex', binaryName);
    const asarMarker = `${path.sep}app.asar${path.sep}`;

    if (binaryPath.includes(asarMarker)) {
      const unpackedBinaryPath = binaryPath.replace(
        asarMarker,
        `${path.sep}app.asar.unpacked${path.sep}`,
      );
      if (fs.existsSync(unpackedBinaryPath)) {
        return unpackedBinaryPath;
      }
    }

    const packagedResourceBinary = resolvePackagedResourceCodexBinary(targetTriple);
    if (packagedResourceBinary) {
      return packagedResourceBinary;
    }

    if (fs.existsSync(binaryPath)) {
      // fs.existsSync() can succeed for paths inside app.asar, but executables
      // cannot be spawned directly from inside asar archives.
      if (isAsarPath(binaryPath)) {
        return null;
      }
      return binaryPath;
    }
  } catch {
    // Fall through to CLI lookup via PATH if packaged binary resolution fails.
  }

  return null;
}

function resolveBundledCodexPath() {
  try {
    const codexPackageJsonPath = moduleRequire.resolve('@openai/codex/package.json');
    return resolveCodexBinaryFromPackageJson(codexPackageJsonPath);
  } catch {
    return null;
  }
}

function findExecutableInPath(commandName) {
  const pathEnv = process.env.PATH || '';
  const entries = pathEnv.split(path.delimiter).filter(Boolean);
  const isWindows = process.platform === 'win32';
  const extensions = isWindows
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM')
      .split(';')
      .filter(Boolean)
      .map((ext) => ext.toLowerCase())
    : [''];

  for (const entry of entries) {
    const candidateBase = path.join(entry, commandName);
    if (isWindows) {
      for (const ext of extensions) {
        const candidate = candidateBase.toLowerCase().endsWith(ext)
          ? candidateBase
          : `${candidateBase}${ext}`;
        if (fs.existsSync(candidate)) {
          return candidate;
        }
      }
    } else if (fs.existsSync(candidateBase)) {
      return candidateBase;
    }
  }

  return null;
}

function resolveSystemCodexPath() {
  const codexCommandPath = findExecutableInPath('codex');
  if (!codexCommandPath) {
    return null;
  }
  if (isAsarPath(codexCommandPath)) {
    return null;
  }

  if (process.platform !== 'win32') {
    return codexCommandPath;
  }

  // On Windows the command discovered in PATH is usually codex.cmd/codex.ps1.
  // Claude/Codex transports expect a native executable path, so resolve the
  // real vendor binary from the global package install when possible.
  if (!/\.(cmd|ps1|bat)$/i.test(codexCommandPath)) {
    return codexCommandPath;
  }

  const launcherDir = path.dirname(codexCommandPath);
  const globalCodexPackageJson = path.join(launcherDir, 'node_modules', '@openai', 'codex', 'package.json');
  if (!fs.existsSync(globalCodexPackageJson)) {
    return null;
  }

  return resolveCodexBinaryFromPackageJson(globalCodexPackageJson);
}

export function resolveCodexExecutablePath() {
  const explicitPath = typeof process.env.CODEX_CLI_PATH === 'string'
    ? process.env.CODEX_CLI_PATH.trim()
    : '';
  if (explicitPath) {
    if (isAsarPath(explicitPath)) {
      return null;
    }
    return explicitPath;
  }

  // Prefer globally installed Codex first so users who upgraded via
  // `npm install -g @openai/codex` don't get stuck on bundled older versions.
  const systemCodexPath = resolveSystemCodexPath();
  if (systemCodexPath) {
    return systemCodexPath;
  }

  return resolveBundledCodexPath();
}

function resolveWorkingDirectory(...candidates) {
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'string') {
      continue;
    }

    const resolved = path.resolve(candidate.trim());

    try {
      const stats = fs.statSync(resolved);
      if (stats.isDirectory()) {
        return resolved;
      }
      if (stats.isFile()) {
        const parentDir = path.dirname(resolved);
        if (fs.existsSync(parentDir) && fs.statSync(parentDir).isDirectory()) {
          return parentDir;
        }
      }
    } catch {
      const parentDir = path.dirname(resolved);
      try {
        if (fs.existsSync(parentDir) && fs.statSync(parentDir).isDirectory()) {
          return parentDir;
        }
      } catch {
        // Continue trying other candidates.
      }
    }
  }

  return process.cwd();
}

/**
 * Transform Codex SDK event to WebSocket message format
 * @param {object} event - SDK event
 * @returns {object} - Transformed event for WebSocket
 */
function transformCodexEvent(event) {
  // Map SDK event types to a consistent format
  switch (event.type) {
    case 'item.started':
    case 'item.updated':
    case 'item.completed':
      const item = event.item;
      if (!item) {
        return { type: event.type, item: null };
      }

      // Transform based on item type
      switch (item.type) {
        case 'agent_message':
          return {
            type: 'item',
            itemType: 'agent_message',
            message: {
              role: 'assistant',
              content: item.text ?? item.content ?? ''
            }
          };

        case 'reasoning':
          return {
            type: 'item',
            itemType: 'reasoning',
            message: {
              role: 'assistant',
              content: item.text ?? item.content ?? '',
              isReasoning: true
            }
          };

        case 'command_execution':
          return {
            type: 'item',
            itemType: 'command_execution',
            command: item.command,
            output: item.aggregated_output,
            exitCode: item.exit_code,
            status: item.status
          };

        case 'file_change':
          return {
            type: 'item',
            itemType: 'file_change',
            changes: item.changes,
            status: item.status
          };

        case 'mcp_tool_call':
          return {
            type: 'item',
            itemType: 'mcp_tool_call',
            server: item.server,
            tool: item.tool,
            arguments: item.arguments,
            result: item.result,
            error: item.error,
            status: item.status
          };

        case 'web_search':
          return {
            type: 'item',
            itemType: 'web_search',
            query: item.query
          };

        case 'todo_list':
          return {
            type: 'item',
            itemType: 'todo_list',
            items: item.items
          };

        case 'error':
          return {
            type: 'item',
            itemType: 'error',
            message: {
              role: 'error',
              content: item.message
            }
          };

        default:
          return {
            type: 'item',
            itemType: item.type,
            item: item
          };
      }

    case 'turn.started':
      return {
        type: 'turn_started'
      };

    case 'turn.completed':
      return {
        type: 'turn_complete',
        usage: event.usage
      };

    case 'turn.failed':
      return {
        type: 'turn_failed',
        error: event.error
      };

    case 'thread.started':
      return {
        type: 'thread_started',
        threadId: event.id
      };

    case 'error':
      return {
        type: 'error',
        message: event.message
      };

    default:
      return {
        type: event.type,
        data: event
      };
  }
}

/**
 * Map permission mode to Codex SDK options
 * @param {string} permissionMode - 'default', 'acceptEdits', or 'bypassPermissions'
 * @returns {object} - { sandboxMode, approvalPolicy }
 */
function mapPermissionModeToCodexOptions(permissionMode) {
  switch (permissionMode) {
    case 'acceptEdits':
      return {
        sandboxMode: 'workspace-write',
        approvalPolicy: 'never'
      };
    case 'bypassPermissions':
      return {
        sandboxMode: 'danger-full-access',
        approvalPolicy: 'never'
      };
    case 'default':
    default:
      return {
        sandboxMode: 'workspace-write',
        approvalPolicy: 'untrusted'
      };
  }
}

/**
 * Execute a Codex query with streaming
 * @param {string} command - The prompt to send
 * @param {object} options - Options including cwd, sessionId, model, permissionMode
 * @param {WebSocket|object} ws - WebSocket connection or response writer
 */
export async function queryCodex(command, options = {}, ws) {
  const {
    sessionId,
    cwd,
    projectPath,
    model,
    permissionMode = 'default'
  } = options;

  const workingDirectory = resolveWorkingDirectory(cwd, projectPath, process.cwd(), os.homedir());
  // Always pass an explicit binary path when resolvable so packaged apps do not
  // fall back to SDK defaults that can point into app.asar on Windows.
  const codexPathOverride = resolveCodexExecutablePath();
  const { sandboxMode, approvalPolicy } = mapPermissionModeToCodexOptions(permissionMode);

  let codex;
  let thread;
  let currentSessionId = sessionId;
  const abortController = new AbortController();

  try {
    // Initialize Codex SDK
    codex = codexPathOverride ? new Codex({ codexPathOverride }) : new Codex();
    if (codexPathOverride) {
      console.log('[Codex] Using executable:', codexPathOverride);
    } else {
      console.warn('[Codex] No explicit executable resolved, falling back to SDK default resolution');
    }

    // Thread options with sandbox and approval settings
    const threadOptions = {
      workingDirectory,
      skipGitRepoCheck: true,
      sandboxMode,
      approvalPolicy,
      ...(typeof model === 'string' && model.trim().length > 0 ? { model: model.trim() } : {})
    };

    // Start or resume thread
    if (sessionId) {
      thread = codex.resumeThread(sessionId, threadOptions);
    } else {
      thread = codex.startThread(threadOptions);
    }

    // Get the thread ID
    currentSessionId = thread.id || sessionId || `codex-${Date.now()}`;

    // Track the session
    activeCodexSessions.set(currentSessionId, {
      thread,
      codex,
      status: 'running',
      abortController,
      startedAt: new Date().toISOString()
    });

    // Send session created event
    sendMessage(ws, {
      type: 'session-created',
      sessionId: currentSessionId,
      originalSessionId: sessionId || null,
      provider: 'codex'
    });

    // Execute with streaming
    const streamedTurn = await thread.runStreamed(command, {
      signal: abortController.signal
    });

    for await (const event of streamedTurn.events) {
      // Check if session was aborted
      const session = activeCodexSessions.get(currentSessionId);
      if (!session || session.status === 'aborted') {
        break;
      }

      if (event.type === 'item.started' || event.type === 'item.updated') {
        continue;
      }

      const transformed = transformCodexEvent(event);

      sendMessage(ws, {
        type: 'codex-response',
        data: transformed,
        sessionId: currentSessionId
      });

      // Extract and send token usage if available (normalized to match Claude format)
      if (event.type === 'turn.completed' && event.usage) {
        const totalTokens = (event.usage.input_tokens || 0) + (event.usage.output_tokens || 0);
        sendMessage(ws, {
          type: 'token-budget',
          data: {
            used: totalTokens,
            total: 200000 // Default context window for Codex models
          },
          sessionId: currentSessionId
        });
      }
    }

    // Send completion event
    sendMessage(ws, {
      type: 'codex-complete',
      sessionId: currentSessionId,
      actualSessionId: thread.id
    });

  } catch (error) {
    const session = currentSessionId ? activeCodexSessions.get(currentSessionId) : null;
    const wasAborted =
      session?.status === 'aborted' ||
      error?.name === 'AbortError' ||
      String(error?.message || '').toLowerCase().includes('aborted');

    if (!wasAborted) {
      console.error('[Codex] Error:', error);
      sendMessage(ws, {
        type: 'codex-error',
        error: error.message,
        sessionId: currentSessionId
      });
    }

  } finally {
    // Update session status
    if (currentSessionId) {
      const session = activeCodexSessions.get(currentSessionId);
      if (session) {
        session.status = session.status === 'aborted' ? 'aborted' : 'completed';
      }
    }
  }
}

/**
 * Abort an active Codex session
 * @param {string} sessionId - Session ID to abort
 * @returns {boolean} - Whether abort was successful
 */
export function abortCodexSession(sessionId) {
  const session = activeCodexSessions.get(sessionId);

  if (!session) {
    return false;
  }

  session.status = 'aborted';
  try {
    session.abortController?.abort();
  } catch (error) {
    console.warn(`[Codex] Failed to abort session ${sessionId}:`, error);
  }

  return true;
}

/**
 * Check if a session is active
 * @param {string} sessionId - Session ID to check
 * @returns {boolean} - Whether session is active
 */
export function isCodexSessionActive(sessionId) {
  const session = activeCodexSessions.get(sessionId);
  return session?.status === 'running';
}

/**
 * Get all active sessions
 * @returns {Array} - Array of active session info
 */
export function getActiveCodexSessions() {
  const sessions = [];

  for (const [id, session] of activeCodexSessions.entries()) {
    if (session.status === 'running') {
      sessions.push({
        id,
        status: session.status,
        startedAt: session.startedAt
      });
    }
  }

  return sessions;
}

/**
 * Helper to send message via WebSocket or writer
 * @param {WebSocket|object} ws - WebSocket or response writer
 * @param {object} data - Data to send
 */
function sendMessage(ws, data) {
  try {
    if (ws.isSSEStreamWriter || ws.isWebSocketWriter) {
      // Writer handles stringification (SSEStreamWriter or WebSocketWriter)
      ws.send(data);
    } else if (typeof ws.send === 'function') {
      // Raw WebSocket - stringify here
      ws.send(JSON.stringify(data));
    }
  } catch (error) {
    console.error('[Codex] Error sending message:', error);
  }
}

// Clean up old completed sessions periodically
setInterval(() => {
  const now = Date.now();
  const maxAge = 30 * 60 * 1000; // 30 minutes

  for (const [id, session] of activeCodexSessions.entries()) {
    if (session.status !== 'running') {
      const startedAt = new Date(session.startedAt).getTime();
      if (now - startedAt > maxAge) {
        activeCodexSessions.delete(id);
      }
    }
  }
}, 5 * 60 * 1000); // Every 5 minutes
