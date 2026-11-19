import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';
import type { CanopyClient, SessionViewModel } from '@canopy/app-core';
import {
  offerWorktreeDiscard,
  registerArchiveRecoveryReview,
  useArchiveRecoveryReviewRequest,
} from '@canopy/app-state';
import { worktreeDiscardStoreFor } from '@canopy/app-state/worktree-discard';
import type { WorktreeRecoveryListResult } from '@canopy/protocol/canopy-core';
import type { W5RecoveryStatus } from '@canopy/protocol/remote-control/shell';
import { formatWorktreeRecoveryReason } from '@canopy/protocol/remote-control/shell/worktree-recovery';
import {
  Button,
  CodeBlock,
  ConfirmDialog,
  CopyButton,
  DialogModal,
  Disclosure,
  ErrorBanner,
  Heading,
  ListRowStatic,
  LoadingButton,
  Stack,
  type W5RecoveryNoticeProps,
} from '@canopy/ui-shared/components';
import {
  worktreeRecoveryResultCopy,
  worktreeRecoveryUnconfirmedCopy,
} from '@canopy/ui-shared/lib/worktree-discard-copy';
import { REPLAY_MASK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';

import {
  hasNewRecovery,
  dismissRecovery,
  hasRecoveryMaterial,
  needsRecoveryReview,
} from './recovery-attention';
import { WorkspaceRecoveryNotice } from './WorkspaceRecoveryNotice';
import type { WorkspaceRecoveryDismissalStore } from './recovery-dismissal-store';

const RECOVERY_CHECK_GAP_MS = 30_000;

type RecoveryWorkspace = Pick<
  SessionViewModel['workspaces'][number],
  'localId' | 'name' | 'placeholder' | 'sharedFrom' | 'backend'
> &
  Partial<Pick<SessionViewModel['workspaces'][number], 'type'>>;

/** Shell projections may omit workspace classification until it is loaded. */
export interface WorktreeRecoverySnapshot {
  readonly workspaces: readonly RecoveryWorkspace[];
  readonly worktrees: readonly Pick<
    SessionViewModel['worktrees'][number],
    'localId' | 'workspaceLocalId' | 'createdAt' | 'label' | 'branch'
  >[];
}

function isRecoveryWorkspace(workspace: RecoveryWorkspace): boolean {
  return (
    !workspace.placeholder &&
    !workspace.sharedFrom &&
    workspace.backend !== 'cloud' &&
    workspace.type !== 'cowork'
  );
}

export type RecoveryProject = Omit<WorktreeRecoveryListResult, 'check'> & {
  check: WorktreeRecoveryListResult['check'] | 'list-unavailable';
  workspaceId: string;
  name: string;
  worktrees: WorktreeRecoverySnapshot['worktrees'];
};
export type RecoveryHold = NonNullable<
  WorktreeRecoveryListResult['resolutions']
>[number] & { workspaceId: string };

function recoveryName(
  project: RecoveryProject,
  recovery: WorktreeRecoveryListResult['entries'][number],
): string {
  const row = project.worktrees.find(
    (worktree) => worktree.localId === recovery.subject.worktreeId,
  );
  if (!row)
    return recovery.check === 'completed-turn-diff-cleanup'
      ? 'Removed worktree'
      : 'Unlisted worktree';
  if (row.createdAt !== recovery.subject.createdAt)
    return 'Earlier archive attempt';
  return row.label || row.branch;
}

function archiveReference(
  recovery: WorktreeRecoveryListResult['entries'][number],
): string | undefined {
  const reference =
    recovery.diagnosis?.operationId ??
    (recovery.evidence.kind === 'journal'
      ? recovery.evidence.operationId
      : undefined);
  return reference &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      reference,
    )
    ? reference
    : undefined;
}

function shortArchiveReference(
  operationId: string | undefined,
  references: readonly string[],
): string | undefined {
  if (!operationId) return undefined;
  // Keep both ends and grow the suffix only when two attempts would look alike.
  let length = 8;
  while (
    length < operationId.length - 4 &&
    references.some(
      (reference) =>
        reference !== operationId &&
        reference.slice(0, 4) === operationId.slice(0, 4) &&
        reference.slice(-length) === operationId.slice(-length),
    )
  )
    length += 1;
  return length < operationId.length - 4
    ? `${operationId.slice(0, 4)}…${operationId.slice(-length)}`
    : operationId;
}

function recoveryCreatedAt(createdAt: string | null): string | undefined {
  return createdAt && Number.isFinite(Date.parse(createdAt))
    ? `Worktree created ${new Date(createdAt).toLocaleString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZoneName: 'short',
      })}`
    : undefined;
}

function RecoveryReference({
  operationId,
  reason,
  details,
  unfinished = true,
}: {
  readonly operationId?: string;
  readonly reason: string;
  readonly details: unknown;
  readonly unfinished?: boolean;
}): JSX.Element {
  return (
    <Stack gap="tight">
      <p className="text-pretty">{reason}</p>
      {unfinished ? (
        <p className="text-pretty">
          If recovery cannot continue, keep the files in place. Copy the
          recovery details, then use Send feedback in the account menu to share
          them with support.
        </p>
      ) : null}
      <CopyButton
        label="Copy recovery details"
        value={JSON.stringify(details, null, 2)}
      />
      <Disclosure label="Details">
        {operationId ? (
          <p className="text-pretty break-words">
            Archive reference: {operationId}
          </p>
        ) : null}
        <CodeBlock format="plain" variant="bare">
          {JSON.stringify(details, null, 2)}
        </CodeBlock>
      </Disclosure>
    </Stack>
  );
}

/** Live archive records are available even when cold W5 recovery is unavailable. */
export function WorktreeRecoveryPanel({
  client,
  snapshot,
  status,
  canRecover,
  onRecover,
  coldBusy,
  service,
  dismissalStore,
}: {
  readonly client: CanopyClient;
  /** null waits for the shell; undefined supports hosts without a shell snapshot. */
  readonly snapshot?: WorktreeRecoverySnapshot | null;
  readonly status?: W5RecoveryStatus;
  readonly canRecover?: boolean;
  readonly onRecover?: () => void;
  readonly coldBusy?: boolean;
  /** The background service notice shown with the blocked-changes notice. */
  readonly service?: W5RecoveryNoticeProps['service'];
  readonly dismissalStore: WorkspaceRecoveryDismissalStore;
}): JSX.Element {
  const supported = client.capabilities.worktreeRecoveryResolution === true;
  const [, setDismissalRevision] = useState(0);
  const [projects, setProjects] = useState<RecoveryProject[]>([]);
  const [open, setOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<RecoveryHold | null>(null);
  const projectsClient = useRef<CanopyClient | null>(null);
  const reviewRequest = useArchiveRecoveryReviewRequest(client);
  const answeredReview = useRef(reviewRequest);
  const active = useRef(0);
  const reading = useRef(false);
  const mutating = useRef(false);
  const lastCompleted = useRef<number | null>(null);
  const shellSnapshot = useRef(snapshot);
  useEffect(() => {
    shellSnapshot.current = snapshot;
  }, [snapshot]);
  const snapshotReady =
    snapshot === undefined ||
    (snapshot !== null && snapshot.workspaces.some(isRecoveryWorkspace));
  const refresh = useCallback(
    async (explicit = false): Promise<void> => {
      if (
        !supported ||
        reading.current ||
        (!explicit && mutating.current) ||
        shellSnapshot.current === null
      )
        return;
      if (
        !explicit &&
        lastCompleted.current !== null &&
        Date.now() - lastCompleted.current < RECOVERY_CHECK_GAP_MS
      )
        return;
      const generation = active.current;
      let didRead = shellSnapshot.current === undefined;
      reading.current = true;
      setChecking(true);
      try {
        // Only the hidden legacy desktop sidebar lacks a reusable shell snapshot.
        const currentSnapshot =
          shellSnapshot.current ?? (await client.query('session.snapshot', {}));
        if (generation !== active.current) return;
        const next: RecoveryProject[] = [];
        let incomplete = false;
        for (const workspace of currentSnapshot.workspaces) {
          if (!isRecoveryWorkspace(workspace)) continue;
          didRead = true;
          try {
            const result = await client.command('worktree.recovery.list', {
              workspaceId: workspace.localId,
            });
            next.push({
              ...result,
              workspaceId: workspace.localId,
              name: workspace.name,
              worktrees: currentSnapshot.worktrees.filter(
                (worktree) => worktree.workspaceLocalId === workspace.localId,
              ),
            });
            incomplete ||= result.check !== 'ok';
          } catch {
            incomplete = true;
            next.push({
              workspaceId: workspace.localId,
              name: workspace.name,
              worktrees: [],
              entries: [],
              check: 'list-unavailable',
            });
          }
          if (generation !== active.current) return;
        }
        if (generation === active.current) {
          projectsClient.current = client;
          setProjects(next);
          setError(incomplete);
        }
      } catch {
        if (generation === active.current) setError(true);
      } finally {
        if (generation === active.current) {
          reading.current = false;
          // Measure from completion so a slow read cannot trigger a trailing run.
          if (didRead) lastCompleted.current = Date.now();
          setChecking(false);
        }
      }
    },
    [client, supported],
  );
  useEffect(() => {
    active.current += 1;
    reading.current = false;
    mutating.current = false;
    lastCompleted.current = null;
    projectsClient.current = null;
    setProjects([]);
    setOpen(false);
    setMessage(null);
    setDeleting(null);
    setBusy(false);
    setChecking(false);
    setError(false);
    if (!supported) return;
    const onFocus = (): void => {
      void refresh();
    };
    window.addEventListener('focus', onFocus);
    // Settled dialog actions bypass the passive gap, but never an in-flight read.
    const unsubscribe = worktreeDiscardStoreFor(client).subscribe(
      (state, previous) => {
        if (
          (state.view.phase === 'closed' && previous.view.phase !== 'closed') ||
          (state.view.phase === 'recovery' &&
            state.view.outcome &&
            (previous.view.phase !== 'recovery' ||
              state.view.outcome !== previous.view.outcome))
        )
          void refresh(true);
      },
    );
    return (): void => {
      active.current += 1;
      window.removeEventListener('focus', onFocus);
      unsubscribe();
    };
  }, [client, refresh, supported]);
  useEffect(() => {
    if (!snapshotReady) return;
    let mounted = true;
    // Cancel StrictMode's replayed bootstrap before starting backend work.
    void Promise.resolve().then((): void => {
      if (mounted) void refresh();
    });
    return (): void => {
      mounted = false;
    };
  }, [refresh, snapshotReady]);
  useEffect(() => {
    if (!supported || projectsClient.current !== client) return;
    return registerArchiveRecoveryReview(
      client,
      projects
        .filter(
          (project) =>
            project.check !== 'ok' ||
            project.entries.length > 0 ||
            project.resolutions?.some(hasRecoveryMaterial),
        )
        .map((project) => project.workspaceId),
    );
  }, [client, projects, supported]);
  useEffect(() => {
    if (
      !supported ||
      !reviewRequest ||
      reviewRequest === answeredReview.current
    )
      return;
    answeredReview.current = reviewRequest;
    setOpen(true);
  }, [reviewRequest, supported]);
  const resolveHold = useCallback(
    async (
      hold: RecoveryHold,
      action: 'keep-worktree' | 'release' | 'delete-hold',
    ): Promise<void> => {
      if (mutating.current || reading.current || error) return;
      const generation = active.current;
      mutating.current = true;
      setBusy(true);
      setMessage(null);
      try {
        const result = await client.command('worktree.recovery.resolve', {
          workspaceId: hold.workspaceId,
          operationId: hold.operationId,
          revision: hold.revision,
          action,
        });
        if (generation !== active.current) return;
        setMessage(worktreeRecoveryResultCopy(result, action));
        setDeleting(null);
        await refresh(true);
      } catch {
        if (generation === active.current) {
          setMessage(worktreeRecoveryUnconfirmedCopy(action));
          setError(true);
          setDeleting(null);
        }
      } finally {
        if (generation === active.current) {
          mutating.current = false;
          setBusy(false);
        }
      }
    },
    [client, error, refresh],
  );
  const finishCleanup = useCallback(
    async (
      project: RecoveryProject,
      recovery: WorktreeRecoveryListResult['entries'][number],
    ): Promise<void> => {
      if (mutating.current || reading.current || error || !recovery.diagnosis)
        return;
      const generation = active.current;
      mutating.current = true;
      setBusy(true);
      setMessage(null);
      try {
        const result = await client.command('worktree.recovery.finish', {
          workspaceId: project.workspaceId,
          operationId: recovery.diagnosis.operationId,
          revision: recovery.diagnosis.revision,
        });
        if (generation !== active.current) return;
        setMessage(worktreeRecoveryResultCopy(result, 'finish-cleanup'));
        await refresh(true);
      } catch {
        if (generation === active.current) {
          setMessage(worktreeRecoveryUnconfirmedCopy('finish-cleanup'));
          setError(true);
        }
      } finally {
        if (generation === active.current) {
          mutating.current = false;
          setBusy(false);
        }
      }
    },
    [client, error, refresh],
  );
  const showArchiveRecovery =
    supported && hasNewRecovery(client, projects, error);
  // Shell snapshots update read inputs, not the already-reviewed recovery UI.
  return useMemo(() => {
    const cleanupOnly =
      !error &&
      projects.some((project) => project.entries.length > 0) &&
      projects.every(
        (project) =>
          project.entries.every(
            (entry) => entry.check === 'completed-turn-diff-cleanup',
          ) && !project.resolutions?.some(needsRecoveryReview),
      );
    return (
      <>
        <WorkspaceRecoveryNotice
          dismissalStore={dismissalStore}
          service={service}
          status={status}
          canRecover={canRecover}
          onRecover={onRecover}
          busy={coldBusy}
          archiveRecovery={
            showArchiveRecovery
              ? {
                  unavailable: error,
                  cleanupOnly,
                  onDismiss: () => {
                    dismissRecovery(client, projects, error);
                    setDismissalRevision((revision) => revision + 1);
                  },
                  onReview: () => {
                    setOpen(true);
                  },
                }
              : undefined
          }
        />
        {open || deleting ? (
          <WorktreeRecoveryListDialog
            projects={projects}
            checking={checking}
            error={error}
            busy={busy}
            message={message}
            deleting={deleting}
            onClose={() => {
              if (!busy) setOpen(false);
            }}
            onRefresh={() => {
              void refresh(true);
            }}
            onReview={(project, recovery) => {
              setOpen(false);
              offerWorktreeDiscard({
                workspaceId: project.workspaceId,
                worktreeId: recovery.subject.worktreeId,
                worktreeName: `${recoveryName(project, recovery)} (${project.name})`,
                message: formatWorktreeRecoveryReason(recovery),
                recovery,
              });
            }}
            onDelete={setDeleting}
            onFinishCleanup={(project, recovery) => {
              void finishCleanup(project, recovery);
            }}
            onResolve={(hold, action) => {
              void resolveHold(hold, action);
            }}
            onCancelDelete={() => {
              if (!busy) setDeleting(null);
            }}
          />
        ) : null}
      </>
    );
  }, [
    busy,
    canRecover,
    checking,
    client,
    coldBusy,
    deleting,
    dismissalStore,
    error,
    finishCleanup,
    message,
    onRecover,
    open,
    projects,
    refresh,
    resolveHold,
    service,
    status,
    showArchiveRecovery,
  ]);
}

/** Shared presentation kept separate from live reads and recovery commands. */
export function WorktreeRecoveryListDialog({
  projects,
  checking,
  error,
  busy,
  message,
  deleting,
  onClose,
  onRefresh,
  onReview,
  onDelete,
  onResolve,
  onCancelDelete,
  onFinishCleanup,
}: {
  readonly projects: readonly RecoveryProject[];
  readonly checking: boolean;
  readonly error: boolean;
  readonly busy: boolean;
  readonly message?: string | null;
  readonly deleting?: RecoveryHold | null;
  readonly onClose: () => void;
  readonly onRefresh: () => void;
  readonly onReview: (
    project: RecoveryProject,
    recovery: WorktreeRecoveryListResult['entries'][number],
  ) => void;
  readonly onDelete: (hold: RecoveryHold) => void;
  readonly onResolve: (
    hold: RecoveryHold,
    action: 'keep-worktree' | 'release' | 'delete-hold',
  ) => void;
  readonly onCancelDelete: () => void;
  readonly onFinishCleanup: (
    project: RecoveryProject,
    recovery: WorktreeRecoveryListResult['entries'][number],
  ) => void;
}): JSX.Element {
  const count = projects.reduce(
    (total, project) =>
      total +
      project.entries.length +
      (project.resolutions?.filter(hasRecoveryMaterial).length ?? 0),
    0,
  );
  return (
    <>
      {!deleting ? (
        <DialogModal
          title="Archive recovery"
          onClose={onClose}
          closeButtonDisabled={busy}
          closeOnEscape={!busy}
          closeOnBackdrop={!busy}
          trapFocus
          maxWidth="lg"
          dataTestId="worktree-live-recovery-panel"
          footer={
            <LoadingButton
              variant="primary"
              loading={checking}
              loadingLabel="Checking…"
              disabled={busy || checking}
              onClick={onRefresh}
            >
              Check again
            </LoadingButton>
          }
        >
          <p className="text-pretty">
            Finish leftover cleanup, continue an unfinished archive, or copy
            details to share with support. Saved recovery material can be
            deleted separately.
          </p>
          {error ? (
            <>
              <ErrorBanner
                errorSource="worktree-recovery-panel"
                error="Couldn't check all recovery records. You can still review known records and copy their details to share with support."
              />
              <p className="text-pretty">
                Copy the recovery details, then use Send feedback in the account
                menu to share them with support.
              </p>
              <CopyButton
                label="Copy recovery details"
                value={JSON.stringify(
                  {
                    check: 'recovery-list-unavailable',
                    projects: projects.map((project) => ({
                      workspaceId: project.workspaceId,
                      check: project.check,
                    })),
                  },
                  null,
                  2,
                )}
              />
            </>
          ) : null}
          {message ? (
            <p role="status" className="text-pretty">
              {message}
            </p>
          ) : null}
          {!count && !checking && !error ? (
            <p>No unfinished archives or retained recovery material.</p>
          ) : null}
          {projects.map((project) => {
            const references = [
              ...project.entries.flatMap(
                (entry) => archiveReference(entry) ?? [],
              ),
              ...(project.resolutions?.map((hold) => hold.operationId) ?? []),
            ];
            return (
              <Stack as="section" key={project.workspaceId} gap="inline">
                {project.entries.length > 0 ||
                project.resolutions?.some(hasRecoveryMaterial) ||
                project.check !== 'ok' ? (
                  <Heading level={3} variant="label">
                    <span className={REPLAY_MASK_CLASS}>{project.name}</span>
                  </Heading>
                ) : null}
                {project.check !== 'ok' ? (
                  <RecoveryReference
                    reason="Couldn't check this project. Keep its files in place. Check again later, or copy these details to share with support."
                    details={{
                      workspaceId: project.workspaceId,
                      check: project.check,
                    }}
                  />
                ) : null}
                {project.entries.map((recovery) => (
                  <Stack
                    data-testid="worktree-live-recovery-entry"
                    data-worktree-id={recovery.subject.worktreeId}
                    key={
                      archiveReference(recovery) ?? recovery.subject.worktreeId
                    }
                    gap="tight"
                  >
                    <ListRowStatic
                      size="lg"
                      description={recoveryCreatedAt(
                        recovery.subject.createdAt,
                      )}
                      trailing={shortArchiveReference(
                        archiveReference(recovery),
                        references,
                      )}
                      actions={
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={
                            busy ||
                            checking ||
                            (error &&
                              recovery.diagnosis?.check ===
                                'completed-turn-diff-cleanup')
                          }
                          onClick={() =>
                            recovery.diagnosis?.check ===
                            'completed-turn-diff-cleanup'
                              ? onFinishCleanup(project, recovery)
                              : onReview(project, recovery)
                          }
                        >
                          {recovery.diagnosis?.check ===
                          'completed-turn-diff-cleanup'
                            ? 'Finish cleanup'
                            : recovery.check === 'completed-turn-diff-cleanup'
                              ? 'View cleanup details'
                              : 'Review archive'}
                        </Button>
                      }
                    >
                      <span className={REPLAY_MASK_CLASS}>
                        {recoveryName(project, recovery)}
                      </span>
                    </ListRowStatic>
                    <RecoveryReference
                      operationId={archiveReference(recovery)}
                      reason={
                        recovery.check === 'completed-turn-diff-cleanup'
                          ? recovery.diagnosis?.check ===
                            'completed-turn-diff-cleanup'
                            ? 'The archive finished and the worktree was removed. Finish cleanup to remove leftover saved change data.'
                            : "The archive finished, but leftover saved change data couldn't be safely cleaned up. Copy the recovery details to share with support."
                          : formatWorktreeRecoveryReason(recovery)
                      }
                      unfinished={
                        recovery.diagnosis?.verdict !== 'cleanup-debt' &&
                        (recovery.check !== 'completed-turn-diff-cleanup' ||
                          recovery.diagnosis?.check !==
                            'completed-turn-diff-cleanup')
                      }
                      details={recovery}
                    />
                  </Stack>
                ))}
                {project.resolutions
                  ?.filter(hasRecoveryMaterial)
                  .map((hold) => (
                    <Stack key={hold.operationId} gap="tight">
                      <ListRowStatic
                        size="lg"
                        description={recoveryCreatedAt(hold.createdAt)}
                        trailing={shortArchiveReference(
                          hold.operationId,
                          references,
                        )}
                        actions={
                          hold.stage === 'completed' ? (
                            <Button
                              variant="secondary"
                              size="sm"
                              disabled={busy || checking || error}
                              onClick={() =>
                                onDelete({
                                  ...hold,
                                  workspaceId: project.workspaceId,
                                })
                              }
                            >
                              Delete recovery material
                            </Button>
                          ) : (
                            <LoadingButton
                              variant="secondary"
                              size="sm"
                              loading={busy}
                              loadingLabel="Continuing recovery…"
                              disabled={busy || checking || error}
                              onClick={() => {
                                onResolve(
                                  { ...hold, workspaceId: project.workspaceId },
                                  hold.action,
                                );
                              }}
                            >
                              {hold.action === 'keep-worktree'
                                ? 'Keep worktree'
                                : 'Release'}
                            </LoadingButton>
                          )
                        }
                      >
                        {hold.stage === 'completed'
                          ? 'Retained recovery material'
                          : 'Unfinished recovery'}
                      </ListRowStatic>
                      <RecoveryReference
                        operationId={hold.operationId}
                        unfinished={hold.stage !== 'completed'}
                        details={{ workspaceId: project.workspaceId, ...hold }}
                        reason={
                          hold.stage === 'completed'
                            ? `${hold.retainedSnapshots} saved Git ${hold.retainedSnapshots === 1 ? 'snapshot' : 'snapshots'}. ${hold.retainedPayload ? 'A saved working-file copy is also retained.' : 'No working-file copy is retained.'}`
                            : 'Recovery has not finished. Continue the same choice to check and resume it.'
                        }
                      />
                    </Stack>
                  ))}
              </Stack>
            );
          })}
        </DialogModal>
      ) : null}
      {deleting ? (
        <ConfirmDialog
          title="Delete retained recovery material?"
          message="Permanently delete the saved Git snapshots and working-file copy for this archive attempt. This does not delete a live worktree."
          confirmLabel="Delete recovery material"
          busyLabel="Deleting recovery material…"
          destructive
          busy={busy}
          confirmDisabled={checking || error}
          onConfirm={() => {
            onResolve(deleting, 'delete-hold');
          }}
          onCancel={onCancelDelete}
          dataTestId="worktree-recovery-delete-hold"
        />
      ) : null}
    </>
  );
}
