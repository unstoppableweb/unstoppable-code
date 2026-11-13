import { app } from 'electron';
import { publishAutoDeleteActivity } from '../lib/work-entry-auto-delete/activity';
import { collectScheduledAutomationTargetKeys } from '../lib/auto-archive';
import type { ShareOperationResult } from '@canopy/protocol/sharing';
import { readCoworkFolderMissing } from '@canopy/protocol/canopy-core';
import {
  toShareOperationResult,
  withShareStage,
} from '../sharing/share-operation-result';
import { assertInstalledResourceShare } from '../lib/resource-install-context';
import { assertResourceShareDestination } from '../lib/resource-share-context';
import { resourceContextEnabled } from '../lib/resource-context';
import { scopeAutomationsToSelectedContext } from '../services/background-execution-context';
import {
  IPC_CHANNELS,
  DEFAULT_CRON_GENERATION_MODEL,
  DEFAULT_IF_COMMAND_GENERATION_MODEL,
  getExecutionHarnessForModel,
  resolveProviderModelConfig,
  type AutomationCronGenerateRequest,
  type AutomationCronGenerateResponse,
  type AutomationIfCommandGenerateRequest,
  type AutomationIfCommandGenerateResponse,
  type AutomationCreateRequest,
  type AutomationCancelRunRequest,
  type AutomationDeleteRequest,
  type AutomationMutationResponse,
  type AutomationRunNowRequest,
  type AutomationRunHistoryRequest,
  type AutomationRunHistoryResponse,
  type AutomationRunStatus,
  type AutomationRunTrigger,
  type AutomationUpdateRequest,
  type AnalyzeAutomationCapabilityPackageRequest,
  type ApproveAutomationSharedPipelineReviewRequest,
  type AutomationCapabilityPackageRequest,
  type AutomationsListRequest,
  type AutomationsListResponse,
  AUTOMATION_RUN_HISTORY_DEFAULT_PAGE_SIZE,
  AUTOMATION_RUN_HISTORY_MAX_PAGE_SIZE,
  type CommitAutomationCapabilityPackageRequest,
  type CommitAutomationCapabilityPackageResponse,
  type CreateSharedAutomationIpcRequest,
  type DeleteSharedAutomationIpcRequest,
  type InstallAutomationCapabilityPackageRequest,
  type InstallAutomationPipelinesResponse,
  type PreviewAutomationPipelinesResponse,
  type ScheduledActivity,
  type ListSharedAutomationsIpcRequest,
  type ResolveAutomationSharedPipelinePinRequest,
  type ResolvedAutomationSharedPipelinePin,
  type UpdateSharedAutomationIpcRequest,
  type VerifyAutomationSharedPipelinePinRequest,
} from '@canopy/desktop-shared/types';
import type {
  PipelinePackageAnalysisSummary,
  PipelinePackageReadiness,
} from '@canopy/execution-engine/types/pipeline';
import type { PipelineShareInstallPin } from '@canopy/protocol/pipelines';
import type { CuratedAutomationDetail } from '@canopy/protocol/automation-catalog';
import { isCuratedCatalogKey } from '@canopy/protocol/plugin-catalog';
import type {
  ListCuratedAutomationsRequest,
  ListCuratedAutomationsResult,
} from '@canopy/desktop-shared/types/curated-automations';
import type {
  ListSharedAutomationsResponse,
  SharedAutomationDetail,
  SharedAutomationPublicShareInfo,
} from '@canopy/protocol/automations';
import {
  validateAutomationAction,
  validateAutomationActionForWrite,
  validateAutomationCreateRequest,
  validateAutomationIfCommand,
  validateAutomationInstalledFrom,
  validateAutomationTrigger,
} from '@canopy/desktop-shared/lib/automations';
import {
  createAutomationFromForm,
  updateAutomationFromForm,
} from '../automations/chat-automation-save';
import { projectOwnedChatAutomations } from '../automations/owned-chat-projection';
import { createWebCoreCloudScheduleRemote } from '../automations/cloud-schedule-remote';
import { desktopWebCoreBindingOptions, signedInAccountId } from './cloud-chats';
import { getAutomationsService } from '../automations/service';
import { logMainProcessError } from '../lib/main-process-logging';
import {
  createSharedAutomation,
  deleteSharedAutomation,
  getSharedAutomation,
  listSharedAutomations,
  publishAutomationPublicShare,
  revokeAutomationPublicShare,
  updateSharedAutomation,
} from '../automations/canopy-server-client';
import { assertCanopyCloudCapability } from '../canopy-cloud/client';
import { generateCronExpression } from '../automations/cron-generator';
import { generateAutomationIfCommand } from '../automations/if-command-generator';
import { readPreferencesFile } from '../lib/preferences-store';
import { isRecord } from '../lib/type-guards';
import { validateId } from '../lib/validation';
import { sendToWindow } from '../lib/window-send';
import { registerIpcHandler } from './register';
import type { WindowAccessors } from './index';
import {
  analyzeAutomationCapabilityPackage,
  cancelPackageAnalysis,
  createPackagedAutomationCapabilityPackage,
  getAutomationCapabilityPackageReadiness,
  getSharedPipelineAutomationInstallPin,
  installAutomationCapabilityPackage,
  removeAutomationCapabilityPackageInstall,
  verifySharedPipelineAutomationInstallPin,
  type AnalyzeAutomationCapabilityPackageOptions,
} from '../pipelines/pipeline-package-service';
import {
  installAutomationPipelines,
  pipelinesRecordedByAutomations,
  previewAutomationPipelines,
} from '../pipelines/automation-pipeline-install';
import {
  getCuratedAutomation,
  listCuratedAutomations,
} from '../automations/curated-automation-catalog';

const MAX_CRON_DESCRIPTION_CHARS = 1000;
const MAX_IF_COMMAND_DESCRIPTION_CHARS = 1000;
const AUTOMATIONS_CAPABILITY = 'automations-crud-v1';
const AUTOMATION_CATALOG_CAPABILITY = 'automation-catalog-v1';

async function assertSharedAutomationsSupported(): Promise<void> {
  await assertCanopyCloudCapability(AUTOMATIONS_CAPABILITY);
}

/**
 * The stored `worktree_pipeline` action pipeline an analysis packages as the
 * `action` pipeline: only a user or project pipeline travels that way.
 * Derived from the saved activity, never from the request.
 */
function automationActionPipeline(
  activity: ScheduledActivity | undefined,
): AnalyzeAutomationCapabilityPackageOptions['actionPipeline'] {
  if (activity?.action.type !== 'worktree_pipeline') return undefined;
  const { pipelineSource, pipelineId, pipelineName } = activity.action;
  if (pipelineSource !== 'user' && pipelineSource !== 'project')
    return undefined;
  return {
    source: pipelineSource,
    pipelineId,
    ...(pipelineName ? { name: pipelineName } : {}),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateCreateRequest(request: unknown): string | null {
  return validateAutomationCreateRequest(request);
}

function validateUpdateRequest(request: unknown): string | null {
  if (!isRecord(request)) return 'Automation update request must be an object.';
  if (typeof request.id !== 'string' || request.id.trim() === '') {
    return 'Automation id is required.';
  }
  try {
    validateId(request.id, 'automation id');
  } catch (error) {
    return errorMessage(error);
  }
  if (request.name !== undefined) {
    if (typeof request.name !== 'string' || request.name.trim() === '') {
      return 'Automation name must be a non-empty string.';
    }
  }
  if (request.enabled !== undefined && typeof request.enabled !== 'boolean') {
    return 'Automation enabled must be a boolean.';
  }
  if (request.schedule !== undefined) {
    const scheduleError = validateAutomationTrigger(request.schedule);
    if (scheduleError) return scheduleError;
  }
  if (request.action !== undefined) {
    const actionError = validateAutomationActionForWrite(request.action);
    if (actionError) return actionError;
  }
  if (request.ifCommand !== undefined) {
    const ifCommandError = validateAutomationIfCommand(request.ifCommand);
    if (ifCommandError) return ifCommandError;
  }
  const installedFromError = validateAutomationInstalledFrom(
    request.installedFrom,
  );
  if (installedFromError) return installedFromError;
  return null;
}

function validateIdRequest(request: unknown): string | null {
  if (
    !isRecord(request) ||
    typeof request.id !== 'string' ||
    request.id.trim() === ''
  ) {
    return 'Automation id is required.';
  }
  try {
    validateId(request.id, 'automation id');
  } catch (error) {
    return errorMessage(error);
  }
  return null;
}

const RUN_STATUSES = new Set<AutomationRunStatus>([
  'running',
  'success',
  'failure',
  'skipped',
  'canceled',
  'missed',
]);
const RUN_TRIGGERS = new Set<AutomationRunTrigger>([
  'scheduled',
  'manual',
  'catch_up',
]);

function validateRunHistoryRequest(
  request: unknown,
): AutomationRunHistoryRequest {
  if (!isRecord(request) || typeof request.activityId !== 'string') {
    throw new Error('Automation activity id is required.');
  }
  validateId(request.activityId, 'automation activity id');
  if (request.cursor !== undefined && typeof request.cursor !== 'string') {
    throw new Error('Automation run history cursor must be a string.');
  }
  if (
    request.limit !== undefined &&
    (!Number.isInteger(request.limit) ||
      (request.limit as number) < 1 ||
      (request.limit as number) > AUTOMATION_RUN_HISTORY_MAX_PAGE_SIZE)
  ) {
    throw new Error(
      `Automation run history limit must be between 1 and ${AUTOMATION_RUN_HISTORY_MAX_PAGE_SIZE}.`,
    );
  }
  if (
    request.statuses !== undefined &&
    (!Array.isArray(request.statuses) ||
      request.statuses.some((status) => !RUN_STATUSES.has(status as never)))
  ) {
    throw new Error('Automation run history statuses are invalid.');
  }
  if (
    request.triggers !== undefined &&
    (!Array.isArray(request.triggers) ||
      request.triggers.some((trigger) => !RUN_TRIGGERS.has(trigger as never)))
  ) {
    throw new Error('Automation run history triggers are invalid.');
  }
  return {
    activityId: request.activityId,
    ...(request.cursor ? { cursor: request.cursor } : {}),
    limit:
      request.limit === undefined
        ? AUTOMATION_RUN_HISTORY_DEFAULT_PAGE_SIZE
        : (request.limit as number),
    ...(request.statuses
      ? { statuses: request.statuses as AutomationRunStatus[] }
      : {}),
    ...(request.triggers
      ? { triggers: request.triggers as AutomationRunTrigger[] }
      : {}),
  };
}

function validateGenerateCronRequest(request: unknown): string | null {
  if (
    !isRecord(request) ||
    typeof request.description !== 'string' ||
    request.description.trim() === ''
  ) {
    return 'Trigger schedule description is required.';
  }
  if (request.description.length > MAX_CRON_DESCRIPTION_CHARS) {
    return `Trigger schedule description is too long (max ${MAX_CRON_DESCRIPTION_CHARS} characters).`;
  }
  return null;
}

function validateGenerateIfCommandRequest(request: unknown): string | null {
  if (
    !isRecord(request) ||
    typeof request.description !== 'string' ||
    request.description.trim() === ''
  ) {
    return 'If Command description is required.';
  }
  if (request.description.length > MAX_IF_COMMAND_DESCRIPTION_CHARS) {
    return `If Command description is too long (max ${MAX_IF_COMMAND_DESCRIPTION_CHARS} characters).`;
  }
  const currentCommandError = validateAutomationIfCommand(
    request.currentCommand,
  );
  if (currentCommandError) return currentCommandError;
  return null;
}

/** The window accessors the automations service drives. */
type AutomationsWindowAccessors = Pick<
  WindowAccessors,
  | 'getMainWindow'
  | 'getAppAdvisorWindow'
  | 'openAppAdvisorWindow'
  | 'ensureAppAdvisorWindow'
  | 'sendAppAdvisorWindowCommand'
>;

/*
 * The window's automation listing and sharing calls as owners, so App
 * Advisor's automation sharing in Electron main makes the same ones
 * (CAN-6003).
 */

async function writeRemoteMetadataFromDetail(
  activityId: string,
  detail: SharedAutomationDetail,
): Promise<void> {
  await getAutomationsService().setActivityRemoteMetadata(activityId, {
    accountId: detail.createdBy.id,
    remoteId: detail.id,
    contentHash: detail.contentHash,
    shareScope: detail.shareScope,
    // Server-canonical share/update time — the local clock can drift from
    // the timestamps the server reports in list/detail responses.
    sharedAt: detail.updatedAt,
  });
}

export async function listAutomationsForCaller(
  request?: AutomationsListRequest,
): Promise<AutomationsListResponse> {
  const snapshot = projectOwnedChatAutomations(
    await getAutomationsService().list(),
    await getAutomationsService().allActivities(),
  );
  // App Advisor lists what the Automations page shows; everything else
  // reads the full snapshot.
  return isRecord(request) && request.scope === 'selected-context'
    ? scopeAutomationsToSelectedContext(snapshot)
    : snapshot;
}

export async function listSharedAutomationsForCaller(
  request: ListSharedAutomationsIpcRequest,
): Promise<ListSharedAutomationsResponse> {
  await assertSharedAutomationsSupported();
  return listSharedAutomations(request);
}

export async function getSharedAutomationForCaller(
  automationId: string,
): Promise<SharedAutomationDetail> {
  validateId(automationId, 'shared automation id');
  await assertSharedAutomationsSupported();
  return getSharedAutomation(automationId);
}

export async function createSharedAutomationForCaller(
  request: CreateSharedAutomationIpcRequest,
): Promise<ShareOperationResult<SharedAutomationDetail>> {
  const { activityId, ...createRequest } = request;
  validateId(activityId, 'automation id');
  return toShareOperationResult(async () => {
    await withShareStage('access', async () => {
      await assertSharedAutomationsSupported();
      if (resourceContextEnabled()) {
        await getAutomationsService().assertActivityResourceContext(activityId);
        const destination = await assertResourceShareDestination(createRequest);
        await assertInstalledResourceShare(
          'automations',
          activityId,
          destination,
          getSharedAutomation,
        );
      }
    });
    const detail = await createSharedAutomation(createRequest);
    await writeRemoteMetadataFromDetail(activityId, detail);
    return detail;
  });
}

export async function updateSharedAutomationForCaller(
  request: UpdateSharedAutomationIpcRequest,
): Promise<ShareOperationResult<SharedAutomationDetail>> {
  const { activityId, ...updateRequest } = request;
  validateId(activityId, 'automation id');
  validateId(updateRequest.automationId, 'shared automation id');
  return toShareOperationResult(async () => {
    await withShareStage('access', assertSharedAutomationsSupported);
    const detail = await updateSharedAutomation(updateRequest);
    await writeRemoteMetadataFromDetail(activityId, detail);
    return detail;
  });
}

export async function deleteSharedAutomationForCaller(
  request: DeleteSharedAutomationIpcRequest,
): Promise<void> {
  validateId(request.automationId, 'shared automation id');
  await assertSharedAutomationsSupported();
  await deleteSharedAutomation(request);
  await getAutomationsService().clearActivityRemoteMetadataByRemoteId(
    request.automationId,
  );
}

export async function resolveSharedPipelinePinForCaller(
  request: ResolveAutomationSharedPipelinePinRequest,
): Promise<ResolvedAutomationSharedPipelinePin> {
  return getSharedPipelineAutomationInstallPin(request.remoteId);
}

export function registerAutomationsHandlers(
  accessors: AutomationsWindowAccessors,
): void {
  const service = getAutomationsService();
  // CAN-6183: cloud schedules are stored through main's web core connection.
  service.setCloudScheduleRemote(
    createWebCoreCloudScheduleRemote(
      desktopWebCoreBindingOptions(),
      app.getVersion(),
      signedInAccountId,
    ),
  );
  service.configure({
    getMainWindow: accessors.getMainWindow,
    getAppAdvisorWindow: accessors.getAppAdvisorWindow,
    openAppAdvisorWindow: accessors.openAppAdvisorWindow,
    ensureAppAdvisorWindow: accessors.ensureAppAdvisorWindow,
    sendAppAdvisorWindowCommand: accessors.sendAppAdvisorWindowCommand,
    onChange: (stored: AutomationsListResponse) => {
      publishAutoDeleteActivity(
        'automations',
        collectScheduledAutomationTargetKeys(
          stored.activities,
          new Set(
            stored.recentRuns
              .filter((run) => run.status === 'running')
              .map((run) => run.activityId),
          ),
        ),
      );
      // Windows edit a converted automation as its chat action (CAN-4551),
      // with its workflow-page facts counted across every context (CAN-5782).
      void service.allActivities().then(
        (activities) => {
          const snapshot = projectOwnedChatAutomations(stored, activities);
          sendToWindow(
            accessors.getMainWindow(),
            IPC_CHANNELS.automationsChanged,
            snapshot,
          );
          sendToWindow(
            accessors.getAppAdvisorWindow(),
            IPC_CHANNELS.automationsChanged,
            snapshot,
          );
        },
        (error: unknown) => {
          logMainProcessError('Failed to publish the automations list', error);
        },
      );
    },
  });

  registerIpcHandler<
    [AutomationsListRequest | undefined],
    AutomationsListResponse
  >(IPC_CHANNELS.automationsList, async (_event, request) =>
    listAutomationsForCaller(request),
  );

  registerIpcHandler<
    [AutomationRunHistoryRequest],
    AutomationRunHistoryResponse
  >(IPC_CHANNELS.automationsListRuns, async (_event, request) => {
    const safeRequest = validateRunHistoryRequest(request);
    const response = await service.listRuns(safeRequest);
    return JSON.parse(JSON.stringify(response)) as AutomationRunHistoryResponse;
  });

  registerIpcHandler<[AutomationCreateRequest], AutomationMutationResponse>(
    IPC_CHANNELS.automationsCreate,
    async (_event, request) => {
      try {
        const validationError = validateCreateRequest(request);
        if (validationError) return { ok: false, error: validationError };
        // A person writing the automation clears any agent marker, and may
        // save a chat automation as a pipeline (CAN-4551).
        return await createAutomationFromForm(request);
      } catch (error) {
        const coworkFolderMissing = readCoworkFolderMissing(error);
        return {
          ok: false,
          error: errorMessage(error),
          ...(coworkFolderMissing ? { coworkFolderMissing } : {}),
        };
      }
    },
  );

  registerIpcHandler<[AutomationUpdateRequest], AutomationMutationResponse>(
    IPC_CHANNELS.automationsUpdate,
    async (_event, request) => {
      try {
        const validationError = validateUpdateRequest(request);
        if (validationError) return { ok: false, error: validationError };
        return await updateAutomationFromForm(request);
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  );

  registerIpcHandler<[AutomationDeleteRequest], AutomationMutationResponse>(
    IPC_CHANNELS.automationsDelete,
    async (_event, request) => {
      try {
        const validationError = validateIdRequest(request);
        if (validationError) return { ok: false, error: validationError };
        return await service.delete(request);
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  );

  registerIpcHandler<[AutomationRunNowRequest], AutomationMutationResponse>(
    IPC_CHANNELS.automationsRunNow,
    async (_event, request) => {
      try {
        const validationError = validateIdRequest(request);
        if (validationError) return { ok: false, error: validationError };
        return await service.runNow(request);
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  );

  registerIpcHandler<[AutomationCancelRunRequest], AutomationMutationResponse>(
    IPC_CHANNELS.automationsCancelRun,
    async (_event, request) => {
      if (!isRecord(request) || typeof request.runId !== 'string') {
        return { ok: false, error: 'Run id is required.' };
      }
      try {
        validateId(request.runId, 'automation run id');
        return await service.cancelRun({ runId: request.runId });
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  );

  registerIpcHandler<
    [AutomationCronGenerateRequest],
    AutomationCronGenerateResponse
  >(IPC_CHANNELS.automationsGenerateCron, async (_event, request) => {
    try {
      const validationError = validateGenerateCronRequest(request);
      if (validationError) return { ok: false, error: validationError };
      const preferences = await readPreferencesFile();
      const model =
        preferences.cronGenerationModel ?? DEFAULT_CRON_GENERATION_MODEL;
      const thinkingLevel = preferences.cronGenerationThinkingLevel ?? 'medium';
      const executionHarness = getExecutionHarnessForModel(model);
      if (!executionHarness) {
        return {
          ok: false,
          error: `No execution harness is available for model "${model}".`,
        };
      }
      const modelConfig = resolveProviderModelConfig(
        executionHarness,
        { thinkingLevel },
        preferences.providerModelConfigDefaults,
      );
      const result = await generateCronExpression({
        description: request.description,
        model,
        thinkingLevel,
        modelConfig,
      });
      return { ok: true, expression: result.expression };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  });

  registerIpcHandler<
    [AutomationIfCommandGenerateRequest],
    AutomationIfCommandGenerateResponse
  >(IPC_CHANNELS.automationsGenerateIfCommand, async (_event, request) => {
    try {
      const validationError = validateGenerateIfCommandRequest(request);
      if (validationError) return { ok: false, error: validationError };
      const preferences = await readPreferencesFile();
      const result = await generateAutomationIfCommand({
        description: request.description,
        currentCommand: request.currentCommand,
        model:
          preferences.ifCommandGenerationModel ??
          DEFAULT_IF_COMMAND_GENERATION_MODEL,
        thinkingLevel: preferences.ifCommandGenerationThinkingLevel ?? 'medium',
      });
      return { ok: true, command: result.command };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  });

  // Shared-Automation cloud CRUD (CAN-1581). These mirror the shared-Agent
  // handlers: they throw (rejecting the invoke) rather than returning the
  // local mutation envelope, and every one is gated on the server capability.

  registerIpcHandler<
    [ListSharedAutomationsIpcRequest],
    ListSharedAutomationsResponse
  >(IPC_CHANNELS.automationsSharedList, async (_event, request) =>
    listSharedAutomationsForCaller(request),
  );

  registerIpcHandler<[string], SharedAutomationDetail>(
    IPC_CHANNELS.automationsSharedGet,
    async (_event, automationId) => getSharedAutomationForCaller(automationId),
  );

  registerIpcHandler<
    [ListCuratedAutomationsRequest?],
    ListCuratedAutomationsResult
  >(IPC_CHANNELS.automationsCuratedList, async (_event, request = {}) => {
    await assertCanopyCloudCapability(AUTOMATION_CATALOG_CAPABILITY);
    return listCuratedAutomations(request);
  });

  registerIpcHandler<[string], CuratedAutomationDetail>(
    IPC_CHANNELS.automationsCuratedGet,
    async (_event, key) => {
      if (!isCuratedCatalogKey(key)) {
        throw new Error('Invalid curated automation key.');
      }
      await assertCanopyCloudCapability(AUTOMATION_CATALOG_CAPABILITY);
      return getCuratedAutomation(key);
    },
  );

  registerIpcHandler<
    [CreateSharedAutomationIpcRequest],
    ShareOperationResult<SharedAutomationDetail>
  >(IPC_CHANNELS.automationsSharedCreate, async (_event, request) =>
    createSharedAutomationForCaller(request),
  );

  registerIpcHandler<
    [UpdateSharedAutomationIpcRequest],
    ShareOperationResult<SharedAutomationDetail>
  >(IPC_CHANNELS.automationsSharedUpdate, async (_event, request) =>
    updateSharedAutomationForCaller(request),
  );

  registerIpcHandler<[DeleteSharedAutomationIpcRequest], void>(
    IPC_CHANNELS.automationsSharedDelete,
    async (_event, request) => deleteSharedAutomationForCaller(request),
  );
  registerIpcHandler<[string], SharedAutomationPublicShareInfo>(
    IPC_CHANNELS.automationsPublicSharePublish,
    async (_event, automationId): Promise<SharedAutomationPublicShareInfo> => {
      validateId(automationId, 'shared automation id');
      await assertSharedAutomationsSupported();
      return publishAutomationPublicShare(automationId);
    },
  );
  registerIpcHandler<[string], void>(
    IPC_CHANNELS.automationsPublicShareRevoke,
    async (_event, automationId): Promise<void> => {
      validateId(automationId, 'shared automation id');
      await assertSharedAutomationsSupported();
      await revokeAutomationPublicShare(automationId);
    },
  );
  registerIpcHandler<
    [AnalyzeAutomationCapabilityPackageRequest],
    PipelinePackageAnalysisSummary
  >(
    IPC_CHANNELS.automationsCapabilityPackageAnalyze,
    async (_event, request) => {
      if (
        request.activityId === undefined ||
        request.pipelineContent === undefined
      )
        return analyzeAutomationCapabilityPackage(request);
      validateId(request.activityId, 'activityId');
      const actionPipeline = automationActionPipeline(
        (await service.list()).activities.find(
          (activity) => activity.id === request.activityId,
        ),
      );
      return actionPipeline
        ? analyzeAutomationCapabilityPackage(request, { actionPipeline })
        : analyzeAutomationCapabilityPackage(request);
    },
  );
  registerIpcHandler<[string], void>(
    IPC_CHANNELS.automationsCapabilityPackageCancel,
    (_event, analysisId) => {
      validateId(analysisId, 'package analysis id');
      cancelPackageAnalysis(analysisId);
    },
  );
  registerIpcHandler<
    [CommitAutomationCapabilityPackageRequest],
    ShareOperationResult<CommitAutomationCapabilityPackageResponse>
  >(IPC_CHANNELS.automationsCapabilityPackageCommit, (_event, request) =>
    toShareOperationResult(async () => {
      if ('localAutomationId' in request) {
        validateId(request.localAutomationId, 'automation id');
        if (resourceContextEnabled())
          await service.assertActivityResourceContext(
            request.localAutomationId,
          );
      }
      return createPackagedAutomationCapabilityPackage(request, () =>
        accessors.getMainWindow(),
      );
    }, 'prepare'),
  );
  registerIpcHandler<
    [AutomationCapabilityPackageRequest],
    PipelinePackageReadiness
  >(
    IPC_CHANNELS.automationsCapabilityPackageReadiness,
    async (_event, request) => {
      if (request.source === 'curated') {
        await assertCanopyCloudCapability(AUTOMATION_CATALOG_CAPABILITY);
      }
      return getAutomationCapabilityPackageReadiness(request);
    },
  );
  registerIpcHandler<
    [InstallAutomationCapabilityPackageRequest],
    | InstallAutomationPipelinesResponse
    | PreviewAutomationPipelinesResponse
    | undefined
  >(
    IPC_CHANNELS.automationsCapabilityPackageInstall,
    async (_event, request) => {
      // Stage A: materialize the package's pipelines before the automation
      // exists; its preview is the update review's dry run. Stage B (below)
      // records the automation-owner install.
      if (
        request.stage === 'pipelines' ||
        request.stage === 'pipelines-preview'
      ) {
        if (request.source === 'curated') {
          await assertCanopyCloudCapability(AUTOMATION_CATALOG_CAPABILITY);
        }
        // Each installed copy keeps its own pipelines.
        const options = {
          recordedPipelineIds: pipelinesRecordedByAutomations(
            (await service.list()).activities,
          ),
        };
        return request.stage === 'pipelines'
          ? installAutomationPipelines(request, options)
          : previewAutomationPipelines(request, options);
      }
      validateId(request.localAutomationId, 'automation id');
      if (request.remove === true) {
        await removeAutomationCapabilityPackageInstall(
          request.localAutomationId,
        );
        return undefined;
      }
      if (request.source === 'curated') {
        await assertCanopyCloudCapability(AUTOMATION_CATALOG_CAPABILITY);
      }
      await installAutomationCapabilityPackage(request);
      return undefined;
    },
  );
  registerIpcHandler<
    [VerifyAutomationSharedPipelinePinRequest],
    PipelineShareInstallPin
  >(IPC_CHANNELS.automationsSharedPipelinePinVerify, async (_event, request) =>
    verifySharedPipelineAutomationInstallPin(
      request.remoteId,
      request.installPin,
    ),
  );
  registerIpcHandler<
    [ResolveAutomationSharedPipelinePinRequest],
    ResolvedAutomationSharedPipelinePin
  >(IPC_CHANNELS.automationsSharedPipelinePinResolve, async (_event, request) =>
    resolveSharedPipelinePinForCaller(request),
  );
  registerIpcHandler<
    [ApproveAutomationSharedPipelineReviewRequest],
    AutomationMutationResponse
  >(
    IPC_CHANNELS.automationsSharedPipelineReviewApprove,
    async (_event, request) => {
      if (!isRecord(request) || typeof request.id !== 'string') {
        return { ok: false, error: 'Automation id is required.' };
      }
      try {
        validateId(request.id, 'automation id');
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
      if (request.runNow !== undefined && typeof request.runNow !== 'boolean') {
        return { ok: false, error: 'runNow must be a boolean.' };
      }
      const pinError = validateAutomationAction({
        type: 'worktree_pipeline',
        workspaceId: 'review',
        pipelineId: 'review',
        pipelineSource: 'shared',
        sharedPipeline: {
          serverId: 'canopy-cloud',
          remoteId: 'review',
          installPin: request.installPin,
        },
      });
      if (pinError) return { ok: false, error: pinError };
      return service.approveSharedPipelineReview(request);
    },
  );
}
