import React, { useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { ChatAnswerResponse, ChatFormField, ChatInteractionForm, ChatItem, ChatPart } from '@threadterm/protocol';
import { questionPresentation, questionSummary, validQuestionValues, type QuestionValue } from '../../../renderer/src/chatQuestion';
import { approvalData } from '../core/projection';
import type { CompanionController, CompanionState, SessionRef } from '../core/types';
import { sessionKey } from '../core/types';
import { Button, Card } from './primitives';
import type { Theme } from './theme';

type Values = Record<string, QuestionValue>;
type Copy = (en: string, zh: string) => string;
type Props = { theme: Theme; state: CompanionState; controller: CompanionController; sessionRef: SessionRef; item: ChatItem; part: ChatPart };

/** Pending approval identity comes from the current host snapshot; history is display-only. */
export function ApprovalCard({ theme, state, controller, sessionRef, item, part }: Props) {
  const data = approvalData(part.data);
  const copy: Copy = (en, zh) => state.preferences.locale === 'zh-CN' ? zh : en;
  const [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [feedback, setFeedback] = useState('');
  const inFlight = useRef(false);
  const machine = state.machines.find(row => row.id === sessionRef.machineId);
  const session = machine?.snapshot?.sessions.find(row => row.id === sessionRef.sessionId);
  const view = state.sessions[sessionKey(sessionRef)];
  const approvalId = part.approvalId ?? data?.approvalId;
  const turnId = data?.turnId ?? item.turnId;
  const pending = part.status === 'pending' && item.turnOrigin !== 'history'
    && !data?.planOutcome && !data?.answerSummary && !data?.outcome
    && !['completed', 'failed', 'interrupted'].includes(item.turnStatus ?? '')
    && (!session?.activity?.turnId || session.activity.turnId === turnId);
  const writable = pending && !!approvalId && !!turnId && !busy && !/outcome[_ ]?unknown|approval_expired/i.test(error ?? '')
    && machine?.permission === 'fullcontrol' && machine.status === 'connected' && !machine.syncing && !view?.syncing
    && !session?.readOnly && !session?.archived;

  const run = async (action: () => Promise<void>) => {
    if (!writable || inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(undefined);
    try { await action(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { inFlight.current = false; setBusy(false); }
  };
  const answer = (response: ChatAnswerResponse) => void run(() => controller.answer(sessionRef, turnId!, approvalId!, response));
  const resolvedText = data?.answerSummary && data.form
    ? questionSummary(data.form, data.answerSummary, copy)
    : data?.planOutcome ?? part.status ?? copy('No longer pending', '已结束');
  return <Card theme={theme} style={styles.card}>
    <Text style={[styles.title, { color: theme.text }]}>{data?.title ?? copy('Needs your decision', '等待你的决定')}</Text>
    {!!data?.message && <Text selectable style={{ color: theme.text }}>{data.message}</Text>}
    {!!data?.previewUnavailableReason && <Text style={{ color: theme.muted }}>{data.previewUnavailableReason}</Text>}
    {!!data?.plan && <Text selectable style={[styles.monospace, { color: theme.text }]}>{data.plan}</Text>}
    {data?.details != null && <Text selectable style={[styles.monospace, { color: theme.muted }]}>{typeof data.details === 'string' ? data.details : JSON.stringify(data.details, null, 2)}</Text>}
    {!pending ? <Text style={{ color: theme.muted }}>{resolvedText}</Text> : data?.interaction === 'plan' ? <>
      <TextInput accessibilityLabel={copy('Plan feedback', '计划反馈')} editable={writable} value={feedback} onChangeText={setFeedback}
        multiline placeholder={copy('Feedback (optional)', '反馈（可选）')} placeholderTextColor={theme.faint}
        style={[styles.input, { color: theme.text, borderColor: theme.line, backgroundColor: theme.input }]} />
      <View style={styles.actions}>
        <Button theme={theme} label={copy('Approve plan', '批准计划')} tone="primary" disabled={!writable || data.submittable === false}
          onPress={() => answer({ action: 'approve', ...(feedback.trim() ? { feedback: feedback.trim() } : {}) })} />
        <Button theme={theme} label={copy('Request changes', '要求修改')} disabled={!writable || !feedback.trim() || data.submittable === false}
          onPress={() => answer({ action: 'request_changes', feedback: feedback.trim() })} />
        <Button theme={theme} label={copy('Abandon', '放弃')} tone="destructive" disabled={!writable} onPress={() => answer({ action: 'abandon' })} />
      </View>
    </> : data?.form ? <AnswerForm key={JSON.stringify([sessionRef.machineId, approvalId, turnId])} theme={theme} form={data.form}
      copy={copy} disabled={!writable} answerable={data.answerable !== false && data.submittable !== false} busy={busy} onAnswer={answer}
      onOpenUrl={url => controller.openPreview(sessionRef.machineId, url)} /> : <View style={styles.actions}>
      {(data?.choices ?? []).map(choice => <View key={choice.choiceId} style={styles.choice}>
        <Button theme={theme} label={choice.label} tone={choice.kind === 'deny' || choice.kind === 'cancel' ? 'destructive' : 'primary'} disabled={!writable}
          onPress={() => void run(() => controller.approve(sessionRef, turnId!, approvalId!, choice.choiceId))} />
        {!!choice.description && <Text style={{ color: theme.muted }}>{choice.description}</Text>}
        {choice.scope !== 'unknown' && <Text style={{ color: theme.muted }}>{copy('Scope: ', '范围：')}{choice.scope}</Text>}
      </View>)}
      {!data?.choices.length && <Text style={{ color: theme.muted }}>{copy('Continue on your computer.', '请在电脑上继续。')}</Text>}
    </View>}
    {pending && machine?.permission !== 'fullcontrol' && <Text style={{ color: theme.muted }}>{copy('View only.', '仅查看。')}</Text>}
    {pending && (machine?.status !== 'connected' || machine.syncing || view?.syncing) && <Text style={{ color: theme.amber }}>{copy('Reconnect to act.', '重连后可操作。')}</Text>}
    {data?.isBlocking === false && <Text style={{ color: theme.muted }}>{copy('The agent can continue while you decide.', '你决定期间，Agent 可以继续工作。')}</Text>}
    {!!error && <Text accessibilityRole="alert" selectable style={{ color: theme.red }}>{error}</Text>}
    {busy && <Text style={{ color: theme.muted }}>{copy('Submitting…', '正在提交…')}</Text>}
  </Card>;
}

function AnswerForm({ theme, form, copy, disabled, answerable, busy, onAnswer, onOpenUrl }: {
  theme: Theme; form: ChatInteractionForm; copy: Copy; disabled: boolean; answerable: boolean; busy: boolean;
  onAnswer: (response: ChatAnswerResponse) => void; onOpenUrl: (url: string) => Promise<void>;
}) {
  const [values, setValues] = useState<Values>(() => form.kind === 'form' ? Object.fromEntries(form.fields
    .filter(field => field.default !== undefined || field.type === 'boolean' && field.required)
    .map(field => [field.id, field.default === undefined ? false : field.default as QuestionValue])) : {});
  const [error, setError] = useState<string>();
  const setValue = (id: string, value?: QuestionValue) => setValues(current => {
    const next = { ...current }; if (value === undefined) delete next[id]; else next[id] = value; return next;
  });
  const valid = answerable && validQuestionValues(form, values);
  return <View style={styles.form}>
    {form.kind === 'questions' && form.questions.map((question, index) => {
      const selected = Array.isArray(values[question.id]) ? values[question.id] as string[] : [];
      const other = selected.find(value => !question.options.some(option => option.label === value)) ?? '';
      const presentation = questionPresentation(question);
      return <View key={question.id} style={styles.question}>
        <Text style={[styles.label, { color: theme.text }]}>{form.questions.length > 1 ? `${index + 1}. ` : ''}{presentation.title}</Text>
        {!!presentation.command && <Text selectable style={[styles.monospace, { color: theme.text }]}>{presentation.command}</Text>}
        {question.options.map(option => <Option key={option.label} theme={theme} label={option.label} description={option.description} disabled={disabled}
          multiple={question.multiSelect} selected={selected.includes(option.label)} onPress={() => setValue(question.id,
            question.multiSelect ? selected.includes(option.label) ? selected.filter(value => value !== option.label) : [...selected, option.label] : [option.label])} />)}
        {question.allowOther && <TextInput accessibilityLabel={copy('Other answer: ', '其他答案：') + question.question} editable={!disabled} secureTextEntry={question.secret}
          value={other} onChangeText={text => setValue(question.id, [...(question.multiSelect ? selected.filter(value => question.options.some(option => option.label === value)) : []), ...(text ? [text] : [])])}
          placeholder={copy('Your answer', '输入你的回答')} placeholderTextColor={theme.faint} style={[styles.input, { color: theme.text, backgroundColor: theme.input, borderColor: theme.line }]} />}
      </View>;
    })}
    {form.kind === 'form' && <>
      <Text style={{ color: theme.text }}>{form.message}</Text>
      {form.fields.map(field => <FormField key={field.id} theme={theme} copy={copy} field={field} value={values[field.id]} disabled={disabled} onChange={value => setValue(field.id, value)} />)}
    </>}
    {form.kind === 'url' && <>
      <Text style={{ color: theme.text }}>{form.message}</Text>
      <Text selectable style={{ color: theme.primary }}>{form.url}</Text>
      <Button theme={theme} label={copy('Open link', '打开链接')} disabled={disabled} onPress={() => { setError(undefined); void onOpenUrl(form.url).catch(reason => setError(reason instanceof Error ? reason.message : String(reason))); }} />
    </>}
    {!!error && <Text accessibilityRole="alert" style={{ color: theme.red }}>{error}</Text>}
    <View style={styles.actions}>
      {answerable && <Button theme={theme} label={busy ? copy('Submitting…', '提交中…') : form.kind === 'url' ? copy('Done', '已完成') : copy('Submit answer', '提交回答')}
        tone="primary" disabled={disabled || !valid} onPress={() => onAnswer({ action: 'submit', values })} />}
      <Button theme={theme} label={copy('Dismiss', '忽略')} disabled={disabled} onPress={() => onAnswer({ action: 'dismiss' })} />
    </View>
  </View>;
}

function FormField({ theme, copy, field, value, disabled, onChange }: { theme: Theme; copy: Copy; field: ChatFormField; value?: QuestionValue; disabled: boolean; onChange: (value?: QuestionValue) => void }) {
  const label = (field.title || field.id) + (field.required ? ' *' : '');
  const textColor = { color: theme.text };
  return <View style={styles.question}>
    <Text style={[styles.label, textColor]}>{label}</Text>
    {!!field.description && <Text style={{ color: theme.muted }}>{field.description}</Text>}
    {field.type === 'boolean' ? <Option theme={theme} label={copy('Yes', '是')} selected={value === true} disabled={disabled} multiple onPress={() => onChange(value !== true)} />
      : field.type === 'enum' || field.type === 'multiEnum' ? (field.options ?? []).map(option => <Option key={option.value} theme={theme} label={option.label} disabled={disabled}
        multiple={field.type === 'multiEnum'} selected={Array.isArray(value) ? value.includes(option.value) : value === option.value} onPress={() => {
          if (field.type === 'enum') { onChange(value === option.value && !field.required ? undefined : option.value); return; }
          const selected = Array.isArray(value) ? value : [];
          const next = selected.includes(option.value) ? selected.filter(item => item !== option.value) : [...selected, option.value];
          onChange(next.length || field.required ? next : undefined);
        }} />)
        : <TextInput accessibilityLabel={label} editable={!disabled} value={value === undefined ? '' : String(value)} secureTextEntry={field.secret}
          multiline={field.type === 'string' && field.multiline && !field.secret} autoCapitalize="none"
          keyboardType={field.type === 'number' || field.type === 'integer' ? 'numbers-and-punctuation' : field.format === 'email' ? 'email-address' : 'default'}
          onChangeText={text => onChange(text === '' && !field.required ? undefined : field.type === 'string' ? text : text === '' ? undefined : Number(text))}
          style={[styles.input, textColor, { borderColor: theme.line, backgroundColor: theme.input }]} />}
  </View>;
}

function Option({ theme, label, description, selected, disabled, multiple, onPress }: { theme: Theme; label: string; description?: string; selected: boolean; disabled: boolean; multiple?: boolean; onPress: () => void }) {
  return <Pressable accessibilityRole={multiple ? 'checkbox' : 'radio'} accessibilityState={{ checked: selected, disabled }} accessibilityLabel={label} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [styles.option, { opacity: disabled ? .55 : pressed ? .7 : 1, borderColor: selected ? theme.primary : theme.line, backgroundColor: selected ? theme.chip : theme.raised }]}>
    <Text style={[styles.label, { color: selected ? theme.primary : theme.text }]}>{selected ? '✓ ' : ''}{label}</Text>
    {!!description && <Text style={{ color: theme.muted }}>{description}</Text>}
  </Pressable>;
}

const styles = StyleSheet.create({
  card: { padding: 14, gap: 10 }, title: { fontSize: 17, fontWeight: '700' }, label: { fontSize: 15, lineHeight: 21, fontWeight: '600' },
  form: { gap: 16 }, question: { gap: 8 }, actions: { gap: 10 }, choice: { gap: 5 }, option: { minHeight: 46, padding: 12, gap: 4, borderWidth: 1, borderRadius: 12 },
  input: { minHeight: 46, padding: 12, borderWidth: 1, borderRadius: 12, fontSize: 16 }, monospace: { fontFamily: 'Menlo', fontSize: 13, lineHeight: 19 },
});
