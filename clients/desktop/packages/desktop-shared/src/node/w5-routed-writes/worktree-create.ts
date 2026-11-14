import { isDeepStrictEqual } from 'node:util';
import { admitRoutedW5Storage } from './record-store';
import type { W5CommitOptions } from '@canopy/core-runtime/node/w5/commit-scope';
import type { W5CommitLogFileStore } from '@canopy/core-runtime/node/w5/commit-log-file-store';
import { createW5KeyedOperationRunner } from '@canopy/core-runtime/node/w5/keyed-operation';
import { createW5DecisionOnlyRetry } from '@canopy/core-runtime/node/w5/workspace-metadata/retry';
import { decodeW5WorktreeOutcome } from '@canopy/core-runtime/node/w5/worktree-outcome';
import type { WorkspaceCreationDiagnostics } from '@canopy/core-runtime/node/w5/commit-log/reservation-diagnostics';
import {
  applyReservedWorktreeRecordTo,
  applyWorktreeCreationReservationTo,
} from '../worktree-record-decision-apply';
import type { WorktreeCreationPromoteDecision } from '../worktree-record-decisions';
import { getWorkspaceItem } from '../lib/workspace-cli-reads';
import {
  getSingleRepoWorktreeDir,
  getWorktreesFilePath,
  multiRepoGitEntries,
} from '../lib/worktree-cli-reads';
import { updateCliWorktreeList } from '../lib/worktree-create-records';
import {
  createWorktreeGit,
  proveFailedWorktreeCreationAbsent,
  makeWorktreeId,
  normalizeBranchName,
  buildTrackedRepoBaseBranches,
  seedCreatedWorktreePanelLayoutMode,
} from '../lib/worktree-create-effects';
import type { CreateWorktreeServiceOptions } from '../lib/worktree-service';
import { isRecord } from '@canopy/execution-engine/node/lib/type-guards';
import type { WorktreeData } from '../../types';
import { acquireW5DesktopDeleteGate } from '@canopy/core-platform/w5-process-file-lock';
import { getCanopyDataDir } from '@canopy/execution-engine/canopy-paths';
import { validateId } from '@canopy/execution-engine/node/lib/validation';
import { assertNoConflictingW5Reservation } from './worktree-delete-records';

async function readReservedImage(
  store: W5CommitLogFileStore,
  workspaceId: string,
  worktreeId: string,
): Promise<Record<string, unknown>> {
  const read = await store.read(getWorktreesFilePath(workspaceId));
  if (read.state !== 'present')
    throw new Error('Reserved worktree is unreadable');
  const document: unknown = JSON.parse(read.raw);
  if (!isRecord(document) || !Array.isArray(document.worktrees))
    throw new Error('Reserved worktree is unreadable');
  const row: unknown = document.worktrees.find(
    (value: unknown) => isRecord(value) && value.id === worktreeId,
  );
  if (!isRecord(row)) throw new Error('Reserved worktree is no longer tracked');
  return row;
}

export class CliWorktreeCoworkError extends Error {
  constructor(workspaceId: string) {
    super(`Project ${workspaceId} is not single-repo`);
    this.name = 'CliWorktreeCoworkError';
  }
}

/** W6h1: only the reserve and promote units retry; Git is never replayed. */
export function createRoutedCliWorktree(
  options: CreateWorktreeServiceOptions,
  context: {
    store: W5CommitLogFileStore;
    idempotencyKey: string;
    signal: AbortSignal;
    /** Acknowledged durable outcome, before optional sidecar work. */
    onOutcome?: (outcome: WorktreeData) => void;
  },
): Promise<WorktreeData> {
  const { store, signal } = context;
  const retry = createW5DecisionOnlyRetry();
  const initialDiagnostics: WorkspaceCreationDiagnostics = {
    kind: 'local-workspace-create',
    workspaceId: options.workspaceId,
    ownedPaths: [],
    phase: 'before-canonical-commit',
  };
  const keyed = createW5KeyedOperationRunner({
    getReceiptStore: () => ({
      lookupReceipt: (
        receipt,
      ): ReturnType<W5CommitLogFileStore['lookupReceipt']> =>
        store.lookupReceipt(receipt),
      reserve: (input): Promise<void> =>
        store.reserve({ ...input, diagnostics: initialDiagnostics }),
      releaseReservation: (id): Promise<void> => store.releaseReservation(id),
      markReservationRecoveryRequired: (id, diagnostics): Promise<void> =>
        store.markReservationRecoveryRequired(id, diagnostics),
    }),
  });
  return admitRoutedW5Storage(
    [{ namespace: 'worktree_list', writer: 'desktop_cli' }],
    () =>
      keyed(
        {
          // The authority binds this source to the authenticated principal.
          caller: 'worktree-create',
          operation: 'core.worktree.create',
          idempotencyKey: context.idempotencyKey,
          parameters: {
            workspaceId: options.workspaceId,
            branchName: options.branchName,
            baseBranch: options.baseBranch,
            repairWorkspaceRoot: options.repairWorkspaceRoot,
            restoreClaudeMd: options.restoreClaudeMd,
          },
          isPreEffectRefusal: () => false,
          hold: async (run) => {
            validateId(options.workspaceId, 'workspaceId');
            const gate = await acquireW5DesktopDeleteGate(
              getCanopyDataDir(),
              'desktop',
            );
            try {
              signal.throwIfAborted();
              await assertNoConflictingW5Reservation(
                store,
                options.workspaceId,
                undefined,
                'core.worktree.delete',
              );
              return await run();
            } finally {
              gate.close();
            }
          },
        },
        decodeW5WorktreeOutcome,
        async (binding, attempt) => {
          const workspace = await getWorkspaceItem(
            options.workspaceId,
            store,
          ).catch((error: unknown) => {
            throw attempt.validationError(
              error instanceof Error ? error : new Error(String(error)),
            );
          });
          if (workspace.type === 'cowork')
            throw attempt.validationError(
              new CliWorktreeCoworkError(options.workspaceId),
            );
          const explicitBranch = normalizeBranchName(options.branchName);
          const operationId = binding.reservationId;
          if (!operationId) throw new Error('Missing worktree reservation');
          const createdAt = new Date().toISOString();
          const reservationCommit: W5CommitOptions = {
            operation: 'internal.cli.worktree.reserve',
            beforeDecision: () => signal.throwIfAborted(),
          };
          const { worktree, reservedWorktree } = await retry.run(
            'cli worktree reserve',
            () =>
              store.withCommit(reservationCommit, async () => {
                const worktree = await updateCliWorktreeList(
                  store,
                  workspace.id,
                  (rows) => {
                    // H10: allocate against the authoritative image on each decision attempt.
                    const id = makeWorktreeId(
                      rows.map((row) => row.id),
                      explicitBranch,
                    );
                    const entries =
                      workspace.type === 'single-repo'
                        ? [
                            {
                              repoPath: workspace.repoPath,
                              worktreePath: getSingleRepoWorktreeDir(
                                workspace.id,
                                id,
                              ),
                            },
                          ]
                        : multiRepoGitEntries(workspace, id);
                    const row: WorktreeData = {
                      id,
                      branchName: explicitBranch ?? id,
                      createdAt,
                      setupPhase: 'git-pending',
                      creation: {
                        operationId,
                        state: 'pending',
                        phase: 'reserved',
                        checkouts: entries.map((entry) => ({
                          repositoryPath: entry.repoPath,
                          checkoutPath: entry.worktreePath,
                        })),
                      },
                    };
                    const decision = applyWorktreeCreationReservationTo(rows, {
                      kind: 'worktree.create.reserve',
                      worktree: row,
                    });
                    if ('refusal' in decision)
                      throw attempt.validationError(
                        new Error(
                          decision.refusal.reason === 'branch-reserved'
                            ? rows.some(
                                (existing) =>
                                  existing.branchName === row.branchName &&
                                  (!existing.creation ||
                                    existing.creation.state === 'complete'),
                              )
                              ? `a branch named '${row.branchName}' already exists`
                              : `Branch ${row.branchName} is already reserved`
                            : 'Checkout is already reserved',
                        ),
                      );
                    if (decision.status !== 'reserved')
                      throw attempt.validationError(
                        new Error('Worktree ID collision'),
                      );
                    return { rows: decision.worktrees, value: row };
                  },
                );
                return {
                  worktree,
                  reservedWorktree: await readReservedImage(
                    store,
                    workspace.id,
                    worktree.id,
                  ),
                };
              }),
          );
          attempt.beforeEffects();
          const diagnostics: WorkspaceCreationDiagnostics = {
            kind: 'local-workspace-create',
            workspaceId: workspace.id,
            ownedPaths:
              worktree.creation?.checkouts.map(
                (checkout) => checkout.checkoutPath,
              ) ?? [],
            phase: 'before-canonical-commit',
          };
          await store.updateReservationDiagnostics(operationId, diagnostics);
          signal.throwIfAborted();
          try {
            await createWorktreeGit(workspace, worktree, options, signal);
          } catch (error) {
            if (
              error instanceof Error &&
              (await proveFailedWorktreeCreationAbsent(
                error,
                workspace,
                worktree,
                signal,
              ))
            ) {
              try {
                await retry.run('cli worktree no-effect refusal', () =>
                  store.withCommit(
                    {
                      operation: 'internal.cli.worktree.refused',
                      beforeDecision: () => signal.throwIfAborted(),
                    },
                    async () => {
                      const image = await readReservedImage(
                        store,
                        workspace.id,
                        worktree.id,
                      );
                      if (!isDeepStrictEqual(image, reservedWorktree))
                        throw new Error(
                          'Reserved worktree is no longer tracked',
                        );
                      return updateCliWorktreeList(
                        store,
                        workspace.id,
                        (rows) => {
                          const current = rows.find(
                            (row) => row.id === worktree.id,
                          );
                          return {
                            rows: rows.filter((row) => row !== current),
                            value: undefined,
                          };
                        },
                      );
                    },
                  ),
                );
                attempt.confirmEffectsAbsent(error);
              } catch {
                // Unconfirmed cleanup keeps the primary Git error and recovery evidence.
              }
            }
            throw error;
          }
          const promote: WorktreeCreationPromoteDecision =
            workspace.type === 'single-repo'
              ? {
                  kind: 'worktree.create.promote',
                  workspaceKind: 'single-repo',
                  branchName: worktree.branchName,
                  trackedBaseBranch: options.baseBranch,
                }
              : {
                  kind: 'worktree.create.promote',
                  workspaceKind: 'multi-repo',
                  branchName: worktree.branchName,
                  trackedRepoBaseBranches: buildTrackedRepoBaseBranches(
                    multiRepoGitEntries(workspace, worktree.id),
                    options.baseBranch,
                  ),
                };
          const outcome: WorktreeData = {
            id: worktree.id,
            branchName: worktree.branchName,
            createdAt,
            ...(promote.workspaceKind === 'single-repo'
              ? { trackedBaseBranch: promote.trackedBaseBranch }
              : { trackedRepoBaseBranches: promote.trackedRepoBaseBranches }),
            setupPhase: 'git-ready',
          };
          const finalizeCommit: W5CommitOptions = {
            ...binding,
            outcome,
            beforeDecision: () => signal.throwIfAborted(),
          };
          await retry.run('cli worktree finalize', () =>
            store.withCommit(finalizeCommit, () =>
              updateCliWorktreeList(store, workspace.id, (rows) => {
                const current = rows.find((row) => row.id === worktree.id);
                if (current?.creation?.operationId !== operationId)
                  throw new Error('Reserved worktree is no longer tracked');
                const decision = applyReservedWorktreeRecordTo(
                  rows,
                  worktree,
                  promote,
                );
                if ('refusal' in decision)
                  throw new Error('Branch is already reserved');
                if (!decision.updated)
                  throw new Error('Reserved worktree is no longer tracked');
                const promoted = decision.worktrees.find(
                  (row) => row.id === worktree.id,
                );
                if (!promoted)
                  throw new Error('Reserved worktree is no longer tracked');
                return {
                  rows: [
                    promoted,
                    ...decision.worktrees.filter((row) => row !== promoted),
                  ],
                  value: undefined,
                };
              }),
            ),
          );
          context.onOutcome?.(outcome);
          if (!signal.aborted)
            await seedCreatedWorktreePanelLayoutMode(options, worktree.id);
          return outcome;
        },
      ),
  );
}
