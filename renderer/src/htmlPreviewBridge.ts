export type HtmlPreviewCommand =
  | { type: 'grant'; projectId: string; worktreePath?: string; path: string; frameName: string; remote: boolean }
  | { type: 'revoke'; id: string }
  | { type: 'selectAll'; frameName: string };

export type HtmlPreviewGrant = { id: string; url: string };
export type HtmlPreviewLink = { frameName: string; grantId: string; url: string };

type HtmlPreviewBridge = {
  htmlPreview(command: HtmlPreviewCommand): Promise<HtmlPreviewGrant | void>;
  onHtmlPreviewLink(listener: (event: HtmlPreviewLink) => void): () => void;
};

const facade = () => window.threadterm as typeof window.threadterm & Partial<HtmlPreviewBridge>;

export function htmlPreview(command: HtmlPreviewCommand): Promise<HtmlPreviewGrant | void> {
  return facade().htmlPreview?.(command) ?? Promise.reject(new Error('Sandboxed HTML previews require the desktop application.'));
}

export function onHtmlPreviewLink(listener: (event: HtmlPreviewLink) => void): () => void {
  return facade().onHtmlPreviewLink?.(listener) ?? (() => {});
}
