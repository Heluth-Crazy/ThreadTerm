import { Select } from "./ui/Select";
import { Icon } from "./PrototypeIcon";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  Draft,
  FileDocument,
  GitBlame,
  GitCompareDiff,
  GitCompareFiles,
  GitCompareRef,
  GitDiff,
} from "@threadterm/protocol";
import { operationId, request } from "../bridge";
import { CodeEditor } from "./CodeEditor";
import { ConflictStageAction } from "./ConflictStageAction";
import { useConflictStageGuard } from "./useConflictStageGuard";
import { useConflictStates } from "./useConflictStates";
import { conflictStageReason } from "../workbench/conflictStage";
import { conflictBlocks } from "../workbench/conflictBlocks";
import { isConflict } from "../workbench/gitDecorations";
import { notifyFilesChanged } from "../workbench/types";
import { MergeEditor, type MergeEditorHandle, type MergeSelection } from "./MergeEditor";
import { CommentForm, PendingComments, useFileComments } from "./FileComments";
import type { FileCommentsHost } from "../fileCommentsHost";
import { sameCommentVersion, type CommentVersion } from "../reviewComments";
import { GitMergeControls } from "./GitMergeControls";
import { SurfaceDialog } from "./SurfaceDialog";
import { FilePreview } from "./FilePreview";
import "./file-workspace.css";
import "./file-bar.css";
import { FileBarActions, FileBreadcrumb } from "./FileBarActions";
import type { ContextMenuItem } from "./ContextMenu";
import { registerDirtyEditor } from "../dirtyEditors";
import { ExplorerView } from "./ExplorerView";
import { SourceControlView } from "./SourceControlView";
import { useGitStatus } from "./WorkbenchSideBar";
import { WbIcon } from "../workbench/icons";
import type { ChunkRange } from "../workbench/indexEdit";
import { indexChunkContent } from "../workbench/gutterHunk";
import { workbenchError } from "../workbench/errors";
import { coveredBy, type WorkbenchActions } from "../workbench/types";
import { isDocumentPinned, sessionDocumentError } from "../sessionDocuments";
import { showContextMenu } from "./ContextMenu";
import { diffSurfaceMenuItems, sourceEditorMenuItems } from "../fileSurfaceContextMenuItems";
import { changedFileContext } from "./GitContextActions";
import { sendContextToAgent } from "./ContextSendAction";
import { readDiffDocument } from '../fileDiffDocument';
import { gitDiffFiles } from '../diffFileNavigation';
import { compareDiffEditable, compareOriginalPath, comparePaths, compareReloadText, compareStaleText, compareTabSignature } from '../workbench/branchScope';
import { DiffFileNavigation } from './DiffFileNavigation';
import { externalFileError, externalFileErrorCode, externalSelectionText } from '../externalFiles';
import { displayPath } from '../displayPath';
import { EditorView } from '@codemirror/view';
import type { GitWorkbenchAction, GitWorkbenchCommand } from '../workbench/gitKeyboardCommand';

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
  /** Branch-versus-base diff (`git.compare.diff`) instead of the index diff. */
  initialCompare?: GitCompareRef;
  /** Absolute root for "Copy path" in the standalone tools panel. */
  rootPath?: string;
  /** A registered external file is read through the explicit external-file API only. */
  externalId?: string;
  /** Updates a recovered external registration in the persisted tab layout. */
  onExternalChange?: (file: { externalId: string; path: string }) => void;
  /** Whether this tab is active; external files refresh only on activation. */
  active?: boolean;
  onSendToAgent?: (target: { path: string; startLine?: number; endLine?: number; selection?: string }) => void;
  onOpenHistory?: (target: { path?: string; commit?: string }) => void;
  /** Host confirms dirty edits, awaits load(), then retargets the same tab only on success. */
  onNavigateDiff?: (path: string, load: () => Promise<boolean>) => void;
  navigationDisabled?: boolean;
  /** Present only for file tabs in the active session's worktree. */
  sessionDocuments?: WorkbenchActions["sessionDocuments"];
  comments?: FileCommentsHost;
};
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const imagePath = (path: string) => /\.(?:png|jpe?g|gif|webp)$/i.test(path);

export function ExternalFileBoundary({ path, zh, noticeOpen, onNoticeToggle, onCopy, onReload }: { path: string; zh: boolean; noticeOpen: boolean; onNoticeToggle: () => void; onCopy: () => void; onReload: () => void }) {
  path = displayPath(path);
  const notice = zh ? "ThreadTerm 以只读方式打开此文件。发送它只会让 Agent 按自身权限读取，不会授予写入权限。" : "ThreadTerm opens this file read-only. Sending it lets the agent read it under its own permissions and never grants write access.";
  return <div className="external-file-boundary" data-testid="external-file-boundary">
    <button type="button" className="ws-chip external-file-boundary-chip" aria-expanded={noticeOpen} aria-label={zh ? "工作区外 · 只读" : "Outside workspace · Read-only"} title={notice} onClick={onNoticeToggle}>
      {/* Narrow bars keep "Read-only" whole instead of clipping the longer label mid-word. */}
      <span className="external-file-chip-full">{zh ? "工作区外 · 只读" : "Outside workspace · Read-only"}</span>
      <span className="external-file-chip-short" aria-hidden="true">{zh ? "只读" : "Read-only"}</span>
    </button>
    {noticeOpen && <span className="external-file-boundary-notice" role="note">{notice}</span>}
    <span className="path external-file-boundary-path" title={path} aria-label={path}><span className="external-file-path-prefix">{path.slice(0,Math.max(path.lastIndexOf('/'),path.lastIndexOf('\\'))+1)}</span><span className="external-file-path-name">{path.split(/[\\/]/).at(-1)}</span></span>
    <button type="button" className="icon-btn icon-btn-sm external-file-boundary-action file-bar-optional" title={zh ? "复制路径" : "Copy path"} aria-label={zh ? "复制路径" : "Copy path"} onClick={onCopy}><WbIcon name="copy"/></button>
    <button type="button" className="icon-btn icon-btn-sm external-file-boundary-action file-bar-optional" title={zh ? "从磁盘重新载入" : "Reload from disk"} aria-label={zh ? "从磁盘重新载入" : "Reload from disk"} onClick={onReload}><WbIcon name="refresh"/></button>
  </div>;
}

export function FileWorkspace(props: Props) {
  return <FileWorkspaceInstance key={`${props.projectId}\0${props.worktreePath ?? ""}\0${props.externalId ?? ""}`} {...props} />;
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
  initialCompare,
  rootPath,
  externalId,
  onExternalChange,
  active,
  onSendToAgent,
  onOpenHistory,
  onNavigateDiff,
  navigationDisabled,
  sessionDocuments,
  comments: commentsHost,
}: Props) {
  const external = externalId !== undefined;
  const scope = { projectId, worktreePath };
  // A standalone workspace opened without a file (project Files page, Settings → Tools dialog) has
  // nothing else to show, so it starts with its Files & Git panel open.
  const [toolsOpen, setToolsOpen] = useState(!embedded && !initialPath);
  const [filesToolsHost, setFilesToolsHost] = useState<HTMLDivElement | null>(null);
  const [scmToolsHost, setScmToolsHost] = useState<HTMLDivElement | null>(null);
  const [gitCommand, setGitCommand] = useState<GitWorkbenchCommand>();
  const gitWorkbenchHost=useRef(crypto.randomUUID());
  const [openPaths, setOpenPaths] = useState<string[]>([]);
  const [document, setDocument] = useState<FileDocument>();
  const [image, setImage] = useState<{ mime: string; data: string }>();
  const [text, setText] = useState("");
  const [resolvedNotice, setResolvedNotice] = useState<string>();
  useEffect(() => { if (!resolvedNotice) return; const timer = setTimeout(() => setResolvedNotice(undefined), 4000); return () => clearTimeout(timer); }, [resolvedNotice]);
  const externalInitialView: View = external && initialView === "diff" ? "file" : initialView;
  const [internalView, setInternalView] = useState<View>(externalInitialView);
  const previousControlledView = useRef<View | undefined>(controlledView);
  const requestedView = internalView === "preview" ? "preview" : (controlledView ?? internalView);
  const view: View = external && requestedView === "diff" ? "file" : requestedView;
  const setView = (next: View) => {
    setInternalView(next);
    if (next !== "preview") onViewChange?.(next);
  };
  const [staged, setStaged] = useState(initialStaged ?? false);
  // Branch-versus-base diffs reuse this surface: the old side is the merge base, the new side the
  // working file (or HEAD with committedOnly). Base resolution and the file list stay in the side bar.
  const [localCompare, setLocalCompare] = useState<GitCompareRef|undefined>(initialCompare);
  const compare = localCompare;
  const [compareStale, setCompareStale] = useState(false);
  // The path this instance was opened with. Retargeting the tab (Alt+→) changes `initialPath`, but a
  // compare tab's own `originalPath` only ever belongs to this first file.
  const firstPath = useRef(initialPath);
  // A tab that is re-pointed at another base (or another scope) re-syncs here instead of keeping the
  // stale one; the Branch scope preference itself stays in memory only.
  const [compareTabKey, setCompareTabKey] = useState(compareTabSignature(initialCompare));
  const incomingCompareTabKey = compareTabSignature(initialCompare);
  if(incomingCompareTabKey !== compareTabKey) {
    setCompareTabKey(incomingCompareTabKey);
    setLocalCompare(initialCompare);
    setCompareStale(false);
  }
  const [compareFiles, setCompareFiles] = useState<GitCompareFiles>();
  const [hunk, setHunk] = useState(0);
  const [hunkCount, setHunkCount] = useState(0);
  const [gitBaseText, setGitBaseText] = useState<string | null>(null);
  const gutterBase=useRef<{path:string;diff:GitDiff}|undefined>(undefined);
  const [gutterRevision,setGutterRevision]=useState(0);
  const gutterStagePending=useRef(false);
  const [diffReveal,setDiffReveal]=useState<{path:string;line:number}>();
  const [blameOn, setBlameOn] = useState(false);
  const [blame, setBlame] = useState<GitBlame>();
  const [diff, setDiff] = useState<GitDiff>();
  const mergeEditor = useRef<MergeEditorHandle>(null);
  const [issue, setIssue] = useState<string | { externalError: unknown }>();
  const [busy, setBusy] = useState(false);
  const [fileNavigation, setFileNavigation] = useState(false);
  const [documentPinning, setDocumentPinning] = useState(false);
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
  const sourceEditorHost = useRef<HTMLElement>(null);
  const externalPath = useRef<string | undefined>(undefined);
  currentText.current = text;
  const mounted = useRef(true);
  const generation = useRef(0);
  const dirty = !external && !!document && text !== document.content;
  const selectedExternalText = () => {
    const element=sourceEditorHost.current?.querySelector<HTMLElement>('.cm-content');
    const editor=element?EditorView.findFromDOM(element):null;
    return editor?externalSelectionText(editor.state):'';
  };
  const zh = globalThis.document.documentElement.lang === "zh-CN";
  const issueText = typeof issue === "object" ? externalFileError(issue.externalError, zh) : issue;
  const pinnedDocument = !external && document && sessionDocuments && isDocumentPinned(sessionDocuments.documents, document.path);
  const sessionDocumentIssue = sessionDocuments?.error;
  const needsSessionDocuments = Boolean(!external && sessionDocuments && document && !image);
  useEffect(() => needsSessionDocuments ? sessionDocuments?.retain() : undefined, [needsSessionDocuments, sessionDocuments?.retain]);
  const toggleSessionDocument = async () => {
    if (!document || !sessionDocuments || documentPinning || sessionDocuments.loading) return;
    setDocumentPinning(true);
    setIssue(undefined);
    try {
      await sessionDocuments.toggle(document.path);
    } catch (error) {
      setIssue(sessionDocumentError(error, zh));
    } finally {
      setDocumentPinning(false);
    }
  };
  const commentScope = useMemo(() => {
    const root = worktreePath ?? commentsHost?.projectRoot(projectId);
    return commentsHost && root ? { projectId, root } : undefined;
  }, [commentsHost, projectId, worktreePath]);
  const fileComments = useFileComments(commentScope);
  const [commentSelection, setCommentSelection] = useState<MergeSelection>();
  const [commentDraft, setCommentDraft] = useState<MergeSelection>();
  const [externalNoticeOpen, setExternalNoticeOpen] = useState(false);
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

  const gitState = useGitStatus(scope, (toolsOpen || view === "diff" || view === "file") && !external, zh);
  const conflictedFile = Boolean(document && gitState.status?.changes.some(change => change.path === document.path && isConflict(change)));
  const conflictStates = useConflictStates(scope, conflictedFile && document ? [document.path] : [], document?.fingerprint);
  const stageReason = conflictedFile && document ? conflictStageReason(conflictStates[document.path], zh) : undefined;
  const stageGuard = useConflictStageGuard(scope, zh);
  const plainCommentVersion: CommentVersion = { kind: "file" };
  const diffCommentVersion: CommentVersion = { kind: "git", staged };
  const plainCommentMarks = useMemo(
    () =>
      document
        ? fileComments
            .filter(
              (comment) =>
                comment.path === document.path &&
                comment.side === "new" &&
                sameCommentVersion(comment.version, plainCommentVersion),
            )
            .map(({ startLine, endLine }) => ({ startLine, endLine }))
        : [],
    [document?.path, fileComments],
  );
  const diffCommentMarks = useMemo(
    () =>
      document
        ? fileComments
            .filter(
              (comment) =>
                comment.path === document.path &&
                sameCommentVersion(comment.version, diffCommentVersion),
            )
            .map(({ side, startLine, endLine }) => ({ side, startLine, endLine }))
        : [],
    [document?.path, fileComments, staged],
  );
  useEffect(() => {
    setCommentSelection(undefined);
    setCommentDraft(undefined);
  }, [commentScope?.projectId, commentScope?.root, document?.path, view, staged]);
  useEffect(() => {
    if (dirty) setCommentDraft(undefined);
  }, [dirty]);
  const openEditorContextMenu = (menu: { x: number; y: number; selection: { side?: "old" | "new"; startLine: number; endLine: number; text: string }; hasSelection?: boolean; target: HTMLElement; copy?: () => Promise<void>; cut?: () => Promise<void>; paste?: () => Promise<void>; selectAll?: () => void }, kind: "file" | "diff") => {
    const { selection, x, y, target } = menu;
    const canComment = Boolean(commentScope && commentsHost && selection && !busy && !dirty && !commentDraft);
    const reason = dirty
      ? (zh ? "请先保存或放弃修改：修改会让行号变化。" : "Save or discard your edits first: they move the lines.")
      : busy
        ? (zh ? "请等待当前文件操作完成。" : "Wait for the current file action to finish.")
      : commentDraft
        ? (zh ? "请先完成当前评论。" : "Finish the current comment first.")
        : (zh ? "此工作区无法添加评论。" : "Comments are unavailable in this workspace.");
    const common = {zh,lines:selection,canComment,commentReason:reason,comment:()=>setCommentDraft(kind === "file" ? {side:"new",...selection} : selection as MergeSelection)};
    const sourceItems = kind === "diff" ? diffSurfaceMenuItems({...common,prefix:"editor",hasSelection:Boolean(menu.hasSelection),sendDiff:!compare&&commentsHost?.attachContext?async()=>sendContextToAgent({host:commentsHost,context:await changedFileContext(scope,document!.path,staged,zh),zh,sourceRoot:worktreePath??rootPath??commentsHost.projectRoot(projectId)}):undefined,copy:menu.copy ?? (()=>navigator.clipboard.writeText(selection.text)),copyPath:()=>navigator.clipboard.writeText(document!.path)}) : sourceEditorMenuItems({...common,hasSelection:Boolean(menu.hasSelection),readOnly:Boolean(external||document?.readonly),send:onSendToAgent?()=>onSendToAgent({path:document!.path,...(menu.hasSelection?{startLine:selection.startLine,endLine:selection.endLine, ...(external?{selection:selectedExternalText()}:{})}:{})}):undefined,plans:external?undefined:sessionDocuments?()=>void toggleSessionDocument():undefined,pinned:Boolean(pinnedDocument),plansDisabled:Boolean(external||sessionDocuments?.loading||documentPinning||sessionDocumentIssue),plansReason:external?(zh?"工作区外文件不能固定到计划与文档。":"Outside-workspace files cannot be pinned to Plans & docs."):sessionDocumentIssue?(zh?"计划与文档当前不可用。":"Plans & docs is unavailable."):undefined,history:external?undefined:onOpenHistory?()=>onOpenHistory({path:document!.path}):undefined,copy:menu.copy??(()=>navigator.clipboard.writeText(selection.text)),cut:menu.cut??(()=>{}),paste:menu.paste??(()=>{}),selectAll:menu.selectAll??(()=>{}),copyPath:()=>navigator.clipboard.writeText(document!.path),copyReference:()=>navigator.clipboard.writeText(`${document!.path}:${selection.startLine}-${selection.endLine}`)});
    showContextMenu({ x, y, restoreFocus: target, items: sourceItems });
  };
  async function refreshGit() {
    await gitState.refresh();
  }
  async function open(
    path: string,
    nextView: View = "file",
    ignoreDraft = false,
  ) {
    const ticket = ++generation.current;
    const source = loaded.current;
    const changingFile = Boolean(source && source.path !== path);
    setFileNavigation(changingFile);
    // Recheck live text, including edits dispatched before React applies the read-only state.
    const canApply = () => !changingFile || (loaded.current === source && currentText.current === source?.content);
    try {
      const externalRead = async (id: string, registeredPath: string, image: boolean, recovered = false): Promise<FileDocument | { mime: string; data: string }> => {
        try {
          const value = image
            ? await request("filesystem.external.image", { id })
            : await request("filesystem.external.read", { id });
          if (!image && mounted.current && ticket === generation.current) {
            externalPath.current = (value as FileDocument).path;
            if ((value as FileDocument).path !== registeredPath)
              onExternalChange?.({ externalId: id, path: (value as FileDocument).path });
          }
          return value;
        } catch (error) {
          if (!recovered && mounted.current && ticket === generation.current && externalFileErrorCode(error) === "external_file_unknown") {
            const reopened = await request("filesystem.external.open", {
              path: registeredPath,
              source: "recent",
              ...(ownerSessionId ? { sessionId: ownerSessionId } : {}),
            });
            if ("file" in reopened && mounted.current && ticket === generation.current) {
              externalPath.current = reopened.file.path;
              onExternalChange?.({ externalId: reopened.file.id, path: reopened.file.path });
              return externalRead(reopened.file.id, reopened.file.path, image, true);
            }
          }
          throw error;
        }
      };
      const imageHint = path === initialPath ? assetKind : undefined;
      if (nextView !== "diff" && (imageHint === "image" || imagePath(path))) {
        const asset = externalId
          ? await externalRead(externalId, path, true) as { mime: string; data: string }
          : await request("filesystem.image", { ...scope, path });
        if (!mounted.current || ticket !== generation.current || !canApply()) return false;
        const imageDocument = {
          path: externalPath.current ?? path,
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
      const read = () => externalId
        ? externalRead(externalId, path, false) as Promise<FileDocument>
        : request("filesystem.read", { ...scope, path });
      const value: FileDocument & { diffOnly?: true } = nextView === "diff"
        ? await readDiffDocument(path, read, () => compare ? compareDiffRequest(path).then(asCompareDiff) : request("git.diff", { ...scope, path, staged }))
        : await read();
      if (!mounted.current || ticket !== generation.current || !canApply()) return false;
      const saved = ignoreDraft || value.diffOnly ? undefined : drafts.current.get(path);
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
      if (mounted.current && ticket === generation.current) {
        if (external) { setDocument(undefined); setImage(undefined); }
        setIssue(external ? { externalError: error } : message(error));
      }
      return false;
    } finally {
      if (mounted.current && ticket === generation.current) setFileNavigation(false);
    }
  }
  function persistDraft(doc: FileDocument, value: string, fingerprint: string) {
    if (external) return Promise.resolve();
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
    const draftsLoad = external ? Promise.resolve([] as Draft[]) : request("draft.list", scope);
    void draftsLoad
      .then((values) => {
        if (!mounted.current) return;
        drafts.current = new Map(values.map((draft) => [draft.path, draft]));
        if (initialPath) void open(initialPath, externalInitialView);
      })
      .catch((error) => {
        if (mounted.current) setIssue(message(error));
      });
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, [projectId, worktreePath, externalId]);
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
    if (external && active && document && initialPath) void open(initialPath, view, true);
  }, [active]);
  useEffect(() => {
    if (document) onDocumentChange?.({ path: document.path, dirty });
  }, [document?.path, dirty, onDocumentChange]);
  useEffect(() => {
    if (external ||
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
  }, [text, document, external]);
  useEffect(
    () => () => {
      const doc = loaded.current;
      if (!external && doc && currentText.current !== doc.content)
        void persistDraft(doc, currentText.current, base.current);
    },
    [projectId, worktreePath, external],
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
    if(!compare) { setCompareFiles(undefined); return; }
    let alive = true;
    void request("git.compare.files", {...scope, base:compare.base, ...(compare.committedOnly ? {committedOnly:true} : {})})
      .then(value => { if(alive) setCompareFiles(value); })
      .catch(() => { if(alive) setCompareFiles(undefined); });
    return () => { alive = false; };
  }, [compare?.base, compare?.mergeBase, compare?.committedOnly, projectId, worktreePath]);
  // A rename's base side lives at its pre-rename path, resolved per path from the current list.
  const compareOriginal = (path: string) => compareOriginalPath(path, firstPath.current, compare, compareFiles?.files);
  const compareDiffRequest = (path: string): Promise<GitCompareDiff> => {
    const original = compareOriginal(path);
    return request("git.compare.diff", {...scope, base:{ref:compare!.base, oid:compare!.oid}, mergeBase:compare!.mergeBase, path, ...(original ? {originalPath:original} : {}), ...(compare!.committedOnly ? {committedOnly:true} : {})});
  };
  // A base that moved while this tab was open (or across a restart) is re-pointed at the current
  // base instead of leaving a dead end: the list is recomputed and this tab adopts its merge base.
  const reloadCompareBase = async () => {
    if(!compare) return;
    setBusy(true);
    try {
      const fresh = await request("git.compare.files", {...scope, base:compare.base, ...(compare.committedOnly ? {committedOnly:true} : {})});
      setCompareFiles(fresh);
      setLocalCompare({base:fresh.base.ref, oid:fresh.base.oid, mergeBase:fresh.mergeBase, ...(compare.committedOnly ? {committedOnly:true} : {})});
      setCompareStale(false);
      setIssue(undefined);
    } catch (error) {
      setIssue(workbenchError(error, zh));
    } finally {
      setBusy(false);
    }
  };
  // The diff surface renders a GitDiff; a compare diff has no index fingerprint and no staged state.
  const asCompareDiff = (value: GitCompareDiff): GitDiff => ({path:value.path, staged:false, oldText:value.oldText, newText:value.newText, binary:value.binary, fingerprint:"", ...(value.deleted ? {deleted:true} : {})});
  useEffect(() => {
    if (external || view !== "diff" || !document) return;
    let alive = true;
    const loading = compare
      ? compareDiffRequest(document.path).then(value => asCompareDiff(value))
      : request("git.diff", { ...scope, path: document.path, staged });
    void loading
      .then((value) => {
        if (alive) { setDiff(value); setCompareStale(false); }
      })
      .catch((error) => {
        if (!alive) return;
        // A moved base is recoverable from this tab; keep the message out of the error strip.
        if (compare && /compare_stale/.test(error instanceof Error ? error.message : String(error))) {
          setCompareStale(true);
          setIssue(undefined);
          return;
        }
        setIssue(workbenchError(error, zh));
      });
    return () => {
      alive = false;
    };
  }, [
    external,
    view,
    staged,
    document?.path,
    document?.fingerprint,
    projectId,
    worktreePath,
    compare?.mergeBase,
    compareFiles,
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
    if (external || !doc || doc.readonly || busy) return false;
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
      const before = conflictBlocks(doc.content), after = conflictBlocks(saved.content);
      if (before.blocks.length && !after.blocks.length && !after.unparseable)
        setResolvedNotice(doc.path);
      notifyFilesChanged();
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
      const expectedFingerprints = unstage ? undefined : await stageGuard.check([document.path], conflictedFile ? [document.path] : []);
      if (!unstage && !expectedFingerprints) return;
      await request(unstage ? "git.unstage" : "git.stage", {
        ...scope,
        paths: [document.path],
        expectedFingerprints: unstage
          ? undefined
          : { [document.path]: document.fingerprint, ...expectedFingerprints },
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
  const workbenchScopeKey=`${workbenchScope.projectId}\0${workbenchScope.worktreePath??''}\0${workbenchScope.rootPath}`;
  useEffect(() => {
    const palette=(event:Event)=>{
      if(external||embedded)return;
      const detail=(event as CustomEvent<{view?:string;key?:string;action?:GitWorkbenchAction;hostKey?:string}>).detail;
      if(detail?.view!=='scm'||!detail.action||detail.hostKey!==gitWorkbenchHost.current)return;
      setToolsOpen(true);setGitCommand({view:'scm',key:detail.key??crypto.randomUUID(),action:detail.action,scopeKey:workbenchScopeKey});
    };
    addEventListener('threadterm:workbench',palette);
    return()=>removeEventListener('threadterm:workbench',palette);
  },[embedded,external,workbenchScopeKey]);
  const standaloneActions: WorkbenchActions = {
    openFile: (path) => choose(path, "file"),
    openDiff: (path, nextStaged, nextCompare) => {
      setStaged(nextStaged);
      setLocalCompare(nextCompare);
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
    if(gutterBase.current?.path!==document?.path||external||image||view!=='file') {gutterBase.current=undefined;setGitBaseText(null);}
    if (external || !document || image || view !== "file") return;
    let alive = true;
    void request("git.diff", { ...scope, path: document.path, staged: false })
      .then((value) => {
        if (alive) {
          const previous=gutterBase.current;
          if(previous?.path!==document.path||previous.diff.indexFingerprint!==value.indexFingerprint||previous.diff.oldText!==value.oldText||previous.diff.binary!==value.binary)gutterBase.current={path:document.path,diff:value};
          setGitBaseText(value.binary || value.indexFingerprint == null ? null : value.oldText);
        }
      })
      .catch(() => {
        if (alive) {gutterBase.current=undefined;setGitBaseText(null);}
      });
    return () => {
      alive = false;
    };
  }, [external, document?.path, document?.fingerprint, view, projectId, worktreePath, gitState.status,gutterRevision]);
  useEffect(() => {
    if (external || !blameOn || !document || dirty) {
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
  }, [external, blameOn, document?.path, document?.fingerprint, dirty]);
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
    const content = indexChunkContent(snapshot.a,snapshot.b,chunk,staged,staged?diff.newText:diff.oldText);
    setBusy(true);
    setIssue(undefined);
    try {
      if (!staged) {
        const checked = await stageGuard.check([document.path], conflictedFile ? [document.path] : []);
        if (!checked) return;
        if (Object.hasOwn(checked, document.path) && checked[document.path] !== document.fingerprint) throw Error('file_conflict');
      }
      await request("git.index.write", {
        ...scope,
        path: document.path,
        content,
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
  async function stageGutterHunk(baseText:string,buffer:string,chunk:ChunkRange) {
    const origin=gutterBase.current,source=loaded.current,ticket=generation.current;
    const fresh=()=>mounted.current&&ticket===generation.current&&loaded.current===source&&gutterBase.current===origin;
    if(!origin||!source||origin.path!==source.path||origin.diff.oldText!==baseText||origin.diff.indexFingerprint==null||dirty||conflictedFile||gutterStagePending.current||currentText.current!==source.content)return;
    gutterStagePending.current=true;setBusy(true);setIssue(undefined);
    try {
      const checked=await stageGuard.check([source.path],[]);
      if(!checked||!fresh()||currentText.current!==source.content)return;
      if(Object.hasOwn(checked,source.path)&&checked[source.path]!==source.fingerprint)throw Error('file_conflict');
      await request('git.index.write',{...scope,path:source.path,content:indexChunkContent(baseText,buffer,chunk,false,baseText),expectedIndexFingerprint:origin.diff.indexFingerprint,operationId:operationId()});
      if(!fresh())return;
      gutterBase.current=undefined;setGitBaseText(null);setGutterRevision(value=>value+1);
      await refreshGit();
    } catch(error) {
      if(fresh()) {setIssue(workbenchError(error,zh));gutterBase.current=undefined;setGitBaseText(null);setGutterRevision(value=>value+1);}
    } finally {
      gutterStagePending.current=false;
      if(mounted.current)setBusy(false);
    }
  }
  useEffect(()=>{
    if(view!=='diff'||!diff||!diffReveal||diffReveal.path!==document?.path)return;
    const editor=mergeEditor.current,snapshot=editor?.snapshot();if(!editor||!snapshot)return;
    const position=snapshot.b.split('\n').slice(0,diffReveal.line-1).reduce((offset,line)=>offset+line.length+1,0);
    const index=snapshot.chunks.findIndex(chunk=>chunk.fromB<=position&&position<chunk.toB||chunk.fromB>=position);
    if(index>=0) {setHunk(index);editor.focusChunk(index);}setDiffReveal(undefined);
  },[view,diff,diffReveal,document?.path,hunkCount]);
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
      <FileBreadcrumb path={embeddedPath} />
    ) : null;
  };
  const embeddedClose = () =>
    embedded && previewNavigation ? (
      <button
        type="button"
        className="icon-btn icon-btn-sm embedded-file-close"
        title={zh ? "关闭文件预览" : "Close file preview"}
        aria-label={zh ? "关闭文件预览" : "Close file preview"}
        disabled={previewNavigation.closing}
        onClick={previewNavigation.onClose}
      >
        <Icon name="close" />
      </button>
    ) : null;
  const externalBoundary = document && external ? <ExternalFileBoundary path={document.path} zh={zh} noticeOpen={externalNoticeOpen} onNoticeToggle={() => setExternalNoticeOpen((open) => !open)} onCopy={() => void navigator.clipboard.writeText(document.path)} onReload={() => void open(document.path, view, true)} /> : null;
  // In the Branch scope the diff walk follows the compared file list, not the working-tree groups.
  const navigationPaths = compare
    ? (compareFiles ? comparePaths(compareFiles.files) : document ? [document.path] : [])
    : gitDiffFiles(gitState.status?.changes ?? [], staged);
  // A compare diff is editable on the working side only in the working-tree scope, with a real disk file.
  const compareEditable = compare ? compareDiffEditable(compare, !document?.readonly) : true;
  const pinLabel = pinnedDocument ? (zh ? "从计划与文档中移除" : "Remove from Plans & docs") : (zh ? "添加到计划与文档（会话详情）" : "Add to Plans & docs (Session details)");
  const canPin = !external && sessionDocuments && !image && !sessionDocuments.loading && !documentPinning && !sessionDocumentIssue;
  const pinAction = canPin && <button type="button" className="icon-btn icon-btn-sm file-bar-secondary" aria-pressed={Boolean(pinnedDocument)} title={pinLabel} aria-label={pinLabel} onClick={() => void toggleSessionDocument()}><Icon name="bookmark" /></button>;
  const historyAction = document && !external && onOpenHistory && !image && <button type="button" className="icon-btn icon-btn-sm file-bar-secondary" title={zh ? "文件历史" : "File history"} aria-label={zh ? "文件历史" : "File history"} onClick={() => onOpenHistory({ path: document.path })}><Icon name="clock" /></button>;
  const sendAction = document && onSendToAgent && (!image || external) && <button type="button" className="icon-btn icon-btn-sm file-bar-optional" title={zh ? "发送给 Agent（Ctrl+L 发送选中行）" : "Send to agent (Ctrl+L sends the selected lines)"} aria-label={zh ? "发送给 Agent" : "Send to agent"} onClick={() => onSendToAgent({ path: document.path })}><Icon name="send" /></button>;
  const dirtyPill = <span className="file-dirty ws-chip" data-testid="editor-dirty" hidden={!dirty} title={zh ? "未保存" : "Unsaved"}>●<span className="file-dirty-label">{zh ? "未保存" : "Unsaved"}</span></span>;
  const fileMenuItems: ContextMenuItem[] = document ? [
    {id:"file-copy-path",label:zh ? "复制路径" : "Copy path",icon:<WbIcon name="copy" />,onSelect:()=>navigator.clipboard.writeText(document.path)},
    ...(!external ? [{id:"file-reveal",label:zh ? "在文件中显示" : "Reveal in Files",icon:<Icon name="folder" />,onSelect:()=>{if(embedded)dispatchEvent(new CustomEvent("threadterm:workbench",{detail:{view:"files"}}));else setToolsOpen(true);}}] : []),
    ...(!busy ? [{id:"file-reload",label:copy.reload,icon:<WbIcon name="refresh" />,onSelect:()=>{if(external)void open(document.path,view,true);else setPending({path:document.path,view,reload:true});}}] : []),
    ...(view === "file" && !external && !image && gitState.status && (!dirty || blameOn) ? [{id:"file-blame",label:zh ? "逐行追溯" : "Blame",icon:<WbIcon name="person" />,onSelect:()=>setBlameOn(value=>!value)}] : []),
    ...(!external && onOpenHistory && !image ? [{id:"file-history",label:zh ? "文件历史" : "File history",icon:<Icon name="clock" />,onSelect:()=>onOpenHistory({path:document.path})}] : []),
    ...(canPin ? [{id:"file-plans",label:pinLabel,icon:<Icon name="bookmark" />,onSelect:()=>toggleSessionDocument()}] : []),
    ...(onSendToAgent && (!image || external) ? [{id:"file-send",label:zh ? "发送给 Agent" : "Send to agent",icon:<Icon name="send" />,onSelect:()=>onSendToAgent({path:document.path})}] : []),
    ...(view === "diff" && !staged && compareEditable && !document.readonly && diff && !diff.binary ? [
      {id:"file-revert-line",label:zh ? "还原当前行" : "Revert current line",icon:<WbIcon name="undo" />,onSelect:()=>{mergeEditor.current?.revertLine();}},
      {id:"file-revert-hunk",label:zh ? "还原当前块" : "Revert current hunk",icon:<WbIcon name="undo" />,onSelect:()=>{mergeEditor.current?.revertHunk();}},
    ] : []),
    ...(view === "diff" && navigationPaths.includes(document.path) && !busy && !fileNavigation && !navigationDisabled ? [
      ...navigationPaths.filter((_,index) => index === navigationPaths.indexOf(document.path) - 1).map(path => ({id:"file-previous",label:zh ? "上一个文件" : "Previous file",onSelect:()=>{if(onNavigateDiff)onNavigateDiff(path,()=>open(path,"diff"));else choose(path,"diff");}})),
      ...navigationPaths.filter((_,index) => index === navigationPaths.indexOf(document.path) + 1).map(path => ({id:"file-next",label:zh ? "下一个文件" : "Next file",onSelect:()=>{if(onNavigateDiff)onNavigateDiff(path,()=>open(path,"diff"));else choose(path,"diff");}})),
    ] : []),
    ...(view === "diff" && hunkCount > 0 ? [
      {id:"file-previous-hunk",label:zh ? "上一个更改块" : "Previous hunk",onSelect:()=>moveHunk(-1)},
      {id:"file-next-hunk",label:zh ? "下一个更改块" : "Next hunk",onSelect:()=>moveHunk(1)},
    ] : []),
    ...(draftStatus === "conflict" ? [{id:"file-retry",label:copy.retry,onSelect:()=>persistDraft(document,text,base.current)}] : []),
    ...(!embedded ? [
      ...(!external ? [{id:"file-tools",label:zh ? "文件与 Git" : "Files & Git",icon:<Icon name="panel" />,onSelect:()=>setToolsOpen(value=>!value)}] : []),
      {id:"file-close",label:zh ? "关闭当前" : "Close current",onSelect:()=>requestClose("current")},
      ...(openPaths.length > 1 ? [{id:"file-close-others",label:zh ? "关闭其他" : "Close others",onSelect:()=>requestClose("others")}] : []),
      {id:"file-close-all",label:zh ? "关闭全部文件" : "Close all files",onSelect:()=>requestClose("all")},
    ] : []),
  ] : [];

  return (
    <section className={`file-workspace ${toolsOpen ? "tools-open" : ""} ${embedded ? "embedded" : ""}${external ? " external-file-workspace" : ""}`} data-git-workbench={!embedded&&!external||undefined} data-git-workbench-host={!embedded&&!external?gitWorkbenchHost.current:undefined} data-git-repository={!embedded&&!external&&gitState.status?'true':undefined}>
      {toolsOpen && !external && (
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
                command={gitCommand}
                visible={toolsOpen && active!==false}
                onCommandHandled={key=>setGitCommand(current=>current?.key===key?undefined:current)}
                compact
                toolbarHost={scmToolsHost}
              />
            </section>
            {gitState.status && (
              <GitMergeControls
                operation={gitState.status.operation}
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
              <div className={`tt-editor-tabs file-view-tabs file-workspace-bar${external ? " external-file-toolbar" : ""}`}>
                <div className="file-bar-location">
                {external ? externalBoundary : previewNavigation ? embeddedNavigation() : <FileBreadcrumb path={document.path} />}
                {!embedded && !external && openPaths.length > 1 && <Select className="embedded-file-navigation" value={document.path} aria-label={zh ? "切换文件预览" : "Switch file preview"} onChange={event => choose(event.target.value, view)}>{openPaths.map(path => <option key={path} value={path}>{path}</option>)}</Select>}
                {dirtyPill}
                </div>
                {/\.(md|mdx|html?)$/i.test(document.path) && <span className="file-bar-segments" role="group" aria-label={zh ? "文件视图" : "File view"}>
                  <button type="button" aria-pressed={view === "file"} onClick={() => setView("file")}>{zh ? "源代码" : "Source"}</button>
                  <button type="button" aria-pressed={view === "preview"} onClick={() => setView("preview")}>{copy.preview}</button>
                </span>}
                {view === "file" && !external && !image && gitState.status && (!dirty || blameOn) && <button type="button" className="icon-btn icon-btn-sm file-bar-secondary" aria-label={zh ? "逐行追溯" : "Blame"} title={zh ? "显示每行最后修改的提交" : "Show the last commit for each line"} aria-pressed={blameOn} onClick={() => setBlameOn(value => !value)}><WbIcon name="person" /></button>}
                {historyAction}
                {pinAction}
                {sendAction}
                {!external && !image && (!conflictedFile || dirty) && <span className="file-bar-save-slot">{dirty && !document.readonly && !busy && <button className="btn btn-sm" aria-label={copy.save} title={`${copy.save} (Ctrl+S)`} onClick={() => void saveFile()}>{zh ? "保存" : "Save"}</button>}</span>}
                {view === "file" && !external && !image && conflictedFile && !busy && !dirty && !document.readonly && !stageReason && <ConflictStageAction key={document.path} scope={scope} path={document.path} revision={document.fingerprint} disabled={false} zh={zh} onStaged={() => void refreshGit()} />}
                {!embedded && !external && <button className="icon-btn icon-btn-sm file-tools-button" title={zh ? "文件与 Git" : "Files & Git"} aria-label={zh ? "文件与 Git" : "Files & Git"} aria-pressed={toolsOpen} onClick={() => setToolsOpen(value => !value)}><Icon name="panel" /></button>}
                <FileBarActions items={fileMenuItems} zh={zh} />
                {embeddedClose()}
              </div>
            )}
            {view === "file" && commentScope && commentsHost && !image && <>
              {commentDraft && !dirty && <CommentForm scope={commentScope} path={document.path} version={plainCommentVersion} selection={commentDraft} zh={zh} onCancel={() => setCommentDraft(undefined)} onAdded={() => setCommentDraft(undefined)} />}
              <PendingComments scope={commentScope} host={commentsHost} comments={fileComments} zh={zh} />
            </>}
            {view === "diff" ? (
                <section className="tt-diff-shell" data-testid="file-diff-surface">
                <div className="file-bar file-workspace-bar">
                  <div className="file-bar-location">
                  {previewNavigation ? embeddedNavigation() : <FileBreadcrumb path={document.path} />}
                  {dirtyPill}
                  {!compare && <Select className="file-bar-diff-state" value={staged ? "staged" : "unstaged"} onChange={event => setStaged(event.target.value === "staged")} aria-label={zh ? "差异状态" : "Diff state"} title={staged || document.readonly ? copy.readOnly : zh ? "左侧基线只读，右侧可编辑" : "Baseline is read-only; current file is editable"}>
                    <option value="unstaged">{copy.unstaged}</option><option value="staged">{copy.staged}</option>
                  </Select>}
                  {compare && <span className="ws-chip file-bar-optional file-bar-compare" title={`${compare.committedOnly ? (zh ? "仅已提交的更改" : "Committed changes only") : (zh ? "工作区" : "Working tree")} · ${zh ? `对比 ${compare.base}` : `vs ${compare.base}`} · ${compare.committedOnly || document.readonly ? copy.readOnly : zh ? "左侧基线只读，右侧可编辑" : "Baseline is read-only; current file is editable"}`}>{compare.base}</span>}
                  </div>
                  {diff && !diff.binary && hunkCount > 0 && <span className="wb-hunk-nav" role="group" aria-label={zh ? "更改块" : "Hunks"}>
                    <button type="button" className="icon-btn icon-btn-sm" aria-label={zh ? "上一个更改块" : "Previous hunk"} onClick={() => moveHunk(-1)}><WbIcon name="chev-up" /></button>
                    <span className="wb-hunk-count"><span className="file-change-label">{zh ? "更改" : "Change"} </span>{hunk + 1}/{hunkCount}</span>
                    <button type="button" className="icon-btn icon-btn-sm" aria-label={zh ? "下一个更改块" : "Next hunk"} onClick={() => moveHunk(1)}><Icon name="chevron" /></button>
                  </span>}
                  <DiffFileNavigation paths={navigationPaths} path={document.path} zh={zh} disabled={busy || navigationDisabled || fileNavigation} onNavigate={onNavigateDiff ? path => onNavigateDiff(path, () => open(path, "diff")) : path => choose(path, "diff")} />
                  {pinAction}
                  {dirty && !staged && compareEditable && !document.readonly && !busy ? <button className="btn btn-sm" aria-label={zh ? "保存变更" : "Save changes"} title="Ctrl+S" onClick={() => void saveFile()}>{zh ? "保存" : "Save"}</button> : !compare && !dirty && !busy && (staged || !stageReason) && <button className="btn btn-sm" onClick={() => void changeIndex(staged)}>{staged ? (zh ? "取消暂存" : "Unstage file") : (zh ? "暂存文件" : "Stage file")}</button>}
                  {!embedded && <button className="icon-btn icon-btn-sm file-tools-button" title={zh ? "文件与 Git" : "Files & Git"} aria-label={zh ? "文件与 Git" : "Files & Git"} aria-pressed={toolsOpen} onClick={() => setToolsOpen(value => !value)}><Icon name="panel" /></button>}
                  <FileBarActions items={fileMenuItems} zh={zh} />
                  {embeddedClose()}
                </div>
                {commentScope && commentsHost && diff && !diff.binary && <>
                  {commentDraft && !dirty && <CommentForm scope={commentScope} path={document.path} version={diffCommentVersion} selection={commentDraft} zh={zh} onCancel={() => setCommentDraft(undefined)} onAdded={() => setCommentDraft(undefined)} />}
                  <PendingComments scope={commentScope} host={commentsHost} comments={fileComments} zh={zh} />
                </>}
                {compareStale ? (
                  <p className="tt-editor-state" role="status" data-testid="compare-stale">
                    <span>{compareStaleText(zh)}</span>
                    <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void reloadCompareBase()}>{compareReloadText(zh)}</button>
                  </p>
                ) : diff?.binary ? (
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
                    newText={staged || compare?.committedOnly ? diff.newText : text}
                    readOnly={staged || !compareEditable || document.readonly || fileNavigation || Boolean(navigationDisabled)}
                    onChange={value => { currentText.current = value; setText(value); }}
                    onSave={() => void saveFile()}
                    onChunks={setHunkCount}
                    onStageHunk={!compare ? () => void applyHunk() : undefined}
                    stageHunkLabel={staged ? (zh ? "取消暂存此块" : "Unstage hunk") : (zh ? "暂存此块" : "Stage hunk")}
                    stageHunkDisabled={busy || dirty || fileNavigation || Boolean(navigationDisabled) || (!staged && Boolean(stageReason))}
                    selectionActions={{zh,canComment:Boolean(commentScope && commentsHost && !busy && !dirty && !commentDraft),onComment:selection => setCommentDraft(selection),onSend:onSendToAgent ? lines => onSendToAgent({path:document.path,...lines}) : undefined}}
                    onSelection={commentScope ? setCommentSelection : undefined}
                    onContextMenu={(menu) => openEditorContextMenu(menu, "diff")}
                    marks={commentScope ? diffCommentMarks : undefined}
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
                external={external}
                path={document.path}
                savedContent={document.content}
                content={text}
                image={image}
                embedded={embedded}
                commentScope={commentScope}
                commentsHost={commentsHost}
                onShowSource={() => setView("file")}
                onSendToAgent={onSendToAgent ? () => onSendToAgent({ path: document.path }) : undefined}
              />
            ) : (
              <>
                {resolvedNotice === document.path && <p className="wb-summary" role="status">{zh ? "此文件中的所有冲突已解决。请暂存以标记为已解决。" : "All conflicts resolved in this file. Stage it to mark it resolved."}</p>}
                <section ref={sourceEditorHost} className="tt-editor-shell" data-testid="file-editor-surface">
                  <CodeEditor
                    path={document.path}
                    value={text}
                    onChange={value => { currentText.current = value; setText(value); }}
                    onSave={() => void saveFile()}
                    readOnly={external || document.readonly || fileNavigation || Boolean(navigationDisabled)}
                    reveal={editorReveal}
                    resetKey={editorResetKey}
                    gitBaseText={external?null:gitBaseText}
                    gitHunkActions={external?undefined:{conflicted:conflictedFile,disabled:dirty?(zh?'请先保存文件以暂存此更改':'Save the file to stage this change'):conflictedFile?(zh?'无法暂存冲突文件的单个更改':'Cannot stage a change in a conflicted file'):busy?(zh?'正在处理…':'Working…'):undefined,stage:(base,buffer,chunk)=>void stageGutterHunk(base,buffer,chunk),openDiff:line=>{setStaged(false);setDiffReveal({path:document.path,line});setView('diff');}}}
                    blame={blameOn && !dirty ? blame : undefined}
                    onBlameCommit={onOpenHistory ? (commit) => onOpenHistory({ path: document.path, commit }) : undefined}
                    onSendToAgent={onSendToAgent ? (lines) => onSendToAgent({ path: document.path, ...lines, ...(external ? { selection: selectedExternalText() } : {}) }) : undefined}
                    selectionActions={{zh,canComment:Boolean(commentScope && commentsHost && !busy && !dirty && !commentDraft),onComment:selection => setCommentDraft({side:"new",...selection}),onSend:onSendToAgent ? lines => onSendToAgent({path:document.path,...lines,...(external ? {selection:selectedExternalText()} : {})}) : undefined}}
                    onSelection={external || commentScope ? (selection) => { if (commentScope) setCommentSelection({ side: "new", ...selection }); } : undefined}
                    onContextMenu={(menu) => openEditorContextMenu(menu, "file")}
                    marks={commentScope ? plainCommentMarks : undefined}
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
            <div className={`empty tt-editor-state${external ? " external-file-error" : ""}`}>
              {embedded && initialPath && !issue ? (
                <span>{zh ? "正在读取…" : "Loading…"}</span>
              ) : (
                <>
                  <strong>{issueText ?? copy.empty}</strong>
                  {external && initialPath && <span className="external-file-error-path" title={displayPath(initialPath)}>{displayPath(initialPath)}</span>}
                  {external && initialPath && <button className="btn btn-sm" onClick={() => void open(initialPath, externalInitialView, true)}>{zh ? "重试" : "Retry"}</button>}
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
        {(issueText ?? sessionDocumentIssue) && (
          <div role="alert" className="tt-editor-conflict">
            {issueText ?? sessionDocumentIssue}
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
      {stageGuard.dialog}
      {(pending || closePrompt) && (
        <SurfaceDialog
          title={copy.question}
          subtitle={document?.path}
          icon="file"
          size="sm"
          className="file-unsaved-dialog"
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
