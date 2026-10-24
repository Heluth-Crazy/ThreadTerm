// Content-Security-Policy for ThreadTerm's own documents (review F03/F17 follow-up): the last line of defence behind
// the Markdown policy, so text that ever slips past the sanitizer still cannot run script, pull remote script or
// stylesheets, submit forms, frame the app, or redirect relative URLs.
//
// The policy is built in one place so the built meta tag (vite.config.ts) and the header the main process sets
// (desktop/src/main.ts) can never drift; the brief's directive list is kept, with two relaxations that are deliberate
// and measured:
//   style-src 'unsafe-inline': React, KaTeX, Mermaid and CodeMirror write style attributes and inject <style>
//     elements, so blocking inline style would break every chat surface instead of containing Markdown.
//   img-src http: https:: a remote image loads only after the transcript placeholder decides to request it (F17), so
//     the policy only bounds where an explicitly requested image may come from.
// Script hashes are computed from whatever inline script the built document actually contains, so editing the boot
// script cannot silently break the app.
// The policy deliberately carries no default-src, frame-src or child-src. Chromium enforces frame-src in the embedding
// document for *every* navigation of its child frame, so a frame list here also governed the sandboxed HTML preview and
// the dev-server preview: a preview page navigating itself to mailto: or to a custom scheme was replaced by an error
// page instead of being cancelled by the preview's own grant gate (qa/html-preview-sandbox-visual.mjs). Frames are
// left to the preview's own policy (desktop/src/htmlPreview.ts) and to the grant checks in htmlPreviewPolicy.ts;
// every resource type the app document loads itself is listed explicitly below.
import { createHash } from 'node:crypto';

export interface AppCspOptions {
  /** Vite's dev server needs inline/eval for the HMR preamble and a websocket for updates; never shipped. */
  dev?: boolean;
  /** Meta-delivered policies ignore frame-ancestors (Chromium logs a warning), so it stays header-only. */
  meta?: boolean;
}

// Resolved by the HTML parser: newlines are normalised to LF before the script text is hashed.
const INLINE_SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;

/** sha256- sources for every inline (no src) script in the document, in document order. */
export function cspScriptHashes(html: string): string[] {
  const hashes: string[] = [];
  for (const match of html.matchAll(INLINE_SCRIPT)) {
    if (/\bsrc\s*=/i.test(match[1])) continue;
    const text = match[2].replace(/\r\n?/g, '\n').replace(/\0/g, '\uFFFD');
    hashes.push(`sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}`);
  }
  return hashes;
}

export function appCspDirectives(hashes: readonly string[], options: AppCspOptions = {}): string[] {
  const script = ["'self'", ...hashes.map(hash => `'${hash}'`)];
  const connect = ["'self'"];
  if (options.dev) {
    script.push("'unsafe-inline'", "'unsafe-eval'");
    connect.push('ws:', 'wss:');
  }
  return [
    `script-src ${script.join(' ')}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: http: https:",
    "font-src 'self' data:",
    `connect-src ${connect.join(' ')}`,
    "media-src 'self' data: blob:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    ...(options.meta ? [] : ["frame-ancestors 'none'"]),
  ];
}

export function buildAppCsp(hashes: readonly string[], options: AppCspOptions = {}): string {
  return appCspDirectives(hashes, options).join('; ');
}

/** The production document policy for an HTML file: the app's own inline scripts are allowed by hash. */
export function appCspForHtml(html: string, options: AppCspOptions = {}): string {
  return buildAppCsp(cspScriptHashes(html), options);
}

/** Inserts the policy meta right after the charset declaration, before any script, style or image is fetched. */
export function injectAppCspMeta(html: string, options: AppCspOptions = {}): string {
  if (/http-equiv=["']?content-security-policy/i.test(html)) return html;
  const policy = appCspForHtml(html, { ...options, meta: true });
  const tag = `<meta http-equiv="Content-Security-Policy" content="${policy}" />`;
  const charset = /<meta\s+charset=[^>]*>/i.exec(html);
  if (!charset) return html.replace(/<head\b[^>]*>/i, head => `${head}\n    ${tag}`);
  const at = charset.index + charset[0].length;
  return `${html.slice(0, at)}\n    ${tag}${html.slice(at)}`;
}
