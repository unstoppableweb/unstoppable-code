/**
 * Capability-package counts for the share preview (CAN-4655, plan §4/§6).
 *
 * The preview never analyzes. It shows counts only from a completed analysis
 * whose scope key matches the container's current scope; a cold or stale
 * scope returns no counts and starts one background analysis, deduplicated
 * per container, bounded in time and concurrency, and cancelled when the
 * scope moves on. Nothing pushes the result to an open dialog: the next
 * preview request reads the refreshed cache. Publication reuses the same
 * cache entry, and a refresh and a publication of the same scope and inputs
 * share one in-flight analysis.
 */
import type {
  ChatTabsFile,
  SharedContainerFileScope,
  SharedContainerPreviewRequest,
} from '@canopy/desktop-shared/types';
import type { SharedContainerCapabilityPackageCounts } from '@canopy/protocol/shared-containers';
import { logMainProcessWarn } from '../../lib/main-process-logging';
import { isSharedAutomationsWorkflowFormEnabled } from '../../automations/shared-workflow-form-flag';
import type { SharedContainerLocalRepository } from '../local-repositories';
import type {
  AnalyzeSharedContainerCapabilityPackageInput,
  CompletedSharedContainerCapabilityPackageAnalysis,
  SharedContainerCapabilityPackageAnalysis,
} from './analyze';
import {
  getSharedContainerCapabilityPackageAnalysisCache,
  sharedContainerCapabilityPackageInputKey,
  sharedContainerCapabilityPackageScopeKey,
  type SharedContainerCapabilityPackageAnalysisCache,
  type SharedContainerCapabilityPackageTarget,
} from './analysis-cache';

/** A background analysis that takes longer than this is abandoned. */
const PREVIEW_ANALYSIS_TIMEOUT_MS = 60_000;
/** A matching entry older than this is shown and revalidated. */
const PREVIEW_REVALIDATE_AFTER_MS = 30_000;
const MAX_CONCURRENT_PREVIEW_ANALYSES = 2;

export interface SharedContainerCapabilityPackagePreviewDependencies {
  cache: SharedContainerCapabilityPackageAnalysisCache;
  readChatTabs: (
    projectId: string,
    worktreeId: string,
  ) => Promise<ChatTabsFile>;
  listRepositories: (
    projectId: string,
    worktreeId: string,
  ) => Promise<SharedContainerLocalRepository[]>;
  listTrackedPaths: (repoPath: string) => Promise<string[]>;
  analyze: (
    input: AnalyzeSharedContainerCapabilityPackageInput,
    options: { previous?: CompletedSharedContainerCapabilityPackageAnalysis },
  ) => Promise<SharedContainerCapabilityPackageAnalysis>;
  now: () => number;
  timeoutMs: number;
  /** The workflow-form flag (CAN-6455). */
  workflowForm: () => boolean;
}

const DEFAULT_DEPENDENCIES: SharedContainerCapabilityPackagePreviewDependencies =
  {
    cache: getSharedContainerCapabilityPackageAnalysisCache(),
    readChatTabs: async (projectId, worktreeId) => {
      const { readChatTabsFileForIndex } =
        await import('../../lib/chat-tabs-reader');
      return readChatTabsFileForIndex(projectId, worktreeId);
    },
    listRepositories: async (projectId, worktreeId) => {
      const { listSharedContainerLocalRepositories } =
        await import('../local-repositories');
      return listSharedContainerLocalRepositories(projectId, worktreeId);
    },
    listTrackedPaths: async (repoPath) => {
      const { listSharedContainerTrackedPaths } = await import('./prepare');
      return listSharedContainerTrackedPaths(repoPath);
    },
    analyze: async (input, options) => {
      const { analyzeSharedContainerCapabilityPackage } =
        await import('./analyze');
      return analyzeSharedContainerCapabilityPackage(input, undefined, options);
    },
    now: () => Date.now(),
    timeoutMs: PREVIEW_ANALYSIS_TIMEOUT_MS,
    workflowForm: isSharedAutomationsWorkflowFormEnabled,
  };

function targetKey(target: SharedContainerCapabilityPackageTarget): string {
  return `${target.projectId}\0${target.worktreeId}\0${target.containerType}`;
}

interface InFlightRefresh {
  scopeKey: string;
  controller: AbortController;
  done: Promise<void>;
}

export class SharedContainerCapabilityPackagePreviewRefresher {
  private readonly inFlight = new Map<string, InFlightRefresh>();

  constructor(
    private readonly deps: SharedContainerCapabilityPackagePreviewDependencies = DEFAULT_DEPENDENCIES,
  ) {}

  /**
   * Counts of the completed analysis for the current scope, or undefined.
   * Starts a background refresh when the scope is cold, stale or due for
   * revalidation; never waits for it.
   */
  async readCounts(
    request: Pick<
      SharedContainerPreviewRequest,
      'projectId' | 'worktreeId' | 'containerType'
    >,
    fileScope: SharedContainerFileScope,
  ): Promise<SharedContainerCapabilityPackageCounts | undefined> {
    const { containerType } = request;
    // Cloud chats carry no capability package.
    if (
      containerType !== 'CODE_WORKTREE' &&
      containerType !== 'COWORK_WORK_ENTRY'
    )
      return undefined;
    const target: SharedContainerCapabilityPackageTarget = {
      projectId: request.projectId,
      worktreeId: request.worktreeId,
      containerType,
    };
    let chatTabs: ChatTabsFile;
    try {
      chatTabs = await this.deps.readChatTabs(
        target.projectId,
        target.worktreeId,
      );
    } catch {
      return undefined;
    }
    // CAN-6455: one reading of the flag decides the key and the analysis.
    const workflowForm = this.deps.workflowForm();
    const scopeKey = sharedContainerCapabilityPackageScopeKey({
      containerType: target.containerType,
      chatTabs,
      fileScope,
      ...(workflowForm ? { workflowForm } : {}),
    });
    const entry = this.deps.cache.get(target);
    const matches = entry?.scopeKey === scopeKey;
    if (
      !entry ||
      !matches ||
      this.deps.now() - entry.completedAt >= PREVIEW_REVALIDATE_AFTER_MS
    ) {
      this.refresh(target, chatTabs, scopeKey, workflowForm);
    }
    return matches && entry.analysis.state === 'ready'
      ? entry.analysis.summary.counts
      : undefined;
  }

  /** Resolves when every background analysis started so far has settled. */
  async whenIdle(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.all(
        Array.from(this.inFlight.values(), (refresh) => refresh.done),
      );
    }
  }

  cancelAll(): void {
    for (const refresh of Array.from(this.inFlight.values()))
      refresh.controller.abort();
  }

  private refresh(
    target: SharedContainerCapabilityPackageTarget,
    chatTabs: ChatTabsFile,
    scopeKey: string,
    workflowForm: boolean,
  ): void {
    const key = targetKey(target);
    const existing = this.inFlight.get(key);
    if (existing?.scopeKey === scopeKey) return;
    if (existing) existing.controller.abort();
    else if (this.inFlight.size >= MAX_CONCURRENT_PREVIEW_ANALYSES) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(this.deps.timeoutMs),
    ]);
    const done = this.run(target, chatTabs, scopeKey, workflowForm, signal)
      .catch((error: unknown) => {
        if (signal.aborted) return;
        logMainProcessWarn(
          '[shared-containers] capability package preview analysis failed',
          { error: error instanceof Error ? error.name : typeof error },
        );
      })
      .finally(() => {
        if (this.inFlight.get(key)?.controller === controller)
          this.inFlight.delete(key);
      });
    this.inFlight.set(key, { scopeKey, controller, done });
  }

  private async run(
    target: SharedContainerCapabilityPackageTarget,
    chatTabs: ChatTabsFile,
    scopeKey: string,
    workflowForm: boolean,
    signal: AbortSignal,
  ): Promise<void> {
    const includedChatIds = chatTabs.tabs
      .filter((tab) => tab.kind !== 'file')
      .map((tab) => tab.id);
    let code: Pick<
      AnalyzeSharedContainerCapabilityPackageInput,
      'snapshotPaths' | 'repositories'
    > = {};
    if (target.containerType === 'CODE_WORKTREE') {
      // Without the publication inventory the preview approximates the
      // snapshot by each checkout's index. Publication derives the paths from
      // its inventory; a difference only means publication analyzes again.
      const repositories = await this.deps.listRepositories(
        target.projectId,
        target.worktreeId,
      );
      const snapshot: Array<{
        repoId: string;
        repoPath: string;
        paths: string[];
      }> = [];
      for (const repository of repositories) {
        signal.throwIfAborted();
        snapshot.push({
          repoId: repository.repoId,
          repoPath: repository.repoPath,
          paths: await this.deps
            .listTrackedPaths(repository.repoPath)
            .catch((): string[] => {
              signal.throwIfAborted();
              return [];
            }),
        });
      }
      code = {
        snapshotPaths: { repositories: snapshot },
        repositories: repositories.map(({ repoId, repoPath }) => ({
          repoId,
          repoPath,
        })),
      };
    }
    signal.throwIfAborted();
    const analysisInput = {
      ...target,
      includedChatIds,
      ...code,
      ...(workflowForm ? { workflowForm } : {}),
    };
    // Joins a publication analysis of the same scope and inputs. The shared
    // analysis caches a completed result; a failed one is not an empty
    // package, so the line stays absent.
    await this.deps.cache.analyzeShared({
      target,
      scopeKey,
      inputKey: sharedContainerCapabilityPackageInputKey(analysisInput),
      timeoutMs: this.deps.timeoutMs,
      now: this.deps.now,
      signal,
      keepAlive: false,
      analyze: (sharedSignal, previous) =>
        this.deps.analyze(
          { ...analysisInput, signal: sharedSignal },
          previous ? { previous } : {},
        ),
    });
  }
}

let sharedRefresher:
  | SharedContainerCapabilityPackagePreviewRefresher
  | undefined;

export function getSharedContainerCapabilityPackagePreviewRefresher(): SharedContainerCapabilityPackagePreviewRefresher {
  sharedRefresher ??= new SharedContainerCapabilityPackagePreviewRefresher();
  return sharedRefresher;
}

export function readSharedContainerCapabilityPackagePreviewCounts(
  request: Pick<
    SharedContainerPreviewRequest,
    'projectId' | 'worktreeId' | 'containerType'
  >,
  fileScope: SharedContainerFileScope,
): Promise<SharedContainerCapabilityPackageCounts | undefined> {
  return getSharedContainerCapabilityPackagePreviewRefresher().readCounts(
    request,
    fileScope,
  );
}
