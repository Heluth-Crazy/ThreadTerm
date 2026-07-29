import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  isTauriEnv,
  mobileBridge,
  mobileBridgeHasSubscribers,
} from '../../lib/tauri-bridge';
import type { TerminalCard } from '../../types/terminal';
import { cardToMobileMeta } from '../../mobile/bridge/cardMeta';
import {
  buildMobileWorkbenchProjection,
  notificationsToMobile,
  type MobileWorkbenchProjectionInput,
} from '../../mobile/bridge/workbenchProjection';

const MOBILE_SYNC_DEBOUNCE_MS = 100;
const MOBILE_SYNC_MAX_WAIT_MS = 1000;
const MOBILE_SUBSCRIBER_POLL_MS = 1000;

interface MobileWorkbenchModel {
  attentionItems: MobileWorkbenchProjectionInput['attentionItems'];
  followedCardIds: MobileWorkbenchProjectionInput['followedCardIds'];
  groups: MobileWorkbenchProjectionInput['groups'];
  notifications: Parameters<typeof notificationsToMobile>[0];
  now: MobileWorkbenchProjectionInput['generatedAt'];
  projectOverviews: MobileWorkbenchProjectionInput['projectOverviews'];
  rules: MobileWorkbenchProjectionInput['rules'];
  summary: MobileWorkbenchProjectionInput['summary'];
}

interface UseMobileWorkbenchSyncInput {
  cards: readonly TerminalCard[];
  mobileWorkbenchModel: MobileWorkbenchModel;
}

export function useMobileWorkbenchSync({
  cards,
  mobileWorkbenchModel,
}: UseMobileWorkbenchSyncInput): boolean {
  const [syncEnabled, setSyncEnabled] = useState(false);
  const [syncActive, setSyncActive] = useState(false);
  const lastPayloadRef = useRef('');
  const pendingSyncRef = useRef<{
    fingerprint: string;
    args: Parameters<typeof mobileBridge.syncState>;
  } | null>(null);
  const trailingTimerRef = useRef<number | null>(null);
  const maxWaitTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!isTauriEnv()) return;
    let cancelled = false;

    void import('@tauri-apps/api/window')
      .then(({ getCurrentWindow }) => {
        if (cancelled) return;
        setSyncEnabled(getCurrentWindow().label === 'main');
      })
      .catch(() => {
        if (!cancelled) setSyncEnabled(true);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const bridgeCards = useMemo(() => cards.map(cardToMobileMeta), [cards]);
  const bridgeNotifications = useMemo(
    () => notificationsToMobile(mobileWorkbenchModel.notifications),
    [mobileWorkbenchModel.notifications],
  );
  const workbenchProjection = useMemo(
    () =>
      buildMobileWorkbenchProjection({
        generatedAt: mobileWorkbenchModel.now,
        summary: mobileWorkbenchModel.summary,
        attentionItems: mobileWorkbenchModel.attentionItems,
        groups: mobileWorkbenchModel.groups,
        followedCardIds: mobileWorkbenchModel.followedCardIds,
        projectOverviews: mobileWorkbenchModel.projectOverviews,
        rules: mobileWorkbenchModel.rules,
      }),
    [
      mobileWorkbenchModel.attentionItems,
      mobileWorkbenchModel.groups,
      mobileWorkbenchModel.followedCardIds,
      mobileWorkbenchModel.now,
      mobileWorkbenchModel.projectOverviews,
      mobileWorkbenchModel.rules,
      mobileWorkbenchModel.summary,
    ],
  );

  const clearSyncTimers = useCallback(() => {
    if (trailingTimerRef.current !== null) {
      window.clearTimeout(trailingTimerRef.current);
      trailingTimerRef.current = null;
    }
    if (maxWaitTimerRef.current !== null) {
      window.clearTimeout(maxWaitTimerRef.current);
      maxWaitTimerRef.current = null;
    }
  }, []);

  const flushSync = useCallback(() => {
    clearSyncTimers();
    const pending = pendingSyncRef.current;
    pendingSyncRef.current = null;
    if (!pending || pending.fingerprint === lastPayloadRef.current) return;

    lastPayloadRef.current = pending.fingerprint;
    void mobileBridge.syncState(...pending.args).catch((error) => {
      console.warn('[MobileBridge] failed to sync state', error);
    });
  }, [clearSyncTimers]);

  useEffect(() => {
    if (!syncEnabled) {
      setSyncActive(false);
      return;
    }
    let cancelled = false;

    const refreshSubscriberState = async () => {
      try {
        const active = await mobileBridgeHasSubscribers();
        if (!cancelled) setSyncActive(active);
      } catch {
        if (!cancelled) setSyncActive(false);
      }
    };

    void refreshSubscriberState();
    const interval = window.setInterval(
      () => void refreshSubscriberState(),
      MOBILE_SUBSCRIBER_POLL_MS,
    );
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [syncEnabled]);

  useEffect(() => {
    if (!syncActive) {
      pendingSyncRef.current = null;
      clearSyncTimers();
      lastPayloadRef.current = '';
      return;
    }
    const fingerprint = JSON.stringify({
      cards: bridgeCards,
      notifications: bridgeNotifications,
      workbench: workbenchProjection,
    });
    if (fingerprint === lastPayloadRef.current) return;

    pendingSyncRef.current = {
      fingerprint,
      args: [bridgeCards, bridgeNotifications, workbenchProjection],
    };
    if (trailingTimerRef.current !== null) {
      window.clearTimeout(trailingTimerRef.current);
    }
    trailingTimerRef.current = window.setTimeout(
      flushSync,
      MOBILE_SYNC_DEBOUNCE_MS,
    );
    if (maxWaitTimerRef.current === null) {
      maxWaitTimerRef.current = window.setTimeout(
        flushSync,
        MOBILE_SYNC_MAX_WAIT_MS,
      );
    }
  }, [
    bridgeCards,
    bridgeNotifications,
    clearSyncTimers,
    flushSync,
    syncActive,
    workbenchProjection,
  ]);

  useEffect(
    () => () => {
      pendingSyncRef.current = null;
      clearSyncTimers();
    },
    [clearSyncTimers],
  );

  return syncEnabled;
}
