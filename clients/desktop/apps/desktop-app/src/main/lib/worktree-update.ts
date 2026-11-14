import { z } from 'zod';
import { decodeW5WorktreeUpdateOutcome } from '@canopy/core-runtime/node/w5/worktree-outcome';
import { w5RecordReadPaths } from './paths';
import { withW5Commit } from './w5-commit-log-file-store';
import {
  checkW5ExpectedRevision,
  w5ExpectedRevision,
  type W5BoundaryOptions,
} from './w5-boundary-operation';
import {
  createW5SingleDecisionOperation,
  wireW5Decode,
  withW5DecisionOnlyRetry,
  type W5WireDecisionCall,
} from './w5-single-decision-operation';
import {
  WORKSPACE_ROOT_REPO_ID,
  type WorktreeData,
} from '@canopy/desktop-shared/types';
import { isWritableScope, READ_ONLY_SCOPE_ERROR } from './read-only-scope';
import { validateId } from './validation';
import {
  reorderWorktreesById,
  updateWorkspaceWorktrees,
  WorktreeRegistryUnreadableError,
} from './workspace-persistence';

export type WorktreeBranchGroupingOverride = NonNullable<
  WorktreeData['branchGroupingOverride']
>;

/**
 * The client-patchable worktree metadata of `core.worktree.update` (CAN-3799).
 * Each property replaces one persisted field; `null` clears it. Lifecycle,
 * activity, badges, Git and PR observations, health, discovery and paused
 * hooks are owned by other operations and cannot be patched here.
 */
export interface WorktreeMetadataPatch {
  /** Trimmed display label; `null` or a blank label clears it. */
  label?: string | null;
  hidden?: boolean;
  pinned?: boolean;
  branchGroupingOverride?: WorktreeBranchGroupingOverride | null;
  /**
   * Single-repository base branch. `null` is persisted as the clear, so a
   * stale whole-list save cannot bring the old base back. Setting it clears
   * the merge-retarget grouping parent.
   */
  trackedBaseBranch?: string | null;
  /**
   * Per-repository base branches keyed by repository id; `null` clears that
   * repository's base. Setting any clears the merge-retarget grouping parent.
   */
  trackedRepoBaseBranches?: Readonly<Record<string, string | null>>;
}

/** The typed read projection of the patchable fields of one persisted row. */
export interface WorktreeMetadata {
  label: string | null;
  hidden: boolean;
  pinned: boolean;
  branchGroupingOverride: WorktreeBranchGroupingOverride | null;
  trackedBaseBranch: string | null;
  trackedRepoBaseBranches: Record<string, string>;
}

/**
 * The closed request of the in-process `core.worktree.update` boundary: any
 * other key, top-level or in `patch`, is refused `invalid-patch` before its
 * idempotency key is looked up (CAN-5526). `expectedCreatedAt` and
 * `worktreeOrder` are host-only compatibility fields that the wire operation
 * does not carry; revisit them at W9 or when the renderer moves to `core.*`.
 */
export interface WorktreeUpdateRequest extends W5BoundaryOptions {
  workspaceId: string;
  worktreeId: string;
  /** `projects_save` may edit only the incarnation it was shown. */
  expectedCreatedAt?: string;
  patch: WorktreeMetadataPatch;
  /**
   * Branch grouping's full manual order, applied in the same write as its
   * override, last writer wins. Ids that are not in the list are ignored.
   */
  worktreeOrder?: readonly string[];
}

export interface WorktreeUpdateOutcome {
  /** The persisted row after the update. */
  worktree: WorktreeData;
  /**
   * False when the patch matched the stored row's fields. A `worktreeOrder`
   * can still have moved it.
   */
  changed: boolean;
}

/**
 * The closed move request of `core.worktree.reorder`; its wire spec mirrors
 * it at registration. Group membership is desktop-only (A22(a)): a membership
 * field is an unknown key, refused before any key lookup or read.
 */
export const worktreeMoveRequestSchema = z.strictObject({
  workspaceId: z.string(),
  activeWorktreeId: z.string(),
  overWorktreeId: z.string(),
  expectedRevision: z.number().optional(),
  idempotencyKey: z.string().optional(),
});

export type WorktreeMoveRequest = z.infer<typeof worktreeMoveRequestSchema>;

// `satisfies` keeps both key sets equal to their interfaces.
const worktreeUpdateRequestSchema = z.strictObject({
  workspaceId: z.string(),
  worktreeId: z.string(),
  expectedCreatedAt: z.string().optional(),
  // Closed and checked field by field in `admitPatch`.
  patch: z.unknown(),
  worktreeOrder: z.array(z.string()).optional(),
  expectedRevision: z.number().optional(),
  idempotencyKey: z.string().optional(),
} satisfies Record<keyof WorktreeUpdateRequest, z.ZodType>);

const WORKTREE_METADATA_PATCH_FIELDS: ReadonlySet<string> = new Set(
  Object.keys({
    label: true,
    hidden: true,
    pinned: true,
    branchGroupingOverride: true,
    trackedBaseBranch: true,
    trackedRepoBaseBranches: true,
  } satisfies Record<keyof WorktreeMetadataPatch, true>),
);

export type WorktreeUpdateRefusal =
  | 'read-only-scope'
  | 'invalid-patch'
  | 'not-found'
  | 'worktrees-unavailable';

/**
 * An admission check refused the update before anything was written. The
 * name stays `Error` so the message a renderer sees is unchanged.
 */
export class WorktreeUpdateRefusedError extends Error {
  constructor(
    readonly reason: WorktreeUpdateRefusal,
    message: string,
  ) {
    super(message);
  }
}

const isWorktreeUpdateRefusal = (error: unknown): boolean =>
  error instanceof WorktreeUpdateRefusedError;

/**
 * Both boundaries' in-process receipts name `desktop-host:worktree-metadata`;
 * a wire call's name its principal (`worktreeMetadataRunner`). A refused
 * attempt wrote no sidecar (P14), so each call is a decision-only unit.
 */
const runWorktreeMetadataCommand = withW5DecisionOnlyRetry(
  createW5SingleDecisionOperation<'worktree-metadata'>(isWorktreeUpdateRefusal),
);

/** The runner for one call: a wire call's receipts name its principal. */
function worktreeMetadataRunner(
  wire: W5WireDecisionCall<never> | undefined,
): typeof runWorktreeMetadataCommand {
  return wire
    ? withW5DecisionOnlyRetry(
        createW5SingleDecisionOperation<'worktree-metadata'>(
          isWorktreeUpdateRefusal,
          wire,
        ),
      )
    : runWorktreeMetadataCommand;
}

function refuse(reason: WorktreeUpdateRefusal, message: string): never {
  throw new WorktreeUpdateRefusedError(reason, message);
}

function admitScope(workspaceId: string): void {
  validateId(workspaceId, 'workspaceId');
  if (!isWritableScope(workspaceId)) {
    refuse('read-only-scope', READ_ONLY_SCOPE_ERROR);
  }
}

function requireBaseBranch(value: unknown): string | null {
  if (value === null) return null;
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) refuse('invalid-patch', 'baseBranch is required.');
  return trimmed;
}

function refuseUnknownPatchFields(entries: Record<string, unknown>): void {
  if (
    Object.keys(entries).some((key) => !WORKTREE_METADATA_PATCH_FIELDS.has(key))
  )
    refuse('invalid-patch', 'Unknown worktree patch field');
}

/**
 * Checks a patch from an untrusted caller and returns its normalized form.
 * Renderer data reaches the boundary unchecked, so every field is read as
 * `unknown` here.
 */
function admitPatch(patch: WorktreeMetadataPatch): WorktreeMetadataPatch {
  const entries: Record<string, unknown> = { ...patch };
  refuseUnknownPatchFields(entries);
  const admitted: WorktreeMetadataPatch = {};
  if ('label' in entries) {
    const label = entries.label;
    if (label !== null && typeof label !== 'string') {
      refuse('invalid-patch', 'Invalid worktree label');
    }
    admitted.label = label;
  }
  if ('hidden' in entries) {
    if (typeof entries.hidden !== 'boolean') {
      refuse('invalid-patch', 'Invalid worktree hidden state');
    }
    admitted.hidden = entries.hidden;
  }
  if ('pinned' in entries) {
    if (typeof entries.pinned !== 'boolean') {
      refuse('invalid-patch', 'Invalid worktree pinned state');
    }
    admitted.pinned = entries.pinned;
  }
  if ('branchGroupingOverride' in entries) {
    const override = entries.branchGroupingOverride;
    if (override !== null && override !== 'group' && override !== 'ungroup') {
      refuse('invalid-patch', 'Invalid worktree branch grouping override');
    }
    admitted.branchGroupingOverride = override;
  }
  if ('trackedBaseBranch' in entries) {
    admitted.trackedBaseBranch = requireBaseBranch(entries.trackedBaseBranch);
  }
  if ('trackedRepoBaseBranches' in entries) {
    const bases = entries.trackedRepoBaseBranches;
    if (typeof bases !== 'object' || bases === null || Array.isArray(bases)) {
      refuse('invalid-patch', 'Invalid per-repository base branches');
    }
    const admittedBases: Record<string, string | null> = {};
    for (const [repoId, base] of Object.entries(bases)) {
      // Source-backed workspaces address the workspace root through the
      // synthetic root repository id, which is not a plain slug.
      if (repoId !== WORKSPACE_ROOT_REPO_ID) validateId(repoId, 'repoId');
      admittedBases[repoId] = requireBaseBranch(base);
    }
    admitted.trackedRepoBaseBranches = admittedBases;
  }
  if (Object.keys(admitted).length === 0) {
    refuse('invalid-patch', 'A worktree update needs at least one field');
  }
  return admitted;
}

/**
 * Applies an admitted patch with the desktop's persistence conventions:
 * absent and false flags omit their key, and the row is returned unchanged
 * (the same object) when the patch matches it, so no write happens.
 */
function applyWorktreeMetadataPatch(
  worktree: WorktreeData,
  patch: WorktreeMetadataPatch,
): WorktreeData {
  const next: WorktreeData = { ...worktree };
  let changed = false;

  if (patch.label !== undefined) {
    const label = patch.label?.trim() ?? '';
    const hadLabel = next.label !== undefined;
    if (!label) {
      if (hadLabel) {
        delete next.label;
        changed = true;
      }
    } else if (next.label !== label) {
      next.label = label;
      changed = true;
    }
    // Every caller of this patch is a person or an explicit agent action, so
    // automatic naming stops for this row. A label with no source is manual;
    // a cleared one records that choice. Clearing a row that never had a
    // label leaves it eligible.
    if (label) {
      if (next.labelSource !== undefined || next.labelProvisional) {
        delete next.labelSource;
        delete next.labelProvisional;
        changed = true;
      }
    } else if (hadLabel || next.labelSource === 'generated') {
      if (next.labelSource !== 'manual') {
        next.labelSource = 'manual';
        changed = true;
      }
      if (next.labelProvisional) {
        delete next.labelProvisional;
        changed = true;
      }
    }
  }
  if (patch.hidden === true && next.hidden !== true) {
    next.hidden = true;
    changed = true;
  } else if (patch.hidden === false && next.hidden !== undefined) {
    delete next.hidden;
    changed = true;
  }
  if (patch.pinned === true && next.pinned !== true) {
    next.pinned = true;
    changed = true;
  } else if (patch.pinned === false && next.pinned === true) {
    delete next.pinned;
    changed = true;
  }
  if (patch.branchGroupingOverride === null) {
    if (next.branchGroupingOverride !== undefined) {
      delete next.branchGroupingOverride;
      changed = true;
    }
  } else if (
    patch.branchGroupingOverride !== undefined &&
    next.branchGroupingOverride !== patch.branchGroupingOverride
  ) {
    next.branchGroupingOverride = patch.branchGroupingOverride;
    changed = true;
  }

  const retargetsBase =
    patch.trackedBaseBranch !== undefined ||
    patch.trackedRepoBaseBranches !== undefined;
  if (patch.trackedBaseBranch !== undefined) {
    if (next.trackedBaseBranch !== patch.trackedBaseBranch) {
      next.trackedBaseBranch = patch.trackedBaseBranch;
      changed = true;
    }
  }
  if (patch.trackedRepoBaseBranches !== undefined) {
    const bases: Record<string, string> = {
      ...next.trackedRepoBaseBranches,
    };
    for (const [repoId, base] of Object.entries(
      patch.trackedRepoBaseBranches,
    )) {
      if (base === null) {
        if (repoId in bases) {
          delete bases[repoId];
          changed = true;
        }
      } else if (bases[repoId] !== base) {
        bases[repoId] = base;
        changed = true;
      }
    }
    if (Object.keys(bases).length > 0) {
      next.trackedRepoBaseBranches = bases;
    } else if (next.trackedRepoBaseBranches !== undefined) {
      delete next.trackedRepoBaseBranches;
      changed = true;
    }
  }
  // A user-chosen base replaces the visual parent an automatic merge
  // retarget left behind.
  if (retargetsBase && next.branchGroupingParentWorktreeId !== undefined) {
    delete next.branchGroupingParentWorktreeId;
    changed = true;
  }

  return changed ? next : worktree;
}

/** The typed projection of a persisted row's patchable fields. */
export function projectWorktreeMetadata(
  worktree: WorktreeData,
): WorktreeMetadata {
  return {
    label: worktree.label ?? null,
    hidden: worktree.hidden === true,
    pinned: worktree.pinned === true,
    branchGroupingOverride: worktree.branchGroupingOverride ?? null,
    trackedBaseBranch: worktree.trackedBaseBranch ?? null,
    trackedRepoBaseBranches: { ...worktree.trackedRepoBaseBranches },
  };
}

/**
 * The typed in-process worktree update boundary (CAN-3810). The renderer's
 * label, hidden, pinned and branch-grouping changes go through it, so the
 * patch semantics of `core.worktree.update` live in one place. Admission
 * (ids, the read-only shared-container scope, the closed request and patch)
 * runs before the worktree list is read; the patch is applied under the
 * per-workspace list lock in one commit, with optional revisions. A keyed
 * update's receipt and outcome join that commit, so a same-key retry replays
 * it (CAN-3805, CAN-4393). `wire` is the registered operation's wire call
 * (W7b-1b); compatibility callers omit it.
 */
export async function updateWorktree(
  request: WorktreeUpdateRequest,
  wire?: W5WireDecisionCall<WorktreeUpdateOutcome>,
): Promise<WorktreeUpdateOutcome> {
  const { workspaceId, worktreeId } = request;
  admitScope(workspaceId);
  validateId(worktreeId, 'worktreeId');
  if (!worktreeUpdateRequestSchema.safeParse(request).success)
    refuse('invalid-patch', 'Invalid worktree update request');
  request.worktreeOrder?.forEach((id, index) =>
    validateId(id, `worktreeOrder[${index}]`),
  );
  const admittedPatch = admitPatch(request.patch);

  const { expectedRevision, idempotencyKey, ...parameters } = request;
  return worktreeMetadataRunner(wire)(
    {
      operation: 'core.worktree.update',
      source: 'worktree-metadata',
      idempotencyKey,
      parameters: () => ({ ...parameters, patch: admittedPatch }),
    },
    () => Promise.resolve(admittedPatch),
    wireW5Decode(decodeW5WorktreeUpdateOutcome, wire),
    (patch, options, save) => {
      async function stageWorktreeUpdate(): Promise<WorktreeUpdateOutcome> {
        await checkW5ExpectedRevision(
          { kind: 'worktree', workspaceId, worktreeId },
          expectedRevision,
        );
        const result: { worktree?: WorktreeData; changed: boolean } = {
          changed: false,
        };
        await updateWorkspaceWorktrees(
          workspaceId,
          (worktrees) => {
            const index = worktrees.findIndex(
              (worktree) => worktree.id === worktreeId,
            );
            const target = worktrees[index];
            if (
              !target ||
              (request.expectedCreatedAt !== undefined &&
                target.createdAt !== request.expectedCreatedAt)
            )
              refuse(
                'not-found',
                `Worktree ${worktreeId} not found in project ${workspaceId}`,
              );
            const next = applyWorktreeMetadataPatch(target, patch);
            result.worktree = next;
            result.changed = next !== target;
            const patched = result.changed
              ? worktrees.map((worktree, position) =>
                  position === index ? next : worktree,
                )
              : worktrees;
            return reorderWorktreesById(patched, request.worktreeOrder);
          },
          request.expectedCreatedAt === undefined
            ? undefined
            : { requireAuthoritativeRead: true, requireExistingRead: true },
        );
        const { worktree } = result;
        if (!worktree) {
          refuse(
            'not-found',
            `Worktree ${worktreeId} not found in project ${workspaceId}`,
          );
        }
        return save({ worktree, changed: result.changed });
      }
      return withW5Commit(
        {
          ...options,
          locks: [
            { kind: 'list', path: w5RecordReadPaths.worktrees(workspaceId) },
          ],
          expectedRevisions: w5ExpectedRevision(
            { kind: 'worktree', workspaceId, worktreeId },
            expectedRevision,
          ),
        },
        stageWorktreeUpdate,
      );
    },
  );
}

/**
 * Moves one visible row onto another's position (`core.worktree.reorder`),
 * keeping hidden rows in their slots. Refuses when either row is unknown or
 * hidden; a move onto itself writes nothing. A keyed move's receipt joins the
 * list commit, so a same-key retry never moves the row again (CAN-4393).
 * `wire` is the registered operation's wire call (W7b-1b).
 */
export async function moveWorktree(
  request: WorktreeMoveRequest,
  wire?: W5WireDecisionCall<void>,
): Promise<void> {
  const { workspaceId, activeWorktreeId, overWorktreeId } = request;
  admitScope(workspaceId);
  validateId(activeWorktreeId, 'activeWorktreeId');
  validateId(overWorktreeId, 'overWorktreeId');
  const admitted = worktreeMoveRequestSchema.safeParse(request);
  if (!admitted.success)
    refuse('invalid-patch', 'Invalid worktree reorder request');

  const { expectedRevision, idempotencyKey, ...parameters } = admitted.data;
  return worktreeMetadataRunner(wire)(
    {
      operation: 'core.worktree.reorder',
      source: 'worktree-metadata',
      idempotencyKey,
      parameters: () => parameters,
    },
    () => Promise.resolve(),
    // The saved outcome is `null`; it replays as `undefined`.
    (): void => undefined,
    (_admitted, options, save) => {
      async function stageWorktreeMove(): Promise<void> {
        await checkW5ExpectedRevision(
          { kind: 'worktrees', workspaceId },
          expectedRevision,
        );
        let found = false;
        await updateWorkspaceWorktrees(workspaceId, (worktrees) => {
          const visible = worktrees.filter((worktree) => !worktree.hidden);
          const oldIndex = visible.findIndex(
            (worktree) => worktree.id === activeWorktreeId,
          );
          const newIndex = visible.findIndex(
            (worktree) => worktree.id === overWorktreeId,
          );
          if (oldIndex < 0 || newIndex < 0) return worktrees;
          found = true;
          if (oldIndex === newIndex) return worktrees;
          const reordered = visible.slice();
          const [moved] = reordered.splice(oldIndex, 1);
          if (!moved) return worktrees;
          reordered.splice(newIndex, 0, moved);
          let visibleIndex = 0;
          return worktrees.map((worktree) => {
            if (worktree.hidden) return worktree;
            const replacement = reordered[visibleIndex];
            visibleIndex += 1;
            return replacement ?? worktree;
          });
        });
        if (!found) refuse('not-found', 'Worktree to reorder was not found.');
        save(undefined);
      }
      return withW5Commit(
        {
          ...options,
          locks: [
            { kind: 'list', path: w5RecordReadPaths.worktrees(workspaceId) },
          ],
          expectedRevisions: w5ExpectedRevision(
            { kind: 'worktrees', workspaceId },
            expectedRevision,
          ),
        },
        stageWorktreeMove,
      );
    },
  );
}

/** The worktree order part of a desktop sidebar group transaction (CAN-3818). */
export interface WorktreeGroupMembershipReorderRequest {
  source: 'sidebar_item_groups';
  workspaceId: string;
  /** Both membership and order are decided from the rows under the list lock. */
  decide: (rows: readonly WorktreeData[]) => Promise<{
    order: readonly string[];
    commitMembership: () => Promise<void>;
    /** Stack children the move unstacked from their base to group them. */
    ungroupItemIds?: readonly string[];
  }>;
}

/**
 * A desktop-only, unkeyed host command, not part of `core.worktree.reorder`
 * (A22(a), CAN-4718): commits the group membership before publishing its
 * order. A failed membership reconciliation leaves the list unchanged. The
 * two files are not atomic: a later list write failure can leave the sidecar
 * advanced, the retained compatibility behavior.
 */
export async function reorderWorktreeGroupMembership(
  request: WorktreeGroupMembershipReorderRequest,
): Promise<void> {
  validateId(request.workspaceId, 'workspaceId');
  if (request.source !== 'sidebar_item_groups')
    refuse('invalid-patch', 'Unknown sidebar group source');
  try {
    await updateWorkspaceWorktrees(
      request.workspaceId,
      async (rows) => {
        const { order, commitMembership, ungroupItemIds } =
          await request.decide(rows);
        order.forEach((id) => validateId(id, 'worktreeId'));
        const rowIds = new Set(rows.map((row) => row.id));
        if (
          order.length !== rows.length ||
          new Set(order).size !== rows.length ||
          order.some((id) => !rowIds.has(id))
        ) {
          throw new WorktreeUpdateRefusedError(
            'invalid-patch',
            'Sidebar order contains an unknown item',
          );
        }
        // No list change reaches storage if the sidecar cannot be reconciled.
        await commitMembership();
        const ungrouped = new Set(ungroupItemIds);
        return reorderWorktreesById(rows, order).map((row) =>
          ungrouped.has(row.id)
            ? { ...row, branchGroupingOverride: 'ungroup' as const }
            : row,
        );
      },
      {
        groupMutation: true,
        requireAuthoritativeRead: true,
        requireExistingRead: true,
      },
    );
  } catch (error) {
    if (error instanceof WorktreeRegistryUnreadableError)
      refuse('worktrees-unavailable', error.message);
    throw error;
  }
}
