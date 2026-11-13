import {
  agentActionError,
  agentActionIdempotencyKey,
  agentActionResult,
  agentActionToolResult,
  portErrorResponse,
  runIdempotentWrite,
} from '../action-support';
import type { AgentActionLimitsPort } from '../limits';
import type { AgentActionReceiptStore } from '../receipts';
import type { AgentActionResponse, AgentJson } from '../response';
import type { AgentActionHostCapabilities } from '../surface/capabilities';
import type { AgentActionWatcherPort } from '../surface/engine';
import type { AgentActionCall, AgentActionCallScope } from '../surface/family';
import type { AgentActionToolResult } from '../tools/definition';
import type { ScheduleWakeupInput } from '../tools/schedule-wakeup';
import { sha256Hex } from '../sha256';
import {
  isCanonicalSetupWatcherEntry,
  MAX_ACTIVE_WATCHER_PAGE_SIZE,
  resolveSetupWatcherTrigger,
  type SearchWatchersInput,
  type SetupWatcherTargetInput,
  type SetupWatchersInput,
  type TargetSetupWatcherEntry,
} from '../tools/watchers';
import {
  buildAgentWatcherCatalog,
  searchAgentWatcherCatalog,
  type AgentWatcherTriggerType,
} from '../watchers/catalog';
import {
  isLegacyChatWatcherTrigger,
  offersCanonicalChatWatchers,
  type CanonicalChatWatcherEntry,
} from '../watchers/chat-watchers';
import {
  AgentPortError,
  type AgentChatState,
  type AgentEnvironmentPort,
} from './environment-port';

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

/** A project chat by canonical ids, as `projects.list_task_chats` names it. */
export interface AgentProjectChatAddress {
  projectId: string;
  taskId: string;
  chatId: string;
}

/** A project, or one of its tasks, whose new chats a watcher waits for. */
export interface AgentProjectChatScope {
  projectId: string;
  taskId?: string;
}

/**
 * A `project_task_chat_completion` watcher. As for chat watchers, except
 * that the target is a canonical project chat, which the port resolves
 * under its own target rules (for example, only projects with the calling
 * chat's saved owner, anything else `not_found`).
 */
export interface AgentArmProjectChatWatcherInput {
  target: AgentProjectChatAddress;
  label?: string;
  followUpInstruction?: string;
  armForNextCompletion: boolean;
  allowDuplicate?: boolean;
  forWrite?: { idempotencyKey: string };
  idempotencyKey: string;
}

/**
 * A `project_new_chat_started` watcher: it fires once, on the first input
 * of a chat in the scope that starts after it was armed, never the calling
 * chat's own start.
 */
export interface AgentArmProjectNewChatWatcherInput {
  target: AgentProjectChatScope;
  label?: string;
  followUpInstruction?: string;
  allowDuplicate?: boolean;
  idempotencyKey: string;
}

export interface AgentProjectChatWatcherRecord {
  watcherId: string;
  trigger: 'project_task_chat_completion';
  target: AgentProjectChatAddress;
  label: string | null;
}

export interface AgentProjectNewChatWatcherRecord {
  watcherId: string;
  trigger: 'project_new_chat_started';
  target: AgentProjectChatScope;
  label: string | null;
}

/** A pipeline run's terminal status, as pipeline watchers filter on it. */
export type AgentPipelineTerminalStatus = 'success' | 'failure' | 'cancelled';

/**
 * The pipeline runs a watcher follows, and the terminal statuses that fire
 * it: one run (`executionId`), or the runs that start after it is armed
 * (no `executionId`), of one workflow when `pipelineId` names it.
 */
export interface AgentPipelineWatcherTarget {
  executionId?: string;
  /** With `executionId`, the run must be one of this workflow. */
  pipelineId?: string;
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

/**
 * A ScheduleWakeup (`scheduled_wakeup`): one notification of the calling
 * chat once `delaySeconds` have passed since it was armed.
 */
export interface AgentArmScheduledWakeupInput {
  delaySeconds: number;
  followUpInstruction?: string;
  /** As for chat watchers: the same key returns the wakeup it armed. */
  idempotencyKey: string;
}

/** What a wakeup waits for: its delay and when it is due (ISO 8601). */
export interface AgentScheduledWakeupTarget {
  delaySeconds: number;
  scheduledFor: string;
}

export interface AgentArmedScheduledWakeup extends AgentArmedChatWatcher {
  target: AgentScheduledWakeupTarget;
  label: string;
}

export interface AgentScheduledWakeupWatcherRecord {
  watcherId: string;
  trigger: 'scheduled_wakeup';
  target: AgentScheduledWakeupTarget;
  label: string | null;
}

export type AgentWatcherRecord =
  | AgentChatWatcherRecord
  | AgentPipelineWatcherRecord
  | AgentProjectChatWatcherRecord
  | AgentProjectNewChatWatcherRecord
  | AgentScheduledWakeupWatcherRecord;

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
   * Arms a watcher on the pipeline runs the calling chat may watch. It
   * notifies the calling chat each time a watched run pauses, leaving the
   * watcher armed, and once when a watched run reaches a terminal status it
   * fires on, which consumes it. A host offers
   * `worktree_pipeline_completion` only with this member; it refuses a run
   * the calling chat may not watch with `not_found`, and one that already
   * ended, or that is not a run of the named workflow, with
   * `invalid_target`.
   */
  armPipelineCompletion?(
    input: AgentArmPipelineWatcherInput,
    call: AgentActionCall<H>,
  ): Promise<AgentArmedChatWatcher>;
  /**
   * Arms a `project_task_chat_completion` watcher. A host offers the trigger
   * only with this member. The tools refuse the calling chat before the
   * port; the port answers a target the caller may not watch, or one that
   * does not exist, with the same `not_found`, and an idle target without
   * `armForNextCompletion` (unbound) with `invalid_target`.
   */
  armProjectChatCompletion?(
    input: AgentArmProjectChatWatcherInput,
    call: AgentActionCall<H>,
  ): Promise<AgentArmedChatWatcher>;
  /**
   * Arms a `project_new_chat_started` watcher. A host offers the trigger only
   * with this member, and answers a scope the caller may not watch with
   * `not_found`.
   */
  armProjectNewChatStarted?(
    input: AgentArmProjectNewChatWatcherInput,
    call: AgentActionCall<H>,
  ): Promise<AgentArmedChatWatcher>;
  /**
   * Arms a `scheduled_wakeup` watcher, which notifies the calling chat once
   * its delay has passed. A host offers the trigger, and ScheduleWakeup, only
   * with this member. While the calling chat has a pending wakeup with the
   * same delay and follow-up instruction, the port returns it with its
   * original due time (`created: false`) instead of arming another, as
   * desktop does. The port refuses a calling chat it cannot wake later
   * (`invalid_target`) and one with no room for another watcher
   * (`quota_exceeded`).
   */
  armScheduledWakeup?(
    input: AgentArmScheduledWakeupInput,
    call: AgentActionCall<H>,
  ): Promise<AgentArmedScheduledWakeup>;
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
 * and canonical project chat watchers where the port arms them: target
 * validation against the environment port, the host's watcher target scope,
 * and per-entry results. They create only `worktree_chat_completion`
 * watchers, `worktree_pipeline_completion` watchers with a port that has
 * `armPipelineCompletion`, and `project_task_chat_completion` and
 * `project_new_chat_started` watchers with a port that has
 * `armProjectChatCompletion` and `armProjectNewChatStarted`, so
 * capabilities that offer any other trigger are refused at construction: a
 * host offers exactly the triggers its watcher tools accept.
 *
 * With a port that has `armScheduledWakeup` the tools also offer
 * `scheduled_wakeup` and ScheduleWakeup, an idempotent write behind the
 * host's receipts and limits like the other agent writes: a retried call
 * replays its result, and each new wakeup takes a limits slot.
 *
 * A host offering a canonical trigger gets the canonical tools' behavior:
 * SearchWatchers pages active watchers and filters them by canonical target
 * ids, and lists the legacy chat rows only for an exact trigger lookup,
 * while SetupWatchers still accepts them.
 */
export function createChatWatcherTools<H>(options: {
  capabilities: AgentActionHostCapabilities;
  environment: AgentEnvironmentPort<H>;
  watchers: AgentChatWatcherPort<H>;
  /**
   * Where ScheduleWakeup records its results, so a retried call replays the
   * wakeup it armed. Required with `armScheduledWakeup`.
   */
  receipts?: AgentActionReceiptStore<H>;
  /** The limits a new wakeup counts against; null or omitted for none. */
  limits?: AgentActionLimitsPort | null;
}): AgentActionWatcherPort<H, never> {
  const { capabilities, environment, watchers } = options;
  const toolTriggers: readonly AgentWatcherTriggerType[] = [
    'worktree_chat_completion',
    ...(watchers.armPipelineCompletion === undefined
      ? []
      : ['worktree_pipeline_completion' as const]),
    ...(watchers.armProjectChatCompletion === undefined
      ? []
      : ['project_task_chat_completion' as const]),
    ...(watchers.armProjectNewChatStarted === undefined
      ? []
      : ['project_new_chat_started' as const]),
    ...(watchers.armScheduledWakeup === undefined
      ? []
      : ['scheduled_wakeup' as const]),
  ];
  if (watchers.armScheduledWakeup !== undefined && !options.receipts) {
    throw new Error(
      'createChatWatcherTools needs receipts to offer ScheduleWakeup.',
    );
  }
  const canonical = offersCanonicalChatWatchers(capabilities.watcherTriggers);
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
    if (isCanonicalSetupWatcherEntry(entry))
      return setupCanonical(entry, index, scope, call);
    const trigger = resolveSetupWatcherTrigger(entry);
    if (
      trigger === 'worktree_pipeline_completion' &&
      capabilities.watcherTriggers.includes(trigger)
    ) {
      return setupPipeline(entry, index, call);
    }
    if (trigger !== 'worktree_chat_completion') {
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

  /**
   * A canonical project chat watcher, armed through the port, which resolves
   * the target under the host's own target rules. Bot triggers, and project
   * triggers the host does not offer, are not available here.
   */
  async function setupCanonical(
    entry: CanonicalChatWatcherEntry,
    index: number,
    scope: AgentActionCallScope,
    call: AgentActionCall<H>,
  ): Promise<AgentActionResponse> {
    const offered = capabilities.watcherTriggers.includes(entry.trigger);
    const metadata = {
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
    };
    let armed: AgentArmedChatWatcher;
    if (
      entry.trigger === 'project_task_chat_completion' &&
      offered &&
      watchers.armProjectChatCompletion
    ) {
      if (entry.target.chatId === scope.chatId) {
        return agentActionError(
          call,
          'invalid_target',
          'A chat cannot watch itself.',
        );
      }
      armed = await watchers.armProjectChatCompletion(
        {
          target: { ...entry.target },
          armForNextCompletion: entry.armForNextCompletion === true,
          ...metadata,
        },
        call,
      );
    } else if (
      entry.trigger === 'project_new_chat_started' &&
      offered &&
      watchers.armProjectNewChatStarted
    ) {
      armed = await watchers.armProjectNewChatStarted(
        { target: { ...entry.target }, ...metadata },
        call,
      );
    } else {
      return agentActionError(
        call,
        'missing_capability',
        `Watcher trigger ${entry.trigger} is not available here.`,
      );
    }
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
    if (watchers.armPipelineCompletion === undefined || requested === null) {
      return agentActionError(
        call,
        'invalid_payload',
        'worktree_pipeline_completion watchers here need target.executionId (the executionId pipeline.run returned), target.pipelineId, or target.terminalStatuses.',
      );
    }
    if (requested.runOn === 'local') {
      return agentActionError(
        call,
        'invalid_target',
        'Workflow runs here run in the cloud. Omit runOn to watch them.',
      );
    }
    // The input schema admits only terminal statuses here, and needs one of
    // executionId, pipelineId and terminalStatuses.
    const { executionId, pipelineId, terminalStatuses } = requested;
    const armed = await watchers.armPipelineCompletion(
      {
        target: {
          ...(executionId ? { executionId } : {}),
          ...(pipelineId ? { pipelineId } : {}),
          ...(terminalStatuses === undefined
            ? {}
            : { terminalStatuses: [...terminalStatuses] }),
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

  /**
   * ScheduleWakeup as an idempotent write: the key comes from the tool call,
   * so a retried call replays the wakeup it armed, and a new wakeup reserves
   * a limits slot before it is armed.
   */
  async function scheduleWakeup(
    input: ScheduleWakeupInput,
    call: AgentActionCall<H>,
  ): Promise<AgentActionToolResult> {
    const { receipts } = options;
    if (watchers.armScheduledWakeup === undefined || receipts === undefined) {
      return {
        text: 'ScheduleWakeup is not available in this chat.',
        isError: true,
      };
    }
    if (!call.scope) {
      return agentActionToolResult(
        agentActionError(
          call,
          'invalid_target',
          'ScheduleWakeup needs a chat to wake; it is not available here.',
        ),
      );
    }
    const idempotencyKey = agentActionIdempotencyKey(
      'schedule_wakeup',
      call,
      input,
    );
    try {
      return await runIdempotentWrite({
        receipts,
        limits: options.limits ?? null,
        kind: 'schedule_wakeup',
        call,
        idempotencyKey,
        payload: input,
        prepare: () =>
          Promise.resolve({
            ok: true,
            parentDepth: 0,
            write: async (): Promise<AgentActionToolResult> => {
              const armed = await watchers.armScheduledWakeup?.(
                {
                  delaySeconds: input.delaySeconds,
                  ...(input.followUpInstruction === undefined
                    ? {}
                    : { followUpInstruction: input.followUpInstruction }),
                  idempotencyKey,
                },
                call,
              );
              if (armed === undefined)
                throw new AgentPortError(
                  'unsupported_action',
                  'ScheduleWakeup is not available in this chat.',
                );
              return agentActionToolResult(
                agentActionResult(call, 'schedule_wakeup', {
                  watcherId: armed.watcherId,
                  trigger: 'scheduled_wakeup',
                  label: armed.label,
                  target: { ...armed.target },
                  // A pending identical wakeup was returned instead.
                  deduped: !armed.created,
                }),
              );
            },
          }),
      });
    } catch (error) {
      return agentActionToolResult(
        portErrorResponse(call, 'ScheduleWakeup', error),
      );
    }
  }

  // These tools watch only runs the calling chat started: one by its
  // execution id, or the ones it starts later.
  const offeredCatalog = catalog
    .filter((entry) => capabilities.watcherTriggers.includes(entry.trigger))
    .map((entry) =>
      entry.trigger === 'scheduled_wakeup'
        ? {
            ...entry,
            usageGuidance:
              'Use ScheduleWakeup for a one-shot wakeup of this chat after 60–3600 seconds. End the turn after registering; do not sleep or poll. The wakeup is kept on the server and arrives once, usually within about a minute of its due time; a chat archived or deleted before then gets nothing.',
          }
        : entry.trigger === 'worktree_pipeline_completion'
          ? {
              ...entry,
              title: 'Workflow run completion',
              requiredFields: [],
              optionalFields: ['executionId', 'pipelineId', 'terminalStatuses'],
              usageGuidance:
                'Fires when a workflow run this chat started pauses or reaches a terminal status. Pause notifications leave the watcher active; a matching terminal status consumes it. Use {"watchers":[{"trigger":"worktree_pipeline_completion","target":{"executionId":"..."}}]} with the executionId pipeline.run returned, or omit executionId and optionally set pipelineId or terminalStatuses to watch the runs this chat starts later.',
            }
          : entry,
    );

  return {
    hookTriggerNames: [],
    ...(watchers.armScheduledWakeup === undefined ? {} : { scheduleWakeup }),
    search: async (input, call): Promise<AgentActionToolResult> => {
      // A canonical host lists a legacy chat row only for an exact lookup.
      const rows = searchAgentWatcherCatalog(
        canonical
          ? offeredCatalog.filter(
              (entry) =>
                !isLegacyChatWatcherTrigger(entry.trigger) ||
                input.trigger === entry.trigger,
            )
          : offeredCatalog,
        input,
      );
      const active =
        input.includeActive === false ? [] : await watchers.list(call);
      const catalogJson = rows.map(
        (row): AgentJson => ({
          trigger: row.trigger,
          title: row.title,
          targetKind: row.targetKind,
          setupTool: row.setupTool,
          requiredFields: row.requiredFields,
          optionalFields: row.optionalFields,
          optionalEntryFields: row.optionalEntryFields,
          ...(input.detailLevel === 'standard' &&
          row.usageGuidance !== undefined
            ? { usageGuidance: row.usageGuidance }
            : {}),
        }),
      );
      const watcherJson = (watcher: AgentWatcherRecord): AgentJson => ({
        watcherId: watcher.watcherId,
        trigger: watcher.trigger,
        target: watcherTargetJson(watcher),
        label: watcher.label,
      });
      if (!canonical) {
        return json({
          catalog: catalogJson,
          activeWatchers: active.map(watcherJson),
        });
      }
      const page = pageActiveWatchers(active, input);
      if (!page.ok) return { text: page.error, isError: true };
      return json({
        catalog: catalogJson,
        activeWatchers: page.watchers.map(watcherJson),
        activeReturned: page.watchers.length,
        activeTotalMatches: page.totalMatches,
        ...(page.nextCursor === undefined
          ? {}
          : { activeNextCursor: page.nextCursor }),
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

/** The default page of active watchers a canonical SearchWatchers returns. */
const DEFAULT_ACTIVE_WATCHER_PAGE_SIZE = 50;

/**
 * A watcher's canonical target ids, for SearchWatchers' target filters and
 * `activeQuery`: a chat watcher's project, task and chat, and none for a
 * pipeline watcher.
 */
function canonicalTargetIds(watcher: AgentWatcherRecord): {
  projectId?: string;
  taskId?: string;
  chatId?: string;
} {
  switch (watcher.trigger) {
    case 'worktree_chat_completion':
      return {
        projectId: watcher.target.workspaceId,
        taskId: watcher.target.worktreeId,
        chatId: watcher.target.chatId,
      };
    case 'project_task_chat_completion':
    case 'project_new_chat_started':
      return { ...watcher.target };
    case 'worktree_pipeline_completion':
    case 'scheduled_wakeup':
      return {};
  }
}

/**
 * One page of active watchers, as desktop pages them: target filters match
 * canonical ids exactly, `activeQuery` matches the watcher id, label and
 * target ids case-insensitively, and a cursor (`v1.<offset>.<key>`) is valid
 * only for the same query and filters. No watcher has a bot target here, so
 * a bot filter matches none.
 */
function pageActiveWatchers(
  watchers: readonly AgentWatcherRecord[],
  input: SearchWatchersInput,
):
  | {
      ok: true;
      watchers: AgentWatcherRecord[];
      totalMatches: number;
      nextCursor?: string;
    }
  | { ok: false; error: string } {
  const query = (input.activeQuery ?? '').trim().toLowerCase();
  const pageSize = Math.min(
    MAX_ACTIVE_WATCHER_PAGE_SIZE,
    Math.max(
      1,
      Math.floor(input.activePageSize ?? DEFAULT_ACTIVE_WATCHER_PAGE_SIZE),
    ),
  );
  const matches = watchers.filter((watcher) => {
    if (input.targetBotId !== undefined) return false;
    const ids = canonicalTargetIds(watcher);
    if (
      (input.targetProjectId !== undefined &&
        ids.projectId !== input.targetProjectId) ||
      (input.targetTaskId !== undefined && ids.taskId !== input.targetTaskId) ||
      (input.targetChatId !== undefined && ids.chatId !== input.targetChatId)
    )
      return false;
    if (query.length === 0) return true;
    return [
      watcher.watcherId,
      watcher.label,
      ids.projectId,
      ids.taskId,
      ids.chatId,
    ]
      .filter((value): value is string => typeof value === 'string')
      .some((value) => value.toLowerCase().includes(query));
  });
  const key = sha256Hex(
    JSON.stringify([
      query,
      input.targetProjectId ?? null,
      input.targetBotId ?? null,
      input.targetTaskId ?? null,
      input.targetChatId ?? null,
    ]),
  ).slice(0, 8);
  let offset = 0;
  if (input.activeCursor !== undefined) {
    const match = /^v1\.(\d{1,9})\.([0-9a-f]{8})$/.exec(input.activeCursor);
    if (!match || match[2] !== key)
      return { ok: false, error: 'Invalid activeCursor.' };
    offset = Number(match[1]);
  }
  const page = matches.slice(offset, offset + pageSize);
  const next = offset + page.length;
  return {
    ok: true,
    watchers: page,
    totalMatches: matches.length,
    ...(next < matches.length
      ? { nextCursor: `v1.${String(next)}.${key}` }
      : {}),
  };
}

function watcherTargetJson(watcher: AgentWatcherRecord): AgentJson {
  if (
    watcher.trigger === 'worktree_chat_completion' ||
    watcher.trigger === 'project_task_chat_completion' ||
    watcher.trigger === 'project_new_chat_started' ||
    watcher.trigger === 'scheduled_wakeup'
  )
    return { ...watcher.target };
  const { executionId, pipelineId, terminalStatuses } = watcher.target;
  return {
    ...(executionId === undefined ? {} : { executionId }),
    ...(pipelineId === undefined ? {} : { pipelineId }),
    ...(terminalStatuses === undefined
      ? {}
      : { terminalStatuses: [...terminalStatuses] }),
  };
}
