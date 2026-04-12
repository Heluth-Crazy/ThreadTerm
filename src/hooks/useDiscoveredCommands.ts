import { useState, useEffect, useCallback, useRef } from 'react';
import {
  commandDiscovery,
  type CommandDiscoveryResult,
  type DiscoveredCommand,
  type DiscoveredSkill,
} from '../lib/tauri-bridge';

interface UseDiscoveredCommandsOptions {
  provider: string;
  projectPath?: string;
}

interface UseDiscoveredCommandsResult {
  discoveredCommands: DiscoveredCommand[];
  discoveredSkills: DiscoveredSkill[];
  isLoading: boolean;
  refresh: () => void;
}

const cache = new Map<string, CommandDiscoveryResult>();

export function useDiscoveredCommands({
  provider,
  projectPath,
}: UseDiscoveredCommandsOptions): UseDiscoveredCommandsResult {
  const cacheKey = `${provider}:${projectPath ?? ''}`;
  const [result, setResult] = useState<CommandDiscoveryResult>(
    () => cache.get(cacheKey) ?? { commands: [], skills: [] },
  );
  const [isLoading, setIsLoading] = useState(!cache.has(cacheKey));
  const mountedRef = useRef(true);

  const fetchCommands = useCallback(async () => {
    const cached = cache.get(cacheKey);
    if (cached) {
      setResult(cached);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    try {
      const data = await commandDiscovery.discover(provider, projectPath);
      cache.set(cacheKey, data);
      if (mountedRef.current) {
        setResult(data);
      }
    } catch (err) {
      console.warn('[useDiscoveredCommands] failed:', err);
    } finally {
      if (mountedRef.current) {
        setIsLoading(false);
      }
    }
  }, [cacheKey, provider, projectPath]);

  useEffect(() => {
    mountedRef.current = true;
    cache.delete(cacheKey);
    fetchCommands();
    return () => {
      mountedRef.current = false;
    };
  }, [cacheKey, fetchCommands]);

  // Re-fetch on window focus (catches newly installed skills/commands)
  useEffect(() => {
    const handleFocus = () => {
      cache.delete(cacheKey);
      fetchCommands();
    };
    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, [cacheKey, fetchCommands]);

  return {
    discoveredCommands: result.commands,
    discoveredSkills: result.skills,
    isLoading,
    refresh: () => {
      cache.delete(cacheKey);
      fetchCommands();
    },
  };
}
