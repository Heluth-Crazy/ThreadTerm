// Read-only inline mention badges inside a sent (or pending) user message
// (design-inline-mentions.md §8). Plain runs still go through FileLinkedText,
// so file links outside the badges keep working.
import { Fragment } from 'react';
import type { FileReference } from '@threadterm/protocol';
import { highlightSegments } from '../inlineMentions';
import type { MessageMentionBadge } from '../messageMentions';
import { FileLinkedText } from './FileReferenceText';

type OpenFile = (reference: FileReference) => void;

export function MessageMentionText({ text, badges, openFile }: { text: string; badges: readonly MessageMentionBadge[]; openFile?: OpenFile }) {
  if (!badges.length) return openFile ? <FileLinkedText text={text} openFile={openFile} /> : <>{text}</>;
  const byId = new Map(badges.map(badge => [badge.itemId, badge]));
  return <>{highlightSegments(text, badges).map((segment, index) => {
    const badge = segment.mention ? byId.get(segment.mention.itemId) : undefined;
    if (badge) return <mark key={index} className="chat-mention-badge" data-kind={badge.kind} data-token={badge.token} title={badge.title}>{segment.text}</mark>;
    return openFile ? <FileLinkedText key={index} text={segment.text} openFile={openFile} /> : <Fragment key={index}>{segment.text}</Fragment>;
  })}</>;
}
