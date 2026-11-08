import React, { useCallback, useEffect, useRef, useState } from "react";
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type {
  FileDocument,
  FileListResult,
  GitBranches,
  GitCommitDetail,
  GitDiff,
  GitLog,
  GitStatus,
  GitTextPair,
} from "@threadterm/protocol";
import type { CompanionController, CompanionState } from "../core/types";
import { Icon } from "./icons";
import {
  Button,
  Card,
  EmptyState,
  PageTitle,
  Pill,
  Separator,
} from "./primitives";
import type { Theme } from "./theme";
import { space } from "./theme";
type Scope = { machineId: string; projectId: string; worktreePath: string };
type ImageDocument = {
  mime: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  data: string;
};
type FileValue = FileListResult | FileDocument | ImageDocument;
type GitValue =
  | GitStatus
  | GitDiff
  | GitLog
  | GitCommitDetail
  | GitTextPair
  | GitBranches;
export type ResourceRoute =
  | ({ kind: "files"; path?: string } & Scope)
  | ({ kind: "file"; path: string } & Scope)
  | ({ kind: "git"; view?: "status" | "history" | "branches" } & Scope)
  | ({ kind: "diff"; path: string; staged: boolean } & Scope)
  | ({ kind: "commit"; commit: string } & Scope)
  | ({
      kind: "commit-diff";
      commit: string;
      path: string;
      originalPath?: string;
    } & Scope);
const tr = (zh: boolean, en: string, cn: string) => (zh ? cn : en),
  base = (p: string) =>
    p.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) ?? p,
  scope = (r: Scope) => ({
    projectId: r.projectId,
    worktreePath: r.worktreePath,
  }),
  err = (e: unknown) => (e instanceof Error ? e.message : String(e));
export function ResourceScreen(p: {
  theme: Theme;
  state: CompanionState;
  controller: CompanionController;
  route: ResourceRoute;
  onBack: () => void;
  onRoute: (r: ResourceRoute) => void;
}) {
  return p.route.kind === "files" || p.route.kind === "file" ? (
    <Files {...p} route={p.route} />
  ) : (
    <Git {...p} route={p.route} />
  );
}
function Header({
  theme,
  zh,
  title,
  detail,
  onBack,
}: {
  theme: Theme;
  zh: boolean;
  title: string;
  detail?: string;
  onBack: () => void;
}) {
  return (
    <PageTitle
      theme={theme}
      title={title}
      subtitle={detail}
      left={
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={tr(zh, "Back", "返回")}
          onPress={onBack}
          style={s.back}
        >
          <Icon name="arrowLeft" color={theme.primary} />
        </Pressable>
      }
    />
  );
}
function Load({
  theme,
  zh,
  loading,
  error,
  retry,
  children,
}: {
  theme: Theme;
  zh: boolean;
  loading: boolean;
  error?: string;
  retry: () => void;
  children: React.ReactNode;
}) {
  return loading ? (
    <Text style={[s.state, { color: theme.muted }]}>
      {tr(zh, "Loading…", "加载中…")}
    </Text>
  ) : error ? (
    <EmptyState
      theme={theme}
      icon="warning"
      title={tr(zh, "Could not load", "加载失败")}
      detail={error}
      action={
        <Button
          theme={theme}
          small
          label={tr(zh, "Retry", "重试")}
          onPress={retry}
        />
      }
    />
  ) : (
    <>{children}</>
  );
}
function Files({
  theme,
  state,
  controller,
  route,
  onBack,
  onRoute,
}: {
  theme: Theme;
  state: CompanionState;
  controller: CompanionController;
  route: Extract<ResourceRoute, { kind: "files" | "file" }>;
  onBack: () => void;
  onRoute: (r: ResourceRoute) => void;
}) {
  const zh = state.preferences.locale === "zh-CN",
    [loading, setLoading] = useState(true),
    [error, setError] = useState<string>(),
    [value, setValue] = useState<FileValue>(),
    generation = useRef(0);
  const key = JSON.stringify(route);
  const load = useCallback(() => {
    const current = ++generation.current;
    setLoading(true);
    setError(undefined);
    setValue(undefined);
    const request: Promise<FileValue> =
      route.kind === "files"
        ? controller.read(route.machineId, "filesystem.files", scope(route))
        : controller
            .read(route.machineId, "filesystem.read", {
              ...scope(route),
              path: route.path,
            })
            // The runtime rejects binary documents. Try its separately scoped,
            // read-only image endpoint before surfacing the original text error.
            .catch(async (readError) => {
              try {
                return await controller.read(route.machineId, "filesystem.image", {
                  ...scope(route),
                  path: route.path,
                });
              } catch {
                throw readError;
              }
            });
    void request
      .then(
        (v) => current === generation.current && setValue(v),
        (e) => current === generation.current && setError(err(e)),
      )
      .finally(() => current === generation.current && setLoading(false));
  }, [controller, key]);
  useEffect(() => {
    load();
    return () => {
      generation.current += 1;
    };
  }, [load]);
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={s.content}
    >
      <Header
        theme={theme}
        zh={zh}
        title={
          route.kind === "files" ? tr(zh, "Files", "文件") : base(route.path)
        }
        detail={
          route.kind === "files"
            ? route.path
            : route.path
        }
        onBack={onBack}
      />
      <Load theme={theme} zh={zh} loading={loading} error={error} retry={load}>
        {route.kind === "files" ? (
          <List
            theme={theme}
            zh={zh}
            value={isFileList(value) ? value : undefined}
            route={route}
            onRoute={onRoute}
          />
        ) : (
          <Document
            theme={theme}
            zh={zh}
            path={route.path}
            value={isFileDocument(value) || isImageDocument(value) ? value : undefined}
          />
        )}
      </Load>
    </ScrollView>
  );
}
function List({
  theme,
  zh,
  value,
  route,
  onRoute,
}: {
  theme: Theme;
  zh: boolean;
  value?: FileListResult;
  route: Extract<ResourceRoute, { kind: "files" }>;
  onRoute: (r: ResourceRoute) => void;
}) {
  if (!value?.paths.length)
    return (
      <EmptyState
        theme={theme}
        icon="folder"
        title={tr(zh, "No files", "暂无文件")}
      />
    );
  return (
    <>
      <Card theme={theme} style={s.group}>
        {value.paths.map((path, i) => (
          <React.Fragment key={path}>
            {i > 0 && <Separator theme={theme} />}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={path}
              onPress={() => onRoute({ ...route, kind: "file", path })}
              style={({ pressed }) => [s.row, { opacity: pressed ? 0.7 : 1 }]}
            >
              <Icon name="file" color={theme.primary} />
              <View style={s.copy}>
                <Text numberOfLines={1} style={[s.name, { color: theme.text }]}>
                  {base(path)}
                </Text>
                {path !== base(path) && <Text
                  numberOfLines={1}
                  style={[s.path, { color: theme.muted }]}
                >
                  {path}
                </Text>}
              </View>
              <Icon name="chevron" color={theme.faint} />
            </Pressable>
          </React.Fragment>
        ))}
      </Card>
      {value.truncated && (
        <Text style={[s.notice, { color: theme.muted }]}>
          {tr(
            zh,
            "More files on the computer.",
            "更多文件请在电脑查看。",
          )}
        </Text>
      )}
    </>
  );
}
function isFileList(value: FileValue | undefined): value is FileListResult {
  return !!value && "paths" in value;
}
function isFileDocument(value: FileValue | undefined): value is FileDocument {
  return !!value && "fingerprint" in value;
}
function isImageDocument(value: FileValue | undefined): value is ImageDocument {
  return !!value && "mime" in value;
}
function Document({
  theme,
  zh,
  path,
  value,
}: {
  theme: Theme;
  zh: boolean;
  path: string;
  value?: FileDocument | ImageDocument;
}) {
  if (!value) return null;
  if ("mime" in value)
    return (
      <>
        <Text selectable style={[s.context, { color: theme.muted }]}>
          {path} · {value.mime}
        </Text>
        <Card theme={theme} style={s.imageCard}>
          <Image
            accessibilityLabel={tr(zh, "Read-only image preview", "只读图片预览")}
            resizeMode="contain"
            source={{ uri: `data:${value.mime};base64,${value.data}` }}
            style={s.image}
          />
        </Card>
      </>
    );
  return (
    <>
      <Text selectable style={[s.context, { color: theme.muted }]}>
        {value.path} · {value.size} B
      </Text>
      <Card theme={theme} style={[s.code, { backgroundColor: theme.terminal }]}>
        <Text
          selectable
          style={{ color: theme.terminalText, fontFamily: "Menlo" }}
        >
          {value.content ||
            tr(zh, "Empty file", "空文件")}
        </Text>
      </Card>
    </>
  );
}
function Git({
  theme,
  state,
  controller,
  route,
  onBack,
  onRoute,
}: {
  theme: Theme;
  state: CompanionState;
  controller: CompanionController;
  route: Exclude<ResourceRoute, { kind: "files" | "file" }>;
  onBack: () => void;
  onRoute: (r: ResourceRoute) => void;
}) {
  const zh = state.preferences.locale === "zh-CN",
    [loading, setLoading] = useState(true),
    [error, setError] = useState<string>(),
    [value, setValue] = useState<GitValue>(),
    generation = useRef(0);
  const key = JSON.stringify(route);
  const load = useCallback(() => {
    const current = ++generation.current;
    setLoading(true);
    setError(undefined);
    setValue(undefined);
    let q: Promise<GitValue>;
    if (route.kind === "diff")
      q = controller.read(route.machineId, "git.diff", {
        ...scope(route),
        path: route.path,
        staged: route.staged,
      });
    else if (route.kind === "commit")
      q = controller.read(route.machineId, "git.commit.show", {
        ...scope(route),
        commit: route.commit,
      });
    else if (route.kind === "commit-diff")
      q = controller.read(route.machineId, "git.commit.diff", {
        ...scope(route),
        commit: route.commit,
        path: route.path,
        ...(route.originalPath ? { originalPath: route.originalPath } : {}),
      });
    else if (route.view === "history")
      q = controller.read(route.machineId, "git.log", {
        ...scope(route),
        limit: 40,
      });
    else if (route.view === "branches")
      q = controller.read(route.machineId, "git.branches", scope(route));
    else q = controller.read(route.machineId, "git.status", scope(route));
    void q
      .then(
        (v) => current === generation.current && setValue(v),
        (e) => current === generation.current && setError(err(e)),
      )
      .finally(() => current === generation.current && setLoading(false));
  }, [controller, key]);
  useEffect(() => {
    load();
    return () => {
      generation.current += 1;
    };
  }, [load]);
  const title =
    route.kind === "commit"
      ? tr(zh, "Commit", "提交")
      : route.kind === "diff" || route.kind === "commit-diff"
        ? base(route.path)
        : route.kind === "git" && route.view === "history"
          ? tr(zh, "History", "历史")
          : route.kind === "git" && route.view === "branches"
            ? tr(zh, "Branches", "分支")
            : tr(zh, "Changes", "变更");
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={s.content}
    >
      <Header
        theme={theme}
        zh={zh}
        title={title}
        detail={route.kind === "commit" ? route.commit.slice(0, 8) : undefined}
        onBack={onBack}
      />
      {route.kind === "git" && (
        <View style={s.tabs}>
          {(["status", "history", "branches"] as const).map((view) => (
            <Button
              key={view}
              theme={theme}
              small
              tone={(route.view ?? "status") === view ? "primary" : "secondary"}
              label={
                view === "status"
                  ? tr(zh, "Status", "状态")
                  : view === "history"
                    ? tr(zh, "History", "历史")
                    : tr(zh, "Branches", "分支")
              }
              onPress={() => onRoute({ ...route, view })}
            />
          ))}
        </View>
      )}
      <Load theme={theme} zh={zh} loading={loading} error={error} retry={load}>
        <GitBody
          theme={theme}
          zh={zh}
          route={route}
          value={value}
          onRoute={onRoute}
        />
      </Load>
    </ScrollView>
  );
}
function GitBody({
  theme,
  zh,
  route,
  value,
  onRoute,
}: {
  theme: Theme;
  zh: boolean;
  route: Exclude<ResourceRoute, { kind: "files" | "file" }>;
  value?: GitValue;
  onRoute: (r: ResourceRoute) => void;
}) {
  if (route.kind === "diff" || route.kind === "commit-diff") {
    if (!isGitDiff(value)) return null;
    const d = value;
    if (d.binary)
      return (
        <EmptyState
          theme={theme}
          icon="file"
          title={tr(zh, "Binary file", "二进制文件")}
          detail={tr(
            zh,
            "View on the computer.",
            "请在电脑查看。",
          )}
        />
      );
    return (
      <View style={s.diff}>
        <Card theme={theme} style={s.pane}>
          <Text style={{ color: theme.muted }}>
            {tr(zh, "Previous", "之前")}
          </Text>
          <Text selectable style={[s.diffText, { color: theme.text }]}>{d.oldText || tr(zh, "(empty)", "（空）")}</Text>
        </Card>
        <Card theme={theme} style={s.pane}>
          <Text style={{ color: theme.muted }}>
            {tr(zh, "Current", "当前")}
          </Text>
          <Text selectable style={[s.diffText, { color: theme.text }]}>{d.newText || tr(zh, "(empty)", "（空）")}</Text>
        </Card>
      </View>
    );
  }
  if (route.kind === "commit") {
    if (!isGitCommitDetail(value)) return null;
    const d = value;
    return (
      <Card theme={theme} style={s.group}>
        {d?.files.map((f, i) => (
          <React.Fragment key={f.path}>
            {i > 0 && <Separator theme={theme} />}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={f.path}
              onPress={() =>
                onRoute({
                  ...route,
                  kind: "commit-diff",
                  path: f.path,
                  ...(f.originalPath ? { originalPath: f.originalPath } : {}),
                })
              }
              style={s.row}
            >
              <Pill theme={theme}>{f.status}</Pill>
              <Text style={[s.name, { color: theme.text }]}>{f.path}</Text>
            </Pressable>
          </React.Fragment>
        ))}
      </Card>
    );
  }
  if (route.kind === "git" && route.view === "history") {
    if (isGitLog(value) && !value.commits.length) return <EmptyState theme={theme} icon="git" title={tr(zh, "No commits", "暂无提交")} />;
    return (
      <Card theme={theme} style={s.group}>
        {(isGitLog(value) ? value.commits : []).map((c, i) => (
          <React.Fragment key={c.hash}>
            {i > 0 && <Separator theme={theme} />}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={c.subject}
              onPress={() =>
                onRoute({ ...route, kind: "commit", commit: c.hash })
              }
              style={s.item}
            >
              <Text style={[s.name, { color: theme.text }]}>{c.subject}</Text>
              <Text style={[s.path, { color: theme.muted }]}>
                {c.hash.slice(0, 8)} · {c.authorName}
              </Text>
            </Pressable>
          </React.Fragment>
        ))}
      </Card>
    );
  }
  if (route.kind === "git" && route.view === "branches")
    return (
      <Card theme={theme} style={s.group}>
        {(isGitBranches(value) ? value.branches : []).map((b) => (
          <View key={b.name} style={s.item}>
            <Text style={[s.name, { color: theme.text }]}>{b.name}</Text>
          </View>
        ))}
      </Card>
    );
  if (!isGitStatus(value) || !value.changes.length) return <EmptyState theme={theme} icon="check" title={tr(zh, "No changes", "暂无变更")} />;
  const status = value;
  return (
    <Card theme={theme} style={s.group}>
      {status?.changes.map((c, i) => (
        <React.Fragment key={c.path}>
          {i > 0 && <Separator theme={theme} />}
          <View style={s.change}>
            <Text style={[s.name, { color: theme.text }]}>{c.path}</Text>
            {!!c.indexStatus && c.indexStatus !== " " && (
              <Button
                theme={theme}
                small
                label={tr(zh, "Staged", "暂存")}
                onPress={() =>
                  onRoute({
                    ...route,
                    kind: "diff",
                    path: c.path,
                    staged: true,
                  })
                }
              />
            )}
            {!!c.worktreeStatus && c.worktreeStatus !== " " && (
              <Button
                theme={theme}
                small
                label={tr(zh, "Working", "工作区")}
                onPress={() =>
                  onRoute({
                    ...route,
                    kind: "diff",
                    path: c.path,
                    staged: false,
                  })
                }
              />
            )}
          </View>
        </React.Fragment>
      ))}
    </Card>
  );
}
function isGitDiff(value: GitValue | undefined): value is GitDiff | GitTextPair {
  return !!value && "oldText" in value && "newText" in value;
}
function isGitCommitDetail(value: GitValue | undefined): value is GitCommitDetail {
  return !!value && "files" in value;
}
function isGitLog(value: GitValue | undefined): value is GitLog {
  return !!value && "commits" in value;
}
function isGitBranches(value: GitValue | undefined): value is GitBranches {
  return !!value && "branches" in value;
}
function isGitStatus(value: GitValue | undefined): value is GitStatus {
  return !!value && "changes" in value;
}
const s = StyleSheet.create({
  content: { paddingBottom: 120 },
  back: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  state: { padding: space.lg, textAlign: "center" },
  group: { marginHorizontal: space.md },
  row: {
    minHeight: 52,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  copy: { flex: 1, minWidth: 0 },
  name: { fontSize: 15 },
  path: { fontSize: 12 },
  notice: { margin: space.md },
  context: { marginHorizontal: space.md, marginBottom: 8 },
  code: { marginHorizontal: space.md, padding: 14 },
  imageCard: { marginHorizontal: space.md, padding: 8, minHeight: 220 },
  image: { width: "100%", height: 320 },
  tabs: {
    paddingHorizontal: space.md,
    flexDirection: "row",
    gap: 8,
    marginBottom: 12,
  },
  item: { padding: 14, gap: 4 },
  change: { padding: 14, gap: 8 },
  diff: { flexDirection: "row", gap: 8, marginHorizontal: space.md },
  pane: { flex: 1, padding: 10 },
  diffText: { marginTop: 8, fontFamily: "Menlo", fontSize: 14, lineHeight: 20 },
});
