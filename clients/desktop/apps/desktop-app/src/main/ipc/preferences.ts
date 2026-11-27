import {
  applyPreferenceSaveRules,
  mergeUsageDataPatch,
  type PreferenceSaveRefusedKey,
} from '@canopy/protocol/canopy-core/core';
import {
  applyOnboardingTipsUpdate,
  CLAUDE_CONNECTOR_NOTICE_DISMISSAL_ID,
  normalizeOnboardingTipDismissals,
  parseOnboardingTipsState,
  parseOnboardingTipsUpdate,
  type OnboardingTipDismissals,
  type OnboardingTipsState,
} from '@canopy/protocol/onboarding-tips';
import {
  parseSuggestionsState,
  type SuggestionsState,
} from '@canopy/protocol/suggestions';
import { isDataSharingOptInFeature } from '@canopy/protocol/canopy-server';
import { DATA_SHARING_OPT_IN_SCOPES } from '@canopy/ui-shared/lib/data-sharing-features';
import { normalizeUuid } from '@canopy/execution-engine/lib/workspace-owner';
import type { TelemetryEnforcement } from '@canopy/desktop-shared/lib/telemetry-enforcement';
import type {
  DataSharingOptInResult,
  DataSharingOptInDismissResult,
  TelemetryScopeKey,
} from '@canopy/desktop-shared/types';
import {
  DataSharingOptInError,
  requireDataSharingOptInAuthority,
  requireDataSharingPersonalOptInAuthority,
} from '../lib/data-sharing-opt-in-authority';
import { broadcastPreferencesChanged } from '../lib/preferences-broadcast';
import { getMainWindow } from '../lib/main-window-focus';
import { sendToWindow } from '../lib/window-send';
import { notifyManagedDelegationLifetimePreferencesChanged } from '../agents/delegation/lifetime-status';
import { notifyDesktopInventoryChanged } from '../services/desktop-inventory-sync-signals';
import { personalCatalogPreferenceChanged } from '../services/personal-catalog-sync-host';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createDirectoryDurably,
  writeFileAtomically,
  type AdmittedWriterTarget,
} from '../lib/atomic-file';
import { nativeTheme, shell } from 'electron';
import { isCuratedCatalogKey } from '@canopy/protocol/plugin-catalog';
import {
  IPC_CHANNELS,
  initCursorModels,
  type PreferencesData,
  type PreferencesSavePatch,
  type PreferencesLoadResult,
  type PreferencesSaveResult,
  type PreferencesProjectionOptions,
  type LocalMemoryImportRequest,
  type LocalMemoryImportResult,
  type SetApprovalDefaultPreferenceRequest,
  type SetPipelineDisabledPreferenceRequest,
} from '@canopy/desktop-shared/types';
import {
  DATA_DIR_ADOPTION_MARKER_FILENAME,
  getPrimaryBrandDataDir,
  getResolvedCanopyDataDir,
} from '@canopy/execution-engine/canopy-paths';
import {
  acknowledgePreferencesLoadError,
  arePreferencesUnconfirmed,
  readLatestPreferencesFile,
  projectPreferencesForRuntime,
  peekPreferencesLoadError,
  readPreferencesFile,
  readPreferencesFileForRenderer,
  updatePreferencesFile,
  updatePreferencesFileWithPrevious,
} from '../lib/preferences-store';
import { validateId } from '../lib/validation';
import { pluginSelectionsEqual } from '@canopy/desktop-shared/lib/effective-plugin-selections';
import {
  bumpGlobalPluginDefaultsRevision,
  markCodexSessionsForNextTurnRecreation,
  markManagedDelegationSessionsForNextTurnRecreation,
  updateClaudeSessionIdleTimeoutMinutes,
  updateCodexSessionIdleTimeoutMinutes,
} from '../agents/session-manager';
import {
  updateManagedDelegationPolicy,
  updateManagedDelegationMaxConcurrent,
  updateManagedDelegationMaxDepth,
  updateManagedDelegationLifetimeLimit,
} from '../agents/delegation/service';
import { getMcpHttpProxyService } from '../mcp/http-proxy-service';
import { updatePerformanceLimitsFromPreferences } from '../lib/performance-limits';
import { setAppAdvisorProjectAgentAccess } from '../lib/app-advisor-project-agent-access';
import { applyOneWindowChoice } from '../lib/one-window-switch';
import { resolveRemoteBridgeSender } from '../remote-control/host/bridge-window';
import {
  electronPreferenceNativeEffects,
  type PreferenceNativeEffects,
} from '../lib/preference-native-effects';
import {
  applyImmediateHostEffects,
  applySettledHostEffects,
  commitChanged,
  commitTouches,
  committedPreferencesSequence,
  registerPreferenceCommitHost,
  type ForeignPreferenceCommitChange,
  type PreferenceCommitChange,
  type PreferenceCommitEffectInput,
  type PreferenceCommitHost,
} from '../lib/preference-commit-effects';
import {
  getUsageDataPolicy,
  usageDataConsentStateOf,
} from '../lib/usage-data-policy';
import { nativeCrashAnnotation } from '../lib/native-crash-policy';
import { getMemoryDiagnosticsService } from '../memory-diagnostics';
import { getBrowserService } from '../browser/browser-service-registry';
import { registerIpcHandler } from './register';
import { getRendererCodeCacheSchemeStatus } from '../renderer-origin/renderer-code-cache-scheme-status';
import { correctRefusedFocusShortcut } from './global-focus-shortcut';
import { broadcastPreferencesSynced } from '../lib/preferences-broadcast';
import { applyUiZoomToAllWindows, uiScaleToZoomFactor } from '../lib/ui-zoom';
import { updateSuggestionsPreferences } from '../lib/suggestions-preferences';
import {
  getCodeGraphPreferencesSnapshot,
  reconcileCodeGraphAvailability,
  setCodeGraphPreferences,
} from '../lib/code-graph-availability';
import { getNativeThemeSource } from '../lib/window-material';
import {
  beginApprovalDefaultIntent,
  beginPendingApprovalDefaultWrite,
  commitApprovalDefaultIntent,
} from '../lib/approval-mode-resolution';
import { isApprovalMode } from '@canopy/desktop-shared/lib/approval-engine';
import { isApprovalDefaultSurface } from '@canopy/desktop-shared/types';
import { recordOnboardingProfileTelemetry } from '../lib/desktop-telemetry';
import { syncOnboardingProfilePreferences } from '../services/onboarding-profile-sync-service';
import { enqueueManualLocalMemoryImportBatch } from '../memory/local/import/import-job';
import { localMemoryScopeDir } from '../memory/local/scope-resolver';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { resolveManagedDelegationMode } from '../agents/delegation/gate';
import { broadcastModelRegistryUpdated } from '../models/model-registry';
// Zero top-level imports of its own — defers `runtime-status` (and the
// `__CANOPY_CURSOR_CLI__` build constant it reads) internally, matching
// `ipc/cursor-connection.ts`. A static import here is safe.
import { refreshCursorRuntimeAvailability } from '../cursor/runtime-availability';
import {
  detachedWorkCallback,
  trackDetachedWork,
} from '@canopy/desktop-shared/node/lib/detached-work';

const STORED_PIPELINE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const DATA_DIR_ADOPTION_MARKER_WRITER: AdmittedWriterTarget = {
  namespace: 'data_dir_adoption_marker',
  writer: 'electron_main',
  module: 'main/ipc/preferences',
};
const CODE_GRAPH_RECONCILIATION_RETRY_DELAYS_MS = [1_000, 5_000, 30_000];

let codeGraphReconciliationRetryTimer: ReturnType<typeof setTimeout> | null =
  null;
let managedDelegationRevocationIncomplete = false;
let preferencesSaveGeneration = 0;
let managedDelegationPolicyGeneration = 0;
let latestManagedDelegationPolicyCompletion: Promise<void> = Promise.resolve();

interface PendingManagedDelegationPolicyUpdate {
  mode: ReturnType<typeof resolveManagedDelegationMode>;
  generation: number;
  completion: Promise<void>;
}

function beginManagedDelegationPolicyUpdate(
  commit: PreferenceCommitEffectInput,
): PendingManagedDelegationPolicyUpdate | undefined {
  const normalized = commit.next;
  if (commitTouches(commit, ['managedDelegationMaxDepth'])) {
    updateManagedDelegationMaxDepth(normalized.managedDelegationMaxDepth);
  }
  if (commitTouches(commit, ['managedDelegationMaxConcurrent'])) {
    updateManagedDelegationMaxConcurrent(
      normalized.managedDelegationMaxConcurrent,
    );
  }
  if (commitTouches(commit, ['managedDelegationLifetimeLimit'])) {
    updateManagedDelegationLifetimeLimit(
      normalized.managedDelegationLifetimeLimit,
    );
  }
  if (!commitTouches(commit, ['managedDelegationMode'])) return undefined;
  const mode = resolveManagedDelegationMode(normalized.managedDelegationMode);
  const generation = ++managedDelegationPolicyGeneration;
  markManagedDelegationSessionsForNextTurnRecreation(mode);
  const completion = updateManagedDelegationPolicy(mode).then(
    () => {
      if (generation === managedDelegationPolicyGeneration) {
        managedDelegationRevocationIncomplete = false;
      }
    },
    (error: unknown) => {
      if (generation === managedDelegationPolicyGeneration) {
        managedDelegationRevocationIncomplete = mode === 'off';
      }
      logMainProcessWarn(
        '[preferences] Managed delegation revocation failed; continuing preference side effects',
        error,
      );
    },
  );
  latestManagedDelegationPolicyCompletion = completion;
  return { mode, generation, completion };
}

function preferencesSaveResult(
  normalized: PreferencesData,
): PreferencesSaveResult {
  const runtime = projectPreferencesForRuntime(normalized);
  return {
    ...runtime,
    // Old controllers render this switch; disk keeps its downgrade value frozen.
    repeatTaskAutomationSuggestionsEnabled: runtime.suggestions.enabled,
    managedDelegationMode: resolveManagedDelegationMode(
      runtime.managedDelegationMode,
    ),
    __managedDelegationRevocationIncomplete:
      managedDelegationRevocationIncomplete,
  };
}

/**
 * Broadcasts preferences that a main-side writer (such as a Portal adapter)
 * just committed. It advances the save generation like a renderer save, so a
 * save still waiting on profile sync cannot broadcast its older snapshot over
 * this one.
 */
export function broadcastCommittedPreferences(
  normalized: PreferencesData,
): void {
  ++preferencesSaveGeneration;
  broadcastPreferencesSynced(preferencesSaveResult(normalized));
}

async function latestPreferencesSaveResult(): Promise<PreferencesSaveResult> {
  for (;;) {
    const observedSaveGeneration = preferencesSaveGeneration;
    const observedPolicyGeneration = managedDelegationPolicyGeneration;
    const policyCompletion = latestManagedDelegationPolicyCompletion;
    await policyCompletion;
    const latestPreferences = await readLatestPreferencesFile();
    if (
      observedSaveGeneration === preferencesSaveGeneration &&
      observedPolicyGeneration === managedDelegationPolicyGeneration &&
      policyCompletion === latestManagedDelegationPolicyCompletion
    ) {
      return preferencesSaveResult(latestPreferences);
    }
  }
}

let registeredNativeEffects: PreferenceNativeEffects | null = null;

// Read at call time, never at module load: saves made before
// registerPreferenceHandlers use the Electron composition.
function nativeEffects(): PreferenceNativeEffects {
  return registeredNativeEffects ?? electronPreferenceNativeEffects;
}

function commitHost(): PreferenceCommitHost {
  return {
    native: nativeEffects(),
    correctFocusShortcut: correctRefusedFocusShortcut,
    applyCommitOrdered: (commit) => {
      applyCommittedPreferenceValues(commit.next);
      resumeCrashReportsAfterOptIn(
        commit.changedKeys.has('usageData') &&
          !commit.previous.usageData.errorReports,
        commit.next,
      );
    },
    applyCommitEffects: applyForeignCommitEffects,
  };
}

/**
 * Resumes native crash reports once a commit opts in: an own save whose patch
 * opts in, or a foreign commit that turned them on.
 */
function resumeCrashReportsAfterOptIn(
  optedIn: boolean,
  committed: Readonly<PreferencesData>,
): void {
  if (optedIn && committed.usageData.errorReports)
    nativeCrashAnnotation.resumeAfterOptIn();
}

/** A foreign commit's effects after the write queue, in an own save's order. */
async function applyForeignCommitEffects(
  commit: ForeignPreferenceCommitChange,
): Promise<void> {
  const pendingManagedDelegationPolicyUpdate = beginCommitEffects(commit);
  // As an own save: a mode change broadcasts once, with its final status.
  if (pendingManagedDelegationPolicyUpdate) ++preferencesSaveGeneration;
  else broadcastCommittedPreferences(commit.next);
  try {
    await applyCommitConnectionEffects(commit, changedValues(commit));
  } catch (error) {
    // The commit is durable: a provider failure must not skip its host
    // effects below.
    logMainProcessWarn(
      '[preferences] Provider effects failed after a foreign preference commit',
      error,
    );
  }
  if (commitTouches(commit, ['codeGraph'])) {
    const previousCodeGraph = getCodeGraphPreferencesSnapshot();
    setCodeGraphPreferences(commit.next.codeGraph);
    if (
      commit.next.codeGraph !== undefined &&
      !hasSameEffectiveCodeGraphPreference(
        previousCodeGraph,
        commit.next.codeGraph,
      )
    )
      await reconcileCommittedCodeGraph();
  }
  try {
    await applyCommitSideEffects(commit, pendingManagedDelegationPolicyUpdate);
  } finally {
    // The windows hear of a mode change even when a later effect failed;
    // the effective mode and its revocation status travel together.
    if (
      pendingManagedDelegationPolicyUpdate?.generation ===
      managedDelegationPolicyGeneration
    )
      broadcastPreferencesSynced(await latestPreferencesSaveResult());
  }
}

/** A foreign commit's changed values: the patch an own save's effects read. */
function changedValues(
  commit: ForeignPreferenceCommitChange,
): Partial<PreferencesData> {
  const values: Partial<PreferencesData> = { ...commit.next };
  for (const key of Object.keys(values)) {
    if (!commit.changedKeys.has(key)) Reflect.deleteProperty(values, key);
  }
  return values;
}

const ACCOUNT_PROXY_PREFERENCE_KEYS = [
  'accountProxyEnabled',
  'accountProxyKeepChatOnOneAccount',
  'accountProxyRouteClaude',
  'accountProxyRouteCodex',
  'accountProxyLocalStartWithApp',
] as const;

function sameJson(previous: unknown, next: unknown): boolean {
  return JSON.stringify(previous) === JSON.stringify(next);
}

/**
 * Right after the commit, before anything yields. Managed delegation changes
 * the process-authoritative admission state synchronously, so no broadcast
 * or later effect can leave old sessions launchable.
 */
function beginCommitEffects(
  commit: PreferenceCommitChange,
): PendingManagedDelegationPolicyUpdate | undefined {
  const pendingManagedDelegationPolicyUpdate =
    beginManagedDelegationPolicyUpdate(commit);
  if (commitTouches(commit, ['managedDelegationLifetimeLimit']))
    notifyManagedDelegationLifetimePreferencesChanged();
  if (commitChanged(commit, 'personalWorkspaceCatalogSync')) {
    trackDetachedWork(() =>
      (async (): Promise<void> => {
        try {
          await personalCatalogPreferenceChanged();
        } catch (error) {
          logMainProcessWarn(
            '[preferences] Personal catalog follow-up failed after preference commit',
            error,
          );
        }
      })(),
    );
  }
  return pendingManagedDelegationPolicyUpdate;
}

/**
 * The provider runtimes and catalogs a commit re-syncs, then its onboarding
 * profile. `named` holds the keys the commit names, with their values.
 */
async function applyCommitConnectionEffects(
  commit: PreferenceCommitChange,
  named: Partial<PreferencesData>,
): Promise<void> {
  const { previous, next } = commit;
  if (
    commitChanged(commit, 'copilotEnabled') ||
    commitChanged(commit, 'copilotAccount', sameJson)
  ) {
    const { revokeCopilotRuntimes } = await import('../copilot/connection');
    await revokeCopilotRuntimes();
    broadcastModelRegistryUpdated();
  }
  if (ACCOUNT_PROXY_PREFERENCE_KEYS.some((key) => commitChanged(commit, key))) {
    const { notifyAccountProxyPreferencesChanged } =
      await import('./account-proxy');
    notifyAccountProxyPreferencesChanged();
  }
  if (commitChanged(commit, 'opencodeEnabled')) {
    const { revokeOpenCodeRuntimes } = await import('../opencode/connection');
    await revokeOpenCodeRuntimes();
    broadcastModelRegistryUpdated();
  }
  if (commitChanged(commit, 'cursorEnabled')) {
    // Preferences can be changed without using the Connect/Disconnect UI
    // — `harnesses-settings.spec.mjs` exercises exactly this generic
    // `preferencesSave` path with `{ cursorEnabled: false }`. Both
    // directions refresh and notify below; only disabling additionally
    // withdraws the cached selectable models, since enabling here (with
    // no accompanying sign-in) has no catalog to populate.
    if (!next.cursorEnabled) {
      // Drain pending discovery before withdrawing its selectable models.
      const { invalidateCursorModels } = await import('../cursor/models');
      await invalidateCursorModels();
      initCursorModels([]);
    }
    // Portal projects `providerAvailability.cursor` from the cached
    // preflight; refresh it so the broadcast that follows does not
    // re-project a stale hint in either direction.
    await refreshCursorRuntimeAvailability();
    broadcastModelRegistryUpdated();
  }
  if (
    commitTouches(commit, ['globalPluginSelections']) &&
    commitChanged(commit, 'globalPluginSelections', pluginSelectionsEqual)
  ) {
    // Sessions on overlay-participating chat surfaces lazily recreate on
    // their next send; new sends and terminals resolve against the
    // updated global defaults when they start.
    bumpGlobalPluginDefaultsRevision();
    // The installed-item statuses derive from these selections, so the
    // synced snapshot the web settings read must follow (CAN-6037).
    notifyDesktopInventoryChanged(['installed_items']);
  }
  recordOnboardingProfileTelemetry({ previous, next });
  try {
    await syncOnboardingProfilePreferences(next, named);
  } catch (error) {
    // The local preference write has already committed. Cloud profile sync
    // is best-effort and must never make a successful onboarding step look
    // failed or roll back the user's local answer.
    // eslint-disable-next-line no-console
    console.warn('Failed to sync onboarding profile to the cloud:', error);
  }
}

/** Applied in commit order, so an older save cannot overwrite a newer value. */
function applyCommittedPreferenceValues(
  committed: Readonly<PreferencesData>,
): void {
  getMemoryDiagnosticsService().setEnabled(committed.memoryDiagnosticsEnabled);
  setAppAdvisorProjectAgentAccess(committed.appAdvisorProjectAgentAccess);
}

function cancelCodeGraphReconciliationRetry(): void {
  if (codeGraphReconciliationRetryTimer !== null) {
    clearTimeout(codeGraphReconciliationRetryTimer);
    codeGraphReconciliationRetryTimer = null;
  }
}

function scheduleCodeGraphReconciliationRetry(attempt = 0): void {
  if (
    codeGraphReconciliationRetryTimer !== null ||
    attempt >= CODE_GRAPH_RECONCILIATION_RETRY_DELAYS_MS.length
  ) {
    return;
  }

  codeGraphReconciliationRetryTimer = setTimeout(
    detachedWorkCallback(() => {
      codeGraphReconciliationRetryTimer = null;
      return reconcileCodeGraphAvailability().catch((error) => {
        // eslint-disable-next-line no-console
        console.error('Failed to retry Code Graph availability:', error);
        scheduleCodeGraphReconciliationRetry(attempt + 1);
      });
    }),
    CODE_GRAPH_RECONCILIATION_RETRY_DELAYS_MS[attempt],
  );
  codeGraphReconciliationRetryTimer.unref?.();
}

export function resetCodeGraphReconciliationRetryForTests(): void {
  cancelCodeGraphReconciliationRetry();
}

function getCreatedPrimaryDataDirStatus(): ReturnType<
  typeof getResolvedCanopyDataDir
> {
  const current = getResolvedCanopyDataDir();
  if (current.source === 'override' || current.source === 'primary') {
    return current;
  }

  // For fallback and fresh sources, mkdir just created the primary folder.
  // Return the status the app will use after restart without mutating live cache.
  return {
    ...current,
    path: getPrimaryBrandDataDir(),
    source: 'primary',
  };
}

export {
  DEFAULT_PREFERENCES,
  normalizePreferences,
  readPreferencesFile,
  readPreferencesFileForRenderer,
  updatePreferencesFile,
  writePreferencesFile,
} from '../lib/preferences-store';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validatePipelinePreferenceId(id: string): void {
  if (id.startsWith('curated:')) {
    if (!isCuratedCatalogKey(id.slice('curated:'.length))) {
      throw new Error('Invalid curated pipeline id.');
    }
    return;
  }

  const sharedMatch = /^shared:([^:]+):([^:]+)$/.exec(id);
  if (sharedMatch) {
    validateId(sharedMatch[1], 'pipeline server id');
    if (!STORED_PIPELINE_ID_PATTERN.test(sharedMatch[2])) {
      throw new Error(
        'Invalid remote pipeline id: must be alphanumeric with underscores or hyphens.',
      );
    }
    return;
  }

  if (id.startsWith('project--')) {
    const relativePath = id.slice('project--'.length);
    const segments = relativePath.split('/');
    if (
      !/\.ya?ml$/i.test(relativePath) ||
      segments.some(
        (segment) => segment === '' || segment === '.' || segment === '..',
      )
    ) {
      throw new Error('Invalid project pipeline id.');
    }
    return;
  }

  if (!STORED_PIPELINE_ID_PATTERN.test(id)) {
    throw new Error(
      'Invalid pipeline id: must be alphanumeric with underscores or hyphens.',
    );
  }
}

function normalizeSetPipelineDisabledRequest(
  value: unknown,
): SetPipelineDisabledPreferenceRequest {
  if (
    isRecord(value) &&
    typeof value.id === 'string' &&
    value.id.trim().length > 0 &&
    typeof value.disabled === 'boolean'
  ) {
    validatePipelinePreferenceId(value.id);
    return { id: value.id, disabled: value.disabled };
  }

  throw new Error('Invalid pipeline disabled preference request.');
}

/**
 * Validates a single-surface approval default write. `mode` reaches durable
 * global policy, and `normalizeApprovalDefaults` resolves a malformed value
 * fail-closed rather than to the caller's intent, so reject rather than coerce.
 */
function normalizeSetApprovalDefaultRequest(
  value: unknown,
): SetApprovalDefaultPreferenceRequest {
  if (
    isRecord(value) &&
    isApprovalDefaultSurface(value.surface) &&
    isApprovalMode(value.mode)
  ) {
    return { surface: value.surface, mode: value.mode };
  }

  throw new Error('Invalid approval default preference request.');
}

function hasSameEffectiveCodeGraphPreference(
  left: ReturnType<typeof getCodeGraphPreferencesSnapshot>,
  right: NonNullable<PreferencesData['codeGraph']>,
): boolean {
  if (left.mode !== right.mode) {
    return false;
  }
  const leftIds = [...left.selectedWorkspaceIds].sort();
  const rightIds = [...right.selectedWorkspaceIds].sort();
  return (
    leftIds.length === rightIds.length &&
    leftIds.every((id, index) => id === rightIds[index])
  );
}

/** Reconciles Code Graph availability after a commit changed the choice. */
async function reconcileCommittedCodeGraph(): Promise<void> {
  try {
    await reconcileCodeGraphAvailability();
    cancelCodeGraphReconciliationRetry();
  } catch (error) {
    // The preference is already persisted, cached, and broadcast. Keep
    // reconciliation best-effort so a transient workspace read failure
    // cannot make that successful save appear to fail or skip the
    // remaining preference side effects.
    // eslint-disable-next-line no-console
    console.error('Failed to reconcile Code Graph availability:', error);
    scheduleCodeGraphReconciliationRetry();
  }
}

/** An own save's effects: those gated on "key in patch" keep that rule. */
function applyPreferenceSideEffects(
  normalized: PreferencesData,
  changedPreferences: Partial<PreferencesData>,
  pendingManagedDelegationPolicyUpdate?: PendingManagedDelegationPolicyUpdate,
  defaultBrowserRegistration?: Promise<unknown>,
): Promise<void> {
  return applyCommitSideEffects(
    {
      next: normalized,
      origin: 'own',
      patchKeys: new Set(Object.keys(changedPreferences)),
    },
    pendingManagedDelegationPolicyUpdate,
    defaultBrowserRegistration,
  );
}

/**
 * A commit's runtime and native effects. Own saves gate on "key in patch";
 * foreign commits on their changed keys (CAN-5722, slice F).
 */
async function applyCommitSideEffects(
  commit: PreferenceCommitEffectInput,
  pendingManagedDelegationPolicyUpdate?: PendingManagedDelegationPolicyUpdate,
  defaultBrowserRegistration?: Promise<unknown>,
): Promise<void> {
  const normalized = commit.next;
  const host = commitHost();
  applyImmediateHostEffects(commit, host.native);
  trackDetachedWork(() =>
    // Lazy: the default-model resolver reaches services that import this module.
    import('../agents/agent-default-model')
      .then(({ refreshCatalogAgentDefaults }) =>
        refreshCatalogAgentDefaults(
          commit.origin === 'own' ? commit.patchKeys : commit.changedKeys,
        ),
      )
      .catch(() => undefined),
  );
  getBrowserService()?.setLocalServersOnly(
    normalized.inAppBrowserLocalServersOnly === true,
  );
  updatePerformanceLimitsFromPreferences(normalized);
  const { getObservabilityService } = await import('../observability');
  getObservabilityService().setRetentionDays(normalized.auditRetentionDays);
  const { getTelemetrySyncService } =
    await import('../services/telemetry-sync-service');
  await getTelemetrySyncService().refreshScopeFromPreferences();
  updateCodexSessionIdleTimeoutMinutes(
    normalized.codexAppServerIdleTimeoutMinutes,
  );
  updateClaudeSessionIdleTimeoutMinutes(
    normalized.claudeSessionIdleTimeoutMinutes,
  );
  const { getCodexRuntimeService } = await import('../codex/runtime-service');
  getCodexRuntimeService()
    .admin()
    .updateIdleTimeoutMinutes(normalized.codexAppServerIdleTimeoutMinutes);
  if (pendingManagedDelegationPolicyUpdate)
    await pendingManagedDelegationPolicyUpdate.completion;
  if (commitTouches(commit, ['codexMaxConcurrentSubagents'])) {
    markCodexSessionsForNextTurnRecreation('all');
  }
  if (commitTouches(commit, ['codexMultiAgentAppAdvisorEnabled'])) {
    markCodexSessionsForNextTurnRecreation('app-advisor');
  }
  if (commitTouches(commit, ['codexMultiAgentWorktreeChatsEnabled'])) {
    markCodexSessionsForNextTurnRecreation('worktree');
  }
  if (commitTouches(commit, ['codexMultiAgentStandaloneChatsEnabled'])) {
    markCodexSessionsForNextTurnRecreation('standalone');
  }
  // The dedicated `global-focus-shortcut:update` IPC is the intended chord
  // writer; a plain save re-syncs the registration after it persisted.
  await applySettledHostEffects(commit, host, defaultBrowserRegistration);
  if (commitTouches(commit, ['aiCreditsRoutingMode'])) {
    // Keep the routing-mode cache warm with the just-saved value so the next
    // session spawn on any surface reflects the change immediately (the reader
    // is non-blocking and would otherwise serve a stale value until refresh).
    const { setAiCreditsRoutingModeCache } =
      await import('../agents/ai-credits-routing');
    setAiCreditsRoutingModeCache(normalized.aiCreditsRoutingMode ?? 'off');
  }
}

/** What this launch did with the renderer scheme, for the Settings row. */
function rendererCodeCacheSchemeLoadFields(): Pick<
  PreferencesLoadResult,
  | '__rendererCodeCacheSchemeActive'
  | '__rendererCodeCacheSchemeFellBack'
  | '__rendererCodeCacheSchemeSwitchBackFailed'
> {
  const status = getRendererCodeCacheSchemeStatus();
  return {
    ...(status.active ? { __rendererCodeCacheSchemeActive: true } : {}),
    ...(status.fellBack ? { __rendererCodeCacheSchemeFellBack: true } : {}),
    ...(status.switchBackFailed
      ? { __rendererCodeCacheSchemeSwitchBackFailed: true }
      : {}),
  };
}

const CLAUDE_MOD_REFUSAL =
  'Claude Mod consent and the kill switch must be changed with the typed Claude Mod admission service.';

/** The typed writer each key the save rules refuse belongs to. */
const PREFERENCE_SAVE_REFUSALS: Record<PreferenceSaveRefusedKey, string> = {
  approvalDefaults:
    'Approval defaults must be saved with setApprovalDefaultPreference.',
  claudeModAdmissions: CLAUDE_MOD_REFUSAL,
  claudeModsDisabled: CLAUDE_MOD_REFUSAL,
  accountProxyConnection:
    'The account proxy connection must be changed with accountProxy.connect.',
  copilotAccount:
    'The Copilot account must be changed with copilotConnection.connect.',
};

/**
 * The window's preferences save: commits a patch with every side effect and
 * broadcast that follow it. `precondition` runs inside the serialized commit
 * with the stored preferences and may throw to refuse the patch before
 * anything is written (CAN-6004).
 */
export async function savePreferencesPatch(
  input: PreferencesSavePatch,
  options?: PreferencesProjectionOptions,
  precondition?: (latest: PreferencesData) => void,
): Promise<PreferencesSaveResult | PreferencesData> {
  const { usageData: usageDataPatch, ...otherPreferences } = input;
  // The rules count the patch's keys as the side-effect view below holds
  // them: `usageData` only when it is set, even to `{}`.
  const saveRules = applyPreferenceSaveRules(
    usageDataPatch
      ? { ...otherPreferences, usageData: usageDataPatch }
      : otherPreferences,
  );
  if ('refused' in saveRules)
    throw new Error(PREFERENCE_SAVE_REFUSALS[saveRules.refused]);
  // Read only for the keys that need it: a client-local save (theme, zoom)
  // must not wait on the domain document (CAN-7991).
  let stored: Promise<PreferencesData> | undefined;
  const readStored = (): Promise<PreferencesData> =>
    (stored ??= readPreferencesFile());
  // Generic side-effect helpers consume a complete preference shape. The
  // serialized write below still merges only the explicitly changed keys.
  const preferences: Partial<PreferencesData> = {
    ...otherPreferences,
    ...(usageDataPatch
      ? {
          usageData: mergeUsageDataPatch(
            (await readStored()).usageData,
            usageDataPatch,
          ),
        }
      : {}),
  };
  // The shared rules drop main-owned records and shape-guarded keys a
  // renderer snapshot may hold an older copy of (CAN-7935).
  const rendererPatch = { ...preferences };
  for (const key of saveRules.dropped)
    Reflect.deleteProperty(rendererPatch, key);
  const previousCodeGraph = getCodeGraphPreferencesSnapshot();
  const proxy = getMcpHttpProxyService();
  if (
    typeof preferences.mcpProxyPort === 'number' &&
    preferences.mcpProxyPort !== (await readStored()).mcpProxyPort
  ) {
    try {
      await proxy.assertPortAvailable(preferences.mcpProxyPort);
    } catch {
      throw new Error('MCP proxy port is already in use. Choose another port.');
    }
  }
  let defaultBrowserRegistration: Promise<unknown> | undefined;
  let sequenceAtCommit = 0;
  const {
    previous: committedPrevious,
    next: normalized,
    domainUnread,
  } = await updatePreferencesFileWithPrevious(
    // Usage data merges per key: a partial patch must not turn the
    // flows it omits back on through their defaults.
    (latest) => {
      sequenceAtCommit = committedPreferencesSequence();
      precondition?.(latest);
      // Stop marking and sending native crashes before this opt-out writes.
      // Across restart, preference-write failures follow the shared consent
      // store, just as analytics does. CAN-6589 tracks opt-out durability.
      if (usageDataPatch?.errorReports === false)
        nativeCrashAnnotation.suspendForOptOut();
      return usageDataPatch
        ? {
            ...rendererPatch,
            usageData: mergeUsageDataPatch(latest.usageData, usageDataPatch),
          }
        : rendererPatch;
    },
    (committed) => {
      // Memory diagnostics and App Advisor access, in commit order: an
      // older overlapping save must not overwrite a newer value.
      applyCommittedPreferenceValues(committed);
      // The commit consumer applies the one-window switch and the stored
      // usage data for every domain commit, before this callback. A save
      // with no domain commit (client-local keys only) applies them here,
      // still before the window hears of the save.
      if (committedPreferencesSequence() === sequenceAtCommit) {
        applyOneWindowChoice(
          committed.oneWindowEnabled,
          arePreferencesUnconfirmed(),
        );
        // The full merged-and-normalized object, never the partial patch.
        // Applied on every commit: a commit proves the stored file is real
        // again, which also ends a fail-closed startup read of unreadable
        // preferences. Consent from the same committed object, in one
        // recompute: the accepting commit must never start a flow on the
        // stale defaults.
        getUsageDataPolicy().setStored(
          committed.usageData,
          usageDataConsentStateOf(committed),
        );
      }
      resumeCrashReportsAfterOptIn(
        usageDataPatch?.errorReports === true,
        committed,
      );
      if ('useAsSystemDefaultBrowser' in preferences) {
        defaultBrowserRegistration =
          nativeEffects().defaultBrowser.requestRegistration(
            committed.useAsSystemDefaultBrowser === true,
          );
      }
    },
    // The save rules above already ran on this caller's patch; it is never
    // classified (CAN-5722).
    { route: 'caller' },
  );
  const saveGeneration = ++preferencesSaveGeneration;
  const commit: PreferenceCommitChange = {
    previous: committedPrevious,
    next: normalized,
    origin: 'own',
    patchKeys: new Set(Object.keys(preferences)),
  };
  // Started immediately after commit, before any profile sync or broadcast.
  const pendingManagedDelegationPolicyUpdate = beginCommitEffects(commit);
  // Client-local commit effects: the zoom here and the native theme below
  // follow this save's client-local values. No domain or daemon commit
  // drives them (CAN-5722, slice F).
  if (committedPrevious.uiScale !== normalized.uiScale) {
    // Interface scale is a uniform zoom owned by main (`lib/ui-zoom.ts`).
    // Fan the new factor out to every open window (main, App Advisor,
    // panel pull-outs) right after the write commits, ahead of the slower
    // side effects and the renderer broadcast below, so the slider feels
    // immediate.
    applyUiZoomToAllWindows(uiScaleToZoomFactor(normalized.uiScale));
  }
  await applyCommitConnectionEffects(commit, preferences);
  // Apply the persisted native appearance before any asynchronous
  // reconciliation or renderer broadcast. This keeps renderer
  // `prefers-color-scheme` updates pinned to an explicit Light/Dark choice
  // throughout the save. Native window backgrounds follow each renderer's
  // published theme color instead (see trackAppWindowBackground).
  nativeTheme.themeSource = getNativeThemeSource(normalized.colorMode);
  // A client-only save on a domain document the port has not read, whose
  // domain keys are defaults. Nothing below may apply or broadcast them
  // (see `updatePreferencesFileWithPrevious`), and the reply says so: no
  // saved domain state exists to send instead.
  if (domainUnread === true) {
    const unconfirmed: Pick<PreferencesSaveResult, '__preferencesUnconfirmed'> =
      { __preferencesUnconfirmed: true };
    return options?.view === 'persisted'
      ? { ...normalized, ...unconfirmed }
      : { ...preferencesSaveResult(normalized), ...unconfirmed };
  }
  setCodeGraphPreferences(normalized.codeGraph);
  if (
    !pendingManagedDelegationPolicyUpdate &&
    saveGeneration === preferencesSaveGeneration
  ) {
    broadcastPreferencesSynced(preferencesSaveResult(normalized));
  }
  if (
    normalized.codeGraph !== undefined &&
    !hasSameEffectiveCodeGraphPreference(
      previousCodeGraph,
      normalized.codeGraph,
    )
  ) {
    await reconcileCommittedCodeGraph();
  }
  await applyCommitSideEffects(
    commit,
    pendingManagedDelegationPolicyUpdate,
    defaultBrowserRegistration,
  );
  const latest =
    pendingManagedDelegationPolicyUpdate ||
    saveGeneration !== preferencesSaveGeneration
      ? await latestPreferencesSaveResult()
      : preferencesSaveResult(normalized);
  const saved: PreferencesSaveResult = latest;
  if (
    pendingManagedDelegationPolicyUpdate &&
    pendingManagedDelegationPolicyUpdate.generation ===
      managedDelegationPolicyGeneration
  ) {
    // The effective mode and final revocation status must travel together
    // so every renderer reflects the process-authoritative result.
    broadcastPreferencesSynced(saved);
  }
  return options?.view === 'persisted' ? normalized : saved;
}

export function registerPreferenceHandlers(
  effects: PreferenceNativeEffects = electronPreferenceNativeEffects,
): void {
  registeredNativeEffects = effects;
  registerPreferenceCommitHost(commitHost());
  managedDelegationRevocationIncomplete = false;
  preferencesSaveGeneration = 0;
  managedDelegationPolicyGeneration = 0;
  latestManagedDelegationPolicyCompletion = Promise.resolve();
  registerIpcHandler(
    IPC_CHANNELS.preferencesLoad,
    async (_event, options?: PreferencesProjectionOptions) => {
      const loaded = await readPreferencesFileForRenderer(options);
      if (options?.view === 'persisted') return loaded;
      return {
        ...loaded,
        repeatTaskAutomationSuggestionsEnabled: loaded.suggestions.enabled,
        managedDelegationMode: resolveManagedDelegationMode(
          loaded.managedDelegationMode,
        ),
        ...(managedDelegationRevocationIncomplete
          ? { __managedDelegationRevocationIncomplete: true }
          : {}),
        ...rendererCodeCacheSchemeLoadFields(),
      };
    },
  );
  registerIpcHandler(IPC_CHANNELS.preferencesAcknowledgeLoadError, () => {
    acknowledgePreferencesLoadError();
    return Promise.resolve();
  });

  registerIpcHandler(IPC_CHANNELS.preferencesCreatePrimaryDataDir, async () => {
    // Only this explicit action writes the adoption marker (CAN-2271); its
    // presence is all that is read (install-data detection). The first W5
    // commit on this root creates the workspace index.
    const primaryDataDir = getPrimaryBrandDataDir();
    await createDirectoryDurably(primaryDataDir, { dataRoot: primaryDataDir });
    await writeFileAtomically(
      join(primaryDataDir, DATA_DIR_ADOPTION_MARKER_FILENAME),
      JSON.stringify(
        { version: 1, adoptedAt: new Date().toISOString() },
        null,
        2,
      ),
      {
        encoding: 'utf8',
        durable: true,
        admittedWriter: DATA_DIR_ADOPTION_MARKER_WRITER,
      },
    );
    return getCreatedPrimaryDataDirStatus();
  });

  registerIpcHandler(
    IPC_CHANNELS.preferencesOpenMemoryDir,
    async (_event, workspaceId?: unknown): Promise<void> => {
      if (workspaceId !== undefined) {
        if (typeof workspaceId !== 'string') {
          throw new Error('Invalid local memory project id.');
        }
        validateId(workspaceId, 'workspaceId');
      }
      const memoryDir = localMemoryScopeDir(
        workspaceId === undefined
          ? { scope: 'user' }
          : { scope: 'workspace', workspaceId },
      );
      await mkdir(memoryDir, { recursive: true });
      const error = await shell.openPath(memoryDir);
      if (error !== '') {
        throw new Error(`Could not open memory folder: ${error}`);
      }
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.preferencesImportClaudeMemory,
    async (
      _event,
      request: LocalMemoryImportRequest,
    ): Promise<LocalMemoryImportResult> => {
      if (!isRecord(request)) {
        throw new Error('Invalid local memory import request.');
      }
      if (request.workspaceId !== undefined) {
        if (typeof request.workspaceId !== 'string') {
          throw new Error('Invalid local memory import project id.');
        }
        validateId(request.workspaceId, 'workspaceId');
      }
      return enqueueManualLocalMemoryImportBatch(request.workspaceId);
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.preferencesSave,
    (
      event,
      preferences: PreferencesSavePatch,
      options?: PreferencesProjectionOptions,
    ) => {
      if (resolveRemoteBridgeSender(event.sender) === null)
        return savePreferencesPatch(preferences, options);
      // The one-window switch belongs to the computer in front of the
      // person (CAN-7755): a paired computer's save never changes it.
      const fromPairedComputer = { ...preferences };
      delete fromPairedComputer.oneWindowEnabled;
      return savePreferencesPatch(fromPairedComputer, options);
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.telemetrySharingEnableForFeature,
    async (_event, request: unknown): Promise<DataSharingOptInResult> => {
      if (!isRecord(request) || !isDataSharingOptInFeature(request.feature))
        return { status: 'refused', reason: 'invalid-request' };
      const feature = request.feature;
      // `null` asks for the personal ("Just me") audience, which only shared
      // projects support: personal work has no organization to share with.
      const personal = request.organizationId === null;
      if (personal && feature !== 'shared-projects')
        return { status: 'refused', reason: 'invalid-request' };
      const organizationId = personal
        ? null
        : normalizeUuid(request.organizationId);
      if (!personal && !organizationId)
        return { status: 'refused', reason: 'invalid-request' };
      const changedScopes: TelemetryScopeKey[] = [];
      const skippedScopes: TelemetryScopeKey[] = [];
      const requireAuthority =
        async (): Promise<TelemetryEnforcement | null> => {
          try {
            if (organizationId !== null)
              return await requireDataSharingOptInAuthority(organizationId);
            await requireDataSharingPersonalOptInAuthority();
            return null;
          } catch (error) {
            if (error instanceof DataSharingOptInError) throw error;
            throw new DataSharingOptInError('account-unavailable');
          }
        };
      try {
        await requireAuthority();
        await updatePreferencesFile(
          async (previous) => {
            changedScopes.length = 0;
            skippedScopes.length = 0;
            if (peekPreferencesLoadError() !== null)
              throw new DataSharingOptInError('preferences-unavailable');
            const enforcement = await requireAuthority();
            if (enforcement?.prohibited.metadata)
              throw new DataSharingOptInError('organization-prohibited');
            const telemetrySharing = { ...previous.telemetrySharing };
            for (const scope of DATA_SHARING_OPT_IN_SCOPES[feature]) {
              if (enforcement === null) {
                // Personal: raise Off to Just me only; never lower a broader
                // audience the user already chose.
                if (telemetrySharing[scope] === 'off') {
                  changedScopes.push(scope);
                  telemetrySharing[scope] = 'private';
                }
              } else if (enforcement.prohibited[scope]) {
                skippedScopes.push(scope);
              } else {
                if (telemetrySharing[scope] !== 'organization')
                  changedScopes.push(scope);
                telemetrySharing[scope] = 'organization';
              }
            }
            return {
              telemetrySharing,
              ...(changedScopes.length
                ? {
                    dataSharingOptInHistory: [
                      ...(previous.dataSharingOptInHistory ?? []),
                      {
                        enabledAt: new Date().toISOString(),
                        sharing: { ...previous.telemetrySharing },
                      },
                    ],
                  }
                : {}),
            };
          },
          () => {
            ++preferencesSaveGeneration;
          },
        );
      } catch (error) {
        return {
          status: 'refused',
          reason:
            error instanceof DataSharingOptInError
              ? error.reason
              : 'save-failed',
        };
      }
      // Persistence is complete. A retry also applies effects on a no-op write.
      const normalized = await readLatestPreferencesFile();
      broadcastPreferencesSynced(preferencesSaveResult(normalized));
      broadcastPreferencesChanged();
      try {
        await applyPreferenceSideEffects(normalized, {
          telemetrySharing: normalized.telemetrySharing,
        });
        return { status: 'saved', changedScopes, skippedScopes };
      } catch {
        const persisted = await readLatestPreferencesFile();
        broadcastPreferencesSynced(preferencesSaveResult(persisted));
        return {
          status: 'saved-application-failed',
          changedScopes,
          skippedScopes,
        };
      }
    },
  );
  registerIpcHandler(
    IPC_CHANNELS.telemetrySharingDismissOptInHint,
    async (
      _event,
      request: unknown,
    ): Promise<DataSharingOptInDismissResult> => {
      if (!isRecord(request) || !isDataSharingOptInFeature(request.feature))
        return { status: 'refused', reason: 'invalid-request' };
      const feature = request.feature;
      try {
        await updatePreferencesFile(
          (previous) => {
            if (peekPreferencesLoadError() !== null)
              throw new DataSharingOptInError('preferences-unavailable');
            return {
              dataSharingOptInHints: {
                ...previous.dataSharingOptInHints,
                [feature]: { dismissedAt: new Date().toISOString() },
              },
            };
          },
          () => {
            ++preferencesSaveGeneration;
          },
        );
        broadcastPreferencesSynced(
          preferencesSaveResult(await readLatestPreferencesFile()),
        );
        broadcastPreferencesChanged();
        return { status: 'saved' };
      } catch (error) {
        return {
          status: 'refused',
          reason:
            error instanceof DataSharingOptInError &&
            error.reason === 'preferences-unavailable'
              ? 'preferences-unavailable'
              : 'save-failed',
        };
      }
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.preferencesSetPipelineDisabled,
    async (_event, request: unknown) => {
      const { id, disabled } = normalizeSetPipelineDisabledRequest(request);
      // Core records it for any source, in order with the definition's
      // writes; loaded here, as the dispatch module reaches the pipeline store.
      const { setPipelineDefinitionEnabled } =
        await import('../canopy-runtime/pipeline-definition-dispatch');
      const normalized =
        (await setPipelineDefinitionEnabled(id, !disabled)) ??
        (await readPreferencesFile());
      ++preferencesSaveGeneration;
      broadcastPreferencesSynced(preferencesSaveResult(normalized));
      await applyPreferenceSideEffects(normalized, {
        disabledPipelineIds: normalized.disabledPipelineIds,
      });
      return normalized;
    },
  );

  // Narrow reads for controllers that are not served `preferences:load`
  // (CAN-7434): projections of the read-only `core.config.get` namespaces.
  // Tunneled invokes use the same local caller; which controller may invoke
  // a channel is the host's channel authorization, not this caller.
  registerIpcHandler<[], OnboardingTipsState>(
    IPC_CHANNELS.preferencesLoadOnboardingTips,
    async () => {
      const state = parseOnboardingTipsState(
        await readPreferenceConfigNamespace('onboardingTips'),
      );
      if (state === null) throw new Error('Invalid onboarding tips state.');
      return state;
    },
  );

  registerIpcHandler<[], SuggestionsState>(
    IPC_CHANNELS.preferencesLoadSuggestions,
    async () => {
      const state = parseSuggestionsState(
        await readPreferenceConfigNamespace('suggestions'),
      );
      if (state === null) throw new Error('Invalid suggestions state.');
      return state;
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.preferencesUpdateSuggestions,
    async (_event, request: unknown) => {
      const saved = await updateSuggestionsPreferences(request);
      broadcastCommittedPreferences(saved);
      return saved.suggestions;
    },
  );

  // Onboarding tips (CAN-4904): applied to the latest stored record inside the
  // serialized write, like the Portal adapter, so neither surface can drop a
  // dismissal the other saved meanwhile.
  registerIpcHandler(
    IPC_CHANNELS.preferencesUpdateOnboardingTips,
    async (_event, request: unknown): Promise<OnboardingTipsState> => {
      const update = parseOnboardingTipsUpdate(request);
      if (update === null) {
        throw new Error('Invalid onboarding tip update.');
      }
      let dismissed: OnboardingTipDismissals = {};
      const normalized = await updatePreferencesFile((previous) => {
        dismissed = applyOnboardingTipsUpdate(
          normalizeOnboardingTipDismissals(previous.onboardingTipsDismissed),
          update,
          new Date(),
        );
        return { onboardingTipsDismissed: dismissed };
      });
      broadcastCommittedPreferences(normalized);
      if (
        update.action === 'dismiss' &&
        update.tipId === CLAUDE_CONNECTOR_NOTICE_DISMISSAL_ID
      ) {
        sendToWindow(getMainWindow(), IPC_CHANNELS.preferencesChanged);
      }
      return { dismissed };
    },
  );

  registerIpcHandler<[SetApprovalDefaultPreferenceRequest], PreferencesData>(
    IPC_CHANNELS.preferencesSetApprovalDefault,
    async (_event, request: unknown) => {
      const { surface, mode } = normalizeSetApprovalDefaultRequest(request);
      // Settings and in-chat changes share one per-surface sequence. Only a
      // successfully committed Settings choice supersedes an older runtime
      // transition that is still applying in another chat.
      const approvalDefaultIntent = beginApprovalDefaultIntent(surface);
      // Refuse to merge into state we could not actually read. On a degraded
      // read `readPreferencesFile()` returns DEFAULT_PREFERENCES (all Full
      // Access), so merging the one changed key into it would durably persist
      // Full Access for the two surfaces the user never touched. A later
      // committed read would then treat that escalated object as authoritative.
      // `rememberApprovalDefaultForSurface` guards the same way.
      //
      // Unlike that best-effort write-back this is a direct user action, so it
      // throws instead of silently skipping: Settings can surface the failure
      // rather than showing a change that was never saved.
      const endPendingWrite = beginPendingApprovalDefaultWrite(surface);
      try {
        // Merge inside the write queue and touch only the one key the user
        // changed. `savePreferences` with a whole `approvalDefaults` object
        // writes a snapshot taken when Settings mounted, which clobbers a
        // concurrent in-chat write-back — and, when `loadPreferences()` failed
        // and that snapshot came from a synthetic fallback, silently escalates
        // the two surfaces the user never touched (CAN-3055).
        const normalized = await updatePreferencesFile(
          (previous) => {
            // Check after the write queue's authoritative re-read. Checking
            // before entering the queue would leave a gap where the file could
            // become unreadable before this updater receives its snapshot.
            if (peekPreferencesLoadError() !== null) {
              throw new Error(
                'Preferences could not be read; the approval default was not changed.',
              );
            }
            const approvalDefaults = {
              ...previous.approvalDefaults,
              [surface]: mode,
            };
            return { approvalDefaults };
          },
          // Publish intent authority while the preferences queue is still
          // held. A queued older chat write then observes this successful
          // Settings commit before it decides whether it is stale.
          () => commitApprovalDefaultIntent(surface, approvalDefaultIntent),
        );
        broadcastPreferencesSynced(normalized, projectPreferencesForRuntime);
        return normalized;
      } finally {
        endPendingWrite();
      }
    },
  );
}

/**
 * A read-only preferences namespace through `core.config.get` on the desktop
 * dispatcher. Loaded on use, so this module's static graph stays as it was.
 */
async function readPreferenceConfigNamespace(
  namespace: 'onboardingTips' | 'suggestions',
): Promise<unknown> {
  const [
    { CONFIG_GRANTS },
    { getActiveDesktopRuntime },
    { LOCAL_DESKTOP_AUTHORITY_ID },
    { preserveRuntimeCauseError },
  ] = await Promise.all([
    import('@canopy/protocol/canopy-core'),
    import('../canopy-runtime/desktop-runtime'),
    import('../canopy-runtime/desktop-runtime-identity'),
    import('../canopy-runtime/runtime-cause-error'),
  ]);
  const document = await preserveRuntimeCauseError(
    getActiveDesktopRuntime().query(
      'core.config.get',
      { namespace },
      {
        caller: {
          principalId: 'local-desktop-user',
          clientInstanceId: 'desktop-main-preferences',
          authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
          interfaceKind: 'desktop',
          grants: [CONFIG_GRANTS.read],
        },
      },
    ),
  );
  return document.value;
}
