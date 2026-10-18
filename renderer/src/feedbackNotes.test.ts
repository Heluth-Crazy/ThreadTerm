import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatFeedbackNote, ChatPart } from '@threadterm/protocol';
import { applyNoteEvent, feedbackNotesFromPart, isFeedbackCheck, MAX_NOTE_CHARS, noteBodyFits, notesMessage, readIsCurrent, sortNotes, waitingNotes } from './feedbackNotes';
import { serializeContext } from './chatContext';

const note = (id: string, status: ChatFeedbackNote['status'] = 'waiting', turnId = 'turn-1'): ChatFeedbackNote => ({
  id, sessionId: 's', turnId, text: `note ${id}`, status, createdAt: `2026-01-01T00:00:0${id.at(-1) ?? '0'}Z`,
});

test('feedback_check is detected by exact tool identity, never by provider', () => {
  assert.equal(isFeedbackCheck({ type: 'tool', toolName: 'mcp__threadterm__feedback_check' }), true);
  assert.equal(isFeedbackCheck({ type: 'tool', toolName: 'threadterm__feedback_check' }), true);
  assert.equal(isFeedbackCheck({ type: 'tool', data: { server: 'threadterm', tool: 'feedback_check' } }), true);
  assert.equal(isFeedbackCheck({ type: 'tool', toolName: 'mcp__threadterm__ask_user' }), false);
  assert.equal(isFeedbackCheck({ type: 'tool', toolName: 'feedback_check_shell' }), false);
  assert.equal(isFeedbackCheck({ type: 'tool', data: { server: 'foreign', tool: 'feedback_check' } }), false);
});

test('notes are read from the result content wherever the provider put it', () => {
  const viaContent: ChatPart = { type: 'tool', toolName: 'mcp__threadterm__feedback_check', data: { result: { content: [{ type: 'text', text: JSON.stringify({ notes: [note('a')] }) }] } } };
  assert.deepEqual(feedbackNotesFromPart(viaContent)?.map(entry => entry.id), ['a']);
  const viaResult: ChatPart = { type: 'tool', data: { server: 'threadterm', tool: 'feedback_check', result: { notes: [note('b', 'received')] } } };
  assert.deepEqual(feedbackNotesFromPart(viaResult)?.map(entry => `${entry.id}:${entry.status}`), ['b:received']);
  const empty: ChatPart = { type: 'tool', toolName: 'threadterm__feedback_check', data: { output: '{"notes":[]}' } };
  assert.deepEqual(feedbackNotesFromPart(empty), []);
  assert.equal(feedbackNotesFromPart({ type: 'tool', toolName: 'mcp__threadterm__ask_user' }), undefined);
  // A running call has no result yet, so the typed card is not forced.
  assert.equal(feedbackNotesFromPart({ type: 'tool', toolName: 'mcp__threadterm__feedback_check', data: { status: 'running' } }), undefined);
});

test('the event delta updates in place, removes exactly once and never duplicates', () => {
  const current = sortNotes([note('a'), note('b')]);
  const merged = applyNoteEvent(current, 's', [{ ...note('b', 'received'), text: 'note b updated' }], []);
  assert.deepEqual(merged.map(entry => `${entry.id}:${entry.status}:${entry.text}`), ['a:waiting:note a', 'b:received:note b updated']);
  const removed = applyNoteEvent(merged, 's', [], ['a']);
  assert.deepEqual(removed.map(entry => entry.id), ['b']);
  // A note for another session is ignored.
  assert.deepEqual(applyNoteEvent(removed, 's', [{ ...note('c'), sessionId: 'other' }], []).map(entry => entry.id), ['b']);
});

test('only waiting notes are offered and all of them join one message', () => {
  const notes = [note('a'), note('b', 'received'), note('c')];
  assert.deepEqual(waitingNotes(notes).map(entry => entry.id), ['a', 'c']);
  assert.equal(notesMessage(waitingNotes(notes)), 'note a\n\nnote c');
});

test('note bodies are capped at the runtime 4,000-character limit', () => {
  assert.equal(noteBodyFits('a'.repeat(MAX_NOTE_CHARS)), true);
  assert.equal(noteBodyFits('a'.repeat(MAX_NOTE_CHARS + 1)), false);
  // Astral characters count as one, matching the runtime's chars().count().
  assert.equal(noteBodyFits('😀'.repeat(MAX_NOTE_CHARS)), true);
  assert.equal(noteBodyFits('😀'.repeat(MAX_NOTE_CHARS + 1)), false);
});

test('a serialized context envelope counts against the note cap and keeps the text', () => {
  const body = serializeContext([{ kind: 'file', id: 'f', path: 'src/cart.ts' }], 'prefer the narrow reading');
  assert.equal(noteBodyFits(body), true);
  assert.match(body, /prefer the narrow reading/);
  assert.equal(noteBodyFits(serializeContext([], 'x'.repeat(MAX_NOTE_CHARS + 1))), false);
});

test('a feedback event supersedes an in-flight read snapshot', () => {
  let revision = 0;
  const read = ++revision;
  assert.equal(readIsCurrent(read, revision), true);
  revision += 1; // a chat.feedback event bumps the sequence
  assert.equal(readIsCurrent(read, revision), false);
  const next = ++revision;
  assert.equal(readIsCurrent(next, revision), true);
});

test('all managed browser identities reject private feedback-note dispatch', () => {
  for (const tool of ['browser_list_tabs', 'browser_snapshot', 'browser_screenshot', 'browser_console_messages',
    'browser_navigate', 'browser_click', 'browser_type', 'browser_hover', 'browser_press_key', 'browser_select_option']) {
    const part: ChatPart = { type: 'tool', toolName: `mcp__threadterm__${tool}`, data: {
      server: 'threadterm', tool: 'feedback_check', result: { notes: [{ ...note('private'), text: 'PRIVATE' }] },
    } };
    assert.equal(isFeedbackCheck(part), false);
    assert.equal(feedbackNotesFromPart(part), undefined);
  }
});
