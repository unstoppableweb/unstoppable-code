import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import type {
  ExternalProjectChatDestinationPort,
  ExternalProjectRegistrationPorts,
} from '@canopy/core-runtime/node/workspace/create-orchestration';
import type { SidebarItem } from '@canopy/desktop-shared/types';
import {
  createWorkEntry,
  listWorkEntryIds,
  removeWorkEntryRow,
} from '../lib/cowork-work-entries';
import { createExternalCoworkWorkspace } from '../lib/cowork-workspace-crud';
import { readAllSidebarItems } from '../lib/sidebar-items';
import { assertFolderIsImportable } from '../lib/workspace-service';
import { createWorkspace } from '../lib/workspace-creation';
import { cleanupPersistedWorktreeData } from '../lib/worktree-data-cleanup';
import {
  archiveSingleRepoWorktree,
  createSingleRepoWorktree,
} from '../lib/worktree-service';
import { readExternalProjectImportLedger } from './ledger';

/*
 * The desktop ports of core's external project registration (CAN-4096 D):
 * the sidebar and ledger reads, the single-repo register through the
 * workspace-creation adapter, and the external Cowork create, which `publish`
 * wraps (W6a2 has no P0 decision type).
 */

export const externalProjectRegistrationPorts: ExternalProjectRegistrationPorts<SidebarItem> =
  {
    canonicalPath: (path) => realpath(path),
    resolvesTo: async (path, canonicalPath) => {
      try {
        return (await realpath(path)) === canonicalPath;
      } catch {
        return false;
      }
    },
    readItems: async () => (await readAllSidebarItems()).items,
    rootPath: (item) =>
      item.type === 'single-repo'
        ? item.repoPath
        : item.type === 'cowork'
          ? item.externalPath
          : item.sourceRepoPath,
    recordedWorkspaceId: async (candidateId) =>
      (await readExternalProjectImportLedger()).imports[candidateId]
        ?.workspaceId,
    registerRepository: async (repoPath, name) =>
      (
        await createWorkspace({
          source: 'external_projects_import',
          variant: { kind: 'repository-without-manifest', repoPath, name },
        })
      ).workspace,
    admitFolder: (folderPath, items) =>
      assertFolderIsImportable(folderPath, items),
    publish: (folderPath, name) =>
      createExternalCoworkWorkspace(folderPath, name),
  };

/*
 * The Work Entry removal stays whole here rather than calling the item store's
 * `purge` (CAN-4098): `cleanupPersistedWorktreeData` already purges the
 * worktree's data through it, beside the chat, browser, code graph and other
 * sidecar tasks a purge alone would skip.
 */
export const externalProjectChatDestinationPort: ExternalProjectChatDestinationPort<SidebarItem> =
  {
    createWorkEntry: async (workspaceId) => {
      // No title: the entry is named from the chats it holds, the same way
      // every other Work Entry is, and a user rename still overrides that.
      // The explicit id makes it a fresh entry rather than adopting an empty
      // one the user already has open.
      const { entry } = await createWorkEntry(workspaceId, {
        id: randomUUID(),
      });
      return entry.id;
    },
    workEntryIds: (workspaceId) => listWorkEntryIds(workspaceId),
    removeWorkEntry: async (workspaceId, worktreeId) => {
      // Defer the browser lifecycle graph to this rollback-only path so normal
      // external-project imports do not eagerly load the browser service stack.
      const { withBrowserTaskOwnerRemoval } =
        await import('../browser/browser-profile-lifecycle');
      await withBrowserTaskOwnerRemoval(workspaceId, worktreeId, async () => {
        try {
          await cleanupPersistedWorktreeData(workspaceId, worktreeId);
        } finally {
          await removeWorkEntryRow(workspaceId, worktreeId);
        }
      });
    },
    createWorktree: async (workspaceId, existingWorktreeIds) =>
      (await createSingleRepoWorktree({ workspaceId, existingWorktreeIds })).id,
    worktreeIds: (item) =>
      item.type === 'single-repo'
        ? item.worktrees.map((worktree) => worktree.id)
        : [],
    removeWorktree: async (workspaceId, worktreeId) => {
      await archiveSingleRepoWorktree({
        archiveTrigger: 'import',
        workspaceId,
        worktreeId,
        // This import created the branch and nothing landed on it.
        deleteBranch: true,
        retainAsArchivedContainer: false,
      });
    },
  };
