import { useEffect, useRef, useState } from "react";
import type { ProviderCapability, Settings } from "@threadterm/protocol";
import { openExternal, request } from "../bridge";
import "./provider-network-settings.css";
import "./antigravity-settings.css";

/**
 * Antigravity sign-in (task 11-24). Google's own CLI (`agy acp`) runs the agent; ThreadTerm only hands it the
 * credential of the method chosen here. Nothing is chosen by default: a personal Google account can be saved only
 * after its ban-risk notice is acknowledged (owner decision), and the API key goes to the runtime's secret store
 * through `provider.secret.set`, never into settings.
 */
type Method = "oauth-personal" | "oauth-business" | "gemini-api-key" | "agent-platform";
type Draft = { method?: Method; project: string; location: string };
type Props = {
  settings: Settings;
  capability?: ProviderCapability;
  zh: boolean;
  update: (patch: Record<string, unknown>) => Promise<void>;
};

const METHODS: Method[] = ["oauth-personal", "oauth-business", "gemini-api-key", "agent-platform"];
const TERMS_URL = "https://antigravity.google/terms";
const API_KEY_URL = "https://aistudio.google.com/apikey";

export function configuredAntigravity(settings: Settings): Draft {
  const auth = record(record(settings.providerAuth).antigravity);
  const method = METHODS.find(value => value === auth.method);
  return { method, project: string(auth.project), location: string(auth.location) };
}

export function validateProject(value: string, zh: boolean): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return zh ? "请输入 Google Cloud 项目 ID。" : "Enter the Google Cloud project ID.";
  return /^[a-z0-9.:-]{1,100}$/.test(trimmed) ? undefined : zh ? "项目 ID 只含小写字母、数字和连字符。" : "A project ID has lowercase letters, digits and hyphens.";
}

export function validateLocation(value: string, zh: boolean): string | undefined {
  const trimmed = value.trim();
  return !trimmed || /^[a-z0-9-]{1,40}$/.test(trimmed) ? undefined : zh ? "位置形如 global 或 us-central1。" : "A location looks like global or us-central1.";
}

/** Saving is blocked until a method is chosen, a personal account's risk is acknowledged and Agent Platform has a project. */
export function canSave(draft: Draft, acknowledged: boolean, zh: boolean): boolean {
  if (!draft.method) return false;
  if (draft.method === "oauth-personal" && !acknowledged) return false;
  if (draft.method === "agent-platform") return !validateProject(draft.project, zh) && !validateLocation(draft.location, zh);
  return true;
}

export function AntigravitySettings({ settings, capability, zh, update }: Props) {
  const incoming = configuredAntigravity(settings);
  const incomingKey = draftKey(incoming);
  const [draft, setDraft] = useState<Draft>(incoming);
  const [acknowledged, setAcknowledged] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [issue, setIssue] = useState<string>();
  const saved = useRef({ key: incomingKey, value: incoming });
  const text = zh ? cn : en;

  useEffect(() => {
    if (saved.current.key === incomingKey) return;
    const untouched = draftKey(draft) === saved.current.key;
    saved.current = { key: incomingKey, value: incoming };
    if (untouched) setDraft(incoming);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incomingKey]);

  if (!capability?.authMethods?.length) return null;
  const dirty = draftKey(draft) !== saved.current.key;
  const savedMethod = saved.current.value.method;
  const keyMethod = draft.method === "gemini-api-key" || draft.method === "agent-platform";
  const projectError = draft.method === "agent-platform" ? validateProject(draft.project, zh) : undefined;
  const locationError = draft.method === "agent-platform" ? validateLocation(draft.location, zh) : undefined;

  const choose = (method: Method) => {
    setDraft(current => ({ ...current, method }));
    setAcknowledged(false);
    setNotice(undefined);
    setIssue(undefined);
  };
  const save = async () => {
    if (!canSave(draft, acknowledged, zh) || busy) return;
    setBusy(true);
    setNotice(undefined);
    setIssue(undefined);
    try {
      const value = { method: draft.method, project: draft.project.trim(), location: draft.location.trim() };
      await update({ providerAuth: { antigravity: value } });
      saved.current = { key: draftKey(value), value };
      setDraft(value);
      setNotice(text.saved);
    } catch {
      setIssue(text.saveFailed);
    } finally {
      setBusy(false);
    }
  };
  const storeKey = async (value: string | null) => {
    if (busy) return;
    setBusy(true);
    setNotice(undefined);
    setIssue(undefined);
    try {
      await request("provider.secret.set", { provider: "antigravity", value });
      setApiKey("");
      setNotice(value === null ? text.keyRemoved : text.keySaved);
    } catch {
      setIssue(text.keyFailed);
    } finally {
      setBusy(false);
    }
  };

  return <section className="settings-card provider-network-settings antigravity-settings" aria-labelledby="antigravity-settings-title" data-testid="antigravity-settings">
    <div className="settings-card-row">
      <div>
        <div className="settings-card-title" id="antigravity-settings-title">{text.title}</div>
        <p>{text.description}</p>
      </div>
      <span className={`provider-network-state${savedMethod ? " is-custom" : ""}`}>{savedMethod ? text.short[savedMethod] : text.notChosen}</span>
    </div>
    <fieldset disabled={busy}>
      <legend>{text.method}</legend>
      {METHODS.map(method => <label className="provider-network-option" key={method} data-auth-method={method}>
        <input type="radio" name="antigravity-auth-method" checked={draft.method === method} onChange={() => choose(method)} />
        <span><strong>{text.names[method]}</strong><small>{text.hints[method]}</small></span>
      </label>)}
    </fieldset>
    {draft.method === "oauth-personal" && <div className="agy-risk" role="note" data-testid="antigravity-risk">
      <strong>{text.riskTitle}</strong>
      <p>{text.risk}</p>
      <button type="button" className="agy-link" onClick={() => void openExternal(TERMS_URL)}>{text.terms}</button>
      {savedMethod !== "oauth-personal" && <label className="agy-ack">
        <input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} />
        <span>{text.acknowledge}</span>
      </label>}
    </div>}
    {draft.method === "agent-platform" && <div className="provider-network-fields">
      <label htmlFor="antigravity-project">{text.project}<input id="antigravity-project" type="text" autoComplete="off" spellCheck={false} disabled={busy} placeholder="my-project-id" value={draft.project}
        aria-invalid={Boolean(draft.project) && Boolean(projectError)} onChange={event => setDraft(current => ({ ...current, project: event.target.value }))} />
        {draft.project && projectError && <span className="provider-network-field-error" role="alert">{projectError}</span>}</label>
      <label htmlFor="antigravity-location">{text.location}<input id="antigravity-location" type="text" autoComplete="off" spellCheck={false} disabled={busy} placeholder="global" value={draft.location}
        aria-invalid={Boolean(locationError)} onChange={event => setDraft(current => ({ ...current, location: event.target.value }))} />
        <small>{text.locationHint}</small>{locationError && <span className="provider-network-field-error" role="alert">{locationError}</span>}</label>
    </div>}
    {keyMethod && <div className="agy-key" data-testid="antigravity-api-key">
      <div className="agy-key-head">
        <span>{draft.method === "gemini-api-key" ? text.apiKey : text.apiKeyOptional}</span>
        <span className={`agy-key-state${capability.apiKeySet ? " is-set" : ""}`}>{capability.apiKeySet ? text.keyStored : text.keyMissing}</span>
      </div>
      <div className="agy-key-row">
        <input type="password" autoComplete="off" spellCheck={false} disabled={busy} aria-label={text.apiKey} placeholder={capability.apiKeySet ? text.replacePlaceholder : text.keyPlaceholder}
          value={apiKey} onChange={event => setApiKey(event.target.value)} />
        <button className="btn" type="button" disabled={busy || !apiKey.trim()} onClick={() => void storeKey(apiKey)}>{text.saveKey}</button>
        {capability.apiKeySet && <button className="btn" type="button" disabled={busy} onClick={() => void storeKey(null)}>{text.removeKey}</button>}
      </div>
      <small>{text.keyNote}{draft.method === "gemini-api-key" && <> <button type="button" className="agy-link" onClick={() => void openExternal(API_KEY_URL)}>{text.getKey}</button></>}</small>
    </div>}
    <p className="provider-network-apply-note">{text.applyNote}</p>
    <div className="provider-network-actions">
      {dirty && <button className="btn btn-lg" type="button" disabled={busy} onClick={() => { setDraft(saved.current.value); setAcknowledged(false); setIssue(undefined); }}>{text.discard}</button>}
      <button className="btn btn-primary" type="button" disabled={busy || !dirty || !canSave(draft, acknowledged, zh)} onClick={() => void save()}>{busy ? text.saving : text.save}</button>
    </div>
    {notice && <p className="provider-network-notice" role="status" aria-live="polite">{notice}</p>}
    {issue && <div className="provider-network-save-error" role="alert"><p>{issue}</p></div>}
  </section>;
}

function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function string(value: unknown): string { return typeof value === "string" ? value : ""; }
function draftKey(value: Draft): string { return `${value.method ?? ""}\u0000${value.project.trim()}\u0000${value.location.trim()}`; }

const en = {
  title: "Antigravity sign-in",
  description: "Antigravity runs in Google's own CLI (agy). ThreadTerm gives it only the credential of the method you choose and never reads its sign-in.",
  notChosen: "Not chosen",
  method: "Sign in with",
  names: { "oauth-personal": "Personal Google account", "oauth-business": "Gemini Enterprise account", "gemini-api-key": "Gemini API key", "agent-platform": "Gemini Enterprise Agent Platform (formerly Vertex AI)" } as Record<Method, string>,
  short: { "oauth-personal": "Personal Google", "oauth-business": "Enterprise", "gemini-api-key": "API key", "agent-platform": "Agent Platform" } as Record<Method, string>,
  hints: {
    "oauth-personal": "Google AI Pro or Ultra. The CLI opens Google's sign-in page.",
    "oauth-business": "Your company's or school's Gemini Enterprise. The CLI opens its sign-in page.",
    "gemini-api-key": "A key from Google AI Studio, billed by use. Google recommends this for third-party tools.",
    "agent-platform": "Your Google Cloud project. Uses Application Default Credentials, or an API key.",
  } as Record<Method, string>,
  riskTitle: "Risk of a suspended account",
  risk: "Google's Antigravity terms say that using third-party software to access Antigravity with its login is a breach that can get the Antigravity / Gemini CLI account suspended or terminated (not the whole Google account). Google's Antigravity team has said publicly that using it in T3 Code will not get anyone banned, and ThreadTerm works the same way (Google's own CLI, never touching the sign-in), but that is not a promise to ThreadTerm. To avoid the risk, use a Gemini API key or an Enterprise account.",
  terms: "Read Google's terms",
  acknowledge: "I understand the risk and want to use my personal Google account.",
  project: "Google Cloud project ID",
  location: "Location (optional)",
  locationHint: "global when empty.",
  apiKey: "API key",
  apiKeyOptional: "API key (optional, express mode)",
  keyStored: "A key is stored",
  keyMissing: "No key stored",
  keyPlaceholder: "Paste the key",
  replacePlaceholder: "Paste a new key to replace it",
  saveKey: "Save key",
  removeKey: "Remove",
  keyNote: "Stored encrypted on this computer, apart from settings and backups; it is never shown again.",
  getKey: "Get a key in Google AI Studio",
  applyNote: "Applies to Antigravity sessions connected after saving; connected ones keep their sign-in.",
  discard: "Discard changes",
  save: "Save sign-in method",
  saving: "Saving…",
  saved: "Saved. The next Antigravity session signs in this way.",
  saveFailed: "Could not save the sign-in method. Check the fields and try again.",
  keySaved: "API key saved.",
  keyRemoved: "API key removed.",
  keyFailed: "Could not store the API key.",
};
const cn: typeof en = {
  title: "Antigravity 登录方式",
  description: "Antigravity 由 Google 官方 CLI（agy）运行。ThreadTerm 只把所选方式的凭据交给它，不读取它的登录信息。",
  notChosen: "未选择",
  method: "登录方式",
  names: { "oauth-personal": "个人 Google 账号", "oauth-business": "Gemini Enterprise 账号", "gemini-api-key": "Gemini API key", "agent-platform": "Gemini Enterprise Agent Platform（原 Vertex AI）" },
  short: { "oauth-personal": "个人 Google", "oauth-business": "企业账号", "gemini-api-key": "API key", "agent-platform": "Agent Platform" },
  hints: {
    "oauth-personal": "适用于 Google AI Pro / Ultra。CLI 会打开 Google 登录页。",
    "oauth-business": "公司或学校的 Gemini Enterprise。CLI 会打开它的登录页。",
    "gemini-api-key": "在 Google AI Studio 创建的密钥，按用量计费。Google 推荐第三方工具用这种方式。",
    "agent-platform": "使用你的 Google Cloud 项目。默认用 Application Default Credentials，也可以填 API key。",
  },
  riskTitle: "封号风险",
  risk: "Google 的 Antigravity 服务条款写明：用第三方软件通过 Antigravity 登录访问服务属于违约，可能导致 Antigravity / Gemini CLI 账号被暂停或终止（不是整个 Google 账号）。Google 的 Antigravity 团队公开表示在 T3 Code 中使用不会被封，ThreadTerm 用的是同样的方式（Google 官方 CLI，不碰登录凭据），但这不是 Google 对 ThreadTerm 的承诺。不想承担风险，请用 Gemini API key 或企业账号。",
  terms: "查看 Google 条款",
  acknowledge: "我了解风险，仍使用个人 Google 账号。",
  project: "Google Cloud 项目 ID",
  location: "位置（可选）",
  locationHint: "留空即 global。",
  apiKey: "API key",
  apiKeyOptional: "API key（可选，快速模式）",
  keyStored: "已保存密钥",
  keyMissing: "未保存密钥",
  keyPlaceholder: "粘贴密钥",
  replacePlaceholder: "粘贴新密钥以替换",
  saveKey: "保存密钥",
  removeKey: "移除",
  keyNote: "加密保存在这台电脑上，不进设置和备份，保存后不再显示。",
  getKey: "去 Google AI Studio 获取",
  applyNote: "保存后，新连接的 Antigravity 会话使用新方式；已连接的会话不变。",
  discard: "放弃更改",
  save: "保存登录方式",
  saving: "正在保存…",
  saved: "已保存。下一个 Antigravity 会话会用这种方式登录。",
  saveFailed: "登录方式没有保存成功。请检查填写的内容后重试。",
  keySaved: "API key 已保存。",
  keyRemoved: "API key 已移除。",
  keyFailed: "API key 没有保存成功。",
};
