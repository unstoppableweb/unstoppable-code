import { CanopyCloudClientError } from '../../canopy-cloud/client';
import { reportBackgroundFailure } from '../../observability/background-failure-reporter';
import { readdir } from 'node:fs/promises';
import { getWorktreeDataRootDir } from '../../lib/paths';
import {
  getSharedContainerLink,
  listSharedContainerRecipients,
} from '../canopy-server-client';
import {
  getSharedContainerPublicationStateStore,
  type SharedContainerPublicationRecord,
  type SharedContainerPublicationStateStore,
} from '../publication-state';
import { pruneSharedContainerPublishStaging } from './pipeline';
import { SharedContainerPublishInventoryChangedError } from './source-files';
import {
  SHARED_CONTAINER_CLEANUP_IN_PROGRESS_ERROR_CODE,
  type SharedContainerType,
} from '@canopy/protocol/shared-containers';
import { publishSharedContainerRevisionForTarget } from './dispatcher';
import { getSharedContainerPublishErrorReason } from './errors';
import { sharedContainerOwnerKey } from '../owner-scope';

export const SHARED_CONTAINER_PUBLISH_IDLE_DEBOUNCE_MS = 10_000;
const MAX_RETRY_ATTEMPTS = 5;
const MAX_RETRY_DELAY_MS = 60_000;

interface PendingKnownLookup {
  explicit: boolean;
  promise: Promise<void>;
  resolve: () => void;
  reject: (reason: unknown) => void;
}

interface KnownLookupCycle {
  pending?: PendingKnownLookup;
}

export interface SharedContainerPublishTarget {
  projectId: string;
  worktreeId: string;
  /** Absent for a personal container; every server call then omits the hint. */
  organizationId?: string;
  containerId: string;
  containerType: SharedContainerType;
}

export function classifySharedContainerPublishFailure(
  error: unknown,
): 'terminal' | 'transient' {
  if (error instanceof SharedContainerPublishInventoryChangedError)
    return 'transient';
  if (!(error instanceof CanopyCloudClientError)) return 'terminal';
  if (error.serverCode === SHARED_CONTAINER_CLEANUP_IN_PROGRESS_ERROR_CODE) {
    return 'transient';
  }
  if (error.code === 'http-error' && !error.isValidatedServerError) {
    return 'transient';
  }
  if (error.code === 'network-error' || error.code === 'invalid-response') {
    return 'transient';
  }
  if (error.code !== 'http-error') return 'terminal';
  return error.status === 429 ||
    (error.status !== undefined && error.status >= 500)
    ? 'transient'
    : 'terminal';
}

export interface SharedContainerPublishSchedulerDependencies {
  publish: typeof publishSharedContainerRevisionForTarget;
  hasAudience: (target: SharedContainerPublishTarget) => Promise<boolean>;
  stateStore: SharedContainerPublicationStateStore;
  random: () => number;
  pruneStaging?: typeof pruneSharedContainerPublishStaging;
}

/**
 * Whether anyone can open the container: a recipient holds a grant, or a live
 * capability link lets people join. A link-only share has no grants until
 * somebody claims it, and it still has to publish before that first claim.
 */
export async function hasSharedContainerPublishAudience(
  target: SharedContainerPublishTarget,
): Promise<boolean> {
  const { recipients } = await listSharedContainerRecipients({
    containerId: target.containerId,
    organizationId: target.organizationId,
    limit: 1,
  });
  if (recipients.length > 0) return true;
  return (await getSharedContainerLink(target.containerId)) !== null;
}

const DEFAULT_DEPENDENCIES: SharedContainerPublishSchedulerDependencies = {
  publish: publishSharedContainerRevisionForTarget,
  hasAudience: hasSharedContainerPublishAudience,
  stateStore: getSharedContainerPublicationStateStore(),
  random: Math.random,
  pruneStaging: pruneSharedContainerPublishStaging,
};

export class SharedContainerPublishScheduler {
  private readonly debounceTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly retryTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly inFlight = new Set<string>();
  private readonly pending = new Map<string, boolean>();
  private readonly attempts = new Map<string, number>();
  private readonly knownLookups = new Map<string, KnownLookupCycle>();

  constructor(
    private readonly deps: SharedContainerPublishSchedulerDependencies = DEFAULT_DEPENDENCIES,
  ) {}

  schedule(target: SharedContainerPublishTarget, explicit = false): void {
    const key = this.key(target);
    if (this.inFlight.has(key)) {
      this.pending.set(key, explicit || this.pending.get(key) === true);
      return;
    }
    if (explicit) {
      const retry = this.retryTimers.get(key);
      if (retry) clearTimeout(retry);
      this.retryTimers.delete(key);
      this.attempts.delete(key);
    } else if (this.retryTimers.has(key)) {
      return;
    }
    const existing = this.debounceTimers.get(key);
    if (existing) clearTimeout(existing);
    this.debounceTimers.set(
      key,
      setTimeout(() => {
        this.debounceTimers.delete(key);
        void this.run(target, explicit ? 'explicit' : 'activity');
      }, SHARED_CONTAINER_PUBLISH_IDLE_DEBOUNCE_MS),
    );
  }

  async scheduleKnown(
    projectId: string,
    worktreeId: string,
    explicit = false,
  ): Promise<void> {
    const scopeKey = JSON.stringify([projectId, worktreeId]);
    const active = this.knownLookups.get(scopeKey);
    if (active) {
      if (active.pending) {
        active.pending.explicit ||= explicit;
        return active.pending.promise;
      }
      const handlers: {
        resolve: () => void;
        reject: (reason: unknown) => void;
      } = {
        resolve: (): void => undefined,
        reject: (): void => undefined,
      };
      const promise = new Promise<void>((innerResolve, innerReject): void => {
        handlers.resolve = (): void => innerResolve();
        handlers.reject = (reason: unknown): void =>
          innerReject(
            reason instanceof Error
              ? reason
              : Object.assign(new Error(String(reason)), { cause: reason }),
          );
      });
      active.pending = { explicit, promise, ...handlers };
      return promise;
    }

    const cycle: KnownLookupCycle = {};
    this.knownLookups.set(scopeKey, cycle);
    const lookup = this.scheduleKnownOnce(projectId, worktreeId, explicit);
    this.observeKnownLookup(scopeKey, cycle, projectId, worktreeId, lookup);
    return lookup;
  }

  private async scheduleKnownOnce(
    projectId: string,
    worktreeId: string,
    explicit: boolean,
  ): Promise<void> {
    const states = await this.deps.stateStore.list(projectId, worktreeId);
    for (const state of states) {
      if (state.containerId && state.containerType) {
        this.schedule(
          {
            projectId,
            worktreeId,
            organizationId: state.organizationId,
            containerId: state.containerId,
            containerType: state.containerType,
          },
          explicit,
        );
      }
    }
  }

  private observeKnownLookup(
    scopeKey: string,
    cycle: KnownLookupCycle,
    projectId: string,
    worktreeId: string,
    lookup: Promise<void>,
  ): void {
    const afterLookup = (): void => {
      if (this.knownLookups.get(scopeKey) !== cycle) return;
      const pending = cycle.pending;
      if (!pending) {
        this.knownLookups.delete(scopeKey);
        return;
      }
      cycle.pending = undefined;
      const rerun = this.scheduleKnownOnce(
        projectId,
        worktreeId,
        pending.explicit,
      );
      void rerun.then(pending.resolve, pending.reject);
      this.observeKnownLookup(scopeKey, cycle, projectId, worktreeId, rerun);
    };
    // Both outcomes must drain a queued caller. Attaching rejection handling
    // here also prevents an unobserved internal promise from leaking.
    void lookup.then(afterLookup, afterLookup);
  }

  async scheduleWorkspace(projectId: string): Promise<void> {
    try {
      const entries = await readdir(getWorktreeDataRootDir(projectId), {
        withFileTypes: true,
      });
      await Promise.all(
        entries
          .filter((entry) => entry.isDirectory())
          .map((entry) => this.scheduleKnown(projectId, entry.name)),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  async recover(
    records: readonly SharedContainerPublicationRecord[],
  ): Promise<void> {
    await (this.deps.pruneStaging ?? pruneSharedContainerPublishStaging)();
    await Promise.all(
      records.flatMap((state) => {
        const recoverFirstPublication = state.status === 'not-published';
        const recoverPersistedAttempt =
          (state.status === 'publishing' || state.status === 'error') &&
          (Boolean(state.idempotencyKey) ||
            state.restartWithFreshStage === true);
        const recoverPackage =
          state.packageRecoveryPending === true &&
          (state.packageRecoveryAttempts ?? 0) < MAX_RETRY_ATTEMPTS;
        if (
          !state.containerType ||
          !state.containerId ||
          state.terminalError ||
          (!recoverFirstPublication &&
            !recoverPersistedAttempt &&
            !recoverPackage)
        ) {
          return [];
        }
        return [
          this.run(
            {
              projectId: state.projectId,
              worktreeId: state.worktreeId,
              organizationId: state.organizationId,
              containerId: state.containerId,
              containerType: state.containerType,
            },
            'recovery',
          ),
        ];
      }),
    );
  }

  private async run(
    target: SharedContainerPublishTarget,
    mode: 'activity' | 'explicit' | 'recovery' | 'retry',
  ): Promise<void> {
    const key = this.key(target);
    if (this.inFlight.has(key)) {
      this.pending.set(
        key,
        mode === 'explicit' || this.pending.get(key) === true,
      );
      return;
    }
    this.inFlight.add(key);
    try {
      const state = await this.deps.stateStore.get(
        target.projectId,
        target.worktreeId,
        target.organizationId,
      );
      if (state?.containerId && state.containerId !== target.containerId) {
        return;
      }
      const retryOwnerActionableRefusal =
        mode === 'activity' &&
        state?.terminalError === true &&
        state.errorReason !== undefined;
      if (
        mode !== 'explicit' &&
        state?.terminalError &&
        !retryOwnerActionableRefusal
      ) {
        return;
      }
      if (
        (mode === 'explicit' || retryOwnerActionableRefusal) &&
        state?.terminalError
      ) {
        await this.deps.stateStore.set({
          projectId: target.projectId,
          worktreeId: target.worktreeId,
          organizationId: target.organizationId,
          containerId: target.containerId,
          containerType: target.containerType,
          status: 'not-published',
          ...(state.revision !== undefined ? { revision: state.revision } : {}),
          ...(state.revisionId ? { revisionId: state.revisionId } : {}),
          ...(state.publishedAt ? { publishedAt: state.publishedAt } : {}),
          updatedAt: new Date().toISOString(),
        });
        this.attempts.delete(key);
      } else if (
        mode === 'activity' &&
        state?.status === 'error' &&
        state.idempotencyKey
      ) {
        this.attempts.delete(key);
      }
      if (!(await this.deps.hasAudience(target))) return;
      const published = await this.deps.publish(target);
      this.attempts.delete(key);
      if (
        published?.packageRecoveryPending &&
        (published.packageRecoveryAttempts ?? 0) < MAX_RETRY_ATTEMPTS
      ) {
        const attempt = published.packageRecoveryAttempts ?? 1;
        this.retryTimers.set(
          key,
          setTimeout(
            () => {
              this.retryTimers.delete(key);
              void this.run(target, 'retry');
            },
            Math.min(MAX_RETRY_DELAY_MS, 1_000 * 2 ** Math.min(attempt, 5)),
          ),
        );
      }
    } catch (error) {
      const classification = classifySharedContainerPublishFailure(error);
      const attempt = (this.attempts.get(key) ?? 0) + 1;
      this.attempts.set(key, attempt);
      if (classification === 'transient' && attempt < MAX_RETRY_ATTEMPTS) {
        const jitter = Math.floor(
          this.deps.random() *
            Math.min(MAX_RETRY_DELAY_MS, 1_000 * 2 ** (attempt - 1)),
        );
        const retryAfter =
          error instanceof CanopyCloudClientError
            ? (error.retryAfterMs ?? 0)
            : 0;
        this.retryTimers.set(
          key,
          setTimeout(
            () => {
              this.retryTimers.delete(key);
              void this.run(target, 'retry');
            },
            Math.max(jitter, retryAfter),
          ),
        );
      } else {
        const current = await this.deps.stateStore.get(
          target.projectId,
          target.worktreeId,
          target.organizationId,
        );
        // The reason must describe *this* failure or not exist at all. The
        // renderer prefers the classified remedy over the exception string, so
        // carrying a previous run's reason forward would show the owner a
        // remedy for a refusal that is no longer happening.
        const { errorReason: _staleReason, ...carried } = current ?? {};
        void _staleReason;
        const reason = getSharedContainerPublishErrorReason(error);
        const parked: SharedContainerPublicationRecord = {
          ...carried,
          ...target,
          status: 'error',
          error: error instanceof Error ? error.message : 'Publish failed',
          ...(reason ? { errorReason: reason } : {}),
          ...(classification === 'terminal' ? { terminalError: true } : {}),
          updatedAt: new Date().toISOString(),
        };
        await this.deps.stateStore.set(parked);
        reportBackgroundFailure(
          'shared-container-publish.parked',
          reason ?? 'unclassified',
        );
      }
    } finally {
      this.inFlight.delete(key);
      const pendingExplicit = this.pending.get(key);
      if (pendingExplicit !== undefined) {
        this.pending.delete(key);
        this.schedule(target, pendingExplicit);
      }
    }
  }

  private key(target: SharedContainerPublishTarget): string {
    return `${target.projectId}/${target.worktreeId}/${sharedContainerOwnerKey(target.organizationId)}/${target.containerId}`;
  }
}

let scheduler: SharedContainerPublishScheduler | null = null;

export function getSharedContainerPublishScheduler(): SharedContainerPublishScheduler {
  scheduler ??= new SharedContainerPublishScheduler();
  return scheduler;
}
