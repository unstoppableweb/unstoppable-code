/*
 * The memory sync contract between desktop replicas and Canopy Cloud
 * (`/api/v1/memory-sync/*`). Every number here is explained in
 * docs/planning/2026-10-27-cloud-memory-sync/README.md.
 */

export const MEMORY_SYNC_CAPABILITY = 'memory-sync-v1';

export const MEMORY_SYNC_PROTOCOL_VERSION = 1;

export const MEMORY_SYNC_PROTOCOL_HEADER = 'X-Canopy-Memory-Sync-Version';

export const MEMORY_SYNC_ACCOUNT_HEADER = 'X-Canopy-Memory-Account';

export const MEMORY_SYNC_DEVICE_SESSION_HEADER =
  'X-Canopy-Memory-Device-Session';

export const MEMORY_SYNC_REALTIME_EVENT_TYPE = 'memory.scope';

export const MEMORY_SYNC_API_PREFIX = '/api/v1/memory-sync';

function scopePath(scopeId: string): string {
  return `${MEMORY_SYNC_API_PREFIX}/scopes/${scopeId}`;
}

export const MEMORY_SYNC_ROUTES = {
  settings: (): string => `${MEMORY_SYNC_API_PREFIX}/settings`,
  projectSettings: (): string => `${MEMORY_SYNC_API_PREFIX}/settings/projects`,
  projectSetting: (projectId: string): string =>
    `${MEMORY_SYNC_API_PREFIX}/settings/projects/${projectId}`,
  deviceRegister: (): string => `${MEMORY_SYNC_API_PREFIX}/devices/register`,
  scopes: (): string => `${MEMORY_SYNC_API_PREFIX}/scopes`,
  scopeResolve: (): string => `${MEMORY_SYNC_API_PREFIX}/scopes/resolve`,
  scope: (scopeId: string): string => scopePath(scopeId),
  snapshot: (scopeId: string): string => `${scopePath(scopeId)}/snapshot`,
  changes: (scopeId: string): string => `${scopePath(scopeId)}/changes`,
  notes: (scopeId: string): string => `${scopePath(scopeId)}/notes`,
  leaseAcquire: (scopeId: string): string =>
    `${scopePath(scopeId)}/lease/acquire`,
  leaseRenew: (scopeId: string): string => `${scopePath(scopeId)}/lease/renew`,
  leaseRelease: (scopeId: string): string =>
    `${scopePath(scopeId)}/lease/release`,
  commits: (scopeId: string): string => `${scopePath(scopeId)}/commits`,
  revisions: (scopeId: string): string => `${scopePath(scopeId)}/revisions`,
  revisionDocuments: (scopeId: string, revision: number): string =>
    `${scopePath(scopeId)}/revisions/${revision}/documents`,
  restore: (scopeId: string): string => `${scopePath(scopeId)}/restore`,
  usage: (scopeId: string): string => `${scopePath(scopeId)}/usage`,
  exportScope: (scopeId: string): string => `${scopePath(scopeId)}/export`,
  purge: (): string => `${MEMORY_SYNC_API_PREFIX}/purge`,
  stream: (): string => `${MEMORY_SYNC_API_PREFIX}/stream`,
} as const;

const DOCUMENT_MAX_BYTES = 512 * 1024;
const FILE_NAME_MAX_BYTES = 200;
const TOPIC_DOCUMENTS_PER_SCOPE_MAX = 500;
const PENDING_NOTES_PER_SCOPE_MAX = 5_000;
const DOCUMENT_PATH_MAX_BYTES = 'topics/'.length + FILE_NAME_MAX_BYTES;
// Every topic and MEMORY.md deleted and put again, so a restore across
// renames always fits one revision.
const COMMIT_CHANGES_MAX = 2 * (TOPIC_DOCUMENTS_PER_SCOPE_MAX + 1);
const COMMIT_REQUEST_MAX_BYTES = 16 * 1024 * 1024;
const CHANGES_PAGE_ENVELOPE_MAX_BYTES = 1024;
const CHANGED_PATHS_MAX_BYTES =
  COMMIT_CHANGES_MAX * (DOCUMENT_PATH_MAX_BYTES + '"",'.length);
const REVISION_ENTRY_OVERHEAD_MAX_BYTES = CHANGED_PATHS_MAX_BYTES + 64 * 1024;

export const MEMORY_SYNC_LIMITS = {
  noteBodyMaxBytes: 256 * 1024,
  importNoteBodyMaxBytes: DOCUMENT_MAX_BYTES,
  inboxNoteMaxChars: 2_000,
  documentMaxBytes: DOCUMENT_MAX_BYTES,
  memoryIndexMaxLines: 200,
  memoryIndexMaxBytes: 25 * 1024,
  fileNameMaxBytes: FILE_NAME_MAX_BYTES,
  topicDocumentsPerScopeMax: TOPIC_DOCUMENTS_PER_SCOPE_MAX,
  pendingNotesPerScopeMax: PENDING_NOTES_PER_SCOPE_MAX,
  pushOpsMax: 100,
  pushRequestMaxBytes: 4 * 1024 * 1024,
  commitChangesMax: COMMIT_CHANGES_MAX,
  commitConsumedNotesMax: 5_000,
  commitRequestMaxBytes: COMMIT_REQUEST_MAX_BYTES,
  requestMaxBytes: 64 * 1024,
  changesPageMax: 200,
  changesPageTargetBytes: 4 * 1024 * 1024,
  changesPageEnvelopeMaxBytes: CHANGES_PAGE_ENVELOPE_MAX_BYTES,
  revisionEntryOverheadMaxBytes: REVISION_ENTRY_OVERHEAD_MAX_BYTES,
  changesPageHardMaxBytes:
    COMMIT_REQUEST_MAX_BYTES +
    CHANGES_PAGE_ENVELOPE_MAX_BYTES +
    REVISION_ENTRY_OVERHEAD_MAX_BYTES,
  snapshotPageMaxBytes: 4 * 1024 * 1024,
  historyPageMax: 50,
  usageDeltasMax: 500,
  usageDeltaUsesMax: 10_000,
  deviceLabelMaxChars: 256,
  sourceFieldMaxChars: 500,
  messageMaxChars: 512,
  cursorMaxLength: 128,
  pageTokenMaxLength: 1_024,
  blockedOrganizationsMax: 500,
} as const;

export const MEMORY_SYNC_TIMINGS = {
  leaseTtlMs: 90_000,
  leaseRenewIntervalMs: 30_000,
  leaseMaxHoldMs: 40 * 60_000,
  desktopIdleDebounceMs: 5 * 60_000,
  consolidationMinIntervalMs: 60 * 60_000,
  cloudBackstopPendingAgeMs: 60 * 60_000,
  pullFallbackIntervalMs: 5 * 60_000,
  pushDebounceMs: 2_000,
  launchQuietMs: 15_000,
  retryBaseMs: 1_000,
  retryMaxMs: 60_000,
  serverRetryAfterMaxMs: 10 * 60_000,
  localLockStaleMs: 30_000,
  localLockHeartbeatMs: 5_000,
} as const;

export const MEMORY_SYNC_RETENTION = {
  revisionsKept: 100,
  historyDays: 180,
  removedNoteDays: 180,
} as const;

export const MEMORY_SYNC_QUOTAS = {
  noteOpsPerScopePerHour: 1_000,
  writeRequestsPerDevicePerMinute: 120,
  scopesPerAccount: 1_000,
  devicesPerAccount: 50,
  scopeStoredBytesMax: 64 * 1024 * 1024,
  // A usage counter names a current document or a pending note, so a scope
  // never needs more keys than every topic, MEMORY.md and its pending notes.
  usageKeysPerScopeMax:
    TOPIC_DOCUMENTS_PER_SCOPE_MAX + 1 + PENDING_NOTES_PER_SCOPE_MAX,
} as const;
