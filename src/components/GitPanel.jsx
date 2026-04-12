import React, { useState, useEffect, useRef } from 'react';
import { GitBranch, GitCommit, Plus, Minus, RefreshCw, Check, X, ChevronDown, ChevronRight, Info, History, FileText, Mic, MicOff, Sparkles, Download, RotateCcw, Trash2, AlertTriangle, Upload } from 'lucide-react';
import { MicButton } from './MicButton.jsx';
import { git as tauriGit } from '../lib/tauri-bridge';
import DiffViewer from './DiffViewer.jsx';
import { useToastStore } from '../stores/toastStore';

function GitPanel({ selectedProject, onFileOpen }) {
  const [gitStatus, setGitStatus] = useState(null);
  const [gitDiff, setGitDiff] = useState({});
  const [isLoading, setIsLoading] = useState(false);
  const [commitMessage, setCommitMessage] = useState('');
  const [expandedFiles, setExpandedFiles] = useState(new Set());
  const [selectedFiles, setSelectedFiles] = useState(new Set());
  const [isCommitting, setIsCommitting] = useState(false);
  const [currentBranch, setCurrentBranch] = useState('');
  const [branches, setBranches] = useState([]);
  const [wrapText, setWrapText] = useState(true);
  const [showLegend, setShowLegend] = useState(false);
  const [showBranchDropdown, setShowBranchDropdown] = useState(false);
  const [showNewBranchModal, setShowNewBranchModal] = useState(false);
  const [newBranchName, setNewBranchName] = useState('');
  const [isCreatingBranch, setIsCreatingBranch] = useState(false);
  const [activeView, setActiveView] = useState('changes'); // 'changes' or 'history'
  const [recentCommits, setRecentCommits] = useState([]);
  const [expandedCommits, setExpandedCommits] = useState(new Set());
  const [commitDiffs, setCommitDiffs] = useState({});
  const [isGeneratingMessage, setIsGeneratingMessage] = useState(false);
  const [remoteStatus, setRemoteStatus] = useState(null);
  const [isFetching, setIsFetching] = useState(false);
  const [isPulling, setIsPulling] = useState(false);
  const [isPushing, setIsPushing] = useState(false);
  const [isPublishing, setIsPublishing] = useState(false);
  const [isCommitAreaCollapsed, setIsCommitAreaCollapsed] = useState(false);
  const isCompactLayout = false;
  const [confirmAction, setConfirmAction] = useState(null); // { type: 'discard|commit|pull|push', file?: string, message?: string }
  const [isCreatingInitialCommit, setIsCreatingInitialCommit] = useState(false);
  const textareaRef = useRef(null);
  const dropdownRef = useRef(null);

  // Get current provider from localStorage (same as ChatInterface does)
  const [provider, setProvider] = useState(() => {
    return localStorage.getItem('selected-provider') || 'claude';
  });

  // Listen for provider changes in localStorage
  useEffect(() => {
    const handleStorageChange = () => {
      const newProvider = localStorage.getItem('selected-provider') || 'claude';
      setProvider(newProvider);
    };

    window.addEventListener('storage', handleStorageChange);
    return () => window.removeEventListener('storage', handleStorageChange);
  }, []);

  useEffect(() => {
    // Clear stale repo-scoped state when project changes.
    setCurrentBranch('');
    setBranches([]);
    setGitStatus(null);
    setRemoteStatus(null);
    setSelectedFiles(new Set());

    if (!selectedProject) {
      return;
    }

    fetchGitStatus();
    fetchBranches();
    fetchRemoteStatus();
  }, [selectedProject]);

  // Auto-refresh git status when files change on disk
  useEffect(() => {
    const handler = () => {
      if (selectedProject) {
        fetchGitStatus();
        fetchRemoteStatus();
      }
    };
    window.addEventListener('openwork:git-status-changed', handler);
    return () => window.removeEventListener('openwork:git-status-changed', handler);
  }, [selectedProject]);

  useEffect(() => {
    if (!selectedProject || activeView !== 'history') {
      return;
    }

    fetchRecentCommits();
  }, [selectedProject, activeView]);

  // Handle click outside dropdown
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setShowBranchDropdown(false);
      }
    };
    
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const fetchGitStatus = async () => {
    if (!selectedProject) return;
    
    
    setIsLoading(true);
    try {
      const projectPath = selectedProject.fullPath || selectedProject.path;
      const data = await tauriGit.status(projectPath);
      
      setGitStatus(data);
      setCurrentBranch(data.branch || 'main');
      
      // Auto-select all changed files
      const allFiles = new Set([
        ...(data.staged || []).map(f => f.path),
        ...(data.unstaged || []).map(f => f.path),
        ...(data.untracked || [])
      ]);
      setSelectedFiles(allFiles);
      
      // Fetch diffs for changed files
      for (const file of (data.staged || []).map(f => f.path)) {
        fetchFileDiff(file, true);
      }
      for (const file of (data.unstaged || []).map(f => f.path)) {
        fetchFileDiff(file, false);
      }
      for (const file of data.untracked || []) {
        fetchFileDiff(file, false);
      }
    } catch (error) {
      console.error('Error fetching git status:', error);
      setGitStatus({ error: 'Git operation failed', details: String(error) });
      setCurrentBranch('');
      setSelectedFiles(new Set());
    } finally {
      setIsLoading(false);
    }
  };

  const fetchBranches = async () => {
    try {
      const projectPath = selectedProject.fullPath || selectedProject.path;
      const data = await tauriGit.branches(projectPath);
      
      if (data.local) {
        setBranches(data.local);
      } else {
        setBranches([]);
      }
    } catch (error) {
      console.error('Error fetching branches:', error);
      setBranches([]);
    }
  };

  const fetchRemoteStatus = async () => {
    if (!selectedProject) return;
    
    try {
      const projectPath = selectedProject.fullPath || selectedProject.path;
      const data = await tauriGit.status(projectPath);
      setRemoteStatus({ ahead: data.ahead, behind: data.behind });
    } catch (error) {
      console.error('Error fetching remote status:', error);
      setRemoteStatus(null);
    }
  };

  const switchBranch = async (branchName) => {
    try {
      const projectPath = selectedProject.fullPath || selectedProject.path;
      await tauriGit.checkoutBranch(projectPath, branchName);
      setCurrentBranch(branchName);
      setShowBranchDropdown(false);
      fetchGitStatus();
    } catch (error) {
      console.error('Error switching branch:', error);
    }
  };

  const createBranch = async () => {
    if (!newBranchName.trim()) return;
    
    setIsCreatingBranch(true);
    try {
      const projectPath = selectedProject.fullPath || selectedProject.path;
      await tauriGit.createBranch(projectPath, newBranchName.trim());
      setCurrentBranch(newBranchName.trim());
      setShowNewBranchModal(false);
      setShowBranchDropdown(false);
      setNewBranchName('');
      fetchBranches();
      fetchGitStatus();
    } catch (error) {
      console.error('Error creating branch:', error);
    } finally {
      setIsCreatingBranch(false);
    }
  };

  const handleFetch = async () => {
    setIsFetching(true);
    try {
      // Tauri backend doesn't have a separate fetch command; use pull as a proxy
      // or just refresh status (git2 doesn't support fetch natively)
      fetchGitStatus();
      fetchRemoteStatus();
    } catch (error) {
      console.error('Error fetching from remote:', error);
    } finally {
      setIsFetching(false);
    }
  };

  const handlePull = async () => {
    setIsPulling(true);
    try {
      const projectPath = selectedProject.fullPath || selectedProject.path;
      await tauriGit.pull(projectPath);
      fetchGitStatus();
      fetchRemoteStatus();
    } catch (error) {
      console.error('Error pulling from remote:', error);
    } finally {
      setIsPulling(false);
    }
  };

  const handlePush = async () => {
    setIsPushing(true);
    try {
      const projectPath = selectedProject.fullPath || selectedProject.path;
      await tauriGit.push(projectPath);
      fetchGitStatus();
      fetchRemoteStatus();
    } catch (error) {
      console.error('Error pushing to remote:', error);
    } finally {
      setIsPushing(false);
    }
  };

  const handlePublish = async () => {
    setIsPublishing(true);
    try {
      const projectPath = selectedProject.fullPath || selectedProject.path;
      // Publish = push with upstream tracking; use push for now
      await tauriGit.push(projectPath);
      fetchGitStatus();
      fetchRemoteStatus();
    } catch (error) {
      console.error('Error publishing branch:', error);
    } finally {
      setIsPublishing(false);
    }
  };

  const discardChanges = async (filePath) => {
    try {
      const projectPath = selectedProject.fullPath || selectedProject.path;
      await tauriGit.discardFile(projectPath, filePath);
      setSelectedFiles(prev => {
        const newSet = new Set(prev);
        newSet.delete(filePath);
        return newSet;
      });
      fetchGitStatus();
    } catch (error) {
      console.error('Error discarding changes:', error);
    }
  };

  const deleteUntrackedFile = async (filePath) => {
    try {
      const projectPath = selectedProject.fullPath || selectedProject.path;
      const fullFilePath = `${projectPath}/${filePath}`;
      const { fs: tauriFs } = await import('../lib/tauri-bridge');
      await tauriFs.deleteFile(fullFilePath);
      setSelectedFiles(prev => {
        const newSet = new Set(prev);
        newSet.delete(filePath);
        return newSet;
      });
      fetchGitStatus();
    } catch (error) {
      console.error('Error deleting untracked file:', error);
    }
  };

  const confirmAndExecute = async () => {
    if (!confirmAction) return;

    const { type, file, message } = confirmAction;
    setConfirmAction(null);

    try {
      switch (type) {
        case 'discard':
          await discardChanges(file);
          break;
        case 'delete':
          await deleteUntrackedFile(file);
          break;
        case 'commit':
          await handleCommit();
          break;
        case 'pull':
          await handlePull();
          break;
        case 'push':
          await handlePush();
          break;
        case 'publish':
          await handlePublish();
          break;
      }
    } catch (error) {
      console.error(`Error executing ${type}:`, error);
    }
  };

  const fetchFileDiff = async (filePath, isStaged = false) => {
    try {
      const projectPath = selectedProject.fullPath || selectedProject.path;
      const diff = isStaged
        ? await tauriGit.stagedDiff(projectPath, filePath)
        : await tauriGit.diff(projectPath, filePath);
      
      if (diff) {
        setGitDiff(prev => ({
          ...prev,
          [filePath]: diff
        }));
      }
    } catch (error) {
      console.error('Error fetching file diff:', error);
    }
  };

  const handleFileOpen = async (filePath) => {
    if (!onFileOpen) return;

    try {
      const projectPath = selectedProject.fullPath || selectedProject.path;
      const diff = await tauriGit.diff(projectPath, filePath);
      const { fs: tauriFs } = await import('../lib/tauri-bridge');
      const currentContent = await tauriFs.readFile(`${projectPath}/${filePath}`);

      const diffInfo = {
        old_string: '',
        new_string: currentContent || ''
      };

      onFileOpen(filePath, diffInfo);
    } catch (error) {
      console.error('Error opening file:', error);
      onFileOpen(filePath);
    }
  };

  const fetchRecentCommits = async () => {
    try {
      const projectPath = selectedProject.fullPath || selectedProject.path;
      const commits = await tauriGit.log(projectPath, 10);
      setRecentCommits(commits);
    } catch (error) {
      console.error('Error fetching commits:', error);
    }
  };

  const fetchCommitDiff = async (commitHash) => {
    try {
      // TODO: Implement commit-specific diff in Tauri backend
      // For now, this is a placeholder
      console.warn('Commit-specific diff not yet implemented in Tauri backend');
    } catch (error) {
      console.error('Error fetching commit diff:', error);
    }
  };

  const generateCommitMessage = async () => {
    setIsGeneratingMessage(true);
    try {
      // TODO: Implement AI-generated commit message in Tauri backend
      // For now, auto-generate a basic message from staged files
      const files = Array.from(selectedFiles);
      const message = files.length > 0
        ? `Update ${files.length} file(s): ${files.slice(0, 3).join(', ')}${files.length > 3 ? '...' : ''}`
        : 'Update files';
      setCommitMessage(message);
    } catch (error) {
      console.error('Error generating commit message:', error);
    } finally {
      setIsGeneratingMessage(false);
    }
  };

  const toggleFileExpanded = (filePath) => {
    setExpandedFiles(prev => {
      const newSet = new Set(prev);
      if (newSet.has(filePath)) {
        newSet.delete(filePath);
      } else {
        newSet.add(filePath);
      }
      return newSet;
    });
  };

  const toggleCommitExpanded = (commitHash) => {
    setExpandedCommits(prev => {
      const newSet = new Set(prev);
      if (newSet.has(commitHash)) {
        newSet.delete(commitHash);
      } else {
        newSet.add(commitHash);
        // Fetch diff for this commit if not already fetched
        if (!commitDiffs[commitHash]) {
          fetchCommitDiff(commitHash);
        }
      }
      return newSet;
    });
  };

  const toggleFileSelected = (filePath) => {
    setSelectedFiles(prev => {
      const newSet = new Set(prev);
      if (newSet.has(filePath)) {
        newSet.delete(filePath);
      } else {
        newSet.add(filePath);
      }
      return newSet;
    });
  };

  const handleCommit = async () => {
    if (!commitMessage.trim() || selectedFiles.size === 0) return;

    setIsCommitting(true);
    try {
      const projectPath = selectedProject.fullPath || selectedProject.path;
      const files = Array.from(selectedFiles);
      
      // Stage selected files first
      await tauriGit.stage(projectPath, files);
      // Commit
      await tauriGit.commit(projectPath, commitMessage);
      
      setCommitMessage('');
      setSelectedFiles(new Set());
      fetchGitStatus();
      fetchRemoteStatus();
      useToastStore.getState().addToast('Committed successfully', 'success');
    } catch (error) {
      console.error('Error committing changes:', error);
      useToastStore.getState().addToast(String(error) || 'Commit failed', 'error');
    } finally {
      setIsCommitting(false);
    }
  };

  const createInitialCommit = async () => {
    setIsCreatingInitialCommit(true);
    try {
      const projectPath = selectedProject.fullPath || selectedProject.path;
      // Stage all files and create initial commit
      await tauriGit.stage(projectPath, ['.']);
      await tauriGit.commit(projectPath, 'Initial commit');
      fetchGitStatus();
      fetchRemoteStatus();
    } catch (error) {
      console.error('Error creating initial commit:', error);
      alert('Failed to create initial commit');
    } finally {
      setIsCreatingInitialCommit(false);
    }
  };

  const getStatusLabel = (status) => {
    switch (status) {
      case 'M': return '已修改';
      case 'A': return '已添加';
      case 'D': return 'Deleted';
      case 'U': return '未跟踪';
      default: return status;
    }
  };

  const renderCommitItem = (commit) => {
    const isExpanded = expandedCommits.has(commit.hash);
    const diff = commitDiffs[commit.hash];

    return (
      <div key={commit.hash} className="border-b border-border last:border-0">
        <div
          className="flex items-start p-3 hover:bg-accent/50 cursor-pointer transition-colors"
          onClick={() => toggleCommitExpanded(commit.hash)}
        >
          <div className="mr-2 mt-1 p-0.5 hover:bg-accent rounded">
            {isExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground truncate">
                  {commit.message}
                </p>
                <p className="text-sm text-muted-foreground mt-1">
                  {commit.author} • {commit.date}
                </p>
              </div>
              <span className="text-sm font-mono text-muted-foreground/60 flex-shrink-0">
                {commit.hash.substring(0, 7)}
              </span>
            </div>
          </div>
        </div>
        {isExpanded && diff && (
          <div className="bg-muted/50">
            <div className="max-h-96 overflow-y-auto p-2">
              <div className="text-sm font-mono text-muted-foreground mb-2">
                {commit.stats}
              </div>
              <DiffViewer diff={diff} fileName="commit" wrapText={wrapText} />
            </div>
          </div>
        )}
      </div>
    );
  };

  const renderFileItem = (filePath, status) => {
    const isExpanded = expandedFiles.has(filePath);
    const isSelected = selectedFiles.has(filePath);
    const diff = gitDiff[filePath];

    return (
      <div key={filePath} className="border-b border-border last:border-0">
        <div className={`flex items-center hover:bg-accent/50 transition-colors ${isCompactLayout ? 'px-2 py-1.5' : 'px-3 py-2'}`}>
          <input
            type="checkbox"
            checked={isSelected}
            onChange={() => toggleFileSelected(filePath)}
            onClick={(e) => e.stopPropagation()}
            className={`rounded border-border text-primary focus:ring-primary/40 bg-background checked:bg-primary ${isCompactLayout ? 'mr-1.5' : 'mr-2'}`}
          />
          <div className="flex items-center flex-1">
            <div
              className={`p-0.5 hover:bg-accent rounded cursor-pointer ${isCompactLayout ? 'mr-1' : 'mr-2'}`}
              onClick={(e) => {
                e.stopPropagation();
                toggleFileExpanded(filePath);
              }}
            >
              <ChevronRight className={`w-3 h-3 transition-transform duration-200 ease-in-out ${isExpanded ? 'rotate-90' : 'rotate-0'}`} />
            </div>
            <span
              className={`flex-1 truncate ${isCompactLayout ? 'text-xs' : 'text-sm'} cursor-pointer hover:text-primary hover:underline`}
              onClick={(e) => {
                e.stopPropagation();
                handleFileOpen(filePath);
              }}
              title="点击打开文件"
            >
              {filePath}
            </span>
            <div className="flex items-center gap-1">
              {(status === 'M' || status === 'D') && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setConfirmAction({
                      type: 'discard',
                      file: filePath,
                      message: `Discard all changes to "${filePath}"? This action cannot be undone.`
                    });
                  }}
                  className={`${isCompactLayout ? 'px-2 py-1 text-xs' : 'p-1'} hover:bg-destructive/10 rounded text-destructive font-medium flex items-center gap-1`}
                  title="丢弃更改"
                >
                  <Trash2 className="w-3 h-3" />
                  {isCompactLayout && <span>丢弃</span>}
                </button>
              )}
              {status === 'U' && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setConfirmAction({
                      type: 'delete',
                      file: filePath,
                      message: `Delete untracked file "${filePath}"? This action cannot be undone.`
                    });
                  }}
                  className={`${isCompactLayout ? 'px-2 py-1 text-xs' : 'p-1'} hover:bg-destructive/10 rounded text-destructive font-medium flex items-center gap-1`}
                  title="删除未跟踪文件"
                >
                  <Trash2 className="w-3 h-3" />
                  {isCompactLayout && <span>删除</span>}
                </button>
              )}
              <span
                className={`inline-flex items-center justify-center w-5 h-5 rounded text-[10px] font-bold border ${
                  status === 'M' ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300 border-yellow-200 dark:border-yellow-800/50' :
                  status === 'A' ? 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300 border-green-200 dark:border-green-800/50' :
                  status === 'D' ? 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300 border-red-200 dark:border-red-800/50' :
                  'bg-muted text-muted-foreground border-border'
                }`}
                title={getStatusLabel(status)}
              >
                {status}
              </span>
            </div>
          </div>
        </div>
        <div className={`bg-muted/50 transition-all duration-400 ease-in-out overflow-hidden ${
          isExpanded && diff
            ? 'max-h-[600px] opacity-100 translate-y-0'
            : 'max-h-0 opacity-0 -translate-y-1'
        }`}>
            {/* Operation header */}
            <div className="flex items-center justify-between p-2 border-b border-border">
              <div className="flex items-center gap-2">
                <span
                  className={`inline-flex items-center justify-center w-5 h-5 rounded text-[10px] font-bold border ${
                    status === 'M' ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300 border-yellow-200 dark:border-yellow-800/50' :
                    status === 'A' ? 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300 border-green-200 dark:border-green-800/50' :
                    status === 'D' ? 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300 border-red-200 dark:border-red-800/50' :
                    'bg-muted text-muted-foreground border-border'
                  }`}
                >
                  {status}
                </span>
                <span className="text-sm font-medium text-foreground">
                  {getStatusLabel(status)}
                </span>
              </div>
              {isCompactLayout && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setWrapText(!wrapText);
                  }}
                  className="text-sm text-muted-foreground hover:text-foreground transition-colors"
                  title={wrapText ? "Switch to horizontal scroll" : "Switch to text wrap"}
                >
                  {wrapText ? '↔️ Scroll' : '↩️ Wrap'}
                </button>
              )}
            </div>
            <div className="max-h-96 overflow-y-auto">
              {diff && <DiffViewer diff={diff} fileName={filePath} wrapText={wrapText} />}
            </div>
        </div>
      </div>
    );
  };

  if (!selectedProject) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground">
        <p>Select a project to view source control</p>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-background">
      {/* Header */}
      <div className={`flex items-center justify-between border-b border-border/60 ${isCompactLayout ? 'px-3 py-2' : 'px-4 py-3'}`}>
        <div className="relative" ref={dropdownRef}>
          <button
            onClick={() => setShowBranchDropdown(!showBranchDropdown)}
            className={`flex items-center hover:bg-accent rounded-lg transition-colors ${isCompactLayout ? 'space-x-1 px-2 py-1' : 'space-x-2 px-3 py-1.5'}`}
          >
            <GitBranch className={`text-muted-foreground ${isCompactLayout ? 'w-3 h-3' : 'w-4 h-4'}`} />
            <div className="flex items-center gap-1">
              <span className={`font-medium ${isCompactLayout ? 'text-xs' : 'text-sm'}`}>{currentBranch}</span>
              {/* Remote status indicators */}
              {remoteStatus?.hasRemote && (
                <div className="flex items-center gap-1 text-xs">
                  {remoteStatus.ahead > 0 && (
                    <span className="text-green-600 dark:text-green-400" title={`${remoteStatus.ahead} commit${remoteStatus.ahead !== 1 ? 's' : ''} ahead`}>
                      ↑{remoteStatus.ahead}
                    </span>
                  )}
                  {remoteStatus.behind > 0 && (
                    <span className="text-primary" title={`${remoteStatus.behind} commit${remoteStatus.behind !== 1 ? 's' : ''} behind`}>
                      ↓{remoteStatus.behind}
                    </span>
                  )}
                  {remoteStatus.isUpToDate && (
                    <span className="text-muted-foreground" title="与远程同步">
                      ✓
                    </span>
                  )}
                </div>
              )}
            </div>
            <ChevronDown className={`w-3 h-3 text-muted-foreground transition-transform ${showBranchDropdown ? 'rotate-180' : ''}`} />
          </button>

          {/* Branch Dropdown */}
          {showBranchDropdown && (
            <div className="absolute top-full left-0 mt-1 w-64 bg-card rounded-xl shadow-lg border border-border z-50 overflow-hidden">
              <div className="py-1 max-h-64 overflow-y-auto">
                {branches.map(branch => (
                  <button
                    key={branch}
                    onClick={() => switchBranch(branch)}
                    className={`w-full text-left px-4 py-2 text-sm hover:bg-accent transition-colors ${
                      branch === currentBranch ? 'bg-accent/50 text-foreground' : 'text-muted-foreground'
                    }`}
                  >
                    <div className="flex items-center space-x-2">
                      {branch === currentBranch && <Check className="w-3 h-3 text-primary" />}
                      <span className={branch === currentBranch ? 'font-medium' : ''}>{branch}</span>
                    </div>
                  </button>
                ))}
              </div>
              <div className="border-t border-border py-1">
                <button
                  onClick={() => {
                    setShowNewBranchModal(true);
                    setShowBranchDropdown(false);
                  }}
                  className="w-full text-left px-4 py-2 text-sm hover:bg-accent transition-colors flex items-center space-x-2"
                >
                  <Plus className="w-3 h-3" />
                  <span>Create new branch</span>
                </button>
              </div>
            </div>
          )}
        </div>
        
        <div className={`flex items-center ${isCompactLayout ? 'gap-1' : 'gap-2'}`}>
          {/* Remote action buttons - smart logic based on ahead/behind status */}
          {remoteStatus?.hasRemote && (
            <>
              {/* Publish button - show when branch doesn't exist on remote */}
              {!remoteStatus?.hasUpstream && (
                <button
                  onClick={() => setConfirmAction({
                    type: 'publish',
                    message: `Publish branch "${currentBranch}" to ${remoteStatus.remoteName}?`
                  })}
                  disabled={isPublishing}
                  className="px-2.5 py-1 text-sm bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:opacity-50 flex items-center gap-1 transition-colors"
                  title={`Publish branch "${currentBranch}" to ${remoteStatus.remoteName}`}
                >
                  <Upload className={`w-3 h-3 ${isPublishing ? 'animate-pulse' : ''}`} />
                  <span>{isPublishing ? '发布中...' : '发布'}</span>
                </button>
              )}
              
              {/* Show normal push/pull buttons only if branch has upstream */}
              {remoteStatus?.hasUpstream && !remoteStatus?.isUpToDate && (
                <>
                  {/* Pull button - show when behind (primary action) */}
                  {remoteStatus.behind > 0 && (
                    <button
                      onClick={() => setConfirmAction({
                        type: 'pull',
                        message: `Pull ${remoteStatus.behind} commit${remoteStatus.behind !== 1 ? 's' : ''} from ${remoteStatus.remoteName}?`
                      })}
                      disabled={isPulling}
                      className="px-2.5 py-1 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 flex items-center gap-1 transition-colors"
                      title={`Pull ${remoteStatus.behind} commit${remoteStatus.behind !== 1 ? 's' : ''} from ${remoteStatus.remoteName}`}
                    >
                      <Download className={`w-3 h-3 ${isPulling ? 'animate-pulse' : ''}`} />
                      <span>{isPulling ? '拉取中...' : `拉取 ${remoteStatus.behind}`}</span>
                    </button>
                  )}

                  {/* Push button - show when ahead (primary action when ahead only) */}
                  {remoteStatus.ahead > 0 && (
                    <button
                      onClick={() => setConfirmAction({
                        type: 'push',
                        message: `Push ${remoteStatus.ahead} commit${remoteStatus.ahead !== 1 ? 's' : ''} to ${remoteStatus.remoteName}?`
                      })}
                      disabled={isPushing}
                      className="px-2.5 py-1 text-sm bg-orange-600 text-white rounded-lg hover:bg-orange-700 disabled:opacity-50 flex items-center gap-1 transition-colors"
                      title={`Push ${remoteStatus.ahead} commit${remoteStatus.ahead !== 1 ? 's' : ''} to ${remoteStatus.remoteName}`}
                    >
                      <Upload className={`w-3 h-3 ${isPushing ? 'animate-pulse' : ''}`} />
                      <span>{isPushing ? '推送中...' : `推送 ${remoteStatus.ahead}`}</span>
                    </button>
                  )}

                  {/* Fetch button - show when ahead only or when diverged (secondary action) */}
                  {(remoteStatus.ahead > 0 || (remoteStatus.behind > 0 && remoteStatus.ahead > 0)) && (
                    <button
                      onClick={handleFetch}
                      disabled={isFetching}
                      className="px-2.5 py-1 text-sm bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50 flex items-center gap-1 transition-colors"
                      title={`Fetch from ${remoteStatus.remoteName}`}
                    >
                      <RefreshCw className={`w-3 h-3 ${isFetching ? 'animate-spin' : ''}`} />
                      <span>{isFetching ? 'Fetching...' : 'Fetch'}</span>
                    </button>
                  )}
                </>
              )}
            </>
          )}
          
          <button
            onClick={() => {
              fetchGitStatus();
              fetchBranches();
              fetchRemoteStatus();
            }}
            disabled={isLoading}
            className={`hover:bg-accent rounded-lg transition-colors ${isCompactLayout ? 'p-1' : 'p-1.5'}`}
          >
            <RefreshCw className={`text-muted-foreground ${isLoading ? 'animate-spin' : ''} ${isCompactLayout ? 'w-3 h-3' : 'w-4 h-4'}`} />
          </button>
        </div>
      </div>

      {/* Git Repository Not Found Message */}
      {gitStatus?.error ? (
        <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground px-6 py-12">
          <div className="w-16 h-16 rounded-2xl bg-muted/50 flex items-center justify-center mb-6">
            <GitBranch className="w-8 h-8 opacity-40" />
          </div>
          <h3 className="text-lg font-medium mb-3 text-center text-foreground">{gitStatus.error}</h3>
          {gitStatus.details && (
            <p className="text-sm text-center leading-relaxed mb-6 max-w-md">{gitStatus.details}</p>
          )}
          <div className="p-4 bg-primary/5 rounded-xl border border-primary/10 max-w-md">
            <p className="text-sm text-primary text-center">
              <strong>Tip:</strong> Run <code className="bg-primary/10 px-2 py-1 rounded-md font-mono text-xs">git init</code> in your project directory to initialize git source control.
            </p>
          </div>
        </div>
      ) : (
        <>
          {/* Tab Navigation - Only show when git is available and no files expanded */}
          <div className={`flex border-b border-border/60 transition-all duration-300 ease-in-out ${
            expandedFiles.size === 0
              ? 'max-h-16 opacity-100 translate-y-0'
              : 'max-h-0 opacity-0 -translate-y-2 overflow-hidden'
          }`}>
            <button
              onClick={() => setActiveView('changes')}
              className={`flex-1 px-4 py-2 text-sm font-medium transition-colors ${
                activeView === 'changes'
                  ? 'text-primary border-b-2 border-primary'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <div className="flex items-center justify-center gap-2">
                <FileText className="w-4 h-4" />
                <span>变更</span>
              </div>
            </button>
            <button
              onClick={() => setActiveView('history')}
              className={`flex-1 px-4 py-2 text-sm font-medium transition-colors ${
                activeView === 'history'
                  ? 'text-primary border-b-2 border-primary'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <div className="flex items-center justify-center gap-2">
                <History className="w-4 h-4" />
                <span>历史</span>
              </div>
            </button>
          </div>

          {/* Changes View */}
          {activeView === 'changes' && (
            <>
              {/* Desktop commit composer - Hide when files expanded */}
              <div className={`transition-all duration-300 ease-in-out ${
                expandedFiles.size === 0 
                  ? 'max-h-96 opacity-100 translate-y-0' 
                  : 'max-h-0 opacity-0 -translate-y-2 overflow-hidden'
              }`}>
                {isCompactLayout && isCommitAreaCollapsed ? (
                  <div className="px-4 py-2 border-b border-border/60">
                      <button
                        onClick={() => setIsCommitAreaCollapsed(false)}
                        className="w-full flex items-center justify-center gap-2 px-3 py-2 text-sm bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors"
                      >
                        <GitCommit className="w-4 h-4" />
                        <span>提交 {selectedFiles.size} 个文件</span>
                        <ChevronDown className="w-3 h-3" />
                      </button>
                    </div>
                  ) : (
                <>
                  {/* Commit Message Input */}
                  <div className="px-4 py-3 border-b border-border/60">
                    {/* Compact layout collapse button */}
                    {isCompactLayout && (
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-sm font-medium text-foreground">提交变更</span>
                        <button
                          onClick={() => setIsCommitAreaCollapsed(true)}
                          className="p-1 hover:bg-accent rounded-lg transition-colors"
                        >
                          <ChevronDown className="w-4 h-4 rotate-180" />
                        </button>
                      </div>
                    )}

                    <div className="relative">
                      <textarea
                        ref={textareaRef}
                        value={commitMessage}
                        onChange={(e) => setCommitMessage(e.target.value)}
                        placeholder="Message (Ctrl+Enter to commit)"
                        className="w-full px-3 py-2 text-sm border border-border rounded-xl bg-background text-foreground placeholder:text-muted-foreground resize-none pr-20 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/30"
                        rows="3"
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                            handleCommit();
                          }
                        }}
                      />
                      <div className="absolute right-2 top-2 flex gap-1">
                        <button
                          onClick={generateCommitMessage}
                          disabled={selectedFiles.size === 0 || isGeneratingMessage}
                          className="p-1.5 text-muted-foreground hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                          title="生成提交信息"
                        >
                          {isGeneratingMessage ? (
                            <RefreshCw className="w-4 h-4 animate-spin" />
                          ) : (
                            <Sparkles className="w-4 h-4" />
                          )}
                        </button>
                        <div style={{ display: 'none' }}>
                          <MicButton
                            onTranscript={(transcript) => setCommitMessage(transcript)}
                            mode="default"
                            className="p-1.5"
                          />
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center justify-between mt-2">
                      <span className="text-sm text-muted-foreground">
                        {selectedFiles.size} file{selectedFiles.size !== 1 ? 's' : ''} selected
                      </span>
                      <button
                        onClick={() => setConfirmAction({
                          type: 'commit',
                          message: `Commit ${selectedFiles.size} file${selectedFiles.size !== 1 ? 's' : ''} with message: "${commitMessage.trim()}"?`
                        })}
                        disabled={!commitMessage.trim() || selectedFiles.size === 0 || isCommitting}
                        className="px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed flex items-center space-x-1 transition-colors"
                      >
                        <Check className="w-3 h-3" />
                        <span>{isCommitting ? '提交中...' : '提交'}</span>
                      </button>
                    </div>
                  </div>
                  </>
                  )}
              </div>
            </>
          )}

          {/* File Selection Controls - Only show in changes view and when git is working and no files expanded */}
          {activeView === 'changes' && gitStatus && !gitStatus.error && (
            <div className={`border-b border-border/60 flex items-center justify-between transition-all duration-300 ease-in-out ${isCompactLayout ? 'px-3 py-1.5' : 'px-4 py-2'} ${
              expandedFiles.size === 0
                ? 'max-h-16 opacity-100 translate-y-0'
                : 'max-h-0 opacity-0 -translate-y-2 overflow-hidden'
            }`}>
              <span className="text-sm text-muted-foreground">
                {selectedFiles.size} of {(gitStatus?.modified?.length || 0) + (gitStatus?.added?.length || 0) + (gitStatus?.deleted?.length || 0) + (gitStatus?.untracked?.length || 0)} {isCompactLayout ? '' : 'files'} selected
              </span>
              <div className={`flex ${isCompactLayout ? 'gap-1' : 'gap-2'}`}>
                <button
                  onClick={() => {
                    const allFiles = new Set([
                      ...(gitStatus?.modified || []),
                      ...(gitStatus?.added || []),
                      ...(gitStatus?.deleted || []),
                      ...(gitStatus?.untracked || [])
                    ]);
                    setSelectedFiles(allFiles);
                  }}
                  className="text-sm text-primary hover:text-primary/80 transition-colors"
                >
                  {isCompactLayout ? 'All' : 'Select All'}
                </button>
                <span className="text-border">|</span>
                <button
                  onClick={() => setSelectedFiles(new Set())}
                  className="text-sm text-primary hover:text-primary/80 transition-colors"
                >
                  {isCompactLayout ? 'None' : 'Deselect All'}
                </button>
              </div>
            </div>
          )}

          {/* Status Legend Toggle - Available in expanded layout */}
          {!gitStatus?.error && !isCompactLayout && (
            <div className="border-b border-border/60">
              <button
                onClick={() => setShowLegend(!showLegend)}
                className="w-full px-4 py-2 bg-muted/30 hover:bg-muted/50 text-sm text-muted-foreground flex items-center justify-center gap-1 transition-colors"
              >
                <Info className="w-3 h-3" />
                <span>File Status Guide</span>
                {showLegend ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
              </button>

              {showLegend && (
                <div className="px-4 py-3 bg-muted/30 text-sm">
                  <div className={`${isCompactLayout ? 'grid grid-cols-2 gap-3 justify-items-center' : 'flex justify-center gap-6'}`}>
                    <div className="flex items-center gap-2">
                      <span className="inline-flex items-center justify-center w-5 h-5 bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300 rounded border border-yellow-200 dark:border-yellow-800/50 font-bold text-[10px]">
                        M
                      </span>
                      <span className="text-muted-foreground italic">已修改</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="inline-flex items-center justify-center w-5 h-5 bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300 rounded border border-green-200 dark:border-green-800/50 font-bold text-[10px]">
                        A
                      </span>
                      <span className="text-muted-foreground italic">已添加</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="inline-flex items-center justify-center w-5 h-5 bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300 rounded border border-red-200 dark:border-red-800/50 font-bold text-[10px]">
                        D
                      </span>
                      <span className="text-muted-foreground italic">Deleted</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="inline-flex items-center justify-center w-5 h-5 bg-muted text-muted-foreground rounded border border-border font-bold text-[10px]">
                        U
                      </span>
                      <span className="text-muted-foreground italic">未跟踪</span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* File List - Changes View - Only show when git is available */}
      {activeView === 'changes' && !gitStatus?.error && (
        <div className={`flex-1 overflow-y-auto ${isCompactLayout ? '' : ''}`}>
          {isLoading ? (
            <div className="flex items-center justify-center h-32">
              <RefreshCw className="w-5 h-5 animate-spin text-muted-foreground" />
            </div>
          ) : gitStatus?.hasCommits === false ? (
            <div className="flex flex-col items-center justify-center p-8 text-center">
              <div className="w-14 h-14 rounded-2xl bg-muted/50 flex items-center justify-center mb-4">
                <GitBranch className="w-7 h-7 text-muted-foreground/50" />
              </div>
              <h3 className="text-lg font-medium mb-2 text-foreground">暂无提交记录</h3>
              <p className="text-sm text-muted-foreground mb-6 max-w-md">
                This repository doesn't have any commits yet. Create your first commit to start tracking changes.
              </p>
              <button
                onClick={createInitialCommit}
                disabled={isCreatingInitialCommit}
                className="px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 transition-colors"
              >
                {isCreatingInitialCommit ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    <span>创建初始提交中...</span>
                  </>
                ) : (
                  <>
                    <GitCommit className="w-4 h-4" />
                    <span>创建初始提交</span>
                  </>
                )}
              </button>
            </div>
          ) : !gitStatus || (!gitStatus.modified?.length && !gitStatus.added?.length && !gitStatus.deleted?.length && !gitStatus.untracked?.length) ? (
            <div className="flex flex-col items-center justify-center h-32 text-muted-foreground">
              <GitCommit className="w-10 h-10 mb-2 opacity-40" />
              <p className="text-sm">No changes detected</p>
            </div>
          ) : (
            <div className={isCompactLayout ? 'pb-4' : ''}>
              {gitStatus.modified?.map(file => renderFileItem(file, 'M'))}
              {gitStatus.added?.map(file => renderFileItem(file, 'A'))}
              {gitStatus.deleted?.map(file => renderFileItem(file, 'D'))}
              {gitStatus.untracked?.map(file => renderFileItem(file, 'U'))}
            </div>
          )}
        </div>
      )}

      {/* History View - Only show when git is available */}
      {activeView === 'history' && !gitStatus?.error && (
        <div className={`flex-1 overflow-y-auto ${isCompactLayout ? '' : ''}`}>
          {isLoading ? (
            <div className="flex items-center justify-center h-32">
              <RefreshCw className="w-5 h-5 animate-spin text-muted-foreground" />
            </div>
          ) : recentCommits.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-32 text-muted-foreground">
              <History className="w-10 h-10 mb-2 opacity-40" />
              <p className="text-sm">未找到提交记录</p>
            </div>
          ) : (
            <div className={isCompactLayout ? 'pb-4' : ''}>
              {recentCommits.map(commit => renderCommitItem(commit))}
            </div>
          )}
        </div>
      )}

      {/* New Branch Modal */}
      {showNewBranchModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setShowNewBranchModal(false)} />
          <div className="relative bg-card border border-border rounded-xl shadow-2xl max-w-md w-full overflow-hidden">
            <div className="p-6">
              <h3 className="text-lg font-semibold text-foreground mb-4">Create New Branch</h3>
              <div className="mb-4">
                <label className="block text-sm font-medium text-foreground/80 mb-2">
                  Branch Name
                </label>
                <input
                  type="text"
                  value={newBranchName}
                  onChange={(e) => setNewBranchName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !isCreatingBranch) {
                      createBranch();
                    }
                  }}
                  placeholder="feature/new-feature"
                  className="w-full px-3 py-2 border border-border rounded-xl bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/30"
                  autoFocus
                />
              </div>
              <div className="text-sm text-muted-foreground mb-4">
                This will create a new branch from the current branch ({currentBranch})
              </div>
              <div className="flex justify-end space-x-3">
                <button
                  onClick={() => {
                    setShowNewBranchModal(false);
                    setNewBranchName('');
                  }}
                  className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-accent rounded-lg transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={createBranch}
                  disabled={!newBranchName.trim() || isCreatingBranch}
                  className="px-4 py-2 text-sm bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed flex items-center space-x-2 transition-colors"
                >
                  {isCreatingBranch ? (
                    <>
                      <RefreshCw className="w-3 h-3 animate-spin" />
                      <span>Creating...</span>
                    </>
                  ) : (
                    <>
                      <Plus className="w-3 h-3" />
                      <span>Create Branch</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Confirmation Modal */}
      {confirmAction && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setConfirmAction(null)} />
          <div className="relative bg-card border border-border rounded-xl shadow-2xl max-w-md w-full overflow-hidden">
            <div className="p-6">
              <div className="flex items-center mb-4">
                <div className={`p-2 rounded-full mr-3 ${
                  (confirmAction.type === 'discard' || confirmAction.type === 'delete') ? 'bg-red-100 dark:bg-red-900/30' : 'bg-yellow-100 dark:bg-yellow-900/30'
                }`}>
                  <AlertTriangle className={`w-5 h-5 ${
                    (confirmAction.type === 'discard' || confirmAction.type === 'delete') ? 'text-red-600 dark:text-red-400' : 'text-yellow-600 dark:text-yellow-400'
                  }`} />
                </div>
                <h3 className="text-lg font-semibold text-foreground">
                  {confirmAction.type === 'discard' ? 'Discard Changes' :
                   confirmAction.type === 'delete' ? 'Delete File' :
                   confirmAction.type === 'commit' ? 'Confirm Commit' :
                   confirmAction.type === 'pull' ? 'Confirm Pull' :
                   confirmAction.type === 'publish' ? 'Publish Branch' : 'Confirm Push'}
                </h3>
              </div>

              <p className="text-sm text-muted-foreground mb-6">
                {confirmAction.message}
              </p>

              <div className="flex justify-end space-x-3">
                <button
                  onClick={() => setConfirmAction(null)}
                  className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-accent rounded-lg transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={confirmAndExecute}
                  className={`px-4 py-2 text-sm text-white rounded-lg transition-colors ${
                    (confirmAction.type === 'discard' || confirmAction.type === 'delete')
                      ? 'bg-red-600 hover:bg-red-700'
                      : confirmAction.type === 'commit'
                      ? 'bg-primary hover:bg-primary/90'
                      : confirmAction.type === 'pull'
                      ? 'bg-green-600 hover:bg-green-700'
                      : confirmAction.type === 'publish'
                      ? 'bg-purple-600 hover:bg-purple-700'
                      : 'bg-orange-600 hover:bg-orange-700'
                  } flex items-center space-x-2`}
                >
                  {confirmAction.type === 'discard' ? (
                    <>
                      <Trash2 className="w-4 h-4" />
                      <span>丢弃</span>
                    </>
                  ) : confirmAction.type === 'delete' ? (
                    <>
                      <Trash2 className="w-4 h-4" />
                      <span>删除</span>
                    </>
                  ) : confirmAction.type === 'commit' ? (
                    <>
                      <Check className="w-4 h-4" />
                      <span>提交</span>
                    </>
                  ) : confirmAction.type === 'pull' ? (
                    <>
                      <Download className="w-4 h-4" />
                      <span>拉取</span>
                    </>
                  ) : confirmAction.type === 'publish' ? (
                    <>
                      <Upload className="w-4 h-4" />
                      <span>发布</span>
                    </>
                  ) : (
                    <>
                      <Upload className="w-4 h-4" />
                      <span>推送</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default GitPanel;
