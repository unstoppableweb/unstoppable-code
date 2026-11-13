import type { BrowserWindow } from 'electron';
import {
  adoptDesktopPostHogSession,
  getDesktopPostHogSession,
  getDesktopPostHogEmailDomain,
} from '@canopy/desktop-instrumentation/electron/main';
import type { PostHogSessionState } from '@canopy/execution-engine/types/observability';
import {
  CORE_OBSERVABILITY_GRANTS,
  ObservabilityAuditTranscriptGetParamsSchema,
  type CanopyCallerDescriptor,
  type CanopyQueryName,
  type CanopyQueryParams,
  type CanopyQueryResult,
} from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '@canopy/core-runtime';
import {
  IPC_CHANNELS,
  SINGLE_REPO_USAGE_REPO_ID,
  type AgentAuditHistoryRequest,
  type AgentAuditHistoryResponse,
  type AgentObservabilitySnapshot,
  type AgentAuditTranscriptRequest,
  type AgentAuditTranscriptResponse,
  type AgentProviderType,
  type DesktopInstrumentationInitFailureDiagnosticRequest,
  type UsageMetricsRequest,
  type UsageMetricsResponse,
  type UsageMetricsViewRequest,
  type UsageMetricsViewResponse,
  type UsageTabSummaryRequest,
  type UsageTabSummaryResponse,
  type UsageTimeseriesRequest,
  type UsageTimeseriesResponse,
} from '@canopy/desktop-shared/types';
import { getObservabilityService } from '../observability';
import { getExecutionObservabilityIngest } from '../observability/ingest';
import { getStablePostHogAnonymousKey } from '../lib/anonymous-id';
import { getUsageDataPolicy } from '../lib/usage-data-policy';
import { isUsageInitiationSource } from '@canopy/desktop-shared/lib/turn-utils';
import { validateId, validateOptionalRepoId } from '../lib/validation';
import { sendToAllWindows, sendToWindow } from '../lib/window-send';
import type { DesktopCanopyDispatcher } from '../canopy-runtime/desktop-runtime';
import type { DesktopIpcCallerResolver } from './file-tree';
import { registerIpcHandler } from './register';
import { registerRendererDiagnosticsHandler } from './renderer-diagnostics';

function validateHistoryRequestIds(request: AgentAuditHistoryRequest): void {
  if (request.projectId) {
    validateId(request.projectId, 'projectId');
  }

  if (request.worktreeId) {
    validateId(request.worktreeId, 'worktreeId');
  }

  if (request.pipelineExecutionId) {
    validateId(request.pipelineExecutionId, 'pipelineExecutionId');
  }
}

function parseUsageTimeseriesDate(value: unknown, label: string): number {
  if (typeof value !== 'string') {
    throw new Error('startDate and endDate must be ISO 8601 strings');
  }

  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`${label} must be a valid ISO 8601 timestamp`);
  }

  return timestamp;
}

function validateUsageMetricProvider(provider: unknown): void {
  if (
    provider === undefined ||
    provider === 'all' ||
    provider === 'claude' ||
    provider === 'codex' ||
    provider === 'ollama' ||
    provider === 'cursor' ||
    provider === 'pipeline'
  ) {
    return;
  }
  throw new Error(
    `Invalid provider: ${typeof provider === 'string' ? provider : 'unknown'}`,
  );
}

function validateUsageMetricInitiationSource(source: unknown): void {
  if (
    source === undefined ||
    source === 'all' ||
    isUsageInitiationSource(source)
  ) {
    return;
  }
  throw new Error(
    `Invalid initiationSource: ${typeof source === 'string' ? source : 'unknown'}`,
  );
}

function validateUsageTabId(tab: unknown): void {
  if (
    tab === 'tokens' ||
    tab === 'cost' ||
    tab === 'worktrees' ||
    tab === 'chats' ||
    tab === 'plans' ||
    tab === 'tools' ||
    tab === 'pipelines'
  ) {
    return;
  }
  throw new Error(`Invalid tab: ${typeof tab === 'string' ? tab : 'unknown'}`);
}

function validateDesktopInstrumentationInitFailureRequest(
  request: DesktopInstrumentationInitFailureDiagnosticRequest,
): void {
  if (request.surface !== 'main' && request.surface !== 'app-advisor') {
    throw new Error(
      `Invalid surface: ${typeof request.surface === 'string' ? request.surface : 'unknown'}`,
    );
  }
  if (typeof request.reason !== 'string' || request.reason.trim() === '') {
    throw new Error('reason must be a non-empty string');
  }
}

type ObservabilityQueryName = Extract<
  CanopyQueryName,
  `core.observability.${string}`
>;

/**
 * The audit and usage channels are compatibility projections over
 * `core.observability.*` (CAN-4137). A failed read rejects with the error the
 * read itself raised, as the channels did before they went through core.
 */
export async function queryObservability<Name extends ObservabilityQueryName>(
  dispatcher: Pick<DesktopCanopyDispatcher, 'query'>,
  caller: CanopyCallerDescriptor,
  name: Name,
  params: CanopyQueryParams<Name>,
): Promise<CanopyQueryResult<Name>> {
  try {
    return await dispatcher.query(name, params, {
      caller: { ...caller, grants: [CORE_OBSERVABILITY_GRANTS.read] },
    });
  } catch (error) {
    if (!(error instanceof CanopyOperationError)) throw error;
    if (error.runtimeCause instanceof Error) throw error.runtimeCause;
    throw new Error(error.payload.message);
  }
}

export function registerObservabilityHandlers(
  getWindow: () => BrowserWindow | null,
  dispatcher: Pick<DesktopCanopyDispatcher, 'query'>,
  resolveCaller: DesktopIpcCallerResolver,
  getOrchestratorWindow: () => BrowserWindow | null = (): null => null,
): void {
  const service = getObservabilityService();
  registerRendererDiagnosticsHandler(getExecutionObservabilityIngest());

  service.subscribe((event) => {
    sendToWindow(getWindow(), IPC_CHANNELS.observabilityEvent, event);
    // The Orchestrator's page shows usage too: its composer ring re-reads a
    // plan's usage when a turn ends, which it learns from these entries.
    const orchestrator = getOrchestratorWindow();
    if (orchestrator !== null) {
      sendToWindow(orchestrator, IPC_CHANNELS.observabilityEvent, event);
    }
  });

  // Provider account usage stays with the desktop host (CAN-4180); core
  // serves the audit part of the snapshot.
  registerIpcHandler(
    IPC_CHANNELS.observabilityLoadSnapshot,
    async (event): Promise<AgentObservabilitySnapshot> => {
      const summary = await queryObservability(
        dispatcher,
        resolveCaller(event),
        'core.observability.summary.get',
        { kind: 'overview' },
      );
      if (summary.kind !== 'overview') {
        throw new Error('The audit overview could not be read.');
      }
      return { ...summary.overview, usage: service.getUsageOverview() };
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.observabilityLoadHistory,
    (
      event,
      request: AgentAuditHistoryRequest,
    ): Promise<AgentAuditHistoryResponse> => {
      validateHistoryRequestIds(request);
      return queryObservability(
        dispatcher,
        resolveCaller(event),
        'core.observability.audit.list',
        request,
      );
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.observabilityLoadUsageTimeseries,
    async (
      event,
      request: UsageTimeseriesRequest,
    ): Promise<UsageTimeseriesResponse> => {
      const startTime = parseUsageTimeseriesDate(
        request?.startDate,
        'startDate',
      );
      const endTime = parseUsageTimeseriesDate(request?.endDate, 'endDate');
      if (startTime >= endTime) {
        return Promise.reject(new Error('startDate must be before endDate'));
      }
      if (
        request.bucket !== 'hour' &&
        request.bucket !== 'day' &&
        request.bucket !== 'week'
      ) {
        return Promise.reject(
          new Error(`Invalid bucket: ${String(request.bucket)}`),
        );
      }
      const usage = await queryObservability(
        dispatcher,
        resolveCaller(event),
        'core.observability.usage.query',
        { kind: 'timeseries', request },
      );
      if (usage.kind !== 'timeseries') {
        throw new Error('The usage time series could not be read.');
      }
      return usage.result;
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.observabilityLoadUsageMetrics,
    async (
      event,
      request: UsageMetricsRequest,
    ): Promise<UsageMetricsResponse> => {
      const startTime = parseUsageTimeseriesDate(
        request?.startDate,
        'startDate',
      );
      const endTime = parseUsageTimeseriesDate(request?.endDate, 'endDate');
      if (startTime >= endTime) {
        return Promise.reject(new Error('startDate must be before endDate'));
      }
      if (request.workspaceId) {
        validateId(request.workspaceId, 'workspaceId');
      }
      if (request.repoId) {
        if (request.repoId !== SINGLE_REPO_USAGE_REPO_ID) {
          validateOptionalRepoId(request.repoId, 'repoId');
        }
      }
      validateUsageMetricProvider(request.provider);
      validateUsageMetricInitiationSource(request.initiationSource);
      const usage = await queryObservability(
        dispatcher,
        resolveCaller(event),
        'core.observability.usage.query',
        { kind: 'metrics', request },
      );
      if (usage.kind !== 'metrics') {
        throw new Error('The usage metrics could not be read.');
      }
      return usage.result;
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.observabilityLoadUsageMetricsView,
    async (
      event,
      request: UsageMetricsViewRequest,
    ): Promise<UsageMetricsViewResponse> => {
      validateUsageTabId(request?.tab);
      if (typeof request.metric !== 'string') {
        return Promise.reject(new Error('metric must be a string'));
      }
      if (typeof request.groupBy !== 'string') {
        return Promise.reject(new Error('groupBy must be a string'));
      }
      const window = request.window;
      if (
        !window ||
        (window.kind !== 'last7d' &&
          window.kind !== 'prior7d' &&
          window.kind !== 'allTime' &&
          window.kind !== 'custom')
      ) {
        return Promise.reject(new Error('window has unknown kind'));
      }
      if (window.kind === 'custom') {
        parseUsageTimeseriesDate(window.start, 'window.start');
        parseUsageTimeseriesDate(window.end, 'window.end');
      }
      const usage = await queryObservability(
        dispatcher,
        resolveCaller(event),
        'core.observability.usage.query',
        { kind: 'view', request },
      );
      if (usage.kind !== 'view') {
        throw new Error('The usage metric view could not be read.');
      }
      return usage.result;
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.observabilityLoadUsageTabSummary,
    async (
      event,
      request: UsageTabSummaryRequest,
    ): Promise<UsageTabSummaryResponse> => {
      validateUsageTabId(request?.tab);
      const summary = await queryObservability(
        dispatcher,
        resolveCaller(event),
        'core.observability.summary.get',
        { kind: 'tab', request: { tab: request.tab } },
      );
      if (summary.kind !== 'tab') {
        throw new Error('The usage summary could not be read.');
      }
      return summary.result;
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.observabilityLoadTranscript,
    (
      event,
      request: AgentAuditTranscriptRequest,
    ): Promise<AgentAuditTranscriptResponse> => {
      const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T[\d:.Z+-]+$/;
      const params = ObservabilityAuditTranscriptGetParamsSchema.safeParse({
        id: request?.id,
        eventType: request?.eventType,
        startedAt: request?.startedAt,
      });
      if (
        !params.success ||
        !ISO_DATE_RE.test(params.data.startedAt) ||
        params.data.id.length === 0
      ) {
        const result: AgentAuditTranscriptResponse = { type: 'not_available' };
        return Promise.resolve(result);
      }
      return queryObservability(
        dispatcher,
        resolveCaller(event),
        'core.observability.audit.transcript.get',
        params.data,
      );
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.observabilityRefreshUsage,
    (_event, provider: AgentProviderType): Promise<void> => {
      if (
        provider !== 'claude' &&
        provider !== 'codex' &&
        provider !== 'cursor' &&
        provider !== 'copilot' &&
        provider !== 'opencode'
      ) {
        return Promise.reject(
          new Error(`Invalid provider: ${String(provider)}`),
        );
      }
      return service.refreshProviderUsage(provider);
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.observabilityRecordDesktopInstrumentationInitFailure,
    (
      _event,
      request: DesktopInstrumentationInitFailureDiagnosticRequest,
    ): void => {
      validateDesktopInstrumentationInitFailureRequest(request);
      service.recordAppDiagnostic({
        version: 1,
        timestamp: new Date().toISOString(),
        kind: 'desktop_instrumentation_init_failed',
        reason: request.reason,
        rendererSurface:
          request.surface === 'app-advisor'
            ? 'app_advisor_window'
            : 'main_window',
      });
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.observabilityGetPostHogAnonymousId,
    (): Promise<string> => getStablePostHogAnonymousKey(),
  );

  registerIpcHandler(IPC_CHANNELS.observabilityGetPostHogSession, () =>
    getDesktopPostHogSession(),
  );
  registerIpcHandler(IPC_CHANNELS.observabilityGetUsageDataPolicy, () =>
    getUsageDataPolicy().getUsageDataPolicySnapshot(),
  );
  getUsageDataPolicy().subscribe((snapshot): void => {
    sendToAllWindows(
      IPC_CHANNELS.observabilityUsageDataPolicyChanged,
      snapshot,
    );
  });
  registerIpcHandler(IPC_CHANNELS.observabilityGetPostHogEmailDomain, () =>
    getDesktopPostHogEmailDomain(),
  );
  registerIpcHandler(
    IPC_CHANNELS.observabilityReportPostHogSessionRotation,
    (_event, proposal: PostHogSessionState) => {
      const previous = getDesktopPostHogSession();
      const current = adoptDesktopPostHogSession(proposal);
      if (current.revision !== previous.revision) {
        sendToAllWindows(
          IPC_CHANNELS.observabilityPostHogSessionUpdate,
          current,
        );
      }
      return current;
    },
  );
}
