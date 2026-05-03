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

  const writeOutput = (output: SequencedOutput, ack: boolean, render: boolean) => {
    if (!output.data && render) return;
    write(output.data, output.seq, () => {}, { ack, render });
  };

  const flushPending = () => {
    pending.sort((left, right) => left.seq - right.seq);
    const nextPending = pending;
    pending = [];
    for (const item of nextPending) {
      if (item.seq <= lastAppliedSeq) {
        writeOutput(item, true, false);
        continue;
      }
      lastAppliedSeq = item.seq;
      writeOutput(item, true, true);
    }
  };

  return {
    reset() {
      snapshotReady = false;
      lastAppliedSeq = 0;
      pending = [];
    },

    applySnapshot(snapshot: OutputSnapshot) {
      if (!snapshotReady) {
        snapshotReady = true;
      }
      if (snapshot.seq > lastAppliedSeq) {
        lastAppliedSeq = snapshot.seq;
      }
      writeOutput(snapshot, false, true);
      flushPending();
    },

    receive(output: SequencedOutput) {
      if (output.seq <= lastAppliedSeq) return;
      if (!snapshotReady) {
        pending.push(output);
        return;
      }
      lastAppliedSeq = output.seq;
      writeOutput(output, true, true);
    },

    getLastAppliedSeq() {
      return lastAppliedSeq;
    },
  };
}
