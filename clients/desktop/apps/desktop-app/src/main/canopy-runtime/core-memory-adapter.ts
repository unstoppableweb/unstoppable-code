import { CanopyOperationError } from '@canopy/core-runtime';
import { KeyedOutcomes } from '@canopy/core-runtime/node/operations';
import type {
  CanopyOperationCode,
  CanopyWorkspaceScope,
  MemoryScopeKind,
  MemorySearchResult,
} from '@canopy/protocol/canopy-core';
import type {
  LocalMemoryScopeRequest,
  SearchHit,
} from '@canopy/desktop-shared/types';
import type { LocalMemoryPolicy } from '../memory/local/policy';
import type { LocalMemoryStore } from '../memory/local/memory-store';
import { LocalMemoryScopeReadOnlyError } from '../memory/local/scope-manifest';
import type { DesktopDomainAdapter } from './desktop-runtime';

/** What `core.memory.*` reads and writes; Electron main's store by default, tests inject one. */
export interface CoreMemoryHost {
  enabled(): Promise<boolean>;
  policy(location: {
    projectId: string;
    worktreeId: string;
  }): Promise<LocalMemoryPolicy>;
  store: Pick<
    LocalMemoryStore,
    'saveNote' | 'search' | 'readFile' | 'recordUsage' | 'seedUsage'
  >;
  /** Tells open windows a scope changed. */
  changed(scope: LocalMemoryScopeRequest): void;
}

const desktopMemoryHost: CoreMemoryHost = {
  enabled: async () => {
    const { readPreferencesFile } = await import('../lib/preferences-store');
    return (await readPreferencesFile()).localMemoryEnabled;
  },
  policy: async (location) => {
    const { resolveLocalMemoryPolicy } = await import('../memory/local/policy');
    return resolveLocalMemoryPolicy(location);
  },
  store: {
    saveNote: async (...args) =>
      (await import('../memory/local/memory-store')).localMemoryStore.saveNote(
        ...args,
      ),
    search: async (...args) =>
      (await import('../memory/local/memory-store')).localMemoryStore.search(
        ...args,
      ),
    readFile: async (...args) =>
      (await import('../memory/local/memory-store')).localMemoryStore.readFile(
        ...args,
      ),
    recordUsage: async (...args) =>
      (
        await import('../memory/local/memory-store')
      ).localMemoryStore.recordUsage(...args),
    seedUsage: async (...args) =>
      (await import('../memory/local/memory-store')).localMemoryStore.seedUsage(
        ...args,
      ),
  },
  changed: (scope) => {
    void import('../memory/local/change-events').then(
      ({ broadcastLocalMemoryChanged }) => broadcastLocalMemoryChanged(scope),
    );
  },
};

const refused = (
  code: CanopyOperationCode,
  message: string,
): CanopyOperationError =>
  new CanopyOperationError({
    kind: 'failed_precondition',
    code,
    message,
    retry: { kind: 'never' },
  });

const DISABLED = (): CanopyOperationError =>
  refused('core.memory.disabled', 'Local memory is disabled');
const POLICY_UNAVAILABLE = (): CanopyOperationError =>
  refused(
    'core.memory.policyUnavailable',
    'Project memory is unavailable because its configuration could not be read.',
  );
const USER_IN_PRIVATE_PROJECT = (): CanopyOperationError =>
  refused(
    'core.memory.scopeUnavailable',
    'User memory is unavailable in a private-memory project. Use workspace scope.',
  );

function chatLocation(scope: CanopyWorkspaceScope): {
  projectId: string;
  worktreeId: string;
} {
  if (scope.workspaceId === undefined || scope.worktreeId === undefined)
    throw new CanopyOperationError({
      kind: 'invalid_argument',
      message: 'Name the calling chat’s project and worktree.',
      retry: { kind: 'never' },
    });
  return { projectId: scope.workspaceId, worktreeId: scope.worktreeId };
}

/** The policy for a call, refusing a disabled store or an unreadable project. */
async function admittedPolicy(
  host: CoreMemoryHost,
  scope: CanopyWorkspaceScope,
): Promise<Exclude<LocalMemoryPolicy, { kind: 'blocked' }>> {
  const location = chatLocation(scope);
  if (!(await host.enabled())) throw DISABLED();
  const policy = await host.policy(location);
  if (policy.kind === 'blocked') throw POLICY_UNAVAILABLE();
  return policy;
}

/** The store scope one memory kind names under a policy, or the refusal. */
function scopeFor(
  policy: Exclude<LocalMemoryPolicy, { kind: 'blocked' }>,
  memory: MemoryScopeKind,
  noProjectMessage: string,
): LocalMemoryScopeRequest {
  if (policy.kind === 'scoped' && policy.privateMemory && memory === 'user')
    throw USER_IN_PRIVATE_PROJECT();
  if (memory === 'user') return { scope: 'user' };
  if (policy.kind !== 'scoped')
    throw refused('core.memory.scopeUnavailable', noProjectMessage);
  return { scope: 'workspace', workspaceId: policy.workspaceId };
}

const hit = (entry: SearchHit): MemorySearchResult['hits'][number] => ({
  memory: entry.scope,
  fileKey: entry.fileKey,
  heading: entry.heading ?? null,
  snippet: entry.snippet,
});

/**
 * `core.memory.search`, `.entry.get` and `.entry.append` on the desktop
 * dispatcher (CAN-5993), over Electron main's local memory store. Each
 * resolves the calling chat's memory policy at the boundary; reads record
 * usage, and a save broadcasts the change and seeds the note's usage.
 */
export function createCoreMemoryAdapter(
  host: CoreMemoryHost = desktopMemoryHost,
): DesktopDomainAdapter {
  const appends = new KeyedOutcomes<{
    memory: MemoryScopeKind;
    fileKey: string;
  }>({
    reusedError: (): CanopyOperationError =>
      new CanopyOperationError({
        kind: 'conflict',
        message: 'This idempotency key was used with other parameters.',
        retry: { kind: 'never' },
      }),
  });
  return {
    queries: {
      'core.memory.search': async (params) => {
        const policy = await admittedPolicy(host, params.scope);
        const userScope: LocalMemoryScopeRequest = { scope: 'user' };
        const scopes: LocalMemoryScopeRequest[] =
          policy.kind === 'scoped' && policy.privateMemory ? [] : [userScope];
        const workspaceScope: LocalMemoryScopeRequest | null =
          policy.kind === 'scoped'
            ? { scope: 'workspace', workspaceId: policy.workspaceId }
            : null;
        if (workspaceScope !== null) scopes.push(workspaceScope);
        const hits = await host.store.search(scopes, params.query);
        const keys = (memory: MemoryScopeKind): string[] =>
          Array.from(
            new Set(
              hits
                .filter((entry) => entry.scope === memory)
                .map((entry) => entry.fileKey),
            ),
          );
        const userKeys = keys('user');
        const workspaceKeys = keys('workspace');
        await Promise.all([
          ...(userKeys.length > 0
            ? [host.store.recordUsage(userScope, userKeys)]
            : []),
          ...(workspaceScope !== null && workspaceKeys.length > 0
            ? [host.store.recordUsage(workspaceScope, workspaceKeys)]
            : []),
        ]);
        return { hits: hits.map(hit) };
      },
      'core.memory.entry.get': async (params) => {
        const policy = await admittedPolicy(host, params.scope);
        const scope = scopeFor(
          policy,
          params.memory,
          'Project memory is not available in this session because no project is selected.',
        );
        const content = await host.store.readFile(scope, params.fileKey);
        if (content === undefined)
          throw new CanopyOperationError({
            kind: 'not_found',
            code: 'core.memory.entry.notFound',
            message: `Local memory file not found: [${params.memory}] ${params.fileKey}.`,
            retry: { kind: 'never' },
          });
        await host.store.recordUsage(scope, [params.fileKey]);
        return { memory: params.memory, fileKey: params.fileKey, content };
      },
    },
    instructions: {
      'core.memory.entry.append': (params, context) =>
        appends.run(context, params, async () => {
          const policy = await admittedPolicy(host, params.scope);
          const scope = scopeFor(
            policy,
            params.memory,
            'Project memory is not available in this session because no project is selected; save with scope "user" instead.',
          );
          let fileKey: string;
          try {
            fileKey = await host.store.saveNote(scope, {
              text: params.content,
              source: params.source,
              // Where the note was saved (design §10.4): a synced replica
              // records it, so an organization that keeps its work off the
              // cloud can.
              ...(policy.kind === 'scoped' && policy.owner !== undefined
                ? {
                    origin: {
                      organizationId: policy.owner.organizationId.toLowerCase(),
                      projectId: policy.owner.projectId.toLowerCase(),
                    },
                  }
                : {}),
            });
          } catch (error) {
            if (error instanceof LocalMemoryScopeReadOnlyError)
              throw refused('core.memory.scopeReadOnly', error.message);
            throw error;
          }
          if (!fileKey)
            throw new CanopyOperationError({
              kind: 'internal',
              message: 'The memory note could not be written.',
              retry: { kind: 'never' },
            });
          host.changed(scope);
          await host.store.seedUsage(scope, fileKey);
          return { memory: params.memory, fileKey };
        }),
    },
  };
}
