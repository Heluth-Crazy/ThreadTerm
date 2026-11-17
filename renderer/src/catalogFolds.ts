import { useSyncExternalStore } from 'react';
import { CATALOG_FOLD_KEY, readCatalogFolds, writeCatalogFolds } from './catalogTidy';

/*
 * One fold state for every sidebar tree in this window (this computer's catalog and other computers' trees), saved
 * under one key. Each tree holding its own copy made them overwrite each other's saved folds.
 */
type Folds = Record<string, boolean>;
let folds: Folds | undefined;
const listeners = new Set<() => void>();

function snapshot(): Folds {
  if (!folds) {
    try { folds = readCatalogFolds(localStorage.getItem(CATALOG_FOLD_KEY)); } catch { folds = {}; }
  }
  return folds;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Applies a change to the shared folds, saves it, and re-renders every tree that reads them. */
export function updateCatalogFolds(update: (current: Folds) => Folds): void {
  const next = update(snapshot());
  if (next === folds) return;
  folds = next;
  try { localStorage.setItem(CATALOG_FOLD_KEY, writeCatalogFolds(next)); } catch { /* Folding still works in this window. */ }
  listeners.forEach(listener => listener());
}

export function useCatalogFolds(): Folds {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
