import { checkUpdates } from './skills/skill-service';
import {
  reconcileManagedMarketplaceReceiptsAtStartup,
  refreshMarketplaces,
} from './plugins/plugin-service';
import { getObservabilityService } from './observability';
import { flushTurnFeedbackOutbox } from './feedback/turn-feedback-client';
import { flushSharedItemSubscriptions } from './canopy-cloud/shared-item-subscriptions';
import { sendToWindowDetailed } from './lib/window-send';
import { isE2eBuild } from './lib/e2e-gate';
import {
  isRealisticStartupPerformanceEnabled,
  recordRealisticStartupPerformanceEvent,
} from './lib/realistic-startup-performance';
import { SKILLS_CHANNELS } from '@canopy/desktop-shared/constants/skill-channels';
import { PLUGINS_CHANNELS } from '@canopy/desktop-shared/constants/plugin-channels';
import type { BrowserWindow } from 'electron';
import type { SkillUpdateProgress } from '@canopy/desktop-shared/types/skills';
import type { MarketplaceOperationProgress } from '@canopy/execution-engine/types/plugins';
import { enqueueStartupLocalMemoryImportBatch } from './memory/local/import/import-job';
import { sweepCodexMarketplaceStaging } from './plugins/codex-staging-janitor';
import { prefetchBlueprints } from './blueprints/blueprint-catalog';
import {
  reconcileLedgerScopesAtStartup,
  type LedgerStartupPassOutcome,
} from './ledger/lifecycle';
import { reconcileSummaryPublications } from './ledger/summary-reconciliation';
import { WORKSPACE_TEMPLATE_SHARE_LABEL } from '@canopy/protocol';
import type * as StartupStreamRepairModule from './agents/delegation/startup-stream-repair';

const STARTUP_BACKGROUND_TASK_DELAY_MS = 5000;
const STARTUP_BACKGROUND_INTERACTION_IDLE_MS = 5000;
const STARTUP_BACKGROUND_MAX_DELAY_MS = 60_000;
const CODEX_STAGING_SWEEP_INTERVAL_MS = 12 * 60 * 60 * 1000;
const LIVE_E2E_STARTUP_BACKGROUND_ENV =
  'CANOPY_PERFORMANCE_LIVE_STARTUP_BACKGROUND';
const E2E_STARTUP_STREAM_REPAIR_ENV = 'CANOPY_E2E_STARTUP_STREAM_REPAIR';

// Keep the broker/service graph out of the startup critical path. Retaining the
// import promise also fences shutdown against an import that has not resolved.
let streamRepairModule: Promise<typeof StartupStreamRepairModule> | undefined;
let streamRepairTask: Promise<void> | undefined;

function runStartupStreamRepair(): void {
  streamRepairModule ??= import('./agents/delegation/startup-stream-repair');
  streamRepairTask = streamRepairModule
    .then(async ({ startStartupStreamRepair }): Promise<void> => {
      const result = await startStartupStreamRepair();
      if (result.failed > 0) {
        recordStartupBackgroundTaskFailure(
          'delegation_stream_repair',
          `discovered=${result.discovered} repaired=${result.repaired} skipped=${result.skipped} failed=${result.failed} durationMs=${result.durationMs}`,
        );
      }
    })
    .catch((): void => {
      // Scope errors can contain paths or chat text. Diagnostics carry only
      // fixed codes/counts; the job isolates individual scopes internally.
      recordStartupBackgroundTaskFailure(
        'delegation_stream_repair',
        'incomplete',
      );
    });
}

/** Drop pending scopes and drain the admitted scope while chat ports are live. */
export async function shutdownDeferredStartupStreamRepair(): Promise<void> {
  if (!streamRepairModule) return;
  const repair = await streamRepairModule;
  await repair.shutdownStartupStreamRepair();
  await streamRepairTask;
  streamRepairTask = undefined;
  streamRepairModule = undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function recordStartupBackgroundTaskFailure(
  task:
    | 'skills_check_updates'
    | 'plugin_marketplace_refresh'
    | 'plugin_marketplace_receipts'
    | 'blueprint_catalog_refresh'
    | 'ledger_scope_reconciliation'
    | 'ledger_summary_reconciliation'
    | 'delegation_stream_repair',
  reason: string,
): void {
  getObservabilityService().recordAppDiagnostic({
    version: 1,
    timestamp: new Date().toISOString(),
    kind: 'startup_background_task_failed',
    reason: `${task}: ${reason}`,
  });
}

/**
 * Settles every Ledger scope against its container, including archive,
 * restore and deletion participants that did not finish before the last quit
 * and worktrees deleted through the CLI while the app was closed, then
 * finishes any Summary publications left pending.
 */
async function reconcileLedgerScopes(): Promise<void> {
  let outcome: LedgerStartupPassOutcome = 'incomplete';
  try {
    outcome = await reconcileLedgerScopesAtStartup();
  } catch (error) {
    recordStartupBackgroundTaskFailure(
      'ledger_scope_reconciliation',
      errorMessage(error),
    );
  }
  // Publishing binds scopes, so it waits for a pass that settled every
  // scope: an unfinished restore rebind must land before anything binds the
  // restored container. Pending publications wait for the next startup.
  if (outcome !== 'settled') return;
  try {
    await reconcileSummaryPublications();
  } catch (error) {
    recordStartupBackgroundTaskFailure(
      'ledger_summary_reconciliation',
      errorMessage(error),
    );
  }
}

/** Records receipts for managed marketplaces Claude has registered. */
function reconcileManagedMarketplaceReceipts(): void {
  try {
    const outcome = reconcileManagedMarketplaceReceiptsAtStartup();
    if (outcome.status === 'failed') {
      recordStartupBackgroundTaskFailure(
        'plugin_marketplace_receipts',
        outcome.error,
      );
    }
  } catch (error) {
    recordStartupBackgroundTaskFailure(
      'plugin_marketplace_receipts',
      errorMessage(error),
    );
  }
}

function sendSkillProgress(
  getMainWindow: () => BrowserWindow | null,
  progress: SkillUpdateProgress,
): void {
  sendToWindowDetailed(
    getMainWindow(),
    SKILLS_CHANNELS.UPDATE_PROGRESS,
    progress,
  );
}

function sendMarketplaceProgress(
  getMainWindow: () => BrowserWindow | null,
  progress: MarketplaceOperationProgress,
): void {
  sendToWindowDetailed(
    getMainWindow(),
    PLUGINS_CHANNELS.OPERATION_PROGRESS,
    progress,
  );
}

async function runStartupBackgroundTasks(
  getMainWindow: () => BrowserWindow | null,
): Promise<void> {
  // Turn ratings queued while signed out or offline (CAN-1521). Sign-in is the
  // primary flush trigger; this covers the case where the user was already
  // signed in and simply had no connectivity when they rated. Best-effort and
  // deliberately not awaited alongside the heavier refreshes below.
  void flushTurnFeedbackOutbox();
  // Install subscriptions recorded while signed out or offline, plus the
  // one-time backfill for this account (CAN-2334). Same best-effort shape.
  void flushSharedItemSubscriptions();

  recordRealisticStartupPerformanceEvent(
    'startup:skill-plugin-refresh:started',
  );
  const [skillResult, marketplaceResult, blueprintResult] =
    await Promise.allSettled([
      checkUpdates((progress) => sendSkillProgress(getMainWindow, progress)),
      // Startup always re-runs marketplace discovery (so registration changes
      // and newly supported providers — e.g. a marketplace gaining Codex
      // support — are picked up), but only re-runs the expensive
      // per-marketplace provider update commands when the last full refresh is
      // stale. Those updates spawn the bundled claude/codex CLIs over the
      // network and were re-triggered by every app start from every instance.
      refreshMarketplaces(
        (progress) => sendMarketplaceProgress(getMainWindow, progress),
        { providerUpdates: 'if-stale' },
      ),
      prefetchBlueprints(),
    ]);

  if (skillResult.status === 'rejected') {
    recordStartupBackgroundTaskFailure(
      'skills_check_updates',
      errorMessage(skillResult.reason),
    );
  } else if (!skillResult.value.success) {
    recordStartupBackgroundTaskFailure(
      'skills_check_updates',
      skillResult.value.error ?? 'Unknown error',
    );
  }

  if (marketplaceResult.status === 'rejected') {
    recordStartupBackgroundTaskFailure(
      'plugin_marketplace_refresh',
      errorMessage(marketplaceResult.reason),
    );
  } else if (!marketplaceResult.value.success) {
    recordStartupBackgroundTaskFailure(
      'plugin_marketplace_refresh',
      marketplaceResult.value.error ?? 'Unknown error',
    );
  }
  // Catalog invalidation follows settled publications/effects, even on failure.
  if (blueprintResult.status === 'rejected') {
    recordStartupBackgroundTaskFailure(
      'blueprint_catalog_refresh',
      errorMessage(blueprintResult.reason),
    );
  } else if (!blueprintResult.value) {
    recordStartupBackgroundTaskFailure(
      'blueprint_catalog_refresh',
      `${WORKSPACE_TEMPLATE_SHARE_LABEL} catalog unavailable`,
    );
  }
  recordRealisticStartupPerformanceEvent(
    'startup:skill-plugin-refresh:completed',
    {
      skillsOk: skillResult.status === 'fulfilled' && skillResult.value.success,
      marketplacesOk:
        marketplaceResult.status === 'fulfilled' &&
        marketplaceResult.value.success,
    },
  );
}

export interface DeferredStartupLocalTasks {
  /** Host-supplied, since it needs Electron's Crashpad paths. */
  readonly runCrashDumpSweep?: () => Promise<void>;
}

export function scheduleDeferredStartupBackgroundTasks(
  getMainWindow: () => BrowserWindow | null,
  localTasks: DeferredStartupLocalTasks = {},
): () => void {
  // Under the UI-automation/E2E build, suppress the deferred startup tasks:
  // they spawn the bundled claude/codex binaries to refresh plugin marketplaces
  // over the network (~5s after launch), which is slow and non-deterministic
  // for tests. The desktop performance runner has one explicit opt-in for
  // diagnosing this real post-shell pressure; production builds never consult
  // that E2E-only switch.
  const e2e = isE2eBuild();
  const runOrdinaryTasks =
    !e2e ||
    process.env[LIVE_E2E_STARTUP_BACKGROUND_ENV] === '1' ||
    isRealisticStartupPerformanceEnabled();
  // This switch is consulted only in the compile-time E2E build. It enables
  // local stream repair, never marketplace/provider work or other startup jobs.
  const runStreamRepair =
    !e2e ||
    runOrdinaryTasks ||
    process.env[E2E_STARTUP_STREAM_REPAIR_ENV] === '1';
  if (!runOrdinaryTasks && !runStreamRepair) return () => {};

  const scheduledAt = Date.now();
  recordRealisticStartupPerformanceEvent(
    'startup:skill-plugin-refresh:scheduled',
    {
      delayMs: STARTUP_BACKGROUND_TASK_DELAY_MS,
      idleMs: STARTUP_BACKGROUND_INTERACTION_IDLE_MS,
      maxDelayMs: STARTUP_BACKGROUND_MAX_DELAY_MS,
    },
  );
  let lastInteractionAt = scheduledAt;
  let cancelled = false;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let codexStagingSweepInterval: ReturnType<typeof setInterval> | null = null;
  const window = getMainWindow();
  const webContents =
    window && !window.isDestroyed?.() ? window.webContents : null;
  const recordInteraction = (): void => {
    lastInteractionAt = Date.now();
    recordRealisticStartupPerformanceEvent(
      'startup:skill-plugin-refresh:interaction',
    );
  };
  webContents?.on('before-input-event', recordInteraction);
  webContents?.on('before-mouse-event', recordInteraction);

  const detachInteractionListeners = (): void => {
    webContents?.off('before-input-event', recordInteraction);
    webContents?.off('before-mouse-event', recordInteraction);
  };

  const runWhenInteractionIdle = (): void => {
    if (cancelled) {
      return;
    }
    const now = Date.now();
    const elapsed = now - scheduledAt;
    const idleFor = now - lastInteractionAt;
    if (
      elapsed >= STARTUP_BACKGROUND_MAX_DELAY_MS ||
      idleFor >= STARTUP_BACKGROUND_INTERACTION_IDLE_MS
    ) {
      timeout = null;
      detachInteractionListeners();
      recordRealisticStartupPerformanceEvent(
        'startup:skill-plugin-refresh:gate-fired',
        { elapsedMs: elapsed, idleForMs: idleFor },
      );
      if (runStreamRepair) runStartupStreamRepair();
      if (!runOrdinaryTasks) return;
      void enqueueStartupLocalMemoryImportBatch().catch(() => undefined);
      void sweepCodexMarketplaceStaging();
      codexStagingSweepInterval = setInterval(() => {
        void sweepCodexMarketplaceStaging();
      }, CODEX_STAGING_SWEEP_INTERVAL_MS);
      codexStagingSweepInterval.unref?.();
      // Local work that launches no provider CLI, so it also runs on Windows.
      void reconcileLedgerScopes();
      reconcileManagedMarketplaceReceipts();
      void localTasks.runCrashDumpSweep?.().catch(() => undefined);
      // On Windows, provider CLIs launched by the refreshes can spawn their
      // own visible shell grandchildren. Keep only those provider refreshes
      // user-initiated; the local memory import does not launch provider CLIs.
      if (process.platform !== 'win32') {
        void runStartupBackgroundTasks(getMainWindow);
      }
      return;
    }
    const untilIdle = STARTUP_BACKGROUND_INTERACTION_IDLE_MS - idleFor;
    const untilDeadline = STARTUP_BACKGROUND_MAX_DELAY_MS - elapsed;
    timeout = setTimeout(
      runWhenInteractionIdle,
      Math.max(1, Math.min(untilIdle, untilDeadline)),
    );
  };

  timeout = setTimeout(
    runWhenInteractionIdle,
    STARTUP_BACKGROUND_TASK_DELAY_MS,
  );

  return () => {
    cancelled = true;
    if (timeout) {
      clearTimeout(timeout);
      timeout = null;
    }
    if (codexStagingSweepInterval) {
      clearInterval(codexStagingSweepInterval);
      codexStagingSweepInterval = null;
    }
    detachInteractionListeners();
  };
}
