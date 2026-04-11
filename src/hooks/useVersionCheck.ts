import { useState, useEffect } from 'react';
import { version } from '../../package.json';
import { invoke } from '../lib/tauri-bridge';
import { ReleaseInfo } from '../types/sharedTypes';

export type InstallMode = 'git' | 'npm';

export const useVersionCheck = (_owner?: string, _repo?: string) => {
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [latestVersion, setLatestVersion] = useState<string | null>(null);
  const [releaseInfo, setReleaseInfo] = useState<ReleaseInfo | null>(null);
  const [installMode, setInstallMode] = useState<InstallMode>('git');

  useEffect(() => {
    const fetchInstallMode = async () => {
      try {
        const data = await invoke<{ status: string; version: string; backend: string; installMode?: string }>('health_check');
        if (data.installMode === 'npm' || data.installMode === 'git') {
          setInstallMode(data.installMode);
        }
      } catch {
        // Default to git on error
      }
    };
    fetchInstallMode();
  }, []);

  useEffect(() => {
    // Version polling is intentionally disabled in this build.
    setUpdateAvailable(false);
    setLatestVersion(null);
    setReleaseInfo(null);
  }, []);

  return { updateAvailable, latestVersion, currentVersion: version, releaseInfo, installMode };
};
