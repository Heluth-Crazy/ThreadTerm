import test from 'node:test';
import assert from 'node:assert/strict';
import { discoveredRepair, discoveryMatches } from './chatRepairDiscovery';

test('visible offered legacy and degraded recovery hold connection before a worker opens', () => {
  assert.equal(discoveredRepair('chat', 0, {offered:true,degraded:false,reason:'history_metadata_missing'}).phase, 'held');
  assert.equal(discoveredRepair('chat', 0, {offered:true,degraded:true}).phase, 'held');
});

test('healthy, unavailable and menu-only repair do not create an invisible hold', () => {
  for (const repair of [undefined, {offered:false,degraded:false,reason:'healthy' as const},
    {offered:false,degraded:true,reason:'busy' as const}, {offered:true,degraded:false}]) {
    assert.equal(discoveredRepair('chat', 0, repair).phase, 'clear');
  }
});

test('a previous session or transport generation cannot authorize connecting the new one', () => {
  const clear = discoveredRepair('old', 1);
  assert.equal(discoveryMatches(clear, 'old', 1), true);
  assert.equal(discoveryMatches(clear, 'new', 1), false);
  assert.equal(discoveryMatches(clear, 'old', 2), false);
  assert.equal(discoveryMatches(undefined, 'old', 1), false);
});
