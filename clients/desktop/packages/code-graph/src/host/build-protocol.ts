import type {
  CodeGraphBuildOptions,
  CodeGraphBuildPrelude,
  CodeGraphBuildResult,
  CodeGraphDerivedRepoStats,
  CodeGraphRepositoryInput,
} from '../types/code-graph';
import type {
  CodeGraphBaseIdentity,
  CodeGraphColdFallback,
  CodeGraphSeedOutcome,
  CodeGraphSeedSource,
} from '../base-graph';
import type { CodeGraphFailureClass } from '../io-failure';
import type { BackfillCodeGraphSummaryProjectionResult } from '../summary-projection';

// The requests and responses a code-graph build host exchanges with its
// launcher. Every path is resolved by the launcher; the host derives nothing
// from its working directory, environment or the host's data directory.

export interface CodeGraphWorkerBuildRequest {
  operation?: 'build';
  /** Absolute path to the worktree's `graph.db` (main resolves it via
   * `getWorktreeCodeGraphDbPath`). */
  dbPath: string;
  /** Absolute worktree checkout root — enables the per-build custom-language
   * config lookup. Always provided (main resolves it) even though the engine
   * treats it as optional. */
  worktreeRootPath: string;
  /** Optional immutable root for custom-language config/assets. Base builds
   * use a snapshot while scanning a different repo-shadow checkout. */
  customLanguagesRootPath?: string;
  /** Absolute bundled `code-graph` resources dir (grammar wasm + tags),
   * resolved by main via `getBundledCodeGraphDir()`. */
  resourcesDir: string;
  /** Every repository the graph covers, with absolute `rootPath`s. */
  repositories: readonly CodeGraphRepositoryInput[];
  /** Build options (e.g. `computeDerived`) forwarded verbatim to the engine. */
  options: CodeGraphBuildOptions;
  preparation?: {
    seedSources: readonly CodeGraphSeedSource[];
    coldFallbacks: readonly CodeGraphColdFallback[];
    customLanguagesFingerprint: string;
    seedStagingDir: string;
  };
  /**
   * Default-branch base builds finalize their private staging database in the
   * worker (metadata, WAL truncation, sync, and full integrity check) so main
   * only renames it into place. Worktree builds omit this.
   */
  baseFinalization?: {
    identity: CodeGraphBaseIdentity;
    gitHead: string | null;
    /** Repair only the private staging generation before it is sealed. */
    repairSummaryProjection?: true;
  };
  /**
   * Timings main measured before the worker ran. The runner adds the queue
   * wait when it starts the worker; the worker persists them with the build.
   * A request without this field is posted unchanged.
   */
  timings?: CodeGraphBuildPrelude;
  /**
   * Worktree builds: answer as soon as the graph is published and finish
   * derived analysis afterwards in the same worker (`derivedPending`, then a
   * `derived-complete` message). Ignored with `baseFinalization`, whose
   * published base must carry its derived analysis.
   */
  deferDerived?: boolean;
  /**
   * Worktree builds: the worktree fingerprint observed before the build. The
   * host fingerprints the worktree again once the graph is published and, when
   * the two match, stores it as the graph's `worktree_fingerprint` before it
   * answers. Ignored with `baseFinalization`.
   */
  fingerprint?: { start: string };
}

/** How a worktree build stored its end-of-build fingerprint. */
export interface CodeGraphWorkerFingerprintPersist {
  /** `unstable`: the worktree changed during the build, so nothing was stored. */
  outcome: 'persisted' | 'unstable' | 'error';
  /** Time taken by the end-of-build fingerprint. */
  endFingerprintMs?: number;
  /** Time taken by the metadata write. */
  persistMs?: number;
}

export interface CodeGraphWorkerSummaryRepairRequest {
  operation: 'summary-repair';
  /** Absolute worktree graph path resolved by the trusted main-process caller. */
  dbPath: string;
  /** Trusted source roots resolved from the owning project/worktree. */
  worktreeRootPath: string;
  customLanguagesRootPath: string;
  resourcesDir: string;
  repositories: readonly CodeGraphRepositoryInput[];
}

export type CodeGraphWorkerSummaryRepairResponse =
  | { ok: true; result: BackfillCodeGraphSummaryProjectionResult }
  | { ok: false; message: string };

export type CodeGraphWorkerEagerSeedRequest = {
  operation: 'eager-seed';
  targetDbPath: string;
  repositories: readonly CodeGraphRepositoryInput[];
  source:
    | { kind: 'base-worktree'; dbPath: string }
    | {
        kind: 'workspace-shadow';
        bases: readonly {
          variantDir: string;
          identity: CodeGraphBaseIdentity;
          destinationRootPath: string;
        }[];
      };
};

export type CodeGraphWorkerBuildResponse =
  | {
      ok: true;
      result: CodeGraphBuildResult;
      seedOutcomes?: CodeGraphSeedOutcome[];
      fusionDurationMs?: number;
      /** Present when the request asked for base finalization and it passed. */
      baseFinalized?: true;
      /**
       * The graph is published; the worker is still running derived
       * analysis and reports it with a {@link CodeGraphWorkerDerivedCompletion}.
       */
      derivedPending?: true;
      /** Present when the request carried a start fingerprint. */
      fingerprint?: CodeGraphWorkerFingerprintPersist;
    }
  | CodeGraphWorkerFailure;

/**
 * A failed build or eager seed. `message` is for in-process use only and is
 * never forwarded; `failureClass` and `errno` (an errno code only) are what a
 * receiver may report.
 */
export interface CodeGraphWorkerFailure {
  ok: false;
  message: string;
  failureClass?: CodeGraphFailureClass;
  errno?: string;
}

/** The worker's second message after a `derivedPending` response. */
export type CodeGraphWorkerDerivedCompletion =
  | {
      kind: 'derived-complete';
      ok: true;
      /** False when nothing was pending (already current). */
      ran: boolean;
      derived: CodeGraphDerivedRepoStats[];
      derivedMs: number;
      diagnosticsMs: number;
    }
  | { kind: 'derived-complete'; ok: false; message: string };

export type CodeGraphWorkerEagerSeedResponse =
  | {
      ok: true;
      status: 'seeded' | 'existing' | 'no-compatible-source';
      source?: 'base-worktree' | 'workspace-shadow';
      durationMs: number;
    }
  | CodeGraphWorkerFailure;
