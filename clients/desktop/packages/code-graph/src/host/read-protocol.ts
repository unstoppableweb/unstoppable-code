import type {
  CodeGraphReadFailure,
  CodeGraphPathRequest,
} from '../types/code-graph-tools';
import type { ChangeImpactReport } from '../impact/change-impact';
import type { CodeGraphBaseIdentity } from '../base-graph';
import type { ReadCodeGraphSummaryProjectionResult } from '../summary-projection';
import type { ChangedSymbol } from '../impact/changed-symbols';
import type { CodeGraphFingerprintMetadata } from '../store/database';
import type { CodeGraphSnapshotEnvelope } from '../types/code-graph-tools';
import type { CodeGraphSnapshotImportResult } from '../snapshot/import';

// The requests and responses a code-graph read host exchanges with its
// launcher.

export type CodeGraphReadCall =
  | { method: 'relationship-path'; options: CodeGraphPathRequest }
  | { method: 'status' }
  | { method: 'file-summary'; target: string; repoId?: string }
  | { method: 'scripts-for-file'; target: string; repoId?: string }
  | { method: 'ipc-channel'; target: string; repoId?: string }
  | { method: 'derived-stats'; repoId?: string }
  | { method: 'communities'; repoId?: string; limit: number }
  | { method: 'flows'; repoId?: string; limit: number }
  | {
      method: 'flows-for-symbol';
      target: string;
      repoId?: string;
      limit: number;
    }
  | { method: 'hubs'; repoId?: string; limit: number }
  | {
      method:
        | 'callers'
        | 'callees'
        | 'importers'
        | 'imports'
        | 'children'
        | 'tests-for'
        | 'docs-for'
        | 'rationale-for';
      target: string;
      repoId?: string;
    }
  | { method: 'search'; query: string; limit: number }
  | { method: 'symbol-detail'; target: string; repoId?: string }
  | { method: 'community-for-symbol'; target: string; repoId?: string }
  | {
      method: 'impact-radius';
      target: string;
      options: { maxDepth?: number; maxNodes?: number };
    };

export type CodeGraphWorkerReadTask =
  | { kind: 'calls'; calls: readonly CodeGraphReadCall[] }
  | { kind: 'readonly-summary' }
  | {
      kind: 'base-identity';
      identity: CodeGraphBaseIdentity;
      gitHead: string | null;
    }
  | { kind: 'fingerprint-metadata' }
  /**
   * Checks a published base generation's identifying rows before shadow
   * maintenance trusts its manifest (skip as current, or seed the next build).
   */
  | {
      kind: 'validate-base';
      identity: CodeGraphBaseIdentity;
      gitHead: string | null;
    }
  | {
      kind: 'detect-changed';
      repoId: string;
      rootPath: string;
      baseRef: string;
    }
  | {
      kind: 'change-impact';
      repoId: string;
      rootPath: string;
      baseRef: string;
      resourcesDir: string;
      maxDepth?: number;
    }
  /** One repository's graph as a deterministic snapshot (no derived tables). */
  | { kind: 'snapshot-export'; repoId: string; generatedAt: string }
  /**
   * Replaces one repository's graph with a parsed snapshot. A writer, like the
   * fingerprint: it shares the lane so cleanup cancels it with the reads.
   */
  | {
      kind: 'snapshot-import';
      repoId: string;
      rootPath: string;
      envelope: CodeGraphSnapshotEnvelope;
    }
  /**
   * Validates a worktree's custom languages end to end: loads each grammar
   * and compiles its tags queries. Its loaded grammars cannot be freed, so the
   * worker exits after answering.
   */
  | { kind: 'languages-validate'; worktreeRoot: string; resourcesDir: string };

export interface CodeGraphWorkerReadRequest {
  dbPath: string;
  task: CodeGraphWorkerReadTask;
}

export type CodeGraphWorkerReadResult =
  | { kind: 'calls'; value: unknown[] }
  | { kind: 'readonly-summary'; value: ReadCodeGraphSummaryProjectionResult }
  | { kind: 'base-identity'; value: CodeGraphBaseIdentityReadResult }
  | { kind: 'fingerprint-metadata'; value: CodeGraphFingerprintMetadata }
  | { kind: 'validate-base'; value: boolean }
  | {
      kind: 'detect-changed';
      value: {
        changed: ChangedSymbol[];
        unmatchedFiles: string[];
        lastBuildAt: number | null;
      };
    }
  | {
      kind: 'change-impact';
      value: { report: ChangeImpactReport; lastBuildAt: number | null };
    }
  /** Null when the graph holds no rows for the repository (CAN-6010). */
  | { kind: 'snapshot-export'; value: CodeGraphSnapshotEnvelope | null }
  | { kind: 'snapshot-import'; value: CodeGraphSnapshotImportResult }
  | { kind: 'languages-validate'; value: CodeGraphLanguagesValidation };

/**
 * A worktree's custom-language configuration as validation found it. Only a
 * validation that loaded the grammars reports each one's config `index` and
 * `abiVersion`.
 */
export interface CodeGraphLanguagesValidation {
  config: 'absent' | 'invalid' | 'present';
  languages: Array<{
    id: string;
    extensions: string[];
    index?: number;
    abiVersion?: number;
  }>;
  diagnostics: Array<{
    entryId: string | null;
    index: number;
    message: string;
  }>;
}

/** Host utility-only identity check. No paths or raw marker text in results. */
export type CodeGraphBaseIdentityReadResult =
  | { state: 'missing' }
  | {
      state: 'readable';
      matches: {
        schema: boolean;
        extractor: boolean;
        canonicalRoot: boolean;
        customLanguagesFingerprint: boolean;
        repoId: boolean;
        gitHead: boolean;
        completed: boolean;
      };
      observed: {
        schemaVersion: number | null;
        extractorVersion: number | null;
        lastBuildAt: number | null;
        completedBuildAt: number | null;
      };
      repository: { repoId: string; gitHead: string | null } | null;
    }
  | {
      state: 'error';
      classification:
        | 'permission-denied'
        | 'busy'
        | 'corrupt'
        | 'unsupported-schema'
        | 'io';
    };

export type CodeGraphWorkerReadResponse =
  | { ok: true; result: CodeGraphWorkerReadResult }
  | { ok: false; code: CodeGraphReadFailure; message: string };
