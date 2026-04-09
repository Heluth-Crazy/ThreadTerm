import express from 'express';
import { promises as fs, existsSync } from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import os from 'os';
import crypto from 'crypto';
import { addProjectManually, extractProjectDirectory, loadProjectConfig, saveProjectConfig } from '../projects.js';

const router = express.Router();

function resolveGitCommand() {
  if (process.platform !== 'win32') return 'git';
  const candidates = [
    process.env.GIT_PATH,
    'C:\\Program Files\\Git\\cmd\\git.exe',
    'C:\\Program Files (x86)\\Git\\cmd\\git.exe',
    process.env.LOCALAPPDATA && `${process.env.LOCALAPPDATA}\\Programs\\Git\\cmd\\git.exe`,
  ].filter(Boolean);
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return 'git';
}

const GIT_CMD = resolveGitCommand();

function sanitizeGitError(message, token) {
  if (!message || !token) return message;
  return message.replace(new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '***');
}

// Default workspace root used for initial browsing ("~" expansion)
export const WORKSPACES_ROOT = process.env.WORKSPACES_ROOT || os.homedir();
const OPENWORK_CONFIG_DIR = path.join(os.homedir(), '.openwork');
const WORKTREE_SETTINGS_FILE = path.join(OPENWORK_CONFIG_DIR, 'worktree-settings.json');
const DEFAULT_GIT_WORKTREE_ROOT = process.env.OPENWORK_WORKTREE_ROOT
  ? path.resolve(process.env.OPENWORK_WORKTREE_ROOT)
  : null;

// System-critical paths that should never be used as workspace directories
export const FORBIDDEN_PATHS = [
  // Unix
  '/',
  '/etc',
  '/bin',
  '/sbin',
  '/usr',
  '/dev',
  '/proc',
  '/sys',
  '/var',
  '/boot',
  '/root',
  '/lib',
  '/lib64',
  '/opt',
  '/tmp',
  '/run',
  // Windows (normalizeForComparison lowercases on win32 – keep these lowercase)
  'c:\\windows',
  'c:\\program files',
  'c:\\program files (x86)',
  'c:\\programdata',
  'c:\\system volume information',
  'c:\\$recycle.bin'
];

function encodeProjectNameFromPath(projectPath) {
  return path.resolve(projectPath).replace(/[\\/:\s~_]/g, '-');
}

function sanitizePathSegment(value, fallback = 'workspace') {
  const sanitized = String(value || '')
    .trim()
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  return sanitized || fallback;
}

function normalizeComparablePath(inputPath = '') {
  const normalized = path.normalize(inputPath);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isPathInside(parentPath, childPath) {
  const parent = normalizeComparablePath(path.resolve(parentPath));
  const child = normalizeComparablePath(path.resolve(childPath));
  if (parent === child) return true;
  return child.startsWith(parent + path.sep);
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      ...options,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('error', (error) => {
      reject(error);
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      const err = new Error(`Command failed: ${command} ${args.join(' ')}`);
      err.code = code;
      err.stdout = stdout;
      err.stderr = stderr;
      reject(err);
    });
  });
}

async function git(commandArgs, cwd) {
  return runCommand(GIT_CMD, commandArgs, { cwd });
}

async function gitRefExists(cwd, ref) {
  try {
    await git(['show-ref', '--verify', '--quiet', ref], cwd);
    return true;
  } catch {
    return false;
  }
}

async function ensureUniqueDirectoryPath(baseDir, preferredName) {
  await fs.mkdir(baseDir, { recursive: true });
  const safeName = sanitizePathSegment(preferredName, 'branch');
  let candidate = path.join(baseDir, safeName);
  let suffix = 2;

  while (true) {
    try {
      await fs.access(candidate);
      candidate = path.join(baseDir, `${safeName}-${suffix}`);
      suffix += 1;
    } catch {
      return candidate;
    }
  }
}

async function loadWorktreeSettings() {
  try {
    const raw = await fs.readFile(WORKTREE_SETTINGS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return parsed;
    }
    return {};
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {};
    }
    throw error;
  }
}

async function saveWorktreeSettings(settings) {
  await fs.mkdir(OPENWORK_CONFIG_DIR, { recursive: true });
  await fs.writeFile(WORKTREE_SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
}

function abbreviateName(value, maxLength = 18) {
  const safe = sanitizePathSegment(value, 'item');
  if (safe.length <= maxLength) {
    return safe;
  }

  const parts = safe.split('-').filter(Boolean);
  if (parts.length <= 1) {
    return safe.slice(0, maxLength);
  }

  const shortened = parts
    .slice(0, 4)
    .map((part, index) => {
      if (index === parts.length - 1 && /^\d+$/.test(part)) {
        return part;
      }
      return part.slice(0, 3);
    })
    .join('-');

  return shortened.length <= maxLength
    ? shortened
    : shortened.slice(0, maxLength);
}

function buildWorktreeDirectoryNames(repoRoot, branch) {
  const repoBase = path.basename(repoRoot);
  const repoAlias = abbreviateName(repoBase, 20);
  const branchAlias = abbreviateName(branch, 24);
  const hash = crypto
    .createHash('sha1')
    .update(`${repoBase}|${branch}`)
    .digest('hex')
    .slice(0, 6);

  return {
    repoAlias,
    branchAlias,
    directoryName: `${branchAlias}-${hash}`
  };
}

async function upsertWorktreeMappingDocs(rootPath, entry) {
  await fs.mkdir(rootPath, { recursive: true });

  const jsonPath = path.join(rootPath, 'worktree-map.json');
  const mdPath = path.join(rootPath, 'worktree-map.md');

  let doc = { version: 1, updatedAt: null, entries: [] };

  try {
    const current = await fs.readFile(jsonPath, 'utf8');
    const parsed = JSON.parse(current);
    if (parsed && Array.isArray(parsed.entries)) {
      doc = parsed;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }

  const normalizedEntryPath = normalizeComparablePath(entry.worktreePath);
  const filtered = doc.entries.filter(
    (item) => normalizeComparablePath(item.worktreePath) !== normalizedEntryPath,
  );

  const now = new Date().toISOString();
  filtered.push({
    ...entry,
    createdAt: entry.createdAt || now,
    updatedAt: now
  });

  filtered.sort((a, b) => String(a.worktreePath).localeCompare(String(b.worktreePath)));

  doc = {
    version: 1,
    updatedAt: now,
    entries: filtered
  };

  await fs.writeFile(jsonPath, JSON.stringify(doc, null, 2), 'utf8');

  const lines = [
    '# Worktree Mapping',
    '',
    `Updated: ${doc.updatedAt}`,
    '',
    '| 目录 | 项目 | 分支 | 源仓库路径 |',
    '| --- | --- | --- | --- |',
    ...doc.entries.map((item) => {
      const dirName = path.basename(item.worktreePath || '');
      return `| \`${dirName}\` | \`${item.projectDisplayName || item.projectName || '-'}\` | \`${item.branch || '-'}\` | \`${item.repoRoot || '-'}\` |`;
    }),
    '',
    '> 说明：完整映射可查看 `worktree-map.json`。'
  ];

  await fs.writeFile(mdPath, lines.join('\n'), 'utf8');
}

function normalizeForComparison(inputPath = '') {
  const normalized = path.normalize(inputPath);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isForbiddenWorkspacePath(targetPath) {
  const normalizedTarget = normalizeForComparison(targetPath);

  for (const forbidden of FORBIDDEN_PATHS) {
    const normalizedForbidden = normalizeForComparison(forbidden);
    if (
      normalizedTarget === normalizedForbidden ||
      normalizedTarget.startsWith(normalizedForbidden + path.sep)
    ) {
      // Exception: /var/tmp and similar user-accessible paths might be allowed
      // but /var itself and most /var subdirectories should be blocked
      if (
        normalizedForbidden === '/var' &&
        (normalizedTarget.startsWith('/var/tmp') ||
          normalizedTarget.startsWith('/var/folders'))
      ) {
        continue;
      }
      return { forbidden: true, root: forbidden };
    }
  }

  return { forbidden: false, root: null };
}

/**
 * Validates that a path is safe for workspace operations
 * @param {string} requestedPath - The path to validate
 * @returns {Promise<{valid: boolean, resolvedPath?: string, error?: string}>}
 */
export async function validateWorkspacePath(requestedPath) {
  try {
    // Resolve to absolute path
    let absolutePath = path.resolve(requestedPath);

    // Check if path is a forbidden system directory
    const forbiddenCheck = isForbiddenWorkspacePath(absolutePath);
    if (forbiddenCheck.forbidden) {
      return {
        valid: false,
        error: `Cannot create workspace in system directory: ${forbiddenCheck.root}`
      };
    }

    // Try to resolve the real path (following symlinks)
    let realPath;
    try {
      // Check if path exists to resolve real path
      await fs.access(absolutePath);
      realPath = await fs.realpath(absolutePath);
    } catch (error) {
      if (error.code === 'ENOENT') {
        // Path doesn't exist yet - check parent directory
        let parentPath = path.dirname(absolutePath);
        try {
          const parentRealPath = await fs.realpath(parentPath);

          // Reconstruct the full path with real parent
          realPath = path.join(parentRealPath, path.basename(absolutePath));
        } catch (parentError) {
          if (parentError.code === 'ENOENT') {
            // Parent doesn't exist either - use the absolute path as-is.
            // Later checks still enforce forbidden system path rules.
            realPath = absolutePath;
          } else {
            throw parentError;
          }
        }
      } else {
        throw error;
      }
    }

    // Additional symlink check for existing paths
    try {
      await fs.access(absolutePath);
      const stats = await fs.lstat(absolutePath);

      if (stats.isSymbolicLink()) {
        // Verify symlink target is not a forbidden system path
        const linkTarget = await fs.readlink(absolutePath);
        const resolvedTarget = path.resolve(path.dirname(absolutePath), linkTarget);
        const realTarget = await fs.realpath(resolvedTarget);
        const symlinkForbiddenCheck = isForbiddenWorkspacePath(realTarget);
        if (symlinkForbiddenCheck.forbidden) {
          return {
            valid: false,
            error: `Symlink target is a forbidden system path: ${symlinkForbiddenCheck.root}`
          };
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
      // Path doesn't exist - that's fine for new workspace creation
    }

    return {
      valid: true,
      resolvedPath: realPath
    };

  } catch (error) {
    return {
      valid: false,
      error: `Path validation failed: ${error.message}`
    };
  }
}

router.get('/worktree-settings', async (_req, res) => {
  try {
    const settings = await loadWorktreeSettings();
    res.json({
      rootPath: settings.rootPath || null
    });
  } catch (error) {
    console.error('Error loading worktree settings:', error);
    res.status(500).json({
      error: 'Failed to load worktree settings',
      details: error.message
    });
  }
});

router.put('/worktree-settings', async (req, res) => {
  try {
    const { rootPath } = req.body || {};
    if (!rootPath || typeof rootPath !== 'string' || !rootPath.trim()) {
      return res.status(400).json({
        error: 'rootPath is required'
      });
    }

    const validation = await validateWorkspacePath(rootPath.trim());
    if (!validation.valid) {
      return res.status(400).json({
        error: 'Invalid worktree root path',
        details: validation.error
      });
    }

    const resolvedRoot = validation.resolvedPath;
    await fs.mkdir(resolvedRoot, { recursive: true });
    await saveWorktreeSettings({
      rootPath: resolvedRoot
    });

    res.json({
      success: true,
      rootPath: resolvedRoot,
      message: 'Worktree root path saved'
    });
  } catch (error) {
    console.error('Error saving worktree settings:', error);
    res.status(500).json({
      error: 'Failed to save worktree settings',
      details: error.message
    });
  }
});

/**
 * Create a branch workspace from an existing tracked project.
 * POST /api/projects/:projectName/create-branch-worktree
 *
 * Body:
 * - branch: string (required)
 * - fromRef?: string (optional, default HEAD)
 * - basePath?: string (optional, worktree root path)
 * - displayName?: string (optional)
 */
router.post('/:projectName/create-branch-worktree', async (req, res) => {
  try {
    const { projectName } = req.params;
    const { branch, fromRef = 'HEAD', basePath, displayName } = req.body || {};

    if (!projectName) {
      return res.status(400).json({ error: 'projectName is required' });
    }

    if (!branch || typeof branch !== 'string' || !branch.trim()) {
      return res.status(400).json({ error: 'branch is required' });
    }

    const sourceProjectPath = await extractProjectDirectory(projectName);

    const sourceValidation = await validateWorkspacePath(sourceProjectPath);
    if (!sourceValidation.valid) {
      return res.status(400).json({
        error: 'Invalid source project path',
        details: sourceValidation.error
      });
    }

    let repoRoot = '';
    try {
      const repoRootResult = await git(['rev-parse', '--show-toplevel'], sourceProjectPath);
      repoRoot = repoRootResult.stdout.trim();
    } catch (error) {
      return res.status(400).json({
        error: 'Selected project is not a git repository',
        details: error.stderr?.trim?.() || error.message
      });
    }

    try {
      await git(['check-ref-format', '--branch', branch.trim()], repoRoot);
    } catch (error) {
      return res.status(400).json({
        error: `Invalid branch name: ${branch}`,
        details: error.stderr?.trim?.() || error.message
      });
    }

    const settings = await loadWorktreeSettings();
    const configuredRootPath = settings.rootPath
      ? path.resolve(settings.rootPath)
      : null;

    const requestedRoot = basePath && String(basePath).trim()
      ? path.resolve(String(basePath).trim())
      : (configuredRootPath || DEFAULT_GIT_WORKTREE_ROOT);

    if (!requestedRoot) {
      return res.status(400).json({
        error: 'Worktree root path is not configured',
        details: 'Please configure a worktree root path first.',
        code: 'WORKTREE_ROOT_NOT_CONFIGURED'
      });
    }

    const rootValidation = await validateWorkspacePath(requestedRoot);
    if (!rootValidation.valid) {
      return res.status(400).json({
        error: 'Invalid worktree base path',
        details: rootValidation.error
      });
    }

    const worktreeBaseRoot = rootValidation.resolvedPath;
    const names = buildWorktreeDirectoryNames(repoRoot, branch.trim());
    const worktreeRepoRoot = path.join(worktreeBaseRoot, names.repoAlias);
    const targetWorktreePath = await ensureUniqueDirectoryPath(worktreeRepoRoot, names.directoryName);

    if (isPathInside(repoRoot, targetWorktreePath)) {
      return res.status(400).json({
        error: 'Worktree path must be outside the source repository',
        details: 'Choose a base path outside the current project directory.'
      });
    }

    const normalizedBranch = branch.trim();
    const localBranchExists = await gitRefExists(repoRoot, `refs/heads/${normalizedBranch}`);
    const remoteBranchExists = await gitRefExists(repoRoot, `refs/remotes/origin/${normalizedBranch}`);

    let worktreeArgs;
    if (localBranchExists) {
      worktreeArgs = ['worktree', 'add', targetWorktreePath, normalizedBranch];
    } else if (remoteBranchExists) {
      worktreeArgs = ['worktree', 'add', '-b', normalizedBranch, targetWorktreePath, `origin/${normalizedBranch}`];
    } else {
      worktreeArgs = ['worktree', 'add', '-b', normalizedBranch, targetWorktreePath, String(fromRef || 'HEAD')];
    }

    await git(worktreeArgs, repoRoot);

    const fallbackDisplayName = `${path.basename(repoRoot)} [${normalizedBranch}]`;

    let project;
    try {
      project = await addProjectManually(targetWorktreePath, displayName || fallbackDisplayName);
    } catch (error) {
      if (!String(error.message || '').includes('Project already configured for path')) {
        throw error;
      }

      const existingProjectName = encodeProjectNameFromPath(targetWorktreePath);
      const config = await loadProjectConfig();
      const existingConfig = config[existingProjectName];
      if (!existingConfig) {
        throw error;
      }

      project = {
        name: existingProjectName,
        path: existingConfig.originalPath || targetWorktreePath,
        fullPath: existingConfig.originalPath || targetWorktreePath,
        displayName: existingConfig.displayName || displayName || fallbackDisplayName,
        isManuallyAdded: true,
        isGitRepo: true,
        sessions: [],
        codexSessions: []
      };
    }

    const config = await loadProjectConfig();
    config[project.name] = {
      ...(config[project.name] || {}),
      manuallyAdded: true,
      originalPath: targetWorktreePath,
      workspaceType: 'git-worktree',
      isGitWorktree: true,
      branch: normalizedBranch,
      sourceProjectName: projectName,
      repoRoot,
      worktreePath: targetWorktreePath,
      worktreeBaseRoot
    };
    await saveProjectConfig(config);

    await saveWorktreeSettings({
      rootPath: worktreeBaseRoot
    });

    await upsertWorktreeMappingDocs(worktreeBaseRoot, {
      projectName: project.name,
      projectDisplayName: project.displayName || fallbackDisplayName,
      sourceProjectName: projectName,
      repoRoot,
      branch: normalizedBranch,
      worktreePath: targetWorktreePath
    });

    res.json({
      success: true,
      project: {
        ...project,
        workspaceType: 'git-worktree',
        isGitWorktree: true,
        isGitRepo: true,
        branch: normalizedBranch,
        sourceProjectName: projectName,
        repoRoot,
        worktreePath: targetWorktreePath,
        worktreeBaseRoot
      },
      metadata: {
        localBranchExists,
        remoteBranchExists,
        sourceProjectPath,
        repoRoot,
        worktreePath: targetWorktreePath,
        worktreeBaseRoot,
        worktreeMapFile: path.join(worktreeBaseRoot, 'worktree-map.md')
      },
      message: 'Branch workspace created successfully'
    });
  } catch (error) {
    console.error('Error creating branch workspace:', error);
    res.status(500).json({
      error: 'Failed to create branch workspace',
      details: error.stderr?.trim?.() || error.message,
      code: error.code || null
    });
  }
});

/**
 * Create a new workspace
 * POST /api/projects/create-workspace
 *
 * Body:
 * - workspaceType: 'existing' | 'new'
 * - path: string (workspace path)
 * - githubUrl?: string (optional, for new workspaces)
 * - githubTokenId?: number (optional, ID of stored token)
 * - newGithubToken?: string (optional, one-time token)
 */
router.post('/create-workspace', async (req, res) => {
  try {
    const { workspaceType, path: workspacePath, githubUrl, githubTokenId, newGithubToken } = req.body;

    // Validate required fields
    if (!workspaceType || !workspacePath) {
      return res.status(400).json({ error: 'workspaceType and path are required' });
    }

    if (!['existing', 'new'].includes(workspaceType)) {
      return res.status(400).json({ error: 'workspaceType must be "existing" or "new"' });
    }

    // Validate path safety before any operations
    const validation = await validateWorkspacePath(workspacePath);
    if (!validation.valid) {
      return res.status(400).json({
        error: 'Invalid workspace path',
        details: validation.error
      });
    }

    const absolutePath = validation.resolvedPath;

    // Handle existing workspace
    if (workspaceType === 'existing') {
      // Check if the path exists
      try {
        await fs.access(absolutePath);
        const stats = await fs.stat(absolutePath);

        if (!stats.isDirectory()) {
          return res.status(400).json({ error: 'Path exists but is not a directory' });
        }
      } catch (error) {
        if (error.code === 'ENOENT') {
          return res.status(404).json({ error: 'Workspace path does not exist' });
        }
        throw error;
      }

      // Add the existing workspace to the project list
      const project = await addProjectManually(absolutePath);

      return res.json({
        success: true,
        project,
        message: 'Existing workspace added successfully'
      });
    }

    // Handle new workspace creation
    if (workspaceType === 'new') {
      // Create the directory if it doesn't exist
      await fs.mkdir(absolutePath, { recursive: true });

      // If source hosting URL is provided, clone the repository
      if (githubUrl) {
        let githubToken = null;

        // Get source hosting token if needed
        if (githubTokenId) {
          // Fetch token from database
          const token = await getGithubTokenById(githubTokenId, req.user.id);
          if (!token) {
            // Clean up created directory
            await fs.rm(absolutePath, { recursive: true, force: true });
            return res.status(404).json({ error: 'source hosting token not found' });
          }
          githubToken = token.github_token;
        } else if (newGithubToken) {
          githubToken = newGithubToken;
        }

        // Extract repo name from URL for the clone destination
        const normalizedUrl = githubUrl.replace(/\/+$/, '').replace(/\.git$/, '');
        const repoName = normalizedUrl.split('/').pop() || 'repository';
        const clonePath = path.join(absolutePath, repoName);

        // Check if clone destination already exists to prevent data loss
        try {
          await fs.access(clonePath);
          return res.status(409).json({
            error: 'Directory already exists',
            details: `The destination path "${clonePath}" already exists. Please choose a different location or remove the existing directory.`
          });
        } catch (err) {
          // Directory doesn't exist, which is what we want
        }

        // Clone the repository into a subfolder
        try {
          await cloneRepository(githubUrl, clonePath, githubToken);
        } catch (error) {
          // Only clean up if clone created partial data (check if dir exists and is empty or partial)
          try {
            const stats = await fs.stat(clonePath);
            if (stats.isDirectory()) {
              await fs.rm(clonePath, { recursive: true, force: true });
            }
          } catch (cleanupError) {
            // Directory doesn't exist or cleanup failed - ignore
          }
          throw new Error(`Failed to clone repository: ${error.message}`);
        }

        // Add the cloned repo path to the project list
        const project = await addProjectManually(clonePath);

        return res.json({
          success: true,
          project,
          message: 'New workspace created and repository cloned successfully'
        });
      }

      // Add the new workspace to the project list (no clone)
      const project = await addProjectManually(absolutePath);

      return res.json({
        success: true,
        project,
        message: 'New workspace created successfully'
      });
    }

  } catch (error) {
    console.error('Error creating workspace:', error);
    res.status(500).json({
      error: error.message || 'Failed to create workspace',
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

/**
 * Helper function to get source hosting token from database
 */
async function getGithubTokenById(tokenId, userId) {
  const { getDatabase } = await import('../database/db.js');
  const db = await getDatabase();

  const credential = await db.get(
    'SELECT * FROM user_credentials WHERE id = ? AND user_id = ? AND credential_type = ? AND is_active = 1',
    [tokenId, userId, 'github_token']
  );

  // Return in the expected format (github_token field for compatibility)
  if (credential) {
    return {
      ...credential,
      github_token: credential.credential_value
    };
  }

  return null;
}

/**
 * Clone repository with progress streaming (SSE)
 * GET /api/projects/clone-progress
 */
router.get('/clone-progress', async (req, res) => {
  const { path: workspacePath, githubUrl, githubTokenId, newGithubToken } = req.query;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendEvent = (type, data) => {
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  };

  try {
    if (!workspacePath || !githubUrl) {
      sendEvent('error', { message: 'workspacePath and githubUrl are required' });
      res.end();
      return;
    }

    const validation = await validateWorkspacePath(workspacePath);
    if (!validation.valid) {
      sendEvent('error', { message: validation.error });
      res.end();
      return;
    }

    const absolutePath = validation.resolvedPath;

    await fs.mkdir(absolutePath, { recursive: true });

    let githubToken = null;
    if (githubTokenId) {
      const token = await getGithubTokenById(parseInt(githubTokenId), req.user.id);
      if (!token) {
        await fs.rm(absolutePath, { recursive: true, force: true });
        sendEvent('error', { message: 'source hosting token not found' });
        res.end();
        return;
      }
      githubToken = token.github_token;
    } else if (newGithubToken) {
      githubToken = newGithubToken;
    }

    const normalizedUrl = githubUrl.replace(/\/+$/, '').replace(/\.git$/, '');
    const repoName = normalizedUrl.split('/').pop() || 'repository';
    const clonePath = path.join(absolutePath, repoName);

    // Check if clone destination already exists to prevent data loss
    try {
      await fs.access(clonePath);
      sendEvent('error', { message: `Directory "${repoName}" already exists. Please choose a different location or remove the existing directory.` });
      res.end();
      return;
    } catch (err) {
      // Directory doesn't exist, which is what we want
    }

    let cloneUrl = githubUrl;
    if (githubToken) {
      try {
        const url = new URL(githubUrl);
        url.username = githubToken;
        url.password = '';
        cloneUrl = url.toString();
      } catch (error) {
        // SSH URL or invalid - use as-is
      }
    }

    sendEvent('progress', { message: `Cloning into '${repoName}'...` });

    const gitProcess = spawn(GIT_CMD, ['clone', '--progress', cloneUrl, clonePath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0'
      }
    });

    let lastError = '';

    gitProcess.stdout.on('data', (data) => {
      const message = data.toString().trim();
      if (message) {
        sendEvent('progress', { message });
      }
    });

    gitProcess.stderr.on('data', (data) => {
      const message = data.toString().trim();
      lastError = message;
      if (message) {
        sendEvent('progress', { message });
      }
    });

    gitProcess.on('close', async (code) => {
      if (code === 0) {
        try {
          const project = await addProjectManually(clonePath);
          sendEvent('complete', { project, message: 'Repository cloned successfully' });
        } catch (error) {
          sendEvent('error', { message: `Clone succeeded but failed to add project: ${error.message}` });
        }
      } else {
        const sanitizedError = sanitizeGitError(lastError, githubToken);
        let errorMessage = 'Git clone failed';
        if (lastError.includes('Authentication failed') || lastError.includes('could not read Username')) {
          errorMessage = 'Authentication failed. Please check your credentials.';
        } else if (lastError.includes('Repository not found')) {
          errorMessage = 'Repository not found. Please check the URL and ensure you have access.';
        } else if (lastError.includes('already exists')) {
          errorMessage = 'Directory already exists';
        } else if (sanitizedError) {
          errorMessage = sanitizedError;
        }
        try {
          await fs.rm(clonePath, { recursive: true, force: true });
        } catch (cleanupError) {
          console.error('Failed to clean up after clone failure:', sanitizeGitError(cleanupError.message, githubToken));
        }
        sendEvent('error', { message: errorMessage });
      }
      res.end();
    });

    gitProcess.on('error', (error) => {
      if (error.code === 'ENOENT') {
        sendEvent('error', { message: 'Git is not installed or not in PATH' });
      } else {
        sendEvent('error', { message: error.message });
      }
      res.end();
    });

    req.on('close', () => {
      gitProcess.kill();
    });

  } catch (error) {
    sendEvent('error', { message: error.message });
    res.end();
  }
});

/**
 * Helper function to clone a source hosting repository
 */
function cloneRepository(githubUrl, destinationPath, githubToken = null) {
  return new Promise((resolve, reject) => {
    let cloneUrl = githubUrl;

    if (githubToken) {
      try {
        const url = new URL(githubUrl);
        url.username = githubToken;
        url.password = '';
        cloneUrl = url.toString();
      } catch (error) {
        // SSH URL - use as-is
      }
    }

    const gitProcess = spawn(GIT_CMD, ['clone', '--progress', cloneUrl, destinationPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0'
      }
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
        resolve({ stdout, stderr });
      } else {
        let errorMessage = 'Git clone failed';

        if (stderr.includes('Authentication failed') || stderr.includes('could not read Username')) {
          errorMessage = 'Authentication failed. Please check your source hosting token.';
        } else if (stderr.includes('Repository not found')) {
          errorMessage = 'Repository not found. Please check the URL and ensure you have access.';
        } else if (stderr.includes('already exists')) {
          errorMessage = 'Directory already exists';
        } else if (stderr) {
          errorMessage = stderr;
        }

        reject(new Error(errorMessage));
      }
    });

    gitProcess.on('error', (error) => {
      if (error.code === 'ENOENT') {
        reject(new Error('Git is not installed or not in PATH'));
      } else {
        reject(error);
      }
    });
  });
}

export default router;
