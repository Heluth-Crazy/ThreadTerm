// Inline mention highlight layer (design-inline-mentions.md §7).
//
// Paints read-only badges behind the native, transparent <textarea> so a live
// mention token keeps its text in the draft while the user sees a badge. The
// component is mounted only while at least one mention resolves; it renders a
// scrolling child whose `scrollTop` mirrors the textarea's so the badges stay
// registered with the glyphs while the draft scrolls.
import { useEffect, useRef, type RefObject } from 'react';
import { highlightSegments, type MentionEntry, type ResolvedMention } from '../inlineMentions';

export function ComposerMentionHighlights({ text, resolved, catalogue, areaRef }: {
  text: string;
  resolved: readonly ResolvedMention[];
  catalogue: readonly MentionEntry[];
  areaRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const area = areaRef.current;
    const scroll = scrollRef.current;
    if (!area || !scroll) return;
    const sync = () => { scroll.scrollTop = area.scrollTop; };
    sync();
    area.addEventListener('scroll', sync, { passive: true });
    return () => area.removeEventListener('scroll', sync);
  }, [areaRef, text, resolved]);

  // Zero cost without mentions: no layer, no listeners, no DOM.
  if (resolved.length === 0) return null;
  const kinds = new Map(catalogue.map(entry => [entry.token, entry.item.kind]));
  const segments = highlightSegments(text, resolved);
  return (
    <div className="chat-compose-highlights" aria-hidden="true">
      <div className="chat-compose-highlights-scroll" ref={scrollRef}>
        {segments.map((segment, index) => segment.mention
          ? <mark key={index} className="chat-mention-badge" data-kind={kinds.get(segment.mention.token) ?? 'file'} data-token={segment.mention.token} data-start={segment.mention.start} data-end={segment.mention.end} data-id={segment.mention.itemId}>{segment.text}</mark>
          : <span key={index}>{segment.text}</span>)}
        {/* A trailing newline needs one more line box so the layer's height matches the textarea's. */}
        {text.endsWith('\n') ? '\u200b' : null}
      </div>
    </div>
  );
}
