export {};

declare global {
  interface Window {
    __ROUTER_BASENAME__?: string;
    refreshProjects?: () => void | Promise<void>;
    openSettings?: (tab?: string) => void;
    electronAPI?: {
      onBeforeQuit?: (callback: () => void) => void;
      getAppIconDataUrl?: () => Promise<string | null>;
      platform?: {
        isMac: boolean;
        isWindows: boolean;
        isLinux: boolean;
        platform: string;
        arch: string;
        version: string;
      };
    };
  }
}
