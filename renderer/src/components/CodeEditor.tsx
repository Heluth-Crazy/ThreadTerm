import { autocompletion, completeAnyWord, type CompletionSource } from "@codemirror/autocomplete";
import { history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { foldGutter, indentOnInput, language as languageFacet, syntaxTree } from "@codemirror/language";
import type { Chunk } from "@codemirror/merge";
import { buildGitHunks, canUseGitHunks } from "../workbench/gutterHunk";
import { conflictBlocks } from "../workbench/conflictBlocks";
import { gitHunkPopup, type GitHunkActions } from "./gitHunkPopup";
import { gotoLine, searchKeymap } from "@codemirror/search";
import { conflictResolver } from "./conflictEditor";
import { dominantLineSeparator, normalizeEditorText, serializeEditorText, type EditorLineSeparator } from "./editorTextSerialization";
import {
  Compartment,
  EditorSelection,
  EditorState,
  Facet,
  Prec,
  RangeSet,
  RangeSetBuilder,
  StateEffect,
  StateField,
  Text,
  type Extension,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  GutterMarker,
  ViewPlugin,
  gutter,
  keymap,
  lineNumbers,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import type { GitBlame } from "@threadterm/protocol";
import { useEffect, useRef, useState } from "react";
import { editorHighlight, loadLanguage } from "../workbench/languages";
import { EditorSelectionActions, type SelectionActionPosition, type SelectionActions } from './EditorSelectionActions';
import './editor-selection-actions.css';

// Grammars with their own completion (TS/JS, Python, Go, CSS, HTML, SQL…) keep it alone.
// Other code (Rust, Java, C/C++, JSON, YAML, legacy modes) completes words already in the
// file; plain text, comments and strings get nothing, so writing prose never pops a list.
const fileWords: CompletionSource = (context) => {
  if (!context.state.facet(languageFacet)) return null;
  if (context.state.languageDataAt("autocomplete", context.pos).some((source) => source !== fileWords)) return null;
  if (/comment|string/i.test(syntaxTree(context.state).resolveInner(context.pos, -1).name)) return null;
  return completeAnyWord(context);
};

const completion: Extension = [
  autocompletion(),
  EditorState.languageData.of(() => [{ autocomplete: fileWords }]),
];

/** Loads the grammar for `path` into `compartment` once its chunk arrives. */
export function attachLanguage(
  view: EditorView,
  compartment: Compartment,
  path: string,
) {
  let live = true;
  void loadLanguage(path).then((extension) => {
    if (live && view.dom.isConnected)
      view.dispatch({ effects: compartment.reconfigure(extension) });
  });
  return () => {
    live = false;
  };
}

type LineChange = "added" | "modified" | "deleted";
class ChangeMarker extends GutterMarker {
  constructor(readonly kind: LineChange) {
    super();
  }
  eq(other: ChangeMarker) {
    return other.kind === this.kind;
  }
  toDOM() {
    const marker = document.createElement("div");
    marker.className = `cm-git-marker cm-git-${this.kind}`;
    return marker;
  }
}
const markers: Record<LineChange, ChangeMarker> = {
  added: new ChangeMarker("added"),
  modified: new ChangeMarker("modified"),
  deleted: new ChangeMarker("deleted"),
};
type GutterChanges = {markers:RangeSet<GutterMarker>;chunks:readonly Chunk[];base:string|null;doc:Text};
const setLineChanges = StateEffect.define<GutterChanges>();
const lineChanges = StateField.define<GutterChanges>({
  create: state => ({markers:RangeSet.empty,chunks:[],base:null,doc:state.doc}),
  update(value, transaction) {
    for (const effect of transaction.effects)
      if (effect.is(setLineChanges)) return effect.value;
    return transaction.docChanged ? {...value,markers:value.markers.map(transaction.changes)} : value;
  },
});
const gitBase = Facet.define<string | null, string | null>({
  combine: (values) => (values.length ? values[values.length - 1] : null),
});

/** Line-level markers for the buffer against the index text (VS Code style). */
export function changeMarkers(base: string, doc: Text, chunks:readonly Chunk[]=buildGitHunks(base,doc)): RangeSet<GutterMarker> {
  const lines = new Map<number, LineChange>();
  for (const chunk of chunks) {
    if (chunk.fromB >= chunk.toB) {
      const line = doc.lineAt(Math.min(chunk.fromB, doc.length)).number;
      if (!lines.has(line)) lines.set(line, "deleted");
      continue;
    }
    const kind: LineChange = chunk.fromA >= chunk.toA ? "added" : "modified";
    const first = doc.lineAt(Math.min(chunk.fromB, doc.length)).number;
    const last = doc.lineAt(Math.min(Math.max(chunk.fromB, chunk.toB - 1), doc.length)).number;
    for (let line = first; line <= last; line++) lines.set(line, kind);
  }
  const builder = new RangeSetBuilder<GutterMarker>();
  for (const line of [...lines.keys()].sort((left, right) => left - right)) {
    const start = doc.line(line).from;
    builder.add(start, start, markers[lines.get(line)!]);
  }
  return builder.finish();
}

const gitGutterPlugin = ViewPlugin.fromClass(
  class {
    timer: ReturnType<typeof setTimeout> | undefined;
    constructor(readonly view: EditorView) {
      this.schedule(0);
    }
    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.startState.facet(gitBase) !== update.state.facet(gitBase)
      )
        this.schedule(250);
    }
    schedule(delay: number) {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        const base = this.view.state.facet(gitBase);
        const doc=this.view.state.doc,chunks=base===null?[]:buildGitHunks(base,doc);
        const markers=base===null?RangeSet.empty:changeMarkers(base,doc,chunks);
        this.view.dispatch({ effects: setLineChanges.of({markers,chunks,base,doc}) });
      }, delay);
    }
    destroy() {
      clearTimeout(this.timer);
    }
  },
);
const gitMarkerOpen=Facet.define<(view:EditorView,position:number)=>boolean,((view:EditorView,position:number)=>boolean)|undefined>({combine:values=>values.at(-1)});
const gitGutter: Extension = [
  lineChanges,
  gitGutterPlugin,
  gutter({
    class: "cm-git-gutter",
    markers: (view) => view.state.field(lineChanges).markers,
    domEventHandlers:{click:(view,line,event)=>{
      if(!(event.target as Element).closest('.cm-git-marker'))return false;
      return view.state.facet(gitMarkerOpen)?.(view,line.from)??false;
    }},
  }),
];

export function relativeTime(iso: string, zh: boolean) {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const seconds = Math.max(0, (Date.now() - then) / 1000);
  const units: [number, string, string][] = [
    [31536000, "年前", "y"],
    [2592000, "个月前", "mo"],
    [604800, "周前", "w"],
    [86400, "天前", "d"],
    [3600, "小时前", "h"],
    [60, "分钟前", "m"],
  ];
  for (const [size, zhUnit, enUnit] of units)
    if (seconds >= size) {
      const value = Math.floor(seconds / size);
      return zh ? `${value} ${zhUnit}` : `${value}${enUnit} ago`;
    }
  return zh ? "刚刚" : "just now";
}

class BlameMarker extends GutterMarker {
  constructor(
    readonly label: string,
    readonly detail: string,
    readonly commit: string,
  ) {
    super();
  }
  eq(other: BlameMarker) {
    return other.label === this.label && other.commit === this.commit;
  }
  toDOM() {
    const element = document.createElement("div");
    element.className = this.commit ? "cm-blame-entry" : "cm-blame-entry uncommitted";
    element.textContent = this.label;
    element.title = this.detail;
    if (this.commit) element.dataset.commit = this.commit;
    return element;
  }
}

function blameGutter(
  blame: GitBlame,
  zh: boolean,
  onCommit: (commit: string) => void,
): Extension {
  const build = (doc: Text) => {
    const builder = new RangeSetBuilder<GutterMarker>();
    for (const range of blame.ranges) {
      if (range.start > doc.lines) break;
      const info = range.commit ? blame.commits[range.commit] : undefined;
      const label = range.commit
        ? `${info?.authorName ?? range.commit.slice(0, 7)} · ${relativeTime(info?.authoredAt ?? "", zh)}`
        : zh
          ? "未提交"
          : "Uncommitted";
      const detail = range.commit
        ? `${range.commit.slice(0, 10)} ${info?.authorName ?? ""}\n${info?.summary ?? ""}`
        : zh
          ? "尚未提交的更改"
          : "Not committed yet";
      const start = doc.line(range.start).from;
      builder.add(start, start, new BlameMarker(label, detail, range.commit));
    }
    return builder.finish();
  };
  let cache: { doc: Text; set: RangeSet<GutterMarker> } | undefined;
  return gutter({
    class: "cm-blame-gutter",
    markers: (view) => {
      if (cache?.doc !== view.state.doc)
        cache = { doc: view.state.doc, set: build(view.state.doc) };
      return cache.set;
    },
    initialSpacer: () => new BlameMarker("Wwwwwwwwwwww · 12mo ago", "", ""),
    domEventHandlers: {
      click: (_view, _line, event) => {
        const commit = (event.target as HTMLElement).closest<HTMLElement>(".cm-blame-entry")
          ?.dataset.commit;
        if (!commit) return false;
        onCommit(commit);
        return true;
      },
    },
  });
}

export type EditorSelectionLines = { startLine: number; endLine: number };
export type CodeSelection = EditorSelectionLines & { text: string };
export type CodeMark = EditorSelectionLines;
export type CodeSelectionActions=SelectionActions<CodeSelection>;

const setCommentMarks = StateEffect.define<DecorationSet>();
const commentMarks = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    for (const effect of transaction.effects)
      if (effect.is(setCommentMarks)) return effect.value;
    return value.map(transaction.changes);
  },
  provide: (field) => EditorView.decorations.from(field),
});
const commentedLine = Decoration.line({ class: "cm-review-commented" });
export function CodeEditor({
  path,
  value,
  readOnly,
  onChange,
  onSave,
  reveal,
  resetKey,
  gitBaseText,
  gitHunkActions,
  blame,
  onBlameCommit,
  onSendToAgent,
  onSelection,
  selectionActions,
  onContextMenu,
  marks,
}: {
  path: string;
  value: string;
  readOnly: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
  reveal?: { path: string; line: number; column?: number; key: string };
  resetKey?: number;
  /** Index text for the change gutter; null/undefined hides it (untracked or non-Git). */
  gitBaseText?: string | null;
  gitHunkActions?: GitHunkActions;
  blame?: GitBlame;
  onBlameCommit?: (commit: string) => void;
  /** Mod-L: hand the selected lines (or the cursor line) to an agent session. */
  onSendToAgent?: (lines: EditorSelectionLines) => void;
  /** Comment capture and line marks are installed only when selection reporting is enabled at mount. */
  onSelection?: (selection: CodeSelection) => void;
  /** Actions shown beside a non-empty line selection. */
  selectionActions?: CodeSelectionActions;
  onContextMenu?: (menu: { x: number; y: number; selection: CodeSelection; hasSelection: boolean; target: HTMLElement; copy: () => Promise<void>; cut: () => Promise<void>; paste: () => Promise<void>; selectAll: () => void }) => void;
  marks?: readonly CodeMark[];
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | undefined>(undefined);
  const hunkActions=useRef(gitHunkActions);hunkActions.current=gitHunkActions;
  const popup=useRef<ReturnType<typeof gitHunkPopup>|undefined>(undefined);
  const changed = useRef(onChange);
  changed.current = onChange;
  const save = useRef(onSave);
  save.current = onSave;
  const send = useRef(onSendToAgent);
  send.current = onSendToAgent;
  const selected = useRef(onSelection);
  selected.current = onSelection;
  const actions = useRef(selectionActions);
  actions.current = selectionActions;
  const [selectionAction, setSelectionAction] = useState<{selection:CodeSelection;position:SelectionActionPosition}>();
  const contextMenu = useRef(onContextMenu);
  contextMenu.current = onContextMenu;
  const blameCommit = useRef(onBlameCommit);
  blameCommit.current = onBlameCommit;
  const compartments = useRef({
    language: new Compartment(),
    base: new Compartment(),
    blame: new Compartment(),
  });
  const textFormat = useRef<{separator: EditorLineSeparator; emitted?: string}>({separator: dominantLineSeparator(value)});
  const zh = globalThis.document.documentElement.lang === "zh-CN";
  useEffect(() => {
    if (!host.current) return;
    setSelectionAction(undefined);
    const { language, base, blame: blameSlot } = compartments.current;
    textFormat.current = {separator: dominantLineSeparator(value)};
    const comments = Boolean(selected.current || actions.current);
    const reportSelection = (editor:EditorView) => {
      const range=editor.state.selection.main,first=editor.state.doc.lineAt(range.from);
      let last=editor.state.doc.lineAt(range.to);
      if(range.to>range.from&&range.to===last.from&&last.number>first.number)last=editor.state.doc.line(last.number-1);
      const selection={startLine:first.number,endLine:last.number,text:editor.state.sliceDoc(first.from,last.to)};
      selected.current?.(selection);
      if(!actions.current||range.from===range.to||!host.current){setSelectionAction(undefined);return;}
      const coords=editor.coordsAtPos(range.to),bounds=host.current.getBoundingClientRect();
      if(!coords){setSelectionAction(undefined);return;}
      const below=coords.bottom-bounds.top,top=below+36<=bounds.height?below:coords.top-bounds.top-36;
      setSelectionAction({selection,position:{left:Math.max(8,Math.min(coords.left-bounds.left,bounds.width-230)),top:Math.max(4,top)}});
    };
    let conflictDoc:Text|undefined,hasConflicts=false;
    const enabled=(editor:EditorView)=>{if(conflictDoc!==editor.state.doc){conflictDoc=editor.state.doc;const conflicts=conflictBlocks(conflictDoc.toString());hasConflicts=conflicts.blocks.length>0||conflicts.unparseable;}return canUseGitHunks(editor.state.facet(EditorState.readOnly),Boolean(hunkActions.current?.conflicted),hasConflicts);};
    const hunks=gitHunkPopup(editor=>{const value=editor.state.field(lineChanges);if(editor.state.facet(gitBase)===null)return {base:'',doc:editor.state.doc,chunks:[]};return value.base!==null&&value.base===editor.state.facet(gitBase)&&value.doc===editor.state.doc?{base:value.base,doc:value.doc,chunks:value.chunks}:undefined;},hunkActions,enabled,zh);
    popup.current=hunks;
    const state = EditorState.create({
      doc: value,
      extensions: [
        blameSlot.of([]),
        lineNumbers(),
        gitGutter,
        hunks.extension,
        gitMarkerOpen.of((editor,position)=>hunks.open(editor,position)),
        base.of(gitBase.of(gitBaseText ?? null)),
        foldGutter(),
        history(),
        conflictResolver(zh),
        indentOnInput(),
        language.of([]),
        editorHighlight,
        ...(comments ? [commentMarks,EditorView.updateListener.of(update=>{if((update.selectionSet||update.focusChanged||update.docChanged)&&update.view.hasFocus)reportSelection(update.view);})] : []),
        readOnly ? [] : completion,
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(comments || !readOnly),
        EditorView.domEventHandlers({
          contextmenu(event, editor) {
            const at = editor.posAtCoords({ x: event.clientX, y: event.clientY });
            if (at == null) return false;
            const range = editor.state.selection.main;
            if (at < range.from || at > range.to) editor.dispatch({ selection: EditorSelection.single(at) });
            const current = editor.state.selection.main;
            const first = editor.state.doc.lineAt(current.from);
            let last = editor.state.doc.lineAt(current.to);
            if (current.to > current.from && current.to === last.from && last.number > first.number) last = editor.state.doc.line(last.number - 1);
            const selection = { startLine: first.number, endLine: last.number, text: editor.state.sliceDoc(first.from, last.to) };
            selected.current?.(selection);
            const hasSelection = current.from !== current.to;
            const selectedText = editor.state.sliceDoc(current.from, current.to);
            contextMenu.current?.({ x: event.clientX, y: event.clientY, selection, hasSelection, target: editor.contentDOM, copy: () => navigator.clipboard.writeText(selectedText), cut: async () => { if (!readOnly && hasSelection) { await navigator.clipboard.writeText(selectedText); editor.dispatch({ changes: { from: current.from, to: current.to, insert: '' } }); } }, paste: async () => { if (!readOnly) { const text = await navigator.clipboard.readText(); editor.dispatch({ changes: { from: current.from, to: current.to, insert: text } }); } }, selectAll: () => editor.dispatch({ selection: EditorSelection.create([EditorSelection.range(0, editor.state.doc.length)]) }) });
            return Boolean(contextMenu.current);
          },
        }),
        EditorView.theme({
          "&": {
            height: "100%",
            backgroundColor: "transparent",
            color: "inherit",
          },
          ".cm-scroller": {
            overflow: "auto",
            fontFamily: '"Cascadia Code",Consolas,monospace',
          },
          ".cm-gutters": {
            backgroundColor: "transparent",
            color: "inherit",
            borderRight: "1px solid var(--border)",
          },
          ".cm-cursor": { borderLeftColor: "currentColor" },
          // Suggestion popups use the app palette; CodeMirror's default is light grey in both themes.
          "&.cm-editor .cm-tooltip.cm-tooltip-autocomplete, &.cm-editor .cm-tooltip.cm-completionInfo": {
            backgroundColor: "var(--raised)",
            color: "var(--text)",
            border: "1px solid var(--border)",
            borderRadius: "6px",
            boxShadow: "var(--shadow-soft)",
          },
          "&.cm-editor .cm-tooltip.cm-tooltip-autocomplete > ul": {
            fontFamily: '"Cascadia Code",Consolas,monospace',
          },
          "&.cm-editor .cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": {
            backgroundColor: "color-mix(in srgb, var(--primary) 24%, transparent)",
            color: "var(--text)",
          },
          "&.cm-editor .cm-completionMatchedText": {
            textDecoration: "none",
            fontWeight: 600,
            color: "var(--primary)",
          },
          "&.cm-editor .cm-completionDetail": { color: "var(--muted)" },
        }),
        keymap.of([
          ...historyKeymap,
          ...searchKeymap,
          indentWithTab,
          { key: "Mod-g", run: gotoLine, preventDefault: true },
          {
            key: "Mod-s",
            run: () => {
              save.current();
              return true;
            },
          },
          {
            key: "Mod-l",
            preventDefault: true,
            run: (editor) => {
              if (!send.current) return false;
              const { from, to } = editor.state.selection.main;
              const startLine = editor.state.doc.lineAt(from).number;
              // A selection ending at column 0 does not include that line.
              const endPosition = to > from && editor.state.doc.lineAt(to).from === to ? to - 1 : to;
              send.current({ startLine, endLine: editor.state.doc.lineAt(endPosition).number });
              return true;
            },
          },
          { key: "Shift-F10", run: (editor) => { const range = editor.state.selection.main; const first = editor.state.doc.lineAt(range.from); let last = editor.state.doc.lineAt(range.to); if (range.to > range.from && range.to === last.from && last.number > first.number) last = editor.state.doc.line(last.number - 1); const selection = { startLine: first.number, endLine: last.number, text: editor.state.sliceDoc(first.from, last.to) }; const point = editor.coordsAtPos(range.head); contextMenu.current?.({ x: point?.left ?? editor.contentDOM.getBoundingClientRect().left, y: point?.bottom ?? editor.contentDOM.getBoundingClientRect().bottom, selection, hasSelection: range.from !== range.to, target: editor.contentDOM, copy: () => navigator.clipboard.writeText(editor.state.sliceDoc(range.from, range.to)), cut: async () => { if (!readOnly && range.from !== range.to) { const text = editor.state.sliceDoc(range.from, range.to); await navigator.clipboard.writeText(text); editor.dispatch({ changes: { from: range.from, to: range.to, insert: '' } }); } }, paste: async () => { if (!readOnly) { const text = await navigator.clipboard.readText(); editor.dispatch({ changes: { from: range.from, to: range.to, insert: text } }); } }, selectAll: () => editor.dispatch({ selection: EditorSelection.create([EditorSelection.range(0, editor.state.doc.length)]) }) }); return Boolean(contextMenu.current); }, preventDefault: true },
          { key: "ContextMenu", run: (editor) => { editor.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true, cancelable: true })); return true; }, preventDefault: true },
        ]),
        Prec.lowest(keymap.of([
          { key: 'F7', run: editor => hunks.move(editor,1) },
          { key: 'Shift-F7', run: editor => hunks.move(editor,-1) },
        ])),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            const serialized = serializeEditorText(update.state.doc.toString(), textFormat.current.separator);
            textFormat.current.emitted = serialized;
            changed.current(serialized);
          }
        }),
      ],
    });
    const editor = new EditorView({ state, parent: host.current });
    view.current = editor;
    if(!readOnly){editor.contentDOM.setAttribute('aria-keyshortcuts','F7 Shift+F7 Alt+F7');editor.dom.querySelector('.cm-git-gutter')?.setAttribute('title',zh?'查看更改 (Alt+F7) · 上一处/下一处 (Shift+F7/F7)':'Review change (Alt+F7) · Previous/next (Shift+F7/F7)');}
    const detachLanguage = attachLanguage(editor, language, path);
    return () => {
      detachLanguage();
      editor.destroy();
      if (view.current === editor) view.current = undefined;
    };
  }, [path, readOnly, resetKey]);
  useEffect(() => {
    const current = view.current;
    if (!current) return;
    // Echoes of our own edits retain the loaded format even after all line breaks are deleted.
    if (value !== textFormat.current.emitted) textFormat.current.separator = dominantLineSeparator(value);
    const normalized = normalizeEditorText(value);
    if (current.state.doc.toString() !== normalized)
      current.dispatch({ changes: { from: 0, to: current.state.doc.length, insert: normalized } });
  }, [value]);
  useEffect(()=>{if(view.current)popup.current?.refresh(view.current);},[gitHunkActions]);
  useEffect(() => {
    const current = view.current;
    if (!current || !marks || !current.state.field(commentMarks, false)) return;
    const lines = new Set<number>();
    for (const mark of marks)
      for (let line = mark.startLine; line <= Math.min(mark.endLine, current.state.doc.lines); line++)
        lines.add(line);
    const builder = new RangeSetBuilder<Decoration>();
    for (const line of [...lines].sort((left, right) => left - right)) {
      const at = current.state.doc.line(line).from;
      builder.add(at, at, commentedLine);
    }
    current.dispatch({ effects: setCommentMarks.of(builder.finish()) });
  }, [marks, value, path, readOnly, resetKey]);
  useEffect(() => {
    view.current?.dispatch({
      effects: compartments.current.base.reconfigure(gitBase.of(gitBaseText ?? null)),
    });
  }, [gitBaseText, path, readOnly, resetKey]);
  useEffect(() => {
    view.current?.dispatch({
      effects: compartments.current.blame.reconfigure(
        blame
          ? blameGutter(blame, zh, (commit) => blameCommit.current?.(commit))
          : [],
      ),
    });
  }, [blame, path, readOnly, resetKey, zh]);
  useEffect(() => {
    const current = view.current;
    if (!current || !reveal || reveal.path !== path) return;
    const line = Math.max(1, Math.min(reveal.line, current.state.doc.lines));
    const start = current.state.doc.line(line).from;
    const column = Math.max(1, reveal.column ?? 1);
    const position = Math.min(
      current.state.doc.line(line).to,
      start + column - 1,
    );
    current.dispatch({
      selection: EditorSelection.single(position),
      effects: EditorView.scrollIntoView(position, { y: "center" }),
    });
    current.focus();
  }, [reveal?.key, reveal?.path, path]);
  useEffect(()=>{const element=host.current;if(!element)return;const clear=()=>setSelectionAction(undefined),blur=(event:FocusEvent)=>{if(event.relatedTarget instanceof Node&&element.contains(event.relatedTarget))return;clear();};element.addEventListener('scroll',clear,true);element.addEventListener('focusout',blur);return()=>{element.removeEventListener('scroll',clear,true);element.removeEventListener('focusout',blur);};},[]);
  return <div className="cm-host tt-editor-host" ref={host}>{selectionAction&&selectionActions&&<EditorSelectionActions selection={selectionAction.selection} position={selectionAction.position} actions={selectionActions}/>}</div>;
}
