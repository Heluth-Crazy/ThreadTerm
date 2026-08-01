import { invoke, isTauriEnv } from './tauri-bridge';

export type DataDirectoryMode = 'legacy_split' | 'managed';

export type DataCategory = 'database' | 'desktop_state' | 'window_state';

export type DataMigrationPhase =
  | 'idle'
  | 'preflight'
  | 'scheduled'
  | 'copying_to_staging'
  | 'verifying'
  | 'pointer_switched'
  | 'first_launch_confirmed'
  | 'old_data_cleanup'
  | 'rollback_to_source';

export interface DataMigrationNotice {
  transactionId: string;
  targetRoot: string;
  phase: DataMigrationPhase;
  lastError: string | null;
}

export interface DataCategoryDiagnostic {
  category: DataCategory;
  paths: string[];
  bytes: number;
  fileCount: number;
  exists: boolean;
  measurable: boolean;
}

export interface DataDirectoryStatus {
  mode: DataDirectoryMode;
  root: string | null;
  applicationPath: string;
  recommendedRoot: string;
  bootstrapPointerPath: string;
  categories: DataCategoryDiagnostic[];
  totalBytes: number;
  platformNotes: string[];
  startupMigration: DataMigrationNotice | null;
}

export interface DataMigrationPreflight {
  targetRoot: string;
  sourceBytes: number;
  requiredBytes: number;
  availableBytes: number;
  warnings: string[];
}

export type DataPreflightErrorCode =
  | 'empty_path'
  | 'relative_path'
  | 'source_or_child'
  | 'application_directory'
  | 'mac_application_bundle'
  | 'file_target'
  | 'symbolic_link'
  | 'non_empty_target'
  | 'not_writable'
  | 'insufficient_space'
  | 'network_location'
  | 'source_unavailable'
  | 'source_symbolic_link'
  | 'input_output';

export interface DataPreflightError {
  code: DataPreflightErrorCode;
  message: string;
}

export interface DataMigrationStatus {
  transactionId: string;
  phase: DataMigrationPhase;
  sourceRoot: string | null;
  targetRoot: string;
  copiedBytes: number;
  totalBytes: number;
  retainSource: boolean;
  lastError: string | null;
  restartRequired: boolean;
  canCancel: boolean;
  canRollback: boolean;
  canCleanup: boolean;
}

export interface DataCacheCleanupStatus {
  supported: boolean;
  scheduled: boolean;
  restartRequired: boolean;
  bytes: number;
  paths: string[];
}

export const dataDirectory = {
  status: (): Promise<DataDirectoryStatus> =>
    invoke<DataDirectoryStatus>('data_directory_status'),

  migrationStatus: (): Promise<DataMigrationStatus | null> =>
    invoke<DataMigrationStatus | null>('data_migration_status'),

  preflight: (targetRoot: string): Promise<DataMigrationPreflight> =>
    invoke<DataMigrationPreflight>('data_migration_preflight', { targetRoot }),

  schedule: (targetRoot: string, retainSource: boolean): Promise<DataMigrationStatus> =>
    invoke<DataMigrationStatus>('data_migration_schedule', { targetRoot, retainSource }),

  cancel: (): Promise<void> => invoke<void>('data_migration_cancel'),

  confirm: (): Promise<DataMigrationStatus> =>
    invoke<DataMigrationStatus>('data_migration_confirm'),

  cleanupSource: (transactionId: string): Promise<DataMigrationStatus> =>
    invoke<DataMigrationStatus>('data_migration_cleanup_source', { transactionId }),

  requestRollback: (transactionId: string): Promise<DataMigrationStatus> =>
    invoke<DataMigrationStatus>('data_migration_request_rollback', { transactionId }),

  restart: (): Promise<void> => invoke<void>('data_migration_restart'),

  cacheCleanupStatus: (): Promise<DataCacheCleanupStatus> =>
    invoke<DataCacheCleanupStatus>('data_cache_cleanup_status'),

  scheduleCacheCleanup: (): Promise<DataCacheCleanupStatus> =>
    invoke<DataCacheCleanupStatus>('data_cache_cleanup_schedule'),

  cancelCacheCleanup: (): Promise<DataCacheCleanupStatus> =>
    invoke<DataCacheCleanupStatus>('data_cache_cleanup_cancel'),
};

export async function confirmDataMigrationAfterManagedStateLoad(): Promise<void> {
  if (!isTauriEnv()) return;

  const migration = await dataDirectory.migrationStatus();
  if (migration?.phase === 'pointer_switched') {
    await dataDirectory.confirm();
  }
}
