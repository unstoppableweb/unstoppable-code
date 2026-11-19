import * as os from 'node:os';
import type { ProcessMetric } from 'electron';
import {
  createProcessTableReader,
  hostPlatformOperatingSystem,
} from '@canopy/core-platform';
import {
  ExecutionAccounting,
  type ExecutionAccountingLimits,
  type ExecutionAccountingSnapshot,
  type ExecutionLease,
  type ExecutionWakeLock,
  type ExecutionResourceGroupId,
  type PlatformOperatingSystem,
  type PlatformProcessTable,
  type PlatformProcessTableRequest,
  type PlatformSupervisionServices,
} from '@canopy/core-runtime';
import { BRAND } from '@canopy/brand/current';
import { CHAT_LABEL } from '@canopy/protocol';
import {
  DEFAULT_MEMORY_PRESSURE_CRITICAL_THRESHOLD_BYTES,
  DEFAULT_MEMORY_PRESSURE_WARNING_THRESHOLD_BYTES,
} from '@canopy/desktop-shared/constants/preferences';
import type {
  ResourceMetadata,
  ResourceProcessKind,
  ResourceProcessSnapshot,
} from '@canopy/desktop-shared/types';
import { getDaemonExecutionStatus } from '../canopy-runtime/daemon-execution-status';
import type { AppDiagnosticRecord } from '../observability/service';
import {
  getPerformanceLimits,
  getPerformanceLimitsVersion,
} from '../lib/performance-limits';
import { isRecord } from '../lib/type-guards';
import { mergeDaemonExecutionStatus } from '../resource-monitor/daemon-status';
import type { ResourceRegistrationHandle } from '../resource-monitor/service';

/*
 * The in-process host of core execution accounting (CAN-4135). The core
 * `ExecutionAccounting` owns admission, leases, registrations and pressure;
 * this module supplies what only the desktop host has: the host process
 * table reader, Electron's own process metrics, the performance-limit
 * preferences and product copy. Main installs the Electron wake-lock
 * composition and the diagnostics and failure sinks at startup, so modules that only take
 * leases stay light. Each family's daemon enablement composes the same core
 * class there instead.
 */

export interface ExecutionAccountingHost {
  readonly wakeLock: ExecutionWakeLock;
  readonly recordDiagnostic: (record: AppDiagnosticRecord) => void;
  /** Records a sample that threw; reads and the sampling timer drop it. */
  readonly reportSampleFailure: (error: unknown) => void;
}

let host: ExecutionAccountingHost | null = null;

/** Main installs the host ports once, before execution starts. */
export function installExecutionAccountingHost(
  next: ExecutionAccountingHost | null,
): void {
  host = next;
}

export type DesktopExecutionAccounting = ExecutionAccounting<ResourceMetadata>;

const GIB = 1024 * 1024 * 1024;
const DEFAULT_WARNING_FREE_RATIO = 0.12;
const DEFAULT_CRITICAL_FREE_RATIO = 0.08;

const GROUP_LABELS: Record<ExecutionResourceGroupId, string> = {
  app: BRAND.displayName,
  browser: 'Browser',
  codex: 'Codex',
  claude: 'Claude',
  chat: CHAT_LABEL,
  pipelines: 'Pipelines',
  terminal: 'Terminals',
  scripts: 'Script',
  other: 'Other',
};

interface ResourceThresholds {
  warningMemoryBytes: number;
  criticalMemoryBytes: number;
  warningFreeRatio: number;
  criticalFreeRatio: number;
}

const rejectedOverrideWarnings = new Set<string>();
let cachedThresholds: {
  version: number;
  thresholds: ResourceThresholds;
} | null = null;

function readRatioEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value >= 1) {
    return undefined;
  }
  return value;
}

function recordRejectedOverrideWarning(reason: string): void {
  if (rejectedOverrideWarnings.has(reason)) {
    return;
  }
  rejectedOverrideWarnings.add(reason);
  host?.recordDiagnostic({
    version: 1,
    timestamp: new Date().toISOString(),
    kind: 'resource_monitor_config_warning',
    reason,
    memoryRssBytes: 0,
  });
}

function computeThresholds(): ResourceThresholds {
  const totalMemory = os.totalmem();
  const defaultWarningMemoryBytes = Math.min(
    2 * GIB,
    Math.floor(totalMemory * 0.5),
  );
  const defaultCriticalMemoryBytes = Math.min(
    4 * GIB,
    Math.floor(totalMemory * 0.7),
  );

  let warningMemoryBytes =
    getPerformanceLimits().memoryPressureWarningThresholdBytes;
  let criticalMemoryBytes =
    getPerformanceLimits().memoryPressureCriticalThresholdBytes;

  if (criticalMemoryBytes <= warningMemoryBytes) {
    warningMemoryBytes = Math.min(
      DEFAULT_MEMORY_PRESSURE_WARNING_THRESHOLD_BYTES,
      defaultWarningMemoryBytes,
    );
    criticalMemoryBytes = Math.min(
      DEFAULT_MEMORY_PRESSURE_CRITICAL_THRESHOLD_BYTES,
      defaultCriticalMemoryBytes,
    );
    recordRejectedOverrideWarning(
      'Invalid resource monitor memory threshold override',
    );
  }

  let warningFreeRatio =
    readRatioEnv('CANOPY_RESOURCE_WARNING_FREE_RATIO') ??
    DEFAULT_WARNING_FREE_RATIO;
  let criticalFreeRatio =
    readRatioEnv('CANOPY_RESOURCE_CRITICAL_FREE_RATIO') ??
    DEFAULT_CRITICAL_FREE_RATIO;
  if (criticalFreeRatio >= warningFreeRatio) {
    warningFreeRatio = DEFAULT_WARNING_FREE_RATIO;
    criticalFreeRatio = DEFAULT_CRITICAL_FREE_RATIO;
    recordRejectedOverrideWarning(
      'Invalid resource monitor free-memory ratio override',
    );
  }

  return {
    warningMemoryBytes,
    criticalMemoryBytes,
    warningFreeRatio,
    criticalFreeRatio,
  };
}

function buildThresholds(): ResourceThresholds {
  const version = getPerformanceLimitsVersion();
  if (cachedThresholds?.version !== version) {
    cachedThresholds = { version, thresholds: computeThresholds() };
  }
  return cachedThresholds.thresholds;
}

function desktopLimits(): ExecutionAccountingLimits {
  const limits = getPerformanceLimits();
  const thresholds = buildThresholds();
  return {
    maxActive: { pipeline: limits.maxActivePipelineExecutions },
    maxActiveChatTurns: limits.maxActiveChatTurns,
    memoryGuardEnabled: limits.memoryPressureGuardEnabled,
    warningMemoryBytes: thresholds.warningMemoryBytes,
    criticalMemoryBytes: thresholds.criticalMemoryBytes,
  };
}

function logicalCpuCount(): number {
  const count = os.cpus().length;
  return Number.isInteger(count) && count > 0 ? count : 1;
}

function clampCpuPercent(percent: number): number {
  if (!Number.isFinite(percent) || percent <= 0) {
    return 0;
  }
  return Math.min(100, percent);
}

function normalizeElectronCpuPercent(percent: number): number {
  if (percent > 100) {
    return clampCpuPercent(percent / logicalCpuCount());
  }
  return clampCpuPercent(percent);
}

function metricKind(metricType: string): ResourceProcessKind {
  if (metricType === 'Browser') {
    return 'electron-main';
  }
  if (metricType === 'GPU') {
    return 'electron-gpu';
  }
  if (metricType === 'Utility') {
    return 'electron-utility';
  }
  return 'electron-renderer';
}

function metricLabel(metricType: string): string {
  if (metricType === 'Browser') {
    return 'Electron main';
  }
  if (metricType === 'GPU') {
    return 'Electron GPU';
  }
  if (metricType === 'Utility') {
    return 'Electron utility';
  }
  return 'Electron renderer';
}

function isProcessMetric(value: unknown): value is ProcessMetric {
  if (!isRecord(value)) {
    return false;
  }
  const { pid, type, cpu, memory } = value;
  return (
    typeof pid === 'number' &&
    typeof type === 'string' &&
    isRecord(cpu) &&
    typeof cpu.percentCPUUsage === 'number' &&
    isRecord(memory) &&
    typeof memory.workingSetSize === 'number'
  );
}

interface ElectronAppMetricsProvider {
  getAppMetrics: () => unknown;
}

function isElectronAppMetricsProvider(
  value: unknown,
): value is ElectronAppMetricsProvider {
  return isRecord(value) && typeof value.getAppMetrics === 'function';
}

function getElectronAppMetrics(): ProcessMetric[] {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electronModule: unknown = require('electron');
    if (!isRecord(electronModule)) {
      return [];
    }
    const { app } = electronModule;
    if (!isElectronAppMetricsProvider(app)) {
      return [];
    }
    const metrics: unknown = app.getAppMetrics();
    return Array.isArray(metrics) ? metrics.filter(isProcessMetric) : [];
  } catch {
    return [];
  }
}

/** Electron's own processes, measured by Electron rather than the table. */
function electronProcessRows(): ResourceProcessSnapshot[] {
  return getElectronAppMetrics().map((metric) => ({
    id: `electron:${metric.pid}`,
    kind: metricKind(metric.type),
    groupId: 'app',
    label: metricLabel(metric.type),
    pid: metric.pid,
    cpuPercent: normalizeElectronCpuPercent(metric.cpu.percentCPUUsage),
    memoryRssBytes: metric.memory.workingSetSize * 1024,
    processCount: 1,
    status: 'running',
  }));
}

type ProcessTableReader = PlatformSupervisionServices['readProcessTable'];

// One reader per platform keeps its CPU baseline between samples.
const readers = new Map<PlatformOperatingSystem, ProcessTableReader>();

function readHostProcessTable(
  request?: PlatformProcessTableRequest,
): Promise<PlatformProcessTable> {
  const platform = hostPlatformOperatingSystem();
  let reader = readers.get(platform);
  if (!reader) {
    reader = createProcessTableReader(platform);
    readers.set(platform, reader);
  }
  return reader(request);
}

/**
 * Memory admission counts the daemon whose status this app follows, whoever
 * launched it (CAN-5695), merged as the resource monitor shows it so each
 * process counts once. With no current status (unreachable, older, dropped
 * or idle daemon) it counts this app's own tree, which holds a daemon it
 * launched.
 */
function guardMemoryBytes(
  snapshot: ExecutionAccountingSnapshot<ResourceMetadata>,
): number {
  const status = getDaemonExecutionStatus().current();
  return status
    ? mergeDaemonExecutionStatus(snapshot, status, {
        productName: BRAND.displayName,
        now: Date.now(),
      }).memoryRssBytes
    : snapshot.memoryRssBytes;
}

let accounting: DesktopExecutionAccounting | null = null;

export function getExecutionAccounting(): DesktopExecutionAccounting {
  accounting ??= new ExecutionAccounting<ResourceMetadata>({
    rootPid: process.pid,
    readProcessTable: readHostProcessTable,
    hostProcesses: electronProcessRows,
    limits: desktopLimits,
    guardMemoryBytes,
    productName: BRAND.displayName,
    groupLabel: (id): string => GROUP_LABELS[id],
    executionIdOf: (metadata): string | undefined =>
      metadata?.type === 'pipeline' ? metadata.pipeline.executionId : undefined,
    onSampleFailure: (error): void => {
      host?.reportSampleFailure(error);
    },
    wakeLock: {
      acquire: (key, reason): void => {
        host?.wakeLock.acquire(key, reason);
      },
      release: (key): void => {
        host?.wakeLock.release(key);
      },
    },
  });
  return accounting;
}

/**
 * Drops registrations, pending starts and CPU baselines at shutdown. Leases
 * stay with their work, which keeps its own lifetime.
 */
export function resetExecutionAccountingSamples(): void {
  readers.clear();
  accounting?.dispose();
}

/** Releases `lease` together with the work's resource registration. */
export function withExecutionLease(
  lease: ExecutionLease,
  handle: ResourceRegistrationHandle,
): ResourceRegistrationHandle {
  return {
    update: (update): void => {
      handle.update(update);
    },
    unregister: (): void => {
      handle.unregister();
      lease.release();
    },
  };
}
