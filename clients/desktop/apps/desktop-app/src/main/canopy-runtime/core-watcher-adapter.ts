import { CanopyOperationError } from '@canopy/core-runtime';
import { KeyedOutcomes } from '@canopy/core-runtime/node/operations';
import type { AgentActionToolResult } from '@canopy/agent-actions';
import type {
  WatcherCreateRequest,
  WatcherRecipient,
  WatcherReport,
} from '@canopy/protocol/canopy-core';
import type { AppAdvisorWatcherDestination } from '@canopy/desktop-shared/types';
import type { DesktopDomainAdapter } from './desktop-runtime';

type ToolReport = AgentActionToolResult & {
  failure?: { code: string; message: string };
};

/** The watcher service behind `core.initiatedWork.watcher.*`; Electron main's by default, tests inject one. */
export interface CoreWatcherHost {
  list(
    search: Record<string, unknown>,
    destination: AppAdvisorWatcherDestination,
  ): Promise<ToolReport>;
  create(
    request: WatcherCreateRequest,
    destination: AppAdvisorWatcherDestination,
    call: { createdBy?: string; signal: AbortSignal },
  ): Promise<ToolReport>;
  delete(
    watcherIds: string[],
    destination: AppAdvisorWatcherDestination,
  ): Promise<ToolReport>;
}

/**
 * Where a watcher's calling session works (CAN-6031): the host resolves it
 * from the recipient's ids, never from a path in the request.
 */
export interface CoreWatcherDirectories {
  /** A chat's directory: the one its session was started in. */
  chat(
    workspaceId: string,
    worktreeId: string,
    repoId: string | undefined,
  ): Promise<string>;
  /** A managed delegate's live run's directory, or undefined without one. */
  delegate(
    scope: { projectId: string; worktreeId: string; chatId: string },
    delegationId: string,
  ): Promise<string | undefined>;
}

const desktopWatcherDirectories: CoreWatcherDirectories = {
  chat: async (workspaceId, worktreeId, repoId) =>
    (await import('../lib/resolve-worktree')).resolveWorktreeCwd(
      workspaceId,
      worktreeId,
      repoId,
    ),
  delegate: async (scope, delegationId) =>
    (
      await import('../agents/delegation/service')
    ).managedDelegationWorkingDirectory(scope, delegationId),
};

/** The directory a command or GitHub watcher's session works in. */
export async function resolveWatcherDirectory(
  destination: AppAdvisorWatcherDestination,
  repoId: string | undefined,
  directories: CoreWatcherDirectories = desktopWatcherDirectories,
): Promise<string> {
  if (destination.delegationId === undefined)
    return directories.chat(
      destination.projectId,
      destination.worktreeId,
      repoId,
    );
  const directory = await directories.delegate(
    {
      projectId: destination.projectId,
      worktreeId: destination.worktreeId,
      chatId: destination.chatId,
    },
    destination.delegationId,
  );
  if (directory === undefined)
    throw new CanopyOperationError({
      kind: 'failed_precondition',
      code: 'core.initiatedWork.watcher.unavailable',
      message: 'This delegated task has no live run on this host.',
      retry: { kind: 'never' },
    });
  return directory;
}

function invalidRequest(message: string): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'invalid_argument',
    message,
    retry: { kind: 'never' },
  });
}

/** Re-validates a JSON tool input with the schema the tool used. */
function parsed<T>(
  schema: {
    safeParse(value: unknown): { success: true; data: T } | { success: false };
  },
  value: unknown,
): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw invalidRequest('The watcher request is not valid for its tool.');
  return result.data;
}

const desktopWatcherHost: CoreWatcherHost = {
  list: async (search, destination) => {
    const [{ searchWatchersFor }, { searchWatchersSchema }] = await Promise.all(
      [
        import('../agent-actions/desktop-watcher-port'),
        import('../canopy-tools/definitions'),
      ],
    );
    return searchWatchersFor(parsed(searchWatchersSchema, search), destination);
  },
  create: async (request, destination, call) => {
    const port = await import('../agent-actions/desktop-watcher-port');
    switch (request.kind) {
      case 'setup': {
        const { setupWatchersSchema } =
          await import('../canopy-tools/definitions');
        return port.setupWatchersFor(
          parsed(setupWatchersSchema, request.input),
          destination,
          {
            ...(call.createdBy ? { toolUseId: call.createdBy } : {}),
            signal: call.signal,
          },
        );
      }
      case 'github': {
        const { watchGitHubItemsSchema } =
          await import('../canopy-tools/definitions');
        return port.watchGitHubItemsFor(
          parsed(watchGitHubItemsSchema, request.input),
          destination,
          {
            ...(call.createdBy ? { toolUseId: call.createdBy } : {}),
            signal: call.signal,
            repositoryCwd: await resolveWatcherDirectory(
              destination,
              request.repoId,
            ),
          },
        );
      }
      case 'command':
      case 'wakeup':
        if (!call.createdBy)
          throw invalidRequest('A local watcher names the call that made it.');
        return port.createLocalWatcherFor(
          request.kind === 'command'
            ? {
                kind: 'command_watch',
                command: request.command,
                intervalSeconds: request.intervalSeconds,
                maxAttempts: request.maxAttempts,
                cwd: await resolveWatcherDirectory(destination, request.repoId),
              }
            : {
                kind: 'scheduled_wakeup',
                delaySeconds: request.delaySeconds,
                scheduledFor: '',
              },
          destination,
          {
            toolUseId: call.createdBy,
            ...(request.followUpInstruction !== undefined
              ? { followUpInstruction: request.followUpInstruction }
              : {}),
            signal: call.signal,
          },
        );
    }
  },
  delete: async (watcherIds, destination) => {
    const { deleteWatchersFor } =
      await import('../agent-actions/desktop-watcher-port');
    const { deleteWatchersInputSchema } = await import('@canopy/agent-actions');
    return deleteWatchersFor(
      parsed(deleteWatchersInputSchema, { watcherIds }),
      destination,
    );
  },
};

function destinationOf(
  recipient: WatcherRecipient,
): AppAdvisorWatcherDestination {
  return {
    projectId: recipient.workspaceId,
    worktreeId: recipient.worktreeId,
    chatId: recipient.chatId,
    ...(recipient.delegation
      ? {
          delegationId: recipient.delegation.delegationId,
          ...(recipient.delegation.description
            ? { delegationDescription: recipient.delegation.description }
            : {}),
          ...(recipient.delegation.depth !== undefined
            ? { delegationDepth: recipient.delegation.depth }
            : {}),
        }
      : {}),
  };
}

function report(result: ToolReport): WatcherReport {
  return {
    accepted: result.isError !== true,
    report: result.text,
    ...(result.failure ? { failure: result.failure } : {}),
  };
}

/**
 * `core.initiatedWork.watcher.list`, `.create` and `.delete` on the desktop
 * dispatcher (CAN-5994), over Electron main's watcher service. The recipient
 * is the calling session's chat; the service applies its own policy (owner,
 * bot and automation access, Cowork hooks) as the tools did.
 */
export function createCoreWatcherAdapter(
  host: CoreWatcherHost = desktopWatcherHost,
): DesktopDomainAdapter {
  const reusedError = (): CanopyOperationError =>
    new CanopyOperationError({
      kind: 'conflict',
      message: 'This idempotency key was used with other parameters.',
      retry: { kind: 'never' },
    });
  const creates = new KeyedOutcomes<WatcherReport>({ reusedError });
  const deletes = new KeyedOutcomes<WatcherReport>({ reusedError });
  return {
    queries: {
      'core.initiatedWork.watcher.list': async (params) =>
        report(await host.list(params.search, destinationOf(params.recipient))),
    },
    instructions: {
      'core.initiatedWork.watcher.create': (params, context) =>
        creates.run(context, params, async () =>
          report(
            await host.create(params.request, destinationOf(params.recipient), {
              ...(params.createdBy ? { createdBy: params.createdBy } : {}),
              signal: context.signal,
            }),
          ),
        ),
      'core.initiatedWork.watcher.delete': (params, context) =>
        deletes.run(context, params, async () =>
          report(
            await host.delete(
              params.watcherIds,
              destinationOf(params.recipient),
            ),
          ),
        ),
    },
  };
}
