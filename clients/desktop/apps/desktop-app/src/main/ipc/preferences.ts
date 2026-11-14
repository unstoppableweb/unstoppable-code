import { applyGlobalPluginDefaultsSaveRule } from '@canopy/desktop-shared/node/preferences/global-plugin-defaults';
import { applyTerminalSettingsSaveRule } from '@canopy/desktop-shared/node/preferences/terminal-settings';
import {
  applyOnboardingTipsUpdate,
  normalizeOnboardingTipDismissals,
  parseOnboardingTipsUpdate,
  type OnboardingTipDismissals,
  type OnboardingTipsState,
} from '@canopy/protocol/onboarding-tips';
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
import { notifyManagedDelegationLifetimePreferencesChanged } from '../agents/delegation/lifetime-status';
import { notifyDesktopInventoryChanged } from '../services/desktop-inventory-sync-signals';
import { personalCatalogPreferenceChanged } from '../services/personal-catalog-sync-host';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nativeTheme, shell } from 'electron';
import { isCuratedCatalogKey } from '@canopy/protocol/plugin-catalog';
import {
  IPC_CHANNELS,
  initCursorModels,
  type PreferencesData,
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
import {
  setCloseToTrayPreference,
  syncActivationTray,
} from '../lifecycle/background-presence';
import { requestActivationRecompute } from '../notifications/campaigns/scheduler';
import { getWakeLockService } from '../power/wake-lock-service';
import { getUsageDataPolicy } from '../lib/usage-data-policy';
import { nativeCrashAnnotation } from '../lib/native-crash-policy';
import { getMemoryDiagnosticsService } from '../memory-diagnostics';
import { getBrowserService } from '../browser/browser-service-registry';
import { registerIpcHandler } from './register';
import { getRendererCodeCacheSchemeStatus } from '../renderer-origin/renderer-code-cache-scheme-status';
import { syncGlobalFocusShortcutFromPreferences } from './global-focus-shortcut';
import { broadcastPreferencesSynced } from '../lib/preferences-broadcast';
import { applyUiZoomToAllWindows, uiScaleToZoomFactor } from '../lib/ui-zoom';
import { setRemoteControlEnabled } from '../lib/remote-control-preference';
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
import { notifyPortalStructureChanged } from '../portal/portal-event-bus';
import { getDefaultBrowserRegistrationService } from '../browser/default-browser-registration';
import {
  detachedWorkCallback,
  trackDetachedWork,
} from '@canopy/desktop-shared/node/lib/detached-work';

const STORED_PIPELINE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
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
  normalized: PreferencesData,
  changedPreferences: Partial<PreferencesData>,
): PendingManagedDelegationPolicyUpdate | undefined {
  if ('managedDelegationMaxDepth' in changedPreferences) {
    updateManagedDelegationMaxDepth(normalized.managedDelegationMaxDepth);
  }
  if ('managedDelegationMaxConcurrent' in changedPreferences) {
    updateManagedDelegationMaxConcurrent(
      normalized.managedDelegationMaxConcurrent,
    );
  }
  if ('managedDelegationLifetimeLimit' in changedPreferences) {
    updateManagedDelegationLifetimeLimit(
      normalized.managedDelegationLifetimeLimit,
    );
  }
  if (!('managedDelegationMode' in changedPreferences)) return undefined;
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

let defaultBrowserRegistrationQueue: Promise<void> = Promise.resolve();

function enqueueDefaultBrowserRegistration(enabled: boolean): Promise<unknown> {
  const operation = defaultBrowserRegistrationQueue.then(() =>
    getDefaultBrowserRegistrationService().apply({
      enabled,
      promptForWindowsSettings: enabled,
    }),
  );
  defaultBrowserRegistrationQueue = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
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

async function applyPreferenceSideEffects(
  normalized: PreferencesData,
  changedPreferences: Partial<PreferencesData>,
  pendingManagedDelegationPolicyUpdate?: PendingManagedDelegationPolicyUpdate,
  defaultBrowserRegistration?: Promise<unknown>,
): Promise<void> {
  getWakeLockService().setEnabled(normalized.keepSystemAwakeWhileAgentsActive);
  trackDetachedWork(() =>
    // Lazy: the default-model resolver reaches services that import this module.
    import('../agents/agent-default-model')
      .then(({ refreshCatalogAgentDefaults }) =>
        refreshCatalogAgentDefaults(changedPreferences),
      )
      .catch(() => undefined),
  );
  getBrowserService()?.setLocalServersOnly(
    normalized.inAppBrowserLocalServersOnly === true,
  );
  updatePerformanceLimitsFromPreferences(normalized);
  setCloseToTrayPreference(normalized.closeToTray);
  // Create or destroy the tray to match, and fall back to disabling
  // close-to-tray if creation fails -- a resident app with no window and no
  // tray icon is unreachable except through Task Manager.
  if (!syncActivationTray()) {
    setCloseToTrayPreference(false);
  }
  // Notification preferences are an event-driven suppression input: the
  // scheduler no longer polls for `notifications-disabled`/`category-disabled`,
  // so enabling them has to re-arm it here.
  //
  // Gated on the three keys the scheduler actually reads. Unconditional would be
  // worse than the poll it replaced: ~101 renderer save sites include
  // drag/resize-frequency ones, and each evaluation costs an uncached
  // preferences read plus, per due campaign, a checklist derivation that does
  // its own filesystem reads.
  if (
    'osNotifications' in changedPreferences ||
    'activationQuietHours' in changedPreferences ||
    'promotionalNotifications' in changedPreferences
  ) {
    requestActivationRecompute();
  }
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
  if ('codexMaxConcurrentSubagents' in changedPreferences) {
    markCodexSessionsForNextTurnRecreation('all');
  }
  if ('codexMultiAgentAppAdvisorEnabled' in changedPreferences) {
    markCodexSessionsForNextTurnRecreation('app-advisor');
  }
  if ('codexMultiAgentWorktreeChatsEnabled' in changedPreferences) {
    markCodexSessionsForNextTurnRecreation('worktree');
  }
  if ('codexMultiAgentStandaloneChatsEnabled' in changedPreferences) {
    markCodexSessionsForNextTurnRecreation('standalone');
  }
  if (
    'globalFocusShortcutEnabled' in changedPreferences ||
    'globalFocusShortcut' in changedPreferences
  ) {
    // The dedicated `global-focus-shortcut:update` IPC is the intended writer
    // (it registers with the OS before saving). A plain preference save has
    // already persisted and broadcast, so this re-syncs the registration and
    // writes the previous working chord back if the saved one was refused;
    // the corrective broadcast follows the optimistic one within the same
    // save, which renderer mirrors tolerate. A committed save must not look
    // failed because the corrective write did.
    try {
      await syncGlobalFocusShortcutFromPreferences(normalized);
    } catch {
      // The registration state is still broadcast on the next status push.
    }
  }
  if ('useAsSystemDefaultBrowser' in changedPreferences) {
    // Registration is reconciled after persistence. OS refusal must not make
    // the committed preference save look failed; verified status is exposed
    // separately for Settings to render recovery guidance.
    try {
      await (defaultBrowserRegistration ??
        enqueueDefaultBrowserRegistration(
          normalized.useAsSystemDefaultBrowser === true,
        ));
    } catch {
      // Keep the saved preference and surface the service's status instead.
    }
  }
  if ('aiCreditsRoutingMode' in changedPreferences) {
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

/**
 * The window's preferences save: commits a patch with every side effect and
 * broadcast that follow it. `precondition` runs inside the serialized commit
 * with the stored preferences and may throw to refuse the patch before
 * anything is written (CAN-6004).
 */
export async function savePreferencesPatch(
  preferences: Partial<PreferencesData>,
  options?: PreferencesProjectionOptions,
  precondition?: (latest: PreferencesData) => void,
): Promise<PreferencesSaveResult | PreferencesData> {
  if (Object.prototype.hasOwnProperty.call(preferences, 'approvalDefaults')) {
    throw new Error(
      'Approval defaults must be saved with setApprovalDefaultPreference.',
    );
  }
  if (
    Object.prototype.hasOwnProperty.call(preferences, 'claudeModAdmissions') ||
    Object.prototype.hasOwnProperty.call(preferences, 'claudeModsDisabled')
  ) {
    throw new Error(
      'Claude Mod consent and the kill switch must be changed with the typed Claude Mod admission service.',
    );
  }
  if (
    Object.prototype.hasOwnProperty.call(preferences, 'accountProxyConnection')
  ) {
    throw new Error(
      'The account proxy connection must be changed with accountProxy.connect.',
    );
  }
  if (Object.prototype.hasOwnProperty.call(preferences, 'copilotAccount')) {
    throw new Error(
      'The Copilot account must be changed with copilotConnection.connect.',
    );
  }
  // Main owns native account tracking (CAN-4200); a renderer copy can be
  // older than main's latest record, so it never overwrites it.
  const rendererPatch = { ...preferences };
  // A wider Settings snapshot may predate a disconnect in another window.
  // Only the explicit one-key connection intent may change this choice.
  if (
    Object.keys(preferences).length !== 1 ||
    typeof preferences.googleSubscriptionDisconnected !== 'boolean'
  ) {
    delete rendererPatch.googleSubscriptionDisconnected;
  }
  // Main's Copilot connection owns the flag with its account pin (CAN-4880).
  // Only the dedicated updateSuggestions command changes the master/dismissals.
  // A generic Settings snapshot may predate a toggle in another window.
  delete rendererPatch.suggestions;
  // An older controller sends this exact one-key intent. A multi-field
  // snapshot may be stale and cannot change the committed master.
  const legacySuggestionIntent =
    Object.keys(preferences).length === 1 &&
    typeof preferences.repeatTaskAutomationSuggestionsEnabled === 'boolean';
  if (!legacySuggestionIntent)
    delete rendererPatch.repeatTaskAutomationSuggestionsEnabled;
  delete rendererPatch.copilotEnabled;
  delete rendererPatch.disabledInstalledItems;
  delete rendererPatch.parkedCodexPlugins;
  delete rendererPatch.pendingInstalledItemUninstalls;
  delete rendererPatch.nativeProviderAccounts;
  // Rule mutations belong to the approval authority, not renderer snapshots.
  delete rendererPatch.globalApprovalRules;
  // Follows the proxy's own strategy, which accountProxy.setRoutingStrategy
  // changes first.
  delete rendererPatch.accountProxyLocalRoutingStrategy;
  // Shells and presets belong to core.terminal.settings (CAN-4148). An
  // older controller sends this exact two-key intent; a wider snapshot may
  // be stale and never changes them.
  applyTerminalSettingsSaveRule(preferences, rendererPatch);
  // Global plugin defaults also change through core.catalog (CAN-4123).
  // Every writer sends them as a one-key save; a wider snapshot may hold
  // a copy read before that change and never puts it back (CAN-5766).
  applyGlobalPluginDefaultsSaveRule(preferences, rendererPatch);
  const previous = await readPreferencesFile();
  const previousCodeGraph = getCodeGraphPreferencesSnapshot();
  const proxy = getMcpHttpProxyService();
  if (
    typeof preferences.mcpProxyPort === 'number' &&
    preferences.mcpProxyPort !== previous.mcpProxyPort
  ) {
    try {
      await proxy.assertPortAvailable(preferences.mcpProxyPort);
    } catch {
      throw new Error('MCP proxy port is already in use. Choose another port.');
    }
  }
  let defaultBrowserRegistration: Promise<unknown> | undefined;
  const { previous: committedPrevious, next: normalized } =
    await updatePreferencesFileWithPrevious(
      // Usage data merges per key: a partial patch must not turn the
      // flows it omits back on through their defaults.
      (latest) => {
        precondition?.(latest);
        // Stop marking and sending native crashes before this opt-out writes.
        // Across restart, preference-write failures follow the shared consent
        // store, just as analytics does. CAN-6589 tracks opt-out durability.
        if (rendererPatch.usageData?.errorReports === false)
          nativeCrashAnnotation.suspendForOptOut();
        return rendererPatch.usageData
          ? {
              ...rendererPatch,
              usageData: {
                ...latest.usageData,
                ...rendererPatch.usageData,
              },
            }
          : rendererPatch;
      },
      (committed) => {
        // Apply in commit order: an older overlapping save must not
        // re-enable diagnostics after a newer save turned them off.
        getMemoryDiagnosticsService().setEnabled(
          committed.memoryDiagnosticsEnabled,
        );
        // Apply inside the serialized commit so an older save that
        // finishes its side effects later cannot overwrite a newer value.
        setAppAdvisorProjectAgentAccess(committed.appAdvisorProjectAgentAccess);
        // The full merged-and-normalized object, never the partial patch,
        // applied in commit order like the values above. Applied on every
        // commit: a commit proves the stored file is real again, which
        // also ends a fail-closed startup read of unreadable preferences.
        getUsageDataPolicy().setPreferences(committed.usageData);
        if (
          rendererPatch.usageData?.errorReports === true &&
          committed.usageData.errorReports
        )
          nativeCrashAnnotation.resumeAfterOptIn();
        if ('useAsSystemDefaultBrowser' in preferences) {
          defaultBrowserRegistration = enqueueDefaultBrowserRegistration(
            committed.useAsSystemDefaultBrowser === true,
          );
        }
      },
    );
  const saveGeneration = ++preferencesSaveGeneration;
  // updateManagedDelegationPolicy changes the process-authoritative
  // admission state synchronously before its cancellation promise can
  // yield. Start it immediately after commit so no profile sync,
  // broadcast, or other side effect can leave old sessions launchable.
  const pendingManagedDelegationPolicyUpdate =
    beginManagedDelegationPolicyUpdate(normalized, preferences);
  if ('managedDelegationLifetimeLimit' in preferences)
    notifyManagedDelegationLifetimePreferencesChanged();
  if (
    committedPrevious.personalWorkspaceCatalogSync !==
    normalized.personalWorkspaceCatalogSync
  ) {
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
  if (committedPrevious.uiScale !== normalized.uiScale) {
    // Interface scale is a uniform zoom owned by main (`lib/ui-zoom.ts`).
    // Fan the new factor out to every open window (main, App Advisor,
    // panel pull-outs) right after the write commits, ahead of the slower
    // side effects and the renderer broadcast below, so the slider feels
    // immediate.
    applyUiZoomToAllWindows(uiScaleToZoomFactor(normalized.uiScale));
  }
  setRemoteControlEnabled(normalized.remoteControlEnabled === true);
  if (
    committedPrevious.copilotEnabled !== normalized.copilotEnabled ||
    JSON.stringify(committedPrevious.copilotAccount) !==
      JSON.stringify(normalized.copilotAccount)
  ) {
    const { revokeCopilotRuntimes } = await import('../copilot/connection');
    await revokeCopilotRuntimes();
    broadcastModelRegistryUpdated();
    notifyPortalStructureChanged();
  }
  if (
    committedPrevious.accountProxyEnabled !== normalized.accountProxyEnabled ||
    committedPrevious.accountProxyKeepChatOnOneAccount !==
      normalized.accountProxyKeepChatOnOneAccount ||
    committedPrevious.accountProxyRouteClaude !==
      normalized.accountProxyRouteClaude ||
    committedPrevious.accountProxyRouteCodex !==
      normalized.accountProxyRouteCodex ||
    committedPrevious.accountProxyLocalStartWithApp !==
      normalized.accountProxyLocalStartWithApp
  ) {
    const { notifyAccountProxyPreferencesChanged } =
      await import('./account-proxy');
    notifyAccountProxyPreferencesChanged();
  }
  if (committedPrevious.opencodeEnabled !== normalized.opencodeEnabled) {
    const { revokeOpenCodeRuntimes } = await import('../opencode/connection');
    await revokeOpenCodeRuntimes();
    broadcastModelRegistryUpdated();
    notifyPortalStructureChanged();
  }
  if (committedPrevious.cursorEnabled !== normalized.cursorEnabled) {
    // Preferences can be changed without using the Connect/Disconnect UI
    // — `harnesses-settings.spec.mjs` exercises exactly this generic
    // `preferencesSave` path with `{ cursorEnabled: false }`. Both
    // directions refresh and notify below; only disabling additionally
    // withdraws the cached selectable models, since enabling here (with
    // no accompanying sign-in) has no catalog to populate.
    if (!normalized.cursorEnabled) {
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
    // `broadcastModelRegistryUpdated` above only reaches desktop
    // renderer windows. An already-open Portal session projects
    // `providerAvailability.cursor` from the same cached preflight, so
    // it needs this separate push too, matching the Connect/Disconnect
    // handlers in `ipc/cursor-connection.ts`.
    notifyPortalStructureChanged();
  }
  if (
    'globalPluginSelections' in rendererPatch &&
    !pluginSelectionsEqual(
      committedPrevious.globalPluginSelections,
      normalized.globalPluginSelections,
    )
  ) {
    // Sessions on overlay-participating chat surfaces lazily recreate on
    // their next send; new sends and terminals resolve against the
    // updated global defaults when they start.
    bumpGlobalPluginDefaultsRevision();
    // The installed-item statuses derive from these selections, so the
    // synced snapshot the web settings read must follow (CAN-6037).
    notifyDesktopInventoryChanged(['installed_items']);
  }
  recordOnboardingProfileTelemetry({
    previous: committedPrevious,
    next: normalized,
  });
  try {
    await syncOnboardingProfilePreferences(normalized, preferences);
  } catch (error) {
    // The local preference write has already committed. Cloud profile sync
    // is best-effort and must never make a successful onboarding step look
    // failed or roll back the user's local answer.
    // eslint-disable-next-line no-console
    console.warn('Failed to sync onboarding profile to the cloud:', error);
  }
  // Apply the persisted native appearance before any asynchronous
  // reconciliation or renderer broadcast. This keeps macOS window
  // materials and renderer `prefers-color-scheme` updates pinned to an
  // explicit Light/Dark choice throughout the save.
  nativeTheme.themeSource = getNativeThemeSource(normalized.colorMode);
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
  await applyPreferenceSideEffects(
    normalized,
    preferences,
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

export function registerPreferenceHandlers(): void {
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
    // The adoption marker alone makes data-aware resolution select this
    // directory over a data-bearing fallback after restart; no automatic
    // startup path writes it. The first W5 commit on this root creates the
    // workspace index.
    const primaryDataDir = getPrimaryBrandDataDir();
    await mkdir(primaryDataDir, { recursive: true });
    await writeFile(
      join(primaryDataDir, DATA_DIR_ADOPTION_MARKER_FILENAME),
      JSON.stringify(
        { version: 1, adoptedAt: new Date().toISOString() },
        null,
        2,
      ),
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
      _event,
      preferences: Partial<PreferencesData>,
      options?: PreferencesProjectionOptions,
    ) => savePreferencesPatch(preferences, options),
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
