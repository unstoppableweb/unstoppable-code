import { resolve } from 'node:path';
import type { LocalMemoryScopeRequest } from '@canopy/desktop-shared/types';
import type {
  MemoryDeviceRef,
  MemoryScopeRef,
} from '@canopy/protocol/memory-sync';
import type { MemoryConsolidationResult } from '@canopy/memory-consolidation/run';
import type { LocalMemorySyncedConsolidation } from '../local/replica-hooks';
import type { LocalMemoryReplicaLocator } from '../local/scope-resolver';
import type { MemoryReplicaBinding } from './replica-files';
import { memoryScopeKey } from './replica-layout';

/*
 * The replicas this process may resolve to, held in memory so the scope
 * resolver stays synchronous and free of I/O (design §3.1). The sync engine
 * registers a replica once it exists on disk and its first enable is done;
 * nothing is copied between accounts, and only the signed-in account's
 * replicas are ever answered.
 */

export interface MemoryReplicaEntry {
  accountId: string;
  scope: MemoryScopeRef;
  dir: string;
  binding: MemoryReplicaBinding;
  /** This device as its new notes name it. */
  device: MemoryDeviceRef;
  /** A note or document changed here: the engine syncs soon. */
  onLocalChange: () => void;
  /** Uses counted here, queued as the scope's usage deltas. */
  recordUsage: (counts: ReadonlyMap<string, number>, usedAt: string) => void;
  /** Runs a consolidation of this replica holding its lease. */
  runConsolidation: (
    reason: 'scheduled' | 'manual',
    run: (
      consolidation: LocalMemorySyncedConsolidation,
    ) => Promise<MemoryConsolidationResult>,
  ) => Promise<MemoryConsolidationResult>;
}

export class MemoryReplicaRegistry {
  private readonly byDir = new Map<string, MemoryReplicaEntry>();

  /**
   * @param onChange Runs after a replica is added or removed, when the
   *   folder a scope resolves to may have moved.
   */
  constructor(private readonly onChange: () => void = (): void => undefined) {}

  register(entry: MemoryReplicaEntry): void {
    const dir = resolve(entry.dir);
    const previous = this.byDir.get(dir);
    this.byDir.set(dir, { ...entry, dir });
    if (
      previous?.accountId !== entry.accountId ||
      memoryScopeKey(previous.scope) !== memoryScopeKey(entry.scope)
    ) {
      this.onChange();
    }
  }

  /** Stops resolving to the replica at `dir`, when one is registered. */
  unregisterDir(dir: string): void {
    if (this.byDir.delete(resolve(dir))) this.onChange();
  }

  unregisterAccount(accountId: string): void {
    let removed = false;
    for (const [dir, entry] of this.byDir) {
      if (entry.accountId !== accountId) continue;
      this.byDir.delete(dir);
      removed = true;
    }
    if (removed) this.onChange();
  }

  dirFor(accountId: string, scope: MemoryScopeRef): string | null {
    const key = memoryScopeKey(scope);
    for (const entry of this.byDir.values()) {
      if (
        entry.accountId === accountId &&
        memoryScopeKey(entry.scope) === key
      ) {
        return entry.dir;
      }
    }
    return null;
  }

  /** The replica at `dir`, for the local store's write hooks. */
  entryForDir(dir: string): MemoryReplicaEntry | null {
    return this.byDir.get(resolve(dir)) ?? null;
  }
}

/**
 * The scope resolver's view of the registry. A workspace resolves to the
 * replica of the project scope `projectFor` maps it to for the account
 * (design §22), so a workspace bound to no project, or to another account's,
 * keeps its device-local folder.
 */
export function createMemoryReplicaLocator(
  registry: MemoryReplicaRegistry,
  signedInAccountId: () => string | null,
  projectFor: (
    accountId: string,
    workspaceId: string,
  ) => MemoryScopeRef | null = (): null => null,
): LocalMemoryReplicaLocator {
  return {
    signedInAccountId,
    replicaDir: (accountId: string, scope: LocalMemoryScopeRequest) => {
      if (scope.scope === 'user') {
        return registry.dirFor(accountId, { kind: 'user' });
      }
      const project = projectFor(accountId, scope.workspaceId);
      return project === null ? null : registry.dirFor(accountId, project);
    },
  };
}
