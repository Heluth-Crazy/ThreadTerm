export type EditorLineSeparator = '\n' | '\r\n';

/** Output format only: never configure CodeMirror's input splitting with this value. */
export function dominantLineSeparator(value: string): EditorLineSeparator {
  let crlf = 0, other = 0;
  for (let index = 0; index < value.length; index++) {
    if (value[index] === '\n') {
      if (index > 0 && value[index - 1] === '\r') crlf++;
      else other++;
    } else if (value[index] === '\r' && value[index + 1] !== '\n') other++;
  }
  return crlf > other ? '\r\n' : '\n';
}

/** Mirrors CodeMirror's default normalization of incoming strings. */
export function normalizeEditorText(value: string): string {
  return value.replace(/\r\n?|\n/g, '\n');
}

/** Convert the normalized buffer at the output boundary used by drafts and saves. */
export function serializeEditorText(value: string, separator: EditorLineSeparator): string {
  return normalizeEditorText(value).replace(/\n/g, separator);
}
