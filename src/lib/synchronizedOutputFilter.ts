const SYNC_START = '\x1b[?2026h';
const SYNC_END = '\x1b[?2026l';
const ERASE_DISPLAY_COMMANDS = ['\x1b[2J', '\x1b[3J'] as const;
const TRACKED_SEQUENCES = [SYNC_START, SYNC_END, ...ERASE_DISPLAY_COMMANDS] as const;
const MAX_TRACKED_SEQUENCE_LENGTH = Math.max(
  ...TRACKED_SEQUENCES.map((sequence) => sequence.length),
);

/**
 * Work around xterm.js viewport mutations caused by ED2/ED3 inside a DEC 2026
 * synchronized-output frame. Sequence prefixes are retained across PTY chunks
 * so filtering does not depend on backend batching boundaries.
 */
export function createSynchronizedOutputFilter() {
  let inSynchronizedUpdate = false;
  let pendingSequencePrefix = '';

  return {
    write(data: string): string {
      if (!pendingSequencePrefix && !data.includes('\x1b')) return data;

      const input = pendingSequencePrefix + data;
      pendingSequencePrefix = '';
      let output = '';
      let offset = 0;

      while (offset < input.length) {
        if (input.startsWith(SYNC_START, offset)) {
          inSynchronizedUpdate = true;
          output += SYNC_START;
          offset += SYNC_START.length;
          continue;
        }

        if (input.startsWith(SYNC_END, offset)) {
          inSynchronizedUpdate = false;
          output += SYNC_END;
          offset += SYNC_END.length;
          continue;
        }

        const eraseCommand = ERASE_DISPLAY_COMMANDS.find((sequence) =>
          input.startsWith(sequence, offset),
        );
        if (eraseCommand) {
          if (!inSynchronizedUpdate) output += eraseCommand;
          offset += eraseCommand.length;
          continue;
        }

        const remainingLength = input.length - offset;
        if (remainingLength < MAX_TRACKED_SEQUENCE_LENGTH) {
          const remaining = input.slice(offset);
          if (TRACKED_SEQUENCES.some((sequence) => sequence.startsWith(remaining))) {
            pendingSequencePrefix = remaining;
            break;
          }
        }

        output += input[offset];
        offset += 1;
      }

      return output;
    },

    reset(): void {
      inSynchronizedUpdate = false;
      pendingSequencePrefix = '';
    },
  };
}
