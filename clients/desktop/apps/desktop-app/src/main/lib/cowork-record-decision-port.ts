import { PROJECT_COLORS } from '@canopy/desktop-shared/constants/project-colors';
import type {
  CoworkSidebarItem,
  CoworkWorkspaceSettings,
  WorkspaceConfigFile,
} from '@canopy/desktop-shared/types';
import { ensureCoworkHomeScaffold } from './chat-project-utils';
import { getWorkspaceDir } from './paths';
import {
  commitW5BoundaryStep,
  w5CompositionLocks,
} from './w5-composition-operation';
import { afterW5Apply, outsideW5CommitScope } from './w5-commit-scope';
import { applyWorkspaceRecordsRemoval } from './workspace-record-decision-port';
import {
  removeWorkspaceNonW5Children,
  removeWorkspaceDirectoryAfterRecordRemoval,
} from './w5-workspace-directory-removal';
import { allocateSafeWorkspaceId } from '@canopy/core-runtime/node/identifiers';
import { workspaceCreationPathOccupied } from './w5-workspace-creation-commit';
import {
  getWorkspaceIndexRepository,
  renameWorkspaceIndexEntry,
} from './sidebar-items';
import {
  getWorkspaceManifestRepository,
  readWorkspaceConfigDetailed,
  updateWorkspaceConfig,
  WorkspaceConfigUnreadableError,
} from './workspace-persistence';
import {
  admitCoworkIndex,
  admitCoworkMetadataEntry,
  admitCoworkMetadataManifest,
  admitCoworkProvisionEntry,
  admitCoworkProvisionManifest,
  admitCoworkPublishEntry,
  admitCoworkPublishManifest,
  admitCoworkStageEntry,
  admitCoworkStageManifest,
  allocateCoworkMigrationTo,
  applyCoworkCreationIndexTo,
  applyCoworkCreationManifestTo,
  applyCoworkMetadataIndexTo,
  applyCoworkMetadataTo,
  applyCoworkMigrationManifestTo,
  applyCoworkProvisionIndexTo,
  applyCoworkProvisionManifestCreateTo,
  applyCoworkProvisionManifestTo,
  applyCoworkPublishIndexTo,
  applyCoworkPublishManifestTo,
  applyCoworkStageManifestTo,
  checkCoworkDiscardIndex,
  coworkCreationItemFor,
  coworkCreationScaffolds,
  coworkCreationTaken,
  discardsCoworkStaging,
  withUnknownCoworkFields,
} from './worktree-record-decision-apply';
import type {
  CoworkCreationAllocationDecision,
  CoworkCreationDecision,
  CoworkCreationManifestDecision,
  CoworkDefaultNameDecision,
  CoworkDefaultNameOutcome,
  CoworkDiscardDecision,
  CoworkDiscardStatus,
  CoworkIndexDecision,
  CoworkIndexDecisionOutcome,
  CoworkManifestDecision,
  CoworkMetadataDecision,
  CoworkMigrationDecision,
  CoworkMigrationOutcome,
  CoworkProvisionDecision,
  CoworkProvisionManifestPass,
  CoworkProvisionOutcome,
  CoworkPublishDecision,
  CoworkPublishOutcome,
  CoworkStageDecision,
} from './worktree-record-decisions';

// The designated Cowork members of `W5RecordDecisionPort` (W5c2, W6a2),
// applied by the writers the records used. Kept apart so the ownership,
// private memory and seed records do not load the Cowork scaffold.

function paletteColor(count: number): string {
  return PROJECT_COLORS[count % PROJECT_COLORS.length];
}

/** Restores the raw file's unknown Cowork fields on `config`. */
async function preserveCoworkFields(
  workspaceId: string,
  config: WorkspaceConfigFile,
): Promise<CoworkWorkspaceSettings> {
  const raw = await getWorkspaceManifestRepository().read(workspaceId);
  return withUnknownCoworkFields(
    raw.authority === 'ok' ? raw.document.cowork : undefined,
    config,
  );
}

/**
 * Applies one Cowork index decision through the index repository, which
 * admits the index storage and schedules the Portal sync after its commit.
 * The caller holds the workspace mutation queue; a migration's manifest is
 * read, not written, there.
 */
export async function applyCoworkIndexDecision(
  decision: CoworkMigrationDecision,
): Promise<CoworkMigrationOutcome>;
export async function applyCoworkIndexDecision(
  decision: CoworkDefaultNameDecision,
): Promise<CoworkDefaultNameOutcome>;
export async function applyCoworkIndexDecision(
  decision: CoworkIndexDecision,
): Promise<CoworkIndexDecisionOutcome>;
export async function applyCoworkIndexDecision(
  decision: CoworkIndexDecision,
): Promise<CoworkIndexDecisionOutcome> {
  switch (decision.kind) {
    case 'cowork.migration':
      return getWorkspaceIndexRepository().update<CoworkMigrationOutcome>(
        async (snapshot) => {
          admitCoworkIndex(snapshot.authority, snapshot.unserved);
          const allocated = allocateCoworkMigrationTo(
            snapshot.entries,
            decision,
            paletteColor(snapshot.entries.length),
          );
          if (!allocated.entries)
            return { result: { id: allocated.id, created: false } };
          // Refuse unreadable state before publication; the initial write still follows the index.
          const manifest = await readWorkspaceConfigDetailed(allocated.id);
          if (manifest.authority === 'unreadable')
            throw new WorkspaceConfigUnreadableError(manifest.unserved);
          return {
            result: { id: allocated.id, created: true },
            entries: allocated.entries,
          };
        },
      );
    case 'cowork.default-name':
      // The rename writer keeps its condition and its degraded-read decline.
      return renameWorkspaceIndexEntry(
        decision.workspaceId,
        decision.name,
        decision.onlyWhenNamed,
      );
  }
}

/**
 * Applies a default Cowork provision from the index and manifest read under
 * their queues, never a caller's projection: the manifest decision applies
 * inside the index update, and a new home is scaffolded before the index is
 * published. The caller holds the workspace mutation queue.
 */
export function applyCoworkProvisionDecision(
  decision: CoworkProvisionDecision,
): Promise<CoworkProvisionOutcome> {
  return getWorkspaceIndexRepository().update(async (snapshot) => {
    admitCoworkIndex(snapshot.authority, snapshot.unserved);
    const entry = admitCoworkProvisionEntry(snapshot.entries, decision);
    const pass = await updateWorkspaceConfig(
      decision.workspaceId,
      async (config, read): Promise<CoworkProvisionManifestPass> => {
        if (read.authority !== 'absent') {
          admitCoworkProvisionManifest(config, read, decision);
          await preserveCoworkFields(decision.workspaceId, config);
        }
        return applyCoworkProvisionManifestTo(
          config,
          read,
          {
            entry,
            count: snapshot.entries.length,
            color: paletteColor(snapshot.entries.length),
          },
          decision,
        );
      },
      {
        ownership: decision.owner ? 'replace' : 'preserve',
        shouldWrite: (result) => result.changed && !result.deferManifest,
      },
    );
    if (pass.scaffold) await ensureCoworkHomeScaffold(decision.workspaceId);
    return applyCoworkProvisionIndexTo(snapshot.entries, entry, pass, decision);
  });
}

/** Applies one Cowork manifest decision in the manifest queue. */
export async function applyCoworkManifestDecision(
  workspaceId: string,
  decision: CoworkManifestDecision,
): Promise<void> {
  switch (decision.kind) {
    case 'cowork.provision.manifest':
      await updateWorkspaceConfig(workspaceId, (config, read): void =>
        applyCoworkProvisionManifestCreateTo(config, read, decision),
      );
      return;
    case 'cowork.migration.manifest':
      await updateWorkspaceConfig(
        workspaceId,
        async (config): Promise<void> => {
          const current = await preserveCoworkFields(workspaceId, config);
          applyCoworkMigrationManifestTo(config, current, decision);
        },
      );
      return;
  }
}

// ---------------------------------------------------------------------------
// W6a2 (CAN-4814): create, stage, publish, metadata and discard. Each index
// member runs in the caller's workspace mutation queue.
// ---------------------------------------------------------------------------

/**
 * Selects a new identity under the index queue, past every indexed, pending
 * and occupied one; `admit` is the host's id admission. Commits nothing.
 */
export function applyCoworkCreationAllocation(
  decision: CoworkCreationAllocationDecision,
  admit: (workspaceId: string) => void,
): Promise<CoworkSidebarItem> {
  return getWorkspaceIndexRepository().update(async (snapshot) => {
    admitCoworkIndex(snapshot.authority, snapshot.unserved);
    const taken = coworkCreationTaken(snapshot.entries, decision);
    let id = allocateSafeWorkspaceId(decision.name, taken);
    while (await workspaceCreationPathOccupied(getWorkspaceDir(id))) {
      taken.add(id);
      id = allocateSafeWorkspaceId(decision.name, taken);
    }
    admit(id);
    return {
      result: coworkCreationItemFor(
        id,
        {
          count: snapshot.entries.length,
          color: paletteColor(snapshot.entries.length),
        },
        decision,
      ),
    };
  });
}

/**
 * Publishes an allocated identity in the caller's creation boundary step: a
 * bound manifest inside the index update, then a managed home, marked by
 * `beforeScaffold` before it starts, then the index entry.
 */
export function applyCoworkCreationDecision(
  decision: CoworkCreationDecision,
  beforeScaffold: () => void,
): Promise<void> {
  return getWorkspaceIndexRepository().update(async (snapshot) => {
    admitCoworkIndex(snapshot.authority, snapshot.unserved);
    const entries = applyCoworkCreationIndexTo(snapshot.entries, decision);
    if (decision.item.owner)
      await applyCoworkCreationManifestDecision(decision.item.id, {
        kind: 'cowork.create.manifest',
        item: decision.item,
      });
    if (coworkCreationScaffolds(decision)) {
      beforeScaffold();
      await ensureCoworkHomeScaffold(decision.item.id);
    }
    return { result: undefined, entries };
  });
}

/**
 * Creates a new identity's absent manifest: a bound one inside the index
 * update, replacing ownership; an unbound one after the index entry.
 */
export function applyCoworkCreationManifestDecision(
  workspaceId: string,
  decision: CoworkCreationManifestDecision,
): Promise<void> {
  return updateWorkspaceConfig(
    workspaceId,
    (config, read): void =>
      applyCoworkCreationManifestTo(config, read, decision),
    decision.item.owner ? { ownership: 'replace' } : undefined,
  );
}

/**
 * Stores or refreshes a staged workspace's manifest from the manifest read
 * under the index queue; the index is read, never written.
 */
export function applyCoworkStageDecision(
  decision: CoworkStageDecision,
): Promise<boolean> {
  return getWorkspaceIndexRepository().update(async (snapshot) => {
    admitCoworkIndex(snapshot.authority, snapshot.unserved);
    const indexed = admitCoworkStageEntry(snapshot.entries, decision);
    const created = await updateWorkspaceConfig(
      decision.item.id,
      async (config, read): Promise<boolean> => {
        admitCoworkStageManifest(config, read, decision);
        if (read.authority !== 'absent')
          await preserveCoworkFields(decision.item.id, config);
        return applyCoworkStageManifestTo(
          config,
          read,
          indexed !== undefined,
          decision,
        );
      },
      { ownership: 'replace' },
    );
    return { result: created };
  });
}

/**
 * Publishes a staged manifest under the index queue: the host `precheck`
 * runs on the admitted read, then the manifest, then the index entry.
 */
export function applyCoworkPublishDecision(
  decision: CoworkPublishDecision,
  precheck?: () => Promise<void>,
): Promise<CoworkPublishOutcome> {
  return getWorkspaceIndexRepository().update(async (snapshot) => {
    admitCoworkIndex(snapshot.authority, snapshot.unserved);
    await precheck?.();
    const entry = admitCoworkPublishEntry(snapshot.entries, decision);
    const outcome = await updateWorkspaceConfig(
      decision.workspaceId,
      async (config, read): Promise<CoworkPublishOutcome> => {
        admitCoworkPublishManifest(config, read, decision);
        await preserveCoworkFields(decision.workspaceId, config);
        return applyCoworkPublishManifestTo(
          config,
          {
            entry,
            count: snapshot.entries.length,
            color: paletteColor(snapshot.entries.length),
          },
          decision,
        );
      },
      { ownership: 'replace', shouldWrite: (result) => result.changed },
    );
    const entries = applyCoworkPublishIndexTo(snapshot.entries, entry, outcome);
    return { result: outcome, ...(entries ? { entries } : {}) };
  });
}

/** Applies a metadata change to the manifest, then an import's name or color to the index. */
export function applyCoworkMetadataDecision(
  decision: CoworkMetadataDecision,
): Promise<void> {
  return getWorkspaceIndexRepository().update(async (snapshot) => {
    admitCoworkIndex(snapshot.authority, snapshot.unserved);
    const entry = admitCoworkMetadataEntry(snapshot.entries, decision);
    await updateWorkspaceConfig(
      decision.workspaceId,
      async (config, read): Promise<void> => {
        admitCoworkMetadataManifest(config, read);
        const settings = await preserveCoworkFields(
          decision.workspaceId,
          config,
        );
        applyCoworkMetadataTo(config, settings, decision);
      },
    );
    const entries = applyCoworkMetadataIndexTo(
      snapshot.entries,
      entry,
      decision,
    );
    return { result: undefined, ...(entries ? { entries } : {}) };
  });
}

/**
 * Removes an unpublished staging's metadata directory: the index read under
 * its queue proves it unpublished, then the manifest proves it this project's.
 * Both proofs and record removals share one decision; attached folders stay.
 */
export function applyCoworkDiscardDecision(
  decision: CoworkDiscardDecision,
): Promise<CoworkDiscardStatus> {
  const discardStagingRecords = async (): Promise<CoworkDiscardStatus> => {
    const status =
      await getWorkspaceIndexRepository().update<CoworkDiscardStatus>(
        async (snapshot) => {
          const held = checkCoworkDiscardIndex(
            snapshot.authority,
            snapshot.entries,
            decision,
          );
          if (held) return { result: held };
          const matches = await getWorkspaceManifestRepository().serialize(
            decision.workspaceId,
            async (): Promise<boolean> => {
              const read = await readWorkspaceConfigDetailed(
                decision.workspaceId,
              );
              return discardsCoworkStaging(
                {
                  authority: read.authority,
                  ownerMalformed: read.ownerMalformed,
                  type: read.config.type,
                  owner: read.config.owner,
                },
                decision,
              );
            },
          );
          return { result: matches ? 'removed' : 'kept' };
        },
      );
    if (status !== 'removed') return status;
    // Outer reservations keep both proofs locked without reentering their updaters.
    await outsideW5CommitScope(() =>
      removeWorkspaceNonW5Children(decision.workspaceId),
    );
    await applyWorkspaceRecordsRemoval(decision.workspaceId, {
      kind: 'workspace.delete.records',
    });
    await afterW5Apply(() =>
      removeWorkspaceDirectoryAfterRecordRemoval(decision.workspaceId),
    );
    return status;
  };
  return commitW5BoundaryStep(
    { operation: 'core.workspace.create' },
    w5CompositionLocks({
      index: true,
      manifests: [decision.workspaceId],
      lists: [decision.workspaceId],
    }),
    discardStagingRecords,
  );
}
