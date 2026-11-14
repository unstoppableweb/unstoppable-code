import { randomUUID } from 'node:crypto';
import { readFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import {
  AutoDeleteAttentionSchema,
  type AutoDeleteAttention,
} from '@canopy/protocol/portal/auto-delete-attention';
import type { WorktreeRecoveryDescription } from '@canopy/protocol/portal/worktree-recovery';
import { getAutoDeleteAttentionFilePath } from './paths';
import { writeFileAtomically } from './atomic-file';
import { isErrnoException } from './type-guards';

const stateSchema = z.object({
  version: z.literal(1),
  incidents: z
    .array(
      z.object({
        attention: AutoDeleteAttentionSchema,
        generation: z.string().optional(),
        completedBefore: z.array(z.string().max(200)).max(10_000).optional(),
        operationIds: z.array(z.string().max(200)).max(20),
      }),
    )
    .max(10_000),
});
type State = z.infer<typeof stateSchema>;
const listeners = new Set<(workspaceId: string) => void>();
let tail: Promise<unknown> = Promise.resolve();
let projectionCache: { path: string; state: Promise<State> } | undefined;

function readProjection(): Promise<State> {
  const path = getAutoDeleteAttentionFilePath();
  if (projectionCache?.path === path) return projectionCache.state;
  const state: Promise<State> = read().catch((error: unknown) => {
    if (projectionCache?.state === state) projectionCache = undefined;
    throw error;
  });
  projectionCache = { path, state };
  return state;
}

async function read(): Promise<State> {
  try {
    return stateSchema.parse(
      JSON.parse(await readFile(getAutoDeleteAttentionFilePath(), 'utf8')),
    );
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT')
      return { version: 1, incidents: [] };
    // Delivery history must not silently reset after a damaged read.
    throw error;
  }
}

async function mutate(run: (state: State) => string[]): Promise<void> {
  const next = tail.then(async () => {
    const state = await read();
    const before = JSON.stringify(state);
    const visibleBefore = JSON.stringify(
      state.incidents.map((row) => row.attention),
    );
    const changed = run(state);
    if (before === JSON.stringify(state)) return;
    if (!changed.length) return;
    const path = getAutoDeleteAttentionFilePath();
    await mkdir(dirname(path), { recursive: true });
    const validated = stateSchema.parse(state);
    await writeFileAtomically(path, `${JSON.stringify(validated)}\n`);
    projectionCache = { path, state: Promise.resolve(validated) };
    if (
      visibleBefore ===
      JSON.stringify(validated.incidents.map((row) => row.attention))
    )
      return;
    for (const workspaceId of new Set(changed))
      for (const listener of listeners) listener(workspaceId);
  });
  tail = next.catch(() => {
    projectionCache = undefined;
  });
  return next;
}

export function subscribeAutoDeleteAttention(
  listener: (workspaceId: string) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

async function readWorkspaceAttention(
  workspaceIds: readonly string[],
): Promise<AutoDeleteAttention[]> {
  await tail;
  const allowed = new Set(workspaceIds);
  return (await readProjection()).incidents
    .map((row) => row.attention)
    .filter((row) => allowed.has(row.workspaceId));
}

/** Read-only projection; lifecycle owners retire replaced incarnations. */
export async function projectAutoDeleteAttention(
  workspaceIds: readonly string[],
  incarnations: readonly {
    workspaceId: string;
    worktreeId: string;
    createdAt: string;
  }[],
): Promise<AutoDeleteAttention[]> {
  const current = new Map<string, string>(
    incarnations.map((row) => [
      JSON.stringify([row.workspaceId, row.worktreeId]),
      row.createdAt,
    ]),
  );
  return structuredClone(
    (await readWorkspaceAttention(workspaceIds))
      .filter((row) => {
        if (row.kind !== 'worktree') return true;
        const createdAt = current.get(
          JSON.stringify([row.workspaceId, row.worktreeId]),
        );
        return createdAt === undefined || createdAt === row.createdAt;
      })
      .slice(0, 100),
  );
}

/** Policy enumeration must not lose row-less cleanups to the UI's page bound. */
export async function listAutoDeleteRecoveryCandidates(
  workspaceIds: readonly string[],
): Promise<AutoDeleteAttention[]> {
  return structuredClone(
    (await readWorkspaceAttention(workspaceIds)).filter(
      (row) => row.kind === 'worktree',
    ),
  );
}

export async function listAutoDeleteAttention(
  workspaceIds: readonly string[],
  subject?: { worktreeId: string; createdAt: string },
): Promise<AutoDeleteAttention[]> {
  return structuredClone(
    (await readWorkspaceAttention(workspaceIds))
      .filter(
        (row) =>
          !subject ||
          (row.kind === 'worktree' &&
            row.worktreeId === subject.worktreeId &&
            row.createdAt === subject.createdAt),
      )
      .slice(0, 100),
  );
}

/** Identity follows the unresolved incarnation, not a replaceable journal. */
export async function recordAutoDeleteAttention(
  subject: {
    workspaceId: string;
    worktreeId: string;
    createdAt: string;
    worktreeName: string;
  },
  recovery: WorktreeRecoveryDescription,
  completedBefore?: readonly string[],
): Promise<boolean> {
  let fresh = false;
  await mutate((state) => {
    const reason = {
      code: recovery.code,
      intent: recovery.intent,
      stoppingPoint: recovery.stoppingPoint,
    };
    const review =
      recovery.destination.kind === 'journal-review'
        ? recovery.destination.reason
        : null;
    let incident = state.incidents.find(
      ({ attention }) =>
        attention.workspaceId === subject.workspaceId &&
        (review
          ? attention.kind === 'journal-review'
          : attention.kind === 'worktree' &&
            attention.worktreeId === subject.worktreeId &&
            attention.createdAt === subject.createdAt),
    );
    if (!incident) {
      fresh = true;
      const attention: AutoDeleteAttention = review
        ? {
            kind: 'journal-review',
            id: randomUUID(),
            workspaceId: subject.workspaceId,
            review,
            reason,
          }
        : {
            kind: 'worktree',
            id: randomUUID(),
            ...subject,
            worktreeName: subject.worktreeName.slice(0, 500),
            reason,
          };
      incident = { attention, operationIds: [] };
      state.incidents.push(incident);
    } else {
      // Journal withdrawal loses the step; it does not erase the explanation.
      if (
        reason.stoppingPoint.phase !== 'unknown' ||
        incident.attention.reason.stoppingPoint.phase === 'unknown'
      )
        incident.attention.reason = reason;
      if (incident.attention.kind === 'worktree')
        incident.attention.worktreeName = subject.worktreeName.slice(0, 500);
      if (incident.attention.kind === 'journal-review' && review)
        incident.attention.review = review;
    }
    incident.generation = randomUUID();
    const newJournal =
      recovery.evidence.kind === 'journal' &&
      incident.operationIds[incident.operationIds.length - 1] !==
        recovery.evidence.operationId;
    if (
      completedBefore &&
      (incident.completedBefore === undefined || newJournal)
    )
      incident.completedBefore = [
        ...new Set([...(incident.completedBefore ?? []), ...completedBefore]),
      ];
    if (recovery.evidence.kind === 'journal')
      incident.operationIds = [
        ...new Set([...incident.operationIds, recovery.evidence.operationId]),
      ].slice(-20);
    return [subject.workspaceId];
  });
  return fresh;
}

export interface AutoDeleteAttentionGeneration {
  id: string;
  generation: string;
  attention: AutoDeleteAttention;
  operationIds: string[];
  completedBefore?: string[];
}

/** Capture before observing evidence or starting a removal, never at finalization. */
export async function captureAutoDeleteAttention(
  workspaceId: string,
): Promise<AutoDeleteAttentionGeneration[]> {
  await tail;
  return structuredClone(
    (await readProjection()).incidents
      .filter((row) => row.attention.workspaceId === workspaceId)
      .map((row) => ({
        id: row.attention.id,
        generation: row.generation ?? row.attention.id,
        attention: row.attention,
        operationIds: row.operationIds,
        ...(row.completedBefore
          ? { completedBefore: row.completedBefore }
          : {}),
      })),
  );
}

function observedGeneration(
  row: State['incidents'][number],
  observed: readonly AutoDeleteAttentionGeneration[],
): boolean {
  return observed.some(
    (token) =>
      token.id === row.attention.id &&
      token.generation === (row.generation ?? row.attention.id),
  );
}

/** Requires removal/replacement proof, or a live checkout with no lifecycle evidence. */
export async function resolveAutoDeleteAttention(
  workspaceId: string,
  worktreeId: string,
  createdAt: string,
  replaced: boolean,
  observed: readonly AutoDeleteAttentionGeneration[],
): Promise<void> {
  await mutate((state) => {
    const before = state.incidents.length;
    state.incidents = state.incidents.filter((row) => {
      const { attention } = row;
      return !(
        observedGeneration(row, observed) &&
        attention.kind === 'worktree' &&
        attention.workspaceId === workspaceId &&
        attention.worktreeId === worktreeId &&
        (replaced
          ? attention.createdAt !== createdAt
          : attention.createdAt === createdAt)
      );
    });
    return before === state.incidents.length ? [] : [workspaceId];
  });
}

/** A readable global scan resolves only the unattributable blocker, not worktrees. */
export async function resolveAutoDeleteJournalAttention(
  workspaceId: string,
  observed: readonly AutoDeleteAttentionGeneration[],
): Promise<void> {
  await mutate((state) => {
    const before = state.incidents.length;
    state.incidents = state.incidents.filter(
      (row) =>
        row.attention.workspaceId !== workspaceId ||
        row.attention.kind !== 'journal-review' ||
        !observedGeneration(row, observed),
    );
    return before === state.incidents.length ? [] : [workspaceId];
  });
}

/** Compatibility entry point: supplied rows identify targets, never prove replacement. */
export async function retireReplacedAutoDeleteAttention(
  subjects: readonly {
    workspaceId: string;
    worktreeId: string;
    createdAt: string;
  }[],
): Promise<void> {
  const { withArchivedWorkspaceOperationLock } =
    await import('./archived-containers');
  const { readWorkspaceWorktreesDetailed } =
    await import('./workspace-persistence');
  for (const subject of subjects) {
    await withArchivedWorkspaceOperationLock(subject.workspaceId, async () => {
      const generations = await captureAutoDeleteAttention(subject.workspaceId);
      const inventory = await readWorkspaceWorktreesDetailed(
        subject.workspaceId,
        {
          persistRemovalCleanup: false,
          includeRecentlyRemoved: true,
        },
      );
      if (inventory.authority !== 'ok') return;
      const current = inventory.worktrees.find(
        (row) => row.id === subject.worktreeId,
      );
      if (current)
        await resolveAutoDeleteAttention(
          subject.workspaceId,
          subject.worktreeId,
          current.createdAt,
          true,
          generations,
        );
    });
  }
}
