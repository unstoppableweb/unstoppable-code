import {
  mergeGitHubStarPromptRecords,
  mergePlanModeHintRecords,
  normalizeGitHubStarPromptRecord,
  normalizePlanModeHintRecord,
} from '@canopy/protocol/onboarding';
import {
  compareReleaseVersions,
  parseReleaseVersion,
} from '@canopy/protocol/release-notes';
import {
  hasAcceptedLegalConsent,
  type PreferencesData,
  type PreferencesModelStatus,
} from '@canopy/protocol/preferences';
import type { PreferencesLoadError as PreferencesLoadErrorDetails } from '../codec';
import {
  parseSuggestionsState,
  SUGGESTION_IDS,
} from '@canopy/protocol/suggestions';
import { DEFAULT_PREFERENCES } from './defaults';
import { nextTerminalSettingsRevision } from './terminal-settings';
import {
  normalizeDefaultProvider,
  normalizePersistableModelSelection,
} from './model-normalizers';
import { normalizeOptInTimestamp } from './record-normalizers';
import {
  normalizeOrgSharingNoticesSeen,
  normalizeDomainPreferences,
} from './normalize-preferences';
import type { DomainPreferencesData } from '../domain-preferences';
import { preferencesNormalizationEnvironment } from './normalization-environment';

export interface PreferenceMergeContext {
  /** The load error at the start of this merge; blocks plan-mode-hint and GitHub-star-prompt patches. */
  readonly loadError: PreferencesLoadErrorDetails | null;
  /** One timestamp per document per process, for the notification-offer answer. */
  migrationTimestamp(): string;
}

/** Model preferences whose default follows provider availability. */
const USER_SELECTED_MODEL_FLAGS = {
  summaryModel: 'summaryModelSetByUser',
  localMemoryModel: 'localMemoryModelSetByUser',
} as const satisfies Partial<
  Record<keyof PreferencesData, keyof PreferencesData>
>;

const MODEL_SELECTION_PREFERENCE_KEYS = [
  'summaryModel',
  'handoffSummaryModel',
  'worktreeSummaryModel',
  'planDiagramModel',
  'codeReviewModel',
  'prGenerationModel',
  'commitGenerationModel',
  'branchNamingModel',
  'pipelineAdvisorModel',
  'appAdvisorModel',
  'cronGenerationModel',
  'ifCommandGenerationModel',
  'splitPrPlannerModel',
  'agentRebaseResolutionModel',
  'localMemoryModel',
] as const satisfies readonly (keyof PreferencesData)[];

/**
 * The core's answer for a changed model choice, asked about its canonical id.
 * A changed choice is revalidated unless the answer is `unknown`, which keeps
 * it as sent; a choice that cannot be stored is never `unknown`.
 */
function changedModelStatus(sent: unknown): PreferencesModelStatus {
  const model = normalizePersistableModelSelection(sent);
  return model === null
    ? 'unavailable'
    : preferencesNormalizationEnvironment().status(model);
}

/**
 * Merges a domain save. A client-local key in `patch` has no field here, so
 * normalization drops it (CAN-4472).
 */
export function mergePreferenceUpdate(
  existing: DomainPreferencesData,
  patch: Partial<DomainPreferencesData>,
  context: PreferenceMergeContext,
): DomainPreferencesData {
  // A present-but-corrupt hint has no normalized record. Refuse even an
  // unrelated save rather than dropping the original record and remigrating
  // it on reload. Genuine missing preferences normalize to the initial marker.
  if (existing.planModeHint === undefined) {
    throw new Error(
      'Plan mode hint preferences could not be read; preferences were not changed.',
    );
  }
  if (existing.githubStarPrompt === undefined) {
    throw new Error(
      'GitHub star prompt preferences could not be read; preferences were not changed.',
    );
  }
  const merged = { ...existing, ...patch };
  // Keep downgrade data frozen. Only legacy-only patches affect the new gate.
  if (typeof existing.repeatTaskAutomationSuggestionsEnabled === 'boolean') {
    merged.repeatTaskAutomationSuggestionsEnabled =
      existing.repeatTaskAutomationSuggestionsEnabled;
  } else {
    delete merged.repeatTaskAutomationSuggestionsEnabled;
  }
  if ('suggestions' in patch) {
    const incoming = parseSuggestionsState(patch.suggestions);
    if (incoming === null) throw new Error('Invalid suggestions preferences.');
    // Even generic preference saves cannot forge dismissal/display times.
    const now = new Date().toISOString();
    const dismissed = { ...existing.suggestions.dismissed };
    for (const id of SUGGESTION_IDS) {
      if (dismissed[id] === undefined && incoming.dismissed[id] !== undefined)
        dismissed[id] = now;
    }
    const previousAt = existing.suggestions.lastCornerShownAt;
    const incomingAt = incoming.lastCornerShownAt;
    const advances =
      incomingAt !== undefined &&
      (previousAt === undefined ||
        Date.parse(incomingAt) > Date.parse(previousAt));
    const lastCornerShownAt =
      advances &&
      (previousAt === undefined || Date.parse(now) > Date.parse(previousAt))
        ? now
        : previousAt;
    merged.suggestions = {
      enabled: incoming.enabled,
      dismissed,
      ...(lastCornerShownAt === undefined ? {} : { lastCornerShownAt }),
    };
  } else if (
    typeof patch.repeatTaskAutomationSuggestionsEnabled === 'boolean'
  ) {
    merged.suggestions = {
      ...existing.suggestions,
      enabled: patch.repeatTaskAutomationSuggestionsEnabled,
    };
  }
  if ('planModeHint' in patch) {
    // This runs after the authoritative re-read, inside the main-owned queue.
    // A renderer-local queue cannot protect another window's stale snapshot.
    if (context.loadError !== null) {
      throw new Error(
        'Preferences could not be read; the plan mode hint was not changed.',
      );
    }
    const incoming = normalizePlanModeHintRecord(patch.planModeHint);
    if (incoming === undefined) {
      throw new Error('Invalid plan mode hint preferences.');
    }
    merged.planModeHint = mergePlanModeHintRecords(
      existing.planModeHint,
      incoming,
    );
  }
  if ('githubStarPrompt' in patch) {
    // Same main-owned merge: a stale window cannot lower the count or
    // resurrect a retired prompt.
    if (context.loadError !== null) {
      throw new Error(
        'Preferences could not be read; the GitHub star prompt was not changed.',
      );
    }
    const incoming = normalizeGitHubStarPromptRecord(patch.githubStarPrompt);
    if (incoming === undefined) {
      throw new Error('Invalid GitHub star prompt preferences.');
    }
    merged.githubStarPrompt = mergeGitHubStarPromptRecords(
      existing.githubStarPrompt,
      incoming,
    );
  }
  // Main derives the onboarding decline below; a caller can never set it, so
  // no save can suppress the opt-out ping on its own say-so.
  merged.usageAnalyticsDeclinedAtOnboarding =
    existing.usageAnalyticsDeclinedAtOnboarding;
  if ('orgSharingNoticesSeen' in patch) {
    // Per-key merge: a stale window cannot drop another window's entry. An
    // incoming key replaces that organization's signature.
    const incoming = normalizeOrgSharingNoticesSeen(
      patch.orgSharingNoticesSeen,
    );
    if (incoming === undefined) {
      throw new Error('Invalid organization sharing notice preferences.');
    }
    merged.orgSharingNoticesSeen = {
      ...existing.orgSharingNoticesSeen,
      ...incoming,
    };
  }
  // No new checklist writes. Preserve legacy input for hint migration.
  merged.homeOnboardingSuggestions = existing.homeOnboardingSuggestions;
  // Preserve a read-derived legacy answer before a checklist reset can erase
  // its source, and the first durable answer when Settings and the offer race.
  const answer =
    existing.osNotificationOfferAnsweredAt ??
    normalizeOptInTimestamp(patch.osNotificationOfferAnsweredAt);
  if (answer !== undefined) {
    merged.osNotificationOfferAnsweredAt = answer;
  } else if (
    existing.osNotifications.enabled ||
    patch.osNotifications?.enabled === true
  ) {
    // Enabling notifications is an answer; disabling an already-enabled
    // profile must also retain its permanent suppression, even before loading
    // the renderer has triggered a separate migration write.
    merged.osNotificationOfferAnsweredAt = context.migrationTimestamp();
  }
  for (const modelKey of ['summaryModel', 'localMemoryModel'] as const) {
    const flagKey = USER_SELECTED_MODEL_FLAGS[modelKey];
    // Writing a model is choosing it, unless the writer states otherwise
    // (the legacy summary-model migration records an inferred flag).
    if (modelKey in patch && !(flagKey in patch)) merged[flagKey] = true;
  }
  const normalized = normalizeDomainPreferences(merged, 'persisted');
  // The commit that first records legal consent marks a Welcome gate decline
  // of Usage analytics (stored on, saved off). Normalization keeps the flag
  // only while Usage analytics stays off.
  if (
    !hasAcceptedLegalConsent(existing) &&
    hasAcceptedLegalConsent(normalized)
  ) {
    normalized.usageAnalyticsDeclinedAtOnboarding =
      existing.usageData.productAnalytics &&
      !normalized.usageData.productAnalytics;
  }
  // Check the current disk value inside the main-owned write queue. A stale
  // renderer/remount must never roll back an already recorded release.
  if ('releaseHighlightsLastSeenVersion' in patch) {
    const previous = existing.releaseHighlightsLastSeenVersion;
    const recorded = previous === null ? null : parseReleaseVersion(previous);
    const next = normalized.releaseHighlightsLastSeenVersion;
    const requested = next === null ? null : parseReleaseVersion(next);
    if (
      recorded &&
      (!requested || compareReleaseVersions(requested, recorded) <= 0)
    ) {
      normalized.releaseHighlightsLastSeenVersion = previous;
    }
  }
  let available: DomainPreferencesData | undefined;
  const validateChanges = (): DomainPreferencesData =>
    (available ??= normalizeDomainPreferences(merged));

  for (const key of MODEL_SELECTION_PREFERENCE_KEYS) {
    if (
      key in patch &&
      normalizePersistableModelSelection(patch[key]) !== existing[key]
    ) {
      const status = changedModelStatus(patch[key]);
      if (status === 'unknown') continue;
      if (key === 'handoffSummaryModel' && status === 'unavailable') {
        throw new Error(
          'Choose an available conversation handoff model in Settings.',
        );
      }
      Object.assign(normalized, { [key]: validateChanges()[key] });
      if (key === 'summaryModel' || key === 'localMemoryModel') {
        const flagKey = USER_SELECTED_MODEL_FLAGS[key];
        Object.assign(normalized, { [flagKey]: validateChanges()[flagKey] });
      }
    }
  }

  for (const key of [
    'defaultChatModelByProvider',
    'defaultWorktreeModelByProvider',
  ] as const) {
    if (!(key in patch)) continue;
    for (const provider of [
      'claude',
      'codex',
      'ollama',
      'aiCredits',
    ] as const) {
      const selection = patch[key]?.[provider];
      if (
        normalizePersistableModelSelection(selection?.model) !==
          (existing[key][provider]?.model ?? null) &&
        changedModelStatus(selection?.model) !== 'unknown'
      ) {
        Object.assign(normalized[key], {
          [provider]: validateChanges()[key][provider],
        });
      }
    }
  }
  normalized.defaultChatProvider = normalizeDefaultProvider(
    merged.defaultChatProvider,
    normalized.defaultChatModelByProvider,
    DEFAULT_PREFERENCES.defaultChatProvider,
  );
  normalized.defaultWorktreeProvider = normalizeDefaultProvider(
    merged.defaultWorktreeProvider,
    normalized.defaultWorktreeModelByProvider,
    DEFAULT_PREFERENCES.defaultWorktreeProvider,
  );
  // Terminal shells and presets carry their own revision (CAN-4148): it moves
  // exactly when either committed value changes, whoever writes.
  normalized.terminalSettingsRevision = nextTerminalSettingsRevision(
    existing,
    normalized,
  );
  return normalized;
}
