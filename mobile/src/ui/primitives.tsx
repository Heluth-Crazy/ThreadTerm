import React, { PropsWithChildren } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, TextInput, View, type StyleProp, type TextInputProps, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon, type IconName, statusColor } from './icons';
import type { Theme } from './theme';
import { radius, space } from './theme';

export function Button({ theme, label, onPress, tone = 'secondary', icon, disabled, small = false, accessibilityHint }: {
  theme: Theme; label: string; onPress: () => void; tone?: 'primary' | 'secondary' | 'destructive' | 'plain'; icon?: IconName; disabled?: boolean; small?: boolean; accessibilityHint?: string;
}) {
  const foreground = tone === 'primary' ? theme.primaryText : tone === 'destructive' ? theme.red : tone === 'plain' ? theme.primary : theme.text;
  const background = tone === 'primary' ? theme.primary : tone === 'destructive' ? `${theme.red}14` : tone === 'plain' ? 'transparent' : theme.raised;
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityHint={accessibilityHint} disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.button, small && styles.buttonSmall, { backgroundColor: background, opacity: disabled ? .46 : pressed ? .72 : 1 }, tone === 'secondary' && { borderColor: theme.line, borderWidth: StyleSheet.hairlineWidth }]}>
    {icon && <Icon name={icon} color={foreground} size={small ? 18 : 20} />}
    <Text maxFontSizeMultiplier={1.8} style={[styles.buttonText, small && styles.buttonTextSmall, { color: foreground }]}>{label}</Text>
  </Pressable>;
}

export function IconButton({ theme, icon, label, onPress, badge, disabled }: { theme: Theme; icon: IconName; label: string; onPress: () => void; badge?: number; disabled?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.iconButton, { backgroundColor: pressed ? theme.raised : 'transparent', opacity: disabled ? .42 : 1 }]}>
    <Icon name={icon} color={theme.primary} />
    {!!badge && <View accessibilityLabel={`${badge}`} style={[styles.badge, { backgroundColor: theme.red }]}><Text style={styles.badgeText}>{badge > 99 ? '99+' : badge}</Text></View>}
  </Pressable>;
}

export function Card({ theme, children, style }: PropsWithChildren<{ theme: Theme; style?: StyleProp<ViewStyle> }>) {
  return <View style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.line }, style]}>{children}</View>;
}

export function PageTitle({ theme, title, subtitle, left, right }: { theme: Theme; title: string; subtitle?: string; left?: React.ReactNode; right?: React.ReactNode }) {
  return <View style={styles.pageTitle}>
    <View style={styles.titleLine}>{left}<View style={styles.titleCopy}><Text maxFontSizeMultiplier={1.45} style={[styles.largeTitle, { color: theme.text }]}>{title}</Text>{!!subtitle && <Text maxFontSizeMultiplier={1.6} style={[styles.subtitle, { color: theme.muted }]}>{subtitle}</Text>}</View>{right}</View>
  </View>;
}

export function SectionTitle({ theme, children, action }: PropsWithChildren<{ theme: Theme; action?: React.ReactNode }>) {
  return <View style={styles.sectionTitle}><Text maxFontSizeMultiplier={1.5} style={[styles.sectionLabel, { color: theme.muted }]}>{children}</Text>{action}</View>;
}

export function StatusDot({ theme, state, label }: { theme: Theme; state?: string; label?: string }) {
  const color = statusColor(theme, state);
  return <View style={styles.statusDotRow}><View style={[styles.statusDot, { backgroundColor: color }]} />{!!label && <Text maxFontSizeMultiplier={1.5} style={[styles.statusDotText, { color }]}>{label}</Text>}</View>;
}

export function Pill({ theme, children, tone = 'neutral' }: PropsWithChildren<{ theme: Theme; tone?: 'neutral' | 'primary' | 'success' | 'warning' | 'danger' }>) {
  const colors = tone === 'primary' ? [theme.chip, theme.primary] : tone === 'success' ? [`${theme.green}18`, theme.green] : tone === 'warning' ? [`${theme.amber}1C`, theme.amber] : tone === 'danger' ? [`${theme.red}19`, theme.red] : [theme.raised, theme.muted];
  return <View style={[styles.pill, { backgroundColor: colors[0] }]}><Text maxFontSizeMultiplier={1.4} style={[styles.pillText, { color: colors[1] }]}>{children}</Text></View>;
}

export function Separator({ theme }: { theme: Theme }) { return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: theme.line }} />; }

export function Field({ theme, label, value, onChangeText, placeholder, multiline, secureTextEntry, autoCapitalize = 'sentences', accessibilityHint, testID }: {
  theme: Theme; label?: string; value: string; onChangeText: (value: string) => void; placeholder?: string; multiline?: boolean; secureTextEntry?: boolean; autoCapitalize?: TextInputProps['autoCapitalize']; accessibilityHint?: string; testID?: string;
}) {
  return <View style={styles.fieldWrap}>{!!label && <Text maxFontSizeMultiplier={1.5} style={[styles.fieldLabel, { color: theme.muted }]}>{label}</Text>}<TextInput testID={testID} accessibilityLabel={label ?? placeholder} accessibilityHint={accessibilityHint} value={value} onChangeText={onChangeText} placeholder={placeholder} placeholderTextColor={theme.faint} multiline={multiline} secureTextEntry={secureTextEntry} autoCapitalize={autoCapitalize} style={[styles.field, multiline && styles.fieldMultiline, { backgroundColor: theme.input, borderColor: theme.line, color: theme.text }]} textAlignVertical={multiline ? 'top' : 'center'} /></View>;
}

export function EmptyState({ theme, icon, title, detail, action }: { theme: Theme; icon: IconName; title: string; detail: string; action?: React.ReactNode }) {
  return <View style={styles.empty}><View style={[styles.emptyIcon, { backgroundColor: theme.raised }]}><Icon name={icon} color={theme.primary} size={28} /></View><Text maxFontSizeMultiplier={1.5} style={[styles.emptyTitle, { color: theme.text }]}>{title}</Text><Text maxFontSizeMultiplier={1.7} style={[styles.emptyDetail, { color: theme.muted }]}>{detail}</Text>{action}</View>;
}

export function Sheet({ theme, visible, title, onDismiss, children, closeLabel = 'Close', dismissLabel = 'Dismiss' }: PropsWithChildren<{ theme: Theme; visible: boolean; title: string; onDismiss: () => void; closeLabel?: string; dismissLabel?: string }>) {
  const insets = useSafeAreaInsets();
  return <Modal visible={visible} animationType="slide" transparent onRequestClose={onDismiss} presentationStyle="overFullScreen">
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={[styles.sheetAvoidance, { paddingTop: insets.top }]}>
      <Pressable accessibilityRole="button" accessibilityLabel={dismissLabel} onPress={onDismiss} style={[styles.scrim, { backgroundColor: theme.overlay }]} />
      <View accessibilityViewIsModal style={[styles.sheet, { backgroundColor: theme.background, borderColor: theme.line, paddingBottom: Math.max(space.lg, insets.bottom) }]}>
        <View style={[styles.grabber, { backgroundColor: theme.faint }]} /><View style={styles.sheetHead}><Text maxFontSizeMultiplier={1.4} style={[styles.sheetTitle, { color: theme.text }]}>{title}</Text><IconButton theme={theme} icon="close" label={closeLabel} onPress={onDismiss} /></View>{children}
      </View>
    </KeyboardAvoidingView>
  </Modal>;
}

export function Loading({ theme, label = 'Loading…' }: { theme: Theme; label?: string }) { return <View style={styles.loading}><ActivityIndicator color={theme.primary} /><Text style={{ color: theme.muted }}>{label}</Text></View>; }

const styles = StyleSheet.create({
  button: { minHeight: 46, paddingHorizontal: 16, borderRadius: radius.medium, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8 },
  buttonSmall: { minHeight: 44, paddingHorizontal: 12 }, buttonText: { fontSize: 16, lineHeight: 21, fontWeight: '700' }, buttonTextSmall: { fontSize: 14, lineHeight: 18 },
  iconButton: { minWidth: 44, minHeight: 44, padding: 10, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center', position: 'relative' }, badge: { minWidth: 18, height: 18, paddingHorizontal: 4, borderRadius: 9, position: 'absolute', right: 2, top: 2, alignItems: 'center', justifyContent: 'center' }, badgeText: { color: '#fff', fontSize: 11, fontWeight: '800' },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.large, overflow: 'hidden', shadowColor: '#000', shadowOpacity: .045, shadowRadius: 10, shadowOffset: { width: 0, height: 4 }, elevation: 1 },
  pageTitle: { paddingHorizontal: space.md, paddingTop: space.xs, paddingBottom: space.md }, titleLine: { flexDirection: 'row', alignItems: 'flex-start', gap: space.xs }, titleCopy: { flex: 1, minWidth: 0 }, largeTitle: { fontSize: 34, lineHeight: 40, letterSpacing: -.8, fontWeight: '800' }, subtitle: { marginTop: 3, fontSize: 16, lineHeight: 22 },
  sectionTitle: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: space.md, paddingTop: space.lg, paddingBottom: space.xs }, sectionLabel: { fontSize: 13, fontWeight: '700', letterSpacing: .5, textTransform: 'uppercase' },
  statusDotRow: { flexDirection: 'row', alignItems: 'center', gap: 6 }, statusDot: { width: 9, height: 9, borderRadius: 5 }, statusDotText: { fontSize: 13, fontWeight: '700' },
  pill: { alignSelf: 'flex-start', paddingHorizontal: 9, minHeight: 25, borderRadius: radius.pill, justifyContent: 'center' }, pillText: { fontSize: 12, lineHeight: 16, fontWeight: '700' },
  fieldWrap: { gap: 6 }, fieldLabel: { fontSize: 13, fontWeight: '600' }, field: { minHeight: 46, borderRadius: radius.small, borderWidth: 1, paddingHorizontal: 12, fontSize: 16, lineHeight: 22 }, fieldMultiline: { minHeight: 104, paddingTop: 12, paddingBottom: 12 },
  empty: { alignItems: 'center', paddingHorizontal: 30, paddingVertical: 44, gap: 10 }, emptyIcon: { width: 64, height: 64, borderRadius: 22, alignItems: 'center', justifyContent: 'center', marginBottom: 2 }, emptyTitle: { fontSize: 18, lineHeight: 24, fontWeight: '800', textAlign: 'center' }, emptyDetail: { fontSize: 15, lineHeight: 22, textAlign: 'center' },
  scrim: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 }, sheetAvoidance: { flex: 1, justifyContent: 'flex-end' }, sheet: { maxHeight: '90%', flexShrink: 1, paddingBottom: space.lg, borderTopLeftRadius: 24, borderTopRightRadius: 24, borderWidth: StyleSheet.hairlineWidth }, grabber: { width: 38, height: 4, borderRadius: 2, alignSelf: 'center', marginTop: 9, marginBottom: 5 }, sheetHead: { flexShrink: 0, minHeight: 54, flexDirection: 'row', paddingLeft: space.md, paddingRight: space.xs, alignItems: 'center', justifyContent: 'space-between' }, sheetTitle: { fontSize: 19, fontWeight: '800' },
  loading: { padding: 32, alignItems: 'center', justifyContent: 'center', gap: 12 },
});
