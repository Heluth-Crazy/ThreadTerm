import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  type TextStyle,
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
import { controlPermissionNotice, sessionStatusLabel, timeLabel } from "./format";
import { ApprovalCard } from "./ApprovalCard";
import {
  groupCodexTranscript,
  type CodexTurn,
} from "../../../renderer/src/codexTranscript";
import { chatOptionsDisabledReason, chatOptionsPermissionRecovery, chatOptionsSummary } from "../core/projection";
import { ChatOptionsSheet } from "./ChatOptionsSheet";
import { TerminalPanel as Terminal } from "./TerminalPanel";

// React Native's web Text output needs these CSS properties for an unbroken
// identifier. Native already wraps Text inside its constrained parent.
const webAnywhere = Platform.OS === "web"
  ? ({ overflowWrap: "anywhere", wordBreak: "break-word" } as TextStyle & { overflowWrap: string; wordBreak: string })
  : undefined;
const mono = Platform.select({ ios: "Menlo", web: "monospace", default: "monospace" });
type MessageBlock = { kind: "prose" | "code"; text: string };

/** Keep markdown fences out of the transcript while a streaming final fence is absent. */
function messageBlocks(text: string): MessageBlock[] {
  const blocks: MessageBlock[] = [];
  let code = false, lines: string[] = [];
  const flush = () => {
    if (lines.length) blocks.push({ kind: code ? "code" : "prose", text: lines.join("\n") });
    lines = [];
  };
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) { flush(); code = !code; continue; }
    lines.push(line);
  }
  flush();
  return blocks;
}

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
      {state.machines.length > 1 && <View style={styles.filters}>
        <Button theme={theme} small tone={!machineFilter ? "primary" : "secondary"} label={locale === "zh-CN" ? "所有电脑" : "All computers"} onPress={() => { setMachineFilter(undefined); setProjectFilter(undefined); }} />
        {state.machines.map(machine => <Button key={machine.id} theme={theme} small tone={machineFilter === machine.id ? "primary" : "secondary"} label={machine.name} onPress={() => { setMachineFilter(machine.id); setProjectFilter(undefined); }} />)}
      </View>}
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
                <Text numberOfLines={1} style={{ color: theme.muted, fontSize: 13 }}>
                  {m.name}{s.projectId ? ` · ${m.snapshot?.projects.find(project => project.id === s.projectId)?.name ?? (locale === "zh-CN" ? "未归属项目" : "Unassigned project")}` : ''}
                </Text>
              </View>
              <View style={{ alignItems: 'flex-end', gap: 4 }}><StatusDot theme={theme} state={s.status} /><Text style={{ color: theme.muted, fontSize: 12 }}>{timeLabel(s.updatedAt, locale)}</Text></View>
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
        ? "控制权将移到此手机。"
        : "Control will move to this phone.",
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
  if (!session)
    return (
      <EmptyState
        theme={theme}
        icon="warning"
        title={locale === "zh-CN" ? "会话不可用" : "Session unavailable"}
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
    <View style={[styles.detail, { backgroundColor: theme.background }]}>
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
          label={locale === "zh-CN" ? "会话操作" : "Session actions"}
          onPress={() =>
            Alert.alert(locale === "zh-CN" ? "会话" : "Session", undefined, [
              { text: locale === "zh-CN" ? "文件" : "Files", onPress: onFiles },
              { text: locale === "zh-CN" ? "变更" : "Changes", onPress: onGit },
              ...(canControl ? [
                { text: locale === "zh-CN" ? "获取控制" : "Control", onPress: () => run("claim", () => controller.claimControl(ref)) },
                { text: locale === "zh-CN" ? "接管" : "Take over", onPress: takeOver },
                ...(session.status === "exited" || session.status === "interrupted"
                  ? [{ text: locale === "zh-CN" ? "恢复" : "Resume", onPress: () => run("resume", () => controller.resume(ref)) }]
                  : view?.leaseEpoch ? [{ text: locale === "zh-CN" ? "停止" : "Stop", onPress: () => run("stop", () => controller.stop(ref)) }] : []),
                ...(activeTurnId && view?.leaseEpoch ? [{ text: locale === "zh-CN" ? "取消当前轮次" : "Cancel turn", onPress: () => run("cancel", () => controller.cancelTurn(ref, activeTurnId)) }] : []),
              ] : []),
              { text: locale === "zh-CN" ? "取消" : "Cancel", style: "cancel" },
            ])
          }
        />
      </View>
      <View style={{ paddingHorizontal: space.md, paddingBottom: 8 }}>
        <StatusDot theme={theme} state={session.status} label={sessionStatusLabel(session.status, locale)} />
      </View>
      {(machine?.status !== "connected" || machine.syncing) && (
        <Text style={[styles.lock, { color: theme.amber }]}>
          {locale === "zh-CN"
            ? "重连后可操作。"
            : "Reconnect to act."}
        </Text>
      )}
      {!!session.run?.url && (
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
          activeTurnId={activeTurnId}
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
    </View>
  );
}

function ChatPanel({
  theme,
  state,
  controller,
  ref,
  view,
  session,
  activeTurnId,
}: {
  theme: Theme;
  state: CompanionState;
  controller: CompanionController;
  ref: SessionRef;
  view?: SessionView;
  session: Session;
  activeTurnId?: string;
}) {
  const locale = state.preferences.locale,
    scroll = useRef<React.ElementRef<typeof ScrollView>>(null),
    draft = state.drafts[sessionKey(ref)] ?? "",
    attachments = state.attachments[sessionKey(ref)] ?? [];
  const machinePermission = state.machines.find(m => m.id === ref.machineId)?.permission;
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
  const [optionsOpen, setOptionsOpen] = useState(false);
  const optionsReason = chatOptionsDisabledReason(state, ref);
  const optionsUi = chatOptionsPermissionRecovery(view) && view?.chatUi ? { ...view.chatUi, options: view.chatUi.options.filter(option => option.category === "mode") } : view?.chatUi;
  const openOptions = () => {
    setOptionsOpen(true);
    void controller.refreshChatOptions(ref).catch(() => {});
  };
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
  // While a turn runs and nothing is typed, the send button stops the reply (one tap, like the desktop composer).
  const showStop = !!activeTurnId && !readonly && !draft.trim() && !attachments.length;
  const cancelTurn = () => {
    if (operationRef.current || !activeTurnId) return;
    if (!control) {
      unlock();
      return;
    }
    operationRef.current = true;
    setOperation("cancel");
    void controller
      .cancelTurn(ref, activeTurnId)
      .catch(showError(locale))
      .finally(() => {
        operationRef.current = false;
        setOperation(undefined);
      });
  };
  return (
    <View style={styles.panel}>
      <ScrollView
        testID="chat-transcript"
        ref={scroll}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        onScrollBeginDrag={Keyboard.dismiss}
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
        <Pressable testID="transcript-background" accessible={false} onPress={Keyboard.dismiss} style={{ flexGrow: 1, gap: 10 }}>
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
        {!!view?.error && (
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
            title={locale === "zh-CN" ? "暂无消息" : "No messages yet"}
          />
        )}
        </Pressable>
      </ScrollView>
      {!control && (
        <View style={[styles.lock, { backgroundColor: `${theme.amber}18` }]}>
          <Text style={{ color: theme.amber, flex: 1 }}>
            {session.readOnly || session.archived
              ? (locale === "zh-CN" ? "此会话仅允许查看。" : "This session is read-only.")
              : controlPermissionNotice(machinePermission, state.controlUnlocked, locale)}
          </Text>
          {!readonly && <Button
            theme={theme}
            label={state.controlUnlocked ? (locale === "zh-CN" ? "获取控制" : "Control") : (locale === "zh-CN" ? "解锁" : "Unlock")}
            small
            tone="plain"
            disabled={!ready}
            onPress={unlock}
          />}
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
      <View style={[styles.optionsBar, { borderTopColor: theme.line }]}>
        <Pressable accessibilityRole="button" accessibilityLabel={locale === "zh-CN" ? "会话选项" : "Session options"} accessibilityHint={optionsReason} accessibilityValue={{ text: chatOptionsSummary(view?.chatUi, locale) }} accessibilityState={{ expanded: optionsOpen, busy: !!view?.optionPending || !!view?.optionsLoading }} onPress={openOptions} style={({ pressed }) => [styles.optionsButton, { backgroundColor: theme.chip, opacity: pressed ? .72 : 1 }]}>
          <Text numberOfLines={1} style={{ color: theme.text, fontWeight: "800", flex: 1 }}>{chatOptionsSummary(view?.chatUi, locale)}</Text>
          <Icon name="settings" color={theme.primary} size={18} />
        </Pressable>
        {!!view?.optionPending && <Text style={[styles.optionsHint, { color: theme.muted }]}>{locale === "zh-CN" ? "正在更新选项…" : "Updating options…"}</Text>}
        {!view?.optionPending && !!view?.optionsError && <Text accessibilityRole="alert" style={[styles.optionsHint, { color: theme.red }]}>{view.optionsError.startsWith("outcome_unknown") ? (locale === "zh-CN" ? "请查看当前选项。" : "Check the current options.") : (locale === "zh-CN" ? "打开选项重试。" : "Open options to retry.")}</Text>}
      </View>
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
            locale === "zh-CN" ? "消息" : "Message"
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
        {showStop ? (
          <IconButton
            theme={theme}
            icon="stop"
            label={locale === "zh-CN" ? "停止回复" : "Stop response"}
            disabled={!!operation}
            onPress={cancelTurn}
          />
        ) : (
          <IconButton
            theme={theme}
            icon="send"
            label="Send"
            disabled={
              !control || !!operation || (!draft.trim() && !attachments.length)
            }
            onPress={send}
          />
        )}
      </View>
      <ChatOptionsSheet theme={theme} locale={locale} visible={optionsOpen} ui={optionsUi} disabledReason={optionsReason} pending={view?.optionPending} error={view?.optionsError} loading={view?.optionsLoading} onDismiss={() => setOptionsOpen(false)} onRefresh={() => void controller.refreshChatOptions(ref).catch(() => {})} onChoose={(optionId, value) => void controller.setChatOption(ref, optionId, value).then(() => setOptionsOpen(false)).catch(() => {})} />
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
  const isUser = item.role === "user";
  const isTool = item.role === "tool";
  const blocks = messageBlocks(text);
  const role = isUser
    ? zh ? "你" : "You"
    : item.role === "assistant"
      ? "Agent"
      : item.role === "tool"
        ? zh ? "工具" : "Tool"
        : zh ? "系统" : "System";
  return (
    <View testID={`chat-item-${item.id}`} style={[styles.message, isUser && styles.userMessage]}>
      {!!text && (
        <Card theme={theme} style={[
          styles.bubble,
          isTool ? styles.activityBubble : isUser ? styles.userBubble : styles.agentBubble,
          isUser ? { backgroundColor: theme.primary } : undefined,
        ]}>
          <Text style={[styles.messageMeta, { color: isUser ? theme.primaryText : theme.muted }]}>
            {role} · {timeLabel(item.createdAt, zh ? "zh-CN" : "en")}
          </Text>
          {blocks.map((block, index) => block.kind === "code" ? (
            <Text key={index} testID={`chat-code-${item.id}-${index}`} selectable style={[
              styles.codeBlock,
              webAnywhere,
              { color: item.parts.some((p) => p.type === "error") ? theme.red : isUser ? theme.primaryText : theme.text, backgroundColor: isUser ? `${theme.primaryText}1c` : theme.raised },
            ]}>{block.text}</Text>
          ) : (
            <Text key={index} testID={`chat-prose-${item.id}-${index}`} selectable style={[
              styles.messageText,
              webAnywhere,
              { color: item.parts.some((p) => p.type === "error") ? theme.red : isUser ? theme.primaryText : theme.text },
            ]}>{block.text}</Text>
          ))}
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
    <Card theme={theme} style={styles.activityBubble}>
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
          style={[styles.activityDetails, { color: theme.muted }, webAnywhere]}
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
  list: { padding: space.md, paddingBottom: 24, gap: 8 },
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
  transcript: { padding: space.md, flexGrow: 1, gap: 14 },
  message: { alignSelf: "stretch", gap: 8, minWidth: 0, alignItems: "flex-start" },
  userMessage: { alignItems: "flex-end" },
  bubble: { paddingVertical: 10, paddingHorizontal: 14, minWidth: 0 },
  userBubble: { maxWidth: "82%", alignSelf: "flex-end", borderRadius: 18, borderWidth: 0 },
  agentBubble: { maxWidth: "100%", alignSelf: "flex-start", borderRadius: 14 },
  messageMeta: { fontSize: 12, lineHeight: 16, marginBottom: 4, opacity: 0.82 },
  messageText: { fontSize: 15, lineHeight: 23, flexShrink: 1, minWidth: 0, maxWidth: "100%" },
  codeBlock: { alignSelf: "stretch", borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontFamily: mono, fontSize: 13, lineHeight: 20, flexShrink: 1, minWidth: 0, maxWidth: "100%" },
  activityBubble: { width: "100%", padding: 12, gap: 8 },
  activityDetails: { fontFamily: mono, fontSize: 13, lineHeight: 19, flexShrink: 1, minWidth: 0, maxWidth: "100%" },
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
  optionsBar: { paddingHorizontal: 8, paddingTop: 6, borderTopWidth: StyleSheet.hairlineWidth },
  optionsButton: { minHeight: 44, borderRadius: 12, paddingHorizontal: 12, flexDirection: "row", alignItems: "center", gap: 8 },
  optionsHint: { fontSize: 12, lineHeight: 16, paddingHorizontal: 4, paddingTop: 4 },
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
});
