import React, { useState, useEffect } from 'react';
import { X, FolderPlus, GitBranch, Key, ChevronRight, ChevronLeft, Check, Loader2, AlertCircle, FolderOpen, HardDrive, ArrowUp, Folder } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { projects as tauriProjects, fs as tauriFs, settings } from '../lib/tauri-bridge';
import { useTranslation } from 'react-i18next';
import { selectProjectDirectory, isFileDialogAvailable } from '../utils/fileDialog';

const normalizePathForCompare = (value = '') => value.replace(/\\/g, '/').toLowerCase();

const resolveBrowseBasePath = (inputPath = '') => {
  const trimmed = inputPath.trim();
  if (!trimmed) return null;

  const normalized = trimmed.replace(/\\/g, '/');
  const lastSlash = normalized.lastIndexOf('/');
  if (lastSlash > 0) {
    return normalized.substring(0, lastSlash);
  }

  if (/^[A-Za-z]:$/.test(trimmed)) {
    return `${trimmed}\\`;
  }

  if (/^[A-Za-z]:[\\/]$/.test(trimmed) || trimmed === '~' || trimmed === '/') {
    return trimmed;
  }

  return '~';
};

const getParentDirectoryPath = (inputPath = '') => {
  const trimmed = inputPath.trim();
  if (!trimmed) return null;

  // Windows path
  if (/^[A-Za-z]:/.test(trimmed)) {
    const normalized = trimmed.replace(/\//g, '\\').replace(/\\+$/, '');
    if (/^[A-Za-z]:$/.test(normalized)) return null;

    const rootMatch = normalized.match(/^([A-Za-z]:)(\\.*)?$/);
    if (!rootMatch) return null;

    const drive = rootMatch[1];
    const rest = (rootMatch[2] || '').replace(/^\\+/, '');
    if (!rest) return null;

    const segments = rest.split('\\').filter(Boolean);
    if (segments.length <= 1) {
      return `${drive}\\`;
    }
    return `${drive}\\${segments.slice(0, -1).join('\\')}`;
  }

  // Unix path
  const normalizedUnix = trimmed.replace(/\/+$/, '') || '/';
  if (normalizedUnix === '/') return null;
  const lastSlash = normalizedUnix.lastIndexOf('/');
  if (lastSlash <= 0) return '/';
  return normalizedUnix.substring(0, lastSlash);
};

const ProjectCreationWizard = ({ onClose, onProjectCreated }) => {
  const { t } = useTranslation();
  // Wizard state
  const [step, setStep] = useState(1); // 1: Choose type, 2: Configure, 3: Confirm
  const [workspaceType, setWorkspaceType] = useState('existing'); // 'existing' or 'new' - default to 'existing'

  // Form state
  const [workspacePath, setWorkspacePath] = useState('');
  const [githubUrl, setGithubUrl] = useState('');
  const [selectedGithubToken, setSelectedGithubToken] = useState('');
  const [tokenMode, setTokenMode] = useState('stored'); // 'stored' | 'new' | 'none'
  const [newGithubToken, setNewGithubToken] = useState('');

  // UI state
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState(null);
  const [availableTokens, setAvailableTokens] = useState([]);
  const [loadingTokens, setLoadingTokens] = useState(false);
  const [pathSuggestions, setPathSuggestions] = useState([]);
  const [showPathDropdown, setShowPathDropdown] = useState(false);
  const [cloneProgress, setCloneProgress] = useState('');
  const [isSelectingDirectory, setIsSelectingDirectory] = useState(false);
  const [showWebDirectoryBrowser, setShowWebDirectoryBrowser] = useState(false);
  const [browserRoots, setBrowserRoots] = useState([]);
  const [browserPath, setBrowserPath] = useState('');
  const [browserDirectories, setBrowserDirectories] = useState([]);
  const [browserLoading, setBrowserLoading] = useState(false);
  const [browserError, setBrowserError] = useState(null);

  // Load available source hosting tokens when needed
  useEffect(() => {
    if (step === 2 && workspaceType === 'new' && githubUrl) {
      loadGithubTokens();
    }
  }, [step, workspaceType, githubUrl]);

  // Load path suggestions
  useEffect(() => {
    if (workspacePath.length > 2) {
      loadPathSuggestions(workspacePath);
    } else {
      setPathSuggestions([]);
      setShowPathDropdown(false);
    }
  }, [workspacePath]);

  const loadGithubTokens = async () => {
    try {
      setLoadingTokens(true);
      const allSettings = await settings.getAll();
      const tokens = allSettings?.github_tokens;
      const activeTokens = Array.isArray(tokens) ? tokens.filter(t => t.is_active) : [];
      setAvailableTokens(activeTokens);

      if (activeTokens.length > 0 && !selectedGithubToken) {
        setSelectedGithubToken(activeTokens[0].id?.toString());
      }
    } catch (error) {
      console.error('Error loading source hosting tokens:', error);
    } finally {
      setLoadingTokens(false);
    }
  };

  const loadPathSuggestions = async (inputPath) => {
    try {
      const dirPath = resolveBrowseBasePath(inputPath) || '~';
      const normalizedInputPath = normalizePathForCompare(inputPath);

      const entries = await tauriFs.listDir(dirPath);
      const suggestions = entries
        .filter(e => e.is_dir)
        .map(e => ({ path: e.path, name: e.name, type: 'directory' }));

      if (suggestions.length > 0) {
        const filtered = suggestions.filter(s =>
          normalizePathForCompare(s.path).startsWith(normalizedInputPath) &&
          normalizePathForCompare(s.path) !== normalizedInputPath
        );
        setPathSuggestions(filtered.slice(0, 5));
        setShowPathDropdown(filtered.length > 0);
      }
    } catch (error) {
      console.error('Error loading path suggestions:', error);
    }
  };

  const handleNext = () => {
    setError(null);

    if (step === 1) {
      if (!workspaceType) {
        setError(t('projectWizard.errors.selectType'));
        return;
      }
      setStep(2);
    } else if (step === 2) {
      if (!workspacePath.trim()) {
        setError(t('projectWizard.errors.providePath'));
        return;
      }

      // No validation for source hosting token - it's optional (only needed for private repos)
      setStep(3);
    }
  };

  const handleBack = () => {
    setError(null);
    setStep(step - 1);
  };

  const handleCreate = async () => {
    setIsCreating(true);
    setError(null);
    setCloneProgress('');

    try {
      if (workspaceType === 'new' && githubUrl) {
        const params = new URLSearchParams({
          path: workspacePath.trim(),
          githubUrl: githubUrl.trim(),
        });

        if (tokenMode === 'stored' && selectedGithubToken) {
          params.append('githubTokenId', selectedGithubToken);
        } else if (tokenMode === 'new' && newGithubToken) {
          params.append('newGithubToken', newGithubToken.trim());
        }

        const url = `/api/projects/clone-progress?${params}`;

        await new Promise((resolve, reject) => {
          const eventSource = new EventSource(url);

          eventSource.onmessage = (event) => {
            try {
              const data = JSON.parse(event.data);

              if (data.type === 'progress') {
                setCloneProgress(data.message);
              } else if (data.type === 'complete') {
                eventSource.close();
                if (onProjectCreated) {
                  onProjectCreated(data.project);
                }
                onClose();
                resolve();
              } else if (data.type === 'error') {
                eventSource.close();
                reject(new Error(data.message));
              }
            } catch (e) {
              console.error('Error parsing SSE event:', e);
            }
          };

          eventSource.onerror = () => {
            eventSource.close();
            reject(new Error('Connection lost during clone'));
          };
        });
        return;
      }

      const payload = {
        workspaceType,
        path: workspacePath.trim(),
      };

      const project = await tauriProjects.add(payload.path, payload.path);

      if (onProjectCreated) {
        onProjectCreated(project);
      }

      onClose();
    } catch (error) {
      console.error('Error creating workspace:', error);
      setError(error.message || t('projectWizard.errors.failedToCreate'));
    } finally {
      setIsCreating(false);
    }
  };

  const selectPathSuggestion = (suggestion) => {
    setWorkspacePath(suggestion.path);
    setShowPathDropdown(false);
  };

  const handleSelectDirectory = async () => {
    setIsSelectingDirectory(true);
    setError(null);

    try {
      if (!isFileDialogAvailable()) {
        setShowWebDirectoryBrowser(true);
        setBrowserError(null);

        try {
          const entries = await tauriFs.listDir(resolveBrowseBasePath(workspacePath) || '~');
          const dirs = entries.filter(e => e.is_dir).map(e => ({ path: e.path, name: e.name, type: 'directory' }));
          setBrowserRoots([{ path: '/', label: '/' }]);
          setBrowserPath(resolveBrowseBasePath(workspacePath) || '~');
          setBrowserDirectories(dirs);
        } catch (err) {
          setBrowserError(err.message || t('projectWizard.errors.directoryNotAccessible', 'Selected directory is not accessible'));
        }
        return;
      }

      const result = await selectProjectDirectory({
        title: workspaceType === 'existing'
          ? t('projectWizard.selectExistingDirectory', 'Select Existing Project Directory')
          : t('projectWizard.selectNewDirectory', 'Select Directory for New Project'),
        buttonLabel: t('projectWizard.selectButton', 'Select'),
      });

      if (!result.canceled && result.filePath) {
        setWorkspacePath(result.filePath);
        if (workspaceType === 'existing') {
          setStep(3);
        }
      }
    } catch (error) {
      console.error('Error selecting directory:', error);
      setError(error.message || t('projectWizard.errors.failedToSelectDirectory', 'Failed to select directory'));
    } finally {
      setIsSelectingDirectory(false);
    }
  };

  const loadBrowserDirectory = async (targetPath = null) => {
    setBrowserLoading(true);
    setBrowserError(null);
    try {
      const entries = await tauriFs.listDir(targetPath || '~');
      const dirs = entries.filter(e => e.is_dir).map(e => ({ path: e.path, name: e.name, type: 'directory' }));
      setBrowserPath(targetPath || '~');
      setBrowserDirectories(dirs);
    } catch (err) {
      setBrowserError(err.message || t('projectWizard.errors.failedToSelectDirectory', 'Failed to select directory'));
    } finally {
      setBrowserLoading(false);
    }
  };

  const handleBrowserSelectCurrent = () => {
    if (!browserPath) return;
    setWorkspacePath(browserPath);
    setShowPathDropdown(false);
    setShowWebDirectoryBrowser(false);
    if (workspaceType === 'existing') {
      setStep(3);
    }
  };

  return (
    <div className="fixed top-0 left-0 right-0 bottom-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-[60] p-0 sm:p-4">
      <div className="bg-white dark:bg-gray-800 rounded-none sm:rounded-lg shadow-xl w-full h-full sm:h-auto sm:max-w-2xl border-0 sm:border border-gray-200 dark:border-gray-700 overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-200 dark:border-gray-700">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-blue-100 dark:bg-blue-900/50 rounded-lg flex items-center justify-center">
              <FolderPlus className="w-4 h-4 text-blue-600 dark:text-blue-400" />
            </div>
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
              {t('projectWizard.title')}
            </h3>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700"
            disabled={isCreating}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Progress Indicator */}
        <div className="px-6 pt-4 pb-2">
          <div className="flex items-center justify-between">
            {[1, 2, 3].map((s) => (
              <React.Fragment key={s}>
                <div className="flex items-center gap-2">
                  <div
                    className={`w-8 h-8 rounded-full flex items-center justify-center font-medium text-sm ${
                      s < step
                        ? 'bg-green-500 text-white'
                        : s === step
                        ? 'bg-blue-500 text-white'
                        : 'bg-gray-200 dark:bg-gray-700 text-gray-500'
                    }`}
                  >
                    {s < step ? <Check className="w-4 h-4" /> : s}
                  </div>
                  <span className="text-sm font-medium text-gray-700 dark:text-gray-300 hidden sm:inline">
                    {s === 1 ? t('projectWizard.steps.type') : s === 2 ? t('projectWizard.steps.configure') : t('projectWizard.steps.confirm')}
                  </span>
                </div>
                {s < 3 && (
                  <div
                    className={`flex-1 h-1 mx-2 rounded ${
                      s < step ? 'bg-green-500' : 'bg-gray-200 dark:bg-gray-700'
                    }`}
                  />
                )}
              </React.Fragment>
            ))}
          </div>
        </div>

        {/* Content */}
        <div className="p-6 space-y-6 min-h-[300px]">
          {/* Error Display */}
          {error && (
            <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4 flex items-start gap-3">
              <AlertCircle className="w-5 h-5 text-red-600 dark:text-red-400 flex-shrink-0 mt-0.5" />
              <div className="flex-1">
                <p className="text-sm text-red-800 dark:text-red-200">{error}</p>
              </div>
            </div>
          )}

          {/* Step 1: Choose workspace type */}
          {step === 1 && (
            <div className="space-y-4">
              <div>
                <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">
                  {t('projectWizard.step1.question')}
                </h4>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {/* Existing Workspace */}
                  <button
                    onClick={() => setWorkspaceType('existing')}
                    className={`p-4 border-2 rounded-lg text-left transition-all ${
                      workspaceType === 'existing'
                        ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                        : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600'
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <div className="w-10 h-10 bg-green-100 dark:bg-green-900/50 rounded-lg flex items-center justify-center flex-shrink-0">
                        <FolderPlus className="w-5 h-5 text-green-600 dark:text-green-400" />
                      </div>
                      <div className="flex-1">
                        <h5 className="font-semibold text-gray-900 dark:text-white mb-1">
                          {t('projectWizard.step1.existing.title')}
                        </h5>
                        <p className="text-sm text-gray-600 dark:text-gray-400">
                          {t('projectWizard.step1.existing.description')}
                        </p>
                      </div>
                    </div>
                  </button>

                  {/* New Workspace */}
                  <button
                    onClick={() => setWorkspaceType('new')}
                    className={`p-4 border-2 rounded-lg text-left transition-all ${
                      workspaceType === 'new'
                        ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                        : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600'
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <div className="w-10 h-10 bg-purple-100 dark:bg-purple-900/50 rounded-lg flex items-center justify-center flex-shrink-0">
                        <GitBranch className="w-5 h-5 text-purple-600 dark:text-purple-400" />
                      </div>
                      <div className="flex-1">
                        <h5 className="font-semibold text-gray-900 dark:text-white mb-1">
                          {t('projectWizard.step1.new.title')}
                        </h5>
                        <p className="text-sm text-gray-600 dark:text-gray-400">
                          {t('projectWizard.step1.new.description')}
                        </p>
                      </div>
                    </div>
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Step 2: Configure workspace */}
          {step === 2 && (
            <div className="space-y-4">
              {/* Workspace Path */}
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  {workspaceType === 'existing' ? t('projectWizard.step2.existingPath') : t('projectWizard.step2.newPath')}
                </label>
                <div className="relative flex gap-2">
                  <div className="flex-1 relative">
                    <Input
                      type="text"
                      value={workspacePath}
                      onChange={(e) => setWorkspacePath(e.target.value)}
                      placeholder={workspaceType === 'existing' ? '/path/to/existing/workspace' : '/path/to/new/workspace'}
                      className="w-full"
                    />
                    {showPathDropdown && pathSuggestions.length > 0 && (
                      <div className="absolute z-10 w-full mt-1 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg max-h-60 overflow-y-auto">
                        {pathSuggestions.map((suggestion, index) => (
                          <button
                            key={index}
                            onClick={() => selectPathSuggestion(suggestion)}
                            className="w-full px-4 py-2 text-left hover:bg-gray-100 dark:hover:bg-gray-700 text-sm"
                          >
                            <div className="font-medium text-gray-900 dark:text-white">{suggestion.name}</div>
                            <div className="text-xs text-gray-500 dark:text-gray-400">{suggestion.path}</div>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleSelectDirectory}
                    disabled={isSelectingDirectory}
                    className="px-3"
                    title={t('projectWizard.browseFolders')}
                  >
                    {isSelectingDirectory ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <FolderOpen className="w-4 h-4" />
                    )}
                  </Button>
                </div>
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  {workspaceType === 'existing'
                    ? t('projectWizard.step2.existingHelp')
                    : t('projectWizard.step2.newHelp')}
                </p>
              </div>

              {/* source hosting URL (only for new workspace) */}
              {workspaceType === 'new' && (
                <>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                      {t('projectWizard.step2.githubUrl')}
                    </label>
                    <Input
                      type="text"
                      value={githubUrl}
                      onChange={(e) => setGithubUrl(e.target.value)}
                      placeholder="https://source.example.com/username/repository"
                      className="w-full"
                    />
                    <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                      {t('projectWizard.step2.githubHelp')}
                    </p>
                  </div>

                  {/* source hosting Token (only for HTTPS URLs - SSH uses SSH keys) */}
                  {githubUrl && !githubUrl.startsWith('git@') && !githubUrl.startsWith('ssh://') && (
                    <div className="bg-gray-50 dark:bg-gray-900/50 rounded-lg p-4 border border-gray-200 dark:border-gray-700">
                      <div className="flex items-start gap-3 mb-4">
                        <Key className="w-5 h-5 text-gray-600 dark:text-gray-400 flex-shrink-0 mt-0.5" />
                        <div className="flex-1">
                          <h5 className="font-medium text-gray-900 dark:text-white mb-1">
                            {t('projectWizard.step2.githubAuth')}
                          </h5>
                          <p className="text-sm text-gray-600 dark:text-gray-400">
                            {t('projectWizard.step2.githubAuthHelp')}
                          </p>
                        </div>
                      </div>

                      {loadingTokens ? (
                        <div className="flex items-center gap-2 text-sm text-gray-500">
                          <Loader2 className="w-4 h-4 animate-spin" />
                          {t('projectWizard.step2.loadingTokens')}
                        </div>
                      ) : availableTokens.length > 0 ? (
                        <>
                          {/* Token Selection Tabs */}
                          <div className="grid grid-cols-3 gap-2 mb-4">
                            <button
                              onClick={() => setTokenMode('stored')}
                              className={`px-3 py-2 text-sm font-medium rounded-lg transition-colors ${
                                tokenMode === 'stored'
                                  ? 'bg-blue-500 text-white'
                                  : 'bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
                              }`}
                            >
                              {t('projectWizard.step2.storedToken')}
                            </button>
                            <button
                              onClick={() => setTokenMode('new')}
                              className={`px-3 py-2 text-sm font-medium rounded-lg transition-colors ${
                                tokenMode === 'new'
                                  ? 'bg-blue-500 text-white'
                                  : 'bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
                              }`}
                            >
                              {t('projectWizard.step2.newToken')}
                            </button>
                            <button
                              onClick={() => {
                                setTokenMode('none');
                                setSelectedGithubToken('');
                                setNewGithubToken('');
                              }}
                              className={`px-3 py-2 text-sm font-medium rounded-lg transition-colors ${
                                tokenMode === 'none'
                                  ? 'bg-green-500 text-white'
                                  : 'bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
                              }`}
                            >
                              {t('projectWizard.step2.nonePublic')}
                            </button>
                          </div>

                          {tokenMode === 'stored' ? (
                            <div>
                              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                                {t('projectWizard.step2.selectToken')}
                              </label>
                              <select
                                value={selectedGithubToken}
                                onChange={(e) => setSelectedGithubToken(e.target.value)}
                                className="w-full px-3 py-2 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg text-sm"
                              >
                                <option value="">{t('projectWizard.step2.selectTokenPlaceholder')}</option>
                                {availableTokens.map((token) => (
                                  <option key={token.id} value={token.id}>
                                    {token.credential_name}
                                  </option>
                                ))}
                              </select>
                            </div>
                          ) : tokenMode === 'new' ? (
                            <div>
                              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                                {t('projectWizard.step2.newToken')}
                              </label>
                              <Input
                                type="text"
                                value={newGithubToken}
                                onChange={(e) => setNewGithubToken(e.target.value)}
                                placeholder="ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                                autoCapitalize="none"
                                autoCorrect="off"
                                spellCheck={false}
                                className="w-full"
                              />
                              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                                {t('projectWizard.step2.tokenHelp')}
                              </p>
                            </div>
                          ) : null}
                        </>
                      ) : (
                        <div className="space-y-4">
                          <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-3 border border-blue-200 dark:border-blue-800">
                            <p className="text-sm text-blue-800 dark:text-blue-200">
                              {t('projectWizard.step2.publicRepoInfo')}
                            </p>
                          </div>

                          <div>
                            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                              {t('projectWizard.step2.optionalTokenPublic')}
                            </label>
                            <Input
                              type="text"
                              value={newGithubToken}
                              onChange={(e) => setNewGithubToken(e.target.value)}
                              placeholder={t('projectWizard.step2.tokenPublicPlaceholder')}
                              autoCapitalize="none"
                              autoCorrect="off"
                              spellCheck={false}
                              className="w-full"
                            />
                            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                              {t('projectWizard.step2.noTokensHelp')}
                            </p>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* Step 3: Confirm */}
          {step === 3 && (
            <div className="space-y-4">
              <div className="bg-gray-50 dark:bg-gray-900/50 rounded-lg p-4 border border-gray-200 dark:border-gray-700">
                <h4 className="text-sm font-semibold text-gray-900 dark:text-white mb-3">
                  {t('projectWizard.step3.reviewConfig')}
                </h4>
                <div className="space-y-2">
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-600 dark:text-gray-400">{t('projectWizard.step3.workspaceType')}</span>
                    <span className="font-medium text-gray-900 dark:text-white">
                      {workspaceType === 'existing' ? t('projectWizard.step3.existingWorkspace') : t('projectWizard.step3.newWorkspace')}
                    </span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-600 dark:text-gray-400">{t('projectWizard.step3.path')}</span>
                    <span className="font-mono text-xs text-gray-900 dark:text-white break-all">
                      {workspacePath}
                    </span>
                  </div>
                  {workspaceType === 'new' && githubUrl && (
                    <>
                      <div className="flex justify-between text-sm">
                        <span className="text-gray-600 dark:text-gray-400">{t('projectWizard.step3.cloneFrom')}</span>
                        <span className="font-mono text-xs text-gray-900 dark:text-white break-all">
                          {githubUrl}
                        </span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="text-gray-600 dark:text-gray-400">{t('projectWizard.step3.authentication')}</span>
                        <span className="text-xs text-gray-900 dark:text-white">
                          {tokenMode === 'stored' && selectedGithubToken
                            ? `${t('projectWizard.step3.usingStoredToken')} ${availableTokens.find(t => t.id.toString() === selectedGithubToken)?.credential_name || 'Unknown'}`
                            : tokenMode === 'new' && newGithubToken
                            ? t('projectWizard.step3.usingProvidedToken')
                            : (githubUrl.startsWith('git@') || githubUrl.startsWith('ssh://'))
                            ? t('projectWizard.step3.sshKey', 'SSH Key')
                            : t('projectWizard.step3.noAuthentication')}
                        </span>
                      </div>
                    </>
                  )}
                </div>
              </div>

              <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-4 border border-blue-200 dark:border-blue-800">
                {isCreating && cloneProgress ? (
                  <div className="space-y-2">
                    <p className="text-sm font-medium text-blue-800 dark:text-blue-200">{t('projectWizard.step3.cloningRepository', 'Cloning repository...')}</p>
                    <code className="block text-xs font-mono text-blue-700 dark:text-blue-300 whitespace-pre-wrap break-all">
                      {cloneProgress}
                    </code>
                  </div>
                ) : (
                  <p className="text-sm text-blue-800 dark:text-blue-200">
                    {workspaceType === 'existing'
                      ? t('projectWizard.step3.existingInfo')
                      : githubUrl
                      ? t('projectWizard.step3.newWithClone')
                      : t('projectWizard.step3.newEmpty')}
                  </p>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between p-6 border-t border-gray-200 dark:border-gray-700">
          <Button
            variant="outline"
            onClick={step === 1 ? onClose : handleBack}
            disabled={isCreating}
          >
            {step === 1 ? (
              t('projectWizard.buttons.cancel')
            ) : (
              <>
                <ChevronLeft className="w-4 h-4 mr-1" />
                {t('projectWizard.buttons.back')}
              </>
            )}
          </Button>

          <Button
            onClick={step === 3 ? handleCreate : handleNext}
            disabled={isCreating || (step === 1 && !workspaceType)}
          >
            {isCreating ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                {githubUrl ? t('projectWizard.buttons.cloning', 'Cloning...') : t('projectWizard.buttons.creating')}
              </>
            ) : step === 3 ? (
              <>
                <Check className="w-4 h-4 mr-1" />
                {t('projectWizard.buttons.createProject')}
              </>
            ) : (
              <>
                {t('projectWizard.buttons.next')}
                <ChevronRight className="w-4 h-4 ml-1" />
              </>
            )}
          </Button>
        </div>
      </div>

      {showWebDirectoryBrowser && (
        <div className="fixed inset-0 z-[70] bg-black/55 flex items-center justify-center p-4">
          <div className="bg-white dark:bg-gray-800 w-full max-w-3xl rounded-lg border border-gray-200 dark:border-gray-700 shadow-2xl">
            <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-700">
              <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                {t('projectWizard.selectDirectory', 'Select Directory')}
              </div>
              <button
                type="button"
                onClick={() => setShowWebDirectoryBrowser(false)}
                className="p-2 rounded hover:bg-gray-100 dark:hover:bg-gray-700"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-4 space-y-4">
              {browserRoots.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {browserRoots.map((root) => (
                    <Button
                      key={root.path}
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => loadBrowserDirectory(root.path)}
                      className="h-8"
                    >
                      <HardDrive className="w-3.5 h-3.5 mr-1.5" />
                      {root.name}
                    </Button>
                  ))}
                </div>
              )}

              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    const parentPath = getParentDirectoryPath(browserPath);
                    if (parentPath) {
                      loadBrowserDirectory(parentPath);
                    }
                  }}
                  disabled={!getParentDirectoryPath(browserPath) || browserLoading}
                >
                  <ArrowUp className="w-3.5 h-3.5 mr-1.5" />
                  {t('common.navigation.up', 'Up')}
                </Button>
                <div className="flex-1 px-3 py-2 rounded-md bg-gray-50 dark:bg-gray-900 text-xs text-gray-700 dark:text-gray-300 border border-gray-200 dark:border-gray-700 break-all">
                  {browserPath || t('projectWizard.loadingPath', 'Loading path...')}
                </div>
              </div>

              {browserError && (
                <div className="text-sm text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-md p-3">
                  {browserError}
                </div>
              )}

              <div className="border border-gray-200 dark:border-gray-700 rounded-md min-h-[260px] max-h-[360px] overflow-y-auto">
                {browserLoading ? (
                  <div className="h-64 flex items-center justify-center text-sm text-gray-500">
                    <Loader2 className="w-4 h-4 animate-spin mr-2" />
                    {t('status.loading', 'Loading...')}
                  </div>
                ) : browserDirectories.length === 0 ? (
                  <div className="h-64 flex items-center justify-center text-sm text-gray-500">
                    {t('projectWizard.noDirectories', 'No subdirectories')}
                  </div>
                ) : (
                  <div className="p-2">
                    {browserDirectories.map((dir) => (
                      <button
                        key={dir.path}
                        type="button"
                        onClick={() => loadBrowserDirectory(dir.path)}
                        className="w-full flex items-center justify-between px-3 py-2 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700 text-left"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <Folder className="w-4 h-4 text-blue-600 flex-shrink-0" />
                          <span className="text-sm text-gray-900 dark:text-gray-100 truncate">{dir.name}</span>
                        </div>
                        <ChevronRight className="w-4 h-4 text-gray-400 flex-shrink-0" />
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="flex justify-end gap-2 p-4 border-t border-gray-200 dark:border-gray-700">
              <Button
                type="button"
                variant="outline"
                onClick={() => setShowWebDirectoryBrowser(false)}
              >
                {t('buttons.cancel', 'Cancel')}
              </Button>
              <Button
                type="button"
                onClick={handleBrowserSelectCurrent}
                disabled={!browserPath}
              >
                {t('projectWizard.selectCurrentFolder', 'Select Current Folder')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ProjectCreationWizard;
