import { useState } from "react";
import type { ProviderCapability, Session, Snapshot } from "@threadterm/protocol";
import { chooseDirectory, openExternal, operationId, request } from "../bridge";
import type { ProviderReadiness } from "../providerReadiness";
import { userErrorText } from "../runtimeError";
import { SurfaceDialog } from "./SurfaceDialog";
import { signInTerminal } from "./providerSettings";

export function ProviderReadinessAction({ readiness, capability, data, projectId, zh, onCreated, onOpenSettings, menu = false }: { readiness: ProviderReadiness; capability?: ProviderCapability; data: Snapshot; projectId?: string; zh: boolean; onCreated: (session: Session) => void; onOpenSettings?: () => void; menu?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [confirmLink, setConfirmLink] = useState(false);
  const [issue, setIssue] = useState<string>();
  const act = async () => {
    if (busy) return;
    setBusy(true); setIssue(undefined);
    try {
      if (readiness.action === "install" && readiness.homepage) await openExternal(readiness.homepage);
      else if (readiness.action === "signIn" && capability) {
        const command = signInTerminal(capability);
        if (!command) { onOpenSettings?.(); return; }
        const project = data.projects.find(item => item.id === projectId);
        const cwd = project?.path ?? await chooseDirectory();
        if (!cwd) return;
        const session = await request("session.create", { cwd, projectId: project?.id, title: `${capability.name} ${zh ? "登录" : "sign-in"}`, provider: command.provider, mode: "terminal", executable: command.executable, args: [...command.args], operationId: operationId() });
        onCreated(session);
      } else onOpenSettings?.();
    } catch (error) { setIssue(userErrorText(error, zh ? "无法完成提供商操作。" : "Unable to complete this provider action.", zh)); }
    finally { setBusy(false); }
  };
  return <><button type="button" className="btn btn-sm provider-readiness-action" role={menu ? "menuitem" : undefined} disabled={busy} aria-label={`${capability?.name ?? ""}: ${readiness.actionLabel}`} onClick={() => readiness.action === "install" ? setConfirmLink(true) : void act()}>{busy ? (zh ? "正在打开…" : "Opening…") : readiness.actionLabel}</button>{confirmLink && <SurfaceDialog title={zh ? "打开链接" : "Open link"} onClose={() => setConfirmLink(false)} size="sm" footer={<><button type="button" className="btn" onClick={() => setConfirmLink(false)}>{zh ? "取消" : "Cancel"}</button><button type="button" className="btn btn-primary" onClick={() => { setConfirmLink(false); void act(); }}>{zh ? "打开链接" : "Open link"}</button></>}><p>{zh ? "在浏览器中打开此提供商的网站？" : "Open this provider website in your browser?"}</p><p style={{ overflowWrap: "anywhere" }}>{readiness.homepage}</p></SurfaceDialog>}{issue && <span className="surface-error" role="alert">{issue}</span>}</>;
}
