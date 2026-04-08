import { getStoredFileAccessMode } from './fileAccessMode';

// Simple fetch wrapper without authentication
// This is a compatibility export for components still importing it
export const authenticatedFetch = (url, options = {}) => fetchWrapper(url, options);

const fetchWrapper = (url, options = {}) => {
  const defaultHeaders = {};
  const fileAccessMode = getStoredFileAccessMode();

  if (fileAccessMode) {
    defaultHeaders['x-openwork-file-access-mode'] = fileAccessMode;
  }

  // Only set Content-Type for non-FormData requests
  if (!(options.body instanceof FormData)) {
    defaultHeaders['Content-Type'] = 'application/json';
  }

  return fetch(url, {
    ...options,
    headers: {
      ...defaultHeaders,
      ...options.headers,
    },
  });
};

const encodeProjectParam = (projectName) => encodeURIComponent(String(projectName ?? ''));
const encodeSessionParam = (sessionId) => encodeURIComponent(String(sessionId ?? ''));

// API endpoints
export const api = {
  // Auth endpoints (no token required)
  auth: {
    status: () => fetch('/api/auth/status'),
    login: (username, password) => fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    }),
    register: (username, password) => fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    }),
    user: () => fetchWrapper('/api/auth/user'),
    logout: () => fetchWrapper('/api/auth/logout', { method: 'POST' }),
  },

  // Protected endpoints (no longer require auth)
  // config endpoint removed - no longer needed (frontend uses window.location)
  projects: () => fetchWrapper('/api/projects'),
  sessions: (projectName, limit = 5, offset = 0) =>
    fetchWrapper(`/api/projects/${encodeProjectParam(projectName)}/sessions?limit=${limit}&offset=${offset}`),
  sessionMessages: (projectName, sessionId, limit = null, offset = 0, provider = 'claude') => {
    const params = new URLSearchParams();
    if (limit !== null) {
      params.append('limit', limit);
      params.append('offset', offset);
    }
    const queryString = params.toString();

    // Route to the correct endpoint based on provider
    let url;
    if (provider === 'codex') {
      url = `/api/codex/sessions/${encodeSessionParam(sessionId)}/messages${queryString ? `?${queryString}` : ''}`;
    } else {
      url = `/api/projects/${encodeProjectParam(projectName)}/sessions/${encodeSessionParam(sessionId)}/messages${queryString ? `?${queryString}` : ''}`;
    }
    return fetchWrapper(url);
  },
  renameProject: (projectName, displayName) =>
    fetchWrapper(`/api/projects/${encodeProjectParam(projectName)}/rename`, {
      method: 'PUT',
      body: JSON.stringify({ displayName }),
    }),
  renameSession: (projectName, sessionId, title) =>
    fetchWrapper(`/api/projects/${encodeProjectParam(projectName)}/sessions/${encodeSessionParam(sessionId)}/rename`, {
      method: 'PUT',
      body: JSON.stringify({ title }),
    }),
  deleteSession: (projectName, sessionId) =>
    fetchWrapper(`/api/projects/${encodeProjectParam(projectName)}/sessions/${encodeSessionParam(sessionId)}`, {
      method: 'DELETE',
    }),
  deleteCodexSession: (sessionId) =>
    fetchWrapper(`/api/codex/sessions/${encodeSessionParam(sessionId)}`, {
      method: 'DELETE',
    }),
  deleteProject: (projectName, force = false) =>
    fetchWrapper(`/api/projects/${encodeProjectParam(projectName)}${force ? '?force=true' : ''}`, {
      method: 'DELETE',
    }),
  createProject: (path) =>
    fetchWrapper('/api/projects/create', {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),
  createWorkspace: (workspaceData) =>
    fetchWrapper('/api/projects/create-workspace', {
      method: 'POST',
      body: JSON.stringify(workspaceData),
    }),
  createBranchWorkspace: (projectName, payload) =>
    fetchWrapper(`/api/projects/${encodeProjectParam(projectName)}/create-branch-worktree`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  getWorktreeSettings: () =>
    fetchWrapper('/api/projects/worktree-settings'),
  setWorktreeSettings: (rootPath) =>
    fetchWrapper('/api/projects/worktree-settings', {
      method: 'PUT',
      body: JSON.stringify({ rootPath }),
    }),
  readFile: (projectName, filePath) =>
    fetchWrapper(`/api/projects/${encodeProjectParam(projectName)}/file?filePath=${encodeURIComponent(filePath)}`),
  saveFile: (projectName, filePath, content) =>
    fetchWrapper(`/api/projects/${encodeProjectParam(projectName)}/file`, {
      method: 'PUT',
      body: JSON.stringify({ filePath, content }),
    }),
  getFiles: (projectName, options = {}) =>
    fetchWrapper(`/api/projects/${encodeProjectParam(projectName)}/files`, options),
  transcribe: (formData) =>
    fetchWrapper('/api/transcribe', {
      method: 'POST',
      body: formData,
      headers: {}, // Let browser set Content-Type for FormData
    }),

  // Browse filesystem for project suggestions
  browseFilesystem: (dirPath = null) => {
    const params = new URLSearchParams();
    if (dirPath) params.append('path', dirPath);

    return fetchWrapper(`/api/browse-filesystem?${params}`);
  },

  createFolder: (folderPath) =>
    fetchWrapper('/api/create-folder', {
      method: 'POST',
      body: JSON.stringify({ path: folderPath }),
    }),

  // User endpoints
  user: {
    gitConfig: () => fetchWrapper('/api/user/git-config'),
    updateGitConfig: (gitName, gitEmail) =>
      fetchWrapper('/api/user/git-config', {
        method: 'POST',
        body: JSON.stringify({ gitName, gitEmail }),
      }),
    onboardingStatus: () => fetchWrapper('/api/user/onboarding-status'),
    completeOnboarding: () =>
      fetchWrapper('/api/user/complete-onboarding', {
        method: 'POST',
      }),
  },

  mcp: {
    claudeConfig: () => fetchWrapper('/api/mcp/config/read'),
    claudeAddJson: (payload) => fetchWrapper('/api/mcp/cli/add-json', { method: 'POST', body: JSON.stringify(payload) }),
    claudeDelete: (name, scope) => fetchWrapper(`/api/mcp/cli/remove/${encodeURIComponent(String(name))}${scope ? `?scope=${encodeURIComponent(String(scope))}` : ''}`, { method: 'DELETE' }),
    codexConfig: () => fetchWrapper('/api/codex/config'),
    codexList: () => fetchWrapper('/api/codex/mcp'),
    codexSave: (payload) => fetchWrapper('/api/codex/mcp', { method: 'POST', body: JSON.stringify(payload) }),
    codexDelete: (name) => fetchWrapper(`/api/codex/mcp/${encodeURIComponent(String(name))}`, { method: 'DELETE' }),
  },

  skills: {
    list: () => fetchWrapper('/api/skills'),
    get: (skillId) => fetchWrapper(`/api/skills/${encodeURIComponent(String(skillId))}`),
    create: (payload) => fetchWrapper('/api/skills', { method: 'POST', body: JSON.stringify(payload) }),
    update: (skillId, payload) => fetchWrapper(`/api/skills/${encodeURIComponent(String(skillId))}`, { method: 'PUT', body: JSON.stringify(payload) }),
    delete: (skillId) => fetchWrapper(`/api/skills/${encodeURIComponent(String(skillId))}`, { method: 'DELETE' }),
  },

  // Generic GET method for any endpoint
  get: (endpoint) => fetchWrapper(`/api${endpoint}`),
};
