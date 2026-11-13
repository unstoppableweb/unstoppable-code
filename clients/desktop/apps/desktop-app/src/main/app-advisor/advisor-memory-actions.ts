import { BRAND } from '@canopy/brand/current';
import { CanopyOperationError } from '@canopy/core-runtime';
import type {
  MemoryImportSourcesListResult,
  MemorySnapshotListResult,
  MemoryTarget,
} from '@canopy/protocol/canopy-core';
import type {
  AppAdvisorAction,
  AppAdvisorActionError,
  AppAdvisorActionResponse,
  AppAdvisorJson,
} from '@canopy/desktop-shared/types';

/**
 * CAN-6005: App Advisor's memory actions, in Electron main through the
 * core.memory maintenance operations. A rebuild, a restore and an import go
 * ahead only after a person confirms, and a rebuild or restore replaces only
 * the memory the person was asked about.
 */
export const ADVISOR_MEMORY_ACTION_TYPES = [
  'memory.consolidate_now',
  'memory.import_external',
  'memory.list_snapshots',
  'memory.rebuild',
  'memory.restore_snapshot',
] as const;

export type AdvisorMemoryAction = Extract<
  AppAdvisorAction,
  { type: (typeof ADVISOR_MEMORY_ACTION_TYPES)[number] }
>;

export function isAdvisorMemoryAction(
  action: AppAdvisorAction,
): action is AdvisorMemoryAction {
  return ADVISOR_MEMORY_ACTION_TYPES.some((type) => type === action.type);
}

export type PersonConfirmation = 'confirmed' | 'declined' | 'no_person';

interface ConsolidationStatus {
  pendingNotes: number;
  running: boolean;
  lastRunAt: string | null;
  lastResult: string | null;
  lastReason: string | null;
  lastConsolidatedAt: string | null;
}

/** The core.memory maintenance operations as the advisor chat; tests substitute them. */
export interface AdvisorMemoryActionHost {
  consolidate(target: MemoryTarget): Promise<ConsolidationStatus>;
  listSnapshots(target: MemoryTarget): Promise<MemorySnapshotListResult>;
  rebuild(
    target: MemoryTarget,
    expectedRevision: string,
  ): Promise<{
    status: string;
    reason: string | null;
    snapshotId: string | null;
    restoredInboxNotes: number;
    restoredImports: number;
    runs: number;
    consolidation: ConsolidationStatus;
  }>;
  restoreSnapshot(
    target: MemoryTarget,
    snapshotId: string,
    expectedRevision: string,
  ): Promise<{
    status: string;
    reason: string | null;
    previousSnapshotId: string | null;
  }>;
  importSources(workspaceId?: string): Promise<MemoryImportSourcesListResult>;
  importExternal(
    workspaceId: string | undefined,
    expectedSourcesDigest: string,
  ): Promise<{
    disabled: boolean;
    staged: number;
    skipped: number;
    deferred: number;
    errors: string[];
  }>;
  /** A listed project's name, for a question; null when the desktop lists none. */
  projectName(workspaceId: string): Promise<string | null>;
  /** One AskUserQuestion; only a person's answer can confirm. */
  confirm(
    question: string,
    options: { confirm: string; decline: string },
  ): Promise<PersonConfirmation>;
}

type Response = Omit<AppAdvisorActionResponse, 'requestId'>;

export const REBUILD_MEMORY = 'Rebuild';
export const RESTORE_MEMORY = 'Restore';
export const IMPORT_MEMORY = 'Import';
export const KEEP_MEMORY = 'Cancel';

function failure(
  code: AppAdvisorActionError['code'],
  message: string,
  retryable = false,
): Response {
  return { ok: false, error: { code, message, retryable } };
}

/** The memory the action names: the user's, or one named project's. */
function targetOf(
  action: { scope: 'user' | 'workspace'; workspaceId?: string },
  missingProjectMessage: string,
): MemoryTarget | Response {
  if (action.scope === 'user') return { scope: 'user' };
  return action.workspaceId === undefined
    ? failure('invalid_target', missingProjectMessage)
    : { scope: 'workspace', workspaceId: action.workspaceId };
}

function isResponse(value: MemoryTarget | Response): value is Response {
  return 'ok' in value;
}

async function memoryName(
  host: AdvisorMemoryActionHost,
  target: MemoryTarget,
): Promise<string> {
  if (target.scope === 'user') return 'your user memory';
  const name = await host.projectName(target.workspaceId);
  return `the memory of the project "${name ?? target.workspaceId}"`;
}

function refused(answer: Exclude<PersonConfirmation, 'confirmed'>): Response {
  return failure(
    'authorization_conflict',
    answer === 'declined'
      ? 'The person kept the memory as it is.'
      : 'Only a person can confirm this, and nobody did.',
  );
}

function consolidationJson(
  status: ConsolidationStatus,
): Record<string, AppAdvisorJson> {
  return {
    pendingNotes: status.pendingNotes,
    running: status.running,
    lastRunAt: status.lastRunAt,
    lastResult: status.lastResult,
    lastReason: status.lastReason,
    lastConsolidatedAt: status.lastConsolidatedAt,
  };
}

function operationFailure(error: unknown, fallback: string): Response {
  if (error instanceof CanopyOperationError) {
    switch (error.payload.kind) {
      case 'not_found':
        return failure('not_found', error.payload.message);
      case 'invalid_argument':
        return failure('invalid_payload', error.payload.message);
      case 'conflict':
        return failure('execution_failed', error.payload.message, true);
      case 'permission_denied':
      case 'unauthenticated':
        return failure('authorization_conflict', error.payload.message);
      default:
        return failure('execution_failed', error.payload.message, true);
    }
  }
  return failure(
    'execution_failed',
    error instanceof Error && error.message ? error.message : fallback,
  );
}

async function rebuild(
  action: Extract<AdvisorMemoryAction, { type: 'memory.rebuild' }>,
  host: AdvisorMemoryActionHost,
): Promise<Response> {
  const target = targetOf(action, 'Name the project whose memory to rebuild.');
  if (isResponse(target)) return target;
  const { revision } = await host.listSnapshots(target);
  const answer = await host.confirm(
    `Rebuild ${await memoryName(host, target)} from its notes? This replaces its index and topics; a snapshot is taken first so it can be restored.`,
    { confirm: REBUILD_MEMORY, decline: KEEP_MEMORY },
  );
  if (answer !== 'confirmed') return refused(answer);
  const rebuilt = await host.rebuild(target, revision);
  return {
    ok: true,
    result: {
      status: rebuilt.status,
      reason: rebuilt.reason,
      snapshotId: rebuilt.snapshotId,
      restoredInboxNotes: rebuilt.restoredInboxNotes,
      restoredImports: rebuilt.restoredImports,
      runs: rebuilt.runs,
      pendingNotes: rebuilt.consolidation.pendingNotes,
      lastResult: rebuilt.consolidation.lastResult,
      lastReason: rebuilt.consolidation.lastReason,
    },
  };
}

async function restoreSnapshot(
  action: Extract<AdvisorMemoryAction, { type: 'memory.restore_snapshot' }>,
  host: AdvisorMemoryActionHost,
): Promise<Response> {
  const target = targetOf(action, 'Name the project whose memory to restore.');
  if (isResponse(target)) return target;
  const { revision, snapshots } = await host.listSnapshots(target);
  const snapshot = snapshots.find(
    (entry) => entry.snapshotId === action.snapshotId,
  );
  if (!snapshot)
    return failure('not_found', `Snapshot ${action.snapshotId} was not found.`);
  const answer = await host.confirm(
    `Restore ${await memoryName(host, target)} to the snapshot from ${snapshot.createdAt}? This replaces its index and topics; the current memory is snapshotted first.`,
    { confirm: RESTORE_MEMORY, decline: KEEP_MEMORY },
  );
  if (answer !== 'confirmed') return refused(answer);
  const restored = await host.restoreSnapshot(
    target,
    action.snapshotId,
    revision,
  );
  return {
    ok: true,
    result: {
      status: restored.status,
      reason: restored.reason,
      previousSnapshotId: restored.previousSnapshotId,
    },
  };
}

async function importExternal(
  action: Extract<AdvisorMemoryAction, { type: 'memory.import_external' }>,
  host: AdvisorMemoryActionHost,
): Promise<Response> {
  const { digest, sources } = await host.importSources(action.workspaceId);
  if (sources.length > 0) {
    // The question names every file it reads (M2), by label only, never its
    // content.
    const listed = sources.map((source) => `- ${source.label}`);
    const answer = await host.confirm(
      [
        `Import ${sources.length === 1 ? 'this memory file' : `these ${sources.length} memory files`} from Claude Code and Codex into ${BRAND.displayName} memory?`,
        ...listed,
      ].join('\n'),
      { confirm: IMPORT_MEMORY, decline: KEEP_MEMORY },
    );
    if (answer !== 'confirmed') return refused(answer);
  }
  const imported = await host.importExternal(action.workspaceId, digest);
  return {
    ok: true,
    result: {
      disabled: imported.disabled,
      staged: imported.staged,
      skipped: imported.skipped,
      deferred: imported.deferred,
      errors: imported.errors,
    },
  };
}

async function run(
  action: AdvisorMemoryAction,
  host: AdvisorMemoryActionHost,
): Promise<Response> {
  switch (action.type) {
    case 'memory.consolidate_now': {
      const user = await host.consolidate({ scope: 'user' });
      const workspace =
        action.workspaceId === undefined
          ? null
          : await host.consolidate({
              scope: 'workspace',
              workspaceId: action.workspaceId,
            });
      return {
        ok: true,
        result: {
          user: consolidationJson(user),
          workspace: workspace ? consolidationJson(workspace) : null,
        },
      };
    }
    case 'memory.import_external':
      return importExternal(action, host);
    case 'memory.list_snapshots': {
      const target = targetOf(
        action,
        'Name the project whose memory snapshots to list.',
      );
      if (isResponse(target)) return target;
      const { snapshots } = await host.listSnapshots(target);
      return {
        ok: true,
        result: {
          snapshots: snapshots.map((snapshot) => ({
            id: snapshot.snapshotId,
            createdAt: snapshot.createdAt,
            reason: snapshot.reason,
            topicCount: snapshot.topicCount,
          })),
        },
      };
    }
    case 'memory.rebuild':
      return rebuild(action, host);
    case 'memory.restore_snapshot':
      return restoreSnapshot(action, host);
  }
}

export async function dispatchAdvisorMemoryAction(
  action: AdvisorMemoryAction,
  host: AdvisorMemoryActionHost,
): Promise<Response> {
  try {
    return await run(action, host);
  } catch (error) {
    return operationFailure(error, 'The memory action failed.');
  }
}
