import React, { useState } from 'react';
import { Alert, Pressable, StatusBar, StyleSheet, Text, View, useColorScheme } from 'react-native';
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { CompanionProvider, useCompanion } from './src/core/react';
import type { AttentionItem, SessionRef } from './src/core/types';
import { Icon, type IconName } from './src/ui/icons';
import { ChatListScreen, SessionDetailScreen } from './src/ui/ChatScreen';
import { NeedsYouScreen } from './src/ui/NeedsYouScreen';
import { ProjectsScreen, type ProjectRoute } from './src/ui/ProjectsScreen';
import { ResourceScreen, type ResourceRoute } from './src/ui/ResourceScreen';
import { NewSessionSheet } from './src/ui/NewSessionSheet';
import { SettingsScreen } from './src/ui/SettingsScreen';
import { resolveTheme } from './src/ui/theme';

type Tab = 'needs' | 'projects' | 'chat' | 'settings';
type Detail = { kind: 'session'; ref: SessionRef } | { kind: 'resource'; route: ResourceRoute };

export default function App() {
  return <SafeAreaProvider><CompanionProvider><CompanionApp /></CompanionProvider></SafeAreaProvider>;
}

export function CompanionApp() {
  const { state, controller } = useCompanion();
  const theme = resolveTheme(state.preferences.appearance, useColorScheme() ?? 'light');
  const insets = useSafeAreaInsets();
  const zh = state.preferences.locale === 'zh-CN';
  const [tab, setTab] = useState<Tab>('needs');
  const [projectRoute, setProjectRoute] = useState<ProjectRoute>({ kind: 'computers' });
  const [details, setDetails] = useState<Detail[]>([]);
  const [newSession, setNewSession] = useState(false);
  const detail = details.at(-1);
  const back = () => setDetails(current => current.slice(0, -1));
  const openSession = (ref: SessionRef) => setDetails([{ kind: 'session', ref }]);
  const openAttention = (attention: AttentionItem) => { setTab('needs'); openSession(attention.ref); };
  const showError = (error: unknown) => Alert.alert(zh ? '操作失败' : 'Action failed', error instanceof Error ? error.message : String(error));
  const openSessionResource = (kind: 'files' | 'git', ref: SessionRef) => {
    const machine = state.machines.find(item => item.id === ref.machineId);
    const session = machine?.snapshot?.sessions.find(item => item.id === ref.sessionId);
    const project = machine?.snapshot?.projects.find(item => item.id === session?.projectId);
    const worktreePath = session?.worktreePath ?? project?.path;
    if (!session?.projectId || !worktreePath) {
      showError(zh ? '此会话没有已登记的项目目录。' : 'This session has no registered project directory.');
      return;
    }
    const projectId = session.projectId;
    setDetails(current => [...current, { kind: 'resource', route: { kind, machineId: ref.machineId, projectId, worktreePath } }]);
  };
  if (!state.initialized) return <SafeAreaView style={[styles.fill, { backgroundColor: theme.background }]}>
    <View style={styles.boot}><Icon name="computer" color={theme.primary} size={36} />
      <Text style={[styles.bootText, { color: theme.text }]}>{state.error ?? 'ThreadTerm'}</Text>
    </View>
  </SafeAreaView>;

  let page: React.ReactNode;
  if (detail?.kind === 'session') page = <SessionDetailScreen theme={theme} state={state} controller={controller} ref={detail.ref} onBack={back}
    onFiles={() => openSessionResource('files', detail.ref)} onGit={() => openSessionResource('git', detail.ref)} />;
  else if (detail?.kind === 'resource') page = <ResourceScreen theme={theme} state={state} controller={controller} route={detail.route} onBack={back}
    onRoute={route => setDetails(current => [...current, { kind: 'resource', route }])} />;
  else if (tab === 'needs') page = <NeedsYouScreen theme={theme} state={state} controller={controller} onOpenSession={openAttention} />;
  else if (tab === 'projects') page = <ProjectsScreen theme={theme} state={state} controller={controller} route={projectRoute} onRoute={setProjectRoute}
    onOpenSession={openSession} onOpenResource={route => setDetails([{ kind: 'resource', route }])}
    onConnect={machineId => void controller.connect(machineId).catch(showError)} onAddComputer={() => setTab('settings')} onNewSession={() => setNewSession(true)} />;
  else if (tab === 'chat') page = <ChatListScreen theme={theme} state={state} controller={controller} onOpenSession={openSession} onNew={() => setNewSession(true)} />;
  else page = <SettingsScreen theme={theme} state={state} controller={controller} />;

  const initial = tab === 'projects' && projectRoute.kind !== 'computers'
    ? { machineId: projectRoute.machineId, ...('projectId' in projectRoute ? { projectId: projectRoute.projectId } : {}), ...('worktreeId' in projectRoute ? { worktreeId: projectRoute.worktreeId } : {}) }
    : undefined;
  return <SafeAreaView style={[styles.fill, { backgroundColor: theme.background }]} edges={['top', 'left', 'right']}>
    <StatusBar barStyle={theme.background === '#262624' ? 'light-content' : 'dark-content'} />
    {state.error && <Pressable accessibilityRole="button" accessibilityLabel={zh ? '关闭错误提示' : 'Dismiss error'} onPress={() => controller.clearError()} style={[styles.error, { backgroundColor: theme.surface }]}>
      <Text style={{ color: theme.red, flex: 1 }}>{state.error}</Text><Icon name="close" color={theme.red} size={18} />
    </Pressable>}
    <View style={[styles.page, detail ? { paddingBottom: insets.bottom } : undefined]}>{page}</View>
    {!detail && <TabBar theme={theme} active={tab} attention={state.attention.length} bottom={insets.bottom} onChange={setTab} />}
    {newSession && <NewSessionSheet theme={theme} state={state} controller={controller} visible initial={initial}
      onCreated={openSession} onDismiss={() => setNewSession(false)} />}
  </SafeAreaView>;
}

function TabBar({ theme, active, attention, bottom, onChange }: { theme: ReturnType<typeof resolveTheme>; active: Tab; attention: number; bottom: number; onChange: (tab: Tab) => void }) {
  const locale = useCompanion().state.preferences.locale;
  const tabs: { id: Tab; label: string; labelZh: string; icon: IconName; badge?: number }[] = [
    { id: 'needs', label: 'Needs You', labelZh: '待处理', icon: 'bell', badge: attention },
    { id: 'projects', label: 'Projects', labelZh: '项目', icon: 'folder' },
    { id: 'chat', label: 'Chat', labelZh: '聊天', icon: 'chat' },
    { id: 'settings', label: 'Settings', labelZh: '设置', icon: 'settings' },
  ];
  return <View style={[styles.tabbar, { paddingBottom: Math.max(bottom, 8), backgroundColor: theme.surface, borderTopColor: theme.line }]}>
    {tabs.map(item => <Pressable key={item.id} accessibilityRole="tab" accessibilityState={{ selected: active === item.id }}
      accessibilityLabel={locale === 'zh-CN' ? item.labelZh : item.label} onPress={() => onChange(item.id)}
      style={({ pressed }) => [styles.tab, { opacity: pressed ? .68 : 1 }]}>
      <View style={styles.tabIcon}><Icon name={item.icon} color={active === item.id ? theme.primary : theme.muted} size={24} />
        {!!item.badge && <View style={[styles.tabBadge, { backgroundColor: theme.red }]}><Text style={styles.tabBadgeText}>{item.badge > 99 ? '99+' : item.badge}</Text></View>}
      </View>
      <Text maxFontSizeMultiplier={1.6} style={[styles.tabText, { color: active === item.id ? theme.primary : theme.muted }]}>{locale === 'zh-CN' ? item.labelZh : item.label}</Text>
    </Pressable>)}
  </View>;
}

const styles = StyleSheet.create({
  fill: { flex: 1 }, page: { flex: 1, minHeight: 0 },
  boot: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 }, bootText: { fontSize: 17, fontWeight: '800' },
  error: { padding: 12, minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 8 },
  tabbar: { flexDirection: 'row', borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 7 },
  tab: { minHeight: 49, flex: 1, alignItems: 'center', justifyContent: 'center', gap: 2 },
  tabIcon: { position: 'relative', height: 25 },
  tabBadge: { position: 'absolute', minWidth: 17, height: 17, borderRadius: 9, paddingHorizontal: 3, top: -6, right: -12, alignItems: 'center', justifyContent: 'center' },
  tabBadgeText: { color: '#fff', fontSize: 10, fontWeight: '800' }, tabText: { fontSize: 11, lineHeight: 14, fontWeight: '700' },
});

