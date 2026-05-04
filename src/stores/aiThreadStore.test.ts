import { beforeEach, describe, expect, it } from 'vitest';
import { useAiThreadStore } from './aiThreadStore';

describe('aiThreadStore', () => {
  beforeEach(() => {
    useAiThreadStore.setState({ threads: {} });
  });

  it('appends Q and A entries to the thread for a block', () => {
    const s = useAiThreadStore.getState();
    s.appendQuestion('block-1', 'why did this fail?');
    s.appendAnswer('block-1', 'because exit code 1', 'claude');
    const thread = useAiThreadStore.getState().threads['block-1'];
    expect(thread.entries).toHaveLength(2);
    expect(thread.entries[0]).toMatchObject({ role: 'user', text: 'why did this fail?' });
    expect(thread.entries[1]).toMatchObject({ role: 'ai', provider: 'claude' });
  });

  it('caps a thread at 20 entries (FIFO trim)', () => {
    const s = useAiThreadStore.getState();
    for (let i = 0; i < 25; i++) s.appendQuestion('b', `q${i}`);
    expect(useAiThreadStore.getState().threads['b'].entries).toHaveLength(20);
    expect(useAiThreadStore.getState().threads['b'].entries[0].text).toBe('q5');
  });

  it('clearThread removes the entry', () => {
    const s = useAiThreadStore.getState();
    s.appendQuestion('b', 'q');
    s.clearThread('b');
    expect(useAiThreadStore.getState().threads['b']).toBeUndefined();
  });

  it('setEntryState updates the state of a specific entry', () => {
    const s = useAiThreadStore.getState();
    const id = s.appendQuestion('b', 'q');
    s.setEntryState('b', id, 'ok');
    const entry = useAiThreadStore.getState().threads['b'].entries.find((e) => e.id === id);
    expect(entry?.state).toBe('ok');
  });
});
