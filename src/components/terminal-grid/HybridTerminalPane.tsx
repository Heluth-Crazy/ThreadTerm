import React, { useCallback, useState, useRef, useEffect } from 'react';
import Shell from '../Shell.jsx';
import type { Project } from '../../types/app';

const SESSION_DRAG_FORMATS = ['text/x-openwork-session', 'application/json'];

const hasSessionDragData = (dataTransfer: DataTransfer): boolean => {
  const types = Array.from(dataTransfer.types || []);
  return SESSION_DRAG_FORMATS.some((format) => types.includes(format));
};

const parseSessionDragData = (dataTransfer: DataTransfer): any | null => {
  for (const format of SESSION_DRAG_FORMATS) {
    const raw = dataTransfer.getData(format);
    if (!raw) {
      continue;
    }

    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.sessionId === 'string') {
        return parsed;
      }
    } catch {
      // Ignore invalid payload and continue with other MIME types.
    }
  }

  return null;
};

export interface HybridTerminalPaneProps {
  id: string;
  projects: Project[];
  isActive: boolean;
  onActivate: (id: string) => void;
}

function HybridTerminalPane({ id, projects, isActive, onActivate }: HybridTerminalPaneProps) {
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [selectedSession, setSelectedSession] = useState<any>(null);
  const [isPlainShell, setIsPlainShell] = useState(true);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const dropZoneRef = useRef<HTMLDivElement>(null);
  const dragDepthRef = useRef(0);

  const handleActivate = useCallback(() => {
    onActivate(id);
  }, [id, onActivate]);

  const handleDisconnect = useCallback(() => {
    setSelectedSession(null);
    setIsPlainShell(true);
  }, []);

  // Close dropdown on outside click
  useEffect(() => {
    if (!dropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [dropdownOpen]);

  const handleSelectProject = useCallback((project: Project | null) => {
    setSelectedProject(project);
    setSelectedSession(null);
    setIsPlainShell(true);
    setDropdownOpen(false);
  }, []);

  // Handle drag and drop
  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    if (!hasSessionDragData(e.dataTransfer)) {
      return;
    }
    dragDepthRef.current += 1;
    setIsDragOver(true);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    if (!hasSessionDragData(e.dataTransfer)) {
      e.dataTransfer.dropEffect = 'none';
      setIsDragOver(false);
      return;
    }
    e.dataTransfer.dropEffect = 'copy';
    if (!isDragOver) {
      setIsDragOver(true);
    }
  }, [isDragOver]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setIsDragOver(false);
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragDepthRef.current = 0;
    setIsDragOver(false);

    const sessionData = parseSessionDragData(e.dataTransfer);
    if (sessionData) {
      try {
        console.log('[HybridTerminalPane] Dropped session:', sessionData);

        // Find the project
        const project = projects.find(p => p.name === sessionData.projectName);
        if (project) {
          setSelectedProject(project);
          setSelectedSession({
            id: sessionData.sessionId,
            name: sessionData.sessionName,
            __provider: sessionData.provider,
            __projectName: sessionData.projectName,
          });
          setIsPlainShell(false);
          onActivate(id);
        } else {
          console.error('[HybridTerminalPane] Project not found:', sessionData.projectName);
        }
      } catch (err) {
        console.error('[HybridTerminalPane] Failed to parse dropped session:', err);
      }
    }
  }, [projects, id, onActivate]);

  const borderClass = isActive
    ? 'ring-2 ring-blue-500'
    : isDragOver
      ? 'ring-2 ring-green-500 bg-green-500/10'
      : 'ring-1 ring-gray-700 hover:ring-gray-500';

  const label = selectedSession
    ? (selectedSession.name || '会话')
    : selectedProject
      ? (selectedProject.displayName || selectedProject.name)
      : `Terminal ${id}`;

  return (
    <div
      ref={dropZoneRef}
      className={`relative flex flex-col h-full w-full overflow-hidden rounded-md ${borderClass} transition-all duration-150`}
      onFocus={handleActivate}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Drag overlay - shown when dragging over */}
      {isDragOver && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-green-500/20 backdrop-blur-sm pointer-events-none">
          <div className="bg-gray-800 text-green-400 px-4 py-2 rounded-lg shadow-lg text-sm font-medium">
            释放以在此终端打开会话
          </div>
        </div>
      )}

      {/* Header with project selector */}
      <div
        className={`flex-shrink-0 flex items-center justify-between px-2 py-1 text-xs cursor-pointer ${
          isActive ? 'bg-blue-900/40 text-blue-200' : 'bg-gray-800 text-gray-400'
        }`}
        onClick={handleActivate}
      >
        <span className="truncate font-medium">{label}</span>

        {/* Project selector dropdown */}
        <div className="relative" ref={dropdownRef}>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setDropdownOpen(!dropdownOpen); }}
            className="ml-2 px-1.5 py-0.5 rounded text-[10px] bg-gray-700 hover:bg-gray-600 text-gray-200"
            title="选择项目"
          >
            {selectedProject ? '切换' : '选择项目'} ▾
          </button>

          {dropdownOpen && (
            <div className="absolute right-0 top-full mt-1 z-50 w-48 bg-gray-800 border border-gray-600 rounded-md shadow-lg py-1 max-h-60 overflow-y-auto">
              {/* Pure terminal option */}
              <button
                type="button"
                onClick={() => handleSelectProject(null)}
                className={`w-full text-left px-3 py-1.5 text-xs hover:bg-gray-700 ${
                  !selectedProject ? 'text-blue-300 font-medium' : 'text-gray-300'
                }`}
              >
                纯终端 (无项目)
              </button>
              <div className="border-t border-gray-700 my-1" />
              {projects.map((p) => (
                <button
                  key={p.name}
                  type="button"
                  onClick={() => handleSelectProject(p)}
                  className={`w-full text-left px-3 py-1.5 text-xs hover:bg-gray-700 truncate ${
                    selectedProject?.name === p.name ? 'text-blue-300 font-medium' : 'text-gray-300'
                  }`}
                >
                  {p.displayName || p.name}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center gap-1">
          {selectedSession && (
            <span className="text-[10px] text-gray-500">
              {selectedSession.__provider === 'codex' ? 'Codex' : 'Claude'}
            </span>
          )}
          <span className={`w-1.5 h-1.5 rounded-full ${isActive ? 'bg-blue-400' : 'bg-gray-600'}`} />
        </div>
      </div>

      {/* Shell content */}
      <div className="flex-1 min-h-0 w-full">
        <Shell
          key={`${selectedProject?.name || '__pure_terminal__'}-${selectedSession?.id || 'no-session'}`}
          selectedProject={selectedProject || { name: 'home', displayName: '~', path: '', fullPath: '' }}
          selectedSession={selectedSession}
          initialCommand={null}
          isPlainShell={isPlainShell}
          onProcessComplete={null}
          autoConnect={true}
          paneId={`hybrid-${id}`}
          onDisconnect={handleDisconnect}
        />
      </div>
    </div>
  );
}

export default React.memo(HybridTerminalPane);
