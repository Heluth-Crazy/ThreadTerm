import type { PiTrustState } from '@threadterm/protocol';

export function showPiTrustBanner(trust?: PiTrustState): boolean {
  return Boolean(trust && trust.protectedResources.length && trust.effective === 'skipped'
    && trust.threadtermDecision === 'none' && trust.piDecision === 'none');
}

export function piTrustSource(trust?: PiTrustState): 'threadterm' | 'pi' | undefined {
  if (!trust) return undefined;
  if (trust.threadtermDecision !== 'none') return 'threadterm';
  if (trust.piDecision !== 'none') return 'pi';
  return undefined;
}
