import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {ChatPart} from '@threadterm/protocol';
import {approvalData, choiceLabel} from './chatApproval';

const zh = (_en: string, text: string) => text;
const en = (text: string) => text;

test('known approval choice labels are bilingual; native labels stay verbatim', () => {
  const part: ChatPart = {type: 'approval', approvalId: 'a', status: 'pending', data: {approvalId: 'a', submittable: true, choices: [
    {choiceId: 'allow', label: 'Allow once', kind: 'allow', scope: 'once'},
    {choiceId: 'allow_always', label: 'Always allow in this project', kind: 'allow', scope: 'persistent'},
    {choiceId: 'edits', label: 'Allow all edits this session', kind: 'allow', scope: 'session'},
    {choiceId: 'deny', label: 'Deny', kind: 'deny', scope: 'once'},
    {choiceId: 'native', label: 'Proceed with sandbox', kind: 'other', scope: 'unknown'},
  ]}};
  const choices = approvalData(part)!.choices;
  assert.deepEqual(choices.map(choice => choiceLabel(choice, zh)), ['允许一次', '在此项目中始终允许', '本次会话中允许所有编辑', '拒绝', 'Proceed with sandbox']);
  assert.deepEqual(choices.map(choice => choiceLabel(choice, en)), ['Allow once', 'Always allow in this project', 'Allow all edits this session', 'Deny', 'Proceed with sandbox']);
});
