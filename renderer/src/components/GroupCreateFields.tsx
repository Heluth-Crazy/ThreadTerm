import type { GroupPrerequisiteProvider, ProviderId } from "@threadterm/protocol";
import { agentName } from "../agents";
import { groupHandleIssue, previewGroupHandles, type GroupDraftMember } from "../groupCreate";
import { AgentIcon, Icon } from "./PrototypeIcon";
import { Select } from "./ui/Select";

type Props = {
  providerOptions: readonly ProviderId[];
  usableProviders: readonly ProviderId[];
  providerChecks: readonly GroupPrerequisiteProvider[];
  checkingPrerequisites: boolean;
  capabilities: Parameters<typeof agentName>[1];
  members: GroupDraftMember[];
  lockedFirstProvider?: ProviderId;
  tx: (en: string, zh: string) => string;
  onMembers: (members: GroupDraftMember[]) => void;
  onOpenHomepage: (url: string) => void;
  onOpenSettings?: () => void;
};

export function GroupCreateFields({
  providerOptions, usableProviders, providerChecks, checkingPrerequisites, capabilities, members,
  lockedFirstProvider, tx, onMembers, onOpenHomepage, onOpenSettings,
}: Props) {
  const checkFor = (provider: ProviderId) => providerChecks.find(check => check.provider === provider);
  const previews = previewGroupHandles(members);
  const fixCopy = (check: GroupPrerequisiteProvider) => {
    if (tx("en", "中") === "en") return check.fix?.text ?? check.reason ?? "";
    const provider = agentName(check.provider, capabilities);
    return {
      install: `安装 ${provider} 命令行工具，确认它在 PATH 中，然后刷新检测。`,
      sign_in: `在“设置 → 提供者”中登录 ${provider}，然后刷新检测。`,
      update: `更新 ${provider} 以支持聊天，然后刷新检测。`,
      enable_plugin: `在“设置 → 插件”中启用 ${provider}，然后刷新检测。`,
      configure: `在“设置 → 提供者”中配置 ${provider} 的聊天支持，然后刷新检测。`,
    }[check.fix?.kind ?? "configure"];
  };
  const update = (index: number, patch: Partial<GroupDraftMember>) => {
    onMembers(members.map((member, current) => current === index ? { ...member, ...patch } : member));
  };
  const notices = providerChecks
    .filter(check => !check.usable && check.fix)
    .filter((check, index, checks) => checks.findIndex(item => item.provider === check.provider) === index);
  const selected = new Set(members.map(member => member.provider));
  const chosenNotices = notices.filter(check => selected.has(check.provider));
  const otherNotices = notices.filter(check => !selected.has(check.provider));
  const notice = (check: GroupPrerequisiteProvider) => (
    <div className="group-notice" data-testid="group-provider-notice" title={fixCopy(check)} key={check.provider}>
      <Icon name="info" />
      <span>{fixCopy(check)}</span>
      {onOpenSettings && (check.fix?.kind === "sign_in" || check.fix?.kind === "configure") && (
        <button type="button" className="btn btn-sm" data-testid="group-open-settings" onClick={onOpenSettings}>
          {tx("Open Settings → Providers", "打开设置 → 提供者")}
        </button>
      )}
      {check.fix?.homepage && (
        <button type="button" className="btn btn-sm" onClick={() => onOpenHomepage(check.fix!.homepage!)}>
          {tx("Open homepage", "打开主页")}
        </button>
      )}
    </div>
  );

  return (
    <fieldset className="create-block">
      <legend className="create-label">{tx("Members", "成员")}</legend>
      <div className="group-members" data-testid="group-members">
        {members.map((member, index) => {
          const issue = groupHandleIssue(member.handle, previews, index);
          return (
            <div className="group-member control-row-lg" data-testid={`group-member-${index}`} key={`${member.provider}-${index}`}>
              <span className="group-seat">{index + 1}</span>
              <Select aria-label={tx(`Member ${index + 1} provider`, `成员 ${index + 1} 提供者`)} title={agentName(member.provider, capabilities)} value={member.provider}
                disabled={index === 0 && Boolean(lockedFirstProvider)} onChange={event => update(index, { provider: event.target.value })}>
                {providerOptions.map(provider => {
                  const option = checkFor(provider);
                  return (
                    <option key={provider} value={provider} disabled={checkingPrerequisites || !option?.usable} title={option ? fixCopy(option) : undefined}>
                      <span className="group-provider-option"><AgentIcon provider={provider} size={16} /><span>{agentName(provider, capabilities)}{option?.usable ? "" : ` · ${tx("Unavailable", "不可用")}`}</span></span>
                    </option>
                  );
                })}
              </Select>
              <label className="group-handle input-wrap">
                <span className="sr-only">{tx(`Member ${index + 1} handle`, `成员 ${index + 1} 称呼`)}</span>
                <input value={member.handle} maxLength={24} placeholder={`@${previews[index]}`}
                  aria-invalid={Boolean(issue)} onChange={event => update(index, { handle: event.target.value })} />
              </label>
              <Select aria-label={tx(`Member ${index + 1} mode`, `成员 ${index + 1} 模式`)} value={member.mode}
                onChange={event => update(index, { mode: event.target.value as GroupDraftMember["mode"] })}>
                <option value="default">{tx("Normal", "普通")}</option>
                <option value="read_only">{tx("Read-only", "只读")}</option>
              </Select>
              {members.length > 1 && (
                <button type="button" className="icon-btn" aria-label={tx(`Remove member ${index + 1}`, `移除成员 ${index + 1}`)}
                  onClick={() => onMembers(members.filter((_, current) => current !== index))}>
                  <Icon name="close" />
                </button>
              )}
              {issue && (
                <small className="group-member-note">
                  {issue === "invalid"
                    ? tx("Use lowercase letters, numbers, or hyphens; @all is reserved.", "请使用小写字母、数字或连字符；@all 为保留称呼。")
                    : tx("Handle already in use.", "称呼已被使用。")}
                </small>
              )}
            </div>
          );
        })}
      </div>
      <button type="button" className="btn group-add" data-testid="group-add-member" disabled={members.length >= 6 || usableProviders.length === 0}
        onClick={() => usableProviders[0] && onMembers([...members, { provider: usableProviders[0], handle: "", mode: "default" }])}>
        <Icon name="plus" />{tx("Add member", "添加成员")}
      </button>
      {chosenNotices.map(notice)}
      {otherNotices.length > 0 && (
        <details className="group-prerequisite-more" data-testid="group-other-notices">
          <summary>{otherNotices.length === 1
            ? tx("1 other agent is unavailable", "另有 1 个智能体不可用")
            : tx(`${otherNotices.length} other agents are unavailable`, `另有 ${otherNotices.length} 个智能体不可用`)}</summary>
          {otherNotices.map(notice)}
        </details>
      )}
    </fieldset>
  );
}
