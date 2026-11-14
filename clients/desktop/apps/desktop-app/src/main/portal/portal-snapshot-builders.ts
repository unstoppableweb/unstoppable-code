import { logMainProcessWarn } from '../lib/main-process-logging';
import { projectAutoDeleteAttention } from '../lib/auto-delete-attention';
import { W5_UNREACHABLE_READ_MESSAGE } from '@canopy/core-runtime/node/w5/file-store';
import { projectRemoteW5Recovery } from '@canopy/protocol/portal';
import { getDesktopW5RecoveryController } from '../canopy-runtime/desktop-w5-recovery';
import { listPortalWatchersForSnapshot } from './adapters/watchers-adapter';
import { ORCHESTRATOR_LABEL } from '@canopy/protocol';
import { validateId } from '../lib/validation';
import { listWorktreeChatSummaryBatch } from '../services/worktree-chat-summary-batch';
import {
  isGuestAllowedModelId,
  type ModelLibraryContext,
} from '@canopy/protocol/models';
import {
  isGatewayRoutableModel,
  isOrgGatewayRoute,
} from '@canopy/execution-engine/lib/gateway-model-availability';
import { isRecord } from '@canopy/desktop-shared/portal/persisted-chat-projection';
import { probeEntitlementsWithModelLibrary } from '../canopy-cloud/model-library-access';
import { peekPortalProviderAvailability } from '../auth/provider-auth-state';
import { projectSidebarItemGroups } from '../services/sidebar-item-groups-service';
import type {
  PortalChatMessage,
  PortalChangedFile,
  PortalChangedFilesPayload,
  PortalEntityEnvelope,
  PortalEventEnvelope,
  PortalHookRun,
  PortalPipelineRun,
  PortalScriptRun,
  PortalStateRequestPayload,
  PortalStateSnapshotPayload,
  PortalSessionShellState,
} from '@canopy/desktop-shared/types';
import { logMainProcessError } from '../lib/main-process-logging';
import { listWorkspacePortalEntities } from '../services/workspace-portal-service';
import { listTerminalPortalEntities } from '../services/terminal-service';
import { listPlans, planToPortalEntity } from '../services/plans-service';
import { listFileRoots } from '../services/files-service';
import { listChangedFileSets } from '../services/diff-service';
import { refreshPullRequestState } from '../services/pr-service';
import { getCachedPortalPrState } from '../services/portal-pr-delta';
import { readWorktreeSummary } from '../lib/worktree-summary-persistence';
import { isWorktreeSummaryGenerating } from '../lib/worktree-summary-scheduler';
import { listPortalProviderUsageEntities } from './provider-usage-projection';
import {
  getWorktreeChatTranscriptSeed,
  getAppAdvisorChatTranscriptSeed,
  listAppAdvisorChatSummaries,
  listWorktreeChatSummaries,
  listWorktreeTodoEntities,
} from '../services/chat-service';
import {
  listWorkEntries,
  resolveWorkEntryForChat,
} from '../lib/cowork-work-entries';
import { APP_ADVISOR_PROJECT_ID } from '@canopy/desktop-shared/types';
import {
  getStandaloneChatTranscriptSeed,
  listStandaloneChats,
  projectStandaloneChatSnapshot,
  withStandalonePendingQuestions,
} from '../services/standalone-chat-service';
import {
  listScripts,
  listScriptRuns,
  scriptToPortalEntity,
} from '../services/scripts-service';
import {
  hookToPortalEntity,
  listHookRuns,
  listHooks,
} from '../services/hooks-service';
import {
  listPipelineRuns,
  listPipelines,
  pipelineToPortalEntity,
} from '../services/pipelines-service';
import { readPortalStateStore } from './portal-state-store';
import {
  PORTAL_EVENT_BATCH_MAX_BYTES,
  worktreeScopedParentLocalId,
} from '@canopy/protocol/portal';
import { performance } from 'node:perf_hooks';
import { portalSnapshotWorkBudget } from './portal-snapshot-work-budget';
import {
  elapsedMilliseconds,
  recordPortalSnapshotTiming,
  type PortalSnapshotSection,
} from './portal-performance-diagnostics';
import { readPortalSidebarItems } from './portal-workspace-reads';
import { mapWithConcurrency } from '../lib/concurrency';
import { listPortalMcpServerEntitiesForWorktree } from './adapters/mcp-adapter';
import { listPortalBackgroundProcessEntitiesForWorktree } from './adapters/bg-processes-adapter';
import { projectNewTaskControls } from './worktree-new-task-controls';
import { getLatestAppAdvisorWindowUiState } from '../ipc/app-advisor';
import { portalSnapshotRoutingKey } from './portal-snapshot-lane';
import { resolveAiCreditsScopeOwner } from '../agents/work-owner';
import { capChangedFilesPayload } from './changed-files-paging';
import { portalEventMaxRoutedByteLength } from './portal-outbox';

export interface BuiltPortalSnapshot {
  snapshot: PortalStateSnapshotPayload;
  followUpEvents: PortalEventEnvelope[];
}

/**
 * Bounded concurrency for the batched `worktree_actions` per-worktree
 * script/pipeline reads. Mirrors the sidebar diff-stat batch bound in
 * `workspace-portal-service.ts` so one snapshot never bursts disk I/O
 * across every worktree at once.
 */
const WORKTREE_ACTIONS_CONCURRENCY = 4;

const SNAPSHOT_MEASUREMENT_EVENT_ID = '00000000-0000-4000-8000-000000000000';
const PORTAL_SNAPSHOT_EVENT_BUDGET = PORTAL_EVENT_BATCH_MAX_BYTES - 4096;

function isChangedFile(value: unknown): value is PortalChangedFile {
  return (
    isRecord(value) &&
    typeof value.filePath === 'string' &&
    typeof value.status === 'string' &&
    (value.repoId === undefined || typeof value.repoId === 'string')
  );
}

function isChangedFilesPayload(
  value: unknown,
): value is PortalChangedFilesPayload {
  return (
    isRecord(value) &&
    typeof value.workspaceLocalId === 'string' &&
    typeof value.worktreeLocalId === 'string' &&
    Array.isArray(value.uncommitted) &&
    value.uncommitted.every(isChangedFile) &&
    Array.isArray(value.committed) &&
    value.committed.every(isChangedFile) &&
    (value.notices === undefined ||
      (Array.isArray(value.notices) && value.notices.every(isRecord)))
  );
}

function capChangedFilesInSnapshot(
  snapshot: PortalStateSnapshotPayload,
  commandId?: string,
): PortalStateSnapshotPayload {
  const entityIndex = snapshot.entities.findIndex(
    (entity) => entity.entityType === 'changed_files',
  );
  const changedFilesEntity = snapshot.entities[entityIndex];
  if (
    !changedFilesEntity ||
    !isChangedFilesPayload(changedFilesEntity.payload)
  ) {
    return snapshot;
  }

  const originalPayload = changedFilesEntity.payload;
  // The outbox splits per entity, so size this candidate in the head frame.
  const measureSnapshot = (candidate: PortalChangedFilesPayload): number => {
    const candidateSnapshot: PortalStateSnapshotPayload = {
      ...snapshot,
      entities: [{ ...changedFilesEntity, payload: candidate }],
    };
    const event: PortalEventEnvelope = {
      type: 'portal.state.snapshot',
      ...(commandId ? { commandId } : {}),
      eventId: SNAPSHOT_MEASUREMENT_EVENT_ID,
      clientEventId: SNAPSHOT_MEASUREMENT_EVENT_ID,
      occurredAt: snapshot.generatedAt,
      payload: candidateSnapshot,
    };
    return portalEventMaxRoutedByteLength(event);
  };
  const cappedPayload = capChangedFilesPayload(
    originalPayload,
    measureSnapshot,
    PORTAL_SNAPSHOT_EVENT_BUDGET,
  );
  if (cappedPayload === originalPayload) return snapshot;

  return {
    ...snapshot,
    entities: snapshot.entities.map((entity, index) =>
      index === entityIndex ? { ...entity, payload: cappedPayload } : entity,
    ),
  };
}

export function listActivitySummaryPortalEntities(
  scope: PortalStateRequestPayload['scope'],
  hydratedEntityCount: number,
): PortalEntityEnvelope[] {
  return [
    {
      entityType: 'activity_summary',
      localId: 'overview',
      payload: {
        generatedAt: new Date().toISOString(),
        scope,
        hydratedEntityCount,
      },
    },
  ];
}

function isActivityInventoryId(value: string): boolean {
  try {
    validateId(value, 'activityId');
    return true;
  } catch {
    return false;
  }
}

function standaloneChatToPortalEntity(
  chat: Awaited<ReturnType<typeof listStandaloneChats>>[number],
): PortalEntityEnvelope {
  const snapshot = projectStandaloneChatSnapshot(chat);
  return {
    entityType: 'standalone_chat',
    localId: chat.chatId,
    parentLocalId: chat.projectLocalId,
    payload: {
      ...snapshot,
      projectLocalId: chat.projectLocalId,
      projectId: chat.projectId,
      chatId: chat.chatId,
    },
  };
}

function scriptRunToPortalEntity(run: PortalScriptRun): PortalEntityEnvelope {
  return {
    entityType: 'script_run',
    localId: run.localId,
    parentLocalId: worktreeScopedParentLocalId(
      run.workspaceLocalId,
      run.worktreeLocalId,
    ),
    payload: run,
  };
}

function hookRunToPortalEntity(run: PortalHookRun): PortalEntityEnvelope {
  return {
    entityType: 'hook_run',
    localId: run.localId,
    parentLocalId: worktreeScopedParentLocalId(
      run.workspaceLocalId,
      run.worktreeLocalId,
    ),
    payload: run,
  };
}

function pipelineRunToPortalEntity(
  run: PortalPipelineRun,
): PortalEntityEnvelope {
  return {
    entityType: 'pipeline_run',
    localId: run.localId,
    parentLocalId: worktreeScopedParentLocalId(
      run.workspaceLocalId,
      run.worktreeLocalId,
    ),
    payload: run,
  };
}

async function listScriptEntitiesForWorktree(input: {
  workspaceLocalId: string;
  worktreeLocalId: string;
}): Promise<PortalEntityEnvelope[]> {
  const scriptInput = {
    ...input,
    workspaceId: input.workspaceLocalId,
    worktreeId: input.worktreeLocalId,
    projectId: input.workspaceLocalId,
  };
  const [scripts, scriptRuns] = await Promise.all([
    listScripts(scriptInput).catch(() => []),
    listScriptRuns(scriptInput).catch(() => []),
  ]);
  return [
    ...scripts.map(scriptToPortalEntity),
    ...scriptRuns.map(scriptRunToPortalEntity),
  ];
}

async function listPipelineEntitiesForWorktree(input: {
  workspaceLocalId: string;
  worktreeLocalId: string;
}): Promise<PortalEntityEnvelope[]> {
  const pipelineInput = {
    ...input,
    workspaceId: input.workspaceLocalId,
    worktreeId: input.worktreeLocalId,
    projectId: input.workspaceLocalId,
  };
  const [pipelines, pipelineRuns] = await Promise.all([
    listPipelines(pipelineInput).catch(() => []),
    listPipelineRuns(pipelineInput).catch(() => []),
  ]);
  return [
    ...pipelines.map(pipelineToPortalEntity),
    ...pipelineRuns.map(pipelineRunToPortalEntity),
  ];
}

async function listPlanEntitiesForWorktree(input: {
  workspaceLocalId: string;
  worktreeLocalId: string;
}): Promise<PortalEntityEnvelope[]> {
  const plans = await listPlans({
    projectId: input.workspaceLocalId,
    worktreeId: input.worktreeLocalId,
  }).catch(() => []);
  return plans.map(planToPortalEntity);
}

async function listHookEntitiesForWorktree(input: {
  workspaceLocalId: string;
  worktreeLocalId: string;
}): Promise<PortalEntityEnvelope[]> {
  const hookInput = {
    ...input,
    workspaceId: input.workspaceLocalId,
    worktreeId: input.worktreeLocalId,
    projectId: input.workspaceLocalId,
  };
  const [hooks, hookRuns] = await Promise.all([
    listHooks(hookInput).catch(() => []),
    listHookRuns(hookInput).catch(() => []),
  ]);
  return [
    ...hooks.map(hookToPortalEntity),
    ...hookRuns.map(hookRunToPortalEntity),
  ];
}

async function listSummaryEntitiesForWorktree(input: {
  workspaceLocalId: string;
  worktreeLocalId: string;
}): Promise<PortalEntityEnvelope[]> {
  const { workspaceLocalId, worktreeLocalId } = input;
  const summary = await readWorktreeSummary(
    workspaceLocalId,
    worktreeLocalId,
  ).catch(() => null);
  if (!summary) return [];
  return [
    {
      entityType: 'worktree_summary',
      localId: worktreeLocalId,
      parentLocalId: worktreeScopedParentLocalId(
        workspaceLocalId,
        worktreeLocalId,
      ),
      payload: {
        workspaceLocalId,
        worktreeLocalId,
        title: summary.title,
        description: summary.description,
        highlights: summary.highlights,
        repos: summary.repos,
        generatedAt: summary.generatedAt,
        lastFullRefreshAt: summary.lastFullRefreshAt,
        generating: isWorktreeSummaryGenerating(
          workspaceLocalId,
          worktreeLocalId,
        ),
      },
    },
  ];
}

/**
 * One worktree's plan, script, hook, pipeline and summary entities, built by
 * the same section readers as a Portal `worktree` snapshot. Browser Remote
 * Control controllers read them over `worktree:activity-entities` (CAN-5985),
 * so their panels list exactly the rows a Portal session would.
 */
export async function listWorktreeActivityEntities(input: {
  workspaceLocalId: string;
  worktreeLocalId: string;
}): Promise<PortalEntityEnvelope[]> {
  validateId(input.workspaceLocalId, 'projectId');
  validateId(input.worktreeLocalId, 'worktreeId');
  const sections = await Promise.all([
    listPlanEntitiesForWorktree(input),
    listScriptEntitiesForWorktree(input),
    listHookEntitiesForWorktree(input),
    listPipelineEntitiesForWorktree(input),
    listSummaryEntitiesForWorktree(input),
  ]);
  return sections.flat();
}

function safeListTerminalPortalEntities(
  target: PortalStateRequestPayload['target'],
): PortalEntityEnvelope[] {
  try {
    return listTerminalPortalEntities(target);
  } catch {
    return [];
  }
}

async function listWorktreeChatEntities(input: {
  strict?: boolean;
  workspaceLocalId: string;
  worktreeLocalId: string;
}): Promise<{
  summaries: Awaited<ReturnType<typeof listWorktreeChatSummaries>>;
  entities: PortalEntityEnvelope[];
}> {
  const summaries = await listWorktreeChatSummaries({
    workspaceId: input.workspaceLocalId,
    worktreeId: input.worktreeLocalId,
  }).catch((error: unknown) => {
    if (input.strict) throw error;
    // Degrade to an empty tab list, but surface the failure: swallowing it
    // silently makes a hard error (e.g. an id that fails validateId, or a
    // corrupt tabs file) indistinguishable from a worktree that genuinely
    // has no chats, so the portal/mobile client just shows "No chats yet".
    // eslint-disable-next-line no-console
    console.warn(
      '[portal-snapshot] Failed to project worktree chat summaries; ' +
        'showing an empty chat-tab list for this worktree',
      {
        workspaceLocalId: input.workspaceLocalId,
        worktreeLocalId: input.worktreeLocalId,
        error: error instanceof Error ? error.message : String(error),
      },
    );
    return [];
  });
  return {
    summaries,
    entities: summaries.map((summary) => ({
      entityType: 'chat_summary' as const,
      localId: summary.chatId,
      parentLocalId: worktreeScopedParentLocalId(
        input.workspaceLocalId,
        input.worktreeLocalId,
      ),
      payload: summary,
    })),
  };
}

async function listWorktreeTodoEnvelopes(input: {
  workspaceLocalId: string;
  worktreeLocalId: string;
  chatLocalId?: string;
}): Promise<PortalEntityEnvelope[]> {
  const projections = await listWorktreeTodoEntities({
    workspaceId: input.workspaceLocalId,
    worktreeId: input.worktreeLocalId,
  }).catch(() => []);
  return projections
    .filter(
      (projection) =>
        !input.chatLocalId || projection.chatId === input.chatLocalId,
    )
    .map((projection) => ({
      entityType: 'chat_todo',
      localId: projection.chatId,
      parentLocalId: worktreeScopedParentLocalId(
        projection.workspaceLocalId,
        projection.worktreeLocalId,
      ),
      payload: projection,
    }));
}

async function getWorktreeTranscriptSeed(input: {
  workspaceLocalId: string;
  worktreeLocalId: string;
  chatLocalId?: string;
}): Promise<{ messages: PortalChatMessage[]; truncated: boolean }> {
  return getWorktreeChatTranscriptSeed({
    workspaceId: input.workspaceLocalId,
    worktreeId: input.worktreeLocalId,
    ...(input.chatLocalId ? { chatId: input.chatLocalId } : {}),
  }).catch(() => ({ messages: [], truncated: false }));
}

/** Only a targeted refresh can confirm a paired desktop purchase. */
async function projectModelLibraryContext(
  entities: PortalEntityEnvelope[],
  request: PortalStateRequestPayload,
  requestId: string | undefined,
): Promise<void> {
  if (!requestId || !request.target) return;
  const target = request.target;
  const entity = entities.find((candidate) =>
    request.scope === 'worktree'
      ? candidate.entityType === 'worktree' &&
        candidate.localId === target.worktreeLocalId
      : request.scope === 'app_advisor'
        ? candidate.entityType === 'app_advisor_chat' &&
          candidate.localId === target.chatLocalId
        : target.standaloneChatLocalId
          ? candidate.entityType === 'standalone_chat' &&
            candidate.localId === target.standaloneChatLocalId
          : request.scope === 'chat' &&
            candidate.entityType === 'chat_summary' &&
            candidate.localId === target.chatLocalId,
  );
  if (
    !entity ||
    !isRecord(entity.payload) ||
    !Array.isArray(entity.payload.availableModels)
  )
    return;
  const payload = entity.payload;
  const projectId =
    request.scope === 'app_advisor'
      ? APP_ADVISOR_PROJECT_ID
      : (target.workspaceLocalId ?? target.projectLocalId);
  if (!projectId) return;
  const worktreeId =
    target.worktreeLocalId ??
    (typeof payload.workEntryId === 'string' ? payload.workEntryId : undefined);
  const owner = await resolveAiCreditsScopeOwner({
    kind: 'work',
    projectId,
    ...(worktreeId ? { worktreeId } : {}),
    ...(request.scope !== 'worktree' ? { chatId: entity.localId } : {}),
  });
  if (!owner) return;
  const result = await probeEntitlementsWithModelLibrary(owner);
  if (!result.accountKey) return;
  const accessState = result.workModelLibrary;
  const access =
    accessState?.status === 'reported' || accessState?.status === 'retained'
      ? accessState.access
      : undefined;
  const context: ModelLibraryContext = {
    accountKey: result.accountKey,
    owner,
    ...(access ? { access } : {}),
    authoritative: accessState?.status === 'reported',
    requestId,
  };
  const providers = peekPortalProviderAvailability();
  const availableModels = entity.payload.availableModels.map((row: unknown) => {
    if (!isRecord(row) || typeof row.id !== 'string' || !access) return row;
    const creditsRouted =
      !isOrgGatewayRoute(row.id) &&
      (row.extraChargeOnly === true ||
        row.source === 'ai-gateway' ||
        (typeof row.provider === 'string' &&
          Reflect.get(providers, row.provider) === false &&
          isGatewayRoutableModel(row.id)));
    return {
      ...row,
      libraryEligibility:
        access !== 'unlocked' && creditsRouted && !isGuestAllowedModelId(row.id)
          ? 'locked'
          : 'available',
    };
  });
  entity.payload = {
    ...payload,
    availableModels,
    modelLibraryContext: context,
  };
}

export async function buildPortalSnapshot(
  request: PortalStateRequestPayload,
  options?: { commandId?: string },
): Promise<BuiltPortalSnapshot> {
  const entities: PortalEntityEnvelope[] = [];
  const sections: Array<{
    name: PortalSnapshotSection;
    run: () => Promise<PortalEntityEnvelope[]>;
  }> = [];
  const followUpEvents: PortalEventEnvelope[] = [];
  const visibleCoworkProjectIds: string[] = [];
  const visibleWorkspaceIds = new Set<string>();
  const projectedWorktrees: PortalSessionShellState['worktrees'] = [];
  const attentionWorkspaceIds = new Set<string>();
  let attentionParentsRead = false;
  const attentionIncarnations: {
    workspaceId: string;
    worktreeId: string;
    createdAt: string;
  }[] = [];
  const captureWorkspace = (
    workspace: PortalSessionShellState['workspaces'][number],
  ): void => {
    attentionWorkspaceIds.add(workspace.localId);
    if (
      request.includeChatSummaries !== true ||
      workspace.hidden ||
      !isActivityInventoryId(workspace.localId)
    )
      return;
    if (workspace.type === 'cowork')
      visibleCoworkProjectIds.push(workspace.localId);
    if (workspace.type === 'single-repo' || workspace.type === 'multi-repo')
      visibleWorkspaceIds.add(workspace.localId);
  };
  const captureWorktree = (
    worktree: PortalSessionShellState['worktrees'][number],
  ): void => {
    if (worktree.createdAt)
      attentionIncarnations.push({
        workspaceId: worktree.workspaceLocalId,
        worktreeId: worktree.localId,
        createdAt: worktree.createdAt,
      });
    if (request.includeChatSummaries === true)
      projectedWorktrees.push(worktree);
  };
  let chatMessages: PortalChatMessage[] | undefined;
  let chatMessagesTruncated: boolean | undefined;
  let snapshotTarget = request.target;
  const selectedChatOnly =
    request.scope === 'chat' &&
    request.selectedChatOnly === true &&
    !!request.target?.workspaceLocalId &&
    !!request.target?.worktreeLocalId;
  const workspaceLocalId = request.target?.workspaceLocalId;
  const worktreeLocalId = request.target?.worktreeLocalId;
  const standaloneChatLocalId = request.target?.standaloneChatLocalId;
  const standaloneProjectLocalId = request.target?.projectLocalId;
  // Keyed builds can complete out of order. Shared state belongs only to
  // snapshots that serialize against every other lane.
  const includesSharedState = portalSnapshotRoutingKey(request) === null;
  const viewMode = includesSharedState
    ? (await readPortalStateStore().catch(() => null))?.viewMode
    : undefined;
  const recordSection = (
    section: PortalSnapshotSection,
    elapsedMs: number,
    entityCount: number,
  ): void => {
    if (!options?.commandId) {
      return;
    }
    recordPortalSnapshotTiming({
      commandId: options.commandId,
      stage: 'snapshot_section_completed',
      section,
      scope: request.scope,
      workspaceLocalId,
      worktreeLocalId,
      chatLocalId: request.target?.chatLocalId ?? standaloneChatLocalId,
      elapsedMs: Math.max(0, Math.round(elapsedMs * 100) / 100),
      entityCount,
    });
  };

  if (
    request.scope === 'overview' ||
    request.scope === 'workspace' ||
    request.scope === 'worktree'
  ) {
    const sectionDurations = new Map<PortalSnapshotSection, number>();
    // Diff stats stay on for every scope, including overview: the sidebar's
    // +N/-N badges have no other hydration path for unselected rows, so
    // dropping them from the overview would blank the badges until each row
    // is individually selected. The bounded-concurrency computation in
    // `computeWorktreeDiffStats` (not the former serial loop) is what keeps
    // the overview build inside the CAN-1604 latency budget.
    const workspaceEntities = await listWorkspacePortalEntities(
      request.target,
      {
        statsSource: 'portal-snapshot',
        onWorkspace: captureWorkspace,
        onWorktree: captureWorktree,
        onTiming: (section, ms): void => {
          sectionDurations.set(section, ms);
        },
      },
    );
    attentionParentsRead = true;
    recordSection(
      'workspaces_list',
      sectionDurations.get('workspaces_list') ?? 0,
      workspaceEntities.filter((entity) => entity.entityType === 'workspace')
        .length,
    );
    recordSection(
      'worktrees',
      sectionDurations.get('worktrees') ?? 0,
      workspaceEntities.filter((entity) => entity.entityType === 'worktree')
        .length,
    );
    const worktreeOwner =
      request.scope === 'worktree' && workspaceLocalId && worktreeLocalId
        ? await resolveAiCreditsScopeOwner({
            kind: 'work',
            projectId: workspaceLocalId,
            worktreeId: worktreeLocalId,
          })
        : undefined;
    entities.push(
      ...(request.scope === 'worktree' && worktreeLocalId
        ? projectNewTaskControls(
            workspaceEntities,
            worktreeLocalId,
            worktreeOwner,
            workspaceLocalId
              ? await (
                  await import('../agents/agent-default-model')
                ).resolveCatalogAgentDefaultModel(workspaceLocalId)
              : undefined,
          )
        : workspaceEntities),
    );
  }

  if (
    request.scope === 'overview' ||
    request.scope === 'workspace' ||
    request.scope === 'standalone_chat'
  ) {
    const startedAt = performance.now();
    const standaloneChats = (
      await listStandaloneChats(
        request.includeChatSummaries === true && request.scope === 'overview'
          ? { strict: true, projectIds: visibleCoworkProjectIds }
          : undefined,
      )
    ).filter(
      (chat) =>
        (request.includeChatSummaries !== true ||
          request.scope !== 'overview' ||
          (!chat.archived &&
            visibleCoworkProjectIds.includes(chat.projectLocalId) &&
            isActivityInventoryId(chat.chatId) &&
            (chat.workEntryId === undefined ||
              isActivityInventoryId(chat.workEntryId)))) &&
        (!standaloneProjectLocalId ||
          chat.projectLocalId === standaloneProjectLocalId) &&
        (!standaloneChatLocalId || chat.chatId === standaloneChatLocalId),
    );
    // Only a snapshot of one chat reads its questions from the Work Entry.
    const projectedStandaloneChats =
      request.scope === 'standalone_chat' && standaloneChatLocalId
        ? await Promise.all(standaloneChats.map(withStandalonePendingQuestions))
        : standaloneChats;
    entities.push(
      ...projectedStandaloneChats.map(standaloneChatToPortalEntity),
    );
    recordSection(
      'standalone_chats',
      elapsedMilliseconds(startedAt),
      standaloneChats.length,
    );
  }

  if (request.scope === 'overview') {
    if (request.includeChatSummaries !== true)
      recordSection('chat_summaries', 0, 0);
    entities.push(...(await listPortalProviderUsageEntities()));
  }

  if (request.scope === 'worktree' && workspaceLocalId && worktreeLocalId) {
    const chatEntities = await listWorktreeChatEntities({
      workspaceLocalId,
      worktreeLocalId,
    });
    entities.push(...chatEntities.entities);
    entities.push(
      ...(await listWorktreeTodoEnvelopes({
        workspaceLocalId,
        worktreeLocalId,
      })),
    );
    // Lazy-load plan: a worktree-scoped snapshot now carries chat
    // summaries only by default. The per-tab transcript is fetched on
    // demand via the `chat` snapshot scope keyed by `chatLocalId`, so
    // navigating between chats does not pull every tab's history into
    // the cache. Callers that want a specific chat's transcript bundled
    // with the worktree snapshot can still pass `chatLocalId` in the
    // request target — that path is preserved for the desktop-internal
    // session-bootstrap callers that depend on it.
    if (request.target?.chatLocalId) {
      const seed = await getWorktreeTranscriptSeed({
        workspaceLocalId,
        worktreeLocalId,
        chatLocalId: request.target.chatLocalId,
      });
      chatMessages = seed.messages;
      chatMessagesTruncated = seed.truncated;
    }
  }

  if (request.scope === 'worktree' && workspaceLocalId && worktreeLocalId) {
    entities.push(
      ...listPortalBackgroundProcessEntitiesForWorktree({
        workspaceLocalId,
        worktreeLocalId,
      }),
    );
  }

  if (request.scope === 'standalone_chat' && standaloneChatLocalId) {
    const seed = await getStandaloneChatTranscriptSeed({
      chatId: standaloneChatLocalId,
      projectLocalId: standaloneProjectLocalId,
    });
    chatMessages = seed.messages;
    chatMessagesTruncated = seed.truncated;
  }

  if (request.scope === 'chat') {
    if (standaloneChatLocalId) {
      const seed = await getStandaloneChatTranscriptSeed({
        chatId: standaloneChatLocalId,
        projectLocalId: standaloneProjectLocalId,
      });
      chatMessages = seed.messages;
      chatMessagesTruncated = seed.truncated;
    } else if (workspaceLocalId && worktreeLocalId) {
      const [chatEntities, selectedSeed] = await Promise.all([
        listWorktreeChatEntities({
          workspaceLocalId,
          worktreeLocalId,
          strict: selectedChatOnly,
        }),
        selectedChatOnly && request.target?.chatLocalId
          ? getWorktreeChatTranscriptSeed({
              workspaceId: workspaceLocalId,
              worktreeId: worktreeLocalId,
              chatId: request.target.chatLocalId,
            })
          : Promise.resolve(undefined),
      ]);
      const chatLocalId =
        request.target?.chatLocalId ??
        (selectedChatOnly
          ? (chatEntities.summaries.find((summary) => summary.active)?.chatId ??
            chatEntities.summaries[0]?.chatId)
          : undefined);
      snapshotTarget = {
        ...request.target,
        ...(chatLocalId ? { chatLocalId } : {}),
      };
      entities.push(...chatEntities.entities);
      if (!selectedChatOnly || chatLocalId) {
        const seedInput = {
          workspaceId: workspaceLocalId,
          worktreeId: worktreeLocalId,
          ...(chatLocalId ? { chatId: chatLocalId } : {}),
        };
        // Foreground failures remain retryable instead of clearing cached history.
        const seed = selectedChatOnly
          ? (selectedSeed ?? (await getWorktreeChatTranscriptSeed(seedInput)))
          : await getWorktreeTranscriptSeed({
              workspaceLocalId,
              worktreeLocalId,
              chatLocalId,
            });
        chatMessages = seed.messages;
        chatMessagesTruncated = seed.truncated;
        entities.push(
          ...(await listWorktreeTodoEnvelopes({
            workspaceLocalId,
            worktreeLocalId,
            chatLocalId,
          })),
        );
      }
    }
  }

  if (
    request.scope === 'terminal' ||
    request.scope === 'workspace' ||
    request.scope === 'worktree'
  ) {
    entities.push(...safeListTerminalPortalEntities(request.target));
  }

  if (
    (request.scope === 'worktree' || request.scope === 'plans') &&
    workspaceLocalId &&
    worktreeLocalId
  ) {
    sections.push({
      name: 'plans',
      run: (): Promise<PortalEntityEnvelope[]> =>
        listPlanEntitiesForWorktree({ workspaceLocalId, worktreeLocalId }),
    });
  }

  if (
    (request.scope === 'worktree' || request.scope === 'scripts') &&
    workspaceLocalId &&
    worktreeLocalId
  ) {
    sections.push({
      name: 'scripts',
      run: async (): Promise<PortalEntityEnvelope[]> => {
        const sectionEntities: PortalEntityEnvelope[] = [];
        sectionEntities.push(
          ...(await listScriptEntitiesForWorktree({
            workspaceLocalId,
            worktreeLocalId,
          })),
        );

        return sectionEntities;
      },
    });
  }

  if (
    (request.scope === 'worktree' || request.scope === 'hooks') &&
    workspaceLocalId &&
    worktreeLocalId
  ) {
    sections.push({
      name: 'hooks',
      run: (): Promise<PortalEntityEnvelope[]> =>
        listHookEntitiesForWorktree({ workspaceLocalId, worktreeLocalId }),
    });
  }

  if (request.scope === 'worktree' && workspaceLocalId && worktreeLocalId) {
    sections.push({
      name: 'mcp',
      run: async (): Promise<PortalEntityEnvelope[]> => {
        const sectionEntities: PortalEntityEnvelope[] = [];
        sectionEntities.push(
          ...(await listPortalMcpServerEntitiesForWorktree({
            workspaceLocalId,
            worktreeLocalId,
          }).catch((error: unknown) => {
            logMainProcessError('Portal MCP snapshot projection failed', error);
            return [];
          })),
        );

        return sectionEntities;
      },
    });
  }

  if (
    (request.scope === 'worktree' || request.scope === 'pipelines') &&
    workspaceLocalId &&
    worktreeLocalId
  ) {
    sections.push({
      name: 'pipelines',
      run: async (): Promise<PortalEntityEnvelope[]> => {
        const sectionEntities: PortalEntityEnvelope[] = [];
        sectionEntities.push(
          ...(await listPipelineEntitiesForWorktree({
            workspaceLocalId,
            worktreeLocalId,
          })),
        );

        return sectionEntities;
      },
    });
  }

  if (request.scope === 'worktree_actions') {
    // Let a sidebar read failure throw: `worktree_actions` snapshots are an
    // untargeted authoritative replacement, so degrading to an empty pair
    // list would wipe every cached script/pipeline row session-wide. A
    // failed command instead lets the browser clear its dedupe key and
    // retry. A successful read with zero worktrees still (correctly) emits
    // the empty snapshot; the trailing `activity_summary` entity is appended
    // like every other scope and is intentionally untouched by the browser's
    // action-section replacement.
    const sidebarItems = await readPortalSidebarItems();
    if (sidebarItems.stale) throw new Error(W5_UNREACHABLE_READ_MESSAGE);
    const pairs = sidebarItems.items.flatMap((item) =>
      item.type === 'single-repo' || item.type === 'multi-repo'
        ? item.worktrees.map((worktree) => ({
            workspaceLocalId: item.id,
            worktreeLocalId: worktree.id,
          }))
        : [],
    );
    const actionEntities = await mapWithConcurrency(
      pairs,
      WORKTREE_ACTIONS_CONCURRENCY,
      async (pair): Promise<PortalEntityEnvelope[]> => {
        const [scripts, pipelines] = await Promise.all([
          listScriptEntitiesForWorktree(pair),
          listPipelineEntitiesForWorktree(pair),
        ]);
        return [...scripts, ...pipelines];
      },
    );
    entities.push(...actionEntities.flat());
  }

  if (
    request.scope === 'worktree_chat_summaries' ||
    (request.scope === 'overview' && request.includeChatSummaries === true)
  ) {
    // Batched, untargeted chat-title hydration for the sidebar chat search
    // (CAN-1990). Like `worktree_actions`, a sidebar read failure must reject:
    // this snapshot authoritatively replaces every cached worktree-scoped
    // chat_summary row, so an empty fallback would wipe them session-wide. A
    // single worktree's failed tab read degrades to an empty list inside
    // `listWorktreeChatEntities` without failing the batch.
    const startedAt = performance.now();
    const entityCountBefore = entities.length;
    const sidebarItems = await readPortalSidebarItems();
    if (sidebarItems.stale) throw new Error(W5_UNREACHABLE_READ_MESSAGE);
    let pairs = sidebarItems.items.flatMap((item) =>
      item.type === 'single-repo' || item.type === 'multi-repo'
        ? item.worktrees.map((worktree) => ({
            workspaceLocalId: item.id,
            worktreeLocalId: worktree.id,
          }))
        : [],
    );
    if (request.includeChatSummaries === true) {
      // Overview already captured these exact parents; do not re-list and
      // combine one parent revision with a different chat inventory.
      if (request.scope === 'worktree_chat_summaries') {
        await listWorkspacePortalEntities(request.target, {
          includeDiffStats: false,
          onWorkspace: captureWorkspace,
          onWorktree: captureWorktree,
        });
        attentionParentsRead = true;
      }
      const allowed = new Set(
        projectedWorktrees
          .filter(
            (worktree) =>
              !worktree.hidden &&
              visibleWorkspaceIds.has(worktree.workspaceLocalId),
          )
          .map((worktree) =>
            JSON.stringify([worktree.workspaceLocalId, worktree.localId]),
          ),
      );
      pairs = pairs.filter((pair) => {
        try {
          validateId(pair.workspaceLocalId, 'workspaceId');
          validateId(pair.worktreeLocalId, 'worktreeId');
        } catch {
          return false;
        }
        return allowed.has(
          JSON.stringify([pair.workspaceLocalId, pair.worktreeLocalId]),
        );
      });
    }
    const batch = await listWorktreeChatSummaryBatch(
      pairs,
      async (pair) =>
        (
          await listWorktreeChatEntities({
            ...pair,
            strict: request.includeChatSummaries === true,
          })
        ).summaries,
    );
    for (const { target: pair, summaries } of batch)
      entities.push(
        ...summaries
          .filter((summary) => {
            if (request.includeChatSummaries !== true) return true;
            try {
              validateId(summary.chatId, 'chatId');
            } catch {
              return false;
            }
            return (
              summary.scope === 'worktree' &&
              summary.workspaceLocalId === pair.workspaceLocalId &&
              summary.worktreeLocalId === pair.worktreeLocalId
            );
          })
          .map((summary) => ({
            entityType: 'chat_summary' as const,
            localId: summary.chatId,
            parentLocalId: worktreeScopedParentLocalId(
              pair.workspaceLocalId,
              pair.worktreeLocalId,
            ),
            payload: summary,
          })),
      );
    if (request.includeChatSummaries === true)
      recordSection(
        'chat_summaries',
        elapsedMilliseconds(startedAt),
        entities.length - entityCountBefore,
      );
  }

  if (request.scope === 'app_advisor') {
    // Untargeted authoritative hydration of every App Advisor chat tab
    // (CAN-2565). ANY read failure must reject — the registry read AND each
    // entry's tab read: the server deletes every cached `app_advisor_chat`
    // row before upserting this snapshot, so degrading one flaky tab read to
    // an empty list would wipe that entry's chats from the browser cache. A
    // failed command instead lets the browser clear its dedupe key and
    // retry. A genuinely empty registry still (correctly) emits the empty
    // snapshot — nothing should be cached.
    const preferredChatId = request.target?.chatLocalId;
    const preferredEntryId = preferredChatId
      ? (await resolveWorkEntryForChat(APP_ADVISOR_PROJECT_ID, preferredChatId))
          .entryId
      : null;
    const allEntries = await listWorkEntries(APP_ADVISOR_PROJECT_ID);
    const appAdvisorItemGroups = preferredChatId
      ? undefined
      : await projectSidebarItemGroups({ appAdvisor: true });
    if (appAdvisorItemGroups) {
      entities.push({
        entityType: 'app_advisor_item_groups',
        localId: APP_ADVISOR_PROJECT_ID,
        payload: { groups: appAdvisorItemGroups },
      });
    }
    let entries = allEntries.map((entry, order) => ({ entry, order }));
    const windowUiState = getLatestAppAdvisorWindowUiState();
    if (preferredChatId) {
      if (!preferredEntryId) {
        // A targeted snapshot is an authoritative replacement for this one
        // chat in both browser state and the server cache. Never acknowledge
        // an unresolved id with an empty targeted snapshot: doing so would
        // delete an optimistic tab that has not reached disk yet, or an
        // existing tab hidden by a transient read failure. Reject so the
        // browser re-arms its hydration key and retries after the tab becomes
        // resolvable.
        throw new Error(
          `${ORCHESTRATOR_LABEL} chat is not resolvable: ${preferredChatId}`,
        );
      }
      entries = entries.filter(({ entry }) => entry.id === preferredEntryId);
      if (entries.length === 0) {
        throw new Error(
          `${ORCHESTRATOR_LABEL} Work Entry is not resolvable: ${preferredEntryId}`,
        );
      }
    } else if (windowUiState.activeWorkEntryId) {
      const activeEntry = entries.find(
        ({ entry }) => entry.id === windowUiState.activeWorkEntryId,
      );
      if (activeEntry) {
        entries = [
          activeEntry,
          ...entries.filter(({ entry }) => entry.id !== activeEntry.entry.id),
        ];
      }
    }
    const summaryEntities = await mapWithConcurrency(
      entries,
      WORKTREE_ACTIONS_CONCURRENCY,
      async ({ entry, order }): Promise<PortalEntityEnvelope[]> =>
        (await listAppAdvisorChatSummaries(entry.id, { entry, order }))
          .filter(
            (summary) => !preferredChatId || summary.chatId === preferredChatId,
          )
          .map((summary) => ({
            entityType: 'app_advisor_chat' as const,
            localId: summary.chatId,
            payload: {
              ...summary,
              desktopCurrent:
                windowUiState.activeWorkEntryId === entry.id &&
                windowUiState.activeChatId === summary.chatId,
            },
          })),
    );
    entities.push(...summaryEntities.flat());
    // Seed the persisted transcripts alongside the summaries: server-side
    // chat rows are per portal session, so a freshly paired browser has no
    // other history source for pre-existing App Advisor tabs. Same seed
    // contract as the worktree/standalone scopes (bounded + truncation
    // metadata, so the server's prune guard stays safe). A seed failure
    // rejects like the reads above — a partial snapshot must not
    // authoritatively prune rows its seed failed to include.
    const seed = await getAppAdvisorChatTranscriptSeed(
      preferredChatId
        ? {
            chatId: preferredChatId,
            ...(preferredEntryId ? { entryId: preferredEntryId } : {}),
          }
        : undefined,
    );
    chatMessages = seed.messages;
    chatMessagesTruncated = seed.truncated;
  }

  if (
    (request.scope === 'worktree' || request.scope === 'files') &&
    workspaceLocalId &&
    worktreeLocalId
  ) {
    sections.push({
      name: 'files',
      run: async (): Promise<PortalEntityEnvelope[]> => {
        const sectionEntities: PortalEntityEnvelope[] = [];
        const roots = await listFileRoots({
          projectId: workspaceLocalId,
          worktreeId: worktreeLocalId,
        }).catch(() => []);
        sectionEntities.push(
          ...roots.map((root) => ({
            entityType: 'file_root' as const,
            localId: root.fileRootLocalId,
            parentLocalId: worktreeScopedParentLocalId(
              root.workspaceLocalId,
              root.worktreeLocalId,
            ),
            payload: root,
          })),
        );

        return sectionEntities;
      },
    });
  }

  if (
    (request.scope === 'worktree' || request.scope === 'diff') &&
    workspaceLocalId &&
    worktreeLocalId
  ) {
    sections.push({
      name: 'diff',
      run: async (): Promise<PortalEntityEnvelope[]> => {
        const sectionEntities: PortalEntityEnvelope[] = [];
        const changedFiles = await portalSnapshotWorkBudget
          .expensive(() =>
            listChangedFileSets(workspaceLocalId, worktreeLocalId),
          )
          .catch(() => []);
        sectionEntities.push({
          entityType: 'changed_files',
          localId: worktreeLocalId,
          parentLocalId: worktreeScopedParentLocalId(
            workspaceLocalId,
            worktreeLocalId,
          ),
          payload: {
            ...(Array.isArray(changedFiles)
              ? {
                  workspaceLocalId,
                  worktreeLocalId,
                  uncommitted: changedFiles,
                  committed: [],
                }
              : changedFiles),
          },
        });

        return sectionEntities;
      },
    });
  }

  if (
    (request.scope === 'worktree' || request.scope === 'pr') &&
    workspaceLocalId &&
    worktreeLocalId
  ) {
    sections.push({
      name: 'pr',
      run: async (): Promise<PortalEntityEnvelope[]> => {
        const sectionEntities: PortalEntityEnvelope[] = [];
        const cached =
          request.scope === 'worktree' && !request.refresh
            ? getCachedPortalPrState(workspaceLocalId, worktreeLocalId)
            : undefined;
        const pr =
          cached ??
          (await portalSnapshotWorkBudget
            .expensive(() =>
              refreshPullRequestState({
                workspaceLocalId,
                worktreeLocalId,
              }),
            )
            .catch(() => null));
        if (pr) {
          sectionEntities.push({
            entityType: 'pr_status',
            localId: worktreeLocalId,
            parentLocalId: worktreeScopedParentLocalId(
              workspaceLocalId,
              worktreeLocalId,
            ),
            payload: pr,
          });
        }

        return sectionEntities;
      },
    });
  }

  if (request.scope === 'worktree' && workspaceLocalId && worktreeLocalId) {
    sections.push({
      name: 'summary',
      run: (): Promise<PortalEntityEnvelope[]> =>
        listSummaryEntitiesForWorktree({ workspaceLocalId, worktreeLocalId }),
    });
  }

  // Sections read independent stores; assemble in declaration order regardless
  // of completion order. Two per snapshot, four process-wide, and only one
  // expensive Git/PR section (shared with optional cache warming).
  const sectionEntities = await mapWithConcurrency(sections, 2, (section) =>
    portalSnapshotWorkBudget.section(
      async (): Promise<PortalEntityEnvelope[]> => {
        const startedAt = performance.now();
        const result = await section.run();
        recordSection(
          section.name,
          elapsedMilliseconds(startedAt),
          result.length,
        );
        return result;
      },
    ),
  );
  entities.push(...sectionEntities.flat());

  if (includesSharedState) {
    const activitySummaryStartedAt = performance.now();
    const [activitySummary] = listActivitySummaryPortalEntities(
      request.scope,
      entities.length,
    );
    entities.push({
      ...activitySummary,
      payload: {
        ...(typeof activitySummary.payload === 'object' &&
        activitySummary.payload !== null
          ? activitySummary.payload
          : {}),
        ...(viewMode ? { viewMode } : {}),
        // Only a complete parent inventory can replace the global attention list.
        // Partial snapshots preserve it without another workspace read.
        ...(attentionParentsRead && !request.target?.workspaceLocalId
          ? {
              autoDeleteAttention: await projectAutoDeleteAttention(
                [...attentionWorkspaceIds],
                attentionIncarnations,
              ).catch((error: unknown) => {
                logMainProcessWarn(
                  'Could not project Auto Delete attention',
                  error,
                );
                return [];
              }),
            }
          : {}),
        w5Recovery: projectRemoteW5Recovery(
          getDesktopW5RecoveryController().peek(),
        ),
      },
    });
    recordSection(
      'activity_summary',
      elapsedMilliseconds(activitySummaryStartedAt),
      1,
    );
  }

  entities.push(
    ...(await listPortalWatchersForSnapshot(
      { ...request, target: snapshotTarget },
      entities,
    )),
  );

  await projectModelLibraryContext(entities, request, options?.commandId);

  const snapshot: PortalStateSnapshotPayload = capChangedFilesInSnapshot(
    {
      scope: request.scope,
      ...(request.scope === 'overview' && request.includeChatSummaries === true
        ? { chatSummariesComplete: true }
        : {}),
      ...(selectedChatOnly ? { selectedChatOnly: true } : {}),
      ...(request.scope === 'app_advisor'
        ? request.target?.chatLocalId
          ? { target: { chatLocalId: request.target.chatLocalId } }
          : {}
        : request.target &&
            request.scope !== 'worktree_actions' &&
            request.scope !== 'worktree_chat_summaries'
          ? { target: snapshotTarget }
          : {}),
      entities,
      ...(viewMode ? { viewMode } : {}),
      ...(chatMessages
        ? {
            chatMessages,
            chatMessagesTruncated: chatMessagesTruncated ?? false,
          }
        : {}),
      generatedAt: new Date().toISOString(),
    },
    options?.commandId,
  );

  return { snapshot, followUpEvents };
}
