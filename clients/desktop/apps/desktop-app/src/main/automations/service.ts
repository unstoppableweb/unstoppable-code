import {
  assertCoworkChatRootPresent,
  assertCoworkWorkspaceRootPresent,
} from '../lib/cowork-folder-guard';
import { isDeepStrictEqual } from 'node:util';
import { parsePipelineText } from '@canopy/execution-engine/pipelines/parse-pipeline';
import { ownedPipelineToChatAction } from '@canopy/desktop-shared/lib/chat-automation-conversion';
import { isCoworkWorkspace } from '../lib/workspace-registry';
import { getSharedPipelineForExecutionContext } from '../pipelines/canopy-server-client';
import { readChatTabsFile } from '../lib/chat-tabs-reader';
import { loadExecutionState } from '@canopy/execution-engine/node/pipelines/executor';
import type { ChildPipelineAuthorization } from '@canopy/execution-engine/node/pipelines/executor/child-pipeline-resolver';
import {
  backgroundExecutionDeniedMessage,
  backgroundExecutionRetryMessage,
  backgroundExecutionUnavailableMessage,
  pipelineContextResources,
  localPipelineContextResources,
} from '@canopy/desktop-shared/node/background-execution-context';
import type { ResourceContextDecision } from '@canopy/execution-engine/lib/resource-context-policy';
import {
  resourceContextEnabled,
  resourceContextSnapshot,
  assertResourceContextSnapshot,
  assertResourceContext,
  assertResourceContextForContext,
  resourceAccountSnapshot,
  assertResourceAccountSnapshot,
} from '../lib/resource-context';
import { ResourceContextUnavailableError } from '../lib/resource-context-error';
import {
  assertInstalledResourceContext,
  recordResourceInstall,
} from '../lib/resource-install-context';
import { getSharedAutomation } from './canopy-server-client';
import {
  recordSharedItemInstall,
  recordSharedItemUninstall,
} from '../canopy-cloud/shared-item-subscriptions';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { BrowserWindow } from 'electron';
import { BRAND } from '@canopy/brand/current';
import {
  getExecutionHarnessForModel,
  getModelSource,
  isInheritingAgentModel,
  IPC_CHANNELS,
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
  STANDALONE_CHAT_PROJECT_ID,
  COWORK_HOME_WORKTREE_ID,
  WORKSPACE_ROOT_REPO_ID,
  hasAnySelections,
  resolveKnownModel,
  resolveProviderModelConfig,
  requireProviderForModel,
  type AgentScheduledSend,
  type AgentModelConfig,
  type AgentProviderType,
  type AppAdvisorWindowCommand,
  type AppAdvisorWindowOpenRequest,
  type AppAdvisorWindowState,
  type AutomationAction,
  type ApproveAutomationSharedPipelineReviewRequest,
  type ApproveAutomationSharedPipelineReviewResponse,
  type AutomationCreateRequest,
  type AutomationCancelRunRequest,
  type AutomationDeleteRequest,
  type AutomationIfCommandIdempotencyScope,
  type AutomationMutationResponse,
  type AutomationRunHistoryRequest,
  type AutomationRunHistoryResponse,
  type AutomationRunTrigger,
  type AutomationTrigger,
  type AutomationRemoteMetadata,
  type AutomationRunNowRequest,
  type AutomationSkipReason,
  type AutomationUpdateRequest,
  type AutomationsListResponse,
  type ChatProjectData,
  type ChatModel,
  type ModelDefaultsByProvider,
  type PreferencesData,
  type ChatTabPluginSelections,
  type ThinkingLevel,
  type ScheduledActivity,
  type ScheduledActivityRun,
  type SidebarItem,
  type WorktreeGitFailedEvent,
} from '@canopy/desktop-shared/types';
import type { PipelineShareInstallPin } from '@canopy/protocol/pipelines';
import type { PortalChatScheduledMessages } from '@canopy/protocol/portal';
import type {
  PipelineSchedule,
  PipelineScheduleUpdateParams,
} from '@canopy/protocol/canopy-core';
import {
  isAutomationExecutionLocation,
  projectKindToTargetContext,
  validateSharedAutomationTargetRequirement,
} from '@canopy/protocol/automations';
import type { SidebarItemGroupScope } from '@canopy/protocol/sidebar';
import {
  automationTargetBindingChanged,
  automationTargetMismatchMessage,
  resolveLocalAutomationTargetRequirement,
} from '@canopy/desktop-shared/lib/automation-target';
import {
  isGlobalPipelineAutomationAction,
  pipelineAutomationTaskId,
  pipelineAutomationWorkspaceId,
  resolveAutomationPipelineTarget,
  PIPELINE_TARGET_NEW_WORKTREE_COWORK_ERROR,
  PIPELINE_TARGET_OWNER_MISMATCH_ERROR,
  PIPELINE_TARGET_PROJECT_ROOT_REQUIRED_ERROR,
  PIPELINE_TARGET_REQUIREMENT_GLOBAL_ERROR,
  PIPELINE_TARGET_TASK_MISSING_ERROR,
  type PipelineAutomationAction,
  type ResolvedAutomationPipelineTarget,
} from '@canopy/desktop-shared/lib/automation-pipeline-target';
import {
  resolveAppAdvisorDefaultModel,
  resolveOptionalLaneAwareDefaultSelection,
  type LaneCredentialScope,
} from '../lib/default-model-lane-resolver';
import { resolveCoworkWorkspaceId } from '../lib/cowork-migration-map';
import { getTriggerTypes } from '@canopy/execution-engine/types/pipeline';
import { getPersistedClaudeChatInterfaceMode } from '../lib/claude-tui-chats';
import {
  getNextCronRun,
  getNextAutomationTriggerRun,
  interpolateAutomationActionIfCommandOutput,
  parseAutomationIfCommandOutput,
  normalizeAutomationDependencies,
  normalizeAutomationSharedPipelineReview,
  automationPipelineSpeedError,
  validateAutomationAction,
  validateAutomationActionForWrite,
  validateAutomationCreateRequest,
  validateAutomationDependencies,
  validateAutomationIfCommand,
  validateAutomationSharedPipelineReview,
  validateAutomationTrigger,
} from '@canopy/desktop-shared/lib/automations';
import {
  accountMayRunIn,
  authorizeBackgroundExecution,
  automationActionDestination,
  backgroundExecutionContextEnabled,
  automationBindingContext,
  automationContextRefusal,
  captureBackgroundExecutionContext,
  describeAutomationContextMismatch,
  backgroundDestinationWorkspaceId,
  persistedPipelineContextResources,
  resolveMovedTargetOwnershipChange,
} from '../services/background-execution-context';
import {
  parseWorkspaceContext,
  serializeWorkspaceContext,
  type WorkspaceContext,
} from '@canopy/protocol/workspace-context';
import { runAutomationIfCommand } from './if-command-runner';
import {
  CLOUD_SCHEDULE_MESSAGES,
  CloudScheduleRemoteError,
  cachedCloudRecord,
  cloudScheduleRecordCache,
  UNAVAILABLE_CLOUD_SCHEDULE_REMOTE,
  cloudScheduleDestination,
  cloudScheduleTrigger,
  cloudScheduleWorkflow,
  firesLocally,
  hostTimeZone,
  isCloudScheduleStub,
  localRecordFromCloud,
  normalizePersistedLocation,
  type CloudScheduleRemote,
} from './cloud-schedules';
import { decideIfCommandGate } from './if-command-gate';
import {
  automationDefinitionResource,
  isContextOwnedInstall,
  publicInstallOwner,
} from './activity-owner';
import { getAutomationRunArchive } from './run-archive';
import {
  getDataDir,
  getAutomationsFilePath,
  getChatProjectsFilePath,
} from '../lib/paths';
import { logMainProcessError } from '../lib/main-process-logging';
import { isCursorRuntimeAvailable } from '../cursor/runtime-availability';
import { rebindAgentSenderRequest } from '../agent-messaging/sender-context';
import {
  AUTOMATION_WORK_ENTRY_UNAVAILABLE_MESSAGE,
  automationSendCaller,
  automationSendIds,
  dispatchAutomationAction,
  dispatchAutomationCreation,
  staysNativeAutomationSend,
} from './automation-send';
import { APP_ADVISOR_BOT_ID } from '@canopy/desktop-shared/lib/bot-discovery';
import {
  resolveAutomationApprovalMode,
  resolveAutomationPromptPlugins,
  resolveChatTurnOverride,
  selectedTurnHarness,
  withPromptPluginSelections,
  type ExistingTabDispatchOptions,
} from '../agent-messaging/turn-override';
import {
  assertOpenCodeConnectionGeneration,
  getOpenCodeConnectionGeneration,
} from '../opencode/connection';
import { sidebarItemGroupsService } from '../services/sidebar-item-groups-service';
import {
  assertTerminalChatAcceptsSettings,
  buildExistingTabDispatchOptions,
  ExistingTabDispatchTargetNotFoundError,
  sendWorktreeChatMessage,
} from '../services/chat-service';
import {
  archiveMultiRepoWorktree,
  archiveSingleRepoWorktree,
  createMultiRepoWorktree,
  createSingleRepoWorktree,
} from '../lib/worktree-service';
import { readAllSidebarItems } from '../lib/sidebar-items';
import { readWorkspaceWorktreesDetailed } from '../lib/workspace-persistence';
import { resolveWorkspaceReferenceRepoPath } from '../lib/workspace-reference-repo';
import { sendToWindow } from '../lib/window-send';
import { reserveWorkspaceTargetRuntimeStart } from '../lib/workspace-target-exclusion';
import {
  getCoworkWorkspaceRootDir,
  getWorkspaceWorktreeRepoDir,
  getWorkspaceWorktreeRootRepoDir,
} from '../lib/paths';
import {
  executionContextSatisfies,
  normalizePipelineScopes,
} from '@canopy/execution-engine/pipelines/scope';
import {
  discoverProjectPipelines,
  loadProjectPipelineFromDisk,
} from '../pipelines/project-pipeline-discovery';
import { startPipelineExecutionFromMain } from '../pipelines/pipeline-handlers';
import {
  getUserPipelineOwner,
  validatePipelineOwnerTargetsOnSave,
} from '../pipelines/pipeline-owner-policy';
import { isPipelineLocalMetadataReadable } from '../pipelines/pipeline-local-metadata-store';
import { listWorkEntryIds } from '../lib/cowork-work-entries';
import type { AppAdvisorToolRuntimeSurfaces } from '../app-advisor/runtime';
import { normalizePipelinePluginCollectionPreferences } from '@canopy/execution-engine/node/pipelines/plugin-collection-store';
import { resumePipelineExecutionFromMain } from '../pipelines/pipeline-resume-service';
import * as pipelineStore from '../pipelines/pipeline-service';
import type {
  ExecutionEvent,
  Pipeline,
  PipelineAgentAuthor,
  PipelineAgentChatAddress,
  PipelineData,
  PipelineExecutionInitiator,
  PipelinePreferenceLocator,
  PipelineModelAliasPreference,
  PipelinePluginCollectionPreference,
} from '@canopy/execution-engine/types/pipeline';
import { readPreferencesFile } from '../lib/preferences-store';
import { lastChatSendRunResult } from './pipeline-run-chat-sends';
import {
  deleteOwnedPipeline,
  ownedChatPipelineState,
  ownedPipelineId,
  ownsOrchestratorPromptPipeline,
} from './owned-pipeline';
import {
  WORKFLOW_DELETE_FAILED,
  WORKFLOW_DELETE_RUNNING,
  WORKFLOW_RELEASE_FAILED,
  addedScheduleRefusal,
  isSharedByOtherSchedules,
  isWorkflowPagePipeline,
  keepLastScheduleValues,
  keptWorkflowPipeline,
  markSharedWorkflowPage,
  pipelineSchedules,
  releaseOwnedPipeline,
  scheduledUserPipelineId,
  targetsAgentHiddenPipeline,
  userPipelineMetadata,
  type OwnedPipelineRelease,
} from './workflow-schedules';
import {
  repinConvertedPackageInstall,
  verifyOwnedPipelinePackage,
} from './owned-pipeline-package';
import type { OwnedPipelineReplacement } from './chat-automation-conversion';
import {
  assertAgentRouteModel,
  formatInheritedAgentRoute,
} from '../agents/agent-default-model';
import { mergePluginSelections } from '../lib/plugin-selection-utils';
import { resolveBackgroundChatPluginSelections } from '../plugins/global-plugin-overlay';
import { normalizePluginSelections } from '@canopy/execution-engine/lib/plugin-selections-normalization';
import { resolveConfiguredPrompt } from '../lib/configured-prompt-resolution';
import { loadStandaloneProject } from '../lib/standalone-project-state';
import { isRecord } from '../lib/type-guards';
import { isE2eBuild } from '../lib/e2e-gate';
import {
  isRealisticStartupPerformanceEnabled,
  recordRealisticStartupPerformanceEvent,
} from '../lib/realistic-startup-performance';
import {
  getActiveSessionInfos,
  subscribeChatSessionActivity,
} from '../agents/session-manager';
import {
  removeAutomationCapabilityPackageInstall,
  resolveInstalledAutomationPackageOverlay,
  resolveInstalledAutomationPipelinePackage,
  SharedPipelinePinMismatchError,
  assertSharedPipelineMatchesAutomationInstallPin,
  verifySharedPipelineAutomationInstallPin,
} from '../pipelines/pipeline-package-service';

interface AutomationsFile {
  version: 1;
  updatedAt: string;
  activities: ScheduledActivity[];
  recentRuns: ScheduledActivityRun[];
}

const SHARED_PIPELINE_REVIEW_MESSAGE =
  'This workflow was updated, so take a look before it runs again.';

class SharedPipelineReviewRequiredError extends Error {
  readonly remoteId: string;
  readonly pipelineName?: string;
  readonly installPin: PipelineShareInstallPin;

  constructor(
    remoteId: string,
    installPin: PipelineShareInstallPin,
    pipelineName?: string,
  ) {
    super(SHARED_PIPELINE_REVIEW_MESSAGE);
    this.name = 'SharedPipelineReviewRequiredError';
    this.remoteId = remoteId;
    this.installPin = installPin;
    this.pipelineName = pipelineName;
  }
}

interface SharedPipelineReviewOutcome {
  review: NonNullable<ScheduledActivity['sharedPipelineReview']>;
  installPin: PipelineShareInstallPin;
  enabledIntentRevision: number;
}

function actionMatchesSharedPipelineReviewOutcome(
  action: AutomationAction,
  outcome: SharedPipelineReviewOutcome,
): boolean {
  if (
    action.type !== 'worktree_pipeline' ||
    action.pipelineSource !== 'shared' ||
    action.sharedPipeline?.remoteId !== outcome.review.remoteId
  ) {
    return false;
  }
  const currentPin = action.sharedPipeline.installPin;
  if (!currentPin) return false;
  return (
    currentPin.pipelineContentHash === outcome.installPin.pipelineContentHash &&
    currentPin.distributionMode === outcome.installPin.distributionMode &&
    currentPin.packageDigest === outcome.installPin.packageDigest
  );
}

function isPipelineModelAliasPreference(
  value: unknown,
): value is PipelineModelAliasPreference {
  if (!isRecord(value)) return false;
  if (value.mode === 'reset') return true;
  if (value.mode === 'agent') return typeof value.agent_id === 'string';
  return (
    value.mode === 'inline' &&
    typeof value.base === 'string' &&
    (value.instructions === undefined ||
      typeof value.instructions === 'string') &&
    (value.plugin_collection_id === undefined ||
      typeof value.plugin_collection_id === 'string')
  );
}

function isPipelineModelAliasPreferences(
  value: Record<string, unknown>,
): value is Record<string, PipelineModelAliasPreference> {
  return Object.values(value).every(isPipelineModelAliasPreference);
}

function pipelineExecutionPreferences(
  action: Extract<AutomationAction, { type: 'worktree_pipeline' }>,
): {
  pluginCollectionPreferences?: Record<
    string,
    PipelinePluginCollectionPreference
  >;
  modelAliasPreferences?: Record<string, PipelineModelAliasPreference>;
} {
  const modelAliasPreferences = action.modelAliasPreferences;
  if (
    modelAliasPreferences &&
    !isPipelineModelAliasPreferences(modelAliasPreferences)
  ) {
    throw new Error('Automation model alias preferences are invalid.');
  }
  return {
    ...(action.pluginCollectionPreferences
      ? {
          pluginCollectionPreferences:
            normalizePipelinePluginCollectionPreferences(
              action.pluginCollectionPreferences,
            ),
        }
      : {}),
    ...(modelAliasPreferences ? { modelAliasPreferences } : {}),
  };
}

interface ReadyWorktree {
  id: string;
  createdAt: string;
  workspaceType: 'single-repo' | 'multi-repo';
}

interface IfCommandAbortController {
  readonly signal: AbortSignal;
  abort(): void;
}

/** The task action title limit, which an automation name may exceed. */
const WORK_ENTRY_TITLE_MAX = 200;

/** An automation name as a Work Entry title, cut to the action's limit. */
function workEntryTitle(name: string): string {
  const title = name.trim();
  return title.length > WORK_ENTRY_TITLE_MAX
    ? `${title.slice(0, WORK_ENTRY_TITLE_MAX - 1)}…`
    : title;
}

export interface AutomationsServiceSurfaces {
  getMainWindow: () => BrowserWindow | null;
  getAppAdvisorWindow?: () => BrowserWindow | null;
  openAppAdvisorWindow?: (
    request?: AppAdvisorWindowOpenRequest,
  ) => Promise<AppAdvisorWindowState>;
  ensureAppAdvisorWindow: (
    request?: AppAdvisorWindowOpenRequest,
  ) => Promise<AppAdvisorWindowState>;
  sendAppAdvisorWindowCommand: (command: AppAdvisorWindowCommand) => void;
  onChange?: (snapshot: AutomationsListResponse) => void;
}

const TICK_INTERVAL_MS = 30_000;
const RECENT_RUN_LIMIT = 100;
const MAX_MISSED_BACKFILL_RUNS = 50;
const MISSED_BACKFILL_TIME_BUDGET_MS = 50;
const IF_COMMAND_OUTPUT_MAX_CHARS = 4_000;
const WORKTREE_GIT_READY_TIMEOUT_MS = 10 * 60 * 1000;

export interface ScheduledMessageChatIdentity {
  readonly workspaceId: string;
  readonly worktreeId: string;
  readonly chatId: string;
}

interface ScheduledMessageContributor {
  identity: ScheduledMessageChatIdentity;
  runAt: string;
  updatedAt: string;
}

export function scheduledMessageChatKey(
  identity: ScheduledMessageChatIdentity,
): string {
  return JSON.stringify([
    identity.workspaceId,
    identity.worktreeId,
    identity.chatId,
  ]);
}

const scheduledMessageChangeListeners = new Set<
  (identities: readonly ScheduledMessageChatIdentity[]) => void
>();

export function subscribeScheduledMessageChanges(
  listener: (identities: readonly ScheduledMessageChatIdentity[]) => void,
): () => void {
  scheduledMessageChangeListeners.add(listener);
  return () => {
    scheduledMessageChangeListeners.delete(listener);
  };
}

function scheduledMessageContributors(
  activities: readonly ScheduledActivity[],
): Map<string, ScheduledMessageContributor> {
  const contributors = new Map<string, ScheduledMessageContributor>();
  for (const activity of activities) {
    if (
      !activity.enabled ||
      activity.schedule.kind !== 'one_time' ||
      activity.action.type !== 'worktree_session_prompt' ||
      activity.action.purpose !== 'scheduled_send'
    ) {
      continue;
    }
    contributors.set(activity.id, {
      identity: {
        workspaceId: activity.action.workspaceId,
        worktreeId: activity.action.worktreeId,
        chatId: activity.action.chatId,
      },
      // Keep the persisted definition rather than evaluating it against the
      // current clock; firing after runAt must still invalidate its old target.
      runAt: activity.schedule.runAt,
      updatedAt: activity.updatedAt,
    });
  }
  return contributors;
}

function changedScheduledMessageTargets(
  previous: ReadonlyMap<string, ScheduledMessageContributor>,
  next: ReadonlyMap<string, ScheduledMessageContributor>,
): ScheduledMessageChatIdentity[] {
  const targets = new Map<string, ScheduledMessageChatIdentity>();
  const activityIds = new Set([...previous.keys(), ...next.keys()]);
  for (const activityId of activityIds) {
    const before = previous.get(activityId);
    const after = next.get(activityId);
    if (
      before &&
      after &&
      before.runAt === after.runAt &&
      before.updatedAt === after.updatedAt &&
      scheduledMessageChatKey(before.identity) ===
        scheduledMessageChatKey(after.identity)
    ) {
      continue;
    }
    if (before)
      targets.set(scheduledMessageChatKey(before.identity), before.identity);
    if (after)
      targets.set(scheduledMessageChatKey(after.identity), after.identity);
  }
  return Array.from(targets.values());
}

function notifyScheduledMessageChanges(
  identities: readonly ScheduledMessageChatIdentity[],
): void {
  if (identities.length === 0) return;
  for (const listener of scheduledMessageChangeListeners) {
    try {
      listener(
        identities.map((identity) => ({
          workspaceId: identity.workspaceId,
          worktreeId: identity.worktreeId,
          chatId: identity.chatId,
        })),
      );
    } catch {
      // A summary subscriber must not interrupt an already-persisted change.
    }
  }
}

function missedOccurrenceRunId(
  activityId: string,
  scheduledFor: string,
): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([activityId, scheduledFor]))
    .digest('hex');
  return `missed-${digest}`;
}

/** A pipeline action's run values; `undefined` for any other action. */
function scheduleInputsOf(
  action: AutomationAction,
): Record<string, string> | undefined {
  return action.type === 'worktree_pipeline'
    ? (action.inputs ?? {})
    : undefined;
}

/** Facts main records from a trusted caller, never from a request body. */
export interface AutomationTrustedWrite {
  agentAuthor?: PipelineAgentAuthor | null;
  /**
   * Owner of a new pipeline automation with no project, resolved by a
   * trusted caller (an agent's project owner). Ignored for other actions.
   */
  owner?: string;
  /**
   * The request's run restriction is the one its chat action implies, which
   * main restores when a converted automation goes back to native
   * (CAN-5479). It replaces no restriction an install set, so an install's
   * guard lets it through.
   */
  restoresImpliedTargetRequirement?: true;
}

/** A trusted update: the write's facts, and a write that lands with it. */
export interface AutomationTrustedUpdate extends AutomationTrustedWrite {
  /**
   * Regenerates a converted automation's owned pipeline for the update's
   * action (CAN-5465). It runs inside the queued mutation, before the
   * target and authorization checks that read the pipeline, and is refused
   * while a run is in progress, so a run starts with the old pipeline and
   * inputs or the new ones, never a mix. It answers the action it saved,
   * which must be the update's; it is rolled back when the update is
   * refused or the activity isn't stored.
   */
  regeneratesOwnedPipeline?: () => Promise<OwnedPipelineReplacement>;
  /**
   * CAN-5782: releases the pipeline an owner leaves while other records run
   * it. It runs inside the queued mutation after every refusal, just before
   * the write, so a refused update changes no ownership; `restore` puts the
   * marker back when the write fails.
   */
  releasesOwnedPipeline?: OwnedPipelineRelease;
}

/** A trusted create:the write's facts, an agent sender and its guard. */
export interface AutomationTrustedCreate extends AutomationTrustedWrite {
  agentScheduledSend?: AgentScheduledSend;
  /** Rechecked inside the queue, so an owner change while waiting is seen. */
  authorize?: () => Promise<boolean>;
}

/**
 * The context a new automation is bound to: an explicit owner the account
 * may run in, else the selected one. Nothing is bound while organization
 * projects are off; an explicit organization is refused then.
 */
async function automationCreateOwner(
  explicit: string | undefined,
): Promise<{ context: string | undefined } | { error: string }> {
  if (explicit === undefined)
    return { context: await captureBackgroundExecutionContext() };
  const parsed = parseWorkspaceContext(explicit);
  if (!parsed)
    return { error: backgroundExecutionDeniedMessage('unsupported-target') };
  if (!backgroundExecutionContextEnabled())
    return parsed.kind === 'personal'
      ? { context: undefined }
      : { error: backgroundExecutionDeniedMessage('unsupported-target') };
  if (!(await accountMayRunIn(parsed)))
    return { error: backgroundExecutionDeniedMessage('access-removed') };
  return { context: serializeWorkspaceContext(parsed) };
}

/**
 * The owner a pipeline automation with no project runs as: its saved
 * `executionContext` (absent reads as Personal), never navigation or its
 * inert `workspaceId`. Refused when malformed or the account left it.
 */
async function globalAutomationOwner(
  executionContext: string | undefined,
): Promise<{ context: string } | { error: string }> {
  const parsed = parseWorkspaceContext(executionContext ?? 'personal');
  if (!parsed)
    return { error: backgroundExecutionDeniedMessage('unsupported-target') };
  if (!(await accountMayRunIn(parsed)))
    return { error: backgroundExecutionDeniedMessage('access-removed') };
  return { context: serializeWorkspaceContext(parsed) };
}

/**
 * Folder a project-folder run works in: the selected repository on a
 * multi-repo project, else the canonical source root, which the caller
 * resolves. `cwd` is `undefined` when the project has none; callers refuse
 * instead of falling back.
 */
function projectRootPipelineCwd(
  workspace: SidebarItem,
  repoId: string | undefined,
): { cwd: string | undefined } | { sourceRepoPath: string } {
  if (workspace.type === 'cowork')
    return { cwd: getCoworkWorkspaceRootDir(workspace.id) };
  if (workspace.type === 'single-repo') return { cwd: workspace.repoPath };
  if (repoId && repoId !== WORKSPACE_ROOT_REPO_ID) {
    const repoPath = workspace.repos.find(
      (repo) => repo.id === repoId,
    )?.repoPath;
    if (!repoPath)
      throw new Error(
        'Choose an existing repository in the automation editor.',
      );
    return { cwd: repoPath };
  }
  return workspace.sourceRepoPath
    ? { sourceRepoPath: workspace.sourceRepoPath }
    : { cwd: undefined };
}

interface AutomationRunIdentity {
  initiator: PipelineExecutionInitiator;
  agentOrigin?: PipelineAgentChatAddress;
}

/** Who started an automation's pipeline run, recorded on the run. */
/** Whether two run results name the same fields, whatever their order. */
function sameRunResult(
  current: ScheduledActivityRun['result'],
  next: NonNullable<ScheduledActivityRun['result']>,
): boolean {
  if (!current) return false;
  const keys = Object.keys(current).concat(Object.keys(next));
  return keys.every(
    (key) => Reflect.get(current, key) === Reflect.get(next, key),
  );
}

function automationRunIdentity(
  activity: Pick<ScheduledActivity, 'id' | 'name' | 'agentAuthor'>,
  /** The run's gate output; a converted chat automation's send reads it (CAN-4551). */
  ifCommandOutput?: string,
  /** A scheduled run, whose chats stay behind the current tab (CAN-4551). */
  background = false,
): AutomationRunIdentity {
  return {
    initiator: {
      kind: 'automation',
      automationId: activity.id,
      automationName: activity.name,
      ...(ifCommandOutput !== undefined ? { ifCommandOutput } : {}),
      ...(background ? { background: true } : {}),
    },
    ...(activity.agentAuthor ? { agentOrigin: activity.agentAuthor.chat } : {}),
  };
}

function emptyAutomationsFile(): AutomationsFile {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    activities: [],
    recentRuns: [],
  };
}

function isValidIsoString(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

/** Why a record that doesn't fire here can't be changed or run here. */
function locationRefusal(activity: ScheduledActivity): {
  ok: false;
  error: string;
} {
  return {
    ok: false,
    error: isCloudScheduleStub(activity)
      ? CLOUD_SCHEDULE_MESSAGES.stub
      : CLOUD_SCHEDULE_MESSAGES.unknownLocation,
  };
}

/** How long main shows a cloud stub's server record before reading it again. */
const CLOUD_RECORDS_MAX_AGE_MS = 60_000;

function cloneActivity(activity: ScheduledActivity): ScheduledActivity {
  return JSON.parse(JSON.stringify(activity)) as ScheduledActivity;
}

function cloneRun(run: ScheduledActivityRun): ScheduledActivityRun {
  return JSON.parse(JSON.stringify(run)) as ScheduledActivityRun;
}

function truncateCommandOutput(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.length <= IF_COMMAND_OUTPUT_MAX_CHARS) return value;
  const marker = '\n[output truncated]';
  return `${value.slice(0, IF_COMMAND_OUTPUT_MAX_CHARS - marker.length)}${marker}`;
}

function targetForActivity(
  activity: ScheduledActivity,
): ScheduledActivityRun['target'] {
  const action = activity.action;
  switch (action.type) {
    case 'worktree_prompt':
      return {
        workspaceId: action.workspaceId,
        ...(action.existingWorktreeId
          ? { worktreeId: action.existingWorktreeId }
          : {}),
      };
    case 'worktree_session_prompt':
      return {
        workspaceId: action.workspaceId,
        worktreeId: action.worktreeId,
        chatId: action.chatId,
      };
    case 'standalone_prompt':
      return {
        workspaceId: resolveCoworkWorkspaceId(action.chatProjectId),
        ...(action.workEntryId ? { worktreeId: action.workEntryId } : {}),
      };
    case 'app_advisor_prompt':
      return action.workEntryId
        ? {
            workspaceId: APP_ADVISOR_PROJECT_ID,
            worktreeId: action.workEntryId,
          }
        : undefined;
    case 'worktree_pipeline': {
      const workspaceId = pipelineAutomationWorkspaceId(action);
      if (!workspaceId) return undefined;
      const worktreeId =
        pipelineAutomationTaskId(action) ?? action.baseWorktreeId;
      return {
        workspaceId,
        ...(worktreeId ? { worktreeId } : {}),
        ...(action.repoId ? { repoId: action.repoId } : {}),
      };
    }
    case 'pipeline_execution_resume':
      return {
        ...(action.projectId ? { workspaceId: action.projectId } : {}),
        ...(action.worktreeId ? { worktreeId: action.worktreeId } : {}),
      };
    default:
      return undefined;
  }
}

async function assignNewAutomationItemToSidebarGroup(args: {
  scope: SidebarItemGroupScope;
  itemId: string;
  name: string | undefined;
}): Promise<void> {
  if (!args.name?.trim()) return;
  try {
    await sidebarItemGroupsService.assignItemToNamedGroup({
      scope: args.scope,
      itemId: args.itemId,
      name: args.name,
    });
  } catch {
    // Do not log the group name or service error: either may contain user text.
    logMainProcessError('Automation sidebar group assignment failed', {
      operation: 'assign-sidebar-group',
    });
  }
}

async function contextSnapshot(
  file: AutomationsFile,
): Promise<AutomationsListResponse> {
  if (!resourceContextEnabled()) return cloneSnapshot(file);
  const snapshot = await resourceContextSnapshot();
  const allowed = await Promise.all(
    file.activities.map(async (activity): Promise<boolean> => {
      try {
        await assertAutomationContext(activity);
        return true;
      } catch {
        return false;
      }
    }),
  );
  await assertResourceContextSnapshot(snapshot);
  const activities = file.activities.filter(
    (_activity, index) => allowed[index],
  );
  const ids = new Set(activities.map((activity) => activity.id));
  return {
    activities: activities.map(cloneActivity),
    recentRuns: file.recentRuns
      .filter((run) => ids.has(run.activityId))
      .map(cloneRun),
  };
}

async function contextSnapshotForContext(
  file: AutomationsFile,
  context: WorkspaceContext,
): Promise<AutomationsListResponse> {
  if (!resourceContextEnabled()) return cloneSnapshot(file);
  // The caller context, not the sidebar, authorizes rows; only the account
  // must stay the same while they are checked.
  const account = await resourceAccountSnapshot();
  const allowed = await Promise.all(
    file.activities.map(async (activity): Promise<boolean> => {
      try {
        await assertAutomationContext(activity, context);
        return true;
      } catch {
        return false;
      }
    }),
  );
  await assertResourceAccountSnapshot(account);
  const activities = file.activities.filter(
    (_activity, index) => allowed[index],
  );
  const ids = new Set(activities.map((activity) => activity.id));
  return {
    activities: activities.map(cloneActivity),
    recentRuns: file.recentRuns
      .filter((run) => ids.has(run.activityId))
      .map(cloneRun),
  };
}

/**
 * The install subscription an automation's provenance names, or `undefined`
 * for a local or curated automation. Bundled pipelines are part of the
 * automation install and are never registered on their own.
 */
function automationSubscriptionSource(
  installedFrom: ScheduledActivity['installedFrom'],
):
  | {
      remoteId: string;
      sourceKind: 'shared' | 'public';
      contentHash: string | null;
    }
  | undefined {
  if (!installedFrom || installedFrom.sourceKind === 'curated')
    return undefined;
  return {
    remoteId: installedFrom.remoteId,
    sourceKind: installedFrom.sourceKind === 'public' ? 'public' : 'shared',
    contentHash:
      installedFrom.contentHash.length > 0 ? installedFrom.contentHash : null,
  };
}

function registerAutomationInstall(activity: ScheduledActivity): void {
  const source = automationSubscriptionSource(activity.installedFrom);
  if (source)
    recordSharedItemInstall({
      kind: 'automation',
      ...source,
      localId: activity.id,
    });
}

function unregisterAutomationInstall(
  activityId: string,
  installedFrom: ScheduledActivity['installedFrom'],
): void {
  const source = automationSubscriptionSource(installedFrom);
  if (source)
    recordSharedItemUninstall({
      kind: 'automation',
      remoteId: source.remoteId,
      sourceKind: source.sourceKind,
      localId: activityId,
    });
}

async function assertAutomationContext(
  activity: ScheduledActivity,
  context?: WorkspaceContext,
): Promise<void> {
  if (!resourceContextEnabled()) return;
  if (context !== undefined) {
    if (isContextOwnedInstall(activity.installedFrom)) {
      await assertResourceContextForContext(
        { owner: publicInstallOwner(activity) },
        context,
      );
      return;
    }
    await assertInstalledResourceContext(
      'automations',
      activity.id,
      (remoteId) => getSharedAutomation(remoteId, context),
      context,
    );
    if (!activity.installedFrom) return;
    // Fetching with the caller context also authorizes the owner for it.
    await getSharedAutomation(activity.installedFrom.remoteId, context);
    return;
  }
  if (isContextOwnedInstall(activity.installedFrom)) {
    // Public and curated installs belong to the context they were installed in.
    await assertResourceContext({ owner: publicInstallOwner(activity) });
  } else {
    await assertInstalledResourceContext(
      'automations',
      activity.id,
      getSharedAutomation,
    );
    if (!activity.installedFrom) return;
    const detail = await getSharedAutomation(activity.installedFrom.remoteId);
    await recordResourceInstall('automations', detail, [activity.id]);
  }
}

/**
 * Record the host-captured context in scope at install; the caller never
 * supplies it. Synchronous so a failed capture cannot leave a half-applied
 * update behind.
 */
function applyPublicInstallContext(
  activity: ScheduledActivity,
  context: string | undefined,
): void {
  delete activity.publicInstallContext;
  if (isContextOwnedInstall(activity.installedFrom) && context !== undefined)
    activity.publicInstallContext = context;
}

/** The persisted execution a resume action targets; `null` for other actions. */
async function resumeExecutionState(
  action: AutomationAction,
): Promise<Awaited<ReturnType<typeof loadExecutionState>>> {
  return action.type === 'pipeline_execution_resume'
    ? loadExecutionState(
        action.executionId,
        join(getDataDir(), 'pipeline-executions'),
      )
    : null;
}

/** Where `action` runs; a resume action follows its persisted execution. */
function automationRunDestination(
  action: AutomationAction,
  executionState: Awaited<ReturnType<typeof resumeExecutionState>>,
): { projectId: string; worktreeId?: string } {
  return {
    projectId:
      action.type === 'worktree_pipeline'
        ? (pipelineAutomationWorkspaceId(action) ?? '')
        : 'workspaceId' in action
          ? action.workspaceId
          : action.type === 'standalone_prompt'
            ? resolveCoworkWorkspaceId(action.chatProjectId)
            : action.type === 'app_advisor_prompt'
              ? APP_ADVISOR_PROJECT_ID
              : action.type === 'pipeline_execution_resume'
                ? executionState
                  ? (executionState.project_id ?? '')
                  : (action.projectId ?? '')
                : '',
    ...(action.type === 'pipeline_execution_resume'
      ? {
          worktreeId: executionState
            ? executionState.worktree_id
            : action.worktreeId,
        }
      : {}),
  };
}

/** The context turning `action` on binds it to while `selectedContext` is selected. */
async function bindingContextForAction(
  action: AutomationAction,
  selectedContext: string,
): Promise<string> {
  return automationBindingContext(
    automationRunDestination(action, await resumeExecutionState(action)),
    selectedContext,
  );
}

/** Whether two automation actions run against the same workspace and worktree. */
function sameAutomationDestination(
  a: ReturnType<typeof automationActionDestination>,
  b: ReturnType<typeof automationActionDestination>,
): boolean {
  return (
    a?.projectId === b?.projectId &&
    (a?.worktreeId ?? null) === (b?.worktreeId ?? null)
  );
}

/** Updating (or rolling back) the same public share keeps its install context. */
function isSameContextOwnedShare(
  current: ScheduledActivity['installedFrom'],
  next: NonNullable<ScheduledActivity['installedFrom']>,
): boolean {
  return (
    isContextOwnedInstall(next) &&
    current !== undefined &&
    next.sourceKind === current?.sourceKind &&
    current.remoteId === next.remoteId
  );
}

function cloneSnapshot(file: AutomationsFile): AutomationsListResponse {
  return {
    activities: file.activities.map(cloneActivity),
    recentRuns: file.recentRuns.map(cloneRun),
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isPipelineAgentAuthor(value: unknown): value is PipelineAgentAuthor {
  return (
    isRecord(value) &&
    isRecord(value.chat) &&
    isNonEmptyString(value.chat.projectId) &&
    isNonEmptyString(value.chat.worktreeId) &&
    isNonEmptyString(value.chat.chatId) &&
    isNonEmptyString(value.recordedAt)
  );
}

function isPersistedActivity(value: unknown): value is ScheduledActivity {
  if (!isRecord(value)) return false;
  // CAN-6183: an unknown location is kept and never fired here.
  normalizePersistedLocation(value);
  // A malformed agent marker is dropped; the automation itself stays valid.
  if (
    value.agentAuthor !== undefined &&
    !isPipelineAgentAuthor(value.agentAuthor)
  )
    delete value.agentAuthor;
  if (
    value.executionContext !== undefined &&
    typeof value.executionContext !== 'string'
  )
    return false;
  if (
    value.publicInstallContext !== undefined &&
    typeof value.publicInstallContext !== 'string'
  )
    return false;
  if (value.version !== 1) return false;
  if (typeof value.id !== 'string') return false;
  if (typeof value.name !== 'string' || value.name.trim() === '') return false;
  if (typeof value.enabled !== 'boolean') return false;
  if (validateAutomationTrigger(value.schedule)) {
    return false;
  }
  if (!isRecord(value.action) || validateAutomationAction(value.action)) {
    return false;
  }
  if (!isValidIsoString(value.createdAt)) return false;
  if (!isValidIsoString(value.updatedAt)) return false;
  if (value.lastRunAt !== undefined && !isValidIsoString(value.lastRunAt)) {
    return false;
  }
  if (value.nextRunAt !== undefined && !isValidIsoString(value.nextRunAt)) {
    return false;
  }
  if (
    value.lastScheduledFor !== undefined &&
    !isValidIsoString(value.lastScheduledFor)
  ) {
    return false;
  }
  if (validateAutomationSharedPipelineReview(value.sharedPipelineReview)) {
    return false;
  }
  if (
    value.targetRequirement !== undefined &&
    !validateSharedAutomationTargetRequirement(value.targetRequirement).ok
  )
    return false;
  if (
    value.targetRequirementCleared !== undefined &&
    value.targetRequirementCleared !== true
  )
    return false;
  // A malformed dependency list is dropped; the automation itself stays valid.
  if (
    value.dependencies !== undefined &&
    validateAutomationDependencies(value.dependencies) !== null
  )
    delete value.dependencies;
  return typeof value.failureCount === 'number' && value.failureCount >= 0;
}

function isKnownRunStatus(value: unknown): boolean {
  return (
    value === 'running' ||
    value === 'success' ||
    value === 'failure' ||
    value === 'skipped' ||
    value === 'canceled' ||
    value === 'missed'
  );
}

function isKnownSkipReason(value: unknown): value is AutomationSkipReason {
  return (
    value === 'if_command_exit' ||
    value === 'idempotency' ||
    value === 'already_running'
  );
}

function isPersistedRun(value: unknown): value is ScheduledActivityRun {
  if (!isRecord(value)) return false;
  if (
    value.executionContext !== undefined &&
    typeof value.executionContext !== 'string'
  )
    return false;
  if (typeof value.id !== 'string') return false;
  if (typeof value.activityId !== 'string') return false;
  if (typeof value.activityName !== 'string') return false;
  if (!isValidIsoString(value.scheduledFor)) return false;
  if (typeof value.manual !== 'boolean') return false;
  if (!isKnownRunStatus(value.status)) return false;
  if (!isValidIsoString(value.startedAt)) return false;
  if (value.completedAt !== undefined && !isValidIsoString(value.completedAt)) {
    return false;
  }
  if (value.trigger !== undefined) {
    if (
      value.trigger !== 'scheduled' &&
      value.trigger !== 'manual' &&
      value.trigger !== 'catch_up'
    ) {
      return false;
    }
  }
  // CAN-6183: a run from a location this desktop doesn't know is kept.
  if (
    value.executionLocation !== undefined &&
    !isAutomationExecutionLocation(value.executionLocation)
  )
    delete value.executionLocation;
  if (value.recovered !== undefined && typeof value.recovered !== 'boolean') {
    return false;
  }
  if (
    value.cancellable !== undefined &&
    typeof value.cancellable !== 'boolean'
  ) {
    return false;
  }
  if (
    value.durationMs !== undefined &&
    (typeof value.durationMs !== 'number' || value.durationMs < 0)
  ) {
    return false;
  }
  if (
    value.ifCommandOutput !== undefined &&
    typeof value.ifCommandOutput !== 'string'
  ) {
    return false;
  }
  if (
    value.ifCommandError !== undefined &&
    typeof value.ifCommandError !== 'string'
  ) {
    return false;
  }
  if (
    value.omittedCount !== undefined &&
    (typeof value.omittedCount !== 'number' ||
      !Number.isInteger(value.omittedCount) ||
      value.omittedCount < 1)
  ) {
    return false;
  }
  if (
    value.missedOccurrencesTruncated !== undefined &&
    typeof value.missedOccurrencesTruncated !== 'boolean'
  ) {
    return false;
  }
  if (value.error !== undefined && typeof value.error !== 'string') {
    return false;
  }
  if (value.skipReason !== undefined && !isKnownSkipReason(value.skipReason)) {
    return false;
  }
  if (
    value.idempotencyKey !== undefined &&
    typeof value.idempotencyKey !== 'string'
  ) {
    return false;
  }
  if (
    value.idempotencyScope !== undefined &&
    value.idempotencyScope !== 'global' &&
    value.idempotencyScope !== 'self'
  ) {
    return false;
  }
  return true;
}

function trimRecentRuns(runs: ScheduledActivityRun[]): ScheduledActivityRun[] {
  const running = runs.filter((run) => run.status === 'running');
  const terminal = runs
    .filter((run) => run.status !== 'running')
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
    .slice(0, RECENT_RUN_LIMIT);
  return [...running, ...terminal].sort((left, right) =>
    right.startedAt.localeCompare(left.startedAt),
  );
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isIdempotencyScopeMatch(
  current: {
    activityId: string;
    key: string;
    scope: AutomationIfCommandIdempotencyScope;
  },
  candidate: ScheduledActivityRun,
): boolean {
  if (candidate.idempotencyKey !== current.key) return false;
  if (candidate.status !== 'running' && candidate.status !== 'success') {
    return false;
  }
  if (current.scope === 'global' || candidate.idempotencyScope === 'global') {
    return true;
  }
  return candidate.activityId === current.activityId;
}

function getAutomationProviderForModel(model: ChatModel): AgentProviderType {
  if (!getModelSource(model) && /^gpt-|^o\d|^codex/i.test(model)) {
    return 'codex';
  }
  return requireProviderForModel(model);
}

const ACTIVITY_RUNNING_RETRY =
  'Activity is running. Try again after the run finishes.';

/** Puts back the pipeline a conversion or regeneration saved. */
function rollBackOwnedPipeline(
  replacement: OwnedPipelineReplacement,
): Promise<void> {
  return replacement.rollback().catch(() =>
    logMainProcessError('Failed to roll back an automation’s workflow', {
      operation: 'rollback-owned-pipeline',
    }),
  );
}

function isActivityRunning(file: AutomationsFile, activityId: string): boolean {
  return file.recentRuns.some(
    (run) => run.activityId === activityId && run.status === 'running',
  );
}

function hasRunForOccurrence(
  file: AutomationsFile,
  activityId: string,
  scheduledFor: string,
): boolean {
  return file.recentRuns.some(
    (run) =>
      run.activityId === activityId &&
      run.scheduledFor === scheduledFor &&
      (run.status === 'running' ||
        run.status === 'success' ||
        run.status === 'failure' ||
        run.status === 'skipped'),
  );
}

function isWorktreeSessionPromptTargetBusy(
  action: Extract<AutomationAction, { type: 'worktree_session_prompt' }>,
): boolean {
  return getActiveSessionInfos(action.workspaceId, action.worktreeId).some(
    (session) =>
      session.chatId === action.chatId &&
      (session.turnActive ||
        session.pendingMessageCount > 0 ||
        (session.activeBackgroundTaskCount ?? 0) > 0),
  );
}

function computeNextRunAt(
  activity: ScheduledActivity,
  after: Date,
): string | undefined {
  const next = getNextAutomationTriggerRun(activity.schedule, after);
  return next?.toISOString();
}

function computeNextAfterScheduledWindow(
  activity: ScheduledActivity,
  scheduledFor: string,
  now: Date,
): string | undefined {
  if (activity.schedule.kind !== 'cron') return undefined;
  const scheduledTime = Date.parse(scheduledFor);
  const baseTime = Math.max(
    Number.isFinite(scheduledTime) ? scheduledTime : now.getTime(),
    now.getTime(),
  );
  return getNextCronRun(
    activity.schedule.expression,
    new Date(baseTime),
  )?.toISOString();
}

function triggerForScheduledOccurrence(
  activity: ScheduledActivity,
  scheduledFor: string,
  now: Date,
): AutomationRunTrigger {
  if (activity.schedule.kind !== 'cron') return 'scheduled';
  const next = getNextCronRun(
    activity.schedule.expression,
    new Date(scheduledFor),
  );
  return next && next.getTime() <= now.getTime() ? 'catch_up' : 'scheduled';
}

function nextRunForEnabledActivity(
  activity: ScheduledActivity,
  file: AutomationsFile,
  now: Date,
  options: { preserveExistingCronNextRun?: boolean } = {},
): string | undefined {
  // A cloud stub fires server-side (CAN-6183); it has no local next run.
  if (!activity.enabled || !firesLocally(activity)) return undefined;
  if (activity.schedule.kind === 'one_time') {
    const runAt = activity.schedule.runAt;
    if (activity.sharedPipelineReview && activity.lastScheduledFor === runAt) {
      return undefined;
    }
    if (hasRunForOccurrence(file, activity.id, runAt)) {
      return undefined;
    }
    return runAt;
  }
  if (
    options.preserveExistingCronNextRun !== false &&
    activity.nextRunAt &&
    Number.isFinite(Date.parse(activity.nextRunAt))
  ) {
    return activity.nextRunAt;
  }
  return computeNextRunAt(activity, now);
}

function defaultPluginSelections(
  selections: ChatTabPluginSelections | undefined,
): ChatTabPluginSelections | undefined {
  return selections && hasAnySelections(selections) ? selections : undefined;
}

async function resolveWorkspaceDefaultPluginSelections(
  workspaceId: string,
): Promise<ChatTabPluginSelections | undefined> {
  const { items } = await readAllSidebarItems();
  const workspace = items.find((item) => item.id === workspaceId);
  return defaultPluginSelections(workspace?.defaultPluginSelections);
}

async function resolveStandaloneDefaultPluginSelections(
  chatProjectId: string,
): Promise<ChatTabPluginSelections | undefined> {
  try {
    const raw = await readFile(getChatProjectsFilePath(), 'utf8');
    const parsed = JSON.parse(raw) as { projects?: ChatProjectData[] };
    const indexProject = Array.isArray(parsed.projects)
      ? parsed.projects.find((project) => project.id === chatProjectId)
      : undefined;
    if (!indexProject) return undefined;
    const { mergedProject } = await loadStandaloneProject(indexProject);
    return defaultPluginSelections(mergedProject.defaultPluginSelections);
  } catch {
    return undefined;
  }
}

/** What a created chat will resolve: its own selections plus the defaults it inherits. */
function withInheritedDefaults(
  inherited: ChatTabPluginSelections | undefined,
  selections: ChatTabPluginSelections | undefined,
): ChatTabPluginSelections | undefined {
  return selections ? mergePluginSelections(inherited, selections) : inherited;
}

type AutomationPromptAction = Extract<
  AutomationAction,
  { type: 'app_advisor_prompt' | 'standalone_prompt' | 'worktree_prompt' }
>;

function normalizeAutomationAction(action: AutomationAction): AutomationAction {
  if (
    action.type !== 'app_advisor_prompt' &&
    action.type !== 'standalone_prompt' &&
    action.type !== 'worktree_prompt'
  ) {
    return action;
  }

  const actionWithoutPluginSelections = { ...action };
  delete actionWithoutPluginSelections.pluginSelections;
  if (!action.pluginSelections) {
    return actionWithoutPluginSelections;
  }

  const pluginSelections = normalizePluginSelections(action.pluginSelections);
  return hasAnySelections(pluginSelections)
    ? { ...actionWithoutPluginSelections, pluginSelections }
    : actionWithoutPluginSelections;
}

function sharedPipelineBindingChanged(
  current: AutomationAction,
  next: AutomationAction,
): boolean {
  if (
    current.type !== 'worktree_pipeline' ||
    next.type !== 'worktree_pipeline'
  ) {
    return current.type !== next.type;
  }
  if (current.pipelineSource !== next.pipelineSource) return true;
  if (current.pipelineSource !== 'shared' || next.pipelineSource !== 'shared') {
    return false;
  }
  const currentShared = current.sharedPipeline;
  const nextShared = next.sharedPipeline;
  if (!currentShared || !nextShared) return currentShared !== nextShared;
  if (
    currentShared.serverId !== nextShared.serverId ||
    currentShared.remoteId !== nextShared.remoteId
  ) {
    return true;
  }
  const currentPin = currentShared.installPin;
  const nextPin = nextShared.installPin;
  return (
    currentPin?.pipelineContentHash !== nextPin?.pipelineContentHash ||
    currentPin?.distributionMode !== nextPin?.distributionMode ||
    currentPin?.packageDigest !== nextPin?.packageDigest
  );
}

/**
 * Lane default for an automation, resolved ONLY when the action needs one.
 *
 * Lane resolution awaits both native auth probes, the AI Credits lookup, and
 * policy evaluation; on a cold cache that is ~20s and can spin up a Codex
 * app-server. An automation that names its own model never consumes the
 * default, so the branch happens before the await, not after it. The
 * thinking-level fallback then comes from the configured provider default — a
 * pure preference read.
 */
async function resolveAutomationLaneDefault(
  action: AutomationPromptAction,
  preferences: PreferencesData,
  scope: 'chat' | 'worktree',
  // Parity with the spawn this automation will perform. Required rather than
  // optional so a new prompt action cannot silently resolve against the global
  // Environments slot while dispatching into a workspace that overrides it.
  credentialScope: LaneCredentialScope,
): Promise<
  | {
      selection: { model: ChatModel; thinkingLevel: ThinkingLevel } | undefined;
      requireModel: () => { model: ChatModel; thinkingLevel: ThinkingLevel };
    }
  | undefined
> {
  // `undefined` — not a pair whose `requireModel` throws. Returning a throwing
  // stub made correctness depend on `resolveAutomationPromptModelSettings`
  // independently re-testing the same `action.model` condition; two copies of
  // one condition drift, and the failure mode was a misleading billing error
  // for an automation that HAD an explicit model. Absent is unambiguous.
  //
  // The thinking-level fallback for an explicit model is recovered separately,
  // from the NAMED model's provider — see `resolveAutomationPromptModelSettings`.
  // An Agent that inherits the default model still needs it.
  if (namesConcreteAutomationModel(action)) return undefined;
  return resolveOptionalLaneAwareDefaultSelection(
    preferences,
    scope,
    credentialScope,
  );
}

/** The model an automation names, as validation and resolution read it. */
function namedAutomationModel(
  action: AutomationPromptAction,
): string | undefined {
  return action.model?.trim() || undefined;
}

function namesConcreteAutomationModel(action: AutomationPromptAction): boolean {
  const named = namedAutomationModel(action);
  return named !== undefined && !isInheritingAgentModel(named);
}

function namesInheritingAutomationAgent(
  action: AutomationPromptAction,
): boolean {
  const named = namedAutomationModel(action);
  return named !== undefined && isInheritingAgentModel(named);
}

function resolveAutomationPromptModelSettings(
  action: AutomationPromptAction,
  // Lazy on purpose: an automation configured with an explicit model never
  // needed a lane default, so `requireModel()` must not be evaluated for it.
  defaults:
    | {
        selection:
          | { model: ChatModel; thinkingLevel: ThinkingLevel }
          | undefined;
        requireModel: () => { model: ChatModel; thinkingLevel: ThinkingLevel };
      }
    | undefined,
  // Configured per-provider defaults for THIS surface, used only to recover the
  // thinking level for an explicitly named model. Keyed on the named model's
  // own provider, never the surface's preferred one.
  byProvider: ModelDefaultsByProvider | undefined,
  // A SURFACE-level thinking setting that applies regardless of which model the
  // surface ends up running (App Advisor's `appAdvisorThinkingLevel` is the only
  // one today — the renderer applies it unconditionally in `resolveTabDefaults`).
  // Because it is not provider-keyed, the cross-provider hazard that justifies
  // ignoring the preferred provider's level does not apply to it, so it takes
  // precedence over the per-provider fallback below.
  surfaceThinkingLevel: ThinkingLevel | undefined,
  providerDefaults:
    | Partial<Record<AgentProviderType, AgentModelConfig>>
    | undefined,
): {
  model: ChatModel;
  providerType: AgentProviderType;
  executionHarness: 'claude' | 'codex' | 'cursor' | 'copilot' | 'opencode';
  modelConfig: ReturnType<typeof resolveProviderModelConfig>;
} {
  const namedModel = namedAutomationModel(action);
  if (namedModel) assertAgentRouteModel(namedModel);
  const defaultModel =
    namesConcreteAutomationModel(action) || !defaults
      ? undefined
      : defaults.requireModel().model;
  // The created chat keeps the route an inheriting Agent resolved here. Such
  // actions come from `automation.create` and imports; the automation editor
  // still hides Agents until its separate product decision (out of CAN-3999).
  const requestedModel =
    namedModel && isInheritingAgentModel(namedModel)
      ? defaultModel && formatInheritedAgentRoute(namedModel, defaultModel)
      : namedModel || defaultModel;
  if (!requestedModel) {
    throw new Error('No dispatchable model is available (billing-lane).');
  }
  const model = resolveKnownModel(requestedModel) ?? requestedModel;
  const providerType = getAutomationProviderForModel(model);
  const executionHarness =
    getExecutionHarnessForModel(model) ??
    (providerType === 'codex' ? 'codex' : 'claude');
  // Every caller gates a Cursor dispatch itself, once the harness is known:
  // `isCursorRuntimeAvailable()` does fs `lstat`s, reads preferences,
  // dynamically imports the runtime module and mutates a shared availability
  // cache, so it is never charged to a Claude or Codex dispatch.
  const modelConfig = resolveProviderModelConfig(
    executionHarness,
    {
      // Falls back to the configured level for the NAMED model's provider.
      // Removing this fallback outright (round 3) fixed the cross-provider bug
      // but also dropped the user's own setting for the same-provider case: a
      // user who set their default Claude model to `low` and wrote a hook
      // naming another Claude model silently got `high` back.
      thinkingLevel:
        action.modelConfig?.thinkingLevel ??
        action.thinking ??
        defaults?.selection?.thinkingLevel ??
        surfaceThinkingLevel ??
        byProvider?.[providerType]?.thinkingLevel,
      modelConfig: action.modelConfig,
    },
    providerDefaults,
  );

  return { model, providerType, executionHarness, modelConfig };
}

function automationTarget(
  action: AutomationAction,
): { projectId: string; worktreeId: string } | null {
  if (action.type === 'worktree_session_prompt') {
    return { projectId: action.workspaceId, worktreeId: action.worktreeId };
  }
  if (action.type === 'worktree_prompt') {
    const worktreeId = action.existingWorktreeId ?? action.baseWorktreeId;
    if (worktreeId) {
      return { projectId: action.workspaceId, worktreeId };
    }
    return null;
  }
  if (action.type === 'worktree_pipeline') {
    // An existing task is reserved; so is a fresh worktree's base.
    const projectId = pipelineAutomationWorkspaceId(action);
    const worktreeId =
      pipelineAutomationTaskId(action) ?? action.baseWorktreeId;
    return projectId && worktreeId ? { projectId, worktreeId } : null;
  }
  if (action.type === 'standalone_prompt' && action.workEntryId) {
    return {
      projectId: resolveCoworkWorkspaceId(action.chatProjectId),
      worktreeId: action.workEntryId,
    };
  }
  if (action.type === 'app_advisor_prompt' && action.workEntryId) {
    return {
      projectId: APP_ADVISOR_PROJECT_ID,
      worktreeId: action.workEntryId,
    };
  }
  if (
    action.type === 'pipeline_execution_resume' &&
    action.projectId &&
    action.worktreeId
  ) {
    return { projectId: action.projectId, worktreeId: action.worktreeId };
  }
  return null;
}

function reserveAutomationTargetStart(action: AutomationAction): () => void {
  const target = automationTarget(action);
  return target
    ? reserveWorkspaceTargetRuntimeStart(target.projectId, target.worktreeId)
    : (): void => undefined;
}

/** A pipeline an automation resolved to run, as its authorization sees it. */
interface ResolvedPipelineSelection {
  pipeline: Pipeline;
  pipelineFilePath?: string;
  owner?: unknown;
  pipelinePreferenceLocator?: PipelinePreferenceLocator;
  /** Install receipts are keyed by the remote id of an installed copy. */
  storedPipelineRemoteId?: string;
  sharedPipeline?: Extract<
    AutomationAction,
    { type: 'worktree_pipeline' }
  >['sharedPipeline'];
}

/** The resources a resolved pipeline and its children run with. */
function resolvedPipelineContextResources(
  selection: ResolvedPipelineSelection,
  cwd: string,
  preferences: ReturnType<typeof pipelineExecutionPreferences>,
): ReturnType<typeof pipelineContextResources> {
  // Project files are caller-authored.
  if (selection.pipelineFilePath)
    return localPipelineContextResources(selection.pipeline, {
      cwd,
      pipelineFileDir: dirname(selection.pipelineFilePath),
      pipelinePreferenceLocator: selection.pipelinePreferenceLocator,
      ...preferences,
    });
  const storedPipelineId =
    selection.pipelinePreferenceLocator?.type === 'stored'
      ? selection.pipelinePreferenceLocator.value
      : undefined;
  return pipelineContextResources(
    selection.pipeline,
    selection.owner,
    {
      cwd,
      pipelinePreferenceLocator: selection.pipelinePreferenceLocator,
      ...preferences,
      pipelineId: storedPipelineId,
    },
    selection.storedPipelineRemoteId ?? storedPipelineId,
  );
}

/**
 * The verdict a failed account-bound shared pipeline read carries: a
 * retryable Cloud failure is a transient refusal that keeps the automation
 * on, and a validated 403/404, sign-out or account change means access was
 * removed. Any other failure has no verdict.
 */
async function sharedPipelineReadDecision(
  error: unknown,
): Promise<Extract<ResourceContextDecision, { allow: false }> | null> {
  const { CanopyCloudClientError, isTransientCanopyCloudFailure } =
    await import('../canopy-cloud/client');
  if (isTransientCanopyCloudFailure(error))
    return { allow: false, reason: 'unknown-provenance', transient: true };
  if (
    (error instanceof CanopyCloudClientError &&
      error.isValidatedServerError &&
      (error.status === 403 || error.status === 404)) ||
    // The bound read reports sign-out or an account change this way.
    (error instanceof Error &&
      error.message === 'Workflow unavailable (access-removed)')
  )
    return { allow: false, reason: 'access-removed' };
  return null;
}

export class AutomationsService {
  private surfaces: AutomationsServiceSurfaces | null = null;
  private file: AutomationsFile | null = null;
  private cloudRemote: CloudScheduleRemote = UNAVAILABLE_CLOUD_SCHEDULE_REMOTE;
  /** CAN-6183: the server records of cloud stubs, as main last read them. */
  private readonly cloudRecords = cloudScheduleRecordCache();
  private cloudRecordsReadAt = 0;
  private cloudRecordsRead: Promise<void> | null = null;
  private loadingFile: Promise<AutomationsFile> | null = null;
  private persistedScheduledMessageContributors: Map<
    string,
    ScheduledMessageContributor
  > | null = null;
  private writeQueue: Promise<unknown> = Promise.resolve();
  private interval: ReturnType<typeof setInterval> | null = null;
  private sessionActivityUnsubscribe: (() => void) | null = null;
  private dueCheckRunning = false;
  private dueCheckRequested = false;
  private ifCommandAbortHandlers: Set<() => void> = new Set();
  private cancellableRuns = new Map<string, IfCommandAbortController>();
  private enabledIntentRevisions = new Map<string, number>();
  private readonly archive = getAutomationRunArchive();
  private pendingArchiveWrites: Promise<void>[] = [];
  private archiveMaintenance: Promise<void> = Promise.resolve();

  configure(surfaces: AutomationsServiceSurfaces): void {
    this.surfaces = surfaces;
  }

  async start(): Promise<void> {
    // Under the UI-automation/E2E build, never start the scheduler: due-checks
    // run on a 30s tick and on every chat-session-activity event and can fire
    // real automation actions (create worktrees, send messages, run pipelines),
    // mutating persisted state mid-test. Build-gated, so production is
    // unaffected. Activities remain listable/editable via the IPC handlers,
    // which read the file directly.
    if (isE2eBuild() && !isRealisticStartupPerformanceEnabled()) {
      return;
    }
    recordRealisticStartupPerformanceEvent('startup:automations:started');
    if (this.interval !== null) {
      return;
    }
    const file = await this.readFile();
    if (this.persistedScheduledMessageContributors === null) {
      this.persistedScheduledMessageContributors = scheduledMessageContributors(
        file.activities,
      );
    }
    this.archiveMaintenance = this.archiveMaintenance
      .then(async () => {
        const preferences = await readPreferencesFile();
        await this.archive.pruneAll(
          preferences.automationRunRetentionDays ?? 90,
        );
      })
      .catch((error) =>
        logMainProcessError('Failed to prune automation run history', error),
      );
    const reconciledFile = await this.reconcileArchivedTerminalRuns(file);
    const normalizedFile = this.normalizeFile(reconciledFile);
    await this.flushPendingArchiveWrites();
    this.file = normalizedFile;
    if (JSON.stringify(file) !== JSON.stringify(normalizedFile)) {
      await this.writeFile(normalizedFile);
    }
    await this.runDueCheck();
    this.interval = setInterval(() => {
      void this.runDueCheck().catch(() => undefined);
    }, TICK_INTERVAL_MS);
    this.interval.unref?.();
    this.sessionActivityUnsubscribe = subscribeChatSessionActivity(() => {
      void this.runDueCheck().catch(() => undefined);
    });
  }

  stop(): void {
    if (this.interval !== null) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.sessionActivityUnsubscribe?.();
    this.sessionActivityUnsubscribe = null;
    this.dueCheckRunning = false;
    this.dueCheckRequested = false;
    this.ifCommandAbortHandlers.forEach((abortIfCommand: () => void) => {
      abortIfCommand();
    });
    this.ifCommandAbortHandlers.clear();
    this.cancellableRuns.clear();
  }

  async assertActivityResourceContext(id: string): Promise<void> {
    if (!resourceContextEnabled()) return;
    const file = await this.ensureFile();
    const activity = file.activities.find((entry) => entry.id === id);
    if (!activity)
      throw new Error('Automation unavailable (unsupported-target)');
    await assertAutomationContext(activity);
  }

  /**
   * Unfiltered read for background gates, which authorize the definition
   * against its persisted binding instead of the foreground context.
   */
  async findActivityForBackgroundAuthorization(
    id: string,
  ): Promise<ScheduledActivity | undefined> {
    const activity = (await this.ensureFile()).activities.find(
      (entry) => entry.id === id,
    );
    return activity ? cloneActivity(activity) : undefined;
  }

  /**
   * Every activity installed from a share, across all contexts, for the
   * one-time install subscription backfill. Unfiltered and side-effect free:
   * the backfill only reports provenance and grants nothing.
   */
  async listInstalledActivitiesForSubscriptionBackfill(): Promise<
    ScheduledActivity[]
  > {
    const file = await this.ensureFile();
    return file.activities
      .filter((activity) => activity.installedFrom !== undefined)
      .map(cloneActivity);
  }

  /**
   * Every activity, across all contexts, for the chat automation migration
   * (CAN-5479). Unfiltered and side-effect free: each conversion re-reads its
   * automation inside the write queue.
   */
  async listActivitiesForChatAutomationMigration(): Promise<
    ScheduledActivity[]
  > {
    const file = await this.ensureFile();
    return file.activities.map(cloneActivity);
  }

  async list(): Promise<AutomationsListResponse> {
    // CAN-6183: a read of the cloud stubs' records that finds a change
    // republishes the list.
    void this.refreshCloudRecords();
    const file = await this.ensureFile();
    return contextSnapshot(file);
  }

  /** Undefined when the automations file cannot be read: the count is unknown. */
  async getScheduledMessagesIndex(
    now?: Date,
  ): Promise<ReadonlyMap<string, PortalChatScheduledMessages> | undefined> {
    let file: AutomationsFile;
    try {
      file = await this.ensureFile();
    } catch {
      return undefined;
    }
    const after = now ?? new Date();
    const index = new Map<string, PortalChatScheduledMessages>();
    for (const activity of file.activities) {
      if (
        !activity.enabled ||
        activity.schedule.kind !== 'one_time' ||
        activity.action.type !== 'worktree_session_prompt' ||
        activity.action.purpose !== 'scheduled_send'
      ) {
        continue;
      }
      if (hasRunForOccurrence(file, activity.id, activity.schedule.runAt)) {
        continue;
      }
      const nextRun = getNextAutomationTriggerRun(activity.schedule, after);
      const overdueRunAt =
        !nextRun && Date.parse(activity.schedule.runAt) <= after.getTime()
          ? activity.schedule.runAt
          : undefined;
      const nextAt = nextRun?.toISOString() ?? overdueRunAt;
      if (nextAt === undefined) continue;
      const identity = {
        workspaceId: activity.action.workspaceId,
        worktreeId: activity.action.worktreeId,
        chatId: activity.action.chatId,
      };
      const key = scheduledMessageChatKey(identity);
      const nextAtTime = Date.parse(nextAt);
      const existing = index.get(key);
      const existingTime = existing?.nextAt
        ? Date.parse(existing.nextAt)
        : Number.NaN;
      index.set(
        key,
        existing
          ? {
              count: existing.count + 1,
              nextAt:
                Number.isFinite(existingTime) && existingTime < nextAtTime
                  ? existing.nextAt
                  : nextAt,
            }
          : { count: 1, nextAt },
      );
    }
    return index;
  }

  /**
   * Every stored activity, whatever context is selected: main's ownership
   * facts (CAN-5782) count schedules in every context. Never shown as is.
   */
  async allActivities(): Promise<ScheduledActivity[]> {
    const file = await this.ensureFile();
    return file.activities.map(cloneActivity);
  }

  /** Read activity visibility using a trusted caller's owner context. */
  async listForContext(
    context: WorkspaceContext,
  ): Promise<AutomationsListResponse> {
    const file = await this.ensureFile();
    return contextSnapshotForContext(file, context);
  }

  /**
   * Rebind activities whose destination is a workspace that changed owner
   * (CAN-3543): those bound to the previous owner, or never bound, follow the
   * workspace. Activities bound anywhere else keep their binding.
   */
  async rebindWorkspaceExecutionContexts(input: {
    workspaceId: string;
    previousContext: string;
    nextContext: string;
  }): Promise<string[]> {
    return this.enqueueMutation(async (): Promise<string[]> => {
      const current = await this.ensureFile();
      const file: AutomationsFile = {
        ...current,
        activities: current.activities.map(cloneActivity),
      };
      const rebound: string[] = [];
      const updatedAt = new Date().toISOString();
      for (const activity of file.activities) {
        const destination = automationActionDestination(activity.action);
        if (
          !destination ||
          backgroundDestinationWorkspaceId(destination) !== input.workspaceId
        )
          continue;
        if (
          activity.executionContext !== undefined &&
          activity.executionContext !== input.previousContext
        )
          continue;
        activity.executionContext = input.nextContext;
        activity.updatedAt = updatedAt;
        rebound.push(activity.id);
      }
      if (rebound.length > 0) {
        await this.writeFile(file);
        this.file = file;
        await this.republish();
      }
      return rebound;
    });
  }

  /**
   * The resource graph and destination a background run of `activity`
   * authorizes: the definition, its plugins, model and inherited selections,
   * and its pipeline. Turning an automation on checks the same graph.
   */
  private async backgroundAuthorizationInput(
    activity: ScheduledActivity,
  ): Promise<{
    resources: ReturnType<typeof pipelineContextResources>;
    destination:
      | { scope: 'global' }
      | { projectId: string; worktreeId?: string };
    /**
     * The shared pipeline could not be read, so `resources` is incomplete
     * and must not be authorized. `decision` is the read's verdict, when the
     * failure carries one.
     */
    sharedPipelineReadFailure?: {
      error: unknown;
      decision: Extract<ResourceContextDecision, { allow: false }> | null;
    };
  }> {
    const action = activity.action;
    const resources: ReturnType<typeof pipelineContextResources> = [
      automationDefinitionResource(activity),
      {
        owner: undefined,
        requiresHostAuthorization: true,
        capabilities: {
          ...('plugins' in action ? { plugins: action.plugins } : {}),
          ...('pluginSelections' in action
            ? { selections: action.pluginSelections }
            : {}),
          ...('model' in action ? { model: action.model } : {}),
        },
      },
    ];
    let sharedPipelineReadFailure:
      | {
          error: unknown;
          decision: Extract<ResourceContextDecision, { allow: false }> | null;
        }
      | undefined;
    let inheritedPlugins: ChatTabPluginSelections | undefined;
    if (action.type === 'app_advisor_prompt')
      inheritedPlugins = defaultPluginSelections(
        (await readPreferencesFile()).appAdvisorPluginSelections,
      );
    else if (action.type === 'standalone_prompt')
      inheritedPlugins = await resolveStandaloneDefaultPluginSelections(
        action.chatProjectId,
      );
    else if (action.type === 'worktree_prompt')
      inheritedPlugins = await resolveWorkspaceDefaultPluginSelections(
        action.workspaceId,
      );
    else if (action.type === 'worktree_session_prompt') {
      const tab = (
        await readChatTabsFile(action.workspaceId, action.worktreeId)
      ).tabs.find((candidate) => candidate.id === action.chatId);
      if (tab)
        inheritedPlugins = await resolveBackgroundChatPluginSelections(
          tab.pluginSelections,
          {
            projectId: action.workspaceId,
            worktreeId: action.worktreeId,
            chatId: action.chatId,
          },
        );
    }
    if (inheritedPlugins && hasAnySelections(inheritedPlugins))
      resources.push({
        owner: undefined,
        requiresHostAuthorization: true,
        capabilities: { selections: inheritedPlugins },
      });
    if (action.type === 'worktree_pipeline') {
      const storedSource =
        action.pipelineSource === 'bundled' ||
        action.pipelineSource === 'user' ||
        action.pipelineSource === 'curated'
          ? action.pipelineSource
          : undefined;
      let stored =
        storedSource === 'bundled' || storedSource === 'user'
          ? pipelineStore.getStoredPipelineBySource(
              storedSource,
              action.pipelineId,
            )
          : undefined;
      if (storedSource === 'curated') {
        const { getManagedCuratedPipeline } =
          await import('../pipelines/curated-pipeline-catalog');
        stored = {
          success: true,
          data: await getManagedCuratedPipeline(action.pipelineId),
        };
      }
      if (storedSource && stored?.success && stored.data)
        resources.push(
          ...pipelineContextResources(
            stored.data.content,
            stored.data.info.owner ??
              (stored.data.info.source === 'bundled' ||
              stored.data.info.source === 'curated'
                ? { type: 'system' }
                : stored.data.info.source === 'user'
                  ? { shareScope: 'private' }
                  : undefined),
            {
              cwd: process.cwd(),
              pipelineId: stored.data.info.id,
              pipelinePreferenceLocator: {
                type: 'stored',
                source: storedSource,
                value: stored.data.info.id,
              },
              pluginCollectionPreferences: action.pluginCollectionPreferences,
              modelAliasPreferences: action.modelAliasPreferences,
            },
            stored.data.info.remoteId ?? stored.data.info.id,
            // Children need the actual execution cwd, available at the resolved dispatch gate.
          ).filter((resource) => !resource.childPipeline),
        );
      else if (action.pipelineSource === 'shared' && action.sharedPipeline) {
        try {
          const detail = await getSharedPipelineForExecutionContext(
            action.sharedPipeline.remoteId,
          );
          resources.push(
            ...pipelineContextResources(
              parsePipelineText(detail.rawPipeline),
              detail.owner ?? { shareScope: detail.shareScope },
              {
                cwd: process.cwd(),
                pipelinePreferenceLocator: {
                  type: 'shared',
                  value: `${action.sharedPipeline.serverId}:${action.sharedPipeline.remoteId}`,
                },
                ...pipelineExecutionPreferences(action),
              },
              detail.id,
            ).filter((resource) => !resource.childPipeline),
          );
        } catch (error) {
          sharedPipelineReadFailure = {
            error,
            decision: await sharedPipelineReadDecision(error),
          };
        }
      } else if (
        action.pipelineSource !== 'project' &&
        action.pipelineSource !== undefined
      )
        resources.push({ owner: undefined });
    }
    const executionState = await resumeExecutionState(action);
    if (action.type === 'pipeline_execution_resume')
      resources.push(
        ...persistedPipelineContextResources(
          executionState,
          pipelineStore.getStoredPipelineBySource,
        ),
      );
    const destination = isGlobalPipelineAutomationAction(action)
      ? { scope: 'global' as const }
      : automationRunDestination(action, executionState);
    return {
      resources,
      destination,
      ...(sharedPipelineReadFailure ? { sharedPipelineReadFailure } : {}),
    };
  }

  /**
   * `savedContext` is the binding of an automation that stays on and keeps
   * it; otherwise the check starts from the selected context, as turning it
   * on does.
   */
  /** The service's own Orchestrator windows, when it was given all of them. */
  private appAdvisorSurfaces(): AppAdvisorToolRuntimeSurfaces | undefined {
    const surfaces = this.surfaces;
    return surfaces?.getAppAdvisorWindow && surfaces.openAppAdvisorWindow
      ? {
          getMainWindow: surfaces.getMainWindow,
          getAppAdvisorWindow: surfaces.getAppAdvisorWindow,
          openAppAdvisorWindow: surfaces.openAppAdvisorWindow,
          ensureAppAdvisorWindow: surfaces.ensureAppAdvisorWindow,
        }
      : undefined;
  }

  /**
   * Why a converted automation's chat action couldn't be saved natively
   * (CAN-4551): the action's own validation and its target, checked as its
   * native save would be, before the owned pipeline is regenerated for it.
   */
  async nativeTargetRefusal(
    activity: ScheduledActivity,
  ): Promise<string | null> {
    return (
      validateAutomationActionForWrite(activity.action) ??
      this.targetCompatibilityRefusal(activity, activity.executionContext)
    );
  }

  /**
   * CAN-5782: a workflow schedule saves a global `worktree_pipeline`, whose
   * check reads only the pipeline and its owner. Where it runs is in its
   * inputs: checked here as the chat action they stand for would be, or, for
   * a pipeline that doesn't convert back, input by input, so a stale task or
   * chat is refused at Save instead of failing every run.
   */
  private async workflowScheduleDestinationRefusal(
    activity: ScheduledActivity,
    activities: readonly ScheduledActivity[],
  ): Promise<string | null> {
    const { action } = activity;
    const pipelineId = scheduledUserPipelineId(activity);
    if (
      action.type !== 'worktree_pipeline' ||
      pipelineId === undefined ||
      !isWorkflowPagePipeline(activities, pipelineId)
    )
      return null;
    const stored = pipelineStore.getStoredPipelineBySource('user', pipelineId);
    // A pipeline that can't be read fails its runs with its own error.
    if (!stored.success || !stored.data) return null;
    const inputs = action.inputs ?? {};
    const chat = ownedPipelineToChatAction(
      stored.data.content,
      inputs,
      isCoworkWorkspace,
      ownedChatPipelineState(action, pipelineId),
    );
    if (chat) return this.nativeTargetRefusal({ ...activity, action: chat });
    const projectId = inputs.project_id;
    if (!projectId) return null;
    const { items } = await readAllSidebarItems();
    const workspace = items.find((item) => item.id === projectId);
    if (!workspace)
      return 'Choose an accessible project in the automation editor.';
    const taskId = inputs.task_id;
    if (!taskId) return null;
    try {
      await this.assertPipelineDestinationExists(workspace, {
        kind: 'task',
        workspaceId: projectId,
        taskId,
      });
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    const chatId = inputs.chat_id;
    if (!chatId || workspace.type === 'cowork') return null;
    const tabs = await readChatTabsFile(projectId, taskId);
    return tabs.tabs.some((tab) => tab.id === chatId)
      ? null
      : 'Choose an existing chat in the automation editor.';
  }

  private async targetCompatibilityRefusal(
    activity: ScheduledActivity,
    savedContext?: string,
  ): Promise<string | null> {
    try {
      await this.assertTargetCompatibility(activity, false, savedContext);
      return null;
    } catch (error) {
      const decision = await sharedPipelineReadDecision(error);
      if (decision) return backgroundExecutionDeniedMessage(decision.reason);
      return error instanceof SharedPipelinePinMismatchError
        ? 'Review the selected workflow before saving this automation.'
        : error instanceof Error
          ? error.message
          : 'Edit this automation and choose an accessible target.';
    }
  }

  private async assertTargetCompatibility(
    activity: ScheduledActivity,
    running = false,
    savedContext?: string,
  ): Promise<void> {
    const action = activity.action;
    if (action.type === 'pipeline_execution_resume') {
      const result = resolveLocalAutomationTargetRequirement(
        action,
        undefined,
        activity.targetRequirement,
      );
      if (result.status === 'error') throw new Error(result.error);
      return;
    }
    const pipelineTarget =
      action.type === 'worktree_pipeline'
        ? resolveAutomationPipelineTarget(action)
        : undefined;
    if (action.type === 'worktree_pipeline' && !pipelineTarget)
      throw new Error(
        validateAutomationAction(action) ??
          'Edit this automation and choose where the workflow runs.',
      );
    if (
      action.type === 'worktree_pipeline' &&
      pipelineTarget?.kind === 'global'
    )
      return this.assertGlobalPipelineCompatibility(activity, action, running);
    let kind: unknown;
    let workspaceId: string | undefined;
    let pipelineCwd: string | undefined;
    if (
      action.type === 'app_advisor_prompt' ||
      (action.type === 'worktree_session_prompt' &&
        action.workspaceId === APP_ADVISOR_PROJECT_ID)
    ) {
      kind = 'app_advisor';
    } else {
      workspaceId =
        action.type === 'standalone_prompt'
          ? resolveCoworkWorkspaceId(action.chatProjectId)
          : action.type === 'worktree_session_prompt' &&
              action.workspaceId === STANDALONE_CHAT_PROJECT_ID
            ? resolveCoworkWorkspaceId(action.worktreeId)
            : action.type === 'worktree_pipeline'
              ? pipelineAutomationWorkspaceId(action)
              : action.workspaceId;
      const { items } = await readAllSidebarItems();
      const workspace = items.find((item) => item.id === workspaceId);
      if (
        !workspace &&
        (action.type === 'standalone_prompt' ||
          action.type === 'worktree_session_prompt')
      ) {
        let legacyTargetExists = false;
        try {
          const raw: unknown = JSON.parse(
            await readFile(getChatProjectsFilePath(), 'utf8'),
          );
          legacyTargetExists =
            isRecord(raw) &&
            raw.version === 1 &&
            Array.isArray(raw.projects) &&
            raw.projects.some(
              (project: unknown) =>
                isRecord(project) &&
                project.id === workspaceId &&
                typeof project.name === 'string' &&
                typeof project.createdAt === 'string',
            );
        } catch {
          // An unreadable legacy index is not evidence of a valid target.
        }
        if (!legacyTargetExists) {
          throw new Error(
            'Choose an accessible project in the automation editor.',
          );
        }
        kind = 'cowork';
      } else if (!workspace)
        throw new Error(
          'Choose an accessible project in the automation editor.',
        );
      else {
        kind = workspace.type;
        // Caller-provided project kinds are ignored. The owner is a workspace
        // binding, not ResourceOwner provenance, and an automation binds to its
        // target's owner (CAN-3598), so the selected context does not gate the
        // target here. Sidebar owners are already normalized, so a malformed
        // binding reads as Personal there; check the persisted read instead.
        // At run time resolveBackgroundWorkspaceTarget refuses it the same way.
        if (!running && resourceContextEnabled()) {
          const { readWorkspaceConfigDetailed } =
            await import('../lib/workspace-persistence');
          if ((await readWorkspaceConfigDetailed(workspace.id)).ownerMalformed)
            throw new ResourceContextUnavailableError('unknown-provenance');
        }
        // Only an explicit destination has anything more to check.
        if (
          pipelineTarget?.kind === 'task' ||
          (pipelineTarget?.kind === 'new_worktree' && pipelineTarget.explicit)
        )
          await this.assertPipelineDestinationExists(workspace, pipelineTarget);
        if (workspace.type !== 'cowork') {
          const worktreeId =
            action.type === 'worktree_session_prompt'
              ? action.worktreeId
              : action.type === 'worktree_prompt'
                ? (action.existingWorktreeId ?? action.baseWorktreeId)
                : action.type === 'worktree_pipeline'
                  ? action.baseWorktreeId
                  : undefined;
          if (
            worktreeId &&
            !workspace.worktrees.some((entry) => entry.id === worktreeId)
          ) {
            throw new Error(
              'Choose an existing chat or worktree in the automation editor.',
            );
          }
        }
        const root = projectRootPipelineCwd(
          workspace,
          action.type === 'worktree_pipeline' ? action.repoId : undefined,
        );
        // A project-folder run uses the configured source folder; other runs
        // keep checking the reference checkout.
        pipelineCwd =
          'sourceRepoPath' in root
            ? pipelineTarget?.kind === 'project'
              ? root.sourceRepoPath
              : await resolveWorkspaceReferenceRepoPath(root.sourceRepoPath)
            : root.cwd;
        if (pipelineTarget?.kind === 'project' && !pipelineCwd)
          throw new Error(PIPELINE_TARGET_PROJECT_ROOT_REQUIRED_ERROR);
      }
    }
    const context = projectKindToTargetContext(kind);
    if (!context)
      throw new Error('Choose an accessible project in the automation editor.');
    const implied = resolveLocalAutomationTargetRequirement(
      action,
      kind,
      activity.targetRequirement,
    );
    if (implied.status === 'error') throw new Error(implied.error);
    if (!implied.contexts.includes(context))
      throw new Error(automationTargetMismatchMessage(implied.contexts));
    if (action.type === 'worktree_session_prompt') {
      const tabs = await readChatTabsFile(
        action.workspaceId,
        action.worktreeId,
      );
      if (!tabs.tabs.some((tab) => tab.id === action.chatId)) {
        throw new Error('Choose an existing chat in the automation editor.');
      }
    }
    if (action.type === 'worktree_pipeline') {
      let pipeline: Pipeline;
      if (action.pipelineSource === 'shared') {
        pipeline = await this.readSharedAutomationPipeline(action, running);
      } else {
        const checkoutId =
          pipelineTarget?.kind === 'task' && kind !== 'cowork'
            ? pipelineTarget.taskId
            : action.baseWorktreeId;
        const cwd =
          checkoutId && workspaceId
            ? this.resolveWorktreeCwd(workspaceId, checkoutId, action.repoId)
            : (pipelineCwd ?? '');
        const selection = await this.resolvePipelineSelection(action, cwd);
        pipeline = selection.pipeline;
        if (running && workspaceId)
          await this.authorizeResolvedPipeline(
            activity.id,
            activity.executionContext,
            selection,
            cwd,
            workspaceId,
            pipelineExecutionPreferences(action),
          );
        else {
          // Authorize a stored pipeline in the context the automation runs in:
          // its saved binding while its target still runs there, otherwise the
          // context that owns its target (CAN-3598), never just the selected
          // one. Like turning it on, this leaves the target, children,
          // caller-authored project files, and checks that cannot complete to
          // each run.
          let refusal: string | null = null;
          try {
            const fromContext = backgroundExecutionContextEnabled()
              ? (savedContext ?? (await captureBackgroundExecutionContext()))
              : undefined;
            if (fromContext !== undefined && !selection.pipelineFilePath) {
              const bindingContext = await bindingContextForAction(
                action,
                fromContext,
              );
              refusal = await this.backgroundRefusalMessage(
                action,
                bindingContext,
                await authorizeBackgroundExecution(
                  bindingContext,
                  resolvedPipelineContextResources(
                    selection,
                    cwd,
                    pipelineExecutionPreferences(action),
                  ).filter((resource) => !resource.childPipeline),
                  { scope: 'global' },
                ),
              );
            }
          } catch (error) {
            logMainProcessError(
              'Failed to check an automation pipeline before saving:',
              error,
            );
            refusal = null;
          }
          if (refusal) throw new Error(refusal);
        }
      }
      if (!getTriggerTypes(pipeline.on).includes('dispatch')) {
        throw new Error('Workflow does not support dispatch triggers.');
      }
      const resolved = resolveLocalAutomationTargetRequirement(
        action,
        kind,
        activity.targetRequirement,
        { status: 'resolved', scopes: pipeline.scope },
      );
      if (resolved.status !== 'resolved')
        throw new Error(
          resolved.status === 'error'
            ? resolved.error
            : 'Verify the selected workflow in the automation editor.',
        );
      if (!resolved.contexts.includes(context))
        throw new Error(automationTargetMismatchMessage(resolved.contexts));
    }
  }

  /** The trusted current definition of a shared pipeline, checked against its pin. */
  private async readSharedAutomationPipeline(
    action: PipelineAutomationAction,
    running: boolean,
  ): Promise<Pipeline> {
    if (!action.sharedPipeline)
      throw new Error(
        'Verify the selected workflow before saving or enabling this automation.',
      );
    const detail = await getSharedPipelineForExecutionContext(
      action.sharedPipeline.remoteId,
    );
    // Authored and legacy bindings may be unpinned. Their current trusted
    // definition still has to satisfy the target policy.
    if (action.sharedPipeline.installPin) {
      try {
        assertSharedPipelineMatchesAutomationInstallPin(
          detail,
          action.sharedPipeline.installPin,
        );
      } catch (error) {
        if (running && error instanceof SharedPipelinePinMismatchError) {
          throw new SharedPipelineReviewRequiredError(
            action.sharedPipeline.remoteId,
            action.sharedPipeline.installPin,
            action.pipelineName,
          );
        }
        throw error;
      }
    }
    return parsePipelineText(detail.rawPipeline);
  }

  /**
   * The project destination still names something that exists: a task in
   * this project (a worktree on a code project, a Work Entry on a cowork
   * one), and never a new worktree on a cowork project. Read from main's
   * own sidebar and Work Entry stores, never from caller-supplied facts.
   */
  private async assertPipelineDestinationExists(
    workspace: SidebarItem,
    target: Exclude<ResolvedAutomationPipelineTarget, { kind: 'global' }>,
  ): Promise<void> {
    if (
      workspace.type === 'cowork' &&
      target.kind === 'new_worktree' &&
      target.explicit
    )
      throw new Error(PIPELINE_TARGET_NEW_WORKTREE_COWORK_ERROR);
    if (target.kind !== 'task') return;
    const exists =
      workspace.type === 'cowork'
        ? (await listWorkEntryIds(workspace.id)).includes(target.taskId)
        : workspace.worktrees.some((entry) => entry.id === target.taskId);
    if (!exists) throw new Error(PIPELINE_TARGET_TASK_MISSING_ERROR);
  }

  /**
   * Checks for a pipeline automation with no project: a valid owner the
   * account may run in, no target requirement, a pipeline resolved with no
   * project discovery whose scopes admit a global run, a user pipeline from
   * the same owner, and literal run-pipeline targets inside that owner.
   */
  private async assertGlobalPipelineCompatibility(
    activity: ScheduledActivity,
    action: PipelineAutomationAction,
    running: boolean,
  ): Promise<void> {
    const owner = await globalAutomationOwner(activity.executionContext);
    if ('error' in owner) throw new Error(owner.error);
    if (activity.targetRequirement !== undefined)
      throw new Error(PIPELINE_TARGET_REQUIREMENT_GLOBAL_ERROR);
    let pipeline: Pipeline;
    if (action.pipelineSource === 'shared') {
      pipeline = await this.readSharedAutomationPipeline(action, running);
    } else {
      const selection = await this.resolvePipelineSelection(action, '');
      pipeline = selection.pipeline;
      if (selection.pipelinePreferenceLocator?.source === 'user') {
        // An owner that can't be read refuses, as the run's owner check does.
        if (!isPipelineLocalMetadataReadable())
          throw new Error(
            backgroundExecutionDeniedMessage('unknown-provenance'),
          );
        if (
          (await getUserPipelineOwner(
            selection.pipelinePreferenceLocator.value,
          )) !== owner.context
        )
          throw new Error(PIPELINE_TARGET_OWNER_MISMATCH_ERROR);
      }
      // The run's final authorization happens in the main start path once its
      // scratch folder exists; only the definition is checked here.
      if (!running && backgroundExecutionContextEnabled()) {
        let refusal: string | null = null;
        try {
          refusal = await this.backgroundRefusalMessage(
            action,
            owner.context,
            await authorizeBackgroundExecution(
              owner.context,
              resolvedPipelineContextResources(
                selection,
                '',
                pipelineExecutionPreferences(action),
              ).filter((resource) => !resource.childPipeline),
              { scope: 'global' },
            ),
          );
        } catch (error) {
          logMainProcessError(
            'Failed to check an automation pipeline before saving:',
            error,
          );
        }
        if (refusal) throw new Error(refusal);
      }
    }
    if (!getTriggerTypes(pipeline.on).includes('dispatch'))
      throw new Error('Workflow does not support dispatch triggers.');
    const resolved = resolveLocalAutomationTargetRequirement(
      action,
      undefined,
      undefined,
      { status: 'resolved', scopes: pipeline.scope },
    );
    if (resolved.status !== 'resolved')
      throw new Error(
        resolved.status === 'error'
          ? resolved.error
          : 'Verify the selected workflow in the automation editor.',
      );
    const ownerTargetRefusal = await validatePipelineOwnerTargetsOnSave(
      pipeline,
      owner.context,
    );
    if (ownerTargetRefusal) throw new Error(ownerTargetRefusal);
  }

  private assertResolvedPipelineTarget(
    activity: Pick<ScheduledActivity, 'action' | 'targetRequirement'>,
    kind: unknown,
    pipeline: Pipeline,
  ): void {
    const context = projectKindToTargetContext(kind);
    const resolved = resolveLocalAutomationTargetRequirement(
      activity.action,
      kind,
      activity.targetRequirement,
      { status: 'resolved', scopes: pipeline.scope },
    );
    if (resolved.status !== 'resolved')
      throw new Error(
        resolved.status === 'error'
          ? resolved.error
          : 'Verify the selected workflow in the automation editor.',
      );
    if (!context || !resolved.contexts.includes(context))
      throw new Error(automationTargetMismatchMessage(resolved.contexts));
  }

  /**
   * Refusal copy when turning `activity` on in `executionContext` would only
   * have its first run denied (plugins, model, pipeline or destination), or
   * `null`. A check that cannot complete (offline, a transient cloud error)
   * does not block turning it on: every run checks again.
   */
  private async enablingBackgroundRefusal(
    activity: ScheduledActivity,
    executionContext: string | undefined,
  ): Promise<string | null> {
    if (!backgroundExecutionContextEnabled()) return null;
    let decision: ResourceContextDecision;
    try {
      const { resources, destination, sharedPipelineReadFailure } =
        await this.backgroundAuthorizationInput(activity);
      // A failed shared pipeline read refuses only with a verdict (access
      // removed); a read that could not finish leaves the next run to check.
      if (sharedPipelineReadFailure) {
        if (!sharedPipelineReadFailure.decision) return null;
        decision = sharedPipelineReadFailure.decision;
      } else {
        decision = await authorizeBackgroundExecution(
          executionContext,
          resources,
          destination,
        );
      }
    } catch {
      return null;
    }
    return this.backgroundRefusalMessage(
      activity.action,
      executionContext,
      decision,
    );
  }

  /**
   * Refusal copy for a background authorization `decision` in
   * `executionContext`, or `null` when it allows the automation or could not
   * complete.
   */
  private async backgroundRefusalMessage(
    action: AutomationAction,
    executionContext: string | undefined,
    decision: ResourceContextDecision,
  ): Promise<string | null> {
    if (decision.allow || decision.transient) return null;
    const mismatch =
      decision.reason === 'context-mismatch'
        ? await describeAutomationContextMismatch(
            action,
            executionContext,
          ).catch((): null => null)
        : null;
    return backgroundExecutionDeniedMessage(decision.reason, {
      ...(mismatch ? { mismatch } : {}),
      ...(decision.subject ? { subject: decision.subject } : {}),
    });
  }

  /**
   * Records why turning `activity` on was refused, for main.log and App
   * Advisor. Error level on purpose: the user's action failed. Logs
   * identifiers and the refusal copy, which may name the target, but no
   * prompt text or action payload.
   */
  private logEnableRefusal(activity: ScheduledActivity, refusal: string): void {
    logMainProcessError('Automation enable refused', {
      activityId: activity.id,
      refusal,
      ...(activity.installedFrom?.remoteId !== undefined
        ? { remoteId: activity.installedFrom.remoteId }
        : {}),
    });
  }

  /**
   * A run was refused because its target is in another context. When the
   * target moved (conversion or move back) from the context this automation
   * is bound to, and the account may run in the new owner, move this
   * workspace's background items with it and return the new binding.
   */
  private async followMovedTarget(
    activityId: string,
    runId: string,
    activity: ScheduledActivity,
  ): Promise<string | null> {
    const change = await resolveMovedTargetOwnershipChange(
      activity.action,
      activity.executionContext,
    ).catch((): null => null);
    if (!change) return null;
    const nextContext = serializeWorkspaceContext(change.to);
    const { getBackgroundExecutionContextRebinder } =
      await import('../services/background-execution-rebinding');
    // Other items are best effort; this automation is rebound below anyway.
    await getBackgroundExecutionContextRebinder()
      .rebindWorkspace(change, 'runtime-mismatch')
      .catch((error: unknown): void => {
        logMainProcessError(
          'Failed to move background items with a moved automation target:',
          error,
        );
      });
    await this.enqueueMutation(async (): Promise<void> => {
      const file = await this.ensureFile();
      const run = file.recentRuns.find((entry) => entry.id === runId);
      if (run) run.executionContext = nextContext;
      const stored = file.activities.find((entry) => entry.id === activityId);
      if (stored) stored.executionContext = nextContext;
      await this.persistAndNotify(file);
    });
    return nextContext;
  }

  /** Internal impact scan; callers must redact activities outside the active context. */
  async listActivitiesForSharedPipelineImpact(): Promise<
    Array<{
      activity: ScheduledActivity;
      visibleInCurrentContext: boolean;
    }>
  > {
    const file = await this.ensureFile();
    if (!resourceContextEnabled()) {
      return file.activities.map((activity) => ({
        activity: cloneActivity(activity),
        visibleInCurrentContext: true,
      }));
    }
    const visibleIds = new Set(
      (await contextSnapshot(file)).activities.map((activity) => activity.id),
    );
    return file.activities.map((activity) => ({
      activity: cloneActivity(activity),
      visibleInCurrentContext: visibleIds.has(activity.id),
    }));
  }

  async listRuns(
    request: AutomationRunHistoryRequest,
    callerContext?: WorkspaceContext,
  ): Promise<AutomationRunHistoryResponse> {
    if (resourceContextEnabled()) {
      const file = await this.ensureFile();
      const activity = file.activities.find(
        (entry) => entry.id === request.activityId,
      );
      if (activity) await assertAutomationContext(activity, callerContext);
      else
        await assertInstalledResourceContext(
          'automations',
          request.activityId,
          (remoteId) => getSharedAutomation(remoteId, callerContext),
          callerContext,
        );
    }
    return this.archive.readRuns(request.activityId, {
      ...(request.cursor ? { cursor: request.cursor } : {}),
      ...(request.limit !== undefined ? { limit: request.limit } : {}),
      ...(request.statuses ? { statuses: request.statuses } : {}),
      ...(request.triggers ? { triggers: request.triggers } : {}),
    });
  }

  /**
   * `trusted` carries facts only main may record, never the request body:
   * an agent marker object sets it, `null` clears it, `undefined` leaves it.
   */
  async create(
    request: AutomationCreateRequest,
    trusted: AutomationTrustedCreate = {},
  ): Promise<AutomationMutationResponse> {
    const validationError = validateAutomationCreateRequest(request);
    if (validationError) return { ok: false, error: validationError };

    return this.enqueueMutation(async () => {
      if (trusted.authorize && !(await trusted.authorize()))
        return { ok: false, error: 'Automation creation was not authorized.' };
      if (request.action.type === 'standalone_prompt')
        await assertCoworkWorkspaceRootPresent(request.action.chatProjectId);
      if (request.action.type === 'worktree_session_prompt')
        await assertCoworkChatRootPresent(
          request.action.workspaceId,
          request.action.worktreeId,
        );
      const releaseTarget =
        request.enabled === false
          ? (): void => undefined
          : reserveAutomationTargetStart(request.action);
      try {
        const file = await this.ensureFile();
        const resumeAction =
          request.action.type === 'pipeline_execution_resume'
            ? request.action
            : null;
        if (resumeAction) {
          const requestedIds = [...resumeAction.statusReasonIds].sort();
          const existing = file.activities.find((candidate) => {
            if (
              !candidate.enabled ||
              candidate.action.type !== 'pipeline_execution_resume' ||
              candidate.action.executionId !== resumeAction.executionId ||
              candidate.action.provider !== resumeAction.provider
            ) {
              return false;
            }
            const candidateIds = [...candidate.action.statusReasonIds].sort();
            return (
              requestedIds.length === candidateIds.length &&
              requestedIds.every((id, index) => id === candidateIds[index])
            );
          });
          if (existing) {
            return {
              ok: true,
              activity: cloneActivity(existing),
              created: false,
            };
          }
        }
        const now = new Date();
        const timestamp = now.toISOString();
        const dependencies = request.dependencies
          ? normalizeAutomationDependencies(request.dependencies)
          : undefined;
        const activity: ScheduledActivity = {
          version: 1,
          id: randomUUID(),
          name: request.name.trim(),
          enabled: request.enabled !== false,
          schedule: request.schedule,
          action: normalizeAutomationAction(request.action),
          ...(request.targetRequirement
            ? { targetRequirement: request.targetRequirement }
            : {}),
          ...(request.ifCommand && request.ifCommand.trim().length > 0
            ? { ifCommand: request.ifCommand }
            : {}),
          ...(request.installedFrom
            ? { installedFrom: request.installedFrom }
            : {}),
          ...(dependencies ? { dependencies } : {}),
          ...(trusted.agentAuthor ? { agentAuthor: trusted.agentAuthor } : {}),
          createdAt: timestamp,
          updatedAt: timestamp,
          failureCount: 0,
          ...(trusted.agentScheduledSend
            ? {
                agentScheduledSend: structuredClone(trusted.agentScheduledSend),
              }
            : {}),
        };
        // A pipeline with no project runs as an explicit owner, resolved before
        // its target is checked and never rebound to a destination.
        const globalOwner = isGlobalPipelineAutomationAction(activity.action)
          ? await automationCreateOwner(
              trusted.owner ?? request.executionContext,
            )
          : undefined;
        if (globalOwner) {
          if ('error' in globalOwner)
            return { ok: false, error: globalOwner.error };
          activity.executionContext = globalOwner.context ?? 'personal';
        }
        // CAN-5782: a single-schedule workflow page takes no second schedule.
        const scheduledPipeline = scheduledUserPipelineId(activity);
        const addedRefusal =
          scheduledPipeline === undefined
            ? undefined
            : addedScheduleRefusal(
                file.activities,
                undefined,
                scheduledPipeline,
              );
        if (addedRefusal) return { ok: false, error: addedRefusal };
        const destinationRefusal =
          await this.workflowScheduleDestinationRefusal(
            activity,
            file.activities,
          );
        if (destinationRefusal) return { ok: false, error: destinationRefusal };
        const targetRefusal = await this.targetCompatibilityRefusal(activity);
        if (targetRefusal) return { ok: false, error: targetRefusal };
        // Every automation gets an owner while organization projects are on,
        // whether or not it starts enabled.
        const owner =
          globalOwner ??
          (await automationCreateOwner(request.executionContext));
        if ('error' in owner) return { ok: false, error: owner.error };
        const context = owner.context;
        if (context !== undefined && !globalOwner) {
          const bindingContext = await bindingContextForAction(
            activity.action,
            context,
          );
          // Refuse before persisting: the first run would only be denied.
          if (activity.enabled) {
            const refusal = await automationContextRefusal(
              activity.action,
              bindingContext,
              'enable',
            );
            if (refusal) return { ok: false, error: refusal };
          }
          activity.executionContext = bindingContext;
        }
        // Before preflight, so a public install is checked as the owner it is saved with.
        applyPublicInstallContext(activity, context);
        if (activity.enabled) {
          const refusal = await this.enablingBackgroundRefusal(
            activity,
            activity.executionContext,
          );
          if (refusal) return { ok: false, error: refusal };
        }
        await assertAutomationContext(activity);
        activity.nextRunAt = nextRunForEnabledActivity(activity, file, now);
        file.activities.push(activity);
        await this.persistAndNotify(file);
        if (scheduledPipeline !== undefined)
          markSharedWorkflowPage(file.activities, scheduledPipeline);
        registerAutomationInstall(activity);
        return { ok: true, activity: cloneActivity(activity), created: true };
      } finally {
        releaseTarget();
      }
    });
  }

  async update(
    request: AutomationUpdateRequest,
    authorize?: (activity: ScheduledActivity) => Promise<boolean>,
    callerContext?: WorkspaceContext,
    trusted: AutomationTrustedUpdate = {},
  ): Promise<AutomationMutationResponse> {
    if (!isRecord(request) || typeof request.id !== 'string') {
      return { ok: false, error: 'Automation id is required.' };
    }
    if (request.name !== undefined && request.name.trim() === '') {
      return {
        ok: false,
        error: 'Automation name must be a non-empty string.',
      };
    }
    if (request.enabled !== undefined && typeof request.enabled !== 'boolean') {
      return { ok: false, error: 'Automation enabled must be a boolean.' };
    }
    if (request.schedule !== undefined) {
      const scheduleError = validateAutomationTrigger(request.schedule);
      if (scheduleError) return { ok: false, error: scheduleError };
    }
    if (request.action !== undefined) {
      const actionError = validateAutomationActionForWrite(request.action);
      if (actionError) return { ok: false, error: actionError };
    }
    if (request.ifCommand !== undefined) {
      const ifCommandError = validateAutomationIfCommand(request.ifCommand);
      if (ifCommandError) return { ok: false, error: ifCommandError };
    }
    if (
      request.targetRequirement !== undefined &&
      request.targetRequirement !== null
    ) {
      const validation = validateSharedAutomationTargetRequirement(
        request.targetRequirement,
      );
      if (!validation.ok) return { ok: false, error: validation.error };
    }
    const dependenciesError = validateAutomationDependencies(
      request.dependencies,
      { allowNull: true },
    );
    if (dependenciesError) return { ok: false, error: dependenciesError };

    // A regenerated pipeline stays only once the activity that runs it is
    // written; a refusal or failure before then puts it back (CAN-5465).
    const regeneration: { saved?: OwnedPipelineReplacement; written: boolean } =
      { written: false };
    const rollBackUnwritten = async (): Promise<void> => {
      if (regeneration.saved && !regeneration.written)
        await rollBackOwnedPipeline(regeneration.saved);
    };
    const mutate = async (): Promise<AutomationMutationResponse> => {
      const file = await this.ensureFile();
      const activity = file.activities.find((entry) => entry.id === request.id);
      if (!activity) return { ok: false, error: 'Activity not found.' };
      if (authorize && !(await authorize(cloneActivity(activity))))
        return { ok: false, error: 'Activity not found.' };
      // CAN-6183: the server record is authoritative for a cloud schedule,
      // and a location this version doesn't know is never rewritten here.
      if (!firesLocally(activity)) return locationRefusal(activity);
      // Only session prompts carry the agent sender; other types would drop it.
      if (
        activity.agentScheduledSend &&
        request.action &&
        request.action.type !== 'worktree_session_prompt'
      )
        return {
          ok: false,
          error:
            "An agent-scheduled message can't become another kind of automation. Delete it and create a new one.",
        };
      if (
        trusted.regeneratesOwnedPipeline &&
        isActivityRunning(file, activity.id)
      )
        return { ok: false, error: ACTIVITY_RUNNING_RETRY };
      await assertAutomationContext(activity, callerContext);
      // Saved before the checks below, which read the pipeline it writes.
      if (trusted.regeneratesOwnedPipeline) {
        try {
          regeneration.saved = await trusted.regeneratesOwnedPipeline();
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
        if (
          request.action === undefined ||
          !isDeepStrictEqual(
            normalizeAutomationAction(regeneration.saved.action),
            normalizeAutomationAction(request.action),
          )
        )
          return {
            ok: false,
            error: 'The workflow saved isn’t the one this automation runs.',
          };
      }
      const turnsOn = request.enabled === true && !activity.enabled;
      let effectiveEnabled = request.enabled ?? activity.enabled;
      const normalizedRequestedAction = request.action
        ? normalizeAutomationAction(request.action)
        : undefined;
      // CAN-5782: retargeting onto a single-schedule workflow page that
      // already has a schedule is refused, as a create is.
      const retargetedPipeline =
        normalizedRequestedAction === undefined
          ? undefined
          : scheduledUserPipelineId({ action: normalizedRequestedAction });
      const startsTargeting =
        retargetedPipeline !== scheduledUserPipelineId(activity)
          ? retargetedPipeline
          : undefined;
      if (startsTargeting !== undefined) {
        const refusal = addedScheduleRefusal(
          file.activities,
          activity.id,
          startsTargeting,
        );
        if (refusal) return { ok: false, error: refusal };
      }
      const effectiveAction = normalizedRequestedAction ?? activity.action;
      const sharedUpdateRebinds =
        request.installedFrom !== undefined &&
        normalizedRequestedAction !== undefined &&
        automationTargetBindingChanged(activity.action, effectiveAction);
      if (sharedUpdateRebinds) effectiveEnabled = false;
      const candidate = cloneActivity(activity);
      candidate.action = effectiveAction;
      candidate.enabled = effectiveEnabled;
      // CAN-5782: a schedule whose run values change is checked where they
      // now point.
      if (
        normalizedRequestedAction !== undefined &&
        !isDeepStrictEqual(
          scheduleInputsOf(normalizedRequestedAction),
          scheduleInputsOf(activity.action),
        )
      ) {
        const refusal = await this.workflowScheduleDestinationRefusal(
          candidate,
          file.activities,
        );
        if (refusal) return { ok: false, error: refusal };
      }
      // A pipeline with no project keeps the owner it was saved with, also
      // when it is converted from a project destination.
      const effectiveGlobal = isGlobalPipelineAutomationAction(effectiveAction);
      if (effectiveGlobal) candidate.executionContext ??= 'personal';
      if (request.targetRequirement !== undefined) {
        if (
          activity.installedFrom &&
          !request.installedFrom &&
          !trusted.restoresImpliedTargetRequirement
        ) {
          return {
            ok: false,
            error:
              'Apply the shared update to replace this automation target requirement.',
          };
        }
        if (request.targetRequirement === null) {
          delete candidate.targetRequirement;
          if (activity.targetRequirement !== undefined)
            candidate.targetRequirementCleared = true;
        } else {
          candidate.targetRequirement = request.targetRequirement;
          delete candidate.targetRequirementCleared;
        }
      }
      if (
        request.action !== undefined ||
        request.targetRequirement !== undefined ||
        request.enabled === true
      ) {
        // One that stays on at the same target keeps the context it runs in;
        // one leaving "no project" is checked in the owner it keeps.
        const targetContext =
          !effectiveGlobal && isGlobalPipelineAutomationAction(activity.action)
            ? (activity.executionContext ?? 'personal')
            : activity.enabled &&
                effectiveEnabled &&
                sameAutomationDestination(
                  automationActionDestination(effectiveAction),
                  automationActionDestination(activity.action),
                )
              ? activity.executionContext
              : callerContext === undefined
                ? undefined
                : serializeWorkspaceContext(callerContext);
        const targetRefusal = await this.targetCompatibilityRefusal(
          candidate,
          targetContext,
        );
        if (targetRefusal) {
          if (turnsOn) this.logEnableRefusal(candidate, targetRefusal);
          return { ok: false, error: targetRefusal };
        }
      }
      const releaseTarget = effectiveEnabled
        ? reserveAutomationTargetStart(effectiveAction)
        : (): void => undefined;
      try {
        const scheduleActionOrNameChanged =
          request.schedule !== undefined ||
          request.action !== undefined ||
          request.name !== undefined;
        // Moving an automation that stays on to a different target binds it
        // again, just as turning it on does.
        const retargetsEnabledActivity =
          activity.enabled &&
          effectiveEnabled &&
          normalizedRequestedAction !== undefined &&
          !sameAutomationDestination(
            automationActionDestination(normalizedRequestedAction),
            automationActionDestination(activity.action),
          );
        // Leaving "no project" checks the new destination against the owner
        // it already has; ownership never moves silently.
        const keepsGlobalOwner =
          !effectiveGlobal &&
          normalizedRequestedAction !== undefined &&
          isGlobalPipelineAutomationAction(activity.action);
        // Turning an automation on rebinds it to the selected context, even
        // when create bound it already. A pipeline with no project keeps its
        // saved owner instead.
        const bindsExecutionContext =
          !effectiveGlobal &&
          (keepsGlobalOwner ||
            (request.enabled === true && !activity.enabled) ||
            retargetsEnabledActivity);
        const checksGlobalOwner =
          effectiveGlobal &&
          effectiveEnabled &&
          (turnsOn || normalizedRequestedAction !== undefined);
        const recapturesInstallContext =
          request.installedFrom !== undefined &&
          !isSameContextOwnedShare(
            activity.installedFrom,
            request.installedFrom,
          );
        // Capture before mutating the cached activity so a failure leaves it intact.
        const capturedContext =
          (bindsExecutionContext && !keepsGlobalOwner) ||
          (recapturesInstallContext &&
            isContextOwnedInstall(request.installedFrom))
            ? callerContext === undefined
              ? await captureBackgroundExecutionContext()
              : serializeWorkspaceContext(callerContext)
            : undefined;
        // Check the target this update leaves in place, before mutating.
        const bindingContext = keepsGlobalOwner
          ? (activity.executionContext ?? 'personal')
          : bindsExecutionContext && capturedContext !== undefined
            ? await bindingContextForAction(effectiveAction, capturedContext)
            : undefined;
        if (checksGlobalOwner) {
          const owner = await globalAutomationOwner(candidate.executionContext);
          const refusal =
            'error' in owner
              ? owner.error
              : await this.enablingBackgroundRefusal(candidate, owner.context);
          if (refusal) {
            if (turnsOn) this.logEnableRefusal(candidate, refusal);
            return { ok: false, error: refusal };
          }
        }
        if (bindingContext !== undefined) {
          const refusal = await automationContextRefusal(
            effectiveAction,
            bindingContext,
            retargetsEnabledActivity ? 'save' : 'enable',
          );
          if (refusal) {
            if (turnsOn) this.logEnableRefusal(activity, refusal);
            return { ok: false, error: refusal };
          }
        }
        if (bindsExecutionContext) {
          const candidate = cloneActivity(activity);
          candidate.action = effectiveAction;
          candidate.executionContext = bindingContext;
          if (
            request.installedFrom &&
            isContextOwnedInstall(request.installedFrom)
          ) {
            candidate.installedFrom = request.installedFrom;
            if (recapturesInstallContext)
              applyPublicInstallContext(candidate, capturedContext);
          }
          const refusal = await this.enablingBackgroundRefusal(
            candidate,
            bindingContext,
          );
          if (refusal) {
            if (turnsOn) this.logEnableRefusal(candidate, refusal);
            return { ok: false, error: refusal };
          }
        }
        // CAN-5782: nothing can refuse the update past here.
        if (
          trusted.releasesOwnedPipeline &&
          !trusted.releasesOwnedPipeline.release()
        )
          return { ok: false, error: WORKFLOW_RELEASE_FAILED };
        // What the cache goes back to when the write below fails.
        const stored = cloneActivity(activity);
        // Only after the refusal: a refused update records nothing.
        if (
          resourceContextEnabled() &&
          request.installedFrom &&
          !isContextOwnedInstall(request.installedFrom)
        ) {
          const detail = await getSharedAutomation(
            request.installedFrom.remoteId,
          );
          await recordResourceInstall('automations', detail, [activity.id]);
        }
        if (bindingContext !== undefined)
          activity.executionContext = bindingContext;
        else if (effectiveGlobal)
          activity.executionContext = candidate.executionContext;
        if (request.name !== undefined) activity.name = request.name.trim();
        if (request.enabled !== undefined || sharedUpdateRebinds) {
          activity.enabled = effectiveEnabled;
          this.enabledIntentRevisions.set(
            activity.id,
            (this.enabledIntentRevisions.get(activity.id) ?? 0) + 1,
          );
        }
        if (request.schedule !== undefined)
          activity.schedule = request.schedule;
        if (normalizedRequestedAction !== undefined) {
          const clearsSharedPipelineReview = sharedPipelineBindingChanged(
            activity.action,
            normalizedRequestedAction,
          );
          activity.action = normalizedRequestedAction;
          if (clearsSharedPipelineReview) {
            delete activity.sharedPipelineReview;
          }
        }
        if (request.targetRequirement !== undefined) {
          if (candidate.targetRequirement === undefined)
            delete activity.targetRequirement;
          else activity.targetRequirement = candidate.targetRequirement;
          if (candidate.targetRequirementCleared)
            activity.targetRequirementCleared = true;
          else delete activity.targetRequirementCleared;
        }
        if (request.ifCommand !== undefined) {
          if (request.ifCommand.trim().length > 0) {
            activity.ifCommand = request.ifCommand;
          } else {
            delete activity.ifCommand;
          }
        }
        if (request.dependencies !== undefined) {
          const dependencies =
            request.dependencies === null
              ? undefined
              : normalizeAutomationDependencies(request.dependencies);
          if (dependencies) activity.dependencies = dependencies;
          else delete activity.dependencies;
        }
        const previousInstalledFrom = activity.installedFrom;
        if (request.installedFrom !== undefined) {
          activity.installedFrom = request.installedFrom;
          if (recapturesInstallContext)
            applyPublicInstallContext(activity, capturedContext);
        }
        if (trusted.agentAuthor === null) delete activity.agentAuthor;
        else if (trusted.agentAuthor)
          activity.agentAuthor = trusted.agentAuthor;
        activity.updatedAt = new Date().toISOString();
        if (scheduleActionOrNameChanged || request.enabled !== undefined) {
          activity.nextRunAt = nextRunForEnabledActivity(
            activity,
            file,
            new Date(),
            { preserveExistingCronNextRun: false },
          );
        }
        if (!activity.enabled) {
          delete activity.nextRunAt;
        }
        try {
          await this.writeFile(file);
        } catch (error) {
          // Unwritten, the update isn't the activity: the cache keeps the
          // stored one, so a caller reading the list sees it didn't land.
          const index = file.activities.indexOf(activity);
          if (index !== -1) file.activities[index] = stored;
          trusted.releasesOwnedPipeline?.restore();
          throw error;
        }
        regeneration.written = true;
        if (startsTargeting !== undefined)
          markSharedWorkflowPage(file.activities, startsTargeting);
        this.surfaces?.onChange?.(await contextSnapshot(file));
        if (request.installedFrom !== undefined) {
          // Applying a shared update re-registers the new hash.
          const previous = automationSubscriptionSource(previousInstalledFrom);
          const next = automationSubscriptionSource(activity.installedFrom);
          if (
            previous &&
            (previous.remoteId !== next?.remoteId ||
              previous.sourceKind !== next?.sourceKind)
          )
            unregisterAutomationInstall(activity.id, previousInstalledFrom);
          registerAutomationInstall(activity);
        }
        return { ok: true, activity: cloneActivity(activity) };
      } finally {
        releaseTarget();
      }
    };
    return this.enqueueMutation(async () => {
      try {
        const response = await mutate();
        await rollBackUnwritten();
        return response;
      } catch (error) {
        await rollBackUnwritten();
        throw error;
      }
    });
  }

  async delete(
    request: AutomationDeleteRequest,
    authorize?: (activity: ScheduledActivity) => Promise<boolean>,
    callerContext?: WorkspaceContext,
  ): Promise<AutomationMutationResponse> {
    if (!isRecord(request) || typeof request.id !== 'string') {
      return { ok: false, error: 'Automation id is required.' };
    }
    return this.enqueueMutation(async () => {
      const file = await this.ensureFile();
      if (authorize) {
        const current = file.activities.find(
          (entry) => entry.id === request.id,
        );
        if (!current || !(await authorize(cloneActivity(current))))
          return { ok: false, error: 'Activity not found.' };
      }
      // CAN-5782: Delete on a workflow page's Library row removes the whole
      // workflow in this one mutation, so no run starts and no schedule
      // changes between its parts.
      const requested = file.activities.find(
        (entry) => entry.id === request.id,
      );
      const workflowPipelineId =
        request.workflow === true && requested !== undefined
          ? scheduledUserPipelineId(requested)
          : undefined;
      if (
        requested !== undefined &&
        workflowPipelineId !== undefined &&
        isWorkflowPagePipeline(file.activities, workflowPipelineId)
      )
        return await this.deleteWorkflowPage(
          file,
          requested,
          workflowPipelineId,
          authorize,
          callerContext,
        );
      if (isActivityRunning(file, request.id)) {
        return {
          ok: false,
          error:
            'Activity is running. Disable it now and delete it after the run finishes.',
        };
      }
      const index = file.activities.findIndex(
        (entry) => entry.id === request.id,
      );
      if (index === -1) return { ok: false, error: 'Activity not found.' };
      await assertAutomationContext(file.activities[index], callerContext);
      // CAN-6183: a cloud schedule goes server-side first, so it never
      // keeps firing there once its record is gone here.
      const cloudRefusal = await this.deleteCloudRecord(file.activities[index]);
      if (cloudRefusal !== null) return { ok: false, error: cloudRefusal };
      // CAN-5782: Remove on a workflow page's last schedule may keep its
      // pipeline, unless its package binding or agent grant can't outlive
      // the record.
      const keep = keptWorkflowPipeline(
        file.activities,
        file.activities[index],
        request.keepPipeline === true,
      );
      if (keep?.refusal) return { ok: false, error: keep.refusal };
      // CAN-5782: a pipeline that stays is released before its owner goes,
      // so its hiding facts are durable first; one that didn't persist
      // refuses the delete.
      const target = file.activities[index];
      const owned = ownedPipelineId(target);
      if (
        owned !== undefined &&
        (keep !== undefined ||
          isSharedByOtherSchedules(file.activities, target, owned)) &&
        !releaseOwnedPipeline(target, owned, keep?.lastScheduleValues)
      )
        return { ok: false, error: WORKFLOW_RELEASE_FAILED };
      // The last schedule's values, on a page it didn't own, persist before
      // the record that holds them goes.
      if (
        keep !== undefined &&
        owned === undefined &&
        !keepLastScheduleValues(keep.pipelineId, keep.lastScheduleValues)
      )
        return { ok: false, error: WORKFLOW_RELEASE_FAILED };
      const [activity] = file.activities.splice(index, 1);
      this.enabledIntentRevisions.delete(activity.id);
      file.recentRuns = file.recentRuns.filter(
        (run) => run.activityId !== request.id,
      );
      await this.persistAndNotify(file);
      await this.cleanUpDeletedActivity(activity);
      // A converted chat automation's own pipeline goes with it (CAN-4551),
      // unless another schedule runs it or Remove keeps it (CAN-5782).
      // Released above when it stays; otherwise deleted with its owner.
      await deleteOwnedPipeline(activity);
      return { ok: true, activity: cloneActivity(activity) };
    });
  }

  /** What a deleted record leaves behind once its deletion is durable. */
  private async cleanUpDeletedActivity(
    activity: ScheduledActivity,
  ): Promise<void> {
    unregisterAutomationInstall(activity.id, activity.installedFrom);
    await removeAutomationCapabilityPackageInstall(activity.id).catch(
      () => undefined,
    );
    await this.archive.deleteActivityArchive(activity.id).catch((error) => {
      // The activity deletion is already durable. Keep an orphaned archive
      // rather than turning a cleanup failure into history loss; startup
      // retention maintenance can safely age its records out.
      logMainProcessError(
        'Failed to delete orphaned automation run archive',
        error,
      );
    });
  }

  /**
   * Deletes a workflow page (CAN-5782), inside the caller's mutation: every
   * schedule that runs `pipelineId`, and the pipeline. A schedule the caller
   * can't reach, or one that is running, refuses it before anything
   * changes. The pipeline goes first, so a refusal there leaves the
   * schedules as they were; once it is gone, the schedules go too.
   */
  private async deleteWorkflowPage(
    file: AutomationsFile,
    requested: ScheduledActivity,
    pipelineId: string,
    authorize: ((activity: ScheduledActivity) => Promise<boolean>) | undefined,
    callerContext: WorkspaceContext | undefined,
  ): Promise<AutomationMutationResponse> {
    const schedules = pipelineSchedules(file.activities, pipelineId);
    for (const schedule of schedules) {
      if (authorize && !(await authorize(cloneActivity(schedule))))
        return { ok: false, error: 'Activity not found.' };
      await assertAutomationContext(schedule, callerContext);
    }
    if (schedules.some((schedule) => isActivityRunning(file, schedule.id)))
      return { ok: false, error: WORKFLOW_DELETE_RUNNING };
    // CAN-6183: cloud schedules go server-side before anything here. One
    // that fails stops the delete; a stub whose record went stays, unfired.
    for (const schedule of schedules) {
      const cloudRefusal = await this.deleteCloudRecord(schedule);
      if (cloudRefusal !== null) return { ok: false, error: cloudRefusal };
    }
    const [{ deleteUserPipeline }, { AUTOMATION_PIPELINE_CALLER }] =
      await Promise.all([
        import('../canopy-runtime/pipeline-definition-dispatch'),
        import('./chat-automation-conversion'),
      ]);
    const deleted = await deleteUserPipeline(
      pipelineId,
      null,
      AUTOMATION_PIPELINE_CALLER,
    );
    if (!deleted.success) {
      logMainProcessError('Failed to delete a workflow page', {
        operation: 'delete-workflow-page',
      });
      // A delete that committed before a cleanup step failed is still a
      // delete: its schedules go too, rather than run a missing pipeline.
      if (pipelineStore.getStoredPipelineBySource('user', pipelineId).success)
        return { ok: false, error: WORKFLOW_DELETE_FAILED };
    }
    const ids = new Set(schedules.map((schedule) => schedule.id));
    const { activities, recentRuns } = file;
    file.activities = activities.filter((entry) => !ids.has(entry.id));
    file.recentRuns = recentRuns.filter((run) => !ids.has(run.activityId));
    try {
      await this.persistAndNotify(file);
    } catch (error) {
      // Memory follows disk, which still has the schedules.
      file.activities = activities;
      file.recentRuns = recentRuns;
      throw error;
    }
    for (const id of ids) this.enabledIntentRevisions.delete(id);
    for (const schedule of schedules)
      await this.cleanUpDeletedActivity(schedule);
    return { ok: true, activity: cloneActivity(requested) };
  }

  /**
   * Replaces a chat automation's action with the owned pipeline `save`
   * stores (CAN-4551), in one write. The automation keeps its ID, name,
   * trigger, gate command, enabled state and agent author. When the rewrite
   * fails after the pipeline is saved, the pipeline is rolled back.
   */
  async replaceWithOwnedPipeline(
    activityId: string,
    save: (activity: ScheduledActivity) => Promise<OwnedPipelineReplacement>,
  ): Promise<AutomationMutationResponse> {
    return this.enqueueMutation(async () => {
      const file = await this.ensureFile();
      const index = file.activities.findIndex(
        (entry) => entry.id === activityId,
      );
      const activity = file.activities[index];
      if (!activity) return { ok: false, error: 'Activity not found.' };
      if (isActivityRunning(file, activityId))
        return { ok: false, error: ACTIVITY_RUNNING_RETRY };
      let replacement: OwnedPipelineReplacement;
      try {
        replacement = await save(cloneActivity(activity));
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      const converted: ScheduledActivity = {
        ...cloneActivity(activity),
        action: replacement.action,
        executionContext:
          activity.executionContext ?? replacement.executionContext,
        updatedAt: new Date().toISOString(),
      };
      // A global pipeline takes no run restriction; `save` checked it is the
      // one the chat action implies, which converting back restores.
      delete converted.targetRequirement;
      try {
        file.activities[index] = converted;
        await this.writeFile(file);
      } catch (error) {
        file.activities[index] = activity;
        await rollBackOwnedPipeline(replacement);
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      // A capability package install keeps matching what it now shows.
      await repinConvertedPackageInstall(activity, converted);
      // The stored automation now runs the pipeline, so a failed
      // notification keeps both; the next change republishes.
      try {
        this.surfaces?.onChange?.(await contextSnapshot(file));
      } catch (error) {
        logMainProcessError('Failed to publish a converted automation', error);
      }
      return { ok: true, activity: cloneActivity(converted) };
    });
  }

  /**
   * Write the author-side Canopy Cloud share link onto an activity after a
   * successful shared-Automation create/update (CAN-1581). Returns false when
   * the activity no longer exists (deleted while the share round trip was in
   * flight) — the share itself stays valid server-side.
   */
  async setActivityRemoteMetadata(
    activityId: string,
    remote: AutomationRemoteMetadata,
  ): Promise<boolean> {
    return this.enqueueMutation(async () => {
      const file = await this.ensureFile();
      const activity = file.activities.find((entry) => entry.id === activityId);
      if (!activity) return false;
      activity.remote = { ...remote };
      await this.persistAndNotify(file);
      return true;
    });
  }

  /**
   * Clear the author-side share link from every activity pointing at the
   * given server-side shared resource after an unshare. Returns the number of
   * activities cleared.
   */
  async clearActivityRemoteMetadataByRemoteId(
    remoteId: string,
  ): Promise<number> {
    return this.enqueueMutation(async () => {
      const file = await this.ensureFile();
      let clearedCount = 0;
      for (const activity of file.activities) {
        if (activity.remote?.remoteId !== remoteId) continue;
        delete activity.remote;
        clearedCount += 1;
      }
      if (clearedCount > 0) {
        await this.persistAndNotify(file);
      }
      return clearedCount;
    });
  }

  async approveSharedPipelineReview(
    request: ApproveAutomationSharedPipelineReviewRequest,
  ): Promise<ApproveAutomationSharedPipelineReviewResponse> {
    if (!isRecord(request) || typeof request.id !== 'string') {
      return { ok: false, error: 'Automation id is required.' };
    }
    if (request.runNow !== undefined && typeof request.runNow !== 'boolean') {
      return { ok: false, error: 'runNow must be a boolean.' };
    }

    const prepared = await this.enqueueMutation(async () => {
      const activity = (await this.ensureFile()).activities.find(
        (entry) => entry.id === request.id,
      );
      if (!activity)
        return { ok: false as const, error: 'Activity not found.' };
      await assertAutomationContext(activity);
      const action = activity.action;
      if (
        action.type !== 'worktree_pipeline' ||
        action.pipelineSource !== 'shared' ||
        !action.sharedPipeline?.remoteId
      ) {
        return {
          ok: false as const,
          error: 'Activity does not use a shared workflow.',
        };
      }
      if (!activity.sharedPipelineReview) {
        return {
          ok: false as const,
          error: 'This automation does not need workflow review.',
        };
      }
      if (
        activity.sharedPipelineReview.remoteId !==
        action.sharedPipeline.remoteId
      ) {
        return {
          ok: false as const,
          error: 'This automation changed while the workflow was reviewed.',
        };
      }
      return {
        ok: true as const,
        remoteId: action.sharedPipeline.remoteId,
        reviewDetectedAt: activity.sharedPipelineReview.detectedAt,
      };
    });
    if (!prepared.ok) return prepared;

    try {
      await verifySharedPipelineAutomationInstallPin(
        prepared.remoteId,
        request.installPin,
      );
    } catch (error) {
      if (error instanceof SharedPipelinePinMismatchError) {
        return {
          ok: false,
          error: 'This workflow was updated again, so take another look.',
        };
      }
      return { ok: false, error: getErrorMessage(error) };
    }

    const approved = await this.enqueueMutation(async () => {
      const file = await this.ensureFile();
      const activity = file.activities.find((entry) => entry.id === request.id);
      if (!activity)
        return { ok: false as const, error: 'Activity not found.' };
      const action = activity.action;
      if (
        action.type !== 'worktree_pipeline' ||
        action.pipelineSource !== 'shared' ||
        action.sharedPipeline?.remoteId !== prepared.remoteId ||
        activity.sharedPipelineReview?.detectedAt !== prepared.reviewDetectedAt
      ) {
        return {
          ok: false as const,
          error: 'This automation changed while the workflow was reviewed.',
        };
      }
      const candidate = cloneActivity(activity);
      candidate.action = {
        ...action,
        sharedPipeline: {
          ...action.sharedPipeline,
          installPin: request.installPin,
        },
      };
      const targetRefusal = await this.targetCompatibilityRefusal(candidate);
      if (targetRefusal) return { ok: false as const, error: targetRefusal };
      const approvalTime = new Date();
      const consumedOneTimeReviewSlot =
        activity.schedule.kind === 'one_time' &&
        (activity.lastScheduledFor === activity.schedule.runAt ||
          Date.parse(activity.schedule.runAt) <= approvalTime.getTime());
      action.sharedPipeline.installPin = request.installPin;
      delete activity.sharedPipelineReview;
      const existingNextRunAt = activity.nextRunAt;
      const existingNextRunTime = existingNextRunAt
        ? Date.parse(existingNextRunAt)
        : Number.NaN;
      if (consumedOneTimeReviewSlot) {
        delete activity.nextRunAt;
      } else if (
        activity.schedule.kind === 'cron' &&
        existingNextRunAt &&
        Number.isFinite(existingNextRunTime) &&
        existingNextRunTime <= approvalTime.getTime()
      ) {
        activity.lastScheduledFor = existingNextRunAt;
        activity.nextRunAt = computeNextAfterScheduledWindow(
          activity,
          existingNextRunAt,
          approvalTime,
        );
      } else {
        activity.nextRunAt = nextRunForEnabledActivity(
          activity,
          file,
          approvalTime,
          { preserveExistingCronNextRun: true },
        );
      }
      if (
        activity.schedule.kind === 'one_time' &&
        activity.nextRunAt === undefined
      ) {
        activity.enabled = false;
      }
      activity.updatedAt = new Date().toISOString();
      await this.persistAndNotify(file);
      return { ok: true as const, activity: cloneActivity(activity) };
    });
    if (!approved.ok || request.runNow !== true) return approved;

    try {
      const run = await this.runNow({ id: request.id });
      return run.ok
        ? { ...run, activity: approved.activity }
        : { ok: true, activity: approved.activity, runError: run.error };
    } catch (error) {
      return {
        ok: true,
        activity: approved.activity,
        runError: getErrorMessage(error),
      };
    }
  }

  async runNow(
    request: AutomationRunNowRequest,
    authorize?: (activity: ScheduledActivity) => Promise<boolean>,
    callerContext?: WorkspaceContext,
  ): Promise<AutomationMutationResponse> {
    if (!isRecord(request) || typeof request.id !== 'string') {
      return { ok: false, error: 'Automation id is required.' };
    }
    const prepared = await this.enqueueMutation(async () => {
      const file = await this.ensureFile();
      const activity = file.activities.find((entry) => entry.id === request.id);
      if (!activity)
        return { ok: false as const, error: 'Activity not found.' };
      if (authorize && !(await authorize(cloneActivity(activity))))
        return { ok: false as const, error: 'Activity not found.' };
      await assertAutomationContext(activity, callerContext);
      // CAN-6183: a cloud schedule runs where it is stored.
      if (!firesLocally(activity)) return locationRefusal(activity);
      if (activity.sharedPipelineReview) {
        return {
          ok: false as const,
          error: SHARED_PIPELINE_REVIEW_MESSAGE,
        };
      }
      if (isActivityRunning(file, activity.id)) {
        return {
          ok: false as const,
          error: 'Activity is already running.',
        };
      }
      // An automation that's on runs in the context saved when it was turned
      // on. One that's off (whatever it saved is left over from the last time
      // it was on) or was never turned on runs where turning it on would bind
      // it. Either way, refuse before a run exists.
      // A pipeline with no project always runs as its saved owner.
      const globalOwner = isGlobalPipelineAutomationAction(activity.action)
        ? await globalAutomationOwner(activity.executionContext)
        : undefined;
      if (globalOwner && 'error' in globalOwner)
        return { ok: false as const, error: globalOwner.error };
      const savedContext = globalOwner
        ? globalOwner.context
        : activity.enabled
          ? activity.executionContext
          : undefined;
      const selectedContext =
        savedContext === undefined
          ? callerContext === undefined
            ? await captureBackgroundExecutionContext()
            : serializeWorkspaceContext(callerContext)
          : undefined;
      const executionContext =
        savedContext ??
        (selectedContext === undefined
          ? undefined
          : await bindingContextForAction(activity.action, selectedContext));
      let refusal: string | null;
      if (globalOwner) {
        refusal = null;
      } else if (savedContext === undefined) {
        refusal = await automationContextRefusal(
          activity.action,
          executionContext,
          'run',
        );
      } else {
        const mismatch = await describeAutomationContextMismatch(
          activity.action,
          executionContext,
        );
        // It keeps its saved context until it's turned off and on again.
        refusal = mismatch
          ? backgroundExecutionDeniedMessage('context-mismatch', {
              mismatch,
              stillOn: true,
            })
          : null;
      }
      if (refusal) return { ok: false as const, error: refusal };
      const releaseTarget = reserveAutomationTargetStart(activity.action);
      try {
        const now = new Date().toISOString();
        const run = this.createRun(activity, now, 'manual', executionContext);
        this.openCancellableWindow(activity, run);
        file.recentRuns.unshift(run);
        file.recentRuns = trimRecentRuns(file.recentRuns);
        await this.persistAndNotify(file);
        await this.archive.appendRun(run).catch((error) => {
          logMainProcessError(
            'Failed to archive initial automation run',
            error,
          );
        });
        return {
          ok: true as const,
          activityId: activity.id,
          runId: run.id,
          enabledIntentRevision:
            this.enabledIntentRevisions.get(activity.id) ?? 0,
          releaseTarget,
        };
      } catch (error) {
        releaseTarget();
        throw error;
      }
    });
    if (!prepared.ok) return prepared;
    try {
      const run = await this.finishRun(
        prepared.activityId,
        prepared.runId,
        prepared.enabledIntentRevision,
        true,
      );
      return run
        ? { ok: true, run: cloneRun(run) }
        : { ok: false, error: 'Run was not found.' };
    } finally {
      prepared.releaseTarget();
    }
  }

  async cancelRun(
    request: AutomationCancelRunRequest,
  ): Promise<AutomationMutationResponse> {
    if (!isRecord(request) || typeof request.runId !== 'string') {
      return { ok: false, error: 'Run id is required.' };
    }
    return this.enqueueMutation(async () => {
      const controller = this.cancellableRuns.get(request.runId);
      const file = await this.ensureFile();
      const run = file.recentRuns.find((entry) => entry.id === request.runId);
      if (!run) return { ok: false, error: 'Run not found.' };
      const activity = file.activities.find(
        (entry) => entry.id === run.activityId,
      );
      if (resourceContextEnabled()) {
        if (!activity) return { ok: false, error: 'Run not found.' };
        await assertAutomationContext(activity);
      }
      if (run.status !== 'running' || !run.cancellable || !controller) {
        return { ok: false, error: 'Run can no longer be canceled.' };
      }
      run.status = 'canceled';
      run.cancellable = false;
      run.completedAt = new Date().toISOString();
      run.durationMs = Math.max(
        0,
        Date.parse(run.completedAt) - Date.parse(run.startedAt),
      );
      run.error = 'Canceled before dispatch.';
      if (activity) this.applyRunResult(activity, run);
      await this.archive.appendRun(run);
      await this.persistAndNotify(file);
      this.cancellableRuns.delete(request.runId);
      this.notifyRunWatchers(run);
      controller.abort();
      return { ok: true, run: cloneRun(run) };
    });
  }

  private async runDueCheck(): Promise<void> {
    if (this.dueCheckRunning) {
      this.dueCheckRequested = true;
      return;
    }
    this.dueCheckRunning = true;
    this.dueCheckRequested = false;
    try {
      const now = new Date();
      const due = await this.enqueueMutation(async () => {
        const file = await this.ensureFile();
        const dueRuns: Array<{
          activityId: string;
          runId: string;
          enabledIntentRevision: number;
          releaseTarget: () => void;
        }> = [];
        const initialRunsToArchive: ScheduledActivityRun[] = [];
        let changed = false;
        try {
          for (const activity of file.activities) {
            if (!activity.enabled || !firesLocally(activity)) continue;
            activity.nextRunAt = nextRunForEnabledActivity(activity, file, now);
            const scheduledFor = activity.nextRunAt;
            if (!scheduledFor || Date.parse(scheduledFor) > now.getTime()) {
              continue;
            }
            if (activity.sharedPipelineReview) {
              activity.lastScheduledFor = scheduledFor;
              activity.nextRunAt = computeNextAfterScheduledWindow(
                activity,
                scheduledFor,
                now,
              );
              changed = true;
              continue;
            }
            if (hasRunForOccurrence(file, activity.id, scheduledFor)) {
              this.advanceAfterSkippedOrDuplicate(activity, scheduledFor, now);
              changed = true;
              continue;
            }
            if (
              activity.action.type === 'worktree_session_prompt' &&
              isWorktreeSessionPromptTargetBusy(activity.action)
            ) {
              continue;
            }
            const trigger = triggerForScheduledOccurrence(
              activity,
              scheduledFor,
              now,
            );
            if (isActivityRunning(file, activity.id)) {
              const run = this.createRun(activity, scheduledFor, trigger);
              run.status = 'skipped';
              run.completedAt = new Date().toISOString();
              run.error = 'Previous run is still active.';
              run.skipReason = 'already_running';
              file.recentRuns.unshift(run);
              await this.archive.appendRun(run);
              file.recentRuns = trimRecentRuns(file.recentRuns);
              this.applyRunResult(activity, run);
              this.advanceAfterSkippedOrDuplicate(activity, scheduledFor, now);
              changed = true;
              continue;
            }
            let releaseTarget: (() => void) | null = null;
            try {
              releaseTarget = reserveAutomationTargetStart(activity.action);
            } catch {
              continue;
            }
            let reservationTransferred = false;
            try {
              const run = this.createRun(activity, scheduledFor, trigger);
              this.openCancellableWindow(activity, run);
              file.recentRuns.unshift(run);
              initialRunsToArchive.push(run);
              if (
                activity.schedule.kind === 'cron' &&
                Date.parse(scheduledFor) < now.getTime()
              ) {
                await this.archiveMissedOccurrences(
                  activity,
                  scheduledFor,
                  now,
                );
              }
              file.recentRuns = trimRecentRuns(file.recentRuns);
              this.advanceAfterScheduledDispatch(activity, scheduledFor, now);
              dueRuns.push({
                activityId: activity.id,
                runId: run.id,
                enabledIntentRevision:
                  this.enabledIntentRevisions.get(activity.id) ?? 0,
                releaseTarget,
              });
              reservationTransferred = true;
              changed = true;
            } finally {
              if (!reservationTransferred) releaseTarget();
            }
          }
          if (changed) await this.persistAndNotify(file);
          for (const run of initialRunsToArchive) {
            await this.archive.appendRun(run).catch((error) => {
              logMainProcessError(
                'Failed to archive initial automation run',
                error,
              );
            });
          }
          return dueRuns;
        } catch (error) {
          dueRuns.forEach(({ releaseTarget }) => releaseTarget());
          throw error;
        }
      });

      for (const entry of due) {
        void this.finishRun(
          entry.activityId,
          entry.runId,
          entry.enabledIntentRevision,
          false,
        )
          .catch(() => undefined)
          .finally(entry.releaseTarget);
      }
    } finally {
      this.dueCheckRunning = false;
      if (this.dueCheckRequested && this.interval !== null) {
        void this.runDueCheck().catch(() => undefined);
      }
    }
  }

  private createRun(
    activity: ScheduledActivity,
    scheduledFor: string,
    trigger: AutomationRunTrigger,
    /**
     * The context this run executes in: the activity's saved context for a
     * scheduled run, and the one Run now resolved for a manual run.
     */
    executionContext: string | undefined = activity.executionContext,
  ): ScheduledActivityRun {
    const target = targetForActivity(activity);
    return {
      id: randomUUID(),
      activityId: activity.id,
      activityName: activity.name,
      ...(backgroundExecutionContextEnabled() && executionContext !== undefined
        ? { executionContext }
        : {}),
      scheduledFor,
      manual: trigger === 'manual',
      trigger,
      executionLocation: 'local',
      status: 'running',
      startedAt: new Date().toISOString(),
      ...(target ? { target } : {}),
    };
  }

  private openCancellableWindow(
    activity: ScheduledActivity,
    run: ScheduledActivityRun,
  ): void {
    if (!activity.ifCommand?.trim()) return;
    run.cancellable = true;
    this.cancellableRuns.set(run.id, new AbortController());
  }

  private async archiveMissedOccurrences(
    activity: ScheduledActivity,
    dispatchedScheduledFor: string,
    now: Date,
  ): Promise<void> {
    if (activity.schedule.kind !== 'cron') return;
    const stored: ScheduledActivityRun[] = [];
    let omittedCount = 0;
    let enumeratedCount = 0;
    let enumerationComplete = false;
    let cursor = new Date(dispatchedScheduledFor);
    const target = targetForActivity(activity);
    const deadline = Date.now() + MISSED_BACKFILL_TIME_BUDGET_MS;
    while (enumeratedCount < 10_000) {
      // Always inspect at least one occurrence so a time-boxed scan can attach
      // its truncation marker to a real missed row.
      if (enumeratedCount > 0 && Date.now() > deadline) break;
      const next = getNextCronRun(activity.schedule.expression, cursor);
      if (!next || next.getTime() > now.getTime()) {
        enumerationComplete = true;
        break;
      }
      enumeratedCount += 1;
      if (stored.length < MAX_MISSED_BACKFILL_RUNS) {
        const timestamp = next.toISOString();
        stored.push({
          id: missedOccurrenceRunId(activity.id, timestamp),
          activityId: activity.id,
          activityName: activity.name,
          scheduledFor: timestamp,
          manual: false,
          trigger: 'catch_up',
          executionLocation: 'local',
          status: 'missed',
          startedAt: timestamp,
          completedAt: now.toISOString(),
          ...(target ? { target } : {}),
        });
      } else {
        omittedCount += 1;
      }
      cursor = next;
    }
    if (omittedCount > 0 && stored.length > 0) {
      const newestStored = stored[stored.length - 1];
      if (newestStored) newestStored.omittedCount = omittedCount;
    }
    if (!enumerationComplete && stored.length > 0) {
      const newestStored = stored[stored.length - 1];
      if (newestStored) newestStored.missedOccurrencesTruncated = true;
    }
    // Missed occurrences are observability records only. They never enter the
    // hot window and never notify watchers or affect scheduler dedupe scans.
    for (const run of stored) await this.archive.appendRun(run);
  }

  private advanceAfterScheduledDispatch(
    activity: ScheduledActivity,
    scheduledFor: string,
    now: Date,
  ): void {
    activity.lastScheduledFor = scheduledFor;
    if (activity.schedule.kind === 'one_time') {
      activity.enabled = false;
      delete activity.nextRunAt;
      return;
    }
    activity.nextRunAt = computeNextAfterScheduledWindow(
      activity,
      scheduledFor,
      now,
    );
  }

  private advanceAfterSkippedOrDuplicate(
    activity: ScheduledActivity,
    scheduledFor: string,
    now: Date,
  ): void {
    activity.lastScheduledFor = scheduledFor;
    if (activity.schedule.kind === 'one_time') {
      activity.enabled = false;
      delete activity.nextRunAt;
      return;
    }
    activity.nextRunAt = computeNextAfterScheduledWindow(
      activity,
      scheduledFor,
      now,
    );
  }

  private async finishRun(
    activityId: string,
    runId: string,
    enabledIntentRevision: number,
    /** A Run now; a scheduled or catch-up run starts its chat behind the current tab. */
    manual: boolean,
  ): Promise<ScheduledActivityRun | null> {
    let ifCommandOutput: string | undefined;
    let ifCommandError: string | undefined;
    try {
      const storedActivity = (await this.ensureFile()).activities.find(
        (entry) => entry.id === activityId,
      );
      if (!storedActivity) throw new Error('Activity not found.');
      const activity = backgroundExecutionContextEnabled()
        ? cloneActivity(storedActivity)
        : storedActivity;
      if (backgroundExecutionContextEnabled()) {
        const run = (await this.ensureFile()).recentRuns.find(
          (entry) => entry.id === runId,
        );
        activity.executionContext = run?.executionContext;
      }

      if (backgroundExecutionContextEnabled()) {
        const { resources, destination, sharedPipelineReadFailure } =
          await this.backgroundAuthorizationInput(activity);
        if (sharedPipelineReadFailure) {
          if (sharedPipelineReadFailure.decision)
            await this.rejectBackgroundRun(
              activityId,
              sharedPipelineReadFailure.decision,
              activity.executionContext,
            );
          throw sharedPipelineReadFailure.error;
        }
        let decision = await authorizeBackgroundExecution(
          activity.executionContext,
          resources,
          destination,
        );
        if (!decision.allow && decision.reason === 'context-mismatch') {
          const followed = await this.followMovedTarget(
            activityId,
            runId,
            activity,
          );
          if (followed !== null) {
            activity.executionContext = followed;
            decision = await authorizeBackgroundExecution(
              followed,
              resources,
              destination,
            );
          }
        }
        if (!decision.allow)
          await this.rejectBackgroundRun(
            activityId,
            decision,
            activity.executionContext,
          );
      }

      if (activity.ifCommand && activity.ifCommand.trim().length > 0) {
        await this.assertTargetCompatibility(activity, true);
        const controller =
          this.cancellableRuns.get(runId) ?? new AbortController();
        const abortIfCommand = (): void => {
          controller.abort();
        };
        this.ifCommandAbortHandlers.add(abortIfCommand);
        let result: Awaited<ReturnType<typeof runAutomationIfCommand>>;
        try {
          result = await runAutomationIfCommand({
            command: activity.ifCommand,
            signal: controller.signal,
          });
        } finally {
          this.ifCommandAbortHandlers.delete(abortIfCommand);
        }
        const mayDispatch = await this.closeCancellableWindow(
          activityId,
          runId,
        );
        if (!mayDispatch) {
          return await this.readCurrentRun(activityId, runId);
        }
        ifCommandOutput = truncateCommandOutput(result.stdout);
        ifCommandError = truncateCommandOutput(result.stderr);
        const decision = decideIfCommandGate(result);
        if (decision.kind === 'fail') {
          throw new Error(decision.message);
        }
        if (decision.kind === 'skip') {
          return await this.completeRun(activityId, runId, {
            status: 'skipped',
            message: decision.message,
            skipReason: 'if_command_exit',
            ifCommandOutput,
            ifCommandError,
          });
        }
        const parsedOutput = parseAutomationIfCommandOutput(decision.output);
        ifCommandOutput = truncateCommandOutput(parsedOutput.output);
        if (parsedOutput.idempotencyKey) {
          const reservation = await this.reserveIdempotencyKey({
            activityId,
            runId,
            key: parsedOutput.idempotencyKey,
            scope: parsedOutput.idempotencyScope,
          });
          if (reservation === 'duplicate') {
            return await this.completeRun(activityId, runId, {
              status: 'skipped',
              message: `If Command idempotency key "${parsedOutput.idempotencyKey}" was used by a recent run; action skipped.`,
              skipReason: 'idempotency',
              ifCommandOutput,
              ifCommandError,
            });
          }
        }
      }

      const result = await this.executeAction(
        activity,
        ifCommandOutput,
        !manual,
        runId,
      );
      return await this.completeRun(activityId, runId, {
        status: 'success',
        result,
        ifCommandOutput,
        ifCommandError,
      });
    } catch (error) {
      return await this.completeRun(activityId, runId, {
        status: 'failure',
        error:
          error instanceof SharedPipelineReviewRequiredError
            ? SHARED_PIPELINE_REVIEW_MESSAGE
            : getErrorMessage(error),
        ...(error instanceof SharedPipelineReviewRequiredError
          ? {
              sharedPipelineReview: {
                review: {
                  detectedAt: new Date().toISOString(),
                  remoteId: error.remoteId,
                  ...(error.pipelineName
                    ? { pipelineName: error.pipelineName }
                    : {}),
                },
                installPin: error.installPin,
                enabledIntentRevision,
              },
            }
          : {}),
        ifCommandOutput,
        ifCommandError,
      });
    }
  }

  private async completeRun(
    activityId: string,
    runId: string,
    outcome:
      | {
          status: 'success';
          result: NonNullable<ScheduledActivityRun['result']>;
          ifCommandOutput?: string;
          ifCommandError?: string;
        }
      | {
          status: 'failure';
          error: string;
          sharedPipelineReview?: SharedPipelineReviewOutcome;
          ifCommandOutput?: string;
          ifCommandError?: string;
        }
      | {
          status: 'skipped';
          message: string;
          skipReason?: AutomationSkipReason;
          ifCommandOutput?: string;
          ifCommandError?: string;
        },
  ): Promise<ScheduledActivityRun | null> {
    return this.enqueueMutation(async () => {
      const file = await this.ensureFile();
      const run = file.recentRuns.find((entry) => entry.id === runId);
      const activity = file.activities.find((entry) => entry.id === activityId);
      if (!run) {
        const archived = await this.archive.findRun(activityId, runId);
        if (!archived) return null;
        archived.status = outcome.status;
        archived.cancellable = false;
        archived.completedAt = new Date().toISOString();
        archived.durationMs = Math.max(
          0,
          Date.parse(archived.completedAt) - Date.parse(archived.startedAt),
        );
        archived.ifCommandOutput = outcome.ifCommandOutput;
        archived.ifCommandError = outcome.ifCommandError;
        if (outcome.status === 'success') {
          archived.result = outcome.result;
          const resolvedChatId =
            outcome.result.chatId ??
            outcome.result.standaloneChatId ??
            outcome.result.appAdvisorChatId;
          archived.target = {
            ...(archived.target ?? {}),
            ...(outcome.result.projectId
              ? { workspaceId: outcome.result.projectId }
              : {}),
            ...(outcome.result.worktreeId
              ? { worktreeId: outcome.result.worktreeId }
              : {}),
            ...(resolvedChatId ? { chatId: resolvedChatId } : {}),
          };
          delete archived.error;
          delete archived.skipReason;
        } else if (outcome.status === 'failure') {
          archived.error = outcome.error;
          delete archived.skipReason;
        } else {
          archived.error = outcome.message;
          archived.skipReason = outcome.skipReason;
        }
        if (activity) {
          if (outcome.status === 'failure' && outcome.sharedPipelineReview) {
            const reviewOutcome = outcome.sharedPipelineReview;
            if (
              actionMatchesSharedPipelineReviewOutcome(
                activity.action,
                reviewOutcome,
              )
            ) {
              activity.sharedPipelineReview = reviewOutcome.review;
            }
            if (
              activity.sharedPipelineReview === reviewOutcome.review &&
              activity.schedule.kind === 'one_time' &&
              !archived.manual &&
              (this.enabledIntentRevisions.get(activity.id) ?? 0) ===
                reviewOutcome.enabledIntentRevision
            ) {
              activity.enabled = true;
            }
          }
          this.applyRunResult(activity, archived);
        }
        await this.archive.appendRun(archived);
        if (activity) await this.persistAndNotify(file);
        this.notifyRunWatchers(archived);
        return cloneRun(archived);
      }
      if (run.status !== 'running') return cloneRun(run);
      run.status = outcome.status;
      run.cancellable = false;
      run.completedAt = new Date().toISOString();
      run.durationMs = Math.max(
        0,
        Date.parse(run.completedAt) - Date.parse(run.startedAt),
      );
      run.ifCommandOutput = outcome.ifCommandOutput;
      run.ifCommandError = outcome.ifCommandError;
      if (outcome.status === 'success') {
        run.result = outcome.result;
        const resolvedChatId =
          outcome.result.chatId ??
          outcome.result.standaloneChatId ??
          outcome.result.appAdvisorChatId;
        run.target = {
          ...(run.target ?? {}),
          ...(outcome.result.projectId
            ? { workspaceId: outcome.result.projectId }
            : {}),
          ...(outcome.result.worktreeId
            ? { worktreeId: outcome.result.worktreeId }
            : {}),
          ...(resolvedChatId ? { chatId: resolvedChatId } : {}),
        };
        delete run.error;
        delete run.skipReason;
      } else if (outcome.status === 'failure') {
        run.error = outcome.error;
        delete run.skipReason;
      } else {
        run.error = outcome.message;
        run.skipReason = outcome.skipReason;
      }
      if (activity) {
        if (outcome.status === 'failure' && outcome.sharedPipelineReview) {
          const reviewOutcome = outcome.sharedPipelineReview;
          if (
            actionMatchesSharedPipelineReviewOutcome(
              activity.action,
              reviewOutcome,
            )
          ) {
            activity.sharedPipelineReview = reviewOutcome.review;
          }
          if (
            activity.sharedPipelineReview === reviewOutcome.review &&
            activity.schedule.kind === 'one_time' &&
            !run.manual &&
            (this.enabledIntentRevisions.get(activity.id) ?? 0) ===
              reviewOutcome.enabledIntentRevision
          ) {
            activity.enabled = true;
          }
        }
        this.applyRunResult(activity, run);
      }
      await this.archive.appendRun(run);
      await this.persistAndNotify(file);
      this.notifyRunWatchers(run);
      return cloneRun(run);
    });
  }

  /**
   * Close the only window in which an automation run can be canceled. This
   * transition is archived and broadcast before action dispatch so the UI
   * never advertises Cancel for an agent turn or pipeline that already began.
   */
  private async closeCancellableWindow(
    activityId: string,
    runId: string,
  ): Promise<boolean> {
    return await this.enqueueMutation(async () => {
      this.cancellableRuns.delete(runId);
      const file = await this.ensureFile();
      const run = file.recentRuns.find((entry) => entry.id === runId);
      if (!run || run.activityId !== activityId || run.status !== 'running') {
        return false;
      }
      run.cancellable = false;
      await this.archive.appendRun(run);
      await this.persistAndNotify(file);
      return true;
    });
  }

  private async readCurrentRun(
    activityId: string,
    runId: string,
  ): Promise<ScheduledActivityRun | null> {
    return await this.enqueueMutation(async () => {
      const current = (await this.ensureFile()).recentRuns.find(
        (entry) => entry.id === runId && entry.activityId === activityId,
      );
      if (current) return cloneRun(current);
      const archived = await this.archive.findRun(activityId, runId);
      return archived ? cloneRun(archived) : null;
    });
  }

  /**
   * Fire-and-forget `automation_run` watcher notification for a terminal run.
   * The watcher service is imported lazily and every failure is swallowed so
   * automation runs never fail (or block) on watcher delivery. Occurrences
   * skipped because the previous run is still active are deliberately not
   * notified — the in-flight run's own completion fires the watcher.
   */
  private notifyRunWatchers(run: ScheduledActivityRun): void {
    if (
      run.status !== 'success' &&
      run.status !== 'failure' &&
      run.status !== 'skipped' &&
      run.status !== 'canceled'
    ) {
      return;
    }
    const status = run.status;
    void import('../app-advisor/watchers')
      .then(({ getAppAdvisorWatcherService }) =>
        getAppAdvisorWatcherService().handleAutomationRunEvent({
          kind: 'automation_run',
          ...(run.executionContext === undefined
            ? {}
            : { executionContext: run.executionContext }),
          activityId: run.activityId,
          activityName: run.activityName,
          runId: run.id,
          manual: run.manual,
          status,
          ...(run.error ? { message: run.error } : {}),
          ...(run.result ? { dispatched: { ...run.result } } : {}),
          completedAt: run.completedAt ?? new Date().toISOString(),
        }),
      )
      .catch((error) => {
        // The run outcome is already persisted; a failed notification is
        // recovered by the watcher service's startup missed-run replay, but
        // it should not disappear silently in the meantime.
        logMainProcessError('Automation watcher notification failed', error);
      });
  }

  private async reserveIdempotencyKey(args: {
    activityId: string;
    runId: string;
    key: string;
    scope: AutomationIfCommandIdempotencyScope;
  }): Promise<'reserved' | 'duplicate' | 'missing-run'> {
    return this.enqueueMutation(async () => {
      const file = await this.ensureFile();
      const run = file.recentRuns.find((entry) => entry.id === args.runId);
      if (!run) return 'missing-run';
      const duplicate = file.recentRuns.some(
        (entry) =>
          entry.id !== args.runId &&
          isIdempotencyScopeMatch(
            {
              activityId: args.activityId,
              key: args.key,
              scope: args.scope,
            },
            entry,
          ),
      );
      if (duplicate) return 'duplicate';

      run.idempotencyKey = args.key;
      run.idempotencyScope = args.scope;
      await this.persistAndNotify(file);
      return 'reserved';
    });
  }

  private applyRunResult(
    activity: ScheduledActivity,
    run: ScheduledActivityRun,
  ): void {
    if (run.status === 'running' || run.status === 'missed') return;
    activity.lastRunAt = run.completedAt ?? new Date().toISOString();
    activity.lastScheduledFor = run.scheduledFor;
    activity.lastResult = {
      status: run.status,
      completedAt: activity.lastRunAt,
      ...(run.error ? { message: run.error } : {}),
      ...(run.result ? { result: run.result } : {}),
    };
    if (run.status === 'success') {
      activity.failureCount = 0;
    } else if (run.status === 'failure') {
      activity.failureCount += 1;
    }
    activity.updatedAt = new Date().toISOString();
  }

  private async executeAction(
    activity: ScheduledActivity,
    ifCommandOutput?: string,
    /** The run was not the user's own, so its chat opens behind the current tab. */
    background = false,
    runId: string = randomUUID(),
  ): Promise<NonNullable<ScheduledActivityRun['result']>> {
    await this.assertTargetCompatibility(activity, true);
    const executionContext = backgroundExecutionContextEnabled()
      ? activity.executionContext
      : undefined;
    const action =
      ifCommandOutput !== undefined
        ? interpolateAutomationActionIfCommandOutput(
            activity.action,
            ifCommandOutput,
          )
        : activity.action;
    const packageOverlay =
      action.type === 'app_advisor_prompt' ||
      action.type === 'standalone_prompt' ||
      action.type === 'worktree_prompt'
        ? await resolveInstalledAutomationPackageOverlay(
            activity.id,
            activity.installedFrom?.capabilityPackage,
          )
        : undefined;
    const automationPipelinePackage =
      action.type === 'worktree_pipeline' &&
      action.pipelineSource === 'user' &&
      activity.installedFrom?.bundledPipelineLocalId === action.pipelineId
        ? await resolveInstalledAutomationPipelinePackage(
            activity.id,
            activity.installedFrom.bundledPipelineLocalId,
            activity.installedFrom.capabilityPackage,
          )
        : undefined;
    // A converted install's package is verified before its run starts, as
    // its native prompt's was; the generated send step applies it (CAN-5479).
    if (action.type === 'worktree_pipeline')
      await verifyOwnedPipelinePackage(activity);
    switch (action.type) {
      case 'app_advisor_prompt': {
        if (!this.surfaces) {
          throw new Error('Automations service is not configured.');
        }
        const preferences = await readPreferencesFile();
        // An Agent on the default model runs on the model a new App Advisor
        // chat starts on, which can differ from the stored preference.
        const appAdvisorModel = namesConcreteAutomationModel(action)
          ? undefined
          : namesInheritingAutomationAgent(action)
            ? await resolveAppAdvisorDefaultModel(preferences)
            : preferences.appAdvisorModel;
        const { model, providerType, executionHarness, modelConfig } =
          resolveAutomationPromptModelSettings(
            action,
            // Present only when the default was actually resolved above. When
            // the action named its own model this is `undefined`, matching the
            // other two prompt cases, and the thinking level is recovered from
            // the named model's provider instead.
            appAdvisorModel
              ? {
                  selection: {
                    model: appAdvisorModel,
                    thinkingLevel: preferences.appAdvisorThinkingLevel,
                  },
                  requireModel: (): {
                    model: ChatModel;
                    thinkingLevel: ThinkingLevel;
                  } => ({
                    model: appAdvisorModel,
                    thinkingLevel: preferences.appAdvisorThinkingLevel,
                  }),
                }
              : undefined,
            preferences.defaultChatModelByProvider,
            // App Advisor's own surface setting: applied regardless of which model
            // the automation names, matching the renderer's `resolveTabDefaults`.
            preferences.appAdvisorThinkingLevel,
            preferences.providerModelConfigDefaults,
          );
        // App Advisor runs Cursor on the managed runtime like a worktree chat;
        // gate before the window opens so a disconnected runtime fails here.
        if (
          executionHarness === 'cursor' &&
          !(await isCursorRuntimeAvailable())
        )
          throw new Error(
            'Connect Cursor in Settings to use it in automations.',
          );
        const pluginSelections = await resolveAutomationPromptPlugins(
          defaultPluginSelections(preferences.appAdvisorPluginSelections),
          action.plugins,
          action.pluginSelections,
        );
        const approvalMode = await resolveAutomationApprovalMode(
          APP_ADVISOR_PROJECT_ID,
          action.approvalMode,
        );
        const resolvedPrompt = await resolveConfiguredPrompt({
          projectId: APP_ADVISOR_PROJECT_ID,
          worktreeId: APP_ADVISOR_WORKTREE_ID,
          providerType,
          executionHarness,
          prompt: action.prompt,
          promptReferences: action.promptReferences,
        });
        const dispatchPluginSelections =
          resolvedPrompt.referencedPluginSelections
            ? mergePluginSelections(
                pluginSelections,
                resolvedPrompt.referencedPluginSelections,
              )
            : pluginSelections;
        await this.authorizePromptPlugins(
          activity,
          {
            projectId: APP_ADVISOR_PROJECT_ID,
            worktreeId: APP_ADVISOR_WORKTREE_ID,
          },
          dispatchPluginSelections,
          model,
        );
        // The native quick prompt refused a Work Entry that is gone with this
        // text; the port would read it as an unreachable chat.
        if (
          action.workEntryId !== undefined &&
          !(await listWorkEntryIds(APP_ADVISOR_PROJECT_ID)).includes(
            action.workEntryId,
          )
        )
          throw new Error(
            `Unknown App Advisor work entry ${action.workEntryId}.`,
          );
        // CAN-5380: the automation's own Work Entry and chat, through the
        // shared port instead of the renderer's quick prompt. A new entry is
        // the planned task, and its founding chat shares its ID, as the quick
        // prompt's entry shared its chat's.
        // The quick prompt always brought the window up before it sent.
        await this.surfaces.ensureAppAdvisorWindow();
        const caller = await automationSendCaller(activity, {
          projectId: APP_ADVISOR_PROJECT_ID,
        });
        const ids = automationSendIds(runId, 'create', executionHarness);
        const surfaces = this.appAdvisorSurfaces();
        // The quick prompt sent its text trimmed, unless resolved file
        // references needed the untrimmed offsets.
        const initialMessage = resolvedPrompt.fileReferences?.length
          ? resolvedPrompt.prompt
          : resolvedPrompt.prompt.trim();
        const created = await dispatchAutomationCreation(
          action.workEntryId === undefined
            ? {
                type: 'bots.create_task',
                botId: APP_ADVISOR_BOT_ID,
                title: workEntryTitle(activity.name),
                initialMessage,
              }
            : {
                type: 'bots.create_task_chat',
                botId: APP_ADVISOR_BOT_ID,
                taskId: action.workEntryId,
                initialMessage,
              },
          caller,
          {
            actionType: action.type,
            ...(action.workEntryId === undefined
              ? { plannedTaskId: ids.taskId }
              : {}),
            newChatSeed: {
              model,
              providerType,
              modelConfig,
              planMode: action.planMode === true,
              approvalMode,
              ...(pluginSelections || resolvedPrompt.referencedPluginSelections
                ? { pluginSelections: dispatchPluginSelections }
                : {}),
            },
            ...(resolvedPrompt.fileReferences
              ? {
                  composition: {
                    fileReferences: resolvedPrompt.fileReferences,
                  },
                }
              : {}),
            fixedIds: ids,
            automationDispatch: {
              version: 1,
              automationName: activity.name,
              // The quick prompt always focused its chat in the window.
              presentation: 'foreground',
              executionContext: executionContext ?? 'personal',
              ...(packageOverlay ? { packageOverlay } : {}),
            },
            ...(surfaces ? { surfaces } : {}),
          },
        );
        if (action.workEntryId === undefined) {
          await assignNewAutomationItemToSidebarGroup({
            scope: { appAdvisor: true },
            itemId: created.address.taskId,
            name: action.sidebarGroupName,
          });
        }
        // The quick prompt showed its chat; the message is already accepted,
        // so a selection failure doesn't fail the run.
        try {
          await this.surfaces.ensureAppAdvisorWindow({
            chatId: created.address.chatId,
          });
        } catch {
          logMainProcessError('Automation Orchestrator chat selection failed', {
            operation: 'select-orchestrator-chat',
          });
        }
        return {
          appAdvisorChatId: created.address.chatId,
          userMessageId: created.input.messageId,
        };
      }
      case 'standalone_prompt': {
        await assertCoworkWorkspaceRootPresent(action.chatProjectId);
        if (!this.surfaces) {
          throw new Error('Automations service is not configured.');
        }
        const coworkWorkspaceId = resolveCoworkWorkspaceId(
          action.chatProjectId,
        );
        const preferences = await readPreferencesFile();
        const standaloneDefault = await resolveAutomationLaneDefault(
          action,
          preferences,
          'chat',
          // `sendStandaloneChatMessage` dispatches into this cowork workspace,
          // and the session spawn resolves its Environments credentials for it.
          { workspaceId: coworkWorkspaceId },
        );
        const { model, providerType, executionHarness, modelConfig } =
          resolveAutomationPromptModelSettings(
            action,
            standaloneDefault,
            preferences.defaultChatModelByProvider,
            undefined,
            preferences.providerModelConfigDefaults,
          );
        // Cowork runs Cursor on the managed runtime like a worktree chat;
        // gate before the Work Entry and prompt are persisted.
        if (
          executionHarness === 'cursor' &&
          !(await isCursorRuntimeAvailable())
        )
          throw new Error(
            'Connect Cursor in Settings to use it in automations.',
          );
        // Cowork project defaults are inherited live by the created chat, so
        // they are authorized below but not copied into its selection.
        const pluginSelections = await resolveAutomationPromptPlugins(
          undefined,
          action.plugins,
          action.pluginSelections,
        );
        const approvalMode = await resolveAutomationApprovalMode(
          coworkWorkspaceId,
          action.approvalMode,
        );
        const resolvedPrompt = await resolveConfiguredPrompt({
          projectId: coworkWorkspaceId,
          worktreeId: COWORK_HOME_WORKTREE_ID,
          providerType,
          executionHarness,
          prompt: action.prompt,
          promptReferences: action.promptReferences,
        });
        const dispatchPluginSelections =
          resolvedPrompt.referencedPluginSelections
            ? mergePluginSelections(
                pluginSelections,
                resolvedPrompt.referencedPluginSelections,
              )
            : pluginSelections;
        await this.authorizePromptPlugins(
          activity,
          { projectId: coworkWorkspaceId, worktreeId: COWORK_HOME_WORKTREE_ID },
          withInheritedDefaults(
            await resolveStandaloneDefaultPluginSelections(
              action.chatProjectId,
            ),
            dispatchPluginSelections,
          ),
          model,
        );
        // The native send refused a Work Entry that is gone with this text;
        // the port would read it as an unreachable chat.
        if (
          action.workEntryId !== undefined &&
          !(await listWorkEntryIds(coworkWorkspaceId)).includes(
            action.workEntryId,
          )
        )
          throw new Error(AUTOMATION_WORK_ENTRY_UNAVAILABLE_MESSAGE);
        // CAN-5379: the automation's own Work Entry and chat, through the
        // shared port. A new entry is the planned task, and its founding chat
        // shares its ID, as the native send's entry shared its chat's.
        const caller = await automationSendCaller(activity, {
          projectId: coworkWorkspaceId,
        });
        const ids = automationSendIds(runId, 'create', executionHarness);
        const created = await dispatchAutomationCreation(
          action.workEntryId === undefined
            ? {
                type: 'projects.create_task',
                projectId: coworkWorkspaceId,
                initialMessage: resolvedPrompt.prompt,
              }
            : {
                type: 'projects.create_task_chat',
                projectId: coworkWorkspaceId,
                taskId: action.workEntryId,
                initialMessage: resolvedPrompt.prompt,
              },
          caller,
          {
            actionType: action.type,
            ...(action.workEntryId === undefined
              ? { plannedTaskId: ids.taskId }
              : {}),
            newChatSeed: {
              model,
              providerType,
              modelConfig,
              planMode: action.planMode === true,
              approvalMode,
              ...(pluginSelections || resolvedPrompt.referencedPluginSelections
                ? { pluginSelections: dispatchPluginSelections }
                : {}),
            },
            ...(resolvedPrompt.fileReferences
              ? {
                  composition: {
                    fileReferences: resolvedPrompt.fileReferences,
                  },
                }
              : {}),
            fixedIds: ids,
            automationDispatch: {
              version: 1,
              automationName: activity.name,
              // The native Cowork send never kept the active tab, on Run now
              // or a scheduled run.
              presentation: 'foreground',
              executionContext: executionContext ?? 'personal',
              ...(packageOverlay ? { packageOverlay } : {}),
            },
          },
        );
        if (action.workEntryId === undefined) {
          await assignNewAutomationItemToSidebarGroup({
            scope: { workspaceLocalId: coworkWorkspaceId },
            itemId: created.address.taskId,
            name: action.sidebarGroupName,
          });
        }
        return {
          standaloneChatId: created.address.chatId,
          projectId: coworkWorkspaceId,
          userMessageId: created.input.messageId,
        };
      }
      case 'worktree_prompt': {
        if (!this.surfaces) {
          throw new Error('Automations service is not configured.');
        }
        // `existingWorktreeId` targets an already-provisioned worktree: no
        // worktree row is created and no setup scripts run, so there is
        // nothing to roll back on dispatch failure (readyWorktree stays
        // null on that path).
        const { existingWorktreeId } = action;
        let readyWorktree: ReadyWorktree | null = null;
        let worktreeId: string;
        if (existingWorktreeId === undefined) {
          readyWorktree = await this.createReadyWorktree(action);
          worktreeId = readyWorktree.id;
          // A worktree branched from a base worktree is a branch-stack child,
          // which follows its root and cannot join a group on its own.
          if (action.baseWorktreeId === undefined) {
            await assignNewAutomationItemToSidebarGroup({
              scope: { workspaceLocalId: action.workspaceId },
              itemId: worktreeId,
              name: action.sidebarGroupName,
            });
          }
        } else {
          worktreeId = await this.resolveExistingWorktreeTarget(
            action.workspaceId,
            existingWorktreeId,
          );
        }
        let executionStarted = false;
        try {
          const preferences = await readPreferencesFile();
          const worktreeDefault = await resolveAutomationLaneDefault(
            action,
            preferences,
            'worktree',
            // Same workspace `sendWorktreeChatMessage` dispatches into below.
            { workspaceId: action.workspaceId },
          );
          const { model, providerType, executionHarness, modelConfig } =
            resolveAutomationPromptModelSettings(
              action,
              worktreeDefault,
              preferences.defaultWorktreeModelByProvider,
              undefined,
              preferences.providerModelConfigDefaults,
            );
          // Only now, and only for a dispatch that actually resolved to Cursor.
          if (
            executionHarness === 'cursor' &&
            !(await isCursorRuntimeAvailable())
          )
            throw new Error(
              'Connect Cursor in Settings to use it in automations.',
            );
          // Project defaults are inherited live by the created chat, so they
          // are authorized below but not copied into its selection.
          const pluginSelections = await resolveAutomationPromptPlugins(
            undefined,
            action.plugins,
            action.pluginSelections,
          );
          const interfaceMode =
            providerType === 'claude' && action.interfaceMode
              ? getPersistedClaudeChatInterfaceMode(action.interfaceMode)
              : undefined;
          const approvalMode = await resolveAutomationApprovalMode(
            action.workspaceId,
            action.approvalMode,
          );
          const resolvedPrompt = await resolveConfiguredPrompt({
            projectId: action.workspaceId,
            worktreeId,
            providerType,
            executionHarness,
            prompt: action.prompt,
            promptReferences: action.promptReferences,
          });
          const dispatchPluginSelections =
            resolvedPrompt.referencedPluginSelections
              ? mergePluginSelections(
                  pluginSelections,
                  resolvedPrompt.referencedPluginSelections,
                )
              : pluginSelections;
          await this.authorizePromptPlugins(
            activity,
            { projectId: action.workspaceId, worktreeId: worktreeId },
            withInheritedDefaults(
              await resolveWorkspaceDefaultPluginSelections(action.workspaceId),
              dispatchPluginSelections,
            ),
            model,
          );
          if (!staysNativeAutomationSend(activity)) {
            // CAN-5379: the automation's own chat, through the shared port. A
            // worktree created for this run may already hold the renderer's
            // blank starter, which the seeded chat replaces so the automation's
            // chat is the only one there. An existing worktree's empty tab can
            // be a user's draft, so that target always gets a new chat.
            const caller = await automationSendCaller(activity, {
              projectId: action.workspaceId,
              worktreeId,
            });
            const ids = automationSendIds(runId, 'create', executionHarness);
            executionStarted = true;
            const created = await dispatchAutomationCreation(
              {
                type: 'projects.create_task_chat',
                projectId: action.workspaceId,
                taskId: worktreeId,
                initialMessage: resolvedPrompt.prompt,
              },
              caller,
              {
                actionType: action.type,
                newChatSeed: {
                  model,
                  providerType,
                  modelConfig,
                  planMode: action.planMode === true,
                  approvalMode,
                  ...(pluginSelections ||
                  resolvedPrompt.referencedPluginSelections
                    ? { pluginSelections: dispatchPluginSelections }
                    : {}),
                  ...(interfaceMode ? { interfaceMode } : {}),
                },
                ...(readyWorktree !== null
                  ? { reuseStarterChat: true as const }
                  : {}),
                ...(resolvedPrompt.fileReferences
                  ? {
                      composition: {
                        fileReferences: resolvedPrompt.fileReferences,
                      },
                    }
                  : {}),
                fixedIds: ids,
                automationDispatch: {
                  version: 1,
                  automationName: activity.name,
                  presentation: background ? 'background' : 'foreground',
                  executionContext: executionContext ?? 'personal',
                  ...(packageOverlay ? { packageOverlay } : {}),
                },
              },
            );
            return {
              projectId: action.workspaceId,
              worktreeId,
              chatId: created.address.chatId,
              userMessageId: created.input.messageId,
            };
          }
          // The Home composer's deferred scheduled task (D4) keeps the native
          // send. A worktree created for this run may already hold the
          // renderer's empty starter chat: leaving the chat unnamed lets the
          // chat service reuse that tab. An existing worktree's empty tab can
          // be a user's draft, so that target always gets a new chat.
          const chatId = readyWorktree === null ? randomUUID() : undefined;
          const userMessageId = randomUUID();
          executionStarted = true;
          const sent = await sendWorktreeChatMessage(
            {
              projectId: action.workspaceId,
              worktreeId,
              ...(chatId === undefined ? {} : { chatId }),
              userMessageId,
              text: resolvedPrompt.prompt,
              fileReferences: resolvedPrompt.fileReferences,
              planMode: action.planMode === true,
              model,
              providerType,
              executionHarness,
              modelConfig,
              thinkingLevel: modelConfig.thinkingLevel,
              initiationSource: 'automation',
              ...(background ? { preserveActiveTab: true } : {}),
              automationName: activity.name,
              ...(pluginSelections || resolvedPrompt.referencedPluginSelections
                ? {
                    pluginSelections: dispatchPluginSelections,
                  }
                : {}),
              ...(packageOverlay ? { packageOverlay } : {}),
              ...(interfaceMode ? { interfaceMode } : {}),
              approvalMode,
            },
            {
              getWindow: this.surfaces.getMainWindow,
              executionContext: executionContext ?? 'personal',
            },
          );
          return {
            projectId: action.workspaceId,
            worktreeId,
            chatId: sent.chatId,
            userMessageId,
          };
        } catch (error) {
          if (!executionStarted && readyWorktree !== null) {
            await this.disposeFailedReadyWorktree(
              readyWorktree.workspaceType,
              action.workspaceId,
              readyWorktree.id,
              readyWorktree.createdAt,
            ).catch((cleanupError) => {
              // eslint-disable-next-line no-console
              console.error(
                'Failed to clean up automation worktree after prompt failure:',
                cleanupError,
              );
            });
          }
          throw error;
        }
      }
      case 'worktree_pipeline': {
        if (!this.surfaces) {
          throw new Error('Automations service is not configured.');
        }
        // Pipelines keep boolean Fast mode. Reject a stored Ultra fast request
        // explicitly before creating a worktree or starting any execution.
        const pipelineSpeedError = automationPipelineSpeedError(
          action.modelConfig,
        );
        if (pipelineSpeedError) throw new Error(pipelineSpeedError);
        const target = resolveAutomationPipelineTarget(action);
        if (!target)
          throw new Error(
            validateAutomationAction(action) ??
              'Edit this automation and choose where the workflow runs.',
          );
        const identity = automationRunIdentity(
          activity,
          ifCommandOutput,
          background,
        );
        if (target.kind === 'global')
          return await this.executeGlobalPipelineAction(
            activity,
            action,
            automationPipelinePackage,
            executionContext,
            identity,
          );
        const workspaceId = target.workspaceId;
        const { items } = await readAllSidebarItems();
        const workspace = items.find((item) => item.id === workspaceId);
        if (!workspace) throw new Error('Project not found.');
        if (workspace.type === 'cowork') {
          return await this.executeCoworkPipelineAction(
            action,
            workspaceId,
            target.kind === 'task' ? target.taskId : undefined,
            automationPipelinePackage,
            executionContext,
            activity.id,
            activity.targetRequirement,
            identity,
          );
        }
        if (target.kind === 'task' || target.kind === 'project')
          return await this.executeExistingCheckoutPipelineAction(
            activity,
            action,
            workspace,
            target,
            automationPipelinePackage,
            executionContext,
            identity,
          );
        const readyWorktree = await this.createReadyWorktree(action);
        const worktreeId = readyWorktree.id;
        let executionStarted = false;
        try {
          const cwd = this.resolveWorktreeCwd(
            workspaceId,
            worktreeId,
            action.repoId,
          );
          const pipelineSelection = await this.resolvePipelineSelection(
            action,
            cwd,
          );
          if (!pipelineSelection.sharedPipeline) {
            this.assertResolvedPipelineTarget(
              activity,
              workspace.type,
              pipelineSelection.pipeline,
            );
          }
          const childPipelineAuthorizations =
            await this.authorizeResolvedPipeline(
              activity.id,
              executionContext,
              pipelineSelection,
              cwd,
              workspaceId,
              pipelineExecutionPreferences(action),
            );
          if (
            !getTriggerTypes(pipelineSelection.pipeline.on).includes('dispatch')
          ) {
            throw new Error('Workflow does not support dispatch triggers.');
          }
          const pipelineExecutionId = await this.startAutomationPipeline({
            action,
            selection: pipelineSelection,
            location: {
              cwd,
              projectId: workspaceId,
              worktreeId,
              repoPath: action.repoId ? cwd : undefined,
            },
            executionContext,
            childPipelineAuthorizations,
            automationPipelinePackage,
            identity,
            activityId: activity.id,
          });
          executionStarted = true;
          return { projectId: workspaceId, worktreeId, pipelineExecutionId };
        } catch (error) {
          if (!executionStarted) {
            await this.disposeFailedReadyWorktree(
              readyWorktree.workspaceType,
              workspaceId,
              readyWorktree.id,
              readyWorktree.createdAt,
            ).catch((cleanupError) => {
              // eslint-disable-next-line no-console
              console.error(
                'Failed to clean up automation worktree after pipeline failure:',
                cleanupError,
              );
            });
          }
          throw error;
        }
      }
      case 'pipeline_execution_resume': {
        if (!this.surfaces) {
          throw new Error('Automations service is not configured.');
        }
        const result = await resumePipelineExecutionFromMain({
          executionId: action.executionId,
          statusReasonIds: action.statusReasonIds,
          allowStaleNoop: true,
          initiationSource: 'automation',
          persistInitiationSource: true,
          getWindow: this.surfaces.getMainWindow,
        });
        return { pipelineExecutionId: result.state.id };
      }
      case 'worktree_session_prompt': {
        if (action.purpose === 'usage_limit_resume') {
          // A purpose tag is only intent. Revalidate the interruption at execution
          // and derive the prompt from canonical state rather than stored text.
          if (!this.surfaces)
            throw new Error('Automations service is not configured.');
          const { readUsageLimitedChats } =
            await import('../lib/usage-limited-chats-registry');
          const target = {
            projectId: action.workspaceId,
            worktreeId: action.worktreeId,
            chatId: action.chatId,
          };
          const current = (await readUsageLimitedChats()).find(
            (entry) =>
              entry.projectId === target.projectId &&
              entry.worktreeId === target.worktreeId &&
              entry.chatId === target.chatId,
          );
          const createdAt = Date.parse(activity.createdAt);
          if (
            !current ||
            (current.resumeReason && current.resumeReason !== 'usage_limit') ||
            !Number.isFinite(createdAt) ||
            current.detectedAt > createdAt ||
            activity.agentScheduledSend
          )
            throw new Error(
              'This scheduled resume no longer matches an eligible interruption.',
            );
          const { handleResumeUsageLimitedChats } =
            await import('../ipc/usage-limited-chats');
          const userMessageId = `automation-${runId}`;
          const result = await handleResumeUsageLimitedChats(
            { targets: [target] },
            this.surfaces.getMainWindow,
            userMessageId,
          );
          if (result.resumedCount !== 1)
            throw new Error('The scheduled resume could not be dispatched.');
          return { ...target, userMessageId };
        }
        if (!this.surfaces) {
          throw new Error('Automations service is not configured.');
        }
        let tabOptions: ExistingTabDispatchOptions;
        try {
          tabOptions = await buildExistingTabDispatchOptions(
            action.workspaceId,
            action.worktreeId,
            action.chatId,
          );
        } catch (error) {
          if (error instanceof ExistingTabDispatchTargetNotFoundError) {
            throw new Error(
              'That chat is no longer available. Edit this automation and pick another destination.',
            );
          }
          if (
            error instanceof Error &&
            error.message === 'Target chat is readonly.'
          ) {
            throw new Error(
              'That chat is archived and cannot receive automation messages. Edit this automation and pick another destination.',
            );
          }
          throw error;
        }
        // Capture the OpenCode connection before resolution, so a change at
        // any point before dispatch refuses the send.
        const openCodeGenerationAtResolve = getOpenCodeConnectionGeneration();
        const resolvedOverride = await resolveChatTurnOverride(
          {
            projectId: action.workspaceId,
            worktreeId: action.worktreeId,
            chatId: action.chatId,
          },
          tabOptions,
          {
            model: action.model,
            modelConfig: action.modelConfig,
            planMode: action.planMode,
            approvalMode: action.approvalMode,
            plugins: action.plugins,
            pluginSelections: action.pluginSelections,
          },
        );
        const selectedHarness = selectedTurnHarness(
          tabOptions,
          resolvedOverride.model,
          resolvedOverride.executionHarness,
        );
        const opencodeGeneration =
          selectedHarness === 'opencode'
            ? openCodeGenerationAtResolve
            : undefined;
        const isAppAdvisorTarget =
          action.workspaceId === APP_ADVISOR_PROJECT_ID;
        const appAdvisorSurfaces = isAppAdvisorTarget
          ? this.appAdvisorSurfaces()
          : undefined;
        if (isAppAdvisorTarget && !appAdvisorSurfaces) {
          throw new Error(
            'Automations service is missing App Advisor chat surfaces.',
          );
        }
        // OpenCode requires a UUID; both routes retain the durable run identity.
        const sessionPromptUserMessageId =
          selectedHarness === 'opencode' ? runId : `automation-${runId}`;
        const resolvedPrompt = await resolveConfiguredPrompt({
          projectId: action.workspaceId,
          worktreeId: action.worktreeId,
          selectedRepoId: tabOptions.selectedRepoId,
          providerType:
            resolvedOverride.providerType ?? tabOptions.providerType,
          executionHarness:
            resolvedOverride.executionHarness ??
            tabOptions.executionHarness ??
            (tabOptions.model
              ? getExecutionHarnessForModel(tabOptions.model)
              : undefined),
          prompt: action.prompt,
          promptReferences: action.promptReferences,
        });
        // The prompt binds against the resolved runtime, so its plugin
        // references join the override after it.
        const turnOverride = withPromptPluginSelections(
          resolvedOverride,
          tabOptions,
          resolvedPrompt.referencedPluginSelections,
        );
        const { approvalMode, pluginSelections } = turnOverride;
        await this.authorizePromptPlugins(
          activity,
          { projectId: action.workspaceId, worktreeId: action.worktreeId },
          await resolveBackgroundChatPluginSelections(
            pluginSelections ?? tabOptions.pluginSelections,
            {
              projectId: action.workspaceId,
              worktreeId: action.worktreeId,
              chatId: action.chatId,
            },
          ),
          turnOverride.model ?? tabOptions.model,
        );
        const scheduledSender = activity.agentScheduledSend?.provenance.sender;
        if (scheduledSender?.kind === 'project') {
          // A root agent's scheduled message passes its admission again now.
          const { admitScheduledProjectMessage } =
            await import('../agent-actions/desktop-project-bot-port');
          await admitScheduledProjectMessage(
            {
              workspaceId: scheduledSender.projectId,
              worktreeId: scheduledSender.taskId,
              chatId: scheduledSender.chatId,
            },
            {
              workspaceId: action.workspaceId,
              worktreeId: action.worktreeId,
              chatId: action.chatId,
            },
            {
              ...tabOptions,
              kind: 'chat',
              ...(approvalMode ? { approvalMode } : {}),
            },
          );
        }
        if (opencodeGeneration !== undefined)
          assertOpenCodeConnectionGeneration(opencodeGeneration);
        if (!staysNativeAutomationSend(activity)) {
          // CAN-4549: the automation's own send, through the shared port.
          const caller = await automationSendCaller(activity, {
            projectId: action.workspaceId,
            worktreeId: action.worktreeId,
          });
          if (isAppAdvisorTarget) await this.surfaces.ensureAppAdvisorWindow();
          // A terminal chat refuses settings it would not apply, with the
          // native send's text, before the shared port accepts the input.
          await assertTerminalChatAcceptsSettings(
            {
              projectId: action.workspaceId,
              worktreeId: action.worktreeId,
              chatId: action.chatId,
            },
            {
              ...(turnOverride.resetRuntime
                ? {
                    providerType: turnOverride.providerType,
                    executionHarness: turnOverride.executionHarness,
                  }
                : {}),
              ...(turnOverride.model ? { model: turnOverride.model } : {}),
              ...(turnOverride.modelConfig
                ? { modelConfig: turnOverride.modelConfig }
                : {}),
              ...(turnOverride.planMode !== undefined
                ? { planMode: turnOverride.planMode }
                : {}),
              ...(approvalMode ? { approvalMode } : {}),
              ...(pluginSelections ? { pluginSelections } : {}),
            },
          );
          const ids = automationSendIds(runId, 'session', selectedHarness);
          const target = {
            taskId: action.worktreeId,
            chatId: action.chatId,
            text: resolvedPrompt.prompt,
          };
          if (opencodeGeneration !== undefined)
            assertOpenCodeConnectionGeneration(opencodeGeneration);
          await dispatchAutomationAction(
            isAppAdvisorTarget
              ? {
                  type: 'bots.send_message',
                  botId: APP_ADVISOR_BOT_ID,
                  ...target,
                }
              : {
                  type: 'projects.send_message',
                  projectId: action.workspaceId,
                  ...target,
                },
            caller,
            {
              actionType: action.type,
              turnOverride,
              composition: {
                fileReferences:
                  resolvedPrompt.fileReferences ?? action.fileReferences,
                attachmentPaths: action.attachmentPaths,
                attachmentPromptContexts: action.attachmentPromptContexts,
                inputMode: action.inputMode ?? 'typed',
              },
              fixedIds: ids,
              automationDispatch: {
                version: 1,
                automationName: activity.name,
                presentation: background ? 'background' : 'foreground',
                executionContext: executionContext ?? 'personal',
              },
              ...(appAdvisorSurfaces ? { surfaces: appAdvisorSurfaces } : {}),
            },
          );
          return {
            projectId: action.workspaceId,
            worktreeId: action.worktreeId,
            chatId: action.chatId,
            userMessageId: ids.userMessageId,
          };
        }
        if (isAppAdvisorTarget) {
          await this.surfaces.ensureAppAdvisorWindow();
          if (opencodeGeneration !== undefined)
            assertOpenCodeConnectionGeneration(opencodeGeneration);
        }
        await sendWorktreeChatMessage(
          {
            projectId: action.workspaceId,
            worktreeId: action.worktreeId,
            chatId: action.chatId,
            text: resolvedPrompt.prompt,
            userMessageId: sessionPromptUserMessageId,
            ...(activity.agentScheduledSend
              ? rebindAgentSenderRequest(
                  activity.agentScheduledSend,
                  sessionPromptUserMessageId,
                  action.workspaceId,
                )
              : {}),
            initiationSource: 'automation',
            ...(background ? { preserveActiveTab: true } : {}),
            automationName: activity.name,
            fileReferences:
              resolvedPrompt.fileReferences ?? action.fileReferences,
            attachmentPaths: action.attachmentPaths,
            attachmentPromptContexts: action.attachmentPromptContexts,
            inputMode: action.inputMode ?? 'typed',
            ...tabOptions,
            // A changed runtime cannot resume the chat's session.
            ...(turnOverride.resetRuntime
              ? {
                  sdkSessionId: undefined,
                  globalInstructionsSnapshot: undefined,
                  codexReconstructionSeedId: undefined,
                  claudeForkSession: undefined,
                  claudeForkResumeAt: undefined,
                  claudeForkStartsFresh: undefined,
                  providerType: turnOverride.providerType,
                  executionHarness: turnOverride.executionHarness,
                }
              : {}),
            ...(turnOverride.model ? { model: turnOverride.model } : {}),
            ...(turnOverride.modelConfig
              ? { modelConfig: turnOverride.modelConfig }
              : {}),
            ...(turnOverride.planMode !== undefined
              ? { planMode: turnOverride.planMode }
              : {}),
            ...(approvalMode ? { approvalMode } : {}),
            ...(pluginSelections ? { pluginSelections } : {}),
          },
          {
            getWindow: this.surfaces.getMainWindow,
            ...(appAdvisorSurfaces ? { appAdvisorSurfaces } : {}),
            executionContext: executionContext ?? 'personal',
          },
        );
        return {
          projectId: action.workspaceId,
          worktreeId: action.worktreeId,
          chatId: action.chatId,
          userMessageId: sessionPromptUserMessageId,
        };
      }
    }
  }

  /**
   * Dispatch a `worktree_pipeline` action whose workspace is a cowork
   * workspace. Cowork has no worktrees: the pipeline runs directory-scoped
   * at the cowork root (managed `home/` or the attached external folder).
   * `startPipelineExecutionFromMain` forces `scope: 'directory'` for cowork
   * project ids, so no explicit scope plumbing is needed here.
   */
  private async executeCoworkPipelineAction(
    action: Extract<AutomationAction, { type: 'worktree_pipeline' }>,
    workspaceId: string,
    /** Existing Work Entry the run keeps as its task identity. */
    workEntryId: string | undefined,
    automationPipelinePackage?: NonNullable<
      Awaited<ReturnType<typeof resolveInstalledAutomationPipelinePackage>>
    >,
    executionContext?: string,
    activityId?: string,
    targetRequirement?: ScheduledActivity['targetRequirement'],
    identity?: AutomationRunIdentity,
  ): Promise<NonNullable<ScheduledActivityRun['result']>> {
    if (!this.surfaces) {
      throw new Error('Automations service is not configured.');
    }
    if (action.baseWorktreeId) {
      throw new Error(
        'Base worktree cannot be used with a cowork project workflow.',
      );
    }
    if (action.repoId) {
      throw new Error(
        'Repository selection cannot be used with a cowork project workflow.',
      );
    }
    const cwd = getCoworkWorkspaceRootDir(workspaceId);
    const pipelineSelection = await this.resolvePipelineSelection(action, cwd);
    if (!pipelineSelection.sharedPipeline) {
      this.assertResolvedPipelineTarget(
        { action, targetRequirement },
        'cowork',
        pipelineSelection.pipeline,
      );
    }
    const childPipelineAuthorizations = await this.authorizeResolvedPipeline(
      activityId,
      executionContext,
      pipelineSelection,
      cwd,
      workspaceId,
      pipelineExecutionPreferences(action),
    );
    if (!getTriggerTypes(pipelineSelection.pipeline.on).includes('dispatch')) {
      throw new Error('Workflow does not support dispatch triggers.');
    }
    // Fail fast with a clear message for worktree-only pipelines instead of
    // letting the executor's scope gate fail the run after it starts.
    // Shared pipelines carry a synthetic content stub here; their real scope
    // is still enforced by the executor gate after the cached fetch.
    const declaredScopes = normalizePipelineScopes(
      pipelineSelection.pipeline.scope,
      'pipeline.scope',
    );
    if (!executionContextSatisfies(declaredScopes, 'directory')) {
      throw new Error(
        'Workflow requires a worktree and cannot run in a cowork project.',
      );
    }
    const pipelineExecutionId = await this.startAutomationPipeline({
      action,
      selection: pipelineSelection,
      location: {
        cwd,
        projectId: workspaceId,
        ...(workEntryId ? { worktreeId: workEntryId } : {}),
        ...(pipelineSelection.pipelineFilePath ? { repoPath: cwd } : {}),
      },
      executionContext,
      childPipelineAuthorizations,
      automationPipelinePackage,
      identity,
      activityId,
    });
    return {
      projectId: workspaceId,
      ...(workEntryId ? { worktreeId: workEntryId } : {}),
      pipelineExecutionId,
    };
  }

  /**
   * Run in an existing tracked worktree or the project folder of a code
   * project. Nothing is provisioned, so nothing is cleaned up on failure.
   */
  private async executeExistingCheckoutPipelineAction(
    activity: ScheduledActivity,
    action: PipelineAutomationAction,
    workspace: Exclude<SidebarItem, { type: 'cowork' }>,
    target: Extract<
      ResolvedAutomationPipelineTarget,
      { kind: 'task' } | { kind: 'project' }
    >,
    automationPipelinePackage:
      | NonNullable<
          Awaited<ReturnType<typeof resolveInstalledAutomationPipelinePackage>>
        >
      | undefined,
    executionContext: string | undefined,
    identity: AutomationRunIdentity,
  ): Promise<NonNullable<ScheduledActivityRun['result']>> {
    const workspaceId = target.workspaceId;
    let cwd: string;
    if (target.kind === 'task') {
      if (!workspace.worktrees.some((entry) => entry.id === target.taskId))
        throw new Error(PIPELINE_TARGET_TASK_MISSING_ERROR);
      cwd = this.resolveWorktreeCwd(workspaceId, target.taskId, action.repoId);
    } else {
      // The configured source folder, not its main checkout: dispatch
      // authorizes the run against the project's configured roots, and the
      // editor discovers its pipelines there.
      const root = projectRootPipelineCwd(workspace, action.repoId);
      const rootCwd = 'sourceRepoPath' in root ? root.sourceRepoPath : root.cwd;
      if (!rootCwd)
        throw new Error(PIPELINE_TARGET_PROJECT_ROOT_REQUIRED_ERROR);
      cwd = rootCwd;
    }
    const pipelineSelection = await this.resolvePipelineSelection(action, cwd);
    if (!pipelineSelection.sharedPipeline) {
      this.assertResolvedPipelineTarget(
        activity,
        workspace.type,
        pipelineSelection.pipeline,
      );
    }
    const childPipelineAuthorizations = await this.authorizeResolvedPipeline(
      activity.id,
      executionContext,
      pipelineSelection,
      cwd,
      workspaceId,
      pipelineExecutionPreferences(action),
    );
    if (!getTriggerTypes(pipelineSelection.pipeline.on).includes('dispatch')) {
      throw new Error('Workflow does not support dispatch triggers.');
    }
    const pipelineExecutionId = await this.startAutomationPipeline({
      action,
      selection: pipelineSelection,
      location:
        target.kind === 'task'
          ? {
              cwd,
              projectId: workspaceId,
              worktreeId: target.taskId,
              // Explicit so the start path refuses a worktree a split has locked.
              scope: 'worktree',
              repoPath: action.repoId ? cwd : undefined,
            }
          : {
              cwd,
              projectId: workspaceId,
              scope: 'directory',
              target: { scope: 'directory', path: cwd },
              ...(pipelineSelection.pipelineFilePath || action.repoId
                ? { repoPath: cwd }
                : {}),
            },
      executionContext,
      childPipelineAuthorizations,
      automationPipelinePackage,
      identity,
      activityId: activity.id,
    });
    return target.kind === 'task'
      ? {
          projectId: workspaceId,
          worktreeId: target.taskId,
          pipelineExecutionId,
        }
      : { projectId: workspaceId, pipelineExecutionId };
  }

  /**
   * Run with no project, as the automation's saved owner, in the execution's
   * own scratch folder. No project pipeline discovery runs; the main start
   * path authorizes the definition once that folder exists.
   */
  private async executeGlobalPipelineAction(
    activity: ScheduledActivity,
    action: PipelineAutomationAction,
    automationPipelinePackage:
      | NonNullable<
          Awaited<ReturnType<typeof resolveInstalledAutomationPipelinePackage>>
        >
      | undefined,
    executionContext: string | undefined,
    identity: AutomationRunIdentity,
  ): Promise<NonNullable<ScheduledActivityRun['result']>> {
    const pipelineSelection = await this.resolvePipelineSelection(action, '');
    if (!getTriggerTypes(pipelineSelection.pipeline.on).includes('dispatch')) {
      throw new Error('Workflow does not support dispatch triggers.');
    }
    const pipelineExecutionId = await this.startAutomationPipeline({
      action,
      selection: pipelineSelection,
      location: { scope: 'global' },
      executionContext,
      childPipelineAuthorizations: undefined,
      automationPipelinePackage,
      identity,
      activityId: activity.id,
    });
    return { pipelineExecutionId };
  }

  /**
   * Start an automation's resolved pipeline at `location` with its identity,
   * inputs, preferences, and package. Returns the execution id; a pinned
   * shared pipeline that changed asks for review instead.
   */
  private async startAutomationPipeline(args: {
    action: PipelineAutomationAction;
    selection: ResolvedPipelineSelection;
    location: Pick<
      Parameters<typeof startPipelineExecutionFromMain>[0]['options'],
      'cwd' | 'projectId' | 'worktreeId' | 'repoPath' | 'scope' | 'target'
    >;
    executionContext: string | undefined;
    childPipelineAuthorizations: ChildPipelineAuthorization[] | undefined;
    automationPipelinePackage:
      | NonNullable<
          Awaited<ReturnType<typeof resolveInstalledAutomationPipelinePackage>>
        >
      | undefined;
    identity: AutomationRunIdentity | undefined;
    activityId: string | undefined;
  }): Promise<string> {
    if (!this.surfaces) {
      throw new Error('Automations service is not configured.');
    }
    const { action, selection, executionContext } = args;
    const result = await startPipelineExecutionFromMain({
      pipeline: selection.pipeline,
      getWindow: this.surfaces.getMainWindow,
      options: {
        ...args.location,
        pipelineId: action.pipelineId,
        ...(executionContext === undefined ? {} : { executionContext }),
        ...(args.childPipelineAuthorizations === undefined
          ? {}
          : { childPipelineAuthorizations: args.childPipelineAuthorizations }),
        initiationSource: 'automation',
        ...args.identity,
        ...(selection.pipelineFilePath
          ? { pipelineFilePath: selection.pipelineFilePath }
          : {}),
        ...(selection.pipelinePreferenceLocator
          ? { pipelinePreferenceLocator: selection.pipelinePreferenceLocator }
          : {}),
        ...(selection.sharedPipeline
          ? { sharedPipeline: selection.sharedPipeline }
          : {}),
        inputs: action.inputs,
        ...pipelineExecutionPreferences(action),
        ...(action.modelConfig ? { modelConfig: action.modelConfig } : {}),
        ...(args.automationPipelinePackage
          ? { automationPipelinePackage: args.automationPipelinePackage }
          : {}),
      },
    });
    if (!result.success) {
      if (
        result.errorCode === 'shared_pipeline_changed' &&
        action.pipelineSource === 'shared' &&
        action.sharedPipeline?.installPin
      ) {
        throw new SharedPipelineReviewRequiredError(
          action.sharedPipeline.remoteId,
          action.sharedPipeline.installPin,
          action.pipelineName,
        );
      }
      if (selection.sharedPipeline)
        await this.rejectSharedPipelineDispatchFailure(
          args.activityId,
          executionContext,
          result.error,
        );
      throw new Error(result.error);
    }
    return result.data.id;
  }

  private async resolvePipelineSelection(
    action: Extract<AutomationAction, { type: 'worktree_pipeline' }>,
    cwd: string,
  ): Promise<{
    pipeline: Pipeline;
    owner?: unknown;
    storedPipelineRemoteId?: string;
    pipelineFilePath?: string;
    pipelinePreferenceLocator?: {
      type: 'stored';
      source: 'bundled' | 'user' | 'curated';
      value: string;
      contentHash?: string;
    };
    sharedPipeline?: NonNullable<
      Extract<AutomationAction, { type: 'worktree_pipeline' }>['sharedPipeline']
    >;
  }> {
    if (action.pipelineSource === 'curated') {
      const { getManagedCuratedPipeline } =
        await import('../pipelines/curated-pipeline-catalog');
      const data = await getManagedCuratedPipeline(action.pipelineId);
      return this.requireStoredPipelineResult(
        { success: true, data },
        action.pipelineId,
      );
    }

    if (action.pipelineSource === 'shared') {
      if (!action.sharedPipeline) {
        throw new Error('Shared workflow source is missing.');
      }
      return {
        pipeline: {
          name: action.pipelineName ?? action.pipelineId,
          version: '3.0',
          on: 'dispatch',
          jobs: {},
        },
        sharedPipeline: action.sharedPipeline,
      };
    }

    if (
      action.pipelineSource === 'bundled' ||
      action.pipelineSource === 'user'
    ) {
      const result = pipelineStore.getStoredPipelineBySource(
        action.pipelineSource,
        action.pipelineId,
      );
      return this.requireStoredPipelineResult(result, action.pipelineId);
    }

    if (action.pipelineSource === 'project' || !action.pipelineSource) {
      const project = cwd
        ? await this.resolveProjectPipeline(action, cwd)
        : null;
      if (project) return project;
      if (action.pipelineSource === 'project') {
        throw new Error('Workflow not found.');
      }
    }

    const stored = pipelineStore.getPipeline(action.pipelineId);
    return this.requireStoredPipelineResult(stored, action.pipelineId);
  }

  private async authorizePromptPlugins(
    activity: ScheduledActivity,
    args: { projectId: string; worktreeId?: string },
    pluginSelections: ChatTabPluginSelections | undefined,
    model?: ChatModel,
  ): Promise<void> {
    if (
      backgroundExecutionContextEnabled() &&
      ((pluginSelections && hasAnySelections(pluginSelections)) ||
        model?.startsWith('agent_model_'))
    ) {
      // Dispatch selections can change after preflight while the if-command runs.
      // Resolve the final selections again against the bound background context.
      const decision = await authorizeBackgroundExecution(
        activity.executionContext,
        [
          {
            owner: undefined,
            requiresHostAuthorization: true,
            capabilities: {
              ...(pluginSelections ? { selections: pluginSelections } : {}),
              ...(model ? { model } : {}),
            },
          },
        ],
        { projectId: args.projectId, worktreeId: args.worktreeId },
      );
      if (!decision.allow)
        await this.rejectBackgroundRun(
          activity.id,
          decision,
          activity.executionContext,
        );
    }
  }

  private async authorizeResolvedPipeline(
    activityId: string | undefined,
    executionContext: string | undefined,
    selection: ResolvedPipelineSelection,
    cwd: string,
    projectId: string,
    preferences: ReturnType<typeof pipelineExecutionPreferences> = {},
  ): Promise<ChildPipelineAuthorization[] | undefined> {
    if (!backgroundExecutionContextEnabled()) return;
    // Shared selections are stubs; the main dispatch gate authorizes the fetched
    // definition and its children with the final execution location.
    if (selection.sharedPipeline) return;
    const authorizations: ChildPipelineAuthorization[] = [];
    const decision = await authorizeBackgroundExecution(
      executionContext,
      resolvedPipelineContextResources(selection, cwd, preferences),
      { projectId },
      authorizations,
    );
    if (decision.allow) return authorizations;
    return this.rejectBackgroundRun(activityId, decision, executionContext);
  }

  /**
   * Fail the run. A definite denial disables the activity until the user
   * re-enables it in a context that can run it; a verification that could
   * not complete leaves it enabled so the next run tries again.
   */
  private async rejectSharedPipelineDispatchFailure(
    activityId: string | undefined,
    executionContext: string | undefined,
    error: string,
  ): Promise<void> {
    if (error === backgroundExecutionRetryMessage('run'))
      await this.rejectBackgroundRun(
        activityId,
        { allow: false, reason: 'unknown-provenance', transient: true },
        executionContext,
      );
    if (error === backgroundExecutionDeniedMessage('access-removed'))
      await this.rejectBackgroundRun(
        activityId,
        { allow: false, reason: 'access-removed' },
        executionContext,
      );
  }

  private async rejectBackgroundRun(
    activityId: string | undefined,
    decision: Extract<ResourceContextDecision, { allow: false }>,
    executionContext?: string,
  ): Promise<never> {
    if (decision.transient)
      throw new Error(backgroundExecutionUnavailableMessage());
    let action: AutomationAction | undefined;
    let turnedOff = false;
    await this.enqueueMutation(async () => {
      const file = await this.ensureFile();
      const activity = file.activities.find((entry) => entry.id === activityId);
      if (activity) {
        action = activity.action;
        turnedOff = activity.enabled;
        activity.enabled = false;
        delete activity.nextRunAt;
      }
      await this.persistAndNotify(file);
    });
    const mismatch =
      decision.reason === 'context-mismatch' && action
        ? await describeAutomationContextMismatch(
            action,
            executionContext,
          ).catch(() => null)
        : null;
    throw new Error(
      backgroundExecutionDeniedMessage(decision.reason, {
        ...(turnedOff ? { turnedOff } : {}),
        ...(mismatch ? { mismatch } : {}),
        ...(decision.subject ? { subject: decision.subject } : {}),
      }),
    );
  }

  private async resolveProjectPipeline(
    action: Extract<AutomationAction, { type: 'worktree_pipeline' }>,
    cwd: string,
  ): Promise<{ pipeline: Pipeline; pipelineFilePath: string } | null> {
    const pipelines = await discoverProjectPipelines(cwd);
    const pipelineInfo = pipelines.find(
      (pipeline) =>
        pipeline.id === action.pipelineId ||
        (action.projectPipelineFilename !== undefined &&
          pipeline.filename === action.projectPipelineFilename),
    );
    if (!pipelineInfo?.filePath) {
      return null;
    }
    if (!(pipelineInfo.triggerTypes ?? []).includes('dispatch')) {
      throw new Error('Workflow does not support dispatch triggers.');
    }
    return {
      pipeline: await loadProjectPipelineFromDisk(pipelineInfo.filePath),
      pipelineFilePath: pipelineInfo.filePath,
    };
  }

  private requireStoredPipelineResult(
    result: ReturnType<typeof pipelineStore.getPipeline>,
    pipelineId: string,
  ): {
    pipeline: Pipeline;
    owner?: unknown;
    storedPipelineRemoteId: string;
    pipelinePreferenceLocator: {
      type: 'stored';
      source: 'bundled' | 'user' | 'curated';
      value: string;
      contentHash?: string;
    };
  } {
    if (!result.success || !result.data) {
      throw new Error(result.error ?? `Workflow not found: ${pipelineId}`);
    }
    const data: PipelineData = result.data;
    if (
      data.info.source !== 'bundled' &&
      data.info.source !== 'user' &&
      data.info.source !== 'curated'
    ) {
      throw new Error('Workflow is not a stored workflow.');
    }
    if (!getTriggerTypes(data.content.on).includes('dispatch')) {
      throw new Error('Workflow does not support dispatch triggers.');
    }
    return {
      pipeline: data.content,
      storedPipelineRemoteId: data.info.remoteId ?? data.info.id,
      owner:
        data.info.owner ??
        (data.info.source === 'bundled' || data.info.source === 'curated'
          ? { type: 'system' }
          : data.info.source === 'user'
            ? { shareScope: 'private' }
            : undefined),
      pipelinePreferenceLocator: {
        type: 'stored',
        source: data.info.source,
        value: data.info.id,
        ...(data.info.source === 'curated' && data.info.curatedContentHash
          ? { contentHash: data.info.curatedContentHash }
          : {}),
      },
    };
  }

  /**
   * Resolve a `worktree_prompt` target carrying `existingWorktreeId`. This
   * path never provisions — the worktree must already exist in the target
   * workspace, and cowork workspaces are rejected just as the
   * fresh-worktree path rejects them.
   */
  private async resolveExistingWorktreeTarget(
    workspaceId: string,
    existingWorktreeId: string,
  ): Promise<string> {
    const { items } = await readAllSidebarItems();
    const workspace = items.find((item) => item.id === workspaceId);
    if (!workspace) throw new Error('Project not found.');
    if (workspace.type === 'cowork') {
      throw new Error('Cannot target a worktree in a cowork project.');
    }
    const worktree = workspace.worktrees.find(
      (entry) => entry.id === existingWorktreeId,
    );
    if (!worktree) {
      throw new Error(
        `Worktree "${existingWorktreeId}" was not found in project "${workspaceId}".`,
      );
    }
    return worktree.id;
  }

  private async createReadyWorktree(
    action: Extract<
      AutomationAction,
      { type: 'worktree_prompt' | 'worktree_pipeline' }
    >,
  ): Promise<ReadyWorktree> {
    if (!this.surfaces) {
      throw new Error('Automations service is not configured.');
    }
    const workspaceId =
      action.type === 'worktree_pipeline'
        ? pipelineAutomationWorkspaceId(action)
        : action.workspaceId;
    const { items } = await readAllSidebarItems();
    const workspace = items.find((item) => item.id === workspaceId);
    if (!workspace || !workspaceId) throw new Error('Project not found.');
    if (workspace.type === 'cowork') {
      throw new Error('Cannot create a worktree for a cowork project.');
    }
    const existingWorktreeIds = workspace.worktrees.map(
      (worktree) => worktree.id,
    );
    let lastSetupPhase = 'reserving';
    let setupFailureReason: WorktreeGitFailedEvent['failureReason'];
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const readyPromise = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
      timeout = setTimeout(() => {
        reject(
          new Error(
            `Timed out waiting for worktree setup (last observed phase: ${lastSetupPhase}).`,
          ),
        );
      }, WORKTREE_GIT_READY_TIMEOUT_MS);
      timeout.unref?.();
    });
    // Phase B can settle before the reservation response reaches this waiter.
    void readyPromise.catch(() => undefined);
    const onGitSetupSettled: NonNullable<
      Parameters<typeof createSingleRepoWorktree>[0]['onGitSetupSettled']
    > = ({ outcome }): void => {
      lastSetupPhase = outcome;
      if (outcome === 'ready') {
        resolveReady();
      } else {
        rejectReady(new Error(`Worktree setup ${outcome}.`));
      }
    };
    const onGitReady = (payload: Parameters<typeof sendToWindow>[2]): void => {
      lastSetupPhase = 'git-ready';
      sendToWindow(
        this.surfaces?.getMainWindow() ?? null,
        IPC_CHANNELS.worktreeGitReady,
        payload,
      );
    };
    const onGitFailed = (payload: WorktreeGitFailedEvent): void => {
      lastSetupPhase = 'failed';
      setupFailureReason = payload.failureReason;
      sendToWindow(
        this.surfaces?.getMainWindow() ?? null,
        IPC_CHANNELS.worktreeGitFailed,
        payload,
      );
      rejectReady(new Error(payload.error));
    };
    let created: { id: string; createdAt: string } | null = null;
    try {
      const existingBranch =
        action.type === 'worktree_prompt' ? action.existingBranch : undefined;
      const baseBranch =
        action.type === 'worktree_prompt' ? action.baseBranch : undefined;
      const result =
        workspace.type === 'single-repo'
          ? await createSingleRepoWorktree({
              workspaceId: workspaceId,
              existingWorktreeIds,
              baseWorktreeId: action.baseWorktreeId,
              baseBranch,
              existingBranch,
              getWindow: this.surfaces.getMainWindow,
              deferGitSetup: true,
              onGitReady,
              onGitFailed,
              onGitSetupSettled,
            })
          : await createMultiRepoWorktree({
              workspaceId: workspaceId,
              existingWorktreeIds,
              baseWorktreeId: action.baseWorktreeId,
              baseBranch,
              existingBranch,
              getWindow: this.surfaces.getMainWindow,
              deferGitSetup: true,
              onGitReady,
              onGitFailed,
              onGitSetupSettled,
            });
      if ('needsRepair' in result && result.needsRepair === true) {
        throw new Error('Created worktree requires repair.');
      }
      created = result;
      if (lastSetupPhase === 'reserving') {
        lastSetupPhase = result.setupPhase ?? 'reserved';
      }
      await readyPromise;
      return {
        id: created.id,
        createdAt: created.createdAt,
        workspaceType: workspace.type,
      };
    } catch (error) {
      if (created) {
        await this.disposeFailedReadyWorktree(
          workspace.type,
          workspaceId,
          created.id,
          created.createdAt,
          setupFailureReason,
        ).catch((cleanupError) => {
          // eslint-disable-next-line no-console
          console.error(
            'Failed to clean up automation worktree after setup failure:',
            cleanupError,
          );
        });
      }
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private async disposeFailedReadyWorktree(
    workspaceType: 'single-repo' | 'multi-repo',
    workspaceId: string,
    worktreeId: string,
    expectedCreatedAt: string,
    setupFailureReason?: WorktreeGitFailedEvent['failureReason'],
  ): Promise<void> {
    // Later W5 recovery cannot authorize rollback of an unknown-authority failure.
    if (setupFailureReason === 'storage-unavailable') return;

    const list = await readWorkspaceWorktreesDetailed(workspaceId, {
      persistRemovalCleanup: false,
    });
    // Unknown storage is not permission to roll back a checkout.
    if (list.authority !== 'ok') return;

    // Rolls back a worktree whose setup failed before any chat activity —
    // never retain these as archived containers (they would be junk rows).
    if (workspaceType === 'single-repo') {
      await archiveSingleRepoWorktree({
        archiveTrigger: 'internal-rollback',
        sourceAdmission: 'required',
        workspaceId,
        worktreeId,
        expectedCreatedAt,
        retainAsArchivedContainer: false,
      });
      return;
    }
    await archiveMultiRepoWorktree({
      archiveTrigger: 'internal-rollback',
      sourceAdmission: 'required',
      workspaceId,
      worktreeId,
      expectedCreatedAt,
      retainAsArchivedContainer: false,
    });
  }

  private resolveWorktreeCwd(
    workspaceId: string,
    worktreeId: string,
    repoId?: string,
  ): string {
    if (!repoId || repoId === WORKSPACE_ROOT_REPO_ID) {
      return getWorkspaceWorktreeRootRepoDir(workspaceId, worktreeId);
    }
    return getWorkspaceWorktreeRepoDir(workspaceId, worktreeId, repoId);
  }

  private normalizeFile(file: AutomationsFile): AutomationsFile {
    const now = new Date();
    const normalized: AutomationsFile = {
      version: 1,
      updatedAt: file.updatedAt,
      activities: file.activities.map(cloneActivity),
      recentRuns: trimRecentRuns(file.recentRuns.map(cloneRun)),
    };
    const restartedAt = now.toISOString();
    const recovered: ScheduledActivityRun[] = [];
    for (const run of normalized.recentRuns) {
      if (run.status !== 'running') continue;
      run.status = 'failure';
      run.recovered = true;
      run.cancellable = false;
      run.completedAt = restartedAt;
      run.error = `Run was interrupted when ${BRAND.displayName} restarted.`;
      recovered.push(run);
    }
    for (const run of recovered) {
      const activity = normalized.activities.find(
        (entry) => entry.id === run.activityId,
      );
      if (activity) {
        this.applyRunResult(activity, run);
      }
      // Never strand an automation_run watcher on an interrupted run: fire the
      // failure event now. Double delivery is harmless — a fired watcher is
      // consumed, so a second event finds no active match.
      this.notifyRunWatchers(run);
      this.pendingArchiveWrites.push(
        this.archive
          .appendRun(run)
          .catch((error) =>
            logMainProcessError(
              'Failed to archive recovered automation run',
              error,
            ),
          ),
      );
    }
    for (const activity of normalized.activities) {
      activity.action = normalizeAutomationAction(activity.action);
      if (activity.sharedPipelineReview) {
        activity.sharedPipelineReview = normalizeAutomationSharedPipelineReview(
          activity.sharedPipelineReview,
        );
      }
      activity.nextRunAt = nextRunForEnabledActivity(activity, normalized, now);
      if (
        !activity.nextRunAt &&
        activity.schedule.kind === 'one_time' &&
        !activity.sharedPipelineReview
      ) {
        activity.enabled = false;
      }
    }
    return normalized;
  }

  /**
   * Record the last chat a pipeline an automation started sent to on the run
   * that started it, so run history opens that chat (CAN-5381). It runs as
   * soon as a send is recorded, while the execution may still wait for the
   * reply (CAN-4551), and again when it ends. The run keeps its
   * `pipelineExecutionId`. The hot window is checked first, then the archive,
   * which folds a later record of the same run over the earlier one. A run
   * that already names the send, whose pipeline sent nothing, or whose
   * automation was deleted, is left alone.
   */
  async recordPipelineRunChatSend(event: ExecutionEvent): Promise<void> {
    const { state, executionId } = event;
    if (state.initiator?.kind !== 'automation') return;
    const sent = lastChatSendRunResult(state);
    if (!sent) return;
    const activityId = state.initiator.automationId;
    await this.enqueueMutation(async (): Promise<void> => {
      const file = await this.ensureFile();
      const activity = file.activities.find((entry) => entry.id === activityId);
      if (!activity) return;
      const hotIndex = file.recentRuns.findIndex(
        (entry) =>
          entry.activityId === activityId &&
          entry.result?.pipelineExecutionId === executionId,
      );
      const source =
        file.recentRuns[hotIndex] ??
        (await this.archive.findRunByPipelineExecution(
          activityId,
          executionId,
        ));
      if (!source) return;
      const result = { ...sent, pipelineExecutionId: executionId };
      if (sameRunResult(source.result, result)) return;
      const patched = { ...cloneRun(source), result };
      // The archive is written first, as for a terminal run.
      await this.archive.appendRun(patched);
      const lastResult = activity.lastResult;
      const latest = lastResult?.result?.pipelineExecutionId === executionId;
      if (lastResult && latest) activity.lastResult = { ...lastResult, result };
      if (hotIndex !== -1) file.recentRuns[hotIndex] = patched;
      if (hotIndex !== -1 || latest) await this.persistAndNotify(file);
    });
  }

  /**
   * The terminal archive append intentionally precedes the hot-window write.
   * After a crash in that gap, the archive is authoritative and the stale hot
   * `running` row must not be recovered as a later failure.
   */
  private async reconcileArchivedTerminalRuns(
    file: AutomationsFile,
  ): Promise<AutomationsFile> {
    const reconciled: AutomationsFile = {
      version: 1,
      updatedAt: file.updatedAt,
      activities: file.activities.map(cloneActivity),
      recentRuns: file.recentRuns.map(cloneRun),
    };
    for (let index = 0; index < reconciled.recentRuns.length; index += 1) {
      const hotRun = reconciled.recentRuns[index];
      if (!hotRun || hotRun.status !== 'running') continue;
      const archived = await this.archive.findRun(hotRun.activityId, hotRun.id);
      if (!archived || archived.status === 'running') continue;
      const terminalRun = cloneRun(archived);
      reconciled.recentRuns[index] = terminalRun;
      const activity = reconciled.activities.find(
        (entry) => entry.id === terminalRun.activityId,
      );
      if (activity) this.applyRunResult(activity, terminalRun);
      // The crash happened before the normal post-persist notification.
      this.notifyRunWatchers(terminalRun);
    }
    return reconciled;
  }

  private ensureFile(): Promise<AutomationsFile> {
    if (this.file) return Promise.resolve(this.file);
    if (this.loadingFile) return this.loadingFile;
    const loading = (async (): Promise<AutomationsFile> => {
      const file = await this.readFile();
      if (this.persistedScheduledMessageContributors === null) {
        this.persistedScheduledMessageContributors =
          scheduledMessageContributors(file.activities);
      }
      const normalized = this.normalizeFile(
        await this.reconcileArchivedTerminalRuns(file),
      );
      this.file = normalized;
      await this.flushPendingArchiveWrites();
      return normalized;
    })();
    this.loadingFile = loading;
    void loading.then(
      () => {
        if (this.loadingFile === loading) this.loadingFile = null;
      },
      () => {
        if (this.loadingFile === loading) this.loadingFile = null;
      },
    );
    return loading;
  }

  private async flushPendingArchiveWrites(): Promise<void> {
    const pending = this.pendingArchiveWrites.splice(0);
    if (pending.length > 0) await Promise.all(pending);
  }

  private async readFile(): Promise<AutomationsFile> {
    try {
      const raw = await readFile(getAutomationsFilePath(), 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (!isRecord(parsed) || parsed.version !== 1) {
        return emptyAutomationsFile();
      }
      return {
        version: 1,
        updatedAt:
          typeof parsed.updatedAt === 'string'
            ? parsed.updatedAt
            : new Date().toISOString(),
        activities: Array.isArray(parsed.activities)
          ? parsed.activities.filter(isPersistedActivity).map(cloneActivity)
          : [],
        recentRuns: Array.isArray(parsed.recentRuns)
          ? trimRecentRuns(
              parsed.recentRuns.filter(isPersistedRun).map(cloneRun),
            )
          : [],
      };
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return emptyAutomationsFile();
      }
      if (error instanceof SyntaxError) {
        return emptyAutomationsFile();
      }
      throw error;
    }
  }

  private async writeFile(file: AutomationsFile): Promise<void> {
    const filePath = getAutomationsFilePath();
    const dir = dirname(filePath);
    await mkdir(dir, { recursive: true });
    const payload: AutomationsFile = {
      version: 1,
      updatedAt: new Date().toISOString(),
      activities: file.activities,
      recentRuns: trimRecentRuns(file.recentRuns),
    };
    const previousContributors =
      this.persistedScheduledMessageContributors ?? new Map();
    const nextContributors = scheduledMessageContributors(payload.activities);
    const tempPath = join(
      dir,
      `.automations-${process.pid}-${randomUUID()}.tmp`,
    );
    let renamed = false;
    try {
      await writeFile(
        tempPath,
        `${JSON.stringify(payload, null, 2)}\n`,
        'utf8',
      );
      await rename(tempPath, filePath);
      renamed = true;
      file.updatedAt = payload.updatedAt;
      file.recentRuns = payload.recentRuns;
      this.persistedScheduledMessageContributors = nextContributors;
      notifyScheduledMessageChanges(
        changedScheduledMessageTargets(previousContributors, nextContributors),
      );
    } finally {
      if (!renamed) await unlink(tempPath).catch(() => undefined);
    }
  }

  /**
   * Sends the current snapshot again without writing (CAN-4551): windows
   * recompute what a converted automation's owned workflow now stands for
   * after that workflow changed outside the automation.
   */
  async republish(): Promise<void> {
    const file = await this.ensureFile();
    this.surfaces?.onChange?.(await contextSnapshot(file));
  }

  private async persistAndNotify(file: AutomationsFile): Promise<void> {
    await this.writeFile(file);
    try {
      this.surfaces?.onChange?.(await contextSnapshot(file));
    } catch (error) {
      // Surface refresh failures must not interrupt an already-persisted run.
      logMainProcessError('Failed to notify automation surfaces', error);
    }
  }

  // -------------------------------------------------------------------------
  // Cloud workflow schedules (CAN-6183). The Run in control (CP-47) calls
  // these; nothing else moves a schedule.
  // -------------------------------------------------------------------------

  /** Main's web core client for cloud schedules. */
  setCloudScheduleRemote(remote: CloudScheduleRemote): void {
    this.cloudRemote = remote;
    this.cloudRecords.clear();
    this.cloudRecordsReadAt = 0;
  }

  /** The server record of a cloud stub, as main last read it. */
  cloudRecordFor(activity: ScheduledActivity): PipelineSchedule | undefined {
    return cachedCloudRecord(activity);
  }

  /**
   * Reads the server records of this desktop's cloud stubs again when the
   * last read is a minute old, and republishes the list when one changed.
   * Never rejects: a stub whose record is unread shows as stored.
   */
  refreshCloudRecords(): Promise<void> {
    if (
      this.cloudRecordsRead !== null ||
      Date.now() - this.cloudRecordsReadAt < CLOUD_RECORDS_MAX_AGE_MS
    )
      return this.cloudRecordsRead ?? Promise.resolve();
    const read = (async (): Promise<void> => {
      const file = await this.ensureFile();
      if (!file.activities.some((activity) => isCloudScheduleStub(activity)))
        return;
      const records = await this.cloudRemote.list();
      const next = new Map(
        records.map((record) => [record.scheduleId, record] as const),
      );
      const changed = !isDeepStrictEqual(next, this.cloudRecords);
      this.cloudRecords.clear();
      for (const [scheduleId, record] of next)
        this.cloudRecords.set(scheduleId, record);
      this.cloudRecordsReadAt = Date.now();
      if (changed) await this.republish();
    })()
      .catch(() => {
        // Offline or signed out: the stubs keep showing as stored.
        this.cloudRecordsReadAt = Date.now();
      })
      .finally(() => {
        this.cloudRecordsRead = null;
      });
    this.cloudRecordsRead = read;
    return read;
  }

  /**
   * Moves a local workflow schedule to the cloud: the record stops firing
   * here (a pending stub) before the server holds it, then names the server
   * record. A refusal puts the local record back; an answer that never came
   * leaves the pending stub, which a second move or a move back resolves.
   */
  async moveScheduleToCloud(
    id: string,
    callerContext?: WorkspaceContext,
  ): Promise<AutomationMutationResponse> {
    return this.enqueueMutation(async () => {
      const file = await this.ensureFile();
      const index = file.activities.findIndex((entry) => entry.id === id);
      const activity = file.activities[index];
      if (!activity) return { ok: false, error: 'Activity not found.' };
      await assertAutomationContext(activity, callerContext);
      const pending = isCloudScheduleStub(activity)
        ? activity.cloudSchedule
        : undefined;
      if (pending?.scheduleId !== undefined)
        return { ok: false, error: CLOUD_SCHEDULE_MESSAGES.alreadyCloud };
      if (pending === undefined && !firesLocally(activity))
        return locationRefusal(activity);
      const refusal = this.cloudMoveRefusal(file, activity);
      if (refusal !== null) return { ok: false, error: refusal };
      const { action } = activity;
      if (action.type !== 'worktree_pipeline')
        return { ok: false, error: CLOUD_SCHEDULE_MESSAGES.notPipeline };
      const destination = cloudScheduleDestination(action);
      if (destination === null)
        return { ok: false, error: CLOUD_SCHEDULE_MESSAGES.noDestination };
      const workflow = cloudScheduleWorkflow(action, (pipelineId) => {
        const stored = pipelineStore.getStoredPipelineBySource(
          'user',
          pipelineId,
        );
        return (stored.success ? stored.data?.rawContent : undefined) ?? null;
      });
      if ('refusal' in workflow) return { ok: false, error: workflow.refusal };
      const accountId = await this.cloudRemote.accountId();
      if (accountId === null)
        return { ok: false, error: CLOUD_SCHEDULE_MESSAGES.signedOut };
      if (pending !== undefined && pending.accountId !== accountId)
        return { ok: false, error: CLOUD_SCHEDULE_MESSAGES.otherAccount };
      const localEnabled = pending?.localEnabled ?? activity.enabled;
      const original = cloneActivity(activity);
      const values = {
        owner: activity.executionContext ?? 'personal',
        name: activity.name,
        workflow,
        trigger: cloudScheduleTrigger(activity.schedule, hostTimeZone()),
        runCondition: activity.ifCommand ?? null,
        enabled: localEnabled,
        inputs: { ...(action.inputs ?? {}) },
        destination,
      };

      // The record stops firing here before the server can fire it.
      activity.executionLocation = 'cloud';
      activity.cloudSchedule = {
        accountId,
        movedAt: new Date().toISOString(),
        localEnabled,
      };
      activity.enabled = false;
      delete activity.nextRunAt;
      await this.persistAndNotify(file);

      let record: PipelineSchedule;
      try {
        record = await this.createOrAdoptCloudRecord(
          activity.id,
          action.pipelineId,
          values,
        );
      } catch (error) {
        if (error instanceof CloudScheduleRemoteError && error.definite) {
          file.activities[index] = original;
          await this.persistAndNotify(file);
          return {
            ok: false,
            error:
              error.payload?.message ?? CLOUD_SCHEDULE_MESSAGES.unreachable,
          };
        }
        return { ok: false, error: CLOUD_SCHEDULE_MESSAGES.pending };
      }
      activity.cloudSchedule = {
        ...activity.cloudSchedule,
        scheduleId: record.scheduleId,
      };
      activity.updatedAt = new Date().toISOString();
      this.cloudRecords.set(record.scheduleId, record);
      await this.persistAndNotify(file);
      return { ok: true, activity: cloneActivity(activity) };
    });
  }

  /**
   * Moves a cloud schedule back to this desktop: the server record is
   * deleted first, and the stub turns into a local record from the values
   * the delete answered, in this one mutation. Until the server confirms,
   * nothing here changes, so the slot never fires in both places.
   */
  async moveScheduleToLocal(
    id: string,
    callerContext?: WorkspaceContext,
  ): Promise<AutomationMutationResponse> {
    return this.enqueueMutation(async () => {
      const file = await this.ensureFile();
      const index = file.activities.findIndex((entry) => entry.id === id);
      const activity = file.activities[index];
      if (!activity) return { ok: false, error: 'Activity not found.' };
      await assertAutomationContext(activity, callerContext);
      if (!isCloudScheduleStub(activity))
        return {
          ok: false,
          error: firesLocally(activity)
            ? CLOUD_SCHEDULE_MESSAGES.notStub
            : CLOUD_SCHEDULE_MESSAGES.unknownLocation,
        };
      const stub = activity.cloudSchedule;
      const accountId = await this.cloudRemote.accountId();
      if (accountId === null)
        return { ok: false, error: CLOUD_SCHEDULE_MESSAGES.signedOut };
      if (accountId !== stub.accountId)
        return { ok: false, error: CLOUD_SCHEDULE_MESSAGES.otherAccount };
      // The key outlives this attempt, so a retry after a lost answer
      // replays the deleted record instead of finding it gone.
      let moveBackKey = stub.moveBackKey;
      if (moveBackKey === undefined) {
        moveBackKey = randomUUID();
        activity.cloudSchedule = { ...stub, moveBackKey };
        await this.persistAndNotify(file);
      }
      let record: PipelineSchedule | null;
      try {
        record = await this.deleteCloudRecordOf(activity, moveBackKey);
      } catch (error) {
        return {
          ok: false,
          error:
            error instanceof CloudScheduleRemoteError && error.definite
              ? (error.payload?.message ?? CLOUD_SCHEDULE_MESSAGES.unreachable)
              : CLOUD_SCHEDULE_MESSAGES.unreachable,
        };
      }
      // A record deleted elsewhere comes back off; one that never reached
      // the server comes back as it was.
      const local = localRecordFromCloud(
        activity,
        record,
        stub.scheduleId === undefined ? stub.localEnabled : false,
      );
      local.updatedAt = new Date().toISOString();
      local.nextRunAt = nextRunForEnabledActivity(local, file, new Date(), {
        preserveExistingCronNextRun: false,
      });
      file.activities[index] = local;
      if (stub.scheduleId !== undefined)
        this.cloudRecords.delete(stub.scheduleId);
      await this.persistAndNotify(file);
      return { ok: true, activity: cloneActivity(local) };
    });
  }

  /**
   * Changes a cloud schedule where it is stored, at the revision the server
   * holds now. The stub keeps the name for lists that show it unread.
   */
  async updateCloudSchedule(
    id: string,
    change: {
      readonly name?: string;
      readonly enabled?: boolean;
      readonly schedule?: AutomationTrigger;
      readonly ifCommand?: string | null;
      readonly inputs?: Readonly<Record<string, string>>;
    },
    callerContext?: WorkspaceContext,
  ): Promise<AutomationMutationResponse> {
    if (change.schedule !== undefined) {
      const scheduleError = validateAutomationTrigger(change.schedule);
      if (scheduleError) return { ok: false, error: scheduleError };
    }
    return this.enqueueMutation(async () => {
      const file = await this.ensureFile();
      const activity = file.activities.find((entry) => entry.id === id);
      if (!activity) return { ok: false, error: 'Activity not found.' };
      await assertAutomationContext(activity, callerContext);
      const scheduleId = activity.cloudSchedule?.scheduleId;
      if (!isCloudScheduleStub(activity) || scheduleId === undefined)
        return { ok: false, error: CLOUD_SCHEDULE_MESSAGES.notStub };
      if (
        (await this.cloudRemote.accountId()) !==
        activity.cloudSchedule.accountId
      )
        return { ok: false, error: CLOUD_SCHEDULE_MESSAGES.otherAccount };
      let record: PipelineSchedule;
      try {
        const current = await this.cloudRemote.get(scheduleId);
        if (current === null)
          return { ok: false, error: 'Activity not found.' };
        const params: Omit<PipelineScheduleUpdateParams, '_meta'> = {
          scheduleId,
          expectedRevision: current.revision,
          ...(change.name === undefined ? {} : { name: change.name.trim() }),
          ...(change.enabled === undefined ? {} : { enabled: change.enabled }),
          ...(change.schedule === undefined
            ? {}
            : {
                trigger: cloudScheduleTrigger(
                  change.schedule,
                  current.trigger.timeZone,
                ),
              }),
          ...(change.ifCommand === undefined
            ? {}
            : { runCondition: change.ifCommand?.trim() || null }),
          ...(change.inputs === undefined
            ? {}
            : { inputs: { ...change.inputs } }),
        };
        record = await this.cloudRemote.update(params);
      } catch (error) {
        return {
          ok: false,
          error:
            error instanceof CloudScheduleRemoteError && error.payload !== null
              ? error.payload.message
              : CLOUD_SCHEDULE_MESSAGES.unreachable,
        };
      }
      this.cloudRecords.set(record.scheduleId, record);
      if (activity.name !== record.name) {
        activity.name = record.name;
        activity.updatedAt = new Date().toISOString();
      }
      await this.persistAndNotify(file);
      return { ok: true, activity: cloneActivity(activity) };
    });
  }

  /**
   * After a user pipeline is saved (P7): its cloud schedules take the new
   * name and the saved workflow, uploaded again as their snapshot. Best
   * effort: the save already happened, so a failure is only logged.
   */
  async syncCloudSchedulesAfterPipelineSave(
    pipelineId: string,
    name: string,
  ): Promise<void> {
    const file = await this.ensureFile();
    const stubs = file.activities.filter(
      (activity) =>
        isCloudScheduleStub(activity) &&
        activity.cloudSchedule.scheduleId !== undefined &&
        activity.action.type === 'worktree_pipeline' &&
        (activity.action.pipelineSource === 'user' ||
          activity.action.pipelineSource === undefined) &&
        activity.action.pipelineId === pipelineId,
    );
    if (stubs.length === 0) return;
    const stored = pipelineStore.getStoredPipelineBySource('user', pipelineId);
    if (!stored.success || !stored.data) return;
    const document = stored.data.rawContent;
    if (document === undefined) return;
    for (const stub of stubs) {
      const scheduleId = stub.cloudSchedule?.scheduleId;
      if (scheduleId === undefined || stub.action.type !== 'worktree_pipeline')
        continue;
      try {
        const current = await this.cloudRemote.get(scheduleId);
        if (current === null || current.workflow.kind !== 'snapshot') continue;
        const workflow = cloudScheduleWorkflow(stub.action, () => document);
        if ('refusal' in workflow) continue;
        const record = await this.cloudRemote.update({
          scheduleId,
          expectedRevision: current.revision,
          ...(name.trim() === '' ? {} : { name: name.trim() }),
          ...(workflow.kind === 'snapshot' &&
          workflow.contentHash !== current.workflow.contentHash
            ? { workflow }
            : {}),
        });
        this.cloudRecords.set(record.scheduleId, record);
      } catch (error) {
        logMainProcessError('Failed to update a cloud schedule after a save', {
          operation: 'sync-cloud-schedule',
          kind:
            error instanceof CloudScheduleRemoteError
              ? (error.payload?.kind ?? 'unreachable')
              : 'internal',
        });
      }
    }
    await this.republish();
  }

  /** Why `activity` can't move to the cloud, or null. */
  private cloudMoveRefusal(
    file: AutomationsFile,
    activity: ScheduledActivity,
  ): string | null {
    if (activity.action.type !== 'worktree_pipeline')
      return CLOUD_SCHEDULE_MESSAGES.notPipeline;
    if (activity.sharedPipelineReview) return CLOUD_SCHEDULE_MESSAGES.review;
    if (isActivityRunning(file, activity.id))
      return CLOUD_SCHEDULE_MESSAGES.running;
    if (activity.installedFrom?.capabilityPackage)
      return CLOUD_SCHEDULE_MESSAGES.installed;
    if (
      ownsOrchestratorPromptPipeline(activity) ||
      targetsAgentHiddenPipeline(activity)
    )
      return CLOUD_SCHEDULE_MESSAGES.orchestrator;
    const pipelineId = scheduledUserPipelineId(activity);
    if (
      activity.agentAuthor !== undefined ||
      activity.agentScheduledSend !== undefined ||
      (pipelineId !== undefined &&
        userPipelineMetadata(pipelineId).agentAuthor !== undefined)
    )
      return CLOUD_SCHEDULE_MESSAGES.agent;
    return null;
  }

  /**
   * Creates the server record of a move, or takes over the one an earlier
   * move of the same record left (its answer was lost), with these values.
   */
  private async createOrAdoptCloudRecord(
    sourceRecordId: string,
    sourcePipelineId: string,
    values: Omit<
      Parameters<CloudScheduleRemote['create']>[0],
      'sourceRecordId' | 'sourcePipelineId' | 'runCondition'
    > & { readonly runCondition: string | null },
  ): Promise<PipelineSchedule> {
    const { runCondition, ...rest } = values;
    try {
      return await this.cloudRemote.create({
        ...rest,
        ...(runCondition === null ? {} : { runCondition }),
        sourceRecordId,
        sourcePipelineId,
      });
    } catch (error) {
      const taken =
        error instanceof CloudScheduleRemoteError &&
        error.payload?.code === 'core.pipeline.schedule.sourceRecordTaken' &&
        isRecord(error.payload.details) &&
        typeof error.payload.details.scheduleId === 'string'
          ? error.payload.details.scheduleId
          : undefined;
      if (taken === undefined) throw error;
      const current = await this.cloudRemote.get(taken);
      if (current === null) throw error;
      return this.cloudRemote.update({
        scheduleId: taken,
        expectedRevision: current.revision,
        ...rest,
        runCondition,
      });
    }
  }

  /**
   * Deletes the server record a stub stands for, finding a pending stub's
   * by its record id; answers it as it was, or null when there is none.
   */
  private async deleteCloudRecordOf(
    activity: ScheduledActivity,
    idempotencyKey: string,
  ): Promise<PipelineSchedule | null> {
    const scheduleId =
      activity.cloudSchedule?.scheduleId ??
      (await this.cloudRemote.findBySourceRecord(activity.id))?.scheduleId;
    return scheduleId === undefined
      ? null
      : this.cloudRemote.delete(scheduleId, idempotencyKey);
  }

  /**
   * Before a record that doesn't fire here is deleted: a stub's server
   * record goes first. Answers why the delete can't go ahead, or null.
   */
  private async deleteCloudRecord(
    activity: ScheduledActivity,
  ): Promise<string | null> {
    if (firesLocally(activity)) return null;
    if (!isCloudScheduleStub(activity))
      return CLOUD_SCHEDULE_MESSAGES.unknownLocation;
    const accountId = await this.cloudRemote.accountId();
    if (accountId === null) return CLOUD_SCHEDULE_MESSAGES.signedOut;
    if (accountId !== activity.cloudSchedule.accountId)
      return CLOUD_SCHEDULE_MESSAGES.otherAccount;
    try {
      await this.deleteCloudRecordOf(activity, randomUUID());
    } catch {
      return CLOUD_SCHEDULE_MESSAGES.unreachable;
    }
    const scheduleId = activity.cloudSchedule.scheduleId;
    if (scheduleId !== undefined) this.cloudRecords.delete(scheduleId);
    return null;
  }

  private enqueueMutation<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.then(fn, fn);
    this.writeQueue = next.catch((error) => {
      // eslint-disable-next-line no-console
      console.error('Automations mutation failed:', error);
    });
    return next;
  }
}

let singleton: AutomationsService | null = null;

export function getAutomationsService(): AutomationsService {
  singleton ??= new AutomationsService();
  return singleton;
}
