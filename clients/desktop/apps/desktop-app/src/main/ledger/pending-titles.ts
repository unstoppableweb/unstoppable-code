import type { LedgerPendingTitleRecord } from '@canopy/desktop-shared/node/ledger';
import {
  getExecutionHarnessForModel,
  requireProviderForModel,
  resolveProviderModelConfig,
  type AgentModelConfig,
  type ThinkingLevel,
} from '@canopy/desktop-shared/types';
import type {
  LedgerContainer,
  LedgerEntry,
} from '@canopy/protocol/canopy-core';
import type { WorkOwner } from '@canopy/protocol';
import {
  BACKGROUND_HELPER_PRIORITIES,
  enqueueBackgroundHelperTask,
  type BackgroundHelperPriority,
} from '../lib/background-helper-queue';
import { resolveWorktreeCwd } from '../lib/resolve-worktree';
import { notifyLedgerEntryChanged } from './change-events';
import { ledgerDatabaseMayExist } from './lifecycle';
import { getLedgerStoreClient } from './storage-client';
import { ledgerTaskViewScopeForContainer } from './view-scope';

export const PENDING_TITLE_MAX_ATTEMPTS = 3;
export const PENDING_TITLE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** The first sweep waits for launch to settle, as Ledger sync does. */
export const PENDING_TITLE_STARTUP_DELAY_MS = 15 * 1000;
export const PENDING_TITLE_SWEEP_INTERVAL_MS = 60 * 1000;
export const PENDING_TITLE_GENERATION_TIMEOUT_MS = 30 * 1000;

export interface PendingTitleEntryContext {
  readonly container: LedgerContainer;
  readonly entry: Pick<LedgerEntry, 'entryId' | 'content'>;
  readonly titlePending: boolean;
}

export interface PendingTitleResolvedEntry {
  readonly entryId: string;
  readonly revision: number;
  readonly scope: { readonly container: LedgerContainer };
}

export interface PendingTitleOrchestratorHost {
  databaseMayExist(): Promise<boolean>;
  isEnabled(): boolean;
  listPendingTitles(): Promise<LedgerPendingTitleRecord[]>;
  recordPendingTitleAttempt(input: {
    readonly entryId: string;
  }): Promise<LedgerPendingTitleRecord | null>;
  readEntry(
    record: LedgerPendingTitleRecord,
  ): Promise<PendingTitleEntryContext | null>;
  resolvePendingTitle(input: {
    readonly entryId: string;
    readonly title: string | null;
  }): Promise<{
    readonly resolved: boolean;
    readonly entry: PendingTitleResolvedEntry | null;
  }>;
}

export interface PendingTitleGenerationInput {
  readonly record: LedgerPendingTitleRecord;
  readonly container: LedgerContainer;
  readonly entry: Pick<LedgerEntry, 'entryId' | 'content'>;
}

export interface PendingTitleSummaryInvocation {
  readonly projectId: string;
  readonly cwd: string;
  readonly observabilityTaskKey: string;
  readonly model?: string;
  readonly thinkingLevel?: ThinkingLevel;
  readonly modelConfig?: AgentModelConfig;
  /** Explicit null pins a missing owner instead of resolving live selection. */
  readonly workOwner: WorkOwner | null;
}

export interface PendingTitleSummarySettings {
  readonly model?: string;
  readonly thinkingLevel?: ThinkingLevel;
  readonly modelConfig?: AgentModelConfig;
}

export interface PendingTitleSummaryGeneratorHost {
  readSettings(): Promise<PendingTitleSummarySettings>;
  /**
   * The task a container's title helper runs in; null for a global
   * (workflow) Ledger, which has no worktree to run it in.
   */
  resolveScope(container: LedgerContainer): {
    readonly projectId: string;
    readonly worktreeId: string;
    readonly cwd: string;
  } | null;
  resolveWorkOwner(scope: {
    readonly projectId: string;
    readonly worktreeId: string;
  }): Promise<WorkOwner | undefined>;
  generateChatSummary(
    text: string,
    invocation: PendingTitleSummaryInvocation,
  ): Promise<{
    readonly text: string;
    readonly fallback?: { readonly skipped?: true };
  }>;
}

export type PendingTitleSummaryGenerator = (
  input: PendingTitleGenerationInput,
) => Promise<string | null>;

/**
 * Thrown by the title generator when the helper was not started because its
 * provider is signed out with no billing source (CAN-7062). The orchestrator
 * leaves the title pending instead of resolving it.
 */
export class PendingTitleGenerationSkippedError extends Error {
  constructor() {
    super('The title helper was skipped.');
    this.name = 'PendingTitleGenerationSkippedError';
  }
}

/** Builds the injectable adapter used by both production and unit tests. */
export function createPendingTitleSummaryGenerator(
  host: PendingTitleSummaryGeneratorHost,
): PendingTitleSummaryGenerator {
  return async (input: PendingTitleGenerationInput): Promise<string | null> => {
    const scope = host.resolveScope(input.container);
    // A global entry keeps its provisional title: no task to generate in.
    if (scope === null) return null;
    const settings = await host.readSettings();
    let workOwner: WorkOwner | undefined;
    try {
      workOwner = await host.resolveWorkOwner({
        projectId: scope.projectId,
        worktreeId: scope.worktreeId,
      });
    } catch {
      // Fail closed to no organization when the captured owner is unavailable.
    }
    const result = await host.generateChatSummary(input.entry.content, {
      projectId: scope.projectId,
      cwd: scope.cwd,
      observabilityTaskKey: `helper:ledger-title:${input.record.ledgerId}/${input.record.entryId}`,
      ...(settings.model === undefined ? {} : { model: settings.model }),
      ...(settings.thinkingLevel === undefined
        ? {}
        : { thinkingLevel: settings.thinkingLevel }),
      ...(settings.modelConfig === undefined
        ? {}
        : { modelConfig: settings.modelConfig }),
      workOwner: workOwner ?? null,
    });
    if (result.fallback?.skipped === true) {
      throw new PendingTitleGenerationSkippedError();
    }
    if (result.fallback !== undefined) return null;
    const title = result.text.trim();
    return title.length === 0 ? null : title;
  };
}

/** A title helper's answer, or that the deadline came first. */
type GenerationOutcome =
  | { readonly timedOut: false; readonly title: string | null }
  | { readonly timedOut: true };

export interface PendingTitleOrchestratorOptions {
  readonly host: PendingTitleOrchestratorHost;
  readonly generateTitle: PendingTitleSummaryGenerator;
  readonly enqueue: (
    task: () => Promise<void>,
    priority: BackgroundHelperPriority,
  ) => Promise<unknown> | void;
  readonly notifyResolved: (change: {
    readonly container: LedgerContainer;
    readonly ledgerId: string;
    readonly entryId: string;
    readonly revision: number;
    readonly titleResolved: true;
  }) => void;
  /**
   * Whether a marker's helper is known, from caches alone, to be refused
   * because its provider is signed out with no billing source (CAN-7062).
   * A skipped marker records no attempt and stays pending for a later sweep.
   * `readEntry` reads the marker's entry through the orchestrator's storage
   * tracking, for a check that needs the entry's workspace.
   */
  readonly isGenerationSkipped?: (
    readEntry: () => Promise<PendingTitleEntryContext | null>,
  ) => Promise<boolean>;
  readonly now?: () => number;
  readonly startupDelayMs?: number;
  readonly sweepIntervalMs?: number;
  readonly generationTimeoutMs?: number;
}

/** Durable, retry-bounded title generation over the local storage host. */
export class PendingTitleOrchestrator {
  private readonly options: PendingTitleOrchestratorOptions;
  private readonly now: () => number;
  private readonly startupDelayMs: number;
  private readonly sweepIntervalMs: number;
  private readonly generationTimeoutMs: number;
  private readonly scheduled = new Set<string>();
  private readonly activeStorage = new Set<Promise<unknown>>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private sweepInProgress: Promise<void> | undefined;
  private stopped = false;

  constructor(options: PendingTitleOrchestratorOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.startupDelayMs =
      options.startupDelayMs ?? PENDING_TITLE_STARTUP_DELAY_MS;
    this.sweepIntervalMs =
      options.sweepIntervalMs ?? PENDING_TITLE_SWEEP_INTERVAL_MS;
    this.generationTimeoutMs =
      options.generationTimeoutMs ?? PENDING_TITLE_GENERATION_TIMEOUT_MS;
  }

  /**
   * Schedules the sweeps. None runs at launch: the first waits for the
   * startup delay, then one runs every interval.
   */
  start(): void {
    if (this.stopped || this.timer !== undefined) return;
    this.scheduleSweep(this.startupDelayMs);
  }

  /** Schedules a marker after its add transaction committed. */
  enqueue(record: LedgerPendingTitleRecord): void {
    if (this.stopped || this.scheduled.has(record.entryId)) return;
    const cleanupOnly = this.needsCleanup(record);
    if (!cleanupOnly && !this.isEnabled()) return;
    this.scheduled.add(record.entryId);
    const task = async (): Promise<void> => {
      try {
        await this.process(record);
      } catch {
        // The marker remains durable and the next sweep will retry it.
      } finally {
        this.scheduled.delete(record.entryId);
      }
    };
    try {
      const queued = this.options.enqueue(
        task,
        BACKGROUND_HELPER_PRIORITIES.chatMetadata,
      );
      void Promise.resolve(queued).catch((): void => {
        this.scheduled.delete(record.entryId);
      });
    } catch {
      this.scheduled.delete(record.entryId);
    }
  }

  /**
   * Scans the durable markers while the Ledger is on. With it off, sync is
   * off too, so a held scope waits for it without a probe or a store read.
   */
  async sweep(): Promise<void> {
    if (this.stopped) return;
    if (this.sweepInProgress !== undefined) return this.sweepInProgress;
    const sweep = this.runSweep();
    this.sweepInProgress = sweep;
    try {
      await sweep;
    } finally {
      if (this.sweepInProgress === sweep) this.sweepInProgress = undefined;
    }
  }

  /** Stops enqueues and waits only for in-flight storage operations, not providers. */
  async shutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    while (this.activeStorage.size > 0) {
      await Promise.allSettled(Array.from(this.activeStorage));
    }
  }

  private scheduleSweep(delayMs: number): void {
    const sweepTimer = setTimeout((): void => {
      void this.sweep()
        .catch((): void => undefined)
        .finally((): void => {
          if (!this.stopped && this.timer === sweepTimer) {
            this.scheduleSweep(this.sweepIntervalMs);
          }
        });
    }, delayMs);
    sweepTimer.unref?.();
    this.timer = sweepTimer;
  }

  private async runSweep(): Promise<void> {
    if (!this.isEnabled()) return;
    let mayExist = false;
    try {
      mayExist = await this.options.host.databaseMayExist();
    } catch {
      return;
    }
    if (this.stopped || !mayExist) return;
    let records: LedgerPendingTitleRecord[];
    try {
      records = await this.withStorage(() =>
        this.options.host.listPendingTitles(),
      );
    } catch {
      return;
    }
    if (this.stopped) return;
    for (const record of records) {
      if (this.needsCleanup(record)) {
        try {
          await this.resolve(record, null);
        } catch {
          // A future sweep will retry direct stale/exhaustion cleanup.
        }
      } else {
        this.enqueue(record);
      }
    }
  }

  private async process(record: LedgerPendingTitleRecord): Promise<void> {
    if (this.stopped) return;
    if (this.isStale(record) || record.attempts >= PENDING_TITLE_MAX_ATTEMPTS) {
      await this.resolve(record, null);
      return;
    }
    if (!this.isEnabled()) return;
    // Checked before the attempt is recorded, so a skip the cached auth state
    // predicts uses none of the marker's bounded attempts. On a cold auth
    // cache the check can't predict it: the attempt is recorded and the
    // generation is then skipped, which costs that one attempt.
    if (await this.isGenerationSkipped(record)) return;

    const attempted = await this.withStorage(() =>
      this.options.host.recordPendingTitleAttempt({ entryId: record.entryId }),
    );
    if (this.stopped || attempted === null) return;
    if (attempted.attempts > PENDING_TITLE_MAX_ATTEMPTS) {
      await this.resolve(record, null);
      return;
    }

    const context = await this.withStorage(() =>
      this.options.host.readEntry(attempted),
    );
    if (this.stopped) return;
    if (context === null || !context.titlePending) {
      await this.resolve(record, null);
      return;
    }

    const generation = this.options.generateTitle({
      record: attempted,
      container: context.container,
      entry: context.entry,
    });
    let title: string | null;
    let timedOut = false;
    try {
      const outcome = await this.raceDeadline(generation);
      timedOut = outcome.timedOut;
      title = outcome.timedOut ? null : outcome.title;
    } catch (error) {
      // A skipped helper never started (CAN-7062): the title stays pending.
      if (
        !(error instanceof PendingTitleGenerationSkippedError) &&
        attempted.attempts >= PENDING_TITLE_MAX_ATTEMPTS
      ) {
        await this.resolve(record, null);
      }
      return;
    }
    if (!this.stopped) {
      if (title !== null && title.trim().length > 0) {
        await this.resolve(record, title.trim());
      } else {
        await this.resolve(record, null);
      }
    }
    // The helper can't be cancelled, so a timed-out task keeps its queue slot
    // until the provider settles; later helpers never run beside it. Its
    // marker was released above, so the scope's sync does not wait.
    if (timedOut) await generation.catch((): null => null);
  }

  private async raceDeadline(
    generation: Promise<string | null>,
  ): Promise<GenerationOutcome> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<GenerationOutcome>((resolve) => {
      timer = setTimeout(
        () => resolve({ timedOut: true }),
        this.generationTimeoutMs,
      );
      timer.unref?.();
    });
    try {
      return await Promise.race([
        generation.then(
          (title): GenerationOutcome => ({ timedOut: false, title }),
        ),
        deadline,
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async resolve(
    record: Pick<LedgerPendingTitleRecord, 'entryId' | 'ledgerId'>,
    title: string | null,
  ): Promise<void> {
    if (this.stopped) return;
    const { entryId } = record;
    const result = await this.withStorage(() =>
      this.options.host.resolvePendingTitle({ entryId, title }),
    );
    if (this.stopped || !result.resolved || result.entry === null) return;
    try {
      this.options.notifyResolved({
        container: result.entry.scope.container,
        ledgerId: record.ledgerId,
        entryId: result.entry.entryId,
        revision: result.entry.revision,
        titleResolved: true,
      });
    } catch {
      // The durable marker was cleared already; next reads still see the result.
    }
  }

  private withStorage<Result>(
    operation: () => Promise<Result>,
  ): Promise<Result> {
    const work = Promise.resolve().then(operation);
    this.activeStorage.add(work);
    void work
      .finally((): void => {
        this.activeStorage.delete(work);
      })
      .catch((): void => undefined);
    return work;
  }

  private isEnabled(): boolean {
    try {
      return this.options.host.isEnabled();
    } catch {
      return false;
    }
  }

  private async isGenerationSkipped(
    record: LedgerPendingTitleRecord,
  ): Promise<boolean> {
    try {
      return (
        (await this.options.isGenerationSkipped?.(() =>
          this.withStorage(() => this.options.host.readEntry(record)),
        )) === true
      );
    } catch {
      return false;
    }
  }

  private isStale(record: LedgerPendingTitleRecord): boolean {
    const createdAt = Date.parse(record.createdAt);
    return (
      !Number.isFinite(createdAt) ||
      this.now() - createdAt >= PENDING_TITLE_MAX_AGE_MS
    );
  }

  private needsCleanup(record: LedgerPendingTitleRecord): boolean {
    return (
      this.isStale(record) || record.attempts >= PENDING_TITLE_MAX_ATTEMPTS
    );
  }
}

let desktopOrchestrator: PendingTitleOrchestrator | undefined;

/** Creates the concrete desktop host adapter without touching storage yet. */
export function startDesktopPendingTitleOrchestrator(options: {
  readonly isEnabled: () => boolean;
}): void {
  if (desktopOrchestrator !== undefined) return;
  const readSettings = async (): Promise<PendingTitleSummarySettings> => {
    const { readPreferencesFile } = await import('../lib/preferences-store');
    const preferences = await readPreferencesFile();
    const model = preferences.summaryModel;
    const thinkingLevel = preferences.summaryThinkingLevel;
    const modelConfig =
      getExecutionHarnessForModel(model) === 'codex'
        ? resolveProviderModelConfig(
            'codex',
            { thinkingLevel },
            preferences.providerModelConfigDefaults,
          )
        : undefined;
    return {
      model,
      thinkingLevel,
      ...(modelConfig === undefined ? {} : { modelConfig }),
    };
  };
  const generateTitle = createPendingTitleSummaryGenerator({
    readSettings,
    resolveScope: (
      container: LedgerContainer,
    ): {
      readonly projectId: string;
      readonly worktreeId: string;
      readonly cwd: string;
    } | null => {
      const scope = ledgerTaskViewScopeForContainer(container);
      return scope === null
        ? null
        : {
            ...scope,
            cwd: resolveWorktreeCwd(scope.projectId, scope.worktreeId),
          };
    },
    resolveWorkOwner: async (scope: {
      readonly projectId: string;
      readonly worktreeId: string;
    }): Promise<WorkOwner | undefined> => {
      const { resolveInvocationWorkOwner } =
        await import('../agents/work-owner');
      return resolveInvocationWorkOwner(scope);
    },
    generateChatSummary: async (
      text: string,
      invocation: PendingTitleSummaryInvocation,
    ): Promise<{
      readonly text: string;
      readonly fallback?: { readonly skipped?: true };
    }> => {
      const { generateChatSummary } = await import('../agents/utils');
      return generateChatSummary(text, {
        model: invocation.model,
        thinkingLevel: invocation.thinkingLevel,
        modelConfig: invocation.modelConfig,
        cwd: invocation.cwd,
        workspaceId: invocation.projectId,
        workOwner: invocation.workOwner,
        observabilityTaskKey: invocation.observabilityTaskKey,
      });
    },
  });

  const host: PendingTitleOrchestratorHost = {
    databaseMayExist: ledgerDatabaseMayExist,
    isEnabled: options.isEnabled,
    listPendingTitles: (): Promise<LedgerPendingTitleRecord[]> =>
      getLedgerStoreClient().listPendingTitles(),
    recordPendingTitleAttempt: (input: {
      readonly entryId: string;
    }): Promise<LedgerPendingTitleRecord | null> =>
      getLedgerStoreClient().recordPendingTitleAttempt(input),
    readEntry: async (record): Promise<PendingTitleEntryContext | null> => {
      const store = getLedgerStoreClient();
      const [scope, result] = await Promise.all([
        store.getScope(record.ledgerId),
        store.getEntry({ ledgerId: record.ledgerId, entryId: record.entryId }),
      ]);
      if (scope === null || result.titlePending !== true) return null;
      return {
        container: scope.scope.container,
        entry: result.entry,
        titlePending: true,
      };
    },
    resolvePendingTitle: (input: {
      readonly entryId: string;
      readonly title: string | null;
    }): Promise<{
      readonly resolved: boolean;
      readonly entry: PendingTitleResolvedEntry | null;
    }> => getLedgerStoreClient().resolvePendingTitle(input),
  };

  // Cache-only: with the provider signed out and nothing to pay for the
  // helper (CAN-7062), a sweep leaves the marker pending without an attempt.
  // The workspace check runs only when the global one predicts a refusal,
  // because a workspace Environment credential replaces the global one.
  const isGenerationSkipped = async (
    readEntry: () => Promise<PendingTitleEntryContext | null>,
  ): Promise<boolean> => {
    const { model } = await readSettings();
    if (model === undefined) return false;
    const provider = requireProviderForModel(model);
    const { isNoBillingSourceRefusalCached } =
      await import('../agents/no-billing-source-refusal');
    if (!isNoBillingSourceRefusalCached({ model }, provider)) return false;
    const context = await readEntry();
    const scope =
      context === null
        ? null
        : ledgerTaskViewScopeForContainer(context.container);
    // A missing entry or a global Ledger is resolved by the normal path.
    if (scope === null) return false;
    return isNoBillingSourceRefusalCached(
      { model, projectId: scope.projectId },
      provider,
    );
  };

  desktopOrchestrator = new PendingTitleOrchestrator({
    host,
    generateTitle,
    isGenerationSkipped,
    enqueue: (task, priority): Promise<void> =>
      enqueueBackgroundHelperTask({
        priority,
        task,
      }),
    notifyResolved: notifyLedgerEntryChanged,
  });
  desktopOrchestrator.start();
}

/** Queues a just-committed marker when the desktop scheduler is running. */
export function enqueueDesktopPendingTitle(
  record: LedgerPendingTitleRecord,
): void {
  desktopOrchestrator?.enqueue(record);
}

/** Quiesces title jobs and drains storage before the storage host closes. */
export async function shutdownDesktopPendingTitleOrchestrator(): Promise<void> {
  const orchestrator = desktopOrchestrator;
  desktopOrchestrator = undefined;
  await orchestrator?.shutdown();
}
