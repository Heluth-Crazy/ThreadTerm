import { useEffect, useRef, useState, useCallback } from 'react';
import { useWebSocket } from '../contexts/TauriEventContext';

export interface FileChangeEvent {
  projectPath: string;
  eventType: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir';
  filePath: string;
}

/**
 * Sends 'start-watching' when activeProjectPath changes,
 * 'stop-watching' on unmount or project switch.
 * Listens for 'file-changed' and 'git-status-changed' WS events.
 */
export function useFileWatcher(activeProjectPath: string | null | undefined) {
  const { sendMessage, latestMessage, messageSequence } = useWebSocket();
  const [lastChangeEvent, setLastChangeEvent] = useState<FileChangeEvent | null>(null);
  const [gitStatusTrigger, setGitStatusTrigger] = useState(0);
  const prevPathRef = useRef<string | null>(null);

  // Start / stop watching on project path change
  useEffect(() => {
    const prev = prevPathRef.current;

    if (prev && prev !== activeProjectPath) {
      sendMessage({ type: 'stop-watching', projectPath: prev });
    }

    if (activeProjectPath) {
      sendMessage({ type: 'start-watching', projectPath: activeProjectPath });
      prevPathRef.current = activeProjectPath;
    } else {
      prevPathRef.current = null;
    }

    return () => {
      if (prevPathRef.current) {
        sendMessage({ type: 'stop-watching', projectPath: prevPathRef.current });
      }
    };
  }, [activeProjectPath, sendMessage]);

  // Listen for file-changed and git-status-changed messages
  useEffect(() => {
    if (!latestMessage) return;

    if (latestMessage.type === 'file-changed' && latestMessage.projectPath) {
      setLastChangeEvent({
        projectPath: latestMessage.projectPath,
        eventType: latestMessage.eventType,
        filePath: latestMessage.filePath,
      });
    }

    if (latestMessage.type === 'git-status-changed') {
      setGitStatusTrigger((prev) => prev + 1);
    }
  }, [latestMessage, messageSequence]);

  return { lastChangeEvent, gitStatusTrigger };
}
