import type {
  ListDismissedSharedContainersResult,
  RestoreSharedContainerResult,
  SharedContainerAccessBlockReason,
  SharedContainerInboxChangedEvent,
  SharedContainerSyncPhaseEvent,
  SharedContainerPublicationErrorReason,
  SharedContainerPublicationState,
  SharedContainerPublicationStatus,
  SharedContainerReplicaBroadcast,
  SharedContainerReplicaPurge,
  SharedContainerReplicaState,
} from '@canopy/desktop-shared/types';
import { SHARED_CONTAINER_SYNC_PHASES } from '@canopy/desktop-shared/types';
import {
  SHARED_CONTAINER_TYPES,
  isListDismissedSharedContainersResponse,
  isSharedContainerRevisionPackage,
  isSharedContainerSummary,
} from '@canopy/protocol/shared-containers';

const ACCESS_BLOCK_REASONS: readonly SharedContainerAccessBlockReason[] = [
  'unsupported-remote-host',
  'github-not-connected',
  'repository-access-missing',
  'commit-unavailable',
  'lfs-unsupported',
  'symlink-unsupported',
  'git-credentials-missing',
];

const PUBLICATION_STATUSES: readonly SharedContainerPublicationStatus[] = [
  'not-published',
  'publishing',
  'published',
  'error',
];

const PUBLICATION_ERROR_REASONS: readonly SharedContainerPublicationErrorReason[] =
  [
    'unpushed-head',
    'git-lfs',
    'undisclosable-repository',
    'artifact-budget',
    'submodule',
    'symlink',
  ];

const BASE_KEYS: readonly string[] = [
  'containerId',
  'organizationId',
  'access',
  'containerType',
  'updatedAt',
  'status',
];

const REVISION_KEYS: readonly string[] = [
  ...BASE_KEYS,
  'revisionId',
  'revision',
  'revisionCreatedAt',
  'withheldFileCount',
  'withheldFileReasons',
  'package',
];

const BLOCKED_KEYS: readonly string[] = [
  ...BASE_KEYS,
  'reason',
  'message',
  'repository',
];

const PURGE_ALL_KEYS: readonly string[] = ['purged'];

const PURGE_CONTAINER_KEYS: readonly string[] = ['purged', 'containerId'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reject any payload carrying a field the state contract does not declare.
 *
 * This is the renderer-facing half of the CAN-2549 boundary rule that no signed
 * URL, object key, ciphertext, or `dataKey` ever crosses IPC: an extra property
 * on a broadcast is dropped here rather than handed to the renderer.
 */
function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function hasValidBase(value: Record<string, unknown>): boolean {
  return (
    typeof value.containerId === 'string' &&
    value.containerId.length > 0 &&
    // Absent for a personal container shared directly.
    (value.organizationId === undefined ||
      (typeof value.organizationId === 'string' &&
        value.organizationId.length > 0)) &&
    // Absent on organization shares (the legacy shape).
    (value.access === undefined ||
      value.access === 'organization' ||
      value.access === 'direct') &&
    typeof value.containerType === 'string' &&
    SHARED_CONTAINER_TYPES.some((type) => type === value.containerType) &&
    typeof value.updatedAt === 'string' &&
    value.updatedAt.length > 0
  );
}

export function isSharedContainerReplicaState(
  value: unknown,
): value is SharedContainerReplicaState {
  if (!isRecord(value) || !hasValidBase(value)) {
    return false;
  }
  switch (value.status) {
    case 'nothing-published':
      return hasOnlyKeys(value, BASE_KEYS);
    case 'available':
    case 'pinned':
      return (
        hasOnlyKeys(value, REVISION_KEYS) &&
        typeof value.revisionId === 'string' &&
        value.revisionId.length > 0 &&
        typeof value.revision === 'number' &&
        Number.isSafeInteger(value.revision) &&
        typeof value.revisionCreatedAt === 'string' &&
        (value.withheldFileCount === undefined ||
          (typeof value.withheldFileCount === 'number' &&
            Number.isSafeInteger(value.withheldFileCount) &&
            value.withheldFileCount >= 0)) &&
        (value.withheldFileReasons === undefined ||
          (Array.isArray(value.withheldFileReasons) &&
            value.withheldFileReasons.every(
              (reason) =>
                reason === 'credential-shaped' ||
                reason === 'undisclosed-repo' ||
                reason === 'oversized' ||
                reason === 'symlink-escaping',
            ))) &&
        (value.package === undefined ||
          isSharedContainerRevisionPackage(value.package))
      );
    case 'blocked':
      return (
        hasOnlyKeys(value, BLOCKED_KEYS) &&
        typeof value.reason === 'string' &&
        ACCESS_BLOCK_REASONS.some((reason) => reason === value.reason) &&
        typeof value.message === 'string' &&
        (value.repository === undefined ||
          (typeof value.repository === 'string' &&
            value.repository.trim().length > 0))
      );
    default:
      return false;
  }
}

export function isSharedContainerPublicationState(
  value: unknown,
): value is SharedContainerPublicationState {
  return (
    isRecord(value) &&
    typeof value.projectId === 'string' &&
    typeof value.worktreeId === 'string' &&
    // Absent for a personal container.
    (value.organizationId === undefined ||
      typeof value.organizationId === 'string') &&
    typeof value.status === 'string' &&
    PUBLICATION_STATUSES.some((status) => status === value.status) &&
    typeof value.updatedAt === 'string' &&
    (value.containerId === undefined ||
      typeof value.containerId === 'string') &&
    (value.revision === undefined ||
      (typeof value.revision === 'number' &&
        Number.isFinite(value.revision))) &&
    (value.error === undefined || typeof value.error === 'string') &&
    (value.errorReason === undefined ||
      (typeof value.errorReason === 'string' &&
        PUBLICATION_ERROR_REASONS.some(
          (reason) => reason === value.errorReason,
        )))
  );
}

/**
 * A purge broadcast names the scope it applies to.
 *
 * Exact-key matching on both variants keeps a malformed payload from being read
 * as a wider purge than main meant: `{ purged: 'container' }` with a missing or
 * empty id is rejected outright rather than degrading into "purge everything".
 */
export function isSharedContainerReplicaPurge(
  value: unknown,
): value is SharedContainerReplicaPurge {
  if (!isRecord(value)) return false;
  if (value.purged === 'all') {
    return hasOnlyKeys(value, PURGE_ALL_KEYS);
  }
  if (value.purged === 'container') {
    return (
      hasOnlyKeys(value, PURGE_CONTAINER_KEYS) &&
      typeof value.containerId === 'string' &&
      value.containerId.length > 0
    );
  }
  return false;
}

/** Everything `shared-containers:replica-changed` may legitimately carry. */
export function isSharedContainerReplicaBroadcast(
  value: unknown,
): value is SharedContainerReplicaBroadcast {
  return (
    isSharedContainerReplicaState(value) || isSharedContainerReplicaPurge(value)
  );
}

/** `null` is the legitimate "no replica for this container" broadcast. */
export function isSharedContainerReplicaStateOrNull(
  value: unknown,
): value is SharedContainerReplicaState | null {
  return value === null || isSharedContainerReplicaState(value);
}

/** Progress events are advisory, so reject anything undeclared outright. */
export function isSharedContainerSyncPhaseEvent(
  value: unknown,
): value is SharedContainerSyncPhaseEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const record: Record<string, unknown> = { ...value };
  return (
    Object.keys(record).length === 2 &&
    typeof record.containerId === 'string' &&
    record.containerId.length > 0 &&
    typeof record.phase === 'string' &&
    SHARED_CONTAINER_SYNC_PHASES.some((phase) => phase === record.phase)
  );
}

const INBOX_CHANGED_REASONS: readonly SharedContainerInboxChangedEvent['reason'][] =
  ['realtime', 'poll', 'focus', 'local'];

/**
 * The inbox signal carries no container identity on purpose — its only job is
 * "something in your recipient inbox moved, re-list". Reject anything
 * undeclared so a transport internal can never reach the renderer.
 */
export function isSharedContainerInboxChangedEvent(
  value: unknown,
): value is SharedContainerInboxChangedEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const record: Record<string, unknown> = { ...value };
  return (
    Object.keys(record).length === 1 &&
    typeof record.reason === 'string' &&
    INBOX_CHANGED_REASONS.some((reason) => reason === record.reason)
  );
}

/** A removed-share page, or the marker that the server cannot list them. */
export function isListDismissedSharedContainersResult(
  value: unknown,
): value is ListDismissedSharedContainersResult {
  if (!isRecord(value)) return false;
  if ('unsupported' in value) {
    return hasOnlyKeys(value, ['unsupported']) && value.unsupported === true;
  }
  return isListDismissedSharedContainersResponse(value);
}

const RESTORE_FAILURE_REASONS: readonly string[] = [
  'not-restorable',
  'unsupported',
];

export function isRestoreSharedContainerResult(
  value: unknown,
): value is RestoreSharedContainerResult {
  if (!isRecord(value)) return false;
  if (value.restored === true) {
    return (
      hasOnlyKeys(value, ['restored', 'container']) &&
      isSharedContainerSummary(value.container)
    );
  }
  return (
    value.restored === false &&
    hasOnlyKeys(value, ['restored', 'reason']) &&
    typeof value.reason === 'string' &&
    RESTORE_FAILURE_REASONS.includes(value.reason)
  );
}
