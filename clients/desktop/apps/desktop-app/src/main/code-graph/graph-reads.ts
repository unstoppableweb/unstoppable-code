import { CanopyClientError } from '@canopy/core-client';
import { CanopyOperationError } from '@canopy/core-runtime';
import { CodeGraphReadFailureError } from '@canopy/code-graph/host/read-failure';
import type { CodeGraphQueryKind } from '@canopy/code-graph/host/read-scheduler';
import type {
  CodeGraphServiceRead,
  CodeGraphGraphState,
  CodeGraphLanguagesValidation,
  CodeGraphWorkspaceBaseSummary,
} from '@canopy/code-graph/host/read-service';
import type { CodeGraphWorkerReadResult } from '@canopy/code-graph/host/read-protocol';
import {
  WORKER_CODE_GRAPH_GRANTS,
  WORKER_CODE_GRAPH_QUERY_KINDS,
  type CanopyCallerDescriptor,
  type WorkerCodeGraphQueryResult,
} from '@canopy/protocol/canopy-core';
import {
  getActiveDesktopRuntimeIfAccepting,
  type DesktopCanopyDispatcher,
} from '../canopy-runtime/desktop-runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../canopy-runtime/desktop-runtime-identity';
import { codeGraphReadRefusalOf } from '@canopy/core-runtime/node/code-graph';
import { withDaemonCodeGraphRoute } from './daemon-code-graph-route-context';
import {
  noteDaemonCodeGraphBuildExcluded,
  noteDaemonCodeGraphBuildSettled,
  selectDaemonAgentCodeGraphReadExclusion,
} from './daemon-code-graph-route';
import {
  recordCodeGraphReadRoute,
  type CodeGraphReadRouteOperation,
} from '@canopy/desktop-shared/node/work-counters';

/*
 * Electron main's one client of the worker's code-graph reads (CAN-4150).
 * The agent tools (and through them the Orchestrator actions), the IPC
 * worktree and workspace base summaries (CAN-5621) and the Claude orientation
 * hooks read every graph through `worker.codeGraph.*` on the desktop
 * dispatcher, never through a graph runtime of their own (see
 * `check:code-graph-read-boundary`). Read refusals
 * come back as the same `CodeGraphReadFailureError` the read hosts report.
 */

const CODE_GRAPH_READS_CALLER: CanopyCallerDescriptor = {
  principalId: 'desktop-code-graph-reads',
  clientInstanceId: 'desktop-main',
  authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
  interfaceKind: 'desktop',
  grants: [WORKER_CODE_GRAPH_GRANTS.read, WORKER_CODE_GRAPH_GRANTS.write],
};

export type CodeGraphReadDispatcher = Pick<
  DesktopCanopyDispatcher,
  'query' | 'instruction'
>;

/** Wraps the read dispatcher for one call; agent tools pass their granted table (CAN-5825). */
export type CodeGraphDispatchVia = (
  dispatcher: CodeGraphReadDispatcher,
) => CodeGraphReadDispatcher;

let dispatcherForTests: CodeGraphReadDispatcher | null = null;

/** Test seam: route reads through a dispatcher built over the real adapter. */
export function setCodeGraphReadDispatcherForTests(
  dispatcher: CodeGraphReadDispatcher | null,
): void {
  dispatcherForTests = dispatcher;
}

function dispatcher(via?: CodeGraphDispatchVia): CodeGraphReadDispatcher {
  const active = dispatcherForTests ?? getActiveDesktopRuntimeIfAccepting();
  // No runtime means the app is starting or quitting: the read is canceled.
  if (active === null) throw new CodeGraphReadFailureError('canceled');
  return via === undefined ? active : via(active);
}

/**
 * A refused read keeps its read-host failure, whether the dispatcher or the
 * daemon's connection (CAN-5089) refused it; other refusals pass through.
 */
export function codeGraphReadError(refused: unknown): unknown {
  const error =
    refused instanceof CanopyClientError
      ? new CanopyOperationError(refused.payload, refused)
      : refused;
  if (!(error instanceof CanopyOperationError)) return error;
  const refusal = codeGraphReadRefusalOf(error);
  if (refusal !== null) return new CodeGraphReadFailureError(refusal);
  return error.payload.kind === 'cancelled'
    ? new CodeGraphReadFailureError('canceled')
    : error;
}

export interface CodeGraphReadScope {
  projectId: string;
  worktreeId: string;
}

export interface CodeGraphReadAnswer extends CodeGraphGraphState {
  result: CodeGraphWorkerReadResult;
}

function isQueryKind(
  kind: CodeGraphQueryKind,
): kind is (typeof WORKER_CODE_GRAPH_QUERY_KINDS)[number] {
  return WORKER_CODE_GRAPH_QUERY_KINDS.some((candidate) => candidate === kind);
}

const READ_RESULT_KINDS: ReadonlySet<string> = new Set([
  'calls',
  'readonly-summary',
  'fingerprint-metadata',
  'detect-changed',
  'change-impact',
]);

/**
 * The worker answered this value for the read of the same kind; its payload
 * keeps the read host's structural contract, as the read scheduler's does.
 */
function isReadResult(value: unknown): value is CodeGraphWorkerReadResult {
  if (typeof value !== 'object' || value === null) return false;
  const kind: unknown = Reflect.get(value, 'kind');
  const payload: unknown = Reflect.get(value, 'value');
  return (
    typeof kind === 'string' &&
    READ_RESULT_KINDS.has(kind) &&
    (kind !== 'calls' || Array.isArray(payload))
  );
}

/** A `worker.codeGraph.query` answer as a read answer, from any host. */
function codeGraphReadAnswerFromWire(
  answer: WorkerCodeGraphQueryResult,
): CodeGraphReadAnswer {
  if (!isReadResult(answer.result))
    throw new CodeGraphReadFailureError('invalid-response');
  return {
    presence: answer.presence,
    buildState: answer.buildState,
    result: answer.result,
  };
}

/** Reads one worktree's graph through `worker.codeGraph.query`. */
export async function readWorktreeCodeGraph(
  scope: CodeGraphReadScope,
  queryKind: CodeGraphQueryKind,
  read: CodeGraphServiceRead,
  options: { signal?: AbortSignal; via?: CodeGraphDispatchVia } = {},
): Promise<CodeGraphReadAnswer> {
  if (!isQueryKind(queryKind))
    throw new Error(`Code-graph query kind ${queryKind} is internal.`);
  try {
    const answer = await dispatcher(options.via).query(
      'worker.codeGraph.query',
      {
        scope: { workspaceId: scope.projectId, worktreeId: scope.worktreeId },
        queryKind,
        read:
          read.kind === 'calls'
            ? { kind: 'calls', calls: [...read.calls] }
            : read,
      },
      {
        caller: CODE_GRAPH_READS_CALLER,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    );
    return codeGraphReadAnswerFromWire(answer);
  } catch (error) {
    throw codeGraphReadError(error);
  }
}

/**
 * The worker answered a workspace base summary; each repository's summary
 * keeps the read host's structural contract, as a worktree summary does.
 */
function isWorkspaceBaseSummary(
  value: unknown,
): value is CodeGraphWorkspaceBaseSummary {
  if (typeof value !== 'object' || value === null) return false;
  const repositories: unknown = Reflect.get(value, 'repositories');
  return (
    Array.isArray(repositories) &&
    repositories.every((repository: unknown) => {
      if (typeof repository !== 'object' || repository === null) return false;
      const state: unknown = Reflect.get(repository, 'state');
      return (
        typeof Reflect.get(repository, 'repoId') === 'string' &&
        (state === 'read' || state === 'failed')
      );
    })
  );
}

/**
 * Reads the summary of each of a workspace's published base graphs through
 * `worker.codeGraph.query` (CAN-5621).
 */
export async function readWorkspaceBaseCodeGraphSummaries(
  workspaceId: string,
): Promise<CodeGraphWorkspaceBaseSummary> {
  let answer: WorkerCodeGraphQueryResult;
  try {
    answer = await dispatcher().query(
      'worker.codeGraph.query',
      {
        scope: { kind: 'workspace_base', workspaceId },
        queryKind: 'ui-summary',
        read: { kind: 'summary' },
      },
      { caller: CODE_GRAPH_READS_CALLER },
    );
  } catch (error) {
    throw codeGraphReadError(error);
  }
  if (
    answer.result.kind !== 'workspace-base-summary' ||
    !isWorkspaceBaseSummary(answer.result.value)
  )
    throw new CodeGraphReadFailureError('invalid-response');
  return answer.result.value;
}

/**
 * Runs one read Electron main starts on its own with the daemon route open
 * where agent builds take it (CAN-5625), so it reads the daemon's graph host
 * on the hosts `DAEMON_AGENT_CODE_GRAPH_READ_PLATFORMS` selects and in
 * process otherwise (CAN-5093). Each read records where it ran, as the
 * route's builds do, and in the `codeGraph.<operation>` route counters.
 */
async function onMainDaemonRoute<T>(
  scope: CodeGraphReadScope,
  operation: CodeGraphReadRouteOperation,
  read: () => Promise<T>,
): Promise<T> {
  const exclusion = selectDaemonAgentCodeGraphReadExclusion(scope.projectId);
  if (exclusion !== null) {
    noteDaemonCodeGraphBuildExcluded(exclusion);
    recordCodeGraphReadRoute(operation, `in_process.${exclusion}`);
  }
  const { value } = await withDaemonCodeGraphRoute(
    exclusion === null,
    read,
    (outcome) => {
      noteDaemonCodeGraphBuildSettled(outcome);
      recordCodeGraphReadRoute(operation, `daemon.${outcome}`);
    },
  );
  return value;
}

/** Whether the worktree has a graph, and whether a source build is pending. */
export async function readWorktreeCodeGraphStatus(
  scope: CodeGraphReadScope,
  options: { via?: CodeGraphDispatchVia } = {},
): Promise<CodeGraphGraphState> {
  try {
    return await onMainDaemonRoute(scope, 'status', () =>
      dispatcher(options.via).query(
        'worker.codeGraph.status.get',
        {
          scope: {
            workspaceId: scope.projectId,
            worktreeId: scope.worktreeId,
          },
        },
        { caller: CODE_GRAPH_READS_CALLER },
      ),
    );
  } catch (error) {
    throw codeGraphReadError(error);
  }
}

/** The worktree's custom-language configuration, validated by the worker. */
export async function validateWorktreeCodeGraphLanguages(
  scope: CodeGraphReadScope,
): Promise<CodeGraphLanguagesValidation> {
  try {
    return await onMainDaemonRoute(scope, 'languages', () =>
      dispatcher().query(
        'worker.codeGraph.languages.validate',
        {
          scope: {
            workspaceId: scope.projectId,
            worktreeId: scope.worktreeId,
          },
        },
        { caller: CODE_GRAPH_READS_CALLER },
      ),
    );
  } catch (error) {
    throw codeGraphReadError(error);
  }
}
