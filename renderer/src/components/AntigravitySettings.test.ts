import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server.edge';
import type { ProviderCapability, Settings } from '@threadterm/protocol';
import { AntigravitySettings, canSave, configuredAntigravity, validateLocation, validateProject } from './AntigravitySettings';

const capability = (patch: Partial<ProviderCapability> = {}): ProviderCapability => ({
  id: 'antigravity', name: 'Antigravity', installed: true, version: '1.5.16', terminal: true, chat: true, history: true, resume: true, auth: 'unauthenticated',
  authMethods: [
    { id: 'oauth-personal', apiKey: false, browser: true }, { id: 'oauth-business', apiKey: false, browser: true },
    { id: 'gemini-api-key', apiKey: true, browser: false }, { id: 'agent-platform', apiKey: true, browser: false },
  ],
  apiKeySet: false,
  ...patch,
});
const settingsWith = (antigravity?: Record<string, unknown>) => ({ ...(antigravity ? { providerAuth: { antigravity } } : {}) }) as unknown as Settings;
const render = (zh: boolean, settings: Settings, value?: ProviderCapability) =>
  renderToStaticMarkup(createElement(AntigravitySettings, { zh, settings, capability: value, update: async () => {} }));

test('nothing is chosen until the user picks a sign-in method, in both languages', () => {
  assert.equal(configuredAntigravity(settingsWith()).method, undefined);
  for (const zh of [false, true]) {
    const html = render(zh, settingsWith(), capability());
    assert.ok(html.includes(zh ? '未选择' : 'Not chosen'));
    assert.equal((html.match(/name="antigravity-auth-method"/g) ?? []).length, 4, 'all four methods agy announces');
    assert.ok(!html.includes('checked=""'), 'no method preselected');
    assert.ok(!html.includes('data-testid="antigravity-risk"'), 'the notice belongs to the personal account');
  }
});

test('a personal Google account shows the ban-risk notice and needs it acknowledged before saving', () => {
  const draft = { method: 'oauth-personal' as const, project: '', location: '' };
  assert.equal(canSave(draft, false, true), false);
  assert.equal(canSave(draft, true, true), true);
  // Saved already: the notice stays on show, without asking again.
  const html = render(true, settingsWith({ method: 'oauth-personal' }), capability());
  assert.ok(html.includes('data-testid="antigravity-risk"'));
  assert.ok(html.includes('封号风险') && html.includes('T3 Code') && html.includes('Gemini API key'));
  assert.ok(!html.includes('我了解风险'), 'the acknowledgement is asked when switching to it, not again afterwards');
});

test('other methods save without the notice; Agent Platform needs a valid project', () => {
  assert.equal(canSave({ method: 'oauth-business', project: '', location: '' }, false, false), true);
  assert.equal(canSave({ method: 'gemini-api-key', project: '', location: '' }, false, false), true);
  assert.equal(canSave({ method: 'agent-platform', project: '', location: '' }, false, false), false);
  assert.equal(canSave({ method: 'agent-platform', project: 'my-proj-1', location: '' }, false, false), true);
  assert.equal(canSave({ method: 'agent-platform', project: 'my-proj-1', location: 'us central' }, false, false), false);
  assert.ok(validateProject('My Project', false));
  assert.equal(validateProject(' my-proj-1 ', false), undefined);
  assert.equal(validateLocation('', false), undefined, 'empty means global');
  assert.ok(validateLocation('us_central', true));
});

test('the API key is write-only: the panel says whether one is stored, never shows it', () => {
  const html = render(false, settingsWith({ method: 'gemini-api-key' }), capability({ apiKeySet: true, auth: 'authenticated' }));
  assert.ok(html.includes('A key is stored'));
  assert.ok(html.includes('type="password"'));
  assert.ok(html.includes('value=""'), 'the field starts empty');
  assert.ok(!html.includes('data-testid="antigravity-risk"'));
  const platform = render(true, settingsWith({ method: 'agent-platform', project: 'p1' }), capability());
  assert.ok(platform.includes('API key（可选，快速模式）') && platform.includes('Google Cloud 项目 ID'));
});

test('an agent row without sign-in methods (an older runtime) shows no panel', () => {
  assert.equal(render(false, settingsWith(), capability({ authMethods: undefined })), '');
  assert.equal(render(false, settingsWith(), undefined), '');
});
