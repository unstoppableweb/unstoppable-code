/**
 * Chat automation conversion in main (CAN-4551, step 7a): saves the
 * automation's owned pipeline through core, then rewrites the automation's
 * action to run it. Nothing calls it yet; the Start chat card (7b) and agent
 * creation (7c) will.
 */
import { isDeepStrictEqual } from 'node:util';
import {
  PIPELINE_GRANTS,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import { serializeWorkspaceContext } from '@canopy/protocol/workspace-context';
import type {
  SharedAutomationTargetRequirement,
  TargetContext,
} from '@canopy/protocol/automations';
import {
  chatAutomationToPipeline,
  chatAutomationTriggers,
  type ChatAutomationTrigger,
  convertibleChatAutomation,
  type ChatAutomationAction,
  type ChatAutomationConversionRefusal,
} from '@canopy/desktop-shared/lib/chat-automation-conversion';
import type {
  Pipeline,
  PipelineData,
  PipelinePluginCollectionPreference,
  PipelinePreferenceLocator,
} from '@canopy/execution-engine/types/pipeline';
import {
  deletePipelinePluginCollectionPreferences,
  loadPipelinePluginCollectionPreferences,
  savePipelinePluginCollectionPreferences,
} from '@canopy/execution-engine/node/pipelines/plugin-collection-store';
import {
  APP_ADVISOR_PROJECT_ID,
  type AutomationAction,
  type AutomationMutationResponse,
  type ScheduledActivity,
} from '@canopy/desktop-shared/types';
import { isBotProjectId } from '@canopy/protocol/chat-targets';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../canopy-runtime/desktop-runtime-identity';
import { resolveCoworkWorkspaceId } from '../lib/cowork-migration-map';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { isCoworkWorkspace } from '../lib/workspace-registry';
import {
  readPipelineLocalMetadata,
  recordUserPipelineOwner,
  setUserPipelineAgentAuthorIfCurrent,
  withCurrentUserPipelineRevision,
  setUserPipelineChatPluginDefaults,
  setUserPipelineNativeGrant,
  setUserPipelineOwnerAutomation,
  type PipelineNativeGrant,
} from '../pipelines/pipeline-local-metadata-store';
import { getStoredPipelineBySource } from '../pipelines/pipeline-service';
import {
  restorePersonApproval,
  stampPersonApproval,
} from '../pipelines/pipeline-person-approval';
import { withPipelineScheduleGuard } from '../pipelines/pipeline-schedule-guard';
import { automationSendCaller } from './automation-send';
import { chatPluginPortability } from './chat-plugin-portability';
import {
  nativeGrantAuthority,
  nativeGrantContentHash,
} from './chat-automation-native-grant';

/**
 * Why {@link saveOwnedChatPipeline} refused or failed, as a fixed code
 * (CAN-5479): the shared converter's refusal, a run restriction the action
 * doesn't imply, the pipeline save, or a record the save had to keep.
 */
export type OwnedChatConversionFailure =
  | OwnedChatConversionRefusal
  | 'pipeline_save'
  | 'owner_not_recorded'
  | 'settings_not_recorded'
  | 'plugins_not_recorded';

/** A conversion {@link saveOwnedChatPipeline} refused or that failed. */
export class OwnedChatConversionError extends Error {
  readonly reason: OwnedChatConversionFailure;

  constructor(reason: OwnedChatConversionFailure, message: string) {
    super(message);
    this.name = 'OwnedChatConversionError';
    this.reason = reason;
  }
}

/** Electron main writing an automation's own pipeline. */
export const AUTOMATION_PIPELINE_CALLER: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'electron-main-automations',
  authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
  interfaceKind: 'desktop',
  grants: [PIPELINE_GRANTS.write],
};

/** The project a chat action reaches, for its owner. */
function actionTarget(action: ChatAutomationAction): {
  projectId: string;
  worktreeId?: string;
} {
  switch (action.type) {
    case 'worktree_prompt':
      return { projectId: action.workspaceId };
    case 'standalone_prompt':
      return { projectId: action.chatProjectId };
    case 'app_advisor_prompt':
      return { projectId: APP_ADVISOR_PROJECT_ID };
    case 'worktree_session_prompt':
      return { projectId: action.workspaceId, worktreeId: action.worktreeId };
  }
}

/** The single target context a chat action runs in. */
function impliedTargetContext(action: ChatAutomationAction): TargetContext {
  switch (action.type) {
    case 'worktree_prompt':
      return 'worktree';
    case 'standalone_prompt':
      return 'cowork';
    case 'app_advisor_prompt':
      return 'app_advisor';
    case 'worktree_session_prompt':
      return isBotProjectId(action.workspaceId)
        ? 'app_advisor'
        : isCoworkWorkspace(action.workspaceId)
          ? 'cowork'
          : 'worktree';
  }
}

/**
 * The run restriction a chat action implies (CAN-5479). A valid restriction
 * is never wider than this, so a converted automation, whose global pipeline
 * can't carry one, drops it, and converting back restores it.
 */
export function impliedChatTargetRequirement(
  action: ChatAutomationAction,
): SharedAutomationTargetRequirement {
  return { contexts: [impliedTargetContext(action)] };
}

/** Why an activity stays native rather than converting (CAN-5479). */
export type OwnedChatConversionRefusal =
  | ChatAutomationConversionRefusal
  | 'target_requirement';

/**
 * Why the activity doesn't convert, or undefined when it does: the shared
 * converter's refusal, or `target_requirement` for a run restriction other
 * than the one its action implies. Any other restriction already fails the
 * native run, so that automation stays native.
 */
export function ownedChatConversionRefusal(
  activity: ScheduledActivity,
): OwnedChatConversionRefusal | undefined {
  const { action, targetRequirement } = activity;
  const verdict = convertibleChatAutomation(activity);
  if (!verdict.convertible) return verdict.reason;
  if (targetRequirement === undefined) return undefined;
  if (
    action.type !== 'worktree_prompt' &&
    action.type !== 'standalone_prompt' &&
    action.type !== 'app_advisor_prompt' &&
    action.type !== 'worktree_session_prompt'
  )
    return 'not_a_chat_action';
  const [context, ...rest] = targetRequirement.contexts;
  return rest.length === 0 && context === impliedTargetContext(action)
    ? undefined
    : 'target_requirement';
}

/**
 * Whether the activity converts: the shared converter accepts it, and any run
 * restriction is exactly the one its action implies.
 */
export function convertsToOwnedChatPipeline(
  activity: ScheduledActivity,
): boolean {
  return ownedChatConversionRefusal(activity) === undefined;
}

/**
 * The owner the native action sent as: the automation's bound context, or
 * its target project's saved owner (Personal for the Orchestrator).
 */
async function conversionOwner(
  activity: ScheduledActivity,
  action: ChatAutomationAction,
): Promise<string> {
  const caller = await automationSendCaller(activity, actionTarget(action));
  return serializeWorkspaceContext(caller.source.owner);
}

/**
 * What the service applies once the owned pipeline is saved. The automation
 * drops its run restriction, which a global pipeline can't carry and which
 * the save checked is the one its chat action implies.
 */
export interface OwnedPipelineReplacement {
  action: AutomationAction;
  /** The owner a global pipeline automation runs as. */
  executionContext: string;
  /** Deletes the saved pipeline when the rewrite fails. */
  rollback: () => Promise<void>;
}

/** An owned pipeline a save rewrites in place, as it was loaded. */
export interface OwnedPipelineInPlace {
  pipelineId: string;
  previous: PipelineData;
  /**
   * CAN-5782: a person's revision of a schedule an agent wrote, which keeps
   * the agent author: no grant is minted, so a person's revision never
   * carries an agent's grant.
   */
  withholdGrant?: boolean;
}

/**
 * The activity with a legacy chat project ID as the Cowork workspace the
 * native send resolves it to; the generated steps look the project up exactly.
 */
function withResolvedCoworkProject(
  activity: ScheduledActivity,
): ScheduledActivity {
  const { action } = activity;
  if (action.type !== 'standalone_prompt') return activity;
  const chatProjectId = resolveCoworkWorkspaceId(action.chatProjectId);
  return chatProjectId === action.chatProjectId
    ? activity
    : { ...activity, action: { ...action, chatProjectId } };
}

/**
 * The stored pipeline's content, if it is still at `revision`; a read that
 * fails is no content, so no grant is minted from it.
 */
function storedRevisionContent(
  pipelineId: string,
  revision: number | undefined,
): { revision: number; content: Pipeline } | undefined {
  if (revision === undefined) return undefined;
  try {
    const stored = getStoredPipelineBySource('user', pipelineId);
    return stored.success &&
      stored.data &&
      stored.data.info.revision === revision
      ? { revision, content: stored.data.content }
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The grant a rollback puts back (CAN-5479): one that held for the content
 * it restores holds for that content's new revision; any other stays as it
 * was, so a stale grant stays stale.
 */
function restoredGrant(
  previous: PipelineNativeGrant | undefined,
  loadedRevision: number | undefined,
  restoredRevision: number | undefined,
  pipelineId: string,
): PipelineNativeGrant | null {
  if (previous === undefined) return null;
  if (previous.pipelineRevision !== loadedRevision) return previous;
  const restored = storedRevisionContent(pipelineId, restoredRevision);
  return restored !== undefined &&
    nativeGrantContentHash(restored.content) === previous.contentHash
    ? { ...previous, pipelineRevision: restored.revision }
    : previous;
}

type ChatAutomationPipeline = ReturnType<typeof chatAutomationToPipeline>;

/** The action that runs `pipeline` as the owned pipeline `pipelineId`. */
function ownedPipelineAction(
  pipelineId: string,
  { pipeline, inputs, modelAliasPreferences }: ChatAutomationPipeline,
): AutomationAction {
  return {
    type: 'worktree_pipeline',
    target: { kind: 'global' },
    pipelineId,
    pipelineSource: 'user',
    pipelineName: pipeline.name,
    inputs,
    // An Agent runs through the pipeline's model alias. Plugin selections
    // are the pipeline's own: its defaults, and its preferences on this
    // machine (CAN-5479).
    ...(modelAliasPreferences ? { modelAliasPreferences } : {}),
  };
}

function userPipelineLocator(pipelineId: string): PipelinePreferenceLocator {
  return { type: 'stored', source: 'user', value: pipelineId };
}

/**
 * Replaces the pipeline's plugin collection preferences on this machine
 * with `preferences`; none deletes them.
 */
async function writePluginPreferences(
  pipelineId: string,
  preferences: Record<string, PipelinePluginCollectionPreference> | undefined,
): Promise<void> {
  const locator = userPipelineLocator(pipelineId);
  if (preferences !== undefined && Object.keys(preferences).length > 0) {
    await savePipelinePluginCollectionPreferences(
      locator,
      preferences,
      'electron_main',
    );
    return;
  }
  if (Object.keys(loadPipelinePluginCollectionPreferences(locator)).length > 0)
    await deletePipelinePluginCollectionPreferences(locator, 'electron_main');
}

/**
 * The action a regenerated owned pipeline `pipelineId` runs `stored` with,
 * what its in-place save answers (CAN-5465). Throws for an activity that
 * can't convert.
 */
export function regeneratedOwnedChatAction(
  stored: ScheduledActivity,
  pipelineId: string,
): AutomationAction {
  return ownedPipelineAction(
    pipelineId,
    chatAutomationToPipeline(withResolvedCoworkProject(stored)),
  );
}

/** What an installed copy's new pipeline declares: Manual alone (CAN-5782). */
const INSTALLED_COPY_TRIGGERS: readonly ChatAutomationTrigger[] = ['dispatch'];

/**
 * Saves the activity's owned pipeline and returns the action that runs it:
 * a new pipeline, or `inPlace` the one it already owns, against the revision
 * that was loaded so a concurrent edit is never overwritten. Throws, changing
 * nothing, for an activity that can't convert.
 *
 * CAN-5782: an in-place save holds the pipeline's schedule guard through its
 * write and its approval stamp; a person's save (an activity with no agent
 * author) stamps the content it committed.
 */
export function saveOwnedChatPipeline(
  stored: ScheduledActivity,
  inPlace?: OwnedPipelineInPlace,
): Promise<OwnedPipelineReplacement> {
  return inPlace
    ? withPipelineScheduleGuard(inPlace.pipelineId, () =>
        saveOwnedChatPipelineUnguarded(stored, inPlace),
      )
    : saveOwnedChatPipelineUnguarded(stored);
}

async function saveOwnedChatPipelineUnguarded(
  stored: ScheduledActivity,
  inPlace?: OwnedPipelineInPlace,
): Promise<OwnedPipelineReplacement> {
  const activity = withResolvedCoworkProject(stored);
  const verdict = convertibleChatAutomation(activity);
  if (!verdict.convertible)
    throw new OwnedChatConversionError(
      verdict.reason,
      `This automation can't convert (${verdict.reason}).`,
    );
  if (!convertsToOwnedChatPipeline(activity))
    throw new OwnedChatConversionError(
      'target_requirement',
      "This automation can't convert (target_requirement).",
    );
  const { action } = activity;
  if (
    action.type !== 'worktree_prompt' &&
    action.type !== 'standalone_prompt' &&
    action.type !== 'app_advisor_prompt' &&
    action.type !== 'worktree_session_prompt'
  )
    throw new OwnedChatConversionError(
      'not_a_chat_action',
      "This automation can't convert (not_a_chat_action).",
    );
  // CAN-5479: the selections that travel are the pipeline's defaults.
  // CAN-5782: an in-place save keeps the stored Workflow and Manual
  // triggers exactly, so a person's choice survives every chat edit. A new
  // pipeline declares both, except an installed copy, which stays Manual
  // until a person turns Workflow on.
  const triggers = inPlace
    ? chatAutomationTriggers(inPlace.previous.content)
    : activity.installedFrom !== undefined
      ? INSTALLED_COPY_TRIGGERS
      : undefined;
  const converted = chatAutomationToPipeline(activity, {
    portable: await chatPluginPortability(action.pluginSelections),
    ...(triggers !== undefined ? { triggers } : {}),
  });
  const { pipeline } = converted;
  const owner = await conversionOwner(activity, action);
  // CAN-5479: the settings its runs keep, which D11 would refuse an agent's.
  const authority = nativeGrantAuthority(action);
  // What a rollback of an in-place save puts back besides the content: the
  // owner, the agent author, whose runs keep their admission (D11), the
  // native grant, and a person's approval (CAN-5782).
  const previousMetadata = inPlace
    ? readPipelineLocalMetadata(userPipelineLocator(inPlace.pipelineId))
    : undefined;
  // And its plugin preferences on this machine (CAN-5479).
  const previousPreferences = inPlace
    ? loadPipelinePluginCollectionPreferences(
        userPipelineLocator(inPlace.pipelineId),
      )
    : undefined;
  const { saveUserPipeline, deleteUserPipeline } =
    await import('../canopy-runtime/pipeline-definition-dispatch');
  const saved = await saveUserPipeline(
    {
      ...(inPlace
        ? {
            id: inPlace.pipelineId,
            expectedRevision: inPlace.previous.info.revision ?? 0,
          }
        : {}),
      name: pipeline.name,
      description: '',
      icon: '',
      content: pipeline,
      ...(inPlace
        ? {}
        : { owner: { owner, agentAuthor: activity.agentAuthor ?? null } }),
    },
    AUTOMATION_PIPELINE_CALLER,
    inPlace || activity.agentAuthor
      ? { author: activity.agentAuthor ?? null, owner }
      : undefined,
  );
  if (!saved.success || !saved.data)
    throw new OwnedChatConversionError(
      saved.markerRefused ? 'owner_not_recorded' : 'pipeline_save',
      saved.error ?? 'The workflow could not be saved.',
    );
  const pipelineId = saved.data.id;
  const savedRevision = saved.data.revision;
  const restoreUnderGuard = async (): Promise<void> => {
    if (!inPlace) {
      const removed = await deleteUserPipeline(
        pipelineId,
        savedRevision,
        AUTOMATION_PIPELINE_CALLER,
      );
      if (!removed.success && !removed.revisionRefused)
        throw new Error(removed.error ?? 'The workflow could not be removed.');
      return;
    }
    const { info, content, rawContent } = inPlace.previous;
    const previousAuthor = previousMetadata?.agentAuthor;
    const restored = await saveUserPipeline(
      {
        id: pipelineId,
        expectedRevision: savedRevision,
        name: info.name,
        description: info.description ?? '',
        icon: info.icon ?? '',
        content,
        rawContent,
      },
      AUTOMATION_PIPELINE_CALLER,
      previousAuthor || previousMetadata?.markerWritePending
        ? {
            author: previousAuthor ?? null,
            owner: previousMetadata?.owner,
            ...(previousMetadata?.markerWritePending && {
              preservePending: true,
            }),
          }
        : undefined,
    );
    if (restored.revisionRefused) return;
    if (!restored.success || !restored.data)
      throw new Error(
        restored.error ?? 'The previous workflow could not be restored.',
      );
    const revision = restored.data.revision;
    const metadata = withCurrentUserPipelineRevision(
      pipelineId,
      revision,
      () => {
        if (
          previousAuthor === undefined &&
          !previousMetadata?.markerWritePending
        ) {
          const cleared = setUserPipelineAgentAuthorIfCurrent(
            pipelineId,
            null,
            { revision },
          );
          if (cleared !== 'written' && cleared !== 'unchanged') return false;
        }
        if (previousMetadata?.owner !== undefined)
          recordUserPipelineOwner(pipelineId, previousMetadata.owner);
        setUserPipelineNativeGrant(
          pipelineId,
          restoredGrant(
            previousMetadata?.nativeGrant,
            info.revision,
            revision,
            pipelineId,
          ),
        );
        setUserPipelineChatPluginDefaults(
          pipelineId,
          previousMetadata?.chatPluginDefaults ?? null,
        );
        return true;
      },
    );
    if (metadata === 'newer_revision') return;
    if (metadata !== true)
      throw new Error(
        'The previous workflow’s settings could not be restored.',
      );
    // The previous approval, which a failed edit must not stop the schedule
    // for, on the same compare-and-set as the stamp it replaces.
    await restorePersonApproval(
      pipelineId,
      previousMetadata?.personApprovedDigest,
      restored.data?.revision,
    );
    try {
      await writePluginPreferences(pipelineId, previousPreferences);
    } catch (error) {
      logMainProcessWarn('Could not restore a workflow’s plugin preferences', {
        operation: 'restore-owned-pipeline',
        errorType: error instanceof Error ? error.name : typeof error,
      });
    }
  };
  // A rollback the caller runs later holds the guard as the save did.
  const rollback = (): Promise<void> =>
    withPipelineScheduleGuard(pipelineId, restoreUnderGuard);
  try {
    // The grant names the revision this save wrote and its content as
    // stored; a write since then is not the automation's. A person's
    // automation records it too, as the authority an agent's later update
    // must keep; an agent's can't run as its native action did without it.
    let grant: PipelineNativeGrant | null = null;
    if (authority !== undefined && inPlace?.withholdGrant !== true) {
      const written = storedRevisionContent(pipelineId, savedRevision);
      if (written === undefined && activity.agentAuthor !== undefined)
        throw new OwnedChatConversionError(
          'settings_not_recorded',
          'The workflow’s settings could not be recorded.',
        );
      if (written !== undefined)
        grant = {
          automationId: activity.id,
          pipelineRevision: written.revision,
          contentHash: nativeGrantContentHash(written.content),
          ...authority,
        };
    }
    const metadata = withCurrentUserPipelineRevision(
      pipelineId,
      savedRevision,
      () => {
        if (!inPlace && activity.agentAuthor === undefined) {
          const cleared = setUserPipelineAgentAuthorIfCurrent(
            pipelineId,
            null,
            { revision: savedRevision },
          );
          if (cleared !== 'written' && cleared !== 'unchanged') return false;
        }
        recordUserPipelineOwner(pipelineId, owner);
        setUserPipelineOwnerAutomation(pipelineId, activity.id);
        setUserPipelineNativeGrant(pipelineId, grant);
        setUserPipelineChatPluginDefaults(
          pipelineId,
          converted.pluginDefaults ?? null,
        );
        return true;
      },
    );
    if (metadata !== true)
      throw new OwnedChatConversionError(
        'owner_not_recorded',
        'The workflow’s owner could not be recorded.',
      );
    // The selections that don't travel, as the pipeline's own preferences.
    await writePluginPreferences(
      pipelineId,
      converted.pluginCollectionPreferences,
    );
    // The store logs a failed write instead of throwing; without the marker
    // the automation's delete could never find its pipeline.
    const recorded = readPipelineLocalMetadata(userPipelineLocator(pipelineId));
    if (
      recorded.owner !== owner ||
      recorded.ownerAutomationId !== activity.id ||
      (activity.agentAuthor !== undefined && recorded.agentAuthor === undefined)
    )
      throw new OwnedChatConversionError(
        'owner_not_recorded',
        'The workflow’s owner could not be recorded.',
      );
    // Without its grant an agent's run would be refused what the native
    // action ran with; a stale one would keep authority the action dropped.
    if (!isDeepStrictEqual(recorded.nativeGrant ?? null, grant))
      throw new OwnedChatConversionError(
        'settings_not_recorded',
        'The workflow’s settings could not be recorded.',
      );
    // Without them converting back would take the pipeline as hand edited.
    if (
      !isDeepStrictEqual(
        recorded.chatPluginDefaults ?? null,
        converted.pluginDefaults ?? null,
      )
    )
      throw new OwnedChatConversionError(
        'plugins_not_recorded',
        'The workflow’s plugins could not be recorded.',
      );
    // CAN-5782: a person's save is their approval of the content it
    // committed. A skipped stamp leaves the previous digest, which doesn't
    // match this content, so the save itself still stands.
    if (activity.agentAuthor === undefined && savedRevision !== undefined)
      await withPipelineScheduleGuard(pipelineId, () =>
        stampPersonApproval(pipelineId, savedRevision),
      );
  } catch (error) {
    try {
      await rollback();
    } catch (rollbackError) {
      // The conversion's own error stays first; the caller learns that the
      // previous workflow did not come back (the cause is only logged).
      logMainProcessWarn('Could not restore the previous workflow', {
        operation: 'restore-owned-pipeline',
        pipelineId,
        errorType:
          rollbackError instanceof Error
            ? rollbackError.name
            : typeof rollbackError,
      });
      const message = error instanceof Error ? error.message : String(error);
      const reported = `${message} and the previous workflow could not be restored`;
      throw error instanceof OwnedChatConversionError
        ? new OwnedChatConversionError(error.reason, reported)
        : new Error(reported);
    }
    throw error;
  }
  return {
    action: ownedPipelineAction(pipelineId, converted),
    executionContext: owner,
    rollback,
  };
}

/**
 * Converts a chat automation into a `worktree_pipeline` automation that runs
 * a pipeline it owns. The automation keeps its ID, name, trigger, gate
 * command, enabled state and agent author, so its run history, calendar
 * entries and watchers stay with it.
 */
export async function convertChatAutomation(
  activityId: string,
): Promise<AutomationMutationResponse> {
  const { getAutomationsService } = await import('./service');
  const converted = await getAutomationsService().replaceWithOwnedPipeline(
    activityId,
    saveOwnedChatPipeline,
  );
  // The failure stage is main's own; the response keeps its public shape.
  return converted.ok ? converted : { ok: false, error: converted.error };
}
