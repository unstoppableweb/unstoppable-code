import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  acquireW5DesktopDeleteGate,
  type W5DesktopDeleteGate,
} from '@canopy/core-platform/w5-process-file-lock';
import type { W5CommitLogFileStore } from '@canopy/core-runtime/node/w5/commit-log-file-store';
import type { W5CommitOptions } from '@canopy/core-runtime/node/w5/commit-scope';
import {
  createW5KeyedOperationRunner,
  type W5ReceiptStore,
} from '@canopy/core-runtime/node/w5/keyed-operation';
import { createW5DecisionOnlyRetry } from '@canopy/core-runtime/node/w5/workspace-metadata/retry';
import { isJsonObject } from '@canopy/core-runtime/node/w5/file-store';
import type { WorkspaceCreationDiagnostics } from '@canopy/core-runtime/node/w5/commit-log/reservation-diagnostics';
import { getCanopyDataDir } from '@canopy/execution-engine/canopy-paths';
import type { ArchiveWorktreeResponse } from '../../types';
import { admitRoutedW5Storage } from './record-store';
import {
  lockCheckout,
  updateCliWorktreeList,
} from '../lib/worktree-create-records';
import { validateId } from '@canopy/execution-engine/node/lib/validation';
import { removeGitWorktree } from '../lib/worktree-create-effects';
import { removePersistedWorktreeDataDirectory } from '../lib/worktree-data-cleanup';
import { BrowserProfileRepository } from '../browser-profiles/repository';
import {
  DEFERRED_BROWSER_RETIREMENT_WARNING,
  prepareBrowserTaskRetirement,
} from '../browser-profiles/lifecycle';
import {
  type WorktreeDeletePlan,
  assertDeleteLifecycleClear,
  assertDeleteTargetUnaliased,
  assertNoConflictingW5Reservation,
  deletionRecordPaths,
  deleteRefusal,
  readWorktreeDeletePlan,
} from './worktree-delete-records';

const SIDECAR_WARNING =
  'Any remaining chats, summaries and observability sidecars need desktop reconciliation the next time the app starts.';

function decodeOutcome(value: unknown): ArchiveWorktreeResponse {
  if (
    !isJsonObject(value) ||
    typeof value.success !== 'boolean' ||
    !Array.isArray(value.warnings)
  )
    throw new Error(
      'The saved deletion result is unreadable. Keep the idempotency key for diagnosis.',
    );
  const warnings: string[] = [];
  for (const warning of value.warnings) {
    if (typeof warning !== 'string')
      throw new Error('The saved deletion warnings are unreadable.');
    warnings.push(warning);
  }
  return { success: value.success, warnings };
}

/** I3/A14′: one admitted CLI hard delete; never a retained-container writer. */
export function deleteRoutedCliWorktree(
  options: { workspaceId: string; worktreeId: string },
  context: {
    store: W5CommitLogFileStore;
    idempotencyKey: string;
    signal: AbortSignal;
  },
): Promise<ArchiveWorktreeResponse> {
  const { store, signal } = context;
  const diagnostics: WorkspaceCreationDiagnostics = {
    kind: 'local-workspace-create',
    workspaceId: options.workspaceId,
    ownedPaths: [],
    phase: 'before-canonical-commit',
  };
  let admission: W5DesktopDeleteGate | undefined;
  let protectedReservation: string | undefined;
  const keyed = createW5KeyedOperationRunner({
    getReceiptStore: (): W5ReceiptStore => ({
      lookupReceipt: (
        receipt,
      ): ReturnType<W5CommitLogFileStore['lookupReceipt']> =>
        store.lookupReceipt(receipt),
      reserve: async (input): Promise<void> => {
        await store.reserve({ ...input, diagnostics });
        if (!admission) throw new Error('Missing deletion admission');
        admission.protectReservation(input.reservationId);
        protectedReservation = input.reservationId;
      },
      releaseReservation: async (id): Promise<void> => {
        await store.releaseReservation(id);
        admission?.completeReservation(id);
        protectedReservation = undefined;
      },
      markReservationRecoveryRequired: (id, failure): Promise<void> =>
        store.markReservationRecoveryRequired(id, failure),
    }),
  });
  return admitRoutedW5Storage(
    [{ namespace: 'worktree_list', writer: 'desktop_cli' }],
    () =>
      keyed(
        {
          caller: 'worktree-delete',
          operation: 'core.worktree.delete',
          idempotencyKey: context.idempotencyKey,
          parameters: options,
          isPreEffectRefusal: () => false,
          // Receipt replay precedes presence admission, even after the owner was removed.
          hold: async (run) => {
            validateId(options.workspaceId, 'workspaceId');
            validateId(options.worktreeId, 'worktreeId');
            const gate = await acquireW5DesktopDeleteGate(
              getCanopyDataDir(),
              'delete',
            );
            admission = gate;
            try {
              signal.throwIfAborted();
              await assertNoConflictingW5Reservation(
                store,
                options.workspaceId,
              );
              const result = await lockCheckout(
                options.workspaceId,
                options.worktreeId,
                run,
              );
              if (protectedReservation)
                gate.completeReservation(protectedReservation);
              return result;
            } finally {
              admission = undefined;
              gate.close();
            }
          },
        },
        decodeOutcome,
        async (binding, attempt) => {
          const reservationId = binding.reservationId;
          if (!reservationId)
            throw attempt.validationError(
              new Error('Missing deletion reservation'),
            );
          const revisions = await store
            .readRevisions([
              { kind: 'workspace', workspaceId: options.workspaceId },
              {
                kind: 'worktree',
                workspaceId: options.workspaceId,
                worktreeId: options.worktreeId,
              },
            ])
            .catch((error: unknown) => {
              throw attempt.validationError(
                error instanceof Error ? error : new Error(String(error)),
              );
            });
          const plan = await (async (): Promise<WorktreeDeletePlan> => {
            try {
              signal.throwIfAborted();
              const admitted = await readWorktreeDeletePlan(
                store,
                options.workspaceId,
                options.worktreeId,
              );
              await assertNoConflictingW5Reservation(
                store,
                options.workspaceId,
                reservationId,
              );
              await assertDeleteLifecycleClear(admitted);
              await assertDeleteTargetUnaliased(admitted.root);
              for (const checkout of admitted.checkouts)
                await assertDeleteTargetUnaliased(checkout.checkoutPath);
              await assertDeleteTargetUnaliased(
                join(
                  getCanopyDataDir(),
                  'workspaces',
                  options.workspaceId,
                  'worktree-data',
                  options.worktreeId,
                ),
              );
              // Diagnostics alone are safe to release, even if their reply is lost.
              await store.updateReservationDiagnostics(reservationId, {
                ...diagnostics,
                ownedPaths: [
                  ...new Set([
                    ...admitted.checkouts.map((entry) => entry.checkoutPath),
                    admitted.root,
                    join(
                      getCanopyDataDir(),
                      'workspaces',
                      options.workspaceId,
                      'worktree-data',
                      options.worktreeId,
                    ),
                  ]),
                ],
              });
              return admitted;
            } catch (error) {
              throw attempt.validationError(
                error instanceof Error ? error : new Error(String(error)),
              );
            }
          })();
          attempt.validate(() => signal.throwIfAborted());
          attempt.beforeEffects();
          const repository = new BrowserProfileRepository(
            join(getCanopyDataDir(), 'browser-profiles'),
          );
          let retirement: string | null = null;
          let browserDeferred = false;
          try {
            retirement = await prepareBrowserTaskRetirement(
              repository,
              getCanopyDataDir(),
              {
                scope: {
                  kind: 'worktree',
                  projectId: options.workspaceId,
                  worktreeId: options.worktreeId,
                },
                projectId: options.workspaceId,
                worktreeId: options.worktreeId,
                createdAt: plan.createdAt,
              },
              () => {
                // Cowork/App Advisor inventories are not served by W6g. Never substitute
                // local registries to prove this legacy locator has no colliding owner.
                throw deleteRefusal(
                  'Legacy browser ownership needs desktop reconciliation.',
                );
              },
            );
          } catch {
            browserDeferred = true;
          }
          for (const checkout of plan.checkouts) {
            signal.throwIfAborted();
            await removeGitWorktree(
              checkout.repositoryPath,
              checkout.checkoutPath,
            );
          }
          signal.throwIfAborted();
          if (plan.multiRepo)
            await rm(plan.root, { recursive: true, force: true });
          const paths = deletionRecordPaths(options.workspaceId);
          const removalCommit: W5CommitOptions = {
            operation: 'internal.cli.worktree.delete.remove',
            expectedRevisions: revisions,
            locks: [
              { kind: 'index', path: paths.index },
              { kind: 'manifest', path: paths.manifest },
              { kind: 'list', path: paths.list },
            ],
            fenceLockedFiles: true,
            beforeDecision: () => signal.throwIfAborted(),
          };
          await createW5DecisionOnlyRetry().run(
            'cli worktree delete finalize',
            () =>
              store.withCommit(removalCommit, async () => {
                const fresh = await readWorktreeDeletePlan(
                  store,
                  options.workspaceId,
                  options.worktreeId,
                );
                if (fresh.description !== plan.description)
                  throw deleteRefusal(
                    'The project or worktree changed during deletion. Preserve its files and key for manual recovery.',
                  );
                await updateCliWorktreeList(
                  store,
                  options.workspaceId,
                  (rows) => ({
                    rows: rows.filter((row) => row.id !== options.worktreeId),
                    value: undefined,
                  }),
                );
              }),
          );
          if (retirement) {
            try {
              await repository.commitRetirement(retirement, {
                kind: 'owner_removed',
                ownerOperationId: reservationId,
              });
            } catch {
              browserDeferred = true;
            }
          }
          const warnings = browserDeferred
            ? [DEFERRED_BROWSER_RETIREMENT_WARNING]
            : [];
          // Every successful headless deletion leaves these desktop-owned sidecars.
          warnings.push(SIDECAR_WARNING);
          signal.throwIfAborted();
          try {
            await removePersistedWorktreeDataDirectory(
              options.workspaceId,
              options.worktreeId,
            );
          } catch {
            warnings.push(
              'Failed to remove persisted worktree data. Desktop reconciliation must finish cleanup.',
            );
          }
          const outcome: ArchiveWorktreeResponse = { success: true, warnings };
          // Removal and outcome are separate: keep the reservation through all tails.
          await store.withCommit(
            {
              ...binding,
              outcome,
              beforeDecision: () => signal.throwIfAborted(),
            },
            (): Promise<void> => Promise.resolve(),
          );
          return outcome;
        },
      ),
  );
}
