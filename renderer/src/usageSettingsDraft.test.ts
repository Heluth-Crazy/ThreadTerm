import test from 'node:test';
import assert from 'node:assert/strict';
import type { UsageLedgerPriceOverride, UsageLedgerSettings } from '@threadterm/protocol';
import {
  adoptStoredUsageSettings, changedUsageSettings, draftFromPriceOverrides, editUsageSettings, initialUsageSettingsDraft,
  mergeStoredUsageSettings, priceModelKey, priceOverridesFromDraft, providerHistoryEnabled, savedUsageSettings,
  usageSettingsEqual, usageSettingsPatchField,
} from './usageSettingsDraft.js';

const settings = (partial: Partial<UsageLedgerSettings> = {}): UsageLedgerSettings => ({
  includeOutside: true,
  providers: {},
  weekStart: 'auto',
  priceOverrides: {} as Record<string, UsageLedgerPriceOverride>,
  ...partial,
});

test('an edit marks exactly the fields the user changed', () => {
  const base = initialUsageSettingsDraft(settings());
  const edited = editUsageSettings(base, { includeOutside: false });
  assert.deepEqual(edited.dirty, ['includeOutside']);
  assert.equal(edited.value.includeOutside, false);
  assert.equal(edited.loaded.includeOutside, true);
  // Typing the stored value back clears the draft again.
  assert.deepEqual(editUsageSettings(edited, { includeOutside: true }).dirty, []);
  // A provider toggle is its own field, not a rewrite of the whole map.
  assert.deepEqual(editUsageSettings(base, { providers: { claude: false } }).dirty, ['providers']);
});

test('a settings event never overwrites a dirty field', () => {
  const dirty = editUsageSettings(initialUsageSettingsDraft(settings()), { weekStart: 'monday' });
  const merged = mergeStoredUsageSettings(dirty, settings({ includeOutside: false, providers: { codex: false } }));
  assert.equal(merged.value.weekStart, 'monday', 'the dirty week start survives the event');
  assert.equal(merged.value.includeOutside, false, 'a clean field follows the stored value');
  assert.deepEqual(merged.dirty, ['weekStart']);
  assert.equal(merged.conflict, false, 'an unrelated change is not a conflict');
  assert.deepEqual(changedUsageSettings(merged), { weekStart: 'monday' }, 'only the dirty field is sent');
});

test('a stored value that moved underneath keeps the draft and reports one conflict', () => {
  const dirty = editUsageSettings(initialUsageSettingsDraft(settings()), { weekStart: 'monday' });
  const conflict = mergeStoredUsageSettings(dirty, settings({ weekStart: 'sunday' }));
  assert.equal(conflict.value.weekStart, 'monday');
  assert.equal(conflict.loaded.weekStart, 'sunday');
  assert.equal(conflict.conflict, true);
  assert.equal(mergeStoredUsageSettings(conflict, settings({ weekStart: 'sunday' })).conflict, true, 'the note stays until the user resolves it');
  const adopted = adoptStoredUsageSettings(conflict);
  assert.deepEqual(adopted, initialUsageSettingsDraft(settings({ weekStart: 'sunday' })));
  assert.deepEqual(adopted.dirty, []);
});

test('a clean draft follows the stored value and a save clears it', () => {
  assert.deepEqual(mergeStoredUsageSettings(initialUsageSettingsDraft(settings()), settings({ weekStart: 'monday' })), initialUsageSettingsDraft(settings({ weekStart: 'monday' })));
  assert.deepEqual(savedUsageSettings(settings({ includeOutside: false })), initialUsageSettingsDraft(settings({ includeOutside: false })));
  assert.deepEqual(changedUsageSettings(initialUsageSettingsDraft(settings())), {}, 'a clean draft sends nothing');
});

test('settings equality compares the four fields independently of key order', () => {
  assert.equal(usageSettingsEqual(settings({ providers: { claude: true, codex: false } }), settings({ providers: { codex: false, claude: true } })), true);
  assert.equal(usageSettingsEqual(settings(), settings({ weekStart: 'monday' })), false);
  assert.deepEqual(usageSettingsPatchField({ weekStart: 'monday', providers: {} }), ['providers', 'weekStart']);
});

test('provider switches default to on', () => {
  assert.equal(providerHistoryEnabled(undefined, 'claude'), true);
  assert.equal(providerHistoryEnabled(settings(), 'claude'), true);
  assert.equal(providerHistoryEnabled(settings({ providers: { claude: false } }), 'claude'), false);
  assert.equal(providerHistoryEnabled(settings({ providers: { claude: true } }), 'codex'), true);
});

test('price overrides are parsed from text, keeping only finite non-negative rates', () => {
  const overrides = priceOverridesFromDraft({
    'codex/gpt-5': { input: '1.25', output: '10', cacheRead: '', cacheWrite5m: '0', cacheWrite1h: 'abc' },
    'claude/opus': { input: '-3', output: '  ' },
    '': { input: '2' },
  });
  assert.deepEqual(overrides, {
    'codex/gpt-5': { input: 1.25, output: 10, cacheWrite5m: 0 },
  });
});

test('stored overrides round-trip through the editable text', () => {
  const stored = { 'codex/gpt-5': { input: 1.25, cacheWrite1h: 20 }, 'claude/opus': { output: 15 } };
  const draft = draftFromPriceOverrides(stored);
  assert.deepEqual(draft, { 'codex/gpt-5': { input: '1.25', cacheWrite1h: '20' }, 'claude/opus': { output: '15' } });
  assert.deepEqual(priceOverridesFromDraft(draft), stored);
  assert.deepEqual(draftFromPriceOverrides(undefined), {});
});

test('a model key is a non-empty token without spaces', () => {
  assert.equal(priceModelKey(' codex/gpt-5 '), 'codex/gpt-5');
  assert.equal(priceModelKey('gpt-5-mini'), 'gpt-5-mini');
  assert.equal(priceModelKey(''), null);
  assert.equal(priceModelKey('two words'), null);
  assert.equal(priceModelKey('x'.repeat(200)), null);
});
