import { join } from 'node:path';
import {
  MEMORY_REPLICA_ACCOUNT_FILENAME,
  MEMORY_REPLICA_PROJECTS_DIRNAME,
  MEMORY_SYNC_OUTBOX_FILENAME,
  MEMORY_SYNC_PRIVATE_DIRNAME,
  MEMORY_SYNC_STATE_FILENAME,
  memoryReplicaPathSegments,
  type MemoryScopeRef,
} from '@canopy/protocol/memory-sync';

/*
 * Where an account's replicas live under `<data>/memory-replicas/`
 * (docs/planning/2026-10-27-cloud-memory-sync/README.md §16.1). The root is
 * passed in, so the engine never reads an app path itself.
 */

/** A scope ref as a stable key: `user` or `project:<projectId>`. */
export function memoryScopeKey(scope: MemoryScopeRef): string {
  return scope.kind === 'user' ? 'user' : `project:${scope.projectId}`;
}

export function memoryReplicaAccountDir(
  replicasRoot: string,
  accountId: string,
): string {
  return join(replicasRoot, accountId);
}

export function memoryReplicaScopeDir(
  replicasRoot: string,
  accountId: string,
  scope: MemoryScopeRef,
): string {
  // The protocol's segments start with the root's own name.
  const [, ...segments] = memoryReplicaPathSegments(accountId, scope);
  return join(replicasRoot, ...segments);
}

/** `<account>/projects`, where the account's project scope replicas live. */
export function memoryReplicaProjectsDir(
  replicasRoot: string,
  accountId: string,
): string {
  return join(replicasRoot, accountId, MEMORY_REPLICA_PROJECTS_DIRNAME);
}

export function memoryReplicaAccountFile(accountDir: string): string {
  return join(accountDir, MEMORY_REPLICA_ACCOUNT_FILENAME);
}

export function memorySyncStateFile(scopeDir: string): string {
  return join(scopeDir, MEMORY_SYNC_STATE_FILENAME);
}

export function memorySyncOutboxFile(scopeDir: string): string {
  return join(scopeDir, MEMORY_SYNC_OUTBOX_FILENAME);
}

export type MemorySyncPrivateFolder =
  | 'base'
  | 'theirs'
  | 'conflicts'
  | 'displaced';

/** `<scope>/.sync/<folder>`, ignored by every memory reader. */
export function memorySyncPrivateDir(
  scopeDir: string,
  folder: MemorySyncPrivateFolder,
): string {
  return join(scopeDir, MEMORY_SYNC_PRIVATE_DIRNAME, folder);
}
