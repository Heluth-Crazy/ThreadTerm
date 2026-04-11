import { useState, useEffect, useCallback } from 'react';
import { settings } from '../lib/tauri-bridge';
import type { CustomSlashCommand } from '../types/slashCommands';

let cachedCommands: CustomSlashCommand[] = [];
let fetchPromise: Promise<CustomSlashCommand[]> | null = null;

async function fetchCustomCommands(): Promise<CustomSlashCommand[]> {
  try {
    const allSettings = await settings.getAll();
    const cmds = allSettings?.customSlashCommands;
    cachedCommands = Array.isArray(cmds) ? cmds as CustomSlashCommand[] : [];
  } catch {
    // silently ignore
  }
  return cachedCommands;
}

export function useCustomSlashCommands() {
  const [commands, setCommands] = useState<CustomSlashCommand[]>(cachedCommands);

  const refresh = useCallback(async () => {
    fetchPromise = fetchPromise ?? fetchCustomCommands();
    const result = await fetchPromise;
    fetchPromise = null;
    setCommands(result);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { customCommands: commands, refreshCustomCommands: refresh };
}
