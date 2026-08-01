import { useCallback, useEffect, useState, type ReactNode } from 'react';
import i18n from '../i18n/config';
import {
  getPreloadedManagedStateItem,
  MANAGED_STATE_KEYS,
  preloadManagedState,
} from '../lib/managedState';
import { confirmDataMigrationAfterManagedStateLoad } from '../lib/dataDirectory';
import { isTauriEnv } from '../lib/tauri-bridge';
import { useOverlayStore } from '../stores/overlayStore';
import { useTerminalStore } from '../stores/terminalStore';
import { useWorkbenchStore } from '../stores/workbenchStore';

let initialization: Promise<void> | null = null;

async function initializeManagedUiState(): Promise<void> {
  await preloadManagedState(Object.values(MANAGED_STATE_KEYS));

  const language = getPreloadedManagedStateItem(MANAGED_STATE_KEYS.language);
  if (language && i18n.language !== language) {
    await i18n.changeLanguage(language);
  }

  await Promise.all([
    useTerminalStore.persist.rehydrate(),
    useWorkbenchStore.persist.rehydrate(),
    useOverlayStore.persist.rehydrate(),
  ]);

  await confirmDataMigrationAfterManagedStateLoad();
}

function initializeOnce(): Promise<void> {
  if (!initialization) {
    initialization = initializeManagedUiState().catch((error) => {
      initialization = null;
      throw error;
    });
  }
  return initialization;
}

export function ManagedStateBootstrap({ children }: { children: ReactNode }) {
  const desktop = isTauriEnv();
  const [ready, setReady] = useState(!desktop);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!desktop) return undefined;
    let disposed = false;
    setReady(false);
    setError(null);
    void initializeOnce()
      .then(() => {
        if (!disposed) setReady(true);
      })
      .catch((reason) => {
        if (!disposed) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      });
    return () => {
      disposed = true;
    };
  }, [attempt, desktop]);

  const retry = useCallback(() => {
    initialization = null;
    setAttempt((value) => value + 1);
  }, []);

  if (ready) return children;

  return (
    <main className="flex h-screen w-screen items-center justify-center bg-background px-6 text-foreground">
      <section className="w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-lg">
        <h1 className="text-base font-semibold">
          {error ? '无法读取 ThreadTerm 数据' : '正在读取 ThreadTerm 数据…'}
        </h1>
        {error ? (
          <>
            <p className="mt-2 text-sm text-muted-foreground">
              应用没有进入空白工作台。请确认数据磁盘可用后重试。
            </p>
            <pre className="mt-4 max-h-28 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 text-xs text-muted-foreground">
              {error}
            </pre>
            <button
              type="button"
              className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
              onClick={retry}
            >
              重试
            </button>
          </>
        ) : (
          <div
            className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-muted"
            aria-label="正在读取 ThreadTerm 数据"
          >
            <div className="h-full w-1/2 animate-pulse rounded-full bg-primary" />
          </div>
        )}
      </section>
    </main>
  );
}

export function resetManagedStateBootstrapForTests(): void {
  initialization = null;
}
