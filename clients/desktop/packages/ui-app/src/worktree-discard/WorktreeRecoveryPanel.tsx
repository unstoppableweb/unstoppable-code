import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import {
  isUnsupportedOperation,
  type CanopyClient,
  type SessionViewModel,
} from '@canopy/app-core';
import {
  offerLifecycleJournalQuarantine,
  offerWorktreeDiscard,
  registerArchiveRecoveryReview,
  useArchiveRecoveryReviewRequest,
} from '@canopy/app-state';
import {
  activateWorktreeDiscardComputer,
  worktreeDiscardStoreFor,
  worktreeRecoveryHostOutdatedMessage,
} from '@canopy/app-state/worktree-discard';
import type { WorktreeRecoveryListResult } from '@canopy/protocol/canopy-core';
import type { W5RecoveryStatus } from '@canopy/protocol/remote-control/shell';
import {
  formatWorktreeRecoveryReason,
  worktreeRecoveryOfferedActions,
} from '@canopy/protocol/remote-control/shell/worktree-recovery';
import {
  Button,
  CodeBlock,
  ConfirmDialog,
  CopyButton,
  DialogModal,
  Disclosure,
  Divider,
  ErrorBanner,
  Heading,
  Inline,
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
  recoveryEvidenceUnavailable,
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
  operationId: string,
  references: readonly string[],
): string {
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

function recoveryCreatedLabel(createdAt: string | null): string | undefined {
  if (!createdAt || !Number.isFinite(Date.parse(createdAt))) return undefined;
  return new Date(createdAt).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

function recoveryHeadingKey(text: string): string {
  return text
    .normalize('NFC')
    .replace(/[ \t\r\n]+/g, ' ')
    .replace(/^ | $/g, '');
}

function recoveryListReason(
  recovery: WorktreeRecoveryListResult['entries'][number],
  readOnly: boolean,
): string {
  if (recovery.check !== 'completed-turn-diff-cleanup')
    return formatWorktreeRecoveryReason(recovery);
  if (recovery.diagnosis?.check !== 'completed-turn-diff-cleanup')
    return "The archive finished, but leftover saved change data couldn't be safely cleaned up.";
  return readOnly
    ? 'The archive finished and the worktree was removed. Leftover saved change data can be cleaned up in the app on the connected computer.'
    : 'The archive finished and the worktree was removed. Finish cleanup to remove leftover saved change data.';
}

function RecoveryListEntry({
  title,
  createdAt,
  created,
  reason,
  operationId,
  details,
  action,
  worktreeId,
  shortReference,
}: {
  readonly title: string;
  readonly createdAt: string | null;
  readonly created: string | undefined;
  readonly reason: string;
  readonly operationId?: string;
  readonly details: unknown;
  readonly action?: ReactNode;
  readonly worktreeId?: string;
  readonly shortReference?: string;
}): JSX.Element {
  return (
    <Stack
      gap="item"
      data-testid={
        worktreeId === undefined ? undefined : 'worktree-live-recovery-entry'
      }
      data-worktree-id={worktreeId}
    >
      <Divider aria-hidden />
      <Stack gap="tight">
        <Inline gap="inline" align="start" wrap>
          <Stack gap="tight" className="min-w-0 grow basis-48">
            <Heading level={4} variant="title">
              <span className={`break-words ${REPLAY_MASK_CLASS}`}>
                {title}
              </span>
            </Heading>
            {created ? (
              <time
                dateTime={createdAt ?? undefined}
                className="text-xs fg-secondary"
              >
                Worktree created {created}
              </time>
            ) : null}
            {shortReference ? (
              <p className="break-words text-xs fg-secondary">
                Archive reference:{' '}
                <span className={REPLAY_MASK_CLASS}>{shortReference}</span>
              </p>
            ) : null}
          </Stack>
          {action}
        </Inline>
        <p className="text-pretty text-xs fg-secondary">{reason}</p>
        <RecoveryDiagnostics operationId={operationId} details={details} />
      </Stack>
    </Stack>
  );
}

function RecoveryDiagnostics({
  operationId,
  details,
  label = 'Details',
}: {
  readonly operationId?: string;
  readonly details: unknown;
  readonly label?: string;
}): JSX.Element {
  return (
    <Disclosure label={label}>
      <RecoveryDiagnosticsContent operationId={operationId} details={details} />
    </Disclosure>
  );
}

function RecoveryDiagnosticsContent({
  operationId,
  details,
}: {
  readonly operationId?: string;
  readonly details: unknown;
}): JSX.Element {
  const serialized = JSON.stringify(details, null, 2);
  return (
    <div className={REPLAY_MASK_CLASS}>
      <Stack gap="inline">
        {operationId && (
          <p className="text-xs fg-secondary break-words">
            Archive reference: {operationId}
          </p>
        )}
        <div>
          <CopyButton label="Copy recovery details" value={serialized} />
        </div>
        <CodeBlock format="plain" variant="bare">
          {serialized}
        </CodeBlock>
      </Stack>
    </div>
  );
}

/** Live archive records are available even when cold W5 recovery is unavailable. */
export function WorktreeRecoveryPanel({
  computerScopeKey = null,
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
  readonly computerScopeKey?: string | null;
}): JSX.Element {
  const discardStore = worktreeDiscardStoreFor(client, computerScopeKey);
  useLayoutEffect(
    () => activateWorktreeDiscardComputer(client, computerScopeKey),
    [client, computerScopeKey],
  );
  // The list is read only (CAN-7439); every action needs live resolution.
  const supported = client.capabilities.worktreeRecoveryReads === true;
  const canResolve = client.capabilities.worktreeRecoveryResolution === true;
  // A computer that refuses the list (from before CAN-7439) has no archive
  // recovery to show: hide the panel rather than report a failed check.
  const [refused, setRefused] = useState(false);
  const available = supported && !refused;
  const [, setDismissalRevision] = useState(0);
  const [projects, setProjects] = useState<RecoveryProject[]>([]);
  const [open, setOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<RecoveryHold | null>(null);
  // An older computer's update message (CAN-7444), cleared by the next read.
  const hostOutdated = useRef<string | null>(null);
  const projectsClient = useRef<CanopyClient | null>(null);
  const reviewRequest = useArchiveRecoveryReviewRequest(client);
  const answeredReview = useRef(reviewRequest);
  const active = useRef(0);
  const reading = useRef(false);
  const refreshQueued = useRef(false);
  const snapshotRefreshQueued = useRef(false);
  const mutating = useRef(false);
  const refusedList = useRef(false);
  const lastCompleted = useRef<number | null>(null);
  const resetFor = useRef<CanopyClient | null>(null);
  const shellSnapshot = useRef(snapshot);
  useEffect(() => {
    shellSnapshot.current = snapshot;
  }, [snapshot]);
  const snapshotReady =
    snapshot === undefined ||
    (snapshot !== null && snapshot.workspaces.some(isRecoveryWorkspace));
  const refresh = useCallback(
    async (explicit = false, snapshotRefresh = false): Promise<void> => {
      if (
        !discardStore.getState().isCurrentComputer() ||
        !supported ||
        refusedList.current ||
        shellSnapshot.current === null
      )
        return;
      if (reading.current) {
        // Only explicit refreshes supersede a running read; focus must not starve it.
        if (explicit) refreshQueued.current = true;
        else if (snapshotRefresh) snapshotRefreshQueued.current = true;
        return;
      }
      if (!explicit && mutating.current) return;
      if (
        !explicit &&
        lastCompleted.current !== null &&
        Date.now() - lastCompleted.current < RECOVERY_CHECK_GAP_MS
      )
        return;
      const generation = active.current;
      const readCancelled = (): boolean =>
        generation !== active.current ||
        !discardStore.getState().isCurrentComputer() ||
        shellSnapshot.current === null;
      let didRead = shellSnapshot.current === undefined;
      reading.current = true;
      setChecking(true);
      if (hostOutdated.current !== null) {
        const shown = hostOutdated.current;
        hostOutdated.current = null;
        setMessage((current) => (current === shown ? null : current));
      }
      try {
        do {
          refreshQueued.current = false;
          snapshotRefreshQueued.current = false;
          try {
            // Only the hidden legacy desktop sidebar lacks a reusable shell snapshot.
            let currentSnapshot = shellSnapshot.current;
            try {
              currentSnapshot ??= await client.query('session.snapshot', {});
            } catch {
              currentSnapshot = undefined;
            }
            if (readCancelled()) return;
            if (refreshQueued.current) continue;
            if (!currentSnapshot) {
              setError(true);
              continue;
            }
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
                    (worktree) =>
                      worktree.workspaceLocalId === workspace.localId,
                  ),
                });
                incomplete ||= recoveryEvidenceUnavailable(result);
              } catch (cause) {
                if (readCancelled()) return;
                if (isUnsupportedOperation(cause)) {
                  refusedList.current = true;
                  projectsClient.current = client;
                  setProjects([]);
                  setError(false);
                  setRefused(true);
                  return;
                }
                incomplete = true;
                next.push({
                  workspaceId: workspace.localId,
                  name: workspace.name,
                  worktrees: [],
                  entries: [],
                  check: 'list-unavailable',
                });
              }
              if (readCancelled()) return;
              if (refreshQueued.current) break;
            }
            if (generation === active.current && !refreshQueued.current) {
              projectsClient.current = client;
              setProjects(next);
              setError(incomplete);
            }
          } catch {
            if (!readCancelled() && !refreshQueued.current) setError(true);
          }
        } while (
          generation === active.current &&
          (refreshQueued.current || snapshotRefreshQueued.current)
        );
      } finally {
        if (generation === active.current) {
          reading.current = false;
          // The passive gap starts after the latest requested read completes.
          if (shellSnapshot.current === null) lastCompleted.current = null;
          else if (didRead) lastCompleted.current = Date.now();
          setChecking(false);
        }
      }
    },
    [client, discardStore, supported],
  );
  useEffect(() => {
    active.current += 1;
    reading.current = false;
    refreshQueued.current = false;
    snapshotRefreshQueued.current = false;
    mutating.current = false;
    // A computer updated in place, or another one attached, is probed again.
    refusedList.current = false;
    setRefused(false);
    setOpen(false);
    setMessage(null);
    hostOutdated.current = null;
    setDeleting(null);
    setBusy(false);
    setChecking(false);
    // Support can flap with a remote link (CAN-7439). Only a new client drops
    // its records and the passive read gap, so a flapping link never reads
    // more often than the gap allows.
    if (resetFor.current !== client) {
      resetFor.current = client;
      lastCompleted.current = null;
      projectsClient.current = null;
      setProjects([]);
      setError(false);
    }
    if (!supported) {
      // A read that failed as the link dropped must not survive the gap as a
      // "couldn't check" banner, or as its placeholder rows, once the link
      // returns. Records the computer reported are kept.
      setError(false);
      setProjects((current) =>
        current.filter((project) => project.check !== 'list-unavailable'),
      );
      return;
    }
    const onFocus = (): void => {
      void refresh();
    };
    window.addEventListener('focus', onFocus);
    // Settled actions bypass the passive gap and invalidate any in-flight list.
    const unsubscribe = discardStore.subscribe((state, previous) => {
      if (
        (state.view.phase === 'closed' && previous.view.phase !== 'closed') ||
        (state.setAsideResult &&
          state.setAsideResult !== previous.setAsideResult) ||
        (state.view.phase === 'recovery' &&
          state.view.outcome &&
          (previous.view.phase !== 'recovery' ||
            state.view.outcome !== previous.view.outcome))
      )
        void refresh(true);
    });
    return (): void => {
      active.current += 1;
      window.removeEventListener('focus', onFocus);
      unsubscribe();
    };
  }, [client, discardStore, refresh, supported]);
  useEffect(() => {
    if (!snapshotReady) return;
    let mounted = true;
    // Cancel StrictMode's replayed bootstrap before starting backend work.
    void Promise.resolve().then((): void => {
      // A newly ready snapshot gets a trailing read without hiding this pass.
      if (mounted) void refresh(false, true);
    });
    return (): void => {
      mounted = false;
    };
  }, [refresh, snapshotReady]);
  useEffect(() => {
    if (!available || projectsClient.current !== client) return;
    return registerArchiveRecoveryReview(
      client,
      projects
        .filter(
          (project) =>
            recoveryEvidenceUnavailable(project) ||
            project.entries.length > 0 ||
            project.resolutions?.some(hasRecoveryMaterial),
        )
        .map((project) => project.workspaceId),
    );
  }, [available, client, projects]);
  useEffect(() => {
    if (
      !available ||
      !reviewRequest ||
      reviewRequest === answeredReview.current
    )
      return;
    answeredReview.current = reviewRequest;
    setOpen(true);
  }, [available, reviewRequest]);
  const resolveHold = useCallback(
    async (
      hold: RecoveryHold,
      action: 'keep-worktree' | 'release' | 'delete-hold',
    ): Promise<void> => {
      // Only a target that resolves archive recovery sends an action
      // (CAN-7444); a read-only list never does.
      if (
        !discardStore.getState().isCurrentComputer() ||
        !canResolve ||
        mutating.current ||
        reading.current ||
        error
      )
        return;
      const generation = active.current;
      mutating.current = true;
      setBusy(true);
      setMessage(null);
      hostOutdated.current = null;
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
      } catch (failure) {
        if (generation === active.current) {
          // An older computer refused the action, so nothing ran (CAN-7444):
          // say how to fix it and keep the list usable.
          const outdated = worktreeRecoveryHostOutdatedMessage(failure);
          hostOutdated.current = outdated;
          setMessage(outdated ?? worktreeRecoveryUnconfirmedCopy(action));
          if (outdated === null) setError(true);
          setDeleting(null);
        }
      } finally {
        if (generation === active.current) {
          mutating.current = false;
          setBusy(false);
        }
      }
    },
    [canResolve, client, discardStore, error, refresh],
  );
  const finishCleanup = useCallback(
    async (
      project: RecoveryProject,
      recovery: WorktreeRecoveryListResult['entries'][number],
    ): Promise<void> => {
      if (
        !discardStore.getState().isCurrentComputer() ||
        !canResolve ||
        mutating.current ||
        reading.current ||
        error ||
        !recovery.diagnosis
      )
        return;
      const generation = active.current;
      mutating.current = true;
      setBusy(true);
      setMessage(null);
      hostOutdated.current = null;
      try {
        const result = await client.command('worktree.recovery.finish', {
          workspaceId: project.workspaceId,
          operationId: recovery.diagnosis.operationId,
          revision: recovery.diagnosis.revision,
        });
        if (generation !== active.current) return;
        setMessage(worktreeRecoveryResultCopy(result, 'finish-cleanup'));
        await refresh(true);
      } catch (failure) {
        if (generation === active.current) {
          const outdated = worktreeRecoveryHostOutdatedMessage(failure);
          hostOutdated.current = outdated;
          setMessage(
            outdated ?? worktreeRecoveryUnconfirmedCopy('finish-cleanup'),
          );
          if (outdated === null) setError(true);
        }
      } finally {
        if (generation === active.current) {
          mutating.current = false;
          setBusy(false);
        }
      }
    },
    [canResolve, client, discardStore, error, refresh],
  );
  const showArchiveRecovery =
    available && hasNewRecovery(client, projects, error);
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
                  readOnly: !canResolve,
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
        {available && (open || deleting) ? (
          <WorktreeRecoveryListDialog
            readOnly={!canResolve}
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
              if (!canResolve) return;
              setOpen(false);
              offerWorktreeDiscard({
                workspaceId: project.workspaceId,
                worktreeId: recovery.subject.worktreeId,
                worktreeName: `${recoveryName(project, recovery)} (${project.name})`,
                message: formatWorktreeRecoveryReason(recovery),
                recovery,
              });
            }}
            onDelete={(hold) => {
              if (canResolve) setDeleting(hold);
            }}
            canSetAside={client.capabilities.worktreeRecoverySetAside === true}
            onReviewJournal={
              client.capabilities.lifecycleJournalQuarantine === true
                ? () => {
                    setOpen(false);
                    offerLifecycleJournalQuarantine(
                      undefined,
                      'unreadable-entry',
                    );
                  }
                : undefined
            }
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
    available,
    busy,
    canRecover,
    canResolve,
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
  readOnly = false,
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
  canSetAside = false,
  onReviewJournal,
}: {
  /**
   * The target lists recovery but takes no recovery action (CAN-7439): rows
   * show their details without Finish, Review, Keep, Release or Delete.
   */
  readonly readOnly?: boolean;
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
  /** Offers the same actions as the dialog each row opens. */
  readonly canSetAside?: boolean;
  /** CAN-5335's review, for a project whose records can't all be read (q-26 4a). */
  readonly onReviewJournal?: () => void;
}): JSX.Element {
  const referencesByRow = new Map<string, string[]>();
  const holdReferencesByProjectName = new Map<string, string[]>();
  const groups = projects.map((project) => {
    const projectNameKey = recoveryHeadingKey(project.name);
    const holds = project.resolutions?.filter(hasRecoveryMaterial) ?? [];
    const holdReferences =
      holdReferencesByProjectName.get(projectNameKey) ?? [];
    for (const hold of holds) holdReferences.push(hold.operationId);
    holdReferencesByProjectName.set(projectNameKey, holdReferences);

    const rows = project.entries.map((recovery) => {
      const title = recoveryName(project, recovery);
      const created = recoveryCreatedLabel(recovery.subject.createdAt);
      const operationId = archiveReference(recovery);
      const finishCleanup =
        recovery.diagnosis?.check === 'completed-turn-diff-cleanup' &&
        worktreeRecoveryOfferedActions(recovery, {
          canResolve: !readOnly,
          canSetAside,
        }).includes('finish');
      const actionLabel = finishCleanup
        ? 'Finish cleanup'
        : recovery.check === 'completed-turn-diff-cleanup'
          ? 'View cleanup details'
          : 'Review recovery';
      const reason = recoveryListReason(recovery, readOnly);
      let matchingReferences: string[] | undefined;
      if (operationId) {
        const key = JSON.stringify([
          projectNameKey,
          recoveryHeadingKey(title),
          created,
          reason,
          readOnly ? null : actionLabel,
        ]);
        matchingReferences = referencesByRow.get(key) ?? [];
        matchingReferences.push(operationId);
        referencesByRow.set(key, matchingReferences);
      }
      return {
        recovery,
        title,
        created,
        operationId,
        finishCleanup,
        actionLabel,
        reason,
        matchingReferences,
      };
    });
    return { project, rows, holds, holdReferences };
  });
  const count = groups.reduce(
    (total, { rows, holds }) => total + rows.length + holds.length,
    0,
  );
  const deletingReference = deleting
    ? shortArchiveReference(
        deleting.operationId,
        groups.find(
          ({ project }) => project.workspaceId === deleting.workspaceId,
        )?.holdReferences ?? [],
      )
    : undefined;
  return (
    <>
      {!deleting || readOnly ? (
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
            <Button
              variant="secondary"
              loading={checking}
              loadingLabel="Checking…"
              disabled={busy || checking}
              onClick={onRefresh}
            >
              Check again
            </Button>
          }
        >
          {count > 0 || error ? (
            <p className="text-pretty text-s fg-secondary">
              {readOnly
                ? // Read only (CAN-7439): recovery actions run on the connected computer.
                  'Open the app on the connected computer to continue recovery.'
                : "If recovery can't continue, keep the files in place."}
              {count > 0
                ? ' Open Details to copy information for support.'
                : null}
            </p>
          ) : null}
          {error ? (
            <Stack gap="tight">
              <ErrorBanner
                errorSource="worktree-recovery-panel"
                error="Couldn't check all recovery records."
              />
              <p className="text-pretty text-s fg-secondary">
                Open Check failure details to copy information for support. Use
                Send feedback beside your account in the desktop app to share
                it.
              </p>
              <RecoveryDiagnostics
                label="Check failure details"
                details={{
                  check: 'recovery-list-unavailable',
                  projects: projects.map((project) => ({
                    workspaceId: project.workspaceId,
                    check: project.check,
                    unreadableEvidence: project.unreadableEvidence,
                  })),
                }}
              />
            </Stack>
          ) : null}
          {message ? (
            <p role="status" className="text-pretty">
              {message}
            </p>
          ) : null}
          {!count && !checking && !error ? (
            <p>No unfinished archives or retained recovery material.</p>
          ) : null}
          {groups.map(({ project, rows, holds, holdReferences }) => {
            const unavailable = recoveryEvidenceUnavailable(project);
            if (
              project.entries.length === 0 &&
              holds.length === 0 &&
              !unavailable
            ) {
              return null;
            }
            return (
              <Stack as="section" key={project.workspaceId} gap="item">
                <Heading level={3} variant="label">
                  <span className={`break-words ${REPLAY_MASK_CLASS}`}>
                    {project.name}
                  </span>
                </Heading>
                {project.check === 'journal-evidence-unreadable' &&
                !readOnly &&
                onReviewJournal ? (
                  <Stack gap="tight">
                    <p className="text-pretty">
                      Some archive records can't be read, so this project
                      couldn't be checked. Review them to move unreadable
                      records to quarantine.
                    </p>
                    <div>
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={busy || checking}
                        onClick={onReviewJournal}
                        data-testid="worktree-recovery-review-journal"
                      >
                        Review records
                      </Button>
                    </div>
                  </Stack>
                ) : unavailable ? (
                  <Stack gap="tight">
                    <p className="text-pretty text-s">
                      Couldn't check this project. Keep its files in place and
                      check again later.
                    </p>
                    <RecoveryDiagnostics
                      details={{
                        workspaceId: project.workspaceId,
                        check: project.check,
                        unreadableEvidence: project.unreadableEvidence,
                      }}
                    />
                  </Stack>
                ) : null}
                {rows.map((row) => {
                  const {
                    recovery,
                    title,
                    created,
                    operationId,
                    finishCleanup,
                    actionLabel,
                    reason,
                    matchingReferences,
                  } = row;
                  return (
                    <RecoveryListEntry
                      worktreeId={recovery.subject.worktreeId}
                      key={operationId ?? recovery.subject.worktreeId}
                      title={title}
                      createdAt={recovery.subject.createdAt}
                      created={created}
                      shortReference={
                        operationId &&
                        matchingReferences &&
                        matchingReferences.length > 1
                          ? shortArchiveReference(
                              operationId,
                              matchingReferences,
                            )
                          : undefined
                      }
                      action={
                        readOnly ? undefined : (
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={
                              busy || checking || (error && finishCleanup)
                            }
                            onClick={() =>
                              finishCleanup
                                ? onFinishCleanup(project, recovery)
                                : onReview(project, recovery)
                            }
                          >
                            {actionLabel}
                          </Button>
                        )
                      }
                      operationId={operationId}
                      reason={reason}
                      details={recovery}
                    />
                  );
                })}
                {holds.map((hold) => (
                  <RecoveryListEntry
                    key={hold.operationId}
                    title={
                      hold.stage === 'completed'
                        ? 'Retained recovery material'
                        : 'Unfinished recovery'
                    }
                    createdAt={hold.createdAt}
                    created={recoveryCreatedLabel(hold.createdAt)}
                    shortReference={
                      holdReferences.length > 1
                        ? shortArchiveReference(
                            hold.operationId,
                            holdReferences,
                          )
                        : undefined
                    }
                    action={
                      readOnly ? undefined : hold.stage === 'completed' ? (
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
                        <Button
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
                        </Button>
                      )
                    }
                    operationId={hold.operationId}
                    details={{ workspaceId: project.workspaceId, ...hold }}
                    reason={
                      hold.stage === 'completed'
                        ? `${hold.retainedSnapshots} saved Git ${hold.retainedSnapshots === 1 ? 'snapshot' : 'snapshots'}. ${hold.retainedPayload ? 'A saved working-file copy is also retained.' : 'No working-file copy is retained.'}`
                        : readOnly
                          ? // Read only (CAN-7439): the choice resumes on the computer.
                            'Recovery has not finished. Continue it in the app on the connected computer.'
                          : 'Recovery has not finished. Continue the same choice to check and resume it.'
                    }
                  />
                ))}
              </Stack>
            );
          })}
        </DialogModal>
      ) : null}
      {deleting && !readOnly ? (
        <ConfirmDialog
          title="Delete retained recovery material?"
          message={
            <Stack gap="inline">
              <p className="text-pretty">
                Permanently delete the saved Git snapshots and working-file copy
                for this archive attempt. This does not delete a live worktree.
              </p>
              <p>
                Archive reference:{' '}
                <span className={REPLAY_MASK_CLASS}>{deletingReference}</span>
              </p>
            </Stack>
          }
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
