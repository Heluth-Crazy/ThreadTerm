type ReadBoundary = { fromCursor: number };

export type ReplayRetentionBoundary = { cursor: number; trimmed: boolean };

/** The initial indexed read identifies the first replayable byte after retention. */
export function replayRetentionBoundary(page: ReadBoundary, replayEnd: number): ReplayRetentionBoundary {
  if (!Number.isSafeInteger(page.fromCursor) || page.fromCursor < 0 || page.fromCursor > replayEnd) {
    throw new Error("Terminal replay returned an invalid retained output start.");
  }
  return { cursor: page.fromCursor, trimmed: page.fromCursor > 0 };
}

export function retainedOutputTrimmedNote(zh: boolean, live: boolean): string {
  if (!live) return zh ? "较早的输出已被清理。" : "Older output was trimmed.";
  return zh
    ? "较早的输出已被清理，此终端保留最近 128 MB。"
    : "Older output was trimmed. This terminal keeps its newest 128 MB.";
}
