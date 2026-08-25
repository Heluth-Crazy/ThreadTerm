import { describe, expect, it } from 'vitest';
import {
  createPtyStartupReconciliation,
  PTY_STARTUP_RECONCILIATION_MAX_GENERATIONS,
  type PtyStartupCreateObservation,
} from './ptyStartupReconciliation';
import type {
  PtyCreateSessionV2Disposition,
  PtyStartupDescriptorDisposition,
  PtyStartupSnapshot,
} from '../../types/ptyStartup';

const snapshot = (
  generation: string,
  revision: number,
  state: PtyStartupSnapshot['state'] = 'waiting',
  ptyId = 'pty-1',
): PtyStartupSnapshot => ({ ptyId, generation, revision, state });

const create = (
  startup: PtyStartupSnapshot,
  disposition: PtyCreateSessionV2Disposition = 'created',
  descriptorDisposition: PtyStartupDescriptorDisposition = 'accepted',
): PtyStartupCreateObservation => ({
  ptyId: startup.ptyId, generation: startup.generation, startup, disposition, descriptorDisposition,
});

describe('PTY startup snapshot reconciliation', () => {
  it('buffers event-before-create and merges the highest same-generation revision', () => {
    const reconciler = createPtyStartupReconciliation();
    expect(reconciler.acceptEvent(snapshot('g1', 4, 'sent'))).toMatchObject({
      accepted: true, current: null, changed: false, bufferedGenerations: 1,
    });
    expect(reconciler.acceptCreate(create(snapshot('g1', 1)))).toMatchObject({
      accepted: true, changed: true, sent: true, needsQuery: true,
      current: snapshot('g1', 4, 'sent'),
    });
  });

  it('keeps the create snapshot authoritative over older events', () => {
    const reconciler = createPtyStartupReconciliation();
    expect(reconciler.acceptCreate(create(snapshot('g1', 3, 'ready'))).current?.revision).toBe(3);
    expect(reconciler.acceptEvent(snapshot('g1', 2, 'waiting'))).toMatchObject({
      accepted: false, changed: false, current: snapshot('g1', 3, 'ready'),
    });
  });

  it('flags a live revision gap and accepts a query without switching generations', () => {
    const reconciler = createPtyStartupReconciliation();
    reconciler.acceptCreate(create(snapshot('g1', 1)));
    expect(reconciler.acceptEvent(snapshot('g1', 3, 'ready'))).toMatchObject({
      accepted: true, changed: true, needsQuery: true,
    });
    expect(reconciler.acceptQuery('g1', snapshot('g1', 3, 'ready'))).toMatchObject({
      accepted: false, changed: false, current: snapshot('g1', 3, 'ready'),
    });
    expect(reconciler.acceptQuery('g0', null)).toMatchObject({
      accepted: false, changed: false, current: snapshot('g1', 3, 'ready'),
    });
  });

  it('buffers other generations until create selects one, then discards the old one', () => {
    const reconciler = createPtyStartupReconciliation();
    reconciler.acceptCreate(create(snapshot('g1', 1)));
    expect(reconciler.acceptEvent(snapshot('g2', 2, 'sent'))).toMatchObject({
      accepted: true, changed: false, current: snapshot('g1', 1),
    });
    expect(reconciler.acceptCreate(create(snapshot('g2', 0)))).toMatchObject({
      accepted: true, changed: true, sent: true, current: snapshot('g2', 2, 'sent'),
      bufferedGenerations: 0,
    });
    expect(reconciler.acceptEvent(snapshot('g1', 2, 'failed'))).toMatchObject({
      accepted: false, changed: false, sent: false, current: snapshot('g2', 2, 'sent'),
    });
  });

  it('caps pre-create generation buffering', () => {
    const reconciler = createPtyStartupReconciliation();
    for (let index = 0; index < PTY_STARTUP_RECONCILIATION_MAX_GENERATIONS + 2; index += 1) {
      reconciler.acceptEvent(snapshot(`g${index}`, 1));
    }
    expect(reconciler.acceptEvent(snapshot('g-last', 1)).bufferedGenerations)
      .toBe(PTY_STARTUP_RECONCILIATION_MAX_GENERATIONS);
  });

  it('emits presentation sent once per observer/generation across reset', () => {
    const reconciler = createPtyStartupReconciliation();
    reconciler.acceptCreate(create(snapshot('g1', 0)));
    expect(reconciler.acceptEvent(snapshot('g1', 1, 'sent')).sent).toBe(true);
    reconciler.reset();
    expect(reconciler.acceptCreate(create(snapshot('g1', 1, 'sent'))).sent).toBe(false);
    expect(reconciler.acceptCreate(create(snapshot('g2', 0, 'sent'))).sent).toBe(true);
  });

  it.each([
    ['created', 'accepted'],
    ['attached', 'legacyClaimed'],
  ] as const)('allows %s/%s to present a sent create snapshot', (disposition, descriptor) => {
    const reconciler = createPtyStartupReconciliation();
    expect(reconciler.acceptCreate(create(snapshot('g-present', 0, 'sent'), disposition, descriptor)))
      .toMatchObject({ accepted: true, changed: true, sent: true });
  });

  it.each(['matched', 'notApplicable'] as const)('skips attached/%s sent presentation', (descriptor) => {
    const reconciler = createPtyStartupReconciliation();
    expect(reconciler.acceptCreate(create(snapshot('g-attach', 0, 'sent'), 'attached', descriptor)))
      .toMatchObject({ accepted: true, changed: true, sent: false });
    expect(reconciler.acceptEvent(snapshot('g-attach', 1, 'sent')).sent).toBe(false);
  });

  it('lets a later live sent event present after an attached non-sent snapshot', () => {
    const reconciler = createPtyStartupReconciliation();
    expect(reconciler.acceptCreate(create(snapshot('g-live', 0), 'attached', 'matched')).sent)
      .toBe(false);
    expect(reconciler.acceptEvent(snapshot('g-live', 1, 'sent')).sent).toBe(true);
  });

  it('retires old generations and keeps sent history after more than four switches', () => {
    const reconciler = createPtyStartupReconciliation();
    reconciler.acceptCreate(create(snapshot('g0', 0)));
    expect(reconciler.acceptEvent(snapshot('g0', 1, 'sent')).sent).toBe(true);
    for (let index = 1; index <= 5; index += 1) {
      const generation = `g${index}`;
      reconciler.acceptCreate(create(snapshot(generation, 0)));
      expect(reconciler.acceptEvent(snapshot(generation, 1, 'sent')).sent).toBe(true);
    }
    const stale = snapshot('g0', 9, 'sent');
    expect(reconciler.acceptEvent(stale)).toMatchObject({
      accepted: false, changed: false, sent: false, current: snapshot('g5', 1, 'sent'),
    });
    expect(reconciler.acceptCreate(create(stale))).toMatchObject({
      accepted: false, changed: false, sent: false, current: snapshot('g5', 1, 'sent'),
    });
    expect(reconciler.acceptQuery('g0', stale).accepted).toBe(false);
  });

  it('rejects snapshots with an unknown trigger without buffering them', () => {
    const reconciler = createPtyStartupReconciliation();
    const invalid = { ...snapshot('bad', 1), trigger: 'unknown' } as unknown as PtyStartupSnapshot;
    expect(reconciler.acceptEvent(invalid)).toMatchObject({
      accepted: false, changed: false, current: null, bufferedGenerations: 0,
    });
    expect(reconciler.acceptCreate(create(invalid))).toMatchObject({
      accepted: false, changed: false, current: null,
    });
  });

  it('retains cancelled and failed terminal snapshots monotonically', () => {
    const reconciler = createPtyStartupReconciliation();
    reconciler.acceptCreate(create(snapshot('g1', 0)));
    expect(reconciler.acceptEvent(snapshot('g1', 1, 'cancelled')).current?.state).toBe('cancelled');
    expect(reconciler.acceptEvent(snapshot('g1', 2, 'failed')).current?.state).toBe('failed');
    expect(reconciler.acceptQuery('g1', null)).toMatchObject({
      accepted: false, changed: false, current: snapshot('g1', 2, 'failed'),
    });
  });
});
