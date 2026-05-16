import type { Terminal } from '@xterm/xterm';

export interface AppendRenderState {
  renderedData: string;
  initialized: boolean;
}

type AppendTerminal = Pick<Terminal, 'reset' | 'write'>;

export function writeAppendOnlyTerminalData(
  terminal: AppendTerminal,
  state: AppendRenderState,
  nextData: string,
) {
  if (nextData === state.renderedData) return;

  if (!state.initialized) {
    terminal.write(nextData);
    state.renderedData = nextData;
    state.initialized = true;
    return;
  }

  if (state.renderedData && nextData.startsWith(state.renderedData)) {
    terminal.write(nextData.slice(state.renderedData.length));
  } else {
    terminal.reset();
    terminal.write(nextData);
  }

  state.renderedData = nextData;
  state.initialized = true;
}
