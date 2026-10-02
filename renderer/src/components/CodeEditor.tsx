import { autocompletion, completeAnyWord, type CompletionSource } from "@codemirror/autocomplete";
import { history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { foldGutter, indentOnInput, language as languageFacet, syntaxTree } from "@codemirror/language";
import { Chunk } from "@codemirror/merge";
import { gotoLine, searchKeymap } from "@codemirror/search";
import {
  Compartment,
  EditorSelection,
  EditorState,
  Facet,
  RangeSet,
  RangeSetBuilder,
  StateEffect,
  StateField,
  Text,
  type Extension,
} from "@codemirror/state";
import {
  EditorView,
  GutterMarker,
  ViewPlugin,
  gutter,
  keymap,
  lineNumbers,
  type ViewUpdate,
} from "@codemirror/view";
import type { GitBlame } from "@threadterm/protocol";
import { useEffect, useRef } from "react";
import { editorHighlight, loadLanguage } from "../workbench/languages";

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
const setLineChanges = StateEffect.define<RangeSet<GutterMarker>>();
const lineChanges = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(value, transaction) {
    for (const effect of transaction.effects)
      if (effect.is(setLineChanges)) return effect.value;
    return transaction.docChanged ? value.map(transaction.changes) : value;
  },
});
const gitBase = Facet.define<string | null, string | null>({
  combine: (values) => (values.length ? values[values.length - 1] : null),
});

/** Line-level markers for the buffer against the index text (VS Code style). */
export function changeMarkers(base: string, doc: Text): RangeSet<GutterMarker> {
  const chunks = Chunk.build(Text.of(base.replace(/\r\n?/g, "\n").split("\n")), doc, {
    scanLimit: 5000,
    timeout: 250,
  });
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
        const value =
          base === null ? RangeSet.empty : changeMarkers(base, this.view.state.doc);
        this.view.dispatch({ effects: setLineChanges.of(value) });
      }, delay);
    }
    destroy() {
      clearTimeout(this.timer);
    }
  },
);
const gitGutter: Extension = [
  lineChanges,
  gitGutterPlugin,
  gutter({
    class: "cm-git-gutter",
    markers: (view) => view.state.field(lineChanges),
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

export function CodeEditor({
  path,
  value,
  readOnly,
  onChange,
  onSave,
  reveal,
  resetKey,
  gitBaseText,
  blame,
  onBlameCommit,
  onSendToAgent,
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
  blame?: GitBlame;
  onBlameCommit?: (commit: string) => void;
  /** Mod-L: hand the selected lines (or the cursor line) to an agent session. */
  onSendToAgent?: (lines: EditorSelectionLines) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | undefined>(undefined);
  const changed = useRef(onChange);
  changed.current = onChange;
  const save = useRef(onSave);
  save.current = onSave;
  const send = useRef(onSendToAgent);
  send.current = onSendToAgent;
  const blameCommit = useRef(onBlameCommit);
  blameCommit.current = onBlameCommit;
  const compartments = useRef({
    language: new Compartment(),
    base: new Compartment(),
    blame: new Compartment(),
  });
  const zh = globalThis.document.documentElement.lang === "zh-CN";
  useEffect(() => {
    if (!host.current) return;
    const { language, base, blame: blameSlot } = compartments.current;
    const state = EditorState.create({
      doc: value,
      extensions: [
        blameSlot.of([]),
        lineNumbers(),
        gitGutter,
        base.of(gitBase.of(gitBaseText ?? null)),
        foldGutter(),
        history(),
        indentOnInput(),
        language.of([]),
        editorHighlight,
        readOnly ? [] : completion,
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
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
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) changed.current(update.state.doc.toString());
        }),
      ],
    });
    const editor = new EditorView({ state, parent: host.current });
    view.current = editor;
    const detachLanguage = attachLanguage(editor, language, path);
    return () => {
      detachLanguage();
      editor.destroy();
      if (view.current === editor) view.current = undefined;
    };
  }, [path, readOnly, resetKey]);
  useEffect(() => {
    const current = view.current;
    if (current && current.state.doc.toString() !== value)
      current.dispatch({
        changes: { from: 0, to: current.state.doc.length, insert: value },
      });
  }, [value]);
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
  return <div className="cm-host tt-editor-host" ref={host} />;
}
