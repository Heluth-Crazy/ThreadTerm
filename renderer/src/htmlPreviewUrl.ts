/** A preview URL identifies a document; file access still requires a live main-process grant. */
export function isLocalHtmlPreviewUrl(value: string): boolean {
  if (value.length > 2048 || !/^tt-preview:\/\/[a-f0-9]{32}\//.test(value) || /[\s\u0000-\u001f\u007f-\u009f]/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'tt-preview:' && /^[a-f0-9]{32}$/.test(url.hostname) && !url.port && !url.username && !url.password;
  } catch { return false; }
}
