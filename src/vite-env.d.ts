/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_THREADTERM_CHANNEL?: string;
  readonly VITE_THREADTERM_PLATFORM_MATERIAL?: string;
  /** Set to "0"/"false" to restore the legacy 6 mounted terminal views cap. */
  readonly VITE_THREADTERM_TERMINAL_SURFACE_POOL?: string;
}
