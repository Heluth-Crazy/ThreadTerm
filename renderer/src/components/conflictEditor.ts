import { isolateHistory } from "@codemirror/commands";
import {
  EditorSelection,
  EditorState,
  Facet,
  StateField,
  Text,
  type Extension,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  keymap,
  showPanel,
  WidgetType,
  type DecorationSet,
  type Panel,
  type ViewUpdate,
} from "@codemirror/view";
import {
  conflictBlocks,
  conflictReplacement,
  type ConflictBlock,
  type ConflictChoice,
} from "../workbench/conflictBlocks";

type ConflictState = {
  blocks: readonly ConflictBlock[];
  decorations: DecorationSet;
  unparseable: boolean;
};

function label(zh: boolean, en: string, cn: string) {
  return zh ? cn : en;
}

const conflictLocale = Facet.define<boolean, boolean>({ combine: (values) => values.at(-1) ?? false });

/** The block containing a position, or the closest following block. */
export function conflictIndexAt(blocks: readonly ConflictBlock[], position: number) {
  if (!blocks.length) return -1;
  const inside = blocks.findIndex((block) => position >= block.from && position < block.to);
  if (inside >= 0) return inside;
  const after = blocks.findIndex((block) => block.from > position);
  return after >= 0 ? after : blocks.length - 1;
}

/** Move to the next (or previous) conflict, wrapping at either end. */
export function navigateConflict(view: EditorView, direction: 1 | -1) {
  const state = view.state.field(conflicts, false);
  if (!state || !state.blocks.length) return false;
  const position = view.state.selection.main.head;
  const next = direction === 1
    ? state.blocks.findIndex((block) => block.from > position)
    : [...state.blocks].map((block, index) => ({ block, index })).reverse()
      .find(({ block }) => block.to <= position)?.index ?? -1;
  const index = next < 0 ? (direction === 1 ? 0 : state.blocks.length - 1) : next;
  const target = state.blocks[index].from;
  view.dispatch({
    selection: EditorSelection.single(target),
    effects: EditorView.scrollIntoView(target, { y: "center" }),
  });
  view.focus();
  return true;
}

/** Edit normalized buffer lines in one undo step; CodeEditor serializes at its output boundary. */
export function acceptConflict(view: EditorView, block: ConflictBlock, choice: ConflictChoice) {
  if (view.state.facet(EditorState.readOnly)) return false;
  const current = conflictBlocks(view.state.doc.toString()).blocks
    .find((candidate) => candidate.from === block.from && candidate.to === block.to
      && candidate.ours === block.ours && candidate.base === block.base && candidate.theirs === block.theirs);
  if (!current) return false;
  view.dispatch({
    changes: { from: current.from, to: current.to, insert: Text.of(conflictReplacement(current, choice).split("\n")) },
    selection: EditorSelection.single(current.from),
    annotations: isolateHistory.of("full"),
  });
  view.focus();
  return true;
}

class ConflictActions extends WidgetType {
  constructor(readonly block: ConflictBlock, readonly zh: boolean) {
    super();
  }
  eq(other: ConflictActions) {
    return this.block.from === other.block.from && this.block.to === other.block.to
      && this.block.ours === other.block.ours && this.block.base === other.block.base
      && this.block.theirs === other.block.theirs && this.zh === other.zh;
  }
  toDOM(view: EditorView) {
    const actions = document.createElement("div");
    actions.className = "cm-conflict-actions";
    actions.setAttribute("role", "group");
    actions.setAttribute("aria-label", label(this.zh, "Resolve conflict", "解决冲突"));
    const choices: readonly [ConflictChoice, string, string][] = [
      ["current", "Accept current", "接受当前更改"],
      ["incoming", "Accept incoming", "接受传入更改"],
      ["current-first", "Accept both (current first)", "接受两者（当前优先）"],
      ["incoming-first", "Accept both (incoming first)", "接受两者（传入优先）"],
    ];
    for (const [choice, en, cn] of choices) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "cm-conflict-action";
      button.textContent = label(this.zh, en, cn);
      button.title = button.textContent;
      button.disabled = view.state.facet(EditorState.readOnly);
      button.addEventListener("click", () => acceptConflict(view, this.block, choice));
      actions.append(button);
    }
    return actions;
  }
  ignoreEvent() {
    return false;
  }
}

function conflictDecorations(doc: EditorState["doc"], blocks: readonly ConflictBlock[], zh: boolean) {
  const ranges = [];
  for (const block of blocks) {
    ranges.push(Decoration.mark({ class: "cm-conflict-marker" }).range(block.from, block.to));
    for (let line = block.startLine; line <= block.endLine; line++) {
      const position = doc.line(line).from;
      ranges.push(Decoration.line({ class: "cm-conflict-line" }).range(position));
    }
    ranges.push(Decoration.widget({ widget: new ConflictActions(block, zh), block: true, side: -1 }).range(block.from));
  }
  ranges.sort((left, right) => left.from - right.from || left.to - right.to);
  return Decoration.set(ranges, true);
}

const conflicts = StateField.define<ConflictState>({
  create(state) {
    const parsed = conflictBlocks(state.doc.toString());
    return {
      blocks: parsed.blocks,
      decorations: conflictDecorations(state.doc, parsed.blocks, state.facet(conflictLocale)),
      unparseable: parsed.unparseable,
    };
  },
  update(value, transaction) {
    if (!transaction.docChanged) return value;
    const parsed = conflictBlocks(transaction.state.doc.toString());
    return {
      blocks: parsed.blocks,
      decorations: conflictDecorations(transaction.state.doc, parsed.blocks, transaction.state.facet(conflictLocale)),
      unparseable: parsed.unparseable,
    };
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

function navigationPanel(zh: boolean) {
  return (view: EditorView): Panel => {
    const dom = document.createElement("div");
    dom.className = "cm-conflict-nav";
    dom.setAttribute("role", "status");
    dom.setAttribute("aria-live", "polite");
    const previous = document.createElement("button");
    previous.type = "button";
    previous.className = "cm-conflict-nav-button";
    previous.textContent = label(zh, "Previous", "上一个");
    previous.title = `${previous.textContent} (Shift+F7)`;
    previous.addEventListener("click", () => navigateConflict(view, -1));
    const count = document.createElement("span");
    count.className = "cm-conflict-count";
    const next = document.createElement("button");
    next.type = "button";
    next.className = "cm-conflict-nav-button";
    next.textContent = label(zh, "Next", "下一个");
    next.title = `${next.textContent} (F7)`;
    next.addEventListener("click", () => navigateConflict(view, 1));
    const warning = document.createElement("span");
    warning.className = "cm-conflict-warning";
    warning.textContent = label(zh, "Conflict markers are malformed; resolve them manually.", "冲突标记格式错误；请手动解决。");
    dom.append(previous, count, next, warning);
    const refresh = () => {
      const state = view.state.field(conflicts);
      const index = conflictIndexAt(state.blocks, view.state.selection.main.head);
      dom.hidden = !state.unparseable && !state.blocks.length;
      previous.hidden = next.hidden = count.hidden = !state.blocks.length;
      warning.hidden = !state.unparseable;
      previous.disabled = next.disabled = !state.blocks.length;
      count.textContent = index < 0 ? "" : `${index + 1} ${label(zh, "of", "/")} ${state.blocks.length}`;
    };
    refresh();
    return {
      dom,
      top: true,
      update(update: ViewUpdate) {
        if (update.docChanged || update.selectionSet) refresh();
      },
    };
  };
}

const theme = EditorView.baseTheme({
  ".cm-conflict-line": { backgroundColor: "color-mix(in srgb, var(--amber) 12%, var(--editor))" },
  ".cm-conflict-marker": { textDecoration: "underline", textDecorationColor: "var(--amber)" },
  ".cm-conflict-actions": {
    display: "flex",
    flexWrap: "wrap",
    gap: "4px",
    padding: "4px 6px",
    borderBottom: "1px solid var(--border)",
    backgroundColor: "var(--raised)",
  },
  ".cm-conflict-action, .cm-conflict-nav-button": {
    border: "1px solid var(--border)",
    borderRadius: "var(--radius)",
    backgroundColor: "var(--surface)",
    color: "var(--text)",
    font: "inherit",
    fontSize: "11px",
    lineHeight: "20px",
    padding: "0 6px",
    cursor: "pointer",
  },
  ".cm-conflict-action:hover:not(:disabled), .cm-conflict-nav-button:hover:not(:disabled)": { backgroundColor: "var(--soft)" },
  ".cm-conflict-action:focus-visible, .cm-conflict-nav-button:focus-visible": { outline: "2px solid var(--primary)" },
  ".cm-conflict-nav": {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    padding: "4px 8px",
    borderBottom: "1px solid var(--border)",
    backgroundColor: "var(--surface)",
    color: "var(--text)",
    fontSize: "11px",
  },
  ".cm-conflict-nav[hidden]": { display: "none" },
  ".cm-conflict-count": { minWidth: "38px", color: "var(--muted)", textAlign: "center" },
  ".cm-conflict-warning": { color: "var(--amber)" },
});

/** CodeMirror conflict markers, actions, navigation panel, and F7 bindings. */
export function conflictResolver(zh: boolean): Extension {
  return [
    conflictLocale.of(zh),
    conflicts,
    theme,
    showPanel.of(navigationPanel(zh)),
    keymap.of([
      { key: "F7", run: (view) => navigateConflict(view, 1), preventDefault: true },
      { key: "Shift-F7", run: (view) => navigateConflict(view, -1), preventDefault: true },
    ]),
  ];
}
