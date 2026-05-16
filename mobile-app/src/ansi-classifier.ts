export type AnsiBlockType = 'chat' | 'tui';

export interface AnsiBlockBase {
  id: string;
  type: AnsiBlockType;
  data: string;
  startedAt: number;
  updatedAt: number;
}

export interface ChatBlock extends AnsiBlockBase {
  type: 'chat';
}

export interface TuiBlock extends AnsiBlockBase {
  type: 'tui';
  reason: TuiReason;
  lines: number;
  cols: number;
  complete: boolean;
}

export type AnsiBlock = ChatBlock | TuiBlock;

export type TuiReason =
  | 'alternate-screen'
  | 'cursor-up'
  | 'absolute-cursor'
  | 'carriage-return'
  | 'erase-line'
  | 'box-drawing';

const ALT_SCREEN_ENTER = /\x1b\[\?1049h/;
const ALT_SCREEN_EXIT = /\x1b\[\?1049l/;
const CURSOR_UP = /\x1b\[[0-9;]*A/;
const ABSOLUTE_CURSOR = /\x1b\[[0-9;]*[Hf]/;
const ERASE_LINE = /\x1b\[[0-9;?]*K/;
const BOX_DRAWING = /[\u2500-\u257f]/;
const SGR_ONLY_PATTERN = /\x1b\[[0-9;]*m/g;
const ANSI_PATTERN = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|[()][A-Za-z0-9])/g;

export const TUI_SAFE_FRAME_MS = 200;
// Cap the size of a single sticky TUI block so AI CLI streaming output (which never
// emits a "safe frame" newline + idle window) does not accumulate forever. Once the
// active block crosses either threshold we close it and start a new one on the next
// push. Keep these bounds defensive: large enough that typical short TUI bursts stay
// in a single block, small enough that xterm canvas + per-render diff cost stay
// bounded.
export const TUI_BLOCK_MAX_BYTES = 50_000;
export const TUI_BLOCK_MAX_LINES = 100;

export class AnsiStreamClassifier {
  private blocks: AnsiBlock[] = [];
  private nextId = 1;
  private activeTuiId: string | null = null;
  private altScreen = false;
  private safeFrameAt: number | null = null;

  push(data: string, now = Date.now()): AnsiBlock[] {
    if (!data) return this.blocks;

    const signal = detectTuiSignal(data, this.altScreen);
    const entersAltScreen = ALT_SCREEN_ENTER.test(data);
    const exitsAltScreen = ALT_SCREEN_EXIT.test(data);
    const isTui = this.altScreen || entersAltScreen || signal !== null || this.activeTuiId !== null;

    if (entersAltScreen) {
      this.altScreen = true;
    }

    if (isTui) {
      this.appendTui(data, signal ?? (this.altScreen ? 'alternate-screen' : 'carriage-return'), now);
      if (exitsAltScreen) {
        this.altScreen = false;
        this.completeActiveTui();
      } else if (endsWithSafeNewline(data) && !this.altScreen) {
        this.safeFrameAt = now;
      } else if (!endsWithSafeNewline(data)) {
        this.safeFrameAt = null;
      }
      return this.blocks;
    }

    this.appendChat(data, now);
    return this.blocks;
  }

  flush(now = Date.now()): AnsiBlock[] {
    if (this.activeTuiId && this.safeFrameAt !== null && now - this.safeFrameAt >= TUI_SAFE_FRAME_MS) {
      this.completeActiveTui();
    }
    return this.blocks;
  }

  reset(data = '', now = Date.now()): AnsiBlock[] {
    this.blocks = [];
    this.nextId = 1;
    this.activeTuiId = null;
    this.altScreen = false;
    this.safeFrameAt = null;
    if (data) {
      this.push(data, now);
      this.flush(now + TUI_SAFE_FRAME_MS);
    }
    return this.blocks;
  }

  getBlocks(): AnsiBlock[] {
    return this.blocks;
  }

  private appendChat(data: string, now: number) {
    const last = this.blocks[this.blocks.length - 1];
    if (last?.type === 'chat') {
      last.data += data;
      last.updatedAt = now;
      return;
    }

    this.blocks.push({
      id: this.allocateId(),
      type: 'chat',
      data,
      startedAt: now,
      updatedAt: now,
    });
  }

  private appendTui(data: string, reason: TuiReason, now: number) {
    const active = this.activeTuiId ? this.blocks.find((block) => block.id === this.activeTuiId) : null;
    if (active?.type === 'tui' && !active.complete) {
      if (active.data.length >= TUI_BLOCK_MAX_BYTES || active.lines >= TUI_BLOCK_MAX_LINES) {
        // Sticky block has grown past its cap — close it and fall through to allocate a
        // fresh block for this chunk. The new block inherits the same reason if known,
        // otherwise we keep the caller-supplied reason.
        this.completeActiveTui();
      } else {
        active.data += data;
        active.updatedAt = now;
        updateTuiDimensions(active);
        return;
      }
    }

    const block: TuiBlock = {
      id: this.allocateId(),
      type: 'tui',
      reason,
      data,
      startedAt: now,
      updatedAt: now,
      lines: 1,
      cols: 0,
      complete: false,
    };
    updateTuiDimensions(block);
    this.blocks.push(block);
    this.activeTuiId = block.id;
    this.safeFrameAt = null;
  }

  private completeActiveTui() {
    const active = this.activeTuiId ? this.blocks.find((block) => block.id === this.activeTuiId) : null;
    if (active?.type === 'tui') {
      active.complete = true;
      updateTuiDimensions(active);
    }
    this.activeTuiId = null;
    this.safeFrameAt = null;
  }

  private allocateId(): string {
    const id = `block-${this.nextId}`;
    this.nextId += 1;
    return id;
  }
}

export function detectTuiSignal(data: string, inAltScreen = false): TuiReason | null {
  if (inAltScreen || ALT_SCREEN_ENTER.test(data)) return 'alternate-screen';
  if (CURSOR_UP.test(data)) return 'cursor-up';
  if (ABSOLUTE_CURSOR.test(data)) return 'absolute-cursor';
  if (ERASE_LINE.test(data)) return 'erase-line';
  if (hasStandaloneCarriageReturn(data)) return 'carriage-return';
  if (BOX_DRAWING.test(data)) return 'box-drawing';
  return null;
}

export function isChatChunk(data: string): boolean {
  const withoutSgr = data.replace(SGR_ONLY_PATTERN, '');
  return detectTuiSignal(data) === null && withoutSgr.length > 0;
}

function updateTuiDimensions(block: TuiBlock) {
  const visible = stripAnsi(block.data).replace(/\r/g, '\n');
  const lines = visible.split('\n');
  block.lines = Math.max(1, lines.filter((line) => line.length > 0).length);
  block.cols = Math.max(1, ...lines.map((line) => line.length));
}

function stripAnsi(data: string): string {
  return data.replace(ANSI_PATTERN, '');
}

function hasStandaloneCarriageReturn(data: string): boolean {
  for (let i = 0; i < data.length; i += 1) {
    if (data[i] !== '\r') continue;
    if (data[i + 1] !== '\n') return true;
  }
  return false;
}

function endsWithSafeNewline(data: string): boolean {
  return data.endsWith('\n') || data.endsWith('\r\n');
}
