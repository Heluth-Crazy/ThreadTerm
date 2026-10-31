import { useEffect, useMemo, useRef, useState } from "react";
import type {
  CodeReviewDepth,
  CodeReviewProviderChoice,
  CodeReviewScope,
  CodeReviewScopeChoice,
  ProviderId,
  Session,
} from "@threadterm/protocol";
import { operationId, request } from "../bridge";
import {
  clampFocus,
  codeReviewErrorMessage,
  codeReviewReason,
  codeReviewScopeLabel,
  defaultCodeReviewProvider,
  loadCodeReviewPrefs,
  saveCodeReviewPrefs,
} from "../codeReview";
import { AgentIcon } from "./PrototypeIcon";
import { SurfaceDialog } from "./SurfaceDialog";
import "./code-review-dialog.css";

type Options = {
  providers: CodeReviewProviderChoice[];
  scopes: CodeReviewScopeChoice[];
  active?: string;
};

type Props = {
  session: Session;
  leaseEpoch: number;
  initialFocus?: string;
  copy: (en: string, zh: string) => string;
  onClose: () => void;
  onStarted: (reviewId: string, itemId: string) => void;
  onJumpToActive?: (reviewId: string) => void;
};

const depths: { id: CodeReviewDepth; label: [string, string]; cost: string }[] = [
  { id: "quick", label: ["Quick", "快速"], cost: "1" },
  { id: "standard", label: ["Standard", "标准"], cost: "2" },
  { id: "thorough", label: ["Thorough", "彻底"], cost: "4" },
];

export function CodeReviewDialog({ session, leaseEpoch, initialFocus = "", copy, onClose, onStarted, onJumpToActive }: Props) {
  const prefs = useMemo(() => loadCodeReviewPrefs(), []);
  const [options, setOptions] = useState<Options>();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string>();
  const [provider, setProvider] = useState<string>(prefs.provider ?? "");
  const [model, setModel] = useState<string>(prefs.model ?? "");
  const [thinking, setThinking] = useState<string>("");
  const [depth, setDepth] = useState<CodeReviewDepth>(prefs.depth ?? "standard");
  const [scopeKind, setScopeKind] = useState<CodeReviewScope["kind"]>(prefs.scopeKind ?? "uncommitted");
  const [focus, setFocus] = useState(clampFocus(initialFocus));
  const [busy, setBusy] = useState(false);
  const [issue, setIssue] = useState<string>();

  useEffect(() => {
    let live = true;
    setLoading(true);
    setLoadError(undefined);
    void request("codeReview.options", { sessionId: session.id })
      .then((result) => {
        if (!live) return;
        setOptions(result);
        const nextProvider = defaultCodeReviewProvider(result.providers, session.provider, prefs.provider);
        setProvider(nextProvider);
        const choice = result.providers.find((row) => row.id === nextProvider);
        const rememberedModel = prefs.model;
        const modelChoices = choice?.model?.choices ?? [];
        if (rememberedModel && modelChoices.some((row) => row.value === rememberedModel)) setModel(rememberedModel);
        else setModel("");
        const scope = result.scopes.find((row) => row.kind === (prefs.scopeKind ?? "uncommitted") && row.available)
          ?? result.scopes.find((row) => row.available);
        if (scope) setScopeKind(scope.kind);
      })
      .catch((error) => {
        if (live) setLoadError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => { live = false; };
  }, [session.id, session.provider, prefs.provider, prefs.model, prefs.scopeKind]);

  const selected = options?.providers.find((row) => row.id === provider);
  const modelChoices = selected?.model?.choices ?? [];
  const thinkingChoices = selected?.thinking?.choices ?? [];
  const showThinking = Boolean(selected?.thinking);
  const active = options?.active;
  const canStart = Boolean(options && !active && selected?.available && !busy && !loading);

  useEffect(() => {
    if (!showThinking) setThinking("");
    else if (selected?.thinking?.value) setThinking(selected.thinking.value);
  }, [showThinking, selected?.thinking?.value, provider]);

  async function start() {
    if (!canStart || !selected) return;
    setBusy(true);
    setIssue(undefined);
    try {
      const scope: CodeReviewScope = { kind: scopeKind };
      const result = await request("codeReview.start", {
        sessionId: session.id,
        provider: provider as ProviderId,
        ...(model ? { model } : {}),
        ...(thinking ? { thinking } : {}),
        depth,
        scope,
        ...(focus.trim() ? { focus: focus.trim() } : {}),
        operationId: operationId(),
        leaseEpoch,
      });
      saveCodeReviewPrefs({ provider, model: model || undefined, depth, scopeKind });
      onStarted(result.reviewId, result.itemId);
      onClose();
    } catch (error) {
      setIssue(codeReviewErrorMessage(error, copy));
    } finally {
      setBusy(false);
    }
  }

  const startRef = useRef(start);
  startRef.current = start;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        void startRef.current();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return <SurfaceDialog
    title={copy("Code review", "代码审查")}
    subtitle={copy("Review the chosen scope in a fresh read-only agent.", "在全新的只读代理中审查所选范围。")}
    icon="search"
    size="sm"
    className="code-review-dialog"
    onClose={onClose}
    footer={<>
      <button type="button" className="btn" onClick={onClose}>{copy("Cancel", "取消")}</button>
      <button type="button" className="btn btn-primary" disabled={!canStart} data-testid="code-review-start" onClick={() => void start()}>
        {busy ? copy("Starting…", "正在开始…") : copy("Start review", "开始审查")}
      </button>
    </>}
  >
    {loading && <p className="code-review-loading" role="status">{copy("Loading options…", "正在加载选项…")}</p>}
    {loadError && <p className="surface-error" role="alert">{loadError}</p>}
    {!loading && options && <>
      {active && <div className="code-review-active" data-testid="code-review-active">
        <p>{copy("A review is already running in this chat.", "此聊天已有正在进行的代码审查。")}</p>
        {onJumpToActive && <button type="button" className="btn" onClick={() => onJumpToActive(active)}>{copy("Jump to card", "跳转到卡片")}</button>}
      </div>}

      <fieldset className="code-review-field" disabled={Boolean(active)}>
        <legend>{copy("Provider", "Provider")}</legend>
        <div className="code-review-providers" role="listbox" aria-label={copy("Provider", "Provider")}>
          {options.providers.map((row) => <button
            type="button"
            role="option"
            key={row.id}
            className={`code-review-provider${provider === row.id ? " is-selected" : ""}`}
            aria-selected={provider === row.id}
            disabled={!row.available}
            title={codeReviewReason(row.reason, copy)}
            data-testid={`code-review-provider-${row.id}`}
            onClick={() => {
              setProvider(row.id);
              setModel("");
            }}
          >
            <AgentIcon provider={row.id} size={16} />
            <span className="code-review-provider-name">{row.name}</span>
            {!row.available && row.reason && <span className="code-review-provider-reason">{codeReviewReason(row.reason, copy)}</span>}
          </button>)}
        </div>
      </fieldset>

      <label className="code-review-field">
        <span>{copy("Model", "模型")}</span>
        <select value={model} onChange={(event) => setModel(event.target.value)} disabled={Boolean(active)} data-testid="code-review-model">
          <option value="">{copy("Default model", "默认模型")}</option>
          {modelChoices.map((choice) => <option key={choice.value} value={choice.value}>{choice.name || choice.value}</option>)}
        </select>
        {!modelChoices.length && selected && <span className="code-review-hint">{copy(`Open a chat with ${selected.name} once to list its models`, `先用 ${selected.name} 打开一次聊天以列出模型`)}</span>}
      </label>

      {showThinking && <label className="code-review-field">
        <span>{copy("Thinking", "思考")}</span>
        <select value={thinking} onChange={(event) => setThinking(event.target.value)} disabled={Boolean(active)} data-testid="code-review-thinking">
          {thinkingChoices.map((choice) => <option key={choice.value} value={choice.value}>{choice.name || choice.value}</option>)}
        </select>
      </label>}

      <fieldset className="code-review-field" disabled={Boolean(active)}>
        <legend>{copy("Depth", "深度")}</legend>
        <div className="code-review-segments" role="radiogroup" aria-label={copy("Depth", "深度")}>
          {depths.map((row) => <button
            type="button"
            role="radio"
            key={row.id}
            aria-checked={depth === row.id}
            className={depth === row.id ? "is-selected" : undefined}
            data-testid={`code-review-depth-${row.id}`}
            onClick={() => setDepth(row.id)}
          >{copy(row.label[0], row.label[1])}</button>)}
        </div>
        <span className="code-review-hint">{copy("1 / 2 / 4 agent runs", "1 / 2 / 4 次代理运行")}</span>
      </fieldset>

      <fieldset className="code-review-field" disabled={Boolean(active)}>
        <legend>{copy("Scope", "范围")}</legend>
        <div className="code-review-scopes">
          {options.scopes.map((scope) => <button
            type="button"
            key={scope.kind}
            className={`code-review-scope${scopeKind === scope.kind ? " is-selected" : ""}`}
            disabled={!scope.available}
            title={codeReviewReason(scope.reason, copy)}
            data-testid={`code-review-scope-${scope.kind}`}
            onClick={() => setScopeKind(scope.kind)}
          >
            <span>{codeReviewScopeLabel(scope.kind, copy)}</span>
            {scope.fileCount != null && <span className="code-review-count">{scope.fileCount}</span>}
            {!scope.available && scope.reason && <span className="code-review-provider-reason">{codeReviewReason(scope.reason, copy)}</span>}
          </button>)}
        </div>
      </fieldset>

      <label className="code-review-field">
        <span>{copy("Focus", "关注点")}</span>
        <textarea
          value={focus}
          rows={3}
          disabled={Boolean(active)}
          data-testid="code-review-focus"
          placeholder={copy("Optional: what to focus on, or a spec file to check against", "可选：关注什么，或对照的规格文件")}
          onChange={(event) => setFocus(clampFocus(event.target.value))}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.ctrlKey && !event.metaKey) event.stopPropagation();
          }}
        />
      </label>

      {selected?.readOnly === "requested" && <p className="code-review-hint" data-testid="code-review-readonly-note">
        {copy("This agent is asked not to edit files but can't be locked to read-only.", "已要求此代理不编辑文件，但无法强制锁定为只读。")}
      </p>}
    </>}
    {issue && <p className="surface-error" role="alert" data-testid="code-review-error">{issue}</p>}
  </SurfaceDialog>;
}
