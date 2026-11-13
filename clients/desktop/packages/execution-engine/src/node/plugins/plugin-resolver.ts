import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SettingSource } from '@anthropic-ai/claude-agent-sdk';
import {
  readPluginCatalog,
  readPluginCacheIndex,
} from '@canopy/execution-engine/node/plugins/catalog-read-health';
import { getCanopyDataDir } from '@canopy/execution-engine/canopy-paths';
import { getBundledSkillDir } from '@canopy/execution-engine/pipelines/config-paths';
import type {
  ChatTabPluginSelections,
  CodexSelectedCapabilityRoot,
} from '@canopy/execution-engine/execution-types';
import type { PipelinePackageCapabilityOverlay } from '@canopy/execution-engine/types/pipeline';
import type {
  MarketplaceInfo,
  PluginInfo,
  PluginsCache,
} from '@canopy/execution-engine/types/plugins';
import {
  normalizeMcpServerFile,
  type McpServerFile,
} from '@canopy/execution-engine/types/mcp-servers';
import { sanitizeEnvVars } from '@canopy/execution-engine/lib/mcp-security';
import { isPathInside } from '@canopy/execution-engine/node/lib/path-safety';
import { createLocalCapabilityRoot } from '../codex-runtime/capability-root';
import { getInstalledSkillDirectory } from '@canopy/execution-engine/node/skills/paths';
import { projectCodexPluginWithoutMcpServers } from '@canopy/execution-engine/node/plugins/codex-plugin-projection';
import {
  evaluateClaudeModAdmission,
  isClaudeModAdmissionLaunch,
  type ClaudeModAdmissionLaunch,
  type ClaudeModPluginInput,
} from '@canopy/execution-engine/node/plugins/claude-mod-admission';
import { projectClaudePluginForLaunch } from '@canopy/execution-engine/node/plugins/claude-mod-projection';
import {
  isClaudeModPluginId,
  type ClaudeModAdmission,
  type SkippedClaudeMod,
} from '@canopy/execution-engine/types/claude-mod-admission';
import { claudeMarketplaceNames } from '@canopy/execution-engine/lib/claude-marketplace-names';
import type { ClaudeModAdmissionContext } from '../pipelines/executor/types';
import {
  buildManagedMcpServerName,
  normalizeManagedMcpServerLabel,
} from '@canopy/execution-engine/node/plugins/mcp-server-name';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';

interface SdkPluginConfig {
  type: 'local';
  path: string;
}

export interface ResolvedPluginRuntime {
  warnings: string[];
  sdkPlugins: SdkPluginConfig[];
  selectedCapabilityRoots: CodexSelectedCapabilityRoot[];
  mcpServers: Record<string, unknown>;
  claudeModAdmission?: ClaudeModAdmissionLaunch;
}

export interface ResolvePluginsOptions {
  purpose?: 'claude-session' | 'codex-session';
  runtimeDirs?: {
    rootDir: string;
    claudePluginDir: string;
  };
  packageOverlay?: PipelinePackageCapabilityOverlay;
  claudeModAdmissionContext?: ClaudeModAdmissionContext;
  claudeModAdmissionCwd?: string;
  claudeModAdmissionSettingSources?: readonly SettingSource[];
}

interface ResolvedPluginPath {
  marketplaceId: string;
  pluginName: string;
  pluginPath: string;
  category: string;
  provider: 'claude' | 'codex';
  mode: 'native' | 'compat';
}

interface SelectedCodexPlugin {
  marketplaceId: string;
  pluginName: string;
  category: string;
  cacheDir: string;
}

interface ResolvedSkill {
  name: string;
  sourceDir: string;
}

const DEFAULT_CLAUDE_SETTING_SOURCES: readonly SettingSource[] = [
  'user',
  'project',
  'local',
];

function isSafeClaudePluginPart(value: string): boolean {
  return /^[^@\s/\\]+$/.test(value);
}

function selectedClaudePluginInput(
  plugin: ResolvedPluginPath,
  index: number,
  marketplaces: readonly MarketplaceInfo[],
  admissions: readonly ClaudeModAdmission[],
): ClaudeModPluginInput {
  const marketplace = marketplaces.find(
    (entry) => entry.id === plugin.marketplaceId,
  );
  const pluginName = isSafeClaudePluginPart(plugin.pluginName)
    ? plugin.pluginName
    : `local-${index + 1}`;
  // The same id rules as consent, so a catalog id such as `curated/cloud`
  // keeps its marketplace.
  const catalogId = `${pluginName}@${plugin.marketplaceId}`;
  if (!marketplace || !isClaudeModPluginId(catalogId)) {
    return { pluginId: `${pluginName}@inline`, installPath: plugin.pluginPath };
  }
  // Consent for a natively installed plugin is keyed by the marketplace's
  // registered name; the digest check still compares this exact copy.
  const consentId = claudeMarketplaceNames(marketplace)
    .map((name) => `${pluginName}@${name}`)
    .find(
      (pluginId) =>
        isClaudeModPluginId(pluginId) &&
        admissions.some((admission) => admission.pluginId === pluginId),
    );
  return { pluginId: consentId ?? catalogId, installPath: plugin.pluginPath };
}

function recordProjectionFailure(
  skippedMods: SkippedClaudeMod[],
  plugin: ClaudeModPluginInput,
  contentDigest: string | null,
): void {
  if (
    skippedMods.some(
      (entry) =>
        entry.pluginId === plugin.pluginId &&
        entry.source === 'selected' &&
        entry.reason === 'projection-failed',
    )
  ) {
    return;
  }
  skippedMods.push({
    pluginId: plugin.pluginId,
    source: 'selected',
    contentDigest,
    reason: 'projection-failed',
  });
}

function readJson<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function removePath(targetPath: string): void {
  fs.rmSync(targetPath, { recursive: true, force: true });
}

function getDirectorySymlinkType(): fs.symlink.Type {
  return hostOperatingSystem() === 'win32' ? 'junction' : 'dir';
}

function safeCodexPluginName(name: string): string | null {
  const trimmed = name.trim();
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed) || trimmed.includes('..')) {
    return null;
  }
  return trimmed;
}

function readPluginsCache(): PluginsCache | null {
  const root = getCanopyDataDir();
  const catalog = readPluginCatalog(path.join(root, 'plugins-cache.json'));
  const index = readPluginCacheIndex(
    path.join(root, 'plugin-cache-index.json'),
  );
  return catalog.state === 'valid' &&
    (index.state === 'valid' || index.state === 'absent')
    ? catalog.data
    : null;
}

function normalizeSelections(
  selections: ChatTabPluginSelections,
): ChatTabPluginSelections {
  return {
    collectionIds: Array.isArray(selections.collectionIds)
      ? selections.collectionIds
      : [],
    skillRefs: Array.isArray(selections.skillRefs) ? selections.skillRefs : [],
    pluginRefs: Array.isArray(selections.pluginRefs)
      ? selections.pluginRefs
      : [],
    mcpServerRefs: Array.isArray(selections.mcpServerRefs)
      ? selections.mcpServerRefs
      : [],
    mcpHttpAuthPreferences: [],
  };
}

function getMcpServerFilePath(serverId: string): string {
  return path.join(
    getCanopyDataDir(),
    'mcp-servers',
    `server-${serverId}.json`,
  );
}

function buildClaudeMcpServerConfig(
  file: McpServerFile,
  configId: string,
): Record<string, unknown> | null {
  const definition = file.server.definition;
  const config = file.server.configs.find((entry) => entry.id === configId);
  if (!config?.enabled) {
    return null;
  }
  if (definition.type === 'http') {
    if (!definition.url) {
      return null;
    }
    return {
      type: 'http',
      url: definition.url,
      headers: {
        ...(definition.headers ?? {}),
        ...(config.extraHeaders ?? {}),
        ...(config.authToken
          ? { Authorization: `Bearer ${config.authToken}` }
          : {}),
      },
    };
  }
  if (!definition.command) {
    return null;
  }
  return {
    type: 'stdio',
    command: definition.command,
    args: [...(definition.args ?? []), ...(config.extraArgs ?? [])],
    env: config.envVars,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.values(value).every((entry) => typeof entry === 'string')
  );
}

function readStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) &&
    value.every((entry) => typeof entry === 'string')
    ? value
    : undefined;
}

function extractPluginMcpServers(
  config: Record<string, unknown>,
): Record<string, Record<string, unknown>> {
  const servers =
    isRecord(config.mcpServers) && !Array.isArray(config.mcpServers)
      ? config.mcpServers
      : config;
  const result: Record<string, Record<string, unknown>> = {};
  for (const [name, value] of Object.entries(servers)) {
    if (isRecord(value)) {
      result[name] = value;
    }
  }
  return result;
}

function readPluginMcpConfigObjects(
  plugin: ResolvedPluginPath,
): Record<string, Record<string, unknown>> {
  const manifest = readJson<Record<string, unknown>>(
    path.join(
      plugin.pluginPath,
      plugin.provider === 'codex' ? '.codex-plugin' : '.claude-plugin',
      'plugin.json',
    ),
  );
  const manifestValue = manifest?.mcpServers;
  if (typeof manifestValue === 'string') {
    const resolvedPath = path.resolve(plugin.pluginPath, manifestValue);
    if (isPathInside(plugin.pluginPath, resolvedPath)) {
      const config = readJson<Record<string, unknown>>(resolvedPath);
      return config ? extractPluginMcpServers(config) : {};
    }
    return {};
  }
  if (Array.isArray(manifestValue)) {
    const merged: Record<string, Record<string, unknown>> = {};
    for (const reference of manifestValue) {
      if (typeof reference !== 'string') {
        continue;
      }
      const resolvedPath = path.resolve(plugin.pluginPath, reference);
      if (!isPathInside(plugin.pluginPath, resolvedPath)) {
        continue;
      }
      const config = readJson<Record<string, unknown>>(resolvedPath);
      if (config) {
        Object.assign(merged, extractPluginMcpServers(config));
      }
    }
    return merged;
  }
  if (isRecord(manifestValue)) {
    return extractPluginMcpServers(manifestValue);
  }
  const defaultConfig = readJson<Record<string, unknown>>(
    path.join(plugin.pluginPath, '.mcp.json'),
  );
  return defaultConfig ? extractPluginMcpServers(defaultConfig) : {};
}

function codexMcpToolPolicy(
  rawServer: Record<string, unknown>,
): Record<string, unknown> {
  const enabledTools = readStringArray(rawServer.enabled_tools);
  const disabledTools = readStringArray(rawServer.disabled_tools);
  return {
    ...(enabledTools ? { enabled_tools: enabledTools } : {}),
    ...(disabledTools ? { disabled_tools: disabledTools } : {}),
    ...(typeof rawServer.default_tools_approval_mode === 'string'
      ? {
          default_tools_approval_mode: rawServer.default_tools_approval_mode,
        }
      : {}),
    ...(isRecord(rawServer.tools) ? { tools: rawServer.tools } : {}),
  };
}

/**
 * A plugin stdio server's declared `cwd`, resolved against the plugin root
 * after `${CLAUDE_PLUGIN_ROOT}` expansion; an undeclared `cwd` is the root.
 * The delegation matcher must resolve it identically, so it is shared.
 */
export function resolvePluginServerCwd(
  cwd: unknown,
  pluginPath: string,
): string {
  if (typeof cwd !== 'string') {
    return pluginPath;
  }
  const expanded = cwd.split('${CLAUDE_PLUGIN_ROOT}').join(pluginPath);
  return path.isAbsolute(expanded)
    ? expanded
    : path.resolve(pluginPath, expanded);
}

/**
 * Codex starts a plugin's stdio server in its declared `cwd`. The Claude CLI
 * and Cursor's ACP transport have no such field and start the server in the
 * chat's working directory instead, so a script path written relative to the
 * plugin directory only resolves on Codex. Making it absolute lets the same
 * definition start on every harness. A non-absolute arg is rewritten only
 * when it names an existing *file* under `cwd`: `./mcp/server.mjs`, a bare
 * `server.mjs`, or a Windows-style `.\\server.mjs` (`path.resolve` understands
 * the backslash form on Windows only; elsewhere it stays as written). A
 * directory is never a script, so a module or subcommand name that matches
 * one (`python -m mcp` with an `mcp/` package) stays as written, and a bare
 * name without an extension (`config`, `serve`) is treated as a positional
 * literal even when a same-named file exists, because the manifest cannot
 * tell the two apart. Flags never resolve to a file. Anything the filesystem
 * refuses to stat (over-long segments, NUL bytes) is left as written rather
 * than failing the whole resolution. The desktop resolver applies this for
 * chat sessions.
 */
export function resolveCwdRelativePathArg(arg: string, cwd: string): string {
  if (arg === '' || path.isAbsolute(arg)) {
    return arg;
  }
  const hasSeparator = /[\\/]/.test(arg);
  if (!hasSeparator && path.extname(arg) === '') {
    return arg;
  }
  const resolved = path.resolve(cwd, arg);
  try {
    return fs.statSync(resolved, { throwIfNoEntry: false })?.isFile()
      ? resolved
      : arg;
  } catch {
    return arg;
  }
}

function resolveNativeCodexPluginMcpServers(
  plugin: ResolvedPluginPath,
  warnings: string[],
): {
  servers: Record<string, unknown>;
  hasMcpServers: boolean;
} {
  const rawServers = readPluginMcpConfigObjects(plugin);
  const servers: Record<string, unknown> = {};
  const replacePluginRoot = (value: string): string =>
    value.split('${CLAUDE_PLUGIN_ROOT}').join(plugin.pluginPath);

  for (const [serverName, rawServer] of Object.entries(rawServers)) {
    if (rawServer.enabled === false) {
      continue;
    }
    const resolvedName = buildManagedMcpServerName({
      kind: 'plugin',
      friendlyParts: [plugin.pluginName, serverName],
      identityParts: [plugin.marketplaceId, plugin.pluginName, serverName],
    });
    if (typeof rawServer.command === 'string') {
      const rawEnv = isStringRecord(rawServer.env) ? rawServer.env : undefined;
      // This resolver only hands native Codex plugins to Codex sessions, and
      // Codex starts the server in `cwd`, so args stay as written here.
      servers[resolvedName] = {
        type: 'stdio',
        command: replacePluginRoot(rawServer.command),
        args: readStringArray(rawServer.args)?.map(replacePluginRoot),
        cwd: resolvePluginServerCwd(rawServer.cwd, plugin.pluginPath),
        ...(rawEnv
          ? {
              env: sanitizeEnvVars(
                Object.fromEntries(
                  Object.entries(rawEnv).map(([key, value]) => [
                    key,
                    replacePluginRoot(value),
                  ]),
                ),
              ),
            }
          : {}),
        ...(typeof rawServer.enabled === 'boolean'
          ? { enabled: rawServer.enabled }
          : {}),
        ...codexMcpToolPolicy(rawServer),
      };
      continue;
    }
    if (
      typeof rawServer.url === 'string' &&
      (!rawServer.type || rawServer.type === 'http')
    ) {
      const rawHeaders = isStringRecord(rawServer.headers)
        ? rawServer.headers
        : isStringRecord(rawServer.http_headers)
          ? rawServer.http_headers
          : undefined;
      servers[resolvedName] = {
        type: 'http',
        url: replacePluginRoot(rawServer.url),
        ...(rawHeaders
          ? {
              headers: Object.fromEntries(
                Object.entries(rawHeaders).map(([key, value]) => [
                  key,
                  replacePluginRoot(value),
                ]),
              ),
            }
          : {}),
        ...(typeof rawServer.enabled === 'boolean'
          ? { enabled: rawServer.enabled }
          : {}),
        ...codexMcpToolPolicy(rawServer),
      };
      continue;
    }
    warnings.push(
      `Plugin MCP server "${plugin.marketplaceId}/${plugin.pluginName}:${serverName}" is invalid, skipping.`,
    );
  }

  return {
    servers,
    hasMcpServers: Object.keys(rawServers).length > 0,
  };
}

function resolveStandaloneMcpServers(
  selections: ChatTabPluginSelections,
  warnings: string[],
): Record<string, unknown> {
  const result = Object.create(null) as Record<string, unknown>;
  const refs = selections.mcpServerRefs ?? [];
  for (const ref of refs) {
    let file: McpServerFile;
    try {
      file = normalizeMcpServerFile(
        readJson<unknown>(getMcpServerFilePath(ref.serverId)),
        ref.serverId,
      );
    } catch {
      warnings.push(`MCP server "${ref.serverId}" not found, skipping.`);
      continue;
    }
    const selectedConfig = file.server.configs.find(
      (entry) => entry.id === ref.configId,
    );
    const config = buildClaudeMcpServerConfig(file, ref.configId);
    if (!selectedConfig || !config) {
      warnings.push(
        `MCP config "${ref.configId}" on server "${ref.serverId}" could not be used, skipping.`,
      );
      continue;
    }
    const friendlyParts =
      normalizeManagedMcpServerLabel(selectedConfig.name) !== 'default'
        ? [file.server.definition.name, selectedConfig.name]
        : [file.server.definition.name];
    const resolvedName = buildManagedMcpServerName({
      kind: 'dynamic',
      friendlyParts,
      identityParts: [ref.serverId, ref.configId],
    });
    result[resolvedName] = config;
  }
  return result;
}

function resolveFacetPath(
  plugin: PluginInfo,
  facet: NonNullable<PluginInfo['facets']['claude']>,
  marketplace: MarketplaceInfo,
  warnings: string[],
): string | null {
  if (facet.cachePath && fs.existsSync(facet.cachePath)) {
    return facet.cachePath;
  }

  if (facet.installLocation && fs.existsSync(facet.installLocation)) {
    return facet.installLocation;
  }

  if (facet.sourcePath) {
    const resolved = path.isAbsolute(facet.sourcePath)
      ? path.resolve(facet.sourcePath)
      : path.resolve(marketplace.installLocation, facet.sourcePath);
    if (
      !path.isAbsolute(facet.sourcePath) &&
      !isPathInside(marketplace.installLocation, resolved)
    ) {
      warnings.push(
        `Plugin "${plugin.name}" path escapes marketplace root, skipping.`,
      );
      return null;
    }
    if (fs.existsSync(resolved)) {
      return resolved;
    }
  }

  warnings.push(
    `Plugin path does not exist: ${facet.sourcePath || facet.installLocation}`,
  );
  return null;
}

function resolvePluginSelection(
  marketplaceId: string,
  pluginName: string,
  marketplaces: readonly MarketplaceInfo[],
  warnings: string[],
  purpose: ResolvePluginsOptions['purpose'],
): ResolvedPluginPath | null {
  const marketplace = marketplaces.find((entry) => entry.id === marketplaceId);
  if (!marketplace) {
    warnings.push(`Marketplace "${marketplaceId}" not found.`);
    return null;
  }

  const plugin = marketplace.plugins.find(
    (entry) => entry.name.toLowerCase() === pluginName.toLowerCase(),
  );
  if (!plugin) {
    warnings.push(
      `Plugin "${pluginName}" not found in marketplace "${marketplaceId}".`,
    );
    return null;
  }

  const facets = plugin.facets;
  const codexPurpose = purpose === 'codex-session';

  if (!codexPurpose) {
    if (!facets.claude) {
      warnings.push(
        `Plugin "${pluginName}" in marketplace "${marketplaceId}" is only available for Codex; skipping for Claude.`,
      );
      return null;
    }
    const pluginPath = resolveFacetPath(
      plugin,
      facets.claude,
      marketplace,
      warnings,
    );
    return pluginPath
      ? {
          marketplaceId,
          pluginName: facets.claude.name,
          pluginPath,
          category: facets.claude.category ?? plugin.category ?? '',
          provider: 'claude',
          mode: 'native',
        }
      : null;
  }

  if (facets.codex) {
    const pluginPath = resolveFacetPath(
      plugin,
      facets.codex,
      marketplace,
      warnings,
    );
    if (pluginPath) {
      return {
        marketplaceId,
        pluginName: facets.codex.name,
        pluginPath,
        category: facets.codex.category ?? plugin.category ?? '',
        provider: 'codex',
        mode: 'native',
      };
    }
    warnings.push(
      `Codex-native plugin "${pluginName}" in marketplace "${marketplaceId}" has no verified install location.`,
    );
  }

  if (facets.codexCompatibility) {
    const pluginPath = resolveFacetPath(
      plugin,
      facets.codexCompatibility,
      marketplace,
      warnings,
    );
    if (pluginPath) {
      return {
        marketplaceId,
        pluginName: facets.codexCompatibility.name,
        pluginPath,
        category: facets.codexCompatibility.category ?? plugin.category ?? '',
        provider: 'codex',
        mode: 'compat',
      };
    }
  }

  if (!facets.claude) {
    warnings.push(
      `Plugin "${pluginName}" in marketplace "${marketplaceId}" is not available for Codex.`,
    );
    return null;
  }

  const pluginPath = resolveFacetPath(
    plugin,
    facets.claude,
    marketplace,
    warnings,
  );
  return pluginPath
    ? {
        marketplaceId,
        pluginName: facets.claude.name,
        pluginPath,
        category: facets.claude.category ?? plugin.category ?? '',
        provider: 'claude',
        mode: 'compat',
      }
    : null;
}

function buildClaudeSkillPluginDir(
  pluginDir: string,
  skills: readonly ResolvedSkill[],
  warnings: string[],
): string | null {
  removePath(pluginDir);

  let linkedCount = 0;
  for (const skill of skills) {
    const targetDir = path.join(pluginDir, 'skills', skill.name);
    if (!isPathInside(pluginDir, targetDir)) {
      warnings.push(
        `Skill name "${skill.name}" produces unsafe path, skipping.`,
      );
      continue;
    }
    ensureDir(path.dirname(targetDir));
    fs.symlinkSync(skill.sourceDir, targetDir, getDirectorySymlinkType());
    linkedCount += 1;
  }

  if (linkedCount === 0) {
    return null;
  }

  const manifestDir = path.join(pluginDir, '.claude-plugin');
  ensureDir(manifestDir);
  fs.writeFileSync(
    path.join(manifestDir, 'plugin.json'),
    `${JSON.stringify({ name: 'canopy-pipeline-skills' }, null, 2)}\n`,
    'utf8',
  );
  return pluginDir;
}

function buildCodexSkillPluginDir(
  pluginDir: string,
  skills: readonly ResolvedSkill[],
  warnings: string[],
): string | null {
  removePath(pluginDir);
  let copiedCount = 0;
  for (const skill of skills) {
    const targetDir = path.join(pluginDir, 'skills', skill.name);
    if (!isPathInside(pluginDir, targetDir)) {
      warnings.push(
        `Skill name "${skill.name}" produces unsafe path, skipping.`,
      );
      continue;
    }
    ensureDir(path.dirname(targetDir));
    fs.cpSync(skill.sourceDir, targetDir, {
      recursive: true,
      force: true,
      dereference: true,
    });
    copiedCount += 1;
  }
  if (copiedCount === 0) {
    return null;
  }
  const manifestDir = path.join(pluginDir, '.codex-plugin');
  ensureDir(manifestDir);
  fs.writeFileSync(
    path.join(manifestDir, 'plugin.json'),
    `${JSON.stringify({ name: 'canopy-pipeline-skills' }, null, 2)}\n`,
    'utf8',
  );
  return pluginDir;
}

function resolveSkillRefs(
  selections: ChatTabPluginSelections,
  warnings: string[],
): ResolvedSkill[] {
  const result: ResolvedSkill[] = [];
  const usedNames = new Set<string>();

  for (const ref of selections.skillRefs) {
    const sourceDir =
      ref.sourceId === 'builtin:app'
        ? getBundledSkillDir(ref.skillName)
        : getInstalledSkillDirectory(
            path.join(getCanopyDataDir(), 'skills'),
            ref.sourceId,
            ref.skillName,
          );
    const skillMdPath = path.join(sourceDir, 'SKILL.md');
    if (!fs.existsSync(skillMdPath)) {
      warnings.push(
        `Skill "${ref.skillName}" (source: ${ref.sourceId}) not found, skipping.`,
      );
      continue;
    }

    let name = ref.skillName;
    let suffix = 1;
    while (usedNames.has(name)) {
      name = `${ref.skillName}-${suffix}`;
      suffix += 1;
    }
    usedNames.add(name);
    result.push({ name, sourceDir });
  }

  return result;
}

function selectUniqueCodexPlugins(
  plugins: readonly SelectedCodexPlugin[],
  warnings: string[],
): SelectedCodexPlugin[] {
  const seen = new Set<string>();
  const result: SelectedCodexPlugin[] = [];
  for (const plugin of plugins) {
    const safeName = safeCodexPluginName(plugin.pluginName);
    if (!safeName) {
      warnings.push(
        `Plugin "${plugin.pluginName}" has an unsafe Codex plugin name, skipping.`,
      );
      continue;
    }
    const key = safeName.toLowerCase();
    if (seen.has(key)) {
      warnings.push(`Skipping duplicate Codex plugin "${plugin.pluginName}".`);
      continue;
    }
    seen.add(key);
    result.push({ ...plugin, pluginName: safeName });
  }
  return result;
}

export function resolvePlugins(
  rawSelections: ChatTabPluginSelections,
  _projectId: string,
  _worktreeId: string,
  _chatId: string,
  options?: ResolvePluginsOptions,
): ResolvedPluginRuntime {
  const selections = normalizeSelections(rawSelections);
  const purpose = options?.purpose ?? 'claude-session';
  const warnings: string[] = [];
  const sdkPlugins: SdkPluginConfig[] = [];
  const selectedClaudePlugins: ClaudeModPluginInput[] = [];
  let selectedCapabilityRoots: CodexSelectedCapabilityRoot[] = [];
  const mcpServers = resolveStandaloneMcpServers(selections, warnings);
  const codexPluginsWithMcpServers = new Set<string>();

  const cache = readPluginsCache();
  const marketplaces = cache?.marketplaces ?? [];
  const resolvedPlugins: ResolvedPluginPath[] = [];
  for (const resource of options?.packageOverlay?.resources ?? []) {
    if (
      resource.provider !== (purpose === 'codex-session' ? 'codex' : 'claude')
    ) {
      continue;
    }
    if (resource.kind !== 'standalone_skill') {
      const plugin: ResolvedPluginPath = {
        marketplaceId: `pipeline-package:${options?.packageOverlay?.packageDigest ?? ''}`,
        pluginName: resource.resourceId,
        pluginPath: resource.rootPath,
        category: 'pipeline-package',
        provider: resource.provider,
        mode: 'native',
      };
      resolvedPlugins.push(plugin);
      if (purpose !== 'codex-session') {
        sdkPlugins.push({ type: 'local', path: resource.rootPath });
        const resourceName = isSafeClaudePluginPart(resource.resourceId)
          ? resource.resourceId
          : `local-${selectedClaudePlugins.length + 1}`;
        selectedClaudePlugins.push({
          pluginId: `${resourceName}@inline`,
          installPath: resource.rootPath,
        });
      }
    }
  }
  for (const ref of selections.pluginRefs) {
    const resolved = resolvePluginSelection(
      ref.marketplaceId,
      ref.pluginName,
      marketplaces,
      warnings,
      purpose,
    );
    if (!resolved) {
      continue;
    }
    resolvedPlugins.push(resolved);
    if (purpose !== 'codex-session') {
      sdkPlugins.push({ type: 'local', path: resolved.pluginPath });
      selectedClaudePlugins.push(
        selectedClaudePluginInput(
          resolved,
          selectedClaudePlugins.length,
          marketplaces,
          options?.claudeModAdmissionContext?.admissions ?? [],
        ),
      );
    }
  }

  if (purpose === 'codex-session') {
    for (const plugin of resolvedPlugins) {
      if (plugin.provider !== 'codex' || plugin.mode !== 'native') {
        continue;
      }
      const pluginMcpResolution = resolveNativeCodexPluginMcpServers(
        plugin,
        warnings,
      );
      Object.assign(mcpServers, pluginMcpResolution.servers);
      if (pluginMcpResolution.hasMcpServers) {
        codexPluginsWithMcpServers.add(plugin.pluginPath);
      }
    }
  }

  const packagedSkills: ResolvedSkill[] = (
    options?.packageOverlay?.resources ?? []
  ).flatMap((resource) =>
    resource.kind === 'standalone_skill' &&
    resource.provider === (purpose === 'codex-session' ? 'codex' : 'claude')
      ? [
          {
            name: path.basename(resource.rootPath),
            sourceDir: resource.rootPath,
          },
        ]
      : [],
  );
  const skills = [...packagedSkills, ...resolveSkillRefs(selections, warnings)];
  if (purpose !== 'codex-session' && skills.length > 0) {
    const pluginDir = buildClaudeSkillPluginDir(
      options?.runtimeDirs?.claudePluginDir ??
        path.join(getCanopyDataDir(), 'pipeline-plugins', 'claude-skills'),
      skills,
      warnings,
    );
    if (pluginDir) {
      sdkPlugins.push({ type: 'local', path: pluginDir });
      selectedClaudePlugins.push({
        pluginId: 'canopy-pipeline-skills@inline',
        installPath: pluginDir,
      });
    }
  }

  if (purpose === 'codex-session') {
    const selectedCodexPlugins = selectUniqueCodexPlugins(
      resolvedPlugins
        .filter((plugin) => plugin.provider === 'codex')
        .map((plugin) => ({
          marketplaceId: plugin.marketplaceId,
          pluginName: plugin.pluginName,
          category: plugin.category,
          cacheDir: plugin.pluginPath,
        })),
      warnings,
    );
    const projectionRootDir = path.join(
      options?.runtimeDirs?.rootDir ??
        path.join(getCanopyDataDir(), 'pipeline-plugins'),
      'codex-capability-plugins',
    );
    selectedCapabilityRoots = selectedCodexPlugins.flatMap((plugin) => {
      const cacheDir = codexPluginsWithMcpServers.has(plugin.cacheDir)
        ? projectCodexPluginWithoutMcpServers({
            sourcePluginPath: plugin.cacheDir,
            marketplaceId: plugin.marketplaceId,
            pluginName: plugin.pluginName,
            projectionRootDir,
            warnings,
          })
        : plugin.cacheDir;
      return cacheDir ? [createLocalCapabilityRoot(cacheDir)] : [];
    });
    if (skills.length > 0) {
      const skillPluginDir = buildCodexSkillPluginDir(
        path.join(projectionRootDir, 'standalone-skills'),
        skills,
        warnings,
      );
      if (skillPluginDir) {
        selectedCapabilityRoots.push(createLocalCapabilityRoot(skillPluginDir));
      }
    }
  }

  let finalSdkPlugins: SdkPluginConfig[];
  let claudeModAdmission: ClaudeModAdmissionLaunch | undefined;
  const admissionContext =
    purpose === 'codex-session'
      ? undefined
      : options?.claudeModAdmissionContext;
  const settingSources =
    options?.claudeModAdmissionSettingSources ?? DEFAULT_CLAUDE_SETTING_SOURCES;
  // Always decide while enabled: an inherited CLAUDE_CODE_PLUGIN_DIRS loads
  // Mods even with no setting sources and no selected plugins.
  if (admissionContext?.enabled) {
    const cwd = options?.claudeModAdmissionCwd;
    if (!cwd || !path.isAbsolute(cwd)) {
      throw new Error(
        'Claude Mod admission requires the absolute pipeline step cwd.',
      );
    }
    const decision = evaluateClaudeModAdmission({
      ...admissionContext,
      selectedPlugins: selectedClaudePlugins,
    });
    const stripKeys = new Set(
      decision.stripSelectedPlugins.map(
        (plugin) => `${plugin.pluginId}\0${plugin.installPath ?? ''}`,
      ),
    );
    const skippedMods: SkippedClaudeMod[] = [...decision.skippedMods];
    const safePlugins: SdkPluginConfig[] = [];
    const projectionRootDir = path.join(
      options?.runtimeDirs?.rootDir ??
        path.join(getCanopyDataDir(), 'pipeline-plugins'),
      'claude-mod-admission-projections',
    );

    for (let index = 0; index < sdkPlugins.length; index++) {
      const plugin = sdkPlugins[index];
      const selected = selectedClaudePlugins[index];
      if (!plugin || !selected) continue;
      const key = `${selected.pluginId}\0${selected.installPath ?? ''}`;
      if (!stripKeys.has(key)) {
        safePlugins.push(plugin);
        continue;
      }
      const projectedPath = projectClaudePluginForLaunch({
        sourcePluginPath: plugin.path,
        projectionRootDir,
        removeModules: true,
        removeMcpServers: false,
      });
      if (projectedPath) {
        safePlugins.push({ type: 'local', path: projectedPath });
        continue;
      }
      const selectedSkipped = decision.skippedMods.find(
        (entry) =>
          entry.pluginId === selected.pluginId && entry.source === 'selected',
      );
      recordProjectionFailure(
        skippedMods,
        selected,
        selectedSkipped?.contentDigest ?? null,
      );
      warnings.push(
        `Claude Mod projection failed for selected plugin "${selected.pluginId}"; it was omitted from this launch.`,
      );
    }

    finalSdkPlugins = safePlugins.filter((plugin) => {
      if (fs.existsSync(plugin.path)) return true;
      warnings.push(`Plugin path does not exist: ${plugin.path}`);
      return false;
    });
    const launch: ClaudeModAdmissionLaunch = {
      version: 1,
      cwd,
      ...(admissionContext.claudeConfigDir
        ? { claudeConfigDir: admissionContext.claudeConfigDir }
        : {}),
      settingSources,
      ...(decision.settings ? { settings: decision.settings } : {}),
      plugins: finalSdkPlugins,
      skippedMods,
    };
    if (!isClaudeModAdmissionLaunch(launch)) {
      throw new Error(
        'Claude Mod admission produced an invalid launch decision.',
      );
    }
    claudeModAdmission = launch;
  } else {
    finalSdkPlugins = sdkPlugins.filter((plugin) => {
      if (fs.existsSync(plugin.path)) {
        return true;
      }
      warnings.push(`Plugin path does not exist: ${plugin.path}`);
      return false;
    });
  }

  return {
    warnings,
    sdkPlugins: finalSdkPlugins,
    selectedCapabilityRoots,
    mcpServers,
    ...(claudeModAdmission ? { claudeModAdmission } : {}),
  };
}
