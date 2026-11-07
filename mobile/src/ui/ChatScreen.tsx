import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type {
  ChatApprovalData,
  ChatItem,
  ChatPart,
  Session,
} from "@threadterm/protocol";
import type {
  CompanionController,
  CompanionState,
  SessionRef,
  SessionView,
} from "../core/types";
import { sessionKey } from "../core/types";
import { Icon } from "./icons";
import {
  Button,
  Card,
  EmptyState,
  IconButton,
  Pill,
  StatusDot,
} from "./primitives";
import type { Theme } from "./theme";
import { space } from "./theme";
import { sessionStatusLabel, timeLabel } from "./format";
import { ApprovalCard } from "./ApprovalCard";
import {
  groupCodexTranscript,
  type CodexTurn,
} from "../../../renderer/src/codexTranscript";
import { stripAnsi } from "../../../renderer/src/chatContext";

export function ChatListScreen({
  theme,
  state,
  onOpenSession,
  onNew,
}: {
  theme: Theme;
  state: CompanionState;
  controller: CompanionController;
  onOpenSession: (ref: SessionRef) => void;
  onNew: () => void;
}) {
  const locale = state.preferences.locale;
  const [machineFilter, setMachineFilter] = useState<string>();
  const [projectFilter, setProjectFilter] = useState<string>();
  const projects = state.machines.flatMap(machine => (machine.snapshot?.projects ?? []).map(project => ({ ...project, machineId: machine.id, machineName: machine.name })));
  const rows = useMemo(
    () =>
      state.machines
        .flatMap((m) => (m.snapshot?.sessions ?? []).map((s) => ({ m, s })))
        .filter(({ m, s }) => (!machineFilter || m.id === machineFilter) && (!projectFilter || s.projectId === projectFilter))
        .sort((a, b) => Date.parse(b.s.updatedAt) - Date.parse(a.s.updatedAt)),
    [state.machines, machineFilter, projectFilter],
  );
  return (
    <ScrollView contentContainerStyle={styles.list}>
      <View style={styles.listHead}>
        <Text style={[styles.title, { color: theme.text }]}>
          {locale === "zh-CN" ? "聊天" : "Chat"}
        </Text>
        <IconButton
          theme={theme}
          icon="plus"
          label="New session"
          onPress={onNew}
        />
      </View>
      <View style={styles.filters}>
        <Button theme={theme} small tone={!machineFilter ? "primary" : "secondary"} label={locale === "zh-CN" ? "所有电脑" : "All computers"} onPress={() => { setMachineFilter(undefined); setProjectFilter(undefined); }} />
        {state.machines.map(machine => <Button key={machine.id} theme={theme} small tone={machineFilter === machine.id ? "primary" : "secondary"} label={machine.name} onPress={() => { setMachineFilter(machine.id); setProjectFilter(undefined); }} />)}
      </View>
      {!!machineFilter && <View style={styles.filters}>{projects.filter(project => project.machineId === machineFilter).map(project => <Button key={project.id} theme={theme} small tone={projectFilter === project.id ? "primary" : "secondary"} label={project.name} onPress={() => setProjectFilter(projectFilter === project.id ? undefined : project.id)} />)}</View>}
      {rows.length ? (
        rows.map(({ m, s }) => (
          <Pressable
            key={`${m.id}:${s.id}`}
            accessibilityRole="button"
            accessibilityLabel={`${s.title}, ${m.name}`}
            onPress={() => onOpenSession({ machineId: m.id, sessionId: s.id })}
          >
            <Card theme={theme} style={styles.row}>
              <Icon name="chat" color={m.color || theme.primary} />
              <View style={styles.grow}>
                <Text
                  numberOfLines={1}
                  style={[styles.name, { color: theme.text }]}
                >
                  {s.title}
                </Text>
                <Text style={{ color: theme.primary }}>{m.name}</Text>
                {s.projectId && <Text style={{ color: theme.muted }}>{m.snapshot?.projects.find(project => project.id === s.projectId)?.name ?? (locale === "zh-CN" ? "未归属项目" : "Unassigned project")}</Text>}
                <Text style={{ color: theme.muted }}>
                  {timeLabel(s.updatedAt, locale)}
                </Text>
              </View>
              <StatusDot theme={theme} state={s.status} />
            </Card>
          </Pressable>
        ))
      ) : (
        <EmptyState
          theme={theme}
          icon="chat"
          title={locale === "zh-CN" ? "还没有会话" : "No sessions yet"}
          detail={
            locale === "zh-CN"
              ? "在已连接电脑上创建会话。"
              : "Create a session on a connected computer."
          }
          action={<Button theme={theme} label="New session" onPress={onNew} />}
        />
      )}
    </ScrollView>
  );
}

export function SessionDetailScreen({
  theme,
  state,
  controller,
  ref,
  onBack,
  onFiles,
  onGit,
}: {
  theme: Theme;
  state: CompanionState;
  controller: CompanionController;
  ref: SessionRef;
  onBack: () => void;
  onFiles: () => void;
  onGit: () => void;
}) {
  const locale = state.preferences.locale,
    [mode, setMode] = useState<"chat" | "terminal">("chat"),
    [busy, setBusy] = useState<string>();
  const machine = state.machines.find((m) => m.id === ref.machineId),
    session = machine?.snapshot?.sessions.find((s) => s.id === ref.sessionId),
    view = state.sessions[sessionKey(ref)];
  const run = (name: string, action: () => Promise<void>) => {
    if (busy) return;
    setBusy(name);
    void action()
      .catch(showError(locale))
      .finally(() => setBusy(undefined));
  };
  const takeOver = () =>
    Alert.alert(
      locale === "zh-CN" ? "接管控制？" : "Take over control?",
      locale === "zh-CN"
        ? "这会请求接管该会话的现有控制租约。"
        : "This requests takeover of the existing control lease.",
      [
        { text: locale === "zh-CN" ? "取消" : "Cancel", style: "cancel" },
        {
          text: locale === "zh-CN" ? "接管" : "Take over",
          style: "destructive",
          onPress: () =>
            run("takeover", () => controller.claimControl(ref, true)),
        },
      ],
    );
  useEffect(() => {
    void controller.openSession(ref).catch(showError(locale));
    return () => {
      void controller.closeSession().catch(showError(locale));
    };
  }, [controller, ref.machineId, ref.sessionId]);
  useEffect(() => {
    if (session?.mode === "terminal") setMode("terminal");
    if (session?.mode === "chat") setMode("chat");
  }, [session?.mode]);
  if (!session)
    return (
      <EmptyState
        theme={theme}
        icon="warning"
        title="Session unavailable"
        detail="It may have been removed."
        action={<Button theme={theme} label="Back" onPress={onBack} />}
      />
    );
  const canControl =
    machine?.permission === "fullcontrol" &&
    machine.status === "connected" &&
    !machine.syncing &&
    !session.readOnly &&
    !session.archived;
  const activeTurnId = [
    "running",
    "awaiting_approval",
    "awaiting_input",
  ].includes(session.activity?.state ?? "")
    ? session.activity?.turnId
    : undefined;
  return (
    <KeyboardAvoidingView
      style={[styles.detail, { backgroundColor: theme.background }]}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={styles.head}>
        <IconButton
          theme={theme}
          icon="arrowLeft"
          label="Back"
          onPress={onBack}
        />
        <View style={styles.grow}>
          <Text style={[styles.name, { color: theme.text }]}>
            {session.title}
          </Text>
          <Text style={{ color: theme.muted }}>
            {machine?.name} · {session.provider}
          </Text>
        </View>
        <IconButton
          theme={theme}
          icon="more"
          label="Resources"
          onPress={() =>
            Alert.alert("Resources", undefined, [
              { text: locale === "zh-CN" ? "文件" : "Files", onPress: onFiles },
              { text: locale === "zh-CN" ? "变更" : "Changes", onPress: onGit },
              { text: "Cancel", style: "cancel" },
            ])
          }
        />
      </View>
      <View style={styles.mode}>
        {session.mode === "chat" && (
          <Button
            theme={theme}
            label="Chat"
            small
            tone={mode === "chat" ? "primary" : "secondary"}
            onPress={() => setMode("chat")}
          />
        )}
        <Button
          theme={theme}
          label="Terminal"
          small
          tone={mode === "terminal" ? "primary" : "secondary"}
          disabled={session.mode !== "terminal"}
          onPress={() => setMode("terminal")}
        />
        <StatusDot
          theme={theme}
          state={session.status}
          label={sessionStatusLabel(session.status, locale)}
        />
      </View>
      {canControl && (
        <View style={styles.lifecycle}>
          {!session.readOnly && !view?.leaseEpoch && (
            <Button
              theme={theme}
              label={
                busy === "claim"
                  ? "…"
                  : locale === "zh-CN"
                    ? "获取控制"
                    : "Control"
              }
              small
              disabled={!!busy}
              onPress={() => run("claim", () => controller.claimControl(ref))}
            />
          )}
          {!session.readOnly && !view?.leaseEpoch && (
            <Button
              theme={theme}
              label={locale === "zh-CN" ? "接管" : "Take over"}
              small
              tone="secondary"
              disabled={!!busy}
              onPress={takeOver}
            />
          )}
          {session.status === "exited" || session.status === "interrupted" ? (
            <Button
              theme={theme}
              label={locale === "zh-CN" ? "恢复" : "Resume"}
              small
              disabled={!!busy}
              onPress={() => run("resume", () => controller.resume(ref))}
            />
          ) : (
            <Button
              theme={theme}
              label={locale === "zh-CN" ? "停止" : "Stop"}
              small
              tone="destructive"
              disabled={!!busy || !view?.leaseEpoch}
              onPress={() => run("stop", () => controller.stop(ref))}
            />
          )}
          {activeTurnId && (
            <Button
              theme={theme}
              label={locale === "zh-CN" ? "取消当前轮次" : "Cancel turn"}
              small
              tone="secondary"
              disabled={!!busy || !view?.leaseEpoch}
              onPress={() =>
                run("cancel", () => controller.cancelTurn(ref, activeTurnId))
              }
            />
          )}
        </View>
      )}
      {(machine?.status !== "connected" || machine.syncing) && (
        <Text style={[styles.lock, { color: theme.amber }]}>
          {locale === "zh-CN"
            ? "显示上次同步的内容，重新连接后才能操作。"
            : "Showing the last synchronized content. Reconnect before acting."}
        </Text>
      )}
      {session.run?.url && (
        <Button
          theme={theme}
          label={locale === "zh-CN" ? "打开网页预览" : "Open web preview"}
          small
          disabled={machine?.status !== "connected" || machine.syncing}
          onPress={() =>
            void controller
              .openPreview(ref.machineId, session.run!.url!)
              .catch(showError(locale))
          }
        />
      )}
      {session.mode === "chat" ? (
        <ChatPanel
          theme={theme}
          state={state}
          controller={controller}
          ref={ref}
          view={view}
          session={session}
        />
      ) : (
        <Terminal
          theme={theme}
          state={state}
          controller={controller}
          ref={ref}
          view={view}
        />
      )}
    </KeyboardAvoidingView>
  );
}

function ChatPanel({
  theme,
  state,
  controller,
  ref,
  view,
  session,
}: {
  theme: Theme;
  state: CompanionState;
  controller: CompanionController;
  ref: SessionRef;
  view?: SessionView;
  session: Session;
}) {
  const locale = state.preferences.locale,
    scroll = useRef<React.ElementRef<typeof ScrollView>>(null),
    draft = state.drafts[sessionKey(ref)] ?? "",
    attachments = state.attachments[sessionKey(ref)] ?? [];
  const readonly =
    session.readOnly ||
    session.archived ||
    state.machines.find((m) => m.id === ref.machineId)?.permission !==
      "fullcontrol";
  const ready =
    state.machines.some(
      (m) => m.id === ref.machineId && m.status === "connected" && !m.syncing,
    ) && !view?.syncing;
  const control =
    state.controlUnlocked && !!view?.leaseEpoch && !readonly && ready;
  const [operation, setOperation] = useState<string>();
  const operationRef = useRef(false),
    followOutput = useRef(true);
  const groups = useMemo(
    () => groupCodexTranscript(view?.items ?? [], session.provider === "codex"),
    [view?.items, session.provider],
  );
  const providerReady = view?.connection?.phase === "ready";
  const unlock = () =>
    void controller
      .unlockControl()
      .then((ok) => {
        if (ok) return controller.claimControl(ref);
      })
      .catch((error) => showError(locale)(error));
  const add = async () => {
    if (operationRef.current) return;
    operationRef.current = true;
    setOperation("upload");
    try {
      if (!control) {
        unlock();
        return;
      }
      const picked = await controller.chooseAttachment();
      if (picked) await controller.uploadAttachment(ref, picked);
    } catch (error) {
      showError(locale)(error);
    } finally {
      operationRef.current = false;
      setOperation(undefined);
    }
  };
  const send = () => {
    if (operationRef.current) return;
    if (!providerReady) {
      void controller.connectChat(ref).catch(showError(locale));
      return;
    }
    if (!control) {
      unlock();
      return;
    }
    operationRef.current = true;
    setOperation("send");
    void controller
      .send(ref)
      .catch(showError(locale))
      .finally(() => {
        operationRef.current = false;
        setOperation(undefined);
      });
  };
  return (
    <View style={styles.panel}>
      <ScrollView
        ref={scroll}
        onContentSizeChange={() => {
          if (followOutput.current)
            scroll.current?.scrollToEnd({ animated: false });
        }}
        onScroll={({ nativeEvent }) => {
          followOutput.current =
            nativeEvent.layoutMeasurement.height +
              nativeEvent.contentOffset.y >=
            nativeEvent.contentSize.height - 64;
        }}
        scrollEventThrottle={100}
        contentContainerStyle={styles.transcript}
      >
        {view?.hasOlder && (
          <Button
            theme={theme}
            label={locale === "zh-CN" ? "加载更早内容" : "Load earlier"}
            small
            tone="secondary"
            disabled={view.loading || !ready}
            onPress={() => {
              followOutput.current = false;
              void controller.loadOlder(ref).catch(showError(locale));
            }}
          />
        )}
        {!providerReady && !readonly && (
          <Card theme={theme} style={styles.error}>
            <Text style={{ color: theme.muted }}>
              {locale === "zh-CN"
                ? "Agent 尚未连接。"
                : "The agent is not connected."}
            </Text>
            <Button
              theme={theme}
              label={locale === "zh-CN" ? "连接 Agent" : "Connect agent"}
              small
              onPress={() =>
                void controller.connectChat(ref).catch(showError(locale))
              }
            />
          </Card>
        )}
        {view?.error && (
          <Card theme={theme} style={styles.error}>
            <Text style={{ color: theme.red }}>{view.error}</Text>
          </Card>
        )}
        {groups.map((group) => (
          <Turn
            key={group.id}
            group={group}
            theme={theme}
            state={state}
            controller={controller}
            sessionRef={ref}
          />
        ))}
        {!view?.items.length && !view?.loading && (
          <EmptyState
            theme={theme}
            icon="chat"
            title="No conversation yet"
            detail="Messages from the agent will appear here."
          />
        )}
      </ScrollView>
      {!control && !readonly && (
        <View style={[styles.lock, { backgroundColor: `${theme.amber}18` }]}>
          <Text style={{ color: theme.amber, flex: 1 }}>
            {locale === "zh-CN"
              ? "查看模式：解锁后可控制。"
              : "View mode: unlock to control."}
          </Text>
          <Button
            theme={theme}
            label="Unlock"
            small
            tone="plain"
            onPress={unlock}
          />
        </View>
      )}
      {!!operation && (
        <Text style={{ color: theme.muted, paddingHorizontal: 16 }}>
          {operation === "upload"
            ? locale === "zh-CN"
              ? "正在上传附件…"
              : "Uploading attachment…"
            : locale === "zh-CN"
              ? "正在发送…"
              : "Sending…"}
        </Text>
      )}
      {attachments.length > 0 && (
        <View style={styles.attachments}>
          {attachments.map((file) => (
            <Pill key={file.assetId} theme={theme} tone="primary">
              <Text
                onPress={() => controller.removeAttachment(ref, file.assetId)}
              >
                {file.name} ×
              </Text>
            </Pill>
          ))}
        </View>
      )}
      <View style={[styles.composer, { borderTopColor: theme.line }]}>
        <IconButton
          theme={theme}
          icon="paperclip"
          label="Add attachment"
          disabled={!control || !!operation}
          onPress={() => void add()}
        />
        <TextInput
          accessibilityLabel="Message"
          value={draft}
          onChangeText={(text) => controller.setDraft(ref, text)}
          editable={!readonly}
          multiline
          placeholder={
            locale === "zh-CN" ? "给 Agent 发送消息" : "Message the agent"
          }
          placeholderTextColor={theme.faint}
          style={[
            styles.input,
            {
              color: theme.text,
              backgroundColor: theme.input,
              borderColor: theme.line,
            },
          ]}
        />
        <IconButton
          theme={theme}
          icon="send"
          label="Send"
          disabled={
            !control || !!operation || (!draft.trim() && !attachments.length)
          }
          onPress={send}
        />
      </View>
    </View>
  );
}
function Terminal({
  theme,
  state,
  controller,
  ref,
  view,
}: {
  theme: Theme;
  state: CompanionState;
  controller: CompanionController;
  ref: SessionRef;
  view?: SessionView;
}) {
  const [text, setText] = useState(""),
    [busy, setBusy] = useState(false);
  const machine = state.machines.find((m) => m.id === ref.machineId);
  const session = machine?.snapshot?.sessions.find(
    (s) => s.id === ref.sessionId,
  );
  const permitted =
    machine?.permission === "fullcontrol" &&
    !session?.readOnly &&
    !session?.archived;
  const control =
    state.controlUnlocked &&
    permitted &&
    machine?.status === "connected" &&
    !machine.syncing &&
    !view?.syncing &&
    !!view?.leaseEpoch;
  const locale = state.preferences.locale;
  const claim = (takeover = false) => {
    setBusy(true);
    void controller
      .unlockControl()
      .then((ok) => {
        if (!ok) throw new Error("control_locked");
        return controller.claimControl(ref, takeover);
      })
      .catch(showError(locale))
      .finally(() => setBusy(false));
  };
  const takeover = () =>
    Alert.alert(
      locale === "zh-CN" ? "接管终端？" : "Take over terminal?",
      locale === "zh-CN"
        ? "这会请求接管其他设备的控制租约。"
        : "This requests takeover of another device's control lease.",
      [
        { text: locale === "zh-CN" ? "取消" : "Cancel", style: "cancel" },
        {
          text: locale === "zh-CN" ? "接管" : "Take over",
          style: "destructive",
          onPress: () => claim(true),
        },
      ],
    );
  return (
    <View style={styles.panel}>
      <ScrollView
        style={[styles.terminal, { backgroundColor: theme.terminal }]}
      >
        {view?.error && <Text style={{ color: theme.red }}>{view.error}</Text>}
        {view?.terminalGap && (
          <Text style={{ color: theme.amber }}>
            {locale === "zh-CN"
              ? "部分较早输出不可用。"
              : "Some earlier output is unavailable."}
          </Text>
        )}
        <Text
          selectable
          style={{
            color: theme.terminalText,
            fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }),
          }}
        >
          {view?.terminal
            ? stripAnsi(view.terminal).replace(
                /[\u0000-\u0008\u000B-\u001F\u007F]/g,
                "",
              )
            : locale === "zh-CN"
              ? "终端输出将显示在这里。"
              : "Terminal output will appear here."}
        </Text>
      </ScrollView>
      {!control && (
        <View style={styles.lock}>
          <Text style={{ color: theme.amber, flex: 1 }}>
            {permitted
              ? locale === "zh-CN"
                ? "需获得控制权后输入。"
                : "Acquire control to enter input."
              : locale === "zh-CN"
                ? "仅查看终端输出。"
                : "Viewing terminal output only."}
          </Text>
          {permitted && (
            <>
              <Button
                theme={theme}
                label={locale === "zh-CN" ? "解锁" : "Unlock"}
                small
                disabled={
                  busy || machine?.status !== "connected" || machine.syncing
                }
                onPress={() => claim()}
              />
              <Button
                theme={theme}
                label={locale === "zh-CN" ? "接管" : "Take over"}
                small
                tone="secondary"
                disabled={
                  busy || machine?.status !== "connected" || machine.syncing
                }
                onPress={takeover}
              />
            </>
          )}
        </View>
      )}
      <View style={styles.composer}>
        <TextInput
          value={text}
          onChangeText={setText}
          editable={control}
          style={[
            styles.input,
            {
              color: theme.text,
              backgroundColor: theme.input,
              borderColor: theme.line,
            },
          ]}
        />
        <Button
          theme={theme}
          label="Run"
          small
          disabled={!control || busy || !text.trim()}
          onPress={() => {
            setBusy(true);
            void controller
              .terminalInput(ref, `${text}\n`)
              .then(() => setText(""))
              .catch(showError(state.preferences.locale))
              .finally(() => setBusy(false));
          }}
        />
        <Button
          theme={theme}
          label="Ctrl-C"
          small
          tone="destructive"
          disabled={!control || busy}
          onPress={() => {
            setBusy(true);
            void controller
              .terminalInput(ref, "\u0003")
              .catch(showError(locale))
              .finally(() => setBusy(false));
          }}
        />
      </View>
    </View>
  );
}
function Turn({
  group,
  theme,
  state,
  controller,
  sessionRef,
}: {
  group: CodexTurn;
  theme: Theme;
  state: CompanionState;
  controller: CompanionController;
  sessionRef: SessionRef;
}) {
  const [expanded, setExpanded] = useState(false);
  const zh = state.preferences.locale === "zh-CN";
  return (
    <View style={styles.message}>
      {group.activity.length > 0 && (
        <Button
          theme={theme}
          small
          tone="plain"
          label={
            (expanded
              ? zh
                ? "收起过程"
                : "Hide activity"
              : zh
                ? "查看过程"
                : "Show activity") +
            (group.elapsedMs === undefined
              ? ""
              : " · " + Math.round(group.elapsedMs / 1000) + "s")
          }
          onPress={() => setExpanded(!expanded)}
        />
      )}
      {expanded &&
        group.activity.map((item) => (
          <Message
            key={item.id}
            theme={theme}
            item={item}
            state={state}
            controller={controller}
            sessionRef={sessionRef}
          />
        ))}
      {group.response.map((item) => (
        <Message
          key={item.id}
          theme={theme}
          item={item}
          state={state}
          controller={controller}
          sessionRef={sessionRef}
        />
      ))}
      {group.turnStatus === "failed" || group.turnStatus === "interrupted" ? (
        <Text style={{ color: theme.red }}>
          {group.turnStatus === "failed"
            ? zh
              ? "本轮失败"
              : "Turn failed"
            : zh
              ? "本轮中断"
              : "Turn interrupted"}
        </Text>
      ) : null}
    </View>
  );
}
function Message({
  theme,
  item,
  state,
  controller,
  sessionRef,
}: {
  theme: Theme;
  item: ChatItem;
  state: CompanionState;
  controller: CompanionController;
  sessionRef: SessionRef;
}) {
  const zh = state.preferences.locale === "zh-CN";
  const text = item.parts
    .filter((p) => ["text", "thinking", "error", "status"].includes(p.type))
    .map((p) => p.text)
    .filter(Boolean)
    .join("\n");
  return (
    <View style={styles.message}>
      {!!text && (
        <Card
          theme={theme}
          style={[
            styles.bubble,
            item.role === "user" ? { backgroundColor: theme.chip } : undefined,
          ]}
        >
          <Text style={{ color: theme.muted, fontSize: 12, marginBottom: 6 }}>
            {item.role === "user"
              ? zh
                ? "你"
                : "You"
              : item.role === "assistant"
                ? "Agent"
                : item.role === "tool"
                  ? zh
                    ? "工具"
                    : "Tool"
                  : zh
                    ? "系统"
                    : "System"}
          </Text>
          <Text
            selectable
            style={{
              color: item.parts.some((p) => p.type === "error")
                ? theme.red
                : theme.text,
            }}
          >
            {text}
          </Text>
        </Card>
      )}
      {item.parts
        .filter(
          (p) =>
            p.type === "tool" || p.type === "subagent" || p.type === "plan",
        )
        .map((part, index) => (
          <ActivityPart
            key={part.toolId ?? index}
            part={part}
            theme={theme}
            zh={zh}
          />
        ))}
      {item.parts
        .filter((p) => p.type === "approval")
        .map((part, index) => (
          <ApprovalCard
            key={part.approvalId ?? index}
            theme={theme}
            state={state}
            controller={controller}
            sessionRef={sessionRef}
            item={item}
            part={part}
          />
        ))}
    </View>
  );
}
function ActivityPart({
  part,
  theme,
  zh,
}: {
  part: ChatPart;
  theme: Theme;
  zh: boolean;
}) {
  const [expanded, setExpanded] = useState(
    part.type === "plan" || part.status === "failed",
  );
  const details =
    part.type === "plan"
      ? part.data.entries
          .map(
            (entry) =>
              (entry.status === "completed"
                ? "✓ "
                : entry.status === "in_progress"
                  ? "→ "
                  : "○ ") + entry.content,
          )
          .join("\n")
      : (part.text ??
        (part.data === undefined ? "" : JSON.stringify(part.data, null, 2)));
  return (
    <Card theme={theme} style={styles.bubble}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(!expanded)}
        style={{ minHeight: 44, justifyContent: "center" }}
      >
        <Text
          style={{
            color: part.status === "failed" ? theme.red : theme.text,
            fontWeight: "600",
          }}
        >
          {part.toolName ??
            (part.type === "plan"
              ? zh
                ? "计划"
                : "Plan"
              : part.type === "subagent"
                ? zh
                  ? "子任务"
                  : "Subagent"
                : zh
                  ? "工具调用"
                  : "Tool call")}
          {part.status ? " · " + part.status : ""} {expanded ? "−" : "+"}
        </Text>
      </Pressable>
      {expanded && (
        <Text
          selectable
          style={{ color: theme.muted, fontFamily: "Menlo", fontSize: 13 }}
        >
          {details}
        </Text>
      )}
    </Card>
  );
}
function showError(locale: CompanionState["preferences"]["locale"]) {
  return (error: unknown) =>
    Alert.alert(
      locale === "zh-CN" ? "操作失败" : "Action failed",
      error instanceof Error ? error.message : String(error),
    );
}
const styles = StyleSheet.create({
  list: { padding: space.md, paddingBottom: 120, gap: 8 },
  listHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  filters: { paddingHorizontal: space.md, flexDirection: "row", flexWrap: "wrap", gap: 8 },
  title: { fontSize: 34, fontWeight: "800" },
  row: { padding: 13, flexDirection: "row", gap: 12, alignItems: "center" },
  grow: { flex: 1, minWidth: 0 },
  name: { fontSize: 16, fontWeight: "800" },
  detail: { flex: 1 },
  head: {
    minHeight: 62,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 4,
  },
  mode: {
    paddingHorizontal: space.md,
    paddingVertical: 8,
    flexDirection: "row",
    gap: 8,
    alignItems: "center",
  },
  lifecycle: {
    paddingHorizontal: space.md,
    paddingBottom: 8,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  panel: { flex: 1, minHeight: 0 },
  transcript: { padding: space.md, gap: 10 },
  message: { gap: 8 },
  bubble: { padding: 12 },
  approval: { padding: 12, gap: 8 },
  error: { padding: 12 },
  lock: { padding: 10, flexDirection: "row", alignItems: "center" },
  attachments: {
    paddingHorizontal: space.md,
    paddingVertical: 6,
    flexDirection: "row",
    gap: 6,
    flexWrap: "wrap",
  },
  composer: {
    padding: 8,
    flexDirection: "row",
    gap: 6,
    alignItems: "flex-end",
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  input: {
    flex: 1,
    minHeight: 44,
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  terminal: { flex: 1, padding: 14 },
});
