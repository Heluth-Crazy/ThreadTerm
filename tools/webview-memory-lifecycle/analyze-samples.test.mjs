import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeDocuments, linearSlope, renderMarkdown } from './analyze-samples.mjs';

function sampleSet(label, round, ownedMb) {
  const bytes = ownedMb * 1024 * 1024;
  return {
    schemaVersion: 2,
    kind: 'threadterm-memory-sample-set',
    label,
    scenario: `S4-round-${round}`,
    build: { kind: 'Release', commit: 'a'.repeat(40) },
    samples: [
      {
        platform: 'windows',
        label: `${label}-t120s`,
        settleSeconds: 120,
        totals: {
          appGroupPrivateBytes: bytes - 10 * 1024 * 1024,
          webviewPrivateBytes: 50 * 1024 * 1024,
          ownedProcessGroupPrivateBytes: bytes,
          claudeHostCount: 1,
          claudeCliCount: 1,
          ptyChildCount: 6,
        },
      },
    ],
  };
}

test('linearSlope calculates change per round', () => {
  assert.equal(linearSlope([{ x: 1, y: 10 }, { x: 2, y: 12 }, { x: 3, y: 14 }]), 2);
});

test('twenty-round ratio passes at or below 110 percent', () => {
  const analysis = analyzeDocuments([
    sampleSet('round-01', 1, 100),
    sampleSet('round-10', 10, 104),
    sampleSet('round-20', 20, 109),
  ]);
  assert.equal(analysis.stability.status, 'pass');
  assert.equal(analysis.stability.firstRound, 1);
  assert.equal(analysis.stability.lastRound, 20);
  assert.ok(analysis.stability.stableRatio <= 1.1);
  assert.match(renderMarkdown(analysis), /`PASS`/);
  assert.match(renderMarkdown(analysis), /Claude host\/CLI/);
});

test('twenty-round ratio fails above 110 percent', () => {
  const analysis = analyzeDocuments([
    sampleSet('round-01', 1, 100),
    sampleSet('round-20', 20, 111),
  ]);
  assert.equal(analysis.stability.status, 'fail');
});

test('legacy macOS RSS schema remains comparable', () => {
  const analysis = analyzeDocuments([{
    schemaVersion: 1,
    kind: 'threadterm-webview-memory-sample-set',
    label: 'mac-cold',
    machine: { platform: 'macos' },
    samples: [{
      platform: 'macos',
      settleSeconds: 120,
      totals: { appGroupRssKb: 102400, helperRssKb: 51200 },
    }],
  }]);
  assert.equal(analysis.rows[0].appGroupBytes, 100 * 1024 * 1024);
  assert.equal(analysis.rows[0].webviewBytes, 50 * 1024 * 1024);
});
