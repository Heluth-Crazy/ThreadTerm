import React, { useCallback, useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import Shell from '../Shell.jsx';
import { hasSessionDragData, parseSessionDragData } from './utils/dragDrop';
import { logger } from '../../utils/logger';

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
  const { t } = useTranslation('terminal');
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
        logger.log('[TerminalPane] Dropped session:', sessionData);

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
    ? 'ring-2 ring-primary'
    : isDragOver
      ? 'ring-2 ring-green-500 bg-green-500/10'
      : 'ring-1 ring-border hover:ring-muted-foreground';

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
          <div className="bg-card text-green-400 px-4 py-2 rounded-lg shadow-lg text-sm font-medium">
            {t('dropToOpenSession')}
          </div>
        </div>
      )}

      {/* Pane header — click here to activate */}
      <div
        role="button"
        tabIndex={0}
        className={`flex-shrink-0 flex items-center justify-between px-2 py-1 text-xs cursor-pointer ${
          isActive ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground'
        }`}
        onClick={handleClick}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleClick(); }}
        aria-label={t('activatePane', { label: label || t('terminalId', { id }) })}
        aria-pressed={isActive}
      >
        <span className="truncate font-medium">
          {localSession ? localSession.name || t('session') : (localProject?.displayName || localProject?.name || label || t('terminalId', { id }))}
        </span>
        <div className="flex items-center gap-1">
          {localSession && (
            <span className="text-[10px] text-muted-foreground/60">
              {localSession.__provider === 'codex' ? 'Codex' : 'Claude'}
            </span>
          )}
          <span className={`w-1.5 h-1.5 rounded-full ${isActive ? 'bg-primary' : 'bg-muted-foreground/40'}`} />
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
