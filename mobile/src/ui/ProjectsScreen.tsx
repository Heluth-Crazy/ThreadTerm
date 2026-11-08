import React, { useState } from "react";
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type {
  CompanionController,
  CompanionState,
  SessionRef,
} from "../core/types";
import { Icon } from "./icons";
import {
  Button,
  Card,
  EmptyState,
  PageTitle,
  Pill,
  SectionTitle,
  StatusDot,
} from "./primitives";
import type { ResourceRoute } from "./ResourceScreen";
import type { Theme } from "./theme";
import { space } from "./theme";
import { machineSummary, sessionStatusLabel, shortPath } from "./format";
import { sessionPresentation, sessionPresentationLabel } from '../core/projection';
import { sameWorkspacePath } from "./workspacePath";

export type ProjectRoute =
  | { kind: "computers" }
  | { kind: "machine"; machineId: string }
  | { kind: "project"; machineId: string; projectId: string }
  | {
      kind: "worktree";
      machineId: string;
      projectId: string;
      worktreeId: string;
    };
type Props = {
  theme: Theme;
  state: CompanionState;
  controller: CompanionController;
  route: ProjectRoute;
  onRoute: (route: ProjectRoute) => void;
  onOpenSession: (ref: SessionRef) => void;
  onOpenResource: (route: ResourceRoute) => void;
  onConnect: (machineId: string) => void;
  onAddComputer: () => void;
  onNewSession: () => void;
};
export function ProjectsScreen(props: Props) {
  const { route } = props;
  if (route.kind === "machine")
    return <Machine {...props} machineId={route.machineId} />;
  if (route.kind === "project")
    return (
      <Project
        {...props}
        machineId={route.machineId}
        projectId={route.projectId}
      />
    );
  if (route.kind === "worktree")
    return (
      <Worktree
        {...props}
        machineId={route.machineId}
        projectId={route.projectId}
        worktreeId={route.worktreeId}
      />
    );
  return <Computers {...props} />;
}
function Back({
  theme,
  title,
  onBack,
}: {
  theme: Theme;
  title: string;
  onBack: () => void;
}) {
  return (
    <PageTitle
      theme={theme}
      title={title}
      left={
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back"
          onPress={onBack}
          style={styles.back}
        >
          <Icon name="arrowLeft" color={theme.primary} />
        </Pressable>
      }
    />
  );
}
function Computers({ theme, state, onRoute, onConnect, onAddComputer }: Props) {
  const locale = state.preferences.locale;
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <PageTitle
        theme={theme}
        title={locale === "zh-CN" ? "项目" : "Projects"}
        right={
          <Button
            theme={theme}
            label={locale === "zh-CN" ? "添加" : "Add"}
            small
            icon="plus"
            onPress={onAddComputer}
          />
        }
      />
      <SectionTitle theme={theme}>
        {locale === "zh-CN" ? "电脑" : "Computers"}
      </SectionTitle>
      {state.machines.length ? (
        state.machines.map((machine) => {
          const attention = state.attention.filter(item => item.ref.machineId === machine.id).length;
          const synced = machine.syncedAt ? new Date(machine.syncedAt).toLocaleString() : undefined;
          return (
          <Pressable
            key={machine.id}
            accessibilityRole="button"
            accessibilityLabel={machine.name}
            onPress={() =>
              machine.status === "connected"
                ? onRoute({ kind: "machine", machineId: machine.id })
                : onConnect(machine.id)
            }
          >
            <Card theme={theme} style={styles.card}>
              <Icon name="computer" color={machine.color || theme.primary} />
              <View style={styles.grow}>
                <Text style={[styles.name, { color: theme.text }]}>
                  {machine.name}
                </Text>
                <StatusDot
                  theme={theme}
                  state={machine.status}
                  label={machineSummary(machine.status, locale)}
                />
                {machine.status !== "connected" && machine.snapshot && <Text style={{ color: theme.muted }}>{locale === "zh-CN" ? `缓存数据${synced ? ` · ${synced}` : ""}` : `Cached${synced ? ` · ${synced}` : ""}`}</Text>}
                {!!machine.error && (
                  <Text style={{ color: theme.red }}>{machine.error}</Text>
                )}
              </View>
              {attention > 0 && <Pill theme={theme} tone="warning">{attention}</Pill>}
              <Icon name="chevron" color={theme.faint} />
            </Card>
          </Pressable>
        )})
      ) : (
        <EmptyState
          theme={theme}
          icon="computer"
          title={locale === "zh-CN" ? "还没有电脑" : "No paired computers"}
          detail={
            locale === "zh-CN"
              ? "添加一台电脑开始。"
              : "Add a computer to start."
          }
        />
      )}
    </ScrollView>
  );
}
function Machine({
  theme,
  state,
  route,
  onRoute,
  onOpenSession,
  machineId,
}: Props & { machineId: string }) {
  const locale = state.preferences.locale,
    machine = state.machines.find((m) => m.id === machineId),
    projects = machine?.snapshot?.projects ?? [],
    otherSessions = machine?.snapshot?.sessions.filter(session => !session.projectId || !projects.some(project => project.id === session.projectId)) ?? [];
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Back
        theme={theme}
        title={machine?.name ?? "Computer"}
        onBack={() => onRoute({ kind: "computers" })}
      />
      {!!machine?.error && (
        <Text style={[styles.error, { color: theme.red }]}>
          {machine.error}
        </Text>
      )}
      <SectionTitle theme={theme}>
        {locale === "zh-CN" ? "项目" : "Projects"}
      </SectionTitle>
      {projects.map((project) => (
        <Pressable
          key={project.id}
          accessibilityRole="button"
          accessibilityLabel={project.name}
          onPress={() =>
            onRoute({ kind: "project", machineId, projectId: project.id })
          }
        >
          <Card theme={theme} style={styles.card}>
            <Icon name="folder" color={theme.primary} />
            <View style={styles.grow}>
              <Text style={[styles.name, { color: theme.text }]}>
                {project.name}
              </Text>
              <Text style={{ color: theme.muted }}>
                {project.git.branch ??
                  (locale === "zh-CN" ? "普通文件夹" : "Directory")}
              </Text>
            </View>
            <Icon name="chevron" color={theme.faint} />
          </Card>
        </Pressable>
      ))}
      {!!otherSessions.length && <><SectionTitle theme={theme}>{locale === "zh-CN" ? "未归属会话" : "Unassigned sessions"}</SectionTitle><SessionRows theme={theme} locale={locale} sessions={otherSessions} machineId={machineId} onOpenSession={onOpenSession}/></>}
    </ScrollView>
  );
}
function Project({
  theme,
  state,
  controller,
  onRoute,
  onOpenSession,
  onOpenResource,
  onNewSession,
  machineId,
  projectId,
}: Props & { machineId: string; projectId: string }) {
  const locale = state.preferences.locale,
    machine = state.machines.find((m) => m.id === machineId),
    project = machine?.snapshot?.projects.find((p) => p.id === projectId),
    worktrees =
      machine?.snapshot?.worktrees.filter((w) => w.projectId === projectId) ??
      [],
    sessions =
      machine?.snapshot?.sessions.filter((s) => s.projectId === projectId) ??
      [];
  const resource = (kind: "files" | "git", path: string) =>
    onOpenResource({ kind, machineId, projectId, worktreePath: path });
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Back
        theme={theme}
        title={project?.name ?? "Project"}
        onBack={() => onRoute({ kind: "machine", machineId })}
      />
      {project && (
        <>
          <View style={styles.tiles}>
            <Button
              theme={theme}
              label={locale === "zh-CN" ? "文件" : "Files"}
              icon="file"
              small
              onPress={() => resource("files", project.path)}
            />
            <Button
              theme={theme}
              label={locale === "zh-CN" ? "变更" : "Changes"}
              icon="git"
              small
              onPress={() => resource("git", project.path)}
            />
            <Button
              theme={theme}
              label={locale === "zh-CN" ? "新会话" : "New session"}
              icon="plus"
              small
              onPress={onNewSession}
            />
          </View>
          <PreviewLauncher
            theme={theme}
            controller={controller}
            machineId={machineId}
            locale={locale}
          />
        </>
      )}
      <SectionTitle theme={theme}>
        {worktrees.length
          ? locale === "zh-CN"
            ? "工作区"
            : "Worktrees"
          : locale === "zh-CN"
            ? "会话"
            : "Sessions"}
      </SectionTitle>
      {worktrees.length ? (
        worktrees.map((w) => (
          <Pressable
            key={w.id}
            accessibilityRole="button"
            accessibilityLabel={w.branch ?? w.path}
            onPress={() =>
              onRoute({
                kind: "worktree",
                machineId,
                projectId,
                worktreeId: w.id,
              })
            }
          >
            <Card theme={theme} style={styles.card}>
              <Icon name="git" color={theme.primary} />
              <View style={styles.grow}>
                <Text style={[styles.name, { color: theme.text }]}>
                  {w.branch ?? shortPath(w.path)}
                </Text>
                <Text style={{ color: theme.muted }}>
                  {w.isMain ? "main" : shortPath(w.path)}
                </Text>
              </View>
              <Icon name="chevron" color={theme.faint} />
            </Card>
          </Pressable>
        ))
      ) : (
        <SessionRows
          theme={theme}
          locale={locale}
          sessions={sessions}
          machineId={machineId}
          onOpenSession={onOpenSession}
        />
      )}
    </ScrollView>
  );
}
function Worktree({
  theme,
  state,
  onRoute,
  onOpenSession,
  onOpenResource,
  onNewSession,
  machineId,
  projectId,
  worktreeId,
}: Props & { machineId: string; projectId: string; worktreeId: string }) {
  const locale = state.preferences.locale,
    machine = state.machines.find((m) => m.id === machineId),
    worktree = machine?.snapshot?.worktrees.find((w) => w.id === worktreeId),
    sessions =
      machine?.snapshot?.sessions.filter(
        (s) => s.projectId === projectId && sameWorkspacePath(s.worktreePath ?? machine?.snapshot?.projects.find(project => project.id === projectId)?.path, worktree?.path),
      ) ?? [];
  const resource = (kind: "files" | "git") =>
    worktree &&
    onOpenResource({ kind, machineId, projectId, worktreePath: worktree.path });
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Back
        theme={theme}
        title={worktree?.branch ?? (shortPath(worktree?.path) || "Worktree")}
        onBack={() => onRoute({ kind: "project", machineId, projectId })}
      />
      <View style={styles.tiles}>
        <Button
          theme={theme}
          label={locale === "zh-CN" ? "文件" : "Files"}
          icon="file"
          small
          onPress={() => resource("files")}
        />
        <Button
          theme={theme}
          label={locale === "zh-CN" ? "变更" : "Changes"}
          icon="git"
          small
          onPress={() => resource("git")}
        />
        <Button
          theme={theme}
          label={locale === "zh-CN" ? "新会话" : "New session"}
          icon="plus"
          small
          onPress={onNewSession}
        />
      </View>
      <SectionTitle theme={theme}>
        {locale === "zh-CN" ? "会话" : "Sessions"}
      </SectionTitle>
      <SessionRows
        theme={theme}
        locale={locale}
        sessions={sessions}
        machineId={machineId}
        onOpenSession={onOpenSession}
      />
    </ScrollView>
  );
}
function SessionRows({
  theme,
  locale,
  sessions,
  machineId,
  onOpenSession,
}: {
  theme: Theme;
  locale: CompanionState["preferences"]["locale"];
  sessions: NonNullable<
    CompanionState["machines"][number]["snapshot"]
  >["sessions"];
  machineId: string;
  onOpenSession: (ref: SessionRef) => void;
}) {
  return sessions.length ? (
    sessions.map((s) => (
      <Pressable
        key={s.id}
        accessibilityRole="button"
        accessibilityLabel={s.title}
        onPress={() => onOpenSession({ machineId, sessionId: s.id })}
      >
        <Card theme={theme} style={styles.card}>
          <Icon name="chat" color={theme.primary} />
          <View style={styles.grow}>
            <Text style={[styles.name, { color: theme.text }]}>{s.title}</Text>
            <Text style={{ color: theme.muted }}>
              {sessionPresentationLabel(s, locale) === s.status ? sessionStatusLabel(s.status, locale) : sessionPresentationLabel(s, locale)}
            </Text>
          </View>
          <StatusDot theme={theme} state={sessionPresentation(s) === 'needs_user' ? 'waiting' : sessionPresentation(s) === 'unread_reply' ? 'unread_reply' : s.status} />
        </Card>
      </Pressable>
    ))
  ) : (
    <EmptyState
      theme={theme}
      icon="chat"
      title={locale === "zh-CN" ? "还没有会话" : "No sessions yet"}
      detail={
        locale === "zh-CN" ? "创建一个会话开始。" : "Start a new session."
      }
    />
  );
}
function PreviewLauncher({
  theme,
  controller,
  machineId,
  locale,
}: {
  theme: Theme;
  controller: CompanionController;
  machineId: string;
  locale: CompanionState["preferences"]["locale"];
}) {
  const [url, setUrl] = useState("");
  const open = async () => {
    try {
      await controller.openPreview(machineId, url.trim());
    } catch (error) {
      Alert.alert(
        locale === "zh-CN" ? "无法打开预览" : "Could not open preview",
        error instanceof Error ? error.message : String(error),
      );
    }
  };
  return (
    <View style={styles.preview}>
      <TextInput
        accessibilityLabel={locale === "zh-CN" ? "预览地址" : "Preview URL"}
        autoCapitalize="none"
        keyboardType="url"
        value={url}
        onChangeText={setUrl}
        placeholder="https://…"
        placeholderTextColor={theme.faint}
        style={[
          styles.previewInput,
          {
            color: theme.text,
            borderColor: theme.line,
            backgroundColor: theme.input,
          },
        ]}
      />
      <Button
        theme={theme}
        label={locale === "zh-CN" ? "预览" : "Preview"}
        icon="eye"
        small
        disabled={!url.trim()}
        onPress={() => void open()}
      />
    </View>
  );
}
const styles = StyleSheet.create({
  content: { paddingBottom: 120 },
  back: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: -8,
  },
  card: {
    marginHorizontal: space.md,
    marginBottom: space.xs,
    minHeight: 64,
    padding: 13,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  grow: { flex: 1, minWidth: 0, gap: 3 },
  name: { fontSize: 16, fontWeight: "800" },
  error: { paddingHorizontal: space.md },
  tiles: {
    paddingHorizontal: space.md,
    flexDirection: "row",
    gap: 8,
    flexWrap: "wrap",
  },
  preview: { padding: space.md, flexDirection: "row", gap: 8 },
  previewInput: {
    flex: 1,
    minHeight: 40,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 10,
  },
});
