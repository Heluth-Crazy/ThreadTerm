import { createContext, useContext } from 'react';
import type { NativeSubagentSummaries, NativeSubagentSummary } from '@threadterm/protocol';

export const NativeSubagentsContext = createContext<NativeSubagentSummaries | undefined>(undefined);
const empty: readonly NativeSubagentSummary[] = [];

export function useNativeSubagents(parentId: string): readonly NativeSubagentSummary[] {
  const summaries = useContext(NativeSubagentsContext);
  return summaries?.[parentId] ?? empty;
}
