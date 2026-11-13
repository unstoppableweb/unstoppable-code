import {
  prepareSidebarReorder,
  runSidebarReorder,
} from './sidebar-reorder-scenario.mjs';
import {
  measureProjectsRetention,
  prepareProjectsRetention,
  runProjectsRetention,
} from './projects-retention-scenario.mjs';
import {
  prepareCodeReviewRegistry,
  runCodeReviewRegistryCleanup,
} from './code-review-registry-scenario.mjs';
import { perfettoTraceEvents } from './perfetto-trace.mjs';
import { w5StoreScenarios } from './w5-store-scenario.mjs';
import { w5StoreLaunchEnv } from './w5-store-arms.mjs';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import {
  AI_GATEWAY_MODEL_CATALOG_CACHE_VERSION,
  AI_GATEWAY_MODEL_CATALOG_VERSION,
} from '../electron/ai-gateway-catalog-versions.mjs';
import { createBrowserLabServer } from '../electron/mock-server/routes/browser-lab.mjs';
import {
  HOME_COWORK_PROMPT,
  registerHomeCoworkScenario,
} from '../electron/cowork-summary-fixture.mjs';
import {
  MANY_CHAT_RESIDENCY_STREAM_CHAT_COUNT,
  seedManyChatResidencyFixture,
} from '../electron/many-chat-fixture.mjs';
import {
  SCOPE_RESIDENCY,
  scopeResidencyWorktreeIds,
  seedScopeResidencyFixture,
} from './scope-residency-fixture.mjs';
import { seedStressTranscript } from '../electron/stress-transcript-fixture.mjs';
import {
  openStressEntry,
  openStressChat,
  inspectStressHistory,
} from '../electron/stress-transcript-driver.mjs';
import {
  LAB_TRANSCRIPT_UPDATE_CADENCE_MS,
  LAB_TRANSCRIPT_UPDATE_COUNT,
  assertLabTranscriptUpdateProgress,
  inspectLabTranscript,
  labTranscriptDimensions,
  labTranscriptLaunchEnvironment,
  labTranscriptProvenance,
  normalizeLabTranscriptReceipt,
  readLabTranscriptActiveSession,
  readLabTranscriptChatVisibility,
  readLabTranscriptNativeWindowIdentity,
  readPersistedLabTranscriptPage,
  runLabTranscriptCheckpointProbe,
  runSerializedLabTranscriptUpdates,
  summarizeLabTranscriptCheckpoint,
  updateLabTranscript,
} from '../electron/lab-transcript-driver.mjs';
import {
  CanopyAppDriver,
  closePanelTab,
  expandDefaultActivityRail,
} from '../electron/canopyApp.mjs';
import { selectModelOption } from '../electron/model-selection-fixture.mjs';
import {
  commitArchiveSiblingProviderMarker,
  deleteArchiveActivityWorktree,
  installArchiveCaptureBarrier,
  releaseArchiveActivityBarrier,
  seedArchiveActivityFixture,
} from '../electron/seeders/archiveActivityFixture.mjs';
import { seedDemoWorkspaces } from '../electron/demoWorkspaces.mjs';
import {
  observeRendererCrashes,
  rendererCrashRecordFields,
  retainLaunchCrashDumps,
  settleRendererCrashEvidence,
} from './renderer-crash-evidence.mjs';
import { openBackgroundDrawer } from '../electron/backgroundDrawer.mjs';
import {
  installTranscriptRewriteObserver,
  readTranscriptRewriteObserver,
  stopTranscriptRewriteObserver,
} from '../electron/delegationStorageWorkload.mjs';
import {
  closeCanopy,
  launchCanopy,
  getMainWindow,
  RENDERER_CODE_CACHE_SCHEME_ENV,
} from '../electron/launchCanopy.mjs';
import { seedInnerPanelLayout } from '../electron/seeders/seedInnerPanelLayout.mjs';
import {
  collectLeaves,
  getLayout,
  movePanelViaApi,
} from '../electron/panelHarness.mjs';
import {
  buildLargePlanFixture,
  buildTrackedPlan,
  getScenarioActivity,
  registerScenario,
  seedAutomations,
  seedCoworkWorkspace,
  seedMcpServers,
  seedPipelineExecution,
  seedStoredPipeline,
  seedTrackedPlans,
  seedWatchers,
  seedWorktreeChat,
} from '../electron/seeders/index.mjs';
import { PERFORMANCE_MOCK_BASE_URL } from './mock-server.mjs';
import { MOCK_GUEST_ACCOUNT_ID } from '../electron/mock-server/routes/cloud.mjs';
import {
  APP_WORK_SOURCES,
  assertValidMonitoring,
  assertValidTypingSampling,
  buildFrameBudgetReport,
  evaluateMainWithRetry,
  diffWorkCounters,
  normalizeAppMetrics,
  ROUTE_EVIDENCE_SOURCE,
  W5_EVIDENCE_SOURCE,
  startPerformanceMonitor,
  markRendererTask,
} from './monitor.mjs';
import { WORK_RATCHET_PROFILE } from './profiles.mjs';
import { toolActiveTurnTaskKind } from './scaling-ratios.mjs';
import {
  checkoutWritesTailLast,
  installWorktreeGitGate,
  readCheckoutGitConfig,
} from './worktree-git-gate.mjs';
import {
  createDiskIoReader,
  mergeDiskIoWork,
  prepareAppDiskIoSampler,
} from './disk-io.mjs';
import {
  admitStudyWindow,
  measuredWindowState,
  setupHeadlessStudyWindow,
  assertHeadlessWindowEvidence,
  HEADLESS_STUDY_MODE,
} from './browser-profiles-evidence.mjs';
import { assessResponsiveness } from './responsiveness.mjs';
import {
  prepareDiagnosticLaunch,
  startDiagnosticCapture,
} from './diagnostics.mjs';
import { prepareGitAttributionCapture } from './git-attribution.mjs';
import { assessCodexSubagentThreadRouting } from './mixed-provider-validation.mjs';
import { captureScenarioFailure } from './scenario-failure-diagnostics.mjs';
import {
  LEDGER_FIXTURE_COWORK_ID,
  ledgerFixtureSearches,
  ledgerUniqueCaseNumbers,
  loadLedgerRepository,
  seedLedgerFixture,
} from './ledger-fixture.mjs';
import { seedCostIndexAudit } from './cost-index-fixture.mjs';
import { measureAppQuit, scenarioWithQuit } from './quit-latency.mjs';
import { performanceScenarioStatus } from './scenario-status.mjs';
import { settlePerformanceScenario } from './smoke-acceptance.mjs';
import { percentile } from './statistics.mjs';

// apps/desktop-app/tests/performance/ -> repository root
const PERF_REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKSPACE_NAME = 'TypeScript pnpm Vite';
const WORKTREE_ID = 'demo-main';
const WORKTREE_BRANCH = 'demo-main';
const VIEWPORT = { width: 1400, height: 900 };
const PAINT_TIMEOUT_MS = 10_000;
const PERFORMANCE_PLUGIN_CACHE_TIMESTAMP = '2026-07-22T12:00:00.000Z';
const PERFORMANCE_PIPELINE_NAME = 'Performance Multi-Review Pipeline';
const REALISTIC_STARTUP_DEMO_APPS = Object.freeze([
  'ts-pnpm-vite',
  'ts-npm-next',
  'ts-bun-api',
  'ts-yarn-cli',
  'ts-npm-nest-monorepo',
  'python-fastapi-uv',
  'python-fastapi-venv',
  'go-cli',
  'rust-tauri-lite',
]);
const REALISTIC_STARTUP_REQUIRED_EVENTS = Object.freeze([
  'startup:unlock',
  'startup:automations:started',
  'startup:resource-monitor:started',
  'startup:shared-plan:completed',
  'startup:codex-capability-gc:requested',
  'startup:github-poller:started',
  'startup:updater:started',
  'startup:curated-mcp:started',
  'startup:skill-plugin-refresh:scheduled',
  'startup:skill-plugin-refresh:gate-fired',
  'startup:skill-plugin-refresh:started',
  'startup:code-graph-base:manager-started',
  'startup:code-graph-base:repositories-synced',
  'startup:code-graph-base:cycle-started',
  'startup:code-graph-base:repo-started',
  'startup:code-graph-base:worker-started',
]);
const REALISTIC_STARTUP_TERMINAL_EVENT_GROUPS = Object.freeze([
  Object.freeze({
    label: 'startup:codex-capability-gc:{completed|failed}',
    events: Object.freeze([
      'startup:codex-capability-gc:completed',
      'startup:codex-capability-gc:failed',
    ]),
  }),
]);
export const PERFORMANCE_PIPELINE_REVIEWER_COUNT = 6;
export const PERFORMANCE_PIPELINE_OUTPUT_BYTES_PER_REVIEWER = 1_000_000;
export const PERFORMANCE_PIPELINE_OUTPUT_CHUNK_BYTES = 4_096;
const POWER_USER_ADVISOR_CHAT_TAB_CAP = 14;
const POWER_USER_ADVISOR_MESSAGES_PER_TAB = 4;

export function missingRealisticStartupProcedureEvents(eventCounts) {
  const missingEvents = REALISTIC_STARTUP_REQUIRED_EVENTS.filter(
    (event) => !Number.isFinite(eventCounts[event]) || eventCounts[event] < 1,
  );
  for (const terminalGroup of REALISTIC_STARTUP_TERMINAL_EVENT_GROUPS) {
    if (
      !terminalGroup.events.some(
        (event) =>
          Number.isFinite(eventCounts[event]) && eventCounts[event] >= 1,
      )
    ) {
      missingEvents.push(terminalGroup.label);
    }
  }
  return missingEvents;
}

class RendererPaintTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`Timed out waiting ${timeoutMs}ms for the renderer to paint`);
    this.name = 'RendererPaintTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

const WAIT_UNTIL_TIMEOUT = Symbol('wait-until-timeout');

/** Thrown by a `waitUntil` check whose condition can no longer be met. */
export class FatalWaitError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FatalWaitError';
  }
}

export async function waitUntil(check, { timeoutMs, label, intervalMs = 100 }) {
  const deadline = performance.now() + timeoutMs;
  let lastError;
  while (performance.now() < deadline) {
    const remainingMs = Math.max(0, deadline - performance.now());
    const timeoutController = new AbortController();
    const checkPromise = Promise.resolve().then(check);
    checkPromise.catch(() => undefined);
    try {
      const value = await Promise.race([
        checkPromise,
        delay(remainingMs, WAIT_UNTIL_TIMEOUT, {
          signal: timeoutController.signal,
        }),
      ]);
      if (value === WAIT_UNTIL_TIMEOUT) break;
      if (value) return value;
    } catch (error) {
      if (error instanceof FatalWaitError) throw error;
      lastError = error;
    } finally {
      timeoutController.abort();
    }
    const intervalRemainingMs = deadline - performance.now();
    if (intervalRemainingMs > 0) {
      await delay(Math.min(intervalMs, intervalRemainingMs));
    }
  }
  throw new Error(
    `Timed out waiting for ${label}${lastError ? `: ${lastError}` : ''}`,
  );
}

export async function drainTransientItems({
  count,
  dismissFirst,
  now = () => performance.now(),
  pause = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  timeoutMs = 15_000,
  pollIntervalMs = 100,
  stableEmptyMs = 500,
}) {
  const startedAt = now();
  let emptySince = null;
  let dismissedCount = 0;
  while (now() - startedAt <= timeoutMs) {
    if ((await count()) > 0) {
      emptySince = null;
      try {
        await dismissFirst();
        dismissedCount += 1;
      } catch (error) {
        // Auto-dismiss can remove a toast while its button is becoming stable.
        // Recount under the existing deadline; a persistent obstruction fails.
        if (error?.name !== 'TimeoutError') throw error;
      }
    } else {
      emptySince ??= now();
      if (now() - emptySince >= stableEmptyMs) return dismissedCount;
    }
    await pause(pollIntervalMs);
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for transient items to remain empty`,
  );
}

/**
 * Opt out of the CAN-2836 activity-rail harness shim (`CanopyAppDriver.selectWorktree`
 * re-expands the rail by default for spec compatibility).
 *
 * Use in any scenario that never renders the activity rail: the shim adds
 * renderer round-trips — and possibly a click plus a poll — inside measured,
 * responsiveness-budgeted blocks, whose breach triggers a CPU-profile replay.
 *
 * Note this measures the SHIPPED default, in which the rail is collapsed. That
 * is deliberate, but it is NOT the pre-PR layout: pre-PR baselines had the rail
 * expanded, so the chat column here is correspondingly wider and a one-time
 * baseline shift in these scenarios is expected rather than a harness bug.
 */
const NO_ACTIVITY_RAIL = { expandDefaultActivityRail: false };

/**
 * Opens the default-collapsed activity rail through its own expand control,
 * as a user would. Unlike `expandDefaultActivityRail`, this needs no E2E panel
 * test API, so release-like runs reveal the rail too.
 */
async function openActivityRail(page) {
  const section = page.getByTestId('panel-content-activity-section');
  const expand = page
    .getByTestId('panel-group-group-activity')
    .getByTestId('panel-group-expand-group-activity');
  await expect(
    section.or(expand).filter({ visible: true }).first(),
  ).toBeVisible({ timeout: 30_000 });
  if (!(await section.isVisible())) {
    // CAN-2836's auto-reopen can unmount the control first; the assertion
    // below still requires the section.
    await expand.click({ timeout: 5_000 }).catch(() => undefined);
  }
  await expect(section).toBeVisible();
}

/**
 * Flattens the E2E transcript accumulator
 * (`renderer/src/lib/transcript-performance.ts`) into work counters: each
 * stage's run count (`<stage>.count`), its work units (`<stage>.work.<unit>`),
 * and the named counters (`counters.<name>`). Stage timings stay with the
 * monitor summary; they are not work.
 */
export function projectTranscriptWork(snapshot) {
  const flat = {};
  for (const [stage, aggregate] of Object.entries(snapshot?.stages ?? {})) {
    if (Number.isFinite(aggregate?.count)) {
      flat[`${stage}.count`] = aggregate.count;
    }
    for (const [unit, value] of Object.entries(aggregate?.work ?? {})) {
      if (Number.isFinite(value)) flat[`${stage}.work.${unit}`] = value;
    }
  }
  for (const [name, value] of Object.entries(snapshot?.counters ?? {})) {
    if (Number.isFinite(value)) flat[`counters.${name}`] = value;
  }
  return flat;
}

/**
 * The work done between two `sampleWork()` samples: the signed change of every
 * observed counter, per source. A source missing from either end is left out,
 * and its sampling error is kept so the scenario can discard that source.
 */
export function bracketWork(start, end) {
  const work = {};
  if (start?.transcript && end?.transcript) {
    work.transcript = diffWorkCounters(
      projectTranscriptWork(start.transcript),
      projectTranscriptWork(end.transcript),
    );
  }
  if (start?.chromium && end?.chromium) {
    work.chromium = diffWorkCounters(start.chromium, end.chromium);
  }
  const errors = [...(start?.errors ?? []), ...(end?.errors ?? [])];
  for (const source of APP_WORK_SOURCES) {
    const before = start?.[source];
    const after = end?.[source];
    if (!before || !after) continue;
    // A reset (or a renderer reload) between the samples hides the change.
    if (before.generation === after.generation) {
      work[source] = diffWorkCounters(before.counters, after.counters);
    } else {
      errors.push({ source, message: 'counters were reset between samples' });
    }
  }
  if (errors.length > 0) work.errors = errors;
  return work;
}

/**
 * Work over the whole measured window (the phase boundary). The transcript
 * accumulator is installed empty at monitor start, so its final values are
 * the window's work. A source with any sampling error, in the window or in a
 * task bracket, is dropped so no partial count reaches the metrics.
 */
export function scenarioWorkCounters(summary, tasks = []) {
  const errors = [
    ...(summary?.workErrors ?? []),
    ...tasks.flatMap((task) =>
      (task.work?.errors ?? []).map((error) => ({ ...error, task: task.kind })),
    ),
  ];
  const failed = new Set(errors.map((error) => error.source));
  const work = {};
  if (!failed.has('transcript')) {
    work.transcript = diffWorkCounters(
      {},
      projectTranscriptWork({
        stages: summary?.transcriptStages,
        counters: summary?.transcriptCounters,
      }),
    );
  }
  if (!failed.has('chromium') && summary?.chromiumWork) {
    work.chromium = summary.chromiumWork;
  }
  for (const source of APP_WORK_SOURCES) {
    if (!failed.has(source) && summary?.appWork?.[source]) {
      work[source] = summary.appWork[source];
    }
  }
  // Evidence of which backend served routed reads; not a work metric source.
  if (summary?.routeWork) work[ROUTE_EVIDENCE_SOURCE] = summary.routeWork;
  // W5 store evidence for the store arms (CAN-5532); not a work metric source.
  if (summary?.w5Work) work[W5_EVIDENCE_SOURCE] = summary.w5Work;
  if (errors.length > 0) work.errors = errors;
  return work;
}

/** Pull the transcript-page invoke and estimated main-to-renderer bytes from
 * one task bracket. Byte samples exist only when the counters profile enabled
 * IPC estimation; invoke counts are always collected by the work monitor. */
export function chatSwitchTranscriptPageCounters(task) {
  const ipc = task?.work?.ipc ?? {};
  const byteCounters = Object.entries(ipc).filter(
    ([key, value]) =>
      key.startsWith('send.') &&
      key.endsWith('.bytes') &&
      Number.isFinite(value),
  );
  return {
    transcriptPageInvokes: ipc['invoke.chat:get-transcript-page'] ?? 0,
    estimatedIpcSendBytes: byteCounters.reduce(
      (total, [, value]) => total + value,
      0,
    ),
    estimatedIpcSendBytesAvailable: byteCounters.length > 0,
  };
}

export async function recordTask(tasks, kind, operation, metadata = {}) {
  const taskId = `${kind}:${tasks.length + 1}`;
  // Work brackets sample outside the timed window and its renderer and trace
  // marks, so collecting counters never adds to a task's duration.
  const workStart = await tasks.workSample?.();
  await tasks.traceMark?.(`task:start:${taskId}`)?.catch(() => undefined);
  const rendererStart = await tasks.rendererMark?.(`task:start:${taskId}`);
  const startedAt = performance.now();
  try {
    const value = await operation();
    const rendererEnd = await tasks.rendererMark?.(`task:end:${taskId}:ok`);
    const durationMs = performance.now() - startedAt;
    const work = workStart
      ? bracketWork(workStart, await tasks.workSample())
      : undefined;
    tasks.push({
      kind,
      rendererStart,
      rendererEnd,
      status: 'ok',
      durationMs,
      ...(work ? { work } : {}),
      ...metadata,
    });
    await tasks.traceMark?.(`task:end:${taskId}:ok`)?.catch(() => undefined);
    return value;
  } catch (error) {
    tasks.push({
      kind,
      rendererStart,
      rendererEnd: await tasks.rendererMark?.(`task:end:${taskId}:error`),
      status:
        error instanceof RendererPaintTimeoutError ? 'unresponsive' : 'error',
      durationMs: performance.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
      ...metadata,
    });
    await tasks.traceMark?.(`task:end:${taskId}:error`)?.catch(() => undefined);
    throw error;
  }
}

export async function recordResponsiveTask(
  tasks,
  kind,
  operation,
  metadata,
  responsivenessBudgetMs,
) {
  const value = await recordTask(tasks, kind, operation, {
    ...metadata,
    responsivenessBudgetMs,
  });
  const task = tasks.at(-1);
  if (
    value &&
    typeof value === 'object' &&
    value.performanceTaskMetrics &&
    typeof value.performanceTaskMetrics === 'object'
  ) {
    Object.assign(task, value.performanceTaskMetrics);
  }
  const characters = Number(task.characters);
  const typingBurstMs = Number(task.typingBurstMs);
  if (
    Number.isFinite(characters) &&
    characters > 0 &&
    Number.isFinite(typingBurstMs)
  ) {
    task.typingBurstMsPerCharacter = typingBurstMs / characters;
    task.typingBurstCharactersPerSecond = (characters * 1_000) / typingBurstMs;
  }
  if (task.durationMs > responsivenessBudgetMs) {
    task.status = 'unresponsive';
    task.error = `${kind} exceeded the ${responsivenessBudgetMs}ms responsiveness liveness budget`;
  }
  return value;
}

/**
 * Brackets one streamed reply for the advisory frame-budget report
 * (`scenarios[].frameBudgets`): the renderer-clock window from before
 * `operation` starts to after it settles. Tasks recorded inside it keep their
 * own brackets.
 */
export async function recordStreamedReply(tasks, label, operation) {
  const start = await tasks.rendererMark?.(`reply:start:${label}`);
  let completed = false;
  try {
    const value = await operation();
    completed = true;
    return value;
  } finally {
    const end = await tasks.rendererMark?.(`reply:end:${label}`);
    tasks.streamedReplies?.push({ label, start, end, completed });
  }
}

/**
 * Brackets one interaction for the 120 Hz frame report
 * (`scenarios[].frameBudgets.windows` and `.areas`): the renderer-clock
 * window from before `operation` starts to after it settles, filed under a
 * focus area (`chat`, `scroll`, `switching`, `feedback`).
 */
export async function recordFrameWindow(tasks, area, label, operation) {
  const id = `${area}:${label}`;
  // Like task brackets, work samples and trace marks stay outside the
  // renderer-clock window.
  const workStart = await tasks.workSample?.();
  await tasks.traceMark?.(`frames:start:${id}`)?.catch(() => undefined);
  const start = await tasks.rendererMark?.(`frames:start:${id}`);
  let completed = false;
  try {
    const value = await operation();
    completed = true;
    return value;
  } finally {
    const end = await tasks.rendererMark?.(`frames:end:${id}`);
    await tasks.traceMark?.(`frames:end:${id}`)?.catch(() => undefined);
    const work = workStart
      ? bracketWork(workStart, await tasks.workSample())
      : undefined;
    tasks.frameWindows?.push({
      area,
      label,
      start,
      end,
      completed,
      ...(work ? { work } : {}),
    });
  }
}

/**
 * Waits until an activity signature stops changing for `quietMs`: the
 * "durable, rendered" settle of the sequential streaming variant. A signature
 * is a string, or `{ key, busy }` where `busy` means work is still in flight
 * although no counter moved; a busy or not-yet-`ready` signature never
 * settles, and `onDeferred` hears the first time that held a quiet window
 * back. Returns false instead of throwing when it never settles within
 * `timeoutMs`, so the caller decides what an unsettled step costs: the
 * sequential streaming variant fails the run (`requireQuiescence`), and a
 * sized active turn marks its bracket `settled: false`, which makes the
 * scaling ratios that read it unavailable.
 */
export async function waitForQuiescence({
  readSignature,
  quietMs = 150,
  timeoutMs = 10_000,
  pollMs = 25,
  ready = () => true,
  onDeferred,
  now = () => performance.now(),
  pause = (delayMs) => delay(delayMs),
}) {
  const read = async () => {
    const value = await readSignature();
    return typeof value === 'string' ? { key: value, busy: false } : value;
  };
  const startedAt = now();
  let last = await read();
  let stableSince = now();
  let deferred = false;
  while (now() - startedAt < timeoutMs) {
    await pause(pollMs);
    const current = await read();
    if (current.key !== last.key) {
      last = current;
      stableSince = now();
      continue;
    }
    last = current;
    if (now() - stableSince < quietMs) continue;
    if (!current.busy && ready(current)) return true;
    if (!deferred) {
      deferred = true;
      onDeferred?.(current);
    }
  }
  return false;
}

/**
 * `waitForQuiescence` for a step that must settle: a step whose work is
 * still in flight at the timeout would spill into the next bracket, so it
 * fails the run, naming the step, rather than producing brackets that only
 * look deterministic.
 */
export async function requireQuiescence(options, label) {
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (await waitForQuiescence({ ...options, timeoutMs })) return true;
  throw new Error(`${label} did not settle within ${timeoutMs} ms`);
}

/**
 * Chat work still in flight: main's commits, file syncs, ingested provider
 * events and chat IPC sends, and the renderer's React commits, plus whether
 * main has a file-system request in flight. A commit can wait on one sync
 * for longer than a quiet window on a busy disk, and then no counter moves
 * while events queue behind it, so such a request marks the signature busy.
 * Reading it goes through the inspector and CDP, never the app's IPC, so it
 * moves no counter itself.
 */
async function readChatActivity(electronApp, page) {
  const [main, react] = await Promise.all([
    // Polled every 25 ms while main streams, so a lost result is read again.
    evaluateMainWithRetry(() =>
      electronApp.evaluate(() => {
        const pendingFs = process
          .getActiveResourcesInfo()
          .filter((name) => name.startsWith('FSReq')).length;
        // A callback soon after this read reaches a microtask checkpoint, so
        // the inspector delivers the result before a collection can lose it.
        globalThis.setImmediate?.(() => {});
        const snapshot = globalThis.__CANOPY_WORK_COUNTERS__?.snapshot();
        if (!snapshot) return { key: 'unavailable', pendingFs, events: null };
        let chatSends = 0;
        for (const [key, value] of Object.entries(snapshot.ipc)) {
          if (key.startsWith('send.chat:') && key.endsWith('.messages')) {
            chatSends += value;
          }
        }
        const storage = snapshot.chatStorage;
        const events = snapshot.provider.eventsIngested ?? 0;
        return {
          key: [
            snapshot.generation,
            storage.commits ?? 0,
            (storage['syncs.file'] ?? 0) + (storage['syncs.directory'] ?? 0),
            events,
            chatSends,
          ].join(':'),
          pendingFs,
          events,
        };
      }),
    ),
    page.evaluate(
      () => window.__CANOPY_REACT_WORK__?.snapshot().counters.commits ?? null,
    ),
  ]);
  return {
    key: `${main.key}|${react}`,
    busy: main.pendingFs > 0,
    events: main.events,
  };
}

export async function nextPaint(page, timeoutMs = PAINT_TIMEOUT_MS) {
  const timeoutAbortController = new AbortController();
  const paintResult = page
    .evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    )
    .then(
      () => ({ painted: true }),
      (error) => ({ error }),
    );
  try {
    const result = await Promise.race([
      paintResult,
      delay(
        timeoutMs,
        { painted: false },
        {
          signal: timeoutAbortController.signal,
        },
      ).catch((error) =>
        error?.name === 'AbortError' ? undefined : { error },
      ),
    ]);
    if (result.error) throw result.error;
    if (!result.painted) throw new RendererPaintTimeoutError(timeoutMs);
  } finally {
    timeoutAbortController.abort();
  }
}

function visibleChatPanel(page) {
  return page.locator('[data-testid="panel-content-chat"]:visible').first();
}

function chatPanelForTab(page, chatId) {
  return page.locator(
    `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${chatId}"]`,
  );
}

async function visibleChatTabIds(page) {
  return page
    .locator('[data-testid^="panel-tab-panel-chat-"]')
    .evaluateAll((nodes) =>
      nodes
        .map((node) => node.getAttribute('data-testid'))
        .filter((id) => id !== null && !id.includes('panel-tab-close'))
        .map((id) => id.replace('panel-tab-panel-chat-', '')),
    );
}

export async function createFreshChatTab(page) {
  const before = new Set(await visibleChatTabIds(page));
  await openPanelAddMenu(page, 'group-chat');
  await page.getByTestId('panel-add-menu-item-new-chat').click();
  let createdChatId = null;
  await expect
    .poll(async () => {
      const after = await visibleChatTabIds(page);
      createdChatId = after.find((id) => !before.has(id)) ?? null;
      return createdChatId;
    })
    .not.toBeNull();
  return createdChatId;
}

async function enterComposerMessage(composer, message) {
  await composer.fill(message);
  await expect.poll(() => composer.textContent()).toContain(message);
}

async function setRendererTypingProbe(page, active) {
  await page.evaluate((nextActive) => {
    if (window.__CANOPY_DESKTOP_PERF__) {
      window.__CANOPY_DESKTOP_PERF__.typingProbeActive = nextActive;
    }
  }, active);
}

/**
 * Clears a typing probe's draft and verifies the clear.
 *
 * `fill('')` selects the Slate composer's contents through the DOM and then
 * presses Delete. Under concurrent streaming that Delete can leave the text in
 * place (a baseline worktree-concurrency run kept iteration 7's draft). An
 * unverified clear then corrupts the next iteration: a tab switch saves the
 * leftover text as the tab's draft, restores it, and the next burst types into
 * the middle of it. `marker` is the prefix every probe draft starts with.
 */
export async function clearComposerDraft(
  composer,
  marker,
  { timeoutMs = 15_000 } = {},
) {
  await expect(async () => {
    await composer.fill('');
    await expect
      .poll(
        async () =>
          composer.evaluate((editor) => {
            const walker = editor.ownerDocument.createTreeWalker(
              editor,
              NodeFilter.SHOW_TEXT,
            );
            let draft = '';
            for (
              let node = walker.nextNode();
              node !== null;
              node = walker.nextNode()
            ) {
              if (
                node.parentElement?.closest(
                  '[data-slate-placeholder], [data-slate-zero-width]',
                )
              )
                continue;
              draft += node.nodeValue ?? '';
            }
            return draft;
          }),
        {
          timeout: 1_000,
        },
      )
      .not.toContain(marker);
  }).toPass({ timeout: timeoutMs });
}

async function typeDraftAndWaitForPaint(
  page,
  { scenario, iteration, characters, verifyDraftState = false },
) {
  const draftMarker = `${scenario} responsiveness `;
  const prefix = `${draftMarker}${iteration}: `;
  const draft = `${prefix}${'typing through active background work '.repeat(
    Math.ceil(characters / 38),
  )}`.slice(0, characters);
  const composer = visibleChatPanel(page)
    .locator('[data-chat-composer-root]')
    .getByRole('textbox')
    .first();
  const send = visibleChatPanel(page).getByRole('button', {
    name: 'Send message',
    exact: true,
  });
  await expect(composer).toBeVisible({ timeout: 30_000 });
  await clearComposerDraft(composer, draftMarker);
  await composer.click();
  await setRendererTypingProbe(page, true);
  let keyboardDispatchMs;
  let textCommitMs;
  let typingBurstMs;
  try {
    const typingStartedAt = performance.now();
    await composer.pressSequentially(
      draft,
      verifyDraftState ? { delay: 5 } : undefined,
    );
    keyboardDispatchMs = performance.now() - typingStartedAt;
    await expect
      .poll(() => composer.textContent(), { timeout: 30_000 })
      .toContain(draft);
    if (verifyDraftState) await expect(send).toBeEnabled({ timeout: 5_000 });
    textCommitMs = performance.now() - typingStartedAt;
    await nextPaint(page);
    typingBurstMs = performance.now() - typingStartedAt;
  } finally {
    await setRendererTypingProbe(page, false);
  }
  if (verifyDraftState) {
    await composer.click();
    await composer.press('ControlOrMeta+A');
    await composer.press('Backspace');
    await expect.poll(() => composer.textContent()).not.toContain(draft);
    // Empty composers offer dictation when the native helper is available.
    const dictate = visibleChatPanel(page).getByRole('button', {
      name: 'Start voice dictation',
      exact: true,
    });
    await expect(send.or(dictate)).toBeVisible({ timeout: 5_000 });
    await expect(send.and(page.locator(':enabled'))).toHaveCount(0, {
      timeout: 5_000,
    });
    await nextPaint(page);
  } else {
    await clearComposerDraft(composer, draftMarker);
  }
  return {
    characters: draft.length,
    performanceTaskMetrics: {
      keyboardDispatchMs,
      textCommitMs,
      typingBurstMs,
    },
  };
}

async function openMainPage(page) {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  });
  await page.keyboard.press(
    `${process.platform === 'darwin' ? 'Meta' : 'Control'}+2`,
  );
  await expect(page.getByTestId('page-main')).toBeVisible({ timeout: 30_000 });
}

async function openPipelinesPage(page) {
  // The ⌘4 page shortcut opens the pipelines list directly on builds from
  // before and after CAN-3980 (which folded the Pipelines row into Workflows)
  // and CAN-3981 (which made that list Workflows › Library), so a baseline and
  // a candidate time the same single navigation.
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  });
  await page.keyboard.press(
    `${process.platform === 'darwin' ? 'Meta' : 'Control'}+4`,
  );
  await expect(
    page
      .getByTestId('page-pipelines')
      .or(page.getByTestId('page-workflows-library')),
  ).toBeVisible({ timeout: 30_000 });
}

export function seedWorkspace(userDataDir, apps = ['ts-pnpm-vite']) {
  const seed = seedDemoWorkspaces({
    userDataDir,
    apps,
    checkRuntimes: false,
  });
  // Non-startup scenarios measure their declared workload, not live provider
  // marketplace discovery. Without a valid cache, an eager catalog load falls
  // through to the user's real Claude/Codex registrations and performs
  // synchronous plugin scans on Electron main. Realistic startup scenarios
  // explicitly opt into the live background refresh when that work is in
  // scope.
  writeFileSync(
    path.join(userDataDir, 'plugins-cache.json'),
    `${JSON.stringify({
      version: 2,
      lastRefreshed: PERFORMANCE_PLUGIN_CACHE_TIMESTAMP,
      lastProviderRefreshAt: PERFORMANCE_PLUGIN_CACHE_TIMESTAMP,
      marketplaces: [],
    })}\n`,
    'utf8',
  );
  return seed;
}

function seedPreexistingWorktrees(
  userDataDir,
  requestedCount,
  seed = seedWorkspace(userDataDir),
) {
  const mainWorktreePath = seed.workspaces[0]?.worktreePath;
  if (!mainWorktreePath) {
    throw new Error('Large-worktree fixture has no default Git worktree');
  }

  const workspaceDir = path.join(userDataDir, 'workspaces', WORKSPACE_ID);
  const worktreesFilePath = path.join(workspaceDir, 'worktrees.json');
  const persisted = JSON.parse(readFileSync(worktreesFilePath, 'utf8'));
  const existingCount = persisted.worktrees.length;

  for (let index = existingCount; index < requestedCount; index += 1) {
    const ordinal = String(index).padStart(3, '0');
    const id = `perf-existing-${ordinal}`;
    const worktreePath = path.join(workspaceDir, 'worktrees', id);
    execFileSync(
      'git',
      [
        '-C',
        mainWorktreePath,
        'worktree',
        'add',
        '-b',
        id,
        worktreePath,
        'HEAD',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    persisted.worktrees.push({
      id,
      branchName: id,
      createdAt: new Date(
        Date.parse('2026-07-01T12:00:00.000Z') + index * 1_000,
      ).toISOString(),
      trackedBaseBranch: 'main',
    });
  }

  writeFileSync(
    worktreesFilePath,
    `${JSON.stringify(persisted, null, 2)}\n`,
    'utf8',
  );
  return persisted.worktrees.length;
}

export const MANY_WORKTREE_FILE_INDEX_WORKTREE_COUNT = 10;
export const MANY_WORKTREE_FILE_INDEX_FILES_PER_WORKTREE = 10_000;
export const MANY_WORKTREE_FILE_INDEX_FILES_PER_DIRECTORY = 100;
export const MANY_WORKTREE_FILE_INDEX_DIRECTORY_COUNT =
  MANY_WORKTREE_FILE_INDEX_FILES_PER_WORKTREE /
  MANY_WORKTREE_FILE_INDEX_FILES_PER_DIRECTORY;
const MANY_WORKTREE_FILE_INDEX_CORPUS_ROOT = 'perf-file-index-corpus';

export function buildManyWorktreeFileIndexCorpus(
  fileCount = MANY_WORKTREE_FILE_INDEX_FILES_PER_WORKTREE,
) {
  if (!Number.isInteger(fileCount) || fileCount < 1) {
    throw new Error('File-index corpus size must be a positive integer');
  }
  return Array.from({ length: fileCount }, (_, index) => {
    const directoryIndex = Math.floor(
      index / MANY_WORKTREE_FILE_INDEX_FILES_PER_DIRECTORY,
    );
    const sectionIndex = Math.floor(directoryIndex / 10);
    const batchIndex = directoryIndex % 10;
    const ordinal = String(index).padStart(5, '0');
    return {
      relativePath: path.posix.join(
        MANY_WORKTREE_FILE_INDEX_CORPUS_ROOT,
        `section-${String(sectionIndex).padStart(2, '0')}`,
        `batch-${String(batchIndex).padStart(2, '0')}`,
        `index-file-${ordinal}.txt`,
      ),
      contents: `Deterministic file-index corpus entry ${ordinal}.\n`,
    };
  });
}

function countFilesRecursively(directory) {
  const pendingDirectories = [directory];
  let fileCount = 0;
  while (pendingDirectories.length > 0) {
    const currentDirectory = pendingDirectories.pop();
    for (const entry of readdirSync(currentDirectory, {
      withFileTypes: true,
    })) {
      const entryPath = path.join(currentDirectory, entry.name);
      if (entry.isDirectory()) pendingDirectories.push(entryPath);
      else if (entry.isFile()) fileCount += 1;
    }
  }
  return fileCount;
}

function prepareManyWorktreeFileIndex(userDataDir) {
  const seed = seedWorkspace(userDataDir);
  const mainWorktreePath = seed.workspaces[0]?.worktreePath;
  if (!mainWorktreePath) {
    throw new Error('File-index fixture has no default Git worktree');
  }

  const corpus = buildManyWorktreeFileIndexCorpus();
  const createdDirectories = new Set();
  for (const file of corpus) {
    const filePath = path.join(
      mainWorktreePath,
      ...file.relativePath.split('/'),
    );
    const directory = path.dirname(filePath);
    if (!createdDirectories.has(directory)) {
      mkdirSync(directory, { recursive: true });
      createdDirectories.add(directory);
    }
    writeFileSync(filePath, file.contents, 'utf8');
  }
  execFileSync(
    'git',
    [
      '-C',
      mainWorktreePath,
      'add',
      '-f',
      '--',
      MANY_WORKTREE_FILE_INDEX_CORPUS_ROOT,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  execFileSync(
    'git',
    [
      '-C',
      mainWorktreePath,
      '-c',
      'user.name=Canopy Performance Harness',
      '-c',
      'user.email=performance@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'Seed deterministic file-index corpus',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  // Worktrees track `main`, checked out at the project root. Fast-forward it
  // to the corpus so each worktree has no diff, and the renderer does not
  // hold 10,000 changed files per worktree beside its file index.
  const corpusCommit = execFileSync(
    'git',
    ['-C', mainWorktreePath, 'rev-parse', 'HEAD'],
    { encoding: 'utf8' },
  ).trim();
  const projectRoot = path.dirname(
    execFileSync(
      'git',
      [
        '-C',
        mainWorktreePath,
        'rev-parse',
        '--path-format=absolute',
        '--git-common-dir',
      ],
      { encoding: 'utf8' },
    ).trim(),
  );
  execFileSync(
    'git',
    ['-C', projectRoot, 'merge', '--ff-only', '--quiet', corpusCommit],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  const baseCommit = execFileSync(
    'git',
    ['-C', mainWorktreePath, 'rev-parse', 'main'],
    { encoding: 'utf8' },
  ).trim();
  if (baseCommit !== corpusCommit) {
    throw new Error('File-index fixture base branch does not hold the corpus');
  }

  const worktreesSeeded = seedPreexistingWorktrees(
    userDataDir,
    MANY_WORKTREE_FILE_INDEX_WORKTREE_COUNT,
    seed,
  );
  if (worktreesSeeded < MANY_WORKTREE_FILE_INDEX_WORKTREE_COUNT) {
    throw new Error(
      `File-index fixture seeded ${worktreesSeeded} worktrees; expected ${MANY_WORKTREE_FILE_INDEX_WORKTREE_COUNT}`,
    );
  }
  const workspaceDir = path.join(userDataDir, 'workspaces', WORKSPACE_ID);
  const persisted = JSON.parse(
    readFileSync(path.join(workspaceDir, 'worktrees.json'), 'utf8'),
  );
  const seededPaths = new Map(
    seed.workspaces.map((workspace) => [workspace.id, workspace.worktreePath]),
  );
  const worktrees = persisted.worktrees
    .slice(0, MANY_WORKTREE_FILE_INDEX_WORKTREE_COUNT)
    .map((worktree) => ({
      ...worktree,
      worktreePath:
        seededPaths.get(worktree.id) ??
        path.join(workspaceDir, 'worktrees', worktree.id),
    }));

  for (const worktree of worktrees) {
    const actualFileCount = countFilesRecursively(
      path.join(worktree.worktreePath, MANY_WORKTREE_FILE_INDEX_CORPUS_ROOT),
    );
    if (actualFileCount !== MANY_WORKTREE_FILE_INDEX_FILES_PER_WORKTREE) {
      throw new Error(
        `File-index fixture ${worktree.id} contains ${actualFileCount} files; expected ${MANY_WORKTREE_FILE_INDEX_FILES_PER_WORKTREE}`,
      );
    }
  }

  return {
    worktrees,
    worktreesSeeded: worktrees.length,
    filesPerWorktree: MANY_WORKTREE_FILE_INDEX_FILES_PER_WORKTREE,
    filesPerDirectory: MANY_WORKTREE_FILE_INDEX_FILES_PER_DIRECTORY,
    directoriesPerWorktree: MANY_WORKTREE_FILE_INDEX_DIRECTORY_COUNT,
  };
}

export function buildManyWorktreeFileIndexCounters({
  worktreesSeeded,
  filesPerWorktree,
  filesPerDirectory,
  directoriesPerWorktree,
  paletteOpenDurationsMs,
  labWindow,
}) {
  if (!paletteOpenDurationsMs.length) {
    throw new Error('File-index scenario visited no worktrees');
  }
  return {
    worktreesSeeded,
    filesPerWorktree,
    filesPerDirectory,
    directoriesPerWorktree,
    totalFilesAcrossWorktrees: worktreesSeeded * filesPerWorktree,
    worktreesVisited: paletteOpenDurationsMs.length,
    averagePaletteOpenMs:
      paletteOpenDurationsMs.reduce((total, duration) => total + duration, 0) /
      paletteOpenDurationsMs.length,
    labWindow,
  };
}

export function buildCodeGraphFixtureSource(index, count) {
  if (
    !Number.isInteger(index) ||
    index < 0 ||
    !Number.isInteger(count) ||
    count < 4 ||
    index >= count
  ) {
    throw new Error('Code Graph fixture coordinates are invalid');
  }
  const a = (index + 1) % count;
  const b = (index + 2) % count;
  const c = (index + 3) % count;
  return `// Generated Code Graph concurrency fixture module ${index}.
import { fn${a}_0 } from './mod${a}';
import { fn${b}_1 } from './mod${b}';
import { fn${c}_2 } from './mod${c}';

export interface Shape${index} {
  id: number;
  label: string;
}

export function fn${index}_0(seed: number): number {
  return seed + ${index} + fn${a}_0(seed % 7);
}

export function fn${index}_1(seed: number): number {
  return fn${b}_1(seed % 5) + ${index};
}

export function fn${index}_2(seed: number): number {
  return fn${c}_2(seed % 3) * 2 + ${index};
}

export function fn${index}_3(input: Shape${index}): string {
  return \`\${input.label}:\${fn${index}_0(input.id)}:\${fn${index}_1(input.id)}\`;
}
`;
}

function generateCodeGraphFixture(worktreePath, count) {
  const fixtureDir = path.join(worktreePath, 'graph-fixture');
  mkdirSync(fixtureDir, { recursive: true });
  for (let index = 0; index < count; index += 1) {
    writeFileSync(
      path.join(fixtureDir, `mod${index}.ts`),
      buildCodeGraphFixtureSource(index, count),
      'utf8',
    );
  }
  return fixtureDir;
}

function prepareCodeGraphConcurrency(userDataDir, config) {
  const seed = seedWorkspace(userDataDir);
  seedPreexistingWorktrees(userDataDir, config.codeGraphBuildWorktrees, seed);
  const workspaceDir = path.join(userDataDir, 'workspaces', WORKSPACE_ID);
  const persisted = JSON.parse(
    readFileSync(path.join(workspaceDir, 'worktrees.json'), 'utf8'),
  );
  const mainWorktreePath = seed.workspaces[0]?.worktreePath;
  if (!mainWorktreePath) {
    throw new Error('Code Graph fixture has no default Git worktree');
  }
  const worktrees = persisted.worktrees
    .slice(0, config.codeGraphBuildWorktrees)
    .map((worktree) => {
      const worktreePath =
        worktree.id === WORKTREE_ID
          ? mainWorktreePath
          : path.join(workspaceDir, 'worktrees', worktree.id);
      generateCodeGraphFixture(
        worktreePath,
        config.codeGraphFixtureFilesPerWorktree,
      );
      return {
        id: worktree.id,
        branchName: worktree.branchName,
        worktreePath,
      };
    });
  if (worktrees.length !== config.codeGraphBuildWorktrees) {
    throw new Error(
      `Code Graph fixture created ${worktrees.length} worktrees; expected ${config.codeGraphBuildWorktrees}`,
    );
  }
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [{ id: 'code-graph-probe-chat', title: 'Code Graph Probe' }],
  });
  return {
    dataRoot: realpathSync(userDataDir),
    workspaceDir,
    worktrees,
    filesPerWorktree: config.codeGraphFixtureFilesPerWorktree,
  };
}

function startupChatBadges(index) {
  const needsHydration = index % 10 === 9;
  return {
    needsHydration,
    value: {
      version: 1,
      unreadChats: [],
      approvalChats: [],
      needsHydration,
      updatedAt: '2026-07-20T12:00:00.000Z',
    },
  };
}

function seedStartupTopology(
  userDataDir,
  requestedWorktreeCount,
  requestedWorkspaceCount,
  seed,
) {
  const workspacesRoot = path.join(userDataDir, 'workspaces');
  const indexPath = path.join(workspacesRoot, 'index.json');
  const primaryWorkspaceDir = path.join(workspacesRoot, WORKSPACE_ID);
  const primaryConfig = JSON.parse(
    readFileSync(path.join(primaryWorkspaceDir, 'workspace.json'), 'utf8'),
  );
  const mainWorktreePath = seed.workspaces[0]?.worktreePath;
  if (!mainWorktreePath) {
    throw new Error('Startup fixture has no default Git worktree');
  }

  const workspaceIndex = JSON.parse(readFileSync(indexPath, 'utf8'));
  const workspaceIds = [WORKSPACE_ID];
  for (let index = 1; index < requestedWorkspaceCount; index += 1) {
    const ordinal = String(index + 1).padStart(3, '0');
    const id = `perf-startup-ws-${ordinal}`;
    workspaceIds.push(id);
    workspaceIndex.workspaces.push({
      id,
      name: `Performance Workspace ${ordinal}`,
      type: 'single-repo',
      color: '#3B82F6',
      collapsed: false,
      order: workspaceIndex.workspaces.length,
    });
    const workspaceDir = path.join(workspacesRoot, id);
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(
      path.join(workspaceDir, 'workspace.json'),
      `${JSON.stringify(primaryConfig, null, 2)}\n`,
      'utf8',
    );
    writeFileSync(
      path.join(workspaceDir, 'worktrees.json'),
      `${JSON.stringify({ version: 1, worktrees: [] }, null, 2)}\n`,
      'utf8',
    );
  }
  writeFileSync(
    indexPath,
    `${JSON.stringify(workspaceIndex, null, 2)}\n`,
    'utf8',
  );

  const worktreesByWorkspace = new Map(
    workspaceIds.map((workspaceId) => {
      const filePath = path.join(workspacesRoot, workspaceId, 'worktrees.json');
      return [
        workspaceId,
        {
          filePath,
          persisted: JSON.parse(readFileSync(filePath, 'utf8')),
        },
      ];
    }),
  );

  const primary = worktreesByWorkspace.get(WORKSPACE_ID);
  const mainBadges = startupChatBadges(0);
  primary.persisted.worktrees[0] = {
    ...primary.persisted.worktrees[0],
    chatBadges: mainBadges.value,
  };
  let eagerHydrationWorktrees = 0;

  for (let index = 1; index < requestedWorktreeCount; index += 1) {
    const ordinal = String(index).padStart(3, '0');
    const id = `perf-startup-wt-${ordinal}`;
    const workspaceId = workspaceIds[index % workspaceIds.length];
    const workspace = worktreesByWorkspace.get(workspaceId);
    const worktreePath = path.join(
      workspacesRoot,
      workspaceId,
      'worktrees',
      id,
    );
    execFileSync(
      'git',
      [
        '-C',
        mainWorktreePath,
        'worktree',
        'add',
        '-b',
        id,
        worktreePath,
        'HEAD',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    const badges = startupChatBadges(index);
    if (badges.needsHydration) eagerHydrationWorktrees += 1;
    workspace.persisted.worktrees.push({
      id,
      branchName: id,
      createdAt: new Date(
        Date.parse('2026-07-01T12:00:00.000Z') + index * 1_000,
      ).toISOString(),
      trackedBaseBranch: 'main',
      chatBadges: badges.value,
    });
  }

  for (const { filePath, persisted } of worktreesByWorkspace.values()) {
    writeFileSync(filePath, `${JSON.stringify(persisted, null, 2)}\n`, 'utf8');
  }

  return {
    startupWorktrees: requestedWorktreeCount,
    startupWorkspaces: requestedWorkspaceCount,
    eagerHydrationWorktrees,
  };
}

function buildLoadedMessages(tabIndex, turns) {
  const messages = [];
  const baseTimestamp = Date.parse('2026-07-01T12:00:00.000Z');
  for (let turn = 0; turn < turns; turn += 1) {
    messages.push({
      id: `loaded-${tabIndex}-user-${turn}`,
      role: 'user',
      blocks: [
        {
          type: 'text',
          text: `Investigate performance case ${tabIndex}.${turn}: ${'workspace state '.repeat(8)}`,
        },
      ],
      timestamp: baseTimestamp + turn * 2_000,
    });
    messages.push({
      id: `loaded-${tabIndex}-assistant-${turn}`,
      role: 'assistant',
      blocks: [
        {
          type: 'text',
          text: `Completed case ${tabIndex}.${turn}. ${'Rendered transcript content and task status. '.repeat(10)}`,
        },
      ],
      timestamp: baseTimestamp + turn * 2_000 + 1_000,
    });
    messages.push({
      id: `loaded-${tabIndex}-timer-${turn}`,
      role: 'system',
      blocks: [
        {
          type: 'turn_timer',
          startedAt: baseTimestamp + turn * 2_000,
          completedAt: baseTimestamp + turn * 2_000 + 1_000,
        },
      ],
      timestamp: baseTimestamp + turn * 2_000 + 1_000,
    });
  }
  return messages;
}

function prepareLoadedUi(userDataDir, config) {
  const seed = seedWorkspace(userDataDir);
  seedLoadedUiState(userDataDir, config);
  return { seed };
}

/** The deterministic large tree `file-explorer` and `menu-surfaces` read. */
function seedExplorerPerformanceTree(worktreePath, config) {
  const treeRoot = path.join(worktreePath, 'explorer-performance');
  mkdirSync(treeRoot, { recursive: true });
  for (
    let directoryIndex = 0;
    directoryIndex < config.fileExplorerDirectories;
    directoryIndex += 1
  ) {
    const directoryName = `directory-${String(directoryIndex).padStart(4, '0')}`;
    const directoryPath = path.join(treeRoot, directoryName);
    mkdirSync(directoryPath, { recursive: true });
    for (
      let fileIndex = 0;
      fileIndex < config.fileExplorerFilesPerDirectory;
      fileIndex += 1
    ) {
      writeFileSync(
        path.join(
          directoryPath,
          `file-${String(fileIndex).padStart(4, '0')}.ts`,
        ),
        `export const value = ${directoryIndex * config.fileExplorerFilesPerDirectory + fileIndex};\n`,
      );
    }
  }
}

function prepareFileExplorer(userDataDir, config) {
  const seed = seedWorkspace(userDataDir);
  const worktreePath = seed.workspaces[0]?.worktreePath;
  if (!worktreePath) throw new Error('File explorer fixture has no worktree');
  seedExplorerPerformanceTree(worktreePath, config);
  mkdirSync(path.join(worktreePath, 'explorer-mutation-zone'));
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [
      { id: 'file-explorer-performance-chat', title: 'Explorer Performance' },
    ],
  });
  return {
    seed,
    worktreePath,
    totalFiles:
      config.fileExplorerDirectories * config.fileExplorerFilesPerDirectory,
  };
}

async function runFileExplorer({ page, app, config, tasks, fixture }) {
  const watchDiagnostic = process.env.CANOPY_FILE_TREE_WATCH_DIAGNOSTIC === '1';
  await recordTask(tasks, 'open_file_explorer', async () => {
    await openMainPage(page);
    await app.selectWorktree(WORKTREE_BRANCH, NO_ACTIVITY_RAIL);
    await openPanelAddMenu(page, 'group-chat');
    await page.getByTestId('panel-add-menu-item-file-explorer').click();
    await expect(page.getByTestId('files-tree-tab')).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByTestId('files-tree-tab')).toHaveAttribute(
      'data-watching',
      'true',
      { timeout: 30_000 },
    );
  });

  const explorer = page.getByTestId('files-tree-tab');
  const performanceRoot = explorer.locator(
    '[data-testid="files-tree-folder"]',
    {
      hasText: 'explorer-performance',
    },
  );
  await recordResponsiveTask(
    tasks,
    'expand_large_project_root',
    async () => {
      await expect(performanceRoot).toBeVisible({ timeout: 30_000 });
      await performanceRoot.click();
      await expect(
        explorer.locator('[data-testid="files-tree-folder"]', {
          hasText: 'directory-0000',
        }),
      ).toBeVisible({ timeout: 30_000 });
      await nextPaint(page);
    },
    { files: fixture.totalFiles },
    config.responsivenessBudgetMs,
  );

  const navigationCount = Math.min(
    config.navigationIterations,
    config.fileExplorerDirectories,
  );
  for (let index = 0; index < navigationCount; index += 1) {
    const directoryName = `directory-${String(index).padStart(4, '0')}`;
    const relativeFile = `explorer-performance/${directoryName}/file-${String(
      config.fileExplorerFilesPerDirectory - 1,
    ).padStart(4, '0')}.ts`;
    await recordResponsiveTask(
      tasks,
      'navigate_large_directory',
      async () => {
        const folder = explorer.locator('[data-testid="files-tree-folder"]', {
          hasText: directoryName,
        });
        await folder.click();
        await expect(
          explorer.locator(
            `[data-testid="files-tree-row"][data-path="${relativeFile}"]`,
          ),
        ).toBeVisible({ timeout: 30_000 });
        await folder.click();
        await nextPaint(page);
      },
      { iteration: index + 1, files: config.fileExplorerFilesPerDirectory },
      config.responsivenessBudgetMs,
    );
  }

  await recordResponsiveTask(
    tasks,
    'search_large_file_tree',
    async () => {
      await explorer.getByTestId('files-tree-search-toggle').click();
      const input = explorer.getByTestId('files-tree-search-input');
      await input.fill('directory-0001/file-0001');
      await expect(
        explorer.locator(
          '[data-testid="files-tree-row"][data-path="explorer-performance/directory-0001/file-0001.ts"]',
        ),
      ).toBeVisible({ timeout: 30_000 });
      await input.press('Escape');
      await nextPaint(page);
    },
    { files: fixture.totalFiles },
    config.responsivenessBudgetMs,
  );

  const mutationZone = explorer.locator('[data-testid="files-tree-folder"]', {
    hasText: 'explorer-mutation-zone',
  });
  await mutationZone.click();
  let watchProbeRegistrationError = null;
  if (watchDiagnostic) {
    try {
      await page.evaluate(
        ({ projectId, worktreeId }) => {
          window.__performanceFileTreeWatchProbe?.dispose();
          const state = { eventCount: 0, changeCount: 0 };
          const dispose = window.api.onFileTreeChanged((event) => {
            if (
              event.projectId !== projectId ||
              event.worktreeId !== worktreeId
            ) {
              return;
            }
            state.eventCount = Math.min(state.eventCount + 1, 10_000);
            state.changeCount = Math.min(
              state.changeCount + (event.changeCount ?? 0),
              10_000,
            );
          });
          window.__performanceFileTreeWatchProbe = { state, dispose };
        },
        { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
      );
    } catch (error) {
      watchProbeRegistrationError =
        error instanceof Error ? error.message.slice(0, 256) : 'unknown';
    }
  }
  await recordResponsiveTask(
    tasks,
    'detect_filesystem_mutation_burst',
    async () => {
      for (
        let index = 0;
        index < config.fileExplorerMutationBurst;
        index += 1
      ) {
        writeFileSync(
          path.join(
            fixture.worktreePath,
            'explorer-mutation-zone',
            `external-${String(index).padStart(4, '0')}.txt`,
          ),
          `${index}\n`,
        );
      }
      const lastPath = `explorer-mutation-zone/external-${String(
        config.fileExplorerMutationBurst - 1,
      ).padStart(4, '0')}.txt`;
      const lastRow = explorer.locator(
        `[data-testid="files-tree-row"][data-path="${lastPath}"]`,
      );
      const captureMutationFailure = (error, phase) =>
        captureScenarioFailure(
          error,
          `file-explorer-${phase}`,
          async () => {
            const diskPath = path.join(fixture.worktreePath, lastPath);
            const diskExists = existsSync(diskPath);
            const mutationDir = path.dirname(diskPath);
            const diskEntryCount = existsSync(mutationDir)
              ? readdirSync(mutationDir).length
              : 0;
            let watchEvidence = null;
            if (watchDiagnostic) {
              try {
                watchEvidence = await page.evaluate(
                  async ({ projectId, worktreeId, targetPath }) => {
                    const eventCounts = window.__performanceFileTreeWatchProbe
                      ? { ...window.__performanceFileTreeWatchProbe.state }
                      : null;
                    let timer;
                    const directDirectory = await Promise.race([
                      window.api
                        .getFileTreeDirectory({
                          projectId,
                          worktreeId,
                          repoId: projectId,
                          relativeDir: 'explorer-mutation-zone',
                        })
                        .then(
                          (response) => ({
                            status: 'ok',
                            entryCount: response.entries.length,
                            targetPresent: response.entries.some(
                              (entry) => entry.relativePath === targetPath,
                            ),
                          }),
                          (error) => ({
                            status: 'error',
                            reason: String(error).slice(0, 256),
                          }),
                        ),
                      new Promise((resolve) => {
                        timer = window.setTimeout(
                          () => resolve({ status: 'timed-out' }),
                          600,
                        );
                      }),
                    ]);
                    window.clearTimeout(timer);
                    return { eventCounts, directDirectory };
                  },
                  {
                    projectId: WORKSPACE_ID,
                    worktreeId: WORKTREE_ID,
                    targetPath: lastPath,
                  },
                );
              } catch (diagnosticError) {
                watchEvidence = {
                  collection: 'failed',
                  reason: String(diagnosticError).slice(0, 256),
                };
              }
            }
            const ui = await explorer.evaluate((element, targetPath) => {
              const rows = element.querySelectorAll(
                '[data-testid="files-tree-row"][data-path^="explorer-mutation-zone/"]',
              );
              const recentRows = [];
              for (
                let index = Math.max(0, rows.length - 8);
                index < rows.length;
                index += 1
              )
                recentRows.push(rows[index]?.getAttribute('data-path'));
              const mutationFolder = element.querySelector(
                '[data-testid="files-tree-folder"][data-path="explorer-mutation-zone"]',
              );
              const scroll = element.querySelector(
                '[data-testid="files-tree-scroll"]',
              );
              return {
                watching: element.getAttribute('data-watching'),
                searchOpen: Boolean(
                  element.querySelector(
                    '[data-testid="files-tree-search-input"]',
                  ),
                ),
                targetRowCount: element.querySelectorAll(
                  `[data-testid="files-tree-row"][data-path="${targetPath}"]`,
                ).length,
                mutationRowCount: rows.length,
                mutationRows: recentRows,
                mutationFolderExpanded:
                  mutationFolder?.getAttribute('aria-expanded') ?? null,
                scroll: scroll
                  ? {
                      top: scroll.scrollTop,
                      height: scroll.clientHeight,
                      contentHeight: scroll.scrollHeight,
                    }
                  : null,
                folderError: element
                  .querySelector('[data-testid="files-tree-folder-error"]')
                  ?.textContent?.slice(0, 256),
              };
            }, lastPath);
            return {
              phase,
              diskExists,
              diskEntryCount,
              ui,
              ...(watchDiagnostic
                ? { watchProbeRegistrationError, watchEvidence }
                : {}),
            };
          },
          { timeoutMs: watchDiagnostic ? 1_800 : 1_000 },
        );
      try {
        await expect(lastRow).toBeVisible({ timeout: 30_000 });
      } catch (error) {
        await captureMutationFailure(error, 'appearance');
      }
      rmSync(
        path.join(
          fixture.worktreePath,
          'explorer-mutation-zone',
          path.basename(lastPath),
        ),
      );
      try {
        await expect(lastRow).toHaveCount(0, { timeout: 30_000 });
      } catch (error) {
        await captureMutationFailure(error, 'deletion');
      }
      await nextPaint(page);
    },
    { mutations: config.fileExplorerMutationBurst + 1 },
    config.responsivenessBudgetMs,
  ).finally(async () => {
    if (watchDiagnostic) {
      await page
        .evaluate(() => {
          window.__performanceFileTreeWatchProbe?.dispose();
          delete window.__performanceFileTreeWatchProbe;
        })
        .catch(() => undefined);
    }
  });

  await recordTask(
    tasks,
    'hidden_explorer_is_idle_and_reconciles',
    async () => {
      await page
        .locator('[role="tab"][data-panel-kind="chat"]')
        .first()
        .click();
      await expect(explorer).not.toBeVisible();
      await expect(explorer).toHaveAttribute('data-watching', 'false');
      writeFileSync(
        path.join(fixture.worktreePath, 'hidden-explorer-change.txt'),
        'changed while hidden\n',
      );
      await delay(400);
      await expect(
        explorer.locator(
          '[data-testid="files-tree-row"][data-path="hidden-explorer-change.txt"]',
        ),
      ).toHaveCount(0);
      await page
        .locator('[role="tab"][data-panel-kind="file-explorer"]')
        .first()
        .click();
      await expect(explorer).toBeVisible();
      await expect(
        explorer.locator(
          '[data-testid="files-tree-row"][data-path="hidden-explorer-change.txt"]',
        ),
      ).toBeVisible({ timeout: 30_000 });
    },
  );

  return {
    ...(watchDiagnostic
      ? { diagnosticOnly: true, timingComparable: false }
      : {}),
    directories: config.fileExplorerDirectories,
    filesPerDirectory: config.fileExplorerFilesPerDirectory,
    files: fixture.totalFiles,
    navigatedDirectories: navigationCount,
    filesystemMutations: config.fileExplorerMutationBurst + 2,
  };
}

function seedLoadedUiState(userDataDir, config) {
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: Array.from({ length: config.loadedChatTabs }, (_, index) => ({
      id: `loaded-chat-${index + 1}`,
      title: `Loaded Chat ${index + 1}`,
      messages: buildLoadedMessages(index + 1, config.loadedTurnsPerChat),
    })),
    activeTabId: 'loaded-chat-1',
  });
  for (let index = 0; index < config.loadedPipelineExecutions; index += 1) {
    const startedAt = new Date(
      Date.parse('2026-07-01T12:00:00.000Z') + index * 60_000,
    );
    seedPipelineExecution({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      execution: {
        id: `loaded-execution-${index + 1}`,
        pipelineId: `loaded-pipeline-${(index % 5) + 1}`,
        pipelineName: `Loaded Pipeline ${(index % 5) + 1}`,
        status: 'success',
        startedAt: startedAt.toISOString(),
        completedAt: new Date(startedAt.getTime() + 12_000).toISOString(),
      },
    });
  }
}

const PLUGIN_PICKER_TIMESTAMP = PERFORMANCE_PLUGIN_CACHE_TIMESTAMP;

function pluginPickerSkillSourceDirectory(sourceId) {
  if (process.platform !== 'win32') return sourceId;
  return Array.from(sourceId, (character) => {
    const codePoint = character.charCodeAt(0);
    return codePoint < 32 || '%<>:"/\\|?*'.includes(character)
      ? `%${codePoint.toString(16).toUpperCase().padStart(2, '0')}`
      : character;
  }).join('');
}

function seedPluginPickerSkills(userDataDir, count) {
  const sourceId = 'custom:app';
  const sourceDirectory = path.join(
    userDataDir,
    'skills',
    pluginPickerSkillSourceDirectory(sourceId),
  );
  const skills = [];
  for (let index = 0; index < count; index += 1) {
    const ordinal = String(index).padStart(4, '0');
    const name = `perf-skill-${ordinal}`;
    const skillDirectory = path.join(sourceDirectory, name);
    mkdirSync(skillDirectory, { recursive: true });
    writeFileSync(
      path.join(skillDirectory, 'SKILL.md'),
      [
        '---',
        `name: ${name}`,
        `description: Performance picker skill ${ordinal}.`,
        '---',
        '',
        `# Performance picker skill ${ordinal}`,
        '',
        'Deterministic synthetic capability for the desktop benchmark.',
        '',
      ].join('\n'),
      'utf8',
    );
    skills.push({ name, sourceId });
  }
  return skills;
}

function seedPluginPickerPlugins(userDataDir, count) {
  const pluginsPerMarketplace = 50;
  const marketplaces = [];
  const plugins = [];
  const emptyDetails = {
    skills: [],
    agents: [],
    commands: [],
    hooks: [],
    mcpServers: [],
    lspServers: [],
    hasReadme: false,
  };
  for (
    let marketplaceIndex = 0;
    marketplaceIndex < Math.ceil(count / pluginsPerMarketplace);
    marketplaceIndex += 1
  ) {
    const marketplaceOrdinal = String(marketplaceIndex).padStart(3, '0');
    const marketplaceId = `performance/market-${marketplaceOrdinal}`;
    const marketplacePlugins = [];
    const start = marketplaceIndex * pluginsPerMarketplace;
    const end = Math.min(count, start + pluginsPerMarketplace);
    for (let index = start; index < end; index += 1) {
      const ordinal = String(index).padStart(4, '0');
      const name = `perf-plugin-${ordinal}`;
      const plugin = {
        name,
        description: `Performance picker plugin ${ordinal}.`,
        sourcePath: `plugins/${name}`,
        marketplaceId,
        details: emptyDetails,
        providerSupport: { claude: 'native', codex: 'none' },
        facets: {},
      };
      marketplacePlugins.push(plugin);
      plugins.push({ name, marketplaceId });
    }
    marketplaces.push({
      id: marketplaceId,
      name: `Performance Market ${marketplaceOrdinal}`,
      description: 'Deterministic synthetic performance marketplace.',
      sourceType: 'github',
      sourceUrl: `https://github.com/performance/market-${marketplaceOrdinal}`,
      installLocation: `/tmp/performance-market-${marketplaceOrdinal}`,
      lastUpdated: PLUGIN_PICKER_TIMESTAMP,
      pluginCount: marketplacePlugins.length,
      plugins: marketplacePlugins,
      providerStatus: {
        claude: {
          provider: 'claude',
          state: 'valid',
          accepted: true,
          pluginCount: marketplacePlugins.length,
          lastCheckedAt: PLUGIN_PICKER_TIMESTAMP,
        },
        codex: {
          provider: 'codex',
          state: 'invalid',
          accepted: false,
          pluginCount: 0,
          lastCheckedAt: PLUGIN_PICKER_TIMESTAMP,
        },
      },
      validProviders: ['claude'],
    });
  }
  writeFileSync(
    path.join(userDataDir, 'plugins-cache.json'),
    `${JSON.stringify({
      version: 2,
      lastRefreshed: PLUGIN_PICKER_TIMESTAMP,
      lastProviderRefreshAt: PLUGIN_PICKER_TIMESTAMP,
      marketplaces,
    })}\n`,
    'utf8',
  );
  return plugins;
}

function seedPluginPickerMcpServers(userDataDir, count) {
  const servers = Array.from({ length: count }, (_, index) => {
    const ordinal = String(index).padStart(4, '0');
    const idSuffix = String(index).padStart(12, '0');
    return {
      definition: {
        id: `00000000-0000-4000-8000-${idSuffix}`,
        name: `perf-mcp-${ordinal}`,
        description: `Performance picker MCP server ${ordinal}.`,
        type: 'command',
        command: 'npx',
        args: [`performance-mcp-${ordinal}`],
        createdAt: PLUGIN_PICKER_TIMESTAMP,
        updatedAt: PLUGIN_PICKER_TIMESTAMP,
      },
      configs: [
        {
          id: `10000000-0000-4000-8000-${idSuffix}`,
          name: 'Default',
          description: 'Enabled deterministic benchmark configuration.',
          enabled: true,
          envVars: {},
          extraArgs: [],
          extraHeaders: {},
          createdAt: PLUGIN_PICKER_TIMESTAMP,
          updatedAt: PLUGIN_PICKER_TIMESTAMP,
        },
      ],
    };
  });
  seedMcpServers({ userDataDir, servers });
  return servers.map((server) => ({
    name: server.definition.name,
    serverId: server.definition.id,
    configId: server.configs[0].id,
  }));
}

function pluginPickerTargets(fixture, iterations) {
  const pluginTargetCount = iterations - 2;
  const targets = Array.from({ length: pluginTargetCount }, (_, index) => {
    const targetIndex = Math.floor(
      ((index + 1) * fixture.plugins.length) / (pluginTargetCount + 1),
    );
    return { kind: 'plugin', ...fixture.plugins[targetIndex] };
  });
  targets.push({ kind: 'skill', ...fixture.skills.at(-1) });
  targets.push({ kind: 'mcp', ...fixture.mcpServers.at(-1) });
  return targets;
}

/**
 * Target toggled while the unfiltered catalog is on screen. The search targets
 * are always selected against a one-row result set, which measures the paint
 * floor rather than the cost of a selection change over the whole catalog.
 *
 * Rows sort by name, and `perf-mcp-*` sorts ahead of `perf-plugin-*` and
 * `perf-skill-*`, so the first MCP row stays near the top of the list and is on
 * screen whether or not the table body is windowed.
 */
function pluginPickerFullListTarget(fixture) {
  return { kind: 'mcp', ...fixture.mcpServers[0] };
}

/**
 * Reads the picker's logical filtered row count. The table publishes this so
 * automation does not have to count `tbody tr`, which only equals the filtered
 * total while the body is unwindowed.
 */
async function pluginPickerRowCount(dialog) {
  const value = await dialog
    .getByTestId('unified-table')
    .getAttribute('data-row-count');
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Rows actually mounted in the DOM. Recorded alongside the logical row count so
 * a run proves whether the table body windowed instead of leaving it to be
 * inferred from downstream timings.
 */
export async function pluginPickerDomRowCount(dialog) {
  return dialog.locator('tbody tr[data-index]').count();
}

async function pluginPickerVirtualized(dialog) {
  const value = await dialog
    .getByTestId('unified-table')
    .getAttribute('data-virtualized');
  return value === 'true';
}

async function waitForPluginPickerCatalog(dialog, catalogItems) {
  return waitUntil(
    async () => {
      const count = await pluginPickerRowCount(dialog);
      return count >= catalogItems ? count : 0;
    },
    {
      timeoutMs: 60_000,
      label: `${catalogItems} plugin picker rows`,
      intervalMs: 50,
    },
  );
}

function preparePluginPicker(userDataDir, config) {
  seedWorkspace(userDataDir);
  const seededChat = seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [
      {
        id: 'plugin-picker-chat',
        title: 'Plugin Picker Performance',
        pluginSelections: {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [],
          mcpServerRefs: [],
        },
      },
    ],
  });
  const fixture = {
    chatFilePath: seededChat.filePath,
    plugins: seedPluginPickerPlugins(userDataDir, config.pluginPickerPlugins),
    skills: seedPluginPickerSkills(userDataDir, config.pluginPickerSkills),
    mcpServers: seedPluginPickerMcpServers(
      userDataDir,
      config.pluginPickerMcpServers,
    ),
  };
  const targets = pluginPickerTargets(
    fixture,
    config.pluginPickerSearchIterations,
  );
  const fullListTarget = pluginPickerFullListTarget(fixture);
  return {
    ...fixture,
    targets,
    fullListTarget,
    expectedTargets: [...targets, fullListTarget],
    catalogItems:
      fixture.plugins.length +
      fixture.skills.length +
      fixture.mcpServers.length,
  };
}

export function resolvePluginPickerChatIndex(chatFilePath) {
  const native = path.join(
    path.dirname(path.dirname(chatFilePath)),
    'chat-storage-v2',
    path.basename(chatFilePath, '.json'),
    'live-index.json',
  );
  return existsSync(native) ? native : chatFilePath;
}

export function readPluginPickerSelections(chatFilePath) {
  const index = resolvePluginPickerChatIndex(chatFilePath);
  if (!existsSync(index)) return null;
  const chatFile = JSON.parse(readFileSync(index, 'utf8'));
  const tab = chatFile.tabs?.find(
    (candidate) => candidate.id === 'plugin-picker-chat',
  );
  return tab?.pluginSelections ?? null;
}

function pluginPickerSelectionsMatch(actual, targets) {
  if (!actual) return false;
  const expectedSkills = targets
    .filter((target) => target.kind === 'skill')
    .map((target) => `${target.sourceId}/${target.name}`)
    .sort();
  const expectedPlugins = targets
    .filter((target) => target.kind === 'plugin')
    .map((target) => `${target.marketplaceId}/${target.name}`)
    .sort();
  const expectedMcp = targets
    .filter((target) => target.kind === 'mcp')
    .map((target) => `${target.serverId}/${target.configId}`)
    .sort();
  return (
    JSON.stringify(
      (actual.skillRefs ?? [])
        .map((ref) => `${ref.sourceId}/${ref.skillName}`)
        .sort(),
    ) === JSON.stringify(expectedSkills) &&
    JSON.stringify(
      (actual.pluginRefs ?? [])
        .map((ref) => `${ref.marketplaceId}/${ref.pluginName}`)
        .sort(),
    ) === JSON.stringify(expectedPlugins) &&
    JSON.stringify(
      (actual.mcpServerRefs ?? [])
        .map((ref) => `${ref.serverId}/${ref.configId}`)
        .sort(),
    ) === JSON.stringify(expectedMcp)
  );
}

async function searchPluginPicker(page, dialog, target) {
  const search = dialog.getByPlaceholder('Search by name…');
  await search.fill('');
  await search.click();
  await setRendererTypingProbe(page, true);
  let keyboardDispatchMs;
  let textCommitMs;
  let typingBurstMs;
  try {
    const startedAt = performance.now();
    await search.pressSequentially(target.name);
    keyboardDispatchMs = performance.now() - startedAt;
    await expect(
      dialog.getByRole('checkbox', { name: `Select ${target.name}` }),
    ).toBeVisible({ timeout: 30_000 });
    textCommitMs = performance.now() - startedAt;
    await nextPaint(page);
    typingBurstMs = performance.now() - startedAt;
  } finally {
    await setRendererTypingProbe(page, false);
  }
  return {
    characters: target.name.length,
    performanceTaskMetrics: {
      keyboardDispatchMs,
      textCommitMs,
      typingBurstMs,
    },
  };
}

async function runPluginPicker({ page, app, config, tasks, fixture }) {
  await openMainPage(page);
  await app.selectWorktree(WORKTREE_BRANCH, NO_ACTIVITY_RAIL);
  await expect(visibleChatPanel(page)).toBeVisible({ timeout: 30_000 });

  let dialog;
  let renderedRows;
  await page.getByTestId('chat-input-plus-button').click();
  await recordResponsiveTask(
    tasks,
    'open_plugin_picker',
    async () => {
      await page.getByTestId('chat-plugins-button').click();
      dialog = page.locator('[role="dialog"]').filter({ hasText: 'Plugins' });
      await expect(dialog).toBeVisible({ timeout: 30_000 });
      renderedRows = await waitForPluginPickerCatalog(
        dialog,
        fixture.catalogItems,
      );
      await nextPaint(page);
    },
    { catalogItems: fixture.catalogItems },
    config.responsivenessBudgetMs,
  );

  for (let index = 0; index < fixture.targets.length; index += 1) {
    const target = fixture.targets[index];
    await recordResponsiveTask(
      tasks,
      'search_plugin_picker',
      () => searchPluginPicker(page, dialog, target),
      {
        iteration: index + 1,
        targetKind: target.kind,
        characters: target.name.length,
      },
      config.responsivenessBudgetMs,
    );
    const checkbox = dialog.getByRole('checkbox', {
      name: `Select ${target.name}`,
    });
    await recordResponsiveTask(
      tasks,
      'select_plugin_picker_item',
      async () => {
        await checkbox.click();
        await expect(checkbox).toBeChecked({ timeout: 30_000 });
        await nextPaint(page);
      },
      { iteration: index + 1, targetKind: target.kind },
      config.responsivenessBudgetMs,
    );
  }

  // Every selection above ran against a one-row result set, which measures the
  // paint floor rather than a selection change over the whole catalog. Clear
  // the search and toggle once more with the full list on screen.
  const clearedRows = await recordResponsiveTask(
    tasks,
    'clear_plugin_picker_search',
    async () => {
      await dialog.getByPlaceholder('Search by name…').fill('');
      const count = await waitForPluginPickerCatalog(
        dialog,
        fixture.catalogItems,
      );
      await nextPaint(page);
      return count;
    },
    { catalogItems: fixture.catalogItems },
    config.responsivenessBudgetMs,
  );

  const fullListDomRows = await pluginPickerDomRowCount(dialog);
  const fullListVirtualized = await pluginPickerVirtualized(dialog);

  const fullListCheckbox = dialog.getByRole('checkbox', {
    name: `Select ${fixture.fullListTarget.name}`,
  });
  await recordResponsiveTask(
    tasks,
    'select_plugin_picker_item_full_list',
    async () => {
      await fullListCheckbox.click();
      await expect(fullListCheckbox).toBeChecked({ timeout: 30_000 });
      await nextPaint(page);
    },
    {
      targetKind: fixture.fullListTarget.kind,
      catalogItems: fixture.catalogItems,
    },
    config.responsivenessBudgetMs,
  );

  const persisted = await recordResponsiveTask(
    tasks,
    'save_plugin_picker',
    async () => {
      await dialog.getByRole('button', { name: 'Save' }).click();
      await expect(dialog).toHaveCount(0, { timeout: 60_000 });
      const selections = await waitUntil(
        () => {
          const current = readPluginPickerSelections(fixture.chatFilePath);
          return pluginPickerSelectionsMatch(current, fixture.expectedTargets)
            ? current
            : null;
        },
        {
          timeoutMs: 60_000,
          label: 'plugin picker selections to persist on the chat tab',
          intervalMs: 25,
        },
      );
      await nextPaint(page);
      return selections;
    },
    { selectedItems: fixture.expectedTargets.length },
    config.responsivenessBudgetMs,
  );

  return {
    catalogItems: fixture.catalogItems,
    catalogPlugins: fixture.plugins.length,
    catalogSkills: fixture.skills.length,
    catalogMcpServers: fixture.mcpServers.length,
    renderedRows,
    clearedRows,
    domRows: fullListDomRows,
    virtualized: fullListVirtualized ? 1 : 0,
    searchIterations: fixture.targets.length,
    selectedPlugins: persisted.pluginRefs.length,
    selectedSkills: persisted.skillRefs.length,
    selectedMcpServers: persisted.mcpServerRefs.length,
    persistedChatBytes: statSync(
      resolvePluginPickerChatIndex(fixture.chatFilePath),
    ).size,
  };
}

/**
 * `menu-surfaces`: every hand-keyed menu family on one launch, against the
 * `plugin-picker` catalog and the `file-explorer` tree, so a menu migration
 * has a baseline for the surfaces no other scenario reaches: the palettes, the
 * `/` and `@` typeaheads, the plus menu and the Home branch picker. Each task
 * ends at the next paint; a keystroke task ends when its character is painted,
 * and the `_results` tasks end when the ranked row is painted, because the
 * file palette defers its ranking.
 */
function prepareMenuSurfaces(userDataDir, config) {
  const seed = seedWorkspace(userDataDir);
  const worktreePath = seed.workspaces[0]?.worktreePath;
  if (!worktreePath) throw new Error('Menu surfaces fixture has no worktree');
  seedExplorerPerformanceTree(worktreePath, config);
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [
      {
        id: 'menu-surfaces-chat',
        title: 'Menu Surfaces Performance',
        // A seeded chat has no session to discover commands from.
        discovery: {
          slashCommands: Array.from(
            { length: config.pluginPickerSkills },
            (_, index) => ({
              name: `perf-skill-${String(index).padStart(4, '0')}`,
              description: 'A seeded command for the slash menu',
            }),
          ),
          mcpServers: [],
          discoveredAt: PERFORMANCE_PLUGIN_CACHE_TIMESTAMP,
          providerType: 'claude',
        },
      },
    ],
  });
  const plugins = seedPluginPickerPlugins(
    userDataDir,
    config.pluginPickerPlugins,
  );
  const skills = seedPluginPickerSkills(userDataDir, config.pluginPickerSkills);
  const mcpServers = seedPluginPickerMcpServers(
    userDataDir,
    config.pluginPickerMcpServers,
  );
  return {
    catalogItems: plugins.length + skills.length + mcpServers.length,
    files:
      config.fileExplorerDirectories * config.fileExplorerFilesPerDirectory,
  };
}

const paletteShortcut = (key) =>
  `${process.platform === 'darwin' ? 'Meta' : 'Control'}+${key}`;

async function runMenuSurfaces({ page, app, config, tasks, fixture }) {
  await openMainPage(page);
  await app.selectWorktree(WORKTREE_BRANCH, NO_ACTIVITY_RAIL);
  await expect(visibleChatPanel(page)).toBeVisible({ timeout: 30_000 });
  const composer = visibleChatPanel(page)
    .locator('[data-chat-composer-root]')
    .getByRole('textbox')
    .first();
  const iterations = config.menuSurfacesIterations;
  const task = (kind, operation, metadata = {}) =>
    recordResponsiveTask(
      tasks,
      kind,
      operation,
      metadata,
      config.responsivenessBudgetMs,
    );

  /** One task per character, each ending when `echoed` holds and it paints. */
  async function typeKeystrokes(kind, text, echoed) {
    await setRendererTypingProbe(page, true);
    try {
      for (let index = 0; index < text.length; index += 1) {
        await task(kind, async () => {
          await page.keyboard.type(text[index]);
          await echoed(text.slice(0, index + 1));
          await nextPaint(page);
        });
      }
    } finally {
      await setRendererTypingProbe(page, false);
    }
  }

  async function pressArrows(kind, count) {
    for (let index = 0; index < count; index += 1) {
      await task(kind, async () => {
        await page.keyboard.press('ArrowDown');
        await nextPaint(page);
      });
    }
  }

  async function closeWithEscape(locator) {
    await expect(async () => {
      await page.keyboard.press('Escape');
      await expect(locator).toBeHidden({ timeout: 500 });
    }).toPass({ timeout: 10_000 });
    await nextPaint(page);
  }

  async function clearComposerMenuDraft(marker) {
    await clearComposerDraft(composer, marker);
  }

  // Model picker: open, harness tab switch, search keystroke.
  const modelTrigger = page
    .locator('[data-testid="chat-model-picker"]:visible')
    .first();
  const modelMenu = page.getByTestId('chat-model-menu');
  const modelTabs = modelMenu.locator(
    '[data-testid^="chat-model-harness-tab-"]',
  );
  const modelSearch = modelMenu.getByTestId('chat-model-search');
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    await task('menu_model_picker_open', async () => {
      await modelTrigger.click();
      await expect(modelMenu).toBeVisible({ timeout: 30_000 });
      await nextPaint(page);
    });
    await task('menu_model_picker_tab_switch', async () => {
      await modelTabs.nth((iteration + 1) % 2).click();
      await expect(modelTabs.nth((iteration + 1) % 2)).toHaveAttribute(
        'aria-checked',
        'true',
      );
      await nextPaint(page);
    });
    await modelSearch.click();
    await typeKeystrokes('menu_model_picker_keystroke', 'gpt', (text) =>
      expect(modelSearch).toHaveValue(text),
    );
    await closeWithEscape(modelMenu);
  }

  // Command palette: open, keystroke over the seeded catalog, arrow keys.
  const palette = page.getByTestId('command-palette');
  const paletteInput = page.getByTestId('command-palette-input');
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    await task('menu_command_palette_open', async () => {
      await page.keyboard.press(paletteShortcut('K'));
      await expect(palette).toBeVisible({ timeout: 30_000 });
      await nextPaint(page);
    });
    await typeKeystrokes(
      'menu_command_palette_keystroke',
      'perf-plugin',
      (text) => expect(paletteInput).toHaveValue(text),
    );
    await pressArrows('menu_command_palette_arrow', 5);
    await closeWithEscape(palette);
  }

  // File palette: open, keystroke, ranked results, arrow keys.
  const filePalette = page.getByTestId('file-search-palette-input');
  const fileResults = page.getByTestId('file-search-palette-result');
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    await task('menu_file_palette_open', async () => {
      await page.keyboard.press(paletteShortcut('P'));
      await expect(filePalette).toBeVisible({ timeout: 30_000 });
      await expect(fileResults.first())
        .toBeVisible({ timeout: 30_000 })
        .catch(async (cause) => {
          const shown = await page
            .getByTestId('file-search-palette')
            .innerText()
            .catch(() => 'the palette closed');
          throw new Error(`The file palette listed no files: ${shown}`, {
            cause,
          });
        });
      await nextPaint(page);
    });
    // The last character changes the first result from file-0000.ts to
    // file-0007.ts, so the result task waits for deferred ranking to commit.
    const query = 'file-0007';
    await typeKeystrokes(
      'menu_file_palette_keystroke',
      query.slice(0, -1),
      (text) => expect(filePalette).toHaveValue(text),
    );
    await expect(fileResults.first()).toHaveAttribute(
      'data-path',
      /file-0000\.ts$/,
      { timeout: 30_000 },
    );
    await task('menu_file_palette_results', async () => {
      await page.keyboard.type(query.at(-1));
      await expect(fileResults.first()).toHaveAttribute(
        'data-path',
        /file-0007\.ts$/,
        { timeout: 30_000 },
      );
      await nextPaint(page);
    });
    await pressArrows('menu_file_palette_arrow', 5);
    await closeWithEscape(filePalette);
  }

  // `/` and `@`: both open the composer's menu in a chat; only the web
  // composer has a separate slash menu. Open, then keystroke with it open.
  for (const { name, trigger, text } of [
    { name: 'slash', trigger: '/', text: 'perf-s' },
    { name: 'mention', trigger: '@', text: 'file-00' },
  ]) {
    const menu = page.getByTestId('chat-input-plus-menu');
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      await composer.click();
      await task(`menu_${name}_open`, async () => {
        await page.keyboard.type(trigger);
        await expect(menu).toBeVisible({ timeout: 30_000 });
        await nextPaint(page);
      });
      await typeKeystrokes(`menu_${name}_keystroke`, text, async (typed) => {
        await expect(composer).toContainText(`${trigger}${typed}`);
        await expect(menu).toBeVisible();
      });
      await closeWithEscape(menu);
      await clearComposerMenuDraft(trigger);
    }
  }

  // Plus menu: open over the plugin catalog, which renders unwindowed.
  const plusItem = page.getByTestId('chat-plugins-button');
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    await task(
      'menu_plus_open',
      async () => {
        await page.getByTestId('chat-input-plus-button').click();
        await expect(plusItem).toBeVisible({ timeout: 30_000 });
        await nextPaint(page);
      },
      { catalogItems: fixture.catalogItems },
    );
    await closeWithEscape(plusItem);
  }

  // Home branch picker: open, tab switch, search keystroke.
  await app.openHomeForProject(WORKSPACE_ID);
  const branchMenu = page.getByTestId('home-branch-picker-menu');
  const branchSearch = page.getByTestId('home-branch-picker-search');
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    await task('menu_home_branch_open', async () => {
      await page.getByTestId('home-branch-picker-button').click();
      await expect(branchMenu).toBeVisible({ timeout: 30_000 });
      await nextPaint(page);
    });
    await task('menu_home_branch_tab_switch', async () => {
      await page.getByTestId('home-branch-picker-tab-branches').click();
      await expect(branchSearch).toHaveAttribute(
        'placeholder',
        'Search branches…',
      );
      await nextPaint(page);
    });
    await branchSearch.click();
    await typeKeystrokes('menu_home_branch_keystroke', 'main', (text) =>
      expect(branchSearch).toHaveValue(text),
    );
    await closeWithEscape(branchMenu);
  }

  return {
    iterations,
    catalogItems: fixture.catalogItems,
    files: fixture.files,
  };
}

function prepareStartupSettle(userDataDir, config) {
  const fixture = prepareLoadedUi(userDataDir, config);
  const catalogDirectory = path.join(userDataDir, '.cache', 'model-catalog');
  mkdirSync(catalogDirectory, { recursive: true });
  writeFileSync(
    path.join(catalogDirectory, 'ai-gateway-v1.json'),
    `${JSON.stringify({
      cacheVersion: AI_GATEWAY_MODEL_CATALOG_CACHE_VERSION,
      serverOrigin: 'http://127.0.0.1:9',
      brandApiNamespace: 'canopy',
      fetchedAt: new Date().toISOString(),
      catalog: {
        version: AI_GATEWAY_MODEL_CATALOG_VERSION,
        models: [
          {
            id: 'performance-catalog-model',
            gatewayId: 'qa/performance-catalog-model',
            label: 'Performance catalog model',
            family: 'openai',
            recommendedHarness: 'codex',
            contextWindow: 100_000,
            supportsPromptCaching: false,
            requiresLocalHarnessSupport: false,
            showMoreOnly: false,
            supportedThinkingLevels: [],
            toolSchemaProfile: 'standard',
          },
        ],
      },
    })}\n`,
    'utf8',
  );
  return {
    ...fixture,
    catalogCacheCondition: 'warm',
    catalogNetworkCondition: 'unavailable',
    ...seedStartupTopology(
      userDataDir,
      config.startupWorktrees,
      config.startupWorkspaces,
      fixture.seed,
    ),
  };
}

function apportion(total, weights) {
  if (total < weights.length) {
    throw new Error('Apportionment requires at least one item per bucket');
  }
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
  const exact = weights.map((weight) => (total * weight) / weightTotal);
  const counts = exact.map((value) => Math.max(1, Math.floor(value)));
  while (counts.reduce((sum, count) => sum + count, 0) > total) {
    const candidate = counts
      .map((count, index) => ({ count, index, fraction: exact[index] % 1 }))
      .filter((entry) => entry.count > 1)
      .sort((a, b) => a.fraction - b.fraction || b.index - a.index)[0];
    if (!candidate) throw new Error('Unable to reduce apportioned counts');
    counts[candidate.index] -= 1;
  }
  while (counts.reduce((sum, count) => sum + count, 0) < total) {
    const candidate = exact
      .map((value, index) => ({ index, fraction: value - counts[index] }))
      .sort((a, b) => b.fraction - a.fraction || a.index - b.index)[0];
    counts[candidate.index] += 1;
  }
  return counts;
}

export function powerUserIdleShape(config) {
  const chatContainerCount = Math.min(175, config.powerUserChatTabs);
  const regularChatContainerCount = Math.max(0, chatContainerCount - 1);
  const advisorChatTabCount = Math.min(
    POWER_USER_ADVISOR_CHAT_TAB_CAP,
    Math.max(1, config.powerUserChatTabs - regularChatContainerCount),
  );
  const regularChatTabCount = config.powerUserChatTabs - advisorChatTabCount;
  const advisorMessageCount = Math.min(
    advisorChatTabCount * POWER_USER_ADVISOR_MESSAGES_PER_TAB,
    config.powerUserMessages - regularChatTabCount,
  );
  const visibleCoworkEntryCount = Math.min(
    config.powerUserCoworkEntries,
    regularChatContainerCount - config.powerUserWorktrees,
  );
  return {
    workspaceCount: config.powerUserWorkspaces,
    worktreeCount: config.powerUserWorktrees,
    repositoryCount: config.powerUserRepositories,
    sourceBackedWorkspaceCount:
      config.powerUserWorkspaces - config.powerUserCoworkWorkspaces,
    coworkWorkspaceCount: config.powerUserCoworkWorkspaces,
    visibleCoworkEntryCount,
    chatContainerCount,
    regularChatContainerCount,
    advisorChatTabCount,
    advisorMessagesPerTab: apportion(
      advisorMessageCount,
      Array(advisorChatTabCount).fill(1),
    ),
    retainedChatContainerCount:
      chatContainerCount - config.powerUserWorktrees - visibleCoworkEntryCount,
    chatTabsPerContainer: apportion(
      regularChatTabCount,
      Array(regularChatContainerCount).fill(1),
    ),
    messagesPerTab: apportion(
      config.powerUserMessages - advisorMessageCount,
      Array(regularChatTabCount).fill(1),
    ),
    pipelineExecutionCount: config.powerUserPipelineExecutions,
    panelLayoutCount: config.powerUserPanelLayouts,
    firedWatcherCount: config.powerUserFiredWatchers,
    automationCount: config.powerUserAutomations,
    automationRunCount: config.powerUserAutomationRuns,
    graphSourceFileCount:
      config.powerUserRepositories * config.powerUserGraphFilesPerRepo,
  };
}

export function realisticStartupWorktreeDistribution(
  worktreeCount,
  repositoryCount,
) {
  if (
    !Number.isInteger(worktreeCount) ||
    !Number.isInteger(repositoryCount) ||
    repositoryCount < 1 ||
    repositoryCount > REALISTIC_STARTUP_DEMO_APPS.length ||
    worktreeCount < repositoryCount
  ) {
    throw new Error('Realistic startup topology coordinates are invalid');
  }
  const weights = [66, 11, 7, 5, 4, 3, 2, 2, 1, 1].slice(0, repositoryCount);
  return apportion(worktreeCount, weights);
}

function commitGraphFixture(repoPath, fileCount, repositoryIndex) {
  generateCodeGraphFixture(repoPath, fileCount);
  execFileSync('git', ['-C', repoPath, 'add', 'graph-fixture'], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  execFileSync(
    'git',
    [
      '-C',
      repoPath,
      '-c',
      'user.name=Canopy Performance',
      '-c',
      'user.email=performance@canopy.test',
      'commit',
      '-m',
      `Seed realistic startup graph ${repositoryIndex + 1}`,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  const remotePath = path.join(
    path.dirname(repoPath),
    '.performance-remotes',
    `repo-${repositoryIndex + 1}.git`,
  );
  mkdirSync(path.dirname(remotePath), { recursive: true });
  execFileSync('git', ['init', '--bare', '--initial-branch=main', remotePath], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  execFileSync('git', ['-C', repoPath, 'remote', 'add', 'origin', remotePath], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  execFileSync(
    'git',
    ['-C', repoPath, 'push', '--set-upstream', 'origin', 'HEAD:main'],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  execFileSync(
    'git',
    ['-C', repoPath, 'remote', 'set-head', 'origin', 'main'],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
}

function prepareRealisticStartup(userDataDir, config, options = {}) {
  const repositoryCount = config.realisticStartupRepositories;
  const selectedApps = REALISTIC_STARTUP_DEMO_APPS.slice(0, repositoryCount);
  const seed = seedDemoWorkspaces({
    userDataDir,
    apps: selectedApps,
    checkRuntimes: false,
  });
  if (options.includeLoadedUiState !== false) {
    seedLoadedUiState(userDataDir, config);
  }
  const distribution = realisticStartupWorktreeDistribution(
    config.realisticStartupWorktrees,
    repositoryCount,
  );
  const workspacesRoot = path.join(userDataDir, 'workspaces');
  const workspaceIndexPath = path.join(workspacesRoot, 'index.json');
  const workspaceIndex = JSON.parse(readFileSync(workspaceIndexPath, 'utf8'));
  const fixtureCoworkWorkspaceCount = workspaceIndex.workspaces.some(
    (workspace) => workspace.type === 'cowork',
  )
    ? 0
    : 1;
  const desiredFixtureWorkspaceCount =
    config.realisticStartupWorkspaces - fixtureCoworkWorkspaceCount;
  let eagerHydrationWorktrees = 0;

  for (const [repositoryIndex, workspaceSeed] of seed.workspaces.entries()) {
    const workspaceId = workspaceSeed.id;
    const workspaceDir = path.join(workspacesRoot, workspaceId);
    const persistedPath = path.join(workspaceDir, 'worktrees.json');
    const persisted = JSON.parse(readFileSync(persistedPath, 'utf8'));
    const repoPath = workspaceSeed.repoPath;
    if (!repoPath) {
      throw new Error(`Realistic startup repository ${workspaceId} is missing`);
    }
    commitGraphFixture(
      repoPath,
      config.realisticStartupGraphFilesPerRepo,
      repositoryIndex,
    );
    const desiredCount = distribution[repositoryIndex];
    for (
      let index = persisted.worktrees.length;
      index < desiredCount;
      index += 1
    ) {
      const ordinal = String(index).padStart(3, '0');
      const id = `perf-realistic-${repositoryIndex + 1}-${ordinal}`;
      const worktreePath = path.join(workspaceDir, 'worktrees', id);
      execFileSync(
        'git',
        ['-C', repoPath, 'worktree', 'add', '-b', id, worktreePath, 'HEAD'],
        { stdio: ['ignore', 'ignore', 'pipe'] },
      );
      persisted.worktrees.push({
        id,
        branchName: id,
        createdAt: new Date(
          Date.parse('2026-07-01T12:00:00.000Z') +
            repositoryIndex * 100_000 +
            index * 1_000,
        ).toISOString(),
        trackedBaseBranch: 'main',
      });
    }
    persisted.worktrees = persisted.worktrees.map((worktree, index) => {
      const badges = startupChatBadges(index + repositoryIndex);
      if (badges.needsHydration) eagerHydrationWorktrees += 1;
      return { ...worktree, chatBadges: badges.value };
    });
    writeFileSync(
      persistedPath,
      `${JSON.stringify(persisted, null, 2)}\n`,
      'utf8',
    );
  }

  for (
    let index = workspaceIndex.workspaces.length;
    index < desiredFixtureWorkspaceCount;
    index += 1
  ) {
    const ordinal = String(index + 1).padStart(3, '0');
    const id = `perf-realistic-empty-${ordinal}`;
    const source = seed.workspaces[index % seed.workspaces.length];
    const sourceWorkspaceDir = path.join(workspacesRoot, source.id);
    const workspaceDir = path.join(workspacesRoot, id);
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(
      path.join(workspaceDir, 'workspace.json'),
      readFileSync(path.join(sourceWorkspaceDir, 'workspace.json')),
    );
    writeFileSync(
      path.join(workspaceDir, 'worktrees.json'),
      `${JSON.stringify({ version: 1, worktrees: [] }, null, 2)}\n`,
      'utf8',
    );
    workspaceIndex.workspaces.push({
      id,
      name: `Realistic Empty Workspace ${ordinal}`,
      type: 'single-repo',
      color: '#3B82F6',
      collapsed: false,
      order: workspaceIndex.workspaces.length,
    });
  }
  writeFileSync(
    workspaceIndexPath,
    `${JSON.stringify(workspaceIndex, null, 2)}\n`,
    'utf8',
  );

  return {
    seed,
    startupWorktrees: distribution.reduce((sum, count) => sum + count, 0),
    startupWorkspaces: config.realisticStartupWorkspaces,
    startupRepositories: repositoryCount,
    worktreesPerRepository: distribution,
    graphFilesPerRepository: config.realisticStartupGraphFilesPerRepo,
    eagerHydrationWorktrees,
  };
}

function buildPowerUserMessages(containerIndex, tabIndex, count) {
  const startedAt = Date.parse('2026-07-01T12:00:00.000Z');
  return Array.from({ length: count }, (_, messageIndex) => ({
    id: `power-${containerIndex}-${tabIndex}-${messageIndex}`,
    role: messageIndex % 2 === 0 ? 'user' : 'assistant',
    blocks: [
      {
        type: 'text',
        text: `Power-user transcript ${containerIndex}.${tabIndex}.${messageIndex}: persisted workspace context and completed background work.`,
      },
    ],
    timestamp: startedAt + messageIndex * 1_000,
  }));
}

function powerUserPanelLayout(chatTabs, ordinal) {
  const chatPanels = chatTabs.slice(0, 6).map((tab) => ({
    panelId: `panel-chat-${tab.id}`,
    kind: 'chat',
    title: tab.title,
    instance: { chatTabId: tab.id },
  }));
  const chatActivePanelId = chatPanels[0]?.panelId ?? `panel-chat-${ordinal}`;
  if (chatPanels.length === 0) {
    chatPanels.push({ panelId: chatActivePanelId, kind: 'chat' });
  }
  const groups = [
    {
      type: 'leaf',
      groupId: `power-files-${ordinal}`,
      panels: [{ panelId: `power-explorer-${ordinal}`, kind: 'file-explorer' }],
      activePanelId: `power-explorer-${ordinal}`,
      size: 220,
    },
    {
      type: 'branch',
      children: [
        {
          type: 'leaf',
          groupId: `power-chat-${ordinal}`,
          panels: chatPanels,
          activePanelId: chatActivePanelId,
          size: 580,
        },
        {
          type: 'leaf',
          groupId: `power-terminal-${ordinal}`,
          panels: [
            { panelId: `power-terminal-panel-${ordinal}`, kind: 'terminal' },
            {
              panelId: `power-diff-${ordinal}`,
              kind: 'file-diff',
              title: `src/power-${ordinal}.ts`,
              instance: {
                fileTabId: `power-file-${ordinal}`,
                filePath: `src/power-${ordinal}.ts`,
              },
            },
          ],
          activePanelId: `power-terminal-panel-${ordinal}`,
          size: 240,
        },
      ],
      size: 820,
    },
    {
      type: 'leaf',
      groupId: `power-activity-${ordinal}`,
      panels: [
        {
          panelId: `power-activity-panel-${ordinal}`,
          kind: 'activity-section',
        },
        {
          panelId: `power-usage-${ordinal}`,
          kind: 'usage',
          instance: { variant: 'all' },
        },
      ],
      activePanelId: `power-activity-panel-${ordinal}`,
      size: 360,
    },
  ];
  return {
    version: 1,
    grid: {
      root: { type: 'branch', children: groups, size: 900 },
      orientation: 1,
      width: 1_400,
      height: 900,
    },
    activeGroupId: `power-chat-${ordinal}`,
    mostRecentActiveGroupIds: [
      `power-chat-${ordinal}`,
      `power-activity-${ordinal}`,
      `power-terminal-${ordinal}`,
      `power-files-${ordinal}`,
    ],
  };
}

function addPowerUserCoworkWorkspaces(userDataDir, count) {
  const workspacesRoot = path.join(userDataDir, 'workspaces');
  const indexPath = path.join(workspacesRoot, 'index.json');
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  const coworkIds = Array.from({ length: count }, (_, ordinal) =>
    ordinal === 0 ? 'cowork-default' : `power-cowork-${ordinal + 1}`,
  );
  for (const [ordinal, workspaceId] of coworkIds.entries()) {
    const createdAt = new Date(
      Date.parse('2026-07-01T12:00:00.000Z') + ordinal * 60_000,
    ).toISOString();
    index.workspaces.push({
      id: workspaceId,
      name: ordinal === 0 ? 'Default' : `Power Cowork ${ordinal + 1}`,
      type: 'cowork',
      color: '#7C3AED',
      collapsed: false,
      order: index.workspaces.length,
      cowork: { createdAt, archiveRetentionDays: 7 },
    });
    const workspaceDir = path.join(workspacesRoot, workspaceId);
    mkdirSync(path.join(workspaceDir, 'home'), { recursive: true });
    writeFileSync(
      path.join(workspaceDir, 'workspace.json'),
      `${JSON.stringify(
        {
          version: 1,
          type: 'cowork',
          cowork: { createdAt, archiveRetentionDays: 7 },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
  }
  writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
  return coworkIds;
}

function sourceWorktreeContainers(userDataDir) {
  const workspacesRoot = path.join(userDataDir, 'workspaces');
  const index = JSON.parse(
    readFileSync(path.join(workspacesRoot, 'index.json'), 'utf8'),
  );
  return index.workspaces.flatMap((workspace) => {
    if (workspace.type === 'cowork') return [];
    const worktreesPath = path.join(
      workspacesRoot,
      workspace.id,
      'worktrees.json',
    );
    if (!existsSync(worktreesPath)) return [];
    const persisted = JSON.parse(readFileSync(worktreesPath, 'utf8'));
    return persisted.worktrees.map((worktree) => ({
      workspaceId: workspace.id,
      worktreeId: worktree.id,
      branchName: worktree.branchName,
      cowork: false,
    }));
  });
}

function seedPowerUserState(userDataDir, config, coworkIds) {
  const shape = powerUserIdleShape(config);
  const containers = sourceWorktreeContainers(userDataDir);
  const coworkEntryCounts =
    shape.visibleCoworkEntryCount === 0
      ? Array(coworkIds.length).fill(0)
      : apportion(
          shape.visibleCoworkEntryCount,
          Array(coworkIds.length).fill(1),
        );
  for (const [coworkIndex, workspaceId] of coworkIds.entries()) {
    const entries = Array.from(
      { length: coworkEntryCounts[coworkIndex] },
      (_, entryIndex) => ({
        id: `power-entry-${coworkIndex + 1}-${entryIndex + 1}`,
        createdAt: new Date(
          Date.parse('2026-07-01T12:00:00.000Z') +
            (containers.length + entryIndex) * 1_000,
        ).toISOString(),
      }),
    );
    writeFileSync(
      path.join(userDataDir, 'workspaces', workspaceId, 'work-entries.json'),
      `${JSON.stringify({ version: 1, entries }, null, 2)}\n`,
      'utf8',
    );
    containers.push(
      ...entries.map((entry) => ({
        workspaceId,
        worktreeId: entry.id,
        branchName: entry.id,
        cowork: true,
      })),
    );
  }

  // The measured installation has many persisted chat files whose owning
  // work entries are archived/removed or app-managed. Preserve those files,
  // tabs, and transcript pressure without inventing visible Cowork rows for
  // every retained container: doing so made the synthetic sidebar more than
  // twice as large as the real one and turned a storage fixture into a DOM
  // stress test.
  const retainedContainerCount =
    shape.regularChatContainerCount - containers.length;
  for (let index = 0; index < retainedContainerCount; index += 1) {
    containers.push({
      workspaceId: coworkIds[index % coworkIds.length],
      worktreeId: `power-retained-entry-${index + 1}`,
      branchName: `power-retained-entry-${index + 1}`,
      cowork: true,
      retained: true,
    });
  }

  let globalTabIndex = 0;
  const seededContainers = containers
    .slice(0, shape.regularChatContainerCount)
    .map((container, containerIndex) => {
      const tabs = Array.from(
        { length: shape.chatTabsPerContainer[containerIndex] },
        (_, localTabIndex) => {
          const tabIndex = globalTabIndex++;
          return {
            id: `power-chat-${tabIndex + 1}`,
            title: `Power Chat ${tabIndex + 1}`,
            providerType: tabIndex % 4 === 0 ? 'codex' : 'claude',
            messages: buildPowerUserMessages(
              containerIndex,
              localTabIndex,
              shape.messagesPerTab[tabIndex],
            ),
          };
        },
      );
      seedWorktreeChat({
        userDataDir,
        workspaceId: container.workspaceId,
        worktreeId: container.worktreeId,
        providerType: 'claude',
        tabs,
        activeTabId: tabs[0].id,
      });
      return { ...container, tabs };
    });

  for (const [ordinal, container] of seededContainers
    .slice(0, shape.panelLayoutCount)
    .entries()) {
    const layoutPath = path.join(
      userDataDir,
      'workspaces',
      container.workspaceId,
      'worktree-data',
      container.worktreeId,
      'panel-layout.json',
    );
    mkdirSync(path.dirname(layoutPath), { recursive: true });
    writeFileSync(
      layoutPath,
      `${JSON.stringify(powerUserPanelLayout(container.tabs, ordinal + 1), null, 2)}\n`,
      'utf8',
    );
  }

  const firstContainer = seededContainers[0];
  seedWatchers({
    userDataDir,
    watchers: Array.from({ length: shape.firedWatcherCount }, (_, index) => ({
      id: `power-fired-watcher-${index + 1}`,
      trigger: 'worktree_pipeline_completion',
      status: 'fired',
      target: {
        kind: 'worktree_pipeline',
        projectId: firstContainer.workspaceId,
        worktreeId: firstContainer.worktreeId,
        executionId: `history-execution-${String((index % config.powerUserPipelineExecutions) + 1).padStart(5, '0')}`,
        workspaceName: 'Power User Workspace',
        worktreeBranchName: firstContainer.branchName,
        pipelineName: 'Power User Pipeline',
        pipelineDescription: 'Synthetic completed pipeline watcher.',
        executionStatus: 'success',
        executionStartedAt: '2026-07-01T12:00:00.000Z',
      },
      destination: {
        projectId: 'app-advisor',
        worktreeId: 'global',
        chatId: `advisor-chat-${(index % shape.advisorChatTabCount) + 1}`,
      },
    })),
  });
  const automationTimestamp = '2026-07-01T12:00:00.000Z';
  const activities = Array.from(
    { length: shape.automationCount },
    (_, index) => ({
      version: 1,
      id: `power-automation-${index + 1}`,
      name: `Power Automation ${index + 1}`,
      enabled: index % 3 !== 0,
      schedule: {
        kind: 'one_time',
        runAt: '2099-01-01T09:00:00.000Z',
        timezone: 'local',
      },
      action: {
        type: 'app_advisor_prompt',
        prompt: `Synthetic power-user automation ${index + 1}`,
      },
      createdAt: automationTimestamp,
      updatedAt: automationTimestamp,
      failureCount: 0,
    }),
  );
  const recentRuns = Array.from(
    { length: shape.automationRunCount },
    (_, index) => {
      const activity = activities[index % activities.length];
      return {
        id: `power-automation-run-${index + 1}`,
        activityId: activity.id,
        activityName: activity.name,
        scheduledFor: automationTimestamp,
        manual: index % 5 === 0,
        status: 'success',
        startedAt: automationTimestamp,
        completedAt: automationTimestamp,
      };
    },
  );
  seedAutomations({ userDataDir, activities, recentRuns });
  const advisorTabs = Array.from(
    { length: shape.advisorChatTabCount },
    (_, index) => ({
      id: `advisor-chat-${index + 1}`,
      title: `Advisor Chat ${index + 1}`,
      createdAt: '2026-07-01T12:00:00.000Z',
      providerType: 'claude',
      messages: buildPowerUserMessages(
        999,
        index,
        shape.advisorMessagesPerTab[index],
      ),
    }),
  );
  const advisorChatPath = path.join(
    userDataDir,
    'app-workspaces',
    'app-advisor',
    'chats',
    'global.json',
  );
  mkdirSync(path.dirname(advisorChatPath), { recursive: true });
  writeFileSync(
    advisorChatPath,
    `${JSON.stringify(
      {
        version: 1,
        tabs: advisorTabs,
        activeTabId: advisorTabs[0].id,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  const realizedChatContainerCount = seededContainers.length + 1;
  const realizedChatTabCount = globalTabIndex + advisorTabs.length;
  const realizedMessageCount =
    seededContainers.reduce(
      (containerTotal, container) =>
        containerTotal +
        container.tabs.reduce(
          (tabTotal, tab) => tabTotal + tab.messages.length,
          0,
        ),
      0,
    ) + advisorTabs.reduce((total, tab) => total + tab.messages.length, 0);
  if (
    realizedChatContainerCount !== shape.chatContainerCount ||
    realizedChatTabCount !== config.powerUserChatTabs ||
    realizedMessageCount !== config.powerUserMessages
  ) {
    throw new Error(
      `Power-user fixture realized ${realizedChatContainerCount} chat containers, ${realizedChatTabCount} tabs, and ${realizedMessageCount} messages; expected ${shape.chatContainerCount}, ${config.powerUserChatTabs}, and ${config.powerUserMessages}`,
    );
  }
  seedPluginPickerPlugins(userDataDir, 600);
  seedPluginPickerSkills(userDataDir, 82);
  seedPluginPickerMcpServers(userDataDir, 7);
  const pipeline = seedPipelineHistoryState(userDataDir, {
    pipelineHistoryExecutions: config.powerUserPipelineExecutions,
    pipelineHistoryTotalBytes: config.powerUserPipelineTotalBytes,
  });
  const actualPipelineStateFiles = readdirSync(
    path.join(userDataDir, 'pipeline-executions'),
  ).filter((file) => file.endsWith('.json')).length;
  if (actualPipelineStateFiles !== config.powerUserPipelineExecutions) {
    throw new Error(
      `Power-user fixture wrote ${actualPipelineStateFiles} pipeline executions; expected ${config.powerUserPipelineExecutions}`,
    );
  }
  return {
    shape,
    pipeline: { ...pipeline, stateFiles: actualPipelineStateFiles },
    activeChatTabs: seededContainers[0].tabs.length,
    firstCoworkEntryId: seededContainers.find((entry) => entry.cowork)
      ?.worktreeId,
  };
}

export function preparePowerUserIdle(userDataDir, config) {
  const sourceBackedWorkspaceCount =
    config.powerUserWorkspaces - config.powerUserCoworkWorkspaces;
  const startup = prepareRealisticStartup(
    userDataDir,
    {
      ...config,
      realisticStartupWorktrees: config.powerUserWorktrees,
      realisticStartupWorkspaces: sourceBackedWorkspaceCount + 1,
      realisticStartupRepositories: config.powerUserRepositories,
      realisticStartupGraphFilesPerRepo: config.powerUserGraphFilesPerRepo,
    },
    {
      includeLoadedUiState: false,
    },
  );
  const coworkIds = addPowerUserCoworkWorkspaces(
    userDataDir,
    config.powerUserCoworkWorkspaces,
  );
  const powerUser = seedPowerUserState(userDataDir, config, coworkIds);
  seedPerformancePipeline(userDataDir, config);
  return {
    ...startup,
    ...powerUser,
    startupWorkspaces: config.powerUserWorkspaces,
    graphFilesPerRepository: config.powerUserGraphFilesPerRepo,
  };
}

async function preparePowerUserActive(userDataDir, config) {
  const fixture = preparePowerUserIdle(userDataDir, config);
  // This fixture restores 100,000 messages plus cold Code Graph maintenance
  // before admitting eight live turns. Keep early streams alive long enough
  // for all eight sessions to overlap; the regular chat/concurrency workloads
  // retain their profile durations and cover the shorter lifecycle.
  await registerPerformanceChatScenarios({
    ...config,
    chatStreamMs: Math.max(config.chatStreamMs, 120_000),
  });
  return fixture;
}

async function typeAtCadenceDuringStartupSettle({
  page,
  intervalMs,
  durationMs,
  launchStartedAt,
}) {
  const composer = page
    .getByTestId('page-home')
    .getByTestId('home-composer-editor');
  await expect(composer).toBeVisible({ timeout: 30_000 });
  const composerReadyFromLaunchMs = performance.now() - launchStartedAt;
  await composer.fill('');
  await composer.click();

  const startedAt = performance.now();
  let firstKeyFromLaunchMs = null;
  const deadline = startedAt + durationMs;
  const samples = [];
  let draft = '';
  let nextKeyAt = startedAt;
  await setRendererTypingProbe(page, true);
  try {
    while (performance.now() < deadline) {
      const waitMs = Math.max(0, nextKeyAt - performance.now());
      if (waitMs > 0) {
        await delay(waitMs);
      }
      const character = String.fromCharCode(97 + (samples.length % 26));
      const keyStartedAt = performance.now();
      firstKeyFromLaunchMs ??= keyStartedAt - launchStartedAt;
      await page.keyboard.type(character);
      await nextPaint(page);
      const latencyMs = performance.now() - keyStartedAt;
      draft += character;
      samples.push({ atMs: keyStartedAt - startedAt, latencyMs });
      nextKeyAt += intervalMs;
    }
  } finally {
    await setRendererTypingProbe(page, false);
  }

  await expect
    .poll(() => composer.textContent(), { timeout: 30_000 })
    .toContain(draft);
  await composer.fill('');
  const latencies = samples.map((sample) => sample.latencyMs);
  return {
    characters: samples.length,
    samples,
    latencyP95Ms: percentile(latencies, 0.95),
    latencyMaxMs: Math.max(...latencies),
    composerReadyFromLaunchMs,
    firstKeyFromLaunchMs,
  };
}

async function runStartupSettle({
  page,
  config,
  tasks,
  fixture,
  launchStartedAt,
}) {
  const result = await recordResponsiveTask(
    tasks,
    'type_during_startup_settle',
    () =>
      typeAtCadenceDuringStartupSettle({
        page,
        intervalMs: config.startupTypingIntervalMs,
        durationMs: config.startupSettleMs,
        launchStartedAt,
      }),
    {
      intervalMs: config.startupTypingIntervalMs,
      requestedDurationMs: config.startupSettleMs,
    },
    config.startupSettleMs + config.responsivenessBudgetMs,
  );
  Object.assign(tasks.at(-1), {
    characters: result.characters,
    cadenceSamples: result.samples,
    cadenceLatencyP95Ms: result.latencyP95Ms,
    cadenceLatencyMaxMs: result.latencyMaxMs,
    composerReadyFromLaunchMs: result.composerReadyFromLaunchMs,
    firstKeyFromLaunchMs: result.firstKeyFromLaunchMs,
  });

  let liveBackgroundProbe = null;
  if (config.startupBackgroundMode === 'live') {
    await recordTask(
      tasks,
      'wait_for_startup_background_idle_gate',
      () => delay(config.startupBackgroundIdleDwellMs),
      { requestedDurationMs: config.startupBackgroundIdleDwellMs },
    );
    liveBackgroundProbe = await recordResponsiveTask(
      tasks,
      'type_during_live_startup_background',
      () =>
        typeAtCadenceDuringStartupSettle({
          page,
          intervalMs: config.startupTypingIntervalMs,
          durationMs: config.startupBackgroundProbeMs,
          launchStartedAt,
        }),
      {
        intervalMs: config.startupTypingIntervalMs,
        requestedDurationMs: config.startupBackgroundProbeMs,
      },
      config.startupBackgroundProbeMs + config.responsivenessBudgetMs,
    );
    Object.assign(tasks.at(-1), {
      characters: liveBackgroundProbe.characters,
      cadenceSamples: liveBackgroundProbe.samples,
      cadenceLatencyP95Ms: liveBackgroundProbe.latencyP95Ms,
      cadenceLatencyMaxMs: liveBackgroundProbe.latencyMaxMs,
    });
  }

  return {
    settleWindowMs: config.startupSettleMs,
    typingIntervalMs: config.startupTypingIntervalMs,
    typingCharacters: result.characters,
    typingLatencyP95Ms: result.latencyP95Ms,
    typingLatencyMaxMs: result.latencyMaxMs,
    composerReadyFromLaunchMs: result.composerReadyFromLaunchMs,
    firstKeyFromLaunchMs: result.firstKeyFromLaunchMs,
    liveBackgroundIdleDwellMs:
      config.startupBackgroundMode === 'live'
        ? config.startupBackgroundIdleDwellMs
        : 0,
    liveBackgroundTypingCharacters: liveBackgroundProbe?.characters ?? 0,
    liveBackgroundTypingLatencyP95Ms: liveBackgroundProbe?.latencyP95Ms ?? 0,
    liveBackgroundTypingLatencyMaxMs: liveBackgroundProbe?.latencyMaxMs ?? 0,
    startupWorktrees: fixture.startupWorktrees,
    startupWorkspaces: fixture.startupWorkspaces,
    eagerHydrationWorktrees: fixture.eagerHydrationWorktrees,
    catalogCacheCondition: fixture.catalogCacheCondition,
    catalogNetworkCondition: fixture.catalogNetworkCondition,
  };
}

async function readRealisticStartupEvents(electronApp) {
  return electronApp.evaluate(() => {
    const target = globalThis;
    const events = target.__CANOPY_PERFORMANCE_REALISTIC_STARTUP_EVENTS__;
    return Array.isArray(events) ? events : [];
  });
}

function countFilesNamed(root, name) {
  if (!existsSync(root)) return 0;
  let count = 0;
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else if (entry.name === name) count += 1;
    }
  };
  visit(root);
  return count;
}

async function runRealisticStartup({
  page,
  electronApp,
  config,
  tasks,
  fixture,
  launchStartedAt,
}) {
  const initialTypingMs = Math.min(
    4_000,
    Math.max(1_000, config.realisticStartupObserveMs / 4),
  );
  const idleDwellMs = Math.min(
    config.startupBackgroundIdleDwellMs,
    Math.max(0, config.realisticStartupObserveMs - initialTypingMs - 1_000),
  );
  const resumedTypingMs = Math.max(
    1_000,
    config.realisticStartupObserveMs - initialTypingMs - idleDwellMs,
  );
  const initialResult = await recordResponsiveTask(
    tasks,
    'type_during_realistic_startup_initial',
    () =>
      typeAtCadenceDuringStartupSettle({
        page,
        intervalMs: config.startupTypingIntervalMs,
        durationMs: initialTypingMs,
        launchStartedAt,
      }),
    {
      intervalMs: config.startupTypingIntervalMs,
      requestedDurationMs: initialTypingMs,
    },
    initialTypingMs + config.responsivenessBudgetMs,
  );
  Object.assign(tasks.at(-1), {
    characters: initialResult.characters,
    cadenceSamples: initialResult.samples,
    cadenceLatencyP95Ms: initialResult.latencyP95Ms,
    cadenceLatencyMaxMs: initialResult.latencyMaxMs,
    composerReadyFromLaunchMs: initialResult.composerReadyFromLaunchMs,
    firstKeyFromLaunchMs: initialResult.firstKeyFromLaunchMs,
  });

  await recordTask(
    tasks,
    'wait_for_realistic_startup_idle_gate',
    () => delay(idleDwellMs),
    { requestedDurationMs: idleDwellMs },
  );

  const resumedResult = await recordResponsiveTask(
    tasks,
    'type_during_realistic_startup_background',
    () =>
      typeAtCadenceDuringStartupSettle({
        page,
        intervalMs: config.startupTypingIntervalMs,
        durationMs: resumedTypingMs,
        launchStartedAt,
      }),
    {
      intervalMs: config.startupTypingIntervalMs,
      requestedDurationMs: resumedTypingMs,
    },
    resumedTypingMs + config.responsivenessBudgetMs,
  );
  Object.assign(tasks.at(-1), {
    characters: resumedResult.characters,
    cadenceSamples: resumedResult.samples,
    cadenceLatencyP95Ms: resumedResult.latencyP95Ms,
    cadenceLatencyMaxMs: resumedResult.latencyMaxMs,
  });

  const typingLatencies = [
    ...initialResult.samples,
    ...resumedResult.samples,
  ].map((sample) => sample.latencyMs);

  const startupEvents = await readRealisticStartupEvents(electronApp);
  const persistedWorkspaceCount = JSON.parse(
    readFileSync(
      path.join(fixture.seed.dataDir, 'workspaces', 'index.json'),
      'utf8',
    ),
  ).workspaces.length;
  if (persistedWorkspaceCount !== fixture.startupWorkspaces) {
    throw new Error(
      `Realistic startup loaded ${persistedWorkspaceCount} persisted workspaces; expected ${fixture.startupWorkspaces}`,
    );
  }
  const eventCounts = Object.fromEntries(
    Array.from(
      startupEvents.reduce((counts, entry) => {
        counts.set(entry.event, (counts.get(entry.event) ?? 0) + 1);
        return counts;
      }, new Map()),
    ),
  );
  const missingEvents = missingRealisticStartupProcedureEvents(eventCounts);
  if (missingEvents.length > 0) {
    const relevantTimeline = startupEvents
      .filter((entry) => entry.event.startsWith('startup:code-graph-base:'))
      .slice(-20);
    throw new Error(
      `Realistic startup did not activate required procedures: ${missingEvents.join(', ')}; code graph timeline=${JSON.stringify(relevantTimeline)}`,
    );
  }

  return {
    settleWindowMs: config.realisticStartupObserveMs,
    initialTypingWindowMs: initialTypingMs,
    startupIdleDwellMs: idleDwellMs,
    resumedTypingWindowMs: resumedTypingMs,
    typingIntervalMs: config.startupTypingIntervalMs,
    typingCharacters: initialResult.characters + resumedResult.characters,
    typingLatencyP95Ms: percentile(typingLatencies, 0.95),
    typingLatencyMaxMs: Math.max(...typingLatencies),
    composerReadyFromLaunchMs: initialResult.composerReadyFromLaunchMs,
    firstKeyFromLaunchMs: initialResult.firstKeyFromLaunchMs,
    startupWorktrees: fixture.startupWorktrees,
    startupWorkspaces: fixture.startupWorkspaces,
    persistedWorkspaceCount,
    startupRepositories: fixture.startupRepositories,
    worktreesPerRepository: fixture.worktreesPerRepository,
    graphFilesPerRepository: fixture.graphFilesPerRepository,
    eagerHydrationWorktrees: fixture.eagerHydrationWorktrees,
    startupEventCounts: eventCounts,
    startupEventTimeline: startupEvents,
    publishedShadowGraphCount: countFilesNamed(
      path.join(fixture.seed.dataDir, 'repo-shadows'),
      'current.json',
    ),
  };
}

async function runPowerUserIdle(args) {
  const { page, app, config, tasks, fixture } = args;
  const startup = await runRealisticStartup({
    ...args,
    config: {
      ...config,
      realisticStartupObserveMs: config.powerUserObserveMs,
    },
  });

  await recordResponsiveTask(
    tasks,
    'open_power_user_layout',
    async () => {
      await openMainPage(page);
      await app.selectWorktree(WORKTREE_BRANCH);
      await expect(visibleChatPanel(page)).toBeVisible({ timeout: 30_000 });
      await expect(
        page.getByTestId('panel-content-activity-section'),
      ).toBeVisible({ timeout: 30_000 });
      await nextPaint(page);
    },
    { persistedPanelLayouts: fixture.shape.panelLayoutCount },
    config.responsivenessBudgetMs,
  );

  const tabs = page.locator('[role="tab"][data-panel-kind="chat"]');
  await expect(tabs).toHaveCount(fixture.activeChatTabs, { timeout: 30_000 });
  const interactionCount = Math.min(6, config.navigationIterations);
  for (let index = 0; index < interactionCount; index += 1) {
    await recordResponsiveTask(
      tasks,
      'type_while_power_user_idle',
      () =>
        typeDraftAndWaitForPaint(page, {
          scenario: 'power-user-idle',
          iteration: index + 1,
          characters: config.typingCharacters,
        }),
      {
        iteration: index + 1,
        characters: config.typingCharacters,
        activeChatTabs: fixture.activeChatTabs,
      },
      config.responsivenessBudgetMs,
    );
    await recordResponsiveTask(
      tasks,
      'navigate_while_power_user_idle',
      async () => {
        await openPipelinesPage(page);
        await app.selectWorktree(WORKTREE_BRANCH);
        await expect(visibleChatPanel(page)).toBeVisible({ timeout: 30_000 });
        await nextPaint(page);
      },
      { iteration: index + 1 },
      config.responsivenessBudgetMs,
    );
  }

  return {
    ...startup,
    ...fixture.shape,
    pipelineStateFiles: fixture.pipeline.stateFiles,
    pipelineStateBytes: fixture.pipeline.stateBytes,
    activeLayoutChatTabs: fixture.activeChatTabs,
    idleTypingBursts: interactionCount,
    idleNavigationCycles: interactionCount,
    networkModel:
      'authenticated production traffic observed separately; benchmark endpoints are deterministic mocks',
  };
}

async function runPowerUserActive(args) {
  const { page, app, config, tasks, fixture } = args;
  const startup = await runRealisticStartup({
    ...args,
    config: {
      ...config,
      realisticStartupObserveMs: config.powerUserObserveMs,
    },
  });

  await recordResponsiveTask(
    tasks,
    'open_active_power_user_layout',
    async () => {
      await openMainPage(page);
      await app.selectWorktree(WORKTREE_BRANCH);
      await expect(visibleChatPanel(page)).toBeVisible({ timeout: 30_000 });
      await expect(
        page.getByTestId('panel-content-activity-section'),
      ).toBeVisible({ timeout: 30_000 });
      await nextPaint(page);
    },
    { persistedPanelLayouts: fixture.shape.panelLayoutCount },
    config.responsivenessBudgetMs,
  );

  const { peakConcurrentTurns, tabIds } = await startConcurrentChats({
    page,
    config,
    tasks,
  });
  const cards = pipelineRunCards(page, PERFORMANCE_PIPELINE_NAME);
  const peakConcurrentRuns = await dispatchConcurrentPipelines({
    page,
    config,
    tasks,
    cards,
  });
  const overlapTurns = await activeTurnCount(page);
  const overlapRuns = (await cards.allTextContents()).filter((text) =>
    text.toLowerCase().includes('running'),
  ).length;
  if (overlapTurns === 0 || overlapRuns === 0) {
    throw new Error(
      `Power-user foreground work did not overlap (chat turns=${overlapTurns}, pipeline runs=${overlapRuns})`,
    );
  }

  const probeTabId = await createResponsivenessChat(page, tasks);
  const interactionCount = Math.min(6, config.interactionIterations);
  let interactionsWithCombinedLoad = 0;
  for (let index = 0; index < interactionCount; index += 1) {
    const activeTurns = await activeTurnCount(page);
    const activeRuns = (await cards.allTextContents()).filter((text) =>
      text.toLowerCase().includes('running'),
    ).length;
    if (activeTurns > 0 && activeRuns > 0) {
      interactionsWithCombinedLoad += 1;
    }
    await recordResponsiveTask(
      tasks,
      'type_during_active_power_user_load',
      () =>
        typeDraftAndWaitForPaint(page, {
          scenario: 'power-user-active',
          iteration: index + 1,
          characters: config.typingCharacters,
        }),
      {
        iteration: index + 1,
        characters: config.typingCharacters,
        activeTurns,
        activeRuns,
        persistedChatTabs: fixture.shape.chatTabsPerContainer.reduce(
          (sum, count) => sum + count,
          0,
        ),
      },
      config.responsivenessBudgetMs,
    );
    await recordResponsiveTask(
      tasks,
      'navigate_during_active_power_user_load',
      async () => {
        const liveTab = page.getByTestId(tabIds[index % tabIds.length]);
        await liveTab.click();
        await expect(liveTab).toHaveAttribute('aria-selected', 'true');
        await openPipelinesPage(page);
        await app.selectWorktree(WORKTREE_BRANCH);
        await expect(page.getByTestId('page-main')).toBeVisible({
          timeout: 30_000,
        });
        const probeTab = page.getByTestId(probeTabId);
        await probeTab.click();
        await expect(probeTab).toHaveAttribute('aria-selected', 'true');
        await nextPaint(page);
      },
      { iteration: index + 1, activeTurns, activeRuns },
      config.responsivenessBudgetMs,
    );
  }
  if (interactionsWithCombinedLoad === 0) {
    throw new Error(
      'Power-user chats and pipelines completed before any responsiveness interaction ran',
    );
  }

  await recordTask(tasks, 'all_active_power_user_work_complete', async () => {
    await Promise.all([
      waitUntil(() => activeTurnCount(page).then((count) => count === 0), {
        timeoutMs: config.chatStreamMs + 120_000,
        label: 'all power-user chat turns to complete',
        intervalMs: 250,
      }),
      waitForPipelinesComplete(cards, config),
    ]);
  });
  const emittedOutputBytes = await verifyPerformancePipelineOutput(page, cards);
  const laterTurnActivationMs = await activateLaterForegroundTurn({
    page,
    config,
    tasks,
    tabId: tabIds[0],
    chatIndex: 1,
  });

  return {
    ...startup,
    ...fixture.shape,
    pipelineStateFiles: fixture.pipeline.stateFiles,
    pipelineStateBytes: fixture.pipeline.stateBytes,
    requestedConcurrentTurns: config.concurrentChats,
    peakConcurrentTurns,
    requestedConcurrentRuns: config.concurrentPipelines,
    peakConcurrentRuns,
    overlapTurns,
    overlapRuns,
    interactionsWithCombinedLoad,
    emittedOutputBytes,
    laterTurnActivationMs,
    networkModel:
      'authenticated production traffic observed separately; benchmark provider and web endpoints are deterministic mocks',
  };
}

export async function runLoadedUi({ page, app, config, tasks }) {
  await recordTask(tasks, 'select_worktree', async () => {
    await openMainPage(page);
    // This fixture already seeds the expanded activity panel. Production
    // has no E2E panel test API, so the compatibility shim only adds a
    // hydration timeout; verify the real panel below instead.
    await app.selectWorktree(WORKTREE_BRANCH, NO_ACTIVITY_RAIL);
    await expect(visibleChatPanel(page)).toBeVisible();
    await expect(
      page.getByTestId('panel-content-activity-section'),
    ).toBeVisible();
  });

  const tabs = page.locator('[role="tab"][data-panel-kind="chat"]');
  await expect(tabs).toHaveCount(config.loadedChatTabs, { timeout: 30_000 });
  for (let index = 0; index < config.navigationIterations; index += 1) {
    const tabIndex = (index * 7) % config.loadedChatTabs;
    await recordTask(
      tasks,
      'switch_loaded_chat',
      async () => {
        const tab = tabs.nth(tabIndex);
        await tab.click();
        await expect(tab).toHaveAttribute('aria-selected', 'true');
        await nextPaint(page);
      },
      { iteration: index + 1, tabIndex },
    );
  }

  for (let index = 0; index < config.navigationIterations; index += 1) {
    await recordTask(
      tasks,
      'navigate_page',
      async () => {
        await openPipelinesPage(page);
        await app.selectWorktree(WORKTREE_BRANCH, NO_ACTIVITY_RAIL);
        await expect(page.getByTestId('page-main')).toBeVisible({
          timeout: 30_000,
        });
        await expect(visibleChatPanel(page)).toBeVisible({ timeout: 30_000 });
        await nextPaint(page);
      },
      { iteration: index + 1 },
    );
  }

  return {
    chatTabs: config.loadedChatTabs,
    turnsPerChat: config.loadedTurnsPerChat,
    messages: config.loadedChatTabs * config.loadedTurnsPerChat * 3,
    pipelineExecutions: config.loadedPipelineExecutions,
  };
}

function syntheticText(marker, requestedBytes) {
  const prefix = `${marker} `;
  const unit = 'synthetic transcript benchmark payload ';
  return `${prefix}${unit.repeat(
    Math.ceil(Math.max(0, requestedBytes - prefix.length) / unit.length),
  )}`.slice(0, requestedBytes);
}

function syntheticMarkdownSection(marker, section) {
  return [
    `### ${marker} section ${section}`,
    '',
    '> Profile renderer work with **semantic Markdown**.',
    '',
    '- [x] Preserve transcript behavior',
    '- [ ] Compare renderer timing',
    '',
    '| Surface | Expected |',
    '| --- | --- |',
    '| Transcript | `stable` |',
    '',
    '```ts',
    `const benchmarkSection${section} = {`,
    '  surface: "transcript",',
    '  interaction: "copy-code",',
    '  status: "covered",',
    '};',
    '```',
    '',
    '[Open benchmark notes](https://example.com/perf)',
    '',
  ].join('\n');
}

function syntheticTranscriptText(marker, requestedBytes, markdown) {
  if (!markdown) {
    return syntheticText(marker, requestedBytes);
  }

  let text = '## Synthetic transcript result\n\n';
  const markdownSection = syntheticMarkdownSection(marker, 1);
  if (text.length + markdownSection.length <= requestedBytes) {
    text += markdownSection;
  }

  const remaining = requestedBytes - text.length;
  if (remaining > 0) {
    text += syntheticText('Markdown benchmark body', remaining);
  }
  return text;
}

export function buildSyntheticTranscriptMessages({
  transcriptId,
  messageCount,
  messageBytes,
  shape,
}) {
  const messages = [];
  const baseTimestamp = Date.parse('2026-07-01T12:00:00.000Z');
  for (let index = 0; index < messageCount; index += 1) {
    const role = index % 2 === 0 ? 'user' : 'assistant';
    const marker = `${transcriptId} message ${index + 1}`;
    let blocks;
    if (shape === 'rich' && role === 'assistant') {
      const firstBytes = Math.max(1, Math.floor(messageBytes / 3));
      const secondBytes = Math.max(1, messageBytes - firstBytes);
      if (index % 4 === 1) {
        blocks = [
          {
            type: 'tool_use',
            toolUseId: `${transcriptId}-tool-${index}`,
            toolName: 'Read',
            input: JSON.stringify({
              file_path: `synthetic/fixture-${index}.ts`,
            }),
          },
          {
            type: 'tool_result',
            toolUseId: `${transcriptId}-tool-${index}`,
            toolName: 'Read',
            output: syntheticText(`${marker} tool output`, firstBytes),
            isError: false,
          },
          {
            type: 'text',
            text: syntheticTranscriptText(
              `${marker} explanation`,
              secondBytes,
              true,
            ),
          },
        ];
      } else {
        blocks = [
          {
            type: 'thinking',
            text: syntheticText(`${marker} reasoning`, firstBytes),
          },
          {
            type: 'text',
            text: syntheticTranscriptText(
              `${marker} answer`,
              secondBytes,
              true,
            ),
          },
        ];
      }
    } else {
      blocks = [
        {
          type: 'text',
          text: syntheticTranscriptText(
            marker,
            messageBytes,
            role === 'assistant',
          ),
        },
      ];
    }
    messages.push({
      id: `${transcriptId}-${index + 1}`,
      role,
      blocks,
      timestamp: baseTimestamp + index * 1_000,
    });
  }
  return messages;
}

const DEFAULT_COWORK_WORKSPACE_ID = 'cowork-default';

function writeJsonSync(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const raw = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(filePath, raw, 'utf8');
  return Buffer.byteLength(raw);
}

function coworkEntryOrdinal(index) {
  return String(index + 1).padStart(3, '0');
}

export function prepareDefaultCoworkWorkspace(userDataDir, config, entryCount) {
  seedCoworkWorkspace({
    userDataDir,
    workspaceId: DEFAULT_COWORK_WORKSPACE_ID,
    name: 'Default',
    collapsed: false,
  });

  const workspaceDir = path.join(
    userDataDir,
    'workspaces',
    DEFAULT_COWORK_WORKSPACE_ID,
  );
  const entries = [];
  const entryIds = [];
  let transcriptBytes = 0;
  let transcriptMessages = 0;

  for (let index = 0; index < entryCount; index += 1) {
    const ordinal = coworkEntryOrdinal(index);
    const entryId = `perf-cowork-entry-${ordinal}`;
    const createdAt = new Date(
      Date.parse('2026-07-01T12:00:00.000Z') + index * 60_000,
    ).toISOString();
    const overviewId = `${entryId}-overview`;
    const longId = `${entryId}-long`;
    const pipelineId = `${entryId}-pipeline`;
    const overviewMessages = buildSyntheticTranscriptMessages({
      transcriptId: overviewId,
      messageCount: config.coworkDefaultShortMessages,
      messageBytes: config.coworkDefaultShortMessageBytes,
      shape: 'dense',
    });
    const longMessages = buildSyntheticTranscriptMessages({
      transcriptId: longId,
      messageCount: config.coworkDefaultLongMessages,
      messageBytes: config.coworkDefaultLongMessageBytes,
      shape: index % 5 === 0 ? 'rich' : 'dense',
    });
    const pipelineMessages = buildSyntheticTranscriptMessages({
      transcriptId: pipelineId,
      messageCount: config.coworkDefaultPipelineMessages,
      messageBytes: config.coworkDefaultPipelineMessageBytes,
      shape: 'rich',
    });
    const lastMessageAt = new Date(
      pipelineMessages.at(-1)?.timestamp ?? Date.parse(createdAt),
    ).toISOString();

    const entry = {
      id: entryId,
      title: `Work entry ${ordinal}`,
      createdAt,
      // Current builds should list from this compact registry data. Older
      // builds ignore the forward-compatible field and reproduce the former
      // all-transcript scan, making the same fixture useful for matched A/B.
      summary: {
        version: 1,
        title: `Pipeline review ${ordinal}`,
        lastMessageAt,
        providerType: 'codex',
        chatCount: 3,
        chats: [
          {
            id: overviewId,
            title: `Overview ${ordinal}`,
            description: `Overview ${ordinal}`,
            createdAt,
            lastMessageAt: new Date(
              overviewMessages.at(-1)?.timestamp ?? Date.parse(createdAt),
            ).toISOString(),
            providerType: 'codex',
          },
          {
            id: longId,
            title: `Long transcript ${ordinal}`,
            description: `Long transcript ${ordinal}`,
            createdAt,
            lastMessageAt: new Date(
              longMessages.at(-1)?.timestamp ?? Date.parse(createdAt),
            ).toISOString(),
            providerType: index % 2 === 0 ? 'claude' : 'codex',
          },
          {
            id: pipelineId,
            title: `Pipeline review ${ordinal}`,
            description: `Pipeline review ${ordinal}`,
            createdAt,
            lastMessageAt,
            providerType: 'codex',
          },
        ],
      },
    };
    entries.push(entry);
    entryIds.push(entryId);
    transcriptMessages +=
      overviewMessages.length + longMessages.length + pipelineMessages.length;
    const chatFilePath = path.join(workspaceDir, 'chats', `${entryId}.json`);
    transcriptBytes += writeJsonSync(chatFilePath, {
      version: 1,
      activeTabId: overviewId,
      tabs: [
        {
          id: overviewId,
          title: `Overview ${ordinal}`,
          description: `Overview ${ordinal}`,
          createdAt,
          kind: 'chat',
          providerType: 'codex',
          messages: overviewMessages,
        },
        {
          id: longId,
          title: `Long transcript ${ordinal}`,
          description: `Long transcript ${ordinal}`,
          createdAt,
          kind: 'chat',
          providerType: index % 2 === 0 ? 'claude' : 'codex',
          messages: longMessages,
        },
        {
          id: pipelineId,
          title: `Pipeline review ${ordinal}`,
          description: `Pipeline review ${ordinal}`,
          createdAt,
          kind: 'chat',
          providerType: 'codex',
          messages: pipelineMessages,
        },
      ],
    });
    entry.summary.sourceMtimeNs = statSync(chatFilePath, {
      bigint: true,
    }).mtimeNs.toString();

    seedPipelineExecution({
      userDataDir,
      workspaceId: DEFAULT_COWORK_WORKSPACE_ID,
      worktreeId: entryId,
      execution: {
        id: `perf-cowork-execution-${ordinal}`,
        pipelineId: 'perf-cowork-review',
        pipelineName: `Cowork review ${ordinal}`,
        status: index % 11 === 0 ? 'failure' : 'success',
        startedAt: createdAt,
        completedAt: new Date(Date.parse(createdAt) + 30_000).toISOString(),
      },
      stepLogs: [
        {
          jobId: 'build',
          stepId: 'compile',
          lines: [
            `Work entry ${ordinal} pipeline started`,
            syntheticText(
              `Work entry ${ordinal} pipeline output`,
              config.coworkDefaultPipelineMessageBytes,
            ),
            `Work entry ${ordinal} pipeline completed`,
          ],
        },
      ],
    });
  }

  writeJsonSync(path.join(workspaceDir, 'work-entries.json'), {
    version: 1,
    entries,
  });

  return {
    entryCount,
    entryIds,
    transcriptBytes,
    transcriptMessages,
    pipelineExecutions: entryCount,
  };
}

// Cold catalog summaries reproduce the Home-send migration coupling. Keep
// this workload opt-in; the existing scenarios exercise warm summary indexes.
export function prepareHomeCoworkLegacy(userDataDir, config) {
  const fixture = prepareDefaultCoworkWorkspace(userDataDir, config, 50);
  const workspaceDir = path.join(
    userDataDir,
    'workspaces',
    DEFAULT_COWORK_WORKSPACE_ID,
  );
  const registryPath = path.join(workspaceDir, 'work-entries.json');
  const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  for (const entry of registry.entries) delete entry.summary;
  writeJsonSync(registryPath, registry);
  return { ...fixture, workspaceDir };
}

async function runHomeCoworkLegacy({ page, config, tasks, fixture }) {
  const observationStartedAt = performance.now();
  await registerHomeCoworkScenario(PERFORMANCE_MOCK_BASE_URL);
  await page.getByTestId('sidebar-create-task').click();
  const home = page.getByTestId('page-home');
  await expect(home).toBeVisible();
  // The sole workspace is selected automatically; its redundant picker is
  // hidden, just as in the durable Home/Cowork summary regression spec.
  await expect(home.getByTestId('home-workspace-select')).toHaveCount(0);
  await home.getByTestId('home-composer-editor').fill(HOME_COWORK_PROMPT);
  await recordResponsiveTask(
    tasks,
    'home_send_to_cowork',
    async () => {
      await home.getByTestId('home-send-button').click();
      await expect(page.getByTestId('cowork-top-bar')).toBeVisible({
        timeout: 120_000,
      });
      await expect(
        visibleChatPanel(page)
          .getByText(HOME_COWORK_PROMPT, { exact: true })
          .first(),
      ).toBeVisible({ timeout: 30_000 });
      await nextPaint(page);
    },
    { legacyEntries: fixture.entryCount },
    config.responsivenessBudgetMs,
  );
  await recordResponsiveTask(
    tasks,
    'type_in_new_cowork_entry',
    () =>
      typeDraftAndWaitForPaint(page, {
        scenario: 'home-cowork-legacy',
        iteration: 1,
        characters: config.typingCharacters,
      }),
    { characters: config.typingCharacters },
    config.responsivenessBudgetMs,
  );
  // Compare resource/latency distributions over the same observation window,
  // even when removing migration makes the foreground task much shorter.
  await delay(Math.max(0, 15_000 - (performance.now() - observationStartedAt)));
  const migratedEntryIds = fixture.entryIds.filter((id) =>
    existsSync(
      path.join(fixture.workspaceDir, 'chat-storage-manifests', id + '.json'),
    ),
  );
  // Standalone bootstrap intentionally selects/admit the first registry entry.
  const bootstrapSelectedEntryId = fixture.entryIds[0];
  return {
    workEntries: fixture.entryCount,
    transcriptMessages: fixture.transcriptMessages,
    transcriptBytes: fixture.transcriptBytes,
    historicalEntriesMigrated: migratedEntryIds.length,
    unrelatedEntriesMigrated: migratedEntryIds.filter(
      (id) => id !== bootstrapSelectedEntryId,
    ).length,
    bootstrapSelectedEntryId,
    migratedEntryIds,
    observationWindowMs: 15_000,
  };
}

function defaultCoworkNavigationIndexes(entryCount, requestedIterations) {
  const candidates = [
    0,
    Math.floor(entryCount / 4),
    Math.floor(entryCount / 2),
    Math.floor((entryCount * 3) / 4),
    entryCount - 1,
  ];
  return [...new Set(candidates)].slice(
    0,
    Math.max(3, Math.min(candidates.length, requestedIterations)),
  );
}

async function runDefaultCoworkWorkspace({ page, config, tasks, fixture }) {
  await openMainPage(page);
  // CAN-2363 lifted the catch-all out of the project list into the top-level
  // Chats section, so its disclosure is the section's toggle. This scenario
  // kept asking for the old project-row toggle and had been erroring out at
  // this line — every metric it reported since was from a run that never got
  // past the sidebar.
  const toggle = page.getByTestId('sidebar-section-chats-toggle');
  await expect(toggle).toBeVisible({ timeout: 30_000 });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') {
    await toggle.click();
  }
  // Reveal every entry: the section caps itself at a handful, and a capped
  // list measures none of the cost this scenario exists to measure.
  const showAll = page.getByTestId(
    `sidebar-cowork-project-${DEFAULT_COWORK_WORKSPACE_ID}-show-all`,
  );
  // `isVisible()` resolves immediately; the cowork entry list arrives over
  // IPC after the row mounts, so a cold run can read `false` while it is
  // still in flight and then measure the five-row capped list — the same
  // "reported metrics from a state it never reached" failure fixed above.
  // Every fixture that runs this scenario seeds 50+ entries, so the control
  // is always expected.
  await showAll.waitFor({ state: 'visible', timeout: 30_000 });
  await showAll.click();
  // Let the freshly revealed rows mount and paint. Without this their mount
  // cost lands inside the scroll measurement below and is reported as scroll
  // latency, which is not what the probe is for.
  await nextPaint(page);

  // Scroll the rail with the whole list revealed. Selecting entries never
  // exercised the scroll path, so the cost of a long sidebar — sticky
  // geometry, masks, clips, anything recomputed per frame — went unmeasured
  // by this scenario even when it was not erroring out.
  await recordResponsiveTask(
    tasks,
    'scroll_cowork_sidebar',
    async () => {
      const rail = page.getByTestId('sidebar-scroll-container');
      const box = await rail.boundingBox();
      // Returning here would bank a fast, zero-work "success" for a rail that
      // never rendered. Fail the scenario instead.
      expect(box).not.toBeNull();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      for (let step = 0; step < 24; step += 1) {
        await page.mouse.wheel(0, 320);
      }
      for (let step = 0; step < 24; step += 1) {
        await page.mouse.wheel(0, -320);
      }
      await rail.evaluate(
        () =>
          new Promise((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(resolve));
          }),
      );
    },
    { entryCount: fixture.entryCount },
    config.responsivenessBudgetMs,
  );

  const navigationIndexes = defaultCoworkNavigationIndexes(
    fixture.entryCount,
    config.navigationIterations,
  );
  let chatSelections = 0;
  let typingProbes = 0;

  for (const [iteration, entryIndex] of navigationIndexes.entries()) {
    const entryId = fixture.entryIds[entryIndex];
    const ordinal = coworkEntryOrdinal(entryIndex);
    const row = page.getByTestId(`sidebar-work-entry-${entryId}`);
    await recordResponsiveTask(
      tasks,
      'select_cowork_work_entry',
      async () => {
        await row.scrollIntoViewIfNeeded({ timeout: 30_000 });
        await row.click({ timeout: 30_000 });
        await expect(page.getByTestId('cowork-top-bar')).toBeVisible({
          timeout: 30_000,
        });
        await expect(visibleChatPanel(page)).toBeVisible({ timeout: 30_000 });
        await nextPaint(page);
      },
      { entryIndex, entryId, iteration: iteration + 1 },
      config.responsivenessBudgetMs,
    );

    for (const chatTitle of [
      `Long transcript ${ordinal}`,
      `Pipeline review ${ordinal}`,
      `Overview ${ordinal}`,
    ]) {
      await recordResponsiveTask(
        tasks,
        'select_cowork_chat',
        async () => {
          const tab = page
            .locator('[data-testid^="panel-tab-panel-chat-"]')
            .filter({ hasText: chatTitle });
          await expect(tab).toBeVisible({ timeout: 30_000 });
          await tab.click({ timeout: 30_000 });
          await expect(visibleChatPanel(page)).toBeVisible({ timeout: 30_000 });
          await nextPaint(page);
        },
        { entryIndex, entryId, chatTitle, iteration: iteration + 1 },
        config.responsivenessBudgetMs,
      );
      chatSelections += 1;
    }

    await recordResponsiveTask(
      tasks,
      'type_in_cowork_entry',
      () =>
        typeDraftAndWaitForPaint(page, {
          scenario: `cowork-default-${fixture.entryCount}`,
          iteration: iteration + 1,
          characters: config.typingCharacters,
        }),
      {
        entryIndex,
        entryId,
        iteration: iteration + 1,
        characters: config.typingCharacters,
      },
      config.responsivenessBudgetMs,
    );
    typingProbes += 1;
  }

  return {
    workEntries: fixture.entryCount,
    workEntriesVisited: navigationIndexes.length,
    chatsPerEntry: 3,
    chatSelections,
    typingProbes,
    transcriptMessages: fixture.transcriptMessages,
    transcriptBytes: fixture.transcriptBytes,
    pipelineExecutions: fixture.pipelineExecutions,
  };
}

function multiLineCodeStats(text) {
  const stats = {
    multiLineCodeBlocks: 0,
    multiLineCodeLines: 0,
    multiLineCodeBytes: 0,
  };
  for (const match of text.matchAll(/```[^\n]*\n([\s\S]*?)\n```/g)) {
    const content = match[1] ?? '';
    const lines = content.split('\n');
    if (lines.length < 2) continue;
    stats.multiLineCodeBlocks += 1;
    stats.multiLineCodeLines += lines.length;
    stats.multiLineCodeBytes += Buffer.byteLength(content);
  }
  return stats;
}

function mathExpression(tier, ordinal) {
  if (tier === 'light') {
    return String.raw`Inline relation \(\alpha_${ordinal} + \beta_${ordinal} = \gamma_${ordinal}\).`;
  }
  if (tier === 'medium') {
    return [
      String.raw`\[`,
      String.raw`\frac{\text{aggregate output tokens/second across all users}}`,
      String.raw`{\text{average system watts}} = \eta_${ordinal}\,\frac{\text{tokens}}{\text{joule}}`,
      String.raw`\]`,
    ].join('\n');
  }
  if (tier === 'heavy') {
    return [
      '$$',
      String.raw`\begin{aligned}`,
      String.raw`\mathcal{L}_{${ordinal}}(\theta) &= \sum_{i=1}^{n} w_i \left\lVert A_i\theta-b_i \right\rVert_2^2 \\`,
      String.raw`&\quad + \lambda \int_{0}^{T} \frac{\partial f_\theta(x,t)}{\partial t}\,dt \\`,
      String.raw`\Sigma_${ordinal} &= \begin{bmatrix} \sigma_x^2 & \rho\sigma_x\sigma_y \\ \rho\sigma_x\sigma_y & \sigma_y^2 \end{bmatrix}`,
      String.raw`\end{aligned}`,
      '$$',
    ].join('\n');
  }
  throw new Error(`Unknown math transcript tier: ${tier}`);
}

export function buildMathTranscriptMessages({ tier, elementCount }) {
  const baseTimestamp = Date.parse('2026-07-01T12:00:00.000Z');
  return Array.from({ length: elementCount }, (_, index) => {
    const ordinal = index + 1;
    return {
      id: `math-${tier}-${ordinal}`,
      role: 'assistant',
      blocks: [
        {
          type: 'text',
          text: [
            `Math benchmark ${tier} element ${ordinal}.`,
            '',
            mathExpression(tier, ordinal),
          ].join('\n'),
        },
      ],
      timestamp: baseTimestamp + index * 1_000,
    };
  });
}

function prepareMathTranscripts(userDataDir, config) {
  seedWorkspace(userDataDir);
  const tiers = [
    {
      tier: 'light',
      elementCount: config.mathTranscriptLightElements,
    },
    {
      tier: 'medium',
      elementCount: config.mathTranscriptMediumElements,
    },
    {
      tier: 'heavy',
      elementCount: config.mathTranscriptHeavyElements,
    },
  ].map(({ tier, elementCount }) => {
    const id = `math-transcript-${tier}`;
    const messages = buildMathTranscriptMessages({ tier, elementCount });
    return {
      tier,
      id,
      title: `Math Transcript ${tier[0].toUpperCase()}${tier.slice(1)}`,
      elementCount,
      messages,
      contentBytes: messages.reduce(
        (total, message) =>
          total + Buffer.byteLength(message.blocks[0]?.text ?? ''),
        0,
      ),
    };
  });
  const seeded = seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: tiers.map(({ id, title, messages }) => ({
      id,
      title,
      messages,
    })),
    activeTabId: tiers[0].id,
  });
  return {
    tiers,
    persistedBytes: statSync(seeded.filePath).size,
  };
}

async function openMathTranscript(page, descriptor) {
  const tab = page.getByTestId(`panel-tab-panel-chat-${descriptor.id}`);
  await expect(tab).toBeVisible({ timeout: 60_000 });
  await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  await expect(
    visibleChatPanel(page).getByText(
      `Math benchmark ${descriptor.tier} element ${descriptor.elementCount}.`,
      { exact: true },
    ),
  ).toBeVisible({ timeout: 60_000 });
  await nextPaint(page);
}

async function runMathTranscripts({ page, app, config, tasks, fixture }) {
  await openMainPage(page);
  await recordResponsiveTask(
    tasks,
    'select_math_transcript_worktree',
    async () => {
      await app.selectWorktree(WORKTREE_BRANCH, NO_ACTIVITY_RAIL);
      await expect(visibleChatPanel(page)).toBeVisible({ timeout: 60_000 });
      await nextPaint(page);
    },
    {
      transcriptTiers: fixture.tiers.length,
      persistedBytes: fixture.persistedBytes,
    },
    config.responsivenessBudgetMs,
  );

  for (
    let index = 0;
    index < config.mathTranscriptNavigationIterations;
    index += 1
  ) {
    const descriptor = fixture.tiers[index % fixture.tiers.length];
    await recordResponsiveTask(
      tasks,
      'open_math_transcript',
      () => openMathTranscript(page, descriptor),
      {
        iteration: index + 1,
        tier: descriptor.tier,
        mathElements: descriptor.elementCount,
        transcriptBytes: descriptor.contentBytes,
      },
      config.responsivenessBudgetMs,
    );
    await recordResponsiveTask(
      tasks,
      'type_with_math_transcript',
      () =>
        typeDraftAndWaitForPaint(page, {
          scenario: `math-transcripts-${descriptor.tier}`,
          iteration: index + 1,
          characters: config.typingCharacters,
        }),
      {
        iteration: index + 1,
        tier: descriptor.tier,
        mathElements: descriptor.elementCount,
        characters: config.typingCharacters,
      },
      config.responsivenessBudgetMs,
    );
  }

  return {
    transcriptTiers: fixture.tiers.length,
    persistedBytes: fixture.persistedBytes,
    navigationIterations: config.mathTranscriptNavigationIterations,
    mathElements: fixture.tiers.reduce(
      (total, descriptor) => total + descriptor.elementCount,
      0,
    ),
    mathTranscriptBytes: fixture.tiers.reduce(
      (total, descriptor) => total + descriptor.contentBytes,
      0,
    ),
    ...Object.fromEntries(
      fixture.tiers.map((descriptor) => [
        `${descriptor.tier}MathElements`,
        descriptor.elementCount,
      ]),
    ),
  };
}

const LINEAR_REFERENCE_TOKEN = 'lin_api_perf_linear_references';
const LINEAR_REFERENCE_MARKER = 'Canopy-CLINEARREFERENCES';
const LINEAR_REFERENCE_REQUEST_TAG = 'linear-references';
const LINEAR_REFERENCE_TEAM_PAGE_SIZE = 10;
const LINEAR_REFERENCE_ISSUES_PER_TEAM = 40;

/**
 * Prose for the Linear reference workload: dense bare identifiers that repeat
 * across messages, unknown prefixes, explicit issue URLs, inline code, lists
 * and tables, on both the plain-paragraph and Markdown render paths.
 */
export function linearReferenceMessageText(ordinal) {
  const can = (ordinal % LINEAR_REFERENCE_ISSUES_PER_TEAM) + 1;
  const next = ((ordinal + 7) % LINEAR_REFERENCE_ISSUES_PER_TEAM) + 1;
  const ecw = ((ordinal * 3) % LINEAR_REFERENCE_ISSUES_PER_TEAM) + 1;
  const plain = `Linear reference ${ordinal}: CAN-${can} blocks ECW-${ecw}, then CAN-${next} and CAN-${can} again; FOO-${ordinal} and BAR-${can} are not teams.`;
  if (ordinal % 2 === 0) return plain;
  return [
    plain,
    '',
    `- **CAN-${next}** follows https://linear.app/perf/issue/CAN-${can}`,
    `- [the design ticket](https://linear.app/perf/issue/ECW-${ecw}) and \`CAN-${can}\` in code`,
    '',
    '| Ticket | Owner |',
    '| --- | --- |',
    `| ECW-${ecw} | Rowan |`,
  ].join('\n');
}

export function linearPlainMessageText(ordinal) {
  return `Plain transcript ${ordinal}: ordinary prose with no ticket references, utf-8 text, version 2-4 notes and **emphasis** across a short paragraph.`;
}

function buildLinearReferenceMessages(prefix, count, text) {
  const baseTimestamp = Date.parse('2026-10-01T12:00:00.000Z');
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index + 1}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    blocks: [{ type: 'text', text: text(index + 1) }],
    timestamp: baseTimestamp + index * 1_000,
  }));
}

/** Team catalog spread over several pages; CAN and ECW sit on later pages. */
export function linearReferenceTeams() {
  const filler = Array.from({ length: 28 }, (_, index) => ({
    id: `team_perf_${index}`,
    key: `T${String.fromCharCode(65 + (index % 26))}${Math.floor(index / 26)}`,
    name: `Team ${index}`,
  }));
  return [
    ...filler.slice(0, 18),
    { id: 'team_perf_can', key: 'CAN', name: 'Canopy' },
    ...filler.slice(18),
    { id: 'team_perf_ecw', key: 'ECW', name: 'Ecommerce' },
  ];
}

async function prepareLinearReferenceTranscripts(userDataDir, config) {
  seedWorkspace(userDataDir);
  const dense = buildLinearReferenceMessages(
    'linear-dense',
    config.linearReferenceMessages,
    linearReferenceMessageText,
  );
  const plain = buildLinearReferenceMessages(
    'linear-plain',
    config.linearReferenceMessages,
    linearPlainMessageText,
  );
  const tabs = [
    { id: 'linear-plain', title: 'Plain transcript', messages: plain },
    { id: 'linear-dense', title: 'Linear references', messages: dense },
  ];
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs,
    activeTabId: 'linear-plain',
  });
  const issues = ['CAN', 'ECW'].flatMap((team) =>
    Array.from({ length: LINEAR_REFERENCE_ISSUES_PER_TEAM }, (_, index) => ({
      id: `iss_perf_${team}_${index + 1}`,
      identifier: `${team}-${index + 1}`,
      title: `${team} performance issue ${index + 1} with a title long enough to clip inside the transcript column`,
      url: `https://linear.app/perf/issue/${team}-${index + 1}/performance-issue`,
      state: { name: 'In Progress' },
    })),
  );
  const teams = linearReferenceTeams();
  await registerScenario(PERFORMANCE_MOCK_BASE_URL, LINEAR_REFERENCE_TOKEN, {
    linear: {
      previewTeams: teams,
      teamPageSize: LINEAR_REFERENCE_TEAM_PAGE_SIZE,
      issues,
    },
  });
  const streamText = [
    ...Array.from({ length: 8 }, (_, index) =>
      linearReferenceMessageText(index + 1),
    ),
    `${LINEAR_REFERENCE_MARKER} complete.`,
  ].join('\n\n');
  const streamStep = {
    text: streamText,
    stopReason: 'end_turn',
    streamMs: config.transcriptStreamMs,
    chunkChars: config.transcriptStreamChunkCharacters,
  };
  await registerScenario(PERFORMANCE_MOCK_BASE_URL, LINEAR_REFERENCE_MARKER, {
    llm: {
      steps: [streamStep],
      stepsByRequestTag: { [LINEAR_REFERENCE_REQUEST_TAG]: streamStep },
    },
  });
  return {
    messages: config.linearReferenceMessages,
    teamPages: Math.ceil(teams.length / LINEAR_REFERENCE_TEAM_PAGE_SIZE),
    denseBytes: dense.reduce(
      (total, message) => total + Buffer.byteLength(message.blocks[0].text),
      0,
    ),
  };
}

/**
 * Route E2E and release-like Linear GraphQL to this runner's isolated mock
 * and count the preview operations.
 */
async function routeLinearToPerformanceMock(electronApp) {
  await electronApp.evaluate((_electron, base) => {
    const original = globalThis.fetch;
    const counts = { teams: 0, issue: 0 };
    Reflect.set(globalThis, '__perfLinearPreviewCounts', counts);
    globalThis.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : String(input?.url ?? '');
      if (
        url !== 'https://api.linear.app/graphql' &&
        !(url.endsWith('/graphql') && url.startsWith('http://127.0.0.1:'))
      ) {
        return original(input, init);
      }
      if (typeof init?.body === 'string') {
        if (init.body.includes('referencePreviewTeams')) counts.teams += 1;
        if (init.body.includes('referencePreviewIssue')) counts.issue += 1;
      }
      return original(`${base}/graphql`, init);
    };
  }, PERFORMANCE_MOCK_BASE_URL);
}

function linearPreviewCounts(electronApp) {
  return electronApp.evaluate(() => ({
    ...Reflect.get(globalThis, '__perfLinearPreviewCounts'),
  }));
}

/** DOM footprint of the open transcript; zero references on a build without previews. */
function linearReferenceDom(page) {
  return page.evaluate(() => {
    const scrollers = Array.from(
      document.querySelectorAll('[data-testid="chat-message-list-scroll"]'),
    ).filter((element) => element.getClientRects().length > 0);
    const scroller = scrollers.at(-1) ?? null;
    const viewport = scroller?.getBoundingClientRect() ?? null;
    const references = Array.from(
      scroller?.querySelectorAll('[data-testid="linear-reference"]') ?? [],
    );
    // On screen as the IntersectionObserver sees it: inside the transcript's
    // scroll viewport and every clipping ancestor (such as the sticky prompt's
    // clamp), with a pixel of slack at the edges.
    const onScreen = (element) => {
      const rect = element.getBoundingClientRect();
      let top = viewport.top;
      let bottom = viewport.bottom;
      for (
        let node = element.parentElement;
        node && node !== scroller;
        node = node.parentElement
      ) {
        if (getComputedStyle(node).overflowY !== 'visible') {
          const clip = node.getBoundingClientRect();
          top = Math.max(top, clip.top);
          bottom = Math.min(bottom, clip.bottom);
        }
      }
      return rect.width > 0 && rect.bottom > top + 1 && rect.top < bottom - 1;
    };
    const visible = viewport ? references.filter(onScreen) : [];
    // Chips show only the identifier; a bare reference that resolved declares
    // its canonical URL for the message menu.
    const resolved = (element) => element.hasAttribute('data-link-url');
    const untitled = visible.filter(
      (element) => element.getAttribute('href') === null && !resolved(element),
    );
    // Inspect mounted React controllers, including closed ones; card DOM is
    // already lazy and cannot distinguish the shell deferral.
    let tooltipControllers = 0;
    let recognizedTooltip = false;
    const fiberKey =
      scroller &&
      Object.keys(scroller).find((key) => key.startsWith('__reactFiber$'));
    const visit = (fiber) => {
      if (!fiber) return;
      if (
        fiber.type?.name === 'RichHoverTooltip' ||
        fiber.type?.name === 'RichHoverTooltipController'
      ) {
        recognizedTooltip = true;
        let hooks = 0;
        for (let state = fiber.memoizedState; state; state = state.next)
          hooks += 1;
        if (hooks > 10) tooltipControllers += 1;
      }
      visit(fiber.child);
      visit(fiber.sibling);
    };
    if (fiberKey) visit(scroller[fiberKey].child);
    return {
      // Minified component names make this probe unavailable, not zero.
      tooltipControllers:
        fiberKey && recognizedTooltip ? tooltipControllers : null,
      domNodes: document.getElementsByTagName('*').length,
      transcriptNodes: scroller ? scroller.getElementsByTagName('*').length : 0,
      references: references.length,
      icons: references.filter((element) =>
        element.querySelector('svg[aria-hidden="true"]'),
      ).length,
      // Resolved bare references (the counter keeps its historical name).
      titles: references.filter(resolved).length,
      visibleReferences: visible.length,
      visibleUntitled: untitled.length,
      untitledSample: untitled
        .slice(0, 3)
        .map((element) => element.textContent),
    };
  });
}

// The same work on both builds: the transcript opens and paints.
async function openLinearReferenceTab(page, tabId, lastText) {
  const tab = page.getByTestId(`panel-tab-panel-chat-${tabId}`);
  await expect(tab).toBeVisible({ timeout: 60_000 });
  await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  const panel = visibleChatPanel(page);
  await expect(panel.getByText(lastText).first()).toBeVisible({
    timeout: 60_000,
  });
  await nextPaint(page);
}

/**
 * Enabled state only: the complete catalog decorated the transcript and every
 * visible bare reference resolved through the visibility queue.
 */
async function resolveVisibleLinearTitles(page) {
  let last = null;
  await waitUntil(
    async () => {
      last = await linearReferenceDom(page);
      return last.references > 0 &&
        last.icons === last.references &&
        last.visibleUntitled === 0
        ? last
        : false;
    },
    {
      timeoutMs: 60_000,
      intervalMs: 20,
      label: 'decorated and resolved Linear references',
    },
  ).catch((error) => {
    throw new Error(`${error.message}; last DOM ${JSON.stringify(last)}`, {
      cause: error,
    });
  });
  await nextPaint(page);
}

async function runLinearReferenceTranscripts({
  page,
  app,
  electronApp,
  config,
  tasks,
  fixture,
  releaseLike = false,
}) {
  await openMainPage(page);
  await routeLinearToPerformanceMock(electronApp);
  // Both matched builds must expose the same preview capability.
  const previews = await page.evaluate(
    () => typeof window.api.referencePreview?.linearTeams === 'function',
  );
  await page.evaluate(
    (token) => window.api.saveLinearToken(token),
    LINEAR_REFERENCE_TOKEN,
  );
  await recordResponsiveTask(
    tasks,
    'select_linear_reference_worktree',
    async () => {
      await app.selectWorktree(WORKTREE_BRANCH, NO_ACTIVITY_RAIL);
      await expect(visibleChatPanel(page)).toBeVisible({ timeout: 60_000 });
      await nextPaint(page);
    },
    { messages: fixture.messages },
    config.responsivenessBudgetMs,
  );
  const lastDense = `Linear reference ${fixture.messages}:`;
  const lastPlain = `Plain transcript ${fixture.messages}:`;
  // Cold: first decorated open loads the team catalog and visible titles.
  await recordResponsiveTask(
    tasks,
    'open_linear_reference_transcript_cold',
    () => openLinearReferenceTab(page, 'linear-dense', lastDense),
    { previews },
    config.responsivenessBudgetMs,
  );
  if (previews) {
    // Cold catalog plus the first visible title reads.
    await recordResponsiveTask(
      tasks,
      'resolve_linear_titles_cold',
      () => resolveVisibleLinearTitles(page),
      {},
      config.responsivenessBudgetMs,
    );
  }
  const coldDom = await linearReferenceDom(page);
  const coldCounts = previews
    ? await linearPreviewCounts(electronApp)
    : { teams: 0, issue: 0 };
  if (previews && coldCounts.teams !== fixture.teamPages) {
    throw new Error(
      `Expected one complete ${fixture.teamPages}-page team catalog, saw ${coldCounts.teams} page reads`,
    );
  }

  for (
    let index = 0;
    index < config.linearReferenceNavigationIterations;
    index += 1
  ) {
    await recordResponsiveTask(
      tasks,
      'type_with_linear_references',
      () =>
        typeDraftAndWaitForPaint(page, {
          scenario: 'linear-reference-transcripts',
          iteration: index + 1,
          characters: config.typingCharacters,
        }),
      { iteration: index + 1, characters: config.typingCharacters },
      config.responsivenessBudgetMs,
    );
    await recordResponsiveTask(
      tasks,
      'scroll_linear_reference_transcript',
      async () => {
        const viewport = page.getByTestId('chat-message-list-scroll').last();
        await viewport.hover();
        for (let step = 0; step < 4; step += 1) {
          await page.mouse.wheel(0, -900);
          await nextPaint(page);
        }
      },
      { iteration: index + 1 },
      config.responsivenessBudgetMs,
    );
    await recordResponsiveTask(
      tasks,
      'open_plain_transcript',
      () => openLinearReferenceTab(page, 'linear-plain', lastPlain),
      { iteration: index + 1 },
      config.responsivenessBudgetMs,
    );
    await recordResponsiveTask(
      tasks,
      'type_with_plain_transcript',
      () =>
        typeDraftAndWaitForPaint(page, {
          scenario: 'linear-reference-plain',
          iteration: index + 1,
          characters: config.typingCharacters,
        }),
      { iteration: index + 1, characters: config.typingCharacters },
      config.responsivenessBudgetMs,
    );
    // Warm: the catalog and title cache are already loaded.
    await recordResponsiveTask(
      tasks,
      'open_linear_reference_transcript_warm',
      () => openLinearReferenceTab(page, 'linear-dense', lastDense),
      { iteration: index + 1 },
      config.responsivenessBudgetMs,
    );
    if (previews) {
      await recordResponsiveTask(
        tasks,
        'resolve_linear_titles_warm',
        () => resolveVisibleLinearTitles(page),
        { iteration: index + 1 },
        config.responsivenessBudgetMs,
      );
    }
  }

  if (previews) {
    await recordResponsiveTask(
      tasks,
      'hover_linear_reference',
      async () => {
        const reference = visibleChatPanel(page)
          .getByTestId('linear-reference')
          .last();
        await reference.hover();
        await expect(page.getByTestId('linear-issue-preview-card')).toBeVisible(
          { timeout: 30_000 },
        );
        await page.mouse.move(0, 0);
        await nextPaint(page);
      },
      {},
      config.responsivenessBudgetMs,
    );
    const readsBeforeFocus = await linearPreviewCounts(electronApp);
    await recordResponsiveTask(
      tasks,
      'focus_linear_reference',
      async () => {
        const reference = visibleChatPanel(page)
          .getByTestId('linear-reference')
          .nth(-2);
        await page.keyboard.press('Shift');
        await reference.focus();
        await expect(
          page.getByTestId('linear-issue-preview-card'),
        ).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(page.getByRole('tooltip')).toHaveCount(0);
        await reference.blur();
      },
      {},
      config.responsivenessBudgetMs,
    );
    const readsAfterFocus = await linearPreviewCounts(electronApp);
    if (readsAfterFocus.issue !== readsBeforeFocus.issue)
      throw new Error(
        'Focusing a fresh visible reference issued another provider read',
      );
  }

  // Production bundles cannot execute the E2E-only scripted provider.
  if (!releaseLike) {
    const panel = visibleChatPanel(page);
    const userMessage = `[${LINEAR_REFERENCE_MARKER}] [Canopy-Mock-Request:${LINEAR_REFERENCE_REQUEST_TAG}] Stream Linear references.`;
    await recordStreamedReply(tasks, 'linear_reference_stream', async () => {
      await recordResponsiveTask(
        tasks,
        'start_linear_reference_stream',
        async () => {
          const composer = panel
            .locator('[data-chat-composer-root]')
            .getByRole('textbox')
            .first();
          await composer.fill(userMessage);
          await panel.getByRole('button', { name: 'Send message' }).click();
          await expect(panel.getByText(userMessage).first()).toBeVisible({
            timeout: 30_000,
          });
          await waitUntil(
            () =>
              scenarioLlmRequestCount(
                LINEAR_REFERENCE_MARKER,
                LINEAR_REFERENCE_REQUEST_TAG,
              ).then((count) => count > 0),
            { timeoutMs: 60_000, label: 'Linear reference stream request' },
          );
        },
        {},
        config.responsivenessBudgetMs,
      );
      for (let index = 0; index < config.interactionIterations; index += 1) {
        await recordResponsiveTask(
          tasks,
          'type_during_linear_reference_stream',
          () =>
            typeDraftAndWaitForPaint(page, {
              scenario: 'linear-reference-stream',
              iteration: index + 1,
              characters: config.typingCharacters,
            }),
          { iteration: index + 1, characters: config.typingCharacters },
          config.responsivenessBudgetMs,
        );
      }
      await recordTask(tasks, 'complete_linear_reference_stream', async () => {
        await expect(
          panel.getByText(`${LINEAR_REFERENCE_MARKER} complete.`),
        ).toBeVisible({ timeout: config.transcriptStreamMs + 120_000 });
        await nextPaint(page);
      });
    });
  }
  // Settlement decorates the streamed reply's references.
  const settledDom = await (previews && !releaseLike
    ? waitUntil(
        async () => {
          const dom = await linearReferenceDom(page);
          return dom.references > coldDom.references ? dom : false;
        },
        { timeoutMs: 30_000, label: 'settled stream decoration' },
      )
    : linearReferenceDom(page));
  await nextPaint(page);
  const finalCounts = previews
    ? await linearPreviewCounts(electronApp)
    : { teams: 0, issue: 0 };

  return {
    linearReferencePreviews: previews ? 1 : 0,
    linearReferenceStreamExercised: releaseLike ? 0 : 1,
    linearReferenceMessages: fixture.messages,
    linearReferenceDenseBytes: fixture.denseBytes,
    linearReferenceTeamPages: fixture.teamPages,
    linearReferenceNodesCold: coldDom.references,
    linearTooltipControllersCold: coldDom.tooltipControllers,
    linearTooltipControllersSettled: settledDom.tooltipControllers,
    linearReferenceIconsCold: coldDom.icons,
    linearReferenceTitlesCold: coldDom.titles,
    linearReferenceDomNodesCold: coldDom.domNodes,
    linearReferenceTranscriptNodesCold: coldDom.transcriptNodes,
    linearReferenceVisibleCold: coldDom.visibleReferences,
    linearReferenceNodesSettled: settledDom.references,
    linearReferenceDomNodesSettled: settledDom.domNodes,
    linearTeamPageReadsCold: coldCounts.teams,
    linearIssueReadsCold: coldCounts.issue,
    linearTeamPageReads: finalCounts.teams,
    linearIssueReads: finalCounts.issue,
  };
}

export function transcriptContentCounters(messages) {
  const counters = {
    plainTextBlocks: 0,
    plainTextBytes: 0,
    markdownTextBlocks: 0,
    markdownTextBytes: 0,
    multiLineCodeBlocks: 0,
    multiLineCodeLines: 0,
    multiLineCodeBytes: 0,
    toolUseBlocks: 0,
    toolResultBlocks: 0,
  };
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type === 'text') {
        const markdown = block.text.startsWith(
          '## Synthetic transcript result',
        );
        const blockKey = markdown ? 'markdownTextBlocks' : 'plainTextBlocks';
        const bytesKey = markdown ? 'markdownTextBytes' : 'plainTextBytes';
        counters[blockKey] += 1;
        counters[bytesKey] += Buffer.byteLength(block.text);
        const codeStats = multiLineCodeStats(block.text);
        counters.multiLineCodeBlocks += codeStats.multiLineCodeBlocks;
        counters.multiLineCodeLines += codeStats.multiLineCodeLines;
        counters.multiLineCodeBytes += codeStats.multiLineCodeBytes;
      } else if (block.type === 'tool_use') {
        counters.toolUseBlocks += 1;
      } else if (block.type === 'tool_result') {
        counters.toolResultBlocks += 1;
      }
    }
  }
  return counters;
}

function sumTranscriptContentCounters(entries) {
  return entries.reduce(
    (totals, entry) => {
      for (const key of Object.keys(totals)) {
        totals[key] += entry[key];
      }
      return totals;
    },
    {
      plainTextBlocks: 0,
      plainTextBytes: 0,
      markdownTextBlocks: 0,
      markdownTextBytes: 0,
      multiLineCodeBlocks: 0,
      multiLineCodeLines: 0,
      multiLineCodeBytes: 0,
      toolUseBlocks: 0,
      toolResultBlocks: 0,
    },
  );
}

function reducedTranscriptDimensions(messageCount, messageBytes) {
  return {
    messageCount: Math.max(24, Math.floor(messageCount / 24)),
    messageBytes: Math.max(256, Math.floor(messageBytes / 4)),
  };
}

function archiveTranscriptDimensions(config, archiveIndex) {
  if (archiveIndex < 3) {
    return {
      messageCount: config.largeTranscriptArchiveMessages,
      messageBytes: config.largeTranscriptArchiveMessageBytes,
    };
  }
  return {
    messageCount: Math.max(
      24,
      Math.floor(config.largeTranscriptArchiveMessages / 4),
    ),
    messageBytes: Math.max(
      256,
      Math.floor(config.largeTranscriptArchiveMessageBytes / 2),
    ),
  };
}

function writeLargeTranscriptArchives(
  userDataDir,
  worktreeId,
  worktreeIndex,
  config,
) {
  const archived = Array.from(
    { length: config.largeTranscriptArchivedChatsPerWorktree },
    (_, archiveIndex) => {
      const transcriptId = `large-archive-${worktreeIndex + 1}-${archiveIndex + 1}`;
      const dimensions = archiveTranscriptDimensions(config, archiveIndex);
      const messages = buildSyntheticTranscriptMessages({
        transcriptId,
        ...dimensions,
        shape: archiveIndex % 2 === 0 ? 'rich' : 'dense',
      });
      return {
        tab: {
          id: transcriptId,
          title: `Large Archived Transcript ${worktreeIndex + 1}.${archiveIndex + 1}`,
          createdAt: '2026-07-01T12:00:00.000Z',
          providerType: 'claude',
          messages,
        },
        archivedAt: new Date(
          Date.parse('2026-07-15T12:00:00.000Z') -
            (worktreeIndex * config.largeTranscriptArchivedChatsPerWorktree +
              archiveIndex) *
              60_000,
        ).toISOString(),
        turnCount: Math.ceil(messages.length / 2),
        unread: false,
      };
    },
  );
  const filePath = path.join(
    userDataDir,
    'workspaces',
    WORKSPACE_ID,
    'chat-archives',
    `${worktreeId}.json`,
  );
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(
    filePath,
    `${JSON.stringify({ version: 1, archived }, null, 2)}\n`,
    'utf8',
  );
  return {
    filePath,
    chatCount: archived.length,
    messageCount: archived.reduce(
      (total, entry) => total + entry.tab.messages.length,
      0,
    ),
    content: transcriptContentCounters(
      archived.flatMap((entry) => entry.tab.messages),
    ),
    primaryChatId: archived[0].tab.id,
    primaryChatTitle: archived[0].tab.title,
  };
}

async function prepareLargeTranscriptFixture(
  userDataDir,
  config,
  { concurrent },
) {
  if (concurrent) {
    // Pin the background chat-summary helper so this foreground-concurrency
    // benchmark does not depend on the active credits lane or its credentials.
    writeFileSync(
      path.join(userDataDir, 'preferences.json'),
      JSON.stringify(
        {
          version: 1,
          preferences: {
            summaryModel: 'claude-haiku-4-5-20251001',
            summaryModelSetByUser: true,
          },
        },
        null,
        2,
      ),
      'utf8',
    );
  }
  seedPreexistingWorktrees(
    userDataDir,
    concurrent ? config.preexistingWorktrees : config.largeTranscriptWorktrees,
  );
  const workspaceDir = path.join(userDataDir, 'workspaces', WORKSPACE_ID);
  const persisted = JSON.parse(
    readFileSync(path.join(workspaceDir, 'worktrees.json'), 'utf8'),
  );
  const worktrees = persisted.worktrees
    .slice(0, config.largeTranscriptWorktrees)
    .map((worktree, worktreeIndex) => {
      const shape = worktreeIndex % 2 === 0 ? 'dense' : 'rich';
      const primaryDimensions =
        shape === 'dense'
          ? {
              messageCount: config.largeTranscriptDenseMessages,
              messageBytes: config.largeTranscriptDenseMessageBytes,
            }
          : {
              messageCount: config.largeTranscriptRichMessages,
              messageBytes: config.largeTranscriptRichMessageBytes,
            };
      const reducedDimensions = reducedTranscriptDimensions(
        primaryDimensions.messageCount,
        primaryDimensions.messageBytes,
      );
      const tabs = Array.from(
        { length: config.largeTranscriptLiveChatsPerWorktree },
        (_, tabIndex) => {
          const transcriptId = `large-live-${worktreeIndex + 1}-${tabIndex + 1}`;
          return {
            id: transcriptId,
            title: `Large Live Transcript ${worktreeIndex + 1}.${tabIndex + 1}`,
            createdAt: '2026-07-01T12:00:00.000Z',
            providerType: 'claude',
            messages: buildSyntheticTranscriptMessages({
              transcriptId,
              ...(tabIndex === 0 ? primaryDimensions : reducedDimensions),
              shape: tabIndex === 0 ? shape : tabIndex % 2 ? 'rich' : 'dense',
            }),
          };
        },
      );
      const seeded = seedWorktreeChat({
        userDataDir,
        workspaceId: WORKSPACE_ID,
        worktreeId: worktree.id,
        providerType: 'claude',
        tabs,
        activeTabId: tabs[0].id,
      });
      const liveContent = transcriptContentCounters(
        tabs.flatMap((tab) => tab.messages),
      );
      const archives = writeLargeTranscriptArchives(
        userDataDir,
        worktree.id,
        worktreeIndex,
        config,
      );
      return {
        id: worktree.id,
        branchName: worktree.branchName,
        shape,
        primaryTabId: tabs[0].id,
        secondaryTabId: tabs[1]?.id ?? tabs[0].id,
        primaryMessageCount: tabs[0].messages.length,
        liveChatCount: tabs.length,
        liveMessageCount: tabs.reduce(
          (total, tab) => total + tab.messages.length,
          0,
        ),
        liveFileBytes: statSync(seeded.filePath).size,
        archiveChatCount: archives.chatCount,
        archiveMessageCount: archives.messageCount,
        archiveFileBytes: statSync(archives.filePath).size,
        liveContent,
        archiveContent: archives.content,
        primaryArchiveChatId: archives.primaryChatId,
        primaryArchiveChatTitle: archives.primaryChatTitle,
      };
    });

  if (concurrent) {
    seedPerformancePipeline(userDataDir, config);
    await registerPerformanceChatScenarios(config);
  }

  return {
    worktrees,
    preexistingWorktrees: persisted.worktrees.length,
    liveBytes: worktrees.reduce(
      (total, worktree) => total + worktree.liveFileBytes,
      0,
    ),
    archiveBytes: worktrees.reduce(
      (total, worktree) => total + worktree.archiveFileBytes,
      0,
    ),
    liveChats: worktrees.reduce(
      (total, worktree) => total + worktree.liveChatCount,
      0,
    ),
    archivedChats: worktrees.reduce(
      (total, worktree) => total + worktree.archiveChatCount,
      0,
    ),
    liveMessages: worktrees.reduce(
      (total, worktree) => total + worktree.liveMessageCount,
      0,
    ),
    archivedMessages: worktrees.reduce(
      (total, worktree) => total + worktree.archiveMessageCount,
      0,
    ),
    content: sumTranscriptContentCounters(
      worktrees.flatMap((worktree) => [
        worktree.liveContent,
        worktree.archiveContent,
      ]),
    ),
  };
}

function prepareLargeTranscripts(userDataDir, config) {
  return prepareLargeTranscriptFixture(userDataDir, config, {
    concurrent: false,
  });
}

export function prepareChatSearchIndexing(userDataDir, config) {
  seedWorkspace(userDataDir);
  const initialNeedle = 'chatsearchinitialneedle';
  const appendNeedle = 'chatsearchappendneedle';
  const prefix = 'Chat search indexing benchmark body. ';
  const requestedBytes = config.chatSearchIndexBodyBytes;
  const suffix = ` ${initialNeedle}`;
  const body = `${prefix
    .repeat(Math.ceil((requestedBytes - suffix.length) / prefix.length))
    .slice(0, Math.max(0, requestedBytes - suffix.length))}${suffix}`;
  const largeChatId = 'chat-search-large-body';
  const foregroundChatId = 'chat-search-foreground';
  const seeded = seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    activeTabId: foregroundChatId,
    tabs: [
      {
        id: foregroundChatId,
        title: 'Chat Search Foreground Probe',
        createdAt: '2026-08-04T00:00:00.000Z',
        messages: [],
      },
      {
        id: largeChatId,
        title: 'Chat Search Large Body',
        createdAt: '2026-08-04T00:00:00.000Z',
        messages: Array.from(
          { length: Math.ceil(body.length / 8_000_000) },
          (_, index) => ({
            id: `chat-search-large-message-${index}`,
            role: 'assistant',
            timestamp: Date.parse('2026-08-04T00:00:00.000Z'),
            blocks: [
              {
                type: 'text',
                text: body.slice(index * 8_000_000, (index + 1) * 8_000_000),
              },
            ],
          }),
        ),
      },
    ],
  });
  return {
    userDataDir,
    largeChatId,
    foregroundChatId,
    initialNeedle,
    appendNeedle,
    bodyBytes: Buffer.byteLength(body),
    sourceFileBytes: statSync(seeded.filePath).size,
  };
}

async function waitForChatSearchResult(page, needle, chatId) {
  return page.evaluate(
    async ({ query, expectedChatId }) => {
      const startedAt = performance.now();
      let attempts = 0;
      while (performance.now() - startedAt < 60_000) {
        attempts += 1;
        const response = await window.api.chatSearch.query({
          query,
          limit: 20,
        });
        if (
          response.results.some((result) => result.chatId === expectedChatId)
        ) {
          return { durationMs: performance.now() - startedAt, attempts };
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(
        `Timed out waiting for chat search result ${expectedChatId}`,
      );
    },
    { query: needle, expectedChatId: chatId },
  );
}

function chatSearchIndexStorageStats(userDataDir) {
  const dbPath = path.join(userDataDir, 'derived', 'chat-search.sqlite');
  const bytes = (filePath) =>
    existsSync(filePath) ? statSync(filePath).size : 0;
  return {
    databaseBytes: bytes(dbPath),
    walBytes: bytes(`${dbPath}-wal`),
    shmBytes: bytes(`${dbPath}-shm`),
  };
}

function chatSearchIndexCheckpointState(userDataDir) {
  const dbPath = path.join(userDataDir, 'derived', 'chat-search.sqlite');
  if (!existsSync(dbPath)) return { unavailable: 'database-missing' };
  let database;
  try {
    database = new DatabaseSync(dbPath);
    const state = database.prepare('PRAGMA wal_checkpoint(PASSIVE)').get();
    return {
      busy: state?.busy,
      log: state?.log,
      checkpointed: state?.checkpointed,
    };
  } catch (error) {
    return {
      unavailable: error instanceof Error ? error.name : 'unknown-error',
    };
  } finally {
    database?.close();
  }
}

async function runChatSearchIndexing({
  page,
  app,
  electronApp,
  config,
  tasks,
  fixture,
}) {
  const walDiagnostic =
    process.env.CANOPY_SEARCH_INDEX_WAL_DIAGNOSTIC === '1'
      ? { diagnosticOnly: true, timingComparable: false }
      : null;
  await openMainPage(page);
  await recordResponsiveTask(
    tasks,
    'select_chat_search_fixture',
    async () => {
      await app.selectWorktree(WORKTREE_BRANCH, NO_ACTIVITY_RAIL);
      await expect(visibleChatPanel(page)).toBeVisible({ timeout: 60_000 });
      await nextPaint(page);
    },
    {
      sourceFileBytes: fixture.sourceFileBytes,
      bodyBytes: fixture.bodyBytes,
    },
    config.responsivenessBudgetMs,
  );

  let initialScan;
  const initialTyping = await recordResponsiveTask(
    tasks,
    'chat_search_initial_scan_with_typing',
    async () => {
      const scan = (async () => {
        const startedAt = performance.now();
        await page.evaluate(() => window.api.chatSearch.catalog());
        const result = await waitForChatSearchResult(
          page,
          fixture.initialNeedle,
          fixture.largeChatId,
        );
        return { ...result, outerDurationMs: performance.now() - startedAt };
      })();
      const typing = typeDraftAndWaitForPaint(page, {
        scenario: 'chat-search-initial-scan',
        iteration: 1,
        characters: config.typingCharacters,
      });
      const [scanResult, typingResult] = await Promise.all([scan, typing]);
      initialScan = scanResult;
      return typingResult;
    },
    {
      sourceFileBytes: fixture.sourceFileBytes,
      bodyBytes: fixture.bodyBytes,
      characters: config.typingCharacters,
    },
    config.responsivenessBudgetMs,
  );
  if (walDiagnostic)
    walDiagnostic.afterInitialResult = chatSearchIndexStorageStats(
      fixture.userDataDir,
    );

  let queryProjection;
  const queryTyping = await recordResponsiveTask(
    tasks,
    'chat_search_query_projection_with_typing',
    async () => {
      const query = page.evaluate(
        async ({ needle, chatId }) => {
          const startedAt = performance.now();
          const response = await window.api.chatSearch.query({
            query: needle,
            limit: 20,
          });
          if (!response.results.some((result) => result.chatId === chatId)) {
            throw new Error(`Missing indexed chat ${chatId}`);
          }
          return { durationMs: performance.now() - startedAt };
        },
        { needle: fixture.initialNeedle, chatId: fixture.largeChatId },
      );
      const typing = typeDraftAndWaitForPaint(page, {
        scenario: 'chat-search-query-projection',
        iteration: 1,
        characters: config.typingCharacters,
      });
      const [queryResult, typingResult] = await Promise.all([query, typing]);
      queryProjection = queryResult;
      return typingResult;
    },
    {
      sourceFileBytes: fixture.sourceFileBytes,
      bodyBytes: fixture.bodyBytes,
      characters: config.typingCharacters,
    },
    config.responsivenessBudgetMs,
  );
  if (walDiagnostic)
    walDiagnostic.afterQuery = chatSearchIndexStorageStats(fixture.userDataDir);

  let deltaUpdate;
  const deltaTyping = await recordResponsiveTask(
    tasks,
    'chat_search_append_reindex_with_typing',
    async () => {
      // Durable chat state is main-owned: the transcript delta enters through
      // the canonical E2E provider ingress (commit-before-broadcast), the same
      // ordering real provider events take, and search indexing follows the
      // post-commit materialization.
      const update = (async () => {
        const loadStartedAt = performance.now();
        const data = await page.evaluate(
          ({ projectId, worktreeId }) =>
            window.api.chat.loadTabs({ projectId, worktreeId }),
          { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
        );
        const loadDurationMs = performance.now() - loadStartedAt;
        const tab = data.tabs.find(
          (candidate) => candidate.id === fixture.largeChatId,
        );
        if (!tab) throw new Error(`Missing large chat ${fixture.largeChatId}`);
        const ingestStartedAt = performance.now();
        await electronApp.evaluate(
          async (_electron, { key, payload }) => {
            const ingest = globalThis[key];
            if (typeof ingest !== 'function') {
              throw new Error(
                'Canonical E2E chat-event ingress is unavailable',
              );
            }
            await ingest(payload);
          },
          {
            key: '__CANOPY_E2E_INGEST_CHAT_EVENT__',
            payload: {
              projectId: WORKSPACE_ID,
              worktreeId: WORKTREE_ID,
              chatId: fixture.largeChatId,
              data: {
                type: 'canopy_user_prompt',
                original_text: fixture.appendNeedle,
                canopy_turn_user_message_id: 'chat-search-appended-message',
                provider: 'claude',
              },
            },
          },
        );
        return {
          loadDurationMs,
          ingestOuterDurationMs: performance.now() - ingestStartedAt,
        };
      })();
      const typing = typeDraftAndWaitForPaint(page, {
        scenario: 'chat-search-append-reindex',
        iteration: 1,
        characters: config.typingCharacters,
      });
      const [updateResult, typingResult] = await Promise.all([update, typing]);
      const freshness = await waitForChatSearchResult(
        page,
        fixture.appendNeedle,
        fixture.largeChatId,
      );
      deltaUpdate = { ...updateResult, freshness };
      return typingResult;
    },
    {
      sourceFileBytes: fixture.sourceFileBytes,
      bodyBytes: fixture.bodyBytes,
      characters: config.typingCharacters,
    },
    config.responsivenessBudgetMs,
  );

  const storage = chatSearchIndexStorageStats(fixture.userDataDir);
  if (walDiagnostic) {
    walDiagnostic.afterAppend = storage;
    // Only after all measured actions: this can checkpoint WAL pages and is
    // diagnostic, never part of a comparable task duration or storage metric.
    walDiagnostic.finalPassiveCheckpoint = chatSearchIndexCheckpointState(
      fixture.userDataDir,
    );
  }

  return {
    bodyBytes: fixture.bodyBytes,
    sourceFileBytes: fixture.sourceFileBytes,
    initialScan,
    queryProjection,
    deltaUpdate,
    initialTypingCharacters: initialTyping.characters,
    queryTypingCharacters: queryTyping.characters,
    deltaTypingCharacters: deltaTyping.characters,
    storage,
    ...(walDiagnostic ? { walDiagnostic } : {}),
  };
}

function prepareLargeTranscriptConcurrency(userDataDir, config) {
  return prepareLargeTranscriptFixture(userDataDir, config, {
    concurrent: true,
  });
}

async function selectLargeTranscriptWorktree({ page, app, descriptor }) {
  await app.selectWorktree(descriptor.branchName, NO_ACTIVITY_RAIL);
  const primaryTab = page.getByTestId(
    `panel-tab-panel-chat-${descriptor.primaryTabId}`,
  );
  await expect(primaryTab).toBeVisible({ timeout: 60_000 });
  await expect(visibleChatPanel(page)).toBeVisible({ timeout: 60_000 });
  await nextPaint(page);
}

async function switchLargeTranscriptChat(page, descriptor, tabId) {
  const tab = page.getByTestId(`panel-tab-panel-chat-${tabId}`);
  await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  await nextPaint(page);
}

async function openLargeArchivedTranscript(page, descriptor) {
  const archiveIcon = page.getByTestId('chat-tab-archive');
  await expect(archiveIcon).toBeVisible({ timeout: 60_000 });
  await archiveIcon.click();
  const modal = page.getByTestId('archived-chats-modal');
  await expect(modal).toBeVisible({ timeout: 60_000 });
  const row = modal.locator(
    `[data-testid="archived-chats-modal-row"][data-archived-chat-id="${descriptor.primaryArchiveChatId}"]`,
  );
  await expect(row).toBeVisible({ timeout: 60_000 });
  await row
    .getByText(descriptor.primaryArchiveChatTitle, { exact: true })
    .click();
  const viewer = page.getByTestId('archived-chat-transcript-modal');
  await expect(viewer).toBeVisible({ timeout: 60_000 });
  await expect(viewer.getByTestId('chat-message-list-scroll')).toBeVisible({
    timeout: 60_000,
  });
  await nextPaint(page);
  await viewer.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(viewer).toHaveCount(0);
  await expect(modal).toBeVisible();
  await modal.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(modal).toHaveCount(0);
}

function largeTranscriptCounters(fixture) {
  if (
    fixture.content.multiLineCodeBlocks === 0 ||
    fixture.content.multiLineCodeLines <= fixture.content.multiLineCodeBlocks
  ) {
    throw new Error(
      'Large-transcript fixture did not include multi-line code blocks',
    );
  }
  return {
    preexistingWorktrees: fixture.preexistingWorktrees,
    transcriptWorktrees: fixture.worktrees.length,
    liveTranscriptBytes: fixture.liveBytes,
    archivedTranscriptBytes: fixture.archiveBytes,
    liveChats: fixture.liveChats,
    archivedChats: fixture.archivedChats,
    liveMessages: fixture.liveMessages,
    archivedMessages: fixture.archivedMessages,
    ...fixture.content,
  };
}

async function runLargeTranscripts({ page, app, config, tasks, fixture }) {
  await openMainPage(page);
  await recordTask(tasks, 'load_large_transcript_worktrees', () =>
    waitUntil(
      async () => {
        const ids = await worktreeIds(page);
        return ids.length === fixture.preexistingWorktrees ? ids.length : false;
      },
      {
        timeoutMs: 60_000,
        label: `${fixture.preexistingWorktrees} pre-existing worktrees with ${fixture.worktrees.length} large-transcript worktrees`,
      },
    ),
  );

  let archiveViews = 0;
  for (
    let index = 0;
    index < config.largeTranscriptNavigationIterations;
    index += 1
  ) {
    const descriptor = fixture.worktrees[index % fixture.worktrees.length];
    await recordResponsiveTask(
      tasks,
      'select_large_transcript_worktree',
      () => selectLargeTranscriptWorktree({ page, app, descriptor }),
      {
        iteration: index + 1,
        worktreeIndex: (index % fixture.worktrees.length) + 1,
        shape: descriptor.shape,
        primaryMessages: descriptor.primaryMessageCount,
        liveFileBytes: descriptor.liveFileBytes,
        archiveFileBytes: descriptor.archiveFileBytes,
      },
      config.responsivenessBudgetMs,
    );
    const tabId =
      index % 2 === 0 ? descriptor.secondaryTabId : descriptor.primaryTabId;
    await recordResponsiveTask(
      tasks,
      'switch_large_transcript_chat',
      () => switchLargeTranscriptChat(page, descriptor, tabId),
      {
        iteration: index + 1,
        shape: descriptor.shape,
        target: tabId === descriptor.primaryTabId ? 'primary' : 'secondary',
      },
      config.responsivenessBudgetMs,
    );
    await recordResponsiveTask(
      tasks,
      'type_with_large_transcripts',
      () =>
        typeDraftAndWaitForPaint(page, {
          scenario: 'large-transcripts',
          iteration: index + 1,
          characters: config.typingCharacters,
        }),
      {
        iteration: index + 1,
        characters: config.typingCharacters,
        shape: descriptor.shape,
      },
      config.responsivenessBudgetMs,
    );

    if (archiveViews < config.largeTranscriptArchiveViews) {
      await recordResponsiveTask(
        tasks,
        'open_large_archived_transcript',
        () => openLargeArchivedTranscript(page, descriptor),
        {
          iteration: index + 1,
          archiveMessages: descriptor.archiveMessageCount,
          archiveFileBytes: descriptor.archiveFileBytes,
        },
        config.responsivenessBudgetMs,
      );
      archiveViews += 1;
    }
  }

  return {
    ...largeTranscriptCounters(fixture),
    navigationIterations: config.largeTranscriptNavigationIterations,
    archiveViews,
  };
}

async function prepareStressTranscript(userDataDir, config) {
  seedWorkspace(userDataDir);
  return seedStressTranscript(userDataDir, {
    turns: config.stressTranscriptTurns,
    batches: config.stressTranscriptBatches,
    finalBytes: config.stressTranscriptFinalBytes,
  });
}

async function runStressTranscript({ page, config, tasks, fixture }) {
  await openMainPage(page);
  await openStressEntry(page);
  await recordResponsiveTask(
    tasks,
    'open_stress_transcript_cold',
    () => openStressChat(page, fixture.turns),
    {},
    config.responsivenessBudgetMs,
  );
  await recordResponsiveTask(
    tasks,
    'inspect_stress_history',
    () =>
      inspectStressHistory(page, {
        lastBatch: config.stressTranscriptBatches - 1,
      }),
    {},
    config.responsivenessBudgetMs,
  );
  await recordResponsiveTask(
    tasks,
    'return_to_latest_stress_turn',
    async () => {
      const viewport = page.getByTestId('chat-message-list-scroll').last();
      await viewport.hover();
      await page.mouse.wheel(0, 10_000_000);
      await expect(
        page.getByRole('heading', {
          name: `Stress final report ${fixture.turns}`,
          exact: true,
        }),
      ).toBeAttached();
      await nextPaint(page);
    },
    {},
    config.responsivenessBudgetMs,
  );
  for (
    let iteration = 0;
    iteration < config.interactionIterations;
    iteration += 1
  ) {
    await page.getByTestId(`panel-tab-panel-chat-${fixture.leanId}`).click();
    await recordResponsiveTask(
      tasks,
      'open_stress_transcript_warm',
      () => openStressChat(page, fixture.turns),
      { iteration },
      config.responsivenessBudgetMs,
    );
    await recordResponsiveTask(
      tasks,
      'type_in_stress_transcript',
      () =>
        typeDraftAndWaitForPaint(page, {
          scenario: 'stress-transcript',
          iteration,
          characters: config.typingCharacters,
        }),
      { iteration, characters: config.typingCharacters },
      config.responsivenessBudgetMs,
    );
  }
  return { ...fixture, navigationIterations: config.interactionIterations };
}

function buildTranscriptStreamText(marker, characters) {
  const unit = `Streaming transcript payload ${marker}; preserve ordering, tool ownership, and complete output. `;
  const suffix = ` ${marker} complete.`;
  return (
    `${unit.repeat(Math.ceil(characters / unit.length))}`.slice(
      0,
      Math.max(0, characters - suffix.length),
    ) + suffix
  );
}

export function buildTranscriptStreamConversation(marker, text, config) {
  const steps = [
    {
      toolCalls: [
        {
          name: 'mcp__canopy__GetScriptOutput',
          input: { scriptId: `${marker}-early-owner` },
        },
        {
          name: 'mcp__canopy__GetScriptOutput',
          input: { scriptId: `${marker}-late-result` },
        },
      ],
      stopReason: 'tool_use',
    },
    {
      text,
      stopReason: 'end_turn',
      streamMs: config.transcriptStreamMs,
      chunkChars: config.transcriptStreamChunkCharacters,
    },
  ];
  return {
    steps,
    stepsByRequestTag: {
      'streaming-history': steps,
      'active-turn': steps,
    },
  };
}

export function prepareTranscriptStreamWorkspace(userDataDir) {
  seedWorkspace(userDataDir);
}

const LAB_TRANSCRIPT_REQUEST_TAG = 'streaming-history';
const LAB_TRANSCRIPT_STREAM_MARKER = 'Canopy-CLABTRANSCRIPT';
// Both update bursts and the refocus must land inside one controlled stream.
// Each legacy card patch rewrites the 130 MB chat, about 3 to 5 s per update.
const LAB_TRANSCRIPT_MIN_STREAM_MS = 240_000;

const LAB_CAPTURE_EVIDENCE_DELAY_MS = 35_000;
const LAB_CAPTURE_MEMORY_DIAGNOSTICS_TIMEOUT_MS = 15_000;
const LAB_CAPTURE_CHAT_ROW_BUCKETS = new Set([0, 1_000, 5_000, 20_000, 50_000]);

/** Return whether `candidate` is lexically at or below `root`. */
export function isPathWithinRoot(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

/**
 * Resolve a path beneath a root, including any existing symlinks. Missing
 * final segments are allowed only when the caller is about to create them.
 */
export function resolvePathWithinRoot(
  root,
  candidate,
  { allowMissing = false } = {},
) {
  const absoluteRoot = path.resolve(root);
  const absoluteCandidate = path.resolve(candidate);
  if (!isPathWithinRoot(absoluteRoot, absoluteCandidate)) {
    throw new Error(`Path escapes expected root: ${candidate}`);
  }

  const resolvedRoot = realpathSync(absoluteRoot);
  let existingPath = absoluteCandidate;
  const missingSegments = [];
  let resolvedExistingPath;
  while (true) {
    try {
      resolvedExistingPath = realpathSync(existingPath);
      break;
    } catch (error) {
      if (!allowMissing || error.code !== 'ENOENT') throw error;
      const parentPath = path.dirname(existingPath);
      if (parentPath === existingPath) throw error;
      missingSegments.unshift(path.basename(existingPath));
      existingPath = parentPath;
    }
  }

  const resolvedCandidate = path.resolve(
    resolvedExistingPath,
    ...missingSegments,
  );
  if (!isPathWithinRoot(resolvedRoot, resolvedCandidate)) {
    throw new Error(`Path escapes expected root: ${candidate}`);
  }
  return resolvedCandidate;
}

export function labCaptureAttemptName(
  scenarioName,
  timestamp = new Date(),
  randomHex = randomBytes(3).toString('hex'),
) {
  if (!/^[a-zA-Z0-9._-]+$/.test(scenarioName)) {
    throw new Error('Lab capture scenario name contains unsafe characters');
  }
  if (!(timestamp instanceof Date) || Number.isNaN(timestamp.getTime())) {
    throw new Error('Lab capture timestamp must be a valid Date');
  }
  if (!/^[a-f0-9]{6}$/i.test(randomHex)) {
    throw new Error('Lab capture suffix must be six hexadecimal characters');
  }
  const compactTimestamp = timestamp
    .toISOString()
    .replace(/[-:]/g, '')
    .replace('.', '');
  return `${scenarioName}-${compactTimestamp}-${randomHex.toLowerCase()}`;
}

export function createLabCaptureAttemptDirectory(
  captureDirectory,
  scenarioName,
  {
    now = () => new Date(),
    randomHex = () => randomBytes(3).toString('hex'),
  } = {},
) {
  const captureRoot = realpathSync(captureDirectory);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const name = labCaptureAttemptName(scenarioName, now(), randomHex());
    const candidate = path.join(captureRoot, name);
    if (!isPathWithinRoot(captureRoot, candidate)) {
      throw new Error('Lab capture attempt path escaped its capture directory');
    }
    try {
      mkdirSync(candidate, { recursive: false });
      return resolvePathWithinRoot(captureRoot, candidate);
    } catch (error) {
      if (error.code === 'EEXIST') continue;
      throw error;
    }
  }
  throw new Error('Could not create a unique lab capture attempt directory');
}

export function classifyLabA1Summaries(lines, labWindow) {
  const startedAt = Date.parse(labWindow?.startedAt);
  const endedAt = Date.parse(labWindow?.endedAt);
  if (
    !Number.isFinite(startedAt) ||
    !Number.isFinite(endedAt) ||
    endedAt < startedAt
  ) {
    throw new Error(
      'Lab capture window must have valid ordered ISO timestamps',
    );
  }

  let summaryCount = 0;
  let summariesInWindow = 0;
  let longFrameCount = 0;
  const focusedChatRows = [];
  for (const line of lines) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record?.kind !== 'renderer_frame_summary') continue;
    summaryCount += 1;
    const timestamp = Date.parse(record.timestamp);
    const windowMs = record.rendererSummary?.windowMs;
    if (
      !Number.isFinite(timestamp) ||
      !Number.isFinite(windowMs) ||
      windowMs < 0 ||
      timestamp - windowMs > endedAt ||
      timestamp < startedAt
    ) {
      continue;
    }

    summariesInWindow += 1;
    const longFrames = record.rendererSummary?.frames?.long;
    if (!Array.isArray(longFrames)) continue;
    longFrameCount += longFrames.length;
    for (const frame of longFrames) {
      const bucket = frame?.focusedChatRows;
      if (bucket === null || LAB_CAPTURE_CHAT_ROW_BUCKETS.has(bucket)) {
        focusedChatRows.push(bucket);
      }
    }
  }

  return {
    summaryCount,
    summariesInWindow,
    longFrameCount,
    focusedChatRows,
    status:
      longFrameCount > 0
        ? 'long-frames'
        : summariesInWindow > 0
          ? 'no-long-frames'
          : 'no-summaries',
  };
}

export async function runOptInAfterMeasurementHook(
  hook,
  context,
  env = process.env,
) {
  if (
    typeof hook !== 'function' ||
    env.CANOPY_PERF_LAB_CAPTURE_DIR === undefined
  ) {
    return undefined;
  }
  try {
    return await hook(context);
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function attachLabCaptureReceipt(record, receipt) {
  return receipt === undefined ? record : { ...record, labCapture: receipt };
}

function ensureLabCaptureDirectory(captureDirectory) {
  if (
    typeof captureDirectory !== 'string' ||
    !path.isAbsolute(captureDirectory)
  ) {
    throw new Error(
      'CANOPY_PERF_LAB_CAPTURE_DIR must be an absolute path to a directory',
    );
  }
  try {
    if (existsSync(captureDirectory)) {
      if (!statSync(captureDirectory).isDirectory()) {
        throw new Error('the configured path is not a directory');
      }
    } else {
      mkdirSync(captureDirectory, { recursive: true });
    }
    if (!statSync(captureDirectory).isDirectory()) {
      throw new Error('the configured path is not a directory');
    }
    return realpathSync(captureDirectory);
  } catch (error) {
    throw new Error(
      `Could not prepare CANOPY_PERF_LAB_CAPTURE_DIR (${captureDirectory}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function copyLabAppEventFiles(dataDirectory, attemptDirectory) {
  const sourceDirectory = path.join(
    dataDirectory,
    'agent-observability',
    'diagnostics',
    'app-events',
  );
  const destinationDirectory = path.join(attemptDirectory, 'app-events');
  const resolvedDestination = resolvePathWithinRoot(
    attemptDirectory,
    destinationDirectory,
    {
      allowMissing: true,
    },
  );
  mkdirSync(resolvedDestination, { recursive: false });

  const resolvedSource = resolvePathWithinRoot(dataDirectory, sourceDirectory, {
    allowMissing: true,
  });
  if (!existsSync(resolvedSource)) return [];
  if (!statSync(resolvedSource).isDirectory()) {
    throw new Error('App-events diagnostics path is not a directory');
  }

  const copiedFiles = [];
  for (const entry of readdirSync(resolvedSource, { withFileTypes: true })) {
    if (!entry.name.endsWith('.jsonl')) continue;
    const sourcePath = resolvePathWithinRoot(
      resolvedSource,
      path.join(resolvedSource, entry.name),
    );
    if (!statSync(sourcePath).isFile()) continue;
    const destinationPath = resolvePathWithinRoot(
      attemptDirectory,
      path.join(resolvedDestination, entry.name),
      { allowMissing: true },
    );
    copyFileSync(sourcePath, destinationPath);
    copiedFiles.push(destinationPath);
  }
  return copiedFiles;
}

function copyLabMemoryReport(dataDirectory, reportId, attemptDirectory) {
  if (typeof reportId !== 'string' || reportId.length === 0) {
    throw new Error('Memory diagnostics returned an invalid report ID');
  }
  const reportsDirectory = resolvePathWithinRoot(
    dataDirectory,
    path.join(dataDirectory, 'memory-reports'),
  );
  const sourceDirectory = resolvePathWithinRoot(
    reportsDirectory,
    path.join(reportsDirectory, reportId),
  );
  if (!statSync(sourceDirectory).isDirectory()) {
    throw new Error('Memory diagnostics report path is not a directory');
  }
  const destinationDirectory = resolvePathWithinRoot(
    attemptDirectory,
    path.join(attemptDirectory, 'memory-report'),
    { allowMissing: true },
  );
  mkdirSync(destinationDirectory, { recursive: false });

  const files = [];
  const copyDirectory = (source, destination, relativeDirectory = '') => {
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      const sourcePath = path.join(source, entry.name);
      const resolvedSourcePath = resolvePathWithinRoot(
        sourceDirectory,
        sourcePath,
      );
      const sourceStats = lstatSync(sourcePath);
      if (sourceStats.isSymbolicLink()) {
        throw new Error('Memory diagnostics report contains a symbolic link');
      }
      const relativeName = path.join(relativeDirectory, entry.name);
      const destinationPath = path.join(destination, entry.name);
      const resolvedDestinationPath = resolvePathWithinRoot(
        attemptDirectory,
        destinationPath,
        { allowMissing: true },
      );
      if (sourceStats.isDirectory()) {
        mkdirSync(resolvedDestinationPath, { recursive: false });
        copyDirectory(
          resolvedSourcePath,
          resolvedDestinationPath,
          relativeName,
        );
      } else if (sourceStats.isFile()) {
        copyFileSync(resolvedSourcePath, resolvedDestinationPath);
        files.push({
          name: relativeName.split(path.sep).join('/'),
          sizeBytes: statSync(resolvedDestinationPath).size,
        });
      } else {
        throw new Error(
          'Memory diagnostics report contains an unsupported file',
        );
      }
    }
  };
  copyDirectory(sourceDirectory, destinationDirectory);
  files.sort((left, right) => left.name.localeCompare(right.name));
  return files;
}

async function captureLabTranscriptDiagnostics({
  page,
  counters,
  scenarioName,
  userDataDir,
}) {
  const captureDirectory = ensureLabCaptureDirectory(
    process.env.CANOPY_PERF_LAB_CAPTURE_DIR,
  );
  const attemptDirectory = createLabCaptureAttemptDirectory(
    captureDirectory,
    scenarioName,
  );
  const labWindow = counters?.labWindow;
  if (!labWindow?.startedAt || !labWindow?.endedAt) {
    throw new Error('Lab transcript result is missing its measured window');
  }

  const elapsedMs = Date.now() - Date.parse(labWindow.endedAt);
  await delay(Math.max(0, LAB_CAPTURE_EVIDENCE_DELAY_MS - elapsedMs));
  const visibilityState = await page.evaluate(() => document.visibilityState);

  // Copy the A1 evidence before the memory report introduces its own pause.
  const dataDirectory = realpathSync(userDataDir);
  const appEventFiles = copyLabAppEventFiles(dataDirectory, attemptDirectory);
  const a1 = classifyLabA1Summaries(
    appEventFiles.flatMap((file) =>
      readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean),
    ),
    labWindow,
  );

  await page.evaluate(() =>
    window.api.savePreferences({ memoryDiagnosticsEnabled: true }),
  );
  const statusDeadline = Date.now() + LAB_CAPTURE_MEMORY_DIAGNOSTICS_TIMEOUT_MS;
  let memoryStatus;
  while (Date.now() <= statusDeadline) {
    memoryStatus = await page.evaluate(() =>
      window.api.memoryDiagnostics.getStatus(),
    );
    if (memoryStatus?.enabled === true) break;
    await delay(Math.min(250, Math.max(0, statusDeadline - Date.now())));
  }
  if (memoryStatus?.enabled !== true) {
    throw new Error('Memory diagnostics did not enable within 15 seconds');
  }

  const report = await page.evaluate(() =>
    window.api.memoryDiagnostics.createReport(),
  );
  if (!report?.ok) {
    throw new Error(
      `Memory diagnostics report failed: ${report?.message ?? report?.reason ?? 'unknown error'}`,
    );
  }
  const reportSummary = report.report;
  const files = copyLabMemoryReport(
    dataDirectory,
    reportSummary.reportId,
    attemptDirectory,
  );
  const receipt = {
    status: 'captured',
    scenarioName,
    attemptDirectory: path.basename(attemptDirectory),
    labWindow,
    visibilityState,
    a1,
    memoryReport: {
      reportId: reportSummary.reportId,
      fileCount: reportSummary.fileCount,
      totalBytes: reportSummary.totalBytes,
      durationMs: reportSummary.durationMs,
      files,
    },
  };
  const receiptPath = resolvePathWithinRoot(
    attemptDirectory,
    path.join(attemptDirectory, 'receipt.json'),
    { allowMissing: true },
  );
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
    flag: 'wx',
  });
  return receipt;
}

async function seedLabTranscriptFixture(userDataDir) {
  prepareTranscriptStreamWorkspace(userDataDir);
  const { LAB_TRANSCRIPT, seedLabTranscript } =
    await import('../electron/lab-transcript-fixture.mjs');
  if (!LAB_TRANSCRIPT || typeof seedLabTranscript !== 'function') {
    throw new Error('The lab transcript fixture module is incomplete');
  }

  const fixture = await seedLabTranscript(userDataDir);
  const dimensions = labTranscriptDimensions(fixture);
  return { ...fixture, dimensions };
}

async function prepareLabTranscript(userDataDir, config) {
  const fixture = await seedLabTranscriptFixture(userDataDir);
  const streamMs = Math.max(
    config.transcriptStreamMs,
    LAB_TRANSCRIPT_MIN_STREAM_MS,
  );
  const text = buildTranscriptStreamText(
    LAB_TRANSCRIPT_STREAM_MARKER,
    config.transcriptStreamCharacters,
  );
  await registerScenario(
    PERFORMANCE_MOCK_BASE_URL,
    LAB_TRANSCRIPT_STREAM_MARKER,
    {
      llm: buildTranscriptStreamConversation(
        LAB_TRANSCRIPT_STREAM_MARKER,
        text,
        { ...config, transcriptStreamMs: streamMs },
      ),
    },
  );
  return {
    ...fixture,
    marker: LAB_TRANSCRIPT_STREAM_MARKER,
    requestTag: LAB_TRANSCRIPT_REQUEST_TAG,
    providerFinalMarker: `${LAB_TRANSCRIPT_STREAM_MARKER} complete.`,
    streamCharacters: text.length,
    streamMs,
  };
}

const prepareLabTranscriptCheckpoint = (userDataDir) =>
  seedLabTranscriptFixture(userDataDir);

async function openLabTranscriptEntry(page, fixture) {
  await openMainPage(page);
  const defaultToggle = page.getByTestId(
    'sidebar-cowork-project-cowork-default-toggle',
  );
  if (
    (await defaultToggle.count()) > 0 &&
    (await defaultToggle.isVisible()) &&
    (await defaultToggle.getAttribute('aria-expanded')) !== 'true'
  ) {
    await defaultToggle.click();
  }
  await page.getByTestId(`sidebar-work-entry-${fixture.entryId}`).click();
  const chatTab = page.getByTestId(`panel-tab-panel-chat-${fixture.chatId}`);
  await expect(chatTab).toBeVisible({ timeout: 30_000 });
  await chatTab.click();
  await expect(chatPanelForTab(page, fixture.chatId)).toBeVisible({
    timeout: 30_000,
  });
  return chatPanelForTab(page, fixture.chatId);
}

async function assertLabProviderActive(page, fixture, label) {
  const active = await readLabTranscriptActiveSession(page, fixture);
  if (active.activeCount < 1) {
    throw new Error(
      `Lab transcript provider was not active ${label}; observed ${active.activeCount} active turns`,
    );
  }
  return active;
}

async function startLabTranscriptStream({ page, config, tasks, fixture }) {
  const panel = chatPanelForTab(page, fixture.chatId);
  const userMessage = `[${fixture.marker}] [Canopy-Mock-Request:${fixture.requestTag}] Stream while transcript cards update.`;
  await recordResponsiveTask(
    tasks,
    'lab_transcript_start_provider',
    async () => {
      await panel.getByRole('textbox').first().fill(userMessage);
      await panel.getByRole('button', { name: 'Send message' }).click();
      await expect(panel.getByText(userMessage, { exact: true })).toBeVisible({
        timeout: 30_000,
      });
      await waitUntil(
        async () =>
          (await readLabTranscriptActiveSession(page, fixture)).activeCount > 0,
        {
          timeoutMs: 60_000,
          label: 'lab transcript provider to become active',
        },
      );
      await waitUntil(
        () =>
          scenarioLlmRequestCount(fixture.marker, fixture.requestTag).then(
            (count) => count > 0,
          ),
        {
          timeoutMs: 60_000,
          label: 'lab transcript controlled provider request',
        },
      );
      // Committed pages hold no in-progress text; the second provider request
      // (after the tool results) is the one that streams the reply text.
      await waitUntil(
        async () => {
          const active = await readLabTranscriptActiveSession(page, fixture);
          if (active.activeCount < 1) {
            throw new FatalWaitError(
              'Lab transcript provider finished before its streamed text began',
            );
          }
          const requests = await scenarioLlmRequestCount(
            fixture.marker,
            fixture.requestTag,
          );
          return requests >= 2;
        },
        {
          timeoutMs: 60_000,
          intervalMs: 50,
          label: 'lab transcript streamed text request',
        },
      );
    },
    { chatId: fixture.chatId },
    config.responsivenessBudgetMs,
  );
  const active = await assertLabProviderActive(
    page,
    fixture,
    'after provider start',
  );
  const providerStreamStart = {
    textStepRequested: true,
    providerRequests: await scenarioLlmRequestCount(
      fixture.marker,
      fixture.requestTag,
    ),
    activeChatIds: active.activeChatIds,
  };
  return { userMessage, providerStreamStart };
}

/**
 * Measures how long the focused chat takes to render streamed provider text
 * past `afterCharacters`. A slow render is the workload's measured outcome,
 * not a harness failure; the provider must still be active.
 */
async function measureLabStreamingPayload(
  page,
  fixture,
  label,
  { afterCharacters = 0, timeoutMs = 20_000 } = {},
) {
  const payload = chatPanelForTab(page, fixture.chatId)
    .getByText(`Streaming transcript payload ${fixture.marker}`, {
      exact: false,
    })
    .first();
  const startedAtMs = performance.now();
  let visibleTextCharacters = 0;
  while (performance.now() - startedAtMs < timeoutMs) {
    const active = await readLabTranscriptActiveSession(page, fixture);
    if (active.activeCount < 1) {
      throw new FatalWaitError(
        `Lab transcript provider finished before ${label} could be measured`,
      );
    }
    visibleTextCharacters =
      (await payload.count()) > 0
        ? ((await payload.textContent()) ?? '').length
        : 0;
    if (visibleTextCharacters > afterCharacters) break;
    await delay(100);
  }
  return {
    rendered: visibleTextCharacters > afterCharacters,
    visibleTextCharacters,
    waitedMs: performance.now() - startedAtMs,
    timeoutMs,
  };
}

async function runLabTranscriptUpdatePhase({
  page,
  electronApp,
  fixture,
  count,
  labelPrefix,
}) {
  let providerActiveChecks = 0;
  const result = await runSerializedLabTranscriptUpdates({
    labelPrefix,
    count,
    update: async (label) => {
      const activeBefore = await assertLabProviderActive(
        page,
        fixture,
        `before ${label}`,
      );
      const receipt = await updateLabTranscript(electronApp, label);
      const activeAfter = await assertLabProviderActive(
        page,
        fixture,
        `after ${label}`,
      );
      providerActiveChecks += 2;
      return {
        ...receipt,
        providerActiveBefore: activeBefore.activeCount,
        providerActiveAfter: activeAfter.activeCount,
      };
    },
  });
  return { ...result, providerActiveChecks };
}

async function selectLabTranscriptTab(page, fixture, chatId) {
  const tab = page.getByTestId(`panel-tab-panel-chat-${chatId}`);
  await expect(tab).toBeVisible({ timeout: 30_000 });
  await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  if (chatId === fixture.chatId) {
    await expect(chatPanelForTab(page, fixture.chatId)).toBeVisible();
  }
  return readLabTranscriptChatVisibility(page, fixture);
}

function assertHeadlessLabWindow(identity, label, startIdentity) {
  if (!identity.available) {
    throw new Error(`Lab transcript main native window was not found ${label}`);
  }
  if (identity.visible) {
    throw new Error(`Lab transcript native window became visible ${label}`);
  }
  if (
    startIdentity &&
    identity.nativeWindowId !== startIdentity.nativeWindowId
  ) {
    throw new Error(
      'Lab transcript changed its native main window during the run',
    );
  }
}

async function runLabTranscriptScenario({
  page,
  electronApp,
  config,
  tasks,
  fixture,
  variant,
}) {
  const before = await inspectLabTranscript(electronApp);
  const provenance = labTranscriptProvenance(fixture, before);
  const nativeWindowStart =
    await readLabTranscriptNativeWindowIdentity(electronApp);
  assertHeadlessLabWindow(nativeWindowStart, 'at start');

  await openLabTranscriptEntry(page, fixture);
  const labWindowStartedAt = new Date().toISOString();
  const initialVisibility = await readLabTranscriptChatVisibility(
    page,
    fixture,
  );
  if (!initialVisibility.chatSelected || !initialVisibility.chatPanelVisible) {
    throw new Error('Lab transcript chat did not open as the selected tab');
  }

  const focusedUpdateCount = variant === 'onscreen' ? 16 : 4;
  const hiddenUpdateCount = LAB_TRANSCRIPT_UPDATE_COUNT - focusedUpdateCount;
  let focusedUpdates;
  let hiddenUpdates;
  let focusedAfter;
  let hiddenAfter;
  let focusedVisibilityAfter;
  let hiddenVisibilityAfter;
  let providerStreamStart;
  let focusedStreamText;

  await recordStreamedReply(tasks, 'lab-focused-stream', async () => {
    const started = await startLabTranscriptStream({
      page,
      config,
      tasks,
      fixture,
    });
    providerStreamStart = started.providerStreamStart;
    focusedUpdates = await runLabTranscriptUpdatePhase({
      page,
      electronApp,
      fixture,
      count: focusedUpdateCount,
      labelPrefix: 'lab-focused',
    });
    focusedStreamText = await measureLabStreamingPayload(
      page,
      fixture,
      'focused streamed text',
    );
    focusedVisibilityAfter = await readLabTranscriptChatVisibility(
      page,
      fixture,
    );
    if (
      !focusedVisibilityAfter.chatSelected ||
      !focusedVisibilityAfter.chatPanelVisible
    ) {
      throw new Error(
        'Lab transcript left the focused tab during its update burst',
      );
    }
    focusedAfter = await inspectLabTranscript(electronApp);
  });

  const hiddenVisibility = await selectLabTranscriptTab(
    page,
    fixture,
    fixture.leanId,
  );
  if (
    hiddenVisibility.chatSelected ||
    hiddenVisibility.chatPanelVisible ||
    !hiddenVisibility.siblingSelected
  ) {
    throw new Error(
      'Lab transcript chat remained visible behind its sibling tab',
    );
  }
  await recordStreamedReply(tasks, 'lab-hidden-stream', async () => {
    hiddenUpdates = await runLabTranscriptUpdatePhase({
      page,
      electronApp,
      fixture,
      count: hiddenUpdateCount,
      labelPrefix: 'lab-hidden',
    });
    hiddenVisibilityAfter = await readLabTranscriptChatVisibility(
      page,
      fixture,
    );
    if (
      hiddenVisibilityAfter.chatSelected ||
      hiddenVisibilityAfter.chatPanelVisible ||
      !hiddenVisibilityAfter.siblingSelected
    ) {
      throw new Error(
        'Lab transcript left the hidden-tab state during its update burst',
      );
    }
    hiddenAfter = await inspectLabTranscript(electronApp);
  });
  const hiddenProviderProgress = await assertLabProviderActive(
    page,
    fixture,
    'after hidden updates',
  );
  const hiddenProgress = assertLabTranscriptUpdateProgress({
    before: focusedAfter,
    after: hiddenAfter,
    updates: hiddenUpdates.updates,
    expectedCount: hiddenUpdateCount,
  });

  const after = await inspectLabTranscript(electronApp);
  const updates = [
    ...(focusedUpdates?.updates ?? []),
    ...(hiddenUpdates?.updates ?? []),
  ];
  const progress = assertLabTranscriptUpdateProgress({
    before,
    after,
    updates,
  });
  const latestUpdateLabel = updates.at(-1)?.label;
  if (!latestUpdateLabel) {
    throw new Error('Lab transcript update receipt has no final update label');
  }
  const latestLegacySentinel = `lab-legacy-${latestUpdateLabel}`;

  let catchupVisibility;
  let catchupPartialEvidence;
  let catchupSentinelEvidence;
  await recordStreamedReply(tasks, 'lab-refocused-catchup', async () => {
    catchupVisibility = await selectLabTranscriptTab(
      page,
      fixture,
      fixture.chatId,
    );
    if (
      !catchupVisibility.chatSelected ||
      !catchupVisibility.chatPanelVisible
    ) {
      throw new Error('Lab transcript chat did not catch up after refocus');
    }
    const catchup = await measureLabStreamingPayload(
      page,
      fixture,
      'refocused catch-up',
      { afterCharacters: focusedStreamText.visibleTextCharacters },
    );
    catchupPartialEvidence = {
      ...catchup,
      focusedVisibleTextCharacters: focusedStreamText.visibleTextCharacters,
    };
    await waitUntil(
      async () =>
        (await readLabTranscriptActiveSession(page, fixture)).activeCount === 0,
      {
        timeoutMs: fixture.streamMs + 120_000,
        label: 'lab transcript provider completion after refocus',
      },
    );
    await expect(
      chatPanelForTab(page, fixture.chatId).getByText(
        fixture.providerFinalMarker,
        { exact: false },
      ),
    ).toBeAttached({ timeout: 30_000 });
    const streamSentinelInChat = chatPanelForTab(
      page,
      fixture.chatId,
    ).getByText(progress.latestSentinel, { exact: false });
    const legacySentinelInChat = chatPanelForTab(
      page,
      fixture.chatId,
    ).getByText(latestLegacySentinel, { exact: false });
    const streamSentinelRendered = (await streamSentinelInChat.count()) > 0;
    if (streamSentinelRendered) {
      await expect(streamSentinelInChat.first()).toBeAttached();
    }
    const legacySentinelRendered = (await legacySentinelInChat.count()) > 0;
    if (legacySentinelRendered) {
      await expect(legacySentinelInChat.first()).toBeAttached();
    }
    catchupSentinelEvidence = {
      stream: streamSentinelRendered
        ? 'rendered-chat-sentinel'
        : 'canonical-reread-only',
      legacy: legacySentinelRendered
        ? 'rendered-chat-sentinel'
        : 'canonical-reread-only',
    };
  });

  // Reread from main's canonical store without reloading the renderer: a
  // reload would reset the renderer monitor this measurement depends on.
  const persistedRead = await readPersistedLabTranscriptPage(
    page,
    electronApp,
    fixture,
    {
      latestSentinel: progress.latestSentinel,
      latestLegacySentinel,
      providerFinalMarker: fixture.providerFinalMarker,
      target: before.target,
    },
  );
  if (
    !persistedRead.providerFinalMarkerRead ||
    !persistedRead.streamSentinelRead ||
    !persistedRead.legacySentinelRead
  ) {
    throw new Error(
      `Lab transcript reread did not find the provider, child-stream and legacy-card writes: ${JSON.stringify(persistedRead)}`,
    );
  }
  persistedRead.rereadBy = 'canonical-store-reread';
  persistedRead.reloadOrRelaunch = false;
  persistedRead.parentReadSource = 'window.api.chat.getTranscriptPage';
  const reopenedVisibility = await readLabTranscriptChatVisibility(
    page,
    fixture,
  );
  const nativeWindowEnd =
    await readLabTranscriptNativeWindowIdentity(electronApp);
  assertHeadlessLabWindow(nativeWindowEnd, 'at end', nativeWindowStart);
  if (
    !reopenedVisibility.chatSelected ||
    !reopenedVisibility.chatPanelVisible
  ) {
    throw new Error('Lab transcript chat was not the selected tab at the end');
  }
  persistedRead.chatVisibility = reopenedVisibility;

  const labWindow = {
    startedAt: labWindowStartedAt,
    endedAt: new Date().toISOString(),
  };
  return {
    ...provenance,
    labWindow,
    updateCount: progress.achievedCount,
    legacyUpdateOutcomes: after.legacyOutcomes ?? null,
    updateCadenceMs: LAB_TRANSCRIPT_UPDATE_CADENCE_MS,
    focusedUpdateCount,
    hiddenUpdateCount,
    hiddenProgress: {
      ...hiddenProgress,
      activeProviderChatIds: hiddenProviderProgress.activeChatIds,
      visible: hiddenVisibility,
      providerActiveChecks: hiddenUpdates.providerActiveChecks,
      chatVisibilityAfter: hiddenVisibilityAfter,
    },
    focusedWindow: {
      label: 'lab-focused-stream',
      chatVisibility: initialVisibility,
      chatVisibilityEnd: focusedVisibilityAfter,
      updateCount: focusedUpdates.achievedCount,
      maxStartGapMs: focusedUpdates.maxStartGapMs,
      providerActiveChecks: focusedUpdates.providerActiveChecks,
      streamingTextAfterBurst: focusedStreamText,
    },
    // The provider stream is proven by its text request and by an active turn
    // around every update; committed pages carry no in-progress text.
    providerStream: {
      ...providerStreamStart,
      streamMs: fixture.streamMs,
    },
    hiddenWindow: {
      label: 'lab-hidden-stream',
      chatVisibility: hiddenVisibility,
      updateCount: hiddenUpdates.achievedCount,
      maxStartGapMs: hiddenUpdates.maxStartGapMs,
    },
    refocusedCatchup: {
      label: 'lab-refocused-catchup',
      chatVisibility: catchupVisibility,
      partialProviderText: catchupPartialEvidence,
      providerFinalMarker: fixture.providerFinalMarker,
      sentinelEvidence: catchupSentinelEvidence,
    },
    persistedRead,
    nativeWindow: { start: nativeWindowStart, end: nativeWindowEnd },
    progress,
  };
}

async function runLabTranscriptCheckpointScenario({
  page,
  electronApp,
  tasks,
  fixture,
}) {
  const before = await inspectLabTranscript(electronApp);
  const provenance = labTranscriptProvenance(fixture, before);
  const nativeWindowStart =
    await readLabTranscriptNativeWindowIdentity(electronApp);
  assertHeadlessLabWindow(nativeWindowStart, 'before checkpoint probe');

  await openLabTranscriptEntry(page, fixture);
  const visibility = await readLabTranscriptChatVisibility(page, fixture);
  if (!visibility.chatSelected || !visibility.chatPanelVisible) {
    throw new Error(
      'Lab transcript checkpoint fixture did not load its primary chat',
    );
  }

  const checkpointReceipt = await recordTask(
    tasks,
    'lab_transcript_checkpoint',
    async () =>
      summarizeLabTranscriptCheckpoint(
        await runLabTranscriptCheckpointProbe({
          electronApp,
          fixture,
          target: before.target,
        }),
      ),
    { fixtureDimensions: fixture.dimensions },
  );
  const after = await inspectLabTranscript(electronApp);
  if (
    after.legacyUpdates !== before.legacyUpdates ||
    after.streamUpdates - before.streamUpdates !==
      checkpointReceipt.mutationCount ||
    after.latestRevision <= before.latestRevision
  ) {
    throw new Error(
      'Lab transcript checkpoint probe did not commit exactly its bounded child-only updates',
    );
  }
  const nativeWindowEnd =
    await readLabTranscriptNativeWindowIdentity(electronApp);
  assertHeadlessLabWindow(
    nativeWindowEnd,
    'after checkpoint probe',
    nativeWindowStart,
  );
  return {
    ...provenance,
    checkpointReceipt,
    checkpointProbe: {
      standalone: true,
      providerStream: false,
      legacyStatusUpdates: 0,
      childRowMutations: checkpointReceipt.mutationCount,
      fixtureLoaded: true,
      chatVisibility: visibility,
      inspectionBefore: normalizeLabTranscriptReceipt(before),
      inspectionAfter: normalizeLabTranscriptReceipt(after),
      nativeWindow: { start: nativeWindowStart, end: nativeWindowEnd },
    },
  };
}

async function prepareTranscriptStream(userDataDir, config, activeTurnOnly) {
  prepareTranscriptStreamWorkspace(userDataDir);
  const fixture = await seedStressTranscript(userDataDir, {
    turns: activeTurnOnly ? 1 : config.stressTranscriptTurns,
    batches: activeTurnOnly ? 1 : config.stressTranscriptBatches,
    finalBytes: activeTurnOnly ? 1_024 : config.stressTranscriptFinalBytes,
    providerType: 'claude',
  });
  const marker = activeTurnOnly
    ? 'Canopy-CTRANSCRIPTACTIVETURN'
    : 'Canopy-CTRANSCRIPTSTREAMINGHISTORY';
  const requestTag = activeTurnOnly ? 'active-turn' : 'streaming-history';
  const characters = activeTurnOnly
    ? config.transcriptActiveTurnCharacters
    : config.transcriptStreamCharacters;
  const text = buildTranscriptStreamText(marker, characters);
  await registerScenario(PERFORMANCE_MOCK_BASE_URL, marker, {
    llm: buildTranscriptStreamConversation(marker, text, config),
  });
  return {
    ...fixture,
    marker,
    requestTag,
    characters,
    streamMs: config.transcriptStreamMs,
  };
}

async function transcriptActiveTurnCount(page, fixture) {
  return page.evaluate(
    async ({ projectId, worktreeId }) => {
      const result = await window.api.chat.activeSessions({
        projectId,
        worktreeId,
      });
      return (result.sessions ?? []).filter((session) => session.turnActive)
        .length;
    },
    { projectId: fixture.workspaceId, worktreeId: fixture.entryId },
  );
}

async function returnToLatestStressTurn(page, fixture) {
  const viewport = page.getByTestId('chat-message-list-scroll').last();
  await viewport.hover();
  await page.mouse.wheel(0, 10_000_000);
  await expect(
    page.getByRole('heading', {
      name: `Stress final report ${fixture.turns}`,
      exact: true,
    }),
  ).toBeAttached();
  await nextPaint(page);
}

async function runTranscriptStreamReply({
  page,
  config,
  tasks,
  fixture,
  panel,
  userMessage,
  inspectHistory,
}) {
  await recordResponsiveTask(
    tasks,
    'start_transcript_stream',
    async () => {
      const composer = panel.getByRole('textbox').first();
      await composer.fill(userMessage);
      await panel.getByRole('button', { name: 'Send message' }).click();
      await expect(panel.getByText(userMessage).first()).toBeVisible({
        timeout: 30_000,
      });
      await waitUntil(
        () =>
          transcriptActiveTurnCount(page, fixture).then((count) => count > 0),
        { timeoutMs: 60_000, label: 'controlled transcript stream to start' },
      );
      await waitUntil(
        () =>
          scenarioLlmRequestCount(fixture.marker, fixture.requestTag).then(
            (count) => count > 0,
          ),
        { timeoutMs: 60_000, label: 'controlled provider request' },
      );
    },
    { inspectHistory },
    config.responsivenessBudgetMs,
  );

  for (
    let iteration = 0;
    iteration < config.interactionIterations;
    iteration++
  ) {
    await recordResponsiveTask(
      tasks,
      'scroll_during_transcript_stream',
      async () => {
        const viewport = page.getByTestId('chat-message-list-scroll').last();
        await viewport.hover();
        await page.mouse.wheel(0, iteration % 2 === 0 ? -1_200 : 1_200);
        await nextPaint(page);
      },
      { iteration, inspectHistory },
      config.responsivenessBudgetMs,
    );
    await recordResponsiveTask(
      tasks,
      'type_during_transcript_stream',
      () =>
        typeDraftAndWaitForPaint(page, {
          scenario: inspectHistory
            ? 'transcript-streaming-history'
            : 'transcript-streaming-tail',
          iteration,
          characters: config.typingCharacters,
        }),
      { iteration, inspectHistory, characters: config.typingCharacters },
      config.responsivenessBudgetMs,
    );
  }

  await recordTask(tasks, 'complete_transcript_stream', async () => {
    await waitUntil(
      () =>
        transcriptActiveTurnCount(page, fixture).then((count) => count === 0),
      {
        timeoutMs: config.transcriptStreamMs + 120_000,
        label: 'controlled transcript stream to complete',
      },
    );
    await returnToLatestStressTurn(page, fixture);
    await expect(panel.getByText(`${fixture.marker} complete.`)).toBeAttached({
      timeout: 30_000,
    });
  });
}

async function runTranscriptStream({
  page,
  config,
  tasks,
  fixture,
  inspectHistory,
}) {
  await openMainPage(page);
  await openStressEntry(page);
  await recordResponsiveTask(
    tasks,
    'open_transcript_stream_fixture',
    () => openStressChat(page, fixture.turns),
    { inspectHistory },
    config.responsivenessBudgetMs,
  );
  if (inspectHistory) {
    await recordResponsiveTask(
      tasks,
      'load_and_collapse_transcript_history',
      () => inspectStressHistory(page),
      {},
      config.responsivenessBudgetMs,
    );
    await recordResponsiveTask(
      tasks,
      'return_to_latest_before_stream',
      () => returnToLatestStressTurn(page, fixture),
      {},
      config.responsivenessBudgetMs,
    );
  }

  const panel = visibleChatPanel(page);
  const userMessage = `[${fixture.marker}] [Canopy-Mock-Request:${fixture.requestTag}] Run the controlled transcript stream.`;
  // The whole controlled stream, probes included, is one streamed reply for
  // the advisory frame-budget report.
  await recordStreamedReply(tasks, 'transcript_stream', () =>
    runTranscriptStreamReply({
      page,
      config,
      tasks,
      fixture,
      panel,
      userMessage,
      inspectHistory,
    }),
  );

  const preservedDraft = `${fixture.marker} draft survives sibling round trip`;
  await recordResponsiveTask(
    tasks,
    'round_trip_transcript_stream_sibling',
    async () => {
      const composer = panel.getByRole('textbox').first();
      await composer.fill(preservedDraft);
      await page.getByTestId(`panel-tab-panel-chat-${fixture.leanId}`).click();
      await expect(
        page.getByTestId(`panel-tab-panel-chat-${fixture.leanId}`),
      ).toHaveAttribute('aria-selected', 'true');
      await page.getByTestId(`panel-tab-panel-chat-${fixture.chatId}`).click();
      await returnToLatestStressTurn(page, fixture);
      await expect(
        visibleChatPanel(page).getByText(`${fixture.marker} complete.`),
      ).toBeAttached();
      await expect(
        visibleChatPanel(page).getByRole('textbox').first(),
      ).toHaveText(preservedDraft);
      await visibleChatPanel(page).getByRole('textbox').first().fill('');
    },
    { inspectHistory },
    config.responsivenessBudgetMs,
  );

  return {
    ...fixture,
    inspectHistory,
    streamMs: config.transcriptStreamMs,
    chunkCharacters: config.transcriptStreamChunkCharacters,
    interactionIterations: config.interactionIterations,
  };
}

const prepareTranscriptStreaming = (userDataDir, config) =>
  prepareTranscriptStream(userDataDir, config, false);
const prepareTranscriptActiveTurn = (userDataDir, config) =>
  prepareTranscriptStream(userDataDir, config, true);
const prepareTranscriptActiveTurnStop = (userDataDir, config) =>
  prepareTranscriptStream(
    userDataDir,
    {
      ...config,
      transcriptStreamMs: Math.min(config.transcriptStreamMs, 2_000),
    },
    true,
  );

const FRAME_SMOOTHNESS_MARKER = 'Canopy-CFRAMESMOOTHNESS';
const FRAME_SMOOTHNESS_REQUEST_TAG = 'frame-smoothness';
// A trackpad delivers about one wheel event per 60 Hz frame.
const FRAME_SMOOTHNESS_WHEEL_GAP_MS = 16;
const FRAME_SMOOTHNESS_WHEEL_STEPS = 24;
const FRAME_SMOOTHNESS_WHEEL_DELTA = 120;

/**
 * Markdown the frame-smoothness reply streams: headings, task lists, tables,
 * code fences and links, the blocks a long agent reply renders while it
 * streams.
 */
export function buildFrameSmoothnessStreamText(marker, characters) {
  const suffix = `\n\n${marker} complete.`;
  let text = '';
  for (let section = 1; text.length < characters; section += 1) {
    text += `${syntheticMarkdownSection(marker, section)}\n`;
    text += `${syntheticText(`Paragraph ${section}`, 360)}\n\n`;
  }
  return text.slice(0, Math.max(0, characters - suffix.length)) + suffix;
}

/**
 * The frame-smoothness fixture: the stress transcript (one long transcript
 * and a lean sibling in Default cowork), a loaded worktree with persisted
 * chats, enough extra Cowork entries for the sidebar to scroll, and a
 * Markdown reply the mock provider streams after two tool calls.
 */
async function prepareFrameSmoothness(userDataDir, config) {
  prepareTranscriptStreamWorkspace(userDataDir);
  seedLoadedUiState(userDataDir, config);
  // The stress seeder writes a workspace index of its own; keep the loaded
  // worktree's project beside Default cowork.
  const indexPath = path.join(userDataDir, 'workspaces', 'index.json');
  const gitWorkspaces = JSON.parse(readFileSync(indexPath, 'utf8')).workspaces;
  const fixture = await seedStressTranscript(userDataDir, {
    turns: config.stressTranscriptTurns,
    batches: config.stressTranscriptBatches,
    finalBytes: config.stressTranscriptFinalBytes,
    providerType: 'claude',
  });
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  index.workspaces = [
    ...index.workspaces,
    ...gitWorkspaces.map((workspace, order) => ({
      ...workspace,
      order: index.workspaces.length + order,
    })),
  ];
  writeFileSync(indexPath, JSON.stringify(index));
  const entriesPath = path.join(
    userDataDir,
    'workspaces',
    fixture.workspaceId,
    'work-entries.json',
  );
  const registry = JSON.parse(readFileSync(entriesPath, 'utf8'));
  const createdAt = '2026-08-01T12:00:00.000Z';
  for (
    let index = 0;
    index < config.frameSmoothnessSidebarEntries;
    index += 1
  ) {
    const ordinal = String(index + 1).padStart(3, '0');
    registry.entries.push({
      id: `frame-smoothness-entry-${ordinal}`,
      title: `Sidebar entry ${ordinal}`,
      createdAt,
      summary: {
        version: 1,
        title: `Sidebar entry ${ordinal}`,
        lastMessageAt: createdAt,
        providerType: 'claude',
        chatCount: 0,
        chats: [],
      },
    });
  }
  writeFileSync(entriesPath, JSON.stringify(registry));
  const text = buildFrameSmoothnessStreamText(
    FRAME_SMOOTHNESS_MARKER,
    config.transcriptStreamCharacters,
  );
  const { steps } = buildTranscriptStreamConversation(
    FRAME_SMOOTHNESS_MARKER,
    text,
    config,
  );
  await registerScenario(PERFORMANCE_MOCK_BASE_URL, FRAME_SMOOTHNESS_MARKER, {
    llm: {
      steps,
      stepsByRequestTag: { [FRAME_SMOOTHNESS_REQUEST_TAG]: steps },
    },
  });
  return {
    ...fixture,
    marker: FRAME_SMOOTHNESS_MARKER,
    requestTag: FRAME_SMOOTHNESS_REQUEST_TAG,
    characters: text.length,
    sidebarEntries: config.frameSmoothnessSidebarEntries,
  };
}

/** Wheel-scrolls `target` at trackpad cadence, `direction` 1 down, -1 up. */
async function wheelAtTrackpadCadence(page, target, direction) {
  await target.hover();
  for (let step = 0; step < FRAME_SMOOTHNESS_WHEEL_STEPS; step += 1) {
    await page.mouse.wheel(0, direction * FRAME_SMOOTHNESS_WHEEL_DELTA);
    await delay(FRAME_SMOOTHNESS_WHEEL_GAP_MS);
  }
  await nextPaint(page);
}

/** Moves the pointer down `target` in small steps, as a hand sweeps a list. */
async function sweepPointer(page, target) {
  const box = await target.boundingBox();
  if (!box) throw new Error('Hover sweep target has no box');
  const x = box.x + box.width / 2;
  const steps = 40;
  for (let step = 0; step <= steps; step += 1) {
    await page.mouse.move(x, box.y + (box.height * step) / steps);
    await delay(FRAME_SMOOTHNESS_WHEEL_GAP_MS / 2);
  }
  await nextPaint(page);
}

async function runFrameSmoothness({ page, app, config, tasks, fixture }) {
  const iterations = config.frameSmoothnessIterations;
  const area = (name, label, operation) =>
    recordFrameWindow(tasks, name, label, operation);

  await openMainPage(page);
  await openStressEntry(page);
  await area('chat', 'open_long_transcript', () =>
    recordResponsiveTask(
      tasks,
      'open_frame_smoothness_transcript',
      () => openStressChat(page, fixture.turns),
      {},
      config.responsivenessBudgetMs,
    ),
  );

  const transcript = page.getByTestId('chat-message-list-scroll').last();
  await area('scroll', 'transcript', async () => {
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      await wheelAtTrackpadCadence(page, transcript, -1);
      await wheelAtTrackpadCadence(page, transcript, 1);
    }
  });

  // One streamed Markdown reply after two tool steps, cut into what a user
  // does during it: watch it follow the bottom, type, scroll back, finish.
  await returnToLatestStressTurn(page, fixture);
  const panel = visibleChatPanel(page);
  const userMessage = `[${fixture.marker}] [Canopy-Mock-Request:${fixture.requestTag}] Stream the frame-smoothness reply.`;
  await recordStreamedReply(tasks, 'frame_smoothness_stream', async () => {
    await area('chat', 'stream_start', async () => {
      const composer = panel.getByRole('textbox').first();
      await composer.fill(userMessage);
      await panel.getByRole('button', { name: 'Send message' }).click();
      await waitUntil(
        () =>
          transcriptActiveTurnCount(page, fixture).then((count) => count > 0),
        { timeoutMs: 60_000, label: 'frame-smoothness stream to start' },
      );
    });
    await area('chat', 'stream_follow', () =>
      delay(Math.round(config.transcriptStreamMs / 3)),
    );
    await area('chat', 'type_during_stream', () =>
      recordResponsiveTask(
        tasks,
        'type_during_frame_smoothness_stream',
        () =>
          typeDraftAndWaitForPaint(page, {
            scenario: 'frame-smoothness',
            iteration: 0,
            characters: config.typingCharacters,
          }),
        { characters: config.typingCharacters },
        config.responsivenessBudgetMs,
      ),
    );
    await area('scroll', 'transcript_during_stream', async () => {
      await wheelAtTrackpadCadence(page, transcript, -1);
      await wheelAtTrackpadCadence(page, transcript, 1);
      await transcript.hover();
      await page.mouse.wheel(0, 10_000_000);
      await nextPaint(page);
    });
    await area('chat', 'stream_finish', async () => {
      await waitUntil(
        () =>
          transcriptActiveTurnCount(page, fixture).then((count) => count === 0),
        {
          timeoutMs: config.transcriptStreamMs + 120_000,
          label: 'frame-smoothness stream to complete',
        },
      );
      await expect(panel.getByText(`${fixture.marker} complete.`)).toBeAttached(
        { timeout: 30_000 },
      );
      await nextPaint(page);
    });
  });

  const leanTab = page.getByTestId(`panel-tab-panel-chat-${fixture.leanId}`);
  const stressTab = page.getByTestId(`panel-tab-panel-chat-${fixture.chatId}`);
  await area('switching', 'chat_tab', async () => {
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      for (const tab of [leanTab, stressTab]) {
        await tab.click();
        await expect(tab).toHaveAttribute('aria-selected', 'true');
        await nextPaint(page);
      }
    }
  });

  await area('switching', 'worktree', async () => {
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      await app.selectWorktree(WORKTREE_BRANCH, NO_ACTIVITY_RAIL);
      await expect(visibleChatPanel(page)).toBeVisible({ timeout: 30_000 });
      await nextPaint(page);
      await openStressEntry(page);
      await nextPaint(page);
    }
  });

  await app.selectWorktree(WORKTREE_BRANCH, NO_ACTIVITY_RAIL);
  const loadedTabs = page.locator('[role="tab"][data-panel-kind="chat"]');
  await expect(loadedTabs).toHaveCount(config.loadedChatTabs, {
    timeout: 30_000,
  });
  await area('switching', 'loaded_chat_tab', async () => {
    for (let iteration = 0; iteration < iterations * 2; iteration += 1) {
      const tab = loadedTabs.nth((iteration * 3 + 1) % config.loadedChatTabs);
      await tab.click();
      await expect(tab).toHaveAttribute('aria-selected', 'true');
      await nextPaint(page);
    }
  });

  await area('switching', 'page', async () => {
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      await page.getByTestId('sidebar-create-task').click();
      await expect(page.getByTestId('page-home')).toBeVisible();
      await nextPaint(page);
      await app.openAutomationsPage();
      await nextPaint(page);
      await openMainPage(page);
      await nextPaint(page);
    }
  });

  await area('switching', 'settings', async () => {
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      await app.openSettings();
      await nextPaint(page);
      await app.closeSettings();
      await nextPaint(page);
    }
  });

  const sidebar = page.getByTestId('app-sidebar');
  const sidebarToggle = page.getByTestId('sidebar-toggle');
  await area('switching', 'sidebar_collapse', async () => {
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      await sidebarToggle.click();
      await expect(sidebar).toBeHidden();
      await nextPaint(page);
      await sidebarToggle.click();
      await expect(sidebar).toBeVisible();
      await nextPaint(page);
    }
  });

  const sidebarViewport = page.getByTestId('sidebar-scroll-container');
  await area('scroll', 'sidebar', async () => {
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      await wheelAtTrackpadCadence(page, sidebarViewport, 1);
      await wheelAtTrackpadCadence(page, sidebarViewport, -1);
    }
  });

  await app.openSettings();
  const settings = page.getByTestId('settings-overlay');
  await area('scroll', 'settings', async () => {
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      await wheelAtTrackpadCadence(page, settings, 1);
      await wheelAtTrackpadCadence(page, settings, -1);
    }
  });
  await app.closeSettings();

  await area('feedback', 'hover_sidebar', async () => {
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      await sweepPointer(page, sidebarViewport);
    }
  });

  await area('feedback', 'panel_menu', async () => {
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      await openPanelAddMenu(page, 'group-chat');
      await expect(page.getByTestId('panel-add-menu')).toBeVisible();
      await nextPaint(page);
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('panel-add-menu')).toBeHidden();
      await nextPaint(page);
    }
  });

  await area('feedback', 'command_palette', async () => {
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      await page.keyboard.press(
        `${process.platform === 'darwin' ? 'Meta' : 'Control'}+K`,
      );
      await expect(page.getByTestId('command-palette')).toBeVisible();
      await nextPaint(page);
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('command-palette')).toBeHidden();
      await nextPaint(page);
    }
  });

  return {
    iterations,
    sidebarEntries: fixture.sidebarEntries,
    streamCharacters: fixture.characters,
    streamMs: config.transcriptStreamMs,
    loadedChatTabs: config.loadedChatTabs,
  };
}

export function transcriptStopFenceWaitMs(streamMs) {
  return streamMs + 250;
}

const runTranscriptStreamingTail = (context) =>
  runTranscriptStream({ ...context, inspectHistory: false });
const runTranscriptStreamingHistory = (context) =>
  runTranscriptStream({ ...context, inspectHistory: true });
const runTranscriptActiveTurn = (context) =>
  runTranscriptStream({ ...context, inspectHistory: false });

async function runTranscriptActiveTurnStop({ page, config, tasks, fixture }) {
  await openMainPage(page);
  await openStressEntry(page);
  await openStressChat(page, fixture.turns);
  const panel = visibleChatPanel(page);
  const userMessage = `[${fixture.marker}] [Canopy-Mock-Request:${fixture.requestTag}] Stop this controlled transcript stream.`;
  await recordResponsiveTask(
    tasks,
    'start_transcript_active_turn_stop',
    async () => {
      const composer = panel.getByRole('textbox').first();
      await composer.fill(userMessage);
      await panel.getByRole('button', { name: 'Send message' }).click();
      await waitUntil(
        () =>
          scenarioLlmRequestCount(fixture.marker, fixture.requestTag).then(
            (count) => count >= 2,
          ),
        {
          timeoutMs: 60_000,
          label: 'tool results to reach the delayed stream',
        },
      );
      await expect(
        panel.getByRole('button', { name: 'Stop generation', exact: true }),
      ).toBeVisible({ timeout: 30_000 });
    },
    {},
    config.responsivenessBudgetMs,
  );
  await recordResponsiveTask(
    tasks,
    'stop_transcript_active_turn',
    async () => {
      await panel
        .getByRole('button', { name: 'Stop generation', exact: true })
        .click();
      await waitUntil(
        () =>
          transcriptActiveTurnCount(page, fixture).then((count) => count === 0),
        { timeoutMs: 60_000, label: 'stopped transcript turn to become idle' },
      );
      await expect(
        panel.getByRole('button', { name: 'Send message', exact: true }),
      ).toBeVisible({ timeout: 30_000 });
    },
    {},
    config.responsivenessBudgetMs,
  );
  await delay(transcriptStopFenceWaitMs(fixture.streamMs));
  await expect(panel.getByText(`${fixture.marker} complete.`)).toHaveCount(0);
  await recordResponsiveTask(
    tasks,
    'type_after_transcript_active_turn_stop',
    () =>
      typeDraftAndWaitForPaint(page, {
        scenario: 'transcript-active-turn-stop',
        iteration: 0,
        characters: config.typingCharacters,
      }),
    { characters: config.typingCharacters },
    config.responsivenessBudgetMs,
  );
  return { ...fixture, termination: 'user-stop' };
}

export function buildTranscriptToolActiveTurnConversation(
  marker,
  toolExchanges,
) {
  const toolStep = {
    toolCalls: Array.from({ length: toolExchanges }, (_, index) => ({
      name: 'mcp__canopy__GetScriptOutput',
      input: { scriptId: `transcript-performance-${index}` },
    })),
    stopReason: 'tool_use',
  };
  const finalStep = {
    text: `${marker} complete.`,
    stopReason: 'end_turn',
    streamMs: 1_000,
    chunkChars: 16,
  };
  return { steps: [toolStep, finalStep] };
}

/**
 * Tool calls a sized active turn issues per model step. Every pending call
 * renders an animated spinner, and one step of 1,000 parallel calls froze
 * the E2E renderer for minutes (its compositor thread saturated and the page
 * stopped answering), so the sized turns grow by steps of this many calls,
 * as a long agent turn does.
 */
export const TOOL_ACTIVE_TURN_BATCH = 10;

/**
 * A sized active turn: `size` tool calls, `batch` per model step, each with
 * its own tool-use id, then the completion text.
 */
export function buildSizedToolActiveTurnConversation(
  marker,
  size,
  batch = TOOL_ACTIVE_TURN_BATCH,
) {
  const steps = [];
  for (let first = 0; first < size; first += batch) {
    steps.push({
      toolCalls: Array.from(
        { length: Math.min(batch, size - first) },
        (_, offset) => ({
          id: `toolu_perf_turn${size}_${first + offset}`,
          name: 'mcp__canopy__GetScriptOutput',
          input: { scriptId: `transcript-performance-${first + offset}` },
        }),
      ),
      stopReason: 'tool_use',
    });
  }
  steps.push({
    text: `${marker} complete.`,
    stopReason: 'end_turn',
    streamMs: 1_000,
    chunkChars: 16,
  });
  return { steps };
}

/**
 * The clean active-turn brackets of `transcript-active-turn-tools`: one fresh
 * chat per size, whose single turn carries that many tool calls. They are the
 * inputs of the P1 and P2 scaling ratios (`scaling-ratios.mjs`).
 */
export function transcriptToolActiveTurnSizeFixtures(sizes) {
  return sizes.map((size) => ({
    size,
    batch: TOOL_ACTIVE_TURN_BATCH,
    chatId: `transcript-tool-active-turn-${size}`,
    title: `Tool active turn ${size}`,
    marker: `Canopy-CTRANSCRIPTTOOLACTIVETURN${size}`,
    requestTag: `tool-active-turn-${size}`,
    taskKind: toolActiveTurnTaskKind(size),
  }));
}

/**
 * A sized turn's completion budget: a floor plus time per tool call. Calls
 * run one at a time and slow as the turn grows (about 0.4-0.7 s each on the
 * test Mac today), so this bounds a stall rather than predicting a duration.
 */
export function toolActiveTurnTimeoutMs(size) {
  return 180_000 + size * 2_000;
}

async function prepareTranscriptToolActiveTurn(userDataDir, config) {
  seedWorkspace(userDataDir);
  const sized = transcriptToolActiveTurnSizeFixtures(
    config.transcriptToolActiveTurnSizes ?? [],
  );
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    activeTabId: 'transcript-tool-active-turn',
    tabs: [
      { id: 'transcript-tool-active-turn', title: 'Tool active turn' },
      ...sized.map((fixture) => ({ id: fixture.chatId, title: fixture.title })),
    ],
  });
  const marker = 'Canopy-CTRANSCRIPTTOOLACTIVETURN';
  const requestTag = 'tool-active-turn';
  await registerScenario(PERFORMANCE_MOCK_BASE_URL, marker, {
    llm: buildTranscriptToolActiveTurnConversation(
      marker,
      config.transcriptToolExchanges,
    ),
  });
  for (const fixture of sized) {
    await registerScenario(PERFORMANCE_MOCK_BASE_URL, fixture.marker, {
      llm: buildSizedToolActiveTurnConversation(
        fixture.marker,
        fixture.size,
        fixture.batch,
      ),
    });
  }
  return {
    marker,
    requestTag,
    toolExchanges: config.transcriptToolExchanges,
    sized,
  };
}

async function runTranscriptToolActiveTurn({
  page,
  app,
  electronApp,
  config,
  tasks,
  fixture,
}) {
  await openMainPage(page);
  await app.selectWorktree(WORKTREE_BRANCH, NO_ACTIVITY_RAIL);
  const panel = visibleChatPanel(page);
  const userMessage = `[${fixture.marker}] [Canopy-Mock-Request:${fixture.requestTag}] Run the controlled tool-heavy turn.`;
  await recordStreamedReply(tasks, 'tool_active_turn', async () => {
    await recordResponsiveTask(
      tasks,
      'start_tool_active_turn',
      async () => {
        const composer = panel
          .locator('[data-chat-composer-root]')
          .getByRole('textbox')
          .first();
        await composer.fill(userMessage);
        await panel.getByRole('button', { name: 'Send message' }).click();
        await expect(panel.getByText(userMessage).first()).toBeVisible({
          timeout: 30_000,
        });
        await waitUntil(
          () => activeTurnCount(page).then((count) => count > 0),
          {
            timeoutMs: 60_000,
            label: 'tool-heavy transcript turn to start',
          },
        );
        await waitUntil(
          () =>
            scenarioLlmRequestCount(fixture.marker, fixture.requestTag).then(
              (count) => count > 0,
            ),
          { timeoutMs: 60_000, label: 'tool-heavy provider request' },
        );
      },
      { toolExchanges: fixture.toolExchanges },
      config.responsivenessBudgetMs,
    );
    await recordResponsiveTask(
      tasks,
      'type_during_tool_active_turn',
      () =>
        typeDraftAndWaitForPaint(page, {
          scenario: 'transcript-active-turn-tools',
          iteration: 0,
          characters: config.typingCharacters,
        }),
      { characters: config.typingCharacters },
      config.responsivenessBudgetMs,
    );
    await recordTask(tasks, 'complete_tool_active_turn', async () => {
      await waitUntil(
        () => activeTurnCount(page).then((count) => count === 0),
        {
          timeoutMs: 180_000,
          label: 'tool-heavy transcript turn to complete',
        },
      );
      await expect(panel.getByText(`${fixture.marker} complete.`)).toBeAttached(
        {
          timeout: 30_000,
        },
      );
    });
  });

  // Clean brackets for the scaling ratios: each size runs in its own chat,
  // with no input probe inside it, and opens and closes only once the chat is
  // quiet. A bracket that could not wait for quiet at either end may hold
  // another turn's work, so it is marked `settled: false` and the ratios that
  // read it report unavailable instead of a value.
  const sizedTurns = [];
  for (const sized of fixture.sized ?? []) {
    const tab = page.getByTestId(`panel-tab-panel-chat-${sized.chatId}`);
    await tab.click();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    const sizedPanel = chatPanelForTab(page, sized.chatId);
    await expect(sizedPanel).toBeVisible({ timeout: 30_000 });
    const quietAtStart = await waitForQuiescence({
      readSignature: () => readChatActivity(electronApp, page),
    });
    const sizedMessage = `[${sized.marker}] [Canopy-Mock-Request:${sized.requestTag}] Run the ${sized.size}-call active turn.`;
    const quietAtEnd = await recordStreamedReply(tasks, sized.taskKind, () =>
      recordTask(
        tasks,
        sized.taskKind,
        async () => {
          const composer = sizedPanel
            .locator('[data-chat-composer-root]')
            .getByRole('textbox')
            .first();
          await composer.fill(sizedMessage);
          await sizedPanel
            .getByRole('button', { name: 'Send message' })
            .click();
          await expect(
            sizedPanel.getByText(`${sized.marker} complete.`),
          ).toBeAttached({ timeout: toolActiveTurnTimeoutMs(sized.size) });
          await waitUntil(
            () => activeTurnCount(page).then((count) => count === 0),
            {
              timeoutMs: 60_000,
              label: `${sized.size}-call active turn to become idle`,
            },
          );
          const quiet = await waitForQuiescence({
            readSignature: () => readChatActivity(electronApp, page),
            quietMs: 250,
            timeoutMs: 30_000,
          });
          await nextPaint(page);
          return quiet;
        },
        { toolExchanges: sized.size },
      ),
    );
    const settled = quietAtStart && quietAtEnd;
    // recordTask just pushed this bracket's task.
    const task = tasks.at(-1);
    Object.assign(task, { quietAtStart, quietAtEnd, settled });
    sizedTurns.push({
      size: sized.size,
      quietAtStart,
      quietAtEnd,
      settled,
      durationMs: task.durationMs,
    });
  }
  return {
    ...fixture,
    sized: undefined,
    activeTurnSizes: (fixture.sized ?? []).map((sized) => sized.size),
    activeTurnToolCallsPerStep: TOOL_ACTIVE_TURN_BATCH,
    sizedTurns,
  };
}

async function sampleTranscriptRetention(page, electronApp, cycle) {
  const [renderer, processes] = await Promise.all([
    page.evaluate(() => ({
      jsHeapUsedBytes: performance.memory?.usedJSHeapSize ?? null,
      transcriptDomNodes: document.querySelectorAll(
        '[data-testid="chat-message-list-content"] *',
      ).length,
      transcriptStages: window.__CANOPY_TRANSCRIPT_PERF__?.stages ?? {},
      transcriptCounters: window.__CANOPY_TRANSCRIPT_PERF__?.counters ?? {},
    })),
    electronApp.evaluate(({ app }) => app.getAppMetrics()),
  ]);
  const normalized = normalizeAppMetrics(processes);
  return {
    cycle,
    ...renderer,
    aggregateWorkingSetMb:
      normalized.reduce((sum, process) => sum + process.workingSetSizeKb, 0) /
      1024,
    processCount: normalized.length,
    rendererWorkingSetMb:
      (normalized.find((process) => process.type === 'Tab')?.workingSetSizeKb ??
        0) / 1024,
  };
}

async function runTranscriptRetentionCycle({
  page,
  electronApp,
  config,
  tasks,
  fixture,
}) {
  await openMainPage(page);
  await openStressEntry(page);
  await recordResponsiveTask(
    tasks,
    'open_retention_fixture',
    () => openStressChat(page, fixture.turns),
    {},
    config.responsivenessBudgetMs,
  );
  const samples = [await sampleTranscriptRetention(page, electronApp, 0)];
  for (let cycle = 1; cycle <= config.transcriptRetentionCycles; cycle++) {
    await recordResponsiveTask(
      tasks,
      'retention_history_cycle',
      async () => {
        await inspectStressHistory(page);
        await page
          .getByTestId(`panel-tab-panel-chat-${fixture.leanId}`)
          .click();
        await expect(
          page.getByTestId(`panel-tab-panel-chat-${fixture.leanId}`),
        ).toHaveAttribute('aria-selected', 'true');
        await page
          .getByTestId(`panel-tab-panel-chat-${fixture.chatId}`)
          .click();
        await returnToLatestStressTurn(page, fixture);
      },
      { cycle },
      config.responsivenessBudgetMs,
    );
    samples.push(await sampleTranscriptRetention(page, electronApp, cycle));
  }
  return {
    ...fixture,
    retentionCycles: config.transcriptRetentionCycles,
    retentionSamples: samples,
  };
}

/**
 * Web Animations whose target left the document stay in the renderer's
 * document timeline while they loop, keeping the detached element alive.
 * `document.getAnimations()` never lists them and an animation's JS wrapper
 * can be collected while it runs, so only a heap snapshot counts them. The
 * count is taken by node name; no snapshot or string is kept.
 */
const PROJECTS_RELOAD_ANIMATION_GROWTH_CEILING = 10;

async function countRendererAnimations(page) {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('HeapProfiler.enable');
    await cdp.send('HeapProfiler.collectGarbage');
    const chunks = [];
    const onChunk = ({ chunk }) => chunks.push(chunk);
    cdp.on('HeapProfiler.addHeapSnapshotChunk', onChunk);
    await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
    cdp.off('HeapProfiler.addHeapSnapshotChunk', onChunk);
    const { snapshot, nodes, strings } = JSON.parse(chunks.join(''));
    const width = snapshot.meta.node_fields.length;
    const nameField = snapshot.meta.node_fields.indexOf('name');
    const counts = { Animation: 0, CSSAnimation: 0, CSSTransition: 0 };
    for (let index = nameField; index < nodes.length; index += width) {
      const name = strings[nodes[index]];
      if (Object.hasOwn(counts, name)) counts[name] += 1;
    }
    return counts;
  } finally {
    await cdp.detach();
  }
}

/** Stream R's reproduction: the default demo workspaces, a worktree each. */
function prepareProjectsReloadRetention(userDataDir) {
  return seedWorkspace(userDataDir, []);
}

/** Before the measured window: the loaded sidebar and its animation count. */
async function setupProjectsReloadRetention({ page, fixture }) {
  await openMainPage(page);
  await waitUntil(
    () => page.evaluate(() => Boolean(window.__canopyProjectsTestApi)),
    { timeoutMs: 30_000, label: 'the E2E projects test API' },
  );
  await expect(page.getByTestId('worktree-row').first()).toBeVisible({
    timeout: 30_000,
  });
  fixture.animationsBefore = await countRendererAnimations(page);
}

/**
 * Silent projects reloads (the path every worktree-file change takes) each
 * followed by a worktree row selection, as a user does between them.
 */
async function runProjectsReloadRetention({ page, config, tasks }) {
  const rows = page.getByTestId('worktree-row');
  const rowCount = await rows.count();
  await recordTask(
    tasks,
    'projects_reload_select_cycles',
    async () => {
      for (let cycle = 0; cycle < config.projectsReloadCycles; cycle++) {
        // Stream R's pacing: each reload and selection draws and settles
        // its loading skeletons before the next step.
        await page.evaluate(() =>
          window.__canopyProjectsTestApi.loadProjects(),
        );
        await page.waitForTimeout(250);
        await rows.nth(cycle % rowCount).click();
        await page.waitForTimeout(250);
      }
    },
    { cycles: config.projectsReloadCycles },
  );
  return {
    reloadCycles: config.projectsReloadCycles,
    worktreeRows: rowCount,
  };
}

/** After the measured window: fails when Web Animations accumulated. */
async function checkProjectsReloadRetention({ page, counters, fixture }) {
  // Loops on removed elements may outlive their element by a moment.
  await page.waitForTimeout(2_000);
  const before = fixture.animationsBefore;
  const after = await countRendererAnimations(page);
  const growth = after.Animation - before.Animation;
  counters.rendererAnimations = { before, after, growth };
  if (growth > PROJECTS_RELOAD_ANIMATION_GROWTH_CEILING) {
    throw new Error(
      `Web Animations grew by ${growth} over ${counters.reloadCycles} reload-and-select cycles (ceiling ${PROJECTS_RELOAD_ANIMATION_GROWTH_CEILING}): a looping animation outlives its element`,
    );
  }
}

async function registerPerformanceChatScenarios(config) {
  for (let index = 0; index < config.concurrentChats; index += 1) {
    const marker = `Canopy-CPERF${index + 1}`;
    const text = `Streaming performance reply ${index + 1}. `
      .repeat(Math.ceil(config.chatReplyCharacters / 32))
      .slice(0, config.chatReplyCharacters);
    const initialStep = {
      text,
      stopReason: 'end_turn',
      streamMs: config.chatStreamMs,
      chunkChars: 16,
    };
    const laterStep = {
      text: `Later foreground performance reply ${index + 1}.`,
      stopReason: 'end_turn',
      streamMs: Math.min(config.chatStreamMs, 1_000),
      chunkChars: 16,
    };
    await registerScenario(PERFORMANCE_MOCK_BASE_URL, marker, {
      llm: {
        steps: [initialStep, laterStep],
        stepsByRequestTag: {
          [`initial-${index + 1}`]: initialStep,
          [`later-${index + 1}`]: laterStep,
        },
      },
    });
  }
}

async function prepareChats(userDataDir, config) {
  seedWorkspace(userDataDir);
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [{ id: 'performance-chat-1', title: 'Performance Chat 1' }],
  });
  await registerPerformanceChatScenarios(config);
}

function seedMixedProviderAgentPreferences(userDataDir) {
  writeFileSync(
    path.join(userDataDir, 'preferences.json'),
    JSON.stringify(
      {
        version: 1,
        preferences: {
          onboardingCompleted: ['v1'],
          defaultWorktreeProvider: 'claude',
          defaultChatProvider: 'claude',
          codexMultiAgentWorktreeChatsEnabled: true,
        },
      },
      null,
      2,
    ),
    'utf8',
  );
}

function mixedProviderAgentDescriptors(config) {
  const subagentChats = Math.max(2, Math.floor(config.concurrentChats / 2));
  return Array.from({ length: config.concurrentChats }, (_, index) => {
    const providerType = index % 2 === 0 ? 'claude' : 'codex';
    return {
      id: `mixed-provider-agent-chat-${index + 1}`,
      title: `${providerType === 'claude' ? 'Claude' : 'Codex'} Active ${index + 1}`,
      providerType,
      marker: `Canopy-CMPERF${index + 1}`,
      childMarker: `Canopy-CMPERFSUB${index + 1}`,
      usesSubagent: index < subagentChats,
    };
  });
}

function performanceStreamingText(label, characters) {
  return `${label}. `
    .repeat(Math.ceil(characters / (label.length + 2)))
    .slice(0, characters);
}

export async function registerMixedProviderAgentScenarios(config, descriptors) {
  const streamMs =
    config.chatStreamMs + Math.max(15_000, config.concurrentChats * 1_000);
  for (const descriptor of descriptors) {
    const rootText = performanceStreamingText(
      `${descriptor.providerType} root stream ${descriptor.id}`,
      config.chatReplyCharacters,
    );
    const rootTextStep = {
      text: rootText,
      stopReason: 'end_turn',
      streamMs,
      chunkChars: 16,
    };
    const subagentToolStep = {
      toolCalls: [
        descriptor.providerType === 'claude'
          ? {
              name: 'Agent',
              input: {
                description: 'Profile concurrent stream',
                prompt: `[${descriptor.childMarker}] Stream the deterministic child workload and report when complete.`,
                subagent_type: 'general-purpose',
                run_in_background: true,
              },
            }
          : {
              namespace: 'collaboration',
              name: 'spawn_agent',
              input: {
                task_name: descriptor.childMarker
                  .replace('Canopy-', 'canopy_')
                  .toLowerCase(),
                message: `[${descriptor.childMarker}] Stream the deterministic child workload and report when complete.`,
                fork_turns: 'none',
              },
            },
      ],
      stopReason: 'tool_use',
    };
    const steps = descriptor.usesSubagent
      ? [subagentToolStep, rootTextStep]
      : [rootTextStep];
    await registerScenario(PERFORMANCE_MOCK_BASE_URL, descriptor.marker, {
      llm: {
        steps,
        // Codex app-server contributes synthetic assistant bootstrap items to
        // Responses requests. Advance this fixture only after its scripted
        // tool has a matching output so step zero remains the real call.
        ...(descriptor.providerType === 'codex'
          ? { openAiStepCursor: 'completed-scenario-tool-calls' }
          : {}),
      },
    });

    if (descriptor.usesSubagent) {
      await registerScenario(
        PERFORMANCE_MOCK_BASE_URL,
        descriptor.childMarker,
        {
          llm: {
            steps: [
              {
                text: performanceStreamingText(
                  `${descriptor.providerType} child stream ${descriptor.id}`,
                  config.chatReplyCharacters,
                ),
                stopReason: 'end_turn',
                // Keep the requested concurrent load, but finish before the
                // root's extra drain window. Equal deadlines can deliver a
                // Claude background result after its root has completed,
                // measuring another full continuation stream on some runs.
                streamMs: config.chatStreamMs,
                chunkChars: 16,
              },
            ],
          },
        },
      );
    }
  }
  return { streamMs };
}

async function prepareMixedProviderAgentConcurrency(userDataDir, config) {
  seedWorkspace(userDataDir);
  seedMixedProviderAgentPreferences(userDataDir);
  const descriptors = mixedProviderAgentDescriptors(config);
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    activeTabId: descriptors[0].id,
    tabs: descriptors.map((descriptor) => ({
      id: descriptor.id,
      title: descriptor.title,
      providerType: descriptor.providerType,
      // This deterministic benchmark intentionally exercises background agent
      // tools without stopping on an interactive approval prompt.
      approvalMode: 'full-access',
    })),
  });
  const { streamMs } = await registerMixedProviderAgentScenarios(
    config,
    descriptors,
  );
  return { descriptors, streamMs };
}

async function installMixedProviderAgentEventMonitor(page, descriptors) {
  await page.evaluate(
    ({ workspaceId, worktreeId, chatIds }) => {
      const previous = window.__CANOPY_MIXED_PROVIDER_AGENT_PERF__;
      previous?.dispose?.();
      const selectedChatIds = new Set(chatIds);
      const state = {
        totalEvents: 0,
        eventsByChat: {},
        claudeAgentToolUses: 0,
        claudeTaskStarted: 0,
        claudeTaskProgress: 0,
        claudeTaskNotifications: 0,
        claudeBackgroundTaskSnapshots: 0,
        activeClaudeTaskIds: {},
        codexSpawnStarted: 0,
        codexSpawnUpdated: 0,
        codexSpawnCompleted: 0,
        codexSubagentThreads: 0,
        allCodexSubagentThreads: 0,
        codexSubagentThreadsByChat: {},
        codexChildAgentMessages: 0,
        codexChildAgentOrigins: {},
        codexChildAgentMessagesByChat: {},
        codexChildAgentRouteMismatches: 0,
        codexEventTypes: {},
        codexItemTypes: {},
      };
      const readString = (value, key) =>
        value && typeof value === 'object' && typeof value[key] === 'string'
          ? value[key]
          : undefined;
      const unsubscribe = window.api.chat.onChatEvent((envelope) => {
        if (
          envelope.projectId !== workspaceId ||
          envelope.worktreeId !== worktreeId
        ) {
          return;
        }
        const data = envelope.data;
        const codexEvent =
          data && typeof data === 'object' && data.type === 'codex'
            ? data.event
            : undefined;
        if (
          codexEvent &&
          typeof codexEvent === 'object' &&
          codexEvent.type === 'thread.started' &&
          /subagent|subAgent/i.test(JSON.stringify(codexEvent.source ?? ''))
        ) {
          state.allCodexSubagentThreads += 1;
          state.codexSubagentThreadsByChat[envelope.chatId] =
            (state.codexSubagentThreadsByChat[envelope.chatId] ?? 0) + 1;
          if (selectedChatIds.has(envelope.chatId)) {
            state.codexSubagentThreads += 1;
          }
        }
        if (!selectedChatIds.has(envelope.chatId)) return;
        state.totalEvents += 1;
        state.eventsByChat[envelope.chatId] =
          (state.eventsByChat[envelope.chatId] ?? 0) + 1;
        if (!data || typeof data !== 'object') return;
        if (data.type === 'assistant') {
          const message =
            data.message && typeof data.message === 'object'
              ? data.message
              : undefined;
          const content = Array.isArray(message?.content)
            ? message.content
            : [];
          state.claudeAgentToolUses += content.filter(
            (block) =>
              block &&
              typeof block === 'object' &&
              block.type === 'tool_use' &&
              block.name === 'Agent',
          ).length;
          return;
        }
        if (data.type === 'system') {
          const subtype = readString(data, 'subtype');
          const taskId = readString(data, 'task_id');
          if (subtype === 'task_started') {
            state.claudeTaskStarted += 1;
            if (taskId) state.activeClaudeTaskIds[taskId] = true;
          } else if (subtype === 'task_progress') {
            state.claudeTaskProgress += 1;
          } else if (subtype === 'task_notification') {
            state.claudeTaskNotifications += 1;
            if (taskId) delete state.activeClaudeTaskIds[taskId];
          } else if (subtype === 'background_tasks_changed') {
            state.claudeBackgroundTaskSnapshots += 1;
          }
          return;
        }
        if (data.type !== 'codex') return;
        const event =
          data.event && typeof data.event === 'object' ? data.event : undefined;
        if (!event) return;
        const eventType = readString(event, 'type') ?? 'unknown';
        state.codexEventTypes[eventType] =
          (state.codexEventTypes[eventType] ?? 0) + 1;
        if (event.type === 'thread.started') {
          return;
        }
        const item =
          event.item && typeof event.item === 'object' ? event.item : undefined;
        if (item) {
          const itemType = readString(item, 'type') ?? 'unknown';
          state.codexItemTypes[itemType] =
            (state.codexItemTypes[itemType] ?? 0) + 1;
        }
        if (
          event.type === 'item.completed' &&
          item?.type === 'agent_message' &&
          typeof item.text === 'string'
        ) {
          const originChatId =
            /codex child stream (mixed-provider-agent-chat-\d+)/i.exec(
              item.text,
            )?.[1];
          if (originChatId) {
            state.codexChildAgentMessages += 1;
            state.codexChildAgentOrigins[originChatId] = true;
            state.codexChildAgentMessagesByChat[envelope.chatId] =
              (state.codexChildAgentMessagesByChat[envelope.chatId] ?? 0) + 1;
            if (originChatId !== envelope.chatId) {
              state.codexChildAgentRouteMismatches += 1;
            }
          }
        }
        if (
          item?.type !== 'collab_agent_tool_call' ||
          item.tool !== 'spawnAgent'
        ) {
          return;
        }
        if (event.type === 'item.started') state.codexSpawnStarted += 1;
        if (event.type === 'item.updated') state.codexSpawnUpdated += 1;
        if (event.type === 'item.completed') state.codexSpawnCompleted += 1;
      });
      window.__CANOPY_MIXED_PROVIDER_AGENT_PERF__ = {
        state,
        dispose: unsubscribe,
      };
    },
    {
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      chatIds: descriptors.map((descriptor) => descriptor.id),
    },
  );
}

async function mixedProviderAgentEventSnapshot(page) {
  return page.evaluate(() => {
    const state = window.__CANOPY_MIXED_PROVIDER_AGENT_PERF__?.state;
    if (!state)
      throw new Error('Mixed-provider event monitor is not installed');
    return {
      ...state,
      eventsByChat: { ...state.eventsByChat },
      codexSubagentThreadsByChat: { ...state.codexSubagentThreadsByChat },
      codexChildAgentMessagesByChat: {
        ...state.codexChildAgentMessagesByChat,
      },
      codexEventTypes: { ...state.codexEventTypes },
      codexItemTypes: { ...state.codexItemTypes },
      codexChildAgentOrigins: { ...state.codexChildAgentOrigins },
      activeClaudeTaskCount: Object.keys(state.activeClaudeTaskIds).length,
      activeClaudeTaskIds: undefined,
    };
  });
}

export function mixedProviderWorkCompleted(
  turns,
  events,
  expectedCodexChildCompletions,
) {
  const observedDistinctCodexChildren = Object.keys(
    events.codexChildAgentOrigins,
  ).length;
  return (
    turns.total === 0 &&
    events.activeClaudeTaskCount === 0 &&
    observedDistinctCodexChildren >= expectedCodexChildCompletions &&
    events.codexChildAgentMessages >= expectedCodexChildCompletions
  );
}

export function codexRootsCompletedWithoutSpawn(events, expectedCodexTurns) {
  return (
    (events.codexEventTypes['turn.completed'] ?? 0) >= expectedCodexTurns &&
    events.codexSpawnStarted === 0 &&
    events.codexSubagentThreads === 0
  );
}

async function activeTurnSnapshot(page) {
  return page.evaluate(
    async ({ workspaceId, worktreeId }) => {
      const result = await window.api.chat.activeSessions({
        projectId: workspaceId,
        worktreeId,
      });
      const sessions = result.sessions ?? [];
      const active = sessions.filter((session) => session.turnActive);
      return {
        total: active.length,
        claude: active.filter((session) => session.providerType === 'claude')
          .length,
        codex: active.filter((session) => session.providerType === 'codex')
          .length,
        chatIds: active.map((session) => session.chatId),
      };
    },
    { workspaceId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
  );
}

async function startMixedProviderAgentChats({ page, fixture, tasks }) {
  const panel = visibleChatPanel(page);
  await expect(panel).toBeVisible();
  let peak = { total: 0, claude: 0, codex: 0 };
  for (let index = 0; index < fixture.descriptors.length; index += 1) {
    const descriptor = fixture.descriptors[index];
    const expectedChatIds = fixture.descriptors
      .slice(0, index + 1)
      .map((candidate) => candidate.id);
    await recordTask(
      tasks,
      'start_mixed_provider_agent_turn',
      async () => {
        const tab = page.getByTestId(`panel-tab-panel-chat-${descriptor.id}`);
        await tab.click();
        await expect(tab).toHaveAttribute('aria-selected', 'true');
        const userMessage = `[${descriptor.marker}] Run ${descriptor.providerType} concurrent workload ${index + 1}${descriptor.usesSubagent ? ' with a background subagent' : ''}.`;
        const composer = panel
          .locator('[data-chat-composer-root]')
          .getByRole('textbox')
          .first();
        await composer.fill(userMessage);
        await panel.getByRole('button', { name: 'Send message' }).click();
        await expect(panel.getByText(userMessage).first()).toBeVisible({
          timeout: 30_000,
        });
        await waitUntil(
          async () => {
            const snapshot = await activeTurnSnapshot(page);
            return expectedChatIds.every((chatId) =>
              snapshot.chatIds.includes(chatId),
            );
          },
          {
            timeoutMs: 60_000,
            label: `${index + 1} mixed-provider chat turn(s) to overlap`,
          },
        );
      },
      {
        chat: index + 1,
        providerType: descriptor.providerType,
        usesSubagent: descriptor.usesSubagent,
      },
    );
    const snapshot = await activeTurnSnapshot(page);
    if (snapshot.total > peak.total) {
      peak = {
        total: snapshot.total,
        claude: snapshot.claude,
        codex: snapshot.codex,
      };
    }
  }
  return peak;
}

async function verifyMixedProviderAgentCards(page, descriptors, tasks) {
  for (const providerType of ['claude']) {
    const descriptor = descriptors.find(
      (candidate) =>
        candidate.providerType === providerType && candidate.usesSubagent,
    );
    if (!descriptor) continue;
    await recordTask(
      tasks,
      'verify_mixed_provider_agent_card',
      async () => {
        const tab = page.getByTestId(`panel-tab-panel-chat-${descriptor.id}`);
        await tab.click();
        await expect(tab).toHaveAttribute('aria-selected', 'true');
        // Every step on its own row, so the helper agent is not folded into
        // a "Ran …" line. The clean step row has no background badge.
        await page.evaluate(() =>
          window.api.savePreferences({ chatDetail: 'detailed' }),
        );
        const panel = visibleChatPanel(page);
        await expect(panel.getByTestId('agent-block').first()).toBeVisible({
          timeout: 60_000,
        });
      },
      { providerType, chatId: descriptor.id },
    );
  }
}

async function runMixedProviderAgentConcurrency({
  page,
  app,
  config,
  tasks,
  fixture,
}) {
  await openMainPage(page);
  await app.selectWorktree(WORKTREE_BRANCH, NO_ACTIVITY_RAIL);
  await installMixedProviderAgentEventMonitor(page, fixture.descriptors);
  const peak = await startMixedProviderAgentChats({ page, fixture, tasks });
  const expectedClaudeTurns = fixture.descriptors.filter(
    (descriptor) => descriptor.providerType === 'claude',
  ).length;
  const expectedCodexTurns = fixture.descriptors.length - expectedClaudeTurns;
  if (
    peak.total !== fixture.descriptors.length ||
    peak.claude !== expectedClaudeTurns ||
    peak.codex !== expectedCodexTurns
  ) {
    throw new Error(
      `Mixed-provider overlap was incomplete (total=${peak.total}/${fixture.descriptors.length}, Claude=${peak.claude}/${expectedClaudeTurns}, Codex=${peak.codex}/${expectedCodexTurns})`,
    );
  }

  const expectedClaudeTasks = fixture.descriptors.filter(
    (descriptor) =>
      descriptor.providerType === 'claude' && descriptor.usesSubagent,
  ).length;
  const expectedCodexSpawns = fixture.descriptors.filter(
    (descriptor) =>
      descriptor.providerType === 'codex' && descriptor.usesSubagent,
  ).length;
  await recordTask(tasks, 'mixed_provider_agent_load_started', async () => {
    let lastSnapshot;
    try {
      await waitUntil(
        async () => {
          lastSnapshot = await mixedProviderAgentEventSnapshot(page);
          return (
            lastSnapshot.claudeAgentToolUses >= expectedClaudeTasks &&
            lastSnapshot.claudeTaskStarted >= expectedClaudeTasks
          );
        },
        {
          timeoutMs: fixture.streamMs + 120_000,
          label: `${expectedClaudeTasks} Claude background task(s) to start while ${expectedCodexSpawns} Codex subagent spawn(s) are in flight`,
          intervalMs: 250,
        },
      );
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; observed=${JSON.stringify(lastSnapshot)}`,
      );
    }
  });
  await verifyMixedProviderAgentCards(page, fixture.descriptors, tasks);

  const probeTabId = await createResponsivenessChat(page, tasks);
  let interactionsWithActiveTurns = 0;
  let interactionsWithClaudeBackgroundTasks = 0;
  for (let index = 0; index < config.interactionIterations; index += 1) {
    const turns = await activeTurnSnapshot(page);
    const events = await mixedProviderAgentEventSnapshot(page);
    if (turns.total > 0) interactionsWithActiveTurns += 1;
    if (events.activeClaudeTaskCount > 0) {
      interactionsWithClaudeBackgroundTasks += 1;
    }
    await recordResponsiveTask(
      tasks,
      'type_during_mixed_provider_agent_load',
      () =>
        typeDraftAndWaitForPaint(page, {
          scenario: 'mixed-provider-agent-load',
          iteration: index + 1,
          characters: config.typingCharacters,
        }),
      {
        iteration: index + 1,
        characters: config.typingCharacters,
        activeTurns: turns.total,
        activeClaudeTasks: events.activeClaudeTaskCount,
      },
      config.responsivenessBudgetMs,
    );
    await recordResponsiveTask(
      tasks,
      'navigate_during_mixed_provider_agent_load',
      async () => {
        const live = fixture.descriptors[index % fixture.descriptors.length];
        const liveTab = page.getByTestId(`panel-tab-panel-chat-${live.id}`);
        await liveTab.click();
        await expect(liveTab).toHaveAttribute('aria-selected', 'true');
        await nextPaint(page);
        await openPipelinesPage(page);
        await app.selectWorktree(WORKTREE_BRANCH, NO_ACTIVITY_RAIL);
        const probeTab = page.getByTestId(probeTabId);
        await probeTab.click();
        await expect(probeTab).toHaveAttribute('aria-selected', 'true');
        await nextPaint(page);
      },
      {
        iteration: index + 1,
        activeTurns: turns.total,
        activeClaudeTasks: events.activeClaudeTaskCount,
      },
      config.responsivenessBudgetMs,
    );
  }
  if (interactionsWithActiveTurns === 0) {
    throw new Error(
      'Mixed-provider turns completed before any responsiveness interaction ran',
    );
  }
  if (expectedClaudeTasks > 0 && interactionsWithClaudeBackgroundTasks === 0) {
    throw new Error(
      'Claude background-agent streaming completed before any responsiveness interaction ran',
    );
  }

  const expectedCodexChildCompletions = expectedCodexSpawns;

  for (let index = 0; index < fixture.descriptors.length; index += 1) {
    const descriptor = fixture.descriptors[index];
    await recordTask(
      tasks,
      'switch_mixed_provider_agent_chat',
      async () => {
        const tab = page.getByTestId(`panel-tab-panel-chat-${descriptor.id}`);
        await tab.click();
        await expect(tab).toHaveAttribute('aria-selected', 'true');
        await nextPaint(page);
      },
      {
        chat: index + 1,
        providerType: descriptor.providerType,
        usesSubagent: descriptor.usesSubagent,
      },
    );
  }

  await recordTask(
    tasks,
    'all_mixed_provider_agent_work_complete',
    async () => {
      let lastEvents;
      let rootsCompletedWithoutSpawn = false;
      try {
        await waitUntil(
          async () => {
            const turns = await activeTurnSnapshot(page);
            lastEvents = await mixedProviderAgentEventSnapshot(page);
            if (
              expectedCodexChildCompletions > 0 &&
              codexRootsCompletedWithoutSpawn(lastEvents, expectedCodexTurns)
            ) {
              rootsCompletedWithoutSpawn = true;
              return true;
            }
            return mixedProviderWorkCompleted(
              turns,
              lastEvents,
              expectedCodexChildCompletions,
            );
          },
          {
            timeoutMs: fixture.streamMs + 180_000,
            label: `all mixed-provider turns, Claude background agents, and ${expectedCodexChildCompletions} Codex child agent(s) to complete`,
            intervalMs: 250,
          },
        );
        if (rootsCompletedWithoutSpawn) {
          throw new Error(
            'Codex root turns completed without emitting a subagent spawn',
          );
        }
      } catch (error) {
        const codexMockActivity = Object.fromEntries(
          await Promise.all(
            fixture.descriptors
              .filter((descriptor) => descriptor.providerType === 'codex')
              .map(async (descriptor) => [
                descriptor.id,
                (
                  await getScenarioActivity(
                    PERFORMANCE_MOCK_BASE_URL,
                    descriptor.marker,
                  )
                ).activity,
              ]),
          ),
        );
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; observed=${JSON.stringify(lastEvents)}; codexMockActivity=${JSON.stringify(codexMockActivity)}`,
        );
      }
    },
  );

  const events = await mixedProviderAgentEventSnapshot(page);
  await page.evaluate(() => {
    window.__CANOPY_MIXED_PROVIDER_AGENT_PERF__?.dispose?.();
  });
  const codexSubagentThreadRouting = assessCodexSubagentThreadRouting(
    fixture.descriptors,
    events.codexSubagentThreadsByChat,
  );
  const observedDistinctCodexChildren = Object.keys(
    events.codexChildAgentOrigins,
  ).length;
  if (
    expectedCodexSpawns > 0 &&
    observedDistinctCodexChildren < expectedCodexSpawns
  ) {
    throw new Error(
      `Codex child workloads did not all run (native threads=${events.codexSubagentThreads}/${expectedCodexSpawns}, distinct children=${observedDistinctCodexChildren}/${expectedCodexSpawns}, child messages=${events.codexChildAgentMessages})`,
    );
  }
  if (
    expectedCodexSpawns > 0 &&
    (!codexSubagentThreadRouting.passed ||
      events.codexChildAgentRouteMismatches > 0)
  ) {
    throw new Error(
      `Codex subagent routing was incomplete (native threads=${events.codexSubagentThreads}/${expectedCodexSpawns}, child messages=${events.codexChildAgentMessages}/${expectedCodexSpawns}, route mismatches=${events.codexChildAgentRouteMismatches}); threadViolations=${JSON.stringify(codexSubagentThreadRouting.violations)}; threadsByChat=${JSON.stringify(events.codexSubagentThreadsByChat)}; messagesByChat=${JSON.stringify(events.codexChildAgentMessagesByChat)}`,
    );
  }
  return {
    requestedConcurrentTurns: fixture.descriptors.length,
    requestedClaudeTurns: expectedClaudeTurns,
    requestedCodexTurns: expectedCodexTurns,
    requestedClaudeBackgroundAgents: expectedClaudeTasks,
    requestedCodexSubagents: expectedCodexSpawns,
    peakConcurrentTurns: peak.total,
    peakConcurrentClaudeTurns: peak.claude,
    peakConcurrentCodexTurns: peak.codex,
    interactionsWithActiveTurns,
    interactionsWithClaudeBackgroundTasks,
    streamedRootCharacters:
      fixture.descriptors.length * config.chatReplyCharacters,
    streamedChildCharacters:
      (expectedClaudeTasks + expectedCodexSpawns) * config.chatReplyCharacters,
    observedChatEvents: events.totalEvents,
    observedClaudeAgentToolUses: events.claudeAgentToolUses,
    observedClaudeTaskStarted: events.claudeTaskStarted,
    observedClaudeTaskProgress: events.claudeTaskProgress,
    observedClaudeTaskNotifications: events.claudeTaskNotifications,
    observedClaudeBackgroundTaskSnapshots: events.claudeBackgroundTaskSnapshots,
    observedCodexSpawnStarted: events.codexSpawnStarted,
    observedCodexSpawnUpdated: events.codexSpawnUpdated,
    observedCodexSpawnCompleted: events.codexSpawnCompleted,
    observedCodexSubagentThreads: events.codexSubagentThreads,
    observedAllCodexSubagentThreads: events.allCodexSubagentThreads,
    observedCodexSubagentThreadsByChat: events.codexSubagentThreadsByChat,
    observedCodexChildAgentMessages: events.codexChildAgentMessages,
    observedDistinctCodexChildAgents: observedDistinctCodexChildren,
    observedCodexChildAgentMessagesByChat: events.codexChildAgentMessagesByChat,
    observedCodexChildAgentRouteMismatches:
      events.codexChildAgentRouteMismatches,
  };
}

// ── Managed delegation concurrency ─────────────────────────────────────────
//
// Two Claude and two Codex parent chats in one worktree, each seeded with a
// large committed transcript, each delegate three background tasks through
// Canopy's managed delegation tools (one of them on the other harness). As
// the orchestrators of the 2026-10-06 field load did, each parent streams
// briefly and ends its turn while its delegates keep running, so delegate
// progress arrives for cards in committed history
// (docs/planning/2026-10-06-delegation-transcripts-and-commit-load). Every
// delegate reads a worktree file once per step and streams a little text,
// which yields one delegate snapshot per item. Typing and navigation probes
// run while delegates are live, then the Claude parents open a settled
// delegate's card, which reads the delegate's child transcript.
//
// Provider binaries, managed delegation, chat storage and rendering run
// through production paths; only inference is scripted (the shared mock LLM).

const MANAGED_DELEGATION_PARENTS = 4;
const MANAGED_DELEGATION_DELEGATES_PER_PARENT = 3;
const MANAGED_DELEGATION_EVIDENCE_FILE = 'delegation-load-evidence.txt';
const MANAGED_DELEGATION_SETTLED = new Set([
  'completed',
  'failed',
  'cancelled',
  'deadline_exceeded',
  'interrupted',
]);

// Canopy's injected tools take the built brand's namespace, such as
// `mcp__canopy__DelegateTask` and `canopy_spawn_delegate`. The namespace is
// read from the generated brand JSON on first use: Electron specs import this
// module, and Playwright cannot load the generated `desktop-brand.ts` module.
let toolNamespace = null;
function currentBrandToolNamespace() {
  if (toolNamespace !== null) return toolNamespace;
  const brandCache = path.join(PERF_REPO_ROOT, '.cache/brand');
  const indirection = readFileSync(
    path.join(brandCache, 'current/desktop-brand.ts'),
    'utf8',
  );
  const brandId = /from '\.\.\/([^/']+)\/desktop-brand'/.exec(indirection)?.[1];
  if (!brandId) {
    throw new Error('Could not resolve the current brand; run brand:prepare.');
  }
  const brand = JSON.parse(
    readFileSync(path.join(brandCache, brandId, 'current-brand.json'), 'utf8'),
  );
  toolNamespace = brand.tools.namespace;
  return toolNamespace;
}
const claudeToolName = (name) => `mcp__${currentBrandToolNamespace()}__${name}`;
const codexToolName = (name) => `${currentBrandToolNamespace()}_${name}`;

function otherHarness(harness) {
  return harness === 'claude' ? 'codex' : 'claude';
}

export function managedDelegationDescriptors() {
  return Array.from({ length: MANAGED_DELEGATION_PARENTS }, (_, index) => {
    const providerType = index % 2 === 0 ? 'claude' : 'codex';
    const ordinal = index + 1;
    return {
      id: `managed-delegation-parent-${ordinal}`,
      title: `${providerType === 'claude' ? 'Claude' : 'Codex'} Delegating ${ordinal}`,
      providerType,
      marker: `Canopy-CMDPERF${ordinal}`,
      delegates: Array.from(
        { length: MANAGED_DELEGATION_DELEGATES_PER_PARENT },
        (__, delegateIndex) => {
          const harness =
            delegateIndex === 1 ? otherHarness(providerType) : providerType;
          return {
            marker: `Canopy-CMDPERF${ordinal}D${delegateIndex + 1}`,
            harness,
            model: harness === 'claude' ? 'sonnet' : 'gpt-6.1-sol',
            // Codex's `spawn_delegate` takes a task name, which its card
            // shows in place of a description.
            description:
              providerType === 'claude'
                ? `Load review ${ordinal}.${delegateIndex + 1}`
                : `load_review_${ordinal}_${delegateIndex + 1}`,
          };
        },
      ),
    };
  });
}

/** The text a delegate streams before its read in step `step` (1-based). */
export function managedDelegationStepText(marker, step) {
  return `Checking ${marker} part ${step}.`;
}

/**
 * The mock LLM scripts for every parent and delegate, by marker. Pure, so the
 * workload's shape is testable without a launch.
 */
export function managedDelegationScripts(config, descriptors, evidencePath) {
  const scripts = {};
  for (const descriptor of descriptors) {
    const spawn = {
      toolCalls: descriptor.delegates.map((delegate, index) => {
        const prompt = `[${delegate.marker}] Read ${MANAGED_DELEGATION_EVIDENCE_FILE} ${config.managedDelegationChildSteps} times and report what changed. Scope: inspection only, no modifications.`;
        return descriptor.providerType === 'claude'
          ? {
              id: `${descriptor.marker}-spawn-${index + 1}`,
              name: claudeToolName('DelegateTask'),
              input: {
                model: delegate.model,
                description: delegate.description,
                prompt,
                run_in_background: true,
              },
            }
          : {
              name: codexToolName('spawn_delegate'),
              input: {
                model: delegate.model,
                task_name: delegate.description,
                message: prompt,
                execution_mode: 'background',
              },
            };
      }),
      stopReason: 'tool_use',
    };
    // The parent works for about two delegate steps and ends its turn while
    // its delegates keep running; a delegate result that wakes it gets a
    // short reply (a Codex parent repeats this step).
    const work = {
      text: performanceStreamingText(
        `${descriptor.providerType} parent keeps working ${descriptor.id}`,
        config.chatReplyCharacters,
      ),
      stopReason: 'end_turn',
      streamMs: config.managedDelegationChildStepMs * 2,
      chunkChars: 16,
    };
    const integrate = {
      text: `Integrated the delegated findings for ${descriptor.marker}.`,
      stopReason: 'end_turn',
    };
    scripts[descriptor.marker] = {
      llm: {
        steps:
          descriptor.providerType === 'claude'
            ? [spawn, work, integrate]
            : [spawn, work],
        ...(descriptor.providerType === 'codex'
          ? { openAiStepCursor: 'completed-scenario-tool-calls' }
          : {}),
      },
    };
    for (const delegate of descriptor.delegates) {
      const steps = Array.from(
        { length: config.managedDelegationChildSteps },
        (_, index) => ({
          text: managedDelegationStepText(delegate.marker, index + 1),
          streamMs: config.managedDelegationChildStepMs,
          chunkChars: 8,
          toolCalls: [
            delegate.harness === 'claude'
              ? {
                  id: `${delegate.marker}-read-${index + 1}`,
                  name: 'Read',
                  input: { file_path: evidencePath },
                }
              : {
                  namespace: 'functions',
                  name: 'exec_command',
                  input: { cmd: `cat '${evidencePath}'` },
                },
          ],
          stopReason: 'tool_use',
        }),
      );
      steps.push({
        text: performanceStreamingText(
          `Finding for ${delegate.marker}`,
          config.chatReplyCharacters,
        ),
        stopReason: 'end_turn',
        streamMs: config.managedDelegationChildStepMs,
        chunkChars: 16,
      });
      scripts[delegate.marker] = {
        llm: {
          steps,
          ...(delegate.harness === 'codex'
            ? { openAiStepCursor: 'completed-scenario-tool-calls' }
            : {}),
        },
      };
    }
  }
  return scripts;
}

async function prepareManagedDelegationConcurrency(userDataDir, config) {
  const seed = seedWorkspace(userDataDir);
  const worktreePath = seed.workspaces?.find(
    (workspace) => workspace.id === WORKSPACE_ID,
  )?.worktreePath;
  if (!worktreePath) throw new Error('Missing the seeded demo worktree path');
  const evidencePath = path.join(
    worktreePath,
    MANAGED_DELEGATION_EVIDENCE_FILE,
  );
  writeFileSync(
    evidencePath,
    syntheticText('Delegation load evidence', 4 * 1024),
    'utf8',
  );
  writeFileSync(
    path.join(userDataDir, 'preferences.json'),
    JSON.stringify(
      {
        version: 1,
        preferences: {
          onboardingCompleted: ['v1'],
          managedDelegationMode: 'explicit-only',
          defaultChatInterfaceMode: 'canopy',
          defaultWorktreeProvider: 'claude',
          defaultChatProvider: 'claude',
          codexMultiAgentWorktreeChatsEnabled: false,
          // Pin the background summary helper to the mock, as the
          // large-transcript concurrency fixture does.
          summaryModel: 'claude-haiku-4-5-20251001',
          summaryModelSetByUser: true,
        },
      },
      null,
      2,
    ),
    'utf8',
  );
  const descriptors = managedDelegationDescriptors();
  const messageBytes = 4 * 1024;
  const messageCount = Math.max(
    2,
    Math.ceil(config.managedDelegationTranscriptBytes / messageBytes),
  );
  const seeded = seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    activeTabId: descriptors[0].id,
    tabs: descriptors.map((descriptor) => ({
      id: descriptor.id,
      title: descriptor.title,
      providerType: descriptor.providerType,
      // Deterministic: delegates read without stopping on an approval.
      approvalMode: 'full-access',
      createdAt: '2026-07-01T12:00:00.000Z',
      messages: buildSyntheticTranscriptMessages({
        transcriptId: descriptor.id,
        messageCount,
        messageBytes,
        shape: 'rich',
      }),
    })),
  });
  const scripts = managedDelegationScripts(config, descriptors, evidencePath);
  for (const [marker, script] of Object.entries(scripts))
    await registerScenario(PERFORMANCE_MOCK_BASE_URL, marker, script);
  return {
    descriptors,
    seededChatFileBytes: statSync(seeded.filePath).size,
  };
}

async function installManagedDelegationMonitor(page) {
  await page.evaluate(
    ({ workspaceId, worktreeId, settled }) => {
      window.__CANOPY_MANAGED_DELEGATION_PERF__?.dispose?.();
      const settledStatuses = new Set(settled);
      const state = {
        events: 0,
        eventsByChat: {},
        runs: {},
      };
      const unsubscribe = window.api.chat.onChatEvent((envelope) => {
        if (
          envelope.projectId !== workspaceId ||
          envelope.worktreeId !== worktreeId
        )
          return;
        const data = envelope.data;
        if (!data || typeof data !== 'object') return;
        if (data.type !== 'canopy_delegation') return;
        const delegation = data.delegation;
        if (!delegation || typeof delegation !== 'object') return;
        state.events += 1;
        state.eventsByChat[envelope.chatId] =
          (state.eventsByChat[envelope.chatId] ?? 0) + 1;
        const key = `${delegation.delegationId}:${delegation.runGeneration}`;
        const previous = state.runs[key];
        const status = delegation.snapshot?.status ?? 'unknown';
        if (previous && previous.sequence > delegation.sequence) return;
        state.runs[key] = {
          chatId: envelope.chatId,
          sequence: delegation.sequence,
          status,
          settled: settledStatuses.has(status),
        };
      });
      window.__CANOPY_MANAGED_DELEGATION_PERF__ = {
        state,
        dispose: unsubscribe,
      };
    },
    {
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      settled: [...MANAGED_DELEGATION_SETTLED],
    },
  );
}

async function managedDelegationSnapshot(page) {
  return page.evaluate(() => {
    const state = window.__CANOPY_MANAGED_DELEGATION_PERF__?.state;
    if (!state)
      throw new Error('Managed delegation event monitor is not installed');
    const runs = Object.values(state.runs);
    const statuses = {};
    for (const run of runs)
      statuses[run.status] = (statuses[run.status] ?? 0) + 1;
    return {
      events: state.events,
      eventsByChat: { ...state.eventsByChat },
      runs: runs.length,
      running: runs.filter((run) => !run.settled).length,
      settled: runs.filter((run) => run.settled).length,
      statuses,
    };
  });
}

async function runManagedDelegationConcurrency({
  page,
  app,
  config,
  tasks,
  fixture,
}) {
  const expectedRuns =
    fixture.descriptors.length * MANAGED_DELEGATION_DELEGATES_PER_PARENT;
  const childRunMs =
    config.managedDelegationChildSteps * config.managedDelegationChildStepMs;
  await openMainPage(page);
  await app.selectWorktree(WORKTREE_BRANCH, NO_ACTIVITY_RAIL);
  await installManagedDelegationMonitor(page);
  const panel = visibleChatPanel(page);
  for (const descriptor of fixture.descriptors) {
    await recordTask(
      tasks,
      'start_delegating_parent_turn',
      async () => {
        const tab = page.getByTestId(`panel-tab-panel-chat-${descriptor.id}`);
        await tab.click();
        await expect(tab).toHaveAttribute('aria-selected', 'true');
        const userMessage = `[${descriptor.marker}] Delegate three background load reviews and keep working while they run.`;
        const composer = panel
          .locator('[data-chat-composer-root]')
          .getByRole('textbox')
          .first();
        await composer.fill(userMessage);
        await panel.getByRole('button', { name: 'Send message' }).click();
        await expect(panel.getByText(userMessage).first()).toBeVisible({
          timeout: 30_000,
        });
      },
      { providerType: descriptor.providerType, chatId: descriptor.id },
    );
  }

  await recordTask(tasks, 'managed_delegates_started', async () => {
    let last;
    try {
      await waitUntil(
        async () => {
          last = await managedDelegationSnapshot(page);
          return last.runs >= expectedRuns;
        },
        {
          timeoutMs: 120_000,
          label: `${expectedRuns} managed delegates to start`,
          intervalMs: 250,
        },
      );
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; observed=${JSON.stringify(last)}`,
      );
    }
  });

  const probeTabId = await createResponsivenessChat(page, tasks);
  let interactionsWithRunningDelegates = 0;
  for (let index = 0; index < config.interactionIterations; index += 1) {
    const before = await managedDelegationSnapshot(page);
    if (before.running > 0) interactionsWithRunningDelegates += 1;
    await recordResponsiveTask(
      tasks,
      'type_during_managed_delegation_load',
      () =>
        typeDraftAndWaitForPaint(page, {
          scenario: 'managed-delegation-load',
          iteration: index + 1,
          characters: config.typingCharacters,
        }),
      {
        iteration: index + 1,
        characters: config.typingCharacters,
        runningDelegates: before.running,
      },
      config.responsivenessBudgetMs,
    );
    await recordResponsiveTask(
      tasks,
      'navigate_during_managed_delegation_load',
      async () => {
        const parent = fixture.descriptors[index % fixture.descriptors.length];
        const parentTab = page.getByTestId(`panel-tab-panel-chat-${parent.id}`);
        await parentTab.click();
        await expect(parentTab).toHaveAttribute('aria-selected', 'true');
        await nextPaint(page);
        const probeTab = page.getByTestId(probeTabId);
        await probeTab.click();
        await expect(probeTab).toHaveAttribute('aria-selected', 'true');
        await nextPaint(page);
      },
      { iteration: index + 1, runningDelegates: before.running },
      config.responsivenessBudgetMs,
    );
  }
  if (interactionsWithRunningDelegates === 0) {
    throw new Error(
      'Every managed delegate settled before any responsiveness interaction ran',
    );
  }

  let settled;
  await recordTask(tasks, 'managed_delegates_settled', async () => {
    try {
      await waitUntil(
        async () => {
          settled = await managedDelegationSnapshot(page);
          return settled.settled >= expectedRuns;
        },
        {
          timeoutMs: childRunMs * 4 + 180_000,
          label: `${expectedRuns} managed delegates to settle`,
          intervalMs: 250,
        },
      );
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; observed=${JSON.stringify(settled)}`,
      );
    }
  });
  if ((settled?.statuses.completed ?? 0) !== expectedRuns) {
    throw new Error(
      `Managed delegates did not all complete: ${JSON.stringify(settled?.statuses)}`,
    );
  }

  await recordTask(tasks, 'delegating_parents_idle', async () => {
    let idleSamples = 0;
    await waitUntil(
      async () => {
        const turns = await activeTurnSnapshot(page);
        idleSamples = turns.total === 0 ? idleSamples + 1 : 0;
        return idleSamples >= 3;
      },
      {
        timeoutMs: childRunMs * 2 + 120_000,
        label: 'delegating parent turns to settle',
        intervalMs: 250,
      },
    );
  });

  // Delegate results reach the renderer before chat storage has committed
  // every card; a build that commits card progress keeps rewriting parent
  // transcripts after the delegates settle. Wait for chat storage to go quiet
  // (no commit for two seconds) so the cards are opened on settled history.
  await recordTask(tasks, 'parent_transcripts_settled', async () => {
    if (!tasks.workSample) return;
    let lastCommits;
    let quietSince = performance.now();
    await waitUntil(
      async () => {
        const sample = await tasks.workSample();
        const commits = sample?.chatStorage?.counters?.commits;
        if (commits !== lastCommits) {
          lastCommits = commits;
          quietSince = performance.now();
        }
        return performance.now() - quietSince >= 2_000;
      },
      {
        timeoutMs: childRunMs * 4 + 180_000,
        label: 'parent transcripts to stop committing',
        intervalMs: 250,
      },
    );
  });

  const unrevealedCards = [];
  // Claude parents only: on the merge base a Codex parent's settled delegate
  // card stays out of reach after its steps expand, so opening one would not
  // compare like with like across builds.
  for (const descriptor of fixture.descriptors.filter(
    (candidate) => candidate.providerType === 'claude',
  )) {
    // Any of this parent's delegates: a card's label and position differ
    // between harnesses and builds, its children do not.
    const stepOne = new RegExp(`Checking ${descriptor.marker}D\\d+ part 1\\.`);
    await recordResponsiveTask(
      tasks,
      'open_settled_delegate_card',
      async () => {
        const tab = page.getByTestId(`panel-tab-panel-chat-${descriptor.id}`);
        await tab.click();
        await expect(tab).toHaveAttribute('aria-selected', 'true');
        const parentPanel = visibleChatPanel(page);
        // A completed turn collapses its steps, delegate cards included, and
        // a transcript that is still settling can remount a card (and its
        // steps) under the click, so reveal and expand until the delegate's
        // children show, as the managed delegation flow test does.
        try {
          await expect(async () => {
            // A tab can reopen above its latest turn.
            const latest = parentPanel.getByTestId('chat-scroll-to-bottom');
            if (await latest.isVisible().catch(() => false))
              await latest.click({ timeout: 2_000 }).catch(() => undefined);
            const collapsedSteps = parentPanel.getByRole('button', {
              name: /^Agent steps:/,
              expanded: false,
            });
            if (await collapsedSteps.count())
              await collapsedSteps.last().click({ timeout: 2_000 });
            const card = parentPanel
              .getByTestId('chat-delegated-agent')
              .first();
            await expect(card).toBeVisible({ timeout: 2_000 });
            const expand = card.getByRole('button', {
              name: 'Expand delegated task',
            });
            if (await expand.count())
              await expand.first().click({ timeout: 2_000 });
            await expect(card.getByText(stepOne).first()).toBeVisible({
              timeout: 2_000,
            });
          }).toPass({ timeout: 30_000, intervals: [250, 500, 1_000] });
        } catch (error) {
          // Recorded, not fatal: a card that never shows its children is a
          // result to compare, and the run's other measurements still hold.
          const shown = await parentPanel
            .innerText({ timeout: 5_000 })
            .catch(() => '');
          unrevealedCards.push({
            chatId: descriptor.id,
            error: `${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
            panelTail: shown.slice(-300),
          });
          return;
        }
        await nextPaint(page);
      },
      { providerType: descriptor.providerType },
      config.responsivenessBudgetMs,
    );
  }

  const final = await managedDelegationSnapshot(page);
  await page.evaluate(() => {
    window.__CANOPY_MANAGED_DELEGATION_PERF__?.dispose?.();
  });
  return {
    parents: fixture.descriptors.length,
    claudeParents: fixture.descriptors.filter(
      (descriptor) => descriptor.providerType === 'claude',
    ).length,
    delegates: expectedRuns,
    delegateSteps: config.managedDelegationChildSteps,
    seededChatFileBytes: fixture.seededChatFileBytes,
    interactionsWithRunningDelegates,
    settledCardsOpened:
      fixture.descriptors.filter(
        (descriptor) => descriptor.providerType === 'claude',
      ).length - unrevealedCards.length,
    unrevealedCards,
    rendererDelegationEvents: final.events,
    rendererDelegationEventsByChat: final.eventsByChat,
    delegateStatuses: final.statuses,
  };
}

// ── Delegation restart cycles ───────────────────────────────────────────────
//
// One Claude parent in a worktree chat whose committed history is very long
// and holds many settled legacy delegation cards. Each cycle starts a turn
// that launches background delegates (one of them on Codex), stops the
// parent turn with the composer's Stop while they run, stops every delegate
// from the background drawer's Stop all, and waits for chat storage to go
// quiet before the next cycle starts. The parent's committed JSONL is watched
// in main: every full replacement of it rewrites the whole history, the cost
// the foreground-first streaming follow-up set out to remove. Main's heap is
// sampled across the cycles, and typing and navigation probes run while the
// delegates are live.
//
// Run it with format 4 on (`CANOPY_E2E_CHAT_FORMAT4=1`, stream cards) and off
// (legacy cards, production today) to compare the two card paths.

const DELEGATION_CYCLES_CHAT_ID = 'delegation-cycles-parent';
const DELEGATION_CYCLES_MARKER = 'Canopy-CDRCPARENT';
const DELEGATION_CYCLES_EVIDENCE_FILE = 'delegation-cycles-evidence.txt';
const DELEGATION_CYCLES_HEAP_KEY = '__CANOPY_PERF_DELEGATION_CYCLES_HEAP__';

// A settled card validates against its route, as a real retained card does.
const DELEGATION_CYCLES_HISTORY_ROUTE = Object.freeze({
  selectedModelId: 'sonnet',
  selectedModelLabel: 'Claude Sonnet',
  runtimeModelId: 'claude-sonnet-4-6',
  runtimeModelLabel: 'Claude Sonnet 4.6',
  harnessId: 'claude',
  runtimeKind: 'local-sdk',
  runnerRegistrationId: 'claude-local',
  runtimeVersion: '1',
  adapterVersion: '1',
  modelSource: 'test',
  providerType: 'test',
  assignmentRevision: 'a1',
  billingAuthority: 'native',
  aiCreditsRouted: false,
  capabilities: ['read'],
  supportedThinkingLevels: ['low'],
  capabilitySnapshotHash: 'c1',
  capabilityGeneration: 1,
  policyRevision: 'p1',
});

export function delegationCycleTag(cycle) {
  return `delegation-cycle-${cycle}`;
}

export function delegationCycleDelegates(config, cycle) {
  return Array.from(
    { length: config.delegationCyclesDelegates },
    (_, index) => {
      const harness = index === 1 ? 'codex' : 'claude';
      return {
        marker: `Canopy-CDRC${cycle}D${index + 1}`,
        harness,
        model: harness === 'claude' ? 'sonnet' : 'gpt-6.1-sol',
        description: `Cycle ${cycle} review ${index + 1}`,
      };
    },
  );
}

/**
 * The mock LLM scripts for the parent and every delegate, by marker. The
 * parent keeps one marker for its whole history, so each cycle's steps are
 * keyed by that cycle's request tag. Pure, so the workload's shape is
 * testable without a launch.
 */
export function delegationCycleScripts(config, evidencePath) {
  const parentStepsByTag = {};
  const scripts = {};
  for (let cycle = 1; cycle <= config.delegationCycles; cycle += 1) {
    const delegates = delegationCycleDelegates(config, cycle);
    const spawn = {
      toolCalls: delegates.map((delegate, index) => ({
        id: `delegation-cycle-${cycle}-spawn-${index + 1}`,
        name: claudeToolName('DelegateTask'),
        input: {
          model: delegate.model,
          description: delegate.description,
          prompt: `[${delegate.marker}] Read ${DELEGATION_CYCLES_EVIDENCE_FILE} repeatedly and report what changed. Scope: inspection only, no modifications.`,
          run_in_background: true,
        },
      })),
      stopReason: 'tool_use',
    };
    // Outlasts the cycle, so the composer's Stop always lands mid-stream.
    const work = {
      text: performanceStreamingText(
        `Delegation cycle ${cycle} parent keeps working`,
        config.chatReplyCharacters,
      ),
      stopReason: 'end_turn',
      streamMs: config.delegationCyclesParentStreamMs,
      chunkChars: 4,
    };
    // A stopped delegate's result can wake the parent; each wake ends at once.
    const wake = {
      text: `Noted the stopped reviews for cycle ${cycle}.`,
      stopReason: 'end_turn',
    };
    parentStepsByTag[delegationCycleTag(cycle)] = [
      spawn,
      work,
      ...Array.from({ length: delegates.length + 2 }, () => wake),
    ];
    for (const delegate of delegates) {
      const steps = Array.from(
        { length: config.delegationCyclesChildSteps },
        (_, index) => ({
          text: managedDelegationStepText(delegate.marker, index + 1),
          streamMs: config.delegationCyclesChildStepMs,
          chunkChars: 8,
          toolCalls: [
            delegate.harness === 'claude'
              ? {
                  id: `${delegate.marker}-read-${index + 1}`,
                  name: 'Read',
                  input: { file_path: evidencePath },
                }
              : {
                  namespace: 'functions',
                  name: 'exec_command',
                  input: { cmd: `cat '${evidencePath}'` },
                },
          ],
          stopReason: 'tool_use',
        }),
      );
      steps.push({
        text: `Finding for ${delegate.marker}.`,
        stopReason: 'end_turn',
      });
      scripts[delegate.marker] = {
        llm: {
          steps,
          ...(delegate.harness === 'codex'
            ? { openAiStepCursor: 'completed-scenario-tool-calls' }
            : {}),
        },
      };
    }
  }
  scripts[DELEGATION_CYCLES_MARKER] = {
    llm: {
      steps: [{ text: 'Ready for the next cycle.', stopReason: 'end_turn' }],
      stepsByRequestTag: parentStepsByTag,
    },
  };
  return scripts;
}

/**
 * Committed parent history: synthetic rich turns with a settled legacy
 * delegation card after every few of them, as a long-running orchestrator
 * chat accumulates. Deterministic for a given size.
 */
export function buildDelegationCycleHistory({
  transcriptBytes,
  historyCards,
  messageBytes = 4 * 1024,
}) {
  const messageCount = Math.max(2, Math.ceil(transcriptBytes / messageBytes));
  const messages = buildSyntheticTranscriptMessages({
    transcriptId: DELEGATION_CYCLES_CHAT_ID,
    messageCount,
    messageBytes,
    shape: 'rich',
  });
  const cards = Math.min(historyCards, Math.floor(messageCount / 2));
  const every = cards > 0 ? Math.floor(messageCount / cards) : 0;
  const history = [];
  let lastUserId = null;
  let added = 0;
  for (const [index, message] of messages.entries()) {
    history.push(message);
    if (message.role === 'user') lastUserId = message.id;
    if (
      added < cards &&
      lastUserId &&
      message.role === 'assistant' &&
      (index + 1) % every === 0
    ) {
      added += 1;
      const delegationId = `delegation-cycles-history-${String(added).padStart(4, '0')}`;
      history.push({
        id: `delegated-agent-${delegationId}`,
        role: 'assistant',
        timestamp: message.timestamp + 1,
        blocks: [
          {
            type: 'delegated_agent_call',
            delegationId,
            agentBlockId: `delegated-agent-${delegationId}`,
            runGeneration: 1,
            status: 'completed',
            outputTruncated: false,
            transcriptStore: 'chat-log-v1',
            sequence: 4,
            parentHarnessId: 'claude',
            parentTurnId: lastUserId,
            parentToolCallId: `spawn-${delegationId}`,
            selectedModelId: 'sonnet',
            runtimeModelId: 'claude-sonnet-4-6',
            targetHarnessId: 'claude',
            routeSnapshot: DELEGATION_CYCLES_HISTORY_ROUTE,
            description: `Earlier review ${added}`,
            prompt: `Review part ${added} of the earlier change.`,
            executionMode: 'background',
            finalText: syntheticText(`Earlier review ${added} finding`, 512),
            createdAt: message.timestamp + 1,
          },
        ],
      });
    }
  }
  return { messages: history, historyCards: added };
}

async function prepareDelegationRestartCycles(userDataDir, config) {
  const seed = seedWorkspace(userDataDir);
  const worktreePath = seed.workspaces?.find(
    (workspace) => workspace.id === WORKSPACE_ID,
  )?.worktreePath;
  if (!worktreePath) throw new Error('Missing the seeded demo worktree path');
  const evidencePath = path.join(worktreePath, DELEGATION_CYCLES_EVIDENCE_FILE);
  writeFileSync(
    evidencePath,
    syntheticText('Delegation cycle evidence', 4 * 1024),
    'utf8',
  );
  writeFileSync(
    path.join(userDataDir, 'preferences.json'),
    JSON.stringify(
      {
        version: 1,
        preferences: {
          onboardingCompleted: ['v1'],
          managedDelegationMode: 'explicit-only',
          // Every cycle's delegates run at once; none waits in the queue.
          managedDelegationMaxConcurrent: Math.max(
            4,
            config.delegationCyclesDelegates,
          ),
          defaultChatInterfaceMode: 'canopy',
          defaultWorktreeProvider: 'claude',
          defaultChatProvider: 'claude',
          codexMultiAgentWorktreeChatsEnabled: false,
          summaryModel: 'claude-haiku-4-5-20251001',
          summaryModelSetByUser: true,
        },
      },
      null,
      2,
    ),
    'utf8',
  );
  // Normalize the tab as `seedWorktreeChat` does, then write the history
  // straight into canonical V2 storage, so launch does not migrate it.
  const { file: legacyChats } = seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    activeTabId: DELEGATION_CYCLES_CHAT_ID,
    tabs: [
      {
        id: DELEGATION_CYCLES_CHAT_ID,
        title: 'Delegation cycles',
        kind: 'chat',
        providerType: 'claude',
        // Deterministic: delegates read without stopping on an approval.
        approvalMode: 'full-access',
        createdAt: '2026-07-01T12:00:00.000Z',
      },
    ],
  });
  const tab = legacyChats.tabs.find(
    (entry) => entry.id === DELEGATION_CYCLES_CHAT_ID,
  );
  if (!tab) throw new Error('Delegation cycle chat tab was not seeded');
  const history = buildDelegationCycleHistory({
    transcriptBytes: config.delegationCyclesTranscriptBytes,
    historyCards: config.delegationCyclesHistoryCards,
  });
  const workspaceRoot = path.join(userDataDir, 'workspaces', WORKSPACE_ID);
  const { require: tsRequire } = await import('tsx/cjs/api');
  const { ChatStorageV2 } = tsRequire(
    '../../src/main/lib/chat-storage-v2.ts',
    import.meta.url,
  );
  const storage = new ChatStorageV2(workspaceRoot, WORKTREE_ID);
  await storage.migrate(async () => ({
    revision: 1,
    index: { activeTabId: DELEGATION_CYCLES_CHAT_ID, runtimeByChatId: {} },
    recovery: {
      receipts: [],
      mutationIds: [],
      removedTabIds: [],
      removedArchiveEntryIds: [],
      removedMessageIds: [],
    },
    chats: (async function* () {
      yield {
        metadata: Object.fromEntries(
          Object.entries(tab).filter(([key]) => key !== 'messages'),
        ),
        messages: (async function* () {
          yield* history.messages;
        })(),
      };
    })(),
  }));
  const transcriptPath = path.join(
    workspaceRoot,
    'chat-storage-v2',
    WORKTREE_ID,
    'transcripts',
    `${DELEGATION_CYCLES_CHAT_ID}.jsonl`,
  );
  const scripts = delegationCycleScripts(config, evidencePath);
  for (const [marker, script] of Object.entries(scripts))
    await registerScenario(PERFORMANCE_MOCK_BASE_URL, marker, script);
  return {
    transcriptPath,
    seededMessages: history.messages.length,
    seededHistoryCards: history.historyCards,
    seededTranscriptBytes: statSync(transcriptPath).size,
  };
}

/** Samples main's heap until stopped; the peak is a lower bound. */
async function startMainHeapSampler(electronApp, intervalMs) {
  await evaluateMainWithRetry(() =>
    electronApp.evaluate(
      (_electron, { key, interval }) => {
        globalThis[key]?.stop?.();
        const first = process.memoryUsage();
        const state = {
          samples: 0,
          startHeapUsed: first.heapUsed,
          startRss: first.rss,
          peakHeapUsed: first.heapUsed,
          peakRss: first.rss,
        };
        const sample = () => {
          const usage = process.memoryUsage();
          state.samples += 1;
          state.peakHeapUsed = Math.max(state.peakHeapUsed, usage.heapUsed);
          state.peakRss = Math.max(state.peakRss, usage.rss);
        };
        const timer = setInterval(sample, interval);
        timer.unref?.();
        globalThis[key] = {
          stop() {
            clearInterval(timer);
            sample();
            const end = process.memoryUsage();
            return { ...state, endHeapUsed: end.heapUsed, endRss: end.rss };
          },
        };
      },
      { key: DELEGATION_CYCLES_HEAP_KEY, interval: intervalMs },
    ),
  );
}

async function stopMainHeapSampler(electronApp) {
  return evaluateMainWithRetry(() =>
    electronApp.evaluate(
      (_electron, key) => globalThis[key]?.stop?.() ?? null,
      DELEGATION_CYCLES_HEAP_KEY,
    ),
  );
}

/** Card rows in the committed parent, by store and status. */
export function summarizeDelegationCycleCards(jsonl) {
  const summary = { cards: 0, byStore: {}, byStatus: {} };
  for (const line of jsonl.split('\n')) {
    if (!line.includes('"delegated_agent_call"')) continue;
    const row = JSON.parse(line);
    for (const block of row.blocks ?? []) {
      if (block?.type !== 'delegated_agent_call') continue;
      if (block.delegationId?.startsWith('delegation-cycles-history-'))
        continue;
      summary.cards += 1;
      const store = block.transcriptStore ?? 'unknown';
      summary.byStore[store] = (summary.byStore[store] ?? 0) + 1;
      const status = block.status ?? 'unknown';
      summary.byStatus[status] = (summary.byStatus[status] ?? 0) + 1;
    }
  }
  return summary;
}

function replacementDelta(before, after) {
  const events = after.events.slice(before.events.length);
  return {
    full: events.filter((event) => event.kind === 'full').length,
    prefixClone: events.filter((event) => event.kind === 'prefix-clone').length,
    bytes: events.reduce((total, event) => total + (event.bytes ?? 0), 0),
  };
}

/** Run keys the delegation monitor has seen so far. */
function delegationRunKeys(page) {
  return page.evaluate(() =>
    Object.keys(window.__CANOPY_MANAGED_DELEGATION_PERF__?.state.runs ?? {}),
  );
}

/** Statuses of the runs this cycle created, newest state per run. */
function cycleRunStatuses(page, known) {
  return page.evaluate((previous) => {
    const state = window.__CANOPY_MANAGED_DELEGATION_PERF__?.state;
    if (!state)
      throw new Error('Managed delegation event monitor is not installed');
    const seen = new Set(previous);
    return Object.entries(state.runs)
      .filter(([key]) => !seen.has(key))
      .map(([, run]) => run.status);
  }, known);
}

/**
 * Every delegate of the cycle runs and has finished its first scripted read:
 * its second model request answers that read's result.
 */
async function cycleDelegatesWorking(page, known, delegates) {
  const statuses = await cycleRunStatuses(page, known);
  if (
    statuses.length < delegates.length ||
    statuses.some((status) => status !== 'running')
  )
    return { ready: false, statuses };
  const requests = await Promise.all(
    delegates.map(async (delegate) => {
      const { activity } = await getScenarioActivity(
        PERFORMANCE_MOCK_BASE_URL,
        delegate.marker,
      );
      return activity.llmRequests ?? 0;
    }),
  );
  return { ready: requests.every((count) => count >= 2), statuses, requests };
}

async function waitForChatStorageQuiet(tasks, timeoutMs, label) {
  if (!tasks.workSample) return;
  let lastCommits;
  let quietSince = performance.now();
  await waitUntil(
    async () => {
      const sample = await tasks.workSample();
      const commits = sample?.chatStorage?.counters?.commits;
      if (commits !== lastCommits) {
        lastCommits = commits;
        quietSince = performance.now();
      }
      return performance.now() - quietSince >= 2_000;
    },
    { timeoutMs, label, intervalMs: 250 },
  );
}

async function runDelegationRestartCycles({
  page,
  app,
  electronApp,
  config,
  tasks,
  fixture,
}) {
  const delegatesPerCycle = config.delegationCyclesDelegates;
  const childRunMs =
    config.delegationCyclesChildSteps * config.delegationCyclesChildStepMs;
  const format4 = await evaluateMainWithRetry(() =>
    electronApp.evaluate(() => process.env.CANOPY_E2E_CHAT_FORMAT4 === '1'),
  );
  await openMainPage(page);
  await app.selectWorktree(WORKTREE_BRANCH, NO_ACTIVITY_RAIL);
  await installManagedDelegationMonitor(page);
  const parentTab = page.getByTestId(
    `panel-tab-panel-chat-${DELEGATION_CYCLES_CHAT_ID}`,
  );
  const selectParent = async () => {
    await parentTab.click();
    await expect(parentTab).toHaveAttribute('aria-selected', 'true');
  };
  await selectParent();
  const probeTabId = await createResponsivenessChat(page, tasks);
  await selectParent();
  await installTranscriptRewriteObserver(electronApp, fixture.transcriptPath);
  await startMainHeapSampler(electronApp, 250);

  const cycles = [];
  try {
    for (let cycle = 1; cycle <= config.delegationCycles; cycle += 1) {
      const before = await readTranscriptRewriteObserver(electronApp);
      const knownRuns = await delegationRunKeys(page);
      const delegates = delegationCycleDelegates(config, cycle);
      const panel = visibleChatPanel(page);
      await recordResponsiveTask(
        tasks,
        'start_delegation_cycle',
        async () => {
          const message = `[${DELEGATION_CYCLES_MARKER}] [Canopy-Mock-Request:${delegationCycleTag(cycle)}] Cycle ${cycle}: delegate ${delegatesPerCycle} background reviews and keep working.`;
          const composer = panel
            .locator('[data-chat-composer-root]')
            .getByRole('textbox')
            .first();
          await composer.fill(message);
          await panel.getByRole('button', { name: 'Send message' }).click();
          let last;
          try {
            await waitUntil(
              async () => {
                last = await cycleDelegatesWorking(page, knownRuns, delegates);
                return last.ready;
              },
              {
                timeoutMs: 120_000,
                label: `cycle ${cycle} delegates to run and read`,
                intervalMs: 250,
              },
            );
          } catch (error) {
            throw new Error(
              `${error instanceof Error ? error.message : String(error)}; observed=${JSON.stringify(last)}`,
            );
          }
        },
        { cycle, delegates: delegatesPerCycle },
        config.responsivenessBudgetMs,
      );

      await recordResponsiveTask(
        tasks,
        'type_during_delegation_cycle',
        async () => {
          const probeTab = page.getByTestId(probeTabId);
          await probeTab.click();
          await expect(probeTab).toHaveAttribute('aria-selected', 'true');
          await typeDraftAndWaitForPaint(page, {
            scenario: 'delegation-restart-cycles',
            iteration: cycle,
            characters: config.typingCharacters,
          });
        },
        { cycle },
        config.responsivenessBudgetMs,
      );
      await recordResponsiveTask(
        tasks,
        'return_to_delegating_parent',
        async () => {
          await selectParent();
          await nextPaint(page);
        },
        { cycle },
        config.responsivenessBudgetMs,
      );

      const parentPanel = visibleChatPanel(page);
      await recordResponsiveTask(
        tasks,
        'stop_delegation_cycle_parent',
        async () => {
          await parentPanel.getByTestId('chat-stop-generation').click();
          await waitUntil(
            async () =>
              !(await activeTurnSnapshot(page)).chatIds.includes(
                DELEGATION_CYCLES_CHAT_ID,
              ),
            {
              timeoutMs: 60_000,
              label: `cycle ${cycle} parent turn to stop`,
              intervalMs: 100,
            },
          );
        },
        { cycle },
        config.responsivenessBudgetMs,
      );
      const beforeStopAll = await cycleRunStatuses(page, knownRuns);
      if (beforeStopAll.some((status) => status !== 'running'))
        throw new Error(
          `Cycle ${cycle} delegates left running before Stop all: ${JSON.stringify(beforeStopAll)}`,
        );

      await recordResponsiveTask(
        tasks,
        'stop_delegation_cycle_delegates',
        async () => {
          const tray = await openBackgroundDrawer(parentPanel);
          await tray.getByTestId('background-tray-stop-all').click();
          await page.getByTestId('background-tray-stop-all-confirm').click();
          let last;
          try {
            await waitUntil(
              async () => {
                last = await cycleRunStatuses(page, knownRuns);
                return last.every((status) => status === 'cancelled');
              },
              {
                timeoutMs: 60_000,
                label: `cycle ${cycle} delegates to be cancelled`,
                intervalMs: 100,
              },
            );
          } catch (error) {
            throw new Error(
              `${error instanceof Error ? error.message : String(error)}; observed=${JSON.stringify(last)}`,
            );
          }
        },
        { cycle },
        config.responsivenessBudgetMs,
      );

      // A stopped delegate's result can wake the parent; let that turn end
      // and chat storage commit before the next cycle starts.
      await recordTask(
        tasks,
        'delegation_cycle_settled',
        async () => {
          let idleSamples = 0;
          await waitUntil(
            async () => {
              const turns = await activeTurnSnapshot(page);
              idleSamples = turns.chatIds.includes(DELEGATION_CYCLES_CHAT_ID)
                ? 0
                : idleSamples + 1;
              return idleSamples >= 3;
            },
            {
              timeoutMs: 120_000,
              label: `cycle ${cycle} parent to stay idle`,
              intervalMs: 250,
            },
          );
          await waitForChatStorageQuiet(
            tasks,
            childRunMs + 120_000,
            `cycle ${cycle} chat storage to go quiet`,
          );
        },
        { cycle },
      );
      const after = await readTranscriptRewriteObserver(electronApp);
      cycles.push({
        cycle,
        parentReplacements: replacementDelta(before, after),
      });
    }
  } finally {
    await page
      .evaluate(() => window.__CANOPY_MANAGED_DELEGATION_PERF__?.dispose?.())
      .catch(() => undefined);
  }

  const mainHeap = await stopMainHeapSampler(electronApp);
  const observed = await stopTranscriptRewriteObserver(electronApp);
  const final = await managedDelegationSnapshot(page).catch(() => null);
  const cards = summarizeDelegationCycleCards(
    readFileSync(fixture.transcriptPath, 'utf8'),
  );
  const totals = replacementDelta({ events: [] }, observed);
  return {
    format4,
    cycles: config.delegationCycles,
    delegatesPerCycle,
    seededMessages: fixture.seededMessages,
    seededHistoryCards: fixture.seededHistoryCards,
    seededTranscriptBytes: fixture.seededTranscriptBytes,
    finalTranscriptBytes: statSync(fixture.transcriptPath).size,
    parentFullReplacements: totals.full,
    parentPrefixCloneReplacements: totals.prefixClone,
    parentReplacementBytes: totals.bytes,
    perCycle: cycles,
    otherTranscriptRenames: observed.otherRenames,
    mainHeap,
    cycleCards: cards,
    delegateStatuses: final?.statuses ?? null,
    rendererDelegationEvents: final?.events ?? null,
  };
}

// ── Multi-chat streaming ────────────────────────────────────────────────────
//
// Five worktrees, one chat each, alternating Claude and Codex. Both variants
// replay the same deterministic event script; only the release of each chunk
// differs. Every chunk waits at a gate whose `mode` file says `auto <s>` (the
// concurrent variant: the gate releases itself after the tool interval) or
// `manual` (the sequential variant: the harness releases it only after the
// previous chunk is committed, rendered, and quiet).
//
// Claude chats run the real Claude CLI against the mock LLM. Each step is one
// model response with one gated `Bash` tool call, so a tool call lands about
// every tool interval; a few steps also `Read` a file larger than 64 KiB.
// Codex chats run the E2E fake app-server (`perf-script` mode), which replays
// app-server notifications through Canopy's real Codex client, including a
// long command whose output streams in deltas.

const MULTI_CHAT_GATE_SCRIPT = `#!/bin/sh
# Desktop performance harness gate: waits for its release, then reports.
dir="$1"
step="$2"
: > "$dir/waiting-$step"
mode=$(cat "$dir/mode")
case "$mode" in
  auto\\ *) sleep "\${mode#auto }" ;;
  *) while [ ! -e "$dir/release-$step" ]; do sleep 0.02; done ;;
esac
printf 'performance gate %s passed: %s\\n' "$step" "$(cat "$dir/payload")"
`;

/** Five chats across five worktrees, alternating Claude and Codex. */
export function multiChatStreamingChats(config) {
  return Array.from({ length: config.multiChatStreamingChats }, (_, index) => {
    const ordinal = index + 1;
    return {
      index: ordinal,
      key: `chat-${ordinal}`,
      chatId: `multi-chat-streaming-${ordinal}`,
      worktreeId:
        index === 0
          ? WORKTREE_ID
          : `perf-existing-${String(index).padStart(3, '0')}`,
      providerType: index % 2 === 0 ? 'claude' : 'codex',
      marker: `Canopy-CMCS${ordinal}`,
    };
  });
}

/**
 * Chat-switch catch-up compares two real Claude streams on separate
 * worktrees. The warm stream is opened before it is hidden; the cold stream is
 * never selected until all of its hidden steps have committed. Pass the
 * prepared fixture's chats so the plan carries their gate directories.
 */
export function buildChatSwitchCatchUpPlan(
  config,
  chats = multiChatStreamingChats(config),
) {
  const hiddenEvents = config.chatSwitchCatchUpEvents;
  if (!Number.isSafeInteger(hiddenEvents) || hiddenEvents < 1) {
    throw new Error('chatSwitchCatchUpEvents must be a positive integer');
  }

  if (chats.length < 4) {
    throw new Error('Chat-switch catch-up requires at least four stream chats');
  }
  const claudeChats = chats.filter(
    (candidate) => candidate.providerType === 'claude',
  );
  if (claudeChats.length < 2) {
    throw new Error(
      'Chat-switch catch-up requires two Claude chats in separate worktrees',
    );
  }

  const availableSteps = multiChatClaudeStepCount(config);
  if (hiddenEvents >= availableSteps) {
    throw new Error(
      `chatSwitchCatchUpEvents (${hiddenEvents}) must leave a final Claude step in the streaming fixture (${availableSteps} total steps)`,
    );
  }
  const [warmChat, coldChat] = claudeChats;
  if (warmChat.worktreeId === coldChat.worktreeId) {
    throw new Error('Warm and cold catch-up chats must use separate worktrees');
  }

  return {
    warmChat,
    coldChat,
    warmHiddenStepIndexes: Array.from(
      { length: hiddenEvents },
      (_, index) => index + 1,
    ),
    coldHiddenStepIndexes: Array.from(
      { length: hiddenEvents },
      (_, index) => index,
    ),
    availableSteps,
  };
}

/**
 * Gated steps in a Claude chat's script: one tool call per tool interval, at
 * most 150.
 */
// A Claude chat turn ends after 200 model turns (`error_max_turns`), so a
// chat's script stays well under that. Longer loads come from the Codex
// chats' scripts, not from more Claude steps.
const MULTI_CHAT_CLAUDE_MAX_STEPS = 150;

export function multiChatClaudeStepCount(config) {
  return Math.min(
    MULTI_CHAT_CLAUDE_MAX_STEPS,
    Math.max(
      3,
      Math.floor(
        config.multiChatStreamingMs / config.multiChatStreamingToolIntervalMs,
      ),
    ),
  );
}

function evenlySpacedIndexes(count, total) {
  const indexes = new Set();
  for (let index = 1; index <= count; index += 1) {
    indexes.add(Math.min(total - 1, Math.floor((index * total) / (count + 1))));
  }
  return indexes;
}

/**
 * A Claude chat's mock-LLM script: one response per gated step, each with a
 * short text block and one `Bash` gate call, a few also reading the large
 * output file, then a final text.
 */
export function buildMultiChatClaudeConversation({
  chat,
  config,
  gateScriptPath,
  gateDir,
  largeOutputPath,
}) {
  const stepCount = multiChatClaudeStepCount(config);
  const largeSteps = evenlySpacedIndexes(
    config.multiChatStreamingLargeOutputs,
    stepCount,
  );
  const steps = [];
  for (let step = 0; step < stepCount; step += 1) {
    steps.push({
      text: `${chat.key} step ${step}: streaming the next tool call; results stay ordered and complete.`,
      toolCalls: [
        ...(largeSteps.has(step)
          ? [
              {
                id: `toolu_perf_${chat.key}_${step}_read`,
                name: 'Read',
                input: { file_path: largeOutputPath },
              },
            ]
          : []),
        {
          id: `toolu_perf_${chat.key}_${step}_gate`,
          name: 'Bash',
          input: {
            command: `sh '${gateScriptPath}' '${gateDir}' ${step}`,
            description: `Wait for performance gate ${step}`,
          },
        },
      ],
      stopReason: 'tool_use',
    });
  }
  steps.push({ text: `${chat.marker} complete.`, stopReason: 'end_turn' });
  return {
    llm: { steps },
    stepCount,
    largeOutputSteps: [...largeSteps].sort((left, right) => left - right),
  };
}

function codexAgentMessageNotifications(id, text, phase) {
  const item = { type: 'agentMessage', id, text, phase };
  return [
    { method: 'item/started', params: { item: { ...item, text: '' } } },
    { method: 'item/agentMessage/delta', params: { itemId: id, delta: text } },
    { method: 'item/completed', params: { item } },
  ];
}

function codexCommandItem(id, command, cwd, status, aggregatedOutput) {
  return {
    type: 'commandExecution',
    id,
    command,
    cwd,
    processId: '4242',
    status,
    commandActions: [],
    aggregatedOutput,
    exitCode: status === 'completed' ? 0 : null,
    durationMs: status === 'completed' ? 12 : null,
  };
}

function codexOutputDelta(chatKey, index, bytes) {
  const prefix = `${chatKey} output ${String(index).padStart(4, '0')}: `;
  return `${prefix}${'o'.repeat(Math.max(0, bytes - prefix.length - 1))}\n`;
}

/**
 * A Codex chat's fake app-server script. Quick commands land one per tool
 * interval around one long command whose output streams in fixed-size deltas
 * (and completes above 64 KiB). `brackets` are the chunk ranges of its first
 * and last deltas, the inputs of the Codex-output scaling ratio.
 */
export function buildMultiChatCodexScript({ chat, config, gateDir, cwd }) {
  const toolIntervalMs = config.multiChatStreamingToolIntervalMs;
  const deltas = config.multiChatStreamingCommandOutputDeltas;
  const deltaBytes = config.multiChatStreamingCommandOutputDeltaBytes;
  const deltaIntervalMs = config.multiChatStreamingCommandOutputIntervalMs;
  const bracket = Math.min(
    config.multiChatStreamingRatioBracketUpdates,
    Math.floor(deltas / 2),
  );
  const quickCommands = Math.max(
    2,
    Math.floor(
      (config.multiChatStreamingMs - deltas * deltaIntervalMs) / toolIntervalMs,
    ),
  );
  const chunks = [
    {
      delayMs: toolIntervalMs,
      notifications: codexAgentMessageNotifications(
        `${chat.key}-plan`,
        `${chat.key} is running its command workload.`,
        'commentary',
      ),
    },
  ];
  const quick = (index) => {
    const id = `${chat.key}-quick-${index}`;
    const command = `printf 'quick ${index}'`;
    return {
      delayMs: toolIntervalMs,
      notifications: [
        {
          method: 'item/started',
          params: {
            item: codexCommandItem(id, command, cwd, 'inProgress', ''),
          },
        },
        {
          method: 'item/completed',
          params: {
            item: codexCommandItem(
              id,
              command,
              cwd,
              'completed',
              `quick ${index} ${'q'.repeat(200)}\n`,
            ),
          },
        },
      ],
    };
  };
  const before = Math.floor(quickCommands / 2);
  for (let index = 0; index < before; index += 1) chunks.push(quick(index));
  const longId = `${chat.key}-long`;
  const longCommand = 'node scripts/stream-report.js';
  chunks.push({
    delayMs: toolIntervalMs,
    notifications: [
      {
        method: 'item/started',
        params: {
          item: codexCommandItem(longId, longCommand, cwd, 'inProgress', ''),
        },
      },
    ],
  });
  const firstDelta = chunks.length;
  let output = '';
  for (let index = 0; index < deltas; index += 1) {
    const delta = codexOutputDelta(chat.key, index, deltaBytes);
    output += delta;
    chunks.push({
      delayMs: deltaIntervalMs,
      notifications: [
        {
          method: 'item/commandExecution/outputDelta',
          params: { itemId: longId, delta },
        },
      ],
    });
  }
  const lastDelta = chunks.length - 1;
  chunks.push({
    delayMs: deltaIntervalMs,
    notifications: [
      {
        method: 'item/completed',
        params: {
          item: codexCommandItem(longId, longCommand, cwd, 'completed', output),
        },
      },
    ],
  });
  for (let index = before; index < quickCommands; index += 1) {
    chunks.push(quick(index));
  }
  chunks.push({
    delayMs: toolIntervalMs,
    notifications: [
      ...codexAgentMessageNotifications(
        `${chat.key}-final`,
        `${chat.marker} complete.`,
        'final_answer',
      ),
      {
        method: 'thread/tokenUsage/updated',
        params: {
          tokenUsage: {
            total: {
              totalTokens: 12,
              inputTokens: 8,
              cachedInputTokens: 0,
              outputTokens: 4,
              reasoningOutputTokens: 0,
            },
            last: {
              totalTokens: 12,
              inputTokens: 8,
              cachedInputTokens: 0,
              outputTokens: 4,
              reasoningOutputTokens: 0,
            },
            modelContextWindow: 200_000,
          },
        },
      },
      {
        method: 'turn/completed',
        params: { turn: { items: [], status: 'completed', error: null } },
      },
    ],
  });
  return {
    marker: chat.marker,
    gateDir,
    chunks,
    brackets: {
      early: [firstDelta, firstDelta + bracket - 1],
      late: [lastDelta - bracket + 1, lastDelta],
    },
    longCommandOutputBytes: Buffer.byteLength(output),
    quickCommands,
  };
}

function writeGateDirectory(gateDir, mode) {
  mkdirSync(gateDir, { recursive: true });
  writeFileSync(path.join(gateDir, 'mode'), `${mode}\n`, 'utf8');
  writeFileSync(
    path.join(gateDir, 'payload'),
    'deterministic gate payload '.repeat(8).trim(),
    'utf8',
  );
}

const MANY_CHAT_RESIDENCY_STREAM_INTERVAL_MS = 1_000;
// Under the 64 KiB artifact threshold, so streamed reads stay inline.
const MANY_CHAT_RESIDENCY_STREAM_OUTPUT_BYTES = 49_152;
const MANY_CHAT_RESIDENCY_STREAM_STEPS = 10;

async function prepareManyChatResidency(userDataDir) {
  seedWorkspace(userDataDir);
  const fixture = await seedManyChatResidencyFixture(userDataDir);
  const runtimeDir = path.join(userDataDir, 'perf-many-chat-residency');
  mkdirSync(runtimeDir, { recursive: true });
  const gateScriptPath = path.join(runtimeDir, 'gate.sh');
  writeFileSync(gateScriptPath, MULTI_CHAT_GATE_SCRIPT, { mode: 0o755 });
  const largeOutputPath = path.join(runtimeDir, 'provider-output.txt');
  const outputUnit = 'deterministic provider tool output for chat residency\n';
  writeFileSync(
    largeOutputPath,
    outputUnit
      .repeat(
        Math.ceil(MANY_CHAT_RESIDENCY_STREAM_OUTPUT_BYTES / outputUnit.length),
      )
      .slice(0, MANY_CHAT_RESIDENCY_STREAM_OUTPUT_BYTES),
    'utf8',
  );

  const streamConfig = {
    multiChatStreamingMs:
      MANY_CHAT_RESIDENCY_STREAM_INTERVAL_MS * MANY_CHAT_RESIDENCY_STREAM_STEPS,
    multiChatStreamingToolIntervalMs: MANY_CHAT_RESIDENCY_STREAM_INTERVAL_MS,
    // Every step reads the inline output, so each streamed chat carries it.
    multiChatStreamingLargeOutputs: MANY_CHAT_RESIDENCY_STREAM_STEPS,
  };
  const streamChats = [];
  for (
    let index = 0;
    index < MANY_CHAT_RESIDENCY_STREAM_CHAT_COUNT;
    index += 1
  ) {
    const ordinal = index + 1;
    const seededChat = fixture.chats[index];
    const chat = {
      ...seededChat,
      index: ordinal,
      key: `residency-${String(ordinal).padStart(2, '0')}`,
      chatId: seededChat.id,
      worktreeId: fixture.worktreeId,
      providerType: 'claude',
      // The mock provider only matches `[Canopy-C…]` markers.
      marker: `Canopy-CMCR${String(ordinal).padStart(3, '0')}`,
      gateDir: path.join(runtimeDir, 'gates', `residency-${ordinal}`),
    };
    writeGateDirectory(
      chat.gateDir,
      `auto ${MANY_CHAT_RESIDENCY_STREAM_INTERVAL_MS / 1_000}`,
    );
    const conversation = buildMultiChatClaudeConversation({
      chat,
      config: streamConfig,
      gateScriptPath,
      gateDir: chat.gateDir,
      largeOutputPath,
    });
    await registerScenario(PERFORMANCE_MOCK_BASE_URL, chat.marker, {
      llm: conversation.llm,
    });
    streamChats.push({
      ...chat,
      stepCount: conversation.stepCount,
      largeOutputSteps: conversation.largeOutputSteps,
    });
  }

  return {
    ...fixture,
    streamChats,
    runtimeDir,
    largeOutputBytes: statSync(largeOutputPath).size,
    streamStepsPerChat: streamChats[0]?.stepCount ?? 0,
  };
}

async function residencyChatTurnActive(page, chat) {
  return page.evaluate(
    async ({ projectId, worktreeId, chatId }) => {
      const result = await window.api.chat.activeSessions({
        projectId,
        worktreeId,
      });
      return (result.sessions ?? []).some(
        (session) => session.chatId === chatId && session.turnActive,
      );
    },
    {
      projectId: WORKSPACE_ID,
      worktreeId: chat.worktreeId,
      chatId: chat.chatId,
    },
  );
}

async function runManyChatResidency({ page, app, tasks, fixture }) {
  const labWindowStartedAt = new Date().toISOString();
  await openMainPage(page);
  await app.selectWorktree(WORKTREE_BRANCH, NO_ACTIVITY_RAIL);
  await expect
    .poll(() => page.locator('[role="tab"][data-panel-kind="chat"]').count(), {
      timeout: 30_000,
    })
    .toBe(fixture.chats.length);

  const streamedChatIds = [];
  const hiddenStreamingChatIds = new Set();
  const streamsPerGroup = 3;
  for (
    let groupStart = 0;
    groupStart < fixture.streamChats.length;
    groupStart += streamsPerGroup
  ) {
    const group = fixture.streamChats.slice(
      groupStart,
      groupStart + streamsPerGroup,
    );
    let previousChat = null;
    for (const chat of group) {
      const tab = page.getByTestId(`panel-tab-panel-chat-${chat.chatId}`);
      await tab.click();
      await expect(tab).toHaveAttribute('aria-selected', 'true');
      await expect(chatPanelForTab(page, chat.chatId)).toBeVisible({
        timeout: 30_000,
      });
      if (previousChat && (await residencyChatTurnActive(page, previousChat))) {
        hiddenStreamingChatIds.add(previousChat.chatId);
      }

      await recordTask(
        tasks,
        'start_many_chat_residency_stream',
        async () => {
          await sendMultiChatStreamingMessage({ page, app, chat });
          await waitUntil(() => residencyChatTurnActive(page, chat), {
            timeoutMs: 60_000,
            label: `${chat.key} provider turn to become active`,
          });
        },
        { chat: chat.index, providerType: chat.providerType },
      );
      streamedChatIds.push(chat.chatId);
      previousChat = chat;
    }

    await recordTask(tasks, 'finish_many_chat_residency_stream_group', () =>
      waitForMultiChatStreamsComplete(
        page,
        { chats: group },
        MANY_CHAT_RESIDENCY_STREAM_INTERVAL_MS *
          MANY_CHAT_RESIDENCY_STREAM_STEPS *
          3 +
          60_000,
      ),
    );
  }

  if (streamedChatIds.length < MANY_CHAT_RESIDENCY_STREAM_CHAT_COUNT) {
    throw new Error(
      `Expected at least ${MANY_CHAT_RESIDENCY_STREAM_CHAT_COUNT} streamed chats, observed ${streamedChatIds.length}`,
    );
  }
  if (hiddenStreamingChatIds.size === 0) {
    throw new Error('No provider stream continued while its chat was hidden');
  }

  const chatSwitchDurationsMs = [];
  const visitedChatIds = [];
  const streamedChatsById = new Map(
    fixture.streamChats.map((chat) => [chat.chatId, chat]),
  );
  const visitOrder = [...fixture.chats.slice(1), fixture.chats[0]];
  for (const chat of visitOrder) {
    const startedAt = performance.now();
    const tab = page.getByTestId(`panel-tab-panel-chat-${chat.id}`);
    await tab.click();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    const panel = chatPanelForTab(page, chat.id);
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await nextPaint(page);
    await expect(panel.getByText(chat.renderMarker)).toBeVisible({
      timeout: 30_000,
    });
    const streamedChat = streamedChatsById.get(chat.id);
    if (streamedChat) {
      await expect(
        panel.getByText(`${streamedChat.marker} complete.`),
      ).toBeVisible({ timeout: 30_000 });
    }
    chatSwitchDurationsMs.push({
      chatId: chat.id,
      durationMs: performance.now() - startedAt,
    });
    visitedChatIds.push(chat.id);
  }
  if (visitedChatIds.at(-1) !== fixture.chats[0].id) {
    throw new Error('Many-chat residency navigation did not finish on chat 1');
  }
  await expect(
    chatPanelForTab(page, fixture.chats[0].id).getByText(
      fixture.chats[0].renderMarker,
    ),
  ).toBeVisible({ timeout: 30_000 });

  const labWindowEndedAt = new Date().toISOString();
  const averageChatSwitchMs =
    chatSwitchDurationsMs.reduce(
      (total, sample) => total + sample.durationMs,
      0,
    ) / chatSwitchDurationsMs.length;
  return {
    chatsSeeded: fixture.chats.length,
    chatsStreamedInto: streamedChatIds.length,
    streamedChatIds,
    hiddenStreamingChats: hiddenStreamingChatIds.size,
    chatsVisited: visitedChatIds.length,
    visitedChatIds,
    fixtureDigest: fixture.fixtureDigest,
    fixtureDimensions: fixture.dimensions,
    streamStepsPerChat: fixture.streamStepsPerChat,
    providerToolOutputBytes: fixture.largeOutputBytes,
    chatSwitchDurationsMs,
    averageChatSwitchMs,
    labWindow: {
      startedAt: labWindowStartedAt,
      endedAt: labWindowEndedAt,
    },
  };
}

const SCOPE_RESIDENCY_IDLE_UNLOAD_MS = 3_000;
const SCOPE_RESIDENCY_IDLE_WAIT_MS = SCOPE_RESIDENCY_IDLE_UNLOAD_MS * 2 + 2_000;
const SCOPE_RESIDENCY_HEAP_SAMPLE_COUNT = 5;
const SCOPE_RESIDENCY_HEAP_SAMPLE_INTERVAL_MS = 200;
const SCOPE_RESIDENCY_RENDER_TIMEOUT_MS = 30_000;
const SCOPE_RESIDENCY_RENDERER_WARM_CHAT_LIMIT = 4;

async function prepareScopeResidency(userDataDir) {
  const seed = seedWorkspace(userDataDir);
  const worktreeIds = scopeResidencyWorktreeIds(SCOPE_RESIDENCY.worktreeCount);
  seedPreexistingWorktrees(userDataDir, worktreeIds.length + 1, seed);
  const fixture = await seedScopeResidencyFixture(userDataDir, { worktreeIds });
  return {
    ...fixture,
    idleUnloadMs: SCOPE_RESIDENCY_IDLE_UNLOAD_MS,
    neutralWorktreeId: WORKTREE_ID,
  };
}

async function scopeResidencyWaitForActiveChat(page, worktree) {
  const chatId = worktree.activeChatId;
  const tab = page.getByTestId(`panel-tab-panel-chat-${chatId}`);
  await expect(tab).toHaveAttribute('aria-selected', 'true', {
    timeout: SCOPE_RESIDENCY_RENDER_TIMEOUT_MS,
  });
  const panel = chatPanelForTab(page, chatId);
  await expect(panel).toBeVisible({
    timeout: SCOPE_RESIDENCY_RENDER_TIMEOUT_MS,
  });
  const chat = worktree.chats.find((candidate) => candidate.id === chatId);
  if (!chat) {
    throw new Error(
      `Scope residency fixture has no active chat ${chatId} in ${worktree.worktreeId}`,
    );
  }
  await expect(panel.getByText(chat.renderMarker)).toBeVisible({
    timeout: SCOPE_RESIDENCY_RENDER_TIMEOUT_MS,
  });
  await nextPaint(page);
}

async function scopeResidencySampleMainHeap(electronApp, label) {
  const samples = [];
  for (let index = 0; index < SCOPE_RESIDENCY_HEAP_SAMPLE_COUNT; index += 1) {
    if (index > 0) await delay(SCOPE_RESIDENCY_HEAP_SAMPLE_INTERVAL_MS);
    const startedAtMs = performance.now();
    const heap = await electronApp.evaluate(() => {
      let forcedGc = false;
      try {
        const v8 = process.getBuiltinModule('node:v8');
        const vm = process.getBuiltinModule('node:vm');
        v8.setFlagsFromString('--expose-gc');
        const gc = vm.runInNewContext('gc');
        if (typeof gc === 'function') {
          gc();
          gc();
          forcedGc = true;
        }
      } catch {
        // Heap sampling remains useful when this runtime cannot expose GC.
      }
      const statistics = process.getHeapStatistics();
      return {
        usedHeapBytes: statistics.usedHeapSize * 1024,
        totalHeapBytes: statistics.totalHeapSize * 1024,
        heapLimitBytes: statistics.heapSizeLimit * 1024,
        forcedGc,
      };
    });
    const endedAtMs = performance.now();
    if (
      !Number.isFinite(heap?.usedHeapBytes) ||
      heap.usedHeapBytes <= 0 ||
      !Number.isFinite(heap?.heapLimitBytes) ||
      heap.heapLimitBytes <= 0 ||
      !Number.isFinite(heap?.totalHeapBytes) ||
      heap.totalHeapBytes <= 0
    ) {
      throw new Error(`Scope residency ${label} main heap sample was invalid`);
    }
    samples.push({
      ...heap,
      sample: index + 1,
      sampledAtMs: (startedAtMs + endedAtMs) / 2,
      roundTripMs: endedAtMs - startedAtMs,
    });
  }

  const sortedUsedHeapBytes = samples
    .map(({ usedHeapBytes }) => usedHeapBytes)
    .sort((left, right) => left - right);
  const middle = Math.floor(sortedUsedHeapBytes.length / 2);
  const medianUsedBytes =
    sortedUsedHeapBytes.length % 2 === 0
      ? (sortedUsedHeapBytes[middle - 1] + sortedUsedHeapBytes[middle]) / 2
      : sortedUsedHeapBytes[middle];
  return {
    samples,
    medianUsedBytes,
    forcedGc: samples.every((sample) => sample.forcedGc),
  };
}

async function scopeResidencyObserveChatInterest(electronApp, page) {
  const browserWindow = await electronApp.browserWindow(page);
  const webContentsId = await browserWindow.evaluate(
    (win) => win.webContents.id,
  );
  return electronApp.evaluate((_electron, targetWebContentsId) => {
    const entry = globalThis.__CANOPY_E2E_CHAT_INTEREST__
      ?.list()
      .find((candidate) => candidate.webContentsId === targetWebContentsId);
    if (!entry) return null;
    const { focused, warm } = entry.interest;
    return {
      focusedCount: focused.length,
      warmCount: warm.length,
      focusedChatIds: focused.map((ref) => ref.chatId),
      warmChatIds: warm.map((ref) => ref.chatId),
      warmWorktreeIds: [...new Set(warm.map((ref) => ref.worktreeId))],
    };
  }, webContentsId);
}

/**
 * Evidence only: each chat-state scope's lifecycle and unload blockers from
 * main. The unchanged code has no hook and reports null.
 */
async function scopeResidencyReadScopes(electronApp) {
  try {
    return await electronApp.evaluate(
      () => globalThis.__CANOPY_E2E_CHAT_SCOPE_RESIDENCY__?.list() ?? null,
    );
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** Evidence only: an unreadable interest hook never fails the workload. */
async function scopeResidencyReadWarmChats(electronApp, page, fixture) {
  let observed = null;
  let observationError;
  try {
    observed = await scopeResidencyObserveChatInterest(electronApp, page);
  } catch (error) {
    observationError = error instanceof Error ? error.message : String(error);
  }
  return {
    observed,
    ...(observationError ? { observationError } : {}),
    rendererWarmChatLimit: SCOPE_RESIDENCY_RENDERER_WARM_CHAT_LIMIT,
    expectedWarmResidencyWorktrees: Math.min(
      SCOPE_RESIDENCY_RENDERER_WARM_CHAT_LIMIT,
      fixture.worktrees.length,
    ),
    oldestVisitedWorktreeId: fixture.worktrees[0]?.worktreeId ?? null,
    oldestVisitedWorktreeExpectedCold: true,
  };
}

async function runScopeResidency({ page, app, electronApp, tasks, fixture }) {
  const labWindowStartedAt = new Date().toISOString();
  await openMainPage(page);
  await app.selectWorktree(fixture.neutralWorktreeId, NO_ACTIVITY_RAIL);
  await nextPaint(page);
  await delay(250);

  const baseline = await scopeResidencySampleMainHeap(electronApp, 'baseline');
  for (const worktree of fixture.worktrees) {
    await recordTask(
      tasks,
      'scope_residency_visit',
      async () => {
        await app.selectWorktree(worktree.worktreeId, NO_ACTIVITY_RAIL);
        await scopeResidencyWaitForActiveChat(page, worktree);
      },
      { worktreeId: worktree.worktreeId, chatId: worktree.activeChatId },
    );
  }

  await app.selectWorktree(fixture.neutralWorktreeId, NO_ACTIVITY_RAIL);
  await nextPaint(page);
  const loaded = await scopeResidencySampleMainHeap(electronApp, 'loaded');
  const warmChats = await scopeResidencyReadWarmChats(
    electronApp,
    page,
    fixture,
  );

  await delay(SCOPE_RESIDENCY_IDLE_WAIT_MS);
  const idle = await scopeResidencySampleMainHeap(electronApp, 'idle');
  const scopesAfterIdle = await scopeResidencyReadScopes(electronApp);

  const firstWorktree = fixture.worktrees[0];
  await recordTask(
    tasks,
    'scope_residency_cold_return',
    async () => {
      await app.selectWorktree(firstWorktree.worktreeId, NO_ACTIVITY_RAIL);
      await scopeResidencyWaitForActiveChat(page, firstWorktree);
    },
    {
      worktreeId: firstWorktree.worktreeId,
      chatId: firstWorktree.activeChatId,
    },
  );
  const coldReturnMs = tasks.at(-1).durationMs;

  await app.selectWorktree(fixture.neutralWorktreeId, NO_ACTIVITY_RAIL);
  await nextPaint(page);
  await recordTask(
    tasks,
    'scope_residency_warm_return',
    async () => {
      await app.selectWorktree(firstWorktree.worktreeId, NO_ACTIVITY_RAIL);
      await scopeResidencyWaitForActiveChat(page, firstWorktree);
    },
    {
      worktreeId: firstWorktree.worktreeId,
      chatId: firstWorktree.activeChatId,
    },
  );
  const warmReturnMs = tasks.at(-1).durationMs;
  tasks.timings.scope_residency = {
    cold_return_ms: coldReturnMs,
    warm_return_ms: warmReturnMs,
  };

  const retainedAfterVisitsBytes =
    loaded.medianUsedBytes - baseline.medianUsedBytes;
  const retainedAfterIdleBytes =
    idle.medianUsedBytes - baseline.medianUsedBytes;
  const releasedByIdleBytes = loaded.medianUsedBytes - idle.medianUsedBytes;
  tasks.extraWork.scopeResidency = {
    retainedAfterIdleBytes,
    retainedAfterVisitsBytes,
    idleMedianUsedBytes: idle.medianUsedBytes,
  };

  return {
    worktreesSeeded: fixture.worktrees.length,
    worktreesVisited: fixture.worktrees.length,
    fixtureDigest: fixture.fixtureDigest,
    fixtureDimensions: fixture.dimensions,
    idleUnloadMs: fixture.idleUnloadMs,
    idleWaitMs: SCOPE_RESIDENCY_IDLE_WAIT_MS,
    warmChats,
    scopesAfterIdle,
    mainHeap: {
      baseline,
      loaded,
      idle,
      retainedAfterVisitsBytes,
      retainedAfterIdleBytes,
      releasedByIdleBytes,
    },
    coldReturnMs,
    warmReturnMs,
    labWindow: {
      startedAt: labWindowStartedAt,
      endedAt: new Date().toISOString(),
    },
  };
}

async function openFileSearchPaletteFor(page, app, worktree) {
  await app.selectWorktree(worktree.id, NO_ACTIVITY_RAIL);
  const startedAt = performance.now();
  await page.keyboard.press(
    `${process.platform === 'darwin' ? 'Meta' : 'Control'}+P`,
  );
  const palette = page.getByTestId('file-search-palette');
  await expect(palette).toBeVisible({ timeout: 30_000 });
  await expect(
    palette.getByTestId('file-search-palette-result').first(),
  ).toBeVisible({ timeout: 60_000 });
  const openMs = performance.now() - startedAt;

  // Search for a known corpus entry as well as waiting for a visible result:
  // this proves that this worktree's file index contains the seeded corpus.
  await palette
    .getByTestId('file-search-palette-input')
    .fill('index-file-09999.txt');
  await expect(
    palette
      .getByTestId('file-search-palette-result')
      .filter({ hasText: 'index-file-09999.txt' }),
  ).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press('Escape');
  await expect(palette).toBeHidden();
  return openMs;
}

async function runManyWorktreeFileIndex({ page, app, fixture }) {
  await openMainPage(page);
  const labWindowStartedAt = new Date().toISOString();
  // A worktree's first diff stats arrive after its first visit and drop its
  // file index. Field worktrees already have theirs, so warm every worktree
  // once and measure the second pass, whose indexes nothing else drops.
  for (const worktree of fixture.worktrees) {
    await openFileSearchPaletteFor(page, app, worktree);
  }
  const paletteOpenDurationsMs = [];
  for (const worktree of fixture.worktrees) {
    paletteOpenDurationsMs.push(
      await openFileSearchPaletteFor(page, app, worktree),
    );
  }
  const labWindowEndedAt = new Date().toISOString();
  return buildManyWorktreeFileIndexCounters({
    ...fixture,
    paletteOpenDurationsMs,
    labWindow: {
      startedAt: labWindowStartedAt,
      endedAt: labWindowEndedAt,
    },
  });
}

async function prepareMultiChatStreaming(userDataDir, config, { sequential }) {
  const seed = seedWorkspace(userDataDir);
  const chats = multiChatStreamingChats(config);
  seedPreexistingWorktrees(userDataDir, chats.length, seed);
  const workspaceDir = path.join(userDataDir, 'workspaces', WORKSPACE_ID);
  const mainWorktreePath = seed.workspaces[0]?.worktreePath;
  if (!mainWorktreePath) {
    throw new Error('Multi-chat streaming fixture has no default Git worktree');
  }
  const runtimeDir = path.join(userDataDir, 'perf-multi-chat-streaming');
  const codexScriptDir = path.join(runtimeDir, 'codex-scripts');
  mkdirSync(codexScriptDir, { recursive: true });
  const gateScriptPath = path.join(runtimeDir, 'gate.sh');
  writeFileSync(gateScriptPath, MULTI_CHAT_GATE_SCRIPT, { mode: 0o755 });
  // One read of this file is a tool result above the 64 KiB inline limit, so
  // chat storage externalizes it as an artifact.
  const largeOutputPath = path.join(runtimeDir, 'large-output.txt');
  const lineBytes = 72;
  const lines = Math.ceil(
    config.multiChatStreamingLargeOutputBytes / lineBytes,
  );
  writeFileSync(
    largeOutputPath,
    Array.from(
      { length: lines },
      (_, index) =>
        `large output line ${String(index).padStart(5, '0')} ${'r'.repeat(lineBytes - 26)}`,
    ).join('\n'),
    'utf8',
  );
  const codexStatePath = path.join(runtimeDir, 'codex-state.json');
  writeFileSync(
    codexStatePath,
    JSON.stringify({ nextThread: 1, nextTurn: 1, threads: {} }),
    'utf8',
  );
  const gateMode = sequential
    ? 'manual'
    : `auto ${config.multiChatStreamingToolIntervalMs / 1_000}`;
  const prepared = [];
  for (const chat of chats) {
    const worktreePath =
      chat.worktreeId === WORKTREE_ID
        ? mainWorktreePath
        : path.join(workspaceDir, 'worktrees', chat.worktreeId);
    const gateDir = path.join(runtimeDir, 'gates', chat.key);
    writeGateDirectory(gateDir, gateMode);
    seedWorktreeChat({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: chat.worktreeId,
      providerType: chat.providerType,
      activeTabId: chat.chatId,
      tabs: [
        {
          id: chat.chatId,
          title: `${chat.providerType === 'claude' ? 'Claude' : 'Codex'} stream ${chat.index}`,
          providerType: chat.providerType,
          // Deterministic gate and read tools run without approval prompts.
          approvalMode: 'full-access',
          ...(chat.providerType === 'codex' ? { model: 'gpt-5.4' } : {}),
        },
      ],
    });
    if (chat.providerType === 'claude') {
      const conversation = buildMultiChatClaudeConversation({
        chat,
        config,
        gateScriptPath,
        gateDir,
        largeOutputPath,
      });
      await registerScenario(PERFORMANCE_MOCK_BASE_URL, chat.marker, {
        llm: conversation.llm,
      });
      prepared.push({
        ...chat,
        worktreePath,
        gateDir,
        stepCount: conversation.stepCount,
        largeOutputSteps: conversation.largeOutputSteps,
      });
    } else {
      const script = buildMultiChatCodexScript({
        chat,
        config,
        gateDir,
        cwd: worktreePath,
      });
      writeFileSync(
        path.join(codexScriptDir, `${chat.marker}.json`),
        JSON.stringify({
          marker: script.marker,
          gateDir: script.gateDir,
          chunks: script.chunks,
        }),
        'utf8',
      );
      prepared.push({
        ...chat,
        worktreePath,
        gateDir,
        chunkCount: script.chunks.length,
        brackets: script.brackets,
        longCommandOutputBytes: script.longCommandOutputBytes,
        quickCommands: script.quickCommands,
      });
    }
  }
  return {
    sequential,
    chats: prepared,
    runtimeDir,
    largeOutputBytes: statSync(largeOutputPath).size,
    launchEnv: {
      CODEX_EXECUTABLE: fileURLToPath(
        new URL(
          '../electron/fixtures/fake-codex-app-server.mjs',
          import.meta.url,
        ),
      ),
      CANOPY_E2E_CODEX_STATE_PATH: codexStatePath,
      CANOPY_E2E_CODEX_CANONICAL_HOME: runtimeDir,
      CANOPY_E2E_CODEX_MODE: 'perf-script',
      CANOPY_E2E_CODEX_PERF_SCRIPT_DIR: codexScriptDir,
    },
  };
}

async function worktreeActiveTurnCount(page, worktreeId) {
  return page.evaluate(
    async ({ workspaceId, targetWorktreeId }) => {
      const result = await window.api.chat.activeSessions({
        projectId: workspaceId,
        worktreeId: targetWorktreeId,
      });
      return (result.sessions ?? []).filter((session) => session.turnActive)
        .length;
    },
    { workspaceId: WORKSPACE_ID, targetWorktreeId: worktreeId },
  );
}

async function waitForGateFile(filePath, timeoutMs, label) {
  await waitUntil(() => existsSync(filePath), {
    timeoutMs,
    label,
    intervalMs: 10,
  });
}

async function sendMultiChatStreamingMessage({ page, app, chat }) {
  await app.selectWorktree(chat.worktreeId, NO_ACTIVITY_RAIL);
  const panel = chatPanelForTab(page, chat.chatId);
  await expect(panel).toBeVisible({ timeout: 30_000 });
  const userMessage = `[${chat.marker}] Stream the ${chat.providerType} workload for ${chat.key}.`;
  const composer = panel
    .locator('[data-chat-composer-root]')
    .getByRole('textbox')
    .first();
  await expect(composer).toBeVisible({ timeout: 30_000 });
  await composer.fill(userMessage);
  await panel.getByRole('button', { name: 'Send message' }).click();
  await expect(panel.getByText(userMessage).first()).toBeVisible({
    timeout: 30_000,
  });
  return panel;
}

function multiChatStreamingCounters(fixture, extra = {}) {
  const claude = fixture.chats.filter((chat) => chat.providerType === 'claude');
  const codex = fixture.chats.filter((chat) => chat.providerType === 'codex');
  return {
    variant: fixture.sequential ? 'sequential' : 'concurrent',
    worktrees: fixture.chats.length,
    claudeChats: claude.length,
    codexChats: codex.length,
    claudeStepsPerChat: claude[0]?.stepCount ?? 0,
    claudeLargeOutputReads: claude.reduce(
      (total, chat) => total + chat.largeOutputSteps.length,
      0,
    ),
    largeOutputFileBytes: fixture.largeOutputBytes,
    codexChunksPerChat: codex[0]?.chunkCount ?? 0,
    codexQuickCommandsPerChat: codex[0]?.quickCommands ?? 0,
    codexLongCommandOutputBytes: codex[0]?.longCommandOutputBytes ?? 0,
    ...extra,
  };
}

async function countActiveMultiChatTurns(page, chats) {
  const activeCounts = await Promise.all(
    chats.map((chat) => worktreeActiveTurnCount(page, chat.worktreeId)),
  );
  return activeCounts.filter((count) => count > 0).length;
}

async function readMultiChatDeliveredCounts(page, chats) {
  return Promise.all(
    chats.map((chat) =>
      page.evaluate(
        async ({
          projectId,
          worktreeId,
          chatId,
          chatKey,
          marker,
          providerType,
        }) => {
          const result = await window.api.chat.loadTabs({
            projectId,
            worktreeId,
          });
          const tab = (result.tabs ?? []).find(
            (candidate) => candidate.id === chatId,
          );
          const assistantMessages = (tab?.messages ?? []).filter(
            (message) => message.role === 'assistant',
          );
          const assistantTexts = assistantMessages.flatMap((message) =>
            message.blocks
              .filter((block) => block.type === 'text')
              .map((block) => block.text),
          );
          return {
            chatKey,
            worktreeId,
            providerType,
            assistantMessages: assistantMessages.length,
            deliveredSteps: assistantTexts.filter((value) =>
              value.includes(`${chatKey} step `),
            ).length,
            finalMarkerDelivered: assistantTexts.some((value) =>
              value.includes(`${marker} complete.`),
            ),
          };
        },
        {
          projectId: WORKSPACE_ID,
          worktreeId: chat.worktreeId,
          chatId: chat.chatId,
          chatKey: chat.key,
          marker: chat.marker,
          providerType: chat.providerType,
        },
      ),
    ),
  );
}

const CHAT_SWITCH_LOADING_PROBE_KEY =
  '__CANOPY_PERFORMANCE_CHAT_SWITCH_LOADING_PROBE__';

/** Sample the active desktop transcript-page loading indicator once per frame. */
async function startChatSwitchLoadingIndicatorProbe(page, chatId) {
  await page.evaluate(
    ({ probeKey, panelId }) => {
      if (window[probeKey]) {
        throw new Error('Chat-switch loading-frame probe is already active');
      }
      const probe = {
        framesPresent: 0,
        stopped: false,
        frameId: null,
      };
      const selector = '[data-testid="chat-transcript-loading-spinner"]';
      const sample = () => {
        if (probe.stopped) return;
        const panel = Array.from(
          document.querySelectorAll(
            '[data-testid="panel-content-chat"][data-panel-id]',
          ),
        ).find(
          (candidate) => candidate.getAttribute('data-panel-id') === panelId,
        );
        const indicator = panel?.querySelector(selector);
        if (indicator) {
          const bounds = indicator.getBoundingClientRect();
          const style = getComputedStyle(indicator);
          if (
            bounds.width > 0 &&
            bounds.height > 0 &&
            style.display !== 'none' &&
            style.visibility !== 'hidden'
          ) {
            probe.framesPresent += 1;
          }
        }
        probe.frameId = requestAnimationFrame(sample);
      };
      window[probeKey] = probe;
      probe.frameId = requestAnimationFrame(sample);
    },
    {
      probeKey: CHAT_SWITCH_LOADING_PROBE_KEY,
      panelId: `panel-chat-${chatId}`,
    },
  );
}

/** Always returns a numeric frame count, including zero when no loader appeared. */
async function stopChatSwitchLoadingIndicatorProbe(page) {
  return page.evaluate((probeKey) => {
    const probe = window[probeKey];
    if (!probe) return 0;
    probe.stopped = true;
    if (probe.frameId !== null) cancelAnimationFrame(probe.frameId);
    delete window[probeKey];
    return Number.isSafeInteger(probe.framesPresent) ? probe.framesPresent : 0;
  }, CHAT_SWITCH_LOADING_PROBE_KEY);
}

async function settleChatSwitchProviderStep({
  page,
  electronApp,
  before,
  label,
  timeoutMs = 30_000,
}) {
  await requireQuiescence(
    {
      readSignature: () => readChatActivity(electronApp, page),
      ready: (current) =>
        Number.isFinite(current.events) && current.events > before.events,
      timeoutMs,
    },
    label,
  );
  await nextPaint(page);
  const settled = await readChatActivity(electronApp, page);
  return Math.max(0, settled.events - before.events);
}

async function releaseChatSwitchProviderStep({
  page,
  electronApp,
  chat,
  stepIndex,
  timeoutMs = 60_000,
}) {
  const before = await readChatActivity(electronApp, page);
  writeFileSync(path.join(chat.gateDir, `release-${stepIndex}`), '', 'utf8');
  await waitForGateFile(
    path.join(chat.gateDir, `waiting-${stepIndex + 1}`),
    timeoutMs,
    `${chat.key} step ${stepIndex + 1} to reach its gate`,
  );
  const events = await settleChatSwitchProviderStep({
    page,
    electronApp,
    before,
    timeoutMs,
    label: `${chat.key} step ${stepIndex + 1} to commit before the next gate`,
  });
  return { stepIndex: stepIndex + 1, events };
}

async function waitForMultiChatStreamsComplete(page, fixture, timeoutMs) {
  await waitUntil(
    async () => {
      for (const chat of fixture.chats) {
        if ((await worktreeActiveTurnCount(page, chat.worktreeId)) > 0) {
          return false;
        }
        const finished =
          chat.providerType === 'claude'
            ? existsSync(
                path.join(chat.gateDir, `waiting-${chat.stepCount - 1}`),
              )
            : existsSync(path.join(chat.gateDir, 'done'));
        if (!finished) return false;
      }
      return true;
    },
    {
      timeoutMs,
      label: 'every multi-chat stream to finish its script',
      intervalMs: 250,
    },
  );
}

async function runMultiChatStreaming({ page, app, config, tasks, fixture }) {
  await openMainPage(page);
  for (const chat of fixture.chats) {
    await recordTask(
      tasks,
      'start_multi_chat_stream',
      async () => {
        await sendMultiChatStreamingMessage({ page, app, chat });
        await waitUntil(
          () =>
            worktreeActiveTurnCount(page, chat.worktreeId).then(
              (count) => count > 0,
            ),
          { timeoutMs: 60_000, label: `${chat.key} turn to start` },
        );
      },
      { chat: chat.index, providerType: chat.providerType },
    );
  }

  // A passive bracket while every chat streams and the last one is visible.
  await recordStreamedReply(tasks, 'multi_chat_streaming_observe', () =>
    recordTask(
      tasks,
      'observe_multi_chat_streaming',
      () => delay(Math.min(5_000, config.multiChatStreamingMs / 4)),
      { chats: fixture.chats.length },
    ),
  );

  const probeTabId = await createResponsivenessChat(page, tasks);
  let interactionsWithActiveTurns = 0;
  for (let index = 0; index < config.interactionIterations; index += 1) {
    const active = await worktreeActiveTurnCount(
      page,
      fixture.chats.at(-1).worktreeId,
    );
    if (active > 0) interactionsWithActiveTurns += 1;
    await recordResponsiveTask(
      tasks,
      'type_during_multi_chat_streaming',
      () =>
        typeDraftAndWaitForPaint(page, {
          scenario: 'multi-chat-streaming',
          iteration: index + 1,
          characters: config.typingCharacters,
        }),
      { iteration: index + 1, characters: config.typingCharacters },
      config.responsivenessBudgetMs,
    );
    await recordResponsiveTask(
      tasks,
      'navigate_during_multi_chat_streaming',
      async () => {
        const other = fixture.chats[index % (fixture.chats.length - 1)];
        await app.selectWorktree(other.worktreeId, NO_ACTIVITY_RAIL);
        await expect(chatPanelForTab(page, other.chatId)).toBeVisible({
          timeout: 30_000,
        });
        await nextPaint(page);
        await app.selectWorktree(
          fixture.chats.at(-1).worktreeId,
          NO_ACTIVITY_RAIL,
        );
        const probeTab = page.getByTestId(probeTabId);
        await probeTab.click();
        await expect(probeTab).toHaveAttribute('aria-selected', 'true');
        await nextPaint(page);
      },
      { iteration: index + 1 },
      config.responsivenessBudgetMs,
    );
  }
  if (interactionsWithActiveTurns === 0) {
    throw new Error(
      'Multi-chat streams completed before any responsiveness interaction ran',
    );
  }

  await recordTask(tasks, 'all_multi_chat_streams_complete', () =>
    waitForMultiChatStreamsComplete(
      page,
      fixture,
      config.multiChatStreamingMs * 4 + 300_000,
    ),
  );
  return multiChatStreamingCounters(fixture, { interactionsWithActiveTurns });
}

async function runBackgroundStreaming({
  page,
  app,
  electronApp,
  config,
  tasks,
  fixture,
}) {
  if (fixture.chats.length < 4) {
    throw new Error(
      'Background streaming requires at least four provider chats',
    );
  }
  await openMainPage(page);
  for (const chat of fixture.chats) {
    await recordTask(
      tasks,
      'start_background_stream',
      async () => {
        // `--cold-background-streams` never opens a stream's chat, so none is
        // focused or warm in the window's declared interest.
        await (config.backgroundStreamingColdStart === true
          ? sendMultiChatStreamingMessageWithoutSelecting({ page, chat })
          : sendMultiChatStreamingMessage({ page, app, chat }));
        await waitUntil(
          () =>
            worktreeActiveTurnCount(page, chat.worktreeId).then(
              (count) => count > 0,
            ),
          { timeoutMs: 60_000, label: `${chat.key} background turn to start` },
        );
      },
      { chat: chat.index, providerType: chat.providerType },
    );
  }

  // The composer path leaves the last stream's worktree selected; the cold
  // path selects it too, so the observer chat opens in the same place.
  if (config.backgroundStreamingColdStart === true) {
    await app.selectWorktree(fixture.chats.at(-1).worktreeId, NO_ACTIVITY_RAIL);
  }
  // Keep a different chat surface visible while all provider-backed workload
  // chats continue. `createResponsivenessChat` uses the existing UI path and
  // does not send a message or inject provider events.
  const observerTabId = await createResponsivenessChat(page, tasks);
  await expect(page.getByTestId(observerTabId)).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await nextPaint(page);
  const idleWorktreeId = fixture.chats.at(-1).worktreeId;
  if ((await worktreeActiveTurnCount(page, idleWorktreeId)) === 0) {
    throw new Error(
      'The final worktree stream finished before the focused idle-chat typing probe',
    );
  }
  const typingProbe = await recordResponsiveTask(
    tasks,
    'type_in_idle_chat_during_background_streaming',
    () =>
      typeDraftAndWaitForPaint(page, {
        scenario: 'background-streaming',
        iteration: 1,
        characters: config.typingCharacters,
      }),
    { idleWorktreeId, streamChatsInWorktree: 1 },
    config.responsivenessBudgetMs,
  );
  const hiddenBaseline = await readChatActivity(electronApp, page);
  if (!Number.isFinite(hiddenBaseline.events)) {
    throw new Error(
      'Provider event counters are unavailable for background streaming',
    );
  }

  const backgroundObservation = await recordTask(
    tasks,
    'observe_background_streaming',
    async () => {
      const activity = await waitUntil(
        async () => {
          const current = await readChatActivity(electronApp, page);
          return current.events > hiddenBaseline.events ? current : false;
        },
        {
          timeoutMs: config.multiChatStreamingMs * 4 + 300_000,
          label:
            'provider events to continue while multi-chat panels are hidden',
          intervalMs: 25,
        },
      );
      const activeChats = await countActiveMultiChatTurns(page, fixture.chats);
      if (activeChats === 0) {
        throw new Error(
          'Background provider events arrived only after every stream had completed',
        );
      }
      return {
        providerEvents: activity.events - hiddenBaseline.events,
        activeChats,
      };
    },
    { hiddenChats: fixture.chats.length },
  );

  await recordTask(tasks, 'all_background_streams_complete', () =>
    waitForMultiChatStreamsComplete(
      page,
      fixture,
      config.multiChatStreamingMs * 4 + 300_000,
    ),
  );
  // `loadTabs` returns messages only for each worktree's active tab, and the
  // observer tab hid the idle worktree's stream; show it again before reading.
  const idleWorktreeStream = fixture.chats.at(-1);
  await page
    .getByTestId(`panel-tab-panel-chat-${idleWorktreeStream.chatId}`)
    .click();
  await waitUntil(
    async () =>
      (await readMultiChatDeliveredCounts(page, [idleWorktreeStream]))[0]
        .finalMarkerDelivered,
    {
      timeoutMs: 30_000,
      label: `${idleWorktreeStream.key} messages to load once its tab is active`,
    },
  );
  const perChatDeliveredCounts = await readMultiChatDeliveredCounts(
    page,
    fixture.chats,
  );
  for (const counts of perChatDeliveredCounts) {
    if (counts.assistantMessages === 0 || !counts.finalMarkerDelivered) {
      throw new Error(
        `Background stream ${counts.chatKey} did not deliver its final assistant marker`,
      );
    }
  }
  return multiChatStreamingCounters(fixture, {
    hiddenChats: fixture.chats.length,
    providerEventsWhileHidden: backgroundObservation.providerEvents,
    activeChatsWhenObserved: backgroundObservation.activeChats,
    perChatDeliveredCounts,
    typingProbe: {
      characters: typingProbe.characters,
      keyboardDispatchMs: typingProbe.performanceTaskMetrics.keyboardDispatchMs,
      textCommitMs: typingProbe.performanceTaskMetrics.textCommitMs,
      typingBurstMs: typingProbe.performanceTaskMetrics.typingBurstMs,
    },
    idleWorktreeId,
    observerTabCreated: true,
  });
}

/** The final reply is caught up once its marker is on screen and painted. */
async function assertChatSwitchFinalTextVisible(page, panel, chat) {
  await expect(
    panel.getByText(`${chat.marker} complete.`).last(),
  ).toBeInViewport({ timeout: 60_000 });
  await nextPaint(page);
}

async function finishChatSwitchStreamWhileHidden({
  page,
  chat,
  nextGateIndex,
  timeoutMs,
}) {
  for (
    let stepIndex = nextGateIndex;
    stepIndex < chat.stepCount;
    stepIndex += 1
  ) {
    writeFileSync(path.join(chat.gateDir, `release-${stepIndex}`), '', 'utf8');
  }
  await waitUntil(
    () =>
      worktreeActiveTurnCount(page, chat.worktreeId).then(
        (count) => count === 0,
      ),
    {
      timeoutMs,
      label: `${chat.key} provider turn to finish while hidden`,
      intervalMs: 100,
    },
  );
  const [deliveredCounts] = await readMultiChatDeliveredCounts(page, [chat]);
  if (!deliveredCounts.finalMarkerDelivered) {
    throw new Error(
      `${chat.key} completed without persisting its final mock response marker`,
    );
  }
  return deliveredCounts;
}

async function sendMultiChatStreamingMessageWithoutSelecting({ page, chat }) {
  const text = `[${chat.marker}] Stream the ${chat.providerType} workload for ${chat.key}.`;
  // This is the same supported chat IPC used by product callers and other
  // Electron specs. It dispatches a real provider request to the seeded chat;
  // it does not forge provider events or select the target worktree.
  await page.evaluate(async (request) => window.api.chat.sendMessage(request), {
    projectId: WORKSPACE_ID,
    worktreeId: chat.worktreeId,
    chatId: chat.chatId,
    userMessageId: `performance-${chat.chatId}-user-message`,
    text,
    providerType: chat.providerType,
    model: chat.providerType === 'codex' ? 'gpt-5.4' : 'sonnet',
    approvalMode: 'full_access',
  });
}

async function measureChatSwitchCatchUpReturn({
  page,
  app,
  tasks,
  chat,
  catchUpEvents,
  kind,
  hoverMs,
}) {
  const taskKind = `${kind}_chat_switch_catch_up`;
  const panel = chatPanelForTab(page, chat.chatId);
  if (hoverMs) {
    // A user's dwell before the click, outside the timed window. React
    // derives pointer enter from `pointerover`, as from a real pointer.
    await page
      .locator(
        `[data-testid="worktree-row"][data-worktree-id="${chat.worktreeId}"]`,
      )
      .first()
      .dispatchEvent('pointerover');
    await delay(hoverMs);
  }
  await startChatSwitchLoadingIndicatorProbe(page, chat.chatId);
  let loadingIndicatorFrames = 0;
  let clickToShellMs = null;
  let clickToLatestFinalTextMs = null;
  try {
    await recordTask(
      tasks,
      taskKind,
      async () => {
        // Inside the task, so recordTask's pre-task sampling stays untimed.
        const clickStartedAt = performance.now();
        await app.selectWorktree(chat.worktreeId, NO_ACTIVITY_RAIL);
        await expect(panel).toBeVisible({ timeout: 30_000 });
        await nextPaint(page);
        clickToShellMs = performance.now() - clickStartedAt;
        tasks.timings[`${kind}_click_to_shell_ms`] = clickToShellMs;
        await assertChatSwitchFinalTextVisible(page, panel, chat);
        clickToLatestFinalTextMs = performance.now() - clickStartedAt;
        tasks.timings[`${kind}_click_to_latest_final_text_ms`] =
          clickToLatestFinalTextMs;
      },
      {
        providerType: chat.providerType,
        worktreeId: chat.worktreeId,
        catchUpEvents,
      },
    );
  } finally {
    loadingIndicatorFrames = await stopChatSwitchLoadingIndicatorProbe(page);
    const task = tasks.at(-1);
    if (task?.kind === taskKind) {
      // The active desktop page loader may never appear during a warm render;
      // retain an explicit numeric zero in that case.
      task.loadingIndicatorFrames = loadingIndicatorFrames;
    }
  }

  const task = tasks.at(-1);
  if (task?.kind !== taskKind || task.status !== 'ok') {
    throw new Error(`Could not record ${kind} chat-switch catch-up timing`);
  }
  const transcriptPageCounters = chatSwitchTranscriptPageCounters(task);
  task.transcriptPageCounters = transcriptPageCounters;
  return {
    clickToShellMs,
    clickToLatestFinalTextMs,
    loadingIndicatorFrames,
    transcriptPageCounters,
  };
}

async function runChatSwitchCatchUp({
  page,
  app,
  electronApp,
  config,
  tasks,
  fixture,
}) {
  const plan = buildChatSwitchCatchUpPlan(config, fixture.chats);
  const { warmChat, coldChat } = plan;
  if (!fixture.sequential) {
    throw new Error('Chat-switch catch-up requires sequential provider gates');
  }
  const observer = fixture.chats.find(
    (candidate) => candidate.chatId !== warmChat.chatId,
  );
  if (!observer) {
    throw new Error('Chat-switch catch-up fixture needs an observer chat');
  }

  await openMainPage(page);
  const warmPanel = chatPanelForTab(page, warmChat.chatId);
  const warmStart = await readChatActivity(electronApp, page);
  let warmForegroundEvents = 0;
  await recordTask(
    tasks,
    'start_warm_chat_switch_catch_up_stream',
    async () => {
      await sendMultiChatStreamingMessage({ page, app, chat: warmChat });
      await waitForGateFile(
        path.join(warmChat.gateDir, 'waiting-0'),
        60_000,
        `${warmChat.key} foreground provider step to reach its gate`,
      );
      warmForegroundEvents = await settleChatSwitchProviderStep({
        page,
        electronApp,
        before: warmStart,
        label: `${warmChat.key} foreground assistant step to commit`,
      });
      await expect(warmPanel).toContainText(`${warmChat.key} step 0:`, {
        timeout: 30_000,
      });
    },
    { providerType: warmChat.providerType, worktreeId: warmChat.worktreeId },
  );

  // Warm B is selected first, then hidden behind A. Releasing each Claude
  // gate separately makes the next assistant step commit while B is hidden.
  await app.selectWorktree(observer.worktreeId, NO_ACTIVITY_RAIL);
  const observerPanel = chatPanelForTab(page, observer.chatId);
  await expect(observerPanel).toBeVisible({ timeout: 30_000 });
  await expect(warmPanel).toBeHidden();
  await nextPaint(page);
  const warmCommittedEvents = [];
  for (const hiddenStepIndex of plan.warmHiddenStepIndexes) {
    const gateIndex = hiddenStepIndex - 1;
    const committed = await recordTask(
      tasks,
      'commit_warm_hidden_chat_step',
      () =>
        releaseChatSwitchProviderStep({
          page,
          electronApp,
          chat: warmChat,
          stepIndex: gateIndex,
        }),
      { chatKey: warmChat.key, hiddenStepIndex },
    );
    warmCommittedEvents.push(committed.events);
  }
  const warmDelivered = (
    await readMultiChatDeliveredCounts(page, [warmChat])
  )[0];
  if (warmDelivered.deliveredSteps < plan.warmHiddenStepIndexes.length + 1) {
    throw new Error(
      `${warmChat.key} persisted ${warmDelivered.deliveredSteps} stream steps; expected the foreground step plus ${plan.warmHiddenStepIndexes.length} hidden steps`,
    );
  }
  const timeoutMs = config.multiChatStreamingMs * 4 + 300_000;
  const warmFinalDelivered = await recordTask(
    tasks,
    'finish_warm_chat_while_hidden',
    () =>
      finishChatSwitchStreamWhileHidden({
        page,
        chat: warmChat,
        nextGateIndex: plan.warmHiddenStepIndexes.length,
        timeoutMs,
      }),
    { chatKey: warmChat.key, finalMarkerRequiredBeforeSwitch: true },
  );
  const warmCatchUp = await measureChatSwitchCatchUpReturn({
    page,
    app,
    tasks,
    chat: warmChat,
    catchUpEvents: plan.warmHiddenStepIndexes.length,
    kind: 'warm',
    hoverMs: config.chatSwitchHoverMs,
  });

  // Cold B is started through normal chat IPC while A stays selected. Its
  // worktree is never selected before the measured first return.
  await app.selectWorktree(observer.worktreeId, NO_ACTIVITY_RAIL);
  await expect(observerPanel).toBeVisible({ timeout: 30_000 });
  await expect(chatPanelForTab(page, coldChat.chatId)).toBeHidden();
  await nextPaint(page);
  const coldStart = await readChatActivity(electronApp, page);
  let coldFirstCommitEvents = 0;
  await recordTask(
    tasks,
    'start_cold_chat_switch_catch_up_stream_without_selecting',
    async () => {
      await sendMultiChatStreamingMessageWithoutSelecting({
        page,
        chat: coldChat,
      });
      await waitForGateFile(
        path.join(coldChat.gateDir, 'waiting-0'),
        60_000,
        `${coldChat.key} cold provider step to reach its first gate`,
      );
      coldFirstCommitEvents = await settleChatSwitchProviderStep({
        page,
        electronApp,
        before: coldStart,
        label: `${coldChat.key} first hidden assistant step to commit`,
      });
      await expect(observerPanel).toBeVisible();
      await expect(chatPanelForTab(page, coldChat.chatId)).toBeHidden();
    },
    { providerType: coldChat.providerType, worktreeId: coldChat.worktreeId },
  );

  const coldCommittedEvents = [coldFirstCommitEvents];
  // Step zero has already committed behind A. Release only the preceding gate
  // for each remaining hidden step, requiring provider counter quiescence and
  // a renderer paint before continuing to the next gate.
  for (const hiddenStepIndex of plan.coldHiddenStepIndexes.slice(1)) {
    const committed = await recordTask(
      tasks,
      'commit_cold_hidden_chat_step',
      () =>
        releaseChatSwitchProviderStep({
          page,
          electronApp,
          chat: coldChat,
          stepIndex: hiddenStepIndex - 1,
        }),
      { chatKey: coldChat.key, hiddenStepIndex },
    );
    coldCommittedEvents.push(committed.events);
  }
  const coldDelivered = (
    await readMultiChatDeliveredCounts(page, [coldChat])
  )[0];
  if (coldDelivered.deliveredSteps < plan.coldHiddenStepIndexes.length) {
    throw new Error(
      `${coldChat.key} persisted ${coldDelivered.deliveredSteps} stream steps; expected ${plan.coldHiddenStepIndexes.length} hidden steps`,
    );
  }
  const coldFinalDelivered = await recordTask(
    tasks,
    'finish_cold_chat_while_unselected',
    () =>
      finishChatSwitchStreamWhileHidden({
        page,
        chat: coldChat,
        nextGateIndex: plan.coldHiddenStepIndexes.length - 1,
        timeoutMs,
      }),
    { chatKey: coldChat.key, worktreeSelectedBeforeFinish: false },
  );
  const coldCatchUp = await measureChatSwitchCatchUpReturn({
    page,
    app,
    tasks,
    chat: coldChat,
    catchUpEvents: plan.coldHiddenStepIndexes.length,
    kind: 'cold',
    hoverMs: config.chatSwitchHoverMs,
  });

  const loadingIndicatorFrames =
    warmCatchUp.loadingIndicatorFrames + coldCatchUp.loadingIndicatorFrames;
  return multiChatStreamingCounters(fixture, {
    catchUpProvider: 'claude',
    catchUpEventsPerChat: plan.warmHiddenStepIndexes.length,
    warmChatKey: warmChat.key,
    coldChatKey: coldChat.key,
    warmHiddenCommittedProviderEvents: warmCommittedEvents.reduce(
      (total, count) => total + count,
      0,
    ),
    coldHiddenCommittedProviderEvents: coldCommittedEvents.reduce(
      (total, count) => total + count,
      0,
    ),
    warmForegroundProviderEvents: warmForegroundEvents,
    perChatDeliveredCounts: [warmFinalDelivered, coldFinalDelivered],
    warmClickToShellMs: warmCatchUp.clickToShellMs,
    warmClickToLatestFinalTextMs: warmCatchUp.clickToLatestFinalTextMs,
    coldClickToShellMs: coldCatchUp.clickToShellMs,
    coldClickToLatestFinalTextMs: coldCatchUp.clickToLatestFinalTextMs,
    warmTranscriptPageCounters: warmCatchUp.transcriptPageCounters,
    coldTranscriptPageCounters: coldCatchUp.transcriptPageCounters,
    warmLoadingIndicatorFrames: warmCatchUp.loadingIndicatorFrames,
    coldLoadingIndicatorFrames: coldCatchUp.loadingIndicatorFrames,
    loadingIndicatorFrames,
  });
}

async function runMultiChatStreamingSequential({
  page,
  app,
  electronApp,
  tasks,
  fixture,
}) {
  await openMainPage(page);
  let deferredSettles = 0;
  const settleTimeoutMs = 30_000;
  // A step's work is settled once main has ingested at least one of its
  // provider events (`ready`), no counter has moved for the quiet window, no
  // file-system request is in flight in main, and the renderer has painted.
  // A step that does not settle fails the run: its work would spill into the
  // next bracket, and this variant exists for brackets that repeat.
  const settle = async (label, ready, quietMs) => {
    await requireQuiescence(
      {
        readSignature: () => readChatActivity(electronApp, page),
        ready,
        ...(quietMs ? { quietMs } : {}),
        timeoutMs: settleTimeoutMs,
        onDeferred: () => {
          deferredSettles += 1;
        },
      },
      label,
    );
    await nextPaint(page);
  };
  // A turn's end is followed by main's own bookkeeping (queue, search index,
  // chat state), so the last step waits longer for it to land in its bracket.
  const turnEndQuietMs = 500;
  const eventsAfter = (before) => (current) =>
    Number.isFinite(current.events) && current.events > before.events;
  const chunkTimeoutMs = 60_000;
  let releasedChunks = 0;
  const release = async (chat, index, waitFor) => {
    const before = await readChatActivity(electronApp, page);
    writeFileSync(path.join(chat.gateDir, `release-${index}`), '', 'utf8');
    releasedChunks += 1;
    await waitForGateFile(
      waitFor,
      chunkTimeoutMs,
      `${chat.key} chunk ${index} to take effect`,
    );
    await settle(`${chat.key} chunk ${index}`, eventsAfter(before));
  };
  // Chunks between bracket boundaries are grouped into tasks of this size.
  const segmentChunks = 20;

  for (const chat of fixture.chats) {
    await app.selectWorktree(chat.worktreeId, NO_ACTIVITY_RAIL);
    await expect(chatPanelForTab(page, chat.chatId)).toBeVisible({
      timeout: 30_000,
    });
    await settle(`${chat.key} before its turn`);
    await recordStreamedReply(tasks, `sequential_${chat.key}`, async () => {
      await recordTask(
        tasks,
        'start_sequential_chat_turn',
        async () => {
          const before = await readChatActivity(electronApp, page);
          await sendMultiChatStreamingMessage({ page, app, chat });
          await waitForGateFile(
            path.join(
              chat.gateDir,
              chat.providerType === 'claude' ? 'waiting-0' : 'started',
            ),
            chunkTimeoutMs,
            `${chat.key} turn to reach its first gate`,
          );
          await settle(`${chat.key} turn start`, eventsAfter(before));
        },
        { chat: chat.index, providerType: chat.providerType },
      );

      // Every chunk but the last, which ends the turn.
      const lastChunk =
        chat.providerType === 'claude'
          ? chat.stepCount - 1
          : chat.chunkCount - 1;
      const effectOf = (index) =>
        chat.providerType === 'claude'
          ? path.join(chat.gateDir, `waiting-${index + 1}`)
          : path.join(chat.gateDir, `emitted-${index}`);
      const segments = [];
      const brackets = chat.brackets;
      let next = 0;
      const pushRange = (kind, first, last) => {
        for (let start = first; start <= last; start += segmentChunks) {
          segments.push({
            kind,
            first: start,
            last: Math.min(last, start + segmentChunks - 1),
          });
        }
      };
      if (brackets) {
        pushRange('sequential_chat_stream', next, brackets.early[0] - 1);
        segments.push({
          kind: 'codex_output_early',
          first: brackets.early[0],
          last: brackets.early[1],
        });
        pushRange(
          'sequential_chat_stream',
          brackets.early[1] + 1,
          brackets.late[0] - 1,
        );
        segments.push({
          kind: 'codex_output_late',
          first: brackets.late[0],
          last: brackets.late[1],
        });
        next = brackets.late[1] + 1;
      }
      pushRange('sequential_chat_stream', next, lastChunk - 1);
      for (const segment of segments) {
        if (segment.last < segment.first) continue;
        await recordTask(
          tasks,
          segment.kind,
          async () => {
            for (let index = segment.first; index <= segment.last; index += 1) {
              await release(chat, index, effectOf(index));
            }
          },
          {
            chat: chat.index,
            providerType: chat.providerType,
            chunks: segment.last - segment.first + 1,
          },
        );
      }

      await recordTask(
        tasks,
        'complete_sequential_chat_turn',
        async () => {
          const before = await readChatActivity(electronApp, page);
          writeFileSync(
            path.join(chat.gateDir, `release-${lastChunk}`),
            '',
            'utf8',
          );
          releasedChunks += 1;
          await expect(
            chatPanelForTab(page, chat.chatId).getByText(
              `${chat.marker} complete.`,
            ),
          ).toBeAttached({ timeout: chunkTimeoutMs });
          await waitUntil(
            () =>
              worktreeActiveTurnCount(page, chat.worktreeId).then(
                (count) => count === 0,
              ),
            { timeoutMs: chunkTimeoutMs, label: `${chat.key} turn to finish` },
          );
          await settle(
            `${chat.key} turn end`,
            eventsAfter(before),
            turnEndQuietMs,
          );
        },
        { chat: chat.index, providerType: chat.providerType },
      );
    });
  }
  return multiChatStreamingCounters(fixture, {
    releasedChunks,
    // Quiet windows held back because main still had a file-system request
    // in flight or had not ingested the step: each is a step an idle-counter
    // settle alone would have closed too early.
    deferredSettles,
  });
}

async function activeTurnCount(page) {
  return page.evaluate(
    async ({ workspaceId, worktreeId }) => {
      const result = await window.api.chat.activeSessions({
        projectId: workspaceId,
        worktreeId,
      });
      return (result.sessions ?? []).filter((session) => session.turnActive)
        .length;
    },
    { workspaceId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
  );
}

async function scenarioLlmRequestCount(marker, requestTag) {
  const result = await getScenarioActivity(PERFORMANCE_MOCK_BASE_URL, marker);
  return result.activity[`llmRequests:${requestTag}`] ?? 0;
}

export function providerRequestWaitTimeoutMs(config) {
  return config.chatStreamMs + 120_000;
}

export function worktreeSetupSelectionTimeoutMs(config) {
  return config.scriptHoldMs + 60_000;
}

export function countPersistedAssistantReplies(tabs, expectedText) {
  return tabs.reduce(
    (count, tab) =>
      count +
      tab.messages.filter(
        (message) =>
          message.role === 'assistant' &&
          message.blocks.some(
            (block) =>
              block.type === 'text' && block.text.includes(expectedText),
          ),
      ).length,
    0,
  );
}

async function persistedAssistantReplyCount(page, expectedText) {
  const data = await page.evaluate(
    async ({ projectId, worktreeId }) =>
      window.api.chat.loadTabs({ projectId, worktreeId }),
    { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
  );
  return countPersistedAssistantReplies(data.tabs, expectedText);
}

async function startConcurrentChats({ page, config, tasks }) {
  let panel = visibleChatPanel(page);
  await expect(panel).toBeVisible();
  let peakConcurrentTurns = 0;
  const tabIds = [];
  const providerRequests = [];

  for (let index = 0; index < config.concurrentChats; index += 1) {
    const expectedTurns = index + 1;
    let turnActiveMs;
    const activationStartedAt = performance.now();
    const marker = `Canopy-CPERF${index + 1}`;
    const requestTag = `initial-${index + 1}`;
    await recordTask(
      tasks,
      'start_chat_turn',
      async () => {
        const userMessage = `[${marker}] [Canopy-Mock-Request:${requestTag}] Run concurrent performance chat ${index + 1}.`;
        const composer = panel
          .locator('[data-chat-composer-root]')
          .getByRole('textbox')
          .first();
        await composer.fill(userMessage);
        await panel.getByRole('button', { name: 'Send message' }).click();
        await expect(panel.getByText(userMessage).first()).toBeVisible({
          timeout: 30_000,
        });
        await waitUntil(
          () => activeTurnCount(page).then((count) => count >= expectedTurns),
          {
            timeoutMs: 60_000,
            label: `${expectedTurns} active chat turn(s)`,
          },
        );
        turnActiveMs = performance.now() - activationStartedAt;
      },
      { chat: index + 1 },
    );
    Object.assign(tasks.at(-1), { turnActiveMs });
    providerRequests.push({
      chat: index + 1,
      marker,
      requestTag,
      activationStartedAt,
    });

    peakConcurrentTurns = Math.max(
      peakConcurrentTurns,
      await activeTurnCount(page),
    );
    const panelId = await panel.getAttribute('data-panel-id');
    if (!panelId) {
      throw new Error(
        `Could not resolve visible performance chat panel ${index + 1}`,
      );
    }
    const testId = `panel-tab-${panelId}`;
    await expect(page.getByTestId(testId)).toHaveAttribute(
      'aria-selected',
      'true',
    );
    tabIds.push(testId);

    if (index + 1 < config.concurrentChats) {
      const chatTabs = page.locator('[role="tab"][data-panel-kind="chat"]');
      const previousTabCount = await chatTabs.count();
      const previousTabIds = new Set(
        await chatTabs.evaluateAll((tabs) =>
          tabs
            .map((tab) => tab.getAttribute('data-testid'))
            .filter((id) => typeof id === 'string'),
        ),
      );
      let nextTabId;
      await recordTask(
        tasks,
        'create_chat_tab',
        async () => {
          await createFreshChatTab(page);
          await expect(chatTabs).toHaveCount(previousTabCount + 1);
          nextTabId = await waitUntil(
            async () => {
              const ids = await chatTabs.evaluateAll((tabs) =>
                tabs
                  .map((tab) => tab.getAttribute('data-testid'))
                  .filter((id) => typeof id === 'string'),
              );
              return ids.find((id) => !previousTabIds.has(id)) ?? false;
            },
            {
              timeoutMs: 30_000,
              label: `new performance chat tab ${index + 2}`,
            },
          );
        },
        { chat: index + 2 },
      );
      const nextPanelId = panelIdFromTabTestId(nextTabId);
      const nextTab = page.getByTestId(nextTabId);
      await nextTab.click();
      await expect(nextTab).toHaveAttribute('aria-selected', 'true');
      panel = page.locator(
        `[data-testid="panel-content-chat"][data-panel-id=${JSON.stringify(nextPanelId)}]`,
      );
      await expect(panel).toBeVisible({ timeout: 30_000 });
    }
  }

  for (const request of providerRequests) {
    let providerRequestMs;
    await recordTask(
      tasks,
      'wait_for_chat_provider_request',
      async () => {
        await waitUntil(
          () =>
            scenarioLlmRequestCount(request.marker, request.requestTag).then(
              (count) => count >= 1,
            ),
          {
            timeoutMs: providerRequestWaitTimeoutMs(config),
            label: `provider request for performance chat ${request.chat}`,
          },
        );
        providerRequestMs = performance.now() - request.activationStartedAt;
      },
      { chat: request.chat },
    );
    Object.assign(tasks.at(-1), { providerRequestMs });
  }

  return { peakConcurrentTurns, tabIds };
}

export function panelIdFromTabTestId(tabId) {
  const prefix = 'panel-tab-';
  if (!tabId.startsWith(prefix) || tabId.length === prefix.length) {
    throw new Error(`Invalid panel tab test id: ${tabId}`);
  }
  return tabId.slice(prefix.length);
}

export function laterTurnActivationObserved({
  activeTurnCount,
  requestCount,
  requestsBeforeTurn,
}) {
  return activeTurnCount >= 1 || requestCount > requestsBeforeTurn;
}

async function activateLaterForegroundTurn({
  page,
  config,
  tasks,
  tabId,
  chatIndex,
}) {
  if (!tabId) {
    throw new Error('Later foreground activation requires a live chat tab');
  }
  if (!Number.isInteger(chatIndex) || chatIndex < 1) {
    throw new Error('Later foreground activation requires a chat index');
  }
  await recordTask(
    tasks,
    'clear_completion_toasts_before_later_turn',
    async () => {
      const dismissButtons = page
        .getByTestId('toast-card')
        .getByRole('button', { name: 'Dismiss' });
      const dismissedToastCount = await drainTransientItems({
        count: () => dismissButtons.count(),
        dismissFirst: () => dismissButtons.first().click({ timeout: 500 }),
        pause: (delayMs) => page.waitForTimeout(delayMs),
      });
      return {
        performanceTaskMetrics: { dismissedToastCount },
      };
    },
  );
  const tab = page.getByTestId(tabId);
  await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  const panelId = panelIdFromTabTestId(tabId);
  const panel = page.locator(
    `[data-testid="panel-content-chat"][data-panel-id=${JSON.stringify(panelId)}]`,
  );
  await expect(panel).toBeVisible();
  // The established reply can be virtualized off-DOM after navigating through
  // large transcripts. The chat index is fixed when startConcurrentChats
  // records this tab, so keep that explicit identity for the later turn.
  const marker = `Canopy-CPERF${chatIndex}`;
  const requestTag = `later-${chatIndex}`;
  const laterReply = `Later foreground performance reply ${chatIndex}.`;
  const requestsBeforeLaterTurn = await scenarioLlmRequestCount(
    marker,
    requestTag,
  );
  const repliesBeforeLaterTurn = await persistedAssistantReplyCount(
    page,
    laterReply,
  );
  await recordResponsiveTask(
    tasks,
    'activate_later_foreground_chat_turn',
    async () => {
      const activationStartedAt = performance.now();
      await expect(tab).toHaveAttribute('aria-selected', 'true');
      await expect(panel).toBeVisible();
      const composer = panel
        .locator('[data-chat-composer-root]')
        .getByRole('textbox')
        .first();
      const userMessage = `[${marker}] [Canopy-Mock-Request:${requestTag}] Run the later foreground performance turn.`;
      await composer.fill(userMessage);
      const composerFillMs = performance.now() - activationStartedAt;
      const sendButton = panel.getByRole('button', { name: 'Send message' });
      const sendButtonCountBeforeClick = await sendButton.count();
      const sendButtonDisabledBeforeClick =
        sendButtonCountBeforeClick > 0
          ? await sendButton.first().isDisabled()
          : false;
      const stopButtonCountBeforeClick = await panel
        .getByRole('button', { name: /Stop generation/ })
        .count();
      const sendClickStartedAt = performance.now();
      // Background turns can finish after the stable-empty toast drain above
      // and place a clickable completion toast over the composer. Invoke the
      // already-verified enabled control's native click so this task measures
      // application activation latency, not an unrelated overlay's lifetime.
      await sendButton.evaluate((button) => button.click());
      const sendClickMs = performance.now() - sendClickStartedAt;
      await waitUntil(
        async () => {
          const [activeTurns, requestCount] = await Promise.all([
            activeTurnCount(page),
            scenarioLlmRequestCount(marker, requestTag),
          ]);
          return laterTurnActivationObserved({
            activeTurnCount: activeTurns,
            requestCount,
            requestsBeforeTurn: requestsBeforeLaterTurn,
          });
        },
        {
          timeoutMs: 60_000,
          label: 'the later foreground chat turn to activate',
        },
      );
      const turnActiveMs = performance.now() - activationStartedAt;
      await waitUntil(
        () =>
          scenarioLlmRequestCount(marker, requestTag).then(
            (count) => count > requestsBeforeLaterTurn,
          ),
        {
          timeoutMs: providerRequestWaitTimeoutMs(config),
          label: 'provider request for the later foreground chat turn',
        },
      );
      return {
        performanceTaskMetrics: {
          composerFillMs,
          sendButtonCountBeforeClick,
          sendButtonDisabledBeforeClick,
          sendClickMs,
          stopButtonCountBeforeClick,
          turnActiveMs,
          providerRequestMs: performance.now() - activationStartedAt,
        },
      };
    },
    { chat: chatIndex },
    config.responsivenessBudgetMs,
  );
  const activationMs = tasks.at(-1)?.durationMs;
  await recordTask(tasks, 'complete_later_foreground_chat_turn', () =>
    waitUntil(
      async () => {
        if ((await activeTurnCount(page)) !== 0) return false;
        return (
          (await persistedAssistantReplyCount(page, laterReply)) >
          repliesBeforeLaterTurn
        );
      },
      {
        timeoutMs: Math.min(config.chatStreamMs, 1_000) + 120_000,
        label: 'later foreground chat turn to persist its assistant reply',
        intervalMs: 100,
      },
    ),
  );
  return activationMs;
}

async function createResponsivenessChat(page, tasks) {
  const chatTabs = page.locator('[role="tab"][data-panel-kind="chat"]');
  const previousTabIds = new Set(
    await chatTabs.evaluateAll((tabs) =>
      tabs.map((tab) => tab.getAttribute('data-testid')),
    ),
  );
  return recordTask(tasks, 'create_responsiveness_chat', async () => {
    await createFreshChatTab(page);
    await expect(chatTabs).toHaveCount(previousTabIds.size + 1);
    const currentIds = await chatTabs.evaluateAll((tabs) =>
      tabs.map((tab) => tab.getAttribute('data-testid')),
    );
    const testId = currentIds.find((id) => !previousTabIds.has(id));
    if (!testId) throw new Error('Responsiveness chat tab has no test id');
    // The new tab enters the roster before asynchronous canonical activation
    // finishes. Typing into the previously selected composer would split the
    // test draft across two chats when activation subsequently completes.
    await expect(page.getByTestId(testId)).toHaveAttribute(
      'aria-selected',
      'true',
    );
    return testId;
  });
}

async function runChats({ page, app, config, tasks }) {
  await openMainPage(page);
  await app.selectWorktree(WORKTREE_BRANCH, NO_ACTIVITY_RAIL);
  const { peakConcurrentTurns, tabIds } = await startConcurrentChats({
    page,
    config,
    tasks,
  });

  const probeTabId = await createResponsivenessChat(page, tasks);

  let interactionsWithActiveTurns = 0;
  for (let index = 0; index < config.interactionIterations; index += 1) {
    const activeTurns = await activeTurnCount(page);
    if (activeTurns > 0) interactionsWithActiveTurns += 1;
    await recordResponsiveTask(
      tasks,
      'type_during_chat_load',
      () =>
        typeDraftAndWaitForPaint(page, {
          scenario: 'chat-load',
          iteration: index + 1,
          characters: config.typingCharacters,
        }),
      {
        iteration: index + 1,
        characters: config.typingCharacters,
        activeTurns,
      },
      config.responsivenessBudgetMs,
    );
    await recordResponsiveTask(
      tasks,
      'navigate_during_chat_load',
      async () => {
        const liveTab = page.getByTestId(tabIds[index % tabIds.length]);
        await liveTab.click();
        await expect(liveTab).toHaveAttribute('aria-selected', 'true');
        await openPipelinesPage(page);
        await app.selectWorktree(WORKTREE_BRANCH, NO_ACTIVITY_RAIL);
        await expect(page.getByTestId('page-main')).toBeVisible({
          timeout: 30_000,
        });
        const probeTab = page.getByTestId(probeTabId);
        await probeTab.click();
        await expect(probeTab).toHaveAttribute('aria-selected', 'true');
        await nextPaint(page);
      },
      { iteration: index + 1, activeTurns },
      config.responsivenessBudgetMs,
    );
  }
  if (interactionsWithActiveTurns === 0) {
    throw new Error(
      'Chat workload completed before any responsiveness interaction ran',
    );
  }

  for (let index = 0; index < tabIds.length; index += 1) {
    await recordTask(
      tasks,
      'switch_active_chat',
      async () => {
        const tab = page.getByTestId(tabIds[index]);
        await tab.click();
        await expect(tab).toHaveAttribute('aria-selected', 'true');
        await nextPaint(page);
      },
      { chat: index + 1 },
    );
  }

  await recordTask(tasks, 'all_chats_complete', async () => {
    await waitUntil(() => activeTurnCount(page).then((count) => count === 0), {
      timeoutMs: config.chatStreamMs + 120_000,
      label: 'all chat turns to complete',
      intervalMs: 250,
    });
  });

  return {
    requestedConcurrentTurns: config.concurrentChats,
    peakConcurrentTurns,
    interactionsWithActiveTurns,
    streamedCharacters: config.concurrentChats * config.chatReplyCharacters,
  };
}

function buildNodeEvalCommand(source) {
  return `node -e "eval(Buffer.from('${Buffer.from(source).toString('base64')}','base64').toString())"`;
}

function buildPipelineMetadataCommand(label) {
  return buildNodeEvalCommand(`
process.stdout.write(${JSON.stringify(`[synthetic-review] ${label} complete\n`)});
`);
}

function buildPipelineReviewerCommand(config, reviewerIndex) {
  const chunkCount = Math.ceil(
    PERFORMANCE_PIPELINE_OUTPUT_BYTES_PER_REVIEWER /
      PERFORMANCE_PIPELINE_OUTPUT_CHUNK_BYTES,
  );
  return buildNodeEvalCommand(`
const startedAt = Date.now();
const durationMs = ${config.pipelineHoldMs};
const chunkCount = ${chunkCount};
const body = 'x'.repeat(${PERFORMANCE_PIPELINE_OUTPUT_CHUNK_BYTES} - 128);
let sequence = 0;
function emit() {
  if (sequence >= chunkCount) return;
  process.stdout.write(JSON.stringify({
    type: 'assistant_delta',
    reviewer: ${reviewerIndex},
    sequence,
    delta: body,
  }) + '\\n');
  sequence += 1;
  const targetAt = startedAt + Math.floor((sequence * durationMs) / chunkCount);
  setTimeout(emit, Math.max(0, targetAt - Date.now()));
}
emit();
`);
}

function buildPipelineJobYaml({ id, needs = [], steps }) {
  const lines = [`  ${id}:`];
  if (needs.length === 1) lines.push(`    needs: ${needs[0]}`);
  if (needs.length > 1) lines.push(`    needs: [${needs.join(', ')}]`);
  lines.push('    steps:');
  for (const step of steps) {
    lines.push(`      - id: ${step.id}`);
    lines.push(`        run: ${step.run}`);
  }
  return lines.join('\n');
}

export function buildPerformancePipelineYaml(config) {
  const contextJobs = [
    {
      id: 'workspace_details',
      steps: [
        {
          id: 'gather',
          run: buildPipelineMetadataCommand('workspace details'),
        },
      ],
    },
    {
      id: 'review_intent_context',
      steps: [
        {
          id: 'write_context',
          run: buildPipelineMetadataCommand('review intent'),
        },
      ],
    },
    {
      id: 'pr_context',
      needs: ['workspace_details'],
      steps: [
        { id: 'lookup', run: buildPipelineMetadataCommand('PR lookup') },
        {
          id: 'resolve_base_branch',
          run: buildPipelineMetadataCommand('base branch'),
        },
      ],
    },
    {
      id: 'github_review_context',
      needs: ['pr_context'],
      steps: [
        { id: 'gather', run: buildPipelineMetadataCommand('GitHub context') },
      ],
    },
    {
      id: 'review_workspace_details',
      needs: ['pr_context'],
      steps: [
        {
          id: 'determine_source',
          run: buildPipelineMetadataCommand('workspace source'),
        },
        { id: 'gather', run: buildPipelineMetadataCommand('workspace review') },
        {
          id: 'resolve',
          run: buildPipelineMetadataCommand('workspace result'),
        },
      ],
    },
    {
      id: 'instruction_scope',
      needs: ['github_review_context'],
      steps: [
        {
          id: 'find_instruction_files',
          run: buildPipelineMetadataCommand('instruction scope'),
        },
      ],
    },
    {
      id: 'linear_context',
      needs: ['github_review_context'],
      steps: [
        { id: 'gather', run: buildPipelineMetadataCommand('ticket context') },
      ],
    },
    {
      id: 'change_summary',
      needs: ['github_review_context'],
      steps: [
        {
          id: 'summarize',
          run: buildPipelineMetadataCommand('change summary'),
        },
      ],
    },
  ];
  const contextJobIds = contextJobs.map((job) => job.id);
  const reviewerJobIds = Array.from(
    { length: PERFORMANCE_PIPELINE_REVIEWER_COUNT },
    (_, index) => `synthetic_reviewer_${index + 1}`,
  );
  const reviewerJobs = reviewerJobIds.map((id, index) => ({
    id,
    needs: contextJobIds,
    steps: [
      {
        id: 'review',
        run: buildPipelineReviewerCommand(config, index + 1),
      },
      { id: 'validate', run: buildPipelineMetadataCommand(`${id} validation`) },
      {
        id: 'finalize',
        run: buildPipelineMetadataCommand(`${id} finalization`),
      },
      {
        id: 'select_review_output',
        run: buildPipelineMetadataCommand(`${id} output selection`),
      },
    ],
  }));
  const finalJobs = [
    {
      id: 'synthesize_review',
      needs: reviewerJobIds,
      steps: [
        {
          id: 'prepare_aggregation',
          run: buildPipelineMetadataCommand('aggregation preparation'),
        },
        {
          id: 'aggregate',
          run: buildPipelineMetadataCommand('review synthesis'),
        },
        {
          id: 'select_review_output',
          run: buildPipelineMetadataCommand('synthesized output'),
        },
      ],
    },
    {
      id: 'post_review_comment',
      needs: ['synthesize_review'],
      steps: [
        { id: 'lookup', run: buildPipelineMetadataCommand('comment lookup') },
        {
          id: 'prepare_payload',
          run: buildPipelineMetadataCommand('comment payload'),
        },
        { id: 'post', run: buildPipelineMetadataCommand('comment post') },
      ],
    },
    {
      id: 'minimize_previous_reviews',
      needs: ['synthesize_review'],
      steps: [
        { id: 'minimize', run: buildPipelineMetadataCommand('review cleanup') },
      ],
    },
    {
      id: 'publish_review_report',
      needs: ['synthesize_review'],
      steps: [
        {
          id: 'prepare_report',
          run: buildPipelineMetadataCommand('report preparation'),
        },
        {
          id: 'publish_report',
          run: buildPipelineMetadataCommand('report publish'),
        },
      ],
    },
  ];
  const jobs = [...contextJobs, ...reviewerJobs, ...finalJobs];
  return [
    `name: ${PERFORMANCE_PIPELINE_NAME}`,
    'on: dispatch',
    'jobs:',
    ...jobs.map(buildPipelineJobYaml),
    '',
  ].join('\n');
}

function seedPerformancePipeline(userDataDir, config) {
  seedStoredPipeline({
    userDataDir,
    id: 'performance-multi-review',
    name: PERFORMANCE_PIPELINE_NAME,
    description: 'Deterministic high-output multi-review workload',
    yaml: buildPerformancePipelineYaml(config),
  });
}

function buildPerformanceScriptCommand(config) {
  const ticks = Math.ceil(config.scriptHoldMs / config.scriptOutputIntervalMs);
  const source = `
const { Worker } = require('node:worker_threads');
const { spawn } = require('node:child_process');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const deadline = Date.now() + ${config.scriptHoldMs};
const workerSource = ${JSON.stringify(`
const { workerData } = require('node:worker_threads');
let value = 2166136261;
while (Date.now() < workerData.deadline) {
  value = Math.imul(value ^ 16777619, 2246822519) >>> 0;
}
`)};
for (let index = 0; index < ${config.scriptCpuWorkers}; index += 1) {
  new Worker(workerSource, { eval: true, workerData: { deadline } });
}
// npm install materializes dependencies inside the selected checkout. Keep
// every file unique and under an ignored node_modules subtree so the setup
// exercises worktree-local filesystem/Git/index reactions without turning the
// fixture into an artificial untracked diff.
const ioRoot = join(process.cwd(), 'node_modules', '.canopy-perf-install');
mkdirSync(ioRoot, { recursive: true });
const ioPayload = Buffer.alloc(${config.scriptFileBytes}, 97);
let fileSequence = 0;
const ioTimer = setInterval(() => {
  for (let index = 0; index < ${config.scriptFilesPerTick}; index += 1) {
    const bucket = join(ioRoot, String(Math.floor(fileSequence / 128)).padStart(5, '0'));
    if (fileSequence % 128 === 0) mkdirSync(bucket, { recursive: true });
    writeFileSync(join(bucket, String(fileSequence).padStart(7, '0')), ioPayload);
    fileSequence += 1;
  }
}, ${config.scriptOutputIntervalMs});
const spawnTimer = setInterval(() => {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  child.on('error', () => {});
}, ${config.scriptSpawnIntervalMs});
const payload = Array.from(
  { length: ${config.scriptOutputLinesPerTick} },
  (_, index) => 'performance script output ' + index,
).join('\\n') + '\\n';
let ticks = 0;
const timer = setInterval(() => {
  process.stdout.write(payload);
  ticks += 1;
  if (ticks >= ${ticks}) {
    clearInterval(timer);
    clearInterval(ioTimer);
    clearInterval(spawnTimer);
  }
}, ${config.scriptOutputIntervalMs});
`;
  return `node -e "eval(Buffer.from('${Buffer.from(source).toString('base64')}','base64').toString())"`;
}

function requestedPerformanceScriptOutputLines(config) {
  return (
    Math.ceil(config.scriptHoldMs / config.scriptOutputIntervalMs) *
    config.scriptOutputLinesPerTick
  );
}

function requestedPerformanceScriptFiles(config) {
  return (
    Math.ceil(config.scriptHoldMs / config.scriptOutputIntervalMs) *
    config.scriptFilesPerTick
  );
}

function updateWorkspaceScripts(userDataDir, update) {
  const workspacePath = path.join(
    userDataDir,
    'workspaces',
    WORKSPACE_ID,
    'workspace.json',
  );
  const workspace = JSON.parse(readFileSync(workspacePath, 'utf8'));
  workspace.scripts = { ...(workspace.scripts ?? {}), ...update };
  writeFileSync(
    workspacePath,
    `${JSON.stringify(workspace, null, 2)}\n`,
    'utf8',
  );
}

function preparePipelines(userDataDir, config) {
  seedWorkspace(userDataDir);
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [{ id: 'pipeline-responsiveness-chat', title: 'Responsiveness' }],
  });
  seedPerformancePipeline(userDataDir, config);
}

function pipelineHistoryStatus(index, count) {
  const ratio = index / count;
  if (ratio < 0.873) return 'success';
  if (ratio < 0.944) return 'paused';
  if (ratio < 0.982) return 'failure';
  if (ratio < 0.995) return 'cancelled';
  return 'running';
}

function pipelineHistoryStateShapes(count, totalBytes) {
  // Aggregate snapshot from the authorized internal-128 data directory:
  // v2 291/424 files and 837,374 bytes; v3 14 and 429,511; v4 5 and
  // 5,427,341; v5 10 and 7,534,222; v6 45 and 17,171,760; v7 59 and
  // 30,570,836. Version matters because load-time migrations clone the parsed
  // state at each boundary. Preserve both count and byte proportions without
  // retaining any user pipeline content in the fixture.
  const observed = [
    { version: 2, count: 291, bytes: 837_374 },
    { version: 3, count: 14, bytes: 429_511 },
    { version: 4, count: 5, bytes: 5_427_341 },
    { version: 5, count: 10, bytes: 7_534_222 },
    { version: 6, count: 45, bytes: 17_171_760 },
    { version: 7, count: 59, bytes: 30_570_836 },
  ];
  const observedCount = observed.reduce((sum, tier) => sum + tier.count, 0);
  const observedBytes = observed.reduce((sum, tier) => sum + tier.bytes, 0);
  let previousEnd = 0;
  const tiers = observed.map((tier, index) => {
    const end =
      index === observed.length - 1
        ? count
        : Math.round(
            (count *
              observed
                .slice(0, index + 1)
                .reduce((sum, candidate) => sum + candidate.count, 0)) /
              observedCount,
          );
    const scaledCount = Math.max(0, end - previousEnd);
    previousEnd = end;
    return {
      version: tier.version,
      count: scaledCount,
      byteShare: tier.bytes / observedBytes,
    };
  });
  const estimatedJsonOverhead = count * 1_500;
  const payloadBudget = Math.max(0, totalBytes - estimatedJsonOverhead);
  return tiers.flatMap((tier) => {
    const payloadBytes =
      tier.count === 0
        ? 0
        : Math.max(
            0,
            Math.floor((payloadBudget * tier.byteShare) / tier.count),
          );
    return Array.from({ length: tier.count }, () => ({
      version: tier.version,
      payloadBytes,
    }));
  });
}

function seedPipelineHistoryState(userDataDir, config) {
  const stateShapes = pipelineHistoryStateShapes(
    config.pipelineHistoryExecutions,
    config.pipelineHistoryTotalBytes,
  );
  const startedAt = Date.parse('2026-07-01T12:00:00.000Z');
  const statePaths = stateShapes.map(({ version, payloadBytes }, index) => {
    const selectedWorktree = index < 8;
    return seedPipelineExecution({
      userDataDir,
      workspaceId: selectedWorktree ? WORKSPACE_ID : 'historical-workspace',
      worktreeId: selectedWorktree ? WORKTREE_ID : 'historical-worktree',
      execution: {
        id: `history-execution-${String(index + 1).padStart(5, '0')}`,
        pipelineId: `history-pipeline-${(index % 12) + 1}`,
        pipelineName: `History Pipeline ${(index % 12) + 1}`,
        status: pipelineHistoryStatus(index, stateShapes.length),
        startedAt: new Date(startedAt + index * 60_000).toISOString(),
        completedAt: new Date(
          startedAt + index * 60_000 + 12_000,
        ).toISOString(),
        stateOverrides: {
          version,
          // Version 7 requires an explicit status-reason list. Keep the
          // synthetic history states schema-valid even when their terminal
          // status does not need a reason.
          status_reasons: [],
          performance_history_payload: syntheticText(
            `history-${index + 1}`,
            payloadBytes,
          ),
        },
      },
    }).stateFilePath;
  });
  const stateBytes = statePaths.reduce(
    (total, statePath) => total + statSync(statePath).size,
    0,
  );
  return { stateBytes, stateFiles: statePaths.length };
}

function preparePipelineHistory(userDataDir, config) {
  seedWorkspace(userDataDir);
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [{ id: 'pipeline-history-responsiveness', title: 'Responsiveness' }],
  });
  return seedPipelineHistoryState(userDataDir, config);
}

async function startPipelineHistoryList(page) {
  await page.evaluate(() => {
    const state = {
      done: false,
      success: false,
      count: 0,
      durationMs: 0,
      error: null,
    };
    window.__CANOPY_PIPELINE_HISTORY_PERF__ = state;
    const startedAt = performance.now();
    void window.pipelines
      .listExecutions()
      .then((result) => {
        state.success = result.success;
        state.count = result.success && result.data ? result.data.length : 0;
        state.error = result.success ? null : (result.error ?? 'unknown error');
      })
      .catch((error) => {
        state.error = error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        state.durationMs = performance.now() - startedAt;
        state.done = true;
      });
  });
}

async function pipelineHistoryListSnapshot(page) {
  return page.evaluate(() => ({
    ...window.__CANOPY_PIPELINE_HISTORY_PERF__,
  }));
}

async function startConcurrentPipelineHistoryLists(page, requestCount) {
  await page.evaluate((count) => {
    const state = {
      done: false,
      success: false,
      counts: [],
      durationMs: 0,
      error: null,
    };
    window.__CANOPY_PIPELINE_HISTORY_CONCURRENT_PERF__ = state;
    const startedAt = performance.now();
    void Promise.all(
      Array.from({ length: count }, () => window.pipelines.listExecutions()),
    )
      .then((results) => {
        state.counts = results.map((result) =>
          result.success && result.data ? result.data.length : 0,
        );
        state.success = results.every(
          (result) => result.success && result.data !== undefined,
        );
        state.error = state.success
          ? null
          : (results.find((result) => !result.success)?.error ??
            'unknown error');
      })
      .catch((error) => {
        state.error = error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        state.durationMs = performance.now() - startedAt;
        state.done = true;
      });
  }, requestCount);
}

async function concurrentPipelineHistoryListSnapshot(page) {
  return page.evaluate(() => ({
    ...window.__CANOPY_PIPELINE_HISTORY_CONCURRENT_PERF__,
  }));
}

async function runPipelineHistory({ page, app, config, tasks, fixture }) {
  await openMainPage(page);
  await app.selectWorktree(WORKTREE_BRANCH, NO_ACTIVITY_RAIL);
  await expect(visibleChatPanel(page)).toBeVisible({ timeout: 30_000 });
  const durations = [];
  let interactionsOverlappingList = 0;

  for (
    let index = 0;
    index < config.pipelineHistoryListIterations;
    index += 1
  ) {
    await recordTask(tasks, 'dispatch_pipeline_history_list', () =>
      startPipelineHistoryList(page),
    );
    await delay(10);
    if (!(await pipelineHistoryListSnapshot(page)).done) {
      interactionsOverlappingList += 1;
    }
    await recordResponsiveTask(
      tasks,
      'type_during_pipeline_history_list',
      () =>
        typeDraftAndWaitForPaint(page, {
          scenario: 'pipeline-history-list',
          iteration: index + 1,
          characters: config.typingCharacters,
        }),
      { iteration: index + 1 },
      config.responsivenessBudgetMs,
    );
    const snapshot = await recordTask(
      tasks,
      'pipeline_history_list_complete',
      () =>
        waitUntil(
          async () => {
            const snapshot = await pipelineHistoryListSnapshot(page);
            return snapshot.done ? snapshot : false;
          },
          {
            timeoutMs: 60_000,
            label: 'pipeline execution history list to complete',
            intervalMs: 10,
          },
        ),
      { iteration: index + 1 },
    );
    if (!snapshot.done || !snapshot.success || snapshot.error) {
      throw new Error(
        `Pipeline history list failed: ${snapshot.error ?? 'incomplete response'}`,
      );
    }
    if (snapshot.count !== config.pipelineHistoryExecutions) {
      throw new Error(
        `Pipeline history listed ${snapshot.count}/${config.pipelineHistoryExecutions} executions`,
      );
    }
    durations.push(snapshot.durationMs);
    await recordResponsiveTask(
      tasks,
      'navigate_after_pipeline_history_list',
      async () => {
        await openPipelinesPage(page);
        await app.selectWorktree(WORKTREE_BRANCH, NO_ACTIVITY_RAIL);
        await nextPaint(page);
      },
      { iteration: index + 1 },
      config.responsivenessBudgetMs,
    );
  }

  const concurrentListRequests = 2;
  await recordTask(tasks, 'dispatch_concurrent_pipeline_history_lists', () =>
    startConcurrentPipelineHistoryLists(page, concurrentListRequests),
  );
  await delay(10);
  const concurrentListOverlappedInteraction = !(
    await concurrentPipelineHistoryListSnapshot(page)
  ).done;
  await recordResponsiveTask(
    tasks,
    'type_during_concurrent_pipeline_history_lists',
    () =>
      typeDraftAndWaitForPaint(page, {
        scenario: 'concurrent-pipeline-history-lists',
        iteration: 1,
        characters: config.typingCharacters,
      }),
    { concurrentRequests: concurrentListRequests },
    config.responsivenessBudgetMs,
  );
  const concurrentSnapshot = await recordTask(
    tasks,
    'concurrent_pipeline_history_lists_complete',
    () =>
      waitUntil(
        async () => {
          const snapshot = await concurrentPipelineHistoryListSnapshot(page);
          return snapshot.done ? snapshot : false;
        },
        {
          timeoutMs: 60_000,
          label: 'concurrent pipeline execution history lists to complete',
          intervalMs: 10,
        },
      ),
    { concurrentRequests: concurrentListRequests },
  );
  if (
    !concurrentSnapshot.success ||
    concurrentSnapshot.error ||
    concurrentSnapshot.counts.length !== concurrentListRequests ||
    concurrentSnapshot.counts.some(
      (count) => count !== config.pipelineHistoryExecutions,
    )
  ) {
    throw new Error(
      `Concurrent pipeline history lists failed: ${concurrentSnapshot.error ?? concurrentSnapshot.counts.join(',')}`,
    );
  }

  return {
    requestedExecutionStates: config.pipelineHistoryExecutions,
    requestedStateBytes: config.pipelineHistoryTotalBytes,
    actualExecutionStates: fixture.stateFiles,
    actualStateBytes: fixture.stateBytes,
    listIterations: durations.length,
    listDurationMinMs: Math.min(...durations),
    listDurationP50Ms: percentile(durations, 0.5),
    listDurationP95Ms: percentile(durations, 0.95),
    listDurationMaxMs: Math.max(...durations),
    interactionsOverlappingList,
    concurrentListRequests,
    concurrentListDurationMs: concurrentSnapshot.durationMs,
    concurrentListOverlappedInteraction,
  };
}

function pipelineRunCards(page, pipelineName) {
  return page
    .locator('[data-testid^="pipeline-run-card-"]')
    .filter({ hasText: pipelineName });
}

async function dispatchConcurrentPipelines({ page, config, tasks, cards }) {
  let peakConcurrentRuns = 0;

  for (let index = 0; index < config.concurrentPipelines; index += 1) {
    const before = await cards.count();
    await recordTask(
      tasks,
      'dispatch_pipeline',
      async () => {
        await page.getByTestId('pipeline-dispatch-open').click();
        const modal = page.getByTestId('pipeline-trigger-modal-body');
        await expect(modal).toBeVisible();
        await modal
          .getByRole('button', { name: PERFORMANCE_PIPELINE_NAME })
          .first()
          .click();
        const run = page.getByTestId('pipeline-trigger-modal-run');
        await expect(run).toBeEnabled();
        await run.click();
        try {
          await expect(cards).toHaveCount(before + 1, { timeout: 30_000 });
        } catch (error) {
          await captureScenarioFailure(error, 'pipeline-dispatch-card', () =>
            page.evaluate(
              ({ pipelineName, beforeCount }) => {
                const modal = document.querySelector(
                  '[data-testid="pipeline-trigger-modal"]',
                );
                const run = document.querySelector(
                  '[data-testid="pipeline-trigger-modal-run"]',
                );
                const cards = document.querySelectorAll(
                  '[data-testid^="pipeline-run-card-"]',
                );
                const selectedWorktreeIds = [];
                const selected = document.querySelectorAll(
                  '[data-sidebar-selected-item]',
                );
                const selectedRowLabels = [];
                for (
                  let index = 0;
                  index < Math.min(3, selected.length);
                  index += 1
                ) {
                  selectedWorktreeIds.push(
                    selected[index]?.getAttribute('data-worktree-id') ??
                      selected[index]
                        ?.querySelector('[data-worktree-id]')
                        ?.getAttribute('data-worktree-id') ??
                      null,
                  );
                  selectedRowLabels.push(
                    selected[index]?.textContent?.slice(0, 256),
                  );
                }
                const modalErrors = [];
                const errorElements =
                  modal?.querySelectorAll('.fg-destructive') ?? [];
                for (
                  let index = 0;
                  index < Math.min(4, errorElements.length);
                  index += 1
                ) {
                  modalErrors.push(
                    errorElements[index]?.textContent?.slice(0, 256),
                  );
                }
                const cardIds = [];
                const recentCardLabels = [];
                let matchingCards = 0;
                for (let index = 0; index < cards.length; index += 1) {
                  const card = cards[index];
                  if (card?.textContent?.includes(pipelineName))
                    matchingCards += 1;
                  if (index < cards.length - 4) continue;
                  cardIds.push(card?.getAttribute('data-testid'));
                  recentCardLabels.push(card?.textContent?.slice(0, 256));
                }
                const toastErrors = [];
                const alerts = document.querySelectorAll('[role="alert"]');
                for (
                  let index = Math.max(0, alerts.length - 4);
                  index < alerts.length;
                  index += 1
                ) {
                  toastErrors.push(alerts[index]?.textContent?.slice(0, 256));
                }
                return {
                  beforeCount,
                  selectedWorktreeIds,
                  selectedRowLabels,
                  modalOpen: Boolean(modal),
                  modalErrors,
                  runDisabled: run?.hasAttribute('disabled') ?? null,
                  runText: run?.textContent?.slice(0, 256) ?? null,
                  totalCards: cards.length,
                  cardIds,
                  matchingCards,
                  recentCardLabels,
                  toastErrors,
                };
              },
              {
                pipelineName: PERFORMANCE_PIPELINE_NAME,
                beforeCount: before,
              },
            ),
          );
        }
      },
      { pipeline: index + 1 },
    );
    const texts = await cards.allTextContents();
    peakConcurrentRuns = Math.max(
      peakConcurrentRuns,
      texts.filter((text) => text.toLowerCase().includes('running')).length,
    );
  }

  assertRequestedPipelineConcurrency(
    peakConcurrentRuns,
    config.concurrentPipelines,
  );
  return peakConcurrentRuns;
}

async function waitForPipelinesComplete(cards, config) {
  await waitUntil(
    async () => {
      const texts = await cards.allTextContents();
      return (
        texts.length === config.concurrentPipelines &&
        texts.every((text) => text.toLowerCase().includes('success'))
      );
    },
    {
      timeoutMs: config.pipelineHoldMs + 120_000,
      label: 'all pipeline runs to complete',
      intervalMs: 250,
    },
  );
}

async function verifyPerformancePipelineOutput(page, cards) {
  const executionIds = await cards.evaluateAll((elements) =>
    elements.map((element) =>
      (element.getAttribute('data-testid') ?? '').replace(
        'pipeline-run-card-',
        '',
      ),
    ),
  );
  const states = await page.evaluate(async (ids) => {
    const results = await Promise.all(
      ids.map((executionId) => window.pipelines.getExecution(executionId)),
    );
    return results.map((result) =>
      result.success ? (result.data ?? null) : null,
    );
  }, executionIds);
  let outputBytes = 0;
  for (const state of states) {
    if (!state) throw new Error('Unable to load completed pipeline state');
    for (
      let index = 1;
      index <= PERFORMANCE_PIPELINE_REVIEWER_COUNT;
      index += 1
    ) {
      const logFile =
        state.jobs[`synthetic_reviewer_${index}`]?.steps.review?.log_file;
      if (!logFile) {
        throw new Error(`Synthetic reviewer ${index} has no persisted log`);
      }
      const bytes = statSync(logFile).size;
      if (bytes < PERFORMANCE_PIPELINE_OUTPUT_BYTES_PER_REVIEWER * 0.95) {
        throw new Error(
          `Synthetic reviewer ${index} emitted ${bytes} bytes; expected at least 95% of ${PERFORMANCE_PIPELINE_OUTPUT_BYTES_PER_REVIEWER}`,
        );
      }
      outputBytes += bytes;
    }
  }
  return outputBytes;
}

async function runPipelines({ page, app, config, tasks }) {
  await openMainPage(page);
  await app.selectWorktree(WORKTREE_BRANCH);
  await expect(
    page.getByTestId('panel-content-activity-section'),
  ).toBeVisible();
  const cards = pipelineRunCards(page, PERFORMANCE_PIPELINE_NAME);
  const peakConcurrentRuns = await dispatchConcurrentPipelines({
    page,
    config,
    tasks,
    cards,
  });
  let interactionsWithActiveRuns = 0;

  for (let index = 0; index < config.navigationIterations; index += 1) {
    let activeRuns = null;
    if (index < config.interactionIterations) {
      const texts = await cards.allTextContents();
      activeRuns = texts.filter((text) =>
        text.toLowerCase().includes('running'),
      ).length;
      if (activeRuns > 0) interactionsWithActiveRuns += 1;
      await recordResponsiveTask(
        tasks,
        'type_during_pipeline_load',
        () =>
          typeDraftAndWaitForPaint(page, {
            scenario: 'pipeline-load',
            iteration: index + 1,
            characters: config.typingCharacters,
          }),
        {
          iteration: index + 1,
          characters: config.typingCharacters,
          activeRuns,
        },
        config.responsivenessBudgetMs,
      );
    }
    await recordResponsiveTask(
      tasks,
      'navigate_during_pipeline_load',
      async () => {
        await openPipelinesPage(page);
        await app.selectWorktree(WORKTREE_BRANCH);
        await expect(page.getByTestId('page-main')).toBeVisible({
          timeout: 30_000,
        });
        await nextPaint(page);
      },
      { iteration: index + 1, activeRuns },
      config.responsivenessBudgetMs,
    );
  }
  if (interactionsWithActiveRuns === 0) {
    throw new Error(
      'Pipeline workload completed before any responsiveness interaction ran',
    );
  }

  await recordTask(tasks, 'all_pipelines_complete', async () => {
    await waitForPipelinesComplete(cards, config);
  });
  const emittedOutputBytes = await verifyPerformancePipelineOutput(page, cards);

  return {
    requestedConcurrentRuns: config.concurrentPipelines,
    peakConcurrentRuns,
    interactionsWithActiveRuns,
    holdMs: config.pipelineHoldMs,
    reviewerJobsPerRun: PERFORMANCE_PIPELINE_REVIEWER_COUNT,
    expectedOutputBytesPerRun:
      PERFORMANCE_PIPELINE_REVIEWER_COUNT *
      PERFORMANCE_PIPELINE_OUTPUT_BYTES_PER_REVIEWER,
    emittedOutputBytes,
  };
}

function prepareScripts(userDataDir, config) {
  seedWorkspace(userDataDir);
  updateWorkspaceScripts(userDataDir, {
    'performance-load': buildPerformanceScriptCommand(config),
  });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [{ id: 'script-responsiveness-chat', title: 'Responsiveness' }],
  });
}

async function readPerformanceScriptState(page) {
  return page.evaluate(() => window.__canopyPerformanceScriptState);
}

async function runScripts({ page, app, config, tasks }) {
  await openMainPage(page);
  await app.selectWorktree(WORKTREE_BRANCH, NO_ACTIVITY_RAIL);
  await expect(page.getByTestId('page-main')).toBeVisible({ timeout: 30_000 });
  await expect(visibleChatPanel(page)).toBeVisible({ timeout: 30_000 });

  await recordTask(tasks, 'start_script_load', async () => {
    await page.evaluate(
      ({ projectId, worktreeId }) => {
        const state = {
          done: false,
          outputEvents: 0,
          result: null,
          error: null,
        };
        window.__canopyPerformanceScriptState = state;
        const unsubscribe = window.api.onScriptOutput(() => {
          state.outputEvents += 1;
        });
        void window.api
          .runScript({
            target: 'project',
            scriptName: 'performance-load',
            projectId,
            worktreeId,
          })
          .then((result) => {
            state.result = result;
          })
          .catch((error) => {
            state.error =
              error instanceof Error ? error.message : String(error);
          })
          .finally(() => {
            state.done = true;
            unsubscribe();
          });
      },
      { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
    );
    await waitUntil(
      async () => (await readPerformanceScriptState(page))?.outputEvents > 0,
      {
        timeoutMs: 30_000,
        label: 'performance script output to begin',
        intervalMs: 25,
      },
    );
  });

  let interactionsWithActiveScript = 0;
  for (let index = 0; index < config.interactionIterations; index += 1) {
    const state = await readPerformanceScriptState(page);
    const active = state?.done === false;
    if (active) interactionsWithActiveScript += 1;
    await recordResponsiveTask(
      tasks,
      'type_during_script_load',
      () =>
        typeDraftAndWaitForPaint(page, {
          scenario: 'script-load',
          iteration: index + 1,
          characters: config.typingCharacters,
        }),
      {
        iteration: index + 1,
        characters: config.typingCharacters,
        active,
        outputEvents: state?.outputEvents ?? 0,
      },
      config.responsivenessBudgetMs,
    );
  }
  if (interactionsWithActiveScript === 0) {
    throw new Error(
      'Script workload completed before any responsiveness interaction ran',
    );
  }

  await recordTask(tasks, 'script_load_complete', async () => {
    const state = await waitUntil(
      async () => {
        const current = await readPerformanceScriptState(page);
        return current?.done ? current : null;
      },
      {
        timeoutMs: config.scriptHoldMs + 120_000,
        label: 'performance script to complete',
        intervalMs: 100,
      },
    );
    if (state.error) throw new Error(state.error);
    if (!state.result?.success) {
      throw new Error(
        `Performance script failed with exit ${state.result?.exitCode ?? 'unknown'}`,
      );
    }
  });

  const finalState = await readPerformanceScriptState(page);
  return {
    interactionsWithActiveScript,
    outputEvents: finalState?.outputEvents ?? 0,
    requestedDurationMs: config.scriptHoldMs,
    requestedCpuWorkers: config.scriptCpuWorkers,
    requestedOutputLines: requestedPerformanceScriptOutputLines(config),
  };
}

export function assertRequestedPipelineConcurrency(observed, requested) {
  if (observed !== requested) {
    throw new Error(
      `Pipeline workload reached ${observed} concurrent runs; expected ${requested}`,
    );
  }
}

/**
 * Manual Code Graph overlap: every requested build has entered the
 * generation queue, and running and queued builds coexist. Requests are not
 * admitted together: each one's start fingerprint runs first, one at a time,
 * so on a quiet host an early build can finish before the last request is
 * queued. Requiring all of them in the queue at once made the wait depend on
 * host load rather than on the overlap it confirms.
 */
export function codeGraphManualOverlapConfirmed({
  counts,
  admittedWorktreeIds,
  requestedWorktreeIds,
}) {
  const admitted = new Set(admittedWorktreeIds);
  return (
    requestedWorktreeIds.every((worktreeId) => admitted.has(worktreeId)) &&
    counts.running >= 1 &&
    counts.queued >= 1
  );
}

/**
 * A desktop worktree build answers its caller when the graph is published;
 * its worker keeps the queue slot until derived analysis finishes. Wait for
 * that tail to drain, and still fail when an entry is never released.
 */
export async function waitForCodeGraphQueueDrain(
  readCounts,
  { timeoutMs = 5 * 60_000, intervalMs = 100 } = {},
) {
  let last = null;
  try {
    return await waitUntil(
      async () => {
        last = await readCounts();
        return last.total === 0 ? last : false;
      },
      { timeoutMs, label: 'the Code Graph queue to drain', intervalMs },
    );
  } catch (error) {
    if (last === null || last.total === 0) throw error;
    throw new Error(
      `Code Graph queue retained ${last.total} entries after all requests completed${last.detail ? `; ${last.detail}` : ''}`,
    );
  }
}

export function codeGraphQueueCounts(snapshot) {
  const entries = Array.isArray(snapshot?.entries) ? snapshot.entries : [];
  return {
    total: entries.length,
    running: entries.filter((entry) => entry.status === 'running').length,
    queued: entries.filter((entry) => entry.status === 'queued').length,
  };
}

/** Only writer hosts directly owned by this scenario's daemon, on macOS/Linux. */
export function codeGraphDaemonWriterPids(table, daemonPid) {
  return table.split('\n').flatMap((line) => {
    const row = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    return row &&
      Number(row[2]) === daemonPid &&
      /--canopy-execution-host=code-graph-build-host\.js(?:\s|$)/.test(row[3])
      ? [Number(row[1])]
      : [];
  });
}

export function readDaemonCodeGraphWriters(dataRoot) {
  if (!['darwin', 'linux'].includes(process.platform)) return [];
  const descriptorPath = path.join(dataRoot, 'runtime', 'core.json');
  if (!existsSync(descriptorPath)) return [];
  // Descriptor only: never read the connection token or open a session.
  const descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8'));
  if (!Number.isSafeInteger(descriptor.pid) || descriptor.pid <= 0)
    throw new Error('Code Graph drain cannot identify the fixture daemon PID');
  return codeGraphDaemonWriterPids(
    execFileSync('ps', ['-axo', 'pid=,ppid=,args='], {
      encoding: 'utf8',
      timeout: 5_000,
    }),
    descriptor.pid,
  );
}

function readCodeGraphDbCounters(dbPath) {
  const database = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const count = (table) =>
      Number(database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);
    return {
      fileCount: count('files'),
      symbolCount: count('symbols'),
      edgeCount: count('edges'),
    };
  } finally {
    database.close();
  }
}

function startCodeGraphBuildRequests(page, worktrees) {
  return page.evaluate(
    ({ workspaceId, worktreeIds: requestedWorktreeIds }) => {
      const state = {
        startedAt: performance.now(),
        completedAt: null,
        completed: 0,
        results: Array(requestedWorktreeIds.length).fill(null),
        // Requested worktrees whose build has entered the generation queue.
        // Each request's start fingerprint runs first, one at a time, so
        // later requests can be admitted after an early build has finished.
        admitted: {},
      };
      const noteAdmitted = (snapshot) => {
        for (const entry of snapshot.entries) {
          if (
            requestedWorktreeIds.includes(entry.worktreeId) &&
            state.admitted[entry.worktreeId] === undefined
          ) {
            state.admitted[entry.worktreeId] = performance.now();
          }
        }
      };
      window.__CANOPY_PERF_CODE_GRAPH_UNSUBSCRIBE__?.();
      window.__CANOPY_PERF_CODE_GRAPH_UNSUBSCRIBE__ =
        window.api.onCodeGraphGenerationQueueChanged(noteAdmitted);
      window.__CANOPY_PERF_CODE_GRAPH__ = state;
      for (const [index, worktreeId] of requestedWorktreeIds.entries()) {
        window.api
          .codeGraphBuildWorktree({ workspaceId, worktreeId })
          .then(
            (value) => {
              state.results[index] = { status: 'fulfilled', value };
            },
            (error) => {
              state.results[index] = {
                status: 'rejected',
                error: error instanceof Error ? error.message : String(error),
              };
            },
          )
          .finally(() => {
            state.completed += 1;
            if (state.completed === requestedWorktreeIds.length) {
              state.completedAt = performance.now();
            }
          });
      }
    },
    {
      workspaceId: WORKSPACE_ID,
      worktreeIds: worktrees.map((worktree) => worktree.id),
    },
  );
}

function startCodeGraphBackgroundBuildRequests(page, worktrees) {
  return page.evaluate(
    ({ workspaceId, worktreeIds: requestedWorktreeIds }) => {
      const state = {
        startedAt: performance.now(),
        completedAt: null,
        completed: 0,
        results: Array(requestedWorktreeIds.length).fill(null),
      };
      window.__CANOPY_PERF_CODE_GRAPH__ = state;
      for (const [index, worktreeId] of requestedWorktreeIds.entries()) {
        window.api
          .codeGraphSchedulePerformanceBuild({ workspaceId, worktreeId })
          .then(
            (value) => {
              state.results[index] = { status: 'fulfilled', value };
            },
            (error) => {
              state.results[index] = {
                status: 'rejected',
                error: error instanceof Error ? error.message : String(error),
              };
            },
          )
          .finally(() => {
            state.completed += 1;
            if (state.completed === requestedWorktreeIds.length) {
              state.completedAt = performance.now();
            }
          });
      }
    },
    {
      workspaceId: WORKSPACE_ID,
      worktreeIds: worktrees.map((worktree) => worktree.id),
    },
  );
}

function readCodeGraphBuildRuntime(page, worktrees, backgroundScheduler) {
  return page.evaluate(
    async ({ workspaceId, worktreeIds, backgroundScheduler }) => {
      const builds = window.__CANOPY_PERF_CODE_GRAPH__ ?? null;
      let queue;
      if (backgroundScheduler) {
        queue = await window.api.codeGraphGetGenerationQueue();
      } else {
        // Queue view is intentionally local. Manual requests default to the
        // daemon; summaries expose combined source state, not derived drains.
        const entries = await Promise.all(
          worktreeIds.map(async (worktreeId, index) => {
            const summary = await window.api.codeGraphGetWorktreeSummary({
              workspaceId,
              worktreeId,
            });
            const status = summary.buildState;
            if (!['idle', 'queued', 'running'].includes(status)) {
              throw new Error(
                `Code Graph build state unavailable for ${worktreeId}: ${JSON.stringify(summary)}`,
              );
            }
            const result = builds?.results[index];
            if (
              builds &&
              (status !== 'idle' ||
                (result?.status === 'fulfilled' &&
                  result.value?.ok !== false &&
                  result.value?.state === 'ready'))
            ) {
              // A fast completed build also proves admission between samples.
              builds.admitted[worktreeId] ??= performance.now();
            }
            return { worktreeId, status };
          }),
        );
        queue = { entries: entries.filter((entry) => entry.status !== 'idle') };
      }
      return {
        queue,
        builds:
          builds === null
            ? null
            : {
                ...builds,
                admittedWorktreeIds: Object.keys(builds.admitted ?? {}),
              },
      };
    },
    {
      workspaceId: WORKSPACE_ID,
      worktreeIds: worktrees.map((worktree) => worktree.id),
      backgroundScheduler,
    },
  );
}

function stopCodeGraphAdmissionTracking(page) {
  return page.evaluate(() => {
    window.__CANOPY_PERF_CODE_GRAPH_UNSUBSCRIBE__?.();
    delete window.__CANOPY_PERF_CODE_GRAPH_UNSUBSCRIBE__;
  });
}

async function runCodeGraphConcurrencyMode(
  { page, app, config, tasks, fixture },
  { backgroundScheduler },
) {
  await openMainPage(page);
  await recordTask(
    tasks,
    'load_code_graph_worktrees',
    () =>
      waitUntil(
        async () => {
          const ids = await worktreeIds(page);
          return ids.length === fixture.worktrees.length ? ids.length : false;
        },
        {
          timeoutMs: 60_000,
          label: `${fixture.worktrees.length} Code Graph fixture worktrees`,
        },
      ),
    {
      requestedWorktrees: fixture.worktrees.length,
      requestedFilesPerWorktree: fixture.filesPerWorktree,
    },
  );
  await app.selectWorktree(WORKTREE_BRANCH, NO_ACTIVITY_RAIL);
  await expect(visibleChatPanel(page)).toBeVisible({ timeout: 30_000 });

  await recordTask(tasks, 'wait_for_empty_code_graph_queue', () =>
    waitUntil(
      async () => {
        const { queue } = await readCodeGraphBuildRuntime(
          page,
          fixture.worktrees,
          backgroundScheduler,
        );
        return queue.entries.length === 0 ? queue : false;
      },
      {
        timeoutMs: 120_000,
        label: 'an empty Code Graph generation queue before dispatch',
        intervalMs: 250,
      },
    ),
  );

  await recordTask(tasks, 'dispatch_code_graph_builds', () =>
    backgroundScheduler
      ? startCodeGraphBackgroundBuildRequests(page, fixture.worktrees)
      : startCodeGraphBuildRequests(page, fixture.worktrees),
  );

  let peakRunningBuilds = 0;
  let peakQueuedBuilds = 0;
  const observeRuntime = async () => {
    const runtime = await readCodeGraphBuildRuntime(
      page,
      fixture.worktrees,
      backgroundScheduler,
    );
    const counts = codeGraphQueueCounts(runtime.queue);
    peakRunningBuilds = Math.max(peakRunningBuilds, counts.running);
    peakQueuedBuilds = Math.max(peakQueuedBuilds, counts.queued);
    return { ...runtime, counts };
  };

  const overlapTimeline = [];
  const overlapStartedAt = performance.now();
  const requestedWorktreeIds = fixture.worktrees.map((worktree) => worktree.id);
  const overlap = await recordTask(
    tasks,
    'confirm_code_graph_queue_overlap',
    () =>
      waitUntil(
        async () => {
          const runtime = await observeRuntime();
          const sample = [
            Math.round(performance.now() - overlapStartedAt),
            runtime.counts.running,
            runtime.counts.queued,
            runtime.builds?.admittedWorktreeIds?.length ?? 0,
            runtime.builds?.completed ?? 0,
          ];
          const previous = overlapTimeline.at(-1);
          if (previous?.slice(1).join() !== sample.slice(1).join()) {
            overlapTimeline.push(sample);
          }
          if (backgroundScheduler) {
            return runtime.counts.running >= 1 &&
              runtime.builds?.completed < fixture.worktrees.length
              ? runtime
              : false;
          }
          return codeGraphManualOverlapConfirmed({
            counts: runtime.counts,
            admittedWorktreeIds: runtime.builds?.admittedWorktreeIds ?? [],
            requestedWorktreeIds,
          })
            ? runtime
            : false;
        },
        {
          timeoutMs: 60_000,
          label: backgroundScheduler
            ? `${fixture.worktrees.length} scheduled Code Graph builds to start`
            : `all ${fixture.worktrees.length} Code Graph build requests to be admitted while running and queued builds overlap`,
          intervalMs: 25,
        },
      ).catch((error) => {
        // [elapsed ms, running, queued, admitted, completed] at each change.
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; timeline=${JSON.stringify(overlapTimeline)}`,
        );
      }),
    { requestedBuilds: fixture.worktrees.length },
  );
  Object.assign(tasks.at(-1), {
    runningAtOverlap: overlap.counts.running,
    queuedAtOverlap: overlap.counts.queued,
    completedBeforeOverlap: overlap.builds?.completed ?? 0,
  });

  let interactionsWithActiveBuilds = 0;
  for (let index = 0; index < config.interactionIterations; index += 1) {
    const runtime = await observeRuntime();
    if (
      backgroundScheduler
        ? runtime.builds?.completed >= fixture.worktrees.length
        : runtime.counts.total === 0
    ) {
      throw new Error(
        `Code Graph builds completed before responsiveness interaction ${index + 1}`,
      );
    }
    interactionsWithActiveBuilds += 1;
    await recordResponsiveTask(
      tasks,
      'type_during_code_graph_builds',
      () =>
        typeDraftAndWaitForPaint(page, {
          scenario: 'code-graph-concurrency',
          iteration: index + 1,
          characters: config.typingCharacters,
        }),
      {
        iteration: index + 1,
        characters: config.typingCharacters,
        activeBuilds: runtime.counts.running,
        queuedBuilds: runtime.counts.queued,
      },
      config.responsivenessBudgetMs,
    );
    await recordResponsiveTask(
      tasks,
      'navigate_during_code_graph_builds',
      async () => {
        await openPipelinesPage(page);
        await app.selectWorktree(WORKTREE_BRANCH, NO_ACTIVITY_RAIL);
        await expect(visibleChatPanel(page)).toBeVisible({ timeout: 30_000 });
        await nextPaint(page);
      },
      {
        iteration: index + 1,
        activeBuilds: runtime.counts.running,
        queuedBuilds: runtime.counts.queued,
      },
      config.responsivenessBudgetMs,
    );
  }

  const completedRuntime = await recordTask(
    tasks,
    'all_code_graph_builds_complete',
    () =>
      waitUntil(
        async () => {
          const runtime = await observeRuntime();
          return runtime.builds?.completed === fixture.worktrees.length &&
            (backgroundScheduler ? runtime.counts.total === 0 : true)
            ? runtime
            : false;
        },
        {
          timeoutMs: 31 * 60_000,
          label: 'all Code Graph build requests to complete',
          intervalMs: 100,
        },
      ),
    { requestedBuilds: fixture.worktrees.length },
  );
  await stopCodeGraphAdmissionTracking(page);

  const failedBuilds = completedRuntime.builds.results.filter((result) => {
    if (result?.status !== 'fulfilled' || result.value?.ok === false) {
      return true;
    }
    return !backgroundScheduler && result.value?.state !== 'ready';
  });
  if (failedBuilds.length > 0) {
    throw new Error(
      `Code Graph fixture had ${failedBuilds.length} failed build response(s): ${JSON.stringify(failedBuilds.slice(0, 3))}`,
    );
  }
  await recordTask(tasks, 'code_graph_queue_drained', () =>
    waitForCodeGraphQueueDrain(async () => {
      if (backgroundScheduler) return (await observeRuntime()).counts;
      // Summary buildState deliberately ignores derived drains. No daemon
      // queue/completion push reaches the app, and generation reports answer
      // before derived analysis exits. Keep local queue drain unchanged and
      // also wait for this fixture daemon's actual writers to exit.
      const local = codeGraphQueueCounts(await readCodeGraphQueue(page));
      const writers = readDaemonCodeGraphWriters(fixture.dataRoot);
      return {
        ...local,
        total: local.total + writers.length,
        detail: `local queue entries=${local.total}; daemon writer PIDs=${JSON.stringify(writers)}`,
      };
    }),
  );
  if (backgroundScheduler && peakRunningBuilds !== 1) {
    throw new Error(
      `Background Code Graph scheduling reached ${peakRunningBuilds} concurrent builds; expected exactly one`,
    );
  }

  const graphArtifacts = fixture.worktrees.map((worktree) => {
    const dbPath = path.join(
      fixture.workspaceDir,
      'worktree-data',
      worktree.id,
      'code-graph',
      'graph.db',
    );
    if (!existsSync(dbPath)) {
      throw new Error(
        `Code Graph build did not create graph.db for ${worktree.id}`,
      );
    }
    return {
      bytes: statSync(dbPath).size,
      totals: readCodeGraphDbCounters(dbPath),
    };
  });
  const successfulBuildSummaries = backgroundScheduler
    ? graphArtifacts
    : completedRuntime.builds.results.map((entry) => entry.value);
  const failedSummaries = successfulBuildSummaries.filter((summary) =>
    backgroundScheduler
      ? summary.totals.fileCount === 0 || summary.totals.symbolCount === 0
      : summary?.ok === false || summary?.state !== 'ready',
  );
  if (failedSummaries.length > 0) {
    throw new Error(
      `Code Graph fixture had ${failedSummaries.length} non-ready summaries: ${JSON.stringify(failedSummaries.slice(0, 3))}`,
    );
  }
  const graphDbBytes = graphArtifacts.reduce(
    (total, artifact) => total + artifact.bytes,
    0,
  );
  const buildWallMs =
    completedRuntime.builds.completedAt - completedRuntime.builds.startedAt;

  return {
    requestedBuilds: fixture.worktrees.length,
    requestedFilesPerWorktree: fixture.filesPerWorktree,
    requestedFixtureFiles: fixture.worktrees.length * fixture.filesPerWorktree,
    completedBuilds: completedRuntime.builds.completed,
    peakRunningBuilds,
    peakQueuedBuilds,
    interactionsWithActiveBuilds,
    graphDbBytes,
    graphFileCount: successfulBuildSummaries.reduce(
      (total, summary) => total + summary.totals.fileCount,
      0,
    ),
    graphSymbolCount: successfulBuildSummaries.reduce(
      (total, summary) => total + summary.totals.symbolCount,
      0,
    ),
    graphEdgeCount: successfulBuildSummaries.reduce(
      (total, summary) => total + summary.totals.edgeCount,
      0,
    ),
    buildWallMs,
  };
}

async function runCodeGraphConcurrency(context) {
  return runCodeGraphConcurrencyMode(context, { backgroundScheduler: false });
}

async function runCodeGraphBackgroundConcurrency(context) {
  return runCodeGraphConcurrencyMode(context, { backgroundScheduler: true });
}

// ── Code-graph journeys: J7 and small edits ────────────────────────────────

// Test-tooling exception to the centralized binary lookup: fixture Git runs
// the host's PATH `git`, the same Git the seeders create fixture repositories
// with. The app's lookup (src/main/lib/git-executable.ts) reads app
// preferences in the main process and cannot load in this standalone harness;
// the app under test still resolves its own Git.
function gitQuiet(args, cwd) {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
}

function gitOutput(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function commitGraphFixtureAt(worktreePath, fileCount, message) {
  generateCodeGraphFixture(worktreePath, fileCount);
  gitQuiet(['add', 'graph-fixture'], worktreePath);
  gitQuiet(
    [
      '-c',
      'user.name=Canopy Performance',
      '-c',
      'user.email=performance@canopy.test',
      '-c',
      `core.hooksPath=${os.devNull}`,
      'commit',
      '-q',
      '-m',
      message,
    ],
    worktreePath,
  );
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: worktreePath,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/**
 * Deterministic edits for the small-edit refreshes: round `round` appends one
 * exported constant to each of the first `count` fixture modules.
 */
export function applyCodeGraphFixtureEdit(worktreePath, count, round) {
  const files = [];
  for (let index = 0; index < count; index += 1) {
    const filePath = path.join(worktreePath, 'graph-fixture', `mod${index}.ts`);
    writeFileSync(
      filePath,
      `${readFileSync(filePath, 'utf8')}\nexport const perfEdit${round}_${index} = ${round};\n`,
      'utf8',
    );
    files.push(filePath);
  }
  return files;
}

function codeGraphDbPath(workspaceDir, worktreeId) {
  return path.join(
    workspaceDir,
    'worktree-data',
    worktreeId,
    'code-graph',
    'graph.db',
  );
}

/**
 * The last build's phase timings and counts from graph metadata (phase 04's
 * `build_timing:*` keys) and the database's time to first graph, read-only
 * from the harness process.
 */
export function readCodeGraphBuildMetadata(dbPath) {
  const database = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = database
      .prepare(
        "SELECT key, value FROM graph_metadata WHERE key LIKE 'build_timing:%' OR key IN ('time_to_first_graph_ms', 'completed_build_at', 'last_build_at')",
      )
      .all();
    const build = {};
    const values = {};
    for (const row of rows) {
      const key = String(row.key);
      const value = Number(row.value);
      if (!Number.isFinite(value)) continue;
      if (key.startsWith('build_timing:')) {
        build[key.slice('build_timing:'.length)] = value;
      } else {
        values[key] = value;
      }
    }
    return {
      // The last build's timings and counts, without the key prefix.
      build,
      // Written once, by the build that completed the database's first graph.
      timeToFirstGraphMs: values.time_to_first_graph_ms,
      completedBuildAt: values.completed_build_at,
      lastBuildAt: values.last_build_at,
    };
  } finally {
    database.close();
  }
}

/** `code_graph_build` session diagnostics recorded for one worktree. */
export function readCodeGraphBuildDiagnostics(userDataDir, worktreeId) {
  const directory = path.join(
    userDataDir,
    'agent-observability',
    'diagnostics',
    'session-events',
  );
  if (!existsSync(directory)) return [];
  const records = [];
  for (const file of readdirSync(directory).sort()) {
    if (!file.endsWith('.jsonl')) continue;
    for (const line of readFileSync(path.join(directory, file), 'utf8').split(
      '\n',
    )) {
      if (!line.includes('"code_graph_build"')) continue;
      try {
        const record = JSON.parse(line);
        if (
          record.kind === 'code_graph_build' &&
          record.worktreeId === worktreeId
        ) {
          records.push(record);
        }
      } catch {
        // A partially written last line is read again on the next poll.
      }
    }
  }
  return records;
}

/**
 * Build work counts for the `codeGraph` work source: files scanned and
 * parsed from the build diagnostic, rows written, resolver passes run, and
 * whether FTS and derived analysis ran, plus the WAL and RSS high-water
 * marks. Durations become `timings` instead.
 */
export function codeGraphBuildWork(metadata, diagnostic) {
  const timings = diagnostic?.codeGraphBuild?.timings;
  const resolverPasses = Object.keys(
    timings?.resolveMs ??
      Object.fromEntries(
        Object.entries(metadata).filter(([key]) => key.startsWith('resolve_')),
      ),
  ).length;
  const work = {
    filesScanned: diagnostic?.codeGraphBuild?.filesScanned,
    filesParsed: diagnostic?.codeGraphBuild?.filesParsed,
    rowsWritten: metadata.rows_written ?? timings?.rowsWritten,
    resolverPasses,
    ftsRebuilds: metadata.fts_ms === undefined ? 0 : 1,
    derivedRuns: metadata.derived_ms === undefined ? 0 : 1,
    peakWalBytes: metadata.peak_wal_bytes,
    walGrowthBytes:
      Number.isFinite(metadata.peak_wal_bytes) &&
      Number.isFinite(metadata.wal_start_bytes)
        ? metadata.peak_wal_bytes - metadata.wal_start_bytes
        : undefined,
    peakRssBytes: metadata.peak_rss_bytes,
  };
  return Object.fromEntries(
    Object.entries(work).filter(([, value]) => Number.isFinite(value)),
  );
}

/** Phase durations from build metadata, for the `timings` metrics. */
export function codeGraphBuildTimings(metadata, extra = {}) {
  const timings = Object.fromEntries(
    Object.entries(metadata).filter(
      ([key, value]) => key.endsWith('_ms') && Number.isFinite(value),
    ),
  );
  return { ...timings, ...extra };
}

async function readWorktreeGraphSummary(page, worktreeId) {
  return page.evaluate(
    ({ workspaceId, targetWorktreeId }) =>
      window.api.codeGraphGetWorktreeSummary({
        workspaceId,
        worktreeId: targetWorktreeId,
      }),
    { workspaceId: WORKSPACE_ID, targetWorktreeId: worktreeId },
  );
}

async function readCodeGraphQueue(page) {
  return page.evaluate(() => window.api.codeGraphGetGenerationQueue());
}

/** Starts production-scheduler builds without awaiting them in the page. */
function startScheduledCodeGraphBuilds(page, worktreeIds, key) {
  return page.evaluate(
    ({ workspaceId, targetWorktreeIds, stateKey }) => {
      const state = { completed: 0, results: [] };
      window[stateKey] = state;
      for (const worktreeId of targetWorktreeIds) {
        window.api
          .codeGraphSchedulePerformanceBuild({ workspaceId, worktreeId })
          .then(
            (value) => state.results.push({ worktreeId, value }),
            (error) => state.results.push({ worktreeId, error: String(error) }),
          )
          .finally(() => {
            state.completed += 1;
          });
      }
    },
    {
      workspaceId: WORKSPACE_ID,
      targetWorktreeIds: worktreeIds,
      stateKey: key,
    },
  );
}

async function readScheduledCodeGraphBuilds(page, key) {
  return page.evaluate((stateKey) => window[stateKey] ?? null, key);
}

/**
 * Every listed worktree has a completed graph and the generation queue is
 * empty. Startup availability reconciliation builds each worktree through the
 * production scheduler (this scenario opts into it); a worktree it has not
 * reached once the queue drains is requested through the same scheduler.
 */
async function ensureCodeGraphsReady(page, worktreeIds, timeoutMs) {
  const requested = new Set();
  await waitUntil(
    async () => {
      const queue = await readCodeGraphQueue(page);
      const missing = [];
      for (const worktreeId of worktreeIds) {
        const summary = await readWorktreeGraphSummary(page, worktreeId);
        if (summary?.state !== 'ready') missing.push(worktreeId);
      }
      if (missing.length === 0 && queue.entries.length === 0) return true;
      const unrequested = missing.filter((id) => !requested.has(id));
      if (queue.entries.length === 0 && unrequested.length > 0) {
        for (const id of unrequested) requested.add(id);
        await startScheduledCodeGraphBuilds(
          page,
          unrequested,
          '__CANOPY_PERF_INITIAL_GRAPHS__',
        );
      }
      return false;
    },
    {
      timeoutMs,
      label: `${worktreeIds.length} initial Code Graphs`,
      intervalMs: 500,
    },
  );
  return { requestedByHarness: requested.size };
}

async function waitForBuildDiagnostic(
  userDataDir,
  worktreeId,
  previousCount,
  timeoutMs = 30_000,
) {
  return waitUntil(
    () => {
      const records = readCodeGraphBuildDiagnostics(userDataDir, worktreeId);
      return records.length > previousCount ? records.at(-1) : false;
    },
    {
      timeoutMs,
      label: `a code_graph_build diagnostic for ${worktreeId}`,
      intervalMs: 100,
    },
  );
}

function prepareCodeGraphNewWorktree(userDataDir, config) {
  const seed = seedWorkspace(userDataDir);
  const repoPath = seed.workspaces[0]?.repoPath;
  const mainWorktreePath = seed.workspaces[0]?.worktreePath;
  if (!repoPath || !mainWorktreePath) {
    throw new Error('Code Graph new-worktree fixture has no source checkout');
  }
  // The fixture lives on main, so every worktree, including the one the run
  // creates from the workspace base, checks it out without a branch diff.
  const fixtureCommit = commitGraphFixtureAt(
    repoPath,
    config.codeGraphNewWorktreeFiles,
    'Add the Code Graph new-worktree fixture',
  );
  gitQuiet(['update-ref', 'refs/heads/main', fixtureCommit], repoPath);
  gitQuiet(['merge', '-q', '--ff-only', fixtureCommit], mainWorktreePath);
  seedPreexistingWorktrees(
    userDataDir,
    config.codeGraphQueuedRefreshes + 1,
    seed,
  );
  // Worktree creation runs the workspace setup script before its first graph;
  // a no-op keeps that phase deterministic and offline.
  updateWorkspaceScripts(userDataDir, { setup: buildNodeEvalCommand('') });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [{ id: 'code-graph-journey-chat', title: 'Code Graph Journey' }],
  });
  const workspaceDir = path.join(userDataDir, 'workspaces', WORKSPACE_ID);
  const persisted = JSON.parse(
    readFileSync(path.join(workspaceDir, 'worktrees.json'), 'utf8'),
  );
  const worktrees = persisted.worktrees.map((worktree) => ({
    id: worktree.id,
    path:
      worktree.id === WORKTREE_ID
        ? mainWorktreePath
        : path.join(workspaceDir, 'worktrees', worktree.id),
  }));
  return {
    workspaceDir,
    userDataDir,
    worktrees,
    refreshWorktrees: worktrees.filter(
      (worktree) => worktree.id !== WORKTREE_ID,
    ),
    filesPerWorktree: config.codeGraphNewWorktreeFiles,
  };
}

async function runCodeGraphNewWorktree({ page, app, tasks, fixture }) {
  await openMainPage(page);
  await recordTask(tasks, 'load_code_graph_worktrees', () =>
    waitUntil(
      async () => {
        const ids = await worktreeIds(page);
        return ids.length >= fixture.worktrees.length ? ids.length : false;
      },
      {
        timeoutMs: 60_000,
        label: `${fixture.worktrees.length} Code Graph worktrees`,
      },
    ),
  );
  await app.selectWorktree(WORKTREE_BRANCH, NO_ACTIVITY_RAIL);
  const initial = await recordTask(tasks, 'build_initial_code_graphs', () =>
    ensureCodeGraphsReady(
      page,
      fixture.worktrees.map((worktree) => worktree.id),
      30 * 60_000,
    ),
  );

  // K worktrees each edit one file and request a refresh, so the new
  // worktree's first graph queues behind running and queued refreshes.
  await recordTask(
    tasks,
    'queue_code_graph_refreshes',
    async () => {
      fixture.refreshWorktrees.forEach((worktree, index) =>
        applyCodeGraphFixtureEdit(worktree.path, 1, index + 1),
      );
      await startScheduledCodeGraphBuilds(
        page,
        fixture.refreshWorktrees.map((worktree) => worktree.id),
        '__CANOPY_PERF_QUEUED_REFRESHES__',
      );
      await waitUntil(
        async () => {
          const counts = codeGraphQueueCounts(await readCodeGraphQueue(page));
          return counts.running >= 1 && counts.queued >= 1 ? counts : false;
        },
        {
          timeoutMs: 120_000,
          label: 'running and queued Code Graph refreshes',
          intervalMs: 25,
        },
      );
    },
    { queuedRefreshes: fixture.refreshWorktrees.length },
  );

  // J7: worktree created -> Code Graph usable, with the queue wait split out.
  const knownIds = new Set(await worktreeIds(page));
  const journey = {};
  const queueAtCreation = codeGraphQueueCounts(await readCodeGraphQueue(page));
  const createdId = await recordTask(
    tasks,
    'j7_worktree_created_to_code_graph_usable',
    async () => {
      const startedAt = performance.now();
      const since = () => performance.now() - startedAt;
      const create = await workspaceCreateButton(page);
      await create.dispatchEvent('click');
      const id = await waitUntil(
        async () =>
          (await worktreeIds(page)).find(
            (candidate) => candidate && !knownIds.has(candidate),
          ),
        {
          timeoutMs: 45_000,
          label: 'new worktree row reservation',
          intervalMs: 25,
        },
      );
      journey.worktree_reserved_ms = since();
      await waitUntil(
        async () => {
          const queue = await readCodeGraphQueue(page);
          const entry = queue.entries.find(
            (candidate) => candidate.worktreeId === id,
          );
          if (entry) {
            journey.first_queued_ms ??= since();
            if (entry.status === 'running')
              journey.build_started_ms ??= since();
            if (Number.isFinite(entry.queuedAt))
              journey.queuedAtEpochMs = entry.queuedAt;
            if (Number.isFinite(entry.startedAt))
              journey.startedAtEpochMs = entry.startedAt;
          }
          const summary = await readWorktreeGraphSummary(page, id);
          return summary?.state === 'ready';
        },
        {
          timeoutMs: 30 * 60_000,
          label: `the new worktree ${id}'s Code Graph to become usable`,
          intervalMs: 100,
        },
      );
      journey.graph_usable_ms = since();
      return id;
    },
    { queuedRefreshes: fixture.refreshWorktrees.length },
  );

  await recordTask(tasks, 'all_code_graph_refreshes_complete', () =>
    waitUntil(
      async () => {
        const builds = await readScheduledCodeGraphBuilds(
          page,
          '__CANOPY_PERF_QUEUED_REFRESHES__',
        );
        const queue = await readCodeGraphQueue(page);
        return builds?.completed === fixture.refreshWorktrees.length &&
          queue.entries.length === 0
          ? builds
          : false;
      },
      {
        timeoutMs: 30 * 60_000,
        label: 'every queued Code Graph refresh to finish',
        intervalMs: 250,
      },
    ),
  );

  const dbPath = codeGraphDbPath(fixture.workspaceDir, createdId);
  if (!existsSync(dbPath)) {
    throw new Error(`The new worktree ${createdId} has no graph.db`);
  }
  const metadata = readCodeGraphBuildMetadata(dbPath);
  const diagnostic = await waitForBuildDiagnostic(
    fixture.userDataDir,
    createdId,
    0,
  ).catch(() => null);
  const harnessQueueWaitMs =
    Number.isFinite(journey.startedAtEpochMs) &&
    Number.isFinite(journey.queuedAtEpochMs)
      ? journey.startedAtEpochMs - journey.queuedAtEpochMs
      : undefined;
  tasks.timings.j7 = {
    worktree_reserved_ms: journey.worktree_reserved_ms,
    first_queued_ms: journey.first_queued_ms,
    build_started_ms: journey.build_started_ms,
    graph_usable_ms: journey.graph_usable_ms,
    ...(Number.isFinite(harnessQueueWaitMs)
      ? { queue_wait_ms: harnessQueueWaitMs }
      : {}),
    ...(Number.isFinite(metadata.build.queue_wait_ms)
      ? { engine_queue_wait_ms: metadata.build.queue_wait_ms }
      : {}),
    ...(Number.isFinite(metadata.timeToFirstGraphMs)
      ? { time_to_first_graph_ms: metadata.timeToFirstGraphMs }
      : {}),
  };
  tasks.timings.new_worktree_build = codeGraphBuildTimings(metadata.build, {
    ...(Number.isFinite(diagnostic?.codeGraphBuild?.totalMs)
      ? { main_total_ms: diagnostic.codeGraphBuild.totalMs }
      : {}),
  });
  const work = codeGraphBuildWork(metadata.build, diagnostic);
  tasks.extraWork.codeGraph = {
    ...Object.fromEntries(
      Object.entries(work).map(([key, value]) => [`newWorktree.${key}`, value]),
    ),
    'newWorktree.graphDbBytes': statSync(dbPath).size,
    queuedRefreshes: fixture.refreshWorktrees.length,
    'queueAtCreation.running': queueAtCreation.running,
    'queueAtCreation.queued': queueAtCreation.queued,
  };
  return {
    createdWorktreeId: createdId,
    queuedRefreshes: fixture.refreshWorktrees.length,
    filesPerWorktree: fixture.filesPerWorktree,
    initialGraphsRequestedByHarness: initial.requestedByHarness,
    queueAtCreation,
    diagnosticTrigger: diagnostic?.codeGraphBuild?.trigger ?? null,
  };
}

function prepareCodeGraphSmallEdit(userDataDir, config) {
  const seed = seedWorkspace(userDataDir);
  const mainWorktreePath = seed.workspaces[0]?.worktreePath;
  if (!mainWorktreePath) {
    throw new Error('Code Graph small-edit fixture has no default worktree');
  }
  const workspaceDir = path.join(userDataDir, 'workspaces', WORKSPACE_ID);
  const worktreesFilePath = path.join(workspaceDir, 'worktrees.json');
  const persisted = JSON.parse(readFileSync(worktreesFilePath, 'utf8'));
  // The large fixture is 13 times the small one in every profile, so the
  // scaling ratio compares like with like even at smoke size.
  const fixtures = [
    { size: 'small', files: config.codeGraphSmallEditSmallFiles },
    { size: 'large', files: config.codeGraphSmallEditLargeFiles },
  ].map((fixture, index) => {
    const id = `perf-graph-${fixture.size}`;
    const worktreePath = path.join(workspaceDir, 'worktrees', id);
    gitQuiet(
      [
        '-C',
        mainWorktreePath,
        'worktree',
        'add',
        '-q',
        '-b',
        id,
        worktreePath,
        'HEAD',
      ],
      mainWorktreePath,
    );
    const commit = commitGraphFixtureAt(
      worktreePath,
      fixture.files,
      `Add the ${fixture.size} Code Graph fixture`,
    );
    // A base branch at the fixture commit keeps the fixture out of the
    // worktree's branch diff; only the timed edits differ from it.
    const baseBranch = `${id}-base`;
    gitQuiet(['branch', baseBranch, commit], worktreePath);
    persisted.worktrees.push({
      id,
      branchName: id,
      createdAt: new Date(
        Date.parse('2026-07-01T12:00:00.000Z') + (index + 1) * 1_000,
      ).toISOString(),
      trackedBaseBranch: baseBranch,
    });
    return { ...fixture, id, worktreePath };
  });
  writeFileSync(
    worktreesFilePath,
    `${JSON.stringify(persisted, null, 2)}\n`,
    'utf8',
  );
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [{ id: 'code-graph-edit-chat', title: 'Code Graph Edits' }],
  });
  return { workspaceDir, userDataDir, fixtures };
}

async function runCodeGraphSmallEdit({ page, app, tasks, fixture }) {
  await openMainPage(page);
  await recordTask(tasks, 'load_code_graph_worktrees', () =>
    waitUntil(
      async () => {
        const ids = await worktreeIds(page);
        return fixture.fixtures.every((entry) => ids.includes(entry.id))
          ? ids.length
          : false;
      },
      { timeoutMs: 60_000, label: 'Code Graph small-edit worktrees' },
    ),
  );
  await app.selectWorktree(WORKTREE_BRANCH, NO_ACTIVITY_RAIL);
  await recordTask(tasks, 'build_initial_code_graphs', () =>
    ensureCodeGraphsReady(
      page,
      fixture.fixtures.map((entry) => entry.id),
      30 * 60_000,
    ),
  );

  const codeGraph = {};
  const refreshes = [];
  let round = 0;
  for (const editCount of [1, 10]) {
    for (const entry of fixture.fixtures) {
      round += 1;
      const previousDiagnostics = readCodeGraphBuildDiagnostics(
        fixture.userDataDir,
        entry.id,
      ).length;
      applyCodeGraphFixtureEdit(entry.worktreePath, editCount, round);
      const label = `edit${editCount}.${entry.size}`;
      // The production scheduler's core, awaited: fingerprint, queue, build.
      await recordTask(
        tasks,
        `refresh_after_${editCount}_file_edit_${entry.size}`,
        () =>
          page.evaluate(
            ({ workspaceId, worktreeId }) =>
              window.api.codeGraphSchedulePerformanceBuild({
                workspaceId,
                worktreeId,
              }),
            { workspaceId: WORKSPACE_ID, worktreeId: entry.id },
          ),
        { editedFiles: editCount, fixtureFiles: entry.files },
      );
      const diagnostic = await waitForBuildDiagnostic(
        fixture.userDataDir,
        entry.id,
        previousDiagnostics,
      );
      const metadata = readCodeGraphBuildMetadata(
        codeGraphDbPath(fixture.workspaceDir, entry.id),
      ).build;
      const work = codeGraphBuildWork(metadata, diagnostic);
      for (const [key, value] of Object.entries(work)) {
        codeGraph[`${label}.${key}`] = value;
      }
      tasks.timings[`edit${editCount}_${entry.size}`] = codeGraphBuildTimings(
        metadata,
        Number.isFinite(diagnostic?.codeGraphBuild?.totalMs)
          ? { main_total_ms: diagnostic.codeGraphBuild.totalMs }
          : {},
      );
      refreshes.push({
        label,
        outcome: diagnostic?.codeGraphBuild?.outcome ?? null,
        factsChanged: diagnostic?.codeGraphBuild?.factsChanged ?? null,
      });
    }
  }
  for (const entry of fixture.fixtures) {
    codeGraph[`${entry.size}.fixtureFiles`] = entry.files;
  }
  tasks.extraWork.codeGraph = codeGraph;
  const failed = refreshes.filter((refresh) => refresh.outcome !== 'success');
  if (failed.length > 0) {
    throw new Error(
      `Code Graph small-edit refreshes did not succeed: ${JSON.stringify(failed)}`,
    );
  }
  return {
    smallFixtureFiles: fixture.fixtures[0].files,
    largeFixtureFiles: fixture.fixtures[1].files,
    refreshes,
  };
}

async function prepareWorktreeConcurrency(userDataDir, config) {
  seedPreexistingWorktrees(userDataDir, config.preexistingWorktrees);
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [{ id: 'large-worktree-chat-1', title: 'Large Worktree Chat 1' }],
  });
  seedPerformancePipeline(userDataDir, config);
  await registerPerformanceChatScenarios(config);
}

async function runWorktreeConcurrency({ page, app, config, tasks }) {
  await openMainPage(page);
  const preexistingWorktreeCount = await recordTask(
    tasks,
    'load_preexisting_worktrees',
    () =>
      waitUntil(
        async () => {
          const ids = await worktreeIds(page);
          return ids.length === config.preexistingWorktrees
            ? ids.length
            : false;
        },
        {
          timeoutMs: 60_000,
          label: `${config.preexistingWorktrees} pre-existing worktree rows`,
        },
      ),
    { requestedWorktrees: config.preexistingWorktrees },
  );
  if (preexistingWorktreeCount <= 50) {
    throw new Error(
      `Large-worktree workload requires more than 50 worktrees; loaded ${preexistingWorktreeCount}`,
    );
  }

  await app.selectWorktree(WORKTREE_BRANCH, NO_ACTIVITY_RAIL);
  await expect(visibleChatPanel(page)).toBeVisible({ timeout: 30_000 });
  await openActivityRail(page);

  const { peakConcurrentTurns, tabIds } = await startConcurrentChats({
    page,
    config,
    tasks,
  });
  const cards = pipelineRunCards(page, PERFORMANCE_PIPELINE_NAME);
  const peakConcurrentRuns = await dispatchConcurrentPipelines({
    page,
    config,
    tasks,
    cards,
  });
  const overlapTurns = await activeTurnCount(page);
  const overlapRuns = (await cards.allTextContents()).filter((text) =>
    text.toLowerCase().includes('running'),
  ).length;
  if (overlapTurns === 0 || overlapRuns === 0) {
    throw new Error(
      `Concurrent work did not overlap after loading ${preexistingWorktreeCount} worktrees (chat turns=${overlapTurns}, pipeline runs=${overlapRuns})`,
    );
  }

  const probeTabId = await createResponsivenessChat(page, tasks);
  let interactionsWithCombinedLoad = 0;
  for (let index = 0; index < config.interactionIterations; index += 1) {
    const activeTurns = await activeTurnCount(page);
    const activeRuns = (await cards.allTextContents()).filter((text) =>
      text.toLowerCase().includes('running'),
    ).length;
    if (activeTurns > 0 && activeRuns > 0) {
      interactionsWithCombinedLoad += 1;
    }
    await recordResponsiveTask(
      tasks,
      'type_during_worktree_concurrency',
      () =>
        typeDraftAndWaitForPaint(page, {
          scenario: 'worktree-concurrency',
          iteration: index + 1,
          characters: config.typingCharacters,
        }),
      {
        iteration: index + 1,
        characters: config.typingCharacters,
        activeTurns,
        activeRuns,
        preexistingWorktrees: preexistingWorktreeCount,
      },
      config.responsivenessBudgetMs,
    );
    await recordResponsiveTask(
      tasks,
      'navigate_during_worktree_concurrency',
      async () => {
        const liveTab = page.getByTestId(tabIds[index % tabIds.length]);
        await liveTab.click();
        await expect(liveTab).toHaveAttribute('aria-selected', 'true');
        await openPipelinesPage(page);
        await app.selectWorktree(WORKTREE_BRANCH, NO_ACTIVITY_RAIL);
        await expect(page.getByTestId('page-main')).toBeVisible({
          timeout: 30_000,
        });
        const probeTab = page.getByTestId(probeTabId);
        await probeTab.click();
        await expect(probeTab).toHaveAttribute('aria-selected', 'true');
        await nextPaint(page);
      },
      {
        iteration: index + 1,
        activeTurns,
        activeRuns,
        preexistingWorktrees: preexistingWorktreeCount,
      },
      config.responsivenessBudgetMs,
    );
  }
  if (interactionsWithCombinedLoad === 0) {
    throw new Error(
      'Concurrent chats and pipelines completed before any large-worktree responsiveness interaction ran',
    );
  }

  await recordTask(tasks, 'all_concurrent_work_complete', async () => {
    await Promise.all([
      waitUntil(() => activeTurnCount(page).then((count) => count === 0), {
        timeoutMs: config.chatStreamMs + 120_000,
        label: 'all chat turns to complete under the large-worktree load',
        intervalMs: 250,
      }),
      waitForPipelinesComplete(cards, config),
    ]);
  });
  const laterTurnActivationMs = await activateLaterForegroundTurn({
    page,
    config,
    tasks,
    tabId: tabIds[0],
    chatIndex: 1,
  });

  return {
    preexistingWorktrees: preexistingWorktreeCount,
    requestedConcurrentTurns: config.concurrentChats,
    peakConcurrentTurns,
    requestedConcurrentRuns: config.concurrentPipelines,
    peakConcurrentRuns,
    overlapTurns,
    overlapRuns,
    interactionsWithCombinedLoad,
    streamedCharacters: config.concurrentChats * config.chatReplyCharacters,
    pipelineHoldMs: config.pipelineHoldMs,
    laterTurnActivationMs,
  };
}

async function runLargeTranscriptConcurrency({
  page,
  app,
  config,
  tasks,
  fixture,
}) {
  await openMainPage(page);
  await recordTask(tasks, 'load_large_transcript_worktrees', () =>
    waitUntil(
      async () => {
        const ids = await worktreeIds(page);
        return ids.length === fixture.preexistingWorktrees ? ids.length : false;
      },
      {
        timeoutMs: 60_000,
        label: `${fixture.preexistingWorktrees} pre-existing worktrees with ${fixture.worktrees.length} large-transcript worktrees`,
      },
    ),
  );

  const mainDescriptor =
    fixture.worktrees.find((worktree) => worktree.id === WORKTREE_ID) ??
    fixture.worktrees[0];
  await selectLargeTranscriptWorktree({
    page,
    app,
    descriptor: mainDescriptor,
  });

  const { peakConcurrentTurns, tabIds } = await startConcurrentChats({
    page,
    config,
    tasks,
  });
  // Keep the large-transcript cold-open path collapsed, then reveal the
  // pipeline action before dispatching runs from the activity rail.
  await expandDefaultActivityRail(page);
  const cards = pipelineRunCards(page, PERFORMANCE_PIPELINE_NAME);
  const peakConcurrentRuns = await dispatchConcurrentPipelines({
    page,
    config,
    tasks,
    cards,
  });
  const overlapTurns = await activeTurnCount(page);
  const overlapRuns = (await cards.allTextContents()).filter((text) =>
    text.toLowerCase().includes('running'),
  ).length;
  if (overlapTurns === 0 || overlapRuns === 0) {
    throw new Error(
      `Concurrent work did not overlap with the large-transcript fixture (chat turns=${overlapTurns}, pipeline runs=${overlapRuns})`,
    );
  }

  const probeTabId = await createResponsivenessChat(page, tasks);
  const navigationTargets =
    fixture.worktrees.length > 1
      ? fixture.worktrees.filter((worktree) => worktree.id !== WORKTREE_ID)
      : fixture.worktrees;
  let interactionsWithCombinedLoad = 0;
  let archiveViews = 0;
  for (
    let index = 0;
    index < config.largeTranscriptNavigationIterations;
    index += 1
  ) {
    const activeTurns = await activeTurnCount(page);
    const activeRuns = (await cards.allTextContents()).filter((text) =>
      text.toLowerCase().includes('running'),
    ).length;
    if (activeTurns > 0 && activeRuns > 0) {
      interactionsWithCombinedLoad += 1;
    }
    const descriptor = navigationTargets[index % navigationTargets.length];
    await recordResponsiveTask(
      tasks,
      'navigate_large_transcript_during_concurrency',
      () => selectLargeTranscriptWorktree({ page, app, descriptor }),
      {
        iteration: index + 1,
        activeTurns,
        activeRuns,
        shape: descriptor.shape,
        primaryMessages: descriptor.primaryMessageCount,
        liveFileBytes: descriptor.liveFileBytes,
        archiveFileBytes: descriptor.archiveFileBytes,
      },
      config.responsivenessBudgetMs,
    );
    await recordResponsiveTask(
      tasks,
      'type_during_large_transcript_concurrency',
      () =>
        typeDraftAndWaitForPaint(page, {
          scenario: 'large-transcript-concurrency',
          iteration: index + 1,
          characters: config.typingCharacters,
        }),
      {
        iteration: index + 1,
        characters: config.typingCharacters,
        activeTurns,
        activeRuns,
        shape: descriptor.shape,
      },
      config.responsivenessBudgetMs,
    );
    if (archiveViews < config.largeTranscriptArchiveViews) {
      await recordResponsiveTask(
        tasks,
        'open_large_archive_during_concurrency',
        () => openLargeArchivedTranscript(page, descriptor),
        {
          iteration: index + 1,
          activeTurns,
          activeRuns,
          archiveMessages: descriptor.archiveMessageCount,
          archiveFileBytes: descriptor.archiveFileBytes,
        },
        config.responsivenessBudgetMs,
      );
      archiveViews += 1;
    }
    await recordResponsiveTask(
      tasks,
      'return_to_concurrent_transcript_worktree',
      async () => {
        await selectLargeTranscriptWorktree({
          page,
          app,
          descriptor: mainDescriptor,
        });
        const probeTab = page.getByTestId(probeTabId);
        await probeTab.click();
        await expect(probeTab).toHaveAttribute('aria-selected', 'true');
        await nextPaint(page);
      },
      {
        iteration: index + 1,
        activeTurns,
        activeRuns,
      },
      config.responsivenessBudgetMs,
    );
  }
  if (interactionsWithCombinedLoad === 0) {
    throw new Error(
      'Concurrent chats and pipelines completed before any large-transcript interaction ran',
    );
  }

  await recordTask(
    tasks,
    'all_large_transcript_concurrency_complete',
    async () => {
      await Promise.all([
        waitUntil(() => activeTurnCount(page).then((count) => count === 0), {
          timeoutMs: config.chatStreamMs + 120_000,
          label: 'all chat turns to complete under the large-transcript load',
          intervalMs: 250,
        }),
        waitForPipelinesComplete(cards, config),
      ]);
    },
  );
  await selectLargeTranscriptWorktree({
    page,
    app,
    descriptor: mainDescriptor,
  });
  const laterTurnActivationMs = await activateLaterForegroundTurn({
    page,
    config,
    tasks,
    tabId: tabIds[0],
    chatIndex: 1,
  });
  const verifiedPipelineOutputBytes = await recordTask(
    tasks,
    'verify_large_transcript_pipeline_output',
    () => verifyPerformancePipelineOutput(page, cards),
  );

  return {
    ...largeTranscriptCounters(fixture),
    requestedConcurrentTurns: config.concurrentChats,
    peakConcurrentTurns,
    requestedConcurrentRuns: config.concurrentPipelines,
    peakConcurrentRuns,
    overlapTurns,
    overlapRuns,
    interactionsWithCombinedLoad,
    navigationIterations: config.largeTranscriptNavigationIterations,
    archiveViews,
    streamedCharacters: config.concurrentChats * config.chatReplyCharacters,
    laterTurnActivationMs,
    verifiedPipelineOutputBytes,
  };
}

function inflatePerformanceGitCheckout(seed, config) {
  const repoPath = seed.workspaces[0]?.repoPath;
  if (!repoPath) {
    throw new Error('Worktree performance fixture has no source repository');
  }
  const relativeRoot = 'performance-checkout-fixture';
  const fixtureRoot = path.join(repoPath, relativeRoot);
  const payload = Buffer.alloc(config.gitCheckoutFileBytes, 103);
  for (let index = 0; index < config.gitCheckoutFiles; index += 1) {
    const bucket = String(Math.floor(index / 250)).padStart(4, '0');
    const bucketPath = path.join(fixtureRoot, bucket);
    if (index % 250 === 0) {
      mkdirSync(bucketPath, { recursive: true });
    }
    writeFileSync(
      path.join(bucketPath, `${String(index).padStart(6, '0')}.txt`),
      payload,
    );
  }
  execFileSync('git', ['add', '--', relativeRoot], {
    cwd: repoPath,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  execFileSync(
    'git',
    [
      '-c',
      `core.hooksPath=${os.devNull}`,
      'commit',
      '-m',
      'Add performance checkout fixture',
    ],
    { cwd: repoPath, stdio: ['ignore', 'ignore', 'pipe'] },
  );
  const fixtureCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoPath,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  // The synthetic files make checkout materialization expensive; they are not
  // intended to simulate a giant branch diff. Advance the temporary fixture's
  // baseline ref too so Changed Files stays empty when the new worktree opens.
  execFileSync('git', ['update-ref', 'refs/heads/main', fixtureCommit], {
    cwd: repoPath,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
}

function prepareWorktrees(userDataDir, config) {
  const seed = seedWorkspace(userDataDir);
  inflatePerformanceGitCheckout(seed, config);
  // Hold each created worktree's checkout until its Git-pending probes ran,
  // so the measurement no longer depends on how fast the disk is (CAN-3804).
  const repoPath = seed.workspaces[0].repoPath;
  const gitGate = installWorktreeGitGate(repoPath, {
    gateDir: path.join(userDataDir, 'performance-git-gate'),
    maxHoldMs: config.gitGateMaxHoldMs,
  });
  const gitCheckoutConfig = readCheckoutGitConfig(repoPath);
  updateWorkspaceScripts(userDataDir, {
    setup: buildPerformanceScriptCommand(config),
  });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [{ id: 'worktree-responsiveness-chat', title: 'Responsiveness' }],
  });
  return { gitGate, gitCheckoutConfig };
}

function prepareBrowserPanels(userDataDir, config) {
  seedWorkspace(userDataDir);
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [{ id: 'browser-performance-chat', title: 'Browser Performance' }],
  });
  const partitionsDir = path.join(userDataDir, 'Partitions');
  mkdirSync(partitionsDir, { recursive: true });
  for (let index = 0; index < config.browserHistoricalPartitions; index += 1) {
    const partitionDir = path.join(
      partitionsDir,
      `canopy-browser-retired-project-${String(index).padStart(4, '0')}`,
    );
    mkdirSync(partitionDir, { recursive: true });
    writeFileSync(
      path.join(partitionDir, 'Preferences'),
      JSON.stringify({ seededHistoricalPartition: true, index }),
      'utf8',
    );
  }
  return {
    userDataDir,
    seededHistoricalPartitions: config.browserHistoricalPartitions,
  };
}

function prepareBrowserActions(userDataDir) {
  seedWorkspace(userDataDir);
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [{ id: 'browser-actions-chat', title: 'Browser Actions' }],
  });
  return {};
}

function prepareBrowserAgentActions(userDataDir) {
  seedWorkspace(userDataDir);
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [
      { id: 'browser-agent-actions-chat', title: 'Browser Agent Actions' },
    ],
  });
  return {};
}

function prepareInnerPanelCollapse(userDataDir) {
  seedInnerPanelLayout(userDataDir);
  return { userDataDir };
}

async function runInnerPanelCollapse({ page, app, config, tasks }) {
  await recordTask(tasks, 'inner_panels_workspace_ready', async () => {
    await openMainPage(page);
    await app.selectWorktree(WORKTREE_BRANCH, NO_ACTIVITY_RAIL);
    await expect(page.getByTestId('panel-group-inner-C')).toBeVisible({
      timeout: 30_000,
    });
  });

  const collapse = page.getByTestId('panel-group-collapse-inner-A');
  const expand = page.getByTestId('panel-group-expand-inner-A');
  await expect(collapse).toBeVisible();

  for (let index = 0; index < config.innerPanelCollapseWarmups; index += 1) {
    await collapse.click();
    await expect(expand).toBeVisible();
    await expand.click();
    await expect(collapse).toBeVisible();
    await nextPaint(page);
  }

  const collapseCycleDurationsMs = [];
  for (let index = 0; index < config.innerPanelCollapseIterations; index += 1) {
    const startedAt = performance.now();
    await recordTask(
      tasks,
      'inner_panel_collapse_cycle',
      async () => {
        await collapse.click();
        await expect(expand).toBeVisible();
        await expand.click();
        await expect(collapse).toBeVisible();
        await nextPaint(page);
      },
      { iteration: index + 1 },
    );
    collapseCycleDurationsMs.push(performance.now() - startedAt);
  }

  return {
    warmups: config.innerPanelCollapseWarmups,
    iterations: config.innerPanelCollapseIterations,
    collapseCycleDurationsMs,
    collapseCycleP50Ms: percentile(collapseCycleDurationsMs, 0.5),
    collapseCycleP95Ms: percentile(collapseCycleDurationsMs, 0.95),
    collapseCycleMaxMs: Math.max(...collapseCycleDurationsMs),
  };
}

const PLAN_OPEN_PLAN_ID = 'plan-open-large';

/**
 * `plan-open`: one large deterministic plan (ready sequence, logic, and data
 * model diagrams plus comment threads) beside two small plans and a hidden
 * one, all unshared so no cloud traffic is involved.
 */
export function preparePlanOpen(userDataDir, config) {
  const seed = seedWorkspace(userDataDir);
  const large = buildLargePlanFixture({
    id: PLAN_OPEN_PLAN_ID,
    projectId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    sections: config.planOpenSections,
    tasksPerSection: config.planOpenTasksPerSection,
    paragraphBytes: config.planOpenParagraphBytes,
    diagramTasksPerSection: config.planOpenDiagramTasksPerSection,
    commentThreads: config.planOpenCommentThreads,
  });
  const smallPlan = (id, title, extra = {}) =>
    buildTrackedPlan({
      id,
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      title,
      content: `# ${title}\n\n- Keep the plan list realistic.`,
      ...extra,
    });
  seedTrackedPlans({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    plans: [
      large.plan,
      smallPlan('plan-open-small-1', 'Plan open companion one'),
      smallPlan('plan-open-small-2', 'Plan open companion two'),
      smallPlan('plan-open-hidden', 'Plan open hidden companion', {
        hidden: true,
      }),
    ],
  });
  return {
    seed,
    planId: large.plan.id,
    sentinel: large.sentinel,
    logicNodeId: large.logicNodeId,
    contentBytes: large.contentBytes,
    sequenceNodeCount: large.sequenceNodeCount,
    logicNodeCount: large.logicNodeCount,
    commentThreadCount: large.commentThreadCount,
  };
}

/** Deterministic id of a plan's document panel (`panelPlanId` in
 * `../electron/planPanelHarness.mjs`, duplicated here rather than imported so
 * this byte-pinned driver keeps no dependency on that unpinned harness). */
function planOpenPanelId(fixture) {
  return `panel-plan-${fixture.planId}`;
}

/**
 * `'panel'` once the phase 06 cutover has landed (the plan opens as a
 * `panel-plan-<id>` document panel) or `'takeover'` on a tree that still
 * mounts the full-window `PlanExploreModal`. Read once per open so the same
 * driver bytes measure either build — phase 07 pairs a takeover build against
 * a panel build under one harness via `--release-like-root`.
 */
async function planOpenSurface(page) {
  const takeoverCount = await page.getByTestId('plan-explore-modal').count();
  return takeoverCount > 0 ? 'takeover' : 'panel';
}

// The steps that differ across the phase 06 takeover-to-panel cutover. Both
// surfaces render the same `PlanDocumentPanel`/`PlanVisualizerPanel`
// (`plan-explore-plan-panel`, `plan-explore-visualizer-panel`), so only the
// diagram tab switch and the close step vary; task names stay stable so
// `perf:desktop:compare` compares like for like across surfaces.
async function revealPlanDiagram(page, fixture, surface) {
  if (surface === 'panel') {
    // The panel surface tabs Document/Diagram in one pane instead of the
    // takeover's side-by-side layout; switch to the diagram tab first.
    await page.getByTestId('plan-panel-tab-diagram').click();
  }
  await page
    .getByTestId('plan-explore-visualizer-panel')
    .getByRole('tab', { name: 'Current/Planned/Diff', exact: true })
    .first()
    .click();
  await expect(
    page
      .getByTestId('plan-logic-diff-diagram')
      .locator(`.react-flow__node[data-id="${fixture.logicNodeId}"]`),
  ).toBeVisible({ timeout: 30_000 });
  await nextPaint(page);
}

async function closePlanView(page, fixture, surface) {
  if (surface === 'takeover') {
    await page.getByTestId('plan-explore-close').click();
    await expect(page.getByTestId('plan-explore-modal')).toHaveCount(0, {
      timeout: 30_000,
    });
    return;
  }
  // The panel surface closes like any other content panel, through its tab
  // strip's close button; rail re-expansion happens outside this timed step
  // (see the caller) since it is bookkeeping for the next iteration's row
  // click, not part of closing the plan view.
  await closePanelTab(page, planOpenPanelId(fixture));
}

async function waitForPlanDocument(page, fixture) {
  const planPanel = page.getByTestId('plan-explore-plan-panel');
  await expect(
    planPanel.getByText(fixture.sentinel, { exact: true }),
  ).toBeAttached({ timeout: 30_000 });
  await expect(planPanel.locator('[data-sourcepos]').first()).toBeVisible({
    timeout: 30_000,
  });
}

async function runPlanOpen({ page, app, config, tasks, fixture }) {
  const row = page.getByTestId(`activity-plan-row-${fixture.planId}`);
  await recordTask(tasks, 'plan_open_workspace_ready', async () => {
    await openMainPage(page);
    // The plan list lives in the activity rail, so keep it expanded.
    await app.selectWorktree(WORKTREE_BRANCH);
    await expect(row).toBeVisible({ timeout: 30_000 });
  });

  let surface;
  const openDurationsMs = [];
  const diagramSwitchDurationsMs = [];
  for (let index = 0; index < config.planOpenIterations; index += 1) {
    const iteration = index + 1;
    await recordResponsiveTask(
      tasks,
      index === 0 ? 'plan_open_cold' : 'plan_open_warm',
      async () => {
        await row.click();
        await waitForPlanDocument(page, fixture);
        await nextPaint(page);
      },
      { iteration },
      config.responsivenessBudgetMs,
    );
    openDurationsMs.push(tasks.at(-1).durationMs);
    // The surface never changes mid-run (it is a property of the build under
    // test); read it once after the first open, outside the timed step.
    if (surface === undefined) {
      surface = await planOpenSurface(page);
    }

    await recordResponsiveTask(
      tasks,
      'plan_diagram_switch',
      () => revealPlanDiagram(page, fixture, surface),
      { iteration },
      config.responsivenessBudgetMs,
    );
    diagramSwitchDurationsMs.push(tasks.at(-1).durationMs);

    // Close between opens: clicking the row under an open view is not a
    // fresh open.
    await recordTask(
      tasks,
      'plan_close',
      () => closePlanView(page, fixture, surface),
      { iteration },
    );
    if (surface === 'panel') {
      // Opening the plan panel collapses the activity rail that holds the
      // row (the side-open policy collapses the full-height rail it splits
      // from); re-expand it so the next iteration can click the row again.
      // Kept outside both the 'plan_close' and next 'plan_open' timed steps.
      await expandDefaultActivityRail(page);
    }
  }

  const warmOpenDurationsMs = openDurationsMs.slice(1);
  return {
    surface,
    planContentBytes: fixture.contentBytes,
    sequenceNodeCount: fixture.sequenceNodeCount,
    logicNodeCount: fixture.logicNodeCount,
    commentThreadCount: fixture.commentThreadCount,
    iterations: config.planOpenIterations,
    openColdMs: openDurationsMs[0],
    openWarmP50Ms: percentile(warmOpenDurationsMs, 0.5),
    openWarmP95Ms: percentile(warmOpenDurationsMs, 0.95),
    diagramSwitchP50Ms: percentile(diagramSwitchDurationsMs, 0.5),
    diagramSwitchP95Ms: percentile(diagramSwitchDurationsMs, 0.95),
    openDurationsMs,
    diagramSwitchDurationsMs,
  };
}

export function parseBrowserPartitionHandles(output) {
  const partitions = new Set();
  let handleCount = 0;
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/\/Partitions\/([^/\s]+)/);
    if (!match) continue;
    handleCount += 1;
    partitions.add(match[1]);
  }
  return {
    handleCount,
    partitionCount: partitions.size,
    partitions: [...partitions].sort(),
  };
}

async function browserPartitionHandleStats(electronApp) {
  if (process.platform !== 'darwin') return null;
  const pids = await electronApp.evaluate(({ app }) => [
    process.pid,
    ...app.getAppMetrics().map((metric) => metric.pid),
  ]);
  try {
    const output = execFileSync(
      'lsof',
      ['-a', '-p', [...new Set(pids)].join(',')],
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
    );
    return parseBrowserPartitionHandles(output);
  } catch {
    return null;
  }
}

function browserPartitionDiskStats(userDataDir) {
  const partitionsDir = path.join(userDataDir, 'Partitions');
  const entries = existsSync(partitionsDir)
    ? readdirSync(partitionsDir, { withFileTypes: true })
    : [];
  return {
    partitionCount: entries.filter((entry) => entry.isDirectory()).length,
  };
}

async function browserPanelBindings(page) {
  const layout = await getLayout(page);
  if (!layout) return [];
  return collectLeaves(layout.root).flatMap((leaf) =>
    leaf.panels
      .filter((panel) => panel.kind === 'browser' && panel.instance?.browserId)
      .map((panel) => ({
        groupId: leaf.groupId,
        panelId: panel.panelId,
        browserId: panel.instance.browserId,
      })),
  );
}

async function openPanelAddMenu(page, groupId) {
  // Classic rows have a separate Add panel control; standard filled rows
  // open the same menu from their tab-strip + control.
  const classic = page.getByTestId(`panel-add-panel-${groupId}`);
  if (await classic.isVisible()) await classic.click();
  else await page.getByTestId(`panel-add-tab-${groupId}`).click();
}

async function addBrowserPanel(page, expectedCount) {
  await openPanelAddMenu(page, 'group-chat');
  await expect(page.getByTestId('panel-add-menu')).toBeVisible();
  await page.getByTestId('panel-add-menu-item-browser').click();
  // A binding is inserted before async activation finishes. Match the durable
  // browser-chrome flow: wait for the transaction's menu closure before another
  // Add click, which would otherwise toggle the still-open menu closed.
  await expect(page.getByTestId('panel-add-menu')).toBeHidden({
    timeout: 15_000,
  });
  await expect
    .poll(
      () => browserPanelBindings(page).then((bindings) => bindings.length),
      {
        timeout: 30_000,
      },
    )
    .toBe(expectedCount);
}

async function electronProcessStats(electronApp) {
  return electronApp.evaluate(({ app }) => {
    const metrics = app.getAppMetrics();
    const renderers = metrics.filter(
      (metric) => metric.type === 'Tab' || metric.type === 'Renderer',
    );
    return {
      rendererProcessCount: renderers.length,
      rendererWorkingSetMb:
        renderers.reduce(
          (total, metric) => total + (metric.memory?.workingSetSize ?? 0),
          0,
        ) / 1024,
      totalWorkingSetMb:
        metrics.reduce(
          (total, metric) => total + (metric.memory?.workingSetSize ?? 0),
          0,
        ) / 1024,
    };
  });
}

async function browserResourceStats(page) {
  return page.evaluate(async () => {
    const snapshot = await window.api.getResourceMonitorSnapshot();
    const group = snapshot.groups.find(
      (candidate) => candidate.id === 'browser',
    );
    return {
      registeredViews: group?.items.length ?? 0,
      processCount: group?.processCount ?? 0,
      memoryRssMb: (group?.memoryRssBytes ?? 0) / 1024 / 1024,
    };
  });
}

async function runBrowserPanels({
  page,
  app,
  electronApp,
  config,
  fixture,
  tasks,
}) {
  await recordTask(tasks, 'browser_workspace_ready', async () => {
    await openMainPage(page);
    await app.selectWorktree(WORKTREE_BRANCH, NO_ACTIVITY_RAIL);
    await expect(visibleChatPanel(page)).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(() => page.evaluate(() => Boolean(window.__canopyPanelTestApi)), {
        timeout: 15_000,
      })
      .toBe(true);
  });

  await recordTask(tasks, 'browser_create_two_panels', async () => {
    await addBrowserPanel(page, 1);
    await addBrowserPanel(page, 2);
  });

  const bindings = await browserPanelBindings(page);
  if (bindings.length !== 2) {
    throw new Error(`Expected two Browser panels; found ${bindings.length}`);
  }
  const [first, second] = bindings;
  await recordTask(tasks, 'browser_arrange_side_by_side', async () => {
    await movePanelViaApi(page, second.panelId, first.groupId, 'right');
    await expect(
      page.locator('[data-testid="panel-content-browser"]:visible'),
    ).toHaveCount(2, { timeout: 30_000 });
    await nextPaint(page);
  });

  const fixtureUrls = [
    `${PERFORMANCE_MOCK_BASE_URL}/browser-fixture/one`,
    `${PERFORMANCE_MOCK_BASE_URL}/browser-fixture/two`,
  ];
  await recordTask(tasks, 'browser_both_usable', async () => {
    // Tabs are placed before native creation finishes. Navigation requires the
    // same live-session readiness that the user-facing Browser pane exposes.
    for (const binding of [first, second])
      await expect(
        page.getByTestId(`browser-pane-${binding.browserId}`),
      ).toHaveAttribute('data-browser-state', 'live', { timeout: 30_000 });
    const snapshots = await page.evaluate(
      async ({ firstId, secondId, firstUrl, secondUrl }) =>
        Promise.all([
          window.api.browser.navigate({ browserId: firstId, url: firstUrl }),
          window.api.browser.navigate({ browserId: secondId, url: secondUrl }),
        ]),
      {
        firstId: first.browserId,
        secondId: second.browserId,
        firstUrl: fixtureUrls[0],
        secondUrl: fixtureUrls[1],
      },
    );
    if (
      snapshots[0]?.url !== fixtureUrls[0] ||
      snapshots[1]?.url !== fixtureUrls[1]
    ) {
      throw new Error('Browser fixture navigation did not stay exact-ID.');
    }
    await waitUntil(
      async () => (await browserResourceStats(page)).registeredViews >= 2,
      {
        timeoutMs: 30_000,
        label: 'two Browser live-view registrations',
        intervalMs: 250,
      },
    );
    await nextPaint(page);
  });

  const beforeClose = {
    processes: await electronProcessStats(electronApp),
    resources: await browserResourceStats(page),
    partitionHandles: await browserPartitionHandleStats(electronApp),
    partitionDisk: browserPartitionDiskStats(fixture.userDataDir),
  };

  await recordTask(tasks, 'browser_switch_tabs', async () => {
    const chatTab = page
      .locator('[role="tab"][data-panel-kind="chat"]')
      .first();
    await chatTab.click();
    await expect(chatTab).toHaveAttribute('aria-selected', 'true');
    const firstBrowserTab = page.getByTestId(`panel-tab-${first.panelId}`);
    await firstBrowserTab.click();
    await expect(firstBrowserTab).toHaveAttribute('aria-selected', 'true');
    await nextPaint(page);
  });

  await recordTask(tasks, 'browser_open_close_overlay', async () => {
    await openPanelAddMenu(page, first.groupId);
    await expect(page.getByTestId('panel-add-menu')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('panel-add-menu')).toBeHidden();
    await nextPaint(page);
  });

  const closePanelDurationsMs = [];
  await recordTask(tasks, 'browser_close_two_panels', async () => {
    let closeStartedAt = performance.now();
    await page.getByTestId(`panel-tab-${second.panelId}`).hover();
    await page.getByTestId(`panel-tab-close-${second.panelId}`).click();
    await expect(page.getByTestId(`panel-tab-${second.panelId}`)).toHaveCount(
      0,
    );
    closePanelDurationsMs.push(performance.now() - closeStartedAt);
    closeStartedAt = performance.now();
    await page.getByTestId(`panel-tab-${first.panelId}`).hover();
    await page.getByTestId(`panel-tab-close-${first.panelId}`).click();
    await expect(page.getByTestId(`panel-tab-${first.panelId}`)).toHaveCount(0);
    closePanelDurationsMs.push(performance.now() - closeStartedAt);
    await nextPaint(page);
  });
  const afterPanelClose = {
    processes: await electronProcessStats(electronApp),
    resources: await browserResourceStats(page),
    partitionHandles: await browserPartitionHandleStats(electronApp),
    partitionDisk: browserPartitionDiskStats(fixture.userDataDir),
  };
  await recordTask(tasks, 'browser_resource_monitor_converge', async () => {
    await waitUntil(
      async () => (await browserResourceStats(page)).registeredViews === 0,
      {
        timeoutMs: 30_000,
        label: 'Browser live-view registrations to be released',
        intervalMs: 250,
      },
    );
  });

  const afterClose = {
    processes: await electronProcessStats(electronApp),
    resources: await browserResourceStats(page),
    partitionHandles: await browserPartitionHandleStats(electronApp),
    partitionDisk: browserPartitionDiskStats(fixture.userDataDir),
  };

  await recordTask(tasks, 'browser_post_close_settle', async () => {
    await delay(config.browserPostCloseSettleMs);
  });
  const afterCloseSettled = {
    processes: await electronProcessStats(electronApp),
    resources: await browserResourceStats(page),
    partitionHandles: await browserPartitionHandleStats(electronApp),
    partitionDisk: browserPartitionDiskStats(fixture.userDataDir),
  };

  let repeatedBinding;
  await recordTask(tasks, 'browser_reopen_panel', async () => {
    await addBrowserPanel(page, 1);
    const [binding] = await browserPanelBindings(page);
    if (!binding) throw new Error('Repeated Browser panel was not bound.');
    repeatedBinding = binding;
    await expect(
      page.getByTestId(`browser-pane-${binding.browserId}`),
    ).toHaveAttribute('data-browser-state', 'live', { timeout: 30_000 });
    const snapshot = await page.evaluate(
      async ({ browserId, url }) =>
        window.api.browser.navigate({ browserId, url }),
      { browserId: binding.browserId, url: fixtureUrls[0] },
    );
    if (snapshot?.url !== fixtureUrls[0]) {
      throw new Error('Repeated Browser fixture navigation was not exact-ID.');
    }
    await waitUntil(
      async () => (await browserResourceStats(page)).registeredViews === 1,
      {
        timeoutMs: 30_000,
        label: 'repeated Browser live-view registration',
        intervalMs: 250,
      },
    );
  });
  let repeatedCloseDurationMs = 0;
  await recordTask(tasks, 'browser_close_reopened_panel', async () => {
    if (!repeatedBinding) {
      throw new Error('Repeated Browser panel binding was lost.');
    }
    const closeStartedAt = performance.now();
    await page.getByTestId(`panel-tab-${repeatedBinding.panelId}`).hover();
    await page
      .getByTestId(`panel-tab-close-${repeatedBinding.panelId}`)
      .click();
    await expect(
      page.getByTestId(`panel-tab-${repeatedBinding.panelId}`),
    ).toHaveCount(0);
    repeatedCloseDurationMs = performance.now() - closeStartedAt;
    await nextPaint(page);
  });
  await recordTask(
    tasks,
    'browser_repeated_resource_monitor_converge',
    async () => {
      await waitUntil(
        async () => (await browserResourceStats(page)).registeredViews === 0,
        {
          timeoutMs: 30_000,
          label: 'repeated Browser live-view registration to be released',
          intervalMs: 250,
        },
      );
    },
  );
  await delay(config.browserPostCloseSettleMs);
  const afterRepeatedCloseSettled = {
    processes: await electronProcessStats(electronApp),
    resources: await browserResourceStats(page),
    partitionHandles: await browserPartitionHandleStats(electronApp),
    partitionDisk: browserPartitionDiskStats(fixture.userDataDir),
  };
  return {
    panelsCreated: bindings.length,
    lifecycleCycles: 2,
    seededHistoricalPartitions: fixture.seededHistoricalPartitions,
    exactBrowserIds: bindings.map((binding) => binding.browserId),
    beforeClose,
    afterPanelClose,
    afterClose,
    afterCloseSettled,
    afterRepeatedCloseSettled,
    closePanelDurationsMs,
    repeatedCloseDurationMs,
    releasedRegisteredViews:
      beforeClose.resources.registeredViews -
      afterClose.resources.registeredViews,
    rendererProcessDeltaAfterClose:
      afterClose.processes.rendererProcessCount -
      beforeClose.processes.rendererProcessCount,
    totalWorkingSetDeltaMb:
      afterClose.processes.totalWorkingSetMb -
      beforeClose.processes.totalWorkingSetMb,
  };
}

/** A single live Browser tab exercises the same automation IPC used by the
 * App Advisor renderer dispatcher. Keep the action script byte-identical for
 * E2E-relative and production-bundle measurements. */
async function setupBrowserActions({ page, app, config, fixture }) {
  const lab = createBrowserLabServer();
  fixture.lab = lab;
  await new Promise((resolve, reject) => {
    lab.once('error', reject);
    lab.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${lab.address().port}`;
  await openMainPage(page);
  await app.selectWorktree(WORKTREE_BRANCH, NO_ACTIVITY_RAIL);
  await expect(visibleChatPanel(page)).toBeVisible({ timeout: 30_000 });
  // Read the rendered tab/pane rather than the E2E-only panel test API:
  // production bundles intentionally do not install that automation seam.
  await openPanelAddMenu(page, 'group-chat');
  await expect(page.getByTestId('panel-add-menu')).toBeVisible();
  await page.getByTestId('panel-add-menu-item-browser').click();
  await expect(page.getByTestId('panel-add-menu')).toBeHidden();
  const browserTab = page.locator('[role="tab"][data-panel-kind="browser"]');
  const browserPane = page.locator(
    '[data-testid^="browser-pane-"][data-browser-state]',
  );
  await expect(browserTab).toHaveCount(1, { timeout: 30_000 });
  await expect(browserPane).toHaveCount(1, { timeout: 30_000 });
  await expect(browserPane).toHaveAttribute('data-browser-state', 'live', {
    timeout: 30_000,
  });
  const panelId = (await browserTab.getAttribute('data-testid'))?.slice(
    'panel-tab-'.length,
  );
  const browserId = (await browserPane.getAttribute('data-testid'))?.slice(
    'browser-pane-'.length,
  );
  if (!panelId || !browserId)
    throw new Error('Browser action panel was not bound.');
  const binding = { panelId, browserId };

  const navigate = async (pathName) => {
    const url = `${origin}/browser-lab/${pathName}`;
    const snapshot = await page.evaluate(
      ({ browserId, url }) => window.api.browser.navigate({ browserId, url }),
      { browserId: binding.browserId, url },
    );
    if (snapshot?.url !== url) {
      throw new Error(`Browser Lab navigation failed: ${pathName}`);
    }
    const locator =
      pathName === 'menus'
        ? '[data-testid="browser-lab-menus-pointer-trigger"]'
        : '[data-testid="browser-lab-controls-enter-input"]';
    await waitUntil(
      () =>
        page.evaluate(
          ({ browserId, locator }) =>
            window.api.browser.inspect({ browserId, locator }),
          { browserId: binding.browserId, locator },
        ),
      { timeoutMs: 15_000, label: `Browser Lab ${pathName} target` },
    );
  };
  const action = async (command, kind, iteration, samples, tasks) => {
    const invoke = async () => {
      const response = await page.evaluate(
        ({ browserId, command }) =>
          window.api.browser.automation({ browserId, command }),
        { browserId: binding.browserId, command },
      );
      if (!response?.ok || response.completed === false) {
        throw new Error(
          `Browser ${kind} did not complete: ${JSON.stringify(response?.error ?? response?.dialog ?? response)}`,
        );
      }
    };
    if (samples) {
      await recordTask(tasks, kind, invoke, { iteration });
      samples.push(tasks.at(-1).durationMs);
    } else {
      await invoke();
    }
  };

  const latenciesMs = { click: [], fill: [], pressEnter: [], pressTab: [] };
  const runIteration = async (iteration, samples, tasks) => {
    await navigate('menus');
    await action(
      {
        kind: 'click',
        locator: '[data-testid="browser-lab-menus-pointer-trigger"]',
      },
      'browser_action_click',
      iteration,
      samples ? latenciesMs.click : null,
      tasks,
    );
    await navigate('controls');
    const locator = '[data-testid="browser-lab-controls-enter-input"]';
    await action(
      { kind: 'fill', locator, text: `canopy-action-${iteration}` },
      'browser_action_fill',
      iteration,
      samples ? latenciesMs.fill : null,
      tasks,
    );
    await action(
      { kind: 'press', locator, key: 'Enter' },
      'browser_action_press_enter',
      iteration,
      samples ? latenciesMs.pressEnter : null,
      tasks,
    );
    await action(
      { kind: 'press', locator, key: 'Tab' },
      'browser_action_press_tab',
      iteration,
      samples ? latenciesMs.pressTab : null,
      tasks,
    );
    // The Enter handler posts only to the isolated loopback lab. Give that
    // fixed local response time to settle before the next navigation.
    await delay(50);
  };

  for (let index = 0; index < config.browserActionWarmups; index += 1) {
    await runIteration(index + 1, false, null);
  }
  fixture.browserActionDriver = { binding, runIteration, latenciesMs };
}

async function cleanupBrowserActions(fixture) {
  if (!fixture?.lab?.listening) return;
  fixture.lab.closeAllConnections();
  await new Promise((resolve) => fixture.lab.close(resolve));
}

async function runBrowserActions({
  page,
  electronApp,
  config,
  tasks,
  fixture,
}) {
  const { binding, runIteration, latenciesMs } = fixture.browserActionDriver;
  const workingSetSamplesMb = [];
  for (let index = 0; index < config.browserActionIterations; index += 1) {
    const iteration = index + 1;
    await runIteration(iteration, true, tasks);
    workingSetSamplesMb.push(
      (await electronProcessStats(electronApp)).totalWorkingSetMb,
    );
    if (
      iteration %
        Math.max(1, Math.floor(config.browserActionIterations / 5)) ===
      0
    ) {
      const chatTab = page
        .locator('[role="tab"][data-panel-kind="chat"]')
        .first();
      await chatTab.click();
      await recordResponsiveTask(
        tasks,
        'type_browser_action_foreground_probe',
        () =>
          typeDraftAndWaitForPaint(page, {
            scenario: 'browser-actions',
            iteration,
            characters: 48,
          }),
        { iteration, characters: 48 },
        config.responsivenessBudgetMs,
      );
      await page.getByTestId(`panel-tab-${binding.panelId}`).click();
    }
  }
  const tenth = Math.max(1, Math.floor(config.browserActionIterations / 10));
  const mean = (values) =>
    values.reduce((sum, value) => sum + value, 0) / values.length;
  const firstTenthMb = mean(workingSetSamplesMb.slice(0, tenth));
  const lastTenthMb = mean(workingSetSamplesMb.slice(-tenth));
  return {
    iterations: config.browserActionIterations,
    warmups: config.browserActionWarmups,
    originKind: 'isolated-loopback-browser-lab',
    latenciesMs,
    actionLatency: Object.fromEntries(
      Object.entries(latenciesMs).map(([kind, samples]) => [
        kind,
        {
          p50Ms: percentile(samples, 0.5),
          p95Ms: percentile(samples, 0.95),
          maxMs: Math.max(...samples),
        },
      ]),
    ),
    workingSetSamplesMb,
    workingSetRetention: {
      tenth,
      firstTenthMb,
      lastTenthMb,
      growthMb: lastTenthMb - firstTenthMb,
    },
  };
}

const BROWSER_AGENT_ACTIONS_PAGES = Object.freeze(['heavy', 'controls']);
// One budget for a build and for the snapshot agents get from it: the
// snapshot is a build plus its projection and one IPC round trip.
const BROWSER_AGENT_ACTIONS_BUDGETS = Object.freeze({
  heavy: Object.freeze({ modelUncachedP95Ms: 300, modelCachedP95Ms: 10 }),
  controls: Object.freeze({ modelUncachedP95Ms: 60, modelCachedP95Ms: 10 }),
});
const BROWSER_AGENT_ACTIONS_BUDGET_GROUPS = Object.freeze({
  modelUncached: 'uncached',
  snapshotUncached: 'uncached',
  modelCached: 'cached',
  snapshotCached: 'cached',
});

function browserAgentActionTimings(timings) {
  if (!timings || typeof timings !== 'object' || Array.isArray(timings)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(timings).filter(
      ([, value]) => typeof value === 'number' && Number.isFinite(value),
    ),
  );
}

function assertBrowserAgentModelBuild(result, pageName, groupName, iteration) {
  if (!result || typeof result !== 'object') {
    throw new Error(
      `Browser page-model build returned no result for ${pageName}/${groupName} at iteration ${iteration}.`,
    );
  }
  if (
    typeof result.durationMs !== 'number' ||
    !Number.isFinite(result.durationMs)
  ) {
    throw new Error(
      `Browser page-model build returned a non-numeric durationMs for ${pageName}/${groupName} at iteration ${iteration}.`,
    );
  }
  if (typeof result.cached !== 'boolean') {
    throw new Error(
      `Browser page-model build returned no boolean cached field for ${pageName}/${groupName} at iteration ${iteration}.`,
    );
  }
  return result;
}

function assertBrowserAgentSnapshot(snapshot, browserId, pageName) {
  if (
    !snapshot ||
    snapshot.browserId !== browserId ||
    !Array.isArray(snapshot.inputs)
  ) {
    throw new Error(
      `Browser Lab ${pageName} input_snapshot returned an invalid response.`,
    );
  }
  return snapshot;
}

function summarizeBrowserAgentTimings(samples) {
  const keys = [
    ...new Set(samples.flatMap((sample) => Object.keys(sample.timings))),
  ].sort();
  return Object.fromEntries(
    keys.map((key) => {
      const values = samples
        .map((sample) => sample.timings[key])
        .filter((value) => typeof value === 'number' && Number.isFinite(value));
      return [
        key,
        {
          p50Ms: percentile(values, 0.5),
          p95Ms: percentile(values, 0.95),
          maxMs: Math.max(...values),
          sampleCount: values.length,
          samples: values,
        },
      ];
    }),
  );
}

function summarizeBrowserAgentGroup(samples, lastBuild, pageName, groupName) {
  const wallTimes = samples.map((sample) => sample.harnessWallMs);
  const modelDurations = samples
    .map((sample) => sample.durationMs)
    .filter((value) => typeof value === 'number' && Number.isFinite(value));
  const p95Ms = percentile(wallTimes, 0.95);
  let withinBudget = null;
  const budgetKind = BROWSER_AGENT_ACTIONS_BUDGET_GROUPS[groupName];
  if (budgetKind === 'uncached') {
    withinBudget =
      p95Ms <= BROWSER_AGENT_ACTIONS_BUDGETS[pageName].modelUncachedP95Ms;
  } else if (budgetKind === 'cached') {
    withinBudget =
      p95Ms < BROWSER_AGENT_ACTIONS_BUDGETS[pageName].modelCachedP95Ms;
  }
  return {
    p50Ms: percentile(wallTimes, 0.5),
    p95Ms,
    maxMs: Math.max(...wallTimes),
    sampleCount: samples.length,
    samples,
    modelDuration: modelDurations.length
      ? {
          p50Ms: percentile(modelDurations, 0.5),
          p95Ms: percentile(modelDurations, 0.95),
          maxMs: Math.max(...modelDurations),
          sampleCount: modelDurations.length,
          samples: modelDurations,
        }
      : null,
    timings: summarizeBrowserAgentTimings(samples),
    coverage: lastBuild?.coverage ?? null,
    counts: lastBuild?.counts ?? null,
    withinBudget,
  };
}

async function setupBrowserAgentActions({ page, app, electronApp, fixture }) {
  const lab = createBrowserLabServer();
  fixture.lab = lab;
  await new Promise((resolve, reject) => {
    lab.once('error', reject);
    lab.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${lab.address().port}`;
  await openMainPage(page);
  await app.selectWorktree(WORKTREE_BRANCH, NO_ACTIVITY_RAIL);
  await expect(visibleChatPanel(page)).toBeVisible({ timeout: 30_000 });
  // Bind through the rendered live Browser tab, as the existing browser-actions
  // scenario does, rather than relying on a test-only panel API.
  await openPanelAddMenu(page, 'group-chat');
  await expect(page.getByTestId('panel-add-menu')).toBeVisible();
  await page.getByTestId('panel-add-menu-item-browser').click();
  await expect(page.getByTestId('panel-add-menu')).toBeHidden();
  const browserTab = page.locator('[role="tab"][data-panel-kind="browser"]');
  const browserPane = page.locator(
    '[data-testid^="browser-pane-"][data-browser-state]',
  );
  await expect(browserTab).toHaveCount(1, { timeout: 30_000 });
  await expect(browserPane).toHaveCount(1, { timeout: 30_000 });
  await expect(browserPane).toHaveAttribute('data-browser-state', 'live', {
    timeout: 30_000,
  });
  const panelId = (await browserTab.getAttribute('data-testid'))?.slice(
    'panel-tab-'.length,
  );
  const browserId = (await browserPane.getAttribute('data-testid'))?.slice(
    'browser-pane-'.length,
  );
  if (!panelId || !browserId) {
    throw new Error('Browser agent actions panel was not bound.');
  }

  // The build hook reports stage timings and exists only in E2E bundles; it
  // cannot change routing. Release-like bundles have none, and there the
  // scenario measures the snapshot groups alone.
  const modelAvailable = await electronApp.evaluate(
    () => typeof globalThis.__CANOPY_E2E_BROWSER_PAGE_MODEL__ === 'function',
  );
  const invokePageModel = (request) =>
    electronApp.evaluate(
      (_electron, arg) => globalThis.__CANOPY_E2E_BROWSER_PAGE_MODEL__(arg),
      request,
    );

  const navigate = async (pageName) => {
    const url = `${origin}/browser-lab/${pageName}`;
    const snapshot = await page.evaluate(
      ({ browserId, url }) => window.api.browser.navigate({ browserId, url }),
      { browserId, url },
    );
    if (snapshot?.url !== url) {
      throw new Error(`Browser Lab navigation failed: ${pageName}`);
    }
    await waitUntil(
      async () => {
        const candidate = await page.evaluate(
          ({ browserId }) => window.api.browser.inputSnapshot({ browserId }),
          { browserId },
        );
        return candidate?.url === url && Array.isArray(candidate.inputs)
          ? candidate
          : null;
      },
      {
        timeoutMs: 15_000,
        label: `Browser Lab ${pageName} input_snapshot target`,
      },
    );
  };
  fixture.browserAgentActionsDriver = {
    binding: { panelId, browserId },
    modelAvailable,
    invokePageModel,
    navigate,
  };
}

async function cleanupBrowserAgentActions(fixture) {
  if (fixture?.lab?.listening) {
    fixture.lab.closeAllConnections();
    await new Promise((resolve) => fixture.lab.close(resolve));
  }
}

async function runBrowserAgentActions({
  page,
  electronApp,
  config,
  tasks,
  fixture,
}) {
  const { binding, modelAvailable, invokePageModel, navigate } =
    fixture.browserAgentActionsDriver;
  const workingSetSamples = [];
  const foregroundTypingProbes = [];
  const probeIterations = new Set([
    Math.ceil(config.browserAgentActionsIterations / 3),
    Math.ceil((2 * config.browserAgentActionsIterations) / 3),
    config.browserAgentActionsIterations,
  ]);

  const probeForegroundTyping = async (pageName, groupName, iteration) => {
    const characters = 48;
    const chatTab = page
      .locator('[role="tab"][data-panel-kind="chat"]')
      .first();
    await chatTab.click();
    const kind = 'browser_agent_actions_foreground_typing_probe';
    await recordResponsiveTask(
      tasks,
      kind,
      () =>
        typeDraftAndWaitForPaint(page, {
          scenario: 'browser-agent-actions',
          iteration,
          characters,
        }),
      { page: pageName, group: groupName, iteration, characters },
      config.responsivenessBudgetMs,
    );
    foregroundTypingProbes.push({
      page: pageName,
      group: groupName,
      iteration,
    });
    await page.getByTestId(`panel-tab-${binding.panelId}`).click();
  };

  const collectWorkingSet = async (pageName, groupName, iteration) => {
    const processStats = await electronProcessStats(electronApp);
    workingSetSamples.push({
      page: pageName,
      group: groupName,
      iteration,
      totalWorkingSetMb: processStats.totalWorkingSetMb,
    });
  };

  const measureModelGroup = async (
    pageName,
    groupName,
    { probe = false } = {},
  ) => {
    const { browserId } = binding;
    const iterations = config.browserAgentActionsIterations;
    const warmups = config.browserAgentActionsWarmups;
    const cachePrimingBuilds = groupName === 'modelCached' ? 1 : 0;
    const build = async (iteration, measured) => {
      const options = { cache: groupName === 'modelCached' ? 'use' : 'bypass' };
      if (groupName === 'modelAccessibility') options.accessibility = true;
      if (groupName === 'modelListeners') options.listeners = true;
      const result = assertBrowserAgentModelBuild(
        await invokePageModel({ kind: 'build', browserId, options }),
        pageName,
        groupName,
        measured ? iteration : 'warmup',
      );
      return result;
    };

    for (let index = 0; index < cachePrimingBuilds; index += 1) {
      await build(index + 1, false);
    }
    for (let index = 0; index < warmups; index += 1) {
      await build(index + 1, false);
    }

    const samples = [];
    const workingSetInterval = Math.max(1, Math.ceil(iterations / 5));
    for (let index = 0; index < iterations; index += 1) {
      const iteration = index + 1;
      const measure = () =>
        recordTask(
          tasks,
          `browser_agent_actions_${groupName}`,
          () => build(iteration, true),
          { page: pageName, group: groupName, iteration },
        );
      let result = await measure();
      if (groupName === 'modelCached' && result.cached !== true) {
        // The cache lives 500 ms, and a slow loop can outlast it. The miss
        // rebuilt the cache, so drop that attempt and measure the hit.
        tasks.pop();
        result = await measure();
        if (result.cached !== true) {
          throw new Error(
            `Expected a cached browser page-model build for ${pageName} at measured iteration ${iteration}, but received cached=${String(result.cached)} twice.`,
          );
        }
      }
      samples.push({
        iteration,
        harnessWallMs: tasks.at(-1).durationMs,
        durationMs: result.durationMs,
        cached: result.cached,
        timings: browserAgentActionTimings(result.timings),
        coverage: result.coverage ?? null,
        counts: result.counts ?? null,
      });
      if (iteration % workingSetInterval === 0 || iteration === iterations) {
        await collectWorkingSet(pageName, groupName, iteration);
      }
      if (probe && probeIterations.has(iteration)) {
        await probeForegroundTyping(pageName, groupName, iteration);
      }
    }
    return {
      ...summarizeBrowserAgentGroup(
        samples,
        {
          coverage: samples.at(-1).coverage,
          counts: samples.at(-1).counts,
        },
        pageName,
        groupName,
      ),
      warmups,
      cachePrimingBuilds,
    };
  };

  // The snapshot agents get, through the same IPC they use. The response
  // does not say whether its model was cached, so each group controls that
  // itself: an agent action boundary before an uncached read (a load-state
  // wait is one, and builds no model), and a priming read immediately before
  // a cached one.
  const measureSnapshotGroup = async (
    pageName,
    groupName,
    { probe = false } = {},
  ) => {
    const { browserId } = binding;
    const iterations = config.browserAgentActionsIterations;
    const warmups = config.browserAgentActionsWarmups;
    const readSnapshot = async () =>
      assertBrowserAgentSnapshot(
        await page.evaluate(
          ({ browserId }) => window.api.browser.inputSnapshot({ browserId }),
          { browserId },
        ),
        browserId,
        pageName,
      );
    const invalidate = async () => {
      const response = await page.evaluate(
        ({ browserId }) =>
          window.api.browser.automation({
            browserId,
            command: { kind: 'wait_for', loadState: 'load', timeoutMs: 5_000 },
          }),
        { browserId },
      );
      if (!response?.ok || response.waitFor?.satisfied !== true) {
        throw new Error(
          `Browser Lab ${pageName} load-state wait did not complete: ${JSON.stringify(response?.error ?? response)}`,
        );
      }
    };
    const prepare = groupName === 'snapshotCached' ? readSnapshot : invalidate;
    for (let index = 0; index < warmups; index += 1) {
      await prepare();
      await readSnapshot();
    }
    const samples = [];
    const workingSetInterval = Math.max(1, Math.ceil(iterations / 5));
    for (let index = 0; index < iterations; index += 1) {
      const iteration = index + 1;
      await prepare();
      const snapshot = await recordTask(
        tasks,
        `browser_agent_actions_${groupName}`,
        readSnapshot,
        { page: pageName, group: groupName, iteration },
      );
      samples.push({
        iteration,
        harnessWallMs: tasks.at(-1).durationMs,
        durationMs: null,
        cached: null,
        timings: {},
        total: snapshot.total,
        returned: snapshot.returned,
      });
      if (iteration % workingSetInterval === 0 || iteration === iterations) {
        await collectWorkingSet(pageName, groupName, iteration);
      }
      if (probe && probeIterations.has(iteration)) {
        await probeForegroundTyping(pageName, groupName, iteration);
      }
    }
    return {
      ...summarizeBrowserAgentGroup(samples, null, pageName, groupName),
      warmups,
      cachePrimingBuilds: groupName === 'snapshotCached' ? iterations : 0,
    };
  };

  const pages = {};
  for (const pageName of BROWSER_AGENT_ACTIONS_PAGES) {
    await navigate(pageName);
    const groups = {};
    if (modelAvailable) {
      groups.modelUncached = await measureModelGroup(
        pageName,
        'modelUncached',
        { probe: true },
      );
      groups.modelCached = await measureModelGroup(pageName, 'modelCached');
      groups.modelAccessibility = await measureModelGroup(
        pageName,
        'modelAccessibility',
      );
      groups.modelListeners = await measureModelGroup(
        pageName,
        'modelListeners',
      );
    }
    groups.snapshotUncached = await measureSnapshotGroup(
      pageName,
      'snapshotUncached',
      { probe: !modelAvailable },
    );
    groups.snapshotCached = await measureSnapshotGroup(
      pageName,
      'snapshotCached',
    );
    pages[pageName] = { groups };
  }

  const budgetResults = Object.fromEntries(
    BROWSER_AGENT_ACTIONS_PAGES.map((pageName) => {
      const { modelUncached, modelCached, snapshotUncached, snapshotCached } =
        pages[pageName].groups;
      return [
        pageName,
        {
          ...(modelUncached && modelCached
            ? {
                modelUncachedP95Ms: modelUncached.p95Ms,
                modelCachedP95Ms: modelCached.p95Ms,
                modelUncachedWithinBudget: modelUncached.withinBudget,
                modelCachedWithinBudget: modelCached.withinBudget,
              }
            : {}),
          snapshotUncachedP95Ms: snapshotUncached.p95Ms,
          snapshotCachedP95Ms: snapshotCached.p95Ms,
          snapshotUncachedWithinBudget: snapshotUncached.withinBudget,
          snapshotCachedWithinBudget: snapshotCached.withinBudget,
        },
      ];
    }),
  );
  return {
    originKind: 'isolated-loopback-browser-lab',
    pages: BROWSER_AGENT_ACTIONS_PAGES,
    buildHook: modelAvailable ? 'available' : 'unavailable',
    snapshotApi: 'window.api.browser.inputSnapshot',
    iterations: config.browserAgentActionsIterations,
    warmups: config.browserAgentActionsWarmups,
    budgetBasis: 'e2e-relative',
    budgets: BROWSER_AGENT_ACTIONS_BUDGETS,
    budgetResults,
    pageResults: pages,
    foregroundTypingProbes,
    workingSetSamples,
  };
}

function prepareArchiveResponsiveness(userDataDir, config) {
  const fixture = seedArchiveActivityFixture({
    userDataDir,
    archivePayloadBytes: config.archivePayloadBytes,
    includeIndependentWorkspace: true,
  });
  writeFileSync(
    path.join(userDataDir, 'plugins-cache.json'),
    `${JSON.stringify({
      version: 2,
      lastRefreshed: PERFORMANCE_PLUGIN_CACHE_TIMESTAMP,
      lastProviderRefreshAt: PERFORMANCE_PLUGIN_CACHE_TIMESTAMP,
      marketplaces: [],
    })}\n`,
    'utf8',
  );
  return fixture;
}

async function archiveStillPending(electronApp) {
  const observation = await electronApp.evaluate(
    () => globalThis.__archiveActivityObservation,
  );
  if (!observation?.captureBarrierEntered || observation.completed) {
    throw new Error(
      `Archive was not held during responsiveness probe: ${JSON.stringify(observation)}`,
    );
  }
}

async function createIndependentWorktree(page, app, workspace) {
  const sidebar = page.getByTestId('app-sidebar');
  const section = sidebar
    .locator(`[data-sidebar-workspace-id="${workspace.id}"]`)
    .first();
  const header = section
    .getByRole('button', {
      name: new RegExp(`^(?:Expand|Collapse) ${workspace.name}$`),
    })
    .first();
  await expect(header).toBeVisible();
  if (
    (await header.getAttribute('aria-label')) === `Expand ${workspace.name}`
  ) {
    await header.click();
  }
  const beforeIds = new Set(
    await section
      .locator('[data-testid="worktree-row"][data-worktree-id]')
      .evaluateAll((rows) =>
        rows.map((row) => row.getAttribute('data-worktree-id')),
      ),
  );
  await header.hover();
  const create = section.getByRole('button', {
    name: `Create worktree for ${workspace.name}`,
  });
  await expect(create).toBeVisible();
  await create.dispatchEvent('click');
  const worktreeId = await waitUntil(
    async () => {
      const ids = await section
        .locator('[data-testid="worktree-row"][data-worktree-id]')
        .evaluateAll((rows) =>
          rows.map((row) => row.getAttribute('data-worktree-id')),
        );
      return ids.find((id) => id && !beforeIds.has(id));
    },
    {
      timeoutMs: 5_000,
      label: `new worktree row for ${workspace.name}`,
      intervalMs: 25,
    },
  );
  if (!worktreeId) throw new Error('Independent worktree id was not reserved');
  await app.selectWorktree(worktreeId, NO_ACTIVITY_RAIL);
  await expect(visibleChatPanel(page)).toBeVisible({ timeout: 5_000 });
  return worktreeId;
}

async function runArchiveResponsiveness({
  page,
  app,
  electronApp,
  config,
  fixture,
  tasks,
}) {
  if (!fixture.independentWorkspace) {
    throw new Error('Archive responsiveness requires an independent workspace');
  }
  const marker = `Canopy-CARCHIVEPERF-${Date.now()}`;
  const siblingReply = `Sibling chat completed during archive ${marker}`;
  const independentReply = `Independent worktree chat completed during archive ${marker}`;
  await registerScenario(PERFORMANCE_MOCK_BASE_URL, marker, {
    llm: {
      steps: [
        {
          text: `${siblingReply}\n${independentReply}`,
          stopReason: 'end_turn',
        },
      ],
    },
  });
  await openMainPage(page);
  await app.selectWorktree(fixture.original.id, NO_ACTIVITY_RAIL);
  await installArchiveCaptureBarrier(electronApp, {
    projectId: fixture.workspace.id,
    worktreeId: fixture.original.id,
  });

  let barrierReleased = false;
  try {
    await recordTask(tasks, 'archive_start_and_hold_capture', async () => {
      await deleteArchiveActivityWorktree({
        window: page,
        electronApp,
        original: fixture.original,
        workspace: fixture.workspace,
      });
      await expect
        .poll(
          () =>
            electronApp.evaluate(
              () =>
                globalThis.__archiveActivityObservation
                  ?.captureBarrierEntered ?? false,
            ),
          { timeout: 15_000 },
        )
        .toBe(true);
    });

    await app.selectWorktree(fixture.otherId, NO_ACTIVITY_RAIL);
    const siblingPanel = visibleChatPanel(page);
    await recordResponsiveTask(
      tasks,
      'archive_sibling_provider_commit_to_render',
      async () => {
        const text = `Provider output committed during archive ${marker}`;
        await commitArchiveSiblingProviderMarker(electronApp, {
          projectId: fixture.workspace.id,
          worktreeId: fixture.otherId,
          chatId: `${fixture.otherId}-chat`,
          text,
        });
        await expect(siblingPanel.getByText(text).first()).toBeVisible({
          timeout: 5_000,
        });
        await archiveStillPending(electronApp);
      },
      { archiveBarrierHeld: true, projectRelation: 'sibling' },
      config.responsivenessBudgetMs,
    );

    await recordResponsiveTask(
      tasks,
      'archive_sibling_model_change',
      async () => {
        const picker = siblingPanel.getByTestId('chat-model-picker');
        await picker.click();
        await selectModelOption(page, 'sonnet');
        await expect
          .poll(
            () =>
              electronApp.evaluate(
                () =>
                  globalThis.__archiveActivityObservation
                    ?.modelChangeCompleted ?? false,
              ),
            { timeout: 5_000 },
          )
          .toBe(true);
        await expect(picker).toContainText('Sonnet', { timeout: 5_000 });
        await archiveStillPending(electronApp);
      },
      { archiveBarrierHeld: true, projectRelation: 'sibling' },
      config.responsivenessBudgetMs,
    );

    await recordResponsiveTask(
      tasks,
      'archive_sibling_new_chat_first_output',
      async () => {
        const createdChatId = await createFreshChatTab(page);
        const freshPanel = chatPanelForTab(page, createdChatId);
        await expect(freshPanel).toBeVisible({ timeout: 5_000 });
        const composer = freshPanel.getByRole('textbox').first();
        await expect(composer).toBeEditable({ timeout: 5_000 });
        await nextPaint(page);
        await enterComposerMessage(
          composer,
          `[${marker}] Start a new sibling chat.`,
        );
        const send = freshPanel.getByRole('button', {
          name: 'Send message',
          exact: true,
        });
        await expect(send).toBeEnabled({ timeout: 5_000 });
        await send.click();
        await expect(freshPanel.getByText(siblingReply).first()).toBeVisible({
          timeout: 5_000,
        });
        await archiveStillPending(electronApp);
      },
      { archiveBarrierHeld: true, projectRelation: 'sibling' },
      config.responsivenessBudgetMs,
    );

    await recordResponsiveTask(
      tasks,
      'archive_sibling_composer_input',
      () =>
        typeDraftAndWaitForPaint(page, {
          scenario: 'archive-held-sibling',
          iteration: 1,
          characters: config.typingCharacters,
          verifyDraftState: true,
        }),
      {
        archiveBarrierHeld: true,
        projectRelation: 'sibling',
        characters: config.typingCharacters,
      },
      config.responsivenessBudgetMs,
    );
    await archiveStillPending(electronApp);

    let independentWorktreeId;
    await recordResponsiveTask(
      tasks,
      'archive_independent_worktree_create',
      async () => {
        independentWorktreeId = await createIndependentWorktree(
          page,
          app,
          fixture.independentWorkspace,
        );
        await archiveStillPending(electronApp);
      },
      { archiveBarrierHeld: true, projectRelation: 'independent' },
      config.responsivenessBudgetMs,
    );

    await recordResponsiveTask(
      tasks,
      'archive_independent_worktree_first_output',
      async () => {
        const panel = visibleChatPanel(page);
        const composer = panel.getByRole('textbox').first();
        await enterComposerMessage(
          composer,
          `[${marker}] Start in the new worktree.`,
        );
        const send = panel.getByRole('button', {
          name: 'Send message',
          exact: true,
        });
        await expect(send).toBeEnabled({ timeout: 5_000 });
        await send.click();
        await expect(panel.getByText(independentReply).first()).toBeVisible({
          timeout: 5_000,
        });
        await archiveStillPending(electronApp);
      },
      {
        archiveBarrierHeld: true,
        projectRelation: 'independent',
        worktreeId: independentWorktreeId,
      },
      config.responsivenessBudgetMs,
    );

    await recordTask(tasks, 'archive_release_to_completion', async () => {
      await releaseArchiveActivityBarrier(electronApp);
      barrierReleased = true;
      await expect
        .poll(
          () =>
            electronApp.evaluate(
              () => globalThis.__archiveActivityObservation?.completed ?? false,
            ),
          { timeout: 120_000 },
        )
        .toBe(true);
      await expect
        .poll(
          () =>
            existsSync(
              path.join(
                fixture.workspaceRoot,
                'archived-containers',
                fixture.original.id,
                'container.json',
              ),
            ),
          { timeout: 30_000 },
        )
        .toBe(true);
    });

    return {
      archivePayloadBytes: config.archivePayloadBytes,
      archiveBarrierHeldAcrossAllProbes: true,
      siblingProviderOutputRendered: true,
      siblingModelChanged: true,
      siblingChatStarted: true,
      independentWorktreeCreated: true,
      independentWorktreeChatStarted: true,
    };
  } finally {
    if (!barrierReleased) {
      await releaseArchiveActivityBarrier(electronApp).catch(() => undefined);
    }
  }
}

async function workspaceCreateButton(page) {
  const sidebar = page.getByTestId('app-sidebar');
  const header = sidebar
    .getByRole('button', {
      name: new RegExp(`^(?:Expand|Collapse) ${WORKSPACE_NAME}$`),
    })
    .first();
  await expect(header).toBeVisible();
  if (
    (await header.getAttribute('aria-label')) === `Expand ${WORKSPACE_NAME}`
  ) {
    await header.click();
  }
  await header.hover();
  const create = sidebar.getByRole('button', {
    name: `Create worktree for ${WORKSPACE_NAME}`,
  });
  await expect(create).toBeVisible();
  return create;
}

/**
 * The sidebar renders the project's worktrees after the main page opens. Take
 * the snapshot of existing worktrees only once the fixture's own worktree row
 * is present, so a row that renders late is never mistaken for the worktree
 * the scenario creates.
 */
export async function readPreexistingWorktreeIds(
  readIds,
  { fixtureWorktreeId = WORKTREE_ID, timeoutMs = 30_000 } = {},
) {
  const ids = await waitUntil(
    async () => {
      const current = await readIds();
      return current.includes(fixtureWorktreeId) ? current : false;
    },
    {
      timeoutMs,
      label: `the ${fixtureWorktreeId} fixture worktree row`,
      intervalMs: 25,
    },
  );
  return new Set(ids);
}

/**
 * The worktree's row in the sidebar list. The sidebar also portals hidden
 * pinned copies of the selected row (`worktree-row-pin-top`,
 * `worktree-row-pin-bottom`) ahead of the list with the same worktree id, so
 * an id-only locator can resolve to a copy that is never visible.
 */
export function sidebarWorktreeRow(page, worktreeId) {
  return page
    .getByTestId('app-sidebar')
    .locator(`[data-testid="worktree-row"][data-worktree-id="${worktreeId}"]`)
    .first();
}

async function worktreeIds(page) {
  return page
    .getByTestId('app-sidebar')
    .locator('[data-testid="worktree-row"][data-worktree-id]')
    .evaluateAll((rows) =>
      rows.map((row) => row.getAttribute('data-worktree-id')),
    );
}

async function installWorktreeSetupLoadTracker(page) {
  await page.evaluate(() => {
    const state = {
      active: {},
      started: {},
      completed: {},
      completionResults: {},
      outputLines: {},
      outputSamples: {},
      gitReady: {},
      gitFailed: {},
      dispose: null,
    };
    const isAutomaticSetup = (event) =>
      event.invocation === 'automatic-setup' &&
      event.script.scriptName === 'setup';
    const unsubscribers = [
      window.api.onScriptStarted((event) => {
        if (!isAutomaticSetup(event)) return;
        state.active[event.worktreeId] = true;
        state.started[event.worktreeId] = Date.now();
      }),
      window.api.onScriptOutput((event) => {
        if (!isAutomaticSetup(event)) return;
        state.outputLines[event.worktreeId] =
          (state.outputLines[event.worktreeId] ?? 0) + event.lines.length;
        state.outputSamples[event.worktreeId] = [
          ...(state.outputSamples[event.worktreeId] ?? []),
          ...event.lines,
        ].slice(0, 5);
      }),
      window.api.onScriptComplete((event) => {
        if (!isAutomaticSetup(event)) return;
        delete state.active[event.worktreeId];
        state.completed[event.worktreeId] = Date.now();
        state.completionResults[event.worktreeId] = event.result;
      }),
      window.api.onWorktreeGitReady((event) => {
        state.gitReady[event.worktreeId] = Date.now();
      }),
      window.api.onWorktreeGitFailed((event) => {
        state.gitFailed[event.worktreeId] = {
          at: Date.now(),
          error: event.error,
        };
      }),
    ];
    state.dispose = () => {
      unsubscribers.forEach((unsubscribe) => unsubscribe());
    };
    window.__canopyPerformanceWorktreeSetupState = state;
  });
}

async function readWorktreeSetupLoadState(page) {
  return page.evaluate(() => {
    const state = window.__canopyPerformanceWorktreeSetupState;
    if (!state) return null;
    return {
      activeIds: Object.keys(state.active),
      startedIds: Object.keys(state.started),
      completedIds: Object.keys(state.completed),
      completionResults: { ...state.completionResults },
      outputLines: { ...state.outputLines },
      outputSamples: { ...state.outputSamples },
      gitReadyIds: Object.keys(state.gitReady),
      gitReadyAt: { ...state.gitReady },
      gitFailed: { ...state.gitFailed },
    };
  });
}

async function readRendererDomLoadState(page) {
  return page.evaluate(() => ({
    elements: document.querySelectorAll('*').length,
    divs: document.querySelectorAll('div').length,
    spans: document.querySelectorAll('span').length,
    buttons: document.querySelectorAll('button').length,
    svgs: document.querySelectorAll('svg').length,
    paths: document.querySelectorAll('path').length,
    fileRows: document.querySelectorAll('[data-testid="files-tree-row"]')
      .length,
    fileFolders: document.querySelectorAll('[data-file-tree-folder]').length,
    changedFileRows: document.querySelectorAll(
      '[data-testid="activity-changed-file"]',
    ).length,
    changedFilesElements:
      document
        .querySelector('[data-testid="activity-changed-files"]')
        ?.querySelectorAll('*').length ?? 0,
    desktopChangedFilesElements:
      document
        .querySelector('[data-testid="changed-files-section"]')
        ?.querySelectorAll('*').length ?? 0,
    slateNodes: document.querySelectorAll('[data-slate-node]').length,
  }));
}

async function disposeWorktreeSetupLoadTracker(page) {
  await page.evaluate(() => {
    window.__canopyPerformanceWorktreeSetupState?.dispose?.();
    delete window.__canopyPerformanceWorktreeSetupState;
  });
}

async function selectActiveSetupWorktree({
  page,
  createdIds,
  typedWorktreeIds,
  minimumOutputLines,
  iteration,
  timeoutMs,
}) {
  let targetId;
  try {
    targetId = await waitUntil(
      async () => {
        const state = await readWorktreeSetupLoadState(page);
        if (!state) return false;
        const finishedEarly = createdIds.filter(
          (id) =>
            !typedWorktreeIds.has(id) &&
            state.completionResults[id] !== undefined &&
            (state.outputLines[id] ?? 0) < minimumOutputLines,
        );
        if (
          finishedEarly.length > 0 &&
          finishedEarly.length ===
            createdIds.filter((id) => !typedWorktreeIds.has(id)).length
        ) {
          throw new FatalWaitError(
            `Setup for ${finishedEarly.join(', ')} completed before emitting ${minimumOutputLines} output lines`,
          );
        }
        const activeCreatedIds = createdIds.filter(
          (id) =>
            state.activeIds.includes(id) &&
            (state.outputLines[id] ?? 0) >= minimumOutputLines,
        );
        return (
          activeCreatedIds.find((id) => !typedWorktreeIds.has(id)) ??
          activeCreatedIds[iteration % activeCreatedIds.length] ??
          false
        );
      },
      {
        timeoutMs,
        label: `an output-producing setup worktree for interaction ${iteration + 1}`,
        intervalMs: 25,
      },
    );
  } catch (error) {
    const state = await readWorktreeSetupLoadState(page).catch(() => null);
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; tracker=${JSON.stringify(state)}`,
    );
  }

  const row = sidebarWorktreeRow(page, targetId);
  await row.click();
  await expect(page.getByTestId('page-main')).toBeVisible({ timeout: 30_000 });
  await expect(visibleChatPanel(page)).toBeVisible({ timeout: 30_000 });
  return targetId;
}

async function assertWorktreeSetupActive(page, worktreeId) {
  const state = await readWorktreeSetupLoadState(page);
  if (!state?.activeIds.includes(worktreeId)) {
    throw new Error(
      `Worktree ${worktreeId} setup completed before its composer typing probe began`,
    );
  }
}

export function worktreeGitPendingError(state, worktreeId, stage) {
  const failure = state?.gitFailed[worktreeId];
  if (failure) {
    return `Worktree ${worktreeId} Git setup failed: ${failure.error}`;
  }
  if (state?.gitReadyIds.includes(worktreeId)) {
    if (stage === 'held') {
      return `Worktree ${worktreeId} Git setup completed while the performance gate held it`;
    }
    return stage === 'before'
      ? `Worktree ${worktreeId} Git setup completed before its composer typing probe began`
      : `Worktree ${worktreeId} Git setup completed before its composer typing probe finished`;
  }
  return null;
}

/**
 * Whether the setup scripts of earlier worktrees still load the host. A
 * creation is timed only once every one of them finished and no automatic
 * setup is active, so each measurement runs under the same load.
 */
export function priorSetupDrainStatus(state, priorWorktreeIds) {
  const results = state?.completionResults ?? {};
  return {
    pending: priorWorktreeIds.filter((id) => results[id] === undefined),
    failed: priorWorktreeIds.filter((id) => results[id]?.success === false),
    activeIds: state?.activeIds ?? [],
  };
}

/** Whether a drain status allows the timed release to start. */
export function priorSetupsDrained(status) {
  return status.pending.length === 0 && status.activeIds.length === 0;
}

/**
 * Splits a released hold. `gateResumedAfterReleaseMs` is the gate's release
 * poll, harness latency outside the timed task. `gitReadyAfterResumeMs`, the
 * timed creation, splits into Git's file writes
 * (`checkoutWrittenAfterResumeMs`) and the app's share until the renderer
 * received Git ready (`gitReadyAfterCheckoutWrittenMs`, where a W5 writer
 * change would show). The Git and app split is absent when parallel checkout
 * writes the tail early. `gatePassThroughMs` and `tailPassThroughMs` are the
 * filters' harness work inside the Git and app shares.
 */
export function gateHoldTimings(
  gitGate,
  worktreeId,
  { tailWrittenLast, gitReadyAtMs },
) {
  const resumedAtMs = gitGate.resumedAtMs(worktreeId);
  const writtenAtMs = tailWrittenLast
    ? gitGate.writtenAtMs(worktreeId)
    : undefined;
  return {
    heldMs: gitGate.heldMs(worktreeId),
    gateResumedAfterReleaseMs: gitGate.resumedAfterReleaseMs(worktreeId),
    gitReadyAfterResumeMs:
      resumedAtMs === undefined || gitReadyAtMs === undefined
        ? undefined
        : gitReadyAtMs - resumedAtMs,
    checkoutWrittenAfterResumeMs: tailWrittenLast
      ? gitGate.checkoutWrittenAfterResumeMs(worktreeId)
      : undefined,
    gitReadyAfterCheckoutWrittenMs:
      writtenAtMs === undefined || gitReadyAtMs === undefined
        ? undefined
        : gitReadyAtMs - writtenAtMs,
    gatePassThroughMs: gitGate.gatePassThroughMs(worktreeId),
    tailPassThroughMs: gitGate.tailPassThroughMs(worktreeId),
  };
}

/**
 * The timed creation of a released hold: from the gate letting Git continue
 * to the renderer receiving Git ready. Both ends are host wall-clock stamps
 * (the resume marker's mtime and the tracker's `Date.now()`), so neither the
 * gate's release poll nor the harness's ready detection is timed. Throws
 * instead of returning a value that is not that interval.
 */
export function gitReadyAfterResumeMs(gitGate, worktreeId, gitReadyAtMs) {
  if (gitGate.holdExpired(worktreeId)) {
    throw new Error(
      `The performance Git gate expired before worktree ${worktreeId} was released, so Git resumed without the harness`,
    );
  }
  const resumedAtMs = gitGate.resumedAtMs(worktreeId);
  if (resumedAtMs === undefined) {
    throw new Error(
      `Worktree ${worktreeId} reported Git ready without the performance gate resuming its checkout`,
    );
  }
  if (gitReadyAtMs === undefined) {
    throw new Error(
      `Worktree ${worktreeId} Git ready has no renderer timestamp`,
    );
  }
  const elapsedMs = gitReadyAtMs - resumedAtMs;
  if (elapsedMs < 0) {
    throw new Error(
      `Worktree ${worktreeId} reported Git ready ${-elapsedMs}ms before the performance gate resumed its checkout`,
    );
  }
  return elapsedMs;
}

/**
 * Records `worktree_git_ready_after_release` for a held worktree. `release`
 * runs inside the task, so its work and renderer brackets cover the whole
 * checkout, but `durationMs` is `gitReadyAfterResumeMs` because the gate's
 * release poll varied 40-229 ms on the baseline Mac. `harnessWallMs` keeps the
 * harness-timed release-to-observed window, and `harnessTiming` receives the
 * harness's ready detection. A failure records an error task and rethrows.
 */
export async function recordGitReadyAfterRelease(
  tasks,
  { gitGate, worktreeId, release, waitForGitReadyAt, harnessTiming, metadata },
) {
  let harnessWallMs;
  const durationMs = await recordTask(
    tasks,
    'worktree_git_ready_after_release',
    async () => {
      const releasedAt = performance.now();
      release();
      const gitReadyAtMs = await waitForGitReadyAt();
      harnessWallMs = performance.now() - releasedAt;
      harnessTiming.gitReadyObservedAfterReadyMs = Date.now() - gitReadyAtMs;
      return gitReadyAfterResumeMs(gitGate, worktreeId, gitReadyAtMs);
    },
    metadata,
  );
  const task = tasks.at(-1);
  task.harnessWallMs = harnessWallMs;
  task.durationMs = durationMs;
  return durationMs;
}

/**
 * Waits, untimed and while `worktreeId` stays held at the gate, for the
 * setup scripts of `priorIds` to finish. Returns the time spent and the
 * tracker state the release starts from.
 */
export async function waitForPriorSetupsToFinish(
  page,
  { worktreeId, priorIds, timeoutMs },
) {
  const startedAt = performance.now();
  try {
    const state = await waitUntil(
      async () => {
        const state = await readWorktreeSetupLoadState(page);
        if (!state) return null;
        const heldError = worktreeGitPendingError(state, worktreeId, 'held');
        if (heldError) throw new FatalWaitError(heldError);
        const status = priorSetupDrainStatus(state, priorIds);
        if (status.failed.length > 0) {
          throw new FatalWaitError(
            `Setup failed for ${status.failed.join(', ')} before worktree ${worktreeId} was released: ${JSON.stringify(status.failed.map((id) => state.completionResults[id]))}`,
          );
        }
        return priorSetupsDrained(status) ? state : null;
      },
      {
        timeoutMs,
        label: `earlier setup scripts [${priorIds.join(', ')}] to finish before releasing worktree ${worktreeId}`,
        intervalMs: 25,
      },
    );
    return { state, drainMs: performance.now() - startedAt };
  } catch (error) {
    if (error instanceof FatalWaitError) throw error;
    const state = await readWorktreeSetupLoadState(page).catch(() => null);
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; tracker=${JSON.stringify(state)}`,
    );
  }
}

async function assertWorktreeGitPending(page, worktreeId, stage) {
  const message = worktreeGitPendingError(
    await readWorktreeSetupLoadState(page),
    worktreeId,
    stage,
  );
  if (message) throw new Error(message);
}

async function typeAtCadenceUntilWorktreeSetupCompletes({
  page,
  worktreeId,
  intervalMs,
  timeoutMs,
  onGitPhaseKey = () => undefined,
}) {
  const composer = visibleChatPanel(page)
    .locator('[data-chat-composer-root]')
    .getByRole('textbox')
    .first();
  const worktreeRow = sidebarWorktreeRow(page, worktreeId);
  const healthWarning = worktreeRow.getByRole('button', {
    name: 'Worktree issue - click for details',
  });
  await expect(composer).toBeVisible({ timeout: 30_000 });
  await composer.fill('');
  await composer.click();

  const deadline = performance.now() + timeoutMs;
  const samples = [];
  const phaseCounts = { git: 0, setup: 0, transition: 0 };
  let draft = '';
  let nextKeyAt = performance.now();
  await setRendererTypingProbe(page, true);
  try {
    while (performance.now() < deadline) {
      const state = await readWorktreeSetupLoadState(page);
      const completion = state?.completionResults[worktreeId];
      if (completion !== undefined) {
        if (!completion.success) {
          throw new Error(
            `Worktree ${worktreeId} setup failed during sustained typing: ${JSON.stringify(completion)}`,
          );
        }
        break;
      }

      if ((await healthWarning.count()) > 0) {
        const reason =
          (await healthWarning.first().getAttribute('title')) ??
          'unknown worktree issue';
        throw new Error(
          `Worktree ${worktreeId} displayed an unhealthy warning during setup: ${reason}`,
        );
      }

      const phase = !state?.gitReadyIds.includes(worktreeId)
        ? 'git'
        : state.activeIds.includes(worktreeId)
          ? 'setup'
          : 'transition';
      const waitMs = Math.max(0, nextKeyAt - performance.now());
      if (waitMs > 0) {
        await delay(waitMs);
      }
      const character = String.fromCharCode(97 + (samples.length % 26));
      const startedAt = performance.now();
      await page.keyboard.type(character);
      await nextPaint(page);
      const latencyMs = performance.now() - startedAt;
      draft += character;
      samples.push({ phase, latencyMs });
      phaseCounts[phase] += 1;
      if (phase === 'git') onGitPhaseKey(phaseCounts.git);
      nextKeyAt += intervalMs;
    }
  } finally {
    await setRendererTypingProbe(page, false);
  }

  const finalState = await readWorktreeSetupLoadState(page);
  if (finalState?.completionResults[worktreeId] === undefined) {
    throw new Error(
      `Timed out typing every ${intervalMs}ms until worktree ${worktreeId} setup completed`,
    );
  }
  if (samples.length === 0) {
    throw new Error(
      `Worktree ${worktreeId} completed before the sustained typing probe entered a key`,
    );
  }
  if (phaseCounts.git === 0 || phaseCounts.setup === 0) {
    throw new Error(
      `Sustained typing did not cover both Git and setup for ${worktreeId}: ${JSON.stringify(phaseCounts)}`,
    );
  }
  await expect
    .poll(() => composer.textContent(), { timeout: 30_000 })
    .toContain(draft);
  await composer.fill('');

  const latencies = samples.map((sample) => sample.latencyMs);
  return {
    characters: samples.length,
    intervalMs,
    phaseCounts,
    latencyP95Ms: percentile(latencies, 0.95),
    latencyMaxMs: Math.max(...latencies),
  };
}

async function waitForGitAndScriptOverlap(page, worktreeId) {
  try {
    return await waitUntil(
      async () => {
        const state = await readWorktreeSetupLoadState(page);
        if (state?.gitReadyIds.includes(worktreeId)) {
          throw new FatalWaitError(
            `Worktree ${worktreeId} Git setup completed before overlapping script load was observed`,
          );
        }
        return state && state.activeIds.length > 0 ? state : null;
      },
      {
        timeoutMs: 30_000,
        label: `Git setup for ${worktreeId} to overlap an active setup script`,
        intervalMs: 10,
      },
    );
  } catch (error) {
    if (error instanceof FatalWaitError) throw error;
    // The tracker's start and completion times show whether the earlier
    // setup ended before this checkout reached the gate.
    const state = await readWorktreeSetupLoadState(page).catch(() => null);
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; at=${Date.now()} tracker=${JSON.stringify(state)}`,
    );
  }
}

async function recordWorktreeSetupInteraction({
  page,
  config,
  tasks,
  targetWorktreeId,
  iteration,
}) {
  const setupState = await readWorktreeSetupLoadState(page);
  const pendingSetups = setupState?.activeIds.length ?? 0;
  const outputLinesBeforeTyping =
    setupState?.outputLines[targetWorktreeId] ?? 0;
  const domLoad = await readRendererDomLoadState(page);
  await recordResponsiveTask(
    tasks,
    'type_during_worktree_setup',
    async () => {
      await assertWorktreeSetupActive(page, targetWorktreeId);
      return typeDraftAndWaitForPaint(page, {
        scenario: 'worktree-setup',
        iteration,
        characters: config.typingCharacters,
      });
    },
    {
      iteration,
      characters: config.typingCharacters,
      pendingSetups,
      targetWorktreeId,
      targetSetupActive: true,
      outputLinesBeforeTyping,
      domLoad,
    },
    config.responsivenessBudgetMs,
  );
  await recordResponsiveTask(
    tasks,
    'navigate_during_worktree_setup',
    async () => {
      await openPipelinesPage(page);
      await sidebarWorktreeRow(page, targetWorktreeId).click();
      await expect(page.getByTestId('page-main')).toBeVisible({
        timeout: 30_000,
      });
      await nextPaint(page);
    },
    { iteration, pendingSetups, targetWorktreeId },
    config.responsivenessBudgetMs,
  );
}

export async function readWorktreeSetupStatus(row) {
  if (!(await row.isVisible().catch(() => false))) {
    return { ready: false };
  }

  const healthWarning = row.getByRole('button', {
    name: 'Worktree issue - click for details',
  });
  if ((await healthWarning.count()) > 0) {
    const reason =
      (await healthWarning.first().getAttribute('title')) ??
      'Worktree setup failed';
    return { ready: false, error: reason };
  }

  const pending = row.locator(
    '[aria-label^="Setting up worktree"], [aria-label^="Running setup"], [title^="Setting up worktree"], [title^="Running setup"]',
  );
  return { ready: (await pending.count()) === 0 };
}

async function runWorktrees({ page, config, tasks, fixture }) {
  const { gitGate, gitCheckoutConfig } = fixture;
  try {
    return await runGatedWorktrees({
      page,
      config,
      tasks,
      gitGate,
      gitCheckoutConfig,
    });
  } finally {
    // Never leave a checkout held, even when the scenario failed.
    gitGate.releaseAll();
  }
}

async function runGatedWorktrees({
  page,
  config,
  tasks,
  gitGate,
  gitCheckoutConfig,
}) {
  await openMainPage(page);
  await installWorktreeSetupLoadTracker(page);
  // Expand the project first: its worktree rows render only when expanded.
  await workspaceCreateButton(page);
  const initialIds = await readPreexistingWorktreeIds(() => worktreeIds(page));
  const createdIds = [];
  const gitTypedWorktreeIds = new Set();
  const typedWorktreeIds = new Set();
  const minimumOutputLinesBeforeTyping = config.scriptOutputLinesPerTick * 2;
  let gitTypingProbesOverlappingSetupScripts = 0;
  let sustainedTyping = null;

  // Harness-side cost of each created worktree, kept out of every task.
  const harnessTimings = new Map();
  const tailWrittenLast = checkoutWritesTailLast(gitCheckoutConfig);
  // Read right after Git ready, before any later checkout can rewrite a marker.
  const recordGateHoldTimings = async (worktreeId) => {
    const state = await readWorktreeSetupLoadState(page);
    Object.assign(
      harnessTimings.get(worktreeId),
      gateHoldTimings(gitGate, worktreeId, {
        tailWrittenLast,
        gitReadyAtMs: state?.gitReadyAt[worktreeId],
      }),
    );
  };
  const gitGateHolds = [];
  const releaseGitGate = (worktreeId) => {
    if (gitGateHolds.some((hold) => hold.worktreeId === worktreeId)) return;
    gitGate.release(worktreeId);
    gitGateHolds.push({ worktreeId });
  };

  for (let index = 0; index < config.worktreesToCreate; index += 1) {
    const known = new Set([...initialIds, ...createdIds]);
    // Locating and hovering the hover-only control is harness work; time only
    // the reservation from the click to the new row.
    const create = await workspaceCreateButton(page);
    const reserveLoad = await readWorktreeSetupLoadState(page);
    const id = await recordTask(
      tasks,
      'reserve_worktree',
      async () => {
        // Sidebar status updates can replace the hovered workspace header
        // between locating this hover-only control and Playwright's stability
        // check. The click itself is not the responsiveness probe, so dispatch
        // it directly and reserve measurement for the composer interactions.
        await create.dispatchEvent('click');
        return waitUntil(
          async () => {
            const ids = await worktreeIds(page);
            return ids.find((candidate) => candidate && !known.has(candidate));
          },
          {
            timeoutMs: 45_000,
            label: `worktree ${index + 1} row reservation`,
          },
        );
      },
      {
        worktree: index + 1,
        // The previous worktree's setup, for every worktree but the first.
        activeSetupScripts: reserveLoad?.activeIds.length ?? 0,
      },
    );
    const reservedRowAtMs = Date.now();
    createdIds.push(id);
    // Git setup for this worktree is now held at the gate until its
    // Git-pending probes ran. A checkout that never arrives fails explicitly.
    await gitGate.waitForEntered(id, { timeoutMs: 60_000 });
    harnessTimings.set(id, {
      // Negative when Git reached the gate before the row was observed.
      gateEnteredAfterReservedRowMs: gitGate.enteredAtMs(id) - reservedRowAtMs,
      priorSetupDrainMs: null,
      // Harness detection after the renderer's Git ready; null for the
      // sustained-typing worktree, whose typing loop observes it.
      gitReadyObservedAfterReadyMs: null,
    });

    const row = sidebarWorktreeRow(page, id);
    await row.click();
    await expect(page.getByTestId('page-main')).toBeVisible({
      timeout: 30_000,
    });
    await expect(visibleChatPanel(page)).toBeVisible({ timeout: 30_000 });

    let creationState = await readWorktreeSetupLoadState(page);
    if (index > 0) {
      creationState = await waitForGitAndScriptOverlap(page, id);
      gitTypingProbesOverlappingSetupScripts += 1;
    }
    const domLoad = await readRendererDomLoadState(page);
    await recordResponsiveTask(
      tasks,
      'type_during_worktree_git_setup',
      async () => {
        await assertWorktreeGitPending(page, id, 'before');
        const typed = await typeDraftAndWaitForPaint(page, {
          scenario: 'worktree-git-setup',
          iteration: index + 1,
          characters: config.gitTypingCharacters,
        });
        await assertWorktreeGitPending(page, id, 'after');
        return typed;
      },
      {
        iteration: index + 1,
        characters: config.gitTypingCharacters,
        targetWorktreeId: id,
        targetGitSetupPending: true,
        activeSetupScripts: creationState?.activeIds.length ?? 0,
        overlapsSetupScript: index > 0,
        domLoad,
      },
      config.responsivenessBudgetMs,
    );
    gitTypedWorktreeIds.add(id);

    if (index === config.worktreesToCreate - 1) {
      sustainedTyping = await recordTask(
        tasks,
        'type_at_cadence_until_worktree_ready',
        () =>
          typeAtCadenceUntilWorktreeSetupCompletes({
            page,
            worktreeId: id,
            intervalMs: config.sustainedTypingIntervalMs,
            timeoutMs: config.scriptHoldMs + 180_000,
            // Release after a few Git-phase keys so the later keys overlap
            // the real checkout and then the setup script.
            onGitPhaseKey: (gitKeys) => {
              if (gitKeys >= config.gitGateReleaseAfterKeys) {
                releaseGitGate(id);
              }
            },
          }),
        {
          targetWorktreeId: id,
          intervalMs: config.sustainedTypingIntervalMs,
          startsDuringGitSetup: true,
          overlapsSetupScript: index > 0,
        },
      );
      Object.assign(tasks.at(-1), sustainedTyping);
      await recordGateHoldTimings(id);
      typedWorktreeIds.add(id);
    } else {
      // Earlier worktrees' setup scripts share the checkout's utility QoS
      // band on macOS, so how many still ran at release decided this time
      // (1.8 s with none, 11-31 s with three). Release only once they all
      // finished; the wait is harness cost, recorded beside the hold.
      const drained = await waitForPriorSetupsToFinish(page, {
        worktreeId: id,
        priorIds: createdIds.slice(0, -1),
        // Every pending setup started within the last scriptHoldMs.
        timeoutMs: worktreeSetupSelectionTimeoutMs(config),
      });
      harnessTimings.get(id).priorSetupDrainMs = drained.drainMs;
      await recordGitReadyAfterRelease(tasks, {
        gitGate,
        worktreeId: id,
        release: () => releaseGitGate(id),
        waitForGitReadyAt: async () => {
          const state = await waitUntil(
            async () => {
              const state = await readWorktreeSetupLoadState(page);
              const message = worktreeGitPendingError(state, id, 'after');
              if (state?.gitFailed[id]) throw new FatalWaitError(message);
              return message ? state : null;
            },
            {
              timeoutMs: 120_000,
              label: `worktree ${id} Git setup after the gate released`,
              intervalMs: 10,
            },
          );
          return state.gitReadyAt[id];
        },
        harnessTiming: harnessTimings.get(id),
        metadata: {
          worktree: index + 1,
          targetWorktreeId: id,
          concurrentSetupScripts: drained.state.activeIds.length,
        },
      });
      await recordGateHoldTimings(id);
    }
    if (
      index !== config.worktreesToCreate - 1 &&
      index < config.interactionIterations
    ) {
      const setupTarget = await selectActiveSetupWorktree({
        page,
        createdIds: [id],
        typedWorktreeIds: new Set(),
        minimumOutputLines: minimumOutputLinesBeforeTyping,
        iteration: index,
        timeoutMs: worktreeSetupSelectionTimeoutMs(config),
      });
      await recordWorktreeSetupInteraction({
        page,
        config,
        tasks,
        targetWorktreeId: setupTarget,
        iteration: index + 1,
      });
      typedWorktreeIds.add(setupTarget);
    }
  }

  if (gitTypedWorktreeIds.size !== createdIds.length) {
    throw new Error(
      `Composer probes covered ${gitTypedWorktreeIds.size} Git-pending worktrees; expected ${createdIds.length}`,
    );
  }
  if (
    createdIds.length > 1 &&
    gitTypingProbesOverlappingSetupScripts !== createdIds.length - 1
  ) {
    throw new Error(
      `Only ${gitTypingProbesOverlappingSetupScripts} Git typing probes overlapped setup scripts; expected ${createdIds.length - 1}`,
    );
  }

  for (
    let index = typedWorktreeIds.size;
    index < config.interactionIterations;
    index += 1
  ) {
    const targetWorktreeId = await selectActiveSetupWorktree({
      page,
      createdIds,
      typedWorktreeIds,
      minimumOutputLines: minimumOutputLinesBeforeTyping,
      iteration: index,
      timeoutMs: worktreeSetupSelectionTimeoutMs(config),
    });
    await recordWorktreeSetupInteraction({
      page,
      config,
      tasks,
      targetWorktreeId,
      iteration: index + 1,
    });
    typedWorktreeIds.add(targetWorktreeId);
  }
  const expectedDistinctTypedWorktrees = Math.min(
    config.interactionIterations,
    createdIds.length,
  );
  if (typedWorktreeIds.size < expectedDistinctTypedWorktrees) {
    throw new Error(
      `Composer probes covered ${typedWorktreeIds.size} setup worktrees; expected ${expectedDistinctTypedWorktrees}`,
    );
  }

  await recordTask(tasks, 'all_worktrees_ready', async () => {
    await waitUntil(
      async () => {
        for (const id of createdIds) {
          const row = sidebarWorktreeRow(page, id);
          const status = await readWorktreeSetupStatus(row);
          if (status.error) {
            throw new Error(`Worktree ${id} setup failed: ${status.error}`);
          }
          if (!status.ready) return false;
        }
        return true;
      },
      {
        timeoutMs: 180_000,
        label: 'all created worktrees to finish setup',
        intervalMs: 250,
      },
    );
  });

  const finalSetupState = await readWorktreeSetupLoadState(page);
  await disposeWorktreeSetupLoadTracker(page);
  const requestedOutputLinesPerSetup =
    requestedPerformanceScriptOutputLines(config);
  const setupsWithoutChattyOutput = createdIds.filter(
    (id) =>
      (finalSetupState?.outputLines[id] ?? 0) < requestedOutputLinesPerSetup,
  );
  if (setupsWithoutChattyOutput.length > 0) {
    throw new Error(
      `Setup scripts did not emit the requested ${requestedOutputLinesPerSetup} lines for: ${setupsWithoutChattyOutput.join(', ')}`,
    );
  }

  const navigationCount = Math.min(
    config.navigationIterations,
    createdIds.length,
  );
  for (let index = 0; index < navigationCount; index += 1) {
    await recordTask(
      tasks,
      'select_created_worktree',
      async () => {
        await sidebarWorktreeRow(page, createdIds[index]).click();
        await expect(visibleChatPanel(page)).toBeVisible({ timeout: 30_000 });
        await nextPaint(page);
      },
      { worktree: index + 1 },
    );
  }

  const expiredGitGateHolds = gitGate.expiredIds();
  if (expiredGitGateHolds.length > 0) {
    throw new Error(
      `The performance Git gate expired before release for: ${expiredGitGateHolds.join(', ')}`,
    );
  }

  return {
    initialWorktrees: initialIds.size,
    createdWorktrees: createdIds.length,
    gitGateHolds: gitGateHolds.map(({ worktreeId }) => ({
      worktreeId,
      ...harnessTimings.get(worktreeId),
    })),
    gitCheckoutConfig,
    finalWorktrees: (await worktreeIds(page)).length,
    interactionsDuringSetup: config.interactionIterations,
    worktreesTypedDuringOwnSetup: typedWorktreeIds.size,
    worktreesTypedDuringGitSetup: gitTypedWorktreeIds.size,
    gitTypingProbesOverlappingSetupScripts,
    gitCheckoutFiles: config.gitCheckoutFiles,
    requestedSetupDurationMs: config.scriptHoldMs,
    requestedOutputLinesPerSetup,
    requestedMaterializedFilesPerSetup: requestedPerformanceScriptFiles(config),
    sustainedTyping,
  };
}

/*
 * Agent Ledger (phase 15). `ledger-panel` seeds the measured worktree's
 * Ledger and 99 Cowork Work Entry Ledgers through the Ledger store, then
 * measures the panel opening to its first page, searches typed into it, and
 * the renderer's own round trips for the first page, search and a local
 * commit, and for the Feed's first page, which reads every scope.
 * `ledger-feed-overview` reuses those scopes with operation trees and measures
 * navigation to the first painted Operations row and the work-list round trip.
 * `ledger-disabled-idle` starts with the Ledger off and checks that startup
 * and idle started no storage worker and created no database.
 */

/**
 * Budgets for the Ledger's renderer round trips at fixture size, recorded
 * in docs/desktop-app-performance.md before measuring. A release-like run
 * fails when one is missed; other builds report the verdict.
 */
export const LEDGER_ROUND_TRIP_BUDGETS_MS = Object.freeze({
  firstPageP95: 200,
  searchP95: 200,
  localCommitP95: 100,
  feedFirstPageP95: 200,
});

/** The Feed overview's first visible Operations row, in release-like builds. */
export const LEDGER_FEED_OPERATIONS_FIRST_PAINT_BUDGET_MS = 200;

/** The Feed panel's first Operations row after opening, in release-like builds. */
export const LEDGER_PANEL_OPERATIONS_READY_BUDGET_MS = 200;

const LEDGER_PANEL_GROUP_ID = 'group-chat';
const LEDGER_PAGE_SIZE = 30;

/**
 * The Feed's first page with no filters, read past its cache. The scenario
 * runs signed out, so it merges every scope the fixture seeded.
 */
const LEDGER_FEED_FIRST_PAGE_REQUEST = Object.freeze({
  audience: 'mine',
  query: '',
  filters: {
    types: [],
    statuses: [],
    owner: 'anyone',
    author: 'anyone',
    period: 'any',
    includeArchived: false,
  },
  refresh: true,
});

const LEDGER_FEED_WORK_REQUEST = Object.freeze({
  includeOlder: false,
  refresh: true,
});

/** The Ledger flag each Ledger scenario launches with, whatever is pinned. */
const LEDGER_SCENARIO_FLAGS = Object.freeze({
  'ledger-panel': true,
  'ledger-feed-overview': true,
  'ledger-disabled-idle': false,
});

/**
 * The client flags a scenario launches with, over the suite's defaults: the
 * flags the caller pinned for every scenario in
 * `CANOPY_E2E_CLIENT_FEATURE_FLAGS`, such as the Ledger for a matched
 * flag-off/flag-on comparison, then the scenario's own. Null when there are
 * none, so the launch keeps the suite's defaults.
 */
export function scenarioClientFeatureFlags(name, env = process.env) {
  const raw = env.CANOPY_E2E_CLIENT_FEATURE_FLAGS;
  let pinned = {};
  if (raw !== undefined && raw.trim() !== '') {
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Reported below, with every other value that is not an object.
    }
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed)
    ) {
      throw new Error(
        'CANOPY_E2E_CLIENT_FEATURE_FLAGS must be a JSON object of flag values',
      );
    }
    pinned = parsed;
  }
  const flags = Object.hasOwn(LEDGER_SCENARIO_FLAGS, name)
    ? { ...pinned, 'canopy-ledger-enabled': LEDGER_SCENARIO_FLAGS[name] }
    : pinned;
  return Object.keys(flags).length > 0 ? flags : null;
}

function ledgerP95(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

/**
 * The account the fixture's scopes were first used under: the one the app
 * will hold, since the Feed shows only that account's scopes. An E2E build
 * keeps guest mode off and stays signed out. A production build has guest mode
 * on, so it mints the mock cloud's guest account at launch.
 */
export function ledgerFixtureAccountId(releaseLike) {
  return releaseLike ? MOCK_GUEST_ACCOUNT_ID : null;
}

async function prepareLedgerScopes(
  userDataDir,
  config,
  { releaseLike = false } = {},
) {
  seedWorkspace(userDataDir);
  const ledger = await seedLedgerFixture({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    scopeEntries: config.ledgerScopeEntries,
    otherScopes: config.ledgerOtherScopes,
    otherScopeEntries: config.ledgerOtherScopeEntries,
    accountId: ledgerFixtureAccountId(releaseLike),
  });
  return {
    ...ledger,
    searches: ledgerFixtureSearches(config.ledgerScopeEntries),
    uniqueCases: ledgerUniqueCaseNumbers(config.ledgerScopeEntries),
  };
}

const LEDGER_FEED_OPERATION_STATUSES = Object.freeze([
  'TODO',
  'BLOCKED',
  'FAILED',
  'COMPLETED',
]);

const LEDGER_FEED_USER_DETAILS = Object.freeze({
  harness: null,
  model: null,
  thinkingEffort: null,
  mode: null,
  pipelineExecutionId: null,
  settingsRevision: null,
  unavailableReason: 'not_applicable',
});

/**
 * Adds Feed work to every scope created by `seedLedgerFixture`, through the
 * same repository path and with the same scope/account identities. The
 * operation trees and unattached tasks give the Feed page a representative
 * Operations table without changing the large-entry Ledger workload.
 */
async function seedLedgerFeedOverviewWork({ userDataDir, accountId }) {
  const startedAt = performance.now();
  const LedgerRepository = await loadLedgerRepository();
  const workspaceRoot = path.join(userDataDir, 'workspaces');
  const worktreeManifest = JSON.parse(
    readFileSync(
      path.join(workspaceRoot, WORKSPACE_ID, 'worktrees.json'),
      'utf8',
    ),
  );
  const worktree = worktreeManifest.worktrees.find(
    (candidate) => candidate.id === WORKTREE_ID,
  );
  if (typeof worktree?.createdAt !== 'string') {
    throw new Error(`Ledger Feed fixture: ${WORKTREE_ID} has no creation time`);
  }
  const coworkEntries = JSON.parse(
    readFileSync(
      path.join(workspaceRoot, LEDGER_FIXTURE_COWORK_ID, 'work-entries.json'),
      'utf8',
    ),
  ).entries;

  let now = Date.now();
  const repository = LedgerRepository.open({
    databasePath: path.join(userDataDir, 'ledger', 'ledger.sqlite'),
    now: () => new Date(now++),
  });
  let operationCount = 0;
  let taskCount = 0;
  let subtaskCount = 0;
  try {
    repository.database.exec('PRAGMA synchronous = OFF');
    const scopeDescriptors = [
      {
        label: 'measured',
        container: {
          kind: 'code_worktree',
          workspaceId: WORKSPACE_ID,
          worktreeId: WORKTREE_ID,
        },
        containerCreatedAt: worktree.createdAt,
      },
      ...coworkEntries.map((entry) => ({
        label: entry.id,
        container: {
          kind: 'cowork_entry',
          workspaceId: LEDGER_FIXTURE_COWORK_ID,
          entryId: entry.id,
        },
        containerCreatedAt: entry.createdAt,
      })),
    ];

    for (const [scopeIndex, descriptor] of scopeDescriptors.entries()) {
      const ledgerId = repository.bindScope({
        authorityId: repository.authorityId,
        container: descriptor.container,
        containerCreatedAt: descriptor.containerCreatedAt,
        accountId,
      }).scope.scope.ledgerId;
      const user = repository.registerActor({
        ledgerId,
        kind: 'user',
        authorityId: repository.authorityId,
        originKey: 'user:local',
        displayName: 'You',
      }).actor.actor;
      const origin = { kind: 'user', ledgerId, userActorId: user.actorId };
      const attribution = {
        kind: 'user',
        effectiveActor: user,
        recordedBy: user,
        executorDetails: LEDGER_FEED_USER_DETAILS,
      };
      const add = (params, key) =>
        repository.addEntry({
          ledgerId,
          author: user,
          authorDetails: LEDGER_FEED_USER_DETAILS,
          origin,
          attribution,
          owner: user,
          params,
          idempotencyKey: `perf-ledger-feed-${String(scopeIndex)}-${key}`,
        });

      for (let operationIndex = 0; operationIndex < 3; operationIndex += 1) {
        const operation = add(
          {
            type: 'OPERATION',
            title: `${descriptor.label} operation ${String(operationIndex + 1)}`,
            content: `Performance Operations row ${String(operationIndex + 1)} for ${descriptor.label}.`,
          },
          `operation-${String(operationIndex)}`,
        );
        operationCount += 1;

        for (let taskIndex = 0; taskIndex < 3; taskIndex += 1) {
          // The first task gets a subtask, so it stays open: the store
          // refuses a child under a closed parent (PARENT_CLOSED).
          const status =
            taskIndex === 0
              ? 'IN_PROGRESS'
              : LEDGER_FEED_OPERATION_STATUSES[
                  (scopeIndex + operationIndex + taskIndex) %
                    LEDGER_FEED_OPERATION_STATUSES.length
                ];
          const task = add(
            {
              type: 'TASK',
              title: `${descriptor.label} operation task ${String(taskIndex + 1)}`,
              content: `A ${status.toLowerCase()} operation task for ${descriptor.label}.`,
              status,
              parentEntryId: operation.entry.entryId,
            },
            `operation-${String(operationIndex)}-task-${String(taskIndex)}`,
          );
          taskCount += 1;

          if (taskIndex === 0) {
            const subtaskStatus =
              LEDGER_FEED_OPERATION_STATUSES[
                (scopeIndex + operationIndex + taskIndex + 1) %
                  LEDGER_FEED_OPERATION_STATUSES.length
              ];
            add(
              {
                type: 'TASK',
                title: `${descriptor.label} operation subtask ${String(operationIndex + 1)}`,
                content: `A ${subtaskStatus.toLowerCase()} nested task for ${descriptor.label}.`,
                status: subtaskStatus,
                parentEntryId: task.entry.entryId,
              },
              `operation-${String(operationIndex)}-subtask`,
            );
            subtaskCount += 1;
          }
        }
      }

      for (let taskIndex = 0; taskIndex < 2; taskIndex += 1) {
        const status =
          LEDGER_FEED_OPERATION_STATUSES[
            (scopeIndex + taskIndex + 2) % LEDGER_FEED_OPERATION_STATUSES.length
          ];
        add(
          {
            type: 'TASK',
            title: `${descriptor.label} ungrouped task ${String(taskIndex + 1)}`,
            content: `A ${status.toLowerCase()} top-level task without an operation for ${descriptor.label}.`,
            status,
          },
          `top-level-task-${String(taskIndex)}`,
        );
        taskCount += 1;
      }
    }
  } finally {
    repository.close();
  }

  return {
    operationCount,
    taskCount,
    subtaskCount,
    seedMs: Math.round(performance.now() - startedAt),
  };
}

/**
 * The Ledger scopes with operation trees in each: the Feed panel's
 * Operations section and the Feed page's Operations table read the same work.
 */
async function prepareLedgerPanel(
  userDataDir,
  config,
  { releaseLike = false } = {},
) {
  const fixture = await prepareLedgerScopes(userDataDir, config, {
    releaseLike,
  });
  const operations = await seedLedgerFeedOverviewWork({
    userDataDir,
    accountId: ledgerFixtureAccountId(releaseLike),
  });
  return {
    ...fixture,
    ...operations,
    seedMs: fixture.seedMs + operations.seedMs,
  };
}

const prepareLedgerFeedOverview = prepareLedgerPanel;

/**
 * Why a first Ledger read shows the scenario cannot measure the Ledger, or
 * null when it can. A release-like build ignores the E2E flag override and
 * takes the Ledger flag from its bundled LaunchDarkly environment, or the
 * not-configured default (on) without one, so a build whose environment
 * leaves the Ledger off fails here instead of on a missing panel.
 */
export function ledgerUnavailableReason(result, releaseLike) {
  if (result?.status === 'ok') return null;
  if (result?.status === 'unavailable' && result.reason === 'disabled') {
    return releaseLike
      ? 'The Ledger is off in this production build: build it without a LaunchDarkly client-side ID, or turn the Ledger on in its LaunchDarkly environment'
      : 'The Ledger is off, though the scenario launches with canopy-ledger-enabled on';
  }
  return `The Ledger could not be read: ${[
    result?.status ?? 'no result',
    result?.reason ?? '',
  ]
    .join(' ')
    .trim()}`;
}

/** One Ledger API call from the renderer, timed there. */
async function timedLedgerCall(page, method, request) {
  return page.evaluate(
    async ({ method: name, request: payload }) => {
      const startedAt = performance.now();
      const result = await window.api.ledger[name](payload);
      const roundTripMs = performance.now() - startedAt;
      if (result.status !== 'ok') {
        throw new Error(
          `Ledger ${name} failed: ${result.status} ${result.reason ?? ''}`,
        );
      }
      const items = result.value.entries ?? result.value.rows;
      return {
        roundTripMs,
        entries: Array.isArray(items) ? items.length : null,
      };
    },
    { method, request },
  );
}

async function recordLedgerRoundTrip(
  tasks,
  kind,
  page,
  method,
  request,
  meta,
  config,
) {
  const value = await recordResponsiveTask(
    tasks,
    kind,
    async () => {
      const call = await timedLedgerCall(page, method, request);
      return {
        ...call,
        performanceTaskMetrics: { rendererRoundTripMs: call.roundTripMs },
      };
    },
    meta,
    config.responsivenessBudgetMs,
  );
  return value;
}

async function runLedgerPanel({
  page,
  app,
  config,
  tasks,
  fixture,
  releaseLike,
}) {
  await openMainPage(page);
  await app.selectWorktree(WORKTREE_BRANCH, NO_ACTIVITY_RAIL);
  await expect(visibleChatPanel(page)).toBeVisible({ timeout: 30_000 });
  const scope = { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID };
  const unavailable = ledgerUnavailableReason(
    await page.evaluate((request) => window.api.ledger.searchEntries(request), {
      scope,
      params: { limit: 1 },
    }),
    releaseLike,
  );
  if (unavailable !== null) throw new Error(unavailable);

  // The panel, opened to its first page of entries.
  let panel;
  let openStartedAt = 0;
  let operationsReadyMs = null;
  await recordResponsiveTask(
    tasks,
    'open_ledger_panel',
    async () => {
      openStartedAt = await page.evaluate(() => performance.now());
      await openPanelAddMenu(page, LEDGER_PANEL_GROUP_ID);
      await page.getByTestId('panel-add-menu-item-ledger').click();
      panel = page.getByTestId('ledger-panel');
      await expect(panel.getByTestId('ledger-entry-row').first()).toBeVisible({
        timeout: 60_000,
      });
      await nextPaint(page);
    },
    { scopeEntries: fixture.scopeEntries },
    config.responsivenessBudgetMs,
  );

  // The sectioned panel (Phase 06): its Operations rows after opening, and
  // one operation opened to its tree. A build without sections skips both.
  const sections = page.getByTestId('ledger-panel-sections');
  if ((await sections.count()) > 0) {
    const operationRow = sections.getByTestId('feed-operations-row').first();
    await recordResponsiveTask(
      tasks,
      'ledger_panel_operations_ready',
      async () => {
        await expect(operationRow).toBeVisible({ timeout: 60_000 });
        await nextPaint(page);
        operationsReadyMs = await page.evaluate(
          (startedAt) => performance.now() - startedAt,
          openStartedAt,
        );
        return { performanceTaskMetrics: { operationsReadyMs } };
      },
      {
        operations: fixture.operationCount,
        budgetMs: LEDGER_PANEL_OPERATIONS_READY_BUDGET_MS,
      },
      config.responsivenessBudgetMs,
    );
    await recordResponsiveTask(
      tasks,
      'open_ledger_panel_operation',
      async () => {
        await operationRow.getByTestId('feed-operations-title').click();
        await expect(
          sections.getByTestId('feed-operations-tree').first(),
        ).toBeVisible({ timeout: 60_000 });
        await nextPaint(page);
      },
      { operations: fixture.operationCount },
      config.responsivenessBudgetMs,
    );
  }

  // Searches typed into the panel, through its debounce to painted rows.
  const rows = panel.getByTestId('ledger-entry-row');
  for (const number of fixture.uniqueCases) {
    await recordResponsiveTask(
      tasks,
      'search_ledger_panel',
      async () => {
        await panel.getByTestId('ledger-search').fill(`case ${String(number)}`);
        await expect(rows).toHaveCount(1, { timeout: 60_000 });
        await expect(rows.first()).toContainText(`case ${String(number)}`);
        await nextPaint(page);
      },
      { scopeEntries: fixture.scopeEntries },
      config.responsivenessBudgetMs,
    );
  }
  await recordResponsiveTask(
    tasks,
    'clear_ledger_panel_search',
    async () => {
      await panel.getByTestId('ledger-search').fill('');
      await expect
        .poll(() => rows.count(), { timeout: 60_000 })
        .toBeGreaterThan(1);
      await nextPaint(page);
    },
    { scopeEntries: fixture.scopeEntries },
    config.responsivenessBudgetMs,
  );

  // A production build's guest sign-in may still be landing: wait until the
  // Feed holds a full first page of the fixture before timing it.
  await expect
    .poll(
      async () => {
        try {
          return (
            await timedLedgerCall(
              page,
              'searchFeed',
              LEDGER_FEED_FIRST_PAGE_REQUEST,
            )
          ).entries;
        } catch {
          return null;
        }
      },
      { timeout: 60_000 },
    )
    .toBe(LEDGER_PAGE_SIZE);

  // The renderer's own round trips: first page, search and a local commit,
  // and the Feed's first page across every scope, read past its cache.
  const firstPage = [];
  const search = [];
  const commit = [];
  const feedFirstPage = [];
  for (let index = 0; index < config.ledgerRoundTrips; index += 1) {
    const page1 = await recordLedgerRoundTrip(
      tasks,
      'ledger_first_page',
      page,
      'searchEntries',
      { scope, params: { limit: LEDGER_PAGE_SIZE } },
      { iteration: index + 1 },
      config,
    );
    firstPage.push(page1.roundTripMs);
    const query = fixture.searches[index % fixture.searches.length];
    const found = await recordLedgerRoundTrip(
      tasks,
      'ledger_search',
      page,
      'searchEntries',
      { scope, params: { query: query.query, limit: LEDGER_PAGE_SIZE } },
      { iteration: index + 1, search: query.label },
      config,
    );
    search.push(found.roundTripMs);
    const committed = await recordLedgerRoundTrip(
      tasks,
      'ledger_local_commit',
      page,
      'addEntry',
      {
        scope,
        requestKey: `perf-ledger-commit-${String(index + 1)}`,
        params: {
          type: 'TASK',
          title: `Performance commit ${String(index + 1)}`,
          content: 'Recorded by the Ledger performance scenario.',
        },
      },
      { iteration: index + 1 },
      config,
    );
    commit.push(committed.roundTripMs);
    const feed = await recordLedgerRoundTrip(
      tasks,
      'ledger_feed_first_page',
      page,
      'searchFeed',
      LEDGER_FEED_FIRST_PAGE_REQUEST,
      { iteration: index + 1, scopes: fixture.totalScopes },
      config,
    );
    if (feed.entries !== LEDGER_PAGE_SIZE) {
      throw new Error(
        `The Feed's first page held ${String(feed.entries)} rows, not ${String(LEDGER_PAGE_SIZE)}`,
      );
    }
    feedFirstPage.push(feed.roundTripMs);
  }

  const verdicts = {
    firstPageP95Ms: ledgerP95(firstPage),
    searchP95Ms: ledgerP95(search),
    localCommitP95Ms: ledgerP95(commit),
    feedFirstPageP95Ms: ledgerP95(feedFirstPage),
  };
  const misses = [
    verdicts.firstPageP95Ms > LEDGER_ROUND_TRIP_BUDGETS_MS.firstPageP95
      ? `first page p95 ${verdicts.firstPageP95Ms.toFixed(1)} ms`
      : null,
    verdicts.searchP95Ms > LEDGER_ROUND_TRIP_BUDGETS_MS.searchP95
      ? `search p95 ${verdicts.searchP95Ms.toFixed(1)} ms`
      : null,
    verdicts.localCommitP95Ms > LEDGER_ROUND_TRIP_BUDGETS_MS.localCommitP95
      ? `local commit p95 ${verdicts.localCommitP95Ms.toFixed(1)} ms`
      : null,
    verdicts.feedFirstPageP95Ms > LEDGER_ROUND_TRIP_BUDGETS_MS.feedFirstPageP95
      ? `Feed first page p95 ${verdicts.feedFirstPageP95Ms.toFixed(1)} ms`
      : null,
    operationsReadyMs !== null &&
    operationsReadyMs > LEDGER_PANEL_OPERATIONS_READY_BUDGET_MS
      ? `panel Operations ready ${operationsReadyMs.toFixed(1)} ms`
      : null,
  ].filter((miss) => miss !== null);
  if (releaseLike && misses.length > 0) {
    throw new Error(
      `Ledger round trips missed their budgets in a release-like run: ${misses.join(', ')}`,
    );
  }
  return {
    scopeEntries: fixture.scopeEntries,
    totalScopes: fixture.totalScopes,
    totalEntries: fixture.totalEntries,
    seedMs: fixture.seedMs,
    roundTrips: config.ledgerRoundTrips,
    firstPageP95Ms: Math.round(verdicts.firstPageP95Ms * 10) / 10,
    searchP95Ms: Math.round(verdicts.searchP95Ms * 10) / 10,
    localCommitP95Ms: Math.round(verdicts.localCommitP95Ms * 10) / 10,
    feedFirstPageP95Ms: Math.round(verdicts.feedFirstPageP95Ms * 10) / 10,
    ...(operationsReadyMs === null
      ? {}
      : { operationsReadyMs: Math.round(operationsReadyMs * 10) / 10 }),
    budgetMisses: misses.length,
  };
}

/** One Feed work-list IPC round trip, measured by the renderer that invokes it. */
async function timedLedgerFeedWork(page) {
  return page.evaluate(async (request) => {
    const startedAt = performance.now();
    const result = await window.api.ledger.listFeedWork(request);
    const roundTripMs = performance.now() - startedAt;
    if (result.status !== 'ok') {
      throw new Error(
        `Ledger listFeedWork failed: ${result.status} ${result.reason ?? ''}`,
      );
    }
    return { roundTripMs, rows: result.value.rows.length };
  }, LEDGER_FEED_WORK_REQUEST);
}

async function runLedgerFeedOverview({
  page,
  app,
  config,
  tasks,
  fixture,
  releaseLike,
}) {
  await openMainPage(page);
  await app.selectWorktree(WORKTREE_BRANCH, NO_ACTIVITY_RAIL);
  await expect(visibleChatPanel(page)).toBeVisible({ timeout: 30_000 });
  if (releaseLike) {
    // A production build mints its guest account at launch; wait for that
    // identity without warming the Feed work-list cache before navigation.
    await expect
      .poll(
        async () =>
          page.evaluate(async () => {
            const account = await window.api.loadCanopyCloudAccount();
            return account.account?.id ?? null;
          }),
        { timeout: 60_000 },
      )
      .toBe(MOCK_GUEST_ACCOUNT_ID);
  }
  const scope = { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID };
  const unavailable = ledgerUnavailableReason(
    await page.evaluate((request) => window.api.ledger.searchEntries(request), {
      scope,
      params: { limit: 1 },
    }),
    releaseLike,
  );
  if (unavailable !== null) throw new Error(unavailable);

  const firstPaint = await recordResponsiveTask(
    tasks,
    'ledger_feed_operations_first_paint',
    async () => {
      const navigationStartedAt = await page.evaluate(() => performance.now());
      await page.getByTestId('sidebar-nav-feed').click();
      const operationsRow = page
        .getByTestId('page-feed')
        .getByTestId('feed-operations-row')
        .first();
      // A cold baseline-sized Ledger can take minutes; measure it against the
      // budget rather than abort the scenario.
      await expect(operationsRow).toBeVisible({ timeout: 180_000 });
      await nextPaint(page);
      const firstPaintMs = await page.evaluate(
        (startedAt) => performance.now() - startedAt,
        navigationStartedAt,
      );
      return {
        firstPaintMs,
        performanceTaskMetrics: {
          feedOperationsFirstPaintMs: firstPaintMs,
        },
      };
    },
    {
      operations: fixture.operationCount,
      topLevelTasks: fixture.taskCount - fixture.operationCount * 3,
      firstPaintBudgetMs: LEDGER_FEED_OPERATIONS_FIRST_PAINT_BUDGET_MS,
    },
    config.responsivenessBudgetMs,
  );

  const feedWorkRoundTrips = [];
  for (let index = 0; index < config.ledgerRoundTrips; index += 1) {
    const call = await recordResponsiveTask(
      tasks,
      'ledger_feed_work_round_trip',
      async () => {
        const value = await timedLedgerFeedWork(page);
        return {
          ...value,
          performanceTaskMetrics: {
            ledgerFeedWorkRoundTripMs: value.roundTripMs,
          },
        };
      },
      { iteration: index + 1, scopes: fixture.totalScopes },
      config.responsivenessBudgetMs,
    );
    if (call.rows === 0) {
      throw new Error(
        'The Feed work list returned no Operations or top-level tasks',
      );
    }
    feedWorkRoundTrips.push(call.roundTripMs);
  }

  const feedWorkP95Ms = ledgerP95(feedWorkRoundTrips);
  const firstPaintBudgetMiss =
    firstPaint.firstPaintMs > LEDGER_FEED_OPERATIONS_FIRST_PAINT_BUDGET_MS;
  if (releaseLike && firstPaintBudgetMiss) {
    throw new Error(
      `Feed Operations first paint missed its ${String(LEDGER_FEED_OPERATIONS_FIRST_PAINT_BUDGET_MS)} ms budget in a release-like run: ${firstPaint.firstPaintMs.toFixed(1)} ms`,
    );
  }

  return {
    scopeEntries: fixture.scopeEntries,
    totalScopes: fixture.totalScopes,
    totalEntries:
      fixture.totalEntries +
      fixture.operationCount +
      fixture.taskCount +
      fixture.subtaskCount,
    operationsSeeded: fixture.operationCount,
    tasksSeeded: fixture.taskCount,
    subtasksSeeded: fixture.subtaskCount,
    seedMs: fixture.seedMs,
    firstTablePaintMs: Math.round(firstPaint.firstPaintMs * 10) / 10,
    firstTablePaintBudgetMs: LEDGER_FEED_OPERATIONS_FIRST_PAINT_BUDGET_MS,
    firstTablePaintBudgetMisses: Number(firstPaintBudgetMiss),
    feedWorkRoundTrips: feedWorkRoundTrips.length,
    feedWorkRoundTripP95Ms: Math.round(feedWorkP95Ms * 10) / 10,
    budgetEnforced: releaseLike,
  };
}

function prepareLedgerDisabledIdle(userDataDir) {
  seedWorkspace(userDataDir);
  return { ledgerDirectory: path.join(userDataDir, 'ledger') };
}

async function runLedgerDisabledIdle({
  page,
  app,
  electronApp,
  config,
  tasks,
  fixture,
}) {
  await openMainPage(page);
  await app.selectWorktree(WORKTREE_BRANCH, NO_ACTIVITY_RAIL);
  await expect(visibleChatPanel(page)).toBeVisible({ timeout: 30_000 });
  await recordTask(
    tasks,
    'ledger_disabled_idle',
    () => delay(config.ledgerIdleDwellMs),
    { dwellMs: config.ledgerIdleDwellMs },
  );
  const storageWorkersStarted = await electronApp.evaluate(() => {
    const ledger = Reflect.get(globalThis, '__CANOPY_E2E_LEDGER__');
    const count = ledger?.storageWorkersStarted;
    return typeof count === 'function' ? count() : -1;
  });
  const databaseCreated = existsSync(fixture.ledgerDirectory);
  if (storageWorkersStarted !== 0 || databaseCreated) {
    throw new Error(
      `With the Ledger off, startup and idle started ${String(storageWorkersStarted)} storage worker(s) and ${databaseCreated ? 'created' : 'did not create'} the Ledger database`,
    );
  }
  return {
    storageWorkersStarted,
    databaseCreated: 0,
    idleDwellMs: config.ledgerIdleDwellMs,
  };
}

/*
 * `cost-index-first-build` shows a worktree with a week of audit history and
 * its Activity rail, whose Cost section reads the worktree's cost before any
 * summary exists, then idles past the cost index's 60-second startup delay
 * while the composer is typed into. The audit files come from
 * `cost-index-fixture.mjs`. A build without the cost index runs the same
 * journey over the same files, so a matched comparison isolates its reading
 * and indexing.
 */

function prepareCostIndexFirstBuild(userDataDir, config) {
  seedWorkspace(userDataDir);
  const audit = seedCostIndexAudit({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    days: config.costIndexAuditDays,
    linesPerDay: config.costIndexAuditLinesPerDay,
    turnsPerDay: config.costIndexAuditTurnsPerDay,
  });
  return {
    audit,
    checkpointPath: path.join(userDataDir, 'cost-index', 'checkpoint.json'),
  };
}

/**
 * What the cost index recorded, read from its checkpoint after the dwell:
 * how many audit files it read to the end, and its last refresh. Null when
 * the build has no cost index or never wrote one.
 */
export function costIndexCheckpointSummary(checkpointPath, auditFiles) {
  if (!existsSync(checkpointPath)) return null;
  const checkpoint = JSON.parse(readFileSync(checkpointPath, 'utf8'));
  const audit = checkpoint?.audit ?? {};
  const filesRead = auditFiles.filter((file) => {
    const state = audit[path.basename(file)];
    return state !== undefined && state.offset >= state.size && state.size > 0;
  }).length;
  const last = checkpoint?.lastRefresh;
  return {
    costIndexFilesRead: filesRead,
    ...(last === undefined
      ? {}
      : {
          costIndexLastRefreshTrigger: last.trigger,
          costIndexLastRefreshMs: last.durationMs,
          costIndexLastRefreshLines: last.linesRead,
        }),
  };
}

async function runCostIndexFirstBuild({ page, app, config, tasks, fixture }) {
  await openMainPage(page);
  await app.selectWorktree(WORKTREE_BRANCH);
  await expect(visibleChatPanel(page)).toBeVisible({ timeout: 30_000 });
  const dwellStartedAt = performance.now();
  let bursts = 0;
  while (performance.now() - dwellStartedAt < config.costIndexDwellMs) {
    bursts += 1;
    const iteration = bursts;
    await recordResponsiveTask(
      tasks,
      'type_while_cost_index_builds',
      () =>
        typeDraftAndWaitForPaint(page, {
          scenario: 'cost-index-first-build',
          iteration,
          characters: config.typingCharacters,
        }),
      { iteration, characters: config.typingCharacters },
      config.responsivenessBudgetMs,
    );
    const remainingMs =
      config.costIndexDwellMs - (performance.now() - dwellStartedAt);
    if (remainingMs > 0) {
      await delay(Math.min(config.costIndexTypingIntervalMs, remainingMs));
    }
  }
  const index = costIndexCheckpointSummary(
    fixture.checkpointPath,
    fixture.audit.files,
  );
  return {
    auditFiles: fixture.audit.files.length,
    auditBytes: fixture.audit.bytes,
    auditLines: fixture.audit.lines,
    auditScopes: fixture.audit.scopes,
    dwellMs: config.costIndexDwellMs,
    typingBursts: bursts,
    costIndexPresent: index === null ? 0 : 1,
    ...(index ?? {}),
  };
}

// ── Repeat-task skill suggestions: first-scan backfill (CAN-385) ───────────

/**
 * `skill-suggestions-backfill`: about 300 recent chats, three of them large,
 * sit in a worktree the UI never opens. The control phase types into the
 * foreground composer with the `skillSuggestionsEnabled` preference off, so
 * no backfill runs. The measured phase turns it on and runs the first-scan
 * backfill and clustering with the model step stubbed (E2E builds never
 * schedule scans, so an E2E-only main seam starts them) while the composer is
 * typed into. Budget: main event-loop delay p99 at most 50 ms and max at most
 * 100 ms, with typing inside the responsiveness budget of its control.
 */
const SKILL_SUGGESTION_BACKFILL_PROBE_KEY =
  '__CANOPY_E2E_RUN_SKILL_SUGGESTION_BACKFILL__';
const SKILL_SUGGESTION_HISTORY_WORKTREE_ID = 'skill-suggestions-history';
const SKILL_SUGGESTION_BACKFILL_CHATS = 300;
const SKILL_SUGGESTION_BACKFILL_LARGE_CHATS = 3;
const SKILL_SUGGESTION_BACKFILL_LARGE_MESSAGES = 4_000;
const SKILL_SUGGESTION_BACKFILL_TURNS = 6;
export const SKILL_SUGGESTION_BACKFILL_LOOP_BUDGET = Object.freeze({
  p99Ms: 50,
  maxMs: 100,
});
const SKILL_SUGGESTION_PROMPTS = [
  'Summarize the weekly release notes for the {x} app and post them to the team channel',
  'Triage the open bug reports for {x} and label each one by severity',
  'Write the changelog entry for {x} from the merged pull requests since last week',
  'Draft the customer update email for {x} covering this sprint',
  'Check the failing integration tests on {x} and explain the root cause',
  '/review the {x} branch',
  '/push-branch',
  '/open-pr for {x}',
];
const SKILL_SUGGESTION_TOOLS = ['Read', 'Grep', 'Bash', 'Edit'];

function skillSuggestionHistoryMessages(chatIndex, now, large) {
  const day = 24 * 60 * 60 * 1000;
  const startedAt = now - ((chatIndex % 25) + 1) * day;
  const messages = [];
  // A row outside the 30-day window is skipped by timestamp.
  messages.push({
    id: `ssb-${chatIndex}-old`,
    role: 'user',
    timestamp: now - 45 * day,
    blocks: [{ type: 'text', text: 'An old request outside the window' }],
  });
  const turns = large
    ? Math.floor(SKILL_SUGGESTION_BACKFILL_LARGE_MESSAGES / 2)
    : SKILL_SUGGESTION_BACKFILL_TURNS;
  for (let turn = 0; turn < turns; turn += 1) {
    const template =
      SKILL_SUGGESTION_PROMPTS[
        (chatIndex + turn) % SKILL_SUGGESTION_PROMPTS.length
      ];
    const timestamp = startedAt + turn * 1_000;
    messages.push({
      id: `ssb-${chatIndex}-u${turn}`,
      role: 'user',
      timestamp,
      blocks: [
        { type: 'text', text: template.replace('{x}', `app-${chatIndex % 7}`) },
      ],
    });
    messages.push({
      id: `ssb-${chatIndex}-a${turn}`,
      role: 'assistant',
      timestamp: timestamp + 500,
      blocks: [
        {
          type: 'tool_use',
          toolUseId: `ssb-${chatIndex}-t${turn}`,
          toolName:
            SKILL_SUGGESTION_TOOLS[turn % SKILL_SUGGESTION_TOOLS.length],
          input: '{}',
        },
        {
          type: 'text',
          text: `Done with step ${turn}. ${'Result details for the request. '.repeat(large ? 60 : 4)}`,
        },
      ],
    });
  }
  return messages;
}

function prepareSkillSuggestionsBackfill(userDataDir) {
  seedWorkspace(userDataDir);
  const now = Date.now();
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [
      {
        id: 'skill-suggestions-foreground',
        title: 'Skill Suggestions Foreground Probe',
        createdAt: new Date(now).toISOString(),
        messages: [],
      },
    ],
  });
  const tabs = Array.from(
    { length: SKILL_SUGGESTION_BACKFILL_CHATS },
    (_, index) => {
      const large = index < SKILL_SUGGESTION_BACKFILL_LARGE_CHATS;
      return {
        id: `skill-suggestions-history-${index}`,
        title: `History ${index}`,
        createdAt: new Date(now - 46 * 24 * 60 * 60 * 1000).toISOString(),
        messages: skillSuggestionHistoryMessages(index, now, large),
      };
    },
  );
  const seeded = seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: SKILL_SUGGESTION_HISTORY_WORKTREE_ID,
    providerType: 'claude',
    tabs,
  });
  return {
    chats: tabs.length,
    messages: tabs.reduce((total, tab) => total + tab.messages.length, 0),
    sourceFileBytes: statSync(seeded.filePath).size,
  };
}

async function setSkillSuggestionsPreference(page, enabled) {
  await page.evaluate(
    (value) => window.api.savePreferences({ skillSuggestionsEnabled: value }),
    enabled,
  );
}

async function runSkillSuggestionsBackfill({
  page,
  app,
  electronApp,
  config,
  tasks,
  fixture,
}) {
  await openMainPage(page);
  await app.selectWorktree(WORKTREE_BRANCH, NO_ACTIVITY_RAIL);
  await expect(visibleChatPanel(page)).toBeVisible({ timeout: 60_000 });

  // The seeded history is a legacy tabs file; its one-time migration to V2
  // storage happens here, outside both measured phases.
  await recordTask(
    tasks,
    'migrate_skill_suggestion_history_fixture',
    () =>
      page.evaluate(
        ({ projectId, worktreeId }) =>
          window.api.chat.loadTabs({ projectId, worktreeId }),
        {
          projectId: WORKSPACE_ID,
          worktreeId: SKILL_SUGGESTION_HISTORY_WORKTREE_ID,
        },
      ),
    { chats: fixture.chats },
  );

  // Control: the same seed and build with the preference off, no backfill.
  await setSkillSuggestionsPreference(page, false);
  const controlBursts = 3;
  for (let iteration = 1; iteration <= controlBursts; iteration += 1) {
    await recordResponsiveTask(
      tasks,
      'type_without_skill_suggestion_backfill',
      () =>
        typeDraftAndWaitForPaint(page, {
          scenario: 'skill-suggestions-backfill-control',
          iteration,
          characters: config.typingCharacters,
        }),
      { iteration, characters: config.typingCharacters, control: true },
      config.responsivenessBudgetMs,
    );
  }

  await setSkillSuggestionsPreference(page, true);
  let settled = false;
  const probe = recordTask(
    tasks,
    'skill_suggestion_backfill_and_clustering',
    () =>
      electronApp.evaluate(async (_electron, key) => {
        const run = globalThis[key];
        if (typeof run !== 'function') {
          throw new Error('The skill suggestion backfill seam is unavailable');
        }
        return run();
      }, SKILL_SUGGESTION_BACKFILL_PROBE_KEY),
    { chats: fixture.chats, messages: fixture.messages },
  ).finally(() => {
    settled = true;
  });
  let bursts = 0;
  do {
    bursts += 1;
    const iteration = bursts;
    await recordResponsiveTask(
      tasks,
      'type_during_skill_suggestion_backfill',
      () =>
        typeDraftAndWaitForPaint(page, {
          scenario: 'skill-suggestions-backfill',
          iteration,
          characters: config.typingCharacters,
        }),
      { iteration, characters: config.typingCharacters },
      config.responsivenessBudgetMs,
    );
  } while (!settled && bursts < 60);
  const result = await probe;
  const probeTask = tasks.findLast(
    (task) => task.kind === 'skill_suggestion_backfill_and_clustering',
  );
  if (result.backfill !== 'done' || !(result.turnRows > 0)) {
    throw new Error(
      `Skill suggestion backfill did not finish (backfill ${result.backfill}, ${result.turnRows} turn rows)`,
    );
  }
  const budget = SKILL_SUGGESTION_BACKFILL_LOOP_BUDGET;
  if (
    probeTask &&
    (result.eventLoopDelayP99Ms > budget.p99Ms ||
      result.eventLoopDelayMaxMs > budget.maxMs)
  ) {
    probeTask.status = 'unresponsive';
    probeTask.error = `main event-loop delay p99 ${result.eventLoopDelayP99Ms.toFixed(1)}ms / max ${result.eventLoopDelayMaxMs.toFixed(1)}ms exceeded the ${budget.p99Ms}ms / ${budget.maxMs}ms budget`;
  }
  return {
    seededChats: fixture.chats,
    seededMessages: fixture.messages,
    sourceFileBytes: fixture.sourceFileBytes,
    controlTypingBursts: controlBursts,
    typingBursts: bursts,
    backfillMs: result.backfillMs,
    backfillAndClusteringMs: result.durationMs,
    turnRows: result.turnRows,
    chainRows: result.chainRows,
    scannedPartitions: result.scannedPartitions,
    candidateCount: result.candidateCount,
    longestSliceMs: result.longestSliceMs,
    sliceYields: result.sliceYields,
    eventLoopDelayP99Ms: result.eventLoopDelayP99Ms,
    eventLoopDelayMaxMs: result.eventLoopDelayMaxMs,
  };
}

// ── Startup journeys: J1 milestones, App Advisor opening, v8.compile ────────

// Lab-only Chromium startup trace (`--startup-trace`): V8 compile and cache
// events of every process for the first seconds after launch.
const STARTUP_TRACE_CATEGORIES = 'v8,devtools.timeline';
const STARTUP_TRACE_DURATION_S = 10;

export function startupTraceElectronArgs(tracePath) {
  return [
    `--trace-startup=${STARTUP_TRACE_CATEGORIES}`,
    `--trace-startup-file=${tracePath}`,
    `--trace-startup-duration=${STARTUP_TRACE_DURATION_S}`,
    '--trace-startup-format=json',
  ];
}

function scriptFileName(url) {
  if (typeof url !== 'string' || url.length === 0) return '(inline)';
  const withoutQuery = url.split(/[?#]/, 1)[0];
  return withoutQuery.slice(withoutQuery.lastIndexOf('/') + 1) || withoutQuery;
}

/**
 * V8 compile and code-cache events from a Chromium JSON trace, or the
 * slices `perfettoTraceEvents` reads from a Perfetto one: per event
 * name, how many ran and their summed duration, how many were streamed, the
 * code-cache bytes consumed and produced, rejected caches, and the scripts
 * that took longest to compile. Whether a launch consumed a code cache is
 * the P4 question this answers.
 */
export function summarizeV8CompileTrace(trace) {
  const events = Array.isArray(trace) ? trace : (trace?.traceEvents ?? []);
  const byName = {};
  const scripts = new Map();
  let consumedCacheBytes = 0;
  let producedCacheBytes = 0;
  let cacheRejections = 0;
  let streamed = 0;
  const notStreamedReasons = {};
  for (const event of events) {
    if (
      typeof event?.name !== 'string' ||
      !/^v8\.(compile|produce|consume)/.test(event.name)
    ) {
      continue;
    }
    const aggregate = (byName[event.name] ??= { count: 0, durationMs: 0 });
    aggregate.count += 1;
    aggregate.durationMs += Number.isFinite(event.dur) ? event.dur / 1_000 : 0;
    const data = event.args?.data ?? {};
    if (Number.isFinite(data.consumedCacheSize)) {
      consumedCacheBytes += data.consumedCacheSize;
    }
    if (Number.isFinite(data.producedCacheSize)) {
      producedCacheBytes += data.producedCacheSize;
    }
    if (data.cacheRejected === true) cacheRejections += 1;
    if (data.streamed === true) streamed += 1;
    if (typeof data.notStreamedReason === 'string') {
      notStreamedReasons[data.notStreamedReason] =
        (notStreamedReasons[data.notStreamedReason] ?? 0) + 1;
    }
    if (event.name.startsWith('v8.compile') && 'url' in data) {
      const file = scriptFileName(data.url);
      const script = scripts.get(file) ?? { file, compiles: 0, durationMs: 0 };
      script.compiles += 1;
      script.durationMs += Number.isFinite(event.dur) ? event.dur / 1_000 : 0;
      scripts.set(file, script);
    }
  }
  return {
    events: byName,
    streamedCompiles: streamed,
    notStreamedReasons,
    consumedCacheBytes,
    producedCacheBytes,
    cacheRejections,
    slowestScripts: [...scripts.values()]
      .sort((left, right) => right.durationMs - left.durationMs)
      .slice(0, 10),
  };
}

async function readJsonTraceFile(tracePath, timeoutMs) {
  const text = await waitUntil(
    () => {
      if (!existsSync(tracePath)) return false;
      const contents = readFileSync(tracePath, 'utf8');
      try {
        JSON.parse(contents);
        return contents;
      } catch {
        return false;
      }
    },
    {
      timeoutMs,
      label: `the trace file ${path.basename(tracePath)}`,
      intervalMs: 250,
    },
  );
  return JSON.parse(text);
}

/**
 * `--warm-launches`: launch a startup scenario's own profile `count` times,
 * unmeasured and untraced, waiting for the shell and opening App Advisor
 * each time, so the measured launch that follows is a repeat-state startup.
 * Chromium writes a script's code cache on its second load and reads it
 * from the third.
 */
async function primeStartupWarmLaunches(count, launchOptions) {
  for (let launch = 0; launch < count; launch += 1) {
    const { electronApp } = await launchCanopy(launchOptions);
    try {
      const page = await getMainWindow(electronApp);
      await new CanopyAppDriver(page).waitForShell({ timeout: 60_000 });
      await measureAppAdvisorOpening({ electronApp, page, traceDir: null });
    } finally {
      await closeCanopy(electronApp, launchOptions.userDataDir, {
        keepUserData: true,
      });
    }
  }
}

/**
 * J1 milestones on main's clock (ms since the process started), measured
 * after the monitored window from the E2E startup marks, renderer navigation
 * timing, the React hook's first commit, and the harness's composer and
 * shell observations.
 */
export function startupJourneyMilestones({
  launchEpochMs,
  main,
  renderer,
  composerReadyFromLaunchMs,
  shellReadyFromLaunchMs,
}) {
  const fromMain = (epochMs) =>
    Number.isFinite(epochMs) ? epochMs - main.timeOrigin : undefined;
  const navigationStart = fromMain(renderer.timeOrigin);
  const offset = (base, value) =>
    Number.isFinite(base) && Number.isFinite(value) ? base + value : undefined;
  const milestones = {
    process_start_from_launch_ms: main.timeOrigin - launchEpochMs,
    node_bootstrap_ms: main.bootstrapCompleteMs,
    main_ready_ms: main.marks?.mainReady,
    window_navigation_start_ms: navigationStart,
    dom_content_loaded_ms: offset(navigationStart, renderer.domContentLoadedMs),
    react_mount_ms: offset(navigationStart, renderer.reactFirstCommitMs),
    shell_ready_ms: fromMain(offset(launchEpochMs, shellReadyFromLaunchMs)),
    composer_ready_ms: fromMain(
      offset(launchEpochMs, composerReadyFromLaunchMs),
    ),
  };
  const between = (from, to) =>
    Number.isFinite(from) && Number.isFinite(to) ? to - from : undefined;
  const phases = {
    process_start_to_main_ready_ms: milestones.main_ready_ms,
    main_ready_to_window_navigation_ms: between(
      milestones.main_ready_ms,
      milestones.window_navigation_start_ms,
    ),
    window_navigation_to_dom_content_loaded_ms: renderer.domContentLoadedMs,
    dom_content_loaded_to_react_mount_ms: between(
      milestones.dom_content_loaded_ms,
      milestones.react_mount_ms,
    ),
    react_mount_to_composer_ms: between(
      milestones.react_mount_ms,
      milestones.composer_ready_ms,
    ),
  };
  return Object.fromEntries(
    Object.entries({ ...milestones, ...phases }).filter(([, value]) =>
      Number.isFinite(value),
    ),
  );
}

async function readStartupClocks(electronApp, page) {
  const [main, renderer] = await Promise.all([
    evaluateMainWithRetry(() =>
      electronApp.evaluate(() => ({
        timeOrigin: performance.timeOrigin,
        marks: globalThis.__CANOPY_E2E_STARTUP_MARKS__ ?? null,
        bootstrapCompleteMs: performance.nodeTiming?.bootstrapComplete ?? null,
      })),
    ),
    page.evaluate(() => {
      const [navigation] = performance.getEntriesByType('navigation');
      return {
        timeOrigin: performance.timeOrigin,
        domContentLoadedMs: navigation?.domContentLoadedEventEnd ?? null,
        reactFirstCommitMs:
          window.__CANOPY_REACT_WORK__?.snapshot().milestones
            ?.firstCommitAtMs ?? null,
      };
    }),
  ]);
  return { main, renderer };
}

/**
 * Opens the App Advisor window from the sidebar and times it from the click:
 * window created, DOMContentLoaded, React mount, workspace surface visible,
 * and bootstrap finished and painted. With `traceDir`, a Perfetto trace of
 * the opening records its V8 compile events.
 */
async function measureAppAdvisorOpening({ electronApp, page, traceDir }) {
  const tracePath = traceDir
    ? path.join(traceDir, 'app-advisor-trace.pftrace')
    : null;
  if (tracePath) {
    await electronApp.evaluate(async ({ contentTracing }, categories) => {
      await contentTracing.startRecording({
        included_categories: categories.split(','),
        recording_mode: 'record-until-full',
      });
    }, STARTUP_TRACE_CATEGORIES);
  }
  const clickEpochMs = performance.timeOrigin + performance.now();
  const startedAt = performance.now();
  const since = () => performance.now() - startedAt;
  const windowPromise = electronApp.waitForEvent('window', { timeout: 30_000 });
  await page.getByTestId('sidebar-nav-app-advisor').click();
  const advisor = await windowPromise;
  const timings = { window_created_ms: since() };
  await advisor.waitForLoadState('domcontentloaded');
  timings.dom_content_loaded_ms = since();
  await expect(
    advisor.getByTestId('app-advisor-workspace-surface'),
  ).toBeVisible({ timeout: 30_000 });
  timings.surface_visible_ms = since();
  await expect(
    advisor.getByTestId('app-advisor-workspace-loading'),
  ).toHaveCount(0, { timeout: 30_000 });
  await nextPaint(advisor);
  timings.ready_ms = since();
  const reactFirstCommit = await advisor.evaluate(() => {
    const firstCommitAtMs =
      window.__CANOPY_REACT_WORK__?.snapshot().milestones?.firstCommitAtMs;
    return Number.isFinite(firstCommitAtMs)
      ? performance.timeOrigin + firstCommitAtMs
      : null;
  });
  if (Number.isFinite(reactFirstCommit)) {
    timings.react_mount_ms = reactFirstCommit - clickEpochMs;
  }
  let v8Compile;
  if (tracePath) {
    await electronApp.evaluate(async ({ contentTracing }, destination) => {
      await contentTracing.stopRecording(destination);
    }, tracePath);
    // Electron 45+ contentTracing writes Perfetto protobuf, not JSON.
    v8Compile = summarizeV8CompileTrace(
      perfettoTraceEvents(readFileSync(tracePath)),
    );
  }
  return { timings, ...(v8Compile ? { v8Compile } : {}) };
}

/**
 * The startup journey measured after the monitored window closes, so neither
 * the App Advisor window nor the reads move the window's timings or counts.
 * A failure is recorded rather than thrown: these are additive milestones on
 * scenarios whose other results still stand.
 */
async function measureStartupJourney({
  electronApp,
  page,
  launchEpochMs,
  counters,
  shellReadyMs,
  startupTracePath,
  traceDir,
  warmLaunches = 0,
}) {
  const journey = {
    launchState: warmLaunches > 0 ? 'repeat' : 'fresh',
    ...(warmLaunches > 0 ? { warmLaunches } : {}),
    errors: [],
  };
  const timings = {};
  try {
    const clocks = await readStartupClocks(electronApp, page);
    journey.clocks = clocks;
    timings.j1 = startupJourneyMilestones({
      launchEpochMs,
      main: clocks.main,
      renderer: clocks.renderer,
      composerReadyFromLaunchMs: counters?.composerReadyFromLaunchMs,
      shellReadyFromLaunchMs: shellReadyMs,
    });
  } catch (error) {
    journey.errors.push(
      `J1: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    const appAdvisor = await measureAppAdvisorOpening({
      electronApp,
      page,
      traceDir,
    });
    timings.app_advisor = appAdvisor.timings;
    if (appAdvisor.v8Compile)
      journey.appAdvisorV8Compile = appAdvisor.v8Compile;
  } catch (error) {
    journey.errors.push(
      `App Advisor: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (startupTracePath) {
    try {
      journey.startupV8Compile = summarizeV8CompileTrace(
        await readJsonTraceFile(
          startupTracePath,
          (STARTUP_TRACE_DURATION_S + 30) * 1_000,
        ),
      );
    } catch (error) {
      journey.errors.push(
        `Startup trace: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { journey, timings };
}

/**
 * Final bytes of every file under a directory, or null when it is absent.
 * For append-only logs this approximates the bytes written to them.
 */
export function directoryFileBytes(directory) {
  if (!existsSync(directory)) return null;
  let total = 0;
  for (const entry of readdirSync(directory, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile()) continue;
    try {
      total += statSync(path.join(entry.parentPath, entry.name)).size;
    } catch {
      // A file removed while listing adds nothing.
    }
  }
  return total;
}

/**
 * P0 test-plan accuracy check, advisory: the chat-storage bytes main says it
 * wrote against the OS per-process write counter for main, and which file
 * classes dominate those writes (the field pattern is journal and index
 * bytes). `observabilityFileBytes`, the final size of the run's
 * `agent-observability/` tree, estimates main's other large appender.
 */
export function diskAccuracyCheck(work, { observabilityFileBytes } = {}) {
  const chatStorage = work?.chatStorage;
  const osMainWrittenBytes = work?.disk?.['main.writtenBytes'];
  if (!chatStorage || !Number.isFinite(osMainWrittenBytes)) {
    return {
      available: false,
      reason: !chatStorage
        ? 'chat-storage counters were not collected'
        : 'the OS disk counters were not collected',
    };
  }
  const byClass = {};
  for (const [counter, value] of Object.entries(chatStorage)) {
    const match = /^written\.(.+)\.bytes$/.exec(counter);
    if (match && Number.isFinite(value)) byClass[match[1]] = value;
  }
  const ownWriterBytes = Object.values(byClass).reduce(
    (total, value) => total + value,
    0,
  );
  const journalAndIndexBytes = [
    'journal',
    'liveIndex',
    'archiveIndex',
    'recoveryIndex',
    'transcriptIndex',
    'turnIndex',
    'messageIndex',
  ].reduce((total, name) => total + (byClass[name] ?? 0), 0);
  const deviation =
    osMainWrittenBytes === 0
      ? null
      : (osMainWrittenBytes - ownWriterBytes) / osMainWrittenBytes;
  const dominantClass =
    Object.entries(byClass).sort((left, right) => right[1] - left[1])[0]?.[0] ??
    null;
  return {
    available: true,
    advisory: true,
    ownWriterBytes,
    osMainWrittenBytes,
    ownWriterShareOfMain:
      osMainWrittenBytes === 0 ? null : ownWriterBytes / osMainWrittenBytes,
    deviation,
    withinTenPercent: deviation === null ? null : Math.abs(deviation) <= 0.1,
    writtenBytesByClass: byClass,
    journalAndIndexBytes,
    journalAndIndexShareOfOwnWriter:
      ownWriterBytes === 0 ? null : journalAndIndexBytes / ownWriterBytes,
    dominantClass,
    ...(Number.isFinite(observabilityFileBytes)
      ? {
          observabilityFileBytes,
          ownWriterAndObservabilityShareOfMain:
            osMainWrittenBytes === 0
              ? null
              : (ownWriterBytes + observabilityFileBytes) / osMainWrittenBytes,
        }
      : {}),
  };
}

/**
 * What a benchmark scenario collects besides its timings. Every benchmark
 * scenario samples the app counters, the per-process disk bytes, and frame
 * budgets through the same generic plumbing; only the hidden browser-profile
 * study keeps its exact footprint. `ipcBytes` is the one exception to the
 * generic plumbing: estimating main → renderer payload bytes serializes every
 * send a second time, so it would add main-process CPU and transient memory to
 * every timed metric. Only the counters profile, which judges counts in a
 * single run and never compares timings, pays for it.
 */
export function scenarioWorkCollection(_name, options = {}) {
  const study = Boolean(options.studyWindowMode || options.studyViewportPreset);
  return {
    appCounters: true,
    chromiumCounters: true,
    diskBytes: !study,
    frameBudgets: !study,
    ipcBytes: options.profile === WORK_RATCHET_PROFILE,
  };
}

const CLAUDE_GRAPH_ORIENTATION_MARKER = 'Canopy-CCLAUDEGRAPHORIENT';
const CLAUDE_GRAPH_ORIENTATION_CHAT_ID = 'claude-graph-orientation-chat';
const CLAUDE_GRAPH_STEERING_DENIAL = 'A code graph exists for this worktree';
const CLAUDE_GRAPH_ARTIFACT_PATH = 'test-results/claude-graph-run.log';
// Outside an artifact directory, so steering stats the literal `.log` target.
const CLAUDE_GRAPH_ARTIFACT_FILE_PATH = 'claude-graph-notes.log';
// A dot-less directory searched through a `.log` selector, so steering stats
// it to confirm the selector filters what the search reads.
const CLAUDE_GRAPH_ARTIFACT_SELECTOR_DIR = 'claude-graph-logs';

function claudeGraphTurnText(tag) {
  return `Turn ${tag} finished.`;
}

/**
 * The scripted turns, in order. Each source-search step issues the profile's
 * shell searches in one assistant message, so every call crosses the Claude
 * PreToolUse hook; graph calls cross PostToolUse. The bundled Claude CLI has
 * no Grep tool, so searches run through Bash as agents run them.
 */
export function claudeGraphOrientationTurns(config) {
  const sourceSearches = {
    toolCalls: Array.from(
      { length: config.claudeGraphOrientationSearchesPerTurn },
      (_, index) => ({
        name: 'Bash',
        input: {
          command: `grep -rl fn${index}_0 graph-fixture`,
          description: `Search the fixture for fn${index}_0`,
        },
      }),
    ),
    stopReason: 'tool_use',
  };
  const artifactSearch = {
    toolCalls: [
      {
        name: 'Bash',
        input: {
          command: `grep fn0_0 ${CLAUDE_GRAPH_ARTIFACT_PATH}`,
          description: 'Search the run log',
        },
      },
    ],
    stopReason: 'tool_use',
  };
  const artifactFileSearch = {
    toolCalls: [
      {
        name: 'Bash',
        input: {
          command: `grep fn0_0 ${CLAUDE_GRAPH_ARTIFACT_FILE_PATH}`,
          description: 'Search the notes log',
        },
      },
    ],
    stopReason: 'tool_use',
  };
  const artifactSelectorSearch = {
    toolCalls: [
      {
        name: 'Bash',
        input: {
          command: `grep -r --include='*.log' fn0_0 ${CLAUDE_GRAPH_ARTIFACT_SELECTOR_DIR}`,
          description: 'Search the log directory',
        },
      },
    ],
    stopReason: 'tool_use',
  };
  const graphContext = {
    toolCalls: [{ name: 'mcp__canopy__GetCodeGraphContext', input: {} }],
    stopReason: 'tool_use',
  };
  const turn = (tag, task, steps, before) => ({
    tag,
    task,
    before,
    steps: [
      ...steps,
      { text: claudeGraphTurnText(tag), stopReason: 'end_turn' },
    ],
  });
  return [
    // Unmeasured: a new worktree's first message triggers the automatic
    // branch rename, which moves HEAD's ref and would end the orientation.
    turn('settle', 'settle_branch_turn', []),
    turn('fresh', 'fresh_source_search_turn', [sourceSearches]),
    turn('artifact', 'artifact_search_turn', [artifactSearch]),
    turn('artifact-file', 'artifact_file_search_turn', [artifactFileSearch]),
    turn('artifact-selector', 'artifact_selector_search_turn', [
      artifactSelectorSearch,
    ]),
    turn('orient', 'orient_turn', [graphContext, sourceSearches]),
    ...Array.from(
      { length: config.claudeGraphOrientationLaterTurns },
      (_, index) =>
        turn(`later-${index + 1}`, 'later_turn_source_searches', [
          sourceSearches,
        ]),
    ),
    turn(
      'non-build-write',
      'changed_graph_same_build_turn',
      [sourceSearches],
      'non-build-write',
    ),
    turn('rebuilt', 'rebuilt_graph_search_turn', [sourceSearches], 'rebuild'),
    turn('reorient', 'reorient_turn', [graphContext, sourceSearches]),
    turn('after-reorient', 'after_reorient_turn', [sourceSearches]),
  ];
}

async function prepareClaudeGraphOrientation(userDataDir, config, options) {
  const seed = seedWorkspace(userDataDir);
  const worktreePath = seed.workspaces[0]?.worktreePath;
  if (!worktreePath) {
    throw new Error('Claude graph orientation fixture has no default worktree');
  }
  commitGraphFixtureAt(
    worktreePath,
    config.claudeGraphOrientationFixtureFiles,
    'Add the Claude graph orientation fixture',
  );
  const artifactPath = path.join(worktreePath, CLAUDE_GRAPH_ARTIFACT_PATH);
  mkdirSync(path.dirname(artifactPath), { recursive: true });
  writeFileSync(artifactPath, 'perf run log fn0_0\n', 'utf8');
  writeFileSync(
    path.join(worktreePath, CLAUDE_GRAPH_ARTIFACT_FILE_PATH),
    'perf notes log fn0_0\n',
    'utf8',
  );
  const selectorDir = path.join(
    worktreePath,
    CLAUDE_GRAPH_ARTIFACT_SELECTOR_DIR,
  );
  mkdirSync(selectorDir, { recursive: true });
  writeFileSync(
    path.join(selectorDir, 'selector-run.log'),
    'perf selector log fn0_0\n',
    'utf8',
  );
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [
      {
        id: CLAUDE_GRAPH_ORIENTATION_CHAT_ID,
        title: 'Claude Graph Orientation',
        // Steering denies by policy; it must not wait on an approval prompt.
        approvalMode: 'full-access',
        // A production bundle resolves an unpinned tab through its default
        // model lanes (an AI Credits Codex model here); pin native Claude so
        // the run measures the Claude hooks.
        ...(options?.releaseLike === true
          ? {
              model: 'opus[1m]',
              modelExplicitlyChosen: true,
              billingExplicitlyChosen: true,
              subscriptionBillingOverride: true,
            }
          : {}),
      },
    ],
  });
  const turns = claudeGraphOrientationTurns(config);
  await registerScenario(
    PERFORMANCE_MOCK_BASE_URL,
    CLAUDE_GRAPH_ORIENTATION_MARKER,
    {
      llm: {
        steps: [{ text: 'Unscripted turn finished.', stopReason: 'end_turn' }],
        stepsByRequestTag: Object.fromEntries(
          turns.map((entry) => [entry.tag, entry.steps]),
        ),
      },
    },
  );
  const workspaceDir = path.join(userDataDir, 'workspaces', WORKSPACE_ID);
  return {
    releaseLike: options?.releaseLike === true,
    userDataDir,
    worktreePath,
    initialHeadRef: readWorktreeHeadRef(worktreePath),
    dbPath: codeGraphDbPath(workspaceDir, WORKTREE_ID),
    turns,
  };
}

function claudeGraphFileIdentity(dbPath) {
  const describe = (filePath) => {
    if (!existsSync(filePath)) return 'absent';
    const stats = statSync(filePath, { bigint: true });
    return `${stats.dev}:${stats.ino}:${stats.mtimeNs}:${stats.size}`;
  };
  return `${describe(dbPath)}/${describe(`${dbPath}-wal`)}`;
}

/**
 * The non-build write is a valid fixture only when it changed graph.db or its
 * WAL, which triggers the changed-graph probe, and left `last_build_at` equal.
 */
export function assertNonBuildGraphWrite({ before, after, rowsChanged }) {
  if (rowsChanged < 1) {
    throw new Error('The non-build graph write changed no metadata row');
  }
  if (before.identity === after.identity) {
    throw new Error(
      'The non-build graph write left graph.db and its WAL unchanged',
    );
  }
  if (
    !Number.isFinite(before.lastBuildAt) ||
    before.lastBuildAt !== after.lastBuildAt
  ) {
    throw new Error(
      `The non-build graph write changed last_build_at (${before.lastBuildAt} -> ${after.lastBuildAt})`,
    );
  }
}

/**
 * A write that changes graph.db and its WAL without a build, as deferred
 * derived analysis or a checkpoint does; `last_build_at` is unchanged.
 */
export function writeClaudeGraphNonBuildChange(dbPath) {
  const observe = () => ({
    identity: claudeGraphFileIdentity(dbPath),
    lastBuildAt: readCodeGraphBuildMetadata(dbPath).lastBuildAt,
  });
  const before = observe();
  const database = new DatabaseSync(dbPath);
  let rowsChanged = 0;
  try {
    database.exec('PRAGMA busy_timeout = 10000');
    // SQLite skips rewriting identical cell content, so the value must change.
    rowsChanged = Number(
      database
        .prepare(
          "INSERT OR REPLACE INTO graph_metadata (key, value) VALUES ('perf_non_build_write', ?)",
        )
        .run(`${Date.now()}:${process.hrtime.bigint()}`).changes,
    );
    database.exec('PRAGMA wal_checkpoint(PASSIVE)');
  } finally {
    database.close();
  }
  const write = { before, after: observe(), rowsChanged };
  assertNonBuildGraphWrite(write);
  return write;
}

function scriptedSearchCount(entry) {
  return entry.steps.reduce(
    (count, step) =>
      count +
      (step.toolCalls ?? []).filter((call) => call.name === 'Bash').length,
    0,
  );
}

/**
 * Every scripted turn must record exactly its scripted searches: a missing,
 * partial or duplicated result makes the sample invalid, whatever the
 * allow/deny outcome.
 */
export function claudeGraphSearchResultCountErrors(turns, outcomes) {
  const errors = [];
  const scripted = new Set(turns.map((entry) => entry.tag));
  for (const entry of turns) {
    const outcome = outcomes[entry.tag];
    const observed =
      (outcome?.allowed ?? 0) + (outcome?.denied ?? 0) + (outcome?.failed ?? 0);
    const expected = scriptedSearchCount(entry);
    if (observed !== expected) {
      errors.push(`${entry.tag}: ${observed} of ${expected}`);
    }
  }
  for (const tag of Object.keys(outcomes)) {
    if (!scripted.has(tag)) errors.push(`${tag}: unscripted turn`);
  }
  return errors;
}

/**
 * Expected Grep outcomes for a build with chat-scoped orientation. Kept out
 * of the run itself: a baseline without it denies later turns by design.
 */
export function claudeGraphOrientationViolations(turns, outcomes) {
  const expectedKind = (tag) =>
    tag === 'fresh' || tag === 'rebuilt' ? 'denied' : 'allowed';
  const violations = [];
  for (const entry of turns) {
    const searches = scriptedSearchCount(entry);
    const outcome = outcomes[entry.tag] ?? { allowed: 0, denied: 0, failed: 0 };
    const kind = expectedKind(entry.tag);
    if (outcome[kind] !== searches || outcome.failed !== 0) {
      violations.push(
        `${entry.tag}: expected ${searches} ${kind}, got ${JSON.stringify(outcome)}`,
      );
    }
  }
  return violations;
}

/**
 * Production rejects the E2E-only performance scheduler IPC, so release-like
 * runs build through the manual Code Graph build IPC the UI uses.
 */
async function buildClaudeGraphThroughManualIpc(page, fixture) {
  const result = await page.evaluate(
    ({ workspaceId, worktreeId }) =>
      window.api.codeGraphBuildWorktree({ workspaceId, worktreeId }),
    { workspaceId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
  );
  if (result?.ok === false || result?.error) {
    throw new Error(
      `Manual Code Graph build failed: ${JSON.stringify(result)}`,
    );
  }
  const lastBuildAt = readCodeGraphBuildMetadata(fixture.dbPath).lastBuildAt;
  if (!Number.isFinite(lastBuildAt)) {
    throw new Error(
      `Manual Code Graph build left no build stamp: ${JSON.stringify(result)}`,
    );
  }
  return { lastBuildAt };
}

async function rebuildClaudeGraphFixture(page, fixture) {
  const before = readCodeGraphBuildMetadata(fixture.dbPath).lastBuildAt;
  applyCodeGraphFixtureEdit(fixture.worktreePath, 1, 1);
  if (fixture.releaseLike) {
    await buildClaudeGraphThroughManualIpc(page, fixture);
    const after = readCodeGraphBuildMetadata(fixture.dbPath).lastBuildAt;
    if (!Number.isFinite(after) || after === before) {
      throw new Error(
        `The manual rebuild did not change last_build_at (${before} -> ${after})`,
      );
    }
    return { lastBuildAtBefore: before, lastBuildAtAfter: after };
  }
  await startScheduledCodeGraphBuilds(
    page,
    [WORKTREE_ID],
    '__CANOPY_PERF_CLAUDE_GRAPH_REBUILD__',
  );
  const after = await waitUntil(
    async () => {
      const builds = await readScheduledCodeGraphBuilds(
        page,
        '__CANOPY_PERF_CLAUDE_GRAPH_REBUILD__',
      );
      const after = readCodeGraphBuildMetadata(fixture.dbPath).lastBuildAt;
      return builds?.completed === 1 &&
        Number.isFinite(after) &&
        after !== before
        ? after
        : false;
    },
    {
      timeoutMs: 10 * 60_000,
      label: 'the Claude graph orientation rebuild',
      intervalMs: 100,
    },
  );
  return { lastBuildAtBefore: before, lastBuildAtAfter: after };
}

async function readClaudeGraphTranscript(page) {
  const data = await page.evaluate(
    async ({ projectId, worktreeId }) =>
      window.api.chat.loadTabs({ projectId, worktreeId }),
    { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
  );
  const messages =
    data.tabs.find((tab) => tab.id === CLAUDE_GRAPH_ORIENTATION_CHAT_ID)
      ?.messages ?? [];
  // Raw evidence: every block's kind and tool, with a short excerpt.
  const transcript = messages.map((message) => ({
    role: message.role,
    blocks: (message.blocks ?? []).map((block) => ({
      type: block.type,
      ...(block.toolName ? { toolName: block.toolName } : {}),
      ...(block.isError !== undefined ? { isError: block.isError } : {}),
      excerpt: String(block.text ?? block.output ?? block.input ?? '').slice(
        0,
        120,
      ),
    })),
  }));
  return { messages, transcript };
}

async function describeClaudeGraphTurnFailure(page) {
  const [{ transcript }, activity, activeTurns] = await Promise.all([
    readClaudeGraphTranscript(page).catch((error) => ({
      transcript: String(error),
    })),
    getScenarioActivity(
      PERFORMANCE_MOCK_BASE_URL,
      CLAUDE_GRAPH_ORIENTATION_MARKER,
    ).catch((error) => String(error)),
    activeTurnCount(page).catch((error) => String(error)),
  ]);
  return JSON.stringify({ activeTurns, activity, transcript }).slice(0, 8_000);
}

function readWorktreeHeadRef(worktreePath) {
  return gitOutput(['symbolic-ref', '-q', 'HEAD'], worktreePath);
}

/**
 * Waits for the automatic first-message branch rename so it lands before the
 * measured turns; a build without the rename continues after the timeout.
 */
async function waitForClaudeGraphBranchRename(fixture) {
  const before = fixture.initialHeadRef;
  const after = await waitUntil(
    () => {
      const current = readWorktreeHeadRef(fixture.worktreePath);
      return current !== before ? current : false;
    },
    {
      timeoutMs: 20_000,
      label: 'the first-message branch rename',
      intervalMs: 100,
    },
  ).catch(() => readWorktreeHeadRef(fixture.worktreePath));
  return { before, after };
}

async function runClaudeGraphOrientationTurn(page, panel, entry) {
  const userMessage = `[${CLAUDE_GRAPH_ORIENTATION_MARKER}] [Canopy-Mock-Request:${entry.tag}] Run Claude graph orientation turn ${entry.tag}.`;
  const composer = panel
    .locator('[data-chat-composer-root]')
    .getByRole('textbox')
    .first();
  await composer.fill(userMessage);
  await panel.getByRole('button', { name: 'Send message' }).click();
  await expect(panel.getByText(userMessage).first()).toBeVisible({
    timeout: 30_000,
  });
  try {
    await waitUntil(
      async () =>
        (await persistedAssistantReplyCount(
          page,
          claudeGraphTurnText(entry.tag),
        )) > 0 && (await activeTurnCount(page)) === 0,
      {
        timeoutMs: 180_000,
        label: `Claude graph orientation turn ${entry.tag}`,
        intervalMs: 25,
      },
    );
  } catch (error) {
    throw new Error(
      `${String(error)}; state: ${await describeClaudeGraphTurnFailure(page)}`,
    );
  }
}

/**
 * Search outcomes per scripted turn from the persisted transcript: allowed,
 * denied by graph-first steering, or failed for another reason. Results are
 * paired with their Bash calls by tool-use id.
 */
export function classifyClaudeGraphSearchOutcomes(messages) {
  // Mock tool-use ids repeat across turns, so pair in transcript order. A
  // repeated result for the same call is counted, so duplicates surface.
  const toolNameById = new Map();
  const outcomes = {};
  let tag = null;
  for (const message of messages) {
    const requested = /\[Canopy-Mock-Request:([^\]\\]+)\]/.exec(
      JSON.stringify(message),
    );
    if (message.role === 'user' && requested) tag = requested[1];
    for (const block of message.blocks ?? []) {
      if (block.type === 'tool_use') {
        toolNameById.set(block.toolUseId, block.toolName);
        continue;
      }
      if (
        tag === null ||
        block.type !== 'tool_result' ||
        toolNameById.get(block.toolUseId) !== 'Bash'
      ) {
        continue;
      }
      const outcome = (outcomes[tag] ??= { allowed: 0, denied: 0, failed: 0 });
      if (!block.isError) outcome.allowed += 1;
      else if (
        String(block.output ?? '').includes(CLAUDE_GRAPH_STEERING_DENIAL)
      )
        outcome.denied += 1;
      else outcome.failed += 1;
    }
  }
  return outcomes;
}

/**
 * Mock requests attributed to the measured chat, per turn, and helper
 * requests that carried the chat's marker, counted apart.
 */
async function claudeGraphMockActivity() {
  const { activity = {} } = await getScenarioActivity(
    PERFORMANCE_MOCK_BASE_URL,
    CLAUDE_GRAPH_ORIENTATION_MARKER,
  );
  const chatRequestsByTurn = {};
  const helperRequests = {};
  for (const [field, count] of Object.entries(activity)) {
    const turn = /^llmRequests:(.+)$/.exec(field)?.[1];
    if (turn) chatRequestsByTurn[turn] = count;
    const helper = /^helperRequests:(.+)$/.exec(field)?.[1];
    if (helper) helperRequests[helper] = count;
  }
  return { chatRequestsByTurn, helperRequests };
}

/**
 * Every scripted step is one chat request; a missing or extra request means
 * the measured chat did not run the script alone.
 */
export function claudeGraphChatRequestErrors(turns, chatRequestsByTurn) {
  const errors = [];
  const scripted = new Set(turns.map((entry) => entry.tag));
  for (const entry of turns) {
    const observed = chatRequestsByTurn[entry.tag] ?? 0;
    if (observed !== entry.steps.length) {
      errors.push(`${entry.tag}: ${observed} of ${entry.steps.length}`);
    }
  }
  for (const tag of Object.keys(chatRequestsByTurn)) {
    if (!scripted.has(tag)) errors.push(`${tag}: unscripted turn`);
  }
  return errors;
}

/** A release-like sample must name exactly one loaded main entry. */
export function assertClaudeGraphMainEntry(mainEntryModules) {
  const entries = Array.isArray(mainEntryModules) ? mainEntryModules : [];
  if (
    entries.length !== 1 ||
    (entries[0] !== 'index.jsc' && entries[0] !== '_index.js')
  ) {
    throw new Error(
      `Release-like run could not identify the loaded main entry: ${JSON.stringify(mainEntryModules)}`,
    );
  }
}

async function runClaudeGraphOrientation({
  page,
  app,
  electronApp,
  tasks,
  fixture,
}) {
  // Release-like runs record whether Electron loaded the bytecode main entry
  // or fell back to `_index.js`.
  const mainEntryModules = fixture.releaseLike
    ? await electronApp
        .evaluate(() =>
          Object.keys(process.mainModule?.constructor?._cache ?? {})
            .filter((file) =>
              /[\\/]out[\\/]main[\\/](index\.jsc|_index\.js)$/.test(file),
            )
            .map((file) => file.split(/[\\/]out[\\/]main[\\/]/).at(-1)),
        )
        .catch((error) => [`unavailable: ${String(error)}`])
    : null;
  if (fixture.releaseLike) assertClaudeGraphMainEntry(mainEntryModules);
  await openMainPage(page);
  await app.selectWorktree(WORKTREE_BRANCH, NO_ACTIVITY_RAIL);
  await recordTask(tasks, 'build_initial_code_graph', () =>
    fixture.releaseLike
      ? buildClaudeGraphThroughManualIpc(page, fixture)
      : ensureCodeGraphsReady(page, [WORKTREE_ID], 10 * 60_000),
  );
  const panel = visibleChatPanel(page);
  await expect(panel).toBeVisible({ timeout: 30_000 });
  let nonBuildWrite = null;
  let rebuild = null;
  let branchRename = null;
  for (const entry of fixture.turns) {
    if (entry.tag === 'fresh') {
      branchRename = await waitForClaudeGraphBranchRename(fixture);
    }
    if (entry.before === 'non-build-write') {
      nonBuildWrite = writeClaudeGraphNonBuildChange(fixture.dbPath);
    } else if (entry.before === 'rebuild') {
      rebuild = await recordTask(tasks, 'rebuild_graph_between_turns', () =>
        rebuildClaudeGraphFixture(page, fixture),
      );
    }
    await recordTask(
      tasks,
      entry.task,
      () => runClaudeGraphOrientationTurn(page, panel, entry),
      { turn: entry.tag },
    );
  }
  const { messages, transcript } = await readClaudeGraphTranscript(page);
  const outcomes = classifyClaudeGraphSearchOutcomes(messages);
  const countErrors = claudeGraphSearchResultCountErrors(
    fixture.turns,
    outcomes,
  );
  if (countErrors.length > 0) {
    throw new Error(
      `Claude graph orientation recorded unexpected search result counts (${countErrors.join('; ')}); transcript: ${JSON.stringify(transcript).slice(0, 6_000)}`,
    );
  }
  const mockActivity = await claudeGraphMockActivity();
  const requestErrors = claudeGraphChatRequestErrors(
    fixture.turns,
    mockActivity.chatRequestsByTurn,
  );
  if (requestErrors.length > 0) {
    throw new Error(
      `Claude graph orientation chat requests did not match the script (${requestErrors.join('; ')}); activity: ${JSON.stringify(mockActivity)}`,
    );
  }
  // Allow/deny outcomes are evidence, not assertions: the develop baseline
  // gates every later turn by design.
  tasks.extraWork.claudeGraphOrientation = Object.fromEntries(
    Object.entries(outcomes).flatMap(([tag, outcome]) =>
      Object.entries(outcome).map(([kind, count]) => [`${tag}.${kind}`, count]),
    ),
  );
  return {
    mainEntryModules,
    mockActivity,
    outcomes,
    transcript,
    orientationViolations: claudeGraphOrientationViolations(
      fixture.turns,
      outcomes,
    ),
    branchRename,
    nonBuildWrite,
    rebuild,
  };
}

const W5_STORE = w5StoreScenarios({
  FatalWaitError,
  readWorktreeSetupStatus,
  recordTask,
  seedWorkspace,
  sidebarWorktreeRow,
  startupJourneyMilestones,
  waitUntil,
});

const SCENARIOS = {
  'sidebar-reorder': { prepare: prepareSidebarReorder, run: runSidebarReorder },
  'projects-retention': {
    prepare: prepareProjectsRetention,
    beforeCapture: measureProjectsRetention,
    run: runProjectsRetention,
  },
  'startup-settle': {
    prepare: prepareStartupSettle,
    run: runStartupSettle,
    monitorFromDomContentLoaded: true,
    startupJourney: true,
    measureQuit: true,
  },
  'startup-realistic': {
    prepare: prepareRealisticStartup,
    run: runRealisticStartup,
    monitorFromDomContentLoaded: true,
    startupJourney: true,
  },
  'power-user-idle': {
    prepare: preparePowerUserIdle,
    run: runPowerUserIdle,
    monitorFromDomContentLoaded: true,
  },
  'power-user-active': {
    prepare: preparePowerUserActive,
    run: runPowerUserActive,
    monitorFromDomContentLoaded: true,
  },
  'loaded-ui': { prepare: prepareLoadedUi, run: runLoadedUi },
  'pipeline-history': {
    prepare: preparePipelineHistory,
    run: runPipelineHistory,
  },
  'stress-transcript': {
    prepare: prepareStressTranscript,
    run: runStressTranscript,
  },
  'transcript-streaming-tail': {
    prepare: prepareTranscriptStreaming,
    run: runTranscriptStreamingTail,
  },
  'transcript-streaming-history': {
    prepare: prepareTranscriptStreaming,
    run: runTranscriptStreamingHistory,
  },
  'transcript-active-turn': {
    prepare: prepareTranscriptActiveTurn,
    run: runTranscriptActiveTurn,
  },
  'transcript-active-turn-stop': {
    prepare: prepareTranscriptActiveTurnStop,
    run: runTranscriptActiveTurnStop,
  },
  'transcript-active-turn-tools': {
    prepare: prepareTranscriptToolActiveTurn,
    run: runTranscriptToolActiveTurn,
  },
  'transcript-retention-cycle': {
    prepare: prepareStressTranscript,
    run: runTranscriptRetentionCycle,
  },
  'large-transcripts': {
    prepare: prepareLargeTranscripts,
    run: runLargeTranscripts,
  },
  'home-cowork-legacy': {
    prepare: prepareHomeCoworkLegacy,
    run: runHomeCoworkLegacy,
    monitorFromDomContentLoaded: true,
  },
  'cowork-default-50': {
    prepare: (userDataDir, config) =>
      prepareDefaultCoworkWorkspace(userDataDir, config, 50),
    run: runDefaultCoworkWorkspace,
  },
  'cowork-default-100': {
    prepare: (userDataDir, config) =>
      prepareDefaultCoworkWorkspace(userDataDir, config, 100),
    run: runDefaultCoworkWorkspace,
  },
  'cowork-default-500': {
    prepare: (userDataDir, config) =>
      prepareDefaultCoworkWorkspace(userDataDir, config, 500),
    run: runDefaultCoworkWorkspace,
  },
  'math-transcripts': {
    prepare: prepareMathTranscripts,
    run: runMathTranscripts,
  },
  'linear-reference-transcripts': {
    prepare: prepareLinearReferenceTranscripts,
    run: runLinearReferenceTranscripts,
  },
  'chat-search-indexing': {
    prepare: prepareChatSearchIndexing,
    run: runChatSearchIndexing,
  },
  'frame-smoothness': {
    prepare: prepareFrameSmoothness,
    run: runFrameSmoothness,
  },
  'plugin-picker': {
    prepare: preparePluginPicker,
    run: runPluginPicker,
  },
  'menu-surfaces': {
    prepare: prepareMenuSurfaces,
    run: runMenuSurfaces,
  },
  'file-explorer': {
    prepare: prepareFileExplorer,
    run: runFileExplorer,
  },
  'browser-panels': {
    prepare: prepareBrowserPanels,
    run: runBrowserPanels,
  },
  'browser-actions': {
    prepare: prepareBrowserActions,
    beforeCapture: setupBrowserActions,
    run: runBrowserActions,
    cleanup: cleanupBrowserActions,
  },
  'browser-agent-actions': {
    prepare: prepareBrowserAgentActions,
    beforeCapture: setupBrowserAgentActions,
    run: runBrowserAgentActions,
    cleanup: cleanupBrowserAgentActions,
  },
  'archive-responsiveness': {
    prepare: prepareArchiveResponsiveness,
    run: runArchiveResponsiveness,
  },
  'inner-panels-collapse': {
    prepare: prepareInnerPanelCollapse,
    run: runInnerPanelCollapse,
  },
  'plan-open': {
    prepare: preparePlanOpen,
    run: runPlanOpen,
  },
  chats: { prepare: prepareChats, run: runChats },
  'mixed-provider-agent-concurrency': {
    prepare: prepareMixedProviderAgentConcurrency,
    run: runMixedProviderAgentConcurrency,
  },
  'managed-delegation-concurrency': {
    prepare: prepareManagedDelegationConcurrency,
    run: runManagedDelegationConcurrency,
  },
  'delegation-restart-cycles': {
    prepare: prepareDelegationRestartCycles,
    run: runDelegationRestartCycles,
  },
  'multi-chat-streaming': {
    prepare: (userDataDir, config) =>
      prepareMultiChatStreaming(userDataDir, config, { sequential: false }),
    run: runMultiChatStreaming,
    launchEnv: (fixture) => fixture.launchEnv,
    diskAccuracy: true,
  },
  'background-streaming': {
    prepare: (userDataDir, config) =>
      prepareMultiChatStreaming(userDataDir, config, { sequential: false }),
    run: runBackgroundStreaming,
    launchEnv: (fixture) => fixture.launchEnv,
    diskAccuracy: true,
  },
  'chat-switch-catch-up': {
    prepare: (userDataDir, config) =>
      prepareMultiChatStreaming(userDataDir, config, { sequential: true }),
    run: runChatSwitchCatchUp,
    launchEnv: (fixture) => fixture.launchEnv,
    diskAccuracy: true,
  },
  'multi-chat-streaming-sequential': {
    prepare: (userDataDir, config) =>
      prepareMultiChatStreaming(userDataDir, config, { sequential: true }),
    run: runMultiChatStreamingSequential,
    launchEnv: (fixture) => fixture.launchEnv,
    diskAccuracy: true,
  },
  pipelines: { prepare: preparePipelines, run: runPipelines },
  scripts: { prepare: prepareScripts, run: runScripts },
  worktrees: { prepare: prepareWorktrees, run: runWorktrees },
  'worktree-concurrency': {
    prepare: prepareWorktreeConcurrency,
    run: runWorktreeConcurrency,
  },
  'large-transcript-concurrency': {
    prepare: prepareLargeTranscriptConcurrency,
    run: runLargeTranscriptConcurrency,
  },
  'code-graph-concurrency': {
    prepare: prepareCodeGraphConcurrency,
    run: runCodeGraphConcurrency,
  },
  'code-graph-background-concurrency': {
    prepare: prepareCodeGraphConcurrency,
    run: runCodeGraphBackgroundConcurrency,
  },
  'ledger-panel': {
    prepare: prepareLedgerPanel,
    run: runLedgerPanel,
  },
  'ledger-feed-overview': {
    prepare: prepareLedgerFeedOverview,
    run: runLedgerFeedOverview,
  },
  'ledger-disabled-idle': {
    prepare: prepareLedgerDisabledIdle,
    run: runLedgerDisabledIdle,
  },
  'code-graph-new-worktree': {
    prepare: prepareCodeGraphNewWorktree,
    run: runCodeGraphNewWorktree,
    launchEnv: () => ({ CANOPY_PERFORMANCE_CODE_GRAPH_SCHEDULER: '1' }),
  },
  'code-graph-small-edit': {
    prepare: prepareCodeGraphSmallEdit,
    run: runCodeGraphSmallEdit,
    launchEnv: () => ({ CANOPY_PERFORMANCE_CODE_GRAPH_SCHEDULER: '1' }),
  },
  'cost-index-first-build': {
    prepare: prepareCostIndexFirstBuild,
    run: runCostIndexFirstBuild,
  },
  'claude-graph-orientation': {
    prepare: prepareClaudeGraphOrientation,
    run: runClaudeGraphOrientation,
    launchEnv: (fixture) => ({
      CANOPY_PERFORMANCE_CODE_GRAPH_SCHEDULER: '1',
      ...(fixture.releaseLike
        ? {
            ANTHROPIC_BASE_URL: PERFORMANCE_MOCK_BASE_URL,
            ANTHROPIC_API_KEY: 'mock',
            CLAUDE_CONFIG_DIR: path.join(fixture.userDataDir, 'claude-config'),
          }
        : {}),
    }),
  },
  'skill-suggestions-backfill': {
    prepare: prepareSkillSuggestionsBackfill,
    run: runSkillSuggestionsBackfill,
  },
  'lab-transcript-onscreen': {
    prepare: prepareLabTranscript,
    run: (context) =>
      runLabTranscriptScenario({ ...context, variant: 'onscreen' }),
    afterMeasurement: captureLabTranscriptDiagnostics,
    launchEnv: (fixture) =>
      labTranscriptLaunchEnvironment(fixture.streamFixtureSpecPath),
    headlessOnly: true,
  },
  'lab-transcript-offscreen': {
    prepare: prepareLabTranscript,
    run: (context) =>
      runLabTranscriptScenario({ ...context, variant: 'offscreen' }),
    afterMeasurement: captureLabTranscriptDiagnostics,
    launchEnv: (fixture) =>
      labTranscriptLaunchEnvironment(fixture.streamFixtureSpecPath),
    headlessOnly: true,
  },
  'lab-transcript-checkpoint': {
    prepare: prepareLabTranscriptCheckpoint,
    run: runLabTranscriptCheckpointScenario,
    launchEnv: (fixture) =>
      labTranscriptLaunchEnvironment(fixture.streamFixtureSpecPath),
    headlessOnly: true,
  },
  'many-chat-residency': {
    prepare: prepareManyChatResidency,
    run: runManyChatResidency,
    afterMeasurement: captureLabTranscriptDiagnostics,
    headlessOnly: true,
  },
  'projects-reload-retention': {
    prepare: prepareProjectsReloadRetention,
    beforeCapture: setupProjectsReloadRetention,
    run: runProjectsReloadRetention,
    afterCapture: checkProjectsReloadRetention,
  },
  'scope-residency': {
    prepare: prepareScopeResidency,
    run: runScopeResidency,
    launchEnv: () => ({
      CANOPY_E2E_SCOPE_IDLE_UNLOAD_MS: String(SCOPE_RESIDENCY_IDLE_UNLOAD_MS),
    }),
    headlessOnly: true,
  },
  'many-worktree-file-index': {
    prepare: prepareManyWorktreeFileIndex,
    run: runManyWorktreeFileIndex,
    afterMeasurement: captureLabTranscriptDiagnostics,
    headlessOnly: true,
  },
  'code-review-registry-cleanup': {
    prepare: prepareCodeReviewRegistry,
    run: (context) => runCodeReviewRegistryCleanup(context, { trace: false }),
  },
  'code-review-registry-cleanup-trace': {
    prepare: prepareCodeReviewRegistry,
    run: (context) => runCodeReviewRegistryCleanup(context, { trace: true }),
  },
  // CAN-5532 W5 store arms; run them with `--w5-store` or `--w5-store-arms`.
  'w5-store-startup': {
    prepare: W5_STORE.prepare,
    run: W5_STORE.runStartup,
    monitorFromDomContentLoaded: true,
  },
  // Renderer reloads would end the monitor's renderer sampling, so they run
  // and are timed before the measured window, which holds the IPC reloads.
  'w5-store-reload': {
    prepare: W5_STORE.prepare,
    beforeCapture: W5_STORE.reloadSidebar,
    run: W5_STORE.runReload,
  },
  'w5-store-writes': {
    prepare: W5_STORE.prepare,
    run: W5_STORE.runWrites,
  },
};

export function scenarioHasAfterMeasurement(name) {
  return typeof SCENARIOS[name]?.afterMeasurement === 'function';
}

const RELEASE_LIKE_E2E_PROVIDER_SCENARIOS = new Set([
  'frame-smoothness',
  'transcript-streaming-tail',
  'transcript-streaming-history',
  'transcript-active-turn',
  'transcript-active-turn-stop',
  'transcript-active-turn-tools',
  'multi-chat-streaming',
  'multi-chat-streaming-sequential',
  'background-streaming',
  'chat-switch-catch-up',
  'managed-delegation-concurrency',
  'delegation-restart-cycles',
  'lab-transcript-onscreen',
  'lab-transcript-offscreen',
  'lab-transcript-checkpoint',
  'many-chat-residency',
  'worktree-concurrency',
]);

// Production builds have no E2E chat-event ingress to commit seeded events.
const RELEASE_LIKE_E2E_INGRESS_SCENARIOS = new Set(['chat-search-indexing']);

// The production build never enables the Code Graph performance scheduler.
const RELEASE_LIKE_E2E_SCHEDULER_SCENARIOS = new Set([
  'code-graph-new-worktree',
  'code-graph-small-edit',
]);

// The Ledger-off switch, the storage-worker probe, the skill suggestion
// backfill seam, and the W5 store arms, marks and counters query exist only
// in E2E builds.
const RELEASE_LIKE_E2E_HOOK_SCENARIOS = new Set([
  'ledger-disabled-idle',
  'skill-suggestions-backfill',
  'scope-residency',
  'projects-reload-retention',
  'w5-store-startup',
  'w5-store-reload',
  'w5-store-writes',
]);

export function assertReleaseLikeScenarioSupported(name, releaseLike) {
  if (!releaseLike) return;
  if (RELEASE_LIKE_E2E_PROVIDER_SCENARIOS.has(name)) {
    throw new Error(
      `Performance scenario ${name} cannot run in release-like mode because it requires E2E-only provider mocks`,
    );
  }
  if (RELEASE_LIKE_E2E_HOOK_SCENARIOS.has(name)) {
    throw new Error(
      `Performance scenario ${name} cannot run in release-like mode because it needs E2E-only hooks`,
    );
  }
  if (RELEASE_LIKE_E2E_INGRESS_SCENARIOS.has(name)) {
    throw new Error(
      `Performance scenario ${name} cannot run in release-like mode because it requires the E2E-only chat-event ingress`,
    );
  }
  if (RELEASE_LIKE_E2E_SCHEDULER_SCENARIOS.has(name)) {
    throw new Error(
      `Performance scenario ${name} cannot run in release-like mode because it requires the E2E-only Code Graph performance scheduler`,
    );
  }
}

/**
 * A hidden native window on Windows draws about once a second, which pins
 * frame and key-to-paint timings near 1 s and 2 s. Hidden Windows runs render
 * offscreen, as hidden Linux automation always does. Headed runs and the
 * native-window studies keep their native window.
 */
export function performanceWindowEnv(options, platform = process.platform) {
  return platform === 'win32' &&
    options.showWindow === false &&
    !options.studyWindowMode &&
    !options.studyViewportPreset
    ? { CANOPY_E2E_OFFSCREEN_WINDOW: '1' }
    : {};
}

export function performanceElectronArgs(
  releaseLike,
  userDataDir,
  diagnosticArgs = [],
) {
  // Production takes its single-instance lock before ready. CANOPY_DATA_DIR
  // isolates app metadata, but cannot redirect Chromium storage or that lock.
  return [
    ...(releaseLike ? [`--user-data-dir=${userDataDir}`] : []),
    ...diagnosticArgs,
  ];
}

export function assertReleaseLikeRootSupported(releaseLike, releaseLikeRoot) {
  if (releaseLike || !releaseLikeRoot) return;
  throw new Error('A release-like root requires release-like mode');
}

export function assertE2eRootSupported(releaseLike, e2eRoot) {
  if (!releaseLike || !e2eRoot) return;
  throw new Error('An E2E root cannot be used in release-like mode');
}

/**
 * The checkout whose bundle a scenario launches, as `launchCanopy`'s
 * `rootPath`: the release-like root for production bundles, the E2E root
 * otherwise. Either way the launched app runs in that checkout, with that
 * checkout as its working directory. Undefined selects this checkout.
 */
export function measuredBuildRootOption(options) {
  return (
    (options.releaseLike ? options.releaseLikeRoot : options.e2eRoot) ||
    undefined
  );
}

/**
 * Where scenario data roots are created. macOS caps the local daemon's socket
 * path at 103 bytes, and its per-user temp directory leaves too little room
 * for a data root: the daemon host can't be set up, Files reads fall back and
 * the background service notice covers the UI (CAN-5734). So macOS defaults to
 * `/tmp`. `CANOPY_PERFORMANCE_DATA_ROOT_PARENT` (an absolute directory)
 * overrides the default.
 */
export function performanceDataRootParent(
  env = process.env,
  platform = process.platform,
) {
  const parent = env.CANOPY_PERFORMANCE_DATA_ROOT_PARENT;
  if (parent === undefined || parent === '')
    return platform === 'darwin' ? '/tmp' : os.tmpdir();
  if (!path.isAbsolute(parent))
    throw new Error(
      'CANOPY_PERFORMANCE_DATA_ROOT_PARENT must be an absolute directory',
    );
  return parent;
}

/** Whether a scenario times the app's quit after its measured window. */
export function scenarioMeasuresQuit(name) {
  return SCENARIOS[name]?.measureQuit === true;
}

export function runPerformanceScenario(name, config, options = {}) {
  return settlePerformanceScenario(name, (closeScenario) =>
    runPerformanceScenarioAttempt(name, config, options, closeScenario),
  );
}

/**
 * Where a launch's retained crash dumps go: the run's per-sample diagnostics
 * directory, or a diagnostic replay's own output directory.
 */
function crashDumpOutputDir(options) {
  if (options.crashDumpOutputDir) return options.crashDumpOutputDir;
  return options.diagnosticOutputDir
    ? path.join(options.diagnosticOutputDir, 'crash-dumps')
    : null;
}

async function runPerformanceScenarioAttempt(
  name,
  config,
  options,
  closeScenario,
) {
  const definition = SCENARIOS[name];
  if (!definition) throw new Error(`Unknown performance scenario: ${name}`);
  assertReleaseLikeScenarioSupported(name, options.releaseLike === true);
  assertReleaseLikeRootSupported(
    options.releaseLike === true,
    options.releaseLikeRoot,
  );
  assertE2eRootSupported(options.releaseLike === true, options.e2eRoot);
  const scenarioShowWindow = definition.headlessOnly
    ? false
    : options.showWindow;
  const userDataDir = mkdtempSync(
    path.join(performanceDataRootParent(), `canopy-perf-${name}-`),
  );
  const scenarioStartedAt = performance.now();
  let measuredStartedAt = scenarioStartedAt;
  const tasks = [];
  // Side channels a scenario fills while it runs: the streamed-reply windows
  // of the frame-budget report, journey and phase timings, and work counts it
  // reads itself (such as code-graph build counts).
  Object.defineProperty(tasks, 'streamedReplies', { value: [] });
  Object.defineProperty(tasks, 'frameWindows', { value: [] });
  Object.defineProperty(tasks, 'timings', { value: {} });
  Object.defineProperty(tasks, 'extraWork', { value: {} });
  const collection = scenarioWorkCollection(name, options);
  let electronApp;
  let rendererCrashes;
  let monitoring;
  let diagnosticCapture;
  let gitAttributionCapture;
  let diagnostics;
  let monitor;
  let diskIo = null;
  let fixture;

  try {
    fixture = await definition.prepare(userDataDir, config, {
      releaseLike: options.releaseLike === true,
    });
    // `--renderer-code-cache-scheme`: launchCanopy seeds the Experiments
    // preference from its local env switch before every launch.
    const diagnosticLaunch = options.diagnosticOutputDir
      ? await prepareDiagnosticLaunch(options.diagnosticOutputDir)
      : null;
    gitAttributionCapture = options.gitAttribution
      ? prepareGitAttributionCapture(userDataDir)
      : null;
    const clientFeatureFlags = scenarioClientFeatureFlags(name);
    const launchEnv = {
      // Every install runs the Home/sidebar onboarding suggestions module.
      // `launchCanopy` holds it back by default for UI specs; benchmarks
      // measure what users get, so keep it live unless the caller pins the
      // variable (e.g. `hidden` for a matched module-off comparison).
      CANOPY_E2E_ONBOARDING_SUGGESTIONS:
        process.env.CANOPY_E2E_ONBOARDING_SUGGESTIONS ?? '',
      CANOPY_E2E_MOCK_BASE_URL: PERFORMANCE_MOCK_BASE_URL,
      CANOPY_MOCK_LLM_BASE_URL: PERFORMANCE_MOCK_BASE_URL,
      CANOPY_GITHUB_API_BASE_URL: PERFORMANCE_MOCK_BASE_URL,
      CANOPY_LINEAR_API_BASE_URL: `${PERFORMANCE_MOCK_BASE_URL}/graphql`,
      CANOPY_E2E_CLOUD_BASE_URL: PERFORMANCE_MOCK_BASE_URL,
      ...performanceWindowEnv({ ...options, showWindow: scenarioShowWindow }),
      ...(diagnosticLaunch
        ? {
            CANOPY_PERFORMANCE_PROFILE_PLAIN_JS: '1',
            CANOPY_PERFORMANCE_UTILITY_CPU_PROFILE_DIR:
              diagnosticLaunch.utilityCpuProfileDir,
          }
        : {}),
      ...([
        'startup-settle',
        'startup-realistic',
        'power-user-idle',
        'power-user-active',
      ].includes(name)
        ? { CANOPY_E2E_CLOUD_BASE_URL: 'http://127.0.0.1:9' }
        : {}),
      ...(name === 'startup-settle' && config.startupBackgroundMode === 'live'
        ? { CANOPY_PERFORMANCE_LIVE_STARTUP_BACKGROUND: '1' }
        : {}),
      ...(name === 'code-graph-background-concurrency'
        ? { CANOPY_PERFORMANCE_CODE_GRAPH_SCHEDULER: '1' }
        : {}),
      ...(clientFeatureFlags === null
        ? {}
        : {
            CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify(clientFeatureFlags),
          }),
      ...([
        'startup-realistic',
        'power-user-idle',
        'power-user-active',
      ].includes(name)
        ? {
            CANOPY_PERFORMANCE_REALISTIC_STARTUP: '1',
            CANOPY_PERFORMANCE_LIVE_STARTUP_BACKGROUND: '1',
            CANOPY_PERFORMANCE_CODE_GRAPH_SCHEDULER: '1',
          }
        : {}),
      ...(gitAttributionCapture?.env ?? {}),
      ...(options.rendererCodeCacheScheme
        ? { [RENDERER_CODE_CACHE_SCHEME_ENV]: '1' }
        : {}),
      ...w5StoreLaunchEnv(options.w5Store),
      ...(definition.launchEnv?.(fixture, config) ?? {}),
    };
    // Lab-only startup trace of V8 compile events (`--startup-trace`).
    const startupTracePath =
      definition.startupJourney && config.startupTraceMode === 'v8-compile'
        ? path.join(userDataDir, 'startup-trace.json')
        : null;
    const electronArgs = [
      ...(diagnosticLaunch?.electronArgs ?? []),
      ...(startupTracePath ? startupTraceElectronArgs(startupTracePath) : []),
    ];
    // Per-process disk bytes for the whole app tree; the hidden browser-profile
    // study keeps its exact footprint. The reader, a native helper build on
    // macOS, is created before launch, so a cold helper cache never delays the
    // app or lands inside a measured window.
    const diskIoReader = collection.diskBytes
      ? await createDiskIoReader()
      : null;
    // `--warm-launches`: unmeasured launches of this same profile first, so
    // the measured launch starts in repeat state (storage already migrated,
    // V8 code cache written for the scheme).
    const warmLaunches =
      definition.startupJourney && Number.isInteger(config.startupWarmLaunches)
        ? config.startupWarmLaunches
        : 0;
    await primeStartupWarmLaunches(warmLaunches, {
      userDataDir,
      buildKind: options.releaseLike ? 'production' : undefined,
      rootPath: measuredBuildRootOption(options),
      viewportSize: options.studyViewportPreset ? options.viewport : VIEWPORT,
      showWindow: scenarioShowWindow,
      env: Object.keys(launchEnv).length > 0 ? launchEnv : undefined,
    });
    const launchStartedAt = performance.now();
    const launchEpochMs = performance.timeOrigin + launchStartedAt;
    const launched = await launchCanopy({
      userDataDir,
      buildKind: options.releaseLike ? 'production' : undefined,
      rootPath: measuredBuildRootOption(options),
      viewportSize: options.studyViewportPreset ? options.viewport : VIEWPORT,
      showWindow: scenarioShowWindow,
      electronArgs: performanceElectronArgs(
        options.releaseLike,
        userDataDir,
        electronArgs,
      ),
      env: Object.keys(launchEnv).length > 0 ? launchEnv : undefined,
    });
    electronApp = launched.electronApp;
    rendererCrashes = await observeRendererCrashes(electronApp);
    if (options.releaseLike) {
      const nativeDataRoots = await electronApp.evaluate(({ app }) => ({
        userData: app.getPath('userData'),
        sessionData: app.getPath('sessionData'),
      }));
      for (const [kind, nativeRoot] of Object.entries(nativeDataRoots)) {
        if (realpathSync(nativeRoot) !== realpathSync(userDataDir)) {
          throw new Error(
            `Release-like ${kind} escaped the isolated fixture root: ${nativeRoot}`,
          );
        }
      }
    }
    const page = await getMainWindow(electronApp);
    const firstWindowMs = performance.now() - launchStartedAt;
    if (scenarioShowWindow !== false && !options.studyViewportPreset) {
      await electronApp.evaluate(({ BrowserWindow }) => {
        for (const window of BrowserWindow.getAllWindows()) window.show();
      });
      await page.bringToFront();
    }
    const app = new CanopyAppDriver(page);
    let domContentLoadedMs;
    let shellReadyMs;
    let startupComposerReadyMs;
    let startupFirstInputMs;
    let startupFirstInputRelativeToShellMs;

    const foreground = { preset: options.studyViewportPreset, admission: {} };
    const windowEvidence = options.studyWindowMode
      ? {
          mode: options.studyWindowMode,
          windowVisible: false,
          viewport: options.viewport,
          setup: {},
        }
      : undefined;
    const startCapture = async () => {
      if (windowEvidence) {
        if (
          options.studyWindowMode !== HEADLESS_STUDY_MODE ||
          options.showWindow !== false ||
          name !== 'browser-panels'
        )
          throw new Error('Invalid hidden study scenario options');
        await setupHeadlessStudyWindow(
          electronApp,
          page,
          windowEvidence.setup,
          { signal: options.signal },
        );
        windowEvidence.atStart = await measuredWindowState(electronApp, page);
        assertHeadlessWindowEvidence({
          ...windowEvidence,
          atEnd: windowEvidence.atStart,
        });
      } else if (options.studyViewportPreset)
        foreground.atStart = await admitStudyWindow(
          electronApp,
          page,
          foreground.admission,
        );
      Object.defineProperty(tasks, 'rendererMark', {
        value: (label) => markRendererTask(page, label),
      });
      if (diagnosticLaunch) {
        diagnosticCapture = await startDiagnosticCapture({
          electronApp,
          page,
          launch: diagnosticLaunch,
          scenarioName: name,
          benchmarkContext: options.diagnosticContext,
        });
        Object.defineProperty(tasks, 'traceMark', {
          value: (label) =>
            page.evaluate((mark) => {
              performance.mark(`canopy-perf:${mark}`);
            }, label),
        });
      }
      // The disk window's baseline is read at the window boundary, just before
      // the monitor opens its own window.
      if (diskIoReader) {
        const prepared = await prepareAppDiskIoSampler(electronApp, {
          reader: diskIoReader,
        });
        diskIo = await prepared.start();
      }
      monitor = await startPerformanceMonitor({
        page,
        electronApp,
        sampleIntervalMs: config.sampleIntervalMs,
        resourceBoundarySamples: name === 'w5-store-reload',
        workCounters: collection.appCounters,
        estimateIpcBytes: collection.ipcBytes,
        frameBudgets: collection.frameBudgets,
        ...(name === 'archive-responsiveness'
          ? { nativeTreeRootPid: launched.supervisedTreePid }
          : {}),
      });
      if (monitor.sampleWork) {
        Object.defineProperty(tasks, 'workSample', {
          value: () => monitor.sampleWork(),
        });
      }
    };

    try {
      if (definition.monitorFromDomContentLoaded) {
        await page.waitForLoadState('domcontentloaded');
        domContentLoadedMs = performance.now() - launchStartedAt;
        await startCapture();
      }
      const waitForShell = async () => {
        await app.waitForShell({ timeout: 60_000 });
        shellReadyMs = performance.now() - launchStartedAt;
      };
      let counters;
      if (definition.monitorFromDomContentLoaded) {
        await tasks.traceMark?.('workload:start')?.catch(() => undefined);
        [counters] = await Promise.all([
          definition.run({
            page,
            app,
            electronApp,
            config,
            tasks,
            fixture,
            launchStartedAt,
            releaseLike: options.releaseLike,
          }),
          waitForShell(),
        ]);
      } else {
        await waitForShell();
        await definition.beforeCapture?.({
          page,
          app,
          electronApp,
          config,
          fixture,
          // Tasks timed here are kept; no window samples bracket them.
          tasks,
          launchStartedAt,
        });
        if (definition.beforeCapture) measuredStartedAt = performance.now();
        await startCapture();
        await tasks.traceMark?.('workload:start')?.catch(() => undefined);
        counters = await definition.run({
          page,
          app,
          electronApp,
          config,
          tasks,
          fixture,
          launchStartedAt,
          releaseLike: options.releaseLike,
        });
      }
      if (
        [
          'startup-settle',
          'startup-realistic',
          'power-user-idle',
          'power-user-active',
        ].includes(name) &&
        Number.isFinite(counters.composerReadyFromLaunchMs) &&
        Number.isFinite(counters.firstKeyFromLaunchMs)
      ) {
        startupComposerReadyMs = counters.composerReadyFromLaunchMs;
        startupFirstInputMs = counters.firstKeyFromLaunchMs;
        startupFirstInputRelativeToShellMs = startupFirstInputMs - shellReadyMs;
        counters.firstInputRelativeToShellMs =
          startupFirstInputRelativeToShellMs;
      }
      await tasks.traceMark?.('workload:end')?.catch(() => undefined);
      if (windowEvidence) {
        windowEvidence.atEnd = await measuredWindowState(electronApp, page);
        assertHeadlessWindowEvidence(windowEvidence);
      } else if (options.studyViewportPreset)
        foreground.atEnd = await measuredWindowState(electronApp, page);
      // Close the disk window at the boundary, stop the monitor, and only then
      // wait for the closing read (a PowerShell CIM query on Windows).
      const diskClosing = diskIo?.stop();
      monitoring = await monitor.stop();
      // Checks too heavy for the measured window (a heap snapshot); a throw
      // fails the scenario like one from `run`.
      await definition.afterCapture?.({ page, counters, config, fixture });
      const disk = await diskClosing;
      assertValidMonitoring(monitoring.summary);
      assertValidTypingSampling(monitoring.raw, tasks);
      const windowWork = scenarioWorkCounters(monitoring.summary, tasks);
      const work = {
        ...(diskIo ? mergeDiskIoWork(windowWork, disk) : windowWork),
        ...tasks.extraWork,
      };
      diagnostics = diagnosticCapture
        ? await diagnosticCapture.stop()
        : undefined;
      diagnosticCapture = null;
      const responsiveness = assessResponsiveness(
        monitoring.summary,
        config.responsivenessThresholds,
        tasks,
      );
      // The scenario's own wall time; the startup journey below runs after
      // the measured window and reports its own duration.
      const durationMs = performance.now() - measuredStartedAt;
      const labCapture = await runOptInAfterMeasurementHook(
        definition.afterMeasurement,
        {
          page,
          counters,
          scenarioName: name,
          userDataDir,
        },
      );
      const frameBudgets =
        tasks.streamedReplies.length > 0 || tasks.frameWindows.length > 0
          ? buildFrameBudgetReport(
              monitoring.raw,
              tasks.streamedReplies,
              tasks.frameWindows,
            )
          : undefined;
      let startupJourney;
      if (definition.startupJourney) {
        const journeyStartedAt = performance.now();
        const measured = await measureStartupJourney({
          electronApp,
          page,
          launchEpochMs,
          counters,
          shellReadyMs,
          startupTracePath,
          traceDir: startupTracePath ? userDataDir : null,
          warmLaunches,
        });
        // Kept out of `timings`, and so out of the flat metrics: a new timing
        // key would make every earlier startup baseline incomparable.
        startupJourney = {
          ...measured.journey,
          timings: measured.timings,
          durationMs: performance.now() - journeyStartedAt,
        };
      }
      const record = {
        name,
        status: performanceScenarioStatus(counters, responsiveness),
        durationMs,
        launch: {
          firstWindowMs,
          domContentLoadedMs,
          shellReadyMs,
          ...(Number.isFinite(startupComposerReadyMs)
            ? { composerReadyMs: startupComposerReadyMs }
            : {}),
          ...(Number.isFinite(startupFirstInputMs)
            ? { firstInputMs: startupFirstInputMs }
            : {}),
          ...(Number.isFinite(startupFirstInputRelativeToShellMs)
            ? {
                firstInputRelativeToShellMs: startupFirstInputRelativeToShellMs,
              }
            : {}),
        },
        tasks,
        counters,
        work,
        // The flags this launch pinned over the suite's defaults, so each arm
        // of a flag comparison records the flag it ran with.
        ...(clientFeatureFlags ? { clientFeatureFlags } : {}),
        ...(Object.keys(tasks.timings).length > 0
          ? { timings: tasks.timings }
          : {}),
        ...(frameBudgets ? { frameBudgets } : {}),
        ...(startupJourney ? { startupJourney } : {}),
        ...(definition.diskAccuracy
          ? {
              diskAccuracy: diskAccuracyCheck(work, {
                observabilityFileBytes: directoryFileBytes(
                  path.join(userDataDir, 'agent-observability'),
                ),
              }),
            }
          : {}),
        ...(windowEvidence ? { windowEvidence } : { foreground }),
        monitoring,
        responsiveness,
        ...(gitAttributionCapture
          ? { gitAttribution: gitAttributionCapture.summarize() }
          : {}),
        ...(diagnostics ? { diagnostics } : {}),
        ...rendererCrashRecordFields(
          rendererCrashes,
          retainLaunchCrashDumps(
            rendererCrashes,
            null,
            crashDumpOutputDir(options),
          ),
        ),
        ...(options.keepData ? { userDataDir } : {}),
      };
      const completedRecord = attachLabCaptureReceipt(record, labCapture);
      // After every app read: the app is gone afterwards, and the closing
      // harness below finds it already exited.
      return definition.measureQuit
        ? scenarioWithQuit(completedRecord, await measureAppQuit(electronApp))
        : completedRecord;
    } catch (error) {
      await diskIo?.stop();
      monitoring = await monitor?.stop().catch(() => undefined);
      await settleRendererCrashEvidence(rendererCrashes, error);
      const rendererCrashFields = rendererCrashRecordFields(
        rendererCrashes,
        retainLaunchCrashDumps(
          rendererCrashes,
          error,
          crashDumpOutputDir(options),
        ),
      );
      diagnostics = diagnosticCapture
        ? await diagnosticCapture.stop().catch((captureError) => ({
            status: 'error',
            error:
              captureError instanceof Error
                ? captureError.message
                : String(captureError),
          }))
        : undefined;
      diagnosticCapture = null;
      if (error instanceof RendererPaintTimeoutError && monitoring) {
        const responsiveness = assessResponsiveness(
          monitoring.summary,
          config.responsivenessThresholds,
          tasks,
        );
        responsiveness.passed = false;
        responsiveness.violations.push({
          metric: 'renderer.next_paint.timeout_count',
          value: 1,
          budgetMs: 0,
          unit: 'count',
          description: 'Renderer did not produce the requested paint',
        });
        return {
          name,
          status: 'unresponsive',
          error: error.message,
          durationMs: performance.now() - scenarioStartedAt,
          ...(windowEvidence ? { windowEvidence } : { foreground }),
          launch: { firstWindowMs, domContentLoadedMs, shellReadyMs },
          tasks,
          counters: {},
          ...(clientFeatureFlags ? { clientFeatureFlags } : {}),
          monitoring,
          responsiveness,
          ...(gitAttributionCapture
            ? { gitAttribution: gitAttributionCapture.summarize() }
            : {}),
          ...(diagnostics ? { diagnostics } : {}),
          ...rendererCrashFields,
          ...(options.keepData ? { userDataDir } : {}),
        };
      }
      if (error && typeof error === 'object') {
        error.performanceDetails = {
          tasks,
          ...(windowEvidence ? { windowEvidence } : { foreground }),
          launch: { firstWindowMs, domContentLoadedMs, shellReadyMs },
          monitoring,
          ...(gitAttributionCapture
            ? { gitAttribution: gitAttributionCapture.summarize() }
            : {}),
          ...(diagnostics ? { diagnostics } : {}),
          ...rendererCrashFields,
          ...(options.keepData ? { userDataDir } : {}),
        };
      }
      throw error;
    }
  } finally {
    if (definition.cleanup) {
      await definition.cleanup(fixture).catch((error) => {
        console.error(`[perf] Failed to clean up ${name}:`, error);
      });
    }
    if (electronApp) {
      await closeScenario(() =>
        closeCanopy(electronApp, userDataDir, {
          keepUserData: options.keepData,
        }),
      );
    } else if (!options.keepData) {
      rmSync(userDataDir, { recursive: true, force: true });
      rmSync(`${userDataDir}-secure`, { recursive: true, force: true });
    }
  }
}
