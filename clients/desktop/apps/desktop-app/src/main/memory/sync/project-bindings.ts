import type { CloudProjectBinding } from '@canopy/protocol/memory-sync';
import { readWorkspaceIndexEntries } from '../../lib/sidebar-items';
import { readWorkspaceConfigDetailed } from '../../lib/workspace-persistence';
import type { WorkspaceMemoryBinding } from './project-scopes';

/*
 * The project memory facts of each workspace, read from its `workspace.json`
 * (design §21.8, §22): the cloud project its binding names and for which
 * account, whether that binding was detached or its project moved, and
 * whether the project keeps private memory. A config that cannot be read, or
 * whose memory settings are malformed, reads as unreadable, which maps to no
 * project scope.
 */

function hasText(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0;
}

function hasMove(value: unknown): boolean {
  return typeof value === 'object' && value !== null;
}

function bindingFacts(
  binding: CloudProjectBinding | undefined,
): WorkspaceMemoryBinding['binding'] {
  if (binding === undefined) return null;
  return {
    projectId: binding.projectId,
    accountId: binding.accountId,
    detached: hasText(binding.detachedAt),
    moved: hasMove(binding.movedTo),
  };
}

export async function readWorkspaceMemoryBinding(
  workspaceId: string,
): Promise<WorkspaceMemoryBinding> {
  try {
    const detail = await readWorkspaceConfigDetailed(workspaceId);
    if (
      detail.authority !== 'ok' ||
      detail.ownerMalformed ||
      detail.memoryMalformed
    ) {
      return {
        workspaceId,
        unreadable: true,
        privateMemory: false,
        binding: null,
      };
    }
    return {
      workspaceId,
      unreadable: false,
      privateMemory: detail.config.privateMemory === true,
      binding: bindingFacts(detail.config.cloudBinding),
    };
  } catch {
    return {
      workspaceId,
      unreadable: true,
      privateMemory: false,
      binding: null,
    };
  }
}

/** Every workspace in the index, as its file stands now. */
export async function readWorkspaceMemoryBindings(): Promise<
  WorkspaceMemoryBinding[]
> {
  const entries = await readWorkspaceIndexEntries();
  const ids = [...new Set(entries.map((entry) => entry.id))];
  return Promise.all(ids.map((id) => readWorkspaceMemoryBinding(id)));
}
