export interface OutputIdentity {
  runtimeId: string;
  handle: string;
  streamId: string;
  attachId: string;
}

export type SequenceDecision = 'accept' | 'ignore' | 'resync';

/**
 * A stream/attachment pair is one renderer epoch.  Old events must not be
 * allowed to paint after attach or resync moves the renderer to a new epoch.
 */
export class OutputSequenceGuard {
  private identity: OutputIdentity | null = null;
  private throughSeq = 0;

  beginEpoch(identity: OutputIdentity, barrierSeq: number): void {
    this.identity = identity;
    this.throughSeq = barrierSeq;
  }

  matches(identity: OutputIdentity): boolean {
    return this.identity !== null && sameIdentity(this.identity, identity);
  }

  decide(identity: OutputIdentity, seq: number): SequenceDecision {
    if (!this.identity || !sameIdentity(this.identity, identity) || !Number.isSafeInteger(seq)) {
      return 'ignore';
    }
    if (seq <= this.throughSeq) return 'ignore';
    if (seq !== this.throughSeq + 1) return 'resync';
    this.throughSeq = seq;
    return 'accept';
  }

  get acknowledgedThrough(): number {
    return this.throughSeq;
  }
}

export function sameIdentity(left: OutputIdentity, right: OutputIdentity): boolean {
  return left.runtimeId === right.runtimeId
    && left.handle === right.handle
    && left.streamId === right.streamId
    && left.attachId === right.attachId;
}
