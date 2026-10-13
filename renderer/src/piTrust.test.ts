import test from 'node:test';
import assert from 'node:assert/strict';
import type { PiTrustState } from '@threadterm/protocol';
import { chatUiFromEvent } from './chatState';
import { piTrustSource, showPiTrustBanner } from './piTrust';

const trust: PiTrustState = { protectedResources: ['.pi/settings.json', '../.agents/skills'], piDecision: 'none', defaultProjectTrust: 'ask', threadtermDecision: 'none', effective: 'skipped' };

test('trust review appears only for protected resources skipped without a saved decision', () => {
  assert.equal(showPiTrustBanner(trust), true);
  assert.equal(showPiTrustBanner(undefined), false);
  for (const changed of [{ protectedResources: [] }, { effective: 'loaded' }, { piDecision: 'trusted' }, { piDecision: 'declined' }, { threadtermDecision: 'trusted' }, { threadtermDecision: 'declined' }] as Partial<PiTrustState>[]) {
    assert.equal(showPiTrustBanner({ ...trust, ...changed }), false);
  }
});

test('trust review remains visible when only an outside-project link was found', () => {
  const outsideOnly = { ...trust, protectedResources: [], outsideProtectedResources: [{ path: '.pi/extensions/link', target: 'D:\\outside\\extension' }] };
  assert.equal(showPiTrustBanner(outsideOnly), true);
});

test('ThreadTerm launch decisions take precedence over read-only native decisions', () => {
  assert.equal(piTrustSource(trust), undefined);
  assert.equal(piTrustSource({ ...trust, piDecision: 'trusted' }), 'pi');
  assert.equal(piTrustSource({ ...trust, piDecision: 'declined', threadtermDecision: 'trusted' }), 'threadterm');
});

test('complete chat UI snapshots retain trust and clear it when absent', () => {
  assert.deepEqual(chatUiFromEvent({ options: [], commands: [], piTrust: trust }).piTrust, trust);
  assert.equal(chatUiFromEvent({ options: [], commands: [] }).piTrust, undefined);
});
