import { realpath } from 'node:fs/promises';
import type { CodeGraphRepositoryInput } from '../types/code-graph';
import type {
  CodeGraphBuildState,
  CodeGraphReadFailure,
  CodeGraphSnapshotEnvelope,
} from '../types/code-graph-tools';
import type { ReadCodeGraphSummaryProjectionResult } from '../summary-projection';
import {
  CODE_GRAPH_CUSTOM_LANGUAGES_CONFIG_MAX_BYTES,
  customLanguagesConfigPath,
  parseCustomLanguagesConfig,
  readBoundedCodeGraphCustomLanguageFile,
  validateCustomLanguageEntries,
} from '../languages/custom-config';
import {
  parseCodeGraphSnapshotEnvelope,
  type CodeGraphSnapshotImportResult,
} from '../snapshot/import';
import type {
  CodeGraphLanguagesValidation,
  CodeGraphReadCall,
  CodeGraphWorkerReadResult,
  CodeGraphWorkerReadTask,
} from './read-protocol';

export type { CodeGraphLanguagesValidation } from './read-protocol';
import {
  CodeGraphReadFailureError,
  codeGraphReadFailure,
  type CodeGraphQueryKind,
  type CodeGraphReadScheduler,
} from './read-scheduler';

/*
 * The worker-owned code-graph read service: every read, snapshot transfer and
 * language validation a caller asks of one worktree's graph. It resolves the
 * worktree to its database, repositories and resources through the host, runs
 * graph work on the read scheduler's hosts, and reports the graph's presence
 * and source build state beside every answer, so a missing or rebuilding
 * graph is explicit. It holds no graph connection of its own.
 */

export interface CodeGraphWorktreeScope {
  workspaceId: string;
  worktreeId: string;
}

/** A workspace's published base graphs (CAN-5621). */
export interface CodeGraphWorkspaceBaseScope {
  kind: 'workspace_base';
  workspaceId: string;
}

/** Where the host keeps one repository's workspace base graph. */
export interface CodeGraphWorkspaceBaseGraph {
  /** The base's source build key, which also keys its reads. */
  key: string;
  buildState: CodeGraphBuildState;
  /** The compatible published base, or null when none is published. */
  published: {
    dbPath: string;
    /** Whether the base trails its repository shadow checkout. */
    behindCheckout(): Promise<boolean>;
  } | null;
}

/** One repository of a workspace, as the host resolves its base graph. */
export interface CodeGraphWorkspaceBaseRepository {
  repoId: string;
  /** Rejects when the repository cannot be resolved. */
  graph(): Promise<CodeGraphWorkspaceBaseGraph>;
}

/** One repository's base summary, or why it could not be read. */
export type CodeGraphWorkspaceBaseRepositorySummary =
  | {
      repoId: string;
      state: 'read';
      /** Null when the workspace has not prepared its bases. */
      buildState: CodeGraphBuildState | null;
      /** Whether a compatible base is published; if not, it reads as `missing`. */
      published: boolean;
      behindCheckout: boolean;
      summary: ReadCodeGraphSummaryProjectionResult;
    }
  | {
      repoId: string;
      state: 'failed';
      /** Null when the failure came before the base was resolved. */
      buildState: CodeGraphBuildState | null;
      failure: CodeGraphReadFailure;
    };

export interface CodeGraphWorkspaceBaseSummary {
  repositories: CodeGraphWorkspaceBaseRepositorySummary[];
}

export interface CodeGraphReadServiceHost {
  scheduler: Pick<CodeGraphReadScheduler, 'run'>;
  /** The worktree graph's database path. */
  dbPath(scope: CodeGraphWorktreeScope): string;
  hasGraph(scope: CodeGraphWorktreeScope): boolean;
  /** Source generation for the worktree: queued, running or idle. */
  buildState(scope: CodeGraphWorktreeScope): CodeGraphBuildState;
  worktreeRoot(scope: CodeGraphWorktreeScope): string;
  repositories(
    scope: CodeGraphWorktreeScope,
  ): Promise<readonly CodeGraphRepositoryInput[]>;
  resourcesDir(): string;
  now(): Date;
  /**
   * The workspace's repositories with base graphs, or just their IDs when
   * the workspace has not prepared its bases. A host without it serves no
   * workspace base.
   */
  workspaceBases?(scope: CodeGraphWorkspaceBaseScope): Promise<
    | {
        prepared: true;
        repositories: readonly CodeGraphWorkspaceBaseRepository[];
      }
    | { prepared: false; repoIds: readonly string[] }
  >;
}

/** The reads a caller may ask for; the service supplies every host path. */
export type CodeGraphServiceRead =
  | { kind: 'calls'; calls: readonly CodeGraphReadCall[] }
  | { kind: 'summary' }
  | { kind: 'build-stamp' }
  | { kind: 'detect-changed'; repoId: string; baseRef: string }
  | {
      kind: 'change-impact';
      repoId: string;
      baseRef: string;
      maxDepth?: number;
    };

export interface CodeGraphGraphState {
  presence: 'present' | 'absent';
  buildState: CodeGraphBuildState;
}

export interface CodeGraphServiceQueryResult extends CodeGraphGraphState {
  result:
    | CodeGraphWorkerReadResult
    | { kind: 'workspace-base-summary'; value: CodeGraphWorkspaceBaseSummary };
}

export type CodeGraphReadServiceErrorReason =
  | 'invalid-argument'
  | 'not-found'
  | 'failed-precondition';

/** A request the service refuses before any graph work starts. */
export class CodeGraphReadServiceError extends Error {
  public constructor(
    public readonly reason: CodeGraphReadServiceErrorReason,
    message: string,
  ) {
    super(message);
    this.name = 'CodeGraphReadServiceError';
  }
}

export interface CodeGraphReadService {
  status(scope: CodeGraphWorktreeScope): CodeGraphGraphState;
  query(input: {
    scope: CodeGraphWorktreeScope | CodeGraphWorkspaceBaseScope;
    queryKind: CodeGraphQueryKind;
    read: CodeGraphServiceRead;
    signal?: AbortSignal;
  }): Promise<CodeGraphServiceQueryResult>;
  exportSnapshot(input: {
    scope: CodeGraphWorktreeScope;
    repoId?: string;
    signal?: AbortSignal;
  }): Promise<CodeGraphSnapshotEnvelope>;
  /** A writer: replaces one repository's graph. Refused while a build is queued or running. */
  importSnapshot(input: {
    scope: CodeGraphWorktreeScope;
    repoId?: string;
    snapshot: unknown;
    signal?: AbortSignal;
  }): Promise<CodeGraphSnapshotImportResult>;
  /**
   * `static` (the default) reads the config without loading anything; `load`
   * also loads each grammar and compiles its tags queries in a read host.
   */
  validateLanguages(
    scope: CodeGraphWorktreeScope,
    options?: { check?: 'static' | 'load'; signal?: AbortSignal },
  ): Promise<CodeGraphLanguagesValidation>;
}

/**
 * Workspace and worktree IDs name directories on the host, so one that could
 * act as a path segment is refused before any host path is built.
 */
function assertScope(scope: CodeGraphWorktreeScope): void {
  for (const id of [scope.workspaceId, scope.worktreeId])
    if (id.length === 0 || id === '.' || id === '..' || /[\\/\0]/.test(id))
      throw new CodeGraphReadServiceError(
        'invalid-argument',
        'The workspace or worktree ID is not valid.',
      );
}

function readKey(scope: CodeGraphWorktreeScope): string {
  return `${scope.workspaceId}/${scope.worktreeId}`;
}

async function targetRepository(
  host: CodeGraphReadServiceHost,
  scope: CodeGraphWorktreeScope,
  repoId: string | undefined,
): Promise<CodeGraphRepositoryInput> {
  const repositories = await host.repositories(scope);
  if (repoId !== undefined) {
    const repository = repositories.find(
      (candidate) => candidate.repoId === repoId,
    );
    if (repository === undefined)
      throw new CodeGraphReadServiceError(
        'not-found',
        `No repository "${repoId}" is in this worktree.`,
      );
    return repository;
  }
  const [only, ...rest] = repositories;
  if (only === undefined)
    throw new CodeGraphReadServiceError(
      'not-found',
      'This worktree has no repository.',
    );
  if (rest.length > 0)
    throw new CodeGraphReadServiceError(
      'invalid-argument',
      'This worktree has several repositories; name one.',
    );
  return only;
}

export function createCodeGraphReadService(
  host: CodeGraphReadServiceHost,
): CodeGraphReadService {
  const status = (scope: CodeGraphWorktreeScope): CodeGraphGraphState => {
    assertScope(scope);
    return {
      presence: host.hasGraph(scope) ? 'present' : 'absent',
      buildState: host.buildState(scope),
    };
  };

  async function runTask(
    scope: CodeGraphWorktreeScope,
    queryKind: CodeGraphQueryKind,
    task: CodeGraphWorkerReadTask,
    signal: AbortSignal | undefined,
  ): Promise<CodeGraphWorkerReadResult> {
    let response;
    try {
      response = await host.scheduler.run({
        key: readKey(scope),
        kind: queryKind,
        request: { dbPath: host.dbPath(scope), task },
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      throw new CodeGraphReadFailureError(codeGraphReadFailure(error));
    }
    if (!response.ok) throw new CodeGraphReadFailureError(response.code);
    if (response.result.kind !== task.kind)
      throw new CodeGraphReadFailureError('invalid-response');
    return response.result;
  }

  async function taskFor(
    scope: CodeGraphWorktreeScope,
    read: CodeGraphServiceRead,
  ): Promise<CodeGraphWorkerReadTask> {
    switch (read.kind) {
      case 'calls':
        return { kind: 'calls', calls: read.calls };
      case 'summary':
        return { kind: 'readonly-summary' };
      case 'build-stamp':
        return { kind: 'fingerprint-metadata' };
      case 'detect-changed': {
        const repository = await targetRepository(host, scope, read.repoId);
        return {
          kind: 'detect-changed',
          repoId: repository.repoId,
          rootPath: repository.rootPath,
          baseRef: read.baseRef,
        };
      }
      case 'change-impact': {
        const repository = await targetRepository(host, scope, read.repoId);
        return {
          kind: 'change-impact',
          repoId: repository.repoId,
          rootPath: repository.rootPath,
          baseRef: read.baseRef,
          resourcesDir: host.resourcesDir(),
          ...(read.maxDepth === undefined ? {} : { maxDepth: read.maxDepth }),
        };
      }
    }
  }

  async function readWorkspaceBase(
    workspaceId: string,
    repository: CodeGraphWorkspaceBaseRepository,
    queryKind: CodeGraphQueryKind,
    signal: AbortSignal | undefined,
  ): Promise<CodeGraphWorkspaceBaseRepositorySummary> {
    const { repoId } = repository;
    let graph: CodeGraphWorkspaceBaseGraph | undefined;
    try {
      graph = await repository.graph();
      if (graph.published === null)
        return {
          repoId,
          state: 'read',
          buildState: graph.buildState,
          published: false,
          behindCheckout: false,
          summary: { state: 'missing' },
        };
      const response = await host.scheduler.run({
        key: graph.key,
        diagnosticOwner: { projectId: workspaceId, worktreeId: '' },
        kind: queryKind,
        request: {
          dbPath: graph.published.dbPath,
          task: { kind: 'readonly-summary' },
        },
        ...(signal === undefined ? {} : { signal }),
      });
      if (!response.ok) throw new CodeGraphReadFailureError(response.code);
      if (response.result.kind !== 'readonly-summary')
        throw new CodeGraphReadFailureError('invalid-response');
      const summary = response.result.value;
      return {
        repoId,
        state: 'read',
        buildState: graph.buildState,
        published: true,
        behindCheckout:
          summary.state === 'ready' && (await graph.published.behindCheckout()),
        summary,
      };
    } catch (error) {
      return {
        repoId,
        state: 'failed',
        buildState: graph?.buildState ?? null,
        failure: codeGraphReadFailure(error),
      };
    }
  }

  async function queryWorkspaceBases(
    scope: CodeGraphWorkspaceBaseScope,
    queryKind: CodeGraphQueryKind,
    read: CodeGraphServiceRead,
    signal: AbortSignal | undefined,
  ): Promise<CodeGraphServiceQueryResult> {
    if (host.workspaceBases === undefined)
      throw new CodeGraphReadServiceError(
        'failed-precondition',
        'This worker does not serve workspace base graphs.',
      );
    if (queryKind !== 'ui-summary' || read.kind !== 'summary')
      throw new CodeGraphReadServiceError(
        'invalid-argument',
        'A workspace base graph answers only its summary.',
      );
    const bases = await host.workspaceBases(scope);
    const repositories: CodeGraphWorkspaceBaseRepositorySummary[] =
      bases.prepared
        ? await Promise.all(
            bases.repositories.map((repository) =>
              readWorkspaceBase(
                scope.workspaceId,
                repository,
                queryKind,
                signal,
              ),
            ),
          )
        : bases.repoIds.map((repoId) => ({
            repoId,
            state: 'read',
            buildState: null,
            published: false,
            behindCheckout: false,
            summary: { state: 'missing' },
          }));
    const states = repositories.map(({ buildState }) => buildState);
    return {
      presence: repositories.some(
        (repository) => repository.state === 'read' && repository.published,
      )
        ? 'present'
        : 'absent',
      buildState: states.includes('running')
        ? 'running'
        : states.includes('queued')
          ? 'queued'
          : 'idle',
      result: { kind: 'workspace-base-summary', value: { repositories } },
    };
  }

  return {
    status,
    async query({ scope, queryKind, read, signal }) {
      if ('kind' in scope)
        return queryWorkspaceBases(scope, queryKind, read, signal);
      assertScope(scope);
      // The read host answers a missing graph itself, exactly as before.
      const state = status(scope);
      const task = await taskFor(scope, read);
      const result = await runTask(scope, queryKind, task, signal);
      return { ...state, result };
    },
    async exportSnapshot({ scope, repoId, signal }) {
      assertScope(scope);
      const repository = await targetRepository(host, scope, repoId);
      if (!host.hasGraph(scope))
        throw new CodeGraphReadServiceError(
          'failed-precondition',
          'This worktree has no code graph yet.',
        );
      const result = await runTask(
        scope,
        'snapshot-export',
        {
          kind: 'snapshot-export',
          repoId: repository.repoId,
          generatedAt: host.now().toISOString(),
        },
        signal,
      );
      if (result.kind !== 'snapshot-export')
        throw new CodeGraphReadFailureError('invalid-response');
      if (result.value === null)
        throw new CodeGraphReadServiceError(
          'failed-precondition',
          'This repository has no code graph yet.',
        );
      return result.value;
    },
    async importSnapshot({ scope, repoId, snapshot, signal }) {
      assertScope(scope);
      let envelope: CodeGraphSnapshotEnvelope;
      try {
        envelope = parseCodeGraphSnapshotEnvelope(snapshot);
      } catch (error) {
        throw new CodeGraphReadServiceError(
          'invalid-argument',
          error instanceof Error
            ? error.message
            : 'The snapshot is not a code graph snapshot.',
        );
      }
      const repository = await targetRepository(host, scope, repoId);
      if (host.buildState(scope) !== 'idle')
        throw new CodeGraphReadServiceError(
          'failed-precondition',
          'A code graph build is queued or running for this worktree.',
        );
      const result = await runTask(
        scope,
        'snapshot-import',
        {
          kind: 'snapshot-import',
          repoId: repository.repoId,
          rootPath: repository.rootPath,
          envelope,
        },
        signal,
      );
      if (result.kind !== 'snapshot-import')
        throw new CodeGraphReadFailureError('invalid-response');
      return result.value;
    },
    async validateLanguages(scope, options) {
      assertScope(scope);
      let worktreeRoot: string;
      try {
        worktreeRoot = host.worktreeRoot(scope);
      } catch {
        // A scope with no checkout configures no custom languages.
        return { config: 'absent', languages: [], diagnostics: [] };
      }
      if (options?.check !== 'load')
        return validateCodeGraphCustomLanguages(worktreeRoot);
      const result = await runTask(
        scope,
        'languages-validate',
        {
          kind: 'languages-validate',
          worktreeRoot,
          resourcesDir: host.resourcesDir(),
        },
        options.signal,
      );
      if (result.kind !== 'languages-validate')
        throw new CodeGraphReadFailureError('invalid-response');
      return result.value;
    },
  };
}

/**
 * Static validation of a worktree's custom-language configuration: the config
 * is read within its byte bound and each entry checked, without loading any
 * grammar. An unreadable or unparseable config is `invalid`.
 */
export async function validateCodeGraphCustomLanguages(
  worktreeRoot: string,
): Promise<CodeGraphLanguagesValidation> {
  const configPath = customLanguagesConfigPath(worktreeRoot);
  let configRealPath: string;
  try {
    configRealPath = await realpath(configPath);
  } catch {
    return { config: 'absent', languages: [], diagnostics: [] };
  }
  try {
    const config = await readBoundedCodeGraphCustomLanguageFile(
      configPath,
      configRealPath,
      CODE_GRAPH_CUSTOM_LANGUAGES_CONFIG_MAX_BYTES,
    );
    if (config.kind === 'absent')
      return { config: 'absent', languages: [], diagnostics: [] };
    if (config.kind !== 'present')
      return { config: 'invalid', languages: [], diagnostics: [] };
    const parsed = parseCustomLanguagesConfig(config.bytes.toString('utf8'));
    if (!parsed.ok)
      return {
        config: 'invalid',
        languages: [],
        diagnostics: [{ entryId: null, index: -1, message: parsed.error }],
      };
    const { entries, diagnostics } = validateCustomLanguageEntries(
      parsed.rawEntries,
    );
    return {
      config: 'present',
      languages: entries.map((entry) => ({
        id: entry.id,
        extensions: entry.extensions,
      })),
      diagnostics: diagnostics.map(({ entryId, index, message }) => ({
        entryId,
        index,
        message,
      })),
    };
  } catch {
    return { config: 'invalid', languages: [], diagnostics: [] };
  }
}
