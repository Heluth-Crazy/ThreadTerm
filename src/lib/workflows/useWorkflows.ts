/**
 * useWorkflows — React glue between `loadAllWorkflows` and the rest of the app.
 *
 * Reads the focused project from `terminalStore`, re-discovers when it changes,
 * pipes parse / read / size / duplicate-name errors into the Notification
 * Centre exactly once per `(filePath, reason)` so a re-discovery loop never
 * spams the user.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useTerminalStore } from '../../stores/terminalStore';
import { loadAllWorkflows } from './tauriFs';
import type {
  DiscoveredWorkflow,
  DiscoveryError,
  DiscoveryErrorReason,
} from './discoverWorkflows';

export interface UseWorkflowsState {
  workflows: DiscoveredWorkflow[];
  errors: DiscoveryError[];
  loading: boolean;
  reload: () => void;
}

const I18N_KEY_BY_REASON: Record<DiscoveryErrorReason, string> = {
  'parse-failed': 'workflow.parseFailed',
  'duplicate-name': 'workflow.duplicateName',
  'too-large': 'workflow.fileTooLarge',
  'read-failed': 'workflow.readFailed',
};

const NOTIFICATION_CARD_ID = 'system:workflows';

function errorKey(err: DiscoveryError): string {
  return `${err.filePath}::${err.reason}`;
}

export function useWorkflows(): UseWorkflowsState {
  const { t } = useTranslation('terminal');
  const focusedProjectCwd = useTerminalStore((s) => {
    if (s.selectedProjectPath) return s.selectedProjectPath;
    const focused = s.focusedCardId
      ? s.cards.find((card) => card.id === s.focusedCardId)
      : undefined;
    return focused?.projectPath ?? null;
  });
  const pushNotification = useTerminalStore((s) => s.pushNotification);

  const [workflows, setWorkflows] = useState<DiscoveredWorkflow[]>([]);
  const [errors, setErrors] = useState<DiscoveryError[]>([]);
  const [loading, setLoading] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  // Set of (filePath, reason) tuples we've already surfaced — prevents the
  // Notification Centre from being spammed each time the user toggles focus
  // between projects.
  const reportedRef = useRef<Set<string>>(new Set());

  const reload = useCallback(() => setReloadToken((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    loadAllWorkflows(focusedProjectCwd ?? null)
      .then((result) => {
        if (cancelled) return;
        setWorkflows(result.workflows);
        setErrors(result.errors);
        for (const err of result.errors) {
          const key = errorKey(err);
          if (reportedRef.current.has(key)) continue;
          reportedRef.current.add(key);
          const i18nKey = I18N_KEY_BY_REASON[err.reason];
          pushNotification({
            cardId: NOTIFICATION_CARD_ID,
            kind: 'failed',
            title: t(i18nKey, { defaultValue: err.reason }),
            body: `${err.filePath}: ${err.message}`,
          });
        }
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        // A catastrophic failure (e.g. plugin not registered) — surface once
        // and clear results so callers don't show stale data.
        const message = e instanceof Error ? e.message : String(e);
        setWorkflows([]);
        setErrors([
          {
            source: 'global',
            filePath: '<discoverWorkflows>',
            reason: 'read-failed',
            message,
          },
        ]);
        const key = `<discoverWorkflows>::${message}`;
        if (!reportedRef.current.has(key)) {
          reportedRef.current.add(key);
          pushNotification({
            cardId: NOTIFICATION_CARD_ID,
            kind: 'failed',
            title: t('workflow.readFailed', { defaultValue: 'Workflow read failed' }),
            body: message,
          });
        }
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [focusedProjectCwd, reloadToken, pushNotification, t]);

  return useMemo(
    () => ({ workflows, errors, loading, reload }),
    [workflows, errors, loading, reload],
  );
}
