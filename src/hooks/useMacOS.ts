/**
 * Hook to detect macOS platform in Electron environment
 * Used for applying macOS-specific UI adjustments like title bar padding
 */
import { useState, useEffect } from 'react';

interface MacOSState {
  isMacOS: boolean;
  isElectron: boolean;
}

/**
 * Detect if running in Electron environment
 */
function isElectron(): boolean {
  return typeof window !== 'undefined' && window.electronAPI !== undefined;
}

/**
 * Detect if running on macOS
 */
function isMacOS(): boolean {
  if (!isElectron()) return false;
  return window.electronAPI?.platform?.isMac === true;
}

/**
 * Hook to detect macOS platform
 * @returns Object containing isMacOS and isElectron flags
 */
export function useMacOS(): MacOSState {
  const [state, setState] = useState<MacOSState>({
    isMacOS: false,
    isElectron: false,
  });

  useEffect(() => {
    setState({
      isElectron: isElectron(),
      isMacOS: isMacOS(),
    });
  }, []);

  return state;
}

/**
 * Utility function to get macOS-specific class names
 * @param baseClasses - Base CSS classes
 * @param macOSClasses - Classes to add when on macOS
 * @returns Combined class string
 */
export function getMacOSClasses(baseClasses: string, macOSClasses: string): string {
  if (isMacOS()) {
    return `${baseClasses} ${macOSClasses}`;
  }
  return baseClasses;
}

export default useMacOS;
