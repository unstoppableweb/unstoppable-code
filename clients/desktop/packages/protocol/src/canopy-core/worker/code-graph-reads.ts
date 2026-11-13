import { z } from 'zod';

import {
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
  defineCanopyQuery,
  defineCanopyQueryRegistry,
} from '../definitions';
import {
  CanopyErrorPayloadSchema,
  CanopyKeyedRetryDirectiveSchema,
  CanopyQueryRetryDirectiveSchema,
} from '../errors';
import { WORKER_CODE_GRAPH_GRANTS } from './code-graph';

/*
 * The worker's code-graph reads (CAN-4150): queries over one worktree's graph,
 * or the summary of one repository's workspace base graph (CAN-5621), the
 * worktree graph's status, snapshot export and import, and custom-language
 * validation.
 * Parameters name a worktree and repository, never a host path; the worker
 * resolves the database, roots and resources itself. Every query answer
 * reports the graph's presence and source build state beside the read, so a
 * missing or rebuilding graph is explicit rather than an empty result.
 */

const id = z.string().min(1).max(512);

/**
 * Graph answers and snapshots are JSON of any size: a ready summary can reach
 * 2 MB and a snapshot carries the whole repository graph, so they are not held
 * to the bounded error-details JSON schema.
 */
export const WorkerCodeGraphJsonValueSchema = z
  .unknown()
  .refine(isGraphJsonValue, 'Expected JSON-safe data');

/** JSON-safe data of any size, checked without recursion. */
function isGraphJsonValue(value: unknown): boolean {
  try {
    // Throws on a cycle, which the walk below would never leave.
    JSON.stringify(value);
  } catch {
    return false;
  }
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const next = pending.pop();
    if (
      next === null ||
      typeof next === 'string' ||
      typeof next === 'boolean' ||
      (typeof next === 'number' && Number.isFinite(next))
    )
      continue;
    if (typeof next !== 'object') return false;
    if (Array.isArray(next)) {
      const items: readonly unknown[] = next;
      for (const item of items) pending.push(item);
      continue;
    }
    const prototype: unknown = Object.getPrototypeOf(next);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const members: readonly unknown[] = Object.values(next);
    for (const member of members) pending.push(member);
  }
  return true;
}
const target = z.string().max(4_096);
const limit = z.number().int().min(0).max(10_000);
const depth = z.number().int().min(0).max(1_000);

export const WorkerCodeGraphScopeSchema = z.strictObject({
  workspaceId: id,
  worktreeId: id,
});

export type WorkerCodeGraphScope = z.output<typeof WorkerCodeGraphScopeSchema>;

/**
 * A workspace's published base graphs, one per repository (CAN-5621). Only a
 * query reads them, and only for the workspace summary.
 */
export const WorkerCodeGraphWorkspaceBaseScopeSchema = z.strictObject({
  kind: z.literal('workspace_base'),
  workspaceId: id,
});

export type WorkerCodeGraphWorkspaceBaseScope = z.output<
  typeof WorkerCodeGraphWorkspaceBaseScopeSchema
>;

/** One graph query; a `calls` read answers each in order. */
export const WorkerCodeGraphReadCallSchema = z.union([
  z.strictObject({
    method: z.literal('relationship-path'),
    options: z.strictObject({
      mode: z.enum(['call-path', 'relationship-path']),
      target,
      to: target,
      repoId: id.optional(),
      maxDepth: depth.optional(),
      maxNodes: limit.optional(),
    }),
  }),
  z.strictObject({ method: z.literal('status') }),
  z.strictObject({
    method: z.enum([
      'file-summary',
      'scripts-for-file',
      'ipc-channel',
      'symbol-detail',
      'community-for-symbol',
      'callers',
      'callees',
      'importers',
      'imports',
      'children',
      'tests-for',
      'docs-for',
      'rationale-for',
    ]),
    target,
    repoId: id.optional(),
  }),
  z.strictObject({ method: z.literal('derived-stats'), repoId: id.optional() }),
  z.strictObject({
    method: z.enum(['communities', 'flows', 'hubs']),
    repoId: id.optional(),
    limit,
  }),
  z.strictObject({
    method: z.literal('flows-for-symbol'),
    target,
    repoId: id.optional(),
    limit,
  }),
  z.strictObject({
    method: z.literal('search'),
    query: z.string().max(4_096),
    limit,
  }),
  z.strictObject({
    method: z.literal('impact-radius'),
    target,
    options: z.strictObject({
      maxDepth: depth.optional(),
      maxNodes: limit.optional(),
    }),
  }),
]);

export const WorkerCodeGraphReadSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('calls'),
    calls: z.array(WorkerCodeGraphReadCallSchema).max(64),
  }),
  z.strictObject({ kind: z.literal('summary') }),
  z.strictObject({ kind: z.literal('build-stamp') }),
  z.strictObject({
    kind: z.literal('detect-changed'),
    repoId: id,
    baseRef: z.string().min(1).max(1_024),
  }),
  z.strictObject({
    kind: z.literal('change-impact'),
    repoId: id,
    baseRef: z.string().min(1).max(1_024),
    maxDepth: depth.optional(),
  }),
]);

export type WorkerCodeGraphRead = z.output<typeof WorkerCodeGraphReadSchema>;

/** The caller-facing query families, kept apart in telemetry and diagnostics. */
export const WORKER_CODE_GRAPH_QUERY_KINDS = [
  'context',
  'query',
  'search',
  'explain',
  'impact-radius',
  'detect-changed',
  'compare-impact',
  'review-context',
  'ui-summary',
  'fingerprint-metadata',
] as const;

export const WorkerCodeGraphQueryParamsSchema = z
  .strictObject({
    scope: z.union([
      WorkerCodeGraphScopeSchema,
      WorkerCodeGraphWorkspaceBaseScopeSchema,
    ]),
    queryKind: z.enum(WORKER_CODE_GRAPH_QUERY_KINDS),
    read: WorkerCodeGraphReadSchema,
  })
  .refine(
    ({ scope, queryKind, read }) =>
      !('kind' in scope) ||
      (queryKind === 'ui-summary' && read.kind === 'summary'),
    {
      message: 'A workspace base graph answers only its summary.',
      path: ['read'],
    },
  );

export type WorkerCodeGraphQueryParams = z.output<
  typeof WorkerCodeGraphQueryParamsSchema
>;

const graphState = {
  buildState: z.enum(['idle', 'queued', 'running']),
};

export const WorkerCodeGraphStatusGetParamsSchema = z.strictObject({
  scope: WorkerCodeGraphScopeSchema,
});

export const WorkerCodeGraphStatusGetResultSchema = z.strictObject({
  presence: z.enum(['present', 'absent']),
  ...graphState,
});

export type WorkerCodeGraphStatusGetResult = z.output<
  typeof WorkerCodeGraphStatusGetResultSchema
>;

/**
 * The `core.runtime.initialize` client capability that asks for read
 * reports. A client that does not announce it gets read results and refusals
 * without them, as before CAN-5691.
 */
export const WORKER_CODE_GRAPH_READ_REPORT_CAPABILITY =
  'worker.codeGraph.readReport';

/** Every kind a read host read is counted under, query kinds included. */
export const WORKER_CODE_GRAPH_READ_KINDS = [
  ...WORKER_CODE_GRAPH_QUERY_KINDS,
  'base-validation',
  'snapshot-export',
  'snapshot-import',
] as const;

/** A read the read host could not answer, as its telemetry names it. */
export const WORKER_CODE_GRAPH_READ_FAILURES = [
  'queue-timeout',
  'execution-timeout',
  'busy',
  'worker-exit',
  'canceled',
  'invalid-response',
  'database-error',
] as const;

const milliseconds = z.number().min(0).max(86_400_000);

/**
 * One read-host read, as the worker measured it (CAN-5691): what its query
 * telemetry and local read diagnostic record. The requesting interface
 * records it with its own consent and bundled telemetry configuration, so
 * each read is recorded once, by the client that asked for it. It names no
 * path, query or worker message.
 */
export const WorkerCodeGraphReportedReadSchema = z.strictObject({
  kind: z.enum(WORKER_CODE_GRAPH_READ_KINDS),
  outcome: z.enum(['success', 'error', 'timeout', 'canceled']),
  queueDurationMs: milliseconds,
  executionDurationMs: milliseconds,
  readFailure: z.enum(WORKER_CODE_GRAPH_READ_FAILURES).optional(),
});

export type WorkerCodeGraphReportedRead = z.output<
  typeof WorkerCodeGraphReportedReadSchema
>;

/** Every read-host read one request ran, in the order they settled. */
export const WorkerCodeGraphReadReportSchema = z.strictObject({
  reads: z.array(WorkerCodeGraphReportedReadSchema).max(64),
});

export type WorkerCodeGraphReadReport = z.output<
  typeof WorkerCodeGraphReadReportSchema
>;

/** A read refusal's details: how its reads went, for a reporting client. */
export const WorkerCodeGraphReadFailureDetailsSchema = z.strictObject({
  read: WorkerCodeGraphReadReportSchema,
});

export const WorkerCodeGraphQueryResultSchema = z.strictObject({
  /**
   * Whether the worktree's graph database, or any compatible published
   * workspace base, existed when the read began.
   */
  presence: z.enum(['present', 'absent']),
  ...graphState,
  /**
   * The read's answer, matching its `kind`; a missing graph reads as
   * `missing`. A workspace base summary answers each repository's summary.
   */
  result: z.strictObject({
    kind: z.enum([
      'calls',
      'readonly-summary',
      'fingerprint-metadata',
      'detect-changed',
      'change-impact',
      'workspace-base-summary',
    ]),
    value: WorkerCodeGraphJsonValueSchema,
  }),
  /**
   * The reads this answer took, for a client that announced
   * {@link WORKER_CODE_GRAPH_READ_REPORT_CAPABILITY}.
   */
  read: WorkerCodeGraphReadReportSchema.optional(),
});

export type WorkerCodeGraphQueryResult = z.output<
  typeof WorkerCodeGraphQueryResultSchema
>;

/**
 * The read host's closed refusals: admission (`busy`, `queueTimeout`), the
 * execution watchdog, a host that exited or answered badly, cancellation, and
 * a database the host could not read.
 */
export const WORKER_CODE_GRAPH_READ_FAILURE_CODES = [
  'worker.codeGraph.read.busy',
  'worker.codeGraph.read.queueTimeout',
  'worker.codeGraph.read.executionTimeout',
  'worker.codeGraph.read.hostExit',
  'worker.codeGraph.read.canceled',
  'worker.codeGraph.read.invalidResponse',
  'worker.codeGraph.read.databaseError',
] as const;

export const WORKER_CODE_GRAPH_REQUEST_ERROR_CODES = [
  'worker.codeGraph.invalidScope',
  'worker.codeGraph.notFound',
  'worker.codeGraph.invalidState',
] as const;

const readErrorCode = z.enum([
  ...WORKER_CODE_GRAPH_READ_FAILURE_CODES,
  ...WORKER_CODE_GRAPH_REQUEST_ERROR_CODES,
]);

export const WorkerCodeGraphQueryErrorSchema = CanopyErrorPayloadSchema.extend({
  code: readErrorCode.optional(),
  retry: CanopyQueryRetryDirectiveSchema,
});

export const WorkerCodeGraphSnapshotExportParamsSchema = z.strictObject({
  scope: WorkerCodeGraphScopeSchema,
  /** Required when the worktree has more than one repository. */
  repoId: id.optional(),
});

export const WorkerCodeGraphSnapshotExportResultSchema = z.strictObject({
  /** The deterministic snapshot envelope the CLI writes to a file. */
  snapshot: WorkerCodeGraphJsonValueSchema,
});

export const WorkerCodeGraphSnapshotImportParamsSchema = z.strictObject({
  scope: WorkerCodeGraphScopeSchema,
  repoId: id.optional(),
  snapshot: WorkerCodeGraphJsonValueSchema,
});

export type WorkerCodeGraphSnapshotImportParams = z.output<
  typeof WorkerCodeGraphSnapshotImportParamsSchema
>;

export const WorkerCodeGraphSnapshotImportResultSchema = z.strictObject({
  filesImported: z.number().int().nonnegative(),
  symbolsImported: z.number().int().nonnegative(),
  edgesImported: z.number().int().nonnegative(),
  warnings: z.array(z.string().max(4_096)).max(1_000),
});

// Imports are keyed: a repeat with the same caller, key and parameters returns
// the first outcome instead of importing twice; other parameters are refused.
export const WorkerCodeGraphSnapshotImportErrorSchema =
  CanopyErrorPayloadSchema.extend({
    code: z
      .enum([
        ...WORKER_CODE_GRAPH_READ_FAILURE_CODES,
        ...WORKER_CODE_GRAPH_REQUEST_ERROR_CODES,
        // A key reused with other parameters (CAN-4149's keyed replay).
        'worker.codeGraph.idempotencyKeyReused',
      ])
      .optional(),
    retry: CanopyKeyedRetryDirectiveSchema,
  });

/**
 * How far language validation goes: `static` checks the config and its
 * entries without loading anything; `load` also loads each grammar and
 * compiles its tags queries, as a build would (CAN-6010).
 */
export const WORKER_CODE_GRAPH_LANGUAGE_CHECKS = ['static', 'load'] as const;

export const WorkerCodeGraphLanguagesValidateParamsSchema = z.strictObject({
  scope: WorkerCodeGraphScopeSchema,
  /** Defaults to `static`. */
  check: z.enum(WORKER_CODE_GRAPH_LANGUAGE_CHECKS).optional(),
});

export type WorkerCodeGraphLanguagesValidateParams = z.output<
  typeof WorkerCodeGraphLanguagesValidateParamsSchema
>;

export const WorkerCodeGraphLanguagesValidateResultSchema = z.strictObject({
  config: z.enum(['absent', 'invalid', 'present']),
  languages: z
    .array(
      z.strictObject({
        id: z.string().min(1).max(512),
        extensions: z.array(z.string().min(1).max(256)).max(256),
        /**
         * Only a `load` check reports these: the entry's index in the
         * config, and its loaded grammar's ABI version.
         */
        index: z.number().int().nonnegative().optional(),
        abiVersion: z.number().int().nonnegative().optional(),
      }),
    )
    .max(256),
  diagnostics: z
    .array(
      z.strictObject({
        entryId: z.string().max(512).nullable(),
        index: z.number().int().min(-1),
        message: z.string().max(4_096),
      }),
    )
    .max(1_024),
});

export type WorkerCodeGraphLanguagesValidateResult = z.output<
  typeof WorkerCodeGraphLanguagesValidateResultSchema
>;

export const WORKER_CODE_GRAPH_READ_QUERY_DEFINITIONS =
  defineCanopyQueryRegistry('worker', {
    'worker.codeGraph.status.get': defineCanopyQuery({
      plane: 'worker',
      domain: 'codeGraph',
      version: 1,
      placement: 'target-selectable',
      params: WorkerCodeGraphStatusGetParamsSchema,
      result: WorkerCodeGraphStatusGetResultSchema,
      error: WorkerCodeGraphQueryErrorSchema,
      idempotency: 'inherent',
      requiredGrants: [WORKER_CODE_GRAPH_GRANTS.read],
    }),
    'worker.codeGraph.query': defineCanopyQuery({
      plane: 'worker',
      domain: 'codeGraph',
      version: 1,
      placement: 'target-selectable',
      params: WorkerCodeGraphQueryParamsSchema,
      result: WorkerCodeGraphQueryResultSchema,
      error: WorkerCodeGraphQueryErrorSchema,
      idempotency: 'inherent',
      requiredGrants: [WORKER_CODE_GRAPH_GRANTS.read],
    }),
    'worker.codeGraph.snapshot.export': defineCanopyQuery({
      plane: 'worker',
      domain: 'codeGraph',
      version: 1,
      placement: 'target-selectable',
      params: WorkerCodeGraphSnapshotExportParamsSchema,
      result: WorkerCodeGraphSnapshotExportResultSchema,
      error: WorkerCodeGraphQueryErrorSchema,
      idempotency: 'inherent',
      requiredGrants: [WORKER_CODE_GRAPH_GRANTS.read],
    }),
    'worker.codeGraph.languages.validate': defineCanopyQuery({
      plane: 'worker',
      domain: 'codeGraph',
      version: 1,
      placement: 'target-selectable',
      params: WorkerCodeGraphLanguagesValidateParamsSchema,
      result: WorkerCodeGraphLanguagesValidateResultSchema,
      error: WorkerCodeGraphQueryErrorSchema,
      idempotency: 'inherent',
      requiredGrants: [WORKER_CODE_GRAPH_GRANTS.read],
    }),
  });

export const WORKER_CODE_GRAPH_WRITE_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('worker', {
    'worker.codeGraph.snapshot.import': defineCanopyInstruction({
      plane: 'worker',
      domain: 'codeGraph',
      version: 1,
      placement: 'target-selectable',
      params: WorkerCodeGraphSnapshotImportParamsSchema,
      result: WorkerCodeGraphSnapshotImportResultSchema,
      error: WorkerCodeGraphSnapshotImportErrorSchema,
      idempotency: 'keyed',
      requiredGrants: [WORKER_CODE_GRAPH_GRANTS.write],
    }),
  });
