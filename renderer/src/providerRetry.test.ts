import assert from 'node:assert/strict';
import test from 'node:test';
import { providerRetryPresentation } from './providerRetry';
import { ProviderRetryStatus } from './components/ProviderRetryStatus';

const copy = (en: string) => en;

test('preserves every legacy Grok retry state when native metadata is absent', () => {
  for (const state of ['retrying', 'failed', 'stopped', 'finished']) {
    assert.deepEqual(providerRetryPresentation({ kind: 'providerRetry', state, attempt: 2, maxRetries: 3 }), { kind: 'legacy-grok', state, attempt: 2, maxRetries: 3 });
  }
});

test('recognizes a native retry message and next retry value by shape', () => {
  assert.deepEqual(providerRetryPresentation({ kind: 'providerRetry', state: 'retrying', attempt: 2, message: 'Rate limited', next: '2026-10-15T10:00:00Z' }), { kind: 'native', state: 'retrying', attempt: 2, message: 'Rate limited', next: '2026-10-15T10:00:00Z' });
});

test('formats numeric next retry timestamps as readable date-times', () => {
  assert.deepEqual(providerRetryPresentation({ kind: 'providerRetry', state: 'retrying', next: 1_792_000_000_000 }), { kind: 'native', state: 'retrying', next: '2026-10-14T17:46:40.000Z' });
});

test('ignores invalid native retry metadata', () => {
  assert.deepEqual(providerRetryPresentation({ kind: 'providerRetry', state: 'retrying', message: '  ', next: Number.MAX_VALUE }), { kind: 'legacy-grok', state: 'retrying' });
});

test('does not reinterpret a Codex status card as retry status', () => {
  assert.equal(providerRetryPresentation({ model: 'gpt-5.2', account: { type: 'chatgpt' } }), undefined);
});

test('exposes accessible status props and preserves Grok copy without server rendering', () => {
  const grok = ProviderRetryStatus({ data: { kind: 'providerRetry', state: 'retrying', attempt: 2, maxRetries: 3 }, copy });
  assert.ok(grok);
  assert.equal(grok.props.className, 'chat-network-notice');
  assert.equal(grok.props.role, 'status');
  assert.equal(grok.props['aria-live'], 'polite');
  const [heading, detail] = grok.props.children.props.children;
  assert.equal(heading.props.children, 'Connection interrupted · retrying (2/3)');
  assert.equal(detail.props.children, 'Grok is retrying the request. You can stop this turn using the Stop button below.');
});

test('exposes native message and readable retry time props and no Codex retry surface', () => {
  const native = ProviderRetryStatus({ data: { kind: 'providerRetry', state: 'retrying', attempt: 2, message: 'Rate limited', next: 1_792_000_000_000 }, copy });
  assert.ok(native);
  assert.equal(native.props.role, 'status');
  assert.equal(native.props['aria-live'], 'polite');
  const [heading, message, next] = native.props.children.props.children;
  assert.equal(heading.props.children, 'Request retrying (Attempt 2)');
  assert.equal(message.props.children, 'Rate limited');
  assert.deepEqual(next.props.children, ['Next retry', ': ', '2026-10-14T17:46:40.000Z']);
  assert.equal(ProviderRetryStatus({ data: { model: 'gpt-5.2' }, copy }), null);
});
