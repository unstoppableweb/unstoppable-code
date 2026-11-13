import { DATA_SHARING_OPT_IN_FEATURES } from '@canopy/protocol/canopy-server';
import {
  parseInstalledItemKey,
  InstalledItemRefSchema,
  InstalledItemUninstallTargetSchema,
} from '@canopy/protocol/installed-items';
import { z } from 'zod';
import {
  DEFAULT_CHAT_DETAIL,
  isChatDetail,
  type ChatDetail,
} from '@canopy/protocol/chat-detail';
import { mcpHttpAuthTargetKey } from '@canopy/execution-engine/lib/mcp-http-auth';
import { normalizeAccountProxyUrl } from '../../lib/account-proxy';
import type {
  AccountProxyConnection,
  AccountProxyConnectionKind,
} from '../../types/account-proxy';
import {
  IN_APP_NOTIFICATION_PLACEMENTS,
  OS_NOTIFICATION_CATEGORY_SOUNDS,
  OS_NOTIFICATION_TOP_LEVEL_SOUNDS,
  type BranchDisplayMapping,
  type ChatTabPluginSelections,
  type InAppNotificationPlacement,
  type InAppNotificationPreferences,
  type McpHttpAuthHandler,
  type McpHttpAuthPreference,
  type McpHttpAuthTarget,
  type NotificationCategoryMap,
  type OsNotificationCategorySound,
  type OsNotificationPreferences,
  type OsNotificationTopLevelSound,
  type LegacyPlanModeChecklistInput,
  type NativeProviderAccountRecord,
  type PreferencesData,
  type WindowBounds,
} from '../../types';
import { normalizeStringArray } from '../../lib/string-array';
import { DEFAULT_PREFERENCES } from './defaults';
import {
  normalizeTelemetrySharing,
  createEmptyPluginSelections,
  normalizeBoolean,
  isRecord,
} from './field-normalizers';

export function normalizeWindowBounds(value: unknown): WindowBounds | null {
  if (value === null || value === undefined || typeof value !== 'object') {
    return null;
  }
  const obj = value as Record<string, unknown>;
  const x = obj.x;
  const y = obj.y;
  const width = obj.width;
  const height = obj.height;
  if (
    typeof x !== 'number' ||
    !Number.isFinite(x) ||
    typeof y !== 'number' ||
    !Number.isFinite(y) ||
    typeof width !== 'number' ||
    !Number.isFinite(width) ||
    typeof height !== 'number' ||
    !Number.isFinite(height)
  ) {
    return null;
  }
  if (width < 800 || height < 500) {
    return null;
  }
  return { x, y, width, height };
}

/**
 * Validate the persisted App Advisor window bounds. The preference key
 * `appAdvisorDialogBounds` is legacy-named — it was retained from the
 * earlier floating-dialog implementation to avoid a preference migration —
 * but the persisted value is now the standalone App Advisor
 * `BrowserWindow` bounds. The size floor matches the App Advisor
 * window's minimum usable dimensions; invalid values return `null` so
 * the window can fall back to its built-in default size.
 */
export function normalizeAppAdvisorDialogBounds(
  value: unknown,
): PreferencesData['appAdvisorDialogBounds'] {
  if (value === null || value === undefined || typeof value !== 'object') {
    return null;
  }
  const obj = value as Record<string, unknown>;
  const { x, y, width, height } = obj;
  if (
    typeof x !== 'number' ||
    !Number.isFinite(x) ||
    typeof y !== 'number' ||
    !Number.isFinite(y) ||
    typeof width !== 'number' ||
    !Number.isFinite(width) ||
    width < 360 ||
    typeof height !== 'number' ||
    !Number.isFinite(height) ||
    height < 360
  ) {
    return null;
  }
  return { x, y, width, height };
}

function isValidMappingItem(item: unknown): item is BranchDisplayMapping {
  if (typeof item !== 'object' || item === null) return false;
  if (
    !('id' in item) ||
    !('label' in item) ||
    !('matcher' in item) ||
    !('result' in item) ||
    !('enabled' in item) ||
    !('builtin' in item) ||
    !('settings' in item)
  )
    return false;
  if (
    typeof item.id !== 'string' ||
    typeof item.label !== 'string' ||
    typeof item.matcher !== 'string' ||
    typeof item.result !== 'string' ||
    typeof item.enabled !== 'boolean' ||
    typeof item.builtin !== 'boolean' ||
    typeof item.settings !== 'object' ||
    item.settings === null
  )
    return false;
  // Validate examples/readonlyExampleCount if present; normalization backfills defaults
  if ('examples' in item && !Array.isArray(item.examples)) return false;
  if (
    'readonlyExampleCount' in item &&
    typeof item.readonlyExampleCount !== 'number'
  )
    return false;
  if (!('replaceHyphens' in item.settings) || !('capitalize' in item.settings))
    return false;
  return (
    typeof item.settings.replaceHyphens === 'boolean' &&
    typeof item.settings.capitalize === 'boolean'
  );
}

export function normalizeBranchDisplayMappings(
  value: unknown,
): BranchDisplayMapping[] {
  if (!Array.isArray(value)) return DEFAULT_PREFERENCES.branchDisplayMappings;
  return value.filter(isValidMappingItem).map((item: BranchDisplayMapping) => ({
    ...item,
    examples: Array.isArray(item.examples)
      ? item.examples.filter((v: unknown): v is string => typeof v === 'string')
      : [],
    readonlyExampleCount:
      typeof item.readonlyExampleCount === 'number' &&
      Number.isFinite(item.readonlyExampleCount)
        ? Math.max(0, Math.round(item.readonlyExampleCount))
        : 0,
  }));
}

function normalizeTwoPartRefs<T>(
  value: unknown,
  firstKey: string,
  secondKey: string,
  createRef: (first: string, second: string) => T,
): T[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  const result: T[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      continue;
    }

    const first = entry[firstKey];
    const second = entry[secondKey];
    if (typeof first !== 'string' || typeof second !== 'string') {
      continue;
    }

    const normalizedFirst = first.trim();
    const normalizedSecond = second.trim();
    if (normalizedFirst.length === 0 || normalizedSecond.length === 0) {
      continue;
    }

    const stableKey = `${normalizedFirst}/${normalizedSecond}`;
    if (seen.has(stableKey)) {
      continue;
    }

    seen.add(stableKey);
    result.push(createRef(normalizedFirst, normalizedSecond));
  }

  return result;
}

function isMcpHttpAuthHandler(value: unknown): value is McpHttpAuthHandler {
  return value === 'canopy' || value === 'provider' || value === 'account';
}

function normalizeMcpHttpAuthTarget(value: unknown): McpHttpAuthTarget | null {
  if (!isRecord(value)) {
    return null;
  }

  if (value.kind === 'standalone') {
    return typeof value.serverId === 'string' &&
      value.serverId.trim().length > 0 &&
      typeof value.configId === 'string' &&
      value.configId.trim().length > 0
      ? {
          kind: 'standalone',
          serverId: value.serverId.trim(),
          configId: value.configId.trim(),
        }
      : null;
  }

  if (value.kind === 'plugin') {
    return typeof value.marketplaceId === 'string' &&
      value.marketplaceId.trim().length > 0 &&
      typeof value.pluginName === 'string' &&
      value.pluginName.trim().length > 0 &&
      typeof value.serverName === 'string' &&
      value.serverName.trim().length > 0
      ? {
          kind: 'plugin',
          marketplaceId: value.marketplaceId.trim(),
          pluginName: value.pluginName.trim(),
          serverName: value.serverName.trim(),
        }
      : null;
  }

  return null;
}

function normalizeMcpHttpAuthPreferences(
  value: unknown,
): McpHttpAuthPreference[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const byKey = new Map<string, McpHttpAuthPreference>();
  for (const entry of value) {
    if (!isRecord(entry) || !isMcpHttpAuthHandler(entry.handler)) {
      continue;
    }

    const target = normalizeMcpHttpAuthTarget(entry.target);
    if (!target) {
      continue;
    }

    byKey.set(mcpHttpAuthTargetKey(target), {
      target,
      handler: entry.handler,
    });
  }

  return Array.from(byKey.values());
}

export function normalizeChatTabPluginSelections(
  value: unknown,
): ChatTabPluginSelections {
  if (!isRecord(value)) {
    return createEmptyPluginSelections();
  }

  const skillRefs = normalizeTwoPartRefs(
    value.skillRefs,
    'sourceId',
    'skillName',
    (sourceId, skillName) => ({ sourceId, skillName }),
  );
  const pluginRefs = normalizeTwoPartRefs(
    value.pluginRefs,
    'marketplaceId',
    'pluginName',
    (marketplaceId, pluginName) => ({ marketplaceId, pluginName }),
  );
  const mcpServerRefs = normalizeTwoPartRefs(
    value.mcpServerRefs,
    'serverId',
    'configId',
    (serverId, configId) => ({ serverId, configId }),
  );

  const mcpHttpAuthPreferences = normalizeMcpHttpAuthPreferences(
    value.mcpHttpAuthPreferences,
  );
  // Accept either `collectionIds` (canonical) or the deprecated `bundleIds`
  // alias on input, merge + de-duplicate them, and persist only
  // `collectionIds` on output.
  const collectionIdsInput = normalizeStringArray(value.collectionIds);
  const legacyBundleIds = normalizeStringArray(value.bundleIds);
  const seen = new Set<string>();
  const collectionIds: string[] = [];
  for (const id of [...collectionIdsInput, ...legacyBundleIds]) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    collectionIds.push(id);
  }
  return {
    collectionIds,
    skillRefs,
    pluginRefs,
    mcpServerRefs,
    ...(mcpHttpAuthPreferences.length > 0 ? { mcpHttpAuthPreferences } : {}),
  };
}

const VALID_TOP_LEVEL_SOUNDS = new Set<string>(
  OS_NOTIFICATION_TOP_LEVEL_SOUNDS,
);
const VALID_CATEGORY_SOUNDS = new Set<string>(OS_NOTIFICATION_CATEGORY_SOUNDS);
const VALID_IN_APP_NOTIFICATION_PLACEMENTS = new Set<string>(
  IN_APP_NOTIFICATION_PLACEMENTS,
);

function isTopLevelSound(value: unknown): value is OsNotificationTopLevelSound {
  return typeof value === 'string' && VALID_TOP_LEVEL_SOUNDS.has(value);
}

function isCategorySound(value: unknown): value is OsNotificationCategorySound {
  return typeof value === 'string' && VALID_CATEGORY_SOUNDS.has(value);
}

function isInAppNotificationPlacement(
  value: unknown,
): value is InAppNotificationPlacement {
  return (
    typeof value === 'string' && VALID_IN_APP_NOTIFICATION_PLACEMENTS.has(value)
  );
}

function normalizeTopLevelSound(
  value: unknown,
  fallback: OsNotificationTopLevelSound,
): OsNotificationTopLevelSound {
  return isTopLevelSound(value) ? value : fallback;
}

function normalizeCategorySound(
  value: unknown,
  fallback: OsNotificationCategorySound,
): OsNotificationCategorySound {
  return isCategorySound(value) ? value : fallback;
}

function normalizeInAppNotificationPlacement(
  value: unknown,
): InAppNotificationPlacement | undefined {
  return isInAppNotificationPlacement(value) ? value : undefined;
}

function normalizeLegacyInAppChatActivityToasts(
  value: unknown,
  fallback: boolean,
): boolean {
  if (!isRecord(value)) {
    return fallback;
  }

  return normalizeBoolean(value.showInAppChatActivityToasts, fallback);
}

function normalizeNotificationCategories(
  value: unknown,
  fallback: NotificationCategoryMap,
): NotificationCategoryMap {
  if (!isRecord(value)) {
    return { ...fallback };
  }
  return {
    chat: normalizeBoolean(value.chat, fallback.chat),
    script: normalizeBoolean(value.script, fallback.script),
    hook: normalizeBoolean(value.hook, fallback.hook),
    gitCommit: normalizeBoolean(value.gitCommit, fallback.gitCommit),
    gitPush: normalizeBoolean(value.gitPush, fallback.gitPush),
    prCreate: normalizeBoolean(value.prCreate, fallback.prCreate),
    pipeline: normalizeBoolean(value.pipeline, fallback.pipeline),
    terminal: normalizeBoolean(value.terminal, fallback.terminal),
    runComment: normalizeBoolean(value.runComment, fallback.runComment),
    activation: normalizeBoolean(value.activation, fallback.activation),
  };
}

export function normalizeInAppNotifications(
  value: unknown,
  legacyOsNotificationsValue: unknown,
): InAppNotificationPreferences {
  const fallback = DEFAULT_PREFERENCES.inAppNotifications;
  const legacyEnabled = normalizeLegacyInAppChatActivityToasts(
    legacyOsNotificationsValue,
    fallback.enabled,
  );

  if (!isRecord(value)) {
    return {
      enabled: legacyEnabled,
      categories: { ...fallback.categories },
    };
  }

  const legacyShowChatActivityToasts = normalizeBoolean(
    value.showChatActivityToasts,
    legacyEnabled,
  );

  const placementChosen = value.placementChosen === true;
  const storedPlacement = normalizeInAppNotificationPlacement(value.placement);
  // Older builds wrote `bottom-right` automatically on every save. Discard
  // that unchosen legacy value to follow the app default, even when it is also
  // bottom-right. Retain other valid legacy corners: a missing chosen flag
  // cannot distinguish their explicit choices from historical defaults.
  const placement =
    storedPlacement === 'bottom-right' && !placementChosen
      ? undefined
      : storedPlacement;
  return {
    enabled: normalizeBoolean(value.enabled, legacyShowChatActivityToasts),
    ...(placement === undefined
      ? {}
      : { placement, ...(placementChosen ? { placementChosen: true } : {}) }),
    categories: normalizeNotificationCategories(
      value.categories,
      fallback.categories,
    ),
  };
}

export function normalizeOsNotifications(
  value: unknown,
): OsNotificationPreferences {
  const fallback = DEFAULT_PREFERENCES.osNotifications;

  if (!isRecord(value)) {
    return fallback;
  }

  const categories = normalizeNotificationCategories(
    value.categories,
    fallback.categories,
  );

  const rawCategorySounds = value.categorySounds;
  const categorySounds = isRecord(rawCategorySounds)
    ? {
        chat: normalizeCategorySound(
          rawCategorySounds.chat,
          fallback.categorySounds.chat,
        ),
        script: normalizeCategorySound(
          rawCategorySounds.script,
          fallback.categorySounds.script,
        ),
        hook: normalizeCategorySound(
          rawCategorySounds.hook,
          fallback.categorySounds.hook,
        ),
        gitCommit: normalizeCategorySound(
          rawCategorySounds.gitCommit,
          fallback.categorySounds.gitCommit,
        ),
        gitPush: normalizeCategorySound(
          rawCategorySounds.gitPush,
          fallback.categorySounds.gitPush,
        ),
        prCreate: normalizeCategorySound(
          rawCategorySounds.prCreate,
          fallback.categorySounds.prCreate,
        ),
        pipeline: normalizeCategorySound(
          rawCategorySounds.pipeline,
          fallback.categorySounds.pipeline,
        ),
        terminal: normalizeCategorySound(
          rawCategorySounds.terminal,
          fallback.categorySounds.terminal,
        ),
        runComment: normalizeCategorySound(
          rawCategorySounds.runComment,
          fallback.categorySounds.runComment,
        ),
        activation: normalizeCategorySound(
          rawCategorySounds.activation,
          fallback.categorySounds.activation,
        ),
      }
    : fallback.categorySounds;

  return {
    enabled: normalizeBoolean(value.enabled, fallback.enabled),
    skipWhenFocused: normalizeBoolean(
      value.skipWhenFocused,
      fallback.skipWhenFocused,
    ),
    defaultSound: normalizeTopLevelSound(
      value.defaultSound,
      fallback.defaultSound,
    ),
    categories,
    categorySounds,
  };
}

function normalizeIsoTimestamp(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value
    : undefined;
}

/** Narrows persisted unknowns to plain objects without a type assertion. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeNativeProviderAccountRecord(
  value: unknown,
): NativeProviderAccountRecord | undefined {
  if (!isPlainRecord(value)) return undefined;
  const accountKey =
    typeof value.accountKey === 'string' ? value.accountKey.trim() : '';
  if (!accountKey) return undefined;
  const changedAt = value.changedAt;
  const subscriptionRestoredAt = value.subscriptionRestoredAt;
  return {
    accountKey,
    ...(typeof changedAt === 'number' &&
    Number.isFinite(changedAt) &&
    changedAt > 0
      ? { changedAt }
      : {}),
    ...(typeof subscriptionRestoredAt === 'number' &&
    Number.isFinite(subscriptionRestoredAt) &&
    subscriptionRestoredAt > 0
      ? { subscriptionRestoredAt }
      : {}),
  };
}

export function normalizeNativeProviderAccounts(
  value: unknown,
): PreferencesData['nativeProviderAccounts'] {
  if (!isPlainRecord(value)) return undefined;
  const accounts: NonNullable<PreferencesData['nativeProviderAccounts']> = {};
  for (const provider of ['claude', 'codex'] as const) {
    const record = normalizeNativeProviderAccountRecord(value[provider]);
    if (record) accounts[provider] = record;
  }
  return Object.keys(accounts).length ? accounts : undefined;
}

export function normalizeOptInTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const instant = Date.parse(value);
  return Number.isFinite(instant) ? new Date(instant).toISOString() : undefined;
}
export function normalizeDataSharingOptInHints(
  value: unknown,
): PreferencesData['dataSharingOptInHints'] {
  if (!isPlainRecord(value)) return undefined;
  const hints: NonNullable<PreferencesData['dataSharingOptInHints']> = {};
  for (const feature of DATA_SHARING_OPT_IN_FEATURES) {
    const entry = value[feature];
    if (!isPlainRecord(entry)) continue;
    const dismissedAt = normalizeOptInTimestamp(entry.dismissedAt);
    if (dismissedAt !== undefined) hints[feature] = { dismissedAt };
  }
  return Object.keys(hints).length ? hints : undefined;
}
export function normalizeDataSharingOptInHistory(
  value: unknown,
): PreferencesData['dataSharingOptInHistory'] {
  if (!Array.isArray(value)) return undefined;
  const history: NonNullable<PreferencesData['dataSharingOptInHistory']> = [];
  for (const entry of value) {
    if (!isPlainRecord(entry)) continue;
    const enabledAt = normalizeOptInTimestamp(entry.enabledAt);
    if (enabledAt !== undefined && isPlainRecord(entry.sharing)) {
      history.push({
        enabledAt,
        sharing: normalizeTelemetrySharing(entry.sharing),
      });
    }
  }
  return history.length
    ? history.sort((a, b) => a.enabledAt.localeCompare(b.enabledAt))
    : undefined;
}

/**
 * #5222 is not on this base. Retain only its exact compatibility input until
 * its raw-input conversion is integrated; all live checklist state is dropped.
 */
export function preserveLegacyPlanModeInput(
  value: unknown,
): LegacyPlanModeChecklistInput | undefined {
  if (!isPlainRecord(value) || !isPlainRecord(value.entries)) return undefined;
  const entry = value.entries['plan-mode'];
  if (!isPlainRecord(entry)) return undefined;
  const completedAt = normalizeIsoTimestamp(entry.completedAt);
  const dismissedAt = normalizeIsoTimestamp(entry.dismissedAt);
  if (completedAt === undefined && dismissedAt === undefined) return undefined;
  return {
    startedAt:
      normalizeIsoTimestamp(value.startedAt) ?? '1970-01-01T00:00:00.000Z',
    entries: {
      'plan-mode': {
        ...(completedAt !== undefined ? { completedAt } : {}),
        ...(dismissedAt !== undefined ? { dismissedAt } : {}),
      },
    },
  };
}

export function legacyNotificationAnswer(
  value: unknown,
): Record<string, unknown> | undefined {
  if (!isPlainRecord(value) || !isPlainRecord(value.entries)) return undefined;
  const answer = value.entries.notifications;
  return isPlainRecord(answer) ? answer : undefined;
}

const ACCOUNT_PROXY_CONNECTION_KINDS: ReadonlySet<string> = new Set([
  'server',
  'local',
  'device',
]);

/** A stored proxy connection, or null when it is missing or malformed. */
export function normalizeAccountProxyConnection(
  value: unknown,
): AccountProxyConnection | null {
  if (!isRecord(value)) return null;
  const { id, kind, url } = value;
  if (
    typeof id !== 'string' ||
    !/^[a-zA-Z0-9-]{8,64}$/.test(id) ||
    typeof kind !== 'string' ||
    !ACCOUNT_PROXY_CONNECTION_KINDS.has(kind) ||
    typeof url !== 'string'
  ) {
    return null;
  }
  const normalizedUrl = normalizeAccountProxyUrl(url);
  if (!normalizedUrl.ok) return null;
  const connectionKind: AccountProxyConnectionKind =
    kind === 'local' ? 'local' : kind === 'device' ? 'device' : 'server';
  return { id, kind: connectionKind, url: normalizedUrl.url };
}

export function normalizePendingInstalledItemUninstalls(
  value: unknown,
): NonNullable<PreferencesData['pendingInstalledItemUninstalls']> {
  if (!Array.isArray(value)) return [];
  const schema = z
    .object({
      target: InstalledItemUninstallTargetSchema,
      refs: z.array(InstalledItemRefSchema),
    })
    .strict();
  return value.flatMap((entry: unknown) => {
    const result = schema.safeParse(entry);
    return result.success ? [result.data] : [];
  });
}

export function normalizeParkedCodexPlugins(
  value: unknown,
): NonNullable<PreferencesData['parkedCodexPlugins']> {
  if (!Array.isArray(value)) return [];
  const records: NonNullable<PreferencesData['parkedCodexPlugins']> = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      typeof entry.key !== 'string' ||
      seen.has(entry.key) ||
      parseInstalledItemKey(entry.key)?.kind !== 'plugin' ||
      typeof entry.pluginId !== 'string' ||
      !entry.pluginId ||
      typeof entry.pluginName !== 'string' ||
      !entry.pluginName ||
      !(
        entry.marketplacePath === null ||
        typeof entry.marketplacePath === 'string'
      ) ||
      !(
        entry.remoteMarketplaceName === null ||
        typeof entry.remoteMarketplaceName === 'string'
      ) ||
      (!entry.marketplacePath && !entry.remoteMarketplaceName) ||
      (entry.state !== 'parking' &&
        entry.state !== 'parked' &&
        entry.state !== 'restoring')
    )
      continue;
    records.push({
      key: entry.key,
      pluginId: entry.pluginId,
      pluginName: entry.pluginName,
      marketplacePath: entry.marketplacePath,
      remoteMarketplaceName: entry.remoteMarketplaceName,
      ...(typeof entry.version === 'string' ? { version: entry.version } : {}),
      ...(typeof entry.sourceDigest === 'string' &&
      /^[a-f0-9]{64}$/.test(entry.sourceDigest)
        ? { sourceDigest: entry.sourceDigest }
        : {}),
      ...(typeof entry.marketplaceSourceDigest === 'string' &&
      /^[a-f0-9]{64}$/.test(entry.marketplaceSourceDigest)
        ? { marketplaceSourceDigest: entry.marketplaceSourceDigest }
        : {}),
      state: entry.state,
    });
    seen.add(entry.key);
  }
  return records;
}

/**
 * The saved chat detail level. Preferences from before the setting existed
 * move over once from the two switches it replaced: "Show only recent steps"
 * on reads as `recent` (it already folded every run), else "Group tool calls"
 * on as `compact`, else the default. The next save writes `chatDetail` and
 * drops the old keys.
 */
export function normalizeChatDetailPreference(
  data: Partial<PreferencesData> | Record<string, unknown> | undefined,
): ChatDetail {
  if (data === undefined) return DEFAULT_CHAT_DETAIL;
  if (isChatDetail(data.chatDetail)) return data.chatDetail;
  if (
    'chatLiveStepWindowEnabled' in data &&
    data.chatLiveStepWindowEnabled === true
  )
    return 'recent';
  if (
    'chatGroupToolCallsEnabled' in data &&
    data.chatGroupToolCallsEnabled === true
  )
    return 'compact';
  return DEFAULT_CHAT_DETAIL;
}
