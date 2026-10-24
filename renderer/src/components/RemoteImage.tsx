import { useState } from 'react';
import { remoteImagePlaceholderHtml, type InertRemoteImage } from '../markdownPolicy';

/**
 * One remote image from sanitized Markdown (F17). It stays a provenance-visible placeholder until the reader
 * loads this one image; the request is the click, and nothing is remembered across a re-render or a replay.
 * The picture itself is the same inert markup the DOM surfaces get from `remoteImagePlaceholderHtml`.
 */
export function RemoteImage({ image }: { image: InertRemoteImage }) {
  const [loaded, setLoaded] = useState(false);
  if (loaded && image.loadUrl) {
    return <img className="md-remote-image-loaded" src={image.loadUrl} alt={image.alt} title={image.host} loading="lazy" decoding="async" referrerPolicy="no-referrer" />;
  }
  // React owns this subtree, so the delegated document loader must not replace it behind React's back.
  return <span onClick={event => { if ((event.target as Element).closest?.('[data-remote-image-load]')) { event.stopPropagation(); setLoaded(true); } }} dangerouslySetInnerHTML={{ __html: remoteImagePlaceholderHtml(image) }} />;
}
