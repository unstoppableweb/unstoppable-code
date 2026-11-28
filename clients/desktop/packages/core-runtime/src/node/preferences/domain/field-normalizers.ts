import { TELEMETRY_SHARE_SCOPES } from '@canopy/protocol/telemetry';
import {
  expandLegacyProfileRoles,
  PROFILE_ROLES,
} from '@canopy/protocol/plugin-catalog';
import {
  BUILTIN_PLAN_DETECTION_RULE_IDS,
  normalizePlanDetectionRule,
  type PlanDetectionRule,
} from '@canopy/protocol/plan-detection';
import {
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CODEX_MODEL,
} from '@canopy/protocol/chat-models';
import {
  DEFAULT_TERMINAL_DRAWER_ACTIVE_TAB_ID,
  type TerminalPreset,
  type TerminalPresetIcon,
  type TerminalShellProfileId,
} from '@canopy/protocol/terminal';
import {
  USAGE_DATA_KEYS,
  type UsageDataPreferences,
} from '@canopy/protocol/usage-data';
import type { BrowserDrawerTabId } from '@canopy/protocol/browser';
import type { ChatInterfaceMode } from '@canopy/protocol/agent-providers';
import type { ChatTabPluginSelections } from '@canopy/protocol/plugins/selections';
import {
  isTerminalPresetImageDataUrl,
  THEME_NAMES,
  COLOR_MODES,
  SIDEBAR_APPEARANCES,
  WORKTREE_DIFF_STATS_STYLES,
  SCROLLBAR_BEHAVIORS,
  CHAT_ENRICHMENT_MODES,
  ATTRIBUTION_SOURCES,
  AI_CREDITS_ROUTING_MODES,
  CHAT_BILLING_FRAMEWORKS,
  normalizeStringArray,
  DEFAULT_ACTIVATION_QUIET_HOURS,
  type ActivationQuietHours,
  type BranchNamePrefixMode,
  type FileLabelBucket,
  type FileLabelMatcher,
  type PlanDetectionPreferences,
  type LastActiveContext,
  type AiCreditsRoutingMode,
  type ChatBillingFramework,
  type ModelDefaultsByProvider,
  type PreferencesData,
  type PrInstructionMode,
  type TelemetrySharingPreferences,
  type TelemetrySharingVisibility,
} from '@canopy/protocol/preferences';
import {
  GLOBAL_FOCUS_SHORTCUT_DEFAULT_ACCELERATOR,
  validateGlobalShortcut,
} from '@canopy/protocol/shortcuts';
import { preferencesNormalizationEnvironment } from './normalization-environment';

const VALID_PREFIX_MODES = new Set<string>(['github', 'custom', 'none']);

const VALID_PR_INSTRUCTION_MODES = new Set<string>(['replace', 'append']);

const VALID_THEMES = new Set<string>(THEME_NAMES);
const VALID_COLOR_MODES = new Set<string>(COLOR_MODES);
const VALID_SIDEBAR_APPEARANCES = new Set<string>(SIDEBAR_APPEARANCES);
const VALID_WORKTREE_DIFF_STATS_STYLES = new Set<string>(
  WORKTREE_DIFF_STATS_STYLES,
);
const VALID_SCROLLBAR_BEHAVIORS = new Set<string>(SCROLLBAR_BEHAVIORS);
const VALID_CHAT_ENRICHMENT_MODES = new Set<string>(CHAT_ENRICHMENT_MODES);
const VALID_ATTRIBUTION_SOURCES = new Set<string>(ATTRIBUTION_SOURCES);
const VALID_PROFILE_ROLES = new Set<string>(PROFILE_ROLES);

const ONBOARDING_PROFILE_DETAIL_MAX_LENGTH = 256;
const ONBOARDING_PROFILE_INTENT_MAX_LENGTH = 2000;
const VALID_AI_CREDITS_ROUTING_MODES = new Set<string>(
  AI_CREDITS_ROUTING_MODES,
);
const VALID_CHAT_BILLING_FRAMEWORKS = new Set<string>(CHAT_BILLING_FRAMEWORKS);
// Derive from the canonical protocol scope vocabulary plus the Canopy-local
// `off` sentinel so a new scope added to `TELEMETRY_SHARE_SCOPES` is accepted
// automatically rather than being silently coerced to `off`.
const VALID_TELEMETRY_SHARING_VISIBILITIES = new Set<string>([
  'off',
  ...TELEMETRY_SHARE_SCOPES,
]);

/**
 * Coerces a persisted `lastActiveContext` value to a valid `LastActiveContext`
 * or `null`. Malformed shapes (wrong/missing `kind`, missing or non-string
 * ids) normalize to `null` rather than throwing or partially trusting the
 * input.
 */
export function normalizeLastActiveContext(
  value: unknown,
): LastActiveContext | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    value.kind === 'worktree' &&
    typeof value.workspaceId === 'string' &&
    typeof value.worktreeId === 'string'
  ) {
    return {
      kind: 'worktree',
      workspaceId: value.workspaceId,
      worktreeId: value.worktreeId,
    };
  }
  if (value.kind === 'cowork' && typeof value.workspaceId === 'string') {
    return {
      kind: 'cowork',
      workspaceId: value.workspaceId,
      // Optional Work Entry id (cowork entries occupy the worktreeId slot).
      // Round-trip it when present; older contexts simply omit it.
      ...(typeof value.workEntryId === 'string'
        ? { workEntryId: value.workEntryId }
        : {}),
    };
  }
  return null;
}

export function isBrowserDrawerTabId(
  value: unknown,
): value is BrowserDrawerTabId {
  return value === DEFAULT_TERMINAL_DRAWER_ACTIVE_TAB_ID || value === 'browser';
}

export function isBranchNamePrefixMode(
  value: unknown,
): value is BranchNamePrefixMode {
  return typeof value === 'string' && VALID_PREFIX_MODES.has(value);
}

export function isPrInstructionMode(
  value: unknown,
): value is PrInstructionMode {
  return typeof value === 'string' && VALID_PR_INSTRUCTION_MODES.has(value);
}

export function isThemeName(value: unknown): value is PreferencesData['theme'] {
  return typeof value === 'string' && VALID_THEMES.has(value);
}

export function isColorMode(
  value: unknown,
): value is PreferencesData['colorMode'] {
  return typeof value === 'string' && VALID_COLOR_MODES.has(value);
}

export function isSidebarAppearance(
  value: unknown,
): value is NonNullable<PreferencesData['sidebarAppearance']> {
  return typeof value === 'string' && VALID_SIDEBAR_APPEARANCES.has(value);
}

export function isWorktreeDiffStatsStyle(
  value: unknown,
): value is NonNullable<PreferencesData['worktreeDiffStatsStyle']> {
  return (
    typeof value === 'string' && VALID_WORKTREE_DIFF_STATS_STYLES.has(value)
  );
}

export function isScrollbarBehavior(
  value: unknown,
): value is NonNullable<PreferencesData['scrollbarBehavior']> {
  return typeof value === 'string' && VALID_SCROLLBAR_BEHAVIORS.has(value);
}

export function isChatEnrichmentMode(
  value: unknown,
): value is NonNullable<PreferencesData['linearChatEnrichmentMode']> {
  return typeof value === 'string' && VALID_CHAT_ENRICHMENT_MODES.has(value);
}

function isAttributionSourceId(
  value: unknown,
): value is NonNullable<PreferencesData['attributionSource']> {
  return typeof value === 'string' && VALID_ATTRIBUTION_SOURCES.has(value);
}

function isProfileRoleId(
  value: unknown,
): value is NonNullable<PreferencesData['profileRole']> {
  return typeof value === 'string' && VALID_PROFILE_ROLES.has(value);
}

function normalizeOptionalFreeText(
  value: unknown,
  maxLength: number,
): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  return trimmed.slice(0, maxLength);
}

/**
 * Onboarding profile answers (CAN-1009). All five fields are intentionally
 * absent until the user answers — skipping a step must stay distinguishable
 * from any concrete answer, so none of them get defaults.
 */
export function buildOnboardingProfileFields(
  data: Partial<PreferencesData> | undefined,
): Partial<PreferencesData> {
  const attributionSourceDetail = normalizeOptionalFreeText(
    data?.attributionSourceDetail,
    ONBOARDING_PROFILE_DETAIL_MAX_LENGTH,
  );
  const profileRoleDetail = normalizeOptionalFreeText(
    data?.profileRoleDetail,
    ONBOARDING_PROFILE_DETAIL_MAX_LENGTH,
  );
  const profileIntent = normalizeOptionalFreeText(
    data?.profileIntent,
    ONBOARDING_PROFILE_INTENT_MAX_LENGTH,
  );
  const hasExplicitRoleList = Array.isArray(data?.profileRoles);
  const rawRoles = hasExplicitRoleList
    ? data.profileRoles?.filter(isProfileRoleId)
    : isProfileRoleId(data?.profileRole)
      ? [data.profileRole]
      : [];
  const profileRoles = expandLegacyProfileRoles(rawRoles ?? []);
  // An explicit empty list means the user cleared their answer. It must stay
  // authoritative over a stale legacy primary role across reloads.
  const rolesWereCleared =
    hasExplicitRoleList && data.profileRoles?.length === 0;
  const requestedPrimary = isProfileRoleId(data?.profileRole)
    ? expandLegacyProfileRoles([data.profileRole])[0]
    : undefined;
  const profileRole = rolesWereCleared
    ? undefined
    : requestedPrimary !== undefined && profileRoles.includes(requestedPrimary)
      ? requestedPrimary
      : profileRoles[0];
  return {
    ...(isAttributionSourceId(data?.attributionSource)
      ? { attributionSource: data.attributionSource }
      : {}),
    ...(data?.attributionSource === 'other' &&
    attributionSourceDetail !== undefined
      ? { attributionSourceDetail }
      : {}),
    ...(profileRole !== undefined ? { profileRole } : {}),
    ...(rolesWereCleared
      ? { profileRoles: [] }
      : profileRoles.length > 0
        ? { profileRoles }
        : {}),
    ...(profileRole !== undefined && profileRoleDetail !== undefined
      ? { profileRoleDetail }
      : {}),
    ...(profileIntent !== undefined ? { profileIntent } : {}),
  };
}

export function isAiCreditsRoutingMode(
  value: unknown,
): value is AiCreditsRoutingMode {
  return typeof value === 'string' && VALID_AI_CREDITS_ROUTING_MODES.has(value);
}

export function isChatBillingFramework(
  value: unknown,
): value is ChatBillingFramework {
  return typeof value === 'string' && VALID_CHAT_BILLING_FRAMEWORKS.has(value);
}

function isTelemetrySharingVisibility(
  value: unknown,
): value is TelemetrySharingVisibility {
  return (
    typeof value === 'string' && VALID_TELEMETRY_SHARING_VISIBILITIES.has(value)
  );
}

function normalizeTelemetrySharingVisibility(
  value: unknown,
): TelemetrySharingVisibility {
  return isTelemetrySharingVisibility(value) ? value : 'off';
}

export function normalizeTelemetrySharing(
  value: unknown,
): TelemetrySharingPreferences {
  if (!isRecord(value)) {
    return {
      transcripts: 'off',
      plans: 'off',
      metadata: 'off',
      summaries: 'off',
    };
  }
  const metadata = normalizeTelemetrySharingVisibility(value.metadata);
  return {
    transcripts: normalizeTelemetrySharingVisibility(value.transcripts),
    plans: normalizeTelemetrySharingVisibility(value.plans),
    metadata,
    // MIGRATION (summaries split): AI-generated worktree summaries used to ride
    // on `metadata`, so a preferences file written before the split has no
    // `summaries` key at all. Reading that absence back as `'off'` would
    // silently stop summaries for every existing user, so an ABSENT key
    // inherits the stored `metadata` value. A key that is present but
    // unrecognized still coerces to `'off'` like every other visibility.
    summaries:
      value.summaries === undefined
        ? metadata
        : normalizeTelemetrySharingVisibility(value.summaries),
  };
}

/**
 * Every usage-data switch defaults on. A non-record value or a non-boolean
 * field falls back to `true`; unknown fields are dropped.
 */
export function normalizeUsageData(value: unknown): UsageDataPreferences {
  const record = isRecord(value) ? value : {};
  const normalized: UsageDataPreferences = {
    productAnalytics: true,
    sessionReplay: true,
    errorReports: true,
    activeUseSignal: true,
    featureFlagIdentity: true,
    skillSafetyCheck: true,
  };
  for (const key of USAGE_DATA_KEYS) {
    const field = record[key];
    if (typeof field === 'boolean') normalized[key] = field;
  }
  return normalized;
}

export function normalizeString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

export function isChatInterfaceMode(
  value: unknown,
): value is ChatInterfaceMode {
  return value === 'canopy' || value === 'claude-code' || value === 'auto';
}

export function isBackgroundProcessMode(
  value: unknown,
): value is PreferencesData['canopyBackgroundProcessesMode'] {
  return value === 'canopy' || value === 'terminal';
}

export function createDefaultModelDefaultsByProvider(): ModelDefaultsByProvider {
  return {
    claude: { model: DEFAULT_CLAUDE_MODEL, thinkingLevel: 'high' },
    codex: { model: DEFAULT_CODEX_MODEL, thinkingLevel: 'high' },
    ollama: null,
    aiCredits: null,
  };
}

export function createEmptyPluginSelections(): ChatTabPluginSelections {
  return {
    collectionIds: [],
    skillRefs: [],
    pluginRefs: [],
    mcpServerRefs: [],
  };
}

function normalizeFileLabelMatcher(value: unknown): FileLabelMatcher | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = typeof value.id === 'string' ? value.id.trim() : '';
  const pattern = typeof value.pattern === 'string' ? value.pattern.trim() : '';
  if (!id || !pattern) {
    return null;
  }
  return {
    id,
    pattern,
    enabled: typeof value.enabled === 'boolean' ? value.enabled : true,
    stopMatching:
      typeof value.stopMatching === 'boolean' ? value.stopMatching : false,
    builtin: typeof value.builtin === 'boolean' ? value.builtin : false,
  };
}

/**
 * Shape validation only. The renderer merges the persisted array with the
 * seeded built-in buckets (`mergeFileLabelsWithBuiltins`) on read, so this
 * pass just drops malformed entries and dedupes ids; an empty array means
 * "seeded defaults, untouched".
 */
export function normalizeFileLabels(value: unknown): FileLabelBucket[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seenIds = new Set<string>();
  const buckets: FileLabelBucket[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    if (!id || !name || seenIds.has(id)) continue;
    seenIds.add(id);
    const rawMatchers = Array.isArray(entry.matchers) ? entry.matchers : [];
    const seenMatcherIds = new Set<string>();
    const matchers: FileLabelMatcher[] = [];
    for (const rawMatcher of rawMatchers) {
      const matcher = normalizeFileLabelMatcher(rawMatcher);
      if (matcher && !seenMatcherIds.has(matcher.id)) {
        seenMatcherIds.add(matcher.id);
        matchers.push(matcher);
      }
    }
    buckets.push({
      id,
      name,
      enabled: typeof entry.enabled === 'boolean' ? entry.enabled : true,
      stopFurtherLabels:
        typeof entry.stopFurtherLabels === 'boolean'
          ? entry.stopFurtherLabels
          : false,
      builtin: typeof entry.builtin === 'boolean' ? entry.builtin : false,
      matchers,
    });
  }
  return buckets;
}

export function normalizePlanDetectionPreferences(
  value: unknown,
): PlanDetectionPreferences {
  if (!isRecord(value)) {
    return { disabledBuiltinRuleIds: [], customRules: [] };
  }
  const rawDisabled = Array.isArray(value.disabledBuiltinRuleIds)
    ? value.disabledBuiltinRuleIds
    : [];
  const seenDisabled = new Set<string>();
  const disabledBuiltinRuleIds: string[] = [];
  for (const entry of rawDisabled) {
    if (
      typeof entry === 'string' &&
      BUILTIN_PLAN_DETECTION_RULE_IDS.has(entry) &&
      !seenDisabled.has(entry)
    ) {
      seenDisabled.add(entry);
      disabledBuiltinRuleIds.push(entry);
    }
  }
  const rawCustom = Array.isArray(value.customRules) ? value.customRules : [];
  const seenIds = new Set<string>();
  const customRules: PlanDetectionRule[] = [];
  for (const entry of rawCustom) {
    const normalized = normalizePlanDetectionRule(entry);
    if (normalized && !seenIds.has(normalized.id)) {
      seenIds.add(normalized.id);
      customRules.push(normalized);
    }
  }
  return { disabledBuiltinRuleIds, customRules };
}

/**
 * A saved OS focus shortcut (CAN-1963) is only kept when it would pass the
 * same validation the Settings recorder applies. Electron silently registers
 * unknown tokens as bare keys, so a corrupt value must never reach it as a
 * typing-stealing global hotkey; the default chord is the safe fallback.
 */
export function normalizeGlobalFocusShortcut(value: unknown): string {
  if (typeof value !== 'string') {
    return GLOBAL_FOCUS_SHORTCUT_DEFAULT_ACCELERATOR;
  }
  const validation = validateGlobalShortcut(
    value,
    preferencesNormalizationEnvironment().shortcutPlatform(),
  );
  return validation.ok
    ? validation.accelerator
    : GLOBAL_FOCUS_SHORTCUT_DEFAULT_ACCELERATOR;
}

function normalizeHour(value: unknown, fallback: number): number {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 23
    ? value
    : fallback;
}

export function normalizeActivationQuietHours(
  value: unknown,
): ActivationQuietHours {
  const fallback = DEFAULT_ACTIVATION_QUIET_HOURS;
  if (typeof value !== 'object' || value === null) return { ...fallback };
  const raw: Record<string, unknown> = { ...value };
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : fallback.enabled,
    startHour: normalizeHour(raw.startHour, fallback.startHour),
    endHour: normalizeHour(raw.endHour, fallback.endHour),
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const TERMINAL_SHELL_PROFILE_IDS = new Set<string>([
  'default',
  'zsh',
  'bash',
  'cmd',
  'powershell',
  'git-bash',
]);

export function isTerminalShellProfileId(
  value: unknown,
): value is TerminalShellProfileId {
  return typeof value === 'string' && TERMINAL_SHELL_PROFILE_IDS.has(value);
}

function normalizeTerminalPresetImageDataUrl(
  value: unknown,
): string | undefined {
  return isTerminalPresetImageDataUrl(value) ? value : undefined;
}

function normalizeTerminalPresetIcon(
  value: unknown,
): TerminalPresetIcon | undefined {
  if (!isRecord(value)) return undefined;
  if (
    value.kind === 'character' &&
    typeof value.value === 'string' &&
    value.value.length > 0
  ) {
    return { kind: 'character', value: value.value.slice(0, 16) };
  }
  if (value.kind !== 'image') return undefined;

  // `dataUrl` is the pre-themed persisted shape. Treat it as the light asset;
  // the renderer's fallback rule still uses it in dark mode until the user
  // optionally configures a dedicated dark image.
  const lightDataUrl =
    normalizeTerminalPresetImageDataUrl(value.lightDataUrl) ??
    normalizeTerminalPresetImageDataUrl(value.dataUrl);
  const darkDataUrl = normalizeTerminalPresetImageDataUrl(value.darkDataUrl);
  if (!lightDataUrl && !darkDataUrl) return undefined;
  return {
    kind: 'image',
    ...(lightDataUrl ? { lightDataUrl } : {}),
    ...(darkDataUrl ? { darkDataUrl } : {}),
  };
}

export function normalizeTerminalPresets(value: unknown): TerminalPreset[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const presets: TerminalPreset[] = [];
  for (const candidate of value.slice(0, 50)) {
    if (
      !isRecord(candidate) ||
      typeof candidate.id !== 'string' ||
      candidate.id.length < 1 ||
      candidate.id.length > 128 ||
      seen.has(candidate.id) ||
      typeof candidate.name !== 'string' ||
      candidate.name.trim().length < 1 ||
      typeof candidate.command !== 'string' ||
      candidate.command.trim().length < 1 ||
      !isTerminalShellProfileId(candidate.terminalProfileId)
    ) {
      continue;
    }
    const icon = normalizeTerminalPresetIcon(candidate.icon);
    seen.add(candidate.id);
    presets.push({
      id: candidate.id,
      name: candidate.name.trim().slice(0, 64),
      terminalProfileId: candidate.terminalProfileId,
      command: candidate.command.trim().slice(0, 4_000),
      enabled: candidate.enabled !== false,
      ...(icon ? { icon } : {}),
    });
  }
  return presets;
}

export function normalizeCodexCompatDisabledPlugins(value: unknown): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of normalizeStringArray(value)) {
    const separatorIndex = entry.indexOf('/');
    const normalized =
      separatorIndex === -1
        ? entry
        : `${entry.slice(0, separatorIndex)}/${entry
            .slice(separatorIndex + 1)
            .toLowerCase()}`;
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

export function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}
