import { createHash } from 'node:crypto';
import {
  CatalogHostRefusedError,
  CatalogSelectionNotFoundError,
  CatalogSelectionUnavailableError,
  catalogContentRevision,
  type CatalogHostRefusal,
  type CatalogSelectionRead,
  type CatalogSelectionScope,
  type CatalogSnapshotRead,
  type CatalogSourceRecord,
  type CoreCatalogHost,
} from '@canopy/core-runtime/node/catalog';
import { CanopyOperationError } from '@canopy/core-runtime';
import { isStorageOutcomeUnknownError } from '@canopy/core-runtime/storage';
import {
  CatalogEntrySchema,
  CoreWorkspacePluginsUpdateParamsSchema,
  catalogSelectionRefsOf,
  collectionEntryId,
  mcpServerEntryId,
  pluginEntryId,
  selectionEntryIds,
  skillEntryId,
  type CanopyCallerDescriptor,
  type CatalogEntry,
  type CatalogPluginHarness,
  type CatalogPluginHarnesses,
  type CatalogSelectionRefs,
  type CoreWorkspacePluginsUpdateParams,
  type CoreWorkspacePluginsUpdateResult,
} from '@canopy/protocol/canopy-core';
import type { InstalledItemRef } from '@canopy/protocol/installed-items';
import type {
  PortalPluginCatalog,
  PortalPluginCatalogMcpServer,
} from '@canopy/protocol/portal';
import {
  chatInheritsProjectDefaults,
  chatSurfaceUsesGlobalPluginDefaults,
  effectiveChatPluginSelections,
  normalizePluginSelectionTombstones,
  pluginSelectionsEqual,
} from '@canopy/desktop-shared/lib/effective-plugin-selections';
import { parseGitHubRepo } from '@canopy/desktop-shared/lib/github-repo';
import { normalizePluginSelections } from '@canopy/execution-engine/lib/plugin-selections-normalization';
import type {
  ChatTabPluginSelections,
  ChatTabsFile,
  PluginSelectionTombstones,
  PreferencesData,
  WorkspaceConfigFile,
} from '@canopy/desktop-shared/types';
import type { IPCResult } from '@canopy/execution-engine/types/pipeline';
import type {
  MarketplaceInfo,
  MarketplaceProviderStatus,
  PluginInfo,
  PluginsCache,
} from '@canopy/execution-engine/types/plugins';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { pluginDefaultsWorkspaceId } from '../plugins/plugin-defaults-revision';
import { runningCatalogRefresh } from './core-catalog-mutation-host';

/** What the desktop catalog host reads and writes; tests inject fakes. Defaults load lazily. */
export interface DesktopCatalogHostDeps {
  buildCachedPluginCatalog(): Promise<PortalPluginCatalog>;
  readCollection(id: string): Promise<{
    skills: { sourceId: string; skillName: string }[];
    plugins: { marketplaceId: string; pluginName: string }[];
    mcpServers?: { serverId: string; configId: string }[];
  } | null>;
  loadMarketplacesCacheOnly(): Promise<IPCResult<PluginsCache>>;
  readPluginHarnessFacts(
    marketplace: MarketplaceInfo,
    plugin: PluginInfo,
  ): Promise<CatalogPluginHarnesses>;
  readInstalledItemPolicy(): Promise<{
    isDisabled(ref: InstalledItemRef): boolean;
  }>;
  readPreferences(): Promise<{
    preferences: PreferencesData;
    authority: 'ok' | 'absent' | 'unreadable';
  }>;
  updatePreferences(
    updater: (latest: PreferencesData) => Partial<PreferencesData> | null,
  ): Promise<{ previous: PreferencesData; next: PreferencesData }>;
  afterGlobalSelectionChanged(next: PreferencesData): Promise<void>;
  readWorkspaceConfig(workspaceId: string): Promise<{
    config: WorkspaceConfigFile;
    authority: 'ok' | 'absent' | 'unreadable';
  }>;
  readWorkspaceRevision(workspaceId: string): Promise<number>;
  readChatTabs(workspaceId: string, worktreeId: string): Promise<ChatTabsFile>;
  normalizeAccountSelections(
    value: ChatTabPluginSelections,
  ): Promise<ChatTabPluginSelections>;
  normalizeAccountTombstones(
    value: PluginSelectionTombstones | undefined,
  ): Promise<PluginSelectionTombstones | undefined>;
  dispatchWorkspacePluginsUpdate(
    params: CoreWorkspacePluginsUpdateParams,
    caller: CanopyCallerDescriptor,
  ): Promise<CoreWorkspacePluginsUpdateResult>;
}

const defaultDeps: Omit<
  DesktopCatalogHostDeps,
  'dispatchWorkspacePluginsUpdate'
> = {
  buildCachedPluginCatalog: async () =>
    (
      await import('../services/plugin-catalog-service')
    ).buildCachedPluginCatalog(),
  readCollection: async (id) =>
    (
      await (
        await import('../collections/collection-store')
      ).readCollectionConfig(id)
    )?.collection ?? null,
  loadMarketplacesCacheOnly: async () =>
    (await import('../plugins/plugin-service')).loadMarketplacesCacheOnly(),
  readPluginHarnessFacts: async (marketplace, plugin) =>
    (await import('../plugins/plugin-harness-facts')).pluginHarnessFacts(
      marketplace,
      plugin,
    ),
  readInstalledItemPolicy: async () =>
    (
      await import('../installed-items/installed-item-policy')
    ).readInstalledItemPolicy(),
  readPreferences: async () =>
    (await import('../lib/preferences-store')).readPreferencesFileDetailed(),
  updatePreferences: async (updater) =>
    (
      await import('../lib/preferences-store')
    ).updatePreferencesFileWithPrevious(updater),
  afterGlobalSelectionChanged: async (next) => {
    // session-manager imports plugin resolution; load it lazily, as the
    // curated defaults seeding in plugin-service does.
    const { bumpGlobalPluginDefaultsRevision } =
      await import('../agents/session-manager');
    bumpGlobalPluginDefaultsRevision();
    const { broadcastPreferencesSynced } =
      await import('../lib/preferences-broadcast');
    const { projectPreferencesForRuntime } =
      await import('../lib/preferences-store');
    broadcastPreferencesSynced(next, projectPreferencesForRuntime);
  },
  readWorkspaceConfig: async (workspaceId) =>
    (await import('../lib/workspace-persistence')).readWorkspaceConfigDetailed(
      workspaceId,
    ),
  readWorkspaceRevision: async (workspaceId) => {
    const { readW5Revisions } = await import('../lib/w5-commit-log-file-store');
    return (
      (await readW5Revisions([{ kind: 'workspace', workspaceId }]))[0]
        ?.revision ?? 0
    );
  },
  readChatTabs: async (workspaceId, worktreeId) =>
    (await import('../lib/chat-tabs-reader')).readChatTabsFile(
      workspaceId,
      worktreeId,
    ),
  normalizeAccountSelections: async (value) =>
    (await import('../mcp/account-catalog')).normalizeAccountMcpSelections(
      value,
    ),
  normalizeAccountTombstones: async (value) =>
    (await import('../mcp/account-catalog')).normalizeAccountMcpTombstones(
      value,
    ),
};

/** `text` within `max` UTF-16 units, never splitting a surrogate pair. */
function clip(text: string, max: number | null): string {
  if (max === null || text.length <= max) return text;
  const head = text.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(head) ? head.slice(0, -1) : head;
}

const labels = (
  name: string,
  description: string,
): Pick<CatalogEntry, 'name' | 'description'> => ({
  name: clip(name, CatalogEntrySchema.shape.name.maxLength),
  description: clip(
    description,
    CatalogEntrySchema.shape.description.maxLength,
  ),
});

const DISPLAY_NAME_MAX = 256;

const sourceLabel = (label: string): Pick<CatalogEntry, 'sourceLabel'> => ({
  sourceLabel: clip(label, CatalogEntrySchema.shape.name.maxLength),
});

/** The entry's selection ref, when every part fits the schema. */
function selectionRef<T extends Record<string, string>>(
  ref: T,
): { selectionRef: T } | Record<string, never> {
  return Object.values(ref).every(
    (part) => part.length >= 1 && part.length <= 512,
  )
    ? { selectionRef: ref }
    : {};
}

const MEMBERS_MAX = 1024;
const MEMBER_NAME_MAX = 512;
const MEMBER_DESCRIPTION_MAX = 4096;

/** Harness facts within the schema's bounds. */
function boundedHarnesses(
  harnesses: CatalogPluginHarnesses,
): CatalogPluginHarnesses {
  const bound = (harness: CatalogPluginHarness): CatalogPluginHarness => ({
    ...harness,
    members: harness.members.slice(0, MEMBERS_MAX).map((member) => ({
      kind: member.kind,
      name: clip(member.name, MEMBER_NAME_MAX),
      description: clip(member.description, MEMBER_DESCRIPTION_MAX),
    })),
  });
  return {
    claude: bound(harnesses.claude),
    codex: bound(harnesses.codex),
    ollama: bound(harnesses.ollama),
    copilot: bound(harnesses.copilot),
    opencode: bound(harnesses.opencode),
  };
}

interface PluginFacts {
  /** The plugin's description, else its marketplace's. */
  description: string;
  harnesses: CatalogPluginHarnesses;
}

/**
 * The facts the cached marketplace plugin behind each catalog plugin row
 * adds. A cache that can't be read leaves them out.
 */
async function readPluginFacts(
  deps: Pick<
    DesktopCatalogHostDeps,
    'loadMarketplacesCacheOnly' | 'readPluginHarnessFacts'
  >,
): Promise<Map<string, PluginFacts>> {
  const facts = new Map<string, PluginFacts>();
  const cache = await deps.loadMarketplacesCacheOnly();
  if (!cache.success || !cache.data) return facts;
  await Promise.all(
    cache.data.marketplaces.flatMap((marketplace) =>
      marketplace.plugins.map(async (plugin) => {
        let harnesses: CatalogPluginHarnesses;
        try {
          harnesses = await deps.readPluginHarnessFacts(marketplace, plugin);
        } catch (error) {
          // One unreadable plugin root must not fail every snapshot read.
          logMainProcessWarn('Catalog snapshot: plugin facts unreadable', {
            marketplaceId: marketplace.id,
            pluginName: plugin.name,
            reason: error instanceof Error ? error.name : typeof error,
          });
          return;
        }
        facts.set(
          pluginEntryId({
            marketplaceId: marketplace.id,
            pluginName: plugin.name,
          }),
          {
            description: plugin.description ?? marketplace.description ?? '',
            harnesses: boundedHarnesses(harnesses),
          },
        );
      }),
    ),
  );
  return facts;
}

function mcpAvailability(
  server: PortalPluginCatalogMcpServer,
  disabled: boolean,
): CatalogEntry['availability'] {
  if (disabled || server.connectionEnabled === false) return 'disabled';
  if (
    server.connectionState === 'reauth_required' ||
    server.connectionState === 'not_connected'
  )
    return 'auth_required';
  return 'available';
}

function globalRead(preferences: PreferencesData): CatalogSelectionRead {
  const refs = catalogSelectionRefsOf(
    normalizePluginSelections(preferences.globalPluginSelections),
  );
  return {
    revision: catalogContentRevision(refs),
    selections: refs,
    tombstones: null,
  };
}

/** The strict layers of a chat's selection (D9); throws the core-runtime selection errors. */
export async function readDesktopChatSelectionLayers(
  deps: Pick<
    DesktopCatalogHostDeps,
    | 'readPreferences'
    | 'readWorkspaceRevision'
    | 'readWorkspaceConfig'
    | 'readChatTabs'
    | 'normalizeAccountSelections'
    | 'normalizeAccountTombstones'
  >,
  scope: { workspaceId: string; worktreeId: string; chatId: string },
): Promise<{
  read: CatalogSelectionRead;
  effective: ChatTabPluginSelections;
  preferences: PreferencesData;
}> {
  const { preferences, authority } = await deps.readPreferences();
  if (authority === 'unreadable') throw new CatalogSelectionUnavailableError();
  const layerId = pluginDefaultsWorkspaceId({
    projectId: scope.workspaceId,
    worktreeId: scope.worktreeId,
  });
  // App-managed surfaces take no workspace or global layer and have no
  // workspace manifest, so only their chat file is read.
  const uses = chatSurfaceUsesGlobalPluginDefaults(scope.workspaceId);
  let wsRevision = 0;
  let config: WorkspaceConfigFile | null = null;
  if (uses) {
    try {
      wsRevision = await deps.readWorkspaceRevision(layerId);
    } catch (error) {
      throw new CatalogSelectionUnavailableError(error);
    }
    const workspace = await deps.readWorkspaceConfig(layerId);
    if (workspace.authority === 'unreadable')
      throw new CatalogSelectionUnavailableError();
    if (workspace.authority === 'absent')
      throw new CatalogSelectionNotFoundError();
    config = workspace.config;
  }
  let tabs: ChatTabsFile;
  try {
    tabs = await deps.readChatTabs(scope.workspaceId, scope.worktreeId);
  } catch (error) {
    throw new CatalogSelectionUnavailableError(error);
  }
  const tab = tabs.tabs.find((candidate) => candidate.id === scope.chatId);
  if (!tab) throw new CatalogSelectionNotFoundError();
  const local = normalizePluginSelections(tab.pluginSelections);
  const chatTombstones = normalizePluginSelectionTombstones(
    tab.disabledGlobalPluginSelections,
  );
  const inherits = chatInheritsProjectDefaults(tab);
  const effective = config
    ? effectiveChatPluginSelections({
        local: await deps.normalizeAccountSelections(local),
        projectDefaults: inherits
          ? await deps.normalizeAccountSelections(
              normalizePluginSelections(config.defaultPluginSelections),
            )
          : undefined,
        global: await deps.normalizeAccountSelections(
          normalizePluginSelections(preferences.globalPluginSelections),
        ),
        projectTombstones: await deps.normalizeAccountTombstones(
          config.disabledGlobalPluginSelections,
        ),
        chatTombstones: await deps.normalizeAccountTombstones(chatTombstones),
      })
    : await deps.normalizeAccountSelections(local);
  const tombstones = catalogSelectionRefsOf(chatTombstones ?? {});
  const globalTag = globalRead(preferences).revision;
  return {
    read: {
      revision: catalogContentRevision({
        global: globalTag,
        workspace: wsRevision,
        local: catalogSelectionRefsOf(local),
        tombstones,
        inherits,
        uses,
      }),
      selections: catalogSelectionRefsOf(effective),
      tombstones,
    },
    effective,
    preferences,
  };
}

function latestCheck(marketplace: MarketplaceInfo): string | null {
  const stamps = [
    marketplace.providerStatus.claude.lastCheckedAt,
    marketplace.providerStatus.codex.lastCheckedAt,
  ].filter((stamp): stamp is string => Boolean(stamp));
  return stamps.length === 0 ? null : (stamps.sort().reverse()[0] ?? null);
}

const pickStatus = ({
  state,
  accepted,
  pluginCount,
  lastCheckedAt,
}: MarketplaceProviderStatus): Pick<
  MarketplaceProviderStatus,
  'state' | 'accepted' | 'pluginCount' | 'lastCheckedAt'
> => ({ state, accepted, pluginCount, lastCheckedAt });

/** A marketplace as a catalog source, or null when the contract cannot express its locator (D15). */
function marketplaceCatalogSource(
  marketplace: MarketplaceInfo,
  running: string | null,
): CatalogSourceRecord | null {
  const repository =
    marketplace.sourceType === 'github'
      ? parseGitHubRepo(marketplace.sourceUrl)
      : null;
  const locator: CatalogSourceRecord['locator'] | null =
    marketplace.builtIn === true
      ? { kind: 'builtin', builtinId: marketplace.id }
      : marketplace.curated === true
        ? { kind: 'curated', catalogId: marketplace.id }
        : repository
          ? { kind: 'git', repository, ref: null }
          : null;
  if (!locator) return null;
  const accepted = (['claude', 'codex'] as const).filter(
    (provider) => marketplace.providerStatus[provider].accepted,
  );
  const enabled = marketplace.validProviders.length > 0;
  const checked = latestCheck(marketplace);
  const lastRefresh: CatalogSourceRecord['lastRefresh'] =
    running !== null
      ? {
          state: 'running',
          operationId: running,
          completedAt: null,
          errorCode: null,
        }
      : checked === null
        ? { state: 'never' }
        : {
            state: enabled ? 'succeeded' : 'failed',
            operationId: null,
            completedAt: checked,
            errorCode: enabled ? null : 'core.catalog.sourceProviderRejected',
          };
  return {
    sourceId: marketplace.id,
    displayName: clip(marketplace.name || marketplace.id, DISPLAY_NAME_MAX),
    locator,
    providers: accepted.length > 0 ? accepted : ['claude', 'codex'],
    enabled,
    revision: catalogContentRevision({
      id: marketplace.id,
      sourceType: marketplace.sourceType,
      sourceUrl: marketplace.sourceUrl,
      builtIn: marketplace.builtIn === true,
      curated: marketplace.curated === true,
      lastUpdated: marketplace.lastUpdated ?? null,
      providers: {
        claude: pickStatus(marketplace.providerStatus.claude),
        codex: pickStatus(marketplace.providerStatus.codex),
      },
      plugins: marketplace.plugins
        .map((plugin) => [plugin.name, plugin.version ?? null])
        .sort(),
    }),
    lastRefresh,
  };
}

/** Workspace defaults without the legacy bundle ids `core.workspace.plugins.update` does not take. */
function withoutBundleIds({
  bundleIds,
  ...selections
}: ChatTabPluginSelections): Omit<ChatTabPluginSelections, 'bundleIds'> {
  void bundleIds;
  return selections;
}

/** W5 keys are at most 512 characters; a longer namespaced key is hashed. */
const W5_IDEMPOTENCY_KEY_MAX = 512;

function boundedWorkspaceKey(key: string): string {
  return key.length <= W5_IDEMPOTENCY_KEY_MAX
    ? key
    : `catalog-selection:sha256:${createHash('sha256').update(key, 'utf8').digest('hex')}`;
}

const WORKSPACE_REFUSALS: Readonly<Record<string, CatalogHostRefusal>> = {
  'core.workspace.revisionConflict': 'workspace-revision-conflict',
  'core.workspace.notFound': 'workspace-not-found',
  'core.workspace.configurationUnavailable': 'workspace-unavailable',
  'core.workspace.idempotencyKeyReused': 'workspace-key-reused',
  'core.workspace.requestInProgress': 'workspace-in-progress',
  'core.workspace.recoveryRequired': 'workspace-recovery-required',
  'core.workspace.outcomeExpired': 'workspace-outcome-expired',
};

const MUTATIONS_LATER = 'Catalog mutations are served from CAN-4123 PR4.';

export function createDesktopCatalogHost(
  overrides: Partial<DesktopCatalogHostDeps> = {},
): CoreCatalogHost {
  const deps: Omit<DesktopCatalogHostDeps, 'dispatchWorkspacePluginsUpdate'> &
    Partial<Pick<DesktopCatalogHostDeps, 'dispatchWorkspacePluginsUpdate'>> = {
    ...defaultDeps,
    ...overrides,
  };

  const readWorkspace = async (
    workspaceId: string,
  ): Promise<CatalogSelectionRead> => {
    let revision: number;
    try {
      revision = await deps.readWorkspaceRevision(workspaceId);
    } catch (error) {
      throw new CatalogSelectionUnavailableError(error);
    }
    const workspace = await deps.readWorkspaceConfig(workspaceId);
    if (workspace.authority === 'unreadable')
      throw new CatalogSelectionUnavailableError();
    if (workspace.authority === 'absent')
      throw new CatalogSelectionNotFoundError();
    return {
      revision,
      selections: catalogSelectionRefsOf(
        normalizePluginSelections(workspace.config.defaultPluginSelections),
      ),
      tombstones: catalogSelectionRefsOf(
        normalizePluginSelectionTombstones(
          workspace.config.disabledGlobalPluginSelections,
        ) ?? {},
      ),
    };
  };

  const readSelection = async (
    scope: CatalogSelectionScope,
  ): Promise<CatalogSelectionRead> => {
    if (scope.kind === 'global') {
      const { preferences, authority } = await deps.readPreferences();
      if (authority === 'unreadable')
        throw new CatalogSelectionUnavailableError();
      return globalRead(preferences);
    }
    if (scope.kind === 'workspace') return readWorkspace(scope.workspaceId);
    return (await readDesktopChatSelectionLayers(deps, scope)).read;
  };

  const snapshot = async (): Promise<CatalogSnapshotRead> => {
    const catalog = await deps.buildCachedPluginCatalog();
    const pluginFacts = await readPluginFacts(deps);
    const policy = await deps.readInstalledItemPolicy();
    const at = new Date().toISOString();
    const stamp = { revision: 0, createdAt: at, updatedAt: at };
    const collections = await Promise.all(
      catalog.collections.map(async (collection) => ({
        collection,
        members: await deps.readCollection(collection.id),
      })),
    );
    const entries: CatalogEntry[] = [
      ...catalog.skills.map(
        (skill): CatalogEntry => ({
          entryId: skillEntryId(skill),
          kind: 'skill',
          ...labels(skill.name, skill.description),
          ...sourceLabel(skill.source),
          source: skill.builtIn === true ? 'bundled' : 'user',
          content: {
            kind: 'skill',
            entrypoint: null,
            ...selectionRef({
              sourceId: skill.sourceId,
              skillName: skill.skillName,
            }),
          },
          availability: policy.isDisabled({
            kind: 'skill',
            sourceId: skill.sourceId,
            skillName: skill.skillName,
          })
            ? 'disabled'
            : 'available',
          ...stamp,
        }),
      ),
      ...catalog.plugins.map((plugin): CatalogEntry => {
        const facts = pluginFacts.get(pluginEntryId(plugin));
        return {
          entryId: pluginEntryId(plugin),
          kind: 'plugin',
          ...labels(plugin.name, facts?.description ?? plugin.description),
          ...sourceLabel(plugin.marketplaceName),
          source: 'plugin',
          content: {
            kind: 'plugin',
            manifest: {
              name: plugin.pluginName,
              version: '',
              capabilities: [],
              dependencies: [],
              providerSupport: {
                claude: plugin.claudeSupported,
                codex: plugin.codexSupported,
              },
            },
            ...(facts ? { harnesses: facts.harnesses } : {}),
            ...selectionRef({
              marketplaceId: plugin.marketplaceId,
              pluginName: plugin.pluginName,
            }),
          },
          availability: policy.isDisabled({
            kind: 'plugin',
            marketplaceId: plugin.marketplaceId,
            pluginName: plugin.pluginName,
          })
            ? 'disabled'
            : !plugin.claudeSupported && !plugin.codexSupported
              ? 'incompatible'
              : 'available',
          ...stamp,
        };
      }),
      ...catalog.mcpServers.map(
        (server): CatalogEntry => ({
          entryId: mcpServerEntryId(server),
          kind: 'mcp_server',
          ...labels(server.serverName, server.description),
          ...sourceLabel(server.serverName),
          source: 'user',
          content: {
            kind: 'mcp_server',
            transport: server.transport === 'command' ? 'stdio' : 'http',
            commandRef: null,
            url: null,
            authIntegrationId: server.connectionId ?? null,
            ...(server.connectionState === undefined
              ? {}
              : { connectionState: server.connectionState }),
            ...(server.enabledTools === undefined
              ? {}
              : { enabledTools: server.enabledTools }),
            ...(server.configName
              ? { configName: clip(server.configName, MEMBER_NAME_MAX) }
              : {}),
            ...selectionRef({
              serverId: server.serverId,
              configId: server.configId,
            }),
          },
          availability: mcpAvailability(
            server,
            policy.isDisabled({
              kind: 'mcp-config',
              serverId: server.serverId,
              configId: server.configId,
            }),
          ),
          ...stamp,
        }),
      ),
      ...collections.map(
        ({ collection, members }): CatalogEntry => ({
          entryId: collectionEntryId(collection.id),
          kind: 'collection',
          ...labels(collection.name, collection.description),
          source: 'user',
          content: {
            kind: 'collection',
            entryIds: members
              ? selectionEntryIds({
                  skillRefs: members.skills,
                  pluginRefs: members.plugins,
                  mcpServerRefs: members.mcpServers ?? [],
                })
              : [],
          },
          availability: policy.isDisabled({
            kind: 'collection',
            collectionId: collection.id,
          })
            ? 'disabled'
            : members === null
              ? 'missing'
              : 'available',
          ...stamp,
        }),
      ),
    ];
    const refs: CatalogSelectionRefs = {
      collectionIds: catalog.collections.map((collection) => collection.id),
      skillRefs: catalog.skills.map((skill) => ({
        sourceId: skill.sourceId,
        skillName: skill.skillName,
      })),
      pluginRefs: catalog.plugins.map((plugin) => ({
        marketplaceId: plugin.marketplaceId,
        pluginName: plugin.pluginName,
      })),
      mcpServerRefs: catalog.mcpServers.map((server) => ({
        serverId: server.serverId,
        configId: server.configId,
      })),
    };
    return { entries, refs };
  };

  return {
    snapshot,
    readSelection,
    replaceGlobalSelection: async (expectedRevision, refs) => {
      let conflict = false;
      let change: { previous: PreferencesData; next: PreferencesData };
      try {
        change = await deps.updatePreferences((latest) => {
          const current = normalizePluginSelections(
            latest.globalPluginSelections,
          );
          if (
            catalogContentRevision(catalogSelectionRefsOf(current)) !==
            expectedRevision
          ) {
            conflict = true;
            return null;
          }
          return { globalPluginSelections: { ...current, ...refs } };
        });
      } catch (error) {
        if (
          (typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === 'PREFERENCES_RECOVERY_REQUIRED') ||
          isStorageOutcomeUnknownError(error)
        )
          throw new CatalogSelectionUnavailableError(error);
        throw error;
      }
      if (
        !conflict &&
        !pluginSelectionsEqual(
          normalizePluginSelections(change.previous.globalPluginSelections),
          normalizePluginSelections(change.next.globalPluginSelections),
        )
      ) {
        try {
          await deps.afterGlobalSelectionChanged(change.next);
        } catch (error) {
          logMainProcessWarn(
            '[core-catalog] global plugin defaults changed, but sessions were not notified',
            error,
          );
        }
      }
      return {
        outcome: conflict ? 'conflict' : 'replaced',
        read: globalRead(change.next),
      };
    },
    replaceWorkspaceSelection: async (request) => {
      const current = await deps.readWorkspaceConfig(request.workspaceId);
      if (current.authority === 'absent')
        throw new CatalogHostRefusedError('workspace-not-found');
      if (current.authority === 'unreadable')
        throw new CatalogHostRefusedError('workspace-unavailable');
      const existing = withoutBundleIds(
        normalizePluginSelections(current.config.defaultPluginSelections),
      );
      const parsed = CoreWorkspacePluginsUpdateParamsSchema.safeParse({
        workspaceId: request.workspaceId,
        expectedRevision: request.expectedRevision,
        change: {
          kind: 'setDefaults',
          defaultPluginSelections: { ...existing, ...request.refs },
        },
        _meta: { idempotencyKey: boundedWorkspaceKey(request.idempotencyKey) },
      });
      if (!parsed.success)
        throw new CatalogHostRefusedError(
          'workspace-unavailable',
          parsed.error,
        );
      const dispatch = deps.dispatchWorkspacePluginsUpdate;
      if (!dispatch) throw new CatalogHostRefusedError('workspace-unavailable');
      let committed: CoreWorkspacePluginsUpdateResult;
      try {
        committed = await dispatch(parsed.data, {
          ...request.caller,
          grants: ['core.workspace.write'],
        });
      } catch (error) {
        const code =
          error instanceof CanopyOperationError
            ? error.payload.code
            : undefined;
        const refusal =
          code === undefined ? undefined : WORKSPACE_REFUSALS[code];
        if (refusal) throw new CatalogHostRefusedError(refusal, error);
        throw error;
      }
      const after = await readWorkspace(request.workspaceId);
      // A replayed W5 receipt reports the defaults that request committed.
      return committed.defaultPluginSelections
        ? {
            ...after,
            selections: catalogSelectionRefsOf(
              normalizePluginSelections(committed.defaultPluginSelections),
            ),
          }
        : after;
    },
    listSources: async () => {
      const cache = await deps.loadMarketplacesCacheOnly();
      if (!cache.success || !cache.data)
        throw new Error('The plugin cache cannot be read right now.');
      return cache.data.marketplaces
        .map((marketplace) =>
          marketplaceCatalogSource(
            marketplace,
            runningCatalogRefresh(marketplace.id),
          ),
        )
        .filter((source): source is CatalogSourceRecord => source !== null);
    },
    addGitSource: () => Promise.reject(new Error(MUTATIONS_LATER)),
    deleteSource: () => Promise.reject(new Error(MUTATIONS_LATER)),
    refreshSources: () => Promise.reject(new Error(MUTATIONS_LATER)),
    findPlugin: () => Promise.reject(new Error(MUTATIONS_LATER)),
    installPlugin: () => Promise.reject(new Error(MUTATIONS_LATER)),
  };
}
