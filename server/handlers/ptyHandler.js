import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { spawnSync } from 'child_process';
import pty from 'node-pty';
import { WebSocket } from 'ws';
import { logger } from '../utils/logger.js';
import { resolveCodexExecutablePath } from '../openai-codex.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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
      logger.debug(`[PTY GC] Cleaning up stale session: ${sessionId}`);
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
            path.join(__dirname, '..', '..', 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'vendor', 'ripgrep', 'x64-win32'),
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
                logger.warn('[PATH] Failed to scan nvm versions:', error?.message || error);
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
    logger.info(`[PATH] node available: ${nodeProbe.version}`);
} else {
    logger.warn(`[PATH] node unavailable after PATH enhancement: ${nodeProbe.reason}`);
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

// Handle shell WebSocket connections
function handleShellConnection(ws, getIsServerShuttingDown) {
    logger.info('Shell client connected');
    let shellProcess = null;
    let ptySessionKey = null;
    let urlDetectionBuffer = '';
    const announcedAuthUrls = new Set();

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            logger.debug('Shell message received:', data.type);

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
                        logger.debug('Cleaning up existing session:', ptySessionKey);
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
                    logger.debug('Discarding cached PTY for fresh provider shell:', ptySessionKey);
                    if (existingSession.timeoutId) clearTimeout(existingSession.timeoutId);
                    if (isPtyProcessAlive(existingSession.pty) && existingSession.pty && existingSession.pty.kill) {
                        existingSession.pty.kill();
                    }
                    ptySessionsMap.delete(ptySessionKey);
                }

                if (existingSession && shouldReusePtySession) {
                    if (!isPtyProcessAlive(existingSession.pty)) {
                        logger.warn('Existing PTY session is stale, starting a new one:', ptySessionKey);
                        if (existingSession.timeoutId) clearTimeout(existingSession.timeoutId);
                        ptySessionsMap.delete(ptySessionKey);
                    } else {
                        logger.debug('Reconnecting to existing PTY session:', ptySessionKey);
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

                logger.info('Starting shell in:', projectPath);
                logger.info('Session info:', hasSession ? `Resume session ${sessionId}` : (isPlainShell ? 'Plain shell mode' : 'New session'));
                logger.info('Provider:', isPlainShell ? 'plain-shell' : provider);
                if (initialCommand) {
                    logger.debug('Initial command:', initialCommand);
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
                                logger.debug('[Codex] Terminal fallback executable:', codexExecutablePath);
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

                    logger.debug('Executing shell command:', shellCommand);

                    // Use appropriate shell based on platform
                    const termCols = data.cols || 80;
                    const termRows = data.rows || 24;
                    logger.debug('Using terminal dimensions:', termCols, 'x', termRows);

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

                    logger.info('Shell process started with PTY, PID:', currentShellProcess.pid);

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
                        logger.info('Shell process exited with code:', exitCode.exitCode, 'signal:', exitCode.signal);
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
                    logger.error('Error spawning process:', spawnError);
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
                        logger.error('Error writing to shell:', error);
                        if (ws.readyState === WebSocket.OPEN) {
                            ws.send(JSON.stringify({
                                type: 'output',
                                data: `\r\n\x1b[31mTerminal input failed: ${error.message}\x1b[0m\r\n`
                            }));
                        }
                    }
                } else {
                    logger.warn('No active shell process to send input to');
                }
            } else if (data.type === 'resize') {
                // Handle terminal resize
                if (shellProcess && shellProcess.resize) {
                    logger.debug('Terminal resize requested:', data.cols, 'x', data.rows);
                    shellProcess.resize(data.cols, data.rows);
                }
            }
        } catch (error) {
            logger.error('Shell WebSocket error:', error.message);
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: 'output',
                    data: `\r\n\x1b[31mError: ${error.message}\x1b[0m\r\n`
                }));
            }
        }
    });

    ws.on('close', () => {
        logger.info('Shell client disconnected');

        if (ptySessionKey) {
            const session = ptySessionsMap.get(ptySessionKey);
            if (session) {
                if (getIsServerShuttingDown()) {
                    if (session.timeoutId) {
                        clearTimeout(session.timeoutId);
                    }
                    if (session.pty && session.pty.kill) {
                        session.pty.kill();
                    }
                    ptySessionsMap.delete(ptySessionKey);
                    return;
                }

                logger.debug('PTY session kept alive, will timeout in 30 minutes:', ptySessionKey);
                session.ws = null;

                session.timeoutId = setTimeout(() => {
                    logger.debug('PTY session timeout, killing process:', ptySessionKey);
                    if (session.pty && session.pty.kill) {
                        session.pty.kill();
                    }
                    ptySessionsMap.delete(ptySessionKey);
                }, PTY_SESSION_TIMEOUT);
            }
        }
    });

    ws.on('error', (error) => {
        logger.error('Shell WebSocket error:', error);
    });
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
            logger.warn('Failed to close shell WebSocket during shutdown:', error);
        }

        try {
            if (session.pty && session.pty.kill) {
                session.pty.kill();
            }
        } catch (error) {
            logger.warn(`Failed to kill PTY session ${sessionKey}:`, error);
        }
    }

    ptySessionsMap.clear();
}

export {
    ptySessionsMap,
    IS_WINDOWS,
    buildEnhancedPath,
    sanitizeAgentOptions,
    isPtyProcessAlive,
    terminateAllPtySessions,
};

export function setupShellHandler(wss, getIsServerShuttingDown) {
    wss._handleShellConnection = (ws) => handleShellConnection(ws, getIsServerShuttingDown);
}
