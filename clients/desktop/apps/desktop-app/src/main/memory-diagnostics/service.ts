import * as syncFs from 'node:fs';
import {
  chmod,
  mkdir,
  readdir,
  rm,
  stat,
  statfs,
  writeFile,
} from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import * as os from 'node:os';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import type { PlatformOperatingSystem } from '@canopy/core-runtime';
import { app, type ProcessMetric, type WebContents } from 'electron';
import {
  getHeapSpaceStatistics,
  getHeapStatistics,
  writeHeapSnapshot,
  type HeapInfo,
  type HeapSpaceInfo,
} from 'node:v8';
import { getMemoryReportsDir } from '../lib/paths';
import type { MemoryDiagnosticsHost } from './index';
import {
  logMainProcessError,
  logMainProcessWarn,
} from '../lib/main-process-logging';
import type {
  CreateMemoryReportResult,
  MemoryDiagnosticsStatus,
  MemoryReportKind,
  MemoryReportSummary,
} from '@canopy/desktop-shared/types';
import type { Session as InspectorSession } from 'node:inspector';
import {
  captureNativeMemory,
  NATIVE_DUMP_WAIT_MS,
  NativeMemoryTraceCleanupError,
  type NativeMemorySummary,
} from './native-memory';

const AUTO_DUMP_INTERVAL_MS = 15_000;
const AUTO_DUMP_MIN_INTERVAL_MS = 5 * 60 * 1000;
const AUTO_DUMP_HEAP_THRESHOLD = 0.8;
/**
 * V8 needs roughly the heap's size again to write a snapshot, and fails fatally
 * (killing the process) when it can't. Above this fraction of the heap limit the
 * manual report skips main's snapshot rather than risk that crash.
 */
const MAIN_SNAPSHOT_MAX_HEAP_FRACTION = 0.5;
const SAMPLING_INTERVAL_BYTES = 512 * 1024;
const GIBIBYTE_BYTES = 1024 * 1024 * 1024;
const ESTIMATED_SECONDS_PER_GIBIBYTE = 25;
const FALLBACK_RENDERER_MEMORY_BYTES = 256 * 1024 * 1024;
const REPORT_RETENTION_COUNT = 3;
const AUTO_DUMP_RETENTION_COUNT = 5;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const REPORT_ID_PATTERN = /^report-\d{8}T\d{6}Z(?:-[1-9]\d*)?$/;
const AUTO_DUMP_ID_PATTERN = /^auto-\d{8}T\d{6}Z(?:-[1-9]\d*)?$/;

interface InspectorProfileResult {
  readonly profile: object;
}

interface ActiveRenderer {
  readonly label: string;
  readonly webContents: WebContents;
  readonly processId: number | null;
}

type RendererMetricSource =
  | 'privateBytes'
  | 'workingSetSize'
  | 'conservativeFallback'
  | 'mixed'
  | 'unavailable';
type MetricBackedRendererMemorySource = 'privateBytes' | 'workingSetSize';

interface RendererMemoryEstimate {
  readonly bytes: number;
  readonly source: RendererMetricSource;
  readonly rendererCount: number;
  readonly estimatedProcessCount: number;
  readonly fallbackBytesPerProcess: number;
}

interface MemoryDiagnosticsMeasurements {
  readonly heapStatistics: HeapInfo;
  readonly heapSpaceStatistics: readonly HeapSpaceInfo[];
  readonly processMemoryUsage: NodeJS.MemoryUsage;
  readonly appMetrics: readonly ProcessMetric[];
  readonly renderers: readonly ActiveRenderer[];
  readonly rendererMemoryEstimate: RendererMemoryEstimate;
}

interface RendererHeapUsage {
  readonly usedSize: number;
  readonly totalSize: number;
  readonly embedderHeapUsedSize?: number;
  readonly backingStorageSize?: number;
}

interface RendererDomCounters {
  readonly documents: number;
  readonly nodes: number;
  readonly jsEventListeners: number;
}

type RendererStatisticsUnavailableReason =
  | 'debugger-attached'
  | 'attach-failed'
  | 'command-failed'
  | 'timeout'
  | 'invalid-result';

type RendererStatistics =
  | {
      readonly heapUsage: RendererHeapUsage;
      readonly domCounters: RendererDomCounters;
    }
  | {
      readonly statisticsUnavailableReason: RendererStatisticsUnavailableReason;
    };

interface RendererSnapshotSummary {
  readonly label: string;
  readonly processId: number | null;
  readonly fileName: string;
  readonly heapUsage?: RendererHeapUsage;
  readonly domCounters?: RendererDomCounters;
  readonly statisticsUnavailableReason?: RendererStatisticsUnavailableReason;
}

interface MemoryDiagnosticsProcessHistory {
  readonly reportsWrittenBefore: number;
  readonly automaticDumpsWrittenBefore: number;
  readonly mainSnapshotsWrittenBefore: number;
  readonly processUptimeSeconds: number;
}

type MainSnapshotSkippedReason = 'insufficient-heap-headroom';

/**
 * The main-snapshot decision and the heap reading it used, taken just before
 * the snapshot (after the renderer snapshots), so it can differ from
 * `heapStatistics`.
 */
type MainSnapshotSummary =
  | {
      readonly included: true;
      readonly usedHeapBytes: number;
      readonly heapLimitBytes: number;
    }
  | {
      readonly included: false;
      readonly skippedReason: MainSnapshotSkippedReason;
      readonly usedHeapBytes: number;
      readonly heapLimitBytes: number;
    };

interface MemoryDiagnosticsSummaryFile {
  readonly version: 1;
  readonly reportId: string;
  readonly kind: MemoryReportKind;
  readonly createdAt: string;
  readonly appVersion: string;
  readonly electronVersion: string;
  readonly nodeVersion: string;
  readonly chromeVersion: string;
  readonly operatingSystem: {
    readonly platform: PlatformOperatingSystem | null;
    readonly release: string;
    readonly arch: string;
  };
  readonly processMemoryUsage: NodeJS.MemoryUsage;
  readonly heapStatistics: HeapInfo;
  readonly heapSpaceStatistics: readonly HeapSpaceInfo[];
  readonly appMetrics: readonly ProcessMetric[];
  readonly rendererMemoryEstimate: RendererMemoryEstimate;
  readonly rendererSnapshots: readonly RendererSnapshotSummary[];
  readonly processHistory?: MemoryDiagnosticsProcessHistory;
  /** Manual reports only: one Chromium memory-infra dump, before any snapshot. */
  readonly nativeMemory?: NativeMemorySummary;
  /** Manual reports only, set once main's snapshot is written or skipped. */
  readonly mainSnapshot?: MainSnapshotSummary;
  readonly sampling: {
    readonly active: boolean;
    readonly included: boolean;
    readonly unavailableReason: string | null;
  };
  readonly report: MemoryReportSummary;
}

interface CreatedReportDirectory {
  readonly id: string;
  readonly path: string;
  readonly root: string;
}

let lastGeneratedTimestamp = 0;

function isInspectorProfileResult(
  value: object,
): value is InspectorProfileResult {
  return (
    'profile' in value &&
    typeof value.profile === 'object' &&
    value.profile !== null
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isRendererHeapUsage(value: unknown): value is RendererHeapUsage {
  if (
    !isRecord(value) ||
    !isNonNegativeFiniteNumber(value.usedSize) ||
    !isNonNegativeFiniteNumber(value.totalSize)
  ) {
    return false;
  }

  if (
    value.embedderHeapUsedSize !== undefined &&
    !isNonNegativeFiniteNumber(value.embedderHeapUsedSize)
  ) {
    return false;
  }
  if (
    value.backingStorageSize !== undefined &&
    !isNonNegativeFiniteNumber(value.backingStorageSize)
  ) {
    return false;
  }
  return true;
}

function isRendererDomCounters(value: unknown): value is RendererDomCounters {
  return (
    isRecord(value) &&
    isNonNegativeFiniteNumber(value.documents) &&
    isNonNegativeFiniteNumber(value.nodes) &&
    isNonNegativeFiniteNumber(value.jsEventListeners)
  );
}

function sendRendererCommandWithTimeout(
  debuggerClient: WebContents['debugger'],
  method: string,
  timeoutError: Error,
): Promise<unknown> {
  const timeoutSignal = AbortSignal.timeout(5_000);
  const commandPromise: Promise<unknown> = debuggerClient.sendCommand(method);
  let rejectOnTimeout: (() => void) | undefined;
  const timeoutPromise: Promise<never> = new Promise<never>(
    (_resolve, reject) => {
      rejectOnTimeout = (): void => reject(timeoutError);
      timeoutSignal.addEventListener('abort', rejectOnTimeout, { once: true });
      if (timeoutSignal.aborted) {
        rejectOnTimeout();
      }
    },
  );

  return Promise.race([commandPromise, timeoutPromise]).finally((): void => {
    if (rejectOnTimeout !== undefined) {
      timeoutSignal.removeEventListener('abort', rejectOnTimeout);
    }
  });
}

async function readRendererStatistics(
  debuggerClient: WebContents['debugger'],
): Promise<RendererStatistics> {
  let debuggerAttached: boolean;
  try {
    debuggerAttached = debuggerClient.isAttached();
  } catch {
    return { statisticsUnavailableReason: 'command-failed' };
  }
  if (debuggerAttached) {
    return { statisticsUnavailableReason: 'debugger-attached' };
  }

  const timeoutError = new Error('Renderer statistics command timed out.');
  let commandStage = false;
  try {
    debuggerClient.attach('1.3');
    commandStage = true;
    const heapUsage: unknown = await sendRendererCommandWithTimeout(
      debuggerClient,
      'Runtime.getHeapUsage',
      timeoutError,
    );
    const domCounters: unknown = await sendRendererCommandWithTimeout(
      debuggerClient,
      'Memory.getDOMCounters',
      timeoutError,
    );
    if (
      !isRendererHeapUsage(heapUsage) ||
      !isRendererDomCounters(domCounters)
    ) {
      return { statisticsUnavailableReason: 'invalid-result' };
    }
    const normalizedHeapUsage: RendererHeapUsage = {
      usedSize: heapUsage.usedSize,
      totalSize: heapUsage.totalSize,
      ...(heapUsage.embedderHeapUsedSize === undefined
        ? {}
        : { embedderHeapUsedSize: heapUsage.embedderHeapUsedSize }),
      ...(heapUsage.backingStorageSize === undefined
        ? {}
        : { backingStorageSize: heapUsage.backingStorageSize }),
    };
    const normalizedDomCounters: RendererDomCounters = {
      documents: domCounters.documents,
      nodes: domCounters.nodes,
      jsEventListeners: domCounters.jsEventListeners,
    };
    return {
      heapUsage: normalizedHeapUsage,
      domCounters: normalizedDomCounters,
    };
  } catch (error: unknown) {
    if (!commandStage) {
      return { statisticsUnavailableReason: 'attach-failed' };
    }
    return {
      statisticsUnavailableReason:
        error === timeoutError ? 'timeout' : 'command-failed',
    };
  } finally {
    try {
      debuggerClient.detach();
    } catch {
      // Detach must not prevent the renderer snapshot from being written.
    }
  }
}

function inspectorCommand(
  session: InspectorSession,
  method: string,
  params?: object,
): Promise<object> {
  return new Promise((resolveCommand, rejectCommand) => {
    const callback = (error: Error | null, result?: object): void => {
      if (error !== null) {
        rejectCommand(error);
        return;
      }
      resolveCommand(result ?? {});
    };

    if (params === undefined) {
      session.post(method, callback);
      return;
    }
    session.post(method, params, callback);
  });
}

function errorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error) || error.message.length === 0) {
    return fallback;
  }
  return error.message.slice(0, 240);
}

/**
 * A failed capture records why and never fails the report, except a raw trace
 * that could not be deleted: that fails the report and removes its folder.
 */
async function readNativeMemory(
  tracePath: string,
  appMetrics: readonly ProcessMetric[],
): Promise<NativeMemorySummary> {
  const startedAt = Date.now();
  try {
    return await captureNativeMemory(
      tracePath,
      appMetrics,
      NATIVE_DUMP_WAIT_MS,
    );
  } catch (error) {
    if (error instanceof NativeMemoryTraceCleanupError) throw error;
    logMainProcessError('Memory report native memory capture failed', error);
    return {
      captured: false,
      unavailableReason: errorMessage(
        error,
        'The native memory trace could not be recorded.',
      ),
      durationMs: Date.now() - startedAt,
      processes: [],
      missingProcessIds: [],
    };
  }
}

function isWithinDirectory(directory: string, candidate: string): boolean {
  const pathFromDirectory = relative(directory, candidate);
  return (
    pathFromDirectory.length > 0 &&
    pathFromDirectory !== '..' &&
    !pathFromDirectory.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromDirectory)
  );
}

function resolveRealPath(path: string): string {
  return syncFs.realpathSync(path);
}

function isRealDirectory(path: string): boolean {
  if (!syncFs.existsSync(path)) {
    return false;
  }
  const fileStats = syncFs.lstatSync(path);
  return fileStats.isDirectory() && !fileStats.isSymbolicLink();
}

function ensurePrivateRegularFile(path: string): void {
  const fileStats = syncFs.lstatSync(path);
  if (!fileStats.isFile() || fileStats.isSymbolicLink()) {
    throw new Error('Memory report output is not a regular file.');
  }
}

function getRendererProcessId(webContents: WebContents): number | null {
  try {
    if (typeof webContents.getOSProcessId !== 'function') {
      return null;
    }
    const processId = webContents.getOSProcessId();
    return Number.isSafeInteger(processId) && processId > 0 ? processId : null;
  } catch {
    return null;
  }
}

function sanitizeRendererLabel(label: string): string {
  const sanitized = label
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return sanitized.length > 0 ? sanitized : 'app';
}

function formatTimestamp(timestamp: number): string {
  return new Date(timestamp)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

function nextDirectoryTimestamp(): number {
  const timestamp = Math.max(Date.now(), lastGeneratedTimestamp + 1);
  lastGeneratedTimestamp = timestamp;
  return timestamp;
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}

function getMetricBytes(metric: ProcessMetric): {
  readonly bytes: number;
  readonly source: MetricBackedRendererMemorySource;
} | null {
  // Electron's renderer process metrics are KiB-based, not JS heap sizes. The
  // private-memory value is preferred; workingSetSize is the documented
  // fallback when the private estimate is missing. Both are intentionally
  // approximate and include renderer memory beyond V8's managed heap.
  const privateBytes = metric.memory.privateBytes;
  if (
    typeof privateBytes === 'number' &&
    Number.isFinite(privateBytes) &&
    privateBytes > 0
  ) {
    return { bytes: Math.round(privateBytes * 1024), source: 'privateBytes' };
  }
  const workingSetSize = metric.memory.workingSetSize;
  if (Number.isFinite(workingSetSize) && workingSetSize > 0) {
    return {
      bytes: Math.round(workingSetSize * 1024),
      source: 'workingSetSize',
    };
  }
  return null;
}

function collectActiveRenderers(
  host: MemoryDiagnosticsHost,
): readonly ActiveRenderer[] {
  const targets = host.getAppRenderers();
  const activeRenderers: ActiveRenderer[] = [];

  for (const target of targets) {
    if (target.webContents.isDestroyed()) {
      continue;
    }
    const processId = getRendererProcessId(target.webContents);
    activeRenderers.push({
      label: sanitizeRendererLabel(target.label),
      webContents: target.webContents,
      processId,
    });
  }
  return activeRenderers;
}

function estimateRendererMemory(
  renderers: readonly ActiveRenderer[],
  metrics: readonly ProcessMetric[],
): RendererMemoryEstimate {
  const metricsByProcessId = new Map<number, ProcessMetric>();
  for (const metric of metrics) {
    if (!metricsByProcessId.has(metric.pid)) {
      metricsByProcessId.set(metric.pid, metric);
    }
  }

  let bytes = 0;
  const sources = new Set<
    MetricBackedRendererMemorySource | 'conservativeFallback'
  >();
  const seenRendererProcessIds = new Set<number>();
  let estimatedProcessCount = 0;
  for (const renderer of renderers) {
    if (renderer.processId !== null) {
      if (seenRendererProcessIds.has(renderer.processId)) {
        continue;
      }
      seenRendererProcessIds.add(renderer.processId);
    }
    estimatedProcessCount += 1;
    const metric =
      renderer.processId === null
        ? undefined
        : metricsByProcessId.get(renderer.processId);
    const estimate = metric === undefined ? null : getMetricBytes(metric);
    if (estimate === null) {
      // Electron metrics can be absent during process startup or teardown. A
      // 256 MiB per-process fallback is deliberately conservative so disk
      // checks and freeze-time estimates do not treat an unknown renderer as 0.
      bytes += FALLBACK_RENDERER_MEMORY_BYTES;
      sources.add('conservativeFallback');
    } else {
      bytes += estimate.bytes;
      sources.add(estimate.source);
    }
  }

  const source: RendererMetricSource =
    sources.size === 0
      ? 'unavailable'
      : sources.size > 1
        ? 'mixed'
        : (sources.values().next().value ?? 'unavailable');
  return {
    bytes,
    source,
    rendererCount: renderers.length,
    estimatedProcessCount,
    fallbackBytesPerProcess: FALLBACK_RENDERER_MEMORY_BYTES,
  };
}

function estimatedReportSeconds(
  mainHeapUsedBytes: number,
  rendererBytes: number,
  enabled: boolean,
): number {
  if (!enabled) {
    return 0;
  }
  const totalBytes = mainHeapUsedBytes + rendererBytes;
  return (
    Math.max(
      1,
      Math.ceil((totalBytes / GIBIBYTE_BYTES) * ESTIMATED_SECONDS_PER_GIBIBYTE),
    ) + Math.ceil(NATIVE_DUMP_WAIT_MS / 1000)
  );
}

function makeMemoryReportSummary(
  reportId: string,
  kind: MemoryReportKind,
  createdAt: string,
  fileCount: number,
  totalBytes: number,
  durationMs: number,
  samplingIncluded: boolean,
): MemoryReportSummary {
  return {
    reportId,
    kind,
    createdAt,
    fileCount,
    totalBytes,
    durationMs,
    samplingIncluded,
  };
}

async function ensureReportsRoot(): Promise<string> {
  const reportsPath = resolve(getMemoryReportsDir());
  await mkdir(reportsPath, { recursive: true, mode: DIRECTORY_MODE });
  // The reports folder itself must not be a symlink. Its ancestors may be (for
  // example a symlinked home), so the canonical path becomes the trust root.
  if (!isRealDirectory(reportsPath)) {
    throw new Error('Memory report storage is not a directory.');
  }
  const reportsRoot = resolveRealPath(reportsPath);
  await chmod(reportsRoot, DIRECTORY_MODE);
  return reportsRoot;
}

function safeDirectChild(parent: string, childName: string): string {
  if (
    childName.length === 0 ||
    basename(childName) !== childName ||
    childName.includes('/') ||
    childName.includes('\\')
  ) {
    throw new Error('Unsafe memory diagnostics path.');
  }
  const childPath = resolve(parent, childName);
  if (!isWithinDirectory(parent, childPath)) {
    throw new Error('Unsafe memory diagnostics path.');
  }
  return childPath;
}

async function createOutputDirectory(
  root: string,
  kind: MemoryReportKind | 'auto',
): Promise<CreatedReportDirectory> {
  const timestamp = formatTimestamp(nextDirectoryTimestamp());
  for (let suffix = 0; suffix < Number.MAX_SAFE_INTEGER; suffix += 1) {
    const id = `${kind}-${timestamp}${suffix === 0 ? '' : `-${suffix}`}`;
    const path = safeDirectChild(root, id);
    try {
      await mkdir(path, { mode: DIRECTORY_MODE });
    } catch (error) {
      if (isNodeErrorCode(error, 'EEXIST')) {
        continue;
      }
      throw error;
    }
    try {
      const canonicalPath = resolveRealPath(path);
      if (
        canonicalPath !== path ||
        !isWithinDirectory(root, canonicalPath) ||
        !isRealDirectory(path)
      ) {
        throw new Error('Memory report directory escaped its private root.');
      }
      await chmod(path, DIRECTORY_MODE);
      return { id, path, root };
    } catch (error) {
      try {
        if (isRealDirectory(path)) {
          const canonicalPath = resolveRealPath(path);
          if (
            canonicalPath === path &&
            isWithinDirectory(root, canonicalPath)
          ) {
            await rm(path, { recursive: true, force: true });
          }
        }
      } catch (cleanupError) {
        logMainProcessError(
          'Memory diagnostics could not remove an incomplete output directory',
          cleanupError,
        );
      }
      throw error;
    }
  }
  throw new Error('Could not allocate a unique memory report directory.');
}

async function writePrivateFile(
  path: string,
  contents: string,
  replaceExisting = false,
): Promise<void> {
  await writeFile(path, contents, {
    encoding: 'utf8',
    flag: replaceExisting ? 'w' : 'wx',
    mode: FILE_MODE,
  });
  ensurePrivateRegularFile(path);
  await chmod(path, FILE_MODE);
}

async function writeJsonFile(
  path: string,
  value: object,
  replaceExisting = false,
): Promise<void> {
  await writePrivateFile(
    path,
    `${JSON.stringify(value, null, 2)}\n`,
    replaceExisting,
  );
}

async function collectFlatFileSizes(
  directory: string,
): Promise<readonly { readonly path: string; readonly size: number }[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: { path: string; size: number }[] = [];
  for (const entry of entries) {
    if (typeof entry.isFile !== 'function' || !entry.isFile()) {
      continue;
    }
    const path = safeDirectChild(directory, entry.name);
    const fileStats = await stat(path);
    files.push({ path, size: fileStats.size });
  }
  return files;
}

async function finalizeSummaryFile(
  directory: string,
  summaryPath: string,
  summaryWithoutReport: Omit<MemoryDiagnosticsSummaryFile, 'report'>,
  createdAtMs: number,
  samplingIncluded: boolean,
): Promise<MemoryReportSummary> {
  const durationMs = Math.max(0, Date.now() - createdAtMs);
  const initialSummary = makeMemoryReportSummary(
    summaryWithoutReport.reportId,
    summaryWithoutReport.kind,
    summaryWithoutReport.createdAt,
    0,
    0,
    durationMs,
    samplingIncluded,
  );
  let currentSummary = initialSummary;

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const summary: MemoryDiagnosticsSummaryFile = {
      ...summaryWithoutReport,
      sampling: {
        ...summaryWithoutReport.sampling,
        included: samplingIncluded,
      },
      report: currentSummary,
    };
    await writeJsonFile(summaryPath, summary, true);
    const files = await collectFlatFileSizes(directory);
    const nextSummary = makeMemoryReportSummary(
      summaryWithoutReport.reportId,
      summaryWithoutReport.kind,
      summaryWithoutReport.createdAt,
      files.length,
      files.reduce((total, file) => total + file.size, 0),
      durationMs,
      samplingIncluded,
    );
    if (
      nextSummary.fileCount === currentSummary.fileCount &&
      nextSummary.totalBytes === currentSummary.totalBytes &&
      nextSummary.durationMs === currentSummary.durationMs
    ) {
      return nextSummary;
    }
    currentSummary = nextSummary;
  }
  throw new Error('The memory report summary did not converge.');
}

async function pruneOutputDirectories(
  root: string,
  kind: MemoryReportKind | 'auto',
  keepCount: number,
): Promise<void> {
  // Retention is best-effort: a stuck old folder (for example a snapshot open
  // in a viewer) must not fail, or delete, the capture that was just written.
  const entries = await readdir(root, { withFileTypes: true }).catch(
    (error: unknown) => {
      logMainProcessError(
        'Memory diagnostics could not list old reports',
        error,
      );
      return [];
    },
  );
  const pattern = kind === 'report' ? REPORT_ID_PATTERN : AUTO_DUMP_ID_PATTERN;
  const candidates = entries
    .filter((entry) => entry.isDirectory() && pattern.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => {
      const leftTimestamp = left.replace(/-[1-9]\d*$/, '');
      const rightTimestamp = right.replace(/-[1-9]\d*$/, '');
      if (leftTimestamp !== rightTimestamp) {
        return rightTimestamp.localeCompare(leftTimestamp);
      }
      const leftSuffix = /-([1-9]\d*)$/.exec(left);
      const rightSuffix = /-([1-9]\d*)$/.exec(right);
      const leftCollision = leftSuffix === null ? 0 : Number(leftSuffix[1]);
      const rightCollision = rightSuffix === null ? 0 : Number(rightSuffix[1]);
      return rightCollision - leftCollision;
    });

  for (const directoryName of candidates.slice(keepCount)) {
    try {
      const path = safeDirectChild(root, directoryName);
      if (!isRealDirectory(path)) {
        continue;
      }
      const canonicalPath = resolveRealPath(path);
      if (canonicalPath !== path || !isWithinDirectory(root, canonicalPath)) {
        continue;
      }
      await rm(canonicalPath, { recursive: true, force: true });
    } catch (error) {
      logMainProcessError(
        'Memory diagnostics could not remove an old report',
        error,
      );
    }
  }
}

function getProfileFileContents(value: object): string | null {
  if (!isInspectorProfileResult(value)) {
    return null;
  }
  return JSON.stringify(value.profile) ?? null;
}

class MemoryDiagnosticsServiceImpl {
  private enabled = false;
  private disposed = false;
  private samplingActive = false;
  private samplingUnavailableReason: string | null = null;
  private reportInProgress = false;
  private lastReport: MemoryReportSummary | null = null;
  private lastAutomaticDumpAt = 0;
  private reportsWritten = 0;
  private automaticDumpsWritten = 0;
  private mainSnapshotsWritten = 0;
  private generation = 0;
  private timer: NodeJS.Timeout | null = null;
  private samplingSession: InspectorSession | null = null;
  private samplingQueue: Promise<void> | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  public constructor(private readonly host: MemoryDiagnosticsHost) {}

  private getProcessHistory(): MemoryDiagnosticsProcessHistory {
    return {
      reportsWrittenBefore: this.reportsWritten,
      automaticDumpsWrittenBefore: this.automaticDumpsWritten,
      mainSnapshotsWrittenBefore: this.mainSnapshotsWritten,
      processUptimeSeconds: Math.round(process.uptime()),
    };
  }

  private recordSuccessfulReport(kind: MemoryReportKind): void {
    this.reportsWritten += 1;
    if (kind === 'auto') {
      this.automaticDumpsWritten += 1;
    }
  }

  public setEnabled(enabled: boolean): void {
    if (this.disposed || this.enabled === enabled) {
      return;
    }
    this.enabled = enabled;
    const generation = this.generation + 1;
    this.generation = generation;

    if (enabled) {
      this.samplingUnavailableReason = null;
      this.startAutomaticDumpTimer();
      void this.enqueueSampling(() => this.startSampling(generation)).catch(
        (error: unknown) => {
          logMainProcessError(
            'Memory diagnostics sampling startup failed',
            error,
          );
        },
      );
      return;
    }

    this.clearAutomaticDumpTimer();
    this.samplingActive = false;
    this.samplingUnavailableReason = null;
    void this.enqueueSampling(() => this.stopSampling()).catch(
      (error: unknown) => {
        logMainProcessError(
          'Memory diagnostics sampling shutdown failed',
          error,
        );
      },
    );
  }

  public async getStatus(): Promise<MemoryDiagnosticsStatus> {
    const samplingQueue = this.samplingQueue;
    if (samplingQueue !== null) {
      await samplingQueue;
    }
    const heapStatistics = getHeapStatistics();
    let renderers: readonly ActiveRenderer[] = [];
    let metrics: readonly ProcessMetric[] = [];
    try {
      renderers = collectActiveRenderers(this.host);
    } catch (error) {
      logMainProcessError(
        'Memory diagnostics could not list app renderers',
        error,
      );
    }
    if (this.enabled) {
      try {
        metrics = app.getAppMetrics();
      } catch (error) {
        logMainProcessError(
          'Memory diagnostics could not read app metrics',
          error,
        );
      }
    }
    const rendererMemoryBytes = this.enabled
      ? estimateRendererMemory(renderers, metrics).bytes
      : 0;
    return {
      enabled: this.enabled,
      samplingActive: this.samplingActive,
      samplingUnavailableReason: this.enabled
        ? this.samplingUnavailableReason
        : null,
      mainHeapUsedBytes: heapStatistics.used_heap_size,
      mainHeapLimitBytes: heapStatistics.heap_size_limit,
      rendererCount: renderers.length,
      estimatedReportSeconds: estimatedReportSeconds(
        heapStatistics.used_heap_size,
        rendererMemoryBytes,
        this.enabled,
      ),
      reportInProgress: this.reportInProgress,
      lastReport: this.lastReport,
    };
  }

  public createReport(): Promise<CreateMemoryReportResult> {
    if (!this.enabled || this.disposed) {
      return Promise.resolve({
        ok: false,
        reason: 'disabled',
        message: 'Enable memory diagnostics before creating a report.',
      });
    }
    if (this.reportInProgress) {
      return Promise.resolve({
        ok: false,
        reason: 'in-progress',
        message: 'A memory report is already in progress.',
      });
    }

    this.reportInProgress = true;
    return this.enqueueWrite(() => this.createReportSerialized()).finally(
      () => {
        this.reportInProgress = false;
      },
    );
  }

  public resolveReportPath(reportId: string): string | null {
    if (
      !REPORT_ID_PATTERN.test(reportId) &&
      !AUTO_DUMP_ID_PATTERN.test(reportId)
    ) {
      return null;
    }
    try {
      const configuredRoot = resolve(getMemoryReportsDir());
      if (!isRealDirectory(configuredRoot)) {
        return null;
      }
      const reportsRoot = resolveRealPath(configuredRoot);
      const reportPath = safeDirectChild(reportsRoot, reportId);
      if (!isRealDirectory(reportPath)) {
        return null;
      }
      const canonicalPath = resolveRealPath(reportPath);
      if (
        canonicalPath !== reportPath ||
        !isWithinDirectory(reportsRoot, canonicalPath)
      ) {
        return null;
      }
      return canonicalPath;
    } catch {
      return null;
    }
  }

  public async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.enabled = false;
    this.generation += 1;
    this.samplingActive = false;
    this.samplingUnavailableReason = null;
    this.clearAutomaticDumpTimer();
    await this.enqueueSampling(() => this.stopSampling());
    await this.writeQueue;
  }

  private enqueueSampling<T>(work: () => Promise<T>): Promise<T> {
    if (this.samplingQueue === null) {
      let result: Promise<T>;
      try {
        result = work();
      } catch (error) {
        result = Promise.reject(
          error instanceof Error
            ? error
            : new Error('Memory diagnostics sampling failed'),
        );
      }
      this.trackSamplingQueue(result);
      return result;
    }
    const result = this.samplingQueue.then(work, work);
    this.trackSamplingQueue(result);
    return result;
  }

  private trackSamplingQueue<T>(result: Promise<T>): void {
    const queue = result.then(
      (): void => undefined,
      (): void => undefined,
    );
    this.samplingQueue = queue;
    void queue.then(() => {
      if (this.samplingQueue === queue) {
        this.samplingQueue = null;
      }
    });
  }

  private enqueueWrite<T>(work: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(work, work);
    this.writeQueue = result.then(
      (): void => undefined,
      (): void => undefined,
    );
    return result;
  }

  private startAutomaticDumpTimer(): void {
    this.clearAutomaticDumpTimer();
    this.timer = setInterval(() => {
      void this.checkAutomaticDump().catch((error: unknown) => {
        logMainProcessError('Memory diagnostics automatic dump failed', error);
      });
    }, AUTO_DUMP_INTERVAL_MS);
    this.timer.unref();
  }

  private clearAutomaticDumpTimer(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async startSampling(generation: number): Promise<void> {
    if (!this.isCurrentGeneration(generation)) {
      return;
    }
    let session: InspectorSession | null = null;
    let profilerEnabled = false;
    let samplingStarted = false;
    try {
      // Packaged main runs as bytecode through vm.Script without a dynamic import callback, so getBuiltinModule keeps inspector loading lazy without import() failing.
      const inspectorModule = process.getBuiltinModule('node:inspector');
      if (!this.isCurrentGeneration(generation)) {
        return;
      }
      session = new inspectorModule.Session();
      this.samplingSession = session;
      session.connect();
      await inspectorCommand(session, 'HeapProfiler.enable');
      profilerEnabled = true;
      if (!this.isCurrentGeneration(generation)) {
        await this.stopSamplingSession(session, false);
        return;
      }
      await inspectorCommand(session, 'HeapProfiler.startSampling', {
        samplingInterval: SAMPLING_INTERVAL_BYTES,
      });
      samplingStarted = true;
      if (!this.isCurrentGeneration(generation)) {
        await this.stopSamplingSession(session, true);
        return;
      }
      this.samplingActive = true;
      this.samplingUnavailableReason = null;
    } catch (error) {
      if (session !== null) {
        if (this.samplingSession === session) {
          this.samplingSession = null;
        }
        this.samplingActive = false;
        await this.stopSamplingSession(
          session,
          samplingStarted,
          profilerEnabled,
        );
      }
      if (this.isCurrentGeneration(generation)) {
        this.samplingUnavailableReason = errorMessage(
          error,
          'The allocation sampling profiler could not start.',
        );
      }
      logMainProcessError(
        'Memory diagnostics allocation sampling could not start',
        error,
      );
    }
  }

  private async stopSampling(): Promise<void> {
    const session = this.samplingSession;
    this.samplingSession = null;
    this.samplingActive = false;
    if (session !== null) {
      await this.stopSamplingSession(session, true);
    }
  }

  private async stopSamplingSession(
    session: InspectorSession,
    samplingStarted: boolean,
    profilerEnabled = true,
  ): Promise<void> {
    if (samplingStarted) {
      try {
        await inspectorCommand(session, 'HeapProfiler.stopSampling');
      } catch (error) {
        logMainProcessError(
          'Memory diagnostics sampling could not stop',
          error,
        );
      }
    }
    if (profilerEnabled) {
      try {
        await inspectorCommand(session, 'HeapProfiler.disable');
      } catch (error) {
        logMainProcessError(
          'Memory diagnostics profiler could not disable',
          error,
        );
      }
    }
    try {
      if (this.samplingSession === session) {
        this.samplingSession = null;
      }
      try {
        session.disconnect();
      } catch (error) {
        logMainProcessError(
          'Memory diagnostics inspector session could not disconnect',
          error,
        );
      }
      if (!this.enabled) {
        this.samplingActive = false;
      }
    } finally {
      if (this.samplingSession === session) {
        this.samplingSession = null;
      }
    }
  }

  private isCurrentGeneration(generation: number): boolean {
    return this.enabled && !this.disposed && this.generation === generation;
  }

  private async readSamplingProfile(): Promise<string | null> {
    if (
      !this.enabled ||
      !this.samplingActive ||
      this.samplingSession === null
    ) {
      return null;
    }
    try {
      const result = await inspectorCommand(
        this.samplingSession,
        'HeapProfiler.getSamplingProfile',
      );
      return getProfileFileContents(result);
    } catch (error) {
      this.samplingUnavailableReason = errorMessage(
        error,
        'The allocation sampling profile could not be read.',
      );
      logMainProcessError(
        'Memory diagnostics allocation sampling profile could not be read',
        error,
      );
      return null;
    }
  }

  private getMeasurements(): MemoryDiagnosticsMeasurements {
    const renderers = collectActiveRenderers(this.host);
    const appMetrics = app.getAppMetrics();
    return {
      heapStatistics: getHeapStatistics(),
      heapSpaceStatistics: getHeapSpaceStatistics(),
      processMemoryUsage: process.memoryUsage(),
      appMetrics,
      renderers,
      rendererMemoryEstimate: estimateRendererMemory(renderers, appMetrics),
    };
  }

  private async checkAutomaticDump(): Promise<void> {
    if (!this.enabled || this.disposed) {
      return;
    }
    const heapStatistics = getHeapStatistics();
    if (
      heapStatistics.heap_size_limit <= 0 ||
      heapStatistics.used_heap_size <
        heapStatistics.heap_size_limit * AUTO_DUMP_HEAP_THRESHOLD
    ) {
      return;
    }
    await this.enqueueWrite(async () => {
      if (!this.enabled || this.disposed) {
        return;
      }
      const now = Date.now();
      if (
        this.lastAutomaticDumpAt > 0 &&
        now - this.lastAutomaticDumpAt < AUTO_DUMP_MIN_INTERVAL_MS
      ) {
        return;
      }
      this.lastAutomaticDumpAt = now;
      await this.createAutomaticDump();
    });
  }

  private async createAutomaticDump(): Promise<void> {
    const createdAtMs = Date.now();
    const createdAt = new Date(createdAtMs).toISOString();
    let directory: CreatedReportDirectory | null = null;
    try {
      const measurements = this.getMeasurements();
      const root = await ensureReportsRoot();
      directory = await createOutputDirectory(root, 'auto');
      const summaryPath = safeDirectChild(directory.path, 'summary.json');
      const profileContents = await this.enqueueSampling(() =>
        this.readSamplingProfile(),
      );
      if (profileContents !== null) {
        await writePrivateFile(
          safeDirectChild(directory.path, 'main.heapprofile'),
          profileContents,
        );
      }
      const summaryWithoutReport: Omit<MemoryDiagnosticsSummaryFile, 'report'> =
        {
          version: 1,
          reportId: directory.id,
          kind: 'auto',
          createdAt,
          appVersion: app.getVersion(),
          electronVersion: process.versions.electron ?? 'unknown',
          nodeVersion: process.versions.node,
          chromeVersion: process.versions.chrome ?? 'unknown',
          operatingSystem: {
            platform: hostOperatingSystem(),
            release: os.release(),
            arch: os.arch(),
          },
          processMemoryUsage: measurements.processMemoryUsage,
          heapStatistics: measurements.heapStatistics,
          heapSpaceStatistics: measurements.heapSpaceStatistics,
          appMetrics: measurements.appMetrics,
          rendererMemoryEstimate: measurements.rendererMemoryEstimate,
          rendererSnapshots: [],
          processHistory: this.getProcessHistory(),
          sampling: {
            active: this.samplingActive,
            included: profileContents !== null,
            unavailableReason: this.samplingUnavailableReason,
          },
        };
      await writeJsonFile(summaryPath, {
        ...summaryWithoutReport,
        report: makeMemoryReportSummary(
          directory.id,
          'auto',
          createdAt,
          0,
          0,
          Math.max(0, Date.now() - createdAtMs),
          profileContents !== null,
        ),
      });
      const report = await finalizeSummaryFile(
        directory.path,
        summaryPath,
        summaryWithoutReport,
        createdAtMs,
        profileContents !== null,
      );
      await pruneOutputDirectories(root, 'auto', AUTO_DUMP_RETENTION_COUNT);
      this.recordSuccessfulReport('auto');
      this.lastReport = report;
    } catch (error) {
      logMainProcessError(
        'Memory diagnostics automatic dump could not be written',
        error,
      );
      if (directory !== null) {
        await this.removeOutputDirectory(directory);
      }
    }
  }

  private async createReportSerialized(): Promise<CreateMemoryReportResult> {
    let directory: CreatedReportDirectory | null = null;
    try {
      if (!this.enabled || this.disposed) {
        return {
          ok: false,
          reason: 'disabled',
          message: 'Enable memory diagnostics before creating a report.',
        };
      }
      const measurements = this.getMeasurements();
      const root = await ensureReportsRoot();
      const requiredBytes =
        (measurements.heapStatistics.used_heap_size +
          measurements.rendererMemoryEstimate.bytes) *
        2;
      const filesystem = await statfs(root);
      const availableBytes = filesystem.bavail * filesystem.bsize;
      if (availableBytes < requiredBytes) {
        return {
          ok: false,
          reason: 'insufficient-disk',
          message:
            'There is not enough free disk space to create a memory report.',
        };
      }

      const createdAtMs = Date.now();
      const createdAt = new Date(createdAtMs).toISOString();
      const processHistory = this.getProcessHistory();
      directory = await createOutputDirectory(root, 'report');
      const summaryPath = safeDirectChild(directory.path, 'summary.json');
      // Before any snapshot, whose own allocations would skew the numbers.
      const nativeMemory = await readNativeMemory(
        safeDirectChild(directory.path, 'native-memory.trace.json'),
        measurements.appMetrics,
      );
      const profileContents = await this.enqueueSampling(() =>
        this.readSamplingProfile(),
      );
      if (profileContents !== null) {
        await writePrivateFile(
          safeDirectChild(directory.path, 'main.heapprofile'),
          profileContents,
        );
      }

      const rendererSnapshots: RendererSnapshotSummary[] = [];
      const rendererLabelCounts = new Map<string, number>();
      const initialSummary = this.makeSummaryWithoutReport(
        directory,
        'report',
        createdAt,
        measurements,
        rendererSnapshots,
        processHistory,
        profileContents !== null,
        nativeMemory,
      );
      await writeJsonFile(summaryPath, {
        ...initialSummary,
        report: makeMemoryReportSummary(
          directory.id,
          'report',
          createdAt,
          0,
          0,
          0,
          profileContents !== null,
        ),
      });

      for (const renderer of measurements.renderers) {
        if (renderer.webContents.isDestroyed()) {
          continue;
        }
        const duplicateCount = rendererLabelCounts.get(renderer.label) ?? 0;
        rendererLabelCounts.set(renderer.label, duplicateCount + 1);
        const labelSuffix =
          duplicateCount === 0 ? '' : `-${duplicateCount + 1}`;
        const fileName = `renderer-${renderer.label}${labelSuffix}.heapsnapshot`;
        const snapshotPath = safeDirectChild(directory.path, fileName);
        const rendererStatistics = await readRendererStatistics(
          renderer.webContents.debugger,
        );
        await renderer.webContents.takeHeapSnapshot(snapshotPath);
        ensurePrivateRegularFile(snapshotPath);
        await chmod(snapshotPath, FILE_MODE);
        rendererSnapshots.push({
          label: renderer.label,
          processId: renderer.processId,
          fileName,
          ...rendererStatistics,
        });
      }

      // Read the heap again: `measurements` predates the native dump and the
      // renderer snapshots. A snapshot needs about the heap's size again, and
      // V8 aborts the whole process when it runs out, so skip main's snapshot
      // when headroom is low or the limit is unknown.
      const mainHeap = getHeapStatistics();
      const usedHeapBytes = mainHeap.used_heap_size;
      const heapLimitBytes = mainHeap.heap_size_limit;
      const mainSnapshotAllowed =
        Number.isFinite(heapLimitBytes) &&
        heapLimitBytes > 0 &&
        usedHeapBytes <= heapLimitBytes * MAIN_SNAPSHOT_MAX_HEAP_FRACTION;
      let mainSnapshot: MainSnapshotSummary;
      if (mainSnapshotAllowed) {
        // Renderer snapshots have already consumed disk space. Re-check that
        // enough remains for the main snapshot before asking V8 to write it.
        const remainingFilesystem = await statfs(root);
        const remainingBytes =
          remainingFilesystem.bavail * remainingFilesystem.bsize;
        if (remainingBytes < usedHeapBytes * 2) {
          await this.removeOutputDirectory(directory);
          directory = null;
          return {
            ok: false,
            reason: 'insufficient-disk',
            message:
              'There is not enough free disk space to create a memory report.',
          };
        }
        const mainSnapshotPath = safeDirectChild(
          directory.path,
          'main.heapsnapshot',
        );
        const writtenSnapshotPath = writeHeapSnapshot(mainSnapshotPath);
        // Even a report that later fails has left V8's main snapshot pages behind.
        this.mainSnapshotsWritten += 1;
        if (resolve(writtenSnapshotPath) !== resolve(mainSnapshotPath)) {
          throw new Error(
            'V8 wrote the main snapshot outside the report directory.',
          );
        }
        ensurePrivateRegularFile(mainSnapshotPath);
        await chmod(mainSnapshotPath, FILE_MODE);
        mainSnapshot = { included: true, usedHeapBytes, heapLimitBytes };
      } else {
        logMainProcessWarn(
          'Memory diagnostics skipped the main heap snapshot: not enough heap headroom',
          { usedHeapBytes, heapLimitBytes },
        );
        mainSnapshot = {
          included: false,
          skippedReason: 'insufficient-heap-headroom',
          usedHeapBytes,
          heapLimitBytes,
        };
      }

      const summaryWithoutReport = this.makeSummaryWithoutReport(
        directory,
        'report',
        createdAt,
        measurements,
        rendererSnapshots,
        processHistory,
        profileContents !== null,
        nativeMemory,
        mainSnapshot,
      );
      const report = await finalizeSummaryFile(
        directory.path,
        summaryPath,
        summaryWithoutReport,
        createdAtMs,
        profileContents !== null,
      );
      await pruneOutputDirectories(root, 'report', REPORT_RETENTION_COUNT);
      this.recordSuccessfulReport('report');
      this.lastReport = report;
      return { ok: true, report };
    } catch (error) {
      logMainProcessError(
        'Memory diagnostics report could not be created',
        error,
      );
      if (directory !== null) {
        await this.removeOutputDirectory(directory);
      }
      return {
        ok: false,
        reason: 'failed',
        message: 'The memory report could not be created.',
      };
    }
  }

  private makeSummaryWithoutReport(
    directory: CreatedReportDirectory,
    kind: MemoryReportKind,
    createdAt: string,
    measurements: MemoryDiagnosticsMeasurements,
    rendererSnapshots: readonly RendererSnapshotSummary[],
    processHistory: MemoryDiagnosticsProcessHistory,
    samplingIncluded: boolean,
    nativeMemory?: NativeMemorySummary,
    mainSnapshot?: MainSnapshotSummary,
  ): Omit<MemoryDiagnosticsSummaryFile, 'report'> {
    return {
      version: 1,
      reportId: directory.id,
      kind,
      createdAt,
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron ?? 'unknown',
      nodeVersion: process.versions.node,
      chromeVersion: process.versions.chrome ?? 'unknown',
      operatingSystem: {
        platform: hostOperatingSystem(),
        release: os.release(),
        arch: os.arch(),
      },
      processMemoryUsage: measurements.processMemoryUsage,
      heapStatistics: measurements.heapStatistics,
      heapSpaceStatistics: measurements.heapSpaceStatistics,
      appMetrics: measurements.appMetrics,
      rendererMemoryEstimate: measurements.rendererMemoryEstimate,
      rendererSnapshots,
      processHistory,
      ...(nativeMemory ? { nativeMemory } : {}),
      ...(mainSnapshot ? { mainSnapshot } : {}),
      sampling: {
        active: this.samplingActive,
        included: samplingIncluded,
        unavailableReason: this.samplingUnavailableReason,
      },
    };
  }

  private async removeOutputDirectory(
    directory: CreatedReportDirectory,
  ): Promise<void> {
    try {
      const canonicalRoot = resolveRealPath(directory.root);
      const canonicalDirectory = resolveRealPath(directory.path);
      if (
        canonicalDirectory === directory.path &&
        isWithinDirectory(canonicalRoot, canonicalDirectory)
      ) {
        await rm(canonicalDirectory, { recursive: true, force: true });
      }
    } catch {
      // Leave a partial report alone if its current path cannot be verified.
    }
  }
}

export function createMemoryDiagnosticsService(host: MemoryDiagnosticsHost): {
  setEnabled(enabled: boolean): void;
  getStatus(): Promise<MemoryDiagnosticsStatus>;
  createReport(): Promise<CreateMemoryReportResult>;
  resolveReportPath(reportId: string): string | null;
  dispose(): Promise<void>;
} {
  return new MemoryDiagnosticsServiceImpl(host);
}
