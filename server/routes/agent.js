import express from 'express';
import { spawn } from 'child_process';
import path from 'path';
import os from 'os';
import { promises as fs } from 'fs';
import crypto from 'crypto';
import { userDb, githubTokensDb } from '../database/db.js';
import { addProjectManually } from '../projects.js';
import { queryClaudeSDK } from '../claude-sdk.js';
import { queryCodex } from '../openai-codex.js';
import { Octokit } from '@octokit/rest';
import { CODEX_MODELS } from '../../shared/modelConstants.js';
import { IS_PLATFORM } from '../constants/config.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

/**
 * Middleware to authenticate agent API requests.
 *
 * Supports two authentication modes:
 * 1. Platform mode (IS_PLATFORM=true): For managed/hosted deployments where
 *    authentication is handled by an external proxy. Requests are trusted and
 *    the default user context is used.
 *
 * 2. API key mode (default): For self-hosted deployments where users authenticate
 *    via API keys created in the UI. Keys are validated against the local database.
 */
const validateExternalApiKey = (req, res, next) => {
  // Platform mode: Authentication is handled externally (e.g., by a proxy layer).
  // Trust the request and use the default user context.
  if (IS_PLATFORM) {
    try {
      const user = userDb.getFirstUser();
      if (!user) {
        return res.status(500).json({ error: 'Platform mode: No user found in database' });
      }
      req.user = user;
      return next();
    } catch (error) {
      logger.error('Platform mode error:', error);
      return res.status(500).json({ error: 'Platform mode: Failed to fetch user' });
    }
  }

  // Self-hosted mode: API key authentication is no longer available
  return res.status(401).json({ error: 'API key authentication is not configured' });
};

/**
 * Get the remote URL of a git repository
 * @param {string} repoPath - Path to the git repository
 * @returns {Promise<string>} - Remote URL of the repository
 */
async function getGitRemoteUrl(repoPath) {
  return new Promise((resolve, reject) => {
    const gitProcess = spawn('git', ['config', '--get', 'remote.origin.url'], {
      cwd: repoPath,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    gitProcess.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    gitProcess.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    gitProcess.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`Failed to get git remote: ${stderr}`));
      }
    });

    gitProcess.on('error', (error) => {
      reject(new Error(`Failed to execute git: ${error.message}`));
    });
  });
}

/**
 * Parse a git remote URL and extract host/owner/repo.
 * Supports HTTPS/HTTP and SSH forms.
 * @param {string} url
 * @returns {{host: string, owner: string, repo: string}}
 */
function parseGitUrl(url) {
  if (!url || typeof url !== 'string') {
    throw new Error('Invalid repository URL format');
  }

  const trimmed = url.trim().replace(/\/$/, '');
  const sshMatch = trimmed.match(/^git@([^:]+):([^/]+)\/(.+?)(?:\.git)?$/);
  if (sshMatch) {
    return {
      host: sshMatch[1].toLowerCase(),
      owner: sshMatch[2],
      repo: sshMatch[3].replace(/\.git$/, '')
    };
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('Invalid repository URL format');
  }

  const segments = parsed.pathname.replace(/^\/+/, '').replace(/\/+$/, '').split('/');
  if (segments.length < 2) {
    throw new Error('Invalid repository URL format');
  }

  return {
    host: parsed.host.toLowerCase(),
    owner: segments[0],
    repo: segments[1].replace(/\.git$/, '')
  };
}

/**
 * Normalize repository URLs for comparison.
 * @param {string} url
 * @returns {string}
 */
function normalizeGitUrl(url) {
  const { host, owner, repo } = parseGitUrl(url);
  return `${host}/${owner}/${repo}`.toLowerCase();
}

/**
 * Auto-generate a branch name from a message
 * @param {string} message - The agent message
 * @returns {string} - Generated branch name
 */
function autogenerateBranchName(message) {
  // Convert to lowercase, replace spaces/special chars with hyphens
  let branchName = message
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '') // Remove special characters
    .replace(/\s+/g, '-') // Replace spaces with hyphens
    .replace(/-+/g, '-') // Replace multiple hyphens with single
    .replace(/^-|-$/g, ''); // Remove leading/trailing hyphens

  // Ensure non-empty fallback
  if (!branchName) {
    branchName = 'task';
  }

  // Generate timestamp suffix (last 6 chars of base36 timestamp)
  const timestamp = Date.now().toString(36).slice(-6);
  const suffix = `-${timestamp}`;

  // Limit length to ensure total length including suffix fits within 50 characters
  const maxBaseLength = 50 - suffix.length;
  if (branchName.length > maxBaseLength) {
    branchName = branchName.substring(0, maxBaseLength);
  }

  // Remove any trailing hyphen after truncation and ensure no leading hyphen
  branchName = branchName.replace(/-$/, '').replace(/^-+/, '');

  // If still empty or starts with hyphen after cleanup, use fallback
  if (!branchName || branchName.startsWith('-')) {
    branchName = 'task';
  }

  // Combine base name with timestamp suffix
  branchName = `${branchName}${suffix}`;

  // Final validation: ensure it matches safe pattern
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(branchName)) {
    // Fallback to deterministic safe name
    return `branch-${timestamp}`;
  }

  return branchName;
}

/**
 * Validate a Git branch name
 * @param {string} branchName - Branch name to validate
 * @returns {{valid: boolean, error?: string}} - Validation result
 */
function validateBranchName(branchName) {
  if (!branchName || branchName.trim() === '') {
    return { valid: false, error: 'Branch name cannot be empty' };
  }

  // Git branch name rules
  const invalidPatterns = [
    { pattern: /^\./, message: 'Branch name cannot start with a dot' },
    { pattern: /\.$/, message: 'Branch name cannot end with a dot' },
    { pattern: /\.\./, message: 'Branch name cannot contain consecutive dots (..)' },
    { pattern: /\s/, message: 'Branch name cannot contain spaces' },
    { pattern: /[~^:?*\[\\]/, message: 'Branch name cannot contain special characters: ~ ^ : ? * [ \\' },
    { pattern: /@{/, message: 'Branch name cannot contain @{' },
    { pattern: /\/$/, message: 'Branch name cannot end with a slash' },
    { pattern: /^\//, message: 'Branch name cannot start with a slash' },
    { pattern: /\/\//, message: 'Branch name cannot contain consecutive slashes' },
    { pattern: /\.lock$/, message: 'Branch name cannot end with .lock' }
  ];

  for (const { pattern, message } of invalidPatterns) {
    if (pattern.test(branchName)) {
      return { valid: false, error: message };
    }
  }

  // Check for ASCII control characters
  if (/[\x00-\x1F\x7F]/.test(branchName)) {
    return { valid: false, error: 'Branch name cannot contain control characters' };
  }

  return { valid: true };
}

/**
 * Get recent commit messages from a repository
 * @param {string} projectPath - Path to the git repository
 * @param {number} limit - Number of commits to retrieve (default: 5)
 * @returns {Promise<string[]>} - Array of commit messages
 */
async function getCommitMessages(projectPath, limit = 5) {
  return new Promise((resolve, reject) => {
    const gitProcess = spawn('git', ['log', `-${limit}`, '--pretty=format:%s'], {
      cwd: projectPath,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    gitProcess.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    gitProcess.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    gitProcess.on('close', (code) => {
      if (code === 0) {
        const messages = stdout.trim().split('\n').filter(msg => msg.length > 0);
        resolve(messages);
      } else {
        reject(new Error(`Failed to get commit messages: ${stderr}`));
      }
    });

    gitProcess.on('error', (error) => {
      reject(new Error(`Failed to execute git: ${error.message}`));
    });
  });
}

/**
 * Create a new branch on source hosting using the API
 * @param {Octokit} octokit - Octokit instance
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {string} branchName - Name of the new branch
 * @param {string} baseBranch - Base branch to branch from (default: 'main')
 * @returns {Promise<void>}
 */
async function createRemoteBranch(octokit, owner, repo, branchName, baseBranch = 'main') {
  try {
    // Get the SHA of the base branch
    const { data: ref } = await octokit.git.getRef({
      owner,
      repo,
      ref: `heads/${baseBranch}`
    });

    const baseSha = ref.object.sha;

    // Create the new branch
    await octokit.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${branchName}`,
      sha: baseSha
    });

    logger.debug(`鉁?Created branch '${branchName}' on source hosting`);
  } catch (error) {
    if (error.status === 422 && error.message.includes('Reference already exists')) {
      logger.debug(`鈩癸笍 Branch '${branchName}' already exists on source hosting`);
    } else {
      throw error;
    }
  }
}

/**
 * Create a pull request on source hosting
 * @param {Octokit} octokit - Octokit instance
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {string} branchName - Head branch name
 * @param {string} title - PR title
 * @param {string} body - PR body/description
 * @param {string} baseBranch - Base branch (default: 'main')
 * @returns {Promise<{number: number, url: string}>} - PR number and URL
 */
async function createRemotePR(octokit, owner, repo, branchName, title, body, baseBranch = 'main') {
  const { data: pr } = await octokit.pulls.create({
    owner,
    repo,
    title,
    head: branchName,
    base: baseBranch,
    body
  });

  logger.debug(`鉁?Created pull request #${pr.number}: ${pr.html_url}`);

  return {
    number: pr.number,
    url: pr.html_url
  };
}

/**
 * Clone a source hosting repository to a directory
 * @param {string} githubUrl - source hosting repository URL
 * @param {string} githubToken - Optional source hosting token for private repos
 * @param {string} projectPath - Path for cloning the repository
 * @returns {Promise<string>} - Path to the cloned repository
 */
async function cloneRemoteRepo(githubUrl, githubToken = null, projectPath) {
  return new Promise(async (resolve, reject) => {
    try {
      // Validate repository URL
      parseGitUrl(githubUrl);

      const cloneDir = path.resolve(projectPath);

      // Check if directory already exists
      try {
        await fs.access(cloneDir);
        // Directory exists - check if it's a git repo with the same URL
        try {
          const existingUrl = await getGitRemoteUrl(cloneDir);
          const normalizedExisting = normalizeGitUrl(existingUrl);
          const normalizedRequested = normalizeGitUrl(githubUrl);

          if (normalizedExisting === normalizedRequested) {
            logger.debug('鉁?Repository already exists at path with correct URL');
            return resolve(cloneDir);
          } else {
            throw new Error(`Directory ${cloneDir} already exists with a different repository (${existingUrl}). Expected: ${githubUrl}`);
          }
        } catch (gitError) {
          throw new Error(`Directory ${cloneDir} already exists but is not a valid git repository or git command failed`);
        }
      } catch (accessError) {
        // Directory doesn't exist - proceed with clone
      }

      // Ensure parent directory exists
      await fs.mkdir(path.dirname(cloneDir), { recursive: true });

      // Prepare the git clone URL with authentication if token is provided
      let cloneUrl = githubUrl;
      if (githubToken) {
        // Add token to HTTPS remotes; keep SSH remotes unchanged.
        if (/^https?:\/\//i.test(githubUrl)) {
          const cloneTarget = new URL(githubUrl);
          cloneTarget.username = githubToken;
          cloneTarget.password = '';
          cloneUrl = cloneTarget.toString();
        }
      }

      logger.debug('馃攧 Cloning repository:', githubUrl);
      logger.debug('馃搧 Destination:', cloneDir);

      // Execute git clone
      const gitProcess = spawn('git', ['clone', '--depth', '1', cloneUrl, cloneDir], {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';

      gitProcess.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      gitProcess.stderr.on('data', (data) => {
        stderr += data.toString();
        logger.debug('Git stderr:', data.toString());
      });

      gitProcess.on('close', (code) => {
        if (code === 0) {
          logger.debug('鉁?Repository cloned successfully');
          resolve(cloneDir);
        } else {
          logger.error('鉂?Git clone failed:', stderr);
          reject(new Error(`Git clone failed: ${stderr}`));
        }
      });

      gitProcess.on('error', (error) => {
        reject(new Error(`Failed to execute git: ${error.message}`));
      });
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * Clean up a temporary project directory and its Claude session
 * @param {string} projectPath - Path to the project directory
 * @param {string} sessionId - Session ID to clean up
 */
async function cleanupProject(projectPath, sessionId = null) {
  try {
    // Only clean up projects in the external-projects directory
    if (!projectPath.includes('.claude/external-projects')) {
      logger.warn('鈿狅笍 Refusing to clean up non-external project:', projectPath);
      return;
    }

    logger.debug('馃Ч Cleaning up project:', projectPath);
    await fs.rm(projectPath, { recursive: true, force: true });
    logger.debug('鉁?Project cleaned up');

    // Also clean up the Claude session directory if sessionId provided
    if (sessionId) {
      try {
        const sessionPath = path.join(os.homedir(), '.claude', 'sessions', sessionId);
        logger.debug('馃Ч Cleaning up session directory:', sessionPath);
        await fs.rm(sessionPath, { recursive: true, force: true });
        logger.debug('鉁?Session directory cleaned up');
      } catch (error) {
        logger.error('鈿狅笍 Failed to clean up session directory:', error.message);
      }
    }
  } catch (error) {
    logger.error('鉂?Failed to clean up project:', error);
  }
}

/**
 * SSE Stream Writer - Adapts SDK/CLI output to Server-Sent Events
 */
class SSEStreamWriter {
  constructor(res) {
    this.res = res;
    this.sessionId = null;
    this.isSSEStreamWriter = true;  // Marker for transport detection
  }

  send(data) {
    if (this.res.writableEnded) {
      return;
    }

    // Format as SSE - providers send raw objects, we stringify
    this.res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  end() {
    if (!this.res.writableEnded) {
      this.res.write('data: {"type":"done"}\n\n');
      this.res.end();
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
 * Non-streaming response collector
 */
class ResponseCollector {
  constructor() {
    this.messages = [];
    this.sessionId = null;
  }

  send(data) {
    // Store ALL messages for now - we'll filter when returning
    this.messages.push(data);

    // Extract sessionId if present
    if (typeof data === 'string') {
      try {
        const parsed = JSON.parse(data);
        if (parsed.sessionId) {
          this.sessionId = parsed.sessionId;
        }
      } catch (e) {
        // Not JSON, ignore
      }
    } else if (data && data.sessionId) {
      this.sessionId = data.sessionId;
    }
  }

  end() {
    // Do nothing - we'll collect all messages
  }

  setSessionId(sessionId) {
    this.sessionId = sessionId;
  }

  getSessionId() {
    return this.sessionId;
  }

  getMessages() {
    return this.messages;
  }

  /**
   * Get filtered assistant messages only
   */
  getAssistantMessages() {
    const assistantMessages = [];

    for (const msg of this.messages) {
      // Skip initial status message
      if (msg && msg.type === 'status') {
        continue;
      }

      // Handle JSON strings
      if (typeof msg === 'string') {
        try {
          const parsed = JSON.parse(msg);
          // Only include claude-response messages with assistant type
          if (parsed.type === 'claude-response' && parsed.data && parsed.data.type === 'assistant') {
            assistantMessages.push(parsed.data);
          }
        } catch (e) {
          // Not JSON, skip
        }
      }
    }

    return assistantMessages;
  }

  /**
   * Calculate total tokens from all messages
   */
  getTotalTokens() {
    let totalInput = 0;
    let totalOutput = 0;
    let totalCacheRead = 0;
    let totalCacheCreation = 0;

    for (const msg of this.messages) {
      let data = msg;

      // Parse if string
      if (typeof msg === 'string') {
        try {
          data = JSON.parse(msg);
        } catch (e) {
          continue;
        }
      }

      // Extract usage from claude-response messages
      if (data && data.type === 'claude-response' && data.data) {
        const msgData = data.data;
        if (msgData.message && msgData.message.usage) {
          const usage = msgData.message.usage;
          totalInput += usage.input_tokens || 0;
          totalOutput += usage.output_tokens || 0;
          totalCacheRead += usage.cache_read_input_tokens || 0;
          totalCacheCreation += usage.cache_creation_input_tokens || 0;
        }
      }
    }

    return {
      inputTokens: totalInput,
      outputTokens: totalOutput,
      cacheReadTokens: totalCacheRead,
      cacheCreationTokens: totalCacheCreation,
      totalTokens: totalInput + totalOutput + totalCacheRead + totalCacheCreation
    };
  }
}

// ===============================
// External API Endpoint
// ===============================

/**
 * POST /api/agent
 *
 * Trigger an AI agent (Claude or Codex) to work on a project.
 * Supports automatic source hosting branch and pull request creation after successful completion.
 *
 * ================================================================================================
 * REQUEST BODY PARAMETERS
 * ================================================================================================
 *
 * @param {string} githubUrl - (Conditionally Required) source hosting repository URL to clone.
 *                             Supported formats:
 *                             - HTTPS: https://source.example.com/owner/repo
 *                             - HTTPS with .git: https://source.example.com/owner/repo.git
 *                             - SSH: git@host.example:owner/repo
 *                             - SSH with .git: git@host.example:owner/repo.git
 *
 * @param {string} projectPath - (Conditionally Required) Path to existing project OR destination for cloning.
 *                               Behavior depends on usage:
 *                               - If used alone: Must point to existing project directory
 *                               - If used with githubUrl: Target location for cloning
 *                               - If omitted with githubUrl: Auto-generates temporary path in ~/.claude/external-projects/
 *
 * @param {string} message - (Required) Task description for the AI agent. Used as:
 *                          - Instructions for the agent
 *                          - Source for auto-generated branch names (if createBranch=true and no branchName)
 *                          - Fallback for PR title if no commits are made
 *
 * @param {string} provider - (Optional) AI provider to use. Options: 'claude' | 'codex'
 *                           Default: 'claude'
 *
 * @param {boolean} stream - (Optional) Enable Server-Sent Events (SSE) streaming for real-time updates.
 *                          Default: true
 *                          - true: Returns text/event-stream with incremental updates
 *                          - false: Returns complete JSON response after completion
 *
 * @param {string} model - (Optional) Model identifier for providers.
 *
 *                        Claude models: 'sonnet' (default), 'opus', 'haiku', 'opusplan', 'sonnet[1m]'
 *                        Codex models: 'gpt-5.2' (default), 'gpt-5.1-codex-max', 'o3', 'o4-mini'
 *
 * @param {boolean} cleanup - (Optional) Auto-cleanup project directory after completion.
 *                           Default: true
 *                           Behavior:
 *                           - Only applies when cloning via githubUrl (not for existing projectPath)
 *                           - Deletes cloned repository after 5 seconds
 *                           - Also deletes associated Claude session directory
 *                           - Remote branch and PR remain on source hosting if created
 *
 * @param {string} githubToken - (Optional) source hosting Personal Access Token for authentication.
 *                              Overrides stored token from user settings.
 *                              Required for:
 *                              - Private repositories
 *                              - Branch/PR creation features
 *                              Token must have 'repo' scope for full functionality.
 *
 * @param {string} branchName - (Optional) Custom name for the Git branch.
 *                             If provided, createBranch is automatically set to true.
 *                             Validation rules (errors returned if violated):
 *                             - Cannot be empty or whitespace only
 *                             - Cannot start or end with dot (.)
 *                             - Cannot contain consecutive dots (..)
 *                             - Cannot contain spaces
 *                             - Cannot contain special characters: ~ ^ : ? * [ \
 *                             - Cannot contain @{
 *                             - Cannot start or end with forward slash (/)
 *                             - Cannot contain consecutive slashes (//)
 *                             - Cannot end with .lock
 *                             - Cannot contain ASCII control characters
 *                             Examples: 'feature/user-auth', 'bugfix/login-error', 'refactor/db-optimization'
 *
 * @param {boolean} createBranch - (Optional) Create a new Git branch after successful agent completion.
 *                                Default: false (or true if branchName is provided)
 *                                Behavior:
 *                                - Creates branch locally and pushes to remote
 *                                - If branch exists locally: Checks out existing branch (no error)
 *                                - If branch exists on remote: Uses existing branch (no error)
 *                                - Branch name: Custom (if branchName provided) or auto-generated from message
 *                                - Requires either githubUrl OR projectPath with source hosting remote
 *
 * @param {boolean} createPR - (Optional) Create a source hosting Pull Request after successful completion.
 *                            Default: false
 *                            Behavior:
 *                            - PR title: First commit message (or fallback to message parameter)
 *                            - PR description: Auto-generated from all commit messages
 *                            - Base branch: Always 'main' (currently hardcoded)
 *                            - If PR already exists: source hosting returns error with details
 *                            - Requires either githubUrl OR projectPath with source hosting remote
 *
 * ================================================================================================
 * PATH HANDLING BEHAVIOR
 * ================================================================================================
 *
 * Scenario 1: Only githubUrl provided
 *   Input:  { githubUrl: "https://source.example.com/owner/repo" }
 *   Action: Clones to auto-generated temporary path: ~/.claude/external-projects/<hash>/
 *   Cleanup: Yes (if cleanup=true)
 *
 * Scenario 2: Only projectPath provided
 *   Input:  { projectPath: "/home/user/my-project" }
 *   Action: Uses existing project at specified path
 *   Validation: Path must exist and be accessible
 *   Cleanup: No (never cleanup existing projects)
 *
 * Scenario 3: Both githubUrl and projectPath provided
 *   Input:  { githubUrl: "https://source.example.com/owner/repo", projectPath: "/custom/path" }
 *   Action: Clones githubUrl to projectPath location
 *   Validation:
 *     - If projectPath exists with git repo:
 *       - Compares remote URL with githubUrl
 *       - If URLs match: Reuses existing repo
 *       - If URLs differ: Returns error
 *   Cleanup: Yes (if cleanup=true)
 *
 * ================================================================================================
 * GITHUB BRANCH/PR CREATION REQUIREMENTS
 * ================================================================================================
 *
 * For createBranch or createPR to work, one of the following must be true:
 *
 * Option A: githubUrl provided
 *   - Repository URL directly specified
 *   - Works with both cloning and existing paths
 *
 * Option B: projectPath with source hosting remote
 *   - Project must be a Git repository
 *   - Must have 'origin' remote configured
 *   - Remote URL must point to host.example
 *   - System auto-detects source hosting URL via: git remote get-url origin
 *
 * Additional Requirements:
 *   - Valid source hosting token (from settings or githubToken parameter)
 *   - Token must have 'repo' scope for private repos
 *   - Project must have commits (for PR creation)
 *
 * ================================================================================================
 * VALIDATION & ERROR HANDLING
 * ================================================================================================
 *
 * Input Validations (400 Bad Request):
 *   - Either githubUrl OR projectPath must be provided (not neither)
 *   - message must be non-empty string
 *   - provider must be 'claude' or 'codex'
 *   - createBranch/createPR requires githubUrl OR projectPath (not neither)
 *   - branchName must pass Git naming rules (if provided)
 *
 * Runtime Validations (500 Internal Server Error or specific error in response):
 *   - projectPath must exist (if used alone)
 *   - source hosting URL format must be valid
 *   - Git remote URL must include host.example (for projectPath + branch/PR)
 *   - source hosting token must be available (for private repos and branch/PR)
 *   - Directory conflicts handled (existing path with different repo)
 *
 * Branch Name Validation Errors (returned in response, not HTTP error):
 *   Invalid names return: { branch: { error: "Invalid branch name: <reason>" } }
 *   Examples:
 *   - "my branch" 鈫?"Branch name cannot contain spaces"
 *   - ".feature" 鈫?"Branch name cannot start with a dot"
 *   - "feature.lock" 鈫?"Branch name cannot end with .lock"
 *
 * ================================================================================================
 * RESPONSE FORMATS
 * ================================================================================================
 *
 * Streaming Response (stream=true):
 *   Content-Type: text/event-stream
 *   Events:
 *     - { type: "status", message: "...", projectPath: "..." }
 *     - { type: "claude-response", data: {...} }
 *     - { type: "github-branch", branch: { name: "...", url: "..." } }
 *     - { type: "github-pr", pullRequest: { number: 42, url: "..." } }
 *     - { type: "github-error", error: "..." }
 *     - { type: "done" }
 *
 * Non-Streaming Response (stream=false):
 *   Content-Type: application/json
 *   {
 *     success: true,
 *     sessionId: "session-123",
 *     messages: [...],        // Assistant messages only (filtered)
 *     tokens: {
 *       inputTokens: 150,
 *       outputTokens: 50,
 *       cacheReadTokens: 0,
 *       cacheCreationTokens: 0,
 *       totalTokens: 200
 *     },
 *     projectPath: "/path/to/project",
 *     branch: {               // Only if createBranch=true
 *       name: "feature/xyz",
 *       url: "https://source.example.com/owner/repo/tree/feature/xyz"
 *     } | { error: "..." },
 *     pullRequest: {          // Only if createPR=true
 *       number: 42,
 *       url: "https://source.example.com/owner/repo/pull/42"
 *     } | { error: "..." }
 *   }
 *
 * Error Response:
 *   HTTP Status: 400, 401, 500
 *   Content-Type: application/json
 *   { success: false, error: "Error description" }
 *
 * ================================================================================================
 * EXAMPLES
 * ================================================================================================
 *
 * Example 1: Clone and process with auto-cleanup
 *   POST /api/agent
 *   { "githubUrl": "https://source.example.com/user/repo", "message": "Fix bug" }
 *
 * Example 2: Use existing project with custom branch and PR
 *   POST /api/agent
 *   {
 *     "projectPath": "/home/user/project",
 *     "message": "Add feature",
 *     "branchName": "feature/new-feature",
 *     "createPR": true
 *   }
 *
 * Example 3: Clone to specific path with auto-generated branch
 *   POST /api/agent
 *   {
 *     "githubUrl": "https://source.example.com/user/repo",
 *     "projectPath": "/tmp/work",
 *     "message": "Refactor code",
 *     "createBranch": true,
 *     "cleanup": false
 *   }
 */
router.post('/', validateExternalApiKey, async (req, res) => {
  const { githubUrl, projectPath, message, provider = 'claude', model, githubToken, branchName } = req.body;

  // Parse stream and cleanup as booleans (handle string "true"/"false" from curl)
  const stream = req.body.stream === undefined ? true : (req.body.stream === true || req.body.stream === 'true');
  const cleanup = req.body.cleanup === undefined ? true : (req.body.cleanup === true || req.body.cleanup === 'true');

  // If branchName is provided, automatically enable createBranch
  const createBranch = branchName ? true : (req.body.createBranch === true || req.body.createBranch === 'true');
  const createPR = req.body.createPR === true || req.body.createPR === 'true';

  // Validate inputs
  if (!githubUrl && !projectPath) {
    return res.status(400).json({ error: 'Either githubUrl or projectPath is required' });
  }

  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'message is required' });
  }

  if (!['claude', 'codex'].includes(provider)) {
    return res.status(400).json({ error: 'provider must be "claude" or "codex"' });
  }

  // Validate source hosting branch/PR creation requirements
  // Allow branch/PR creation with projectPath as long as it has a source hosting remote
  if ((createBranch || createPR) && !githubUrl && !projectPath) {
    return res.status(400).json({ error: 'createBranch and createPR require either githubUrl or projectPath with a source hosting remote' });
  }

  let finalProjectPath = null;
  let writer = null;

  try {
    // Determine the final project path
    if (githubUrl) {
      // Clone repository (to projectPath if provided, otherwise generate path)
      const tokenToUse = githubToken || githubTokensDb.getActiveGithubToken(req.user.id);

      let targetPath;
      if (projectPath) {
        targetPath = projectPath;
      } else {
        // Generate a unique path for cloning
        const repoHash = crypto.createHash('md5').update(githubUrl + Date.now()).digest('hex');
        targetPath = path.join(os.homedir(), '.claude', 'external-projects', repoHash);
      }

      finalProjectPath = await cloneRemoteRepo(githubUrl.trim(), tokenToUse, targetPath);
    } else {
      // Use existing project path
      finalProjectPath = path.resolve(projectPath);

      // Verify the path exists
      try {
        await fs.access(finalProjectPath);
      } catch (error) {
        throw new Error(`Project path does not exist: ${finalProjectPath}`);
      }
    }

    // Register the project (or use existing registration)
    let project;
    try {
      project = await addProjectManually(finalProjectPath);
      logger.debug('馃摝 Project registered:', project);
    } catch (error) {
      // If project already exists, that's fine - continue with the existing registration
      if (error.message && error.message.includes('Project already configured')) {
        logger.debug('馃摝 Using existing project registration for:', finalProjectPath);
        project = { path: finalProjectPath };
      } else {
        throw error;
      }
    }

    // Set up writer based on streaming mode
    if (stream) {
      // Set up SSE headers for streaming
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering

      writer = new SSEStreamWriter(res);

      // Send initial status
      writer.send({
        type: 'status',
        message: githubUrl ? 'Repository cloned and session started' : 'Session started',
        projectPath: finalProjectPath
      });
    } else {
      // Non-streaming mode: collect messages
      writer = new ResponseCollector();

      // Collect initial status message
      writer.send({
        type: 'status',
        message: githubUrl ? 'Repository cloned and session started' : 'Session started',
        projectPath: finalProjectPath
      });
    }

    // Start the appropriate session
    if (provider === 'claude') {
      logger.debug('馃 Starting Claude SDK session');

      await queryClaudeSDK(message.trim(), {
        projectPath: finalProjectPath,
        cwd: finalProjectPath,
        sessionId: null, // New session
        model: model,
        permissionMode: 'bypassPermissions' // Bypass all permissions for API calls
      }, writer);
    } else if (provider === 'codex') {
      logger.debug('馃 Starting Codex SDK session');

      await queryCodex(message.trim(), {
        projectPath: finalProjectPath,
        cwd: finalProjectPath,
        sessionId: null,
        model: model || CODEX_MODELS.DEFAULT,
        permissionMode: 'bypassPermissions'
      }, writer);
    }

    // Handle source hosting branch and PR creation after successful agent completion
    let branchInfo = null;
    let prInfo = null;

    if (createBranch || createPR) {
      try {
        logger.debug('馃攧 Starting source hosting branch/PR creation workflow...');

        // Get source hosting token
        const tokenToUse = githubToken || githubTokensDb.getActiveGithubToken(req.user.id);

        if (!tokenToUse) {
          throw new Error('source hosting token required for branch/PR creation. Please configure a source hosting token in settings.');
        }

        // Initialize Octokit
        const octokit = new Octokit({ auth: tokenToUse });

        // Get source hosting URL - either from parameter or from git remote
        let repoUrl = githubUrl;
        if (!repoUrl) {
          logger.debug('馃攳 Getting source hosting URL from git remote...');
          try {
            repoUrl = await getGitRemoteUrl(finalProjectPath);
            parseGitUrl(repoUrl);
            logger.debug(`鉁?Found source hosting remote: ${repoUrl}`);
          } catch (error) {
            throw new Error(`Failed to get source hosting remote URL: ${error.message}`);
          }
        }

        // Parse source hosting URL to get owner and repo
        const { host, owner, repo } = parseGitUrl(repoUrl);
        logger.debug(`馃摝 Repository: ${owner}/${repo}`);

        // Use provided branch name or auto-generate from message
        const finalBranchName = branchName || autogenerateBranchName(message);
        if (branchName) {
          logger.debug(`馃尶 Using provided branch name: ${finalBranchName}`);

          // Validate custom branch name
          const validation = validateBranchName(finalBranchName);
          if (!validation.valid) {
            throw new Error(`Invalid branch name: ${validation.error}`);
          }
        } else {
          logger.debug(`馃尶 Auto-generated branch name: ${finalBranchName}`);
        }

        if (createBranch) {
          // Create and checkout the new branch locally
          logger.debug('馃攧 Creating local branch...');
          const checkoutProcess = spawn('git', ['checkout', '-b', finalBranchName], {
            cwd: finalProjectPath,
            stdio: 'pipe'
          });

          await new Promise((resolve, reject) => {
            let stderr = '';
            checkoutProcess.stderr.on('data', (data) => { stderr += data.toString(); });
            checkoutProcess.on('close', (code) => {
              if (code === 0) {
                logger.debug(`鉁?Created and checked out local branch '${finalBranchName}'`);
                resolve();
              } else {
                // Branch might already exist locally, try to checkout
                if (stderr.includes('already exists')) {
                  logger.debug(`鈩癸笍 Branch '${finalBranchName}' already exists locally, checking out...`);
                  const checkoutExisting = spawn('git', ['checkout', finalBranchName], {
                    cwd: finalProjectPath,
                    stdio: 'pipe'
                  });
                  checkoutExisting.on('close', (checkoutCode) => {
                    if (checkoutCode === 0) {
                      logger.debug(`鉁?Checked out existing branch '${finalBranchName}'`);
                      resolve();
                    } else {
                      reject(new Error(`Failed to checkout existing branch: ${stderr}`));
                    }
                  });
                } else {
                  reject(new Error(`Failed to create branch: ${stderr}`));
                }
              }
            });
          });

          // Push the branch to remote
          logger.debug('馃攧 Pushing branch to remote...');
          const pushProcess = spawn('git', ['push', '-u', 'origin', finalBranchName], {
            cwd: finalProjectPath,
            stdio: 'pipe'
          });

          await new Promise((resolve, reject) => {
            let stderr = '';
            let stdout = '';
            pushProcess.stdout.on('data', (data) => { stdout += data.toString(); });
            pushProcess.stderr.on('data', (data) => { stderr += data.toString(); });
            pushProcess.on('close', (code) => {
              if (code === 0) {
                logger.debug(`鉁?Pushed branch '${finalBranchName}' to remote`);
                resolve();
              } else {
                // Check if branch exists on remote but has different commits
                if (stderr.includes('already exists') || stderr.includes('up-to-date')) {
                  logger.debug(`鈩癸笍 Branch '${finalBranchName}' already exists on remote, using existing branch`);
                  resolve();
                } else {
                  reject(new Error(`Failed to push branch: ${stderr}`));
                }
              }
            });
          });

          branchInfo = {
            name: finalBranchName,
            url: `https://${host}/${owner}/${repo}/tree/${finalBranchName}`
          };
        }

        if (createPR) {
          // Get commit messages to generate PR description
          logger.debug('馃攧 Generating PR title and description...');
          const commitMessages = await getCommitMessages(finalProjectPath, 5);

          // Use the first commit message as the PR title, or fallback to the agent message
          const prTitle = commitMessages.length > 0 ? commitMessages[0] : message;

          // Generate PR body from commit messages
          let prBody = '## Changes\n\n';
          if (commitMessages.length > 0) {
            prBody += commitMessages.map(msg => `- ${msg}`).join('\n');
          } else {
            prBody += `Agent task: ${message}`;
          }
          prBody += '\n\n---\n*This pull request was automatically created by OpenWork Agent.*';

          logger.debug(`馃摑 PR Title: ${prTitle}`);

          // Create the pull request
          logger.debug('馃攧 Creating pull request...');
          prInfo = await createRemotePR(octokit, owner, repo, finalBranchName, prTitle, prBody, 'main');
        }

        // Send branch/PR info in response
        if (stream) {
          if (branchInfo) {
            writer.send({
              type: 'github-branch',
              branch: branchInfo
            });
          }
          if (prInfo) {
            writer.send({
              type: 'github-pr',
              pullRequest: prInfo
            });
          }
        }

      } catch (error) {
        logger.error('鉂?source hosting branch/PR creation error:', error);

        // Send error but don't fail the entire request
        if (stream) {
          writer.send({
            type: 'github-error',
            error: error.message
          });
        }
        // Store error info for non-streaming response
        if (!stream) {
          branchInfo = { error: error.message };
          prInfo = { error: error.message };
        }
      }
    }

    // Handle response based on streaming mode
    if (stream) {
      // Streaming mode: end the SSE stream
      writer.end();
    } else {
      // Non-streaming mode: send filtered messages and token summary as JSON
      const assistantMessages = writer.getAssistantMessages();
      const tokenSummary = writer.getTotalTokens();

      const response = {
        success: true,
        sessionId: writer.getSessionId(),
        messages: assistantMessages,
        tokens: tokenSummary,
        projectPath: finalProjectPath
      };

      // Add branch/PR info if created
      if (branchInfo) {
        response.branch = branchInfo;
      }
      if (prInfo) {
        response.pullRequest = prInfo;
      }

      res.json(response);
    }

    // Clean up if requested
    if (cleanup && githubUrl) {
      // Only cleanup if we cloned a repo (not for existing project paths)
      const sessionIdForCleanup = writer.getSessionId();
      setTimeout(() => {
        cleanupProject(finalProjectPath, sessionIdForCleanup);
      }, 5000);
    }

  } catch (error) {
    logger.error('鉂?External session error:', error);

    // Clean up on error
    if (finalProjectPath && cleanup && githubUrl) {
      const sessionIdForCleanup = writer ? writer.getSessionId() : null;
      cleanupProject(finalProjectPath, sessionIdForCleanup);
    }

    if (stream) {
      // For streaming, send error event and stop
      if (!writer) {
        // Set up SSE headers if not already done
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        writer = new SSEStreamWriter(res);
      }

      if (!res.writableEnded) {
        writer.send({
          type: 'error',
          error: error.message,
          message: `Failed: ${error.message}`
        });
        writer.end();
      }
    } else if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
});

export default router;


