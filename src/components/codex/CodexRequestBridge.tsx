import { useEffect } from 'react';
import i18n from '../../i18n/config';
import { logger } from '../../lib/logger';
import {
  classifyCodexRequest,
  resolveCodexRequestCardId,
  summarizeCodexRequest,
} from '../../lib/codexApp/pendingRequest';
import { codexApp, isTauriEnv } from '../../lib/tauri-bridge';
import {
  buildInteractionEpisodeKey,
  normalizeNotificationFingerprint,
} from '../../lib/osNotificationPolicy';
import { useCodexRequestStore } from '../../stores/codexRequestStore';
import { useTerminalStore } from '../../stores/terminalStore';

export function CodexRequestBridge() {
  useEffect(() => {
    if (!isTauriEnv()) return;

    let disposed = false;
    const listeners: Array<{ name: string; unlisten: () => void }> = [];

    const disposeListener = (name: string, unlisten: () => void) => {
      try {
        unlisten();
      } catch (error) {
        logger.warn(`[CodexRequestBridge] failed to unlisten ${name}`, error);
      }
    };

    const registerListener = (name: string, registration: Promise<() => void>) => {
      void registration
        .then((unlisten) => {
          if (disposed) {
            disposeListener(name, unlisten);
            return;
          }
          listeners.push({ name, unlisten });
        })
        .catch((error) => {
          logger.warn(`[CodexRequestBridge] failed to listen for ${name}`, error);
        });
    };

    registerListener(
      'request',
      codexApp.onRequest((payload) => {
        if (disposed) return;
        const terminalState = useTerminalStore.getState();
        const cardId = resolveCodexRequestCardId(payload, terminalState.cards);
        if (!cardId) {
          logger.warn('[CodexRequestBridge] ignored request without a resolvable card', {
            method: payload.method,
          });
          return;
        }

        const request = useCodexRequestStore
          .getState()
          .ingestRequest(payload, cardId);
        if (!request) return;

        const kind = classifyCodexRequest(payload.method);
        const card = terminalState.cards.find((candidate) => candidate.id === cardId);
        const notification = terminalState.pushNotification({
          cardId,
          kind: 'attention',
          title: i18n.t(
            kind === 'approval'
              ? 'terminal:workbench.notifications.approvalTitle'
              : 'terminal:workbench.notifications.inputTitle',
            {
              defaultValue:
                kind === 'approval'
                  ? 'Codex needs approval'
                  : 'Codex needs your input',
            },
          ),
          body:
            summarizeCodexRequest(payload.params) ||
            i18n.t('terminal:workbench.notifications.openRequest', {
              defaultValue: 'Open the Codex session to review this request.',
            }),
          routing: {
            origin: 'codex_request',
            family: 'interaction',
            episodeKey: buildInteractionEpisodeKey(
              cardId,
              card?.messageCount ?? 0,
            ),
            fingerprint: normalizeNotificationFingerprint(request.key),
          },
        });
        useCodexRequestStore
          .getState()
          .attachNotification(request.key, notification.id);
      }),
    );

    registerListener(
      'disconnect',
      codexApp.onDisconnected((payload) => {
        if (disposed) return;
        const pending = useCodexRequestStore.getState().requests;
        const removeNotification = useTerminalStore.getState().removeNotification;
        for (const request of pending) {
          if (request.notificationId) removeNotification(request.notificationId);
        }
        useCodexRequestStore.getState().recordDisconnected(payload.message);
      }),
    );

    return () => {
      disposed = true;
      for (const listener of listeners.splice(0)) {
        disposeListener(listener.name, listener.unlisten);
      }
    };
  }, []);

  return null;
}
