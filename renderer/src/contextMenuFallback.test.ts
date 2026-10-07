import assert from 'node:assert/strict';
import { test } from 'node:test';
import { textFieldContextMenuItems } from './contextMenuFallback';

test('controlled text field edits use captured selection, native setters and input events', async () => {
  class Field {
    type = 'text'; disabled = false; readOnly = false; isConnected = true;
    selectionStart: number | null = 2; selectionEnd: number | null = 5; stored = 'a selected value'; events: unknown[] = [];
    get value() { return this.stored; }
    set value(value: string) { this.stored = value; }
    focus() {}
    setSelectionRange(start: number, end: number) { this.selectionStart = start; this.selectionEnd = end; }
    select() { this.setSelectionRange(0, this.value.length); }
    dispatchEvent(event: unknown) { this.events.push(event); return true; }
  }
  class Textarea extends Field {}
  class Input { constructor(public type: string, public options: unknown) {} }
  const clipboard: string[] = [];
  const commands: Array<[string, string | undefined]> = [];
  let rejectClipboard = false;
  const globals = { HTMLInputElement: Field, HTMLTextAreaElement: Textarea, InputEvent: Input,
    document: { documentElement: { lang: 'en' }, queryCommandEnabled: () => true, execCommand: (name: string, _ui: boolean, value?: string) => { commands.push([name, value]); return true; } },
    navigator: { clipboard: { writeText: async (value: string) => { if (rejectClipboard) throw Error('clipboard unavailable'); clipboard.push(value); }, readText: async () => 'paste' } },
  };
  const descriptors = Object.entries(globals).map(([key, value]) => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    return { key, previous };
  });
  try {
    const field = new Field();
    const items = textFieldContextMenuItems(field as unknown as HTMLInputElement);
    field.setSelectionRange(0, 0); // Opening a menu must not make its action re-read a different selection.
    await items.find(item => item.id === 'copy')!.onSelect!();
    assert.equal(clipboard[0], 'sel');
    rejectClipboard = true;
    await assert.rejects(async () => items.find(item => item.id === 'cut')!.onSelect!(), /clipboard unavailable/);
    assert.equal(field.value, 'a selected value');
    rejectClipboard = false;
    await items.find(item => item.id === 'paste')!.onSelect!();
    assert.equal(field.value, 'a pasteected value');
    assert.equal(field.selectionStart, 7);
    assert.equal(field.events.length, 1);
    assert.deepEqual(field.events[0], new Input('input', { bubbles: true, inputType: 'insertFromPaste', data: 'paste' }));
    field.readOnly = true;
    const readonly = textFieldContextMenuItems(field as unknown as HTMLInputElement);
    assert.equal(readonly.find(item => item.id === 'paste')!.disabled, true);
    field.type = 'password';
    const password = textFieldContextMenuItems(field as unknown as HTMLInputElement);
    assert.equal(password.find(item => item.id === 'copy')!.reason, 'Passwords cannot be copied.');
    const numeric = Object.assign(new Field(), { type: 'number', selectionStart: null, selectionEnd: null });
    const native = textFieldContextMenuItems(numeric as unknown as HTMLInputElement);
    await native.find(item => item.id === 'paste')!.onSelect!();
    await native.find(item => item.id === 'copy')!.onSelect!();
    native.find(item => item.id === 'select-all')!.onSelect!();
    assert.deepEqual(commands, [['insertText', 'paste'], ['copy', undefined], ['selectAll', undefined]]);
    assert.equal(numeric.events.length, 0, 'unsupported offset APIs are never used on native numeric fields');
  } finally {
    for (const { key, previous } of descriptors) {
      if (previous) Object.defineProperty(globalThis, key, previous);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
