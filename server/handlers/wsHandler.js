import { logger } from '../utils/logger.js';
import { connectedClients } from './fileWatcher.js';
import { startProjectWatcher, stopProjectWatcher } from './projectFileWatcher.js';
import { queryClaudeSDK, abortClaudeSDKSession, isClaudeSDKSessionActive, getActiveClaudeSDKSessions, resolveToolApproval } from '../claude-sdk.js';
import { queryCodex, abortCodexSession, isCodexSessionActive, getActiveCodexSessions } from '../openai-codex.js';

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

/**
 * Handle /ws chat WebSocket connections.
 * @param {import('ws').WebSocket} ws
 * @param {(options: object) => object} sanitizeAgentOptions - sanitiser from index
 */
function handleChatConnection(ws, sanitizeAgentOptions) {
    logger.info('Chat WebSocket connected');

    // Add to connected clients for project updates
    connectedClients.add(ws);

    // Wrap WebSocket with writer for consistent interface with SSEStreamWriter
    const writer = new WebSocketWriter(ws);

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);

            if (data.type === 'claude-command') {
                const safeOptions = sanitizeAgentOptions(data.options);
                logger.debug('User message received for project:', safeOptions.projectPath || 'Unknown');
                logger.debug('Session:', safeOptions.sessionId ? 'Resume' : 'New');

                // Use Claude Agents SDK
                await queryClaudeSDK(data.command, safeOptions, writer);
            } else if (data.type === 'codex-command') {
                const safeOptions = sanitizeAgentOptions(data.options);
                logger.debug('Codex message received for project:', safeOptions.projectPath || safeOptions.cwd || 'Unknown');
                logger.debug('Session:', safeOptions.sessionId ? 'Resume' : 'New');
                logger.debug('Model:', safeOptions.model || 'default');
                await queryCodex(data.command, safeOptions, writer);
            } else if (data.type === 'abort-session') {
                logger.debug('Abort session request:', data.sessionId);
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
            } else if (data.type === 'start-watching') {
                if (data.projectPath) {
                    startProjectWatcher(data.projectPath).catch((err) =>
                        logger.error('[wsHandler] start-watching error:', err)
                    );
                }
            } else if (data.type === 'stop-watching') {
                if (data.projectPath) {
                    stopProjectWatcher(data.projectPath).catch((err) =>
                        logger.error('[wsHandler] stop-watching error:', err)
                    );
                }
            }
        } catch (error) {
            logger.error('Chat WebSocket error:', error.message);
            writer.send({
                type: 'error',
                error: error.message
            });
        }
    });

    ws.on('close', () => {
        logger.debug('Chat client disconnected');
        // Remove from connected clients
        connectedClients.delete(ws);
    });
}

/**
 * Wire the main WebSocket server (/ws path) connection handler.
 * @param {import('ws').WebSocketServer} wss
 * @param {(options: object) => object} sanitizeAgentOptions
 */
export function setupWsHandler(wss, sanitizeAgentOptions) {
    wss._handleChatConnection = (ws) => handleChatConnection(ws, sanitizeAgentOptions);
}

export { handleChatConnection };
