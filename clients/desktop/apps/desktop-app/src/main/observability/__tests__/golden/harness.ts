// Host-neutral golden harness for observability ingest (CAN-5065). Scenarios
// drive the ingest boundary only, and captures read the stores a host wrote
// under its data root, so a portable ingest (CAN-4136) can bind its own host
// to the same scenarios and goldens. Nothing here imports Electron main code.
import type { Dirent } from 'node:fs';
import { readFile, readdir, utimes } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type {
  AgentAuditEntry,
  AgentAuditHistoryRequest,
  AgentAuditHistoryResponse,
  AgentAuditStatus,
  AgentObservabilitySnapshot,
  AgentProviderType,
  AssistantMode,
  UsageInitiationSource,
  UsageMetricEvent,
  UsageMetricsRequest,
  UsageMetricsResponse,
  UsageMetricsViewRequest,
  UsageMetricsViewResponse,
  UsageTabId,
  UsageTabSummaryRequest,
  UsageTabSummaryResponse,
  UsageTimeseriesRequest,
  UsageTimeseriesResponse,
} from '@canopy/desktop-shared/types';
import type {
  ExecutionEvent,
  ExecutionState,
} from '@canopy/execution-engine/node/pipelines/executor';

export interface GoldenChatTurnStart {
  projectId: string;
  worktreeId: string;
  chatId: string;
  provider: AgentProviderType;
  originalUserText: string;
  submittedText: string;
  planMode: boolean;
  isStandalone: boolean;
  model?: string;
  requestedModel?: string;
  sdkSessionId?: string;
  userMessageId?: string;
  assistantMode?: AssistantMode;
  initiationSource?: UsageInitiationSource;
  workspaceLabel?: string;
  repoId?: string;
  repoLabel?: string;
  serviceTier?: string;
  accountProxyRouted?: boolean;
}

export interface GoldenTaskUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  totalCostUsd?: number;
  messageCount?: number;
  assistantMessageCount?: number;
  reasoningOutputTokens?: number;
}

export interface GoldenPipelineOutput {
  executionId: string;
  jobId: string;
  stepId: string;
  attempt: number;
  iteration?: number;
  data: string;
}

/** The execution state fields the ingest reads when a run syncs. */
export type GoldenPipelineState = Pick<
  ExecutionState,
  | 'id'
  | 'parent_execution_id'
  | 'pipeline_id'
  | 'project_id'
  | 'worktree_id'
  | 'model_config'
  | 'jobs'
> & { pipeline_snapshot: Pick<ExecutionState['pipeline_snapshot'], 'name'> };

/**
 * The ingest and read boundary every host must serve. The desktop
 * `ObservabilityService` satisfies it today; a portable ingest must satisfy
 * it unchanged.
 */
export interface GoldenObservabilityIngest {
  start(): Promise<void>;
  flush(): Promise<void>;
  dispose(): Promise<void>;
  startChatTurn(options: GoldenChatTurnStart): void;
  observeChatEvent(
    projectId: string,
    worktreeId: string,
    chatId: string,
    data: unknown,
  ): void;
  pauseChatTurn(projectId: string, worktreeId: string, chatId: string): void;
  resumeChatTurn(projectId: string, worktreeId: string, chatId: string): void;
  completeChatTurn(
    projectId: string,
    worktreeId: string,
    chatId: string,
    status: AgentAuditStatus,
    error?: string,
  ): void;
  startObservedTask(key: string, entry: AgentAuditEntry): void;
  finalizeObservedTask(
    key: string,
    status: AgentAuditStatus,
    error?: string,
    usage?: GoldenTaskUsage,
  ): void;
  interruptMatchingEntries(prefix: string): void;
  syncPipelineExecutionState(state: GoldenPipelineState): void;
  observePipelineOutput(event: GoldenPipelineOutput): void;
  recordUsageMetricEvent(event: UsageMetricEvent): void;
  loadSnapshot(): AgentObservabilitySnapshot;
  loadHistory(
    request: AgentAuditHistoryRequest,
  ): Promise<AgentAuditHistoryResponse>;
  loadUsageMetrics(request: UsageMetricsRequest): Promise<UsageMetricsResponse>;
  loadUsageTabSummary(
    request: UsageTabSummaryRequest,
  ): Promise<UsageTabSummaryResponse>;
  loadUsageMetricsView(
    request: UsageMetricsViewRequest,
  ): Promise<UsageMetricsViewResponse>;
  loadUsageTimeseries(
    request: UsageTimeseriesRequest,
  ): Promise<UsageTimeseriesResponse>;
  getPipelineOutputDiagnostics(): {
    droppedOutputChunks: number;
    droppedOutputBytes: number;
  };
}

/** One account-proxy response as the loopback broker reports it. */
export interface GoldenAccountProxyResponse {
  sessionId: string;
  connectionId: string;
  authIndex: string;
  requestId: string;
  label: string;
  provider: string;
}

/**
 * What a host supplies besides the ingest. Every account, price and route
 * fact a scenario depends on is fixed by the host contract below, so two
 * hosts given the same scenario must write the same stores.
 */
export interface GoldenObservabilityHost {
  /** The data root the host's stores live under. */
  readonly dataRoot: string;
  /**
   * Starts a fresh process incarnation over the same stores: no in-memory
   * state survives from an earlier boot, as after an app restart.
   */
  boot(): Promise<GoldenObservabilityIngest>;
  setClock(iso: string): void;
  advanceClock(ms: number): void;
  /** The account-proxy broker naming the account behind one response. */
  recordAccountProxyResponse(response: GoldenAccountProxyResponse): void;
  /** The pipeline runner's lifecycle producer for run usage events. */
  recordPipelineRunEvent(event: ExecutionEvent): void;
}

/**
 * The provider accounts and prices every host must present, so that billing
 * basis, account identity and Codex estimates are part of the golden.
 */
export const GOLDEN_PROVIDER_ACCOUNTS = {
  claude: {
    identity: {
      providerAccountKey: 'claude:golden@example.com',
      accountEmail: 'golden@example.com',
      planType: 'max',
    },
    billingAccountKind: 'subscription',
  },
  codex: {
    identity: {
      providerAccountKey: 'codex:golden@example.com',
      accountEmail: 'golden@example.com',
      planType: 'pro',
    },
    billingAccountKind: 'api_key',
  },
} as const;

export const GOLDEN_CODEX_MODEL = 'gpt-6.1-sol';

/** OpenAI list prices per million tokens for {@link GOLDEN_CODEX_MODEL}. */
export const GOLDEN_CODEX_PRICES = {
  input: 10,
  cachedInput: 1,
  cacheWriteInput: 20,
  output: 40,
} as const;

/** Pipeline output delivery modes the ingest must not distinguish. */
export type GoldenOutputChunking = 'whole' | 'per-character' | 'crlf-split';

export interface GoldenScenarioContext {
  readonly host: GoldenObservabilityHost;
  /** The ingest of the current incarnation. */
  ingest: GoldenObservabilityIngest;
  readonly chunking: GoldenOutputChunking;
  /** Flushes twice, so writes queued by the first flush land too. */
  settle(): Promise<void>;
  /** Abandons the current incarnation without shutdown, as after a crash. */
  crashAndRestart(): Promise<void>;
  /** Shuts the current incarnation down, then boots a fresh one. */
  shutdownAndRestart(): Promise<void>;
  /** Delivers pipeline output in the context's chunking mode. */
  pipelineOutput(event: GoldenPipelineOutput): void;
}

export interface GoldenScenario {
  readonly name: string;
  /** Leaves the final incarnation running; captures follow. */
  run(context: GoldenScenarioContext): Promise<void>;
}

export const GOLDEN_START_TIME = '2026-10-20T09:00:00.000Z';

function chunks(data: string, mode: GoldenOutputChunking): string[] {
  if (mode === 'whole') return [data];
  if (mode === 'per-character') return Array.from(data);
  const crlf = data.replace(/\n/g, '\r\n');
  const middle = Math.max(1, Math.floor(crlf.length / 2));
  // Split inside a CRLF pair and inside a JSON line.
  const pair = crlf.indexOf('\r\n');
  const cuts = [pair < 0 ? middle : pair + 1, middle]
    .filter((cut, index, all) => cut > 0 && all.indexOf(cut) === index)
    .sort((left, right) => left - right);
  const parts: string[] = [];
  let start = 0;
  for (const cut of cuts) {
    if (cut <= start || cut >= crlf.length) continue;
    parts.push(crlf.slice(start, cut));
    start = cut;
  }
  parts.push(crlf.slice(start));
  return parts;
}

export interface GoldenRun {
  readonly context: GoldenScenarioContext;
  /** Every incarnation booted, oldest first. */
  readonly incarnations: readonly GoldenObservabilityIngest[];
}

export async function runGoldenScenario(
  host: GoldenObservabilityHost,
  scenario: GoldenScenario,
  chunking: GoldenOutputChunking = 'whole',
): Promise<GoldenRun> {
  host.setClock(GOLDEN_START_TIME);
  const incarnations: GoldenObservabilityIngest[] = [];
  const boot = async (): Promise<GoldenObservabilityIngest> => {
    // Restart recovery reads file mtimes, which the host's fake clock cannot set.
    const now = new Date();
    for (const file of await listFiles(
      join(host.dataRoot, OBSERVABILITY_DIR),
    )) {
      await utimes(file, now, now);
    }
    const ingest = await host.boot();
    incarnations.push(ingest);
    await ingest.start();
    return ingest;
  };
  const first = await boot();
  const context: GoldenScenarioContext = {
    host,
    ingest: first,
    chunking,
    settle: async (): Promise<void> => {
      await context.ingest.flush();
      await context.ingest.flush();
    },
    crashAndRestart: async (): Promise<void> => {
      await context.settle();
      context.ingest = await boot();
    },
    shutdownAndRestart: async (): Promise<void> => {
      await context.ingest.dispose();
      context.ingest = await boot();
    },
    pipelineOutput: (event): void => {
      for (const data of chunks(event.data, chunking)) {
        context.ingest.observePipelineOutput({ ...event, data });
      }
    },
  };
  await scenario.run(context);
  await context.settle();
  return { context, incarnations };
}

/** Store files under the data root that observability owns. */
const OBSERVABILITY_DIR = 'agent-observability';

async function listFiles(root: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  const names = entries
    .map((entry) => entry.name)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  for (const name of names) {
    const entry = entries.find((candidate) => candidate.name === name);
    const path = join(root, name);
    if (entry?.isDirectory()) files.push(...(await listFiles(path)));
    else if (entry?.isFile()) files.push(path);
  }
  return files;
}

function normalizeText(text: string, dataRoot: string): string {
  return text.split(dataRoot).join('<data>');
}

function prettyJson(raw: string, dataRoot: string): string {
  const parsed: unknown = JSON.parse(raw);
  return normalizeText(JSON.stringify(parsed, null, 2), dataRoot);
}

/**
 * The provider-account usage overview in `snapshot.json` comes from provider
 * account reads, not from ingest; CAN-4180 owns that projection.
 */
function snapshotWithoutProviderUsage(raw: string, dataRoot: string): string {
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return prettyJson(raw, dataRoot);
  }
  const kept = Object.fromEntries(
    Object.entries(parsed).map(([key, value]): [string, unknown] =>
      key === 'usage'
        ? [key, '<provider account usage: not captured>']
        : [key, value],
    ),
  );
  return normalizeText(JSON.stringify(kept, null, 2), dataRoot);
}

/**
 * Every stored record, one block per line in write order, with key order
 * preserved. Only the data root is normalized; the clock is fixed by the host.
 */
export async function captureStores(dataRoot: string): Promise<string> {
  const root = join(dataRoot, OBSERVABILITY_DIR);
  const blocks: string[] = [];
  for (const path of await listFiles(root)) {
    const name = relative(dataRoot, path).split(sep).join('/');
    const contents = await readFile(path, 'utf8');
    if (name.endsWith('.jsonl')) {
      const lines = contents.split('\n').filter((line) => line.length > 0);
      blocks.push(`=== ${name} (${String(lines.length)} lines)`);
      lines.forEach((line, index) => {
        blocks.push(`--- ${String(index + 1)}`, prettyJson(line, dataRoot));
      });
    } else if (name === `${OBSERVABILITY_DIR}/snapshot.json`) {
      blocks.push(
        `=== ${name}`,
        snapshotWithoutProviderUsage(contents, dataRoot),
      );
    } else if (name.endsWith('.json')) {
      blocks.push(`=== ${name}`, prettyJson(contents, dataRoot));
    } else {
      blocks.push(`=== ${name}`, normalizeText(contents, dataRoot));
    }
  }
  return blocks.join('\n');
}

/** The last stored line for each audit entry id, in first-seen order. */
export async function readFinalAuditLines(
  dataRoot: string,
): Promise<unknown[]> {
  const auditDir = join(dataRoot, OBSERVABILITY_DIR, 'audit');
  const byId = new Map<string, unknown>();
  for (const path of await listFiles(auditDir)) {
    if (!path.endsWith('.jsonl')) continue;
    const contents = await readFile(path, 'utf8');
    for (const line of contents.split('\n')) {
      if (line.length === 0) continue;
      const parsed: unknown = JSON.parse(line);
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        'id' in parsed &&
        typeof parsed.id === 'string'
      ) {
        byId.delete(parsed.id);
        byId.set(parsed.id, parsed);
      }
    }
  }
  return Array.from(byId.values());
}

const TABS: readonly UsageTabId[] = [
  'tokens',
  'cost',
  'worktrees',
  'chats',
  'plans',
  'tools',
  'pipelines',
];

const METRIC_VIEWS: readonly UsageMetricsViewRequest[] = [
  {
    tab: 'tokens',
    metric: 'token_total',
    groupBy: 'provider',
    window: { kind: 'allTime' },
  },
  {
    tab: 'cost',
    metric: 'cost_total_usd',
    groupBy: 'chat',
    window: { kind: 'allTime' },
  },
  {
    tab: 'chats',
    metric: 'turn_duration_ms',
    groupBy: 'worktree',
    window: { kind: 'allTime' },
  },
  {
    tab: 'tools',
    metric: 'tool_calls',
    groupBy: 'category',
    window: { kind: 'allTime' },
  },
  {
    tab: 'plans',
    metric: 'plan_created',
    groupBy: 'worktree',
    window: { kind: 'allTime' },
  },
  {
    tab: 'pipelines',
    metric: 'pipeline_duration_ms',
    groupBy: 'pipeline',
    window: { kind: 'allTime' },
  },
];

/**
 * A window around the scenarios' clock, wide enough for every record. Its
 * edges sit at midday UTC so they fall on the same local calendar day in
 * every time zone from UTC-11 to UTC+11.
 */
const WINDOW_START = '2026-10-13T12:00:00.000Z';
const WINDOW_END = '2026-10-26T12:00:00.000Z';

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * Time-series buckets start at local midnight, so their instants depend on
 * the machine's time zone. The golden names each bucket by its local date.
 */
function localBuckets(
  response: UsageTimeseriesResponse,
): UsageTimeseriesResponse {
  const label = (bucketStart: string): string => {
    const date = new Date(bucketStart);
    return `local ${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  };
  switch (response.kind) {
    case 'tokens':
      return {
        kind: 'tokens',
        buckets: response.buckets.map((bucket) => ({
          ...bucket,
          bucketStart: label(bucket.bucketStart),
        })),
      };
    case 'tab-counts':
      return {
        kind: 'tab-counts',
        buckets: response.buckets.map((bucket) => ({
          ...bucket,
          bucketStart: label(bucket.bucketStart),
        })),
      };
    case 'tab-distribution':
      return {
        kind: 'tab-distribution',
        buckets: response.buckets.map((bucket) => ({
          ...bucket,
          bucketStart: label(bucket.bucketStart),
        })),
      };
  }
}

export interface GoldenAggregates {
  readonly recentEntries: AgentObservabilitySnapshot['recentEntries'];
  readonly history: AgentAuditHistoryResponse;
  readonly usageMetrics: UsageMetricsResponse;
  readonly tabSummaries: Record<string, UsageTabSummaryResponse>;
  readonly metricViews: Record<string, UsageMetricsViewResponse>;
  readonly timeseries: Record<string, UsageTimeseriesResponse>;
  readonly pipelineOutputDiagnostics: {
    droppedOutputChunks: number;
    droppedOutputBytes: number;
  };
}

/** The reads the aggregates capture, served directly or through core. */
export type GoldenAggregateReader = Pick<
  GoldenObservabilityIngest,
  | 'loadHistory'
  | 'loadUsageMetrics'
  | 'loadUsageTabSummary'
  | 'loadUsageMetricsView'
  | 'loadUsageTimeseries'
  | 'getPipelineOutputDiagnostics'
> & {
  loadSnapshot(): Pick<AgentObservabilitySnapshot, 'recentEntries'>;
};

/** Every read the ingest serves over what it stored. */
export async function captureAggregates(
  ingest: GoldenAggregateReader,
): Promise<GoldenAggregates> {
  const tabSummaries: Record<string, UsageTabSummaryResponse> = {};
  for (const tab of TABS) {
    tabSummaries[tab] = await ingest.loadUsageTabSummary({ tab });
  }
  const metricViews: Record<string, UsageMetricsViewResponse> = {};
  for (const request of METRIC_VIEWS) {
    metricViews[`${request.tab}/${request.metric}/${request.groupBy}`] =
      await ingest.loadUsageMetricsView(request);
  }
  const timeseries: Record<string, UsageTimeseriesResponse> = {
    'tokens/day': await ingest.loadUsageTimeseries({
      startDate: WINDOW_START,
      endDate: WINDOW_END,
      bucket: 'day',
    }),
    'cost/counts/day': await ingest.loadUsageTimeseries({
      startDate: WINDOW_START,
      endDate: WINDOW_END,
      bucket: 'day',
      dataset: {
        kind: 'tab-counts',
        tab: 'cost',
        series: ['cost_total_usd', 'cost_provider_claude_usd'],
      },
    }),
    'chats/turn-duration/day': await ingest.loadUsageTimeseries({
      startDate: WINDOW_START,
      endDate: WINDOW_END,
      bucket: 'day',
      dataset: {
        kind: 'tab-distribution',
        tab: 'chats',
        metric: 'turn_duration_ms',
      },
    }),
  };
  for (const [key, response] of Object.entries(timeseries)) {
    timeseries[key] = localBuckets(response);
  }
  return {
    recentEntries: ingest.loadSnapshot().recentEntries,
    history: await ingest.loadHistory({ limit: 200 }),
    usageMetrics: await ingest.loadUsageMetrics({
      startDate: WINDOW_START,
      endDate: WINDOW_END,
    }),
    tabSummaries,
    metricViews,
    timeseries,
    pipelineOutputDiagnostics: ingest.getPipelineOutputDiagnostics(),
  };
}

export function renderGolden(value: unknown, dataRoot: string): string {
  return normalizeText(JSON.stringify(value, null, 2), dataRoot);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function describeValue(value: unknown): string {
  return value === undefined ? '(absent)' : JSON.stringify(value);
}

function elementKey(value: unknown, index: number): string {
  if (isPlainRecord(value)) {
    for (const field of ['id', 'key', 'bucketStart']) {
      const candidate = value[field];
      if (typeof candidate === 'string') return `${field}=${candidate}`;
    }
  }
  return String(index);
}

function diffInto(
  left: unknown,
  right: unknown,
  path: string,
  out: string[],
): void {
  if (Array.isArray(left) && Array.isArray(right)) {
    const leftByKey = new Map(
      left.map((value, index) => [elementKey(value, index), value]),
    );
    const rightByKey = new Map(
      right.map((value, index) => [elementKey(value, index), value]),
    );
    for (const [key, value] of Array.from(leftByKey.entries())) {
      diffInto(value, rightByKey.get(key), `${path}[${key}]`, out);
    }
    for (const [key, value] of Array.from(rightByKey.entries())) {
      if (!leftByKey.has(key))
        diffInto(undefined, value, `${path}[${key}]`, out);
    }
    const leftOrder = Array.from(leftByKey.keys()).filter((key) =>
      rightByKey.has(key),
    );
    const rightOrder = Array.from(rightByKey.keys()).filter((key) =>
      leftByKey.has(key),
    );
    if (leftOrder.join('\n') !== rightOrder.join('\n')) {
      out.push(
        `${path}: order ${JSON.stringify(leftOrder)} → ${JSON.stringify(rightOrder)}`,
      );
    }
    return;
  }
  if (isPlainRecord(left) && isPlainRecord(right)) {
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    for (const key of Array.from(keys).sort()) {
      diffInto(left[key], right[key], path ? `${path}.${key}` : key, out);
    }
    return;
  }
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    out.push(`${path}: ${describeValue(left)} → ${describeValue(right)}`);
  }
}

/**
 * Every difference between two JSON-compatible captures, keyed by path.
 * Array elements are matched by `id`, `key` or `bucketStart` when present,
 * so a missing record reads as one line rather than a shifted array.
 */
export function diffGolden(left: unknown, right: unknown): string[] {
  const out: string[] = [];
  const normalize = (value: unknown): unknown =>
    value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  diffInto(normalize(left), normalize(right), '', out);
  return out;
}
