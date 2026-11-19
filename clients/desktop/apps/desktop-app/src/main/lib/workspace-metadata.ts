import { z } from 'zod';
import type { CanopyJsonValue } from '@canopy/protocol/canopy-core';
import type { W5WorkspaceCommandHost } from '@canopy/core-runtime/node/w5/workspace-metadata/ports';
import {
  createWorkspaceMetadataCommands,
  type WorkspaceMetadataCommands,
  type WorkspaceMetadataCommandSource,
  type WorkspaceMetadataPatch as CoreWorkspaceMetadataPatch,
  type WorkspaceMetadataUpdateOutcome,
  type WorkspaceMetadataUpdateRequest as CoreWorkspaceMetadataUpdateRequest,
  type WorkspaceReorderOutcome,
  type WorkspaceReorderRequest,
} from '@canopy/core-runtime/node/w5/workspace-metadata/metadata';
import { isActivitySectionId } from '@canopy/desktop-shared/constants/activity';
import type { ActivitySectionId } from '@canopy/desktop-shared/types';
import { scheduleDesktopStructureChanged } from '../services/desktop-structure-signal';
import { serializeWorkspaceMutation } from './chat-project-operation-queue';
import { recordWorkspaceCrudTelemetry } from './desktop-telemetry';
import { getWorkspaceIndexRepository } from './sidebar-items';
import { afterW5Commit } from './w5-commit-scope';
import {
  DESKTOP_W5_WORKSPACE_COMMAND_STORAGE,
  desktopW5WorkspaceCommandHost,
  desktopW5WorkspaceManifestEditor,
} from './w5-workspace-command-host';
import type {
  WorkspaceIndexChange,
  WorkspaceIndexRepository,
  WorkspaceIndexSnapshot,
} from './workspace-index-repository';

export {
  WorkspaceMetadataRefusedError,
  type WorkspaceMetadataRefusal,
  type WorkspaceMetadataSource,
  type WorkspaceMetadataUpdateOutcome,
  type WorkspaceMoveRequest,
  type WorkspaceReorderOutcome,
  type WorkspaceReorderRequest,
  type WorkspaceStartPageChange,
} from '@canopy/core-runtime/node/w5/workspace-metadata/metadata';

export type WorkspaceMetadataPatch =
  CoreWorkspaceMetadataPatch<ActivitySectionId>;
export type WorkspaceMetadataUpdateRequest =
  CoreWorkspaceMetadataUpdateRequest<ActivitySectionId>;

/**
 * The saved outcome a keyed retry replays; it carries no host path. A wire
 * receipt's version 2 adds the decided workspace (W7a, DM-2).
 */
const workspaceMetadataUpdateOutcomeSchema = z.object({
  workspaceId: z.string(),
  indexWritten: z.boolean(),
  manifestWritten: z.boolean(),
  workspace: z.unknown().optional(),
});
const workspaceReorderOutcomeSchema = z.object({
  workspaceIds: z.array(z.string()),
});

/** The index writes of `core.workspace.update` and `core.workspace.reorder`. */
function updateWorkspaceIndex<T>(
  change: (
    current: WorkspaceIndexSnapshot,
  ) => WorkspaceIndexChange<T> | Promise<WorkspaceIndexChange<T>>,
): Promise<T> {
  return getWorkspaceIndexRepository().update(change);
}

/** The desktop's hooks and stores, under `host`'s decisions and receipts. */
export function createDesktopWorkspaceMetadataCommands(
  host: W5WorkspaceCommandHost<WorkspaceMetadataCommandSource>,
  decidedWorkspace?: (workspaceId: string) => Promise<CanopyJsonValue>,
): WorkspaceMetadataCommands<ActivitySectionId> {
  return createWorkspaceMetadataCommands<ActivitySectionId>({
    ...host,
    index: (): WorkspaceIndexRepository => ({
      read: () => getWorkspaceIndexRepository().read(),
      update: updateWorkspaceIndex,
    }),
    manifest: desktopW5WorkspaceManifestEditor,
    storage: DESKTOP_W5_WORKSPACE_COMMAND_STORAGE,
    isActivitySectionId,
    serializeUpdate: (work) => serializeWorkspaceMutation(work),
    updateOutcome: workspaceMetadataUpdateOutcomeSchema,
    reorderOutcome: workspaceReorderOutcomeSchema,
    afterUpdateStaged: async ({ workspaceId, source, patch }) => {
      // Collapse, pin and the other view preferences are not edits of the
      // workspace's identity, so only a rename or recolor records telemetry.
      if (
        source !== 'projects_save' &&
        (patch.name !== undefined || patch.color !== undefined)
      ) {
        await afterW5Commit(() =>
          recordWorkspaceCrudTelemetry({
            action: 'update',
            workspaceId,
            source,
          }),
        );
      }
    },
    // The manifest repository has no commit hook. Without this, a sort mode,
    // Always show or start page change reaches the renderer only after an
    // unrelated write stales the snapshot.
    afterUpdate: async (outcome) => {
      if (outcome.manifestWritten)
        await afterW5Commit(() =>
          scheduleDesktopStructureChanged('structural.workspace-metadata'),
        );
    },
    afterMoveStaged: () => Promise.resolve(),
    ...(decidedWorkspace && { decidedWorkspace }),
  });
}

let commands: WorkspaceMetadataCommands<ActivitySectionId> | undefined;

function workspaceMetadataCommands(): WorkspaceMetadataCommands<ActivitySectionId> {
  commands ??= createDesktopWorkspaceMetadataCommands(
    desktopW5WorkspaceCommandHost<WorkspaceMetadataCommandSource>(),
  );
  return commands;
}

/**
 * The typed in-process workspace metadata boundary (CAN-3807): every rename,
 * recolor, pin, collapse, sort mode, activity section order, Always show and
 * start page change of one workspace, from the renderer
 * (`workspace:update-metadata`, `workspace:set-start-page`) and the browser
 * Remote Control portal (`portal.workspace.update`). The core-runtime command
 * decides it; a writing update is serialized with the desktop's other
 * workspace mutations. The IPC projections reach it through the registered
 * `core.workspace.update` (W7a).
 *
 * Every write it commits stales the desktop session snapshot, with or
 * without a portal session: an index write through the index repository's
 * commit hook, a manifest write through the same structural sync.
 */
export async function updateWorkspaceMetadata(
  request: WorkspaceMetadataUpdateRequest,
): Promise<WorkspaceMetadataUpdateOutcome> {
  return workspaceMetadataCommands().update(request);
}

/**
 * The typed in-process workspace ordering boundary (CAN-3807): a drag move of
 * one visible workspace onto another's slot, from the renderer
 * (`workspace:reorder`) and the portal (`portal.workspace.reorder`), and the
 * projects save's full order. Each caller decides which workspaces it shows.
 */
export async function reorderWorkspaces(
  request: WorkspaceReorderRequest,
): Promise<WorkspaceReorderOutcome> {
  return workspaceMetadataCommands().reorder(request);
}
