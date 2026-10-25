import { appendFileSync, existsSync, renameSync, rmSync, statSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

/** Keep the active runtime log small while preserving three files in total. */
export const RUNTIME_LOG_MAX_BYTES = 5 * 1024 * 1024;
/** Active log plus these two archives makes three retained files in total. */
export const RUNTIME_LOG_BACKUP_COUNT = 2;
export const RUNTIME_LOG_MAX_LINE_BYTES = 4 * 1024;

const secretLine = /\b(?:bearer\s+\S+|(?:api[_-]?key|token|secret|password|authorization)\s*[=:]\s*["']?\S+)/iu;

export function redactRuntimeLogLine(line: string): string {
  if (secretLine.test(line)) return '[redacted runtime stderr line]';
  if (Buffer.byteLength(line, 'utf8') > RUNTIME_LOG_MAX_LINE_BYTES) return '[truncated runtime log line]';
  return line;
}

export function rotateRuntimeLog(logPath: string, incomingBytes: number): void {
  let size = 0;
  try { size = statSync(logPath).size; } catch {}
  if (size + incomingBytes <= RUNTIME_LOG_MAX_BYTES) return;
  const oldest = `${logPath}.${RUNTIME_LOG_BACKUP_COUNT}`;
  if (existsSync(oldest)) rmSync(oldest);
  for (let index = RUNTIME_LOG_BACKUP_COUNT - 1; index >= 1; index -= 1) {
    const source = `${logPath}.${index}`;
    if (existsSync(source)) renameSync(source, `${logPath}.${index + 1}`);
  }
  if (existsSync(logPath)) renameSync(logPath, `${logPath}.1`);
}

/**
 * Redacts diagnostic streams before they reach disk. The writer is event-driven;
 * it has no timer and a partial unbounded line is discarded rather than buffered.
 */
export class RuntimeLogWriter {
  private partial = '';
  private discarding = false;
  private readonly decoder = new StringDecoder('utf8');

  constructor(private readonly logPath: string) {}

  write(chunk: Buffer | string): void {
    if (typeof chunk === 'string') {
      this.consume(this.decoder.end());
      this.consume(chunk);
      return;
    }
    this.consume(this.decoder.write(chunk));
  }

  private consume(text: string): void {
    while (text) {
      if (this.discarding) {
        const newline = text.indexOf('\n');
        if (newline < 0) return;
        this.discarding = false;
        text = text.slice(newline + 1);
        continue;
      }
      const newline = text.indexOf('\n');
      if (newline >= 0) {
        this.writeLine(this.partial + text.slice(0, newline));
        this.partial = '';
        text = text.slice(newline + 1);
        continue;
      }
      this.partial += text;
      if (Buffer.byteLength(this.partial, 'utf8') > RUNTIME_LOG_MAX_LINE_BYTES) {
        this.writeLine('[truncated runtime log line]');
        this.partial = '';
        this.discarding = true;
      }
      return;
    }
  }

  finish(): void {
    this.consume(this.decoder.end());
    if (this.discarding) return;
    if (!this.partial) return;
    this.writeLine(this.partial);
    this.partial = '';
  }

  private writeLine(line: string): void {
    const output = `${redactRuntimeLogLine(line)}\n`;
    rotateRuntimeLog(this.logPath, Buffer.byteLength(output, 'utf8'));
    appendFileSync(this.logPath, output, 'utf8');
  }
}
