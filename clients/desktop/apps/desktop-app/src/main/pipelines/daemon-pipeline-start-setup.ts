import * as path from 'node:path';
import { readFile, realpath } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import {
  WorkerPipelineStartSetupSchema,
  WorkerPipelineOwnerRequestSchema,
  WorkerPipelineOwnerResultSchema,
  type WorkerPipelineHostLaunch,
  type WorkerPipelineSetupFact,
  type WorkerPipelineStartSetup,
  type WorkerPipelineSetupFailure,
} from '@canopy/protocol/canopy-core';
import {
  pipelineSetupFactRoots,
  readPipelineSetupFactVersion,
  claudeNativeConfigurationFacts,
  codexNativeConfigurationFacts,
  localPipelineAgentId,
  localPipelineAgentMatches,
  localPipelinePluginFacts,
  readLocalPipelineAgentStore,
} from '@canopy/core-runtime/node/pipeline/host/start-setup';
import type { PipelineAgentModelAliasResolution } from '@canopy/execution-engine/node/pipelines/executor/types';
import {
  isForbiddenCodexSpawnEnvironmentKey,
  sanitizeCodexSpawnEnvironment,
} from '@canopy/execution-engine/node/codex-runtime/profile';
import type { DaemonPipelineModelSelection } from '@canopy/execution-engine/node/pipelines/daemon-eligibility';
import { parseSettingSources } from '@canopy/execution-engine/builtin-actions/agent-prompt/logic';
import {
  findClaudeProjectGitRoot,
  listClaudeAutoLoadedPlugins,
} from '@canopy/execution-engine/node/plugins/claude-mod-admission';
import { resolveClaudeModAdmissionContext } from '../agents/claude-mod-admission-launch';
import type { NativePipelineRouteInspection } from './daemon-pipeline-native-admission';
import { getDataDir } from '../lib/paths';
import { getCodexRuntimeService } from '../codex/runtime-service';
import { resolveEffectivePluginSelectionRefs } from '../plugins/plugin-resolver';
import { normalizePluginSelections } from '@canopy/execution-engine/lib/plugin-selections-normalization';

type FactSpec = Omit<WorkerPipelineSetupFact, 'id' | 'version'>;
type SetupBlocker =
  | 'owner-mcp'
  | 'managed-configuration'
  | 'setup-lease'
  | 'configuration-unverified'
  | 'environment-route';

export async function isNativePipelineStartSetupCurrent(input: {
  readonly setup: WorkerPipelineStartSetup;
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
}): Promise<boolean> {
  const roots = pipelineSetupFactRoots({
    cwd: input.cwd,
    dataRoot: getDataDir(),
    environment: input.environment,
  });
  for (const fact of input.setup.facts)
    if (
      (await readPipelineSetupFactVersion(
        roots[fact.root],
        fact,
        hostOperatingSystem(),
      )) !== fact.version
    )
      return false;
  return true;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function nativeSettingsBlocker(
  file: string,
): Promise<SetupBlocker | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (!record(value)) return 'configuration-unverified';
    // No unknown setting may gain authority merely by not matching today's
    // dependency denylist. Expand this subset only with a classified source.
    for (const [key, setting] of Object.entries(value)) {
      if (
        ['env', 'hooks', 'mcpServers', 'enabledPlugins'].includes(key) &&
        record(setting) &&
        Object.keys(setting).length === 0
      )
        continue;
      if (
        key === 'enabledMcpjsonServers' &&
        Array.isArray(setting) &&
        setting.length === 0
      )
        continue;
      if (key === 'enableAllProjectMcpServers' && setting === false) continue;
      if (
        [
          'mcpServers',
          'enabledMcpjsonServers',
          'enableAllProjectMcpServers',
          'enabledPlugins',
        ].includes(key)
      )
        return 'owner-mcp';
      if (
        [
          'env',
          'apiKeyHelper',
          'awsAuthRefresh',
          'awsCredentialExport',
          'gcpAuthRefresh',
          'proxyAuthHelper',
          'forceLoginGatewayUrl',
        ].includes(key)
      )
        return 'environment-route';
      if (['policyHelper', 'policyHelpers'].includes(key))
        return 'managed-configuration';
      return 'configuration-unverified';
    }
    return undefined;
  } catch (error) {
    return record(error) && error.code === 'ENOENT'
      ? undefined
      : 'configuration-unverified';
  }
}

/** Uses the existing Mod resolver, bracketed by independent disk observations. */
export async function buildNativePipelineStartSetup(input: {
  readonly launch: Omit<WorkerPipelineHostLaunch, 'secretEnv'>;
  readonly selections: readonly DaemonPipelineModelSelection[];
  readonly environment: Readonly<Record<string, string>>;
  readonly resolveAgent?: (
    agentId: string,
  ) => Promise<PipelineAgentModelAliasResolution | null>;
  readonly onBlocker?: (
    blocker: SetupBlocker,
    reason: WorkerPipelineSetupFailure,
  ) => void;
}): Promise<WorkerPipelineStartSetup | undefined> {
  const { launch, selections, environment } = input;
  const operatingSystem = hostOperatingSystem();
  const decline = (
    reason: WorkerPipelineSetupFailure,
    blocker: SetupBlocker = 'setup-lease',
  ): undefined => {
    input.onBlocker?.(blocker, reason);
    return undefined;
  };
  if (operatingSystem !== 'darwin' && operatingSystem !== 'linux')
    return decline('unsupported-platform');
  // Collections and inherited selections still need their own provenance proof.
  if (
    Object.keys(launch.pluginCollectionSnapshots ?? {}).length > 0 ||
    Object.keys(launch.modelAliasResolutions ?? {}).some(
      (aliasId) =>
        !selections.some((selection) => selection.aliasId === aliasId),
    )
  )
    return decline('resource-selection');
  const worktreeRoot = await realpath(launch.cwd);
  const roots = pipelineSetupFactRoots({
    cwd: worktreeRoot,
    dataRoot: getDataDir(),
    environment,
  });
  const specs = new Map<string, FactSpec>();
  const add = (fact: FactSpec): void => {
    specs.set(`${fact.root}:${fact.relativePath}:${fact.projection}`, fact);
  };
  const aliasIds = [
    ...new Set(
      selections.flatMap((selection) =>
        selection.aliasId ? [selection.aliasId] : [],
      ),
    ),
  ];
  if (aliasIds.length) {
    add({
      root: 'data',
      relativePath: 'agent-models.json',
      projection: 'content',
    });
    add({
      root: 'data',
      relativePath: 'workspace-context.json',
      projection: 'content',
    });
    // Even a retained/tombstoned receipt makes local provenance unproven.
    add({
      root: 'data',
      relativePath: 'resource-install-receipts.json',
      projection: 'absence',
    });
  }
  const initialAliases = new Map<
    string,
    Extract<
      WorkerPipelineStartSetup['leases'][number]['result'],
      { kind: 'model.agentAlias' }
    >
  >();
  let resourcePolicy = false;
  let codexResourcePolicy = false;
  const resourceFactIds = new Set<string>();
  for (const aliasId of aliasIds) {
    const agentId = localPipelineAgentId(launch, aliasId);
    if (!agentId || !input.resolveAgent) return decline('resource-selection');
    const result = WorkerPipelineOwnerResultSchema.safeParse({
      kind: 'model.agentAlias',
      alias: await input.resolveAgent(agentId),
    });
    if (
      !result.success ||
      result.data.kind !== 'model.agentAlias' ||
      !result.data.alias ||
      !localPipelineAgentMatches(
        await readLocalPipelineAgentStore(roots.data),
        agentId,
        result.data,
      )
    )
      return decline('resource-selection');
    const resourceFacts = await localPipelinePluginFacts({
      dataRoot: roots.data,
      cwd: worktreeRoot,
      selections: result.data.alias.pluginSelections,
      harnesses: selections
        .filter((selection) => selection.aliasId === aliasId)
        .map((selection) => selection.harness),
    });
    if (!resourceFacts) return decline('resource-selection');
    if (resourceFacts.length > 0) resourcePolicy = true;
    if (
      resourceFacts.some(
        (fact) =>
          fact.root === 'codex-config' && fact.relativePath === 'plugins',
      )
    )
      codexResourcePolicy = true;
    for (const fact of resourceFacts) {
      add(fact);
      resourceFactIds.add(
        `${fact.root}:${fact.relativePath}:${fact.projection}`,
      );
    }
    initialAliases.set(aliasId, result.data);
  }
  if (resourcePolicy) {
    // Installed-item policy reads the app's canonical vendor profiles, not
    // per-step environment overrides. Do not fingerprint a different source.
    const policyRoots = pipelineSetupFactRoots({
      cwd: worktreeRoot,
      dataRoot: roots.data,
      environment: Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
    });
    if (policyRoots['claude-config'] !== roots['claude-config'])
      return decline('resource-selection');
    if (
      codexResourcePolicy &&
      (policyRoots['codex-config'] !== roots['codex-config'] ||
        policyRoots.home !== roots.home)
    )
      return decline('resource-selection');
  }
  if (selections.some((selection) => selection.harness === 'claude')) {
    // WSL's additional Windows registry/policy chain is not classified here.
    if (environment.WSL_DISTRO_NAME || environment.WSL_INTEROP) {
      return decline('managed-policy', 'managed-configuration');
    }
    for (const fact of claudeNativeConfigurationFacts(
      operatingSystem,
      environment,
    ))
      add(fact);
  }
  add({
    root: 'data',
    relativePath: 'preferences.json',
    projection: 'preferences',
  });
  add({
    root: 'data',
    relativePath: 'model-policy-marker.json',
    projection: 'content',
  });
  add({
    root: 'data',
    relativePath: 'model-gateway-marker.json',
    projection: 'content',
  });
  if (selections.some((selection) => selection.harness === 'codex'))
    add({
      root: 'codex-config',
      relativePath: 'config.toml',
      projection: 'content',
    });
  const hasCodex = selections.some(
    (selection) => selection.harness === 'codex',
  );
  // Codex strips injected home/profile overrides. Fingerprint only the profile
  // the real app-server will use, rather than a discarded override.
  if (
    hasCodex &&
    Object.entries(environment).some(
      ([key, value]) =>
        isForbiddenCodexSpawnEnvironmentKey(key) && value !== process.env[key],
    )
  )
    return decline('codex-profile-mismatch');
  if (hasCodex) {
    for (const fact of codexNativeConfigurationFacts(operatingSystem))
      add(fact);
    add({
      root: 'worktree',
      relativePath: '.codex/config.toml',
      projection: 'content',
    });
  }
  const modRequests: Array<{
    cwd: string;
    settingSources: Array<'user' | 'project' | 'local'>;
    claudeConfigDir: string;
  }> = [];
  for (const selection of selections) {
    if (selection.harness !== 'claude') continue;
    const raw = selection.step.with?.setting_sources;
    if (raw !== undefined && (typeof raw !== 'string' || raw.includes('${{')))
      return decline('dynamic-settings');
    const working = selection.step.working_directory;
    if (working?.includes('${{')) return decline('dynamic-directory');
    const cwd = await realpath(
      working ? path.resolve(worktreeRoot, working) : worktreeRoot,
    );
    const relativeCwd = path.relative(worktreeRoot, cwd);
    if (relativeCwd.startsWith('..') || path.isAbsolute(relativeCwd))
      return decline('outside-worktree');
    const settingSources: Array<'user' | 'project' | 'local'> =
      parseSettingSources(raw) ?? ['user', 'project', 'local'];
    const configDir = pipelineSetupFactRoots({
      cwd,
      dataRoot: roots.data,
      environment,
    })['claude-config'];
    if (configDir !== roots['claude-config'])
      return decline('claude-profile-mismatch');
    modRequests.push({ cwd, settingSources, claudeConfigDir: configDir });
    for (const name of [
      'settings.json',
      'plugins/installed_plugins.json',
      'skills',
      'plugins/synced',
      'dev-mods',
    ])
      add({ root: 'claude-config', relativePath: name, projection: 'content' });
    const gitRoot = findClaudeProjectGitRoot(cwd);
    for (const folder of new Set([cwd, ...(gitRoot ? [gitRoot] : [])])) {
      const relative = path.relative(worktreeRoot, await realpath(folder));
      if (relative.startsWith('..') || path.isAbsolute(relative))
        return decline('outside-worktree');
      for (const name of ['settings.json', 'settings.local.json', 'skills'])
        add({
          root: 'worktree',
          relativePath: path.posix.join(
            relative.split(path.sep).join('/'),
            '.claude',
            name,
          ),
          projection: 'content',
        });
    }
  }
  const before = new Map<string, string>();
  for (const [id, fact] of specs) {
    const version = await readPipelineSetupFactVersion(
      roots[fact.root],
      fact,
      operatingSystem,
    );
    if (!version) {
      if (resourceFactIds.has(id)) return decline('resource-selection');
      if (
        fact.projection === 'claude-connections' ||
        fact.relativePath === '.mcp.json'
      )
        return decline('native-mcp', 'owner-mcp');
      if (
        fact.relativePath === 'agents' ||
        fact.relativePath.endsWith('/agents')
      )
        return decline('agent-configuration');
      if (fact.projection === 'absence')
        return decline('managed-policy', 'managed-configuration');
      if (fact.projection === 'preferences') return decline('preferences-fact');
      if (fact.relativePath === 'model-policy-marker.json')
        return decline('policy-fact');
      if (fact.relativePath === 'model-gateway-marker.json')
        return decline('gateway-fact');
      return decline(
        fact.root === 'claude-config'
          ? 'claude-profile-fact'
          : fact.root === 'codex-config'
            ? 'codex-profile-fact'
            : 'worktree-fact',
      );
    }
    before.set(id, version);
    if (
      (fact.root === 'claude-config' || fact.root === 'worktree') &&
      /settings(?:\.local)?\.json$/.test(fact.relativePath)
    ) {
      const blocker = await nativeSettingsBlocker(
        path.join(roots[fact.root], fact.relativePath),
      );
      if (blocker) {
        return decline('settings-dependency', blocker);
      }
    }
  }
  if (selections.some((selection) => selection.harness === 'codex')) {
    // Ask the same vendor runtime that starts desktop Codex turns; a model
    // label cannot reveal layered provider overrides or enterprise policy.
    const response: unknown = await getCodexRuntimeService()
      .admin()
      .request(
        'config/read',
        { cwd: launch.cwd, includeLayers: true },
        {
          environment: sanitizeCodexSpawnEnvironment({ ...environment }),
          configArgs: [],
        },
      );
    if (
      !record(response) ||
      !record(response.config) ||
      !Array.isArray(response.layers)
    )
      return decline('codex-config-read');
    const config = response.config;
    if (
      config.model_provider !== null &&
      config.model_provider !== undefined &&
      config.model_provider !== 'openai'
    )
      return decline('codex-provider');
    if (config.openai_base_url !== null && config.openai_base_url !== undefined)
      return decline('codex-connection');
    // Owner-bound MCP, hooks and app capabilities are not a native route.
    for (const key of ['mcp_servers', 'hooks', 'apps']) {
      const value = config[key];
      if (
        value !== undefined &&
        value !== null &&
        (!record(value) || Object.keys(value).length > 0)
      )
        return decline('codex-tools', 'owner-mcp');
    }
    const providers = config.model_providers;
    if (
      providers !== undefined &&
      providers !== null &&
      (!record(providers) || Object.keys(providers).length > 0)
    )
      return decline('codex-providers');
    for (const layer of response.layers) {
      if (!record(layer) || !record(layer.name)) return decline('codex-layer');
      const source = layer.name;
      if (source.type === 'sessionFlags') {
        // The runtime adds only this performance flag to our empty configArgs.
        // Any additional session setting must be classified, not silently trusted.
        const flags = layer.config;
        if (
          !record(flags) ||
          !Object.keys(flags).every((key) => key === 'features')
        )
          return decline('codex-layer');
        if (
          flags.features !== undefined &&
          (!record(flags.features) ||
            Object.keys(flags.features).length !== 1 ||
            flags.features.plugin_discovery_prefetch !== false)
        )
          return decline('codex-layer');
        continue;
      }
      if (source.type === 'system' && typeof source.file === 'string') {
        // The exact pinned system source must be absent in both disk observations.
        // Never read or execute a configured system layer to gain admission.
        if (
          path.resolve(source.file) !==
            path.resolve('/etc/codex/config.toml') ||
          !record(layer.config) ||
          Object.keys(layer.config).length > 0
        )
          return decline('codex-layer');
        continue;
      }
      if (
        source.type === 'user' &&
        typeof source.file === 'string' &&
        path.resolve(source.file) ===
          path.join(roots['codex-config'], 'config.toml') &&
        (source.profile === null || source.profile === undefined)
      )
        continue;
      if (
        source.type === 'project' &&
        typeof source.dotCodexFolder === 'string'
      ) {
        const relative = path
          .relative(launch.cwd, path.join(source.dotCodexFolder, 'config.toml'))
          .split(path.sep)
          .join('/');
        if (relative.startsWith('../') || path.isAbsolute(relative))
          return decline('outside-worktree');
        if (!before.has(`worktree:${relative}:content`))
          return decline('codex-layer');
        continue;
      }
      return decline('codex-layer');
    }
  }
  const leases: WorkerPipelineStartSetup['leases'] = [];
  if (codexResourcePolicy) {
    // Same home-only, local listing used by readInstalledItemPolicy. Native
    // installs are not covered by a worktree-local reference/content lease.
    const installed: unknown = await getCodexRuntimeService()
      .admin()
      .request('plugin/list', { cwds: null, marketplaceKinds: ['local'] });
    if (
      !record(installed) ||
      !Array.isArray(installed.marketplaces) ||
      !Array.isArray(installed.marketplaceLoadErrors) ||
      installed.marketplaceLoadErrors.length > 0 ||
      !installed.marketplaces.every(
        (market: unknown) =>
          record(market) &&
          Array.isArray(market.plugins) &&
          market.plugins.every(
            (plugin: unknown) => record(plugin) && plugin.installed === false,
          ),
      )
    )
      return decline('resource-selection');
  }
  if (aliasIds.length) {
    const { agentContextSnapshot, assertAgentContextSnapshot } =
      await import('../agents/resource-lanes');
    const context = await agentContextSnapshot();
    const store = await readLocalPipelineAgentStore(roots.data);
    for (const aliasId of aliasIds) {
      const agentId = localPipelineAgentId(launch, aliasId);
      if (!agentId || !input.resolveAgent) return decline('resource-selection');
      const alias = await input.resolveAgent(agentId);
      const result = WorkerPipelineOwnerResultSchema.safeParse({
        kind: 'model.agentAlias',
        alias,
      });
      if (
        !result.success ||
        result.data.kind !== 'model.agentAlias' ||
        !localPipelineAgentMatches(store, agentId, result.data) ||
        !isDeepStrictEqual(result.data, initialAliases.get(aliasId)) ||
        !selections
          .filter((selection) => selection.aliasId === aliasId)
          .every((selection) => selection.model === alias?.base)
      )
        return decline('resource-selection');
      const selected = alias?.pluginSelections;
      if (selected && selected.pluginRefs.length > 0) {
        // The same installed-item/context authority used by live owner calls.
        // A filtered reference is not permission to launch with empty resources.
        const refs = await resolveEffectivePluginSelectionRefs(selected);
        if (
          refs.disabledRefs.length ||
          refs.warnings.length ||
          !isDeepStrictEqual(refs.pluginRefs, selected.pluginRefs) ||
          !isDeepStrictEqual(refs.skillRefs, selected.skillRefs) ||
          !isDeepStrictEqual(refs.mcpServerRefs, selected.mcpServerRefs ?? [])
        )
          return decline('resource-selection');
        if (
          selections.some(
            (selection) =>
              selection.aliasId === aliasId && selection.harness === 'codex',
          )
        ) {
          const expanded = WorkerPipelineOwnerResultSchema.safeParse({
            kind: 'codex.pluginRefs',
            selections: {
              collectionIds: [],
              skillRefs: refs.skillRefs,
              pluginRefs: refs.pluginRefs,
              mcpServerRefs: refs.mcpServerRefs,
            },
            warnings: refs.warnings,
          });
          // Bounded by the owner request it answers, not a generic JSON value.
          const selectionsJson: unknown = JSON.parse(
            JSON.stringify(normalizePluginSelections(selected)),
          );
          const request = WorkerPipelineOwnerRequestSchema.safeParse({
            action: 'owner.codex.pluginRefs',
            selections: selectionsJson,
          });
          if (
            !expanded.success ||
            expanded.data.kind !== 'codex.pluginRefs' ||
            !request.success ||
            request.data.action !== 'owner.codex.pluginRefs'
          )
            return decline('resource-selection');
          leases.push({
            jobId: '_run',
            stepId: '_run',
            request: request.data,
            result: expanded.data,
            factIds: [],
          });
        }
      }
      leases.push({
        jobId: '_run',
        stepId: '_run',
        request: { action: 'owner.model.agentAlias', agentId },
        result: result.data,
        factIds: [],
      });
    }
    await assertAgentContextSnapshot(context);
  }
  for (const request of modRequests) {
    // The Mod feature flag does not disable native auto-loading. Inspect it
    // independently before accepting a flag-off null admission result.
    const gitRoot = findClaudeProjectGitRoot(request.cwd);
    if (
      listClaudeAutoLoadedPlugins({
        claudeConfigDir: request.claudeConfigDir,
        settingSources: request.settingSources,
        projectPaths: [
          ...new Set([request.cwd, ...(gitRoot ? [gitRoot] : [])]),
        ],
      }).length > 0
    ) {
      return decline('ambient-resources', 'owner-mcp');
    }
    const context = await resolveClaudeModAdmissionContext(request);
    // Ambient plugin MCP/auth and hook dependencies have not been classified
    // for survival yet. Preserve their normal app-bound execution.
    if (
      (context?.ambientPlugins.length ?? 0) > 0 ||
      (context?.sessionModIds?.length ?? 0) > 0
    )
      return decline('ambient-resources');
    const result = WorkerPipelineOwnerResultSchema.safeParse(
      JSON.parse(
        JSON.stringify({
          kind: 'claude.modAdmission',
          context: context ?? null,
        }),
      ),
    );
    if (
      !result.success ||
      result.data.kind !== 'claude.modAdmission' ||
      result.data.context?.authority === 'unreadable'
    )
      return decline('mod-admission');
    leases.push({
      jobId: '_run',
      stepId: '_run',
      request: { action: 'owner.claude.modAdmission', ...request },
      result: result.data,
      factIds: [],
    });
  }
  const facts: WorkerPipelineSetupFact[] = [];
  for (const [id, fact] of specs) {
    const version = await readPipelineSetupFactVersion(
      roots[fact.root],
      fact,
      operatingSystem,
    );
    if (!version || (before.has(id) && before.get(id) !== version))
      return decline('changed-facts');
    facts.push({ ...fact, id, version });
  }
  for (const lease of leases) lease.factIds = facts.map((fact) => fact.id);
  const parsed = WorkerPipelineStartSetupSchema.safeParse({
    version: 1,
    facts,
    leases,
  });
  return parsed.success ? parsed.data : decline('invalid-snapshot');
}

/** Bracket route inspection with the same independently verifiable setup facts. */
export async function prepareNativePipelineStartAdmission(input: {
  readonly launch: Omit<WorkerPipelineHostLaunch, 'secretEnv'>;
  readonly selections: readonly DaemonPipelineModelSelection[];
  readonly environment: Readonly<Record<string, string>>;
  readonly inspectRoutes: () => Promise<NativePipelineRouteInspection>;
  readonly resolveAgent?: (
    agentId: string,
  ) => Promise<PipelineAgentModelAliasResolution | null>;
}): Promise<{
  readonly setup?: WorkerPipelineStartSetup;
  readonly routes: NativePipelineRouteInspection;
  readonly blockers: readonly SetupBlocker[];
  readonly failure?: WorkerPipelineSetupFailure;
}> {
  // Resolver reads initialize policy/gateway projections on a cold app. Retry
  // once from fresh facts, including a fresh route decision, never bless the
  // old changed snapshot or loop indefinitely under configuration churn.
  for (let attempt = 0; ; attempt += 1) {
    const blockers: SetupBlocker[] = [];
    let failure: WorkerPipelineSetupFailure | undefined;
    const setup = await buildNativePipelineStartSetup({
      ...input,
      onBlocker: (code, reason): void => {
        blockers.push(code);
        failure = reason;
      },
    }).catch(() => {
      failure = 'setup-inspection';
      return undefined;
    });
    const routes = await input
      .inspectRoutes()
      .catch(() => ({ blockers: ['unknown'] as const }));
    const changed = setup
      ? !(await isNativePipelineStartSetupCurrent({
          setup,
          cwd: input.launch.cwd,
          environment: input.environment,
        }).catch(() => false))
      : failure === 'changed-facts';
    if (changed && attempt === 0) continue;
    return {
      setup: changed ? undefined : setup,
      routes,
      blockers,
      failure: changed ? 'changed-facts' : failure,
    };
  }
}
