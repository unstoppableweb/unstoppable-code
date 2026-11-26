/**
 * Per-worktree pipeline documents for the cloud inventory sync (CAN-2830).
 *
 * Project pipelines are discovered from each worktree checkout, so one
 * `pipelines` document exists per `(project, worktree)` and is keyed with
 * {@link buildWorktreeInventoryScopeKey}. The payload is exactly what the
 * live `portal.pipeline.list` command returns for that worktree: the same
 * reader and the same byte-budget fit, so the web renders one shape whether
 * it came from the store or from Remote Control.
 */
import {
  buildWorktreeInventoryScopeKey,
  type DesktopInventoryPayloadMap,
} from '@canopy/protocol/desktop-inventory';
import { runWithW5Caller } from '@canopy/desktop-shared/node/work-counters';
import {
  readThroughDesktopW5Cache,
  W5_DISCOVER_REQUEST,
  w5WorkspaceFileRequest,
} from '../canopy-runtime/w5-read-cache-server';
import { readAllSidebarItemsSnapshot } from '../lib/sidebar-items';
import { logMainProcessError } from '../lib/main-process-logging';
import { fitPipelineListResult } from '../remote-projection/pipeline-list-budget';
import {
  listPipelinesStrict,
  pipelineListTargetFor,
} from './pipelines-service';
import { readWorkspaceConfigDetailed } from '../lib/workspace-persistence';

const NON_CATALOG_WORKSPACE_IDS = new Set([
  'app-advisor',
  'standalone-chat',
  'plan-explore-chat',
  'code-review-chat',
  'pipeline-editor',
]);

export interface WorktreePipelineInventoryDocument {
  scopeKey: string;
  payload: DesktopInventoryPayloadMap['pipelines'];
}

export interface WorktreePipelineInventoryRead {
  documents: WorktreePipelineInventoryDocument[];
  nonPersonalWorkspaceIds: string[];
  /**
   * True only when every workspace loaded and every worktree's discovery
   * succeeded. The sync service turns a scope's absence into a cloud
   * removal, so an incomplete read must never be mistaken for authoritative
   * absence: documents that did read still push, removals wait.
   */
  complete: boolean;
}

/**
 * Every worktree's pipeline list, with strict discovery so a read error is
 * reported (`complete: false`) rather than synced as an empty list, and a
 * discovery bound is reported as a truncated payload.
 */
export function listWorktreePipelineInventoryDocuments(): Promise<WorktreePipelineInventoryRead> {
  return runWithW5Caller('background:inventory-sync', readInventoryDocuments);
}

async function readInventoryDocuments(): Promise<WorktreePipelineInventoryRead> {
  // One snapshot: the items and the authority of the very reads they came
  // from (the workspace index and every workspace.json / worktrees.json).
  // The sidebar reads an unreadable or partly malformed file as whatever it
  // could recover so the app keeps working; here absence becomes cloud
  // removals, so only reads that were authoritative (present and fully
  // valid, or absent) can prove that a worktree is gone.
  const {
    file: { items, warnings },
    authority,
  } = await readThroughDesktopW5Cache(W5_DISCOVER_REQUEST, () =>
    readAllSidebarItemsSnapshot(),
  );
  let complete =
    (authority === 'ok' || authority === 'absent') &&
    (!warnings || warnings.length === 0);
  const documents: WorktreePipelineInventoryDocument[] = [];
  const nonPersonalWorkspaceIds: string[] = [];
  for (const item of items) {
    if (!('worktrees' in item)) continue;
    const detail = await readThroughDesktopW5Cache(
      w5WorkspaceFileRequest('manifest', item.id),
      () => readWorkspaceConfigDetailed(item.id),
    );
    if (detail.authority !== 'ok') {
      complete = false;
      continue;
    }
    if (
      detail.ownerMalformed ||
      detail.config.owner ||
      detail.config.temporary ||
      NON_CATALOG_WORKSPACE_IDS.has(item.id)
    ) {
      nonPersonalWorkspaceIds.push(item.id);
      continue;
    }
    for (const worktree of item.worktrees) {
      try {
        // The sidebar was read once above; the target is derived from that
        // item rather than resolved again per worktree.
        const { pipelines, truncated } = await listPipelinesStrict(
          pipelineListTargetFor(item, worktree.id),
        );
        documents.push({
          scopeKey: buildWorktreeInventoryScopeKey(item.id, worktree.id),
          // A discovery bound that skipped files is reported exactly like
          // the byte-budget cut, and sized with it: the store must never
          // present a partial list as complete.
          payload: fitPipelineListResult(pipelines, { truncated }),
        });
      } catch (error) {
        complete = false;
        logMainProcessError(
          `Desktop inventory pipeline read failed (${item.id}/${worktree.id})`,
          error,
        );
      }
    }
  }
  return { documents, complete, nonPersonalWorkspaceIds };
}
