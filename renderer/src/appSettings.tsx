// The live runtime settings, for surfaces outside the Settings dialog (F3 uses
// them for quick messages). App renders the provider with the latest snapshot;
// it is undefined before the first snapshot arrives and in isolated harnesses.
import { createContext, useContext, type ReactNode } from "react";
import type { Settings } from "@threadterm/protocol";

const AppSettingsContext = createContext<Settings | undefined>(undefined);

export function AppSettingsProvider({ settings, children }: { settings?: Settings; children: ReactNode }) {
  return <AppSettingsContext.Provider value={settings}>{children}</AppSettingsContext.Provider>;
}

export function useAppSettings(): Settings | undefined {
  return useContext(AppSettingsContext);
}
