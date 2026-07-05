/**
 * 自动重启 slice —— 每张卡片的自动重启状态机。
 *
 * 所有 action 都经共享 `set`/`get` 修改 cards slice 上的 `cards[idx].autoRestart`；
 * 本文件不持有卡片状态，只有状态迁移逻辑。
 */
import {
  cancelPendingAutoRestart,
  clampAutoRestartMaxRetries,
  createAutoRestartDecision,
  markAutoRestartStarted,
  normalizeAutoRestartConfig,
} from '../../lib/autoRestart';
import i18n from '../../i18n/config';
import { appendEvent } from './helpers';
import type { AutoRestartSlice, TerminalSliceCreator } from './types';

export const createAutoRestartSlice: TerminalSliceCreator<AutoRestartSlice> = (set, get) => ({
  setCardAutoRestartEnabled: (id, enabled) =>
    set((state) => {
      const idx = state.cards.findIndex((c) => c.id === id);
      if (idx === -1) return state;
      const cards = [...state.cards];
      const existing = cards[idx];
      const current = normalizeAutoRestartConfig(existing.autoRestart);
      const next = enabled
        ? { ...current, enabled: true }
        : { ...cancelPendingAutoRestart(current, Date.now()), enabled: false };
      cards[idx] = { ...existing, autoRestart: next };
      return { cards };
    }),

  setCardAutoRestartMaxRetries: (id, maxRetries) =>
    set((state) => {
      const idx = state.cards.findIndex((c) => c.id === id);
      if (idx === -1) return state;
      const cards = [...state.cards];
      const existing = cards[idx];
      cards[idx] = {
        ...existing,
        autoRestart: {
          ...normalizeAutoRestartConfig(existing.autoRestart),
          maxRetries: clampAutoRestartMaxRetries(maxRetries),
        },
      };
      return { cards };
    }),

  scheduleCardAutoRestart: (id, input) => {
    const card = get().cards.find((candidate) => candidate.id === id);
    if (!card) return null;
    const decision = createAutoRestartDecision(card.autoRestart, {
      exitCode: input.exitCode,
      now: input.now ?? Date.now(),
    });
    if (decision.kind === 'ignored' && !card.autoRestart && !decision.config.enabled) {
      return decision;
    }
    set((state) => {
      const idx = state.cards.findIndex((candidate) => candidate.id === id);
      if (idx === -1) return state;
      const cards = [...state.cards];
      cards[idx] = {
        ...cards[idx],
        autoRestart: decision.config,
      };
      return { cards };
    });
    return decision;
  },

  startCardAutoRestart: (id, input) => {
    const now = input.now ?? Date.now();
    const nextPtyId = `${id}-retry-${input.attempt}-${now.toString(36)}`;
    let started = false;
    set((state) => {
      const idx = state.cards.findIndex((candidate) => candidate.id === id);
      if (idx === -1) return state;
      const cards = [...state.cards];
      const existing = cards[idx];
      cards[idx] = appendEvent(
        {
          ...existing,
          ptyId: nextPtyId,
          status: 'idle',
          lastActivity: now,
          autoRestart: markAutoRestartStarted(existing.autoRestart, {
            attempt: input.attempt,
            now,
          }),
        },
        {
          at: now,
          kind: 'status',
          summary: i18n.t('terminal:events.autoRestartStarted', {
            attempt: input.attempt,
          }),
        },
      );
      started = true;
      return { cards };
    });
    return started ? nextPtyId : null;
  },

  cancelCardAutoRestart: (id, now = Date.now()) =>
    set((state) => {
      const idx = state.cards.findIndex((candidate) => candidate.id === id);
      if (idx === -1) return state;
      const cards = [...state.cards];
      const existing = cards[idx];
      cards[idx] = {
        ...existing,
        autoRestart: cancelPendingAutoRestart(existing.autoRestart, now),
      };
      return { cards };
    }),
});
