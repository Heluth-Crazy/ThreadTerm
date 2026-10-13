// Composer option chips (task 10-11-chat-parity C2).
//
// Renders the composer bar's option controls: the mode chip, one chip per
// remaining option, the combined model + thinking chip and their menus. The
// `+` button and the Stop/Send controls stay in ChatView and are passed as
// slots, so this component owns only the option surface and the overflow fold.
//
// One `ResizeObserver` watches the bar, the right group and a hidden measure
// row. It is scoped to a mounted composer and fires only on layout changes -
// there is no timer, interval or idle work.

import { Fragment, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import type { ChatOptionsLoadState, ChatSessionChoice, ChatSessionOption } from "@threadterm/protocol";
import { Icon } from "./PrototypeIcon";
import { statusModelReserve } from "../contextUsage";
import {
  booleanText,
  chipValueText,
  choiceText,
  currentChoiceName,
  foldExtraChips,
  isBooleanOption,
  isRecommended,
  modelRows,
  optionTitle,
  partitionOptions,
  thinkingChipText,
  virtualWindow,
  type ComposerCopy,
  type ModelRow,
} from "../composerOptions";

const CHIP_GAP = 6;
const BAR_GAP = 8;
const SAFETY = 2;
const COG_WIDTH = 26;
const MODEL_MIN = 72;
const MODEL_MAX = 200;
const MODEL_SEARCH_THRESHOLD = 8;
const VIRTUAL_THRESHOLD = 100;
const MODEL_ROW_HEIGHT = 30;
const MODEL_VIEWPORT = 240;

type OpenMenu = { kind: "model" } | { kind: "more" } | { kind: "option"; id: string };

export function ComposerOptions({
  options,
  loadState,
  zh,
  copy,
  disabled,
  busy,
  onSetOption,
  leading,
  trailing,
  status,
}: {
  options: ChatSessionOption[];
  loadState?: ChatOptionsLoadState;
  zh: boolean;
  copy: ComposerCopy;
  disabled: boolean;
  busy: boolean;
  onSetOption: (optionId: string, value: string) => void;
  leading: ReactNode;
  trailing: ReactNode;
  status?: ReactNode;
}) {
  const { model, thinking, mode, extras } = partitionOptions(options);
  const [open, setOpen] = useState<OpenMenu | undefined>(undefined);
  const [search, setSearch] = useState("");
  const [fold, setFold] = useState({ visibleCount: Number.MAX_SAFE_INTEGER, foldedCount: 0 });
  const barRef = useRef<HTMLDivElement>(null);
  const leadingRef = useRef<HTMLSpanElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const modelRef = useRef<HTMLButtonElement>(null);
  const statusRef = useRef<HTMLSpanElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const triggers = useRef(new Map<string, HTMLButtonElement | null>());

  const closeAndFocus = (key: string) => {
    setOpen(undefined);
    triggers.current.get(key)?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : undefined;
      if (!target?.closest(".chat-compose-menu, [data-menu-trigger]")) setOpen(undefined);
    };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") closeAndFocus(triggerKey(open)); };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // One ResizeObserver on the bar, the right group and the hidden measure row.
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const barWidth = bar.clientWidth;
      const leadingWidth = leadingRef.current?.offsetWidth ?? 26;
      const modeWidth = mode ? (triggers.current.get("mode")?.offsetWidth ?? 0) : 0;
      const rightWidth = rightRef.current?.offsetWidth ?? 0;
      const modelWidth = model ? (modelRef.current?.offsetWidth ?? 0) : 0;
      const natural = measureRef.current?.querySelector<HTMLElement>(".chat-model-measure")?.offsetWidth ?? MODEL_MIN;
      const naturalReserve = Math.min(MODEL_MAX, Math.max(MODEL_MIN, natural));
      const statusWidth = statusRef.current?.offsetWidth ?? 0;
      const modelReserve = statusModelReserve(naturalReserve, statusWidth ? statusWidth + CHIP_GAP : 0, MODEL_MIN);
      const rightFixed = Math.max(0, rightWidth - modelWidth);
      const left = leadingWidth + (modeWidth ? modeWidth + CHIP_GAP : 0);
      const available = barWidth - left - rightFixed - modelReserve - CHIP_GAP - BAR_GAP - SAFETY;
      const widths = [...(measureRef.current?.querySelectorAll<HTMLElement>("[data-measure-width]") ?? [])].map(node => node.offsetWidth);
      const next = foldExtraChips({ available, gap: CHIP_GAP, widths, cogWidth: COG_WIDTH });
      setFold(current => (current.visibleCount === next.visibleCount && current.foldedCount === next.foldedCount ? current : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(bar);
    if (rightRef.current) observer.observe(rightRef.current);
    if (statusRef.current) observer.observe(statusRef.current);
    if (measureRef.current) observer.observe(measureRef.current);
    return () => observer.disconnect();
  }, [options, loadState, busy, zh, model, mode, extras.length]);

  const visibleExtras = extras.slice(0, Math.max(0, extras.length - fold.foldedCount));
  const folded = extras.slice(visibleExtras.length);
  const choose = (optionId: string, value: string) => {
    setOpen(undefined);
    setSearch("");
    onSetOption(optionId, value);
  };

  if (loadState === "loading") {
    return (
      <div className="chat-compose-bar" ref={barRef}>
        <div className="chat-compose-left">
          <span className="chat-compose-leading" ref={leadingRef}>{leading}</span>
          <button type="button" className="chip chip-btn is-plain chat-compose-chip" disabled>{copy("Loading settings…", "正在加载设置…")}</button>
        </div>
        <div className="chat-compose-right" ref={rightRef}>{status && <span className="chat-compose-status" ref={statusRef}>{status}</span>}{trailing}</div>
        <div className="chat-compose-measure" aria-hidden="true" ref={measureRef} />
      </div>
    );
  }

  const moreOpen = open?.kind === "more";
  const modelOpen = open?.kind === "model";

  return (
    <div className="chat-compose-bar" ref={barRef}>
      <div className="chat-compose-left">
        <span className="chat-compose-leading" ref={leadingRef}>{leading}</span>
        {mode && (
          <span className="chat-compose-anchor">
            <button
              type="button"
              ref={node => { triggers.current.set("mode", node); }}
              className={`chip chip-btn is-plain chat-compose-chip chat-mode-chip${/^(yolo|bypasspermissions|dangerfullaccess)$/.test(mode.value.replace(/[^a-z0-9]/gi, "").toLowerCase()) ? " is-warn" : ""} mode-${mode.value.replace(/[^a-z0-9]/gi, "") || "unknown"}`}
              data-menu-trigger="mode"
              aria-haspopup="menu"
              aria-expanded={open?.kind === "option" && open.id === mode.id}
              disabled={disabled}
              title={`${optionTitle(mode, copy)}: ${chipValueText(mode, zh)}`}
              onClick={() => setOpen(open?.kind === "option" && open.id === mode.id ? undefined : { kind: "option", id: mode.id })}
            >
              <Icon name="shield" /><span>{chipValueText(mode, zh)}</span>
            </button>
            {open?.kind === "option" && open.id === mode.id && (
              <OptionMenu option={mode} zh={zh} copy={copy} disabled={disabled || busy} className="chat-menu-mode" onChoose={choose} onKeyDown={onMenuKeyDown} />
            )}
          </span>
        )}
        {visibleExtras.map(option => (
          <span className="chat-compose-anchor" key={option.id}>
            <OptionChip
              option={option}
              zh={zh}
              copy={copy}
              disabled={disabled}
              busy={busy}
              open={open?.kind === "option" && open.id === option.id}
              triggerRef={node => { triggers.current.set(option.id, node); }}
              onToggle={() => setOpen(open?.kind === "option" && open.id === option.id ? undefined : { kind: "option", id: option.id })}
              onToggleBoolean={next => { if (!disabled && !busy) choose(option.id, next); }}
            />
            {open?.kind === "option" && open.id === option.id && !isBooleanOption(option) && (
              <OptionMenu option={option} zh={zh} copy={copy} disabled={disabled || busy} onChoose={choose} onKeyDown={onMenuKeyDown} />
            )}
          </span>
        ))}
        {folded.length > 0 && (
          <span className="chat-compose-anchor">
            <button
              type="button"
              ref={node => { triggers.current.set("more", node); }}
              className="icon-btn icon-btn-sm icon-btn-round chat-compose-more"
              data-menu-trigger="more"
              aria-haspopup="menu"
              aria-expanded={moreOpen}
              aria-label={copy("More settings", "更多设置")}
              title={copy("More settings", "更多设置")}
              disabled={disabled}
              onClick={() => setOpen(moreOpen ? undefined : { kind: "more" })}
            >
              <Icon name="gear" />
            </button>
            {moreOpen && (
              <div className="chat-compose-menu chat-menu-more" role="menu" aria-label={copy("More settings", "更多设置")} onKeyDown={onMenuKeyDown}>
                <p className="chat-menu-label">{copy("More settings", "更多设置")}</p>
                {folded.map(option => (
                  <div className="chat-more-row" key={option.id}>
                    <span className="chat-more-name">{optionTitle(option, copy)}<small>{chipValueText(option, zh)}</small></span>
                    <span className="chat-more-choices">
                      {option.choices.map(choice => (
                        <button
                          type="button"
                          key={choice.value}
                          role="menuitemradio"
                          aria-checked={choice.value === option.value}
                          className={`chip chip-btn is-plain chat-more-choice${choice.value === option.value ? " is-on" : ""}`}
                          disabled={disabled || busy}
                          onClick={() => choose(option.id, choice.value)}
                        >
                          {choiceText(option, choice, zh)}
                        </button>
                      ))}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </span>
        )}
      </div>
      <div className="chat-compose-right" ref={rightRef}>
        {model && (
          <span className="chat-compose-anchor">
            <button
              type="button"
              ref={node => { modelRef.current = node; triggers.current.set("model", node); }}
              className="chip chip-btn is-plain chat-compose-chip chat-model-chip"
              data-menu-trigger="model"
              aria-haspopup="menu"
              aria-expanded={modelOpen}
              disabled={disabled}
              title={`${optionTitle(model, copy)}: ${currentChoiceName(model) || model.value}${thinking ? ` · ${optionTitle(thinking, copy)}: ${currentChoiceName(thinking) || thinking.value}` : ""}`}
              onClick={() => setOpen(modelOpen ? undefined : { kind: "model" })}
            >
              <span className="chat-model-name">{currentChoiceName(model) || copy("Model", "模型")}</span>
              {thinking && <span className="chat-model-think">{thinkingChipText(thinking, zh)}</span>}
              <Icon name="chevD" className="chat-model-chev" />
            </button>
            {modelOpen && <ModelMenu option={model} thinking={thinking} zh={zh} copy={copy} disabled={disabled || busy} search={search} onSearch={setSearch} onChoose={choose} onKeyDown={onMenuKeyDown} />}
          </span>
        )}
        {status && <span className="chat-compose-status" ref={statusRef}>{status}</span>}
        {trailing}
      </div>
      <div className="chat-compose-measure" aria-hidden="true" ref={measureRef}>
        {extras.map(option => (
          <span key={option.id} data-measure-width="" className="chip chip-btn chat-compose-measure-chip">
            <span>{isBooleanOption(option) ? `${optionTitle(option, copy)}: ${booleanText(option.value, copy)}` : chipValueText(option, zh)}</span>
          </span>
        ))}
        {model && (
          <span className="chip chip-btn chat-model-measure">
            <span className="chat-model-measure-name">{currentChoiceName(model) || model.value}</span>
            {thinking && <span className="chat-model-measure-think">{thinkingChipText(thinking, zh)}</span>}
            <Icon name="chevD" />
          </span>
        )}
      </div>
    </div>
  );
}

function triggerKey(open: OpenMenu): string {
  return open.kind === "option" ? open.id : open.kind;
}

function OptionChip({
  option,
  zh,
  copy,
  disabled,
  busy,
  open,
  triggerRef,
  onToggle,
  onToggleBoolean,
}: {
  option: ChatSessionOption;
  zh: boolean;
  copy: ComposerCopy;
  disabled: boolean;
  busy: boolean;
  open: boolean;
  triggerRef: (node: HTMLButtonElement | null) => void;
  onToggle: () => void;
  onToggleBoolean: (next: string) => void;
}) {
  const boolean = isBooleanOption(option);
  const on = option.value === "true" || option.value.toLowerCase() === "on";
  if (boolean) {
    const locked = disabled || busy;
    const label = `${optionTitle(option, copy)}: ${booleanText(option.value, copy)}`;
    return (
      <button
        type="button"
        ref={triggerRef}
        className={`chip chip-btn is-plain chat-compose-chip chat-option-chip${on ? " is-on" : ""}`}
        data-option-id={option.id}
        aria-pressed={on}
        aria-label={label}
        title={busy && !disabled ? copy("Available after the current turn", "当前回合结束后可用") : label}
        disabled={locked}
        onClick={() => onToggleBoolean(option.choices.find(choice => choice.value !== option.value)?.value ?? (on ? "false" : "true"))}
      >
        <span>{label}</span>
      </button>
    );
  }
  return (
    <button
      type="button"
      ref={triggerRef}
      className="chip chip-btn is-plain chat-compose-chip chat-option-chip"
      data-option-id={option.id}
      data-menu-trigger={option.id}
      aria-haspopup="menu"
      aria-expanded={open}
      title={optionTitle(option, copy)}
      disabled={disabled}
      onClick={onToggle}
    >
      <span>{chipValueText(option, zh)}</span>
    </button>
  );
}

function OptionMenu({
  option,
  zh,
  copy,
  disabled,
  className,
  onChoose,
  onKeyDown,
}: {
  option: ChatSessionOption;
  zh: boolean;
  copy: ComposerCopy;
  disabled: boolean;
  className?: string;
  onChoose: (optionId: string, value: string) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const menu = ref.current;
    const target = menu?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]') ?? menu?.querySelector<HTMLElement>('[role="menuitemradio"]');
    target?.focus();
  }, []);
  return (
    <div ref={ref} className={`chat-compose-menu is-anchored${className ? ` ${className}` : ""}`} role="menu" aria-label={optionTitle(option, copy)} onKeyDown={onKeyDown}>
      <p className="chat-menu-label">{optionTitle(option, copy)}</p>
      {option.description && <p className="chat-menu-desc">{option.description}</p>}
      {option.choices.map(choice => <MenuChoice key={choice.value} option={option} choice={choice} zh={zh} copy={copy} disabled={disabled} onChoose={onChoose} />)}
    </div>
  );
}

function MenuChoice({
  option,
  choice,
  zh,
  copy,
  disabled,
  onChoose,
}: {
  option: ChatSessionOption;
  choice: ChatSessionChoice;
  zh: boolean;
  copy: ComposerCopy;
  disabled: boolean;
  onChoose: (optionId: string, value: string) => void;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={choice.value === option.value}
      className={`chat-menu-item${choice.value === option.value ? " active" : ""}`}
      disabled={disabled}
      onClick={() => onChoose(option.id, choice.value)}
    >
      <Icon name="check" className="chat-menu-check" />
      <span className="chat-menu-text">
        <span>{choiceText(option, choice, zh)}</span>
        {choice.description && <small className="chat-menu-choice-desc">{choice.description}</small>}
      </span>
      {isRecommended(option, choice) && <small className="chat-menu-badge">{copy("Recommended", "推荐")}</small>}
    </button>
  );
}

function ModelMenu({
  option,
  thinking,
  zh,
  copy,
  disabled,
  search,
  onSearch,
  onChoose,
  onKeyDown,
}: {
  option: ChatSessionOption;
  thinking?: ChatSessionOption;
  zh: boolean;
  copy: ComposerCopy;
  disabled: boolean;
  search: string;
  onSearch: (value: string) => void;
  onChoose: (optionId: string, value: string) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
}) {
  const searchable = option.choices.length > MODEL_SEARCH_THRESHOLD;
  const rows = modelRows(option.choices, search);
  const virtual = rows.length > VIRTUAL_THRESHOLD;
  const [scrollTop, setScrollTop] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (searchable) inputRef.current?.focus(); }, [searchable]);
  const window = virtual
    ? virtualWindow({ count: rows.length, scrollTop, rowHeight: MODEL_ROW_HEIGHT, viewportHeight: MODEL_VIEWPORT })
    : { start: 0, end: rows.length };
  const renderRow = (row: ModelRow, index: number) => row.kind === "header"
    ? <p className="chat-menu-group" key={`header-${row.key}`}>{row.key}</p>
    : <MenuChoice key={`choice-${row.choice.value}-${index}`} option={option} choice={row.choice} zh={zh} copy={copy} disabled={disabled} onChoose={onChoose} />;
  return (
    <div className="chat-compose-menu chat-menu-model" role="menu" aria-label={copy("Model and thinking level", "模型与思考程度")} onKeyDown={onKeyDown}>
      {searchable && (
        <input
          ref={inputRef}
          className="chat-menu-search"
          type="text"
          value={search}
          placeholder={copy("Search models…", "搜索模型…")}
          aria-label={copy("Search models", "搜索模型")}
          onChange={event => { onSearch(event.target.value); setScrollTop(0); }}
        />
      )}
      <p className="chat-menu-label">{optionTitle(option, copy)}</p>
      {rows.length === 0 ? <p className="chat-menu-empty">{copy("No models found", "未找到模型")}</p>
        : virtual ? (
          <div className="chat-menu-virtual" onScroll={event => setScrollTop(event.currentTarget.scrollTop)}>
            <div className="chat-menu-virtual-inner" style={{ height: rows.length * MODEL_ROW_HEIGHT }}>
              <div className="chat-menu-virtual-window" style={{ transform: `translateY(${window.start * MODEL_ROW_HEIGHT}px)` }}>
                {rows.slice(window.start, window.end).map((row, index) => renderRow(row, window.start + index))}
              </div>
            </div>
          </div>
        ) : rows.map((row, index) => renderRow(row, index))}
      {thinking && (
        <Fragment>
          <p className="chat-menu-label">{optionTitle(thinking, copy)}</p>
          {thinking.choices.map(choice => <MenuChoice key={choice.value} option={thinking} choice={choice} zh={zh} copy={copy} disabled={disabled} onChoose={onChoose} />)}
        </Fragment>
      )}
    </div>
  );
}

function onMenuKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
  const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitemradio"]:not(:disabled)')];
  if (!items.length) return;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const index = items.findIndex(item => item === document.activeElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    const next = index < 0 ? (step === 1 ? 0 : items.length - 1) : (index + step + items.length) % items.length;
    items[next]?.focus();
    return;
  }
  if (event.key === "Home" || event.key === "End") {
    event.preventDefault();
    items[event.key === "Home" ? 0 : items.length - 1]?.focus();
  }
}
