import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const source = (file: string) => readFileSync(`mobile/${file}`, 'utf8');

test('keyboard avoidance accounts for the safe-area origin shared by chat and terminal', () => {
  const app = source('App.tsx');
  assert.match(app, /keyboardVerticalOffset=\{insets\.top\}/);
  assert.match(app, /<KeyboardAvoidingView[^>]*testID="companion-keyboard"/s);
  assert.doesNotMatch(source('src/ui/ChatScreen.tsx'), /<KeyboardAvoidingView/,
    'nested avoidance would apply keyboard movement twice');
});

test('input sheets stay inside safe areas and their scroll views dismiss the keyboard', () => {
  assert.match(source('src/ui/primitives.tsx'), /paddingTop: insets\.top/);
  for (const file of ['src/ui/NewSessionSheet.tsx', 'src/ui/SettingsScreen.tsx', 'src/ui/ChatOptionsSheet.tsx']) {
    assert.match(source(file), /keyboardDismissMode="interactive"/);
    assert.match(source(file), /keyboardShouldPersistTaps="handled"/);
  }
  const chat = source('src/ui/ChatScreen.tsx');
  assert.equal((chat.match(/keyboardDismissMode="interactive"/g) ?? []).length, 2,
    'both transcript and terminal output support drag dismissal');
});
