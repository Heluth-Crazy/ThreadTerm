import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const component = readFileSync('renderer/src/components/SettingsUsage.tsx', 'utf8');
const stylesheet = readFileSync('renderer/src/components/settings-usage.css', 'utf8');

test('Usage settings uses shared status, chip, field and button treatments', () => {
  assert.match(component, /aria-busy=\{!issue\}/, 'the initial card reports its loading state');
  assert.match(component, /role="status" aria-live="polite"/, 'the initial read uses the Settings live-status pattern');
  assert.match(component, /chip flat settings-provider-state/, 'an unavailable provider remains visibly labelled without removing its switch');
  assert.match(component, /btn btn-sm/, 'price actions use the shared compact button');
  assert.match(stylesheet, /\.settings-price-head \{[^}]*font-size:11px[^}]*font-weight:500/s, 'price columns use the shared 11 px label scale');
  assert.match(stylesheet, /\.settings-price-input, \.settings-price-model-input \{[^}]*font-size:12px/s, 'price fields use the shared Settings input treatment with the 12 px control scale');
  assert.doesNotMatch(stylesheet, /\.settings-price-input, \.settings-price-model-input \{[^}]*background:/s, 'price fields do not override the shared Settings field background');
});
