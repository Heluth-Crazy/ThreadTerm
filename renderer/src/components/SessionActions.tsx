import { Select } from "./ui/Select";
import { useState } from "react";
import type { RequestParams, Session } from "@threadterm/protocol";
import { operationId, request } from "../bridge";
import { useTranslation } from "../i18n";
import { Icon } from "./PrototypeIcon";
import "./session-actions.css";

type OrganizationPatch = Pick<RequestParams<"session.organize">, "pinned" | "bookmarked" | "archived" | "intent">;

export function SessionActions({ session }: { session: Session }) {
  const [issue, setIssue] = useState<string>();
  const [busy, setBusy] = useState(false);
  const { locale } = useTranslation();
  const label = (en: string, zh: string) => locale === "zh-CN" ? zh : en;
  const active = !session.readOnly && ["starting", "running", "idle", "waiting"].includes(session.status);
  const update = async (patch: OrganizationPatch) => {
    if (busy) return;
    setBusy(true);
    setIssue(undefined);
    try {
      await request("session.organize", {
        sessionId: session.id, ...patch,
        expectedRevision: session.organizationRevision ?? 0,
        operationId: operationId(),
      });
    } catch (error) {
      setIssue(error instanceof Error ? error.message : label("Session update failed.", "会话更新失败。"));
    } finally { setBusy(false); }
  };
  return <section className="session-actions session-organize-block">
    <h3>{label("Organize", "整理")}</h3>
    <div className="session-organize-toggles">
    <button title={session.pinned ? label("Unpin", "取消固定") : undefined} disabled={busy || Boolean(session.archived)} aria-pressed={Boolean(session.pinned)} onClick={() => void update({ pinned: !session.pinned })}>
      <svg className="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="m16 3 5 5-4 1-4 4-1 5-6-6 5-1 4-4zM8 16l-5 5" /></svg>{label("Pin", "固定")}
    </button>
    <button title={session.bookmarked ? label("Remove bookmark", "移除书签") : undefined} disabled={busy} aria-pressed={Boolean(session.bookmarked)} onClick={() => void update({ bookmarked: !session.bookmarked })}>
      <Icon name="bookmark" />{label("Bookmark", "书签")}
    </button>
    <button disabled={busy || active} aria-pressed={Boolean(session.archived)} title={active ? label("End the session before archiving", "结束会话后可归档") : session.archived ? label("Unarchive", "取消归档") : undefined} onClick={() => void update({ archived: !session.archived })}>
      <Icon name="archive" />{label("Archive", "归档")}
    </button>
    </div>
    <label className="session-organize-intent">{label("Intent", "意图")}
      <Select aria-label={label("Intent", "意图")} disabled={busy} value={session.intent ?? "none"} onChange={(event) => void update({ intent: event.target.value as OrganizationPatch["intent"] })}>
        <option value="none">{label("No intent", "无")}</option>
        <option value="review">{label("Review", "评审")}</option>
        <option value="fix">{label("Fix", "修复")}</option>
        <option value="research">{label("Research", "调研")}</option>
        <option value="test">{label("Test", "测试")}</option>
        <option value="docs">{label("Documentation", "文档")}</option>
      </Select>
    </label>
    {issue && <small role="alert">{issue}</small>}
  </section>;
}
