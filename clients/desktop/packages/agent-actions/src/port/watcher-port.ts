import {
  agentActionError,
  agentActionIdempotencyKey,
  portErrorResponse,
} from '../action-support';
import type { AgentActionResponse, AgentJson } from '../response';
import type { AgentActionHostCapabilities } from '../surface/capabilities';
import type { AgentActionWatcherPort } from '../surface/engine';
import type { AgentActionCall, AgentActionCallScope } from '../surface/family';
import type { AgentActionToolResult } from '../tools/definition';
import {
  isCanonicalSetupWatcherEntry,
  resolveSetupWatcherTrigger,
  type SetupWatcherTargetInput,
  type SetupWatchersInput,
  type TargetSetupWatcherEntry,
} from '../tools/watchers';
import {
  buildAgentWatcherCatalog,
  searchAgentWatcherCatalog,
  type AgentWatcherTriggerType,
} from '../watchers/catalog';
import type { AgentChatState, AgentEnvironmentPort } from './environment-port';

export interface AgentChatWatcherTarget {
  workspaceId: string;
  worktreeId: string;
  chatId: string;
}

export interface AgentArmChatWatcherInput {
  target: AgentChatWatcherTarget;
  label?: string;
  followUpInstruction?: string;
  /**
   * Arm an idle chat for its next completed turn. Applies only to watchers
   * without `forWrite`: a bound watcher waits for its write's turn whatever
   * state the target is in, so a port never rejects it as idle.
   */
  armForNextCompletion: boolean;
  /**
   * Arm another watcher even when the calling chat already has an identical
   * active one. Absent: a port returns the identical active watcher (same
   * target, label, and follow-up instruction) instead of arming another. A
   * port may dedupe more broadly, for example by target alone. Inline
   * watchers of `chat.create` and `chat.send_message` always set it: they
   * belong to their write and are never shared.
   */
  allowDuplicate?: boolean;
  /**
   * The write whose message this watcher waits for. The port completes the
   * watcher only on the turn that the `startChat` or `postMessage` with this
   * idempotency key submits, never on a turn already running or queued
   * ahead of it, even after a retry of that write adopts an existing chat.
   * It resolves against that turn alone and never waits for a later one: if
   * the turn has already finished when the watcher is armed (a retry of a
   * write whose outcome was unknown arms it after the fact) or when an
   * existing watcher is returned for its key, the port fires the watcher
   * for that turn at once, or on its next evaluation, exactly as the turn's
   * completion would have. A turn not submitted yet, queued, or running
   * leaves the watcher armed until it finishes.
   * Inline watchers of `chat.create` and `chat.send_message` always set it;
   * SetupWatchers never does, so those fire on the target's next completion.
   * A bound watcher is private to its write: a port never dedupes another
   * arming onto it, nor it onto another watcher, so only that write's
   * rollback removes it.
   */
  forWrite?: { idempotencyKey: string };
  /**
   * Arming again under a key the port already armed returns that watcher,
   * also after it fired, and arms nothing new; a watcher the caller deleted
   * no longer counts. A retried write therefore reuses its inline watchers.
   */
  idempotencyKey: string;
}

export interface AgentChatWatcherRecord {
  watcherId: string;
  trigger: 'worktree_chat_completion';
  target: AgentChatWatcherTarget;
  label: string | null;
}

/** A pipeline run's terminal status, as pipeline watchers filter on it. */
export type AgentPipelineTerminalStatus = 'success' | 'failure' | 'cancelled';

/** One pipeline run, and the terminal statuses that fire its watcher. */
export interface AgentPipelineWatcherTarget {
  executionId: string;
  /** Omitted fires on every terminal status. */
  terminalStatuses?: readonly AgentPipelineTerminalStatus[];
}

export interface AgentArmPipelineWatcherInput {
  target: AgentPipelineWatcherTarget;
  label?: string;
  followUpInstruction?: string;
  /** As for chat watchers: absent dedupes onto an identical active watcher. */
  allowDuplicate?: boolean;
  /** As for chat watchers: the same key returns the watcher it armed. */
  idempotencyKey: string;
}

export interface AgentPipelineWatcherRecord {
  watcherId: string;
  trigger: 'worktree_pipeline_completion';
  target: AgentPipelineWatcherTarget;
  label: string | null;
}

export type AgentWatcherRecord =
  | AgentChatWatcherRecord
  | AgentPipelineWatcherRecord;

export type AgentWatcherDeleteStatus = 'deleted' | 'not_found' | 'busy';

/**
 * Host-side chat-completion watchers owned by the calling chat. A watcher
 * notifies the calling chat once when its target finishes a turn.
 */
export interface AgentArmedChatWatcher {
  watcherId: string;
  /**
   * Whether this call created the watcher. False when the port returned an
   * existing identical watcher (dedupe) that another call created; such a
   * watcher is never removed when this call's write is rolled back.
   */
  created: boolean;
}

export interface AgentChatWatcherPort<H> {
  /**
   * Where a target's chat is now, before any scope check. A host whose chats
   * can move to another project (a cloud combine) maps a target naming the
   * project the chat left to its current one; other hosts omit it.
   */
  resolveTarget?(
    target: AgentChatWatcherTarget,
    call: AgentActionCall<H>,
  ): Promise<AgentChatWatcherTarget>;
  armChatCompletion(
    input: AgentArmChatWatcherInput,
    call: AgentActionCall<H>,
  ): Promise<AgentArmedChatWatcher>;
  /**
   * Arms a watcher that notifies the calling chat once when a pipeline run
   * it may watch reaches a terminal status. A host offers
   * `worktree_pipeline_completion` only with this member; it refuses a run
   * the calling chat may not watch with `not_found`, and one that already
   * ended with `invalid_target`.
   */
  armPipelineCompletion?(
    input: AgentArmPipelineWatcherInput,
    call: AgentActionCall<H>,
  ): Promise<AgentArmedChatWatcher>;
  list(call: AgentActionCall<H>): Promise<readonly AgentWatcherRecord[]>;
  delete(
    watcherIds: readonly string[],
    call: AgentActionCall<H>,
  ): Promise<
    readonly { watcherId: string; status: AgentWatcherDeleteStatus }[]
  >;
}

const PENDING_CHAT_STATES: readonly AgentChatState[] = [
  'queued',
  'running',
  'awaiting_user',
];

type WatcherEntry = SetupWatchersInput<never>['watchers'][number];

function json(value: AgentJson, isError = false): AgentActionToolResult {
  return {
    text: JSON.stringify(value, null, 2),
    ...(isError ? { isError: true } : {}),
  };
}

function responseJson(response: AgentActionResponse): AgentJson {
  return response.error
    ? {
        ok: false,
        error: {
          code: response.error.code,
          message: response.error.message,
        },
      }
    : { ok: true, result: response.result ?? null };
}

/**
 * The watcher tools over chat-completion watchers, and pipeline-completion
 * watchers where the port arms them: target validation against the
 * environment port, the host's watcher target scope, and per-entry results.
 * They create only `worktree_chat_completion` watchers, and
 * `worktree_pipeline_completion` watchers with a port that has
 * `armPipelineCompletion`, so capabilities that offer any other trigger are
 * refused at construction: a host offers exactly the triggers its watcher
 * tools accept.
 */
export function createChatWatcherTools<H>(options: {
  capabilities: AgentActionHostCapabilities;
  environment: AgentEnvironmentPort<H>;
  watchers: AgentChatWatcherPort<H>;
}): AgentActionWatcherPort<H, never> {
  const { capabilities, environment, watchers } = options;
  const toolTriggers: readonly AgentWatcherTriggerType[] =
    watchers.armPipelineCompletion === undefined
      ? ['worktree_chat_completion']
      : ['worktree_chat_completion', 'worktree_pipeline_completion'];
  const unsupported = capabilities.watcherTriggers.filter(
    (trigger) => !toolTriggers.includes(trigger),
  );
  if (unsupported.length > 0) {
    throw new Error(
      `createChatWatcherTools creates only ${toolTriggers.join(', ')} watchers, but the capabilities offer ${unsupported.join(', ')}.`,
    );
  }
  const catalog = buildAgentWatcherCatalog({
    hookTriggers: [],
    hookTriggerNames: [],
    pullRequestQueuePhases: [],
  });

  async function setupOne(
    entry: WatcherEntry,
    index: number,
    scope: AgentActionCallScope,
    call: AgentActionCall<H>,
  ): Promise<AgentActionResponse> {
    const trigger = isCanonicalSetupWatcherEntry(entry)
      ? entry.trigger
      : resolveSetupWatcherTrigger(entry);
    if (
      trigger === 'worktree_pipeline_completion' &&
      !isCanonicalSetupWatcherEntry(entry) &&
      capabilities.watcherTriggers.includes(trigger)
    ) {
      return setupPipeline(entry, index, call);
    }
    if (
      trigger !== 'worktree_chat_completion' ||
      isCanonicalSetupWatcherEntry(entry)
    ) {
      return agentActionError(
        call,
        'missing_capability',
        `Watcher trigger ${trigger} is not available here.`,
      );
    }
    const requested = entry.target;
    if (
      !('projectId' in requested) ||
      requested.worktreeId === undefined ||
      requested.chatId === undefined
    ) {
      return agentActionError(
        call,
        'invalid_payload',
        'worktree_chat_completion watchers need target.projectId, target.worktreeId, and target.chatId.',
      );
    }
    const projectId = watchers.resolveTarget
      ? (
          await watchers.resolveTarget(
            {
              workspaceId: requested.projectId,
              worktreeId: requested.worktreeId,
              chatId: requested.chatId,
            },
            call,
          )
        ).workspaceId
      : requested.projectId;
    const target = {
      projectId,
      worktreeId: requested.worktreeId,
      chatId: requested.chatId,
    };
    if (
      capabilities.watcherTargetScope === 'current_workspace' &&
      target.projectId !== scope.workspaceId
    ) {
      return agentActionError(
        call,
        'invalid_target',
        'Watchers here may only target chats in the current project.',
      );
    }
    if (target.chatId === scope.chatId) {
      return agentActionError(
        call,
        'invalid_target',
        'A chat cannot watch itself.',
      );
    }
    const chat = await environment.getChat(
      { scope: { workspaceId: target.projectId }, chatId: target.chatId },
      call,
    );
    if (
      !chat ||
      chat.workspaceId !== target.projectId ||
      chat.worktreeId !== target.worktreeId
    ) {
      return agentActionError(
        call,
        'not_found',
        `Chat ${target.chatId} was not found in worktree ${target.worktreeId}.`,
      );
    }
    if (chat.state === 'archived') {
      return agentActionError(
        call,
        'invalid_target',
        `Chat ${target.chatId} is archived.`,
      );
    }
    const armForNextCompletion = entry.armForNextCompletion === true;
    if (!armForNextCompletion && !PENDING_CHAT_STATES.includes(chat.state)) {
      return agentActionError(
        call,
        'invalid_target',
        `Chat ${target.chatId} is idle. Set armForNextCompletion: true to watch its next turn.`,
      );
    }
    const armed = await watchers.armChatCompletion(
      {
        target: {
          workspaceId: target.projectId,
          worktreeId: target.worktreeId,
          chatId: target.chatId,
        },
        ...(entry.label ? { label: entry.label } : {}),
        ...(entry.followUpInstruction
          ? { followUpInstruction: entry.followUpInstruction }
          : {}),
        armForNextCompletion,
        ...(entry.allowDuplicate === true ? { allowDuplicate: true } : {}),
        idempotencyKey: agentActionIdempotencyKey(
          `setup_watchers.${index}`,
          call,
          entry,
        ),
      },
      call,
    );
    return {
      requestId: call.toolUseId ?? '',
      ok: true,
      result: { watcherId: armed.watcherId },
    };
  }

  async function setupPipeline(
    entry: TargetSetupWatcherEntry<never>,
    index: number,
    call: AgentActionCall<H>,
  ): Promise<AgentActionResponse> {
    const requested = pipelineTarget(entry.target);
    if (
      watchers.armPipelineCompletion === undefined ||
      requested?.executionId === undefined ||
      requested.executionId.length === 0
    ) {
      return agentActionError(
        call,
        'invalid_payload',
        'worktree_pipeline_completion watchers here need target.executionId: the executionId pipeline.run returned.',
      );
    }
    // The input schema admits only terminal statuses here.
    const statuses = requested.terminalStatuses;
    const armed = await watchers.armPipelineCompletion(
      {
        target: {
          executionId: requested.executionId,
          ...(statuses === undefined
            ? {}
            : { terminalStatuses: [...statuses] }),
        },
        ...(entry.label ? { label: entry.label } : {}),
        ...(entry.followUpInstruction
          ? { followUpInstruction: entry.followUpInstruction }
          : {}),
        ...(entry.allowDuplicate === true ? { allowDuplicate: true } : {}),
        idempotencyKey: agentActionIdempotencyKey(
          `setup_watchers.${index}`,
          call,
          entry,
        ),
      },
      call,
    );
    return {
      requestId: call.toolUseId ?? '',
      ok: true,
      result: { watcherId: armed.watcherId },
    };
  }

  // These tools watch only runs the calling chat started, by execution id.
  const offeredCatalog = catalog
    .filter((entry) => capabilities.watcherTriggers.includes(entry.trigger))
    .map((entry) =>
      entry.trigger === 'worktree_pipeline_completion'
        ? {
            ...entry,
            title: 'Workflow run completion',
            requiredFields: ['executionId'],
            optionalFields: ['terminalStatuses'],
            usageGuidance:
              'Fires once when a workflow run this chat started reaches a terminal status. Use {"watchers":[{"trigger":"worktree_pipeline_completion","target":{"executionId":"..."}}]} with the executionId pipeline.run returned.',
          }
        : entry,
    );

  return {
    hookTriggerNames: [],
    search: async (input, call): Promise<AgentActionToolResult> => {
      const rows = searchAgentWatcherCatalog(offeredCatalog, input);
      const active =
        input.includeActive === false ? [] : await watchers.list(call);
      return json({
        catalog: rows.map(
          (row): AgentJson => ({
            trigger: row.trigger,
            title: row.title,
            targetKind: row.targetKind,
            setupTool: row.setupTool,
            requiredFields: row.requiredFields,
            optionalFields: row.optionalFields,
            optionalEntryFields: row.optionalEntryFields,
          }),
        ),
        activeWatchers: active.map(
          (watcher): AgentJson => ({
            watcherId: watcher.watcherId,
            trigger: watcher.trigger,
            target: watcherTargetJson(watcher),
            label: watcher.label,
          }),
        ),
      });
    },
    setup: async (input, call): Promise<AgentActionToolResult> => {
      const scope = call.scope;
      if (!scope) {
        return {
          text: 'SetupWatchers is not available in this chat.',
          isError: true,
        };
      }
      const results: AgentJson[] = [];
      let failures = 0;
      let index = 0;
      for (const entry of input.watchers) {
        let response: AgentActionResponse;
        try {
          response = await setupOne(entry, index, scope, call);
        } catch (error) {
          response = portErrorResponse(call, 'SetupWatchers', error);
        }
        if (!response.ok) failures += 1;
        results.push(responseJson(response));
        index += 1;
      }
      return json({ watchers: results }, failures === results.length);
    },
    delete: async (input, call): Promise<AgentActionToolResult> => {
      const results = await watchers.delete(input.watcherIds, call);
      return json({
        results: results.map(
          (entry): AgentJson => ({
            watcherId: entry.watcherId,
            status: entry.status,
          }),
        ),
      });
    },
  };
}

/** A SetupWatchers target naming a pipeline run, or null for another kind. */
function pipelineTarget(
  target: SetupWatcherTargetInput<never>,
): Extract<SetupWatcherTargetInput<never>, { executionId?: string }> | null {
  return 'projectId' in target ||
    'triggerName' in target ||
    'automationId' in target
    ? null
    : target;
}

function watcherTargetJson(watcher: AgentWatcherRecord): AgentJson {
  if (watcher.trigger === 'worktree_chat_completion')
    return { ...watcher.target };
  const { executionId, terminalStatuses } = watcher.target;
  return {
    executionId,
    ...(terminalStatuses === undefined
      ? {}
      : { terminalStatuses: [...terminalStatuses] }),
  };
}
