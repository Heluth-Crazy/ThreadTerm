import { translate } from './i18n';

/**
 * User-facing failures from the page-comment picker. Keep picker validation
 * matching intentionally exact: IPC errors may otherwise contain page data.
 */
const UNUSABLE_PICK = "Error invoking remote method 'threadterm:pick-page-target': Error: Invalid page comment string";

const text = (value: unknown): string => value instanceof Error ? value.message : typeof value === 'string' ? value : '';

export function pageCommentErrorMessage(value: unknown, zh: boolean): string {
 const reason = text(value);
 if (reason === UNUSABLE_PICK) return translate(zh ? 'zh-CN' : 'en', 'pageSelectionUnusable');
 if (reason === 'review_comments_full') return zh ? '此文件夹已有 200 条审查意见。请先加入消息或删除一些。' : 'This folder already has 200 comments. Add them to the message or remove some first.';
 if (reason === 'review_comment_empty') return zh ? '请先填写审查意见。' : 'Enter a comment first.';
 if (reason === 'review_comment_too_long') return zh ? '一条审查意见最多 4000 个字符。' : 'A comment can be at most 4000 characters.';
 return zh ? '无法完成页面评论。' : 'The page comment could not be completed.';
}
