import type { PiTrustState } from '@threadterm/protocol';

export function showPiTrustBanner(trust?: PiTrustState): boolean {
  const outside = (trust as PiTrustState & { outsideProtectedResources?: readonly unknown[] } | undefined)?.outsideProtectedResources?.length ?? 0;
  return Boolean(trust && (trust.protectedResources.length || outside) && trust.effective === 'skipped'
    && trust.threadtermDecision === 'none' && trust.piDecision === 'none');
}

export function piTrustSource(trust?: PiTrustState): 'threadterm' | 'pi' | undefined {
  if (!trust) return undefined;
  if (trust.threadtermDecision !== 'none') return 'threadterm';
  if (trust.piDecision !== 'none') return 'pi';
  return undefined;
}
