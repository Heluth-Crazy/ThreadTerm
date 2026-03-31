import React, { useCallback, useState, useEffect, useRef } from 'react';
import Shell from '../Shell.jsx';

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

export interface TerminalPaneProps {
  id: string;
  project: any;
  session?: any;
  isActive: boolean;
  onActivate: (id: string) => void;
  label?: string;
  onDropSession?: (paneId: string, sessionData: any) => void;
}

function TerminalPane({ id, project, session, isActive, onActivate, label, onDropSession }: TerminalPaneProps) {
  const [localSession, setLocalSession] = useState(session || null);
  const [localProject, setLocalProject] = useState(project);
  const [isDragOver, setIsDragOver] = useState(false);
  const [droppedSessionKey, setDroppedSessionKey] = useState<string>('');
  const dropZoneRef = useRef<HTMLDivElement>(null);
  const dragDepthRef = useRef(0);

  // 外部 session 变化时同步（只在非拖放模式下）
  useEffect(() => {
    if (!droppedSessionKey) {
      setLocalSession(session || null);
      setLocalProject(project);
    }
  }, [session, project, droppedSessionKey]);

  const handleDisconnect = useCallback(() => {
    setLocalSession(null);
  }, []);

  const handleClick = useCallback(() => {
    onActivate(id);
  }, [id, onActivate]);

  // 处理拖放事件
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
        console.log('[TerminalPane] Dropped session:', sessionData);

        // 创建会话对象
        const droppedSession = {
          id: sessionData.sessionId,
          name: sessionData.sessionName,
          __provider: sessionData.provider,
          __projectName: sessionData.projectName,
        };

        // 创建项目对象（从拖动的会话数据）
        const droppedProject = {
          name: sessionData.projectName,
          displayName: sessionData.projectName,
          path: sessionData.projectPath,
          fullPath: sessionData.projectPath,
        };

        // 更新本地项目和会话
        setLocalProject(droppedProject);
        setLocalSession(droppedSession);
        setDroppedSessionKey(`${sessionData.sessionId}-${Date.now()}`);

        // 激活当前 pane
        onActivate(id);

        // 通知父组件
        if (onDropSession) {
          onDropSession(id, sessionData);
        }
      } catch (err) {
        console.error('[TerminalPane] Failed to parse dropped session:', err);
      }
    }
  }, [id, onActivate, onDropSession]);

  const borderClass = isActive
    ? 'ring-2 ring-blue-500'
    : isDragOver
      ? 'ring-2 ring-green-500 bg-green-500/10'
      : 'ring-1 ring-gray-700 hover:ring-gray-500';

  return (
    <div
      ref={dropZoneRef}
      className={`relative flex flex-col h-full w-full overflow-hidden rounded-md ${borderClass} transition-all duration-150`}
      onFocus={handleClick}
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

      {/* Pane header — click here to activate */}
      <div
        role="button"
        tabIndex={0}
        className={`flex-shrink-0 flex items-center justify-between px-2 py-1 text-xs cursor-pointer ${
          isActive ? 'bg-blue-900/40 text-blue-200' : 'bg-gray-800 text-gray-400'
        }`}
        onClick={handleClick}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleClick(); }}
        aria-label={`激活 ${label || `终端 ${id}`}`}
        aria-pressed={isActive}
      >
        <span className="truncate font-medium">
          {localSession ? localSession.name || '会话' : (localProject?.displayName || localProject?.name || label || `终端 ${id}`)}
        </span>
        <div className="flex items-center gap-1">
          {localSession && (
            <span className="text-[10px] text-gray-500">
              {localSession.__provider === 'codex' ? 'Codex' : 'Claude'}
            </span>
          )}
          <span className={`w-1.5 h-1.5 rounded-full ${isActive ? 'bg-blue-400' : 'bg-gray-600'}`} />
        </div>
      </div>

      {/* Shell content — clicks here go to Shell buttons, not intercepted */}
      <div className="flex-1 min-h-0 w-full">
        <Shell
          key={droppedSessionKey || localSession?.id || 'no-session'}
          selectedProject={localProject}
          selectedSession={localSession}
          initialCommand={null}
          isPlainShell={!localSession}
          onProcessComplete={null}
          autoConnect={true}
          paneId={id}
          onDisconnect={handleDisconnect}
        />
      </div>
    </div>
  );
}

export default React.memo(TerminalPane);
