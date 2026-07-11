export interface SequencedOutput {
  seq: number;
  data: string;
}

export interface OutputSnapshot {
  seq: number;
  data: string;
}

export interface OutputWriteMeta {
  ack: boolean;
  render: boolean;
  snapshot: boolean;
}

type OutputWriter = (
  data: string,
  seq: number,
  onWritten: () => void,
  meta: OutputWriteMeta,
) => void;

export function createOutputSequencer(write: OutputWriter) {
  let snapshotReady = false;
  let lastAppliedSeq = 0;
  let pending: SequencedOutput[] = [];
  let writeQueue: Array<{ output: SequencedOutput; meta: OutputWriteMeta }> = [];
  let writing = false;
  let generation = 0;

  const drainWrites = () => {
    if (writing) return;
    const next = writeQueue.shift();
    if (!next) return;

    writing = true;
    const writeGeneration = generation;
    let completed = false;
    const onWritten = () => {
      if (completed) return;
      completed = true;
      if (writeGeneration !== generation) return;
      writing = false;
      drainWrites();
    };

    try {
      write(next.output.data, next.output.seq, onWritten, next.meta);
    } catch (error) {
      onWritten();
      throw error;
    }
  };

  const writeOutput = (output: SequencedOutput, meta: OutputWriteMeta) => {
    const normalizedMeta = {
      ...meta,
      render: meta.render && output.data.length > 0,
    };
    if (!normalizedMeta.render && !normalizedMeta.ack) return;
    writeQueue.push({ output, meta: normalizedMeta });
    drainWrites();
  };

  const flushPending = () => {
    pending.sort((left, right) => left.seq - right.seq);
    const nextPending = pending;
    pending = [];
    for (const item of nextPending) {
      if (item.seq <= lastAppliedSeq) {
        continue;
      }
      lastAppliedSeq = item.seq;
      writeOutput(item, { ack: true, render: true, snapshot: false });
    }
  };

  return {
    reset() {
      snapshotReady = false;
      lastAppliedSeq = 0;
      pending = [];
      writeQueue = [];
      writing = false;
      generation += 1;
    },

    applySnapshot(snapshot: OutputSnapshot) {
      if (!snapshotReady) {
        snapshotReady = true;
      }
      if (snapshot.seq > lastAppliedSeq) {
        lastAppliedSeq = snapshot.seq;
      }
      writeOutput(snapshot, {
        ack: snapshot.seq > 0,
        render: true,
        snapshot: true,
      });
      flushPending();
    },

    receive(output: SequencedOutput) {
      if (output.seq <= lastAppliedSeq) return;
      if (!snapshotReady) {
        pending.push(output);
        return;
      }
      lastAppliedSeq = output.seq;
      writeOutput(output, { ack: true, render: true, snapshot: false });
    },

    getLastAppliedSeq() {
      return lastAppliedSeq;
    },
  };
}
