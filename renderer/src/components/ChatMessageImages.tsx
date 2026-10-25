import { useEffect, useState } from 'react';
import { request } from '../bridge';
import { isChatImage, type ChatImageRef } from '../chatImages';

/** Bounded, local-only image cache: a re-rendered page never refetches the same bytes. */
const cache = new Map<string, string>();
const CACHE_LIMIT = 8;

function key(sessionId: string, ref: ChatImageRef): string {
  return `${sessionId}:${ref.itemId}:${ref.part}:${ref.index}`;
}

function ChatReferenceImage({ sessionId, imageRef, label, copy }: {
  sessionId: string; imageRef: ChatImageRef; label: string; copy: (en: string, zh: string) => string;
}) {
  const cacheKey = key(sessionId, imageRef);
  const [src, setSrc] = useState(() => cache.get(cacheKey));
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (cache.get(cacheKey)) { setSrc(cache.get(cacheKey)); return; }
    let live = true;
    void request('chat.image.read', { sessionId, itemId: imageRef.itemId, part: imageRef.part, index: imageRef.index })
      .then(result => {
        if (!live) return;
        // Only an inline image may render here; anything else (a remote URL from imported history) stays inert.
        if (!isChatImage(result.data)) { setFailed(true); return; }
        if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
        cache.set(cacheKey, result.data);
        setSrc(result.data);
      })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [cacheKey, sessionId, imageRef.itemId, imageRef.part, imageRef.index]);
  if (src) return <img src={src} alt={label} loading="lazy" />;
  return <p className="chat-message-image-missing" role="note">{failed
    ? copy('This image could not be loaded.', '无法加载此图片。')
    : copy('Loading image…', '正在加载图片…')}</p>;
}

/** Inline data URLs, or references to a message too large for one page. */
export function ChatMessageImages({ sessionId, images, refs, copy }: {
  sessionId: string;
  images: readonly string[];
  refs: readonly ChatImageRef[];
  copy: (en: string, zh: string) => string;
}) {
  if (!images.length && !refs.length) return null;
  return <div className="chat-message-images">
    {images.map((image, index) => <img key={`inline-${index}`} src={image} alt={`${copy('Pasted image', '已粘贴图片')} ${index + 1}`} loading="lazy" />)}
    {refs.map(ref => <ChatReferenceImage key={`ref-${ref.part}-${ref.index}`} sessionId={sessionId} imageRef={ref} label={`${copy('Pasted image', '已粘贴图片')} ${ref.index + 1}`} copy={copy} />)}
  </div>;
}
