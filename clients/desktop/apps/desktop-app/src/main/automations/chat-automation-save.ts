/**
 * A person's automation save from the edit form (CAN-4551, 7b). A convertible
 * chat automation is stored as a pipeline it owns, or its owned pipeline is
 * regenerated in place. An edit that no longer converts, such as one pinned
 * to an Agent route, stores the native chat action from the form and deletes
 * the owned pipeline.
 *
 * D4 sends, the Home scheduled task and other actions that stay native keep
 * today's save. A failed conversion leaves the native save in place, which
 * runs as it always did. Agent writes never come through here.
 */
import { isDeepStrictEqual } from 'node:util';
import {
  ownedPipelineToChatAction,
  type ChatAutomationAction,
} from '@canopy/desktop-shared/lib/chat-automation-conversion';
import type { PipelineData } from '@canopy/execution-engine/types/pipeline';
import type {
  AutomationAction,
  AutomationCreateRequest,
  AutomationMutationResponse,
  AutomationUpdateRequest,
  ScheduledActivity,
} from '@canopy/desktop-shared/types';
import type { PipelineAgentAuthor } from '@canopy/execution-engine/types/pipeline';
import type { WorkspaceContext } from '@canopy/protocol/workspace-context';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { isCoworkWorkspace } from '../lib/workspace-registry';
import { readPipelineLocalMetadata } from '../pipelines/pipeline-local-metadata-store';
import { getStoredPipelineBySource } from '../pipelines/pipeline-service';
import {
  convertsToOwnedChatPipeline,
  impliedChatTargetRequirement,
  regeneratedOwnedChatAction,
  saveOwnedChatPipeline,
} from './chat-automation-conversion';
import {
  nativeGrantAuthority,
  ownedPipelineAuthority,
  sameNativeGrantAuthority,
  withNativeGrantAuthority,
} from './chat-automation-native-grant';
import {
  deleteOwnedPipeline,
  ownedChatPipelineState,
  ownedPipelineId,
} from './owned-pipeline';
import { projectOwnedChatAutomation } from './owned-chat-projection';
import {
  isSharedByOtherSchedules,
  isWorkflowPagePipeline,
  scheduledUserPipelineId,
  sharedPipelineRelease,
} from './workflow-schedules';
import {
  getAutomationsService,
  type AutomationsService,
  type AutomationTrustedCreate,
  type AutomationTrustedUpdate,
  type AutomationTrustedWrite,
} from './service';

/** A person writing the automation clears any agent marker. */
const PERSON = { agentAuthor: null } as const;

async function projected(
  response: AutomationMutationResponse,
  service: AutomationsService,
): Promise<AutomationMutationResponse> {
  return response.ok && response.activity
    ? {
        ...response,
        activity: projectOwnedChatAutomation(
          response.activity,
          await service.allActivities(),
        ),
      }
    : response;
}

/** Converts a saved native automation; a failure keeps the native save. */
async function convertSaved(
  saved: AutomationMutationResponse,
  service: AutomationsService,
): Promise<AutomationMutationResponse> {
  if (!saved.ok) return saved;
  const { activity } = saved;
  if (!activity || !convertsToOwnedChatPipeline(activity)) return saved;
  const converted = await service.replaceWithOwnedPipeline(
    activity.id,
    saveOwnedChatPipeline,
  );
  if (converted.ok) return converted;
  logMainProcessWarn('Kept a chat automation native; it could not convert', {
    operation: 'convert-chat-automation',
  });
  return saved;
}

export async function createAutomationFromForm(
  request: AutomationCreateRequest,
  service: AutomationsService = getAutomationsService(),
): Promise<AutomationMutationResponse> {
  const created = await service.create(request, PERSON);
  return projected(await convertSaved(created, service), service);
}

/** Who writes an update, and the guard and context it writes with. */
interface UpdateWriter {
  /** `undefined` keeps the record's author (CAN-5782). */
  agentAuthor: PipelineAgentAuthor | null | undefined;
  authorize?: (activity: ScheduledActivity) => Promise<boolean>;
  callerContext?: WorkspaceContext;
}

/** An agent's write, which may also have to be allowed a native action. */
interface AgentUpdateWriter extends UpdateWriter {
  agentAuthor: PipelineAgentAuthor;
  /**
   * Whether the agent may write `action` as a native action, checked before
   * converting back: its own access, which the converted action didn't need.
   */
  authorizeNative?: (action: AutomationAction) => Promise<boolean>;
}

const PERSON_WRITER: UpdateWriter = PERSON;

/**
 * CAN-5782: a person's edit of a workflow schedule keeps its author, so an
 * agent-written schedule's runs stay agent-originated.
 */
const SCHEDULE_EDITOR: UpdateWriter = { agentAuthor: undefined };

export const OWNED_PIPELINE_SHARED =
  'Its workflow is shared by other schedules, so you edit it there.';

export const OWNED_PIPELINE_SHARED_FOR_AGENT =
  'This automation’s workflow is shared by other schedules. Edit that workflow with pipeline.update, or send the automation’s worktree_pipeline action.';

function writeUpdate(
  request: AutomationUpdateRequest,
  writer: UpdateWriter,
  service: AutomationsService,
  trusted: Omit<AutomationTrustedUpdate, 'agentAuthor'> = {},
): Promise<AutomationMutationResponse> {
  return service.update(request, writer.authorize, writer.callerContext, {
    ...trusted,
    agentAuthor: writer.agentAuthor,
  });
}

/**
 * The activity as the update would store it with chat action `action`: the
 * request's name, run restriction (so adding one keeps it native) and install
 * provenance, and the writer's agent author, which decide whether it converts.
 */
function editedActivity(
  request: AutomationUpdateRequest,
  stored: ScheduledActivity,
  action: AutomationAction,
  writer: UpdateWriter,
): ScheduledActivity {
  const targetRequirement =
    request.targetRequirement === undefined
      ? stored.targetRequirement
      : (request.targetRequirement ?? undefined);
  return {
    ...stored,
    name: request.name ?? stored.name,
    action,
    agentAuthor:
      writer.agentAuthor === undefined
        ? stored.agentAuthor
        : (writer.agentAuthor ?? undefined),
    targetRequirement,
    // An applied update replaces the provenance, as the update stores it.
    ...(request.installedFrom !== undefined
      ? { installedFrom: request.installedFrom }
      : {}),
  };
}

/** An update request and the trusted facts main writes it with. */
interface ConvertedBack {
  request: AutomationUpdateRequest;
  trusted: Omit<AutomationTrustedWrite, 'agentAuthor'>;
}

/**
 * A converted automation stored as its native chat action again: its run
 * restriction, which the conversion dropped, is the one the action implies,
 * unless the request sets its own (CAN-5479). Only main's restoration is
 * trusted past an install's guard; a request's own restriction isn't.
 */
function convertedBack(
  request: AutomationUpdateRequest,
  action: ChatAutomationAction,
): ConvertedBack {
  if (request.targetRequirement !== undefined)
    return { request: { ...request, action }, trusted: {} };
  return {
    request: {
      ...request,
      action,
      targetRequirement: impliedChatTargetRequirement(action),
    },
    trusted: { restoresImpliedTargetRequirement: true },
  };
}

/** The chat action an update request sends, if it sends one. */
function chatActionOf(
  action: AutomationAction | undefined,
): ChatAutomationAction | undefined {
  return action?.type === 'worktree_prompt' ||
    action?.type === 'standalone_prompt' ||
    action?.type === 'app_advisor_prompt' ||
    action?.type === 'worktree_session_prompt'
    ? action
    : undefined;
}

/**
 * Regenerates the owned pipeline for `edited` and stores the activity in one
 * queued write; `undefined` when `edited` doesn't convert.
 */
async function regenerateOwned(
  request: AutomationUpdateRequest,
  edited: ScheduledActivity,
  pipelineId: string,
  previous: PipelineData,
  writer: UpdateWriter,
  service: AutomationsService,
): Promise<AutomationMutationResponse | undefined> {
  if (!convertsToOwnedChatPipeline(edited)) return undefined;
  // The global pipeline's write never sees the chat's own target: check it
  // as the native save would, before anything is written.
  const targetRefusal = await service.nativeTargetRefusal(edited);
  if (targetRefusal) return { ok: false, error: targetRefusal };
  let action: AutomationAction;
  try {
    action = regeneratedOwnedChatAction(edited, pipelineId);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  // CAN-5465: the pipeline is saved inside the update, which refuses while a
  // run is in progress, so no run reads it with the inputs it replaces.
  return writeUpdate(
    {
      ...request,
      action,
      // The pipeline action takes no run restriction (CAN-5479).
      ...(request.targetRequirement ? { targetRequirement: null } : {}),
    },
    writer,
    service,
    {
      // The snapshot the hand-edit check read: a write since then fails the
      // save's revision check instead of being overwritten.
      regeneratesOwnedPipeline: () =>
        saveOwnedChatPipeline(edited, {
          pipelineId,
          previous,
          withholdGrant:
            writer.agentAuthor === undefined &&
            edited.agentAuthor !== undefined,
        }),
    },
  );
}

export const OWNED_PIPELINE_CHANGED =
  'Its workflow was changed since you opened it. Reopen the automation to see it.';

/**
 * Whether the workflow an automation owns, as read now, is still what its
 * chat action stands for. A workflow changed by hand, or one that can't be
 * read, is not, so a chat save must neither rebuild nor delete it.
 */
function ownedPipelineMatchesChat(
  stored: ScheduledActivity,
  current: PipelineData | undefined,
): boolean {
  const { action } = stored;
  return (
    action.type === 'worktree_pipeline' &&
    current !== undefined &&
    ownedPipelineToChatAction(
      current.content,
      action.inputs ?? {},
      isCoworkWorkspace,
      ownedChatPipelineState(action, action.pipelineId),
    ) !== null
  );
}

export async function updateAutomationFromForm(
  request: AutomationUpdateRequest,
  service: AutomationsService = getAutomationsService(),
): Promise<AutomationMutationResponse> {
  const stored = (await service.list()).activities.find(
    (entry) => entry.id === request.id,
  );
  const owned = stored ? ownedPipelineId(stored) : undefined;
  const activities = await service.allActivities();
  // CAN-5782: a chat action would regenerate the steps other schedules run.
  if (
    stored &&
    owned !== undefined &&
    chatActionOf(request.action) !== undefined &&
    isSharedByOtherSchedules(activities, stored, owned)
  )
    return { ok: false, error: OWNED_PIPELINE_SHARED };
  // CAN-5782: an owner leaving a pipeline other schedules run releases it
  // inside the update, once nothing can refuse it.
  const release =
    stored && owned !== undefined
      ? sharedPipelineRelease(activities, stored, owned, request.action)
      : undefined;
  // CAN-5782: a person's edit of a workflow schedule keeps its author.
  const scheduled = stored ? scheduledUserPipelineId(stored) : undefined;
  const writer =
    scheduled !== undefined && isWorkflowPagePipeline(activities, scheduled)
      ? SCHEDULE_EDITOR
      : PERSON_WRITER;
  const loaded =
    owned === undefined ? undefined : getStoredPipelineBySource('user', owned);
  const current = loaded?.success ? loaded.data : undefined;
  // The form sends the chat action it loaded. When the workflow has been
  // changed by hand since, saving it would overwrite or delete that work:
  // refuse, and send the windows a fresh snapshot to reopen.
  if (
    stored &&
    owned !== undefined &&
    request.action !== undefined &&
    request.action.type !== 'worktree_pipeline' &&
    !ownedPipelineMatchesChat(stored, current)
  ) {
    await service.republish();
    return { ok: false, error: OWNED_PIPELINE_CHANGED };
  }
  if (
    stored &&
    owned !== undefined &&
    current !== undefined &&
    request.action !== undefined
  ) {
    const regenerated = await regenerateOwned(
      request,
      editedActivity(request, stored, request.action, writer),
      owned,
      current,
      writer,
      service,
    );
    if (regenerated) return projected(regenerated, service);
  }
  // A chat action that no longer converts, for an automation that owns its
  // pipeline, converts it back.
  const chatBack =
    stored && owned !== undefined ? chatActionOf(request.action) : undefined;
  const back = chatBack ? convertedBack(request, chatBack) : undefined;
  const updated = await service.update(
    back ? back.request : request,
    undefined,
    undefined,
    {
      ...back?.trusted,
      agentAuthor: writer.agentAuthor,
      ...(release ? { releasesOwnedPipeline: release } : {}),
    },
  );
  if (!updated.ok || !updated.activity) return updated;
  // Converted back, or pointed at another pipeline: it no longer owns this one.
  // Delete the revision checked above; a write since then keeps the pipeline.
  if (
    stored &&
    owned !== undefined &&
    ownedPipelineId(updated.activity) !== owned
  )
    await deleteOwnedPipeline(stored, current?.info.revision ?? null);
  // Only an edit of the action converts; switching it on or off doesn't.
  if (
    request.action !== undefined &&
    ownedPipelineId(updated.activity) === undefined
  )
    return projected(await convertSaved(updated, service), service);
  return projected(updated, service);
}

/**
 * An agent's create (CAN-4551, 7c): stored as the native action, then
 * converted with the agent's marker on the automation and its pipeline, so
 * runs stay agent-originated (D11). An action whose runs D11 would refuse
 * doesn't convert, and keeps working natively.
 */
export async function createAutomationForAgent(
  request: AutomationCreateRequest,
  trusted: AutomationTrustedCreate,
  service: AutomationsService = getAutomationsService(),
): Promise<AutomationMutationResponse> {
  const created = await service.create(request, trusted);
  if (!created.ok || !created.activity) return created;
  if (!convertsToOwnedChatPipeline(created.activity)) return created;
  return convertSaved(created, service);
}

export const AUTOMATION_CHANGED_MEANWHILE =
  'This automation changed while it was being updated. Read it again with automation.get, then retry.';

export const OWNED_PIPELINE_HAND_EDITED =
  'This automation runs a workflow that was changed by hand. Edit that workflow with pipeline.update, or send the automation’s worktree_pipeline action.';

/**
 * An agent's update (CAN-4551, 7c). A native automation updates as before.
 * One that owns its pipeline is re-checked as agent-authored: while it still
 * converts, its pipeline is regenerated with the agent's marker; once D11
 * would refuse its runs, or the update changes the plugins, approval mode or
 * Orchestrator model its native grant keeps (CAN-5479), it converts back to
 * the native action and the pipeline is deleted. Its chat action is the one sent, else the one its pipeline stands
 * for, with the grant's settings in place of whatever a hand edit set.
 */
export async function updateAutomationForAgent(
  request: AutomationUpdateRequest,
  writer: AgentUpdateWriter,
  service: AutomationsService = getAutomationsService(),
): Promise<AutomationMutationResponse> {
  // What the agent may see: its caller's context, not the selected one.
  const snapshot = writer.callerContext
    ? await service.listForContext(writer.callerContext)
    : await service.list();
  const stored = snapshot.activities.find((entry) => entry.id === request.id);
  const owned = stored ? ownedPipelineId(stored) : undefined;
  if (
    !stored ||
    owned === undefined ||
    stored.action.type !== 'worktree_pipeline'
  )
    return writeUpdate(request, writer, service);
  // CAN-5782: while other schedules share the pipeline, a chat action would
  // regenerate the steps they run. An update without one is applied as sent,
  // never derived from the pipeline, so it rewrites nothing there.
  const activities = await service.allActivities();
  if (isSharedByOtherSchedules(activities, stored, owned)) {
    if (chatActionOf(request.action) !== undefined)
      return { ok: false, error: OWNED_PIPELINE_SHARED_FOR_AGENT };
    const release = sharedPipelineRelease(
      activities,
      stored,
      owned,
      request.action,
    );
    const updated = await writeUpdate(
      request,
      writer,
      service,
      release ? { releasesOwnedPipeline: release } : {},
    );
    if (
      updated.ok &&
      updated.activity &&
      ownedPipelineId(updated.activity) !== owned
    )
      await deleteOwnedPipeline(stored);
    return updated;
  }
  const loaded = getStoredPipelineBySource('user', owned);
  const current = loaded.success ? loaded.data : undefined;
  const sentChat =
    request.action !== undefined && request.action.type !== 'worktree_pipeline'
      ? request.action
      : undefined;
  // A chat action would overwrite or delete a workflow changed by hand.
  if (sentChat && !ownedPipelineMatchesChat(stored, current))
    return { ok: false, error: OWNED_PIPELINE_HAND_EDITED };
  const fromPipeline =
    current !== undefined
      ? ownedPipelineToChatAction(
          current.content,
          stored.action.inputs ?? {},
          isCoworkWorkspace,
          ownedChatPipelineState(stored.action, owned),
        )
      : null;
  // CAN-5479: the authority the automation has, which an agent's write
  // keeps: its native grant's, never what a hand edit put in its pipeline.
  const authority =
    fromPipeline === null
      ? undefined
      : ownedPipelineAuthority(
          stored.id,
          readPipelineLocalMetadata({
            type: 'stored',
            source: 'user',
            value: owned,
          }),
          fromPipeline,
        );
  const chat =
    sentChat ??
    (request.action === undefined && fromPipeline !== null
      ? withNativeGrantAuthority(fromPipeline, authority)
      : undefined);
  if (chat === undefined || current === undefined) {
    // A pipeline action, or a workflow changed by hand: updated as sent.
    const updated = await writeUpdate(request, writer, service);
    if (
      updated.ok &&
      updated.activity &&
      ownedPipelineId(updated.activity) !== owned
    )
      await deleteOwnedPipeline(stored, current?.info.revision ?? null);
    return updated;
  }
  // A chat action read from the workflow stands for the action read above;
  // a write since then must not be overwritten with it.
  let changedMeanwhile = false;
  const guarded: UpdateWriter = sentChat
    ? writer
    : {
        ...writer,
        authorize: async (fresh: ScheduledActivity): Promise<boolean> => {
          if (!isDeepStrictEqual(fresh.action, stored.action)) {
            changedMeanwhile = true;
            return false;
          }
          return writer.authorize ? writer.authorize(fresh) : true;
        },
      };
  const changed = (
    response: AutomationMutationResponse,
  ): AutomationMutationResponse =>
    changedMeanwhile
      ? { ok: false, error: AUTOMATION_CHANGED_MEANWHILE }
      : response;
  const edited = editedActivity(request, stored, chat, writer);
  // Its grant is re-minted for the new revision only with the authority it
  // had; an agent's change of authority stays a native action's (CAN-5479).
  const regenerated = sameNativeGrantAuthority(
    nativeGrantAuthority(chat),
    authority,
  )
    ? await regenerateOwned(request, edited, owned, current, guarded, service)
    : undefined;
  if (regenerated) return changed(regenerated);
  // D11 would refuse its converted runs, or its authority changed: back to
  // the native action, if the agent may write that, checked inside the
  // queued write.
  const { authorizeNative } = writer;
  const nativeWriter: UpdateWriter = authorizeNative
    ? {
        ...guarded,
        authorize: async (fresh: ScheduledActivity): Promise<boolean> =>
          (guarded.authorize ? await guarded.authorize(fresh) : true) &&
          authorizeNative(chat),
      }
    : guarded;
  const chatBack = chatActionOf(chat);
  const back = chatBack ? convertedBack(request, chatBack) : undefined;
  const updated = await writeUpdate(
    back ? back.request : { ...request, action: chat },
    nativeWriter,
    service,
    back?.trusted,
  );
  if (
    updated.ok &&
    updated.activity &&
    ownedPipelineId(updated.activity) !== owned
  )
    await deleteOwnedPipeline(stored, current.info.revision ?? null);
  return changed(updated);
}
