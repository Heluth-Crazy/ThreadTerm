import { useEffect, useRef, useState } from "react";
import type { Settings } from "@threadterm/protocol";
import "./provider-network-settings.css";

type ProxyMode = "inherit" | "custom";
type GrokNetwork = { mode: ProxyMode; proxyUrl: string; noProxy: string };
type Props = { settings: Settings; zh: boolean; update: (patch: Record<string, unknown>) => Promise<void> };

const localBypass = "localhost,127.0.0.1,::1";

function configuredGrokNetwork(settings: Settings): GrokNetwork {
  const providerNetwork = record(settings.providerNetwork);
  const grok = record(providerNetwork.grok);
  const mode: ProxyMode = grok.mode === "custom" ? "custom" : "inherit";
  return {
    mode,
    proxyUrl: string(grok.proxyUrl),
    noProxy: mode === "custom" ? string(grok.noProxy) || localBypass : string(grok.noProxy),
  };
}

function validateProxyUrl(value: string, zh: boolean): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return zh ? "请输入代理地址。" : "Enter a proxy address.";
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return zh ? "代理地址不能包含控制字符。" : "A proxy address cannot contain control characters.";
  try {
    const url = new URL(trimmed);
    if (!/^https?:$/.test(url.protocol) || !url.hostname || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      return zh ? "仅支持不含凭据、路径、查询参数或片段的 HTTP/HTTPS 地址。" : "Use an HTTP or HTTPS address without credentials, a path, query, or fragment.";
    }
  } catch {
    return zh ? "请输入有效的 HTTP 或 HTTPS 代理地址。" : "Enter a valid HTTP or HTTPS proxy address.";
  }
  return undefined;
}

function validateNoProxy(value: string, zh: boolean): string | undefined {
  if (value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) {
    return zh ? "绕过主机必须是一行、以逗号分隔的列表。" : "Bypass hosts must be a single comma-separated line.";
  }
  return undefined;
}

export function ProviderNetworkSettings({ settings, zh, update }: Props) {
  const incoming = configuredGrokNetwork(settings);
  const incomingKey = networkKey(incoming);
  const [draft, setDraft] = useState(() => incoming);
  const [touched, setTouched] = useState({ proxyUrl: false, noProxy: false });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [issue, setIssue] = useState<string>();
  const proxyInput = useRef<HTMLInputElement>(null);
  const saved = useRef({ key: incomingKey, value: incoming });
  const draftRef = useRef(draft);
  const saving = useRef(false);
  const text = zh ? cn : en;

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);
  useEffect(() => {
    const previous = saved.current;
    if (previous.key === incomingKey) return;
    saved.current = { key: incomingKey, value: incoming };
    if (!sameNetwork(draftRef.current, previous.value)) {
      setNotice(text.externalChanged);
      return;
    }
    setDraft(incoming);
    setTouched({ proxyUrl: false, noProxy: false });
    setIssue(undefined);
  }, [incoming, incomingKey, text.externalChanged]);

  const proxyError = draft.mode === "custom" ? validateProxyUrl(draft.proxyUrl, zh) : undefined;
  const noProxyError = draft.mode === "custom" ? validateNoProxy(draft.noProxy, zh) : undefined;
  const dirty = !sameNetwork(draft, saved.current.value);

  const selectMode = (mode: ProxyMode) => {
    setDraft(current => ({
      ...current,
      mode,
      noProxy: mode === "custom" && !current.noProxy.trim() ? localBypass : current.noProxy,
    }));
    setNotice(undefined);
    setIssue(undefined);
  };
  const save = async () => {
    if (saving.current) return;
    setNotice(undefined);
    setIssue(undefined);
    setTouched({ proxyUrl: true, noProxy: true });
    if (proxyError || noProxyError) {
      if (proxyError) proxyInput.current?.focus();
      return;
    }
    saving.current = true;
    setBusy(true);
    try {
      const normalized = { mode: draft.mode, proxyUrl: draft.proxyUrl.trim(), noProxy: draft.noProxy.trim() };
      await update({ providerNetwork: { grok: normalized } });
      saved.current = { key: networkKey(normalized), value: normalized };
      draftRef.current = normalized;
      setDraft(normalized);
      setTouched({ proxyUrl: false, noProxy: false });
      setNotice(text.saved);
    } catch {
      setIssue(text.saveFailed);
    } finally {
      setBusy(false);
      saving.current = false;
    }
  };

  return <section className="settings-card provider-network-settings" aria-labelledby="provider-network-settings-title">
    <div className="settings-card-row">
      <div>
        <div className="settings-card-title" id="provider-network-settings-title">{text.title}</div>
        <p>{text.description}</p>
      </div>
      <span className={`provider-network-state is-${draft.mode}`}>{draft.mode === "inherit" ? text.inheritShort : text.customShort}</span>
    </div>
    <fieldset disabled={busy}>
      <legend>{text.mode}</legend>
      <label className="provider-network-option">
        <input type="radio" name="grok-proxy-mode" checked={draft.mode === "inherit"} onChange={() => selectMode("inherit")} />
        <span><strong>{text.inherit}</strong><small>{text.inheritHint}</small></span>
      </label>
      <label className="provider-network-option">
        <input type="radio" name="grok-proxy-mode" checked={draft.mode === "custom"} onChange={() => selectMode("custom")} />
        <span><strong>{text.custom}</strong><small>{text.customHint}</small></span>
      </label>
    </fieldset>
    {draft.mode === "custom" && <div className="provider-network-fields">
      <label htmlFor="grok-proxy-url">{text.proxyUrl}<input ref={proxyInput} id="grok-proxy-url" type="url" inputMode="url" autoComplete="off" disabled={busy} placeholder="http://proxy.example:8080" value={draft.proxyUrl} aria-invalid={touched.proxyUrl && Boolean(proxyError)} aria-describedby={touched.proxyUrl && proxyError ? "grok-proxy-url-error" : "grok-proxy-url-hint"} onChange={event => { setDraft(current => ({ ...current, proxyUrl: event.target.value })); setNotice(undefined); setIssue(undefined); }} onBlur={() => setTouched(current => ({ ...current, proxyUrl: true }))} />
        <small id="grok-proxy-url-hint">{text.proxyHint}</small>{touched.proxyUrl && proxyError && <span id="grok-proxy-url-error" className="provider-network-field-error" role="alert">{proxyError}</span>}</label>
      <label htmlFor="grok-no-proxy">{text.noProxy}<input id="grok-no-proxy" type="text" autoComplete="off" disabled={busy} placeholder={localBypass} value={draft.noProxy} aria-invalid={touched.noProxy && Boolean(noProxyError)} aria-describedby={touched.noProxy && noProxyError ? "grok-no-proxy-error" : "grok-no-proxy-hint"} onChange={event => { setDraft(current => ({ ...current, noProxy: event.target.value })); setNotice(undefined); setIssue(undefined); }} onBlur={() => setTouched(current => ({ ...current, noProxy: true }))} />
        <small id="grok-no-proxy-hint">{text.noProxyHint}</small>{touched.noProxy && noProxyError && <span id="grok-no-proxy-error" className="provider-network-field-error" role="alert">{noProxyError}</span>}</label>
    </div>}
    <p className="provider-network-apply-note">{text.applyNote}</p>
    <div className="provider-network-actions">
      {dirty && <button className="btn-subtle" type="button" disabled={busy} onClick={() => { setDraft(saved.current.value); setTouched({ proxyUrl: false, noProxy: false }); setIssue(undefined); setNotice(undefined); }}>{text.discard}</button>}
      <button className="btn btn-primary" type="button" disabled={busy || !dirty} onClick={() => void save()}>{busy ? text.saving : text.save}</button>
    </div>
    {notice && <p className="provider-network-notice" role="status" aria-live="polite">{notice}</p>}
    {issue && <div className="provider-network-save-error" role="alert"><strong>{text.saveErrorTitle}</strong><p>{issue}</p></div>}
  </section>;
}

function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function string(value: unknown): string { return typeof value === "string" ? value : ""; }
function networkKey(value: GrokNetwork): string { return `${value.mode}\u0000${value.proxyUrl}\u0000${value.noProxy}`; }
function sameNetwork(left: GrokNetwork, right: GrokNetwork): boolean { return networkKey(left) === networkKey(right); }

const en = {
  title: "Grok network & proxy", description: "Choose how newly started Grok sessions reach the network.", mode: "Connection route", inherit: "Use inherited environment", inheritShort: "Environment", inheritHint: "Uses the standard HTTP_PROXY, HTTPS_PROXY, ALL_PROXY, and NO_PROXY environment available when ThreadTerm starts. This does not read or change an operating-system proxy setting.", custom: "Use a custom proxy", customShort: "Custom proxy", customHint: "Apply one HTTP or HTTPS proxy endpoint to newly started Grok sessions.", proxyUrl: "Proxy address", proxyHint: "HTTP or HTTPS only. Credentials, paths, queries, and fragments are not accepted.", noProxy: "Bypass hosts (optional)", noProxyHint: "Comma-separated hosts. Local addresses are used by default.", applyNote: "Saved settings apply the next time a Grok session starts. Existing Grok sessions keep their current network settings.", discard: "Discard changes", save: "Save proxy settings", saving: "Saving…", saved: "Grok proxy settings saved. They will apply to newly started Grok sessions.", externalChanged: "Saved Grok proxy settings changed elsewhere. Your unsaved edits are still here; discard them to load the newer settings.", saveErrorTitle: "Unable to save Grok proxy settings", saveFailed: "Check the address and bypass hosts, then try again.",
};
const cn: typeof en = {
  title: "Grok 网络与代理", description: "选择新启动的 Grok 会话如何连接网络。", mode: "连接方式", inherit: "使用继承的环境变量", inheritShort: "环境变量", inheritHint: "使用 ThreadTerm 启动时可用的标准 HTTP_PROXY、HTTPS_PROXY、ALL_PROXY 和 NO_PROXY 环境变量。它不会读取或修改操作系统代理设置。", custom: "使用自定义代理", customShort: "自定义代理", customHint: "将一个 HTTP 或 HTTPS 代理地址应用到新启动的 Grok 会话。", proxyUrl: "代理地址", proxyHint: "仅支持 HTTP 或 HTTPS；不接受凭据、路径、查询参数或片段。", noProxy: "绕过主机（可选）", noProxyHint: "用逗号分隔主机名；默认包含本地地址。", applyNote: "保存后会在下一次启动 Grok 会话时生效。已启动的 Grok 会话会继续使用当前网络设置。", discard: "放弃更改", save: "保存代理设置", saving: "正在保存…", saved: "已保存 Grok 代理设置，将在新启动的 Grok 会话中生效。", externalChanged: "已保存的 Grok 代理设置已在其他位置更改。未保存的编辑仍会保留；放弃更改可载入新设置。", saveErrorTitle: "无法保存 Grok 代理设置", saveFailed: "请检查代理地址和绕过主机后重试。",
};
