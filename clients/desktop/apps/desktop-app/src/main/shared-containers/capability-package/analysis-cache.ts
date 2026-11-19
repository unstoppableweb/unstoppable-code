/**
 * The last completed capability-package analysis of each shared container
 * (CAN-4655, plan §4 preview and §5 publish).
 *
 * Both the share preview and the publisher read and refresh it. The preview
 * shows counts only from an entry whose scope key matches the container's
 * current scope; the publisher passes the entry to the composer, which reuses
 * it without running the analyzer when its content key matches and none of
 * its sources changed.
 *
 * It also owns the analyses in flight. A publish attempt, its retries and a
 * preview refresh that analyze the same scope and inputs share one analysis
 * instead of stacking concurrent full analyses of one container.
 *
 * In memory only: an analysis holds the package blobs it would upload, which
 * do not belong on disk, and a cold start simply analyzes again.
 */
import { createHash } from 'node:crypto';
import { stableStringify } from '@canopy/desktop-shared/lib/stable-hash';
import type {
  ChatTabsFile,
  SharedContainerFileScope,
} from '@canopy/desktop-shared/types';
import type {
  AnalyzeSharedContainerCapabilityPackageInput,
  CompletedSharedContainerCapabilityPackageAnalysis,
  SharedContainerCapabilityPackageAnalysis,
  SharedContainerCapabilityPackageContainerType,
} from './analyze';

const MAX_ENTRIES = 8;
/** Ready analyses retain their package blobs; bound what the cache holds. */
const MAX_RETAINED_PACKAGE_BYTES = 64 * 1024 * 1024;

export interface SharedContainerCapabilityPackageTarget {
  projectId: string;
  worktreeId: string;
  containerType: SharedContainerCapabilityPackageContainerType;
}

export interface SharedContainerCapabilityPackageCacheEntry extends SharedContainerCapabilityPackageTarget {
  /** Cheap identity of the inputs a preview can see without analyzing. */
  scopeKey: string;
  analysis: CompletedSharedContainerCapabilityPackageAnalysis;
  /** When the analysis started; a later start supersedes an earlier one. */
  startedAt: number;
  completedAt: number;
}

function targetKey(target: SharedContainerCapabilityPackageTarget): string {
  return `${target.projectId}\0${target.worktreeId}\0${target.containerType}`;
}

/**
 * Identity of a container's capability scope as far as it can be read
 * without analysis: its included chats with their transcript revisions and
 * the approved file scope that decides what the code snapshot carries.
 * Changes to definitions, selections or skill files are found by the
 * background refresh the preview starts, not by this key. The workflow-form
 * flag (CAN-6455) is part of it, so turning it on misses every entry.
 */
export function sharedContainerCapabilityPackageScopeKey(input: {
  containerType: SharedContainerCapabilityPackageContainerType;
  chatTabs: ChatTabsFile;
  fileScope: SharedContainerFileScope;
  workflowForm?: boolean;
}): string {
  const chats = input.chatTabs.tabs
    .filter((tab) => tab.kind !== 'file')
    .map((tab) => ({
      id: tab.id,
      transcript: tab.transcript ?? null,
      inline: tab.transcript
        ? null
        : {
            count: tab.messages.length,
            last: tab.messages[tab.messages.length - 1]?.id ?? null,
          },
    }))
    .sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    );
  return createHash('sha256')
    .update(
      stableStringify({
        version: 1,
        containerType: input.containerType,
        chats,
        fileScope: input.fileScope,
        ...(input.workflowForm === true ? { workflowForm: true } : {}),
      }),
    )
    .digest('hex');
}

/**
 * Identity of everything an analysis reads from its input: the included
 * chats and, for a code container, the snapshot paths and repositories.
 * Together with the scope key it decides whether two requests may share
 * one analysis.
 */
export function sharedContainerCapabilityPackageInputKey(
  input: Omit<AnalyzeSharedContainerCapabilityPackageInput, 'signal'>,
): string {
  const compare = (left: string, right: string): number =>
    left < right ? -1 : left > right ? 1 : 0;
  return createHash('sha256')
    .update(
      stableStringify({
        version: 1,
        projectId: input.projectId,
        worktreeId: input.worktreeId,
        containerType: input.containerType,
        includedChatIds: Array.from(new Set(input.includedChatIds)).sort(
          compare,
        ),
        snapshotPaths: input.snapshotPaths
          ? input.snapshotPaths.repositories
              .map((repository) => ({
                repoId: repository.repoId,
                repoPath: repository.repoPath,
                paths: Array.from(new Set(repository.paths)).sort(compare),
              }))
              .sort((left, right) => compare(left.repoId, right.repoId))
          : null,
        repositories: input.repositories
          ? [...input.repositories]
              .map(({ repoId, repoPath }) => ({ repoId, repoPath }))
              .sort((left, right) => compare(left.repoId, right.repoId))
          : null,
        ...(input.workflowForm === true ? { workflowForm: true } : {}),
      }),
    )
    .digest('hex');
}

/** Rejects with the signal's reason once it aborts; never settles `work`. */
export function untilSharedContainerAnalysisAborted<T>(
  work: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error('Shared-container package analysis aborted'),
      );
    };
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export interface SharedContainerCapabilityPackageSharedAnalysisRequest {
  target: SharedContainerCapabilityPackageTarget;
  /** Scope identity the result is cached under. */
  scopeKey: string;
  /** {@link sharedContainerCapabilityPackageInputKey} of the analyzed input. */
  inputKey: string;
  /** Bound for an analysis this request starts. */
  timeoutMs: number;
  now: () => number;
  /** Stops this caller waiting; the result rejects with its reason. */
  signal: AbortSignal;
  /**
   * When false, the analysis is cancelled once every waiter has stopped
   * waiting (a superseded preview). When true it runs to completion or its
   * timeout even after this caller stops waiting, so a later publish attempt
   * can reuse it.
   */
  keepAlive: boolean;
  analyze: (
    signal: AbortSignal,
    previous: CompletedSharedContainerCapabilityPackageAnalysis | undefined,
  ) => Promise<SharedContainerCapabilityPackageAnalysis>;
}

interface InFlightAnalysis {
  controller: AbortController;
  /** The analysis's own signal: its controller or its timeout. */
  signal: AbortSignal;
  waiters: number;
  keepAlive: boolean;
  result: Promise<SharedContainerCapabilityPackageAnalysis>;
}

export class SharedContainerCapabilityPackageAnalysisCache {
  private readonly entries = new Map<
    string,
    SharedContainerCapabilityPackageCacheEntry
  >();

  private readonly inFlight = new Map<string, InFlightAnalysis>();

  /**
   * Runs the analysis of one scope and input, or joins the one already
   * running for them. A completed (non-failed) result is cached under the
   * scope key before any waiter sees it.
   */
  analyzeShared(
    request: SharedContainerCapabilityPackageSharedAnalysisRequest,
  ): Promise<SharedContainerCapabilityPackageAnalysis> {
    request.signal.throwIfAborted();
    const key = `${targetKey(request.target)}\0${request.scopeKey}\0${request.inputKey}`;
    const running = this.inFlight.get(key);
    // A cancelled or timed-out analysis is never joined.
    const flight =
      running && !running.signal.aborted ? running : this.start(key, request);
    if (request.keepAlive) flight.keepAlive = true;
    flight.waiters += 1;
    const leave = (): void => {
      flight.waiters -= 1;
      if (flight.waiters > 0 || flight.keepAlive) return;
      if (this.inFlight.get(key) === flight) this.inFlight.delete(key);
      flight.controller.abort(request.signal.reason);
    };
    request.signal.addEventListener('abort', leave, { once: true });
    const settled = (): void => {
      request.signal.removeEventListener('abort', leave);
    };
    flight.result.then(settled, settled);
    return untilSharedContainerAnalysisAborted(flight.result, request.signal);
  }

  private start(
    key: string,
    request: SharedContainerCapabilityPackageSharedAnalysisRequest,
  ): InFlightAnalysis {
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(request.timeoutMs),
    ]);
    const previous = this.get(request.target)?.analysis;
    const startedAt = request.now();
    const result = request.analyze(signal, previous).then((analysis) => {
      if (analysis.state !== 'failed') {
        this.set({
          ...request.target,
          scopeKey: request.scopeKey,
          analysis,
          startedAt,
          completedAt: request.now(),
        });
      }
      return analysis;
    });
    const flight: InFlightAnalysis = {
      controller,
      signal,
      waiters: 0,
      keepAlive: false,
      result,
    };
    const finished = (): void => {
      if (this.inFlight.get(key) === flight) this.inFlight.delete(key);
    };
    // Every waiter observes `result`; this branch only clears the slot.
    result.then(finished, finished);
    this.inFlight.set(key, flight);
    return flight;
  }

  get(
    target: SharedContainerCapabilityPackageTarget,
  ): SharedContainerCapabilityPackageCacheEntry | undefined {
    return this.entries.get(targetKey(target));
  }

  /**
   * Keeps an entry only when its analysis started no earlier than the one it
   * replaces, so a slow analysis of older inputs never displaces a newer one.
   */
  set(entry: SharedContainerCapabilityPackageCacheEntry): void {
    const key = targetKey(entry);
    const existing = this.entries.get(key);
    if (existing && existing.startedAt > entry.startedAt) return;
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (
      this.entries.size > 1 &&
      (this.entries.size > MAX_ENTRIES ||
        this.retainedBytes() > MAX_RETAINED_PACKAGE_BYTES)
    ) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined || oldest === key) break;
      this.entries.delete(oldest);
    }
  }

  private retainedBytes(): number {
    let bytes = 0;
    for (const entry of Array.from(this.entries.values())) {
      if (entry.analysis.state === 'ready')
        bytes += entry.analysis.manifest.totalBytes;
    }
    return bytes;
  }

  delete(target: SharedContainerCapabilityPackageTarget): void {
    this.entries.delete(targetKey(target));
  }

  clear(): void {
    this.entries.clear();
  }
}

let sharedCache: SharedContainerCapabilityPackageAnalysisCache | undefined;

export function getSharedContainerCapabilityPackageAnalysisCache(): SharedContainerCapabilityPackageAnalysisCache {
  sharedCache ??= new SharedContainerCapabilityPackageAnalysisCache();
  return sharedCache;
}
