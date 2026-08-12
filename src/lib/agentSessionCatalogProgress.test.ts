import { describe, expect, it } from 'vitest';
import {
  isValidAgentSessionCatalogProgress,
  mergeAgentSessionCatalogProgress,
} from './agentSessionCatalogProgress';

describe('agent session catalog progress', () => {
  it('rejects impossible determinate counts and invalid elapsed values', () => {
    expect(isValidAgentSessionCatalogProgress({
      requestId: 1,
      provider: 'claude',
      phase: 'scanning',
      completed: 11,
      total: 10,
      elapsedMs: 100,
    })).toBe(false);
    expect(isValidAgentSessionCatalogProgress({
      requestId: 1,
      provider: 'claude',
      phase: 'discovering',
      completed: 11,
      total: null,
      elapsedMs: Number.NaN,
    })).toBe(false);
  });

  it('keeps same-request progress monotonic and resets for a new request', () => {
    const previous = {
      requestId: 1,
      provider: 'claude' as const,
      phase: 'scanning' as const,
      completed: 5,
      total: 10,
      elapsedMs: 500,
    };
    expect(mergeAgentSessionCatalogProgress(previous, {
      ...previous,
      completed: 3,
      elapsedMs: 400,
    })).toMatchObject({ completed: 5, elapsedMs: 500 });
    expect(mergeAgentSessionCatalogProgress(previous, {
      ...previous,
      requestId: 2,
      completed: 1,
      elapsedMs: 10,
    })).toMatchObject({ requestId: 2, completed: 1, elapsedMs: 10 });
  });
});
