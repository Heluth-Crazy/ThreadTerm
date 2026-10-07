import type { AgentReviewFinding, AgentReviewScope, ProviderCapability, ProviderId } from '@threadterm/protocol';
import { MAX_REVIEW_COMMENT_BODY } from './reviewComments';

export function defaultReviewAgent(capabilities: readonly ProviderCapability[], ownProvider: ProviderId): ProviderId | undefined {
 return capabilities.find(capability => capability.installed && capability.chat && capability.id !== ownProvider)?.id
  ?? capabilities.find(capability => capability.installed && capability.chat)?.id;
}

export function reviewScopeLabel(scope: AgentReviewScope, zh: boolean, labels: Readonly<Record<string, string>> = {}): string {
 if(scope.kind === 'uncommitted') return zh ? '未提交的改动' : 'Uncommitted changes';
 const from = labels[scope.from] ?? scope.from, to = scope.to ? labels[scope.to] ?? scope.to : (zh ? '现在' : 'now');
 return zh ? `从 ${from} 到 ${to} 的改动` : `Changes from ${from} to ${to}`;
}

export type FindingCommentContext = { projectId: string; root: string; text: string };
export function agentReviewError(error: unknown, zh: boolean): string {
 const code = String(error).match(/\b(session_not_found|unknown_agent|agent_unavailable|agent_review_limit|checkpoint_not_found|not_a_git_worktree|no_changes|review_not_found|finding_not_found)\b/)?.[1];
 const messages:Record<string,[string,string]> = {
  session_not_found:['This session no longer exists.','此会话已不存在。'],unknown_agent:['The selected agent is not available.','所选智能体不可用。'],agent_unavailable:['The selected agent cannot start a Chat review.','所选智能体无法启动对话审查。'],agent_review_limit:['This session already has three active reviews.','此会话已有三个进行中的审查。'],checkpoint_not_found:['The selected checkpoint is unavailable.','所选检查点不可用。'],not_a_git_worktree:['This session is not in a Git worktree.','此会话不在 Git 工作树中。'],no_changes:['There are no changes to review.','没有可审查的改动。'],review_not_found:['This review no longer exists.','此审查已不存在。'],finding_not_found:['A selected finding no longer exists.','所选发现项已不存在。'],
 };
 return code && messages[code] ? messages[code][zh ? 1 : 0] : String(error);
}
export function findingCommentInput(finding: AgentReviewFinding, context: FindingCommentContext) {
 if(!finding.path || !finding.line) return undefined;
 const raw = `[${finding.severity}] ${finding.title} — ${finding.body}`;
 const body = raw.length <= MAX_REVIEW_COMMENT_BODY ? raw : `${raw.slice(0, MAX_REVIEW_COMMENT_BODY - 1)}…`;
 return {
  projectId: context.projectId,
  root: context.root,
  path: finding.path,
  version: {kind: 'file'} as const,
  side: 'new' as const,
  startLine: finding.line,
  endLine: finding.line,
  body,
  text: context.text,
 };
}
