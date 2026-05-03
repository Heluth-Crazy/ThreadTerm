import { describe, expect, it } from 'vitest';
import { createOutputSequencer } from './outputSequencer';

describe('createOutputSequencer', () => {
  it('buffers live output until a snapshot is applied, then flushes newer output in seq order', () => {
    const writes: Array<{ data: string; seq: number; ack: boolean; render: boolean }> = [];
    const sequencer = createOutputSequencer((data, seq, onWritten, meta) => {
      writes.push({ data, seq, ack: meta.ack, render: meta.render });
      onWritten();
    });

    sequencer.receive({ seq: 5, data: 'five' });
    sequencer.receive({ seq: 3, data: 'three' });
    sequencer.receive({ seq: 4, data: 'four' });
    expect(writes).toEqual([]);

    sequencer.applySnapshot({ seq: 2, data: 'snapshot' });

    expect(writes).toEqual([
      { data: 'snapshot', seq: 2, ack: false, render: true },
      { data: 'three', seq: 3, ack: true, render: true },
      { data: 'four', seq: 4, ack: true, render: true },
      { data: 'five', seq: 5, ack: true, render: true },
    ]);
  });

  it('acks pending live output that is covered by the attach snapshot without rendering it', () => {
    const writes: Array<{ data: string; seq: number; ack: boolean; render: boolean }> = [];
    const sequencer = createOutputSequencer((data, seq, onWritten, meta) => {
      writes.push({ data, seq, ack: meta.ack, render: meta.render });
      onWritten();
    });

    sequencer.receive({ seq: 1, data: 'already in snapshot' });
    sequencer.receive({ seq: 3, data: 'newer live' });
    sequencer.applySnapshot({ seq: 2, data: 'snapshot' });

    expect(writes).toEqual([
      { data: 'snapshot', seq: 2, ack: false, render: true },
      { data: 'already in snapshot', seq: 1, ack: true, render: false },
      { data: 'newer live', seq: 3, ack: true, render: true },
    ]);
  });

  it('drops stale and duplicate outputs after the snapshot gate opens', () => {
    const writes: string[] = [];
    const sequencer = createOutputSequencer((data, _seq, onWritten) => {
      writes.push(data);
      onWritten();
    });

    sequencer.applySnapshot({ seq: 10, data: 'snapshot' });
    sequencer.receive({ seq: 9, data: 'stale' });
    sequencer.receive({ seq: 10, data: 'duplicate' });
    sequencer.receive({ seq: 11, data: 'new' });
    sequencer.receive({ seq: 11, data: 'new duplicate' });

    expect(writes).toEqual(['snapshot', 'new']);
    expect(sequencer.getLastAppliedSeq()).toBe(11);
  });

  it('opens the gate with an empty snapshot when no backend session exists', () => {
    const writes: string[] = [];
    const sequencer = createOutputSequencer((data, _seq, onWritten) => {
      writes.push(data);
      onWritten();
    });

    sequencer.receive({ seq: 1, data: 'one' });
    sequencer.applySnapshot({ seq: 0, data: '' });
    sequencer.receive({ seq: 2, data: 'two' });

    expect(writes).toEqual(['one', 'two']);
  });

  it('reset closes the gate and clears pending output', () => {
    const writes: string[] = [];
    const sequencer = createOutputSequencer((data, _seq, onWritten) => {
      writes.push(data);
      onWritten();
    });

    sequencer.receive({ seq: 1, data: 'old pending' });
    sequencer.reset();
    sequencer.applySnapshot({ seq: 4, data: 'snapshot' });
    sequencer.receive({ seq: 5, data: 'new' });

    expect(writes).toEqual(['snapshot', 'new']);
  });
});
