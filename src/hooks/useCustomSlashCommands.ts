import { useState, useEffect, useCallback } from 'react';
import { authenticatedFetch } from '../utils/api';
import type { CustomSlashCommand } from '../types/slashCommands';

let cachedCommands: CustomSlashCommand[] = [];
let fetchPromise: Promise<CustomSlashCommand[]> | null = null;

async function fetchCustomCommands(): Promise<CustomSlashCommand[]> {
  try {
    const res = await authenticatedFetch('/api/slash-commands');
    if (res.ok) {
      cachedCommands = await res.json();
    }
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
