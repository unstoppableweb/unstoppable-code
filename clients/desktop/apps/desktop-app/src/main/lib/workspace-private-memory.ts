import { z } from 'zod';
import {
  createWorkspacePrivateMemoryCommand,
  WorkspacePrivateMemoryRefusedError,
  type WorkspacePrivateMemorySource,
  type WorkspacePrivateMemoryUpdateOutcome,
  type WorkspacePrivateMemoryUpdateRequest,
} from '@canopy/core-runtime/node/w5/workspace-metadata/private-memory';
import type { W5WorkspaceCommandHost } from '@canopy/core-runtime/node/w5/workspace-metadata/ports';
import { readWorkspaceIndexEntry } from './sidebar-items';
import { validateId } from './validation';
import {
  DESKTOP_W5_WORKSPACE_COMMAND_STORAGE,
  desktopW5WorkspaceCommandHost,
  desktopW5WorkspaceManifestEditor,
} from './w5-workspace-command-host';
import { WorkspaceConfigUnreadableError } from './workspace-persistence';
import { applyWorkspaceOwnershipDecision } from './workspace-ownership-decision-port';
import { notifyWorkspaceMemoryBindingChanged } from './workspace-memory-binding-events';
import type { OrganizationPrivateMemoryStatus } from './worktree-record-decisions';

export {
  WorkspacePrivateMemoryRefusedError,
  type WorkspacePrivateMemoryRefusal,
  type WorkspacePrivateMemorySource,
  type WorkspacePrivateMemoryUpdateOutcome,
  type WorkspacePrivateMemoryUpdateRequest,
} from '@canopy/core-runtime/node/w5/workspace-metadata/private-memory';

const outcomeSchema = z.object({
  workspaceId: z.string(),
  privateMemory: z.boolean(),
});

const ORGANIZATION_CONFIGURATION_UNAVAILABLE_MESSAGE =
  'Organization project config is unavailable for memory policy';

type PrivateMemoryCommand = (
  request: WorkspacePrivateMemoryUpdateRequest,
) => Promise<WorkspacePrivateMemoryUpdateOutcome>;

/** The desktop's private memory command, under `host`'s decisions and receipts. */
export function createDesktopWorkspacePrivateMemoryCommand(
  host: W5WorkspaceCommandHost<WorkspacePrivateMemorySource>,
): PrivateMemoryCommand {
  return createWorkspacePrivateMemoryCommand({
    ...host,
    manifest: desktopW5WorkspaceManifestEditor,
    storage: DESKTOP_W5_WORKSPACE_COMMAND_STORAGE,
    hasWorkspace: async (workspaceId) =>
      Boolean(await readWorkspaceIndexEntry(workspaceId)),
    outcome: outcomeSchema,
  });
}

let updateCommand: PrivateMemoryCommand | undefined;

/**
 * The typed in-process `core.workspace.privateMemory.update` boundary
 * (CAN-3817): the local private memory choice of one workspace, from
 * `workspace:set-private-memory` through the registered operation (W7a),
 * decided by the core-runtime command.
 */
export async function updateWorkspacePrivateMemory(
  request: WorkspacePrivateMemoryUpdateRequest,
): Promise<WorkspacePrivateMemoryUpdateOutcome> {
  updateCommand ??= createDesktopWorkspacePrivateMemoryCommand(
    desktopW5WorkspaceCommandHost<WorkspacePrivateMemorySource>(),
  );
  try {
    return await updateCommand(request);
  } finally {
    notifyWorkspaceMemoryBindingChanged(request.workspaceId);
  }
}

export interface OrganizationPrivateMemoryRecord {
  workspaceId: string;
  organizationId: string;
  projectId: string;
  privateMemory: boolean;
}

/**
 * The private memory part of `internal.workspace.ownership.record` (CAN-3799
 * D9): the organization materialization and catalog reconciliation record an
 * organization project's inherited policy, together with the marker that
 * stops a local change. It is the sole writer of `privateMemoryManagedBy`.
 *
 * The workspace must still be bound to that organization project when the
 * write queue reaches it; otherwise, or when the manifest is missing,
 * unreadable or malformed, nothing is written. Resolves whether it changed
 * the manifest. The decision applies through the record decision port (W5c2).
 */
export async function recordOrganizationPrivateMemory(
  record: OrganizationPrivateMemoryRecord,
): Promise<boolean> {
  validateId(record.workspaceId, 'workspaceId');
  let status: OrganizationPrivateMemoryStatus;
  try {
    status = await applyWorkspaceOwnershipDecision(record.workspaceId, {
      kind: 'ownership.private-memory',
      organizationId: record.organizationId,
      projectId: record.projectId,
      privateMemory: record.privateMemory,
    });
  } catch (error) {
    if (error instanceof WorkspaceConfigUnreadableError) status = 'refused';
    else throw error;
  }
  if (status === 'recorded')
    notifyWorkspaceMemoryBindingChanged(record.workspaceId);
  if (status === 'refused')
    throw new WorkspacePrivateMemoryRefusedError(
      'configuration-unavailable',
      ORGANIZATION_CONFIGURATION_UNAVAILABLE_MESSAGE,
    );
  return status === 'recorded';
}
