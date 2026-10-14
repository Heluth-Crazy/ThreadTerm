// Read-only inline mention badges inside a sent (or pending) user message
// (design-inline-mentions.md §8). Plain runs still go through FileLinkedText,
// so file links outside the badges keep working.
import { Fragment, useMemo } from 'react';
import type { FileReference } from '@threadterm/protocol';
import { highlightSegments } from '../inlineMentions';
import type { MessageMentionBadge } from '../messageMentions';
import { fullTitle } from './ContextTray';
import { FileLinkedText } from './FileReferenceText';

type OpenFile = (reference: FileReference) => void;

export function MessageMentionText({ text, badges, openFile, zh }: { text: string; badges: readonly MessageMentionBadge[]; openFile?: OpenFile; zh: boolean }) {
  // Composer edits re-render the transcript; the text and its badges are
  // immutable, so segmentation and the id lookup are computed once.
  const segments = useMemo(() => highlightSegments(text, badges), [text, badges]);
  const byId = useMemo(() => new Map(badges.map(badge => [badge.itemId, badge])), [badges]);
  if (!badges.length) return openFile ? <FileLinkedText text={text} openFile={openFile} /> : <>{text}</>;
  return <>{segments.map((segment, index) => {
    const badge = segment.mention ? byId.get(segment.mention.itemId) : undefined;
    if (badge) return <mark key={index} className="chat-mention-badge" data-kind={badge.kind} data-token={badge.token} title={fullTitle(badge, zh)}>{segment.text}</mark>;
    return openFile ? <FileLinkedText key={index} text={segment.text} openFile={openFile} /> : <Fragment key={index}>{segment.text}</Fragment>;
  })}</>;
}
