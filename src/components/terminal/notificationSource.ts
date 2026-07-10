/**
 * notificationSource — 通知来源标签的单一出处。
 *
 * 系统通知正文与通知中心列表都需要回答"这条通知来自哪张卡片"。
 * 仅靠 projectName 无法区分同项目的多张卡，因此来源串固定为：
 *
 *   项目名 · 终端类型 · 意图/分支
 *
 * `describeCardSource` 是纯函数（可脱离 i18n 单测），
 * `formatCardSourceLabel` 负责把结构化来源经 i18n 拼成显示串。
 */
import type { TerminalAiIntent, TerminalCard, TerminalType } from '../../types/terminal';
import { getTerminalTypeMeta } from './terminalTypeMeta';

export interface CardSource {
  projectName: string;
  terminalType: TerminalType;
  /** AI 卡片的用户意图（review/fix/…），优先于分支展示。 */
  aiIntent?: TerminalAiIntent;
  /** worktree/分支视图下的人类可读分支标签。 */
  branchLabel?: string;
}

type SourceCard = Pick<
  TerminalCard,
  'projectName' | 'terminalType' | 'aiIntent' | 'branchLabel'
>;

export function describeCardSource(card: SourceCard): CardSource {
  return {
    projectName: card.projectName,
    terminalType: card.terminalType,
    aiIntent: card.aiIntent,
    branchLabel: card.branchLabel?.trim() || undefined,
  };
}

/** 兼容 react-i18next 的 `TFunction` 包装与测试 stub：以 `(key, fallback)` 调用返回字符串。 */
type Translate = (key: string, fallback?: string) => string;

/**
 * `项目名 · 类型 · 意图/分支`。意图与分支同时存在时取意图——
 * 意图是用户手选的扫读标签，区分度高于分支名。
 */
export function formatCardSourceLabel(source: CardSource, t: Translate): string {
  const parts: string[] = [source.projectName];
  parts.push(t(`types.${source.terminalType}`, getTerminalTypeMeta(source.terminalType).label));
  if (source.aiIntent) {
    parts.push(t(`aiIntent.${source.aiIntent}`, source.aiIntent));
  } else if (source.branchLabel) {
    parts.push(source.branchLabel);
  }
  return parts.join(' · ');
}
