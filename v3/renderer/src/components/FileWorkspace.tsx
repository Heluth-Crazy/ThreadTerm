import { Select } from "./ui/Select";
import { Icon } from "./PrototypeIcon";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type {
  Draft,
  FileDocument,
  GitBlame,
  GitDiff,
} from "@threadterm/protocol";
import { operationId, request } from "../bridge";
import { CodeEditor } from "./CodeEditor";
import { MergeEditor, type MergeEditorHandle } from "./MergeEditor";
import { GitMergeControls } from "./GitMergeControls";
import { SurfaceDialog } from "./SurfaceDialog";
import { FilePreview } from "./FilePreview";
import "./file-workspace.css";
import { registerDirtyEditor } from "../dirtyEditors";
import { ExplorerView } from "./ExplorerView";
import { SourceControlView } from "./SourceControlView";
import { useGitStatus } from "./WorkbenchSideBar";
import { WbIcon } from "../workbench/icons";
import { stageChunk, unstageChunk, withLineBreaks } from "../workbench/indexEdit";
import { workbenchError } from "../workbench/errors";
import { coveredBy, type WorkbenchActions } from "../workbench/types";

type View = "file" | "diff" | "preview";
type Props = {
  projectId: string;
  worktreePath?: string;
  initialPath?: string;
  initialView?: View;
  view?: View;
  onViewChange?: (view: View) => void;
  onDocumentChange?: (value: { path: string; dirty: boolean }) => void;
  editorId?: string;
  ownerSessionId?: string;
  reveal?: { line: number; column?: number; key: string };
  embedded?: boolean;
  onOpenPath?: (path: string, view: View) => void;
  assetKind?: "image" | "text";
  previewNavigation?: {
    activeId: string;
    files: Array<{ id: string; path: string; kind: View }>;
    onSelect: (id: string) => void;
    onClose: () => void;
    closing: boolean;
  };
  /** Opens a diff tab directly in its staged (HEAD → index) view. */
  initialStaged?: boolean;
  /** Absolute root for "Copy path" in the standalone tools panel. */
  rootPath?: string;
  onSendToAgent?: (target: { path: string; startLine?: number; endLine?: number }) => void;
  onOpenHistory?: (target: { path?: string; commit?: string }) => void;
};
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const imagePath = (path: string) => /\.(?:png|jpe?g|gif|webp)$/i.test(path);

export function FileWorkspace(props: Props) {
  return <FileWorkspaceInstance key={`${props.projectId}\0${props.worktreePath ?? ""}`} {...props} />;
}

function FileWorkspaceInstance({
  projectId,
  worktreePath,
  initialPath,
  initialView = "file",
  view: controlledView,
  onViewChange,
  onDocumentChange,
  editorId,
  ownerSessionId,
  reveal,
  embedded = false,
  onOpenPath,
  assetKind,
  previewNavigation,
  initialStaged,
  rootPath,
  onSendToAgent,
  onOpenHistory,
}: Props) {
  const scope = { projectId, worktreePath };
  // A standalone workspace opened without a file (project Files page, Settings → Tools dialog) has
  // nothing else to show, so it starts with its Files & Git panel open.
  const [toolsOpen, setToolsOpen] = useState(!embedded && !initialPath);
  const [filesToolsHost, setFilesToolsHost] = useState<HTMLDivElement | null>(null);
  const [scmToolsHost, setScmToolsHost] = useState<HTMLDivElement | null>(null);
  const [openPaths, setOpenPaths] = useState<string[]>([]);
  const [document, setDocument] = useState<FileDocument>();
  const [image, setImage] = useState<{ mime: string; data: string }>();
  const [text, setText] = useState("");
  const [internalView, setInternalView] = useState<View>(initialView);
  const previousControlledView = useRef<View | undefined>(controlledView);
  const view =
    internalView === "preview" ? "preview" : (controlledView ?? internalView);
  const setView = (next: View) => {
    setInternalView(next);
    if (next !== "preview") onViewChange?.(next);
  };
  const [staged, setStaged] = useState(initialStaged ?? false);
  const [hunk, setHunk] = useState(0);
  const [hunkCount, setHunkCount] = useState(0);
  const [gitBaseText, setGitBaseText] = useState<string | null>(null);
  const [blameOn, setBlameOn] = useState(false);
  const [blame, setBlame] = useState<GitBlame>();
  const [diff, setDiff] = useState<GitDiff>();
  const mergeEditor = useRef<MergeEditorHandle>(null);
  const [issue, setIssue] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [draftStatus, setDraftStatus] = useState<
    "saved" | "saving" | "unsaved" | "conflict"
  >("saved");
  const [pending, setPending] = useState<{
    path?: string;
    view: View;
    reload?: boolean;
    close?: "current" | "others" | "all";
  }>();
  const closeResolver = useRef<((value: boolean) => void) | undefined>(
    undefined,
  );
  const [closePrompt, setClosePrompt] = useState(false);
  const [editorResetKey, setEditorResetKey] = useState(0);
  const drafts = useRef(new Map<string, Draft>());
  const queue = useRef(Promise.resolve());
  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const base = useRef("");
  const loaded = useRef<FileDocument | undefined>(undefined);
  const currentText = useRef(text);
  currentText.current = text;
  const mounted = useRef(true);
  const generation = useRef(0);
  const dirty = !!document && text !== document.content;
  const zh = globalThis.document.documentElement.lang === "zh-CN";
  const copy = zh
    ? {
        files: "文件",
        refresh: "刷新",
        changes: "改动",
        saved: "草稿已同步",
        saving: "正在同步草稿…",
        unsaved: "有未同步更改",
        conflict: "草稿冲突",
        save: "保存文件",
        edit: "编辑",
        preview: "预览",
        diff: "对比",
        staged: "已暂存",
        unstaged: "未暂存",
        empty: "选择文件开始编辑",
        readOnly: "只读",
        reload: "从磁盘重新载入",
        restore: "还原未暂存内容",
        cancel: "取消",
        discard: "放弃更改",
        question: "保存此文件的更改？",
        detail: "保存后继续；放弃会删除此文件的草稿。",
        retry: "重试同步",
        noGit: "此目录没有可用的 Git 状态。",
      }
    : {
        files: "Files",
        refresh: "Refresh",
        changes: "Changes",
        saved: "Draft synced",
        saving: "Syncing draft…",
        unsaved: "Unsynced changes",
        conflict: "Draft conflict",
        save: "Save file",
        edit: "Edit",
        preview: "Preview",
        diff: "Diff",
        staged: "Staged",
        unstaged: "Unstaged",
        empty: "Select a file to edit",
        readOnly: "Read only",
        reload: "Reload from disk",
        restore: "Restore unstaged content",
        cancel: "Cancel",
        discard: "Discard changes",
        question: "Save changes to this file?",
        detail: "Save before continuing, or discard this file’s draft.",
        retry: "Retry sync",
        noGit: "Git status is unavailable for this directory.",
      };

  const gitState = useGitStatus(scope, toolsOpen, zh);
  async function refreshGit() {
    await gitState.refresh();
  }
  async function open(
    path: string,
    nextView: View = "file",
    ignoreDraft = false,
  ) {
    const ticket = ++generation.current;
    try {
      const imageHint = path === initialPath ? assetKind : undefined;
      if (imageHint === "image" || imagePath(path)) {
        const asset = await request("filesystem.image", { ...scope, path });
        if (!mounted.current || ticket !== generation.current) return false;
        const imageDocument = {
          path,
          content: "",
          fingerprint: "image",
          readonly: true,
          size: 0,
          modifiedAt: "",
        };
        loaded.current = imageDocument;
        base.current = "image";
        setDocument(imageDocument);
        setImage(asset);
        setText("");
        setOpenPaths((paths) =>
          paths.includes(path) ? paths : [...paths, path],
        );
        setView("preview");
        setDiff(undefined);
        setDraftStatus("saved");
        setIssue(undefined);
        return true;
      }
      const value = await request("filesystem.read", { ...scope, path });
      if (!mounted.current || ticket !== generation.current) return false;
      const saved = ignoreDraft ? undefined : drafts.current.get(path);
      loaded.current = value;
      base.current = saved?.baseFingerprint ?? value.fingerprint;
      setDocument(value);
      setImage(undefined);
      setText(saved?.content ?? value.content);
      // Reload replaces the editor document only after the new content has
      // arrived. Rebuilding at this point clears the old CodeMirror history
      // instead of turning the disk replacement into an undoable change.
      if (ignoreDraft) setEditorResetKey((key) => key + 1);
      setOpenPaths((paths) =>
        paths.includes(path) ? paths : [...paths, path],
      );
      setView(nextView);
      setDiff(undefined);
      setDraftStatus("saved");
      setIssue(
        saved && saved.baseFingerprint !== value.fingerprint
          ? zh
            ? "磁盘文件已修改。草稿已保留，请对比后重新载入或合并。"
            : "The disk file changed. Your draft is preserved; compare, then reload or merge before saving."
          : undefined,
      );
      return true;
    } catch (error) {
      if (mounted.current && ticket === generation.current)
        setIssue(message(error));
      return false;
    }
  }
  function persistDraft(doc: FileDocument, value: string, fingerprint: string) {
    if (mounted.current) setDraftStatus("saving");
    queue.current = queue.current
      .then(async () => {
        const previous = drafts.current.get(doc.path);
        if (!previous && value === doc.content) {
          if (mounted.current) setDraftStatus("saved");
          return;
        }
        const saved = await request("draft.put", {
          ...scope,
          path: doc.path,
          content: value,
          baseFingerprint: fingerprint,
          expectedRevision: previous?.revision ?? 0,
          operationId: operationId(),
        });
        drafts.current.set(doc.path, saved);
        if (mounted.current && loaded.current?.path === doc.path)
          setDraftStatus(currentText.current === value ? "saved" : "unsaved");
      })
      .catch((error) => {
        if (mounted.current) {
          setDraftStatus("conflict");
          setIssue(message(error));
        }
      });
    return queue.current;
  }
  useEffect(() => {
    mounted.current = true;
    void request("draft.list", scope)
      .then((values) => {
        if (!mounted.current) return;
        drafts.current = new Map(values.map((draft) => [draft.path, draft]));
        if (initialPath) void open(initialPath, initialView);
      })
      .catch((error) => {
        if (mounted.current) setIssue(message(error));
      });
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, [projectId, worktreePath]);
  useEffect(() => {
    const changed = controlledView !== previousControlledView.current;
    previousControlledView.current = controlledView;
    if (
      controlledView &&
      controlledView !== internalView &&
      (changed || internalView !== "preview")
    )
      setInternalView(controlledView);
  }, [controlledView, internalView]);
  useEffect(() => {
    if (!initialPath || initialPath === document?.path) return;
    if (dirty) {
      setPending({ path: initialPath, view });
      return;
    }
    void open(initialPath, view);
  }, [initialPath]);
  useEffect(() => {
    if (document) onDocumentChange?.({ path: document.path, dirty });
  }, [document?.path, dirty, onDocumentChange]);
  useEffect(() => {
    if (
      !document ||
      (text === document.content && !drafts.current.has(document.path))
    )
      return;
    setDraftStatus("unsaved");
    const timer = setTimeout(
      () => void persistDraft(document, text, base.current),
      500,
    );
    debounce.current = timer;
    return () => clearTimeout(timer);
  }, [text, document]);
  useEffect(
    () => () => {
      const doc = loaded.current;
      if (doc && currentText.current !== doc.content)
        void persistDraft(doc, currentText.current, base.current);
    },
    [projectId, worktreePath],
  );
  useEffect(
    () =>
      registerDirtyEditor(
        editorId ?? `${projectId}:${worktreePath ?? ""}`,
        () => {
          if (!loaded.current || currentText.current === loaded.current.content)
            return Promise.resolve(true);
          if (closeResolver.current) return Promise.resolve(false);
          return new Promise<boolean>((resolve) => {
            closeResolver.current = resolve;
            setClosePrompt(true);
          });
        },
        {
          projectId,
          worktreePath,
          ownerSessionId,
          isDirty: () =>
            Boolean(
              loaded.current && currentText.current !== loaded.current.content,
            ),
          path: () => loaded.current?.path,
        },
      ),
    [editorId, projectId, worktreePath, ownerSessionId],
  );
  useEffect(() => {
    if (view !== "diff" || !document) return;
    let alive = true;
    void request("git.diff", { ...scope, path: document.path, staged })
      .then((value) => {
        if (alive) setDiff(value);
      })
      .catch((error) => {
        if (alive) setIssue(message(error));
      });
    return () => {
      alive = false;
    };
  }, [
    view,
    staged,
    document?.path,
    document?.fingerprint,
    projectId,
    worktreePath,
  ]);
  async function deleteDraft(path: string) {
    clearTimeout(debounce.current);
    await queue.current;
    const previous = drafts.current.get(path);
    if (previous) {
      await request("draft.delete", {
        id: previous.id,
        expectedRevision: previous.revision,
        operationId: operationId(),
      });
      drafts.current.delete(path);
    }
  }
  async function saveFile(): Promise<boolean> {
    const doc = loaded.current;
    if (!doc || doc.readonly || busy) return false;
    const value = currentText.current;
    setBusy(true);
    setIssue(undefined);
    try {
      const saved = await request("filesystem.write", {
        ...scope,
        path: doc.path,
        content: value,
        expectedFingerprint: base.current,
        operationId: operationId(),
      });
      loaded.current = saved;
      base.current = saved.fingerprint;
      setDocument(saved);
      if (currentText.current === value) {
        await deleteDraft(doc.path);
        setDraftStatus("saved");
      } else await persistDraft(saved, currentText.current, saved.fingerprint);
      void refreshGit();
      return true;
    } catch (error) {
      setIssue(message(error));
      return false;
    } finally {
      setBusy(false);
    }
  }
  const choose = (path: string, nextView: View = "file") => {
    if (embedded && onOpenPath) {
      onOpenPath(path, nextView);
      return;
    }
    if (document?.path === path) {
      setView(nextView);
      return;
    }
    if (dirty) {
      setPending({ path, view: nextView });
      return;
    }
    void open(path, nextView);
  };
  const closeOpenTabs = (kind: "current" | "others" | "all") => {
    const active = document?.path;
    const remaining =
      kind === "all"
        ? []
        : kind === "current"
          ? openPaths.filter((path) => path !== active)
          : openPaths.filter((path) => path === active);
    setOpenPaths(remaining);
    if (kind === "current" && remaining.length) {
      const index = Math.max(0, openPaths.indexOf(active ?? ""));
      void open(remaining[Math.min(index, remaining.length - 1)], view);
      return;
    }
    if (kind === "all" || kind === "current") {
      loaded.current = undefined;
      setDocument(undefined);
      setImage(undefined);
      setText("");
      onDocumentChange?.({ path: "", dirty: false });
    }
  };
  const requestClose = (kind: "current" | "others" | "all") => {
    if (!document || (kind === "others" && openPaths.length < 2)) return;
    if (dirty) {
      setPending({ view, close: kind });
      return;
    }
    closeOpenTabs(kind);
  };
  async function continuePending(save: boolean) {
    if ((!pending && !closePrompt) || !document) return;
    if (save && !(await saveFile())) return;
    try {
      if (!save) {
        await deleteDraft(document.path);
        currentText.current = document.content;
        setText(document.content);
        if (!pending?.reload) setEditorResetKey((value) => value + 1);
      }
      if (closePrompt) {
        setClosePrompt(false);
        closeResolver.current?.(true);
        closeResolver.current = undefined;
        return;
      }
      const next = pending!;
      setPending(undefined);
      if (next.close) {
        closeOpenTabs(next.close);
        return;
      }
      if (next.path) {
        // A successful reload resets only after the new document is in state;
        // a failed reload still clears the discarded document's history.
        const opened = await open(next.path, next.view, !!next.reload);
        if (next.reload && !opened) setEditorResetKey((key) => key + 1);
      }
    } catch (error) {
      setIssue(message(error));
    }
  }
  async function changeIndex(unstage: boolean) {
    if (!document || dirty) return;
    setBusy(true);
    try {
      await request(unstage ? "git.unstage" : "git.stage", {
        ...scope,
        paths: [document.path],
        expectedFingerprints: unstage
          ? undefined
          : { [document.path]: document.fingerprint },
        operationId: operationId(),
      });
      await refreshGit();
      setStaged(!unstage);
      setDiff(
        await request("git.diff", {
          ...scope,
          path: document.path,
          staged: !unstage,
        }),
      );
    } catch (error) {
      setIssue(message(error));
    } finally {
      setBusy(false);
    }
  }
  const workbenchScope = {
    projectId,
    worktreePath,
    rootPath: rootPath ?? worktreePath ?? "",
  };
  const standaloneActions: WorkbenchActions = {
    openFile: (path) => choose(path, "file"),
    openDiff: (path, nextStaged) => {
      setStaged(nextStaged);
      choose(path, "diff");
    },
    dirtyPaths: () => (dirty && document ? [document.path] : []),
    renamed: (from, to) => {
      setOpenPaths((paths) =>
        paths.map((path) => (coveredBy(path, from) ? to + path.slice(from.length) : path)),
      );
      if (document && coveredBy(document.path, from))
        void open(to + document.path.slice(from.length), view === "preview" ? "file" : view, true);
    },
    deleted: (path) => {
      setOpenPaths((paths) => paths.filter((candidate) => !coveredBy(candidate, path)));
      if (document && coveredBy(document.path, path)) closeOpenTabs("current");
    },
  };
  // Index text for the editor's change gutter (null when untracked or not a repository).
  useEffect(() => {
    if (!document || image || view !== "file") return;
    let alive = true;
    void request("git.diff", { ...scope, path: document.path, staged: false })
      .then((value) => {
        if (alive) setGitBaseText(value.binary || value.indexFingerprint == null ? null : value.oldText);
      })
      .catch(() => {
        if (alive) setGitBaseText(null);
      });
    return () => {
      alive = false;
    };
  }, [document?.path, document?.fingerprint, view, projectId, worktreePath, gitState.status]);
  useEffect(() => {
    if (!blameOn || !document || dirty) {
      setBlame(undefined);
      return;
    }
    let alive = true;
    void request("git.blame", { ...scope, path: document.path })
      .then((value) => {
        if (alive) setBlame(value);
      })
      .catch((error) => {
        if (alive) {
          setBlameOn(false);
          setIssue(workbenchError(error, zh));
        }
      });
    return () => {
      alive = false;
    };
  }, [blameOn, document?.path, document?.fingerprint, dirty]);
  useEffect(() => setHunk((value) => Math.max(0, Math.min(value, hunkCount - 1))), [hunkCount]);
  const moveHunk = (step: number) => {
    if (!hunkCount) return;
    const next = (hunk + step + hunkCount) % hunkCount;
    setHunk(next);
    mergeEditor.current?.focusChunk(next);
  };
  /** Stages (unstaged view) or unstages (staged view) the hunk under the cursor or the navigator. */
  async function applyHunk() {
    const editor = mergeEditor.current;
    if (!document || !diff || diff.binary || dirty || !editor) return;
    const snapshot = editor.snapshot();
    const atCursor = editor.cursorChunk();
    const chunk = snapshot.chunks[atCursor >= 0 ? atCursor : hunk];
    if (!chunk) return;
    const content = staged
      ? unstageChunk(snapshot.a, snapshot.b, chunk)
      : stageChunk(snapshot.a, snapshot.b, chunk);
    setBusy(true);
    setIssue(undefined);
    try {
      await request("git.index.write", {
        ...scope,
        path: document.path,
        content: withLineBreaks(content, staged ? diff.newText : diff.oldText),
        expectedIndexFingerprint: diff.indexFingerprint ?? null,
        operationId: operationId(),
      });
      setDiff(await request("git.diff", { ...scope, path: document.path, staged }));
      await refreshGit();
    } catch (error) {
      setIssue(workbenchError(error, zh));
    } finally {
      setBusy(false);
    }
  }
  const editorReveal =
    document && document.path === initialPath && reveal
      ? { ...reveal, path: document.path }
      : undefined;
  const activePreviewFile = previewNavigation?.files.find(
    (file) => file.id === previewNavigation.activeId,
  );
  const embeddedPath = document?.path ?? activePreviewFile?.path ?? initialPath;
  const previewLabel = (file: { id: string; path: string; kind: View }) =>
    `${file.path.split(/[\\/]/).join(" › ")}${
      file.kind === "diff" ? ` · ${copy.diff}` : file.kind === "preview" ? ` · ${copy.preview}` : ""
    }${file.id === previewNavigation?.activeId && dirty ? " ·" : ""}`;
  const embeddedNavigation = () => {
    if (!embedded || !previewNavigation) return null;
    if (previewNavigation.files.length > 1) {
      return (
        <Select
          className="embedded-file-navigation"
          value={previewNavigation.activeId}
          disabled={previewNavigation.closing}
          title={activePreviewFile?.path ?? embeddedPath}
          aria-label={zh ? "切换文件预览" : "Switch file preview"}
          onChange={(event) => previewNavigation.onSelect(event.target.value)}
        >
          {previewNavigation.files.map((file) => (
            <option key={file.id} value={file.id}>
              <span title={file.path}>{previewLabel(file)}</span>
            </option>
          ))}
        </Select>
      );
    }
    return embeddedPath ? (
      <span className="embedded-file-breadcrumb" title={embeddedPath}>
        {embeddedPath.split(/[\\/]/).join(" › ")}
        {dirty ? " ·" : ""}
      </span>
    ) : null;
  };
  const embeddedClose = () =>
    embedded && previewNavigation ? (
      <button
        type="button"
        className="icon-btn embedded-file-close"
        title={zh ? "关闭文件预览" : "Close file preview"}
        aria-label={zh ? "关闭文件预览" : "Close file preview"}
        disabled={previewNavigation.closing}
        onClick={previewNavigation.onClose}
      >
        <Icon name="close" />
      </button>
    ) : null;

  return (
    <section className={`file-workspace ${toolsOpen ? "tools-open" : ""} ${embedded ? "embedded" : ""}`}>
      {toolsOpen && (
        <aside className="file-list tt-file-tree wb-embedded-tools">
          {/* Same header shape as the session side bar; each view portals its actions into it. */}
          <div className="wb-tools-head">
            <strong>{copy.files}</strong>
            {/* The file bar's pressed Files & Git toggle opens and closes this column; no second toggle here. */}
            <div className="wb-panel-actions" ref={setFilesToolsHost} />
          </div>
          <div className="wb-tools-scroll">
            <ExplorerView
              scope={workbenchScope}
              actions={standaloneActions}
              git={gitState}
              zh={zh}
              activePath={document?.path}
              toolbarHost={filesToolsHost}
            />
            <section className="wb-tools-section" aria-label={zh ? "源代码管理" : "Source Control"}>
              <div className="wb-tools-head">
                <strong>{zh ? "源代码管理" : "Source Control"}</strong>
                <div className="wb-panel-actions" ref={setScmToolsHost} />
              </div>
              <SourceControlView
                scope={workbenchScope}
                actions={standaloneActions}
                git={gitState}
                zh={zh}
                compact
                toolbarHost={scmToolsHost}
              />
            </section>
            {gitState.status && (
              <GitMergeControls
                scope={scope}
                disabled={busy || dirty}
                onChanged={async () => {
                  await refreshGit();
                  if (document && !dirty) await open(document.path, view, true);
                }}
              />
            )}
          </div>
        </aside>
      )}
      <div className="editor-area">
        {document ? (
          <>
            {view !== "diff" && (
              <div className="tt-editor-tabs file-view-tabs">
                {embedded ? (
                  embeddedNavigation() ?? (
                    <span className="embedded-file-breadcrumb" title={document.path}>
                      {document.path.split(/[\\/]/).join(" › ")}
                      {dirty ? " ·" : ""}
                    </span>
                  )
                ) : (
                  openPaths.map((path) => (
                    <button
                      className={`tt-editor-tab ${path === document.path ? "active" : ""}`}
                      key={path}
                      onClick={() => choose(path, view)}
                    >
                      {path.split(/[\\/]/).at(-1)}
                      {path === document.path && dirty ? " ·" : ""}
                    </button>
                  ))
                )}
                <span className="grow" />
                {embedded && /\.(md|mdx|html?)$/i.test(document.path) && (
                  <button
                    className="btn"
                    onClick={() => setView(view === "preview" ? "file" : "preview")}
                  >
                    {view === "preview"
                      ? zh
                        ? "查看源代码"
                        : "Source code"
                      : copy.preview}
                  </button>
                )}
                {view === "file" && !image && gitState.status && (
                  <button
                    type="button"
                    className="btn editor-toolbar-toggle"
                    aria-pressed={blameOn}
                    disabled={dirty && !blameOn}
                    title={dirty ? (zh ? "保存后可查看逐行追溯" : "Save to show blame") : zh ? "显示每行最后修改的提交" : "Show the last commit for each line"}
                    onClick={() => setBlameOn((value) => !value)}
                  >
                    {zh ? "逐行追溯" : "Blame"}
                  </button>
                )}
                {onOpenHistory && !image && (
                  <button type="button" className="icon-btn" title={zh ? "文件历史" : "File history"} aria-label={zh ? "文件历史" : "File history"} onClick={() => onOpenHistory({ path: document.path })}>
                    <Icon name="clock" />
                  </button>
                )}
                {onSendToAgent && !image && (
                  <button type="button" className="icon-btn" title={zh ? "发送给 Agent（Ctrl+L 发送选中行）" : "Send to agent (Ctrl+L sends the selected lines)"} aria-label={zh ? "发送给 Agent" : "Send to agent"} onClick={() => onSendToAgent({ path: document.path })}>
                    <Icon name="spark" />
                  </button>
                )}
                {embedded && (
                  <button
                    className="btn"
                    onClick={() => void saveFile()}
                    disabled={busy || document.readonly || !dirty}
                  >
                    {copy.save}
                  </button>
                )}
                {!embedded && (
                  <button
                    className="icon-btn file-tools-button"
                    title={zh ? "文件与 Git" : "Files & Git"}
                    aria-label={zh ? "文件与 Git" : "Files & Git"}
                    aria-pressed={toolsOpen}
                    onClick={() => setToolsOpen((value) => !value)}
                  >
                    <Icon name="panel" />
                  </button>
                )}
                {embeddedClose()}
                {draftStatus === "conflict" && (
                  <button
                    className="btn"
                    onClick={() =>
                      void persistDraft(document, text, base.current)
                    }
                  >
                    {copy.retry}
                  </button>
                )}
              </div>
            )}
            {view === "diff" ? (
              <section className="tt-diff-shell">
                <div className="file-bar">
                  {embeddedNavigation()}
                  {!embedded && (
                    <button
                      className="icon-btn file-tools-button"
                      title={zh ? "文件与 Git" : "Files & Git"}
                      aria-label={zh ? "文件与 Git" : "Files & Git"}
                      aria-pressed={toolsOpen}
                      onClick={() => setToolsOpen((value) => !value)}
                    >
                      <Icon name="panel" />
                    </button>
                  )}
                  {!previewNavigation && <span className="path">{document.path}</span>}
                  <span className="dim">
                    {staged ? copy.staged : copy.unstaged} ·{" "}
                    {staged || document.readonly
                      ? copy.readOnly
                      : zh
                        ? "左侧基线只读，右侧可编辑"
                        : "Baseline is read-only; current file is editable"}
                  </span>
                  <span className="grow" />
                  {diff && !diff.binary && hunkCount > 0 && (
                    <span className="wb-hunk-nav" role="group" aria-label={zh ? "更改块" : "Hunks"}>
                      <button type="button" className="icon-btn" aria-label={zh ? "上一个更改块" : "Previous hunk"} onClick={() => moveHunk(-1)}><WbIcon name="chev-up" /></button>
                      <span className="wb-hunk-count">{hunk + 1}/{hunkCount}</span>
                      <button type="button" className="icon-btn" aria-label={zh ? "下一个更改块" : "Next hunk"} onClick={() => moveHunk(1)}><Icon name="chevron" /></button>
                      <button
                        type="button"
                        className="btn"
                        disabled={busy || dirty}
                        title={dirty ? (zh ? "请先保存文件" : "Save the file first") : undefined}
                        onClick={() => void applyHunk()}
                      >
                        {staged ? (zh ? "取消暂存此块" : "Unstage hunk") : (zh ? "暂存此块" : "Stage hunk")}
                      </button>
                    </span>
                  )}
                  <button
                    className="btn"
                    disabled={busy || dirty}
                    onClick={() => void changeIndex(staged)}
                  >
                    {staged
                      ? zh
                        ? "取消暂存"
                        : "Unstage"
                      : zh
                        ? "暂存文件"
                        : "Stage file"}
                  </button>
                  {!staged && diff && !diff.binary && (
                    <>
                      <button
                        className="btn"
                        onClick={() => mergeEditor.current?.revertLine()}
                      >
                        {zh ? "还原当前行" : "Revert current line"}
                      </button>
                      <button
                        className="btn"
                        onClick={() => mergeEditor.current?.revertHunk()}
                      >
                        {zh ? "还原当前块" : "Revert current hunk"}
                      </button>
                      <button
                        className="btn"
                        disabled={busy || document.readonly || !dirty}
                        onClick={() => void saveFile()}
                      >
                        {zh ? "保存变更" : "Save changes"}
                      </button>
                      <Select
                        value={staged ? "staged" : "unstaged"}
                        onChange={(event) =>
                          setStaged(event.target.value === "staged")
                        }
                        aria-label={zh ? "差异状态" : "Diff state"}
                      >
                        <option value="unstaged">{copy.unstaged}</option>
                        <option value="staged">{copy.staged}</option>
                      </Select>
                    </>
                  )}
                  {embeddedClose()}
                </div>
                {diff?.binary ? (
                  <p className="tt-editor-state">
                    {zh
                      ? "二进制文件无法显示文本对比。"
                      : "Binary files cannot be compared as text."}
                  </p>
                ) : diff ? (
                  <MergeEditor
                    ref={mergeEditor}
                    path={document.path}
                    oldText={diff.oldText}
                    newText={staged ? diff.newText : text}
                    readOnly={staged || document.readonly}
                    onChange={setText}
                    onSave={() => void saveFile()}
                    onChunks={setHunkCount}
                  />
                ) : (
                  <p className="tt-editor-state">
                    {zh ? "正在读取对比…" : "Loading diff…"}
                  </p>
                )}
              </section>
            ) : view === "preview" ? (
              <FilePreview
                {...scope}
                path={document.path}
                savedContent={document.content}
                content={text}
                image={image}
                embedded={embedded}
              />
            ) : (
              <>
                {!embedded && <div className="file-bar">
                  <span className="path" title={document.path}>
                    {document.path}
                  </span>
                  <span className="file-dirty" data-testid="editor-dirty" hidden={!dirty}>
                    {zh ? "未保存" : "Unsaved"}
                  </span>
                  <span className="dim">
                    {copy[draftStatus]}
                    {document.readonly ? ` · ${copy.readOnly}` : ""}
                  </span>
                  <span className="grow" />
                  <button
                    className="btn"
                    onClick={() => void saveFile()}
                    disabled={busy || document.readonly || !dirty}
                  >
                    {copy.save}
                  </button>
                  {/\.(md|mdx|html?)$/i.test(document.path) && (
                    <button className="btn" onClick={() => setView("preview")}>
                      {copy.preview}
                    </button>
                  )}
                  {!embedded && (
                    <button
                      className="btn"
                      onClick={() => requestClose("current")}
                    >
                      {zh ? "关闭当前" : "Close current"}
                    </button>
                  )}
                  {!embedded && (
                    <button
                      className="btn"
                      disabled={openPaths.length < 2}
                      onClick={() => requestClose("others")}
                    >
                      {zh ? "关闭其他" : "Close others"}
                    </button>
                  )}
                  {!embedded && (
                    <button
                      className="icon-btn"
                      onClick={() => requestClose("all")}
                      title={zh ? "关闭全部文件" : "Close all files"}
                      aria-label={zh ? "关闭全部文件" : "Close all files"}
                    >
                      <Icon name="close" />
                    </button>
                  )}
                </div>
                }
                <section className="tt-editor-shell">
                  <CodeEditor
                    path={document.path}
                    value={text}
                    onChange={setText}
                    onSave={() => void saveFile()}
                    readOnly={document.readonly}
                    reveal={editorReveal}
                    resetKey={editorResetKey}
                    gitBaseText={gitBaseText}
                    blame={blameOn && !dirty ? blame : undefined}
                    onBlameCommit={onOpenHistory ? (commit) => onOpenHistory({ path: document.path, commit }) : undefined}
                    onSendToAgent={onSendToAgent ? (lines) => onSendToAgent({ path: document.path, ...lines }) : undefined}
                  />
                </section>
              </>
            )}
          </>
        ) : (
          <>
            {embedded && previewNavigation && (
              <div className="tt-editor-tabs file-view-tabs embedded-file-pending-header">
                {embeddedNavigation()}
                <span className="grow" />
                {embeddedClose()}
              </div>
            )}
            {/* An embedded tab always has a path: until it is read, say so instead of offering the
                standalone browser (its Files panel is hidden in tabs; the session side bar replaces it). */}
            <div className="empty tt-editor-state">
              {embedded && initialPath && !issue ? (
                <span>{zh ? "正在读取…" : "Loading…"}</span>
              ) : (
                <>
                  <strong>{copy.empty}</strong>
                  {!embedded && !toolsOpen && (
                    <button className="btn" onClick={() => setToolsOpen(true)}>
                      {zh ? "浏览文件" : "Browse files"}
                    </button>
                  )}
                </>
              )}
            </div>
          </>
        )}
        {issue && (
          <div role="alert" className="tt-editor-conflict">
            {issue}
            {document && (
              <button
                onClick={() =>
                  setPending({ path: document.path, view, reload: true })
                }
              >
                {copy.reload}
              </button>
            )}
          </div>
        )}
      </div>
      {(pending || closePrompt) && (
        <SurfaceDialog
          title={copy.question}
          subtitle={document?.path}
          icon="file"
          size="sm"
          onClose={() => {
            setPending(undefined);
            setClosePrompt(false);
            closeResolver.current?.(false);
            closeResolver.current = undefined;
          }}
          footer={
            <>
              <button
                className="btn"
                onClick={() => {
                  setPending(undefined);
                  setClosePrompt(false);
                  closeResolver.current?.(false);
                  closeResolver.current = undefined;
                }}
              >
                {copy.cancel}
              </button>
              <button
                className="btn"
                onClick={() => void continuePending(false)}
              >
                {copy.discard}
              </button>
              <button
                className="btn btn-primary"
                disabled={busy}
                onClick={() => void continuePending(true)}
              >
                {copy.save}
              </button>
            </>
          }
        >
          <p>{copy.detail}</p>
        </SurfaceDialog>
      )}
    </section>
  );
}
