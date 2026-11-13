import { readFile } from 'node:fs/promises';
import { BRAND } from '@canopy/brand/current';
import { parseAgentRouteModelId } from '@canopy/protocol/agents';
import { PIPELINE_PACKAGE_VERSION_HEADER } from '@canopy/protocol/pipelines';
import type { BackgroundCapabilities } from '@canopy/desktop-shared/node/background-execution-context';
import {
  normalizeResourceContextSubjectName,
  type ResourceContextDecision,
  type ResourceContextInput,
  type ResourceContextSubject,
} from '@canopy/execution-engine/lib/resource-context-policy';
import type { ChatTabPluginSelections } from '@canopy/desktop-shared/types';
import type { AgentModelDefinition } from '@canopy/execution-engine/types/agent-models';
import { normalizeMcpServerFile } from '@canopy/execution-engine/types/mcp-servers';
import { normalizePluginSelections } from '@canopy/execution-engine/lib/plugin-selections-normalization';
import { getPipelinePluginDefaultKey } from '@canopy/execution-engine/pipelines/plugin-collections';
import type { ShareablePluginCatalog } from '../plugins/shareable-plugin-resolution';
import { getAgentModelsFilePath, getMcpServerFilePath } from '../lib/paths';
import { readCanopyCloudAccountWithStatus } from '../lib/canopy-cloud-account-store';
import { createResourceInstallReceiptsStore } from '../lib/resource-install-receipts';

type Resource = ResourceContextInput['resource'];
const local: Resource = { owner: { shareScope: 'private' } };
const missing: ResourceContextDecision = {
  allow: false,
  reason: 'missing-dependency',
};
const unknown: ResourceContextDecision = {
  allow: false,
  reason: 'unknown-provenance',
};
/** Verification could not complete; not a verdict on the resource. */
const unavailable: ResourceContextDecision = {
  allow: false,
  reason: 'unknown-provenance',
  transient: true,
};
const RECEIPT_LOOKUP_PARTITION = 'background-capability-lookup';
const LOCAL_PROVIDER_MARKETPLACE_SOURCE_TYPES = new Set([
  'github',
  'local',
  'directory',
  'codex',
  'curated',
]);

type ConfiguredAgent = Pick<
  AgentModelDefinition,
  'remoteId' | 'importedFromRemoteId' | 'pluginSelections'
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/** Read only the fields authorization needs from a version 1 agent models file. */
function findConfiguredAgent(
  parsed: unknown,
  id: string,
): ConfiguredAgent | undefined {
  if (
    !isRecord(parsed) ||
    parsed.version !== 1 ||
    !Array.isArray(parsed.agents)
  )
    return undefined;
  const row: unknown = parsed.agents.find(
    (agent: unknown) => isRecord(agent) && agent.id === id,
  );
  if (!isRecord(row)) return undefined;
  const remoteId = optionalString(row.remoteId);
  const importedFromRemoteId = optionalString(row.importedFromRemoteId);
  return {
    ...(remoteId ? { remoteId } : {}),
    ...(importedFromRemoteId ? { importedFromRemoteId } : {}),
    pluginSelections: normalizePluginSelections(row.pluginSelections),
  };
}

/** Per-authorization inventory, never the currently selected UI context or a durable grant. */
export function createBackgroundCapabilityResolver(
  decide: (resource: Resource) => Promise<ResourceContextDecision>,
): (capabilities: BackgroundCapabilities) => Promise<ResourceContextDecision> {
  let skillsPromise: Promise<ShareablePluginCatalog['skills']> | undefined;
  let catalogPromise: Promise<ShareablePluginCatalog> | undefined;
  function skills(): Promise<ShareablePluginCatalog['skills']> {
    return (skillsPromise ??= (async (): Promise<
      ShareablePluginCatalog['skills']
    > => {
      // Defer the heavy skill inventory until background authorization needs it.
      const { loadSkills } = await import('../skills/skill-service');
      const result = loadSkills();
      if (!result.success || !result.data)
        throw new Error('Skill inventory unavailable');
      return result.data;
    })());
  }
  function catalog(): Promise<ShareablePluginCatalog> {
    return (catalogPromise ??= (async (): Promise<ShareablePluginCatalog> => {
      // Defer plugin inventory and provider scans until a plugin is selected.
      const { loadMarketplaces } = await import('../plugins/plugin-service');
      const marketplaces = await loadMarketplaces();
      if (!marketplaces.success || !marketplaces.data)
        throw new Error('Plugin inventory unavailable');
      return {
        skills: await skills(),
        marketplaces: marketplaces.data.marketplaces,
      };
    })());
  }

  async function authorize(
    resource: Resource,
  ): Promise<ResourceContextDecision> {
    const result = await decide(resource);
    if (
      result.allow ||
      result.reason !== 'unknown-provenance' ||
      result.subject ||
      !resource.subject
    )
      return result;
    const subjectName = normalizeResourceContextSubjectName(
      resource.subject.name,
    );
    return subjectName
      ? { ...result, subject: { ...resource.subject, name: subjectName } }
      : result;
  }

  async function installed(
    family: 'skills' | 'collections' | 'agents' | 'automations',
    id: string,
    remoteId?: string,
    {
      requireReceipt = false,
      fromPublicShare = false,
      subject,
    }: {
      requireReceipt?: boolean;
      fromPublicShare?: boolean;
      subject?: ResourceContextSubject;
    } = {},
  ): Promise<ResourceContextDecision> {
    // findLocal scans every account partition; the key only has to be non-empty.
    const binding = await createResourceInstallReceiptsStore(
      RECEIPT_LOOKUP_PARTITION,
    ).findLocal(family, id);
    // A definition known to come from a share is never relabelled local. Its
    // receipt may not be recorded yet (installs made before the gate was on
    // gain one on a foreground read), so deny without treating it as a verdict.
    if (!binding && requireReceipt) return unavailable;
    // Items with no install receipt and no remote origin are purely local, so
    // their authority does not depend on the account; an unreadable account
    // must not deny them. Anything installed from an account still does.
    if (!binding && !remoteId)
      return authorize({ ...local, ...(subject ? { subject } : {}) });
    const account = await readCanopyCloudAccountWithStatus();
    if (account.status !== 'ok') return unavailable;
    const accountId = account.entry?.account?.id;
    // A Public share is readable by anyone, so its install is not tied to the
    // account, if any, that was signed in when it was made.
    const publicCollection =
      family === 'collections' &&
      (binding
        ? binding.receipt.sourceKind === 'public-share'
        : fromPublicShare);
    if (
      binding &&
      !publicCollection &&
      (!accountId || binding.accountId !== accountId)
    )
      return { allow: false, reason: 'access-removed' };
    const origin = binding?.receipt.remoteId ?? remoteId;
    if (!origin) return decide(local);
    if (!accountId && !publicCollection)
      return { allow: false, reason: 'access-removed' };
    // The authenticated detail request rechecks current family grants. Its result is
    // checked below against the persisted background context, never foreground selection.
    // Defer cloud clients for the common local-only authorization path.
    const { requestCanopyCloudJson, isTransientCanopyCloudFailure } =
      await import('../canopy-cloud/client');
    // Defer version negotiation with the cloud client on that same remote path.
    const { withPackageVersionNegotiation } =
      await import('../canopy-cloud/package-version-negotiation');
    let detail: { owner?: unknown };
    try {
      if (publicCollection) {
        const { getPublicCollectionShareSnapshot } =
          await import('../canopy-cloud/public-share-client');
        await getPublicCollectionShareSnapshot(origin);
        detail = { owner: { shareScope: 'private' } };
      } else {
        detail = await withPackageVersionNegotiation((version) =>
          requestCanopyCloudJson<{ owner?: unknown }>(
            `/api/v1/${BRAND.web.apiNamespace}/${family}/${encodeURIComponent(origin)}`,
            { headers: { [PIPELINE_PACKAGE_VERSION_HEADER]: String(version) } },
          ),
        );
      }
    } catch (error) {
      // An outage must not be read as lost access; a real rejection still is.
      if (isTransientCanopyCloudFailure(error)) return unavailable;
      throw error;
    }
    const after = await readCanopyCloudAccountWithStatus();
    if (after.status !== 'ok') return unavailable;
    if (after.entry?.account?.id !== accountId)
      return { allow: false, reason: 'access-removed' };
    return authorize({
      owner: detail.owner,
      ...(binding ? { provenance: binding.receipt } : {}),
      ...(subject ? { subject } : {}),
    });
  }

  async function sharedPipeline(
    remoteId: string,
  ): Promise<ResourceContextDecision> {
    const before = await readCanopyCloudAccountWithStatus();
    if (before.status !== 'ok') return unavailable;
    const accountId = before.entry?.account?.id;
    if (!accountId) return { allow: false, reason: 'access-removed' };
    const {
      CanopyCloudClientError,
      isTransientCanopyCloudFailure,
      requestCanopyCloudJson,
    } = await import('../canopy-cloud/client');
    const { withPackageVersionNegotiation } =
      await import('../canopy-cloud/package-version-negotiation');
    let detail: { owner?: unknown };
    try {
      detail = await withPackageVersionNegotiation((version) =>
        requestCanopyCloudJson<{ owner?: unknown }>(
          `/api/v1/${BRAND.web.apiNamespace}/pipelines/${encodeURIComponent(remoteId)}`,
          { headers: { [PIPELINE_PACKAGE_VERSION_HEADER]: String(version) } },
        ),
      );
    } catch (error) {
      if (isTransientCanopyCloudFailure(error)) return unavailable;
      if (
        error instanceof CanopyCloudClientError &&
        error.isValidatedServerError &&
        (error.status === 403 || error.status === 404)
      )
        return { allow: false, reason: 'access-removed' };
      throw error;
    }
    const after = await readCanopyCloudAccountWithStatus();
    if (after.status !== 'ok') return unavailable;
    if (
      after.entry?.account?.id !== accountId ||
      after.entry?.apiKey !== before.entry?.apiKey
    )
      return { allow: false, reason: 'access-removed' };
    return authorize({ owner: detail.owner });
  }

  async function selections(
    value: ChatTabPluginSelections | undefined,
    visited = new Set<string>(),
  ): Promise<ResourceContextDecision> {
    if (!value) return { allow: true };
    for (const id of Array.from(
      new Set([...(value.collectionIds ?? []), ...(value.bundleIds ?? [])]),
    )) {
      if (!/^[a-f0-9-]+$/.test(id) || visited.has(id) || visited.size >= 16)
        return unknown;
      // Defer collection storage until a collection reference is present.
      const { readCollectionConfigForBackgroundAuthorization } =
        await import('../collections/collection-store');
      const file = await readCollectionConfigForBackgroundAuthorization(id);
      if (!file || file.version !== 2 || file.collection?.id !== id)
        return missing;
      const result = await installed(
        'collections',
        id,
        file.collection.sharedSource?.remoteId,
        { fromPublicShare: file.collection.sharedSource?.fromPublicShare },
      );
      if (!result.allow) return result;
      const members = await selections(
        {
          collectionIds: [],
          skillRefs: file.collection.skills,
          pluginRefs: file.collection.plugins,
          mcpServerRefs: file.collection.mcpServers,
        },
        new Set([...Array.from(visited), id]),
      );
      if (!members.allow) return members;
    }
    for (const ref of value.skillRefs ?? []) {
      const skill = (await skills()).find(
        (row) => row.sourceId === ref.sourceId && row.name === ref.skillName,
      );
      if (!skill) return missing;
      const result = await installed(
        'skills',
        `${ref.sourceId}/${ref.skillName}`,
        undefined,
        { subject: { kind: 'skill', name: skill.name } },
      );
      if (!result.allow) return result;
    }
    for (const ref of value.pluginRefs ?? []) {
      const inventory = await catalog();
      const marketplace = inventory.marketplaces.find(
        (row) => row.id === ref.marketplaceId,
      );
      const plugin = marketplace?.plugins.find(
        (row) => row.name === ref.pluginName,
      );
      if (!plugin) return missing;
      const result = await authorize({
        owner:
          marketplace?.builtIn === true
            ? { type: 'system' }
            : (plugin.owner ??
              marketplace?.owner ??
              (marketplace &&
              LOCAL_PROVIDER_MARKETPLACE_SOURCE_TYPES.has(
                marketplace.sourceType,
              )
                ? local.owner
                : undefined)),
        subject: {
          kind: 'plugin',
          name: plugin.displayName?.trim() || plugin.name,
        },
      });
      if (!result.allow) return result;
    }
    for (const ref of value.mcpServerRefs ?? []) {
      let subjectName: string;
      if (ref.serverId.startsWith('account:')) {
        // Defer cloud MCP inventory for local MCP selections.
        const { listAccountMcpConnections } =
          await import('../canopy-cloud/mcp-connections');
        const connections = await listAccountMcpConnections();
        const connection = connections.find(
          (row) =>
            `account:${row.id}` === ref.serverId &&
            row.configId === ref.configId &&
            row.status === 'CONNECTED' &&
            row.enabled !== false,
        );
        if (!connection) return missing;
        subjectName = connection.displayName;
      } else {
        const file = normalizeMcpServerFile(
          JSON.parse(
            await readFile(getMcpServerFilePath(ref.serverId), 'utf8'),
          ),
          ref.serverId,
        );
        if (
          !file.server.configs.some(
            (row) => row.id === ref.configId && row.enabled,
          )
        )
          return missing;
        subjectName = file.server.definition.name;
      }
      const result = await authorize({
        ...local,
        subject: { kind: 'mcp', name: subjectName },
      });
      if (!result.allow) return result;
    }
    return { allow: true };
  }

  async function model(
    id: string | undefined,
  ): Promise<ResourceContextDecision> {
    if (!id?.startsWith('agent_model_')) return { allow: true };
    // A chat route id is authorized as the Agent it pins.
    const agentId = parseAgentRouteModelId(id)?.agentId ?? id;
    const agent = findConfiguredAgent(
      JSON.parse(await readFile(getAgentModelsFilePath(), 'utf8')),
      agentId,
    );
    if (!agent) return missing;
    const result = await installed(
      'agents',
      agentId,
      agent.importedFromRemoteId ?? agent.remoteId,
    );
    return result.allow ? selections(agent.pluginSelections) : result;
  }

  async function portable(
    refs: NonNullable<BackgroundCapabilities['plugins']>,
  ): Promise<ResourceContextDecision> {
    if (!refs.length) return { allow: true };
    // Defer portable-plugin matching until the resource graph names one.
    const { matchShareablePluginRef } =
      await import('../plugins/shareable-plugin-resolution');
    const inventory = await catalog();
    for (const ref of refs) {
      const match = matchShareablePluginRef(ref, inventory);
      if (match.matchState !== 'matched') return missing;
      const selected = match.selection;
      const result = await selections({
        collectionIds: [],
        skillRefs:
          selected.kind === 'skill'
            ? [{ sourceId: selected.sourceId, skillName: selected.skillName }]
            : [],
        pluginRefs:
          selected.kind === 'plugin'
            ? [
                {
                  marketplaceId: selected.marketplaceId,
                  pluginName: selected.pluginName,
                },
              ]
            : [],
      });
      if (!result.allow) return result;
    }
    return { allow: true };
  }

  return async (capabilities): Promise<ResourceContextDecision> => {
    if (capabilities.sharedPipeline) {
      const origin = await sharedPipeline(capabilities.sharedPipeline.remoteId);
      if (!origin.allow) return origin;
    }
    if (capabilities.installedAutomation) {
      const origin = await installed(
        'automations',
        capabilities.installedAutomation.id,
        undefined,
        { requireReceipt: true },
      );
      if (!origin.allow) return origin;
    }
    const selected = await selections(capabilities.selections);
    if (!selected.allow) return selected;
    const referenced = await portable(capabilities.plugins ?? []);
    if (!referenced.allow) return referenced;
    const configuredModel = await model(capabilities.model);
    if (!configuredModel.allow) return configuredModel;
    const pipeline = capabilities.pipeline;
    if (!pipeline) return { allow: true };
    const location = capabilities.location;
    // Keep preference storage out of authorization paths without a pipeline.
    const {
      loadPipelinePluginCollectionPreferences,
      loadPipelineModelAliasPreferences,
      normalizePipelinePluginCollectionPreferences,
      normalizePipelineModelAliasPreferences,
    } =
      await import('@canopy/execution-engine/node/pipelines/plugin-collection-store');
    const locator = location?.preferencesResolved
      ? undefined
      : location?.pipelinePreferenceLocator;
    const preferences = {
      ...(locator ? loadPipelinePluginCollectionPreferences(locator) : {}),
      ...normalizePipelinePluginCollectionPreferences(
        location?.pluginCollectionPreferences,
      ),
    };
    if (location?.resolvedPluginCollections) {
      for (const [collectionId, snapshot] of Object.entries(
        location.resolvedPluginCollections,
      )) {
        const originals = await selections({
          collectionIds:
            snapshot.sourceCollectionIds ??
            preferences[collectionId]?.extraSelections.collectionIds ??
            [],
          skillRefs: [],
          pluginRefs: [],
        });
        if (!originals.allow) return originals;
        const result = await selections(snapshot.selections);
        if (!result.allow) return result;
      }
    } else {
      for (const collection of pipeline.plugin_collections ?? []) {
        const preference = preferences[collection.id];
        for (const ref of collection.defaults) {
          if (
            !ref.required &&
            preference?.disabledDefaultKeys.includes(
              getPipelinePluginDefaultKey(ref),
            )
          )
            continue;
          const result = await portable([ref]);
          if (
            !result.allow &&
            (ref.required || result.reason !== 'missing-dependency')
          )
            return result;
        }
        const result = await selections(preference?.extraSelections);
        if (!result.allow) return result;
      }
    }
    for (const dependency of pipeline.dependencies ?? []) {
      if (dependency.kind === 'skill' || dependency.kind === 'plugin') {
        const result = await portable([dependency.ref]);
        if (
          !result.allow &&
          (dependency.required || result.reason !== 'missing-dependency')
        )
          return result;
      }
      // MCP/connector/runtime/package requirements are readiness declarations,
      // not ownership claims. Actual selected MCP configurations are checked above.
    }
    const aliases = {
      ...(locator ? loadPipelineModelAliasPreferences(locator) : {}),
      ...normalizePipelineModelAliasPreferences(
        location?.modelAliasPreferences,
      ),
    };
    for (const alias of pipeline.model_aliases ?? []) {
      const rawPreference = location?.modelAliasPreferences?.[alias.id];
      const preference =
        rawPreference &&
        typeof rawPreference === 'object' &&
        'mode' in rawPreference &&
        rawPreference.mode === 'reset'
          ? { mode: 'reset' as const }
          : aliases[alias.id];
      const defaults =
        preference?.mode === 'reset'
          ? alias.defaults
          : (preference ?? alias.defaults);
      const result = await model(
        defaults && 'agent_id' in defaults ? defaults.agent_id : undefined,
      );
      if (!result.allow) return result;
    }
    return { allow: true };
  };
}
