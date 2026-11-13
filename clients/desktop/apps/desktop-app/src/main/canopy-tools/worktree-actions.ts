import { portablePipelineTriggerTypes } from '@canopy/protocol/pipelines';
import { browserHandoffs } from '../browser/browser-handoffs';
import type {
  BrowserSavePdfRequest,
  BrowserTransferStatus,
} from '@canopy/execution-engine/types/browser';
import type { BrowserPostDispatchUnknown } from '@canopy/desktop-shared/types';
import { openShareDialog } from './sharing-runtime';
import { filterProjectPipelineContexts } from '../pipelines/pipeline-install-context';
import { BrowserProfileError } from '@canopy/desktop-shared/browser-profile-error';
import {
  browserReadTargetFailure,
  decodeBrowserReadTargetError,
} from '@canopy/desktop-shared/browser/read-target-error';
import type { BrowserMaintenanceOperation } from '@canopy/protocol/browser-profiles';
import {
  browserTaskScopeTuple,
  type BrowserProfileSelection,
} from '@canopy/protocol/browser-profiles';
import { getBrowserProfileService } from '../browser/browser-profile-service';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { BRAND } from '@canopy/brand/current';
import {
  BROWSER_ACTION_ROW_LIMIT,
  truncateBrowserConsoleEntry,
  truncateBrowserNetworkEntry,
} from '@canopy/desktop-shared/browser-truncation';
import { scopeAgentActionCatalog } from '@canopy/agent-actions';
import {
  APP_ADVISOR_ACTION_CATALOG,
  searchAppAdvisorActions,
  type SearchAppAdvisorActionsInput,
  type SearchAppAdvisorActionsResult,
} from '@canopy/desktop-shared/lib/app-advisor-actions';
import {
  buildPipelineRunArtifactReceipt,
  agentArtifactsForActionResult,
  withAgentArtifacts,
} from '@canopy/desktop-shared/lib/agent-artifacts';
import { buildBrowserAutomationCommand } from '@canopy/agent-actions/families/browser/command';
import {
  FILE_CHOOSER_NOT_PENDING,
  fileChooserDialogAnswer,
  PRINT_REQUEST_NOT_PENDING,
  printRequestDialogAnswer,
  AUTH_REQUEST_NOT_PENDING,
  authRequestDialogAnswer,
} from '@canopy/desktop-shared/lib/browser-pending-surfaces';
import {
  APP_ADVISOR_PROJECT_ID,
  IPC_CHANNELS,
  STANDALONE_CHAT_PROJECT_ID,
} from '@canopy/desktop-shared/types';
import type {
  AppLinkBrowserEvent,
  AppAdvisorAction,
  AppAdvisorActionError,
  AppAdvisorActionResponse,
  AppAdvisorJson,
  AutomationCreateRequest,
  AutomationUpdateRequest,
  BrowserConsoleEntry,
  BrowserElementSnapshot,
  BrowserEvent,
  BrowserInputSnapshotResponse,
  BrowserJavaScriptDialog,
  BrowserJavaScriptDialogResponse,
  BrowserKeyModifier,
  BrowserLoadState,
  BrowserMouseButton,
  BrowserScreenshotResponse,
  BrowserSessionSnapshot,
  BrowserWaitForState,
  WorktreeData,
} from '@canopy/desktop-shared/types';
import {
  getTriggerInputDefs,
  getTriggerTypes,
  type ExecutionState,
  type ExecutionSummary,
  type PipelineData,
  type PipelineInfo,
  type PipelineExecutionInitiator,
  type PipelineInputDef,
  type PipelinePreferenceLocator,
  type PipelineTriggerType,
} from '@canopy/execution-engine/types/pipeline';
import type { PipelineExecutionScope } from '@canopy/protocol/pipelines';
import {
  DEFAULT_PIPELINE_SCOPES,
  executionContextSatisfies,
} from '@canopy/execution-engine/pipelines/scope';
import {
  listDesktopPipelines,
  PIPELINE_DEFINITION_AGENT_CALLER,
  pipelineWriteErrorMessage,
  readDesktopPipeline,
} from '../canopy-runtime/pipeline-definition-dispatch';
import type { AgentPlace } from '../canopy-runtime/agent-place';
import { resumePipelineExecutionFromMain } from '../pipelines/pipeline-resume-service';
import { CanopyCloudClientError } from '../canopy-cloud/client';
import {
  discoverProjectPipelines,
  loadProjectPipelineFromDisk,
} from '../pipelines/project-pipeline-discovery';
import {
  listExecutionSummaries,
  loadExecutionState,
  relativeToExecutionsDir,
} from '@canopy/execution-engine/node/pipelines/executor/execution-state';
import type {
  ExecutionEvent,
  ExecutionRuntime as PipelineExecutionRuntime,
  StepOutputEvent,
} from '@canopy/execution-engine/node/pipelines/executor/types';
import { resolveWorktreeCwd } from '../lib/resolve-worktree';
import { isPathInside } from '../lib/path-safety';
import {
  getExecutionPlanPath,
  readExecutionArtifact,
  resolveAllowedPath,
} from './execution-artifacts';
import { readPreferencesFile } from '../lib/preferences-store';
import { readWorkspaceWorktrees } from '../lib/workspace-persistence';
import type { BrowserWindow } from 'electron';
import { getBrowserService } from '../browser/browser-service-registry';
import {
  isFileBrowserUrl,
  isSafeExternalBrowserUrl,
  normalizeBrowserUrlInput,
} from '../browser/browser-url-policy';
import {
  importedPlanResult,
  importTrackedPlanFromPath,
} from '../lib/plan-import';
import { sendToWindow, type SendableBrowserWindow } from '../lib/window-send';
import {
  changeWorktreeHookPause,
  getWorktreePausedHookKeys,
  listHooks,
} from '../services/hooks-service';
import { PortalServiceError } from '../services/portal-service-error';
import {
  W5CommitLogError,
  W5CommitRefusedError,
} from '@canopy/desktop-shared/node/w5-commit-log/errors';
import {
  agentResourceActionFailure,
  dispatchAgentResourceAction,
  isAgentResourceAction,
  loadAgentPipelineById,
  withAgentPipelineTelemetry,
} from './resource-actions';
import type { WorktreeScriptAction } from './worktree-script-actions';
import type { ScopedSidebarItemGroupAction } from './sidebar-item-group-actions';
import { chatDriver } from '../remote-control/host/chat-drivers';

/**
 * Actions that require a real git worktree context: tracked plans live in
 * worktree-scoped plan storage and hooks pause/resume writes a worktree row.
 * Directory-scoped runtimes (Cowork workspaces) never see these — they are
 * filtered from the search catalog and rejected on dispatch.
 */
const WORKTREE_ONLY_ACTION_TYPES = new Set([
  'worktree.get_settings',
  'worktree.list_scripts',
  'worktree.run_script',
  'tracked-plan.import',
  'hook.pause',
  'hook.resume',
]);

const EXPECTED_SHARED_PIPELINE_UNAVAILABLE_CODES = new Set([
  'cloud-not-configured',
  'missing-api-key',
  'unsupported-capability',
]);

/**
 * The frozen legacy desktop action family: every chat-surface action type
 * the desktop dispatches. It may shrink as families migrate, never grow.
 * The pipeline execution actions moved to the shared pipeline-executions
 * family (CAN-6339); their handlers here serve its desktop port.
 */
export const DESKTOP_LEGACY_ACTION_TYPES = [
  'sidebar.item_groups.list',
  'sidebar.item_groups.list_items',
  'sidebar.item_groups.set_item',
  'sidebar.item_groups.update',
  'sharing.open_dialog',
  'skills.list',
  'skills.read',
  'skills.read_file',
  'skills.create_custom',
  'skills.update_custom',
  'skills.delete_custom',
  'skills.list_shared',
  'skills.read_shared',
  'skills.share_custom',
  'skills.import_shared',
  'skills.update_shared',
  'skills.delete_shared',
  'pipeline.list',
  'pipeline.get',
  'pipeline.create',
  'pipeline.update',
  'pipeline.delete',
  'pipeline.duplicate',
  'pipeline.share',
  'pipeline.update_shared',
  'pipeline.delete_shared',
  'pipeline.set_enabled',
  'worktree.get_settings',
  'worktree.list_scripts',
  'worktree.run_script',
  'tracked-plan.import',
  'hook.pause',
  'hook.resume',
  'automation.list',
  'automation.get',
  'automation.create',
  'automation.update',
  'automation.disable',
  'automation.delete',
  'automation.run_now',
] as const;

const DESKTOP_LEGACY_ACTION_TYPE_SET: ReadonlySet<string> = new Set(
  DESKTOP_LEGACY_ACTION_TYPES,
);

const PIPELINE_LIST_DEFAULT_LIMIT = 20;
const PIPELINE_LIST_MAX_LIMIT = 100;
const PIPELINE_EXECUTION_LIST_DEFAULT_LIMIT = 20;
const PIPELINE_EXECUTION_LIST_MAX_LIMIT = 100;
const PIPELINE_CONTENT_DEFAULT_MAX_CHARS = 20_000;
const PIPELINE_CONTENT_MAX_CHARS = 200_000;

type ScopedAction =
  | ScopedSidebarItemGroupAction
  | Extract<AppAdvisorAction, { type: 'sharing.open_dialog' }>
  | {
      type: 'skills.list';
      query?: string;
      customOnly?: boolean;
      limit?: number;
    }
  | { type: 'skills.read'; sourceId: string; skillName: string }
  | {
      type: 'skills.read_file';
      sourceId: string;
      skillName: string;
      filePath: string;
    }
  | {
      type: 'skills.create_custom';
      name: string;
      description: string;
      body: string;
      extraMetadata?: Record<string, string>;
    }
  | {
      type: 'skills.update_custom';
      originalName: string;
      name?: string;
      description?: string;
      body?: string;
      extraMetadata?: Record<string, string>;
    }
  | { type: 'skills.delete_custom'; name: string }
  | {
      type: 'skills.list_shared';
      query?: string;
      limit?: number;
      cursor?: string;
      createdBy?: 'me' | 'anyone';
    }
  | { type: 'skills.read_shared'; skillId: string }
  | {
      type: 'skills.share_custom';
      name: string;
      shareScope: 'team' | 'organization';
      teamId?: string;
      organizationId?: string;
    }
  | { type: 'skills.import_shared'; skillId: string }
  | { type: 'skills.update_shared'; skillId: string; name: string }
  | { type: 'skills.delete_shared'; skillId: string }
  | {
      type: 'pipeline.list';
      query?: string;
      runModes?: PipelineTriggerType[];
      includeDisabled?: boolean;
      limit?: number;
    }
  | { type: 'pipeline.get'; pipelineId: string; includeYaml?: boolean }
  | {
      type: 'pipeline.create';
      rawYaml?: string;
      yamlFilePath?: string;
      name?: string;
      description?: string;
      icon?: string;
    }
  | {
      type: 'pipeline.update';
      pipelineId: string;
      rawYaml?: string;
      yamlFilePath?: string;
      name?: string;
      description?: string;
      icon?: string;
    }
  | { type: 'pipeline.delete'; pipelineId: string }
  | { type: 'pipeline.duplicate'; pipelineId: string }
  | {
      type: 'pipeline.share';
      pipelineId: string;
      shareScope: 'team' | 'organization';
      teamId?: string;
      organizationId?: string;
      deleteLocal?: boolean;
    }
  | {
      type: 'pipeline.update_shared';
      pipelineId?: string;
      remoteId?: string;
      rawYaml?: string;
      name?: string;
      description?: string;
      icon?: string;
    }
  | {
      type: 'pipeline.delete_shared';
      pipelineId?: string;
      remoteId?: string;
    }
  | { type: 'pipeline.set_enabled'; pipelineId: string; enabled: boolean }
  | {
      type: 'pipeline.execution_list_for_worktree' | 'pipeline.execution_list';
      query?: string;
      pipelineId?: string;
      status?: ExecutionState['status'];
      limit?: number;
    }
  | {
      type: 'pipeline.execution_get';
      executionId: string;
      includeReport?: boolean;
      includePlan?: boolean;
      maxChars?: number;
    }
  | { type: 'pipeline.execution_cancel'; executionId: string }
  | {
      type: 'pipeline.execution_resume';
      executionId: string;
      statusReasonIds?: string[];
      pauseResponses?: Array<{
        checkpointId: string;
        jobId: string;
        stepId: string;
        answers?: Record<string, string | number | boolean>;
      }>;
    }
  | {
      type: 'pipeline.execution_retry_matrix_job';
      executionId: string;
      jobId: string;
      mode: 'all' | 'failed' | 'variants' | 'expansion';
      variantJobIds?: string[];
    }
  | {
      type: 'pipeline.execution_cancel_matrix_variant';
      executionId: string;
      jobId: string;
      variantJobId: string;
    }
  | { type: 'pipeline.execution_retry'; executionId: string }
  | {
      type: 'pipeline.execution_chain';
      executionId: string;
      pipelineId: string;
      inputs?: Record<string, string>;
      repoId?: string;
    }
  | { type: 'worktree.get_settings' }
  | WorktreeScriptAction
  | { type: 'tracked-plan.import'; filePath: string; repoId: string }
  | { type: 'hook.pause'; hookKey?: string; all?: boolean }
  | { type: 'hook.resume'; hookKey?: string; all?: boolean }
  | {
      type: 'browser.profile.preview_clear';
      profileId: string;
      storageGeneration: number;
      metadataRevision: number;
      operation: BrowserMaintenanceOperation;
    }
  | { type: 'browser.profile.clear'; operationId: string; token: string }
  | { type: 'browser.profile.job_get'; jobId: string }
  | { type: 'browser.profile.job_cancel'; jobId: string }
  | { type: 'browser.profile.list'; offset?: number }
  | { type: 'browser.profile.get'; profileId: string }
  | {
      type: 'browser.profile.switch';
      operationId: string;
      browserId: string;
      expectedRuntimeGeneration: number;
      selection: BrowserProfileSelection;
      mode: 'replace' | 'new-tab';
    }
  | { type: 'browser.list' }
  | {
      type: 'browser.open';
      handoff?: boolean;
      url?: string;
      browserId?: string;
      expectedRuntimeGeneration?: number;
      selection?: BrowserProfileSelection;
    }
  | {
      type: 'browser.navigate';
      browserId?: string;
      expectedRuntimeGeneration?: number;
      url: string;
    }
  | { type: 'browser.back'; browserId?: string }
  | { type: 'browser.forward'; browserId?: string }
  | { type: 'browser.reload'; browserId?: string }
  | { type: 'browser.stop'; browserId?: string }
  | { type: 'browser.get_dialog'; browserId?: string }
  | {
      type: 'browser.handle_dialog';
      browserId?: string;
      expectedRuntimeGeneration?: number;
      dialogId: string;
      accept: boolean;
      promptText?: string;
    }
  | {
      type: 'browser.click';
      browserId?: string;
      expectedRuntimeGeneration?: number;
      ref?: string;
      locator?: string;
      frame?: string;
      x?: number;
      y?: number;
      button?: BrowserMouseButton;
      clickCount?: number;
      modifiers?: BrowserKeyModifier[];
      position?: { x: number; y: number };
      force?: boolean;
      dialogResponse?: BrowserJavaScriptDialogResponse;
      actionId?: string;
      timeoutMs?: number;
    }
  | {
      type: 'browser.fill';
      browserId?: string;
      expectedRuntimeGeneration?: number;
      ref?: string;
      locator?: string;
      frame?: string;
      text: string;
      actionId?: string;
      timeoutMs?: number;
    }
  | {
      type: 'browser.press';
      browserId?: string;
      expectedRuntimeGeneration?: number;
      key: string;
      ref?: string;
      locator?: string;
      frame?: string;
      dialogResponse?: BrowserJavaScriptDialogResponse;
      actionId?: string;
      timeoutMs?: number;
    }
  | Extract<
      AppAdvisorAction,
      {
        type:
          | 'browser.hover'
          | 'browser.scroll'
          | 'browser.drag'
          | 'browser.set_checked'
          | 'browser.select_option'
          | 'browser.type'
          | 'browser.upload_files'
          | 'browser.request_files'
          | 'browser.drop_files';
      }
    >
  | {
      type: 'browser.focus';
      browserId?: string;
      expectedRuntimeGeneration?: number;
      ref?: string;
      locator?: string;
      frame?: string;
      actionId?: string;
      timeoutMs?: number;
    }
  | {
      type: 'browser.wait_for';
      browserId?: string;
      expectedRuntimeGeneration?: number;
      locator?: string;
      frame?: string;
      text?: string;
      state?: BrowserWaitForState;
      url?: string;
      loadState?: BrowserLoadState;
      download?: { downloadId?: string };
      actionId?: string;
      timeoutMs?: number;
    }
  | {
      type: 'browser.screenshot';
      browserId?: string;
      expectedRuntimeGeneration?: number;
      saveToAttachments?: boolean;
    }
  | {
      type: 'browser.input_snapshot';
      browserId?: string;
      expectedRuntimeGeneration?: number;
      frame?: string;
      inputType?: string;
      role?: string;
      name?: string;
      offset?: number;
      limit?: number;
    }
  | {
      type: 'browser.inspect';
      browserId?: string;
      expectedRuntimeGeneration?: number;
      ref?: string;
      locator?: string;
      frame?: string;
      x?: number;
      y?: number;
    }
  | {
      type: 'browser.get_console';
      browserId?: string;
      expectedRuntimeGeneration?: number;
      level?: BrowserConsoleEntry['level'];
      limit?: number;
    }
  | {
      type: 'browser.get_network';
      browserId?: string;
      expectedRuntimeGeneration?: number;
      failed?: boolean;
      status?: number;
      urlContains?: string;
      limit?: number;
    }
  | {
      type: 'browser.list_transfers';
      browserId?: string;
      expectedRuntimeGeneration?: number;
      kind?: 'download' | 'copy' | 'upload';
      status?: BrowserTransferStatus;
      offset?: number;
      limit?: number;
    }
  | {
      type: 'browser.cancel_transfer';
      browserId?: string;
      expectedRuntimeGeneration?: number;
      transferId: string;
    }
  | {
      type: 'browser.save_download';
      browserId?: string;
      expectedRuntimeGeneration?: number;
      downloadId: string;
      path: string;
      overwrite?: boolean;
      actionId?: string;
      timeoutMs?: number;
    }
  | ({
      type: 'browser.save_pdf';
      browserId?: string;
      expectedRuntimeGeneration?: number;
    } & Omit<BrowserSavePdfRequest, 'browserId' | 'expectedRuntimeGeneration'>)
  | { type: 'browser.start_recording'; browserId?: string }
  | {
      type: 'browser.stop_recording';
      browserId?: string;
      expectedRuntimeGeneration?: number;
      saveToAttachments?: boolean;
    }
  | {
      type: 'browser.open_external';
      browserId?: string;
      expectedRuntimeGeneration?: number;
      url?: string;
    }
  | { type: 'automation.list'; includeRuns?: boolean }
  | { type: 'automation.get'; id: string }
  | {
      type: 'automation.create';
      input: AutomationCreateRequest;
      watchers?: AutomationInlineWatcher[];
    }
  | {
      type: 'automation.update';
      id: string;
      patch: Omit<AutomationUpdateRequest, 'id'>;
    }
  | { type: 'automation.disable'; id: string }
  | { type: 'automation.delete'; id: string }
  | {
      type: 'automation.run_now';
      id: string;
      watchers?: AutomationInlineWatcher[];
    };

/**
 * Inline `automation_run` watcher metadata for automation.create /
 * automation.run_now. The watched automation id comes from the action, so
 * entries never carry target or destination ids.
 */
export interface AutomationInlineWatcher {
  label?: string;
  followUpInstruction?: string;
  allowDuplicate?: boolean;
}

/**
 * The agent chat that started a run. A chat opened from the Portal is still
 * the agent; `pipelineInitiationSource` is usage attribution only.
 */
export function initiatorForWorktreeRuntime(
  runtime: Pick<WorktreeActionRuntime, 'projectId' | 'worktreeId' | 'chatId'>,
): PipelineExecutionInitiator {
  const chat = {
    projectId: runtime.projectId,
    worktreeId: runtime.worktreeId,
    chatId: runtime.chatId,
  };
  return runtime.projectId === APP_ADVISOR_PROJECT_ID
    ? { kind: 'app_advisor', chat }
    : { kind: 'agent', chat };
}

export interface WorktreeActionRuntime {
  presentationOrigin?: {
    projectId: string;
    worktreeId: string;
    chatTabId: string;
  };
  projectId: string;
  worktreeId: string;
  chatId: string;
  /**
   * The chat that made the call, when its identity is not this runtime's
   * scope: App Advisor acts on another task's browser from its own chat.
   * Approvals an action raises go to this chat.
   */
  approvalChat?: { projectId: string; worktreeId: string; chatId: string };
  cwd: string;
  repoId?: string;
  /**
   * How pipeline runs from this runtime execute. `'worktree'` (default) is
   * the git-worktree chat context; `'directory'` is the Cowork context —
   * runs dispatch directory-scoped at `cwd`, pipeline listings filter to
   * directory-satisfiable pipelines, and worktree-only actions are hidden.
   */
  executionScope?: 'worktree' | 'directory';
  /**
   * Restricts this runtime to the listed action types. When present,
   * SearchActions returns only these types and DispatchAction rejects every
   * other type before any handler runs. Omit it for the full surface.
   */
  allowedActionTypes?: readonly string[];
  pipelineInitiationSource?: 'automation' | 'portal';
  /** Who a tracked plan import is attributed to; App Advisor passes its own. */
  planInitiationSource?: 'app_advisor';
  portalCommandId?: string;
  getWindow: () => BrowserWindow | null;
  browserTargetId?: string;
  getSendableWindow?: () => SendableBrowserWindow | null;
  signal?: AbortSignal;
  onPipelineEvent?: (event: ExecutionEvent) => void;
  onPipelineStepOutput?: (event: StepOutputEvent) => void;
  /** See `WorktreeScriptActionRuntime.authorizeScriptCommand`. */
  authorizeScriptCommand?: (command: string) => Promise<boolean>;
}

export function runtimeExecutionScope(
  runtime: WorktreeActionRuntime,
): 'worktree' | 'directory' {
  return runtime.executionScope ?? 'worktree';
}

export interface DispatchWorktreeActionInput {
  action: ScopedAction;
}

function jsonSafe(value: unknown): AppAdvisorJson {
  return value as AppAdvisorJson;
}

function clampLimit(
  value: number | undefined,
  defaultValue: number,
  maxValue: number,
): number {
  if (!Number.isFinite(value ?? NaN)) return defaultValue;
  return Math.max(1, Math.min(maxValue, Math.floor(value as number)));
}

function fuzzyMatch(query: string | undefined, values: string[]): boolean {
  const tokens = (query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const haystack = values.join(' ').toLowerCase();
  return tokens.every((token) => haystack.includes(token));
}

function error(
  code: AppAdvisorActionError['code'],
  message: string,
  details?: AppAdvisorActionError['details'],
): AppAdvisorActionResponse {
  return {
    requestId: '',
    ok: false,
    error: { code, message, ...(details ? { details } : {}) },
  };
}

function ok(result?: AppAdvisorJson): AppAdvisorActionResponse {
  return { requestId: '', ok: true, ...(result ? { result } : {}) };
}

function isJsonObject(value: unknown): value is { [key: string]: unknown } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAppAdvisorJson(value: unknown): value is AppAdvisorJson {
  if (value === null) {
    return true;
  }
  const valueType = typeof value;
  if (
    valueType === 'string' ||
    valueType === 'number' ||
    valueType === 'boolean'
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isAppAdvisorJson);
  }
  if (!isJsonObject(value)) {
    return false;
  }
  return Object.values(value).every(isAppAdvisorJson);
}

function toAppAdvisorJson(value: unknown): AppAdvisorJson {
  const cloned: unknown = JSON.parse(JSON.stringify(value));
  return isAppAdvisorJson(cloned) ? cloned : null;
}

async function createWorktreeExecutionRuntime(): Promise<PipelineExecutionRuntime> {
  const { createElectronExecutionRuntime } =
    await import('../pipelines/execution-runtime');
  return createElectronExecutionRuntime();
}

interface PipelineRunModeRow {
  mode: PipelineTriggerType;
  inputCount: number | null;
}

// `workflow` starts only from the Workflows page, never an agent run, so it
// is never listed as a run mode (CAN-5782).
function pipelineRunModes(pipeline: PipelineData): PipelineRunModeRow[] {
  return portablePipelineTriggerTypes(getTriggerTypes(pipeline.content.on)).map(
    (mode) => ({
      mode,
      inputCount: Object.keys(
        getTriggerInputDefs(pipeline.content.on, mode) ?? {},
      ).length,
    }),
  );
}

function pipelineInputDetails(
  inputDefs: Record<string, PipelineInputDef> | undefined,
): AppAdvisorJson {
  return Object.entries(inputDefs ?? {}).map(([name, input]) => ({
    name,
    type: input.type ?? 'string',
    required: input.required === true,
    description: input.description ?? '',
    default: input.default ?? null,
    options: input.options ?? null,
    min: input.min ?? null,
    max: input.max ?? null,
  }));
}

interface PipelineListRow {
  id: string;
  name: string;
  description: string;
  source: string;
  readonly: boolean;
  scopes: PipelineExecutionScope[];
  filename: string;
  filePath: string;
  runModes: PipelineRunModeRow[];
}

function pipelineListRow(pipeline: PipelineData): PipelineListRow {
  return {
    id: pipeline.info.id,
    name: pipeline.info.name,
    description: pipeline.info.description,
    source: pipeline.info.source,
    readonly: pipeline.info.readonly,
    scopes: pipeline.info.scopes ?? ['directory'],
    filename: pipeline.info.filename,
    filePath: pipeline.info.filePath ?? '',
    runModes: pipelineRunModes(pipeline),
  };
}

async function loadPipelineForAction(
  pipelineId: string,
  runtime: WorktreeActionRuntime,
  cwd = runtime.cwd,
): Promise<
  { pipeline: PipelineData | null } | { response: AppAdvisorActionResponse }
> {
  try {
    return {
      pipeline: await loadAgentPipelineById(pipelineId, runtime, cwd),
    };
  } catch (cause) {
    return { response: agentResourceActionFailure(cause) };
  }
}

/** Why an optional source listed nothing, unless it is just not signed in. */
function sourceWarning(
  source: 'curated' | 'shared',
  cause: unknown,
): string | undefined {
  if (
    cause instanceof CanopyCloudClientError &&
    EXPECTED_SHARED_PIPELINE_UNAVAILABLE_CODES.has(cause.code)
  )
    return undefined;
  return cause instanceof Error
    ? cause.message
    : `Unavailable workflow source: ${source}`;
}

function agentPlace(runtime: WorktreeActionRuntime): AgentPlace {
  return { workspaceId: runtime.projectId, worktreeId: runtime.worktreeId };
}

async function loadPipelineRows(
  runtime: WorktreeActionRuntime,
  sharedQuery?: string,
): Promise<{
  rows: PipelineListRow[];
  warnings: string[];
}> {
  const warnings: string[] = [];
  // Core lists the stored, catalog and shared definitions; project files are
  // found from this runtime's directory, as core reads project definitions
  // by worktree scope. The query also narrows the shared read.
  let listed: PipelineInfo[] = [];
  try {
    // Core hides workflows Orchestrator automations own from this
    // runtime's place (CAN-4551, CAN-6032).
    const listing = await listDesktopPipelines(
      {
        sources: ['bundled', 'user', 'curated', 'shared'],
        ...(sharedQuery?.trim() ? { query: sharedQuery } : {}),
      },
      PIPELINE_DEFINITION_AGENT_CALLER,
      agentPlace(runtime),
    );
    listed = listing.rows;
    for (const source of listing.unavailableSources) {
      if (source !== 'curated' && source !== 'shared') continue;
      const warning = sourceWarning(source, listing.sourceFailures[source]);
      if (warning !== undefined) warnings.push(warning);
    }
  } catch (cause) {
    warnings.push(
      pipelineWriteErrorMessage(cause) || 'The workflows could not be listed.',
    );
  }
  const projectInfos = await filterProjectPipelineContexts(
    await discoverProjectPipelines(runtime.cwd).catch(() => []),
    runtime.cwd,
    runtime.projectId,
  );
  const catalogRow = (info: PipelineInfo): PipelineListRow => ({
    id: info.id,
    name: info.name,
    description: info.description,
    source: info.source,
    readonly: info.readonly,
    scopes: info.scopes ?? [...DEFAULT_PIPELINE_SCOPES],
    filename: info.filename,
    filePath: '',
    // Catalog and share listings carry no trigger definitions; call
    // pipeline.get to resolve input details for a selected pipeline.
    runModes: portablePipelineTriggerTypes(info.triggerTypes ?? []).map(
      (mode) => ({ mode, inputCount: null }),
    ),
  });
  const hydrated = await Promise.all([
    ...listed
      .filter((info) => info.source === 'bundled' || info.source === 'user')
      .map((info) =>
        readDesktopPipeline(
          info.id,
          {},
          PIPELINE_DEFINITION_AGENT_CALLER,
          agentPlace(runtime),
        ).catch((): null => null),
      ),
    ...projectInfos.map(async (info) =>
      info.filePath
        ? {
            info,
            content: await loadProjectPipelineFromDisk(info.filePath),
          }
        : null,
    ),
  ]);
  return {
    rows: [
      ...hydrated.flatMap((pipeline) =>
        pipeline ? [pipelineListRow(pipeline)] : [],
      ),
      ...listed.filter((info) => info.source === 'shared').map(catalogRow),
      ...listed.filter((info) => info.source === 'curated').map(catalogRow),
    ],
    warnings,
  };
}

export function pipelineSourceExecutionOptions(pipeline: PipelineData): {
  sharedPipeline?: { serverId: string; remoteId: string };
  pipelinePreferenceLocator?: PipelinePreferenceLocator;
} {
  if (pipeline.info.source === 'curated') {
    return {
      pipelinePreferenceLocator: {
        type: 'stored',
        source: 'curated',
        value: pipeline.info.id,
        ...(pipeline.info.curatedContentHash
          ? { contentHash: pipeline.info.curatedContentHash }
          : {}),
      },
    };
  }
  // Match the UI's derived locator so saved preferences apply and background
  // authorization (watchers, replay) can resolve the stored definition's owner.
  if (pipeline.info.source === 'bundled' || pipeline.info.source === 'user') {
    return {
      pipelinePreferenceLocator: {
        type: 'stored',
        source: pipeline.info.source,
        value: pipeline.info.id,
      },
    };
  }
  if (
    pipeline.info.source !== 'shared' ||
    !pipeline.info.serverId ||
    !pipeline.info.remoteId
  ) {
    return {};
  }
  return {
    sharedPipeline: {
      serverId: pipeline.info.serverId,
      remoteId: pipeline.info.remoteId,
    },
  };
}

function scopeActionCatalog(
  result: SearchAppAdvisorActionsResult,
  limit: number | undefined,
  executionScope: 'worktree' | 'directory',
): SearchAppAdvisorActionsResult {
  const actions = result.actions
    .filter((action) => DESKTOP_LEGACY_ACTION_TYPE_SET.has(action.type))
    .filter(
      (action) =>
        executionScope !== 'directory' ||
        !WORKTREE_ONLY_ACTION_TYPES.has(action.type),
    )
    .map((action) =>
      action.type === 'worktree.get_settings'
        ? {
            ...action,
            summary:
              'Inspect the intended base branch, configured hooks, pausedHookKeys, and per-hook paused status for a Code entry (worktree).',
            notes: [
              'This scoped action returns projectId, worktreeId, trackedBaseBranch and trackedRepoBaseBranches for the intended comparison base, pausedHookKeys, and hooks; it does not return Orchestrator UI effective overrides.',
            ],
          }
        : action,
    );
  return scopeAgentActionCatalog(
    { ...result, actions },
    {
      hiddenFields: ['projectId', 'worktreeId'],
      scopeSummary:
        executionScope === 'directory'
          ? `Current cowork project scope is applied by ${BRAND.displayName}.`
          : `Current worktree scope is applied by ${BRAND.displayName}.`,
      scopeNote:
        executionScope === 'directory'
          ? 'Do not provide projectId or worktreeId; this cowork project chat supplies its project scope server-side.'
          : 'Do not provide projectId or worktreeId; this worktree chat supplies them server-side.',
      limit,
      categories: [
        'sidebar',
        'skills',
        'sharing',
        'pipeline',
        'worktree',
        'tracked-plan',
        'hook',
        'browser',
        'automations',
      ],
      refineAction: (action) =>
        action.type.startsWith('sidebar.item_groups.')
          ? {
              hiddenFields: ['scope', 'itemId'],
              trailingNotes: [
                'Do not supply scope or itemId. The current project and sidebar item are supplied by this chat; groupId:null ungroups only the current item.',
              ],
            }
          : undefined,
    },
  );
}

/** Action types a runtime with this scope and restriction may use. */
function availableWorktreeActionTypes(
  executionScope: 'worktree' | 'directory',
  allowedActionTypes: readonly string[] | undefined,
): Set<string> {
  return new Set(
    DESKTOP_LEGACY_ACTION_TYPES.filter(
      (type) =>
        (executionScope !== 'directory' ||
          !WORKTREE_ONLY_ACTION_TYPES.has(type)) &&
        (allowedActionTypes === undefined || allowedActionTypes.includes(type)),
    ),
  );
}

function availableWorktreeActionCategories(
  executionScope: 'worktree' | 'directory',
  availableTypes: ReadonlySet<string>,
  restricted: boolean,
): string[] {
  const categories =
    executionScope === 'directory'
      ? ['sidebar', 'skills', 'sharing', 'pipeline', 'browser', 'automations']
      : [
          'sidebar',
          'skills',
          'sharing',
          'pipeline',
          'worktree',
          'tracked-plan',
          'hook',
          'browser',
          'automations',
        ];
  if (!restricted) return categories;
  const availableCategories = new Set(
    APP_ADVISOR_ACTION_CATALOG.filter((entry) =>
      availableTypes.has(entry.type),
    ).map((entry) => entry.category),
  );
  return categories.filter((category) => availableCategories.has(category));
}

export function searchWorktreeActions(
  input: SearchAppAdvisorActionsInput = {},
  options: {
    executionScope?: 'worktree' | 'directory';
    allowedActionTypes?: readonly string[];
  } = {},
): SearchAppAdvisorActionsResult {
  const executionScope = options.executionScope ?? 'worktree';
  const availableTypes = availableWorktreeActionTypes(
    executionScope,
    options.allowedActionTypes,
  );
  const categories = availableWorktreeActionCategories(
    executionScope,
    availableTypes,
    options.allowedActionTypes !== undefined,
  );
  const actionType = input.actionType?.trim();
  if (actionType && !availableTypes.has(actionType)) {
    return {
      query: input.query ?? '',
      ...(input.category ? { category: input.category } : {}),
      actionType,
      totalMatches: 0,
      returned: 0,
      categories,
      actions: [],
    };
  }

  const catalog = scopeActionCatalog(
    searchAppAdvisorActions({
      ...input,
      ...(input.category ? { category: input.category } : {}),
      limit: 50,
      // Filter before ranking so App Advisor-only matches cannot crowd the
      // surface's own actions out of the result window.
      allowedActionTypes: Array.from(availableTypes),
    }),
    input.limit,
    executionScope,
  );
  return { ...catalog, categories };
}

/**
 * Reject an action type a restricted runtime does not expose. Returns null
 * when the action may run. Callers check this before any handler side effect.
 */
function rejectUnavailableWorktreeAction(
  actionType: string,
  runtime: Pick<WorktreeActionRuntime, 'allowedActionTypes'>,
): AppAdvisorActionResponse | null {
  const allowed = runtime.allowedActionTypes;
  if (allowed === undefined || allowed.includes(actionType)) return null;
  return error(
    'unsupported_action',
    allowed.length > 0
      ? `${actionType} is not available here. Available actions: ${allowed.join(', ')}.`
      : `${actionType} is not available here.`,
  );
}

/**
 * Whether a run with no project was started by exactly this chat. Only the
 * initiating agent chat may reach it; a matching owner grants nothing.
 */
function globalExecutionStartedByRuntime(
  execution: Pick<ExecutionState, 'project_id' | 'initiator'>,
  runtime: Pick<WorktreeActionRuntime, 'projectId' | 'worktreeId' | 'chatId'>,
): boolean {
  if (execution.project_id !== undefined) return false;
  const initiator = execution.initiator;
  if (initiator?.kind !== 'agent' && initiator?.kind !== 'app_advisor')
    return false;
  const chat = initiator.chat;
  return (
    chat !== undefined &&
    chat.projectId === runtime.projectId &&
    chat.worktreeId === runtime.worktreeId &&
    chat.chatId === runtime.chatId
  );
}

function executionBelongsToRuntime(
  execution: Pick<ExecutionState, 'project_id' | 'worktree_id' | 'initiator'>,
  runtime: WorktreeActionRuntime,
): boolean {
  if (globalExecutionStartedByRuntime(execution, runtime)) return true;
  if (
    runtimeExecutionScope(runtime) === 'directory' &&
    runtime.projectId !== STANDALONE_CHAT_PROJECT_ID
  ) {
    return execution.project_id === runtime.projectId;
  }
  return (
    execution.project_id === runtime.projectId &&
    execution.worktree_id === runtime.worktreeId
  );
}

async function executionPathBelongsToRuntime(
  resolvedPath: string,
  executionsDir: string,
  runtime: WorktreeActionRuntime,
): Promise<boolean> {
  const relative = relativeToExecutionsDir(executionsDir, resolvedPath);
  if (relative === null) return false;
  const [executionId] = relative.split(path.sep);
  if (!executionId || executionId === '..' || executionId.includes(path.sep)) {
    return false;
  }
  const state = await loadExecutionState(executionId, executionsDir);
  return state !== null && executionBelongsToRuntime(state, runtime);
}

export async function resolveScopedEventPath(
  filePath: string | undefined,
  cwd: string,
  executionsDir: string,
  runtime: WorktreeActionRuntime,
): Promise<string | null> {
  if (!filePath?.trim()) return null;
  const resolvedPath = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(cwd, filePath);
  if (isPathInside(cwd, resolvedPath)) return resolvedPath;
  if (
    await executionPathBelongsToRuntime(resolvedPath, executionsDir, runtime)
  ) {
    return resolvedPath;
  }
  return null;
}

async function loadScopedExecution(
  executionId: string,
  runtime: WorktreeActionRuntime,
): Promise<{ state: ExecutionState } | { response: AppAdvisorActionResponse }> {
  const executionRuntime = await createWorktreeExecutionRuntime();
  const state = await loadExecutionState(
    executionId,
    executionRuntime.executionsDir,
  );
  if (!state) {
    return {
      response: error('not_found', `Execution ${executionId} not found.`),
    };
  }
  if (!executionBelongsToRuntime(state, runtime)) {
    const scopeLabel =
      runtimeExecutionScope(runtime) === 'directory'
        ? 'cowork project'
        : 'worktree';
    return {
      response: error(
        'invalid_target',
        `That pipeline execution does not belong to this ${scopeLabel}.`,
      ),
    };
  }
  return { state };
}

function executionRow(
  summary: ExecutionSummary,
  state?: ExecutionState | null,
): AppAdvisorJson {
  const inputRequestCount =
    state?.pending_pauses?.filter((checkpoint) => checkpoint.request).length ??
    0;
  return {
    id: summary.id,
    pipelineId: summary.pipeline_id,
    name: summary.pipeline_name,
    description: state?.pipeline_snapshot.description ?? '',
    status: summary.status,
    startedAt: summary.started_at,
    completedAt: summary.completed_at ?? null,
    projectId: summary.project_id ?? null,
    worktreeId: summary.worktree_id ?? null,
    eventName: summary.event_name ?? null,
    hasReport: summary.has_report === true,
    hasPlan: summary.has_plan === true,
    planModified: summary.plan_modified === true,
    inputRequested: inputRequestCount > 0,
    inputRequestCount,
  };
}

function executionDetails(state: ExecutionState): AppAdvisorJson {
  const pendingPauses = (state.pending_pauses ?? []).map((checkpoint) => ({
    checkpointId: checkpoint.id,
    kind: checkpoint.kind,
    jobId: checkpoint.job_id,
    logicalJobId: checkpoint.logical_job_id,
    stepId: checkpoint.step_id,
    request: checkpoint.request ? jsonSafe(checkpoint.request) : null,
  }));
  const inputRequests = pendingPauses.filter(
    (checkpoint) => checkpoint.request !== null,
  );
  return {
    id: state.id,
    pipelineId: state.pipeline_id,
    name: state.pipeline_snapshot.name,
    description: state.pipeline_snapshot.description ?? '',
    status: state.status,
    startedAt: state.started_at,
    completedAt: state.completed_at ?? null,
    cwd: state.cwd,
    projectId: state.project_id ?? null,
    worktreeId: state.worktree_id ?? null,
    eventName: state.event_name ?? null,
    inputs: jsonSafe(state.inputs),
    planId: state.planId ?? null,
    planPath: getExecutionPlanPath(state),
    planModified: state.plan_hash_before !== state.plan_hash_after,
    reportOutputs: jsonSafe(state.report_outputs ?? null),
    error: state.error ?? null,
    inputRequested: inputRequests.length > 0,
    inputRequests,
    pendingPauses,
    resumableStatusReasons: (state.status_reasons ?? [])
      .filter((reason) => reason.kind !== 'input_required')
      .map((reason) => ({
        id: reason.id,
        kind: reason.kind,
        code: reason.code,
        provider: reason.provider ?? null,
        resetsAt: reason.resets_at ?? null,
        jobId: reason.source.job_id,
        stepId: reason.source.step_id,
      })),
    jobs: Object.entries(state.jobs).map(([jobId, job]) => ({
      id: jobId,
      name: state.pipeline_snapshot.jobs[jobId]?.name ?? jobId,
      status: job.status,
      conclusion: job.conclusion ?? null,
      outcome: job.outcome ?? null,
      startedAt: job.started_at ?? null,
      completedAt: job.completed_at ?? null,
      retryCount: job.retry_count ?? 0,
      stepCount: Object.keys(job.steps).length,
      steps: Object.entries(job.steps).map(([stepId, step]) => ({
        id: stepId,
        status: step.status,
        conclusion: step.conclusion ?? null,
        outcome: step.outcome ?? null,
        startedAt: step.started_at ?? null,
        completedAt: step.completed_at ?? null,
        exitCode: step.exit_code ?? null,
        error: step.error ?? null,
        logFile: step.log_file ?? null,
      })),
    })),
  };
}

export function pipelineExecutionArtifact(
  operation: string,
  state: ExecutionState,
  runtime: WorktreeActionRuntime,
  repoId?: string,
): ReturnType<typeof buildPipelineRunArtifactReceipt> {
  const initialStatus =
    state.status === 'paused' || state.status === 'running'
      ? state.status
      : 'pending';
  return buildPipelineRunArtifactReceipt({
    operation,
    executionId: state.id,
    pipelineId: state.pipeline_id,
    pipelineName: state.pipeline_snapshot.name,
    initialStatus,
    queuedAt: state.started_at,
    ...(state.status === 'running' ? { startedAt: state.started_at } : {}),
    projectId: state.project_id ?? runtime.projectId,
    worktreeId: state.worktree_id ?? runtime.worktreeId,
    ...(repoId ? { repoId } : {}),
    navigationTarget: {
      kind: 'pipeline_execution',
      executionId: state.id,
      projectId: state.project_id ?? runtime.projectId,
      worktreeId: state.worktree_id ?? runtime.worktreeId,
    },
  });
}

/**
 * A replayed run's receipts. A run with no project has none yet: the receipt
 * protocol requires a task, and the run never ran in the caller's.
 */
function replayedExecutionArtifacts(
  operation: string,
  state: ExecutionState,
  runtime: WorktreeActionRuntime,
  repoId?: string,
): ReturnType<typeof pipelineExecutionArtifact>[] {
  return (state.scope ?? state.target?.scope) === 'global'
    ? []
    : [pipelineExecutionArtifact(operation, state, runtime, repoId)];
}

/**
 * A hook pause is stored on the worktree row, so a refused worktree-list
 * write refuses it. Report that as a typed error, not an internal one
 * (CAN-5680): a change still in progress can be retried; an earlier change
 * awaiting recovery blocks every later write until it is recovered.
 */
function hookPauseStorageRefusal(
  cause: unknown,
): AppAdvisorActionResponse | undefined {
  if (cause instanceof W5CommitRefusedError) {
    if (cause.reason === 'in-progress')
      return retryableError(
        'in_progress',
        'Another change to this worktree list is still saving. Try again in a moment.',
      );
    if (
      cause.reason === 'unapplied-change' ||
      cause.reason === 'recovery-required'
    ) {
      const commitId = cause.details.commitId;
      return error(
        'execution_failed',
        `Hook pauses can't be saved: an earlier change to this project's worktree list${typeof commitId === 'number' ? ` (commit ${commitId})` : ''} has not finished saving and needs workspace recovery.`,
      );
    }
    return retryableError('execution_failed', cause.message);
  }
  if (cause instanceof W5CommitLogError)
    return retryableError(
      'execution_failed',
      "The project's records are unavailable. Try again in a moment.",
    );
  return undefined;
}

function retryableError(
  code: AppAdvisorActionError['code'],
  message: string,
): AppAdvisorActionResponse {
  return {
    requestId: '',
    ok: false,
    error: { code, message, retryable: true },
  };
}

async function setHookPaused(
  action: Extract<ScopedAction, { type: 'hook.pause' | 'hook.resume' }>,
  runtime: WorktreeActionRuntime,
): Promise<AppAdvisorActionResponse> {
  if (action.all !== true && !action.hookKey) {
    return error('invalid_payload', 'Provide hookKey or set all: true.');
  }
  const hooks = await listHooks({
    projectId: runtime.projectId,
    worktreeId: runtime.worktreeId,
  });
  if (hooks.length === 0 && action.all === true) {
    return ok(
      toAppAdvisorJson({
        projectId: runtime.projectId,
        worktreeId: runtime.worktreeId,
        pausedHookKeys: [],
        changed: false,
        hooks: [],
      }),
    );
  }
  const knownHookKeys = new Set(hooks.map((hook) => hook.hookKey));
  if (action.hookKey && !knownHookKeys.has(action.hookKey)) {
    return error('not_found', `Hook ${action.hookKey} was not found.`);
  }
  const hookKeys =
    action.all === true
      ? hooks.map((hook) => hook.hookKey)
      : action.hookKey
        ? [action.hookKey]
        : [];
  let worktree: WorktreeData;
  let pausedHookKeys: string[];
  try {
    // Applied to the latest row, so a competing pause or resume is kept.
    ({ worktree, pausedHookKeys } = await changeWorktreeHookPause({
      projectId: runtime.projectId,
      worktreeId: runtime.worktreeId,
      change: {
        kind: action.type === 'hook.pause' ? 'pause' : 'resume',
        hookKeys,
      },
      source: 'app_advisor',
    }));
  } catch (cause) {
    if (cause instanceof PortalServiceError && cause.code === 'not_found') {
      return error('not_found', cause.message);
    }
    const refused = hookPauseStorageRefusal(cause);
    if (refused) return refused;
    throw cause;
  }
  const getBroadcastWindow = runtime.getSendableWindow ?? runtime.getWindow;
  sendToWindow(getBroadcastWindow(), IPC_CHANNELS.workspaceWorktreesUpdated, {
    workspaceId: runtime.projectId,
    worktree,
  });
  const refreshedHooks = await listHooks({
    projectId: runtime.projectId,
    worktreeId: runtime.worktreeId,
  });
  return ok(
    toAppAdvisorJson({
      projectId: runtime.projectId,
      worktreeId: runtime.worktreeId,
      pausedHookKeys,
      hooks: refreshedHooks,
    }),
  );
}

async function getWorktreeSettings(
  runtime: WorktreeActionRuntime,
): Promise<AppAdvisorActionResponse> {
  try {
    const [pausedHookKeys, hooks, worktrees] = await Promise.all([
      getWorktreePausedHookKeys({
        projectId: runtime.projectId,
        worktreeId: runtime.worktreeId,
      }),
      listHooks({
        projectId: runtime.projectId,
        worktreeId: runtime.worktreeId,
      }),
      readWorkspaceWorktrees(runtime.projectId),
    ]);
    const worktree = worktrees.find(
      (candidate) => candidate.id === runtime.worktreeId,
    );
    if (!worktree) {
      throw new PortalServiceError(
        'not_found',
        `Worktree ${runtime.worktreeId} not found in project ${runtime.projectId}`,
      );
    }
    return ok(
      toAppAdvisorJson({
        projectId: runtime.projectId,
        worktreeId: runtime.worktreeId,
        trackedBaseBranch: worktree.trackedBaseBranch ?? null,
        trackedRepoBaseBranches: worktree.trackedRepoBaseBranches ?? {},
        pausedHookKeys,
        hooks,
      }),
    );
  } catch (cause) {
    if (cause instanceof PortalServiceError && cause.code === 'not_found') {
      return error('not_found', cause.message);
    }
    throw cause;
  }
}

function truncateContent(
  content: string,
  maxChars: number | undefined,
): AppAdvisorJson {
  const limit = clampLimit(
    maxChars,
    PIPELINE_CONTENT_DEFAULT_MAX_CHARS,
    PIPELINE_CONTENT_MAX_CHARS,
  );
  return {
    content: content.length > limit ? content.slice(0, limit) : content,
    truncated: content.length > limit,
    originalLength: content.length,
  };
}

async function readReport(
  state: ExecutionState,
  maxChars: number | undefined,
): Promise<AppAdvisorJson | null> {
  const report = await readExecutionArtifact(state, { kind: 'report' });
  if (!report) return null;
  const truncated = truncateContent(report.content, maxChars) as Record<
    string,
    unknown
  >;
  return {
    filePath: report.filePath,
    ...truncated,
  };
}

async function readPlan(
  state: ExecutionState,
  maxChars: number | undefined,
): Promise<AppAdvisorJson | null> {
  const plan = await readExecutionArtifact(state, { kind: 'plan' });
  if (!plan) return null;
  const truncated = truncateContent(plan.content, maxChars) as Record<
    string,
    unknown
  >;
  return {
    filePath: plan.filePath,
    ...truncated,
  };
}

async function listPipelines(
  action: Extract<ScopedAction, { type: 'pipeline.list' }>,
  runtime: WorktreeActionRuntime,
): Promise<AppAdvisorActionResponse> {
  const { rows, warnings } = await loadPipelineRows(runtime, action.query);
  let disabledPipelineIds: string[] = [];
  try {
    disabledPipelineIds = (await readPreferencesFile()).disabledPipelineIds;
  } catch (cause) {
    warnings.push(cause instanceof Error ? cause.message : String(cause));
  }
  const disabledIds = new Set(disabledPipelineIds);
  const requestedModes = new Set(action.runModes ?? []);
  const executionScope = runtimeExecutionScope(runtime);
  const filtered = rows
    .map((row) => ({ ...row, enabled: !disabledIds.has(row.id) }))
    .filter((row) => action.includeDisabled === true || row.enabled)
    .filter((row) => {
      // Directory runtimes (Cowork) only surface pipelines whose declared
      // scopes a plain directory context satisfies — worktree-only pipelines
      // are unrunnable there and stay hidden. Non-project pipelines that run
      // globally are listed too: pipeline.run starts them with scope global.
      return (
        executionContextSatisfies(row.scopes, executionScope) ||
        (row.source !== 'project' &&
          executionContextSatisfies(row.scopes, 'global'))
      );
    })
    .filter((row) => {
      return fuzzyMatch(action.query, [row.id, row.name, row.description]);
    })
    .filter((row) => {
      if (requestedModes.size === 0) return true;
      return row.runModes.some((mode) => requestedModes.has(mode.mode));
    })
    .sort((left, right) => left.name.localeCompare(right.name));
  const limit = clampLimit(
    action.limit,
    PIPELINE_LIST_DEFAULT_LIMIT,
    PIPELINE_LIST_MAX_LIMIT,
  );
  return ok({
    scope: {
      projectId: runtime.projectId,
      worktreeId: runtime.worktreeId,
      cwd: runtime.cwd,
    },
    filters: {
      query: action.query ?? '',
      runModes: action.runModes ?? [],
      includeDisabled: action.includeDisabled === true,
      limit,
    },
    totalMatches: filtered.length,
    returned: Math.min(filtered.length, limit),
    pipelines: filtered.slice(0, limit),
    warnings: warnings.filter(Boolean),
  } as unknown as AppAdvisorJson);
}

async function getPipeline(
  action: Extract<ScopedAction, { type: 'pipeline.get' }>,
  runtime: WorktreeActionRuntime,
): Promise<AppAdvisorActionResponse> {
  const loaded = await loadPipelineForAction(action.pipelineId, runtime);
  if ('response' in loaded) return loaded.response;
  const pipeline = loaded.pipeline;
  if (!pipeline) {
    return error('not_found', `Pipeline ${action.pipelineId} was not found.`);
  }
  const result = {
    pipeline: pipelineListRow(pipeline),
    version: pipeline.content.version ?? '',
    icon: pipeline.content.icon ?? '',
    env: jsonSafe(pipeline.content.env ?? {}),
    defaults: jsonSafe(pipeline.content.defaults ?? {}),
    jobCount: Object.keys(pipeline.content.jobs).length,
    stepCount: Object.values(pipeline.content.jobs).reduce(
      (total, job) => total + job.steps.length,
      0,
    ),
    runModes: portablePipelineTriggerTypes(
      getTriggerTypes(pipeline.content.on),
    ).map((mode) => ({
      mode,
      inputs: pipelineInputDetails(
        getTriggerInputDefs(pipeline.content.on, mode),
      ),
    })),
    ...(action.includeYaml
      ? {
          yamlDefinition: yaml.dump(
            { pipeline: pipeline.content },
            { lineWidth: 120, noRefs: true },
          ),
        }
      : {}),
  };
  const receipts = agentArtifactsForActionResult(
    { ...action, projectId: runtime.projectId, worktreeId: runtime.worktreeId },
    result,
  );
  const response = withAgentArtifacts(
    { requestId: '', ok: true as const, result },
    receipts,
  );
  return { ...response, result: toAppAdvisorJson(response.result) };
}

export async function listExecutions(
  action: Extract<
    ScopedAction,
    { type: 'pipeline.execution_list' | 'pipeline.execution_list_for_worktree' }
  >,
  runtime: WorktreeActionRuntime,
): Promise<AppAdvisorActionResponse> {
  const executionRuntime = await createWorktreeExecutionRuntime();
  const summaries = await listExecutionSummaries(
    executionRuntime.executionsDir,
  );
  const filtered = summaries.filter((summary) => {
    if (!executionBelongsToRuntime(summary, runtime)) {
      return false;
    }
    if (action.pipelineId && summary.pipeline_id !== action.pipelineId) {
      return false;
    }
    if (action.status && summary.status !== action.status) {
      return false;
    }
    return fuzzyMatch(action.query, [
      summary.pipeline_id,
      summary.pipeline_name,
      summary.id,
    ]);
  });
  const limit = clampLimit(
    action.limit,
    PIPELINE_EXECUTION_LIST_DEFAULT_LIMIT,
    PIPELINE_EXECUTION_LIST_MAX_LIMIT,
  );
  const selected = filtered.slice(0, limit);
  const states = await Promise.all(
    selected.map((summary) =>
      loadExecutionState(summary.id, executionRuntime.executionsDir).catch(
        () => null,
      ),
    ),
  );
  return ok({
    scope:
      runtimeExecutionScope(runtime) === 'directory'
        ? {
            projectId: runtime.projectId,
            cwd: runtime.cwd,
          }
        : {
            projectId: runtime.projectId,
            worktreeId: runtime.worktreeId,
          },
    filters: {
      query: action.query ?? '',
      pipelineId: action.pipelineId ?? null,
      status: action.status ?? null,
      limit,
    },
    totalMatches: filtered.length,
    returned: selected.length,
    executions: selected.map((summary, index) =>
      executionRow(summary, states[index]),
    ),
  });
}

async function getExecution(
  action: Extract<ScopedAction, { type: 'pipeline.execution_get' }>,
  runtime: WorktreeActionRuntime,
): Promise<AppAdvisorActionResponse> {
  const loaded = await loadScopedExecution(action.executionId, runtime);
  if ('response' in loaded) return loaded.response;
  const [report, plan] = await Promise.all([
    action.includeReport ? readReport(loaded.state, action.maxChars) : null,
    action.includePlan ? readPlan(loaded.state, action.maxChars) : null,
  ]);
  return ok({
    execution: executionDetails(loaded.state),
    ...(action.includeReport ? { report } : {}),
    ...(action.includePlan ? { plan } : {}),
  });
}

async function cancelExecution(
  action: Extract<ScopedAction, { type: 'pipeline.execution_cancel' }>,
  runtime: WorktreeActionRuntime,
): Promise<AppAdvisorActionResponse> {
  const loaded = await loadScopedExecution(action.executionId, runtime);
  if ('response' in loaded) return loaded.response;
  const { cancelPipelineExecutionFromMain } =
    await import('../pipelines/pipeline-handlers');
  const state = await cancelPipelineExecutionFromMain({
    executionId: action.executionId,
    getWindow: runtime.getWindow,
  });
  return ok({ execution: executionDetails(state) });
}

export async function resumeExecution(
  action: Extract<ScopedAction, { type: 'pipeline.execution_resume' }>,
  runtime: WorktreeActionRuntime,
): Promise<AppAdvisorActionResponse> {
  const loaded = await loadScopedExecution(action.executionId, runtime);
  if ('response' in loaded) return loaded.response;
  const result = await resumePipelineExecutionFromMain({
    executionId: action.executionId,
    ...(action.statusReasonIds
      ? { statusReasonIds: action.statusReasonIds }
      : {}),
    ...(action.pauseResponses
      ? {
          pauseResponses: action.pauseResponses.map((response) => ({
            checkpoint_id: response.checkpointId,
            job_id: response.jobId,
            step_id: response.stepId,
            ...(response.answers ? { answers: response.answers } : {}),
          })),
        }
      : {}),
    initiationSource: runtime.pipelineInitiationSource ?? 'automation',
    persistInitiationSource: true,
    ...(runtime.portalCommandId
      ? { portalCommandId: runtime.portalCommandId }
      : {}),
    getWindow: runtime.getWindow,
    onEvent: runtime.onPipelineEvent,
    onStepOutput: runtime.onPipelineStepOutput,
  });
  const response = {
    requestId: '',
    ok: true as const,
    result: { execution: executionDetails(result.state) },
  };
  const receiptResponse = withAgentArtifacts(
    response,
    replayedExecutionArtifacts(action.type, result.state, runtime),
  );
  return {
    ...receiptResponse,
    result: toAppAdvisorJson(receiptResponse.result),
  };
}

export async function retryExecution(
  action: Extract<ScopedAction, { type: 'pipeline.execution_retry' }>,
  runtime: WorktreeActionRuntime,
): Promise<AppAdvisorActionResponse> {
  const loaded = await loadScopedExecution(action.executionId, runtime);
  if ('response' in loaded) return loaded.response;
  // Defer the heavy local pipeline-handler graph until retry is requested.
  // The production Electron main/preload build verifies this local import path.
  const { retryPipelineExecutionFromMain } =
    await import('../pipelines/pipeline-handlers');
  const result = await retryPipelineExecutionFromMain({
    executionId: action.executionId,
    ...(runtime.portalCommandId
      ? { portalCommandId: runtime.portalCommandId }
      : {}),
    getWindow: runtime.getWindow,
    onEvent: runtime.onPipelineEvent,
    onStepOutput: runtime.onPipelineStepOutput,
  });
  if (!result.success) {
    return error('execution_failed', result.error);
  }
  const response = {
    requestId: '',
    ok: true as const,
    result: { execution: executionDetails(result.data) },
  };
  const receiptResponse = withAgentArtifacts(
    response,
    replayedExecutionArtifacts(action.type, result.data, runtime),
  );
  return {
    ...receiptResponse,
    result: toAppAdvisorJson(receiptResponse.result),
  };
}

export async function rerunExecution(
  action: {
    type: 'pipeline.execution_rerun';
    executionId: string;
    rerunExecutionId?: string;
  },
  runtime: WorktreeActionRuntime,
): Promise<AppAdvisorActionResponse> {
  const loaded = await loadScopedExecution(action.executionId, runtime);
  if ('response' in loaded) return loaded.response;
  const { rerunPipelineExecutionFromMain } =
    await import('../pipelines/pipeline-handlers');
  const result = await rerunPipelineExecutionFromMain({
    executionId: action.executionId,
    rerunExecutionId: action.rerunExecutionId,
    initiationSource: runtime.pipelineInitiationSource,
    getWindow: runtime.getWindow,
    onEvent: runtime.onPipelineEvent,
    onStepOutput: runtime.onPipelineStepOutput,
  });
  if (!result.success) {
    return error('execution_failed', result.error);
  }
  return ok({ execution: executionDetails(result.data) });
}

async function retryMatrixJob(
  action: Extract<
    ScopedAction,
    { type: 'pipeline.execution_retry_matrix_job' }
  >,
  runtime: WorktreeActionRuntime,
): Promise<AppAdvisorActionResponse> {
  const loaded = await loadScopedExecution(action.executionId, runtime);
  if ('response' in loaded) return loaded.response;
  // Defer the heavy local pipeline-handler graph until matrix retry is used.
  // The production Electron main/preload build verifies this local import path.
  const { retryMatrixJobFromMain } =
    await import('../pipelines/pipeline-handlers');
  const state = await retryMatrixJobFromMain({
    request: {
      executionId: action.executionId,
      jobId: action.jobId,
      mode: action.mode,
      ...(action.variantJobIds ? { variantJobIds: action.variantJobIds } : {}),
    },
    getWindow: runtime.getWindow,
  });
  return ok({ execution: executionDetails(state) });
}

async function cancelMatrixVariant(
  action: Extract<
    ScopedAction,
    { type: 'pipeline.execution_cancel_matrix_variant' }
  >,
  runtime: WorktreeActionRuntime,
): Promise<AppAdvisorActionResponse> {
  const loaded = await loadScopedExecution(action.executionId, runtime);
  if ('response' in loaded) return loaded.response;
  // Defer the heavy local pipeline-handler graph until variant cancellation.
  // The production Electron main/preload build verifies this local import path.
  const { cancelMatrixVariantFromMain } =
    await import('../pipelines/pipeline-handlers');
  const state = await cancelMatrixVariantFromMain({
    request: {
      executionId: action.executionId,
      jobId: action.jobId,
      variantJobId: action.variantJobId,
    },
    getWindow: runtime.getWindow,
  });
  return ok({ execution: executionDetails(state) });
}

async function chainExecution(
  action: Extract<ScopedAction, { type: 'pipeline.execution_chain' }>,
  runtime: WorktreeActionRuntime,
): Promise<AppAdvisorActionResponse> {
  const loaded = await loadScopedExecution(action.executionId, runtime);
  if ('response' in loaded) return loaded.response;
  const planPath = getExecutionPlanPath(loaded.state);
  if (!planPath) {
    return error(
      'not_found',
      'This pipeline execution does not have a saved plan file.',
    );
  }
  const executionRuntime = await createWorktreeExecutionRuntime();
  const safePlanPath = resolveAllowedPath(planPath, loaded.state.cwd, [
    executionRuntime.executionsDir,
    loaded.state.cwd,
  ]);
  if (!safePlanPath) {
    return error(
      'not_found',
      'This pipeline execution does not have a safe saved plan file.',
    );
  }
  const cwd =
    action.repoId && runtimeExecutionScope(runtime) === 'worktree'
      ? resolveWorktreeCwd(runtime.projectId, runtime.worktreeId, action.repoId)
      : loaded.state.cwd;
  const pipelineLookup = await loadPipelineForAction(
    action.pipelineId,
    runtime,
    cwd,
  );
  if ('response' in pipelineLookup) return pipelineLookup.response;
  const pipeline = pipelineLookup.pipeline;
  if (!pipeline) {
    return error('not_found', `Pipeline ${action.pipelineId} was not found.`);
  }
  const executionScope = runtimeExecutionScope(runtime);
  const declaredScopes = pipeline.info.scopes ?? DEFAULT_PIPELINE_SCOPES;
  if (!executionContextSatisfies(declaredScopes, executionScope)) {
    return error(
      'invalid_target',
      `Pipeline ${action.pipelineId} declares scopes [${declaredScopes.join(
        ', ',
      )}] and cannot run in this workspace folder (directory scope). Use pipeline.list to find runnable pipelines.`,
    );
  }
  if (!getTriggerTypes(pipeline.content.on).includes('plan_ready')) {
    return error(
      'invalid_target',
      `Pipeline ${action.pipelineId} does not support plan_ready.`,
    );
  }
  const { startPipelineExecutionFromMain } =
    await import('../pipelines/pipeline-handlers');
  const result = await startPipelineExecutionFromMain({
    pipeline: pipeline.content,
    getWindow: runtime.getWindow,
    options: {
      cwd,
      pipelineId: pipeline.info.id,
      pipelineFilePath:
        pipeline.info.source === 'project' ? pipeline.info.filePath : undefined,
      repoPath: pipeline.info.source === 'project' ? cwd : undefined,
      ...pipelineSourceExecutionOptions(pipeline),
      projectId: runtime.projectId,
      worktreeId: runtime.worktreeId,
      ...(executionScope === 'directory'
        ? {
            scope: 'directory' as const,
            target: { scope: 'directory' as const, path: cwd },
          }
        : {
            scope: 'worktree' as const,
            target: {
              scope: 'worktree' as const,
              workspace_id: runtime.projectId,
              worktree_id: runtime.worktreeId,
              path: cwd,
              created: false,
            },
          }),
      initiationSource: 'app_advisor',
      initiator: initiatorForWorktreeRuntime(runtime),
      eventName: 'plan_ready',
      eventData: {
        plan_ready: {
          plan_path: safePlanPath,
          ...(loaded.state.planId ? { planId: loaded.state.planId } : {}),
        },
      },
      ...(action.inputs && Object.keys(action.inputs).length > 0
        ? { inputs: action.inputs }
        : {}),
    },
  });
  if (!result.success) {
    return error('execution_failed', result.error);
  }
  const response = {
    requestId: '',
    ok: true as const,
    result: { execution: executionDetails(result.data) },
  };
  const receiptResponse = withAgentArtifacts(
    response,
    replayedExecutionArtifacts(
      action.type,
      result.data,
      runtime,
      action.repoId,
    ),
  );
  return {
    ...receiptResponse,
    result: toAppAdvisorJson(receiptResponse.result),
  };
}

function getRequiredBrowserService(): NonNullable<
  ReturnType<typeof getBrowserService>
> {
  const service = getBrowserService();
  if (!service) {
    throw new Error('Browser service is not available.');
  }
  return service;
}

function browserNotFound(): AppAdvisorActionResponse {
  return error(
    'not_found',
    'No in-app browser is available for this worktree.',
  );
}

async function resolveBrowserId(
  actionBrowserId: string | undefined,
  runtime: WorktreeActionRuntime,
): Promise<string | null> {
  if (runtime.browserTargetId) return runtime.browserTargetId;
  const service = getRequiredBrowserService();
  const browsers = service.listWorktreeBrowsers(
    runtime.projectId,
    runtime.worktreeId,
  );
  let browser: BrowserSessionSnapshot | undefined;
  if (actionBrowserId) {
    browser = browsers.find((entry) => entry.id === actionBrowserId);
  } else {
    const activeBrowserId = service.resolveActiveBrowserId(
      runtime.projectId,
      runtime.worktreeId,
    );
    browser = activeBrowserId
      ? browsers.find((entry) => entry.id === activeBrowserId)
      : undefined;
  }
  if (!browser) return null;
  await service.create({
    projectId: runtime.projectId,
    worktreeId: runtime.worktreeId,
    browserId: browser.id,
    ...(browser.url ? { url: browser.url } : {}),
    ...(browser.themeMode ? { themeMode: browser.themeMode } : {}),
  });
  return browser.id;
}

function getScopedBrowserSnapshot(
  service: ReturnType<typeof getRequiredBrowserService>,
  runtime: WorktreeActionRuntime,
  browserId: string,
): BrowserSessionSnapshot | null {
  return (
    service
      .listWorktreeBrowsers(runtime.projectId, runtime.worktreeId)
      .find((browser) => browser.id === browserId) ?? null
  );
}

/** The image itself goes back as image content, never again as base64 text. */
function screenshotForActionResult(
  screenshot: BrowserScreenshotResponse,
): BrowserScreenshotResponse {
  const withoutDataUrl = { ...screenshot };
  delete withoutDataUrl.dataUrl;
  return withoutDataUrl;
}

function elementForActionResult(
  element: BrowserElementSnapshot,
): AppAdvisorJson {
  const maxHtmlChars = 2_000;
  const attributes = element.attributes ?? {};
  const locatorCandidates = element.locatorCandidates ?? [];
  const outerHtml = element.outerHtml ?? '';
  const attributeEntries = Object.entries(attributes);
  return toAppAdvisorJson({
    ...element,
    attributes: Object.fromEntries(attributeEntries.slice(0, 30)),
    locatorCandidates: locatorCandidates.slice(0, 5),
    outerHtml: outerHtml.slice(0, maxHtmlChars),
    truncation: {
      outerHtml: outerHtml.length > maxHtmlChars,
      attributes: attributeEntries.length > 30,
      locatorCandidates: locatorCandidates.length > 5,
    },
  });
}

function browserList(runtime: WorktreeActionRuntime): AppAdvisorActionResponse {
  const service = getRequiredBrowserService();
  return ok({
    browsers: service.listWorktreeBrowsers(
      runtime.projectId,
      runtime.worktreeId,
    ),
    activeBrowserId: service.resolveActiveBrowserId(
      runtime.projectId,
      runtime.worktreeId,
    ),
  } as unknown as AppAdvisorJson);
}

async function browserOpen(
  action: Extract<ScopedAction, { type: 'browser.open' }>,
  runtime: WorktreeActionRuntime,
): Promise<AppAdvisorActionResponse> {
  const service = getRequiredBrowserService();
  const origin = runtime.presentationOrigin ?? {
    projectId: runtime.projectId,
    worktreeId: runtime.worktreeId,
    chatTabId: runtime.chatId,
  };
  const admission = browserHandoffs.captureAdmission(
    runtime.projectId,
    runtime.worktreeId,
    origin,
  );
  const browsers = service.listWorktreeBrowsers(
    runtime.projectId,
    runtime.worktreeId,
  );
  const browserId = action.browserId;
  if (browserId && !browsers.some((browser) => browser.id === browserId)) {
    return browserNotFound();
  }
  const requestedUrl = action.url
    ? normalizeBrowserUrlInput(action.url)
    : undefined;
  if (requestedUrl) {
    if (
      requestedUrl !== 'about:blank' &&
      !service.isUrlAllowedInApp(requestedUrl)
    ) {
      if (
        isFileBrowserUrl(requestedUrl) ||
        !isSafeExternalBrowserUrl(requestedUrl)
      ) {
        return error(
          'invalid_target',
          'Enter an http or https URL, or the full path to a local file.',
        );
      }
      if (action.handoff)
        return error(
          'invalid_target',
          'A browser handoff requires an in-app browser URL.',
        );
      await service.openExternal(requestedUrl);
      sendToWindow(runtime.getWindow(), IPC_CHANNELS.browserEvent, {
        type: 'app-link-local-only-conflict',
        url: requestedUrl,
      } satisfies AppLinkBrowserEvent);
      return ok({
        browser: browserId
          ? (browsers.find((browser) => browser.id === browserId) ??
            getScopedBrowserSnapshot(service, runtime, browserId))
          : null,
        openedUrl: requestedUrl,
      } as unknown as AppAdvisorJson);
    }
  } else if (action.url) {
    return error(
      'invalid_target',
      'Enter an http or https URL, or the full path to a local file.',
    );
  }
  const pending = browserHandoffs.snapshot(
    runtime.projectId,
    runtime.worktreeId,
  ).handoff;
  if (
    action.handoff &&
    browserId &&
    pending?.browserId === browserId &&
    pending.origin.projectId === origin.projectId &&
    pending.origin.worktreeId === origin.worktreeId &&
    pending.origin.chatTabId === origin.chatTabId
  ) {
    const browser = getScopedBrowserSnapshot(service, runtime, browserId);
    if (!browser) return browserNotFound();
    if (pending.runtimeGeneration === browser.profile?.runtimeGeneration) {
      // A panel may have closed while the logical browser remains pending.
      // Repeating the handoff must neither rehydrate its view nor refocus it.
      return ok(
        toAppAdvisorJson({ browser, handoff: pending, attention: 'pending' }),
      );
    }
  }
  const createdNewSession = !browserId;
  // An empty id means "new" too (see `createdNewSession`).
  const targetBrowserId = browserId ? browserId : randomUUID();
  if (createdNewSession) {
    // Creating a session (profile, persistence, first load) takes a while.
    // Let the renderer place the tab now; `open-requested` or `destroyed`
    // settles it.
    sendToWindow(runtime.getWindow(), IPC_CHANNELS.browserEvent, {
      type: 'open-pending',
      ...(pending && !action.handoff
        ? { presentation: 'background' as const }
        : {}),
      browserId: targetBrowserId,
      projectId: runtime.projectId,
      worktreeId: runtime.worktreeId,
      ...(requestedUrl && requestedUrl !== 'about:blank'
        ? { url: requestedUrl }
        : {}),
      originChatTabId: runtime.chatId,
    } satisfies BrowserEvent);
  }
  let browser: BrowserSessionSnapshot;
  let created = false;
  try {
    browser = await service.create(
      {
        projectId: runtime.projectId,
        worktreeId: runtime.worktreeId,
        ...(requestedUrl ? { url: requestedUrl } : {}),
        ...(action.selection ? { selection: action.selection } : {}),
        browserId: targetBrowserId,
      },
      'agent',
    );
    created = true;
    if (
      action.handoff ||
      !browserHandoffs.snapshot(runtime.projectId, runtime.worktreeId).handoff
    ) {
      await service.setActiveBrowser(
        runtime.projectId,
        runtime.worktreeId,
        browser.id,
      );
    }
    if (action.handoff) {
      const handoff = service.requestHandoff(
        browser,
        origin,
        runtime.getWindow(),
        createdNewSession,
        admission,
      );
      // Main cannot attest renderer selection or OS focus. The renderer acknowledges
      // attention locally only when this worktree is selected.
      return ok(toAppAdvisorJson({ browser, handoff, attention: 'pending' }));
    }
  } catch (cause) {
    if (createdNewSession) {
      // Every announced open must settle: remove the session this action
      // created (best effort) and tell the renderer to drop its tab.
      if (created)
        await service.destroy(targetBrowserId).catch(() => undefined);
      sendToWindow(runtime.getWindow(), IPC_CHANNELS.browserEvent, {
        type: 'destroyed',
        browserId: targetBrowserId,
      } satisfies BrowserEvent);
    }
    throw cause;
  }
  sendToWindow(runtime.getWindow(), IPC_CHANNELS.browserEvent, {
    type: 'open-requested',
    ...(browserHandoffs.snapshot(runtime.projectId, runtime.worktreeId).handoff
      ? { presentation: 'background' as const }
      : {}),
    browserId: browser.id,
    snapshot: browser,
    originChatTabId: runtime.chatId,
    createdNewSession,
  } satisfies BrowserEvent);
  // A new tab loads once its pane shows it; return after that load starts.
  browser = await service.waitForInitialLoad(browser.id);
  return ok({ browser } as unknown as AppAdvisorJson);
}

async function browserNavigate(
  action: Extract<ScopedAction, { type: 'browser.navigate' }>,
  runtime: WorktreeActionRuntime,
): Promise<AppAdvisorActionResponse> {
  const browserId = await resolveBrowserId(action.browserId, runtime);
  if (!browserId) return browserNotFound();
  try {
    const browser = await getRequiredBrowserService().navigate({
      browserId,
      url: action.url,
    });
    return ok({ browser } as unknown as AppAdvisorJson);
  } catch (error_) {
    return error(
      'invalid_target',
      error_ instanceof Error ? error_.message : String(error_),
    );
  }
}

async function browserSimpleNavigation(
  action: Extract<
    ScopedAction,
    {
      type:
        | 'browser.back'
        | 'browser.forward'
        | 'browser.reload'
        | 'browser.stop';
    }
  >,
  runtime: WorktreeActionRuntime,
): Promise<AppAdvisorActionResponse> {
  const browserId = await resolveBrowserId(action.browserId, runtime);
  if (!browserId) return browserNotFound();
  const service = getRequiredBrowserService();
  const browser =
    action.type === 'browser.back'
      ? await service.back(browserId)
      : action.type === 'browser.forward'
        ? await service.forward(browserId)
        : action.type === 'browser.reload'
          ? await service.reload(browserId)
          : await service.stop(browserId);
  return ok({ browser } as unknown as AppAdvisorJson);
}

function projectBrowserAutomationResult(
  result: AppAdvisorActionResponse | BrowserPostDispatchUnknown,
): AppAdvisorActionResponse {
  // A replayed actionId keeps the same retained fields the IPC route returns.
  return 'kind' in result
    ? ok(
        toAppAdvisorJson({
          ok: true,
          completed: false,
          receipt: result.receipt,
          ...('repeated' in result && result.repeated === true
            ? { repeated: true }
            : {}),
          ...('dialog' in result && result.dialog
            ? { dialog: result.dialog }
            : {}),
          ...('handledDialog' in result && result.handledDialog
            ? { handledDialog: result.handledDialog }
            : {}),
        }),
      )
    : result;
}

async function browserAutomationAction(
  action: Extract<
    ScopedAction,
    {
      type:
        | 'browser.click'
        | 'browser.fill'
        | 'browser.press'
        | 'browser.focus'
        | 'browser.wait_for'
        | 'browser.hover'
        | 'browser.scroll'
        | 'browser.drag'
        | 'browser.set_checked'
        | 'browser.select_option'
        | 'browser.type'
        | 'browser.upload_files'
        | 'browser.request_files'
        | 'browser.drop_files';
    }
  >,
  runtime: WorktreeActionRuntime,
): Promise<AppAdvisorActionResponse | BrowserPostDispatchUnknown> {
  const browserId = await resolveBrowserId(action.browserId, runtime);
  if (!browserId) return browserNotFound();
  const command = buildBrowserAutomationCommand(action);
  const service = getRequiredBrowserService();
  const approvalChat =
    action.type === 'browser.upload_files' ||
    action.type === 'browser.request_files' ||
    action.type === 'browser.drop_files'
      ? approvalChatOf(runtime)
      : undefined;
  const request = {
    browserId,
    command,
    ...(approvalChat ? { approvalChat } : {}),
  };
  const response = runtime.signal
    ? await service.automation(request, runtime.signal)
    : await service.automation(request);
  if ('kind' in response) return response;
  if (!response.ok) {
    return error(
      response.error?.code ?? 'execution_failed',
      response.error?.message ?? 'Browser automation failed.',
      response.error?.details,
    );
  }
  return ok(
    toAppAdvisorJson({
      browser:
        response.browser ??
        getScopedBrowserSnapshot(service, runtime, browserId),
      completed: response.completed ?? true,
      ...(response.handledDialog
        ? { handledDialog: response.handledDialog }
        : {}),
      ...(response.dialog ? { dialog: response.dialog } : {}),
      ...(response.receipt ? { receipt: response.receipt } : {}),
      ...(response.waitFor ? { waitFor: response.waitFor } : {}),
      ...(response.repeated ? { repeated: response.repeated } : {}),
    }),
  );
}

function dialogForActionResult(
  dialog: BrowserJavaScriptDialog | null,
): BrowserJavaScriptDialog | null {
  return dialog
    ? {
        ...dialog,
        message: dialog.message.slice(0, 10_000),
        ...(dialog.defaultPrompt !== undefined
          ? { defaultPrompt: dialog.defaultPrompt.slice(0, 10_000) }
          : {}),
      }
    : null;
}

async function browserGetDialogAction(
  action: Extract<ScopedAction, { type: 'browser.get_dialog' }>,
  runtime: WorktreeActionRuntime,
): Promise<AppAdvisorActionResponse> {
  const browserId = await resolveBrowserId(action.browserId, runtime);
  if (!browserId) return browserNotFound();
  const service = getRequiredBrowserService();
  return ok(
    toAppAdvisorJson({
      browser: getScopedBrowserSnapshot(service, runtime, browserId),
      dialog: dialogForActionResult(service.getDialog(browserId)),
      fileChooser: service.getFileChooser(browserId),
      printRequest: service.getPrintRequest(browserId),
      auth: service.getAuthRequest(browserId),
    }),
  );
}

async function browserHandleDialogAction(
  action: Extract<ScopedAction, { type: 'browser.handle_dialog' }>,
  runtime: WorktreeActionRuntime,
): Promise<AppAdvisorActionResponse> {
  const browserId = await resolveBrowserId(action.browserId, runtime);
  if (!browserId) return browserNotFound();
  const service = getRequiredBrowserService();
  const chooser = fileChooserDialogAnswer(action.dialogId, action.accept);
  if (chooser.kind === 'refuse')
    return error('invalid_target', chooser.error.message, {
      error: chooser.error,
    });
  if (chooser.kind === 'dismiss') {
    const answered = await service.answerFileChooser({
      browserId,
      chooserId: chooser.chooserId,
      answer: 'dismiss',
    });
    return answered.ok
      ? ok(
          toAppAdvisorJson({
            browser: getScopedBrowserSnapshot(service, runtime, browserId),
            handled: { fileChooserId: chooser.chooserId, accept: false },
          }),
        )
      : error('invalid_target', FILE_CHOOSER_NOT_PENDING);
  }
  const auth = authRequestDialogAnswer(action.dialogId, action.accept);
  if (auth.kind === 'refuse')
    return error('invalid_target', auth.error.message, { error: auth.error });
  if (auth.kind === 'cancel')
    return service.answerAuthRequest({
      browserId,
      authRequestId: auth.authRequestId,
      answer: 'cancel',
    }).ok
      ? ok(
          toAppAdvisorJson({
            browser: getScopedBrowserSnapshot(service, runtime, browserId),
            handled: { authRequestId: auth.authRequestId, accept: false },
          }),
        )
      : error('invalid_target', AUTH_REQUEST_NOT_PENDING);
  const print = printRequestDialogAnswer(action.dialogId, action.accept);
  if (print.kind === 'answer') {
    const answered = await service.answerPrintRequest({
      browserId,
      printRequestId: print.printRequestId,
      answer: print.answer,
    });
    if (answered.ok)
      return ok(
        toAppAdvisorJson({
          browser: getScopedBrowserSnapshot(service, runtime, browserId),
          handled: {
            printRequestId: print.printRequestId,
            accept: action.accept,
            ...(answered.transfer ? { transfer: answered.transfer } : {}),
          },
        }),
      );
    return answered.error?.code === 'not_found'
      ? error('invalid_target', PRINT_REQUEST_NOT_PENDING)
      : error(
          'execution_failed',
          answered.error?.message ?? "The PDF couldn't be saved.",
        );
  }
  try {
    const handled = await service.handleDialog({
      browserId,
      dialogId: action.dialogId,
      accept: action.accept,
      ...(action.promptText !== undefined
        ? { promptText: action.promptText }
        : {}),
    });
    return ok(
      toAppAdvisorJson({
        browser: getScopedBrowserSnapshot(service, runtime, browserId),
        handled: {
          ...handled,
          dialog: dialogForActionResult(handled.dialog),
        },
      }),
    );
  } catch (error_) {
    return error(
      'invalid_target',
      error_ instanceof Error ? error_.message : String(error_),
    );
  }
}

async function browserScreenshotAction(
  action: Extract<ScopedAction, { type: 'browser.screenshot' }>,
  runtime: WorktreeActionRuntime,
): Promise<AppAdvisorActionResponse> {
  const browserId = await resolveBrowserId(action.browserId, runtime);
  if (!browserId) return browserNotFound();
  const service = getRequiredBrowserService();
  const screenshot = await service.screenshot({
    browserId,
    saveToAttachments: action.saveToAttachments ?? true,
  });
  return {
    ...ok({
      browser: getScopedBrowserSnapshot(service, runtime, browserId),
      screenshot: screenshotForActionResult(screenshot),
    } as unknown as AppAdvisorJson),
    ...(screenshot.dataUrl ? { toolImageDataUrl: screenshot.dataUrl } : {}),
  };
}

async function browserInspectAction(
  action: Extract<ScopedAction, { type: 'browser.inspect' }>,
  runtime: WorktreeActionRuntime,
): Promise<AppAdvisorActionResponse> {
  const browserId = await resolveBrowserId(action.browserId, runtime);
  if (!browserId) return browserNotFound();
  const service = getRequiredBrowserService();
  let element: BrowserElementSnapshot;
  try {
    element = await service.inspect({
      browserId,
      ref: action.ref,
      locator: action.locator,
      ...(action.frame === undefined ? {} : { frame: action.frame }),
      x: action.x,
      y: action.y,
    });
  } catch (failure) {
    return readTargetFailure(failure);
  }
  return ok({
    browser: getScopedBrowserSnapshot(service, runtime, browserId),
    element: elementForActionResult(element),
  } as unknown as AppAdvisorJson);
}

async function browserInputSnapshotAction(
  action: Extract<ScopedAction, { type: 'browser.input_snapshot' }>,
  runtime: WorktreeActionRuntime,
): Promise<AppAdvisorActionResponse> {
  const browserId = await resolveBrowserId(action.browserId, runtime);
  if (!browserId) return browserNotFound();
  const service = getRequiredBrowserService();
  let inputSnapshot: BrowserInputSnapshotResponse;
  try {
    inputSnapshot = await service.inputSnapshot({
      browserId,
      filter: {
        ...(action.frame === undefined ? {} : { frame: action.frame }),
        ...(action.inputType ? { inputType: action.inputType } : {}),
        ...(action.role ? { role: action.role } : {}),
        ...(action.name ? { name: action.name } : {}),
      },
      offset: action.offset ?? 0,
      limit: clampLimit(action.limit, 25, 100),
    });
  } catch (failure) {
    return readTargetFailure(failure);
  }
  return ok({ inputSnapshot } as unknown as AppAdvisorJson);
}

/**
 * A snapshot or inspect whose target did not resolve fails as an action
 * refusal does (E3): `invalid_target` and the code in `details.error`, on
 * the MCP route as on App Advisor's, never a JSON-RPC internal error.
 * Other errors still throw.
 */
function readTargetFailure(failure: unknown): AppAdvisorActionResponse {
  const decoded = decodeBrowserReadTargetError(failure);
  if (!decoded) throw failure;
  const refusal = browserReadTargetFailure(decoded);
  return error(refusal.code, refusal.message, refusal.details);
}

async function browserConsoleAction(
  action: Extract<ScopedAction, { type: 'browser.get_console' }>,
  runtime: WorktreeActionRuntime,
): Promise<AppAdvisorActionResponse> {
  const browserId = await resolveBrowserId(action.browserId, runtime);
  if (!browserId) return browserNotFound();
  const limit = clampLimit(
    action.limit,
    BROWSER_ACTION_ROW_LIMIT,
    BROWSER_ACTION_ROW_LIMIT,
  );
  const service = getRequiredBrowserService();
  const entries = service
    .getConsole({ browserId, level: action.level, limit })
    .map(truncateBrowserConsoleEntry);
  return ok({
    browser: getScopedBrowserSnapshot(service, runtime, browserId),
    entries,
    returned: entries.length,
    limit,
  } as unknown as AppAdvisorJson);
}

async function browserNetworkAction(
  action: Extract<ScopedAction, { type: 'browser.get_network' }>,
  runtime: WorktreeActionRuntime,
): Promise<AppAdvisorActionResponse> {
  const browserId = await resolveBrowserId(action.browserId, runtime);
  if (!browserId) return browserNotFound();
  const limit = clampLimit(
    action.limit,
    BROWSER_ACTION_ROW_LIMIT,
    BROWSER_ACTION_ROW_LIMIT,
  );
  const service = getRequiredBrowserService();
  const entries = service
    .getNetwork({
      browserId,
      failed: action.failed,
      status: action.status,
      urlContains: action.urlContains,
      limit,
    })
    .map(truncateBrowserNetworkEntry);
  return ok({
    browser: getScopedBrowserSnapshot(service, runtime, browserId),
    entries,
    returned: entries.length,
    limit,
  } as unknown as AppAdvisorJson);
}

async function browserListTransfersAction(
  action: Extract<ScopedAction, { type: 'browser.list_transfers' }>,
  runtime: WorktreeActionRuntime,
): Promise<AppAdvisorActionResponse> {
  const browserId = await resolveBrowserId(action.browserId, runtime);
  if (!browserId) return browserNotFound();
  const service = getRequiredBrowserService();
  const result = service.listTransfers({
    browserId,
    kind: action.kind,
    status: action.status,
    offset: action.offset ?? 0,
    limit: clampLimit(action.limit, 25, 100),
  });
  return ok(
    toAppAdvisorJson({
      browserId,
      ...result,
    }),
  );
}

async function browserCancelTransferAction(
  action: Extract<ScopedAction, { type: 'browser.cancel_transfer' }>,
  runtime: WorktreeActionRuntime,
): Promise<AppAdvisorActionResponse> {
  const browserId = await resolveBrowserId(action.browserId, runtime);
  if (!browserId) return browserNotFound();
  const service = getRequiredBrowserService();
  const result = await service.cancelTransfer({
    browserId,
    transferId: action.transferId,
  });
  return ok(
    toAppAdvisorJson({
      browserId,
      ...result,
    }),
  );
}

/**
 * Asks the calling chat's approval session for the write, so it follows that
 * chat's mode. A runtime without a chat has no one to ask and is denied.
 */
/**
 * The chat whose approval session answers an action that asks: the
 * runtime's named approval chat, or the chat that made the call.
 */
function approvalChatOf(
  runtime: WorktreeActionRuntime,
): { projectId: string; worktreeId: string; chatId: string } | undefined {
  if (runtime.approvalChat) return runtime.approvalChat;
  return runtime.chatId
    ? {
        projectId: runtime.projectId,
        worktreeId: runtime.worktreeId,
        chatId: runtime.chatId,
      }
    : undefined;
}

async function browserSaveDownloadAction(
  action: Extract<ScopedAction, { type: 'browser.save_download' }>,
  runtime: WorktreeActionRuntime,
): Promise<AppAdvisorActionResponse> {
  const browserId = await resolveBrowserId(action.browserId, runtime);
  if (!browserId) return browserNotFound();
  const service = getRequiredBrowserService();
  const result = await service.saveDownload(
    {
      browserId,
      downloadId: action.downloadId,
      path: action.path,
      ...(action.overwrite !== undefined
        ? { overwrite: action.overwrite }
        : {}),
      ...(action.timeoutMs !== undefined
        ? { timeoutMs: action.timeoutMs }
        : {}),
      ...(action.actionId !== undefined ? { actionId: action.actionId } : {}),
      ...(approvalChatOf(runtime)
        ? { approvalChat: approvalChatOf(runtime) }
        : {}),
    },
    runtime.signal ? { signal: runtime.signal } : {},
  );
  return ok(toAppAdvisorJson({ browserId, ...result }));
}

async function browserSavePdfAction(
  action: Extract<ScopedAction, { type: 'browser.save_pdf' }>,
  runtime: WorktreeActionRuntime,
): Promise<AppAdvisorActionResponse> {
  const browserId = await resolveBrowserId(action.browserId, runtime);
  if (!browserId) return browserNotFound();
  const result = await getRequiredBrowserService().savePdf({
    browserId,
    fileName: action.fileName,
    landscape: action.landscape,
    printBackground: action.printBackground,
    scale: action.scale,
    paperFormat: action.paperFormat,
    pageRanges: action.pageRanges,
    displayHeaderFooter: action.displayHeaderFooter,
    actionId: action.actionId,
    timeoutMs: action.timeoutMs,
  });
  return ok(toAppAdvisorJson({ browserId, ...result }));
}

async function browserRecordingAction(
  action: Extract<
    ScopedAction,
    { type: 'browser.start_recording' | 'browser.stop_recording' }
  >,
  runtime: WorktreeActionRuntime,
): Promise<AppAdvisorActionResponse> {
  const browserId = await resolveBrowserId(action.browserId, runtime);
  if (!browserId) return browserNotFound();
  const service = getRequiredBrowserService();
  if (action.type === 'browser.start_recording') {
    const browser = await service.startRecording(browserId);
    return ok({ browser } as unknown as AppAdvisorJson);
  }
  const recording = await service.stopRecording(browserId);
  const browser = getScopedBrowserSnapshot(service, runtime, browserId);
  let attachmentPath: string | undefined;
  if (action.saveToAttachments) {
    if (!browser?.profile)
      throw new Error('The browser profile is unavailable.');
    attachmentPath = await service.saveRecordingArtifact(
      browserId,
      browser.profile.runtimeGeneration,
      recording.playwrightScript,
    );
  }
  return ok({
    browser,
    recording,
    ...(attachmentPath ? { attachmentPath } : {}),
  } as unknown as AppAdvisorJson);
}

async function browserOpenExternalAction(
  action: Extract<ScopedAction, { type: 'browser.open_external' }>,
  runtime: WorktreeActionRuntime,
): Promise<AppAdvisorActionResponse> {
  const service = getRequiredBrowserService();
  let url = action.url;
  let browser: BrowserSessionSnapshot | null = null;
  if (action.browserId || !url) {
    const browserId = await resolveBrowserId(action.browserId, runtime);
    if (!browserId) return browserNotFound();
    browser = getScopedBrowserSnapshot(service, runtime, browserId);
    url = url ?? browser?.url;
  }
  if (!url || isFileBrowserUrl(url) || !isSafeExternalBrowserUrl(url)) {
    return error('invalid_target', 'Enter an http or https URL.');
  }
  await service.openExternal(url);
  return ok({ browser, openedUrl: url } as unknown as AppAdvisorJson);
}

async function importTrackedPlanAction(
  action: Extract<ScopedAction, { type: 'tracked-plan.import' }>,
  runtime: WorktreeActionRuntime,
): Promise<AppAdvisorActionResponse> {
  if (!action.filePath.trim()) {
    return error('invalid_target', 'A non-empty filePath is required.');
  }
  const response = await importTrackedPlanFromPath({
    projectId: runtime.projectId,
    worktreeId: runtime.worktreeId,
    filePath: action.filePath,
    repoId: action.repoId,
    ...(runtime.planInitiationSource
      ? { initiationSource: runtime.planInitiationSource }
      : {}),
  });
  sendToWindow(runtime.getWindow(), IPC_CHANNELS.trackedPlansUpdated, {
    projectId: runtime.projectId,
    worktreeId: runtime.worktreeId,
    plan: response.plan,
  });
  return ok(importedPlanResult(response.plan, response.trackedPlanFilePath));
}

async function dispatchWorktreeScriptAction(
  action: WorktreeScriptAction,
  runtime: WorktreeActionRuntime,
): Promise<AppAdvisorActionResponse> {
  // Deferred: the script runner, run-log store, and shared-container run
  // plumbing load only when an agent lists or runs scripts.
  const { listWorktreeScripts, runWorktreeScript } =
    await import('./worktree-script-actions');
  return action.type === 'worktree.list_scripts'
    ? listWorktreeScripts(runtime)
    : runWorktreeScript(action, runtime);
}

async function dispatchWorktreeActionInner(
  input: DispatchWorktreeActionInput,
  runtime: WorktreeActionRuntime,
): Promise<AppAdvisorActionResponse> {
  const actionType = input.action.type;
  if (
    runtimeExecutionScope(runtime) === 'directory' &&
    WORKTREE_ONLY_ACTION_TYPES.has(input.action.type)
  ) {
    return error(
      'invalid_target',
      `${input.action.type} requires a git worktree and is not available in this project folder.`,
    );
  }
  if (input.action.type === 'pipeline.list') {
    const action = input.action;
    return withAgentPipelineTelemetry(
      { action: 'list', source: 'unknown' },
      () => listPipelines(action, runtime),
    );
  }
  if (input.action.type === 'pipeline.get') {
    const action = input.action;
    return withAgentPipelineTelemetry(
      { action: 'get', source: 'unknown', hasPipelineId: true },
      () => getPipeline(action, runtime),
    );
  }
  if (
    input.action.type === 'browser.profile.preview_clear' ||
    input.action.type === 'browser.profile.clear' ||
    input.action.type === 'browser.profile.job_get' ||
    input.action.type === 'browser.profile.job_cancel' ||
    input.action.type === 'browser.profile.list' ||
    input.action.type === 'browser.profile.get' ||
    input.action.type === 'browser.profile.switch'
  )
    return dispatchScopedBrowserAction(input, runtime);
  if (isAgentResourceAction(input.action)) {
    return dispatchAgentResourceAction(input.action, runtime);
  }
  switch (input.action.type) {
    case 'sidebar.item_groups.list':
    case 'sidebar.item_groups.list_items':
    case 'sidebar.item_groups.set_item':
    case 'sidebar.item_groups.update': {
      const { dispatchSidebarItemGroupAction } =
        await import('./sidebar-item-group-actions');
      return dispatchSidebarItemGroupAction(input.action, runtime);
    }
    case 'sharing.open_dialog':
      return openShareDialog(input.action, runtime);
    case 'pipeline.execution_list':
    case 'pipeline.execution_list_for_worktree':
      return listExecutions(input.action, runtime);
    case 'pipeline.execution_get':
      return getExecution(input.action, runtime);
    case 'pipeline.execution_cancel':
      return cancelExecution(input.action, runtime);
    case 'pipeline.execution_resume':
      return resumeExecution(input.action, runtime);
    case 'pipeline.execution_retry_matrix_job':
      return retryMatrixJob(input.action, runtime);
    case 'pipeline.execution_cancel_matrix_variant':
      return cancelMatrixVariant(input.action, runtime);
    case 'pipeline.execution_retry':
      return retryExecution(input.action, runtime);
    case 'pipeline.execution_chain':
      return chainExecution(input.action, runtime);
    case 'worktree.get_settings':
      return getWorktreeSettings(runtime);
    case 'worktree.list_scripts':
    case 'worktree.run_script':
      return dispatchWorktreeScriptAction(input.action, runtime);
    case 'tracked-plan.import':
      return importTrackedPlanAction(input.action, runtime);
    case 'hook.pause':
    case 'hook.resume':
      return setHookPaused(input.action, runtime);
    case 'browser.list':
      return browserList(runtime);
    case 'browser.open':
      return browserOpen(input.action, runtime);
    case 'browser.navigate':
      return browserNavigate(input.action, runtime);
    case 'browser.back':
    case 'browser.forward':
    case 'browser.reload':
    case 'browser.stop':
      return browserSimpleNavigation(input.action, runtime);
    case 'browser.get_dialog':
      return browserGetDialogAction(input.action, runtime);
    case 'browser.handle_dialog':
      return browserHandleDialogAction(input.action, runtime);
    case 'browser.click':
    case 'browser.fill':
    case 'browser.set_checked':
    case 'browser.select_option':
    case 'browser.type':
    case 'browser.upload_files':
    case 'browser.request_files':
    case 'browser.drop_files':
    case 'browser.press':
    case 'browser.hover':
    case 'browser.scroll':
    case 'browser.drag':
    case 'browser.focus':
    case 'browser.wait_for':
      return projectBrowserAutomationResult(
        await browserAutomationAction(input.action, runtime),
      );
    case 'browser.screenshot':
      return browserScreenshotAction(input.action, runtime);
    case 'browser.input_snapshot':
      return browserInputSnapshotAction(input.action, runtime);
    case 'browser.inspect':
      return browserInspectAction(input.action, runtime);
    case 'browser.get_console':
      return browserConsoleAction(input.action, runtime);
    case 'browser.get_network':
      return browserNetworkAction(input.action, runtime);
    case 'browser.list_transfers':
      return browserListTransfersAction(input.action, runtime);
    case 'browser.cancel_transfer':
      return browserCancelTransferAction(input.action, runtime);
    case 'browser.save_download':
      return browserSaveDownloadAction(input.action, runtime);
    case 'browser.save_pdf':
      return browserSavePdfAction(input.action, runtime);
    case 'browser.start_recording':
    case 'browser.stop_recording':
      return browserRecordingAction(input.action, runtime);
    case 'browser.open_external':
      return browserOpenExternalAction(input.action, runtime);
  }
  return error(
    'unsupported_action',
    `${actionType} is defined by the transport contract but its backend handler is unavailable.`,
  );
}

export async function dispatchScopedBrowserAction(
  input: DispatchWorktreeActionInput,
  runtime: WorktreeActionRuntime,
  signal?: AbortSignal,
): Promise<AppAdvisorActionResponse> {
  signal?.throwIfAborted();
  const unavailable = rejectUnavailableWorktreeAction(
    input.action.type,
    runtime,
  );
  if (unavailable) return unavailable;
  // A chat driven from another computer's window cannot use this computer's
  // in-app browser: its panels would join the layout that window shows.
  if (
    chatDriver(runtime.chatId) !== null &&
    !input.action.type.startsWith('browser.profile.')
  )
    return error(
      'surface_unavailable',
      "Open Browser from the other computer's own window.",
    );
  const scopedRuntime = signal ? { ...runtime, signal } : runtime;
  const action = input.action;
  const service = getRequiredBrowserService();
  try {
    if (
      action.type === 'browser.profile.preview_clear' ||
      action.type === 'browser.profile.clear' ||
      action.type === 'browser.profile.job_get' ||
      action.type === 'browser.profile.job_cancel'
    ) {
      const slot = await getBrowserProfileService().taskContext(
        runtime.projectId,
        runtime.worktreeId,
      );
      const actor = {
        kind: 'agent' as const,
        taskScope: slot.scope,
        taskIncarnationId: slot.incarnationId,
      };
      const data = service.profileData;
      await data.ensureReady();
      signal?.throwIfAborted();
      if (action.type === 'browser.profile.preview_clear')
        return ok(
          toAppAdvisorJson(
            await data.maintenance.preview(
              actor,
              action.profileId,
              action.storageGeneration,
              action.metadataRevision,
              action.operation,
            ),
          ),
        );
      if (action.type === 'browser.profile.clear') {
        const job = await data.maintenance.commit(
          actor,
          action.operationId,
          action.token,
        );
        if (signal?.aborted) {
          await data.jobs.cancel(job.jobId, actor);
          service.downloads.cancelJob(job.jobId);
          signal.throwIfAborted();
        }
        return ok(toAppAdvisorJson(job));
      }
      if (action.type === 'browser.profile.job_get')
        return ok(toAppAdvisorJson(await data.jobs.get(action.jobId, actor)));
      const job = await data.jobs.cancel(action.jobId, actor);
      service.downloads.cancelJob(job.jobId);
      return ok(toAppAdvisorJson(job));
    }
    if (
      action.type === 'browser.profile.list' ||
      action.type === 'browser.profile.get'
    ) {
      const authority = getBrowserProfileService();
      const slot = await authority.taskContext(
        runtime.projectId,
        runtime.worktreeId,
      );
      signal?.throwIfAborted();
      if (action.type === 'browser.profile.list')
        return ok(
          toAppAdvisorJson(
            await authority.listProfiles(action.offset, slot.scope),
          ),
        );
      const profile = await authority.repository.get(action.profileId);
      if (
        profile.owner.kind === 'task' &&
        (profile.owner.taskIncarnationId !== slot.incarnationId ||
          browserTaskScopeTuple(profile.owner.taskScope) !==
            browserTaskScopeTuple(slot.scope))
      )
        throw new BrowserProfileError(
          'scope_unresolved',
          'This profile belongs to another task.',
        );
      return ok(toAppAdvisorJson({ profile }));
    }
    await service.loadWorktreeState(runtime.projectId, runtime.worktreeId);
    signal?.throwIfAborted();
    if (
      action.type === 'browser.list' ||
      (action.type === 'browser.open' && !action.browserId) ||
      (action.type === 'browser.open_external' &&
        action.url &&
        !action.browserId)
    )
      return await dispatchWorktreeActionInner(input, scopedRuntime);
    const browserId =
      ('browserId' in action ? action.browserId : undefined) ??
      service.resolveActiveBrowserId(runtime.projectId, runtime.worktreeId);
    if (!browserId) return browserNotFound();
    const snapshot = service
      .listWorktreeBrowsers(runtime.projectId, runtime.worktreeId)
      .find((value) => value.id === browserId);
    if (!snapshot) return browserNotFound();
    if (action.type === 'browser.profile.switch') {
      const result = await service.switchProfile(action, 'agent', signal);
      if (result.status === 'complete' && action.mode === 'new-tab') {
        sendToWindow(runtime.getWindow(), IPC_CHANNELS.browserEvent, {
          type: 'open-requested',
          browserId: result.browser.id,
          snapshot: result.browser,
          originChatTabId: runtime.chatId,
          createdNewSession: true,
        } satisfies BrowserEvent);
      }
      return ok(toAppAdvisorJson(result));
    }
    const result = await service.withRuntimeTarget(
      {
        browserId: snapshot.id,
        expectedRuntimeGeneration:
          'expectedRuntimeGeneration' in action
            ? action.expectedRuntimeGeneration
            : undefined,
      },
      async () => {
        if (
          action.type !== 'browser.open' &&
          !service.hasLiveBrowser(snapshot.id)
        )
          await service.create({
            projectId: runtime.projectId,
            worktreeId: runtime.worktreeId,
            browserId: snapshot.id,
          });
        if (
          action.type === 'browser.click' ||
          action.type === 'browser.fill' ||
          action.type === 'browser.set_checked' ||
          action.type === 'browser.select_option' ||
          action.type === 'browser.type' ||
          action.type === 'browser.upload_files' ||
          action.type === 'browser.request_files' ||
          action.type === 'browser.drop_files' ||
          action.type === 'browser.press' ||
          action.type === 'browser.hover' ||
          action.type === 'browser.scroll' ||
          action.type === 'browser.drag' ||
          action.type === 'browser.focus' ||
          action.type === 'browser.wait_for'
        )
          return browserAutomationAction(action, {
            ...scopedRuntime,
            browserTargetId: snapshot.id,
          });
        return dispatchWorktreeActionInner(input, {
          ...scopedRuntime,
          browserTargetId: snapshot.id,
        });
      },
      {
        dialog:
          action.type === 'browser.get_dialog' ||
          action.type === 'browser.handle_dialog',
        rehydrate: true,
      },
    );
    return projectBrowserAutomationResult(result);
  } catch (cause) {
    if (cause instanceof BrowserProfileError)
      return error(cause.code, cause.message);
    throw cause;
  }
}

export async function dispatchWorktreeAction(
  input: DispatchWorktreeActionInput,
  runtime: WorktreeActionRuntime,
): Promise<AppAdvisorActionResponse> {
  const unavailable = rejectUnavailableWorktreeAction(
    input.action.type,
    runtime,
  );
  if (unavailable) return unavailable;
  const actionWindow = input.action.type.startsWith('browser.')
    ? runtime.getWindow()
    : null;
  const browserService = input.action.type.startsWith('browser.')
    ? getBrowserService()
    : null;
  const userInteractionGeneration =
    browserService?.getUserInteractionGeneration?.() ?? 0;
  const shouldRestoreRendererFocus =
    actionWindow !== null &&
    !actionWindow.isDestroyed() &&
    typeof actionWindow.webContents.isFocused === 'function' &&
    actionWindow.webContents.isFocused();
  try {
    return await (input.action.type.startsWith('browser.')
      ? dispatchScopedBrowserAction(input, runtime)
      : dispatchWorktreeActionInner(input, runtime));
  } finally {
    if (
      shouldRestoreRendererFocus &&
      userInteractionGeneration ===
        (browserService?.getUserInteractionGeneration?.() ?? 0) &&
      actionWindow !== null &&
      !actionWindow.isDestroyed() &&
      actionWindow.isFocused() &&
      !actionWindow.webContents.isFocused()
    ) {
      actionWindow.webContents.focus();
    }
  }
}
