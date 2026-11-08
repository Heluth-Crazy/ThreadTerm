import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { ChatSessionChoice, ChatSessionOption, ChatUiState } from '@threadterm/protocol';
import { choiceText, filterModelChoices, groupChoices, isRecommended, optionCategory, optionTitle, partitionOptions } from '../../../renderer/src/composerOptions';
import type { Locale } from '../core/types';
import { Button, Loading, Sheet } from './primitives';
import type { Theme } from './theme';
import { space } from './theme';

type Props = {
  theme: Theme;
  locale: Locale;
  visible: boolean;
  ui?: ChatUiState;
  disabledReason?: string;
  pending?: string;
  error?: string;
  loading?: boolean;
  onDismiss: () => void;
  onRefresh: () => void;
  onChoose: (optionId: string, value: string) => void;
};

const copy = (locale: Locale, en: string, zh: string) => locale === 'zh-CN' ? zh : en;

/** A provider-driven companion sheet. Every choice comes from `chat.options`. */
export function ChatOptionsSheet({ theme, locale, visible, ui, disabledReason, pending, error, loading, onDismiss, onRefresh, onChoose }: Props) {
  const [search, setSearch] = useState('');
  const { model, thinking, mode, extras } = partitionOptions(ui?.options ?? []);
  const selected = (option: ChatSessionOption, choice: ChatSessionChoice) => option.value === choice.value;
  const choose = (option: ChatSessionOption, choice: ChatSessionChoice) => {
    if (disabledReason || pending || selected(option, choice)) return;
    onChoose(option.id, choice.value);
  };
  const modelChoices = useMemo(() => model ? filterModelChoices(model.choices, search) : [], [model, search]);
  const showSearch = (model?.choices.length ?? 0) > 12;
  const heading = copy(locale, 'Session options', '会话选项');
  const options = [thinking, mode, ...extras].filter((value): value is ChatSessionOption => !!value && value.choices.length > 0);

  return <Sheet theme={theme} visible={visible} title={heading} onDismiss={onDismiss} closeLabel={copy(locale, 'Close', '关闭')} dismissLabel={copy(locale, 'Dismiss', '收起')}>
    <ScrollView contentContainerStyle={styles.content} keyboardDismissMode="interactive" keyboardShouldPersistTaps="handled">
      {(loading || ui?.loadState === 'loading' || ui?.loadState === 'idle') && <Loading theme={theme} label={copy(locale, 'Loading options…', '正在加载选项…')} />}
      {!!(error ?? ui?.error?.message) && <View style={[styles.notice, { backgroundColor: `${theme.red}16` }]}>
        <Text style={{ color: theme.red, flex: 1 }}>{error ?? ui?.error?.message}</Text>
        <Button theme={theme} small label={copy(locale, 'Retry', '重试')} onPress={onRefresh} />
      </View>}
      {ui?.loadState === 'unknown' && <View style={[styles.notice, { backgroundColor: `${theme.amber}18` }]}><Text style={{ color: theme.amber, flex: 1 }}>{copy(locale, 'Options are still syncing.', '选项仍在同步。')}</Text><Button theme={theme} small label={copy(locale, 'Refresh', '刷新')} onPress={onRefresh} /></View>}
      {ui?.loadState === 'error' && !ui.error && !error && <View style={[styles.notice, { backgroundColor: `${theme.red}16` }]}><Text style={{ color: theme.red, flex: 1 }}>{copy(locale, 'Options could not be loaded.', '无法读取选项。')}</Text><Button theme={theme} small label={copy(locale, 'Retry', '重试')} onPress={onRefresh} /></View>}
      {!!disabledReason && <View style={[styles.notice, { backgroundColor: `${theme.amber}18` }]}><Text style={{ color: theme.amber }}>{disabledReason}</Text></View>}
      {showSearch && <TextInput accessibilityLabel={copy(locale, 'Search models', '搜索模型')} value={search} onChangeText={setSearch} placeholder={copy(locale, 'Search models', '搜索模型')} placeholderTextColor={theme.faint} style={[styles.search, { color: theme.text, backgroundColor: theme.input, borderColor: theme.line }]} />}
      {model && <OptionSection theme={theme} locale={locale} option={model} choices={modelChoices} pending={pending} disabled={!!disabledReason} onChoose={choose} />}
      {options.map(option => <OptionSection key={option.id} theme={theme} locale={locale} option={option} pending={pending} disabled={!!disabledReason} onChoose={choose} />)}
      {!loading && ['ready', 'empty'].includes(ui?.loadState ?? '') && !model && options.length === 0 && <View style={styles.empty}><Text style={{ color: theme.muted }}>{copy(locale, 'This provider has no session options.', '此提供方没有会话选项。')}</Text><Button theme={theme} small label={copy(locale, 'Refresh', '刷新')} onPress={onRefresh} /></View>}
    </ScrollView>
  </Sheet>;
}

function SectionLabel({ theme, children }: { theme: Theme; children: React.ReactNode }) {
  return <Text style={[styles.section, { color: theme.muted }]}>{children}</Text>;
}

function OptionSection({ theme, locale, option, choices = option.choices, pending, disabled, onChoose }: { theme: Theme; locale: Locale; option: ChatSessionOption; choices?: ChatSessionChoice[]; pending?: string; disabled: boolean; onChoose: (option: ChatSessionOption, choice: ChatSessionChoice) => void }) {
  // Providers can retain a selected model after withdrawing it from the next choice list.
  // Preserve the host value in the readout instead of pretending a different choice is active.
  const displayed = choices.some(choice => choice.value === option.value) || !option.value ? choices : [{ value: option.value, name: option.value }, ...choices];
  const groups = groupChoices(displayed);
  const withHeaders = groups.some(group => group.key);
  return <View style={styles.option}>
    <SectionLabel theme={theme}>{optionTitle(option, (en, zh) => copy(locale, en, zh))}</SectionLabel>
    {!!option.description && <Text style={[styles.description, { color: theme.muted }]}>{option.description}</Text>}
    {groups.map(group => <View key={group.key || 'choices'}>
      {withHeaders && !!group.key && <Text style={[styles.group, { color: theme.muted }]}>{group.key}</Text>}
      {group.choices.map(choice => <ChoiceRow key={choice.value} theme={theme} locale={locale} option={option} choice={choice} pending={pending} disabled={disabled} onChoose={onChoose} />)}
    </View>)}
    {choices.length === 0 && optionCategory(option) === 'model' && !option.value && <Text style={{ color: theme.muted }}>{copy(locale, 'No models found.', '未找到模型。')}</Text>}
  </View>;
}

function ChoiceRow({ theme, locale, option, choice, pending, disabled, onChoose }: { theme: Theme; locale: Locale; option: ChatSessionOption; choice: ChatSessionChoice; pending?: string; disabled: boolean; onChoose: (option: ChatSessionOption, choice: ChatSessionChoice) => void }) {
  const selected = option.value === choice.value, busy = pending === option.id;
  return <Pressable accessibilityRole="radio" accessibilityLabel={choiceText(option, choice, locale === 'zh-CN')} accessibilityState={{ checked: selected, selected, disabled: disabled || !!pending || selected, busy }} disabled={disabled || !!pending || selected} onPress={() => onChoose(option, choice)} style={({ pressed }) => [styles.choice, { borderColor: selected ? theme.primary : theme.line, backgroundColor: selected ? theme.chip : theme.surface, opacity: pending && !busy ? .55 : pressed ? .72 : 1 }]}>
    <View style={styles.choiceCopy}><Text maxFontSizeMultiplier={1.5} style={{ color: theme.text, fontWeight: selected ? '800' : '600' }}>{choiceText(option, choice, locale === 'zh-CN')}</Text>{!!choice.description && <Text maxFontSizeMultiplier={1.6} style={{ color: theme.muted }}>{choice.description}</Text>}</View>
    {busy ? <Text style={{ color: theme.text }}>…</Text> : selected ? <Text accessibilityLabel={copy(locale, 'Selected', '已选择')} style={{ color: theme.primary, fontWeight: '800' }}>✓</Text> : isRecommended(option, choice) ? <Text style={[styles.recommended, { color: theme.text }]}>{copy(locale, 'Recommended', '推荐')}</Text> : null}
  </Pressable>;
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: space.md, paddingBottom: space.md, gap: space.sm },
  notice: { borderRadius: 12, padding: space.sm, flexDirection: 'row', alignItems: 'center', gap: space.sm },
  option: { gap: 6 }, section: { fontSize: 13, lineHeight: 18, fontWeight: '800', letterSpacing: .35, textTransform: 'uppercase', marginTop: space.sm }, description: { fontSize: 13, lineHeight: 18 }, group: { fontSize: 12, fontWeight: '800', marginTop: space.xs, marginBottom: 2 },
  choice: { minHeight: 44, borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: 4 }, choiceCopy: { flex: 1, minWidth: 0, gap: 2 }, recommended: { fontSize: 12, fontWeight: '800' },
  search: { minHeight: 44, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, fontSize: 16 }, empty: { paddingVertical: space.lg, gap: space.sm, alignItems: 'flex-start' },
});
