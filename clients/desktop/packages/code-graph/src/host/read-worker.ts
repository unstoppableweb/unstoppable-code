import type { CodeGraphReadFailure } from '../types/code-graph-tools';
import type { CodeGraphQueryKind } from './read-scheduler';
import {
  CodeGraphReadFailureError,
  codeGraphReadFailure,
} from './read-failure';
import {
  CodeGraphReadServiceError,
  type CodeGraphGraphState,
  type CodeGraphLanguagesValidation,
  type CodeGraphReadService,
  type CodeGraphReadServiceErrorReason,
  type CodeGraphServiceRead,
  type CodeGraphWorkspaceBaseScope,
  type CodeGraphWorktreeScope,
} from './read-service';

/*
 * The read service as the worker the `worker.codeGraph` read handlers serve
 * (CAN-4150): every failure becomes a closed outcome, so the handlers turn
 * each refusal into its typed operation error. Electron main and the core
 * daemon compose it over their own read service.
 */

export type CodeGraphReadWorkerOutcome<Value> =
  | { ok: true; value: Value }
  | { ok: false; refusal: CodeGraphReadFailure }
  | {
      ok: false;
      request: CodeGraphReadServiceErrorReason;
      /** Fixed text naming what was wrong; never a path. */
      message: string;
    };

/** The read kinds a query answers; anything else is an invalid response. */
export type CodeGraphReadWorkerResultKind =
  | 'calls'
  | 'readonly-summary'
  | 'fingerprint-metadata'
  | 'detect-changed'
  | 'change-impact'
  | 'workspace-base-summary';

export interface CodeGraphReadWorkerAnswer extends CodeGraphGraphState {
  presence: 'present' | 'absent';
  /** The read host's value, before it crosses the boundary as JSON. */
  result: { kind: CodeGraphReadWorkerResultKind; value: unknown };
}

export interface CodeGraphSnapshotImportCounts {
  filesImported: number;
  symbolsImported: number;
  edgesImported: number;
  warnings: string[];
}

export interface CodeGraphReadServiceWorker {
  status(
    scope: CodeGraphWorktreeScope,
  ): Promise<CodeGraphReadWorkerOutcome<CodeGraphGraphState>>;
  query(
    params: {
      scope: CodeGraphWorktreeScope | CodeGraphWorkspaceBaseScope;
      queryKind: CodeGraphQueryKind;
      read: CodeGraphServiceRead;
    },
    signal: AbortSignal,
  ): Promise<CodeGraphReadWorkerOutcome<CodeGraphReadWorkerAnswer>>;
  exportSnapshot(
    params: { scope: CodeGraphWorktreeScope; repoId?: string },
    signal: AbortSignal,
  ): Promise<CodeGraphReadWorkerOutcome<{ snapshot: unknown }>>;
  importSnapshot(
    params: {
      scope: CodeGraphWorktreeScope;
      repoId?: string;
      snapshot: unknown;
    },
    signal: AbortSignal,
  ): Promise<CodeGraphReadWorkerOutcome<CodeGraphSnapshotImportCounts>>;
  validateLanguages(
    params: { scope: CodeGraphWorktreeScope; check?: 'static' | 'load' },
    signal: AbortSignal,
  ): Promise<CodeGraphReadWorkerOutcome<CodeGraphLanguagesValidation>>;
}

async function outcomeOf<Value>(
  operation: () => Promise<Value>,
): Promise<CodeGraphReadWorkerOutcome<Value>> {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    if (error instanceof CodeGraphReadServiceError)
      return { ok: false, request: error.reason, message: error.message };
    return {
      ok: false,
      refusal:
        error instanceof CodeGraphReadFailureError
          ? error.readFailure
          : codeGraphReadFailure(error),
    };
  }
}

export function createCodeGraphReadServiceWorker(
  service: CodeGraphReadService,
): CodeGraphReadServiceWorker {
  return {
    status: (scope) => outcomeOf(() => Promise.resolve(service.status(scope))),
    query: (params, signal) =>
      outcomeOf(async () => {
        const answer = await service.query({
          scope: params.scope,
          queryKind: params.queryKind,
          read: params.read,
          signal,
        });
        const { result } = answer;
        switch (result.kind) {
          case 'calls':
          case 'readonly-summary':
          case 'fingerprint-metadata':
          case 'detect-changed':
          case 'change-impact':
          case 'workspace-base-summary':
            return {
              presence: answer.presence,
              buildState: answer.buildState,
              result: { kind: result.kind, value: result.value },
            };
          default:
            throw new CodeGraphReadFailureError('invalid-response');
        }
      }),
    exportSnapshot: (params, signal) =>
      outcomeOf(async () => ({
        snapshot: await service.exportSnapshot({
          scope: params.scope,
          ...(params.repoId === undefined ? {} : { repoId: params.repoId }),
          signal,
        }),
      })),
    importSnapshot: (params, signal) =>
      outcomeOf(() =>
        service.importSnapshot({
          scope: params.scope,
          ...(params.repoId === undefined ? {} : { repoId: params.repoId }),
          snapshot: params.snapshot,
          signal,
        }),
      ),
    validateLanguages: ({ scope, check }, signal) =>
      outcomeOf(() =>
        service.validateLanguages(scope, {
          ...(check === undefined ? {} : { check }),
          signal,
        }),
      ),
  };
}
