import { randomUUID } from 'node:crypto';
import {
  CanopyOperationError,
  canopyInvalidArgumentError,
  canopyCapabilityUnavailableError,
} from '@canopy/core-runtime';
import type {
  MemoryChatSearchParams,
  MemoryChatSearchResult,
  MemoryChatExcerptResult,
  CanopyOperationCode,
  CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import type { WorkspaceContext } from '@canopy/protocol/workspace-context';
import {
  DEFAULT_COWORK_WORKSPACE_ID,
  type ChatSearchResult,
  type ChatSearchQueryRequest,
} from '@canopy/desktop-shared/types';
import type { AgentChatSearchFilter } from '../chat-search/query';
import type { LocalMemoryPolicy } from '../memory/local/policy';
import type { DesktopDomainAdapter } from './desktop-runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from './desktop-runtime-identity';

export interface CoreMemoryChatsHost {
  enabled(): Promise<boolean>;
  policy(location: {
    projectId: string;
    worktreeId: string;
  }): Promise<LocalMemoryPolicy>;
  query(
    request: ChatSearchQueryRequest,
    context: WorkspaceContext,
    filter: AgentChatSearchFilter,
  ): Promise<ChatSearchResult[]>;
  now(): number;
}

const desktopHost: CoreMemoryChatsHost = {
  enabled: async () =>
    (await (await import('../lib/preferences-store')).readPreferencesFile())
      .localMemoryEnabled,
  policy: async (location) =>
    (await import('../memory/local/policy')).resolveLocalMemoryPolicy(location),
  query: async (request, context, filter) => {
    const service = (
      await import('../chat-search/service')
    ).getChatSearchService();
    service.ensureInitialScan();
    await service.waitForInitialScan();
    return service.queryForAgent(request, context, filter);
  },
  now: Date.now,
};

type CallerScope = MemoryChatSearchParams['scope'];
type Policy = Extract<LocalMemoryPolicy, { kind: 'scoped' }>;
interface Match {
  caller: string;
  policy: string;
  query: string;
  documentId: string;
  expiresAt: number;
}
const MATCH_TTL_MS = 15 * 60 * 1000;
const MATCH_LIMIT = 512;

function refusal(
  code: CanopyOperationCode,
  message: string,
): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'failed_precondition',
    code,
    message,
    retry: { kind: 'never' },
  });
}
const unavailable = (): CanopyOperationError =>
  refusal(
    'core.memory.chats.matchUnavailable',
    'This chat match is unavailable. Search chats again.',
  );

function callerKey(scope: CallerScope, caller: CanopyCallerDescriptor): string {
  return JSON.stringify([
    caller.principalId,
    caller.clientInstanceId,
    caller.authorityId,
    scope.workspaceId,
    scope.worktreeId,
    scope.chatId,
  ]);
}
function policyKey(policy: Policy): string {
  return JSON.stringify([
    policy.workspaceId,
    policy.privateMemory,
    policy.owner?.organizationId.toLowerCase(),
    policy.owner?.projectId.toLowerCase(),
  ]);
}

/** Core owns policy and opaque match handles; the index worker owns text projection. */
export function createCoreMemoryChatsAdapter(
  host: CoreMemoryChatsHost = desktopHost,
): DesktopDomainAdapter {
  const matches = new Map<string, Match>();
  const policyFor = async (scope: CallerScope): Promise<Policy> => {
    if (
      scope.targetId !== undefined ||
      (scope.authorityId !== undefined &&
        scope.authorityId !== LOCAL_DESKTOP_AUTHORITY_ID)
    )
      throw canopyCapabilityUnavailableError(
        'The selected history authority or target is unavailable.',
      );
    if (!scope.workspaceId || !scope.worktreeId || !scope.chatId)
      throw canopyInvalidArgumentError(
        'Name the calling chat, project and worktree.',
      );
    if (!(await host.enabled()))
      throw refusal('core.memory.disabled', 'Local memory is disabled');
    let policy = await host.policy({
      projectId: scope.workspaceId,
      worktreeId: scope.worktreeId,
    });
    // Outside a project, only Personal Chats is eligible, never other personal projects.
    if (policy.kind === 'unscoped')
      policy = await host.policy({
        projectId: DEFAULT_COWORK_WORKSPACE_ID,
        worktreeId: DEFAULT_COWORK_WORKSPACE_ID,
      });
    if (policy.kind !== 'scoped')
      throw refusal(
        'core.memory.policyUnavailable',
        'Project memory is unavailable because its configuration could not be read.',
      );
    if (
      scope.organizationId !== undefined &&
      scope.organizationId.toLowerCase() !==
        policy.owner?.organizationId.toLowerCase()
    )
      throw refusal(
        'core.memory.scopeUnavailable',
        'The calling chat organization does not match its project.',
      );
    return policy;
  };
  const query = (
    scope: CallerScope,
    policy: Policy,
    text: string,
    limit: number,
    documentId?: string,
  ): Promise<ChatSearchResult[]> =>
    host.query(
      { query: text, limit },
      policy.owner
        ? {
            kind: 'organization',
            organizationId: policy.owner.organizationId.toLowerCase(),
          }
        : { kind: 'personal' },
      {
        projectId: policy.workspaceId,
        excludeChatId: scope.chatId,
        ...(documentId === undefined ? {} : { documentId, excerpt: true }),
      },
    );
  const prune = (): void => {
    const now = host.now();
    for (const [id, match] of matches)
      if (match.expiresAt <= now) matches.delete(id);
    while (matches.size >= MATCH_LIMIT) {
      const oldest = matches.keys().next();
      if (oldest.done) break;
      matches.delete(oldest.value);
    }
  };
  return {
    queries: {
      'core.memory.chats.search': async (
        params,
        context,
      ): Promise<MemoryChatSearchResult> => {
        const policy = await policyFor(params.scope);
        const results = await query(
          params.scope,
          policy,
          params.query,
          params.limit,
        );
        // A toggle or ownership change while the worker was running revokes its result.
        if (policyKey(await policyFor(params.scope)) !== policyKey(policy))
          throw unavailable();
        const hits: MemoryChatSearchResult['hits'] = [];
        for (const result of results.slice(0, params.limit)) {
          const date = new Date(result.updatedAt);
          if (!Number.isFinite(date.getTime())) continue;
          prune();
          const matchId = randomUUID();
          matches.set(matchId, {
            caller: callerKey(params.scope, context.caller),
            policy: policyKey(policy),
            query: params.query,
            documentId: result.docId,
            expiresAt: host.now() + MATCH_TTL_MS,
          });
          hits.push({
            matchId,
            title: result.title.slice(0, 512),
            date: date.toISOString(),
            snippet: result.snippet.slice(0, 1200),
          });
        }
        return { hits };
      },
      'core.memory.chats.excerpt': async (
        params,
        context,
      ): Promise<MemoryChatExcerptResult> => {
        const policy = await policyFor(params.scope);
        const match = matches.get(params.matchId);
        if (
          !match ||
          match.expiresAt <= host.now() ||
          match.caller !== callerKey(params.scope, context.caller) ||
          match.policy !== policyKey(policy)
        )
          throw unavailable();
        const [result] = await query(
          params.scope,
          policy,
          match.query,
          1,
          match.documentId,
        );
        if (
          !result ||
          policyKey(await policyFor(params.scope)) !== match.policy
        )
          throw unavailable();
        return {
          title: result.title.slice(0, 512),
          date: new Date(result.updatedAt).toISOString(),
          excerpt: result.snippet.slice(0, 6000),
        };
      },
    },
  };
}
