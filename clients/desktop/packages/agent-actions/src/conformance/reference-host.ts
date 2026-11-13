import {
  createExperimentsActionFamily,
  EXPERIMENT_ACTION_TYPES,
} from '../families/experiments';
import type { AgentExperimentWriteResult } from '../port/experiments-port';
import {
  createSettingsActionFamily,
  SETTINGS_ACTION_TYPES,
} from '../families/settings';
import type { AgentSettingsOpenResult } from '../port/settings-port';
import {
  CHAT_CONTROL_ACTION_TYPES,
  createChatControlActionFamily,
} from '../families/chat-control';
import type { SettingsRoute } from '@canopy/protocol/settings';
import type {
  CanopyQueryResult,
  CoreWorktree,
} from '@canopy/protocol/canopy-core';
import type { ModelCatalogOption } from '@canopy/protocol/models';
import { createTranscriptReadActionFamily } from '../families/transcript-read/dispatch';
import { createConformanceTranscriptStore } from './transcript-store';
import type { AgentTranscriptReadPort } from '../port/transcript-read-port';
import { TRANSCRIPT_READ_ACTION_TYPES } from '../families/transcript-read/actions';
import { ENVIRONMENT_ACTION_TYPES } from '../families/environment/actions';
import {
  createEnvironmentActionFamily,
  offersInlineChatWatchers,
} from '../families/environment/dispatch';
import { createInMemoryAgentActionLimits } from '../limits';
import { createInMemoryAgentActionReceipts } from '../receipts';
import {
  AgentPortError,
  portQueriesFromHandlerMap,
  type AgentChatDetail,
  type AgentEnvironmentPort,
  type AgentPostMessageReceipt,
  type AgentStartChatReceipt,
} from '../port/environment-port';
import {
  createForkSplitPort,
  type AgentForkChatReceipt,
} from '../port/split-port';
import {
  createChatWatcherTools,
  type AgentArmedChatWatcher,
  type AgentChatWatcherPort,
  type AgentChatWatcherRecord,
  type AgentWatcherDeleteStatus,
} from '../port/watcher-port';
import type { AgentActionHostCapabilities } from '../surface/capabilities';
import { createAgentActionSurface } from '../surface/engine';
import type { AgentActionCall } from '../surface/family';
import { createWriteHolds } from './holds';
import { createLimitCommitFailures } from './limit-failures';
import type {
  AgentConformanceCallIdentity,
  AgentConformanceHost,
  AgentConformanceWriteHold,
} from './suite';
import type { ConformanceWorld } from './world';

/** Everything the shared layer offers, as a single in-memory host. */
export const REFERENCE_HOST_CAPABILITIES: AgentActionHostCapabilities = {
  executionScope: 'worktree',
  actionTypes: [
    ...ENVIRONMENT_ACTION_TYPES,
    ...TRANSCRIPT_READ_ACTION_TYPES,
    ...EXPERIMENT_ACTION_TYPES,
    ...SETTINGS_ACTION_TYPES,
    ...CHAT_CONTROL_ACTION_TYPES,
  ],
  chatCreatePlacements: ['current', 'new_worktree'],
  watcherTriggers: ['worktree_chat_completion'],
  watcherTargetScope: 'current_workspace',
  split: { forked: true, branched: false },
  hiddenInstructions: false,
  limits: true,
};

type ReferenceCall = AgentActionCall<null>;

interface ReferenceChat {
  chatId: string;
  workspaceId: string;
  worktreeId: string;
  title: string;
  state: AgentChatDetail['state'];
  modelId: string;
  lastResponse: string | null;
}

interface ReferenceWorktree {
  worktreeId: string;
  workspaceId: string;
  name: string;
  branch: string;
}

interface ReferenceWatcher extends AgentChatWatcherRecord {
  ownerChatId: string;
  followUpInstruction: string | null;
  forWrite: string | null;
}

const CREATED_AT = '2026-01-01T00:00:00.000Z';

/**
 * An in-memory host over the conformance world. It implements every port the
 * shared layer defines, so the suite can run against the shared code alone.
 */
export function createReferenceHost(
  world: ConformanceWorld,
  options: { capabilities?: AgentActionHostCapabilities } = {},
): AgentConformanceHost<null> {
  const capabilities = options.capabilities ?? REFERENCE_HOST_CAPABILITIES;
  const workspaceId = world.workspace.workspaceId;
  const transcripts = createConformanceTranscriptStore(world);
  const transcriptRead: AgentTranscriptReadPort<null> = {
    authorizeOwner: (target, call) => {
      const chat = world.chats.find((row) => row.chatId === target.chatId);
      if (!chat || call.scope?.workspaceId !== workspaceId)
        throw new AgentPortError('not_found', 'Transcript owner not found.');
      return Promise.resolve({
        scope: {
          workspaceId,
          worktreeId: chat.worktreeId,
          chatId: chat.chatId,
        },
        ...(chat.state === 'archived'
          ? { archivedContainerId: chat.worktreeId }
          : {}),
      });
    },
    page: (input, owner) => Promise.resolve(transcripts.page(input, owner)),
    content: (input, owner) =>
      Promise.resolve(transcripts.content(input, owner)),
    blocks: (input, owner) => Promise.resolve(transcripts.blocks(input, owner)),
  };
  const worktrees: ReferenceWorktree[] = [
    ...world.worktrees.map((worktree) => ({ ...worktree, workspaceId })),
    {
      worktreeId: world.foreign.worktreeId,
      workspaceId: world.foreign.workspaceId,
      name: 'Foreign worktree',
      branch: 'foreign',
    },
  ];
  const chats: ReferenceChat[] = [
    ...world.chats.map((chat) => ({ ...chat, workspaceId })),
    {
      chatId: world.foreign.chatId,
      workspaceId: world.foreign.workspaceId,
      worktreeId: world.foreign.worktreeId,
      title: 'Foreign chat',
      state: 'idle',
      modelId: world.defaultModelId,
      lastResponse: null,
    },
  ];
  const watchers: ReferenceWatcher[] = [];
  // Each chat's running turn and the turns queued behind it, by the
  // idempotency key of the write that submitted them (null: not an agent's).
  const turns = new Map<string, (string | null)[]>(
    chats
      .filter((chat) => chat.state === 'running')
      .map((chat) => [chat.chatId, [null]]),
  );
  const submitTurn = (chatId: string, writeKey: string): void => {
    turns.set(chatId, [...(turns.get(chatId) ?? []), writeKey]);
  };
  // The writes whose turn has finished, by idempotency key.
  const finishedWrites = new Set<string>();
  const startReceipts = new Map<string, AgentStartChatReceipt>();
  const postReceipts = new Map<string, AgentPostMessageReceipt>();
  const forkReceipts = new Map<string, AgentForkChatReceipt>();
  const watcherIds = new Map<string, AgentArmedChatWatcher>();
  // A fired watcher is still the one its key armed; a deleted one is not.
  const firedWatcherIds = new Set<string>();
  const firedLog: string[] = [];
  const withdrawnModels = new Set<string>();
  const unmessageable = new Set<string>();
  let sequence = 0;
  const nextId = (prefix: string): string => {
    sequence += 1;
    return `${prefix}${sequence}`;
  };

  const coreWorktree = (worktree: ReferenceWorktree): CoreWorktree => ({
    worktreeId: worktree.worktreeId,
    workspaceId: worktree.workspaceId,
    name: worktree.name,
    state: 'ready',
    baseBranch: null,
    branch: worktree.branch,
    createdAt: CREATED_AT,
  });

  const findWorktree = (worktreeId: string): ReferenceWorktree => {
    const worktree = worktrees.find((entry) => entry.worktreeId === worktreeId);
    if (!worktree) {
      throw new AgentPortError(
        'not_found',
        `Worktree ${worktreeId} was not found.`,
      );
    }
    return worktree;
  };

  const addChat = (
    worktreeId: string,
    title: string,
    modelId: string,
    writeKey: string,
  ): ReferenceChat => {
    const chat: ReferenceChat = {
      chatId: nextId('chat-'),
      workspaceId,
      worktreeId,
      title,
      state: 'running',
      modelId,
      lastResponse: null,
    };
    chats.push(chat);
    submitTurn(chat.chatId, writeKey);
    return chat;
  };

  const models = (): ModelCatalogOption[] =>
    world.models.map((model) => ({
      id: model.id,
      label: model.label,
      provider: model.provider,
      kind: 'model',
      available: !withdrawnModels.has(model.id),
      isDefault: model.id === world.defaultModelId,
      thinkingLevels: [...model.thinkingLevels],
    }));

  const environment: AgentEnvironmentPort<null> = {
    query: portQueriesFromHandlerMap<null, null>(
      {
        'core.workspace.get': (params) => {
          if (params.workspaceId !== workspaceId) {
            throw new AgentPortError(
              'not_found',
              `Workspace ${params.workspaceId} was not found.`,
            );
          }
          return {
            workspaceId,
            name: world.workspace.name,
            kind: world.workspace.kind,
            repositorySources: world.workspace.repositories.map((source) => ({
              repoId: source.repoId,
              remoteUrl: source.remoteUrl,
              ...(source.defaultBranch
                ? { defaultBranch: source.defaultBranch }
                : {}),
            })),
            settings: {},
          };
        },
        'core.worktree.list': (params) => ({
          items: worktrees
            .filter(
              (worktree) =>
                worktree.workspaceId ===
                (params.scope?.workspaceId ?? workspaceId),
            )
            .map(coreWorktree),
          nextCursor: null,
        }),
        'core.worktree.get': (params) =>
          coreWorktree(findWorktree(params.worktreeId)),
        'core.chat.list': (params): CanopyQueryResult<'core.chat.list'> => ({
          items: chats
            .filter(
              (chat) =>
                chat.workspaceId === params.scope.workspaceId &&
                chat.worktreeId === params.scope.worktreeId,
            )
            .map((chat) => ({
              chatId: chat.chatId,
              workspaceId: chat.workspaceId,
              worktreeId: chat.worktreeId,
              title: chat.title,
              state: chat.state,
              revision: 0,
              modelId: chat.modelId,
              createdAt: CREATED_AT,
            })),
          nextCursor: null,
        }),
      },
      () => null,
    ),
    getChat: (input) => {
      const chat = chats.find((entry) => entry.chatId === input.chatId);
      return Promise.resolve(
        chat
          ? {
              chatId: chat.chatId,
              workspaceId: chat.workspaceId,
              worktreeId: chat.worktreeId,
              title: chat.title,
              state: chat.state,
              modelId: chat.modelId,
              ...(chat.lastResponse ? { lastResponse: chat.lastResponse } : {}),
              ...(unmessageable.has(chat.chatId)
                ? {
                    messageable: false,
                    unmessageableReason: `Chat ${chat.chatId} cannot be messaged on this host.`,
                  }
                : {}),
            }
          : null,
      );
    },
    startChat: (input) => {
      const replay = startReceipts.get(input.idempotencyKey);
      if (replay) return Promise.resolve(replay);
      const modelId = input.model?.id ?? world.defaultModelId;
      let receipt: AgentStartChatReceipt;
      if (input.placement === 'new_worktree') {
        const worktree: ReferenceWorktree = {
          worktreeId: nextId('worktree-'),
          workspaceId,
          name: input.title ?? 'New worktree',
          branch: nextId('agent-branch-'),
        };
        worktrees.push(worktree);
        const chat = addChat(
          worktree.worktreeId,
          input.title ?? 'New chat',
          modelId,
          input.idempotencyKey,
        );
        receipt = {
          chatId: chat.chatId,
          worktreeId: worktree.worktreeId,
          delivery: 'queued_for_setup',
        };
      } else {
        findWorktree(input.scope.worktreeId);
        const chat = addChat(
          input.scope.worktreeId,
          input.title ?? 'New chat',
          modelId,
          input.idempotencyKey,
        );
        receipt = {
          chatId: chat.chatId,
          worktreeId: chat.worktreeId,
          delivery: 'submitted',
        };
      }
      startReceipts.set(input.idempotencyKey, receipt);
      const started = receipt;
      return (
        input.beforeFirstMessage?.({
          chatId: started.chatId,
          worktreeId: started.worktreeId,
        }) ?? Promise.resolve()
      ).then(() => started);
    },
    postMessage: (input) => {
      const replay = postReceipts.get(input.idempotencyKey);
      if (replay) return Promise.resolve(replay);
      const chat = chats.find((entry) => entry.chatId === input.chatId);
      if (!chat) {
        return Promise.reject(
          new AgentPortError(
            'not_found',
            `Chat ${input.chatId} was not found.`,
          ),
        );
      }
      const receipt: AgentPostMessageReceipt = {
        chatId: chat.chatId,
        delivery: chat.state === 'running' ? 'queued' : 'submitted',
      };
      chat.state = 'running';
      submitTurn(chat.chatId, input.idempotencyKey);
      postReceipts.set(input.idempotencyKey, receipt);
      return Promise.resolve(receipt);
    },
    listModels: () =>
      Promise.resolve({
        models: models(),
        defaultModelId: world.defaultModelId,
      }),
    callerDepth: () => Promise.resolve(world.callerDepth),
    unmessageableChatIds: ({ chatIds }) =>
      Promise.resolve(chatIds.filter((chatId) => unmessageable.has(chatId))),
  };

  const chatWatchers: AgentChatWatcherPort<null> = {
    armChatCompletion: (input, call) => {
      const replay = watcherIds.get(input.idempotencyKey);
      if (
        replay &&
        (watchers.some((watcher) => watcher.watcherId === replay.watcherId) ||
          firedWatcherIds.has(replay.watcherId))
      ) {
        return Promise.resolve(replay);
      }
      const ownerChatId = call.scope?.chatId ?? '';
      const label = input.label ?? null;
      const followUpInstruction = input.followUpInstruction ?? null;
      const identical =
        input.allowDuplicate === true || input.forWrite !== undefined
          ? undefined
          : watchers.find(
              (watcher) =>
                watcher.ownerChatId === ownerChatId &&
                watcher.forWrite === null &&
                watcher.target.workspaceId === input.target.workspaceId &&
                watcher.target.worktreeId === input.target.worktreeId &&
                watcher.target.chatId === input.target.chatId &&
                watcher.label === label &&
                watcher.followUpInstruction === followUpInstruction,
            );
      if (identical) {
        const deduped = { watcherId: identical.watcherId, created: false };
        watcherIds.set(input.idempotencyKey, deduped);
        return Promise.resolve(deduped);
      }
      const watcherId = nextId('watcher-');
      const armed = { watcherId, created: true };
      watcherIds.set(input.idempotencyKey, armed);
      if (input.forWrite && finishedWrites.has(input.forWrite.idempotencyKey)) {
        firedWatcherIds.add(watcherId);
        firedLog.push(watcherId);
        return Promise.resolve(armed);
      }
      watchers.push({
        watcherId,
        trigger: 'worktree_chat_completion',
        target: { ...input.target },
        label,
        ownerChatId,
        followUpInstruction,
        forWrite: input.forWrite?.idempotencyKey ?? null,
      });
      return Promise.resolve(armed);
    },
    list: (call) =>
      Promise.resolve(
        watchers.filter(
          (watcher) => watcher.ownerChatId === call.scope?.chatId,
        ),
      ),
    delete: (ids, call) =>
      Promise.resolve(
        ids.map(
          (
            watcherId,
          ): { watcherId: string; status: AgentWatcherDeleteStatus } => {
            const index = watchers.findIndex(
              (watcher) =>
                watcher.watcherId === watcherId &&
                watcher.ownerChatId === call.scope?.chatId,
            );
            if (index < 0) return { watcherId, status: 'not_found' };
            watchers.splice(index, 1);
            return { watcherId, status: 'deleted' };
          },
        ),
      ),
  };

  let clock = Date.parse(CREATED_AT);
  const holds = createWriteHolds();
  const heldEnvironment = holds.wrap(environment);
  const commitFailures = createLimitCommitFailures();
  const limits = capabilities.limits
    ? commitFailures.wrap(createInMemoryAgentActionLimits({ now: () => clock }))
    : null;
  const offersWatchers = offersInlineChatWatchers(capabilities);
  const receipts = createInMemoryAgentActionReceipts<null>();
  let experimentRevision = 0;
  const experiments = createExperimentsActionFamily<null>({
    receipts,
    limits: capabilities.limits ? limits : null,
    port: {
      setEnabled: (request): Promise<AgentExperimentWriteResult> => {
        if (request.experimentId !== 'early-access')
          return Promise.reject(
            new AgentPortError('invalid_payload', 'Unknown experiment.'),
          );
        experimentRevision++;
        return Promise.resolve({
          experimentId: request.experimentId,
          storedChoice: request.enabled,
          effectiveEnabledAtCommit: request.enabled,
          listedAtCommit: true,
          generationAtCommit: 0,
          revisionAtCommit: experimentRevision,
        });
      },
    },
  });
  const memberships = new Set(
    world.organizations.map((organization) => organization.organizationId),
  );
  const openedSettings: SettingsRoute[] = [];
  const settings = createSettingsActionFamily<null>({
    port: {
      open: (route): Promise<AgentSettingsOpenResult> => {
        if (
          route.scope === 'organization' &&
          !memberships.has(route.organizationId)
        )
          return Promise.resolve({
            status: 'rejected',
            reason: 'organization_not_member',
          });
        openedSettings.push(route);
        return Promise.resolve({ status: 'opened' });
      },
    },
  });
  const family = createEnvironmentActionFamily<null>({
    capabilities,
    port: heldEnvironment,
    limits,
    watchers: offersWatchers ? chatWatchers : null,
    receipts,
  });
  // Ends a chat's turns: the running one, and with `all` those queued behind.
  const stopTurns = (
    chatId: string,
    all: boolean,
  ): { interrupted: boolean; cancelledQueued: number } => {
    const queue = turns.get(chatId) ?? [];
    if (queue.length === 0) return { interrupted: false, cancelledQueued: 0 };
    const ended = all ? queue.splice(0) : queue.splice(0, 1);
    for (const writeKey of ended)
      if (writeKey !== null) finishedWrites.add(writeKey);
    const chat = chats.find((entry) => entry.chatId === chatId);
    if (chat?.state === 'running' && queue.length === 0) chat.state = 'idle';
    return { interrupted: true, cancelledQueued: ended.length - 1 };
  };
  const chatControl = createChatControlActionFamily<null>({
    environment,
    receipts,
    port: {
      interrupt: (target) =>
        Promise.resolve({
          chatId: target.chatId,
          interrupted: stopTurns(target.chatId, false).interrupted,
        }),
      cancel: (target) =>
        Promise.resolve({
          chatId: target.chatId,
          ...stopTurns(target.chatId, true),
        }),
      archive: (target) => {
        const chat = chats.find((entry) => entry.chatId === target.chatId);
        if (!chat)
          return Promise.reject(
            new AgentPortError(
              'not_found',
              `Chat ${target.chatId} was not found.`,
            ),
          );
        const archived = chat.state !== 'archived';
        chat.state = 'archived';
        return Promise.resolve({ chatId: chat.chatId, archived });
      },
    },
  });
  const surface = createAgentActionSurface<null, never>({
    brand: world.brand,
    capabilities,
    families: [
      family,
      createTranscriptReadActionFamily({ port: transcriptRead }),
      experiments,
      settings,
      chatControl,
    ],
    ...(offersWatchers
      ? {
          watchers: createChatWatcherTools({
            capabilities,
            environment,
            watchers: chatWatchers,
          }),
        }
      : {}),
    ...(capabilities.split.forked
      ? {
          split: createForkSplitPort<null>({
            environment,
            limits,
            receipts,
            fork: {
              forkChat: (input) => {
                const replay = forkReceipts.get(input.idempotencyKey);
                if (replay) return Promise.resolve(replay);
                const chat = addChat(
                  input.scope.worktreeId,
                  'Forked chat',
                  world.defaultModelId,
                  input.idempotencyKey,
                );
                const receipt = {
                  chatId: chat.chatId,
                  worktreeId: chat.worktreeId,
                };
                forkReceipts.set(input.idempotencyKey, receipt);
                return Promise.resolve(receipt);
              },
            },
          }),
        }
      : {}),
  });

  return {
    surface,
    capabilities,
    call: ({
      callingChatId,
      ...identity
    }: AgentConformanceCallIdentity): ReferenceCall => {
      const caller = world.chats.find((chat) => chat.chatId === callingChatId);
      return {
        scope: caller
          ? {
              workspaceId,
              worktreeId: caller.worktreeId,
              chatId: caller.chatId,
            }
          : { ...world.current },
        ...identity,
        host: null,
      };
    },
    control: {
      transcriptReadCount: (): number => transcripts.readCount(),
      archiveChat: (chatId): Promise<void> => {
        const chat = chats.find((entry) => entry.chatId === chatId);
        if (chat) chat.state = 'archived';
        return Promise.resolve();
      },
      setChatMessageable: (chatId, messageable): Promise<void> => {
        if (messageable) unmessageable.delete(chatId);
        else unmessageable.add(chatId);
        return Promise.resolve();
      },
      withdrawModel: (modelId): Promise<void> => {
        withdrawnModels.add(modelId);
        return Promise.resolve();
      },
      advanceClock: (ms): Promise<void> => {
        clock += ms;
        return Promise.resolve();
      },
      holdNextChatStart: (): AgentConformanceWriteHold =>
        holds.holdNextChatStart(),
      holdNextMessagePost: (): AgentConformanceWriteHold =>
        holds.holdNextMessagePost(),
      failNextLimitCommit: (): Promise<void> => {
        commitFailures.failNextCommit();
        return Promise.resolve();
      },
      completeTurn: (chatId): Promise<readonly string[]> => {
        const queue = turns.get(chatId) ?? [];
        const finished = queue.shift();
        if (finished === undefined) return Promise.resolve([]);
        if (finished !== null) finishedWrites.add(finished);
        const chat = chats.find((entry) => entry.chatId === chatId);
        if (chat && queue.length === 0) chat.state = 'idle';
        const fired = watchers.filter(
          (watcher) =>
            watcher.target.chatId === chatId &&
            (watcher.forWrite === null || watcher.forWrite === finished),
        );
        for (const watcher of fired) {
          watchers.splice(watchers.indexOf(watcher), 1);
          firedWatcherIds.add(watcher.watcherId);
          firedLog.push(watcher.watcherId);
        }
        return Promise.resolve(fired.map((watcher) => watcher.watcherId));
      },
      firedWatchers: (): Promise<readonly string[]> =>
        Promise.resolve([...firedLog]),
      openedSettings: (): Promise<readonly SettingsRoute[]> =>
        Promise.resolve([...openedSettings]),
    },
  };
}
