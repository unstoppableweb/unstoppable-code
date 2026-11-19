import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  ChatTabPluginSelections,
  McpHttpAuthHandler,
  ModelHarness,
} from '@canopy/desktop-shared/types';
import { DEFAULT_MCP_HTTP_AUTH_HANDLER } from '@canopy/desktop-shared/types';
import {
  getMcpHttpAuthDefault,
  getMcpHttpAuthHandler,
  mcpHttpAuthTargetKey,
} from '@canopy/execution-engine/lib/mcp-http-auth';
import { normalizePluginSelections } from '@canopy/execution-engine/lib/plugin-selections-normalization';
import { normalizeMcpServerFile } from '@canopy/execution-engine/types/mcp-servers';
import type {
  AgentCapabilitySnapshot,
  AgentMcpHttpAuthPin,
  AgentMcpSelection,
  AgentProjectionToolName,
  CapabilityItemRef,
  CapabilityOverlayProvenance,
} from '@canopy/desktop-shared/node/delegation/agent-artifacts';
import type {
  DelegationCapabilityKind,
  DelegationCapabilitySource,
} from '@canopy/protocol/delegation';
import {
  validDelegationPath,
  type NativeDelegationFiles,
} from '@canopy/desktop-shared/node/delegation/file-access';
import {
  projectClaudePluginForCodex,
  projectCodexPluginWithoutMcpServers,
  parseFrontmatter,
  type ClaudePluginManifest,
} from '@canopy/plugin-interop';
import {
  resolveEffectivePluginSelectionRefs,
  resolveSelectedSkillDirectory,
  resolvePluginInfoPath,
} from '../../plugins/plugin-resolver';
import { loadMarketplacesCacheOnly } from '../../plugins/plugin-service';
import { getMcpServerFilePath } from '../../lib/paths';
import { readPreferencesFile } from '../../lib/preferences-store';
import { readMcpAccountIndexEntry } from '../../mcp/account-routing';
import {
  accountMcpConnectionsEnabled,
  loadAccountMcpRefConnections,
} from '../../mcp/account-catalog';
import {
  accountMcpConnectionForRef,
  isCustomAccountMcpServerKey,
  legacyAccountMcpConnectionId,
} from '@canopy/desktop-shared/lib/effective-plugin-selections';
import {
  DelegationAgentCapabilityError,
  type DelegationAgentCapabilityErrorCode,
} from './agent-capability-error';
import { type DelegationCapabilityCache } from './capability-cache';
import { delegationCapabilityIdForRef } from './capability-catalog';
import { delegationCapabilityDisplayName } from '@canopy/desktop-shared/node/delegation/capability-grant';
import {
  mcpTransportDigest,
  accountMcpTransportDigest,
  standaloneMcpTransportDigest,
} from './agent-mcp-fingerprint';

const MAX_BYTES = 1_000_000;
const MAX_FILES = 256;
const INERT_BINARY_ART =
  /\.(?:png|jpe?g|gif|webp|ico|icns|pdf|woff2?|ttf|otf|mp[34]|webm)$/i;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

function safePath(value: string): string {
  const normalized = path.posix.normalize(value.replace(/^\.\//, ''));
  if (
    !normalized ||
    normalized === '.' ||
    normalized.startsWith('../') ||
    normalized.startsWith('/') ||
    normalized.includes('\\') ||
    normalized.split('/').some((part) => part === '..')
  )
    throw new DelegationAgentCapabilityError('invalid_projection');
  return normalized;
}

function parseJson(value: string): Record<string, unknown> {
  try {
    const parsed = record(JSON.parse(value));
    if (parsed) return parsed;
  } catch {
    // A malformed selected file is unavailable to the child.
  }
  throw new DelegationAgentCapabilityError('invalid_projection');
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value;
  throw new DelegationAgentCapabilityError('invalid_projection');
}

function optionalStringList(value: unknown): string | string[] | undefined {
  if (value === undefined || typeof value === 'string') return value;
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string'))
    return value;
  throw new DelegationAgentCapabilityError('invalid_projection');
}

function optionalManifestConfig(
  value: unknown,
): string | string[] | Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  const object = record(value);
  return object ?? optionalStringList(value);
}

function claudePluginManifest(
  value: Record<string, unknown>,
): ClaudePluginManifest {
  const author = value.author === undefined ? undefined : record(value.author);
  if (
    value.author !== undefined &&
    (!author || typeof author.name !== 'string')
  )
    throw new DelegationAgentCapabilityError('invalid_projection');
  const authorName = author ? optionalString(author.name) : undefined;
  return {
    name: optionalString(value.name),
    version: optionalString(value.version),
    author:
      authorName !== undefined
        ? { name: authorName, email: optionalString(author?.email) }
        : undefined,
    description: optionalString(value.description),
    homepage: optionalString(value.homepage),
    skills: optionalStringList(value.skills),
    agents: optionalStringList(value.agents),
    commands: optionalStringList(value.commands),
    apps: optionalStringList(value.apps),
    hooks: optionalManifestConfig(value.hooks),
    mcpServers: optionalManifestConfig(value.mcpServers),
    lspServers: optionalManifestConfig(value.lspServers),
  };
}

function label(kind: string, identity: string): string {
  return `${kind}/${createHash('sha256').update(identity).digest('hex').slice(0, 16)}`;
}

export function memberName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]/g, '-') || 'selected';
}

export function validateSkillInstructions(
  files: ReadonlyMap<string, string>,
  manifest?: Record<string, unknown>,
): void {
  const declared = new Set<string>();
  for (const key of ['skills', 'commands']) {
    const value = manifest?.[key];
    const refs =
      typeof value === 'string'
        ? [value]
        : Array.isArray(value)
          ? value.filter((entry): entry is string => typeof entry === 'string')
          : [];
    for (const ref of refs) {
      const member = safePath(ref);
      if (!validDelegationPath(member))
        throw new DelegationAgentCapabilityError('unavailable_asset');
      declared.add(member);
    }
  }
  for (const [name, content] of Array.from(files.entries())) {
    if (
      !name.endsWith('SKILL.md') &&
      !name.startsWith('skills/') &&
      !name.startsWith('commands/') &&
      !Array.from(declared).some(
        (entry) => name === entry || name.startsWith(`${entry}/`),
      )
    )
      continue;
    if (!name.endsWith('.md')) continue;
    const metadata = parseFrontmatter(content);
    if (
      metadata?.context === 'fork' ||
      metadata?.agent !== undefined ||
      metadata?.hooks !== undefined ||
      /!`[^`\n]+`/.test(content)
    )
      throw new DelegationAgentCapabilityError('unsupported_skill_execution');
  }
}

function claudeInvocableNames(
  source: ReadonlyMap<string, string>,
  manifest: Record<string, unknown>,
  wrapperName: string,
): string[] {
  const names = new Set<string>();
  const configured = (key: 'skills' | 'commands'): string[] => {
    const value = manifest[key];
    return typeof value === 'string'
      ? [safePath(value)]
      : Array.isArray(value)
        ? value
            .filter((entry): entry is string => typeof entry === 'string')
            .map(safePath)
        : [];
  };
  const skillPaths = configured('skills');
  const commandPaths = configured('commands');
  for (const [file, content] of Array.from(source.entries())) {
    if (!file.endsWith('.md')) continue;
    const skill =
      file.endsWith('/SKILL.md') &&
      (file.startsWith('skills/') ||
        skillPaths.some(
          (entry) => file.startsWith(`${entry}/`) || file === entry,
        ));
    const command =
      (file.startsWith('commands/') ||
        commandPaths.some(
          (entry) => file.startsWith(`${entry}/`) || file === entry,
        )) &&
      !file.endsWith('/SKILL.md');
    if (!skill && !command) continue;
    const parsed = parseFrontmatter(content);
    const rawName =
      typeof parsed?.name === 'string'
        ? parsed.name
        : skill
          ? path.posix.basename(path.posix.dirname(file))
          : path.posix.basename(file, '.md');
    names.add(`${wrapperName}:${memberName(rawName)}`);
  }
  return Array.from(names).sort();
}

export async function readDelegationCapabilityTree(
  directory: string,
  openFiles: (
    directory: string,
  ) => Promise<Pick<NativeDelegationFiles, 'list' | 'read' | 'close'>>,
): Promise<Map<string, string>> {
  const reader = await openFiles(directory);
  const files = new Map<string, string>();
  try {
    const pending = [''];
    while (pending.length > 0) {
      const current = pending.shift();
      if (current === undefined) break;
      for (const entry of await reader.list(current)) {
        const member = safePath(entry.path);
        if (/(^|\/)\.(?:git|hg|svn)(?:\/|$)/.test(member)) continue;
        if (!validDelegationPath(member)) continue;
        if (entry.directory) {
          if (member.split('/').length > 12 || pending.length >= 256)
            throw new DelegationAgentCapabilityError('unavailable_asset');
          pending.push(member);
          continue;
        }
        // The native reader is text-only. A partial capability would appear
        // available but fail when its instructions reference an omitted asset.
        if (INERT_BINARY_ART.test(member))
          throw new DelegationAgentCapabilityError('unavailable_asset');
        let content: string;
        try {
          content = await reader.read(member);
        } catch {
          throw new DelegationAgentCapabilityError('unavailable_asset');
        }
        files.set(member, content);
        if (files.size > MAX_FILES)
          throw new DelegationAgentCapabilityError('unavailable_asset');
      }
    }
    return files;
  } finally {
    await reader.close();
  }
}

function pluginMcpConfigs(
  source: ReadonlyMap<string, string>,
  manifest: Record<string, unknown>,
): { configs: Record<string, Record<string, unknown>>; referenced: string[] } {
  const declaration = manifest.mcpServers;
  const referenced =
    typeof declaration === 'string'
      ? [safePath(declaration)]
      : Array.isArray(declaration)
        ? declaration.map((entry) => {
            if (typeof entry !== 'string')
              throw new DelegationAgentCapabilityError('invalid_projection');
            return safePath(entry);
          })
        : declaration === undefined && source.has('.mcp.json')
          ? ['.mcp.json']
          : [];
  const configs: Record<string, Record<string, unknown>> = {};
  const add = (value: unknown): void => {
    const container = record(value);
    if (!container)
      throw new DelegationAgentCapabilityError('invalid_projection');
    const servers = record(container.mcpServers) ?? container;
    for (const [name, raw] of Object.entries(servers)) {
      const config = record(raw);
      if (!config)
        throw new DelegationAgentCapabilityError('invalid_projection');
      configs[name] = config;
    }
  };
  if (record(declaration)) add(declaration);
  for (const reference of referenced) {
    const text = source.get(reference);
    if (!text) throw new DelegationAgentCapabilityError('missing_selection');
    add(parseJson(text));
  }
  return { configs, referenced };
}

function copyFiles(
  target: Record<string, string>,
  root: string,
  source: ReadonlyMap<string, string>,
): void {
  for (const [member, content] of Array.from(source.entries())) {
    const name = `${root}/${safePath(member)}`;
    if (name in target)
      throw new DelegationAgentCapabilityError('invalid_projection');
    target[name] = content;
  }
}

function safePluginFiles(
  source: ReadonlyMap<string, string>,
  manifestPath: string,
  manifest: Record<string, unknown>,
  mcpFiles: readonly string[],
  origin: ReadonlyMap<string, string> = source,
): Map<string, string> {
  const files = new Map(source);
  files.delete('.mcp.json');
  files.delete('mcp.json');
  for (const member of mcpFiles) files.delete(member);
  for (const name of [
    '.claude-plugin/plugin.json',
    '.codex-plugin/plugin.json',
  ]) {
    const text = source.get(name);
    if (!text) continue;
    const parsed = name === manifestPath ? manifest : parseJson(text);
    const references = pluginMcpConfigs(origin, parsed).referenced;
    for (const reference of references) files.delete(reference);
    const safeManifest = { ...parsed };
    delete safeManifest.mcpServers;
    files.set(name, `${JSON.stringify(safeManifest, null, 2)}\n`);
  }
  return files;
}

export interface DelegationCapabilityLayer {
  readonly source: DelegationCapabilitySource;
  readonly selections: ChatTabPluginSelections;
}

export interface DelegationCapabilityItemResult {
  readonly id: string;
  readonly kind: DelegationCapabilityKind;
  readonly name: string;
  readonly source: DelegationCapabilitySource;
  readonly ref: CapabilityItemRef;
}

export interface SkippedDelegationCapabilityItem extends DelegationCapabilityItemResult {
  readonly reason: DelegationAgentCapabilityErrorCode;
}

export interface MaterializedDelegationCapabilities {
  readonly files: Readonly<Record<string, string>>;
  readonly toolNames: readonly AgentProjectionToolName[];
  readonly capabilities: AgentCapabilitySnapshot;
  readonly provenance: CapabilityOverlayProvenance;
  readonly included: readonly DelegationCapabilityItemResult[];
  readonly skipped: readonly SkippedDelegationCapabilityItem[];
  readonly layerWarnings: readonly {
    readonly source: DelegationCapabilitySource;
    readonly reason: DelegationAgentCapabilityErrorCode;
  }[];
}

type EffectivePluginSelectionRefs = Awaited<
  ReturnType<typeof resolveEffectivePluginSelectionRefs>
>;

interface SingleProjectionOptions {
  readonly cache: DelegationCapabilityCache | undefined;
  readonly marketplaceCache:
    | Awaited<ReturnType<typeof loadMarketplacesCacheOnly>>
    | undefined;
  readonly loadAccountConnections: () => ReturnType<
    typeof loadAccountMcpRefConnections
  >;
  readonly defaultHttpAuthHandler: () => Promise<McpHttpAuthHandler>;
  readonly usedNames: Map<string, number>;
}

interface AgentPluginProjection {
  readonly files: Readonly<Record<string, string>>;
  readonly toolNames: readonly AgentProjectionToolName[];
  readonly capabilities: AgentCapabilitySnapshot;
}

function singleRefs(
  skillRefs: EffectivePluginSelectionRefs['skillRefs'],
  pluginRefs: EffectivePluginSelectionRefs['pluginRefs'],
  mcpServerRefs: EffectivePluginSelectionRefs['mcpServerRefs'],
): EffectivePluginSelectionRefs {
  return {
    skillRefs,
    pluginRefs,
    mcpServerRefs,
    warnings: [],
    disabledRefs: [],
  };
}

function resultFor(
  ref: CapabilityItemRef,
  name: string,
  source: DelegationCapabilitySource,
): DelegationCapabilityItemResult {
  return {
    id: delegationCapabilityIdForRef(ref),
    kind: ref.kind,
    name: delegationCapabilityDisplayName(name),
    source,
    ref,
  };
}

function itemError(error: unknown): DelegationAgentCapabilityError {
  if (error instanceof DelegationAgentCapabilityError) return error;
  if (error instanceof Error) throw error;
  throw new Error('Delegation capability materialization failed');
}

async function readCapabilityTree(
  directory: string,
  identity: string,
  openFiles: (
    directory: string,
  ) => Promise<Pick<NativeDelegationFiles, 'list' | 'read' | 'close'>>,
  harness: ModelHarness,
  cache: DelegationCapabilityCache | undefined,
): Promise<Map<string, string>> {
  if (
    !cache ||
    (harness !== 'claude' &&
      harness !== 'codex' &&
      harness !== 'cursor' &&
      harness !== 'copilot' &&
      harness !== 'opencode')
  )
    return readDelegationCapabilityTree(directory, openFiles);
  const cached = await cache.readTree({ harness, identity, directory }, () =>
    readDelegationCapabilityTree(directory, openFiles),
  );
  return new Map(cached);
}

/** Materialize one already-resolved item; callers isolate its failures. */
async function materializeSingleAgentPluginItem(
  selections: ChatTabPluginSelections,
  openFiles: (
    directory: string,
  ) => Promise<Pick<NativeDelegationFiles, 'list' | 'read' | 'close'>>,
  harness: ModelHarness,
  refs: EffectivePluginSelectionRefs,
  options: SingleProjectionOptions,
): Promise<AgentPluginProjection> {
  if (
    harness !== 'claude' &&
    harness !== 'codex' &&
    harness !== 'cursor' &&
    harness !== 'copilot' &&
    harness !== 'opencode'
  )
    throw new DelegationAgentCapabilityError('unsupported_capability');
  const files: Record<string, string> = {};
  const claudePluginRoots: string[] = [];
  const claudeSkillNames: string[] = [];
  const codexCapabilityRoots: string[] = [];
  const mcpSelections: AgentMcpSelection[] = [];
  const selectedHttpAuthPreferences = new Map<string, AgentMcpHttpAuthPin>();
  const effectiveSelections = normalizePluginSelections(selections);
  const usedNames = options.usedNames;
  const uniqueName = (value: string): string => {
    const base = memberName(value);
    const next = (usedNames.get(base) ?? 0) + 1;
    usedNames.set(base, next);
    return next === 1 ? base : base + '-' + next;
  };

  for (const ref of refs.skillRefs) {
    const warnings: string[] = [];
    const directory = resolveSelectedSkillDirectory(ref, warnings);
    if (!directory || warnings.length > 0)
      throw new DelegationAgentCapabilityError('missing_selection');
    const identity = delegationCapabilityIdForRef({
      kind: 'skill',
      sourceId: ref.sourceId,
      skillName: ref.skillName,
    });
    const source = await readCapabilityTree(
      directory,
      identity,
      openFiles,
      harness,
      options.cache,
    );
    validateSkillInstructions(source);
    if (!source.has('SKILL.md'))
      throw new DelegationAgentCapabilityError('missing_selection');
    const root = label('skills', ref.sourceId + '/' + ref.skillName);
    const skillName = uniqueName(ref.skillName);
    const wrapped = new Map<string, string>();
    for (const [member, content] of Array.from(source.entries()))
      wrapped.set('skills/' + skillName + '/' + member, content);
    if (harness !== 'codex') {
      wrapped.set(
        '.claude-plugin/plugin.json',
        JSON.stringify({ name: skillName, skills: './skills' }),
      );
      claudePluginRoots.push(root);
      const parsed = parseFrontmatter(source.get('SKILL.md') ?? '');
      claudeSkillNames.push(
        skillName +
          ':' +
          memberName(
            typeof parsed?.name === 'string' ? parsed.name : ref.skillName,
          ),
      );
    } else {
      wrapped.set(
        '.codex-plugin/plugin.json',
        JSON.stringify({ name: skillName, skills: './skills' }),
      );
      codexCapabilityRoots.push(root);
    }
    copyFiles(files, root, wrapped);
  }

  for (const ref of refs.pluginRefs) {
    const marketplaceCache = options.marketplaceCache;
    if (!marketplaceCache?.success || !marketplaceCache.data)
      throw new DelegationAgentCapabilityError('missing_selection');
    const marketplace = marketplaceCache.data.marketplaces.find(
      (entry) => entry.id === ref.marketplaceId,
    );
    const plugin = marketplace?.plugins.find(
      (entry) => entry.name.toLowerCase() === ref.pluginName.toLowerCase(),
    );
    if (!marketplace || !plugin)
      throw new DelegationAgentCapabilityError('missing_selection');
    const selected =
      harness === 'codex' && plugin.facets?.codex
        ? { ...plugin, facets: { codex: plugin.facets.codex } }
        : plugin;
    const warnings: string[] = [];
    const directory = await resolvePluginInfoPath(
      selected,
      marketplace,
      warnings,
      false,
    );
    if (!directory || warnings.length > 0)
      throw new DelegationAgentCapabilityError('missing_selection');
    const identity = delegationCapabilityIdForRef({
      kind: 'plugin',
      marketplaceId: ref.marketplaceId,
      pluginName: plugin.name,
    });
    const source = await readCapabilityTree(
      directory,
      identity,
      openFiles,
      harness,
      options.cache,
    );
    const codexNative =
      harness === 'codex' && source.has('.codex-plugin/plugin.json');
    const manifestPath = codexNative
      ? '.codex-plugin/plugin.json'
      : '.claude-plugin/plugin.json';
    const manifestText = source.get(manifestPath);
    if (!manifestText)
      throw new DelegationAgentCapabilityError('missing_selection');
    const manifest = parseJson(manifestText);
    validateSkillInstructions(source, manifest);
    const hasMonitorDeclaration = [
      '.claude-plugin/plugin.json',
      '.codex-plugin/plugin.json',
    ].some((name) => {
      const text = source.get(name);
      return text ? parseJson(text).monitors !== undefined : false;
    });
    const hasLspDeclaration = [
      '.claude-plugin/plugin.json',
      '.codex-plugin/plugin.json',
    ].some((name) => {
      const text = source.get(name);
      return text ? parseJson(text).lspServers !== undefined : false;
    });
    if (
      hasLspDeclaration ||
      Array.from(source.keys()).some(
        (name) => name === '.lsp.json' || name.endsWith('/.lsp.json'),
      )
    )
      throw new DelegationAgentCapabilityError('unsupported_lsp');
    if (
      manifest.hooks !== undefined ||
      hasMonitorDeclaration ||
      Array.from(source.keys()).some((name) =>
        /(^|\/)(?:hooks|monitors)\//.test(name),
      )
    )
      throw new DelegationAgentCapabilityError('unsupported_hooks');

    const root = label('plugins', ref.marketplaceId + '/' + ref.pluginName);
    const wrapperName = uniqueName(ref.pluginName);
    const { configs, referenced } = pluginMcpConfigs(source, manifest);
    for (const [serverName, config] of Object.entries(configs)) {
      if (config.enabled === false) continue;
      if (typeof config.url === 'string') {
        const target = {
          kind: 'plugin' as const,
          marketplaceId: ref.marketplaceId,
          pluginName: ref.pluginName,
          serverName,
        };
        const { handler, source } = getMcpHttpAuthHandler(
          effectiveSelections,
          target,
          await options.defaultHttpAuthHandler(),
        );
        // Any handler the parent can use (canopy proxy, provider, account)
        // is pinned so the child resolves the server exactly as the parent.
        // The source tells the child whether the user chose it.
        selectedHttpAuthPreferences.set(mcpHttpAuthTargetKey(target), {
          target,
          handler,
          source,
        });
      }
      mcpSelections.push({
        source: 'plugin',
        marketplaceId: ref.marketplaceId,
        pluginName: ref.pluginName,
        serverName,
        root,
        configDigest: mcpTransportDigest(config, {
          marketplaceId: ref.marketplaceId,
          pluginName: ref.pluginName,
          serverName,
        }),
      });
    }
    let staged: Map<string, string>;
    if (harness === 'codex' && !codexNative) {
      const projected = projectClaudePluginForCodex({
        pluginName: wrapperName,
        category: plugin.category ?? '',
        manifest: claudePluginManifest(manifest),
        rawManifest: manifest,
        files: source,
        includeMcpServers: false,
      });
      if (projected.warnings.length > 0)
        throw new DelegationAgentCapabilityError('unsupported_capability');
      staged = new Map(
        Array.from(projected.files.entries()).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      );
    } else if (codexNative) {
      staged = new Map(
        Array.from(
          projectCodexPluginWithoutMcpServers({
            files: source,
            manifest,
          }).entries(),
        ).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      );
    } else {
      staged = safePluginFiles(source, manifestPath, manifest, referenced);
    }
    for (const member of referenced) staged.delete(member);
    staged.delete('.mcp.json');
    staged.delete('mcp.json');
    staged = safePluginFiles(
      staged,
      manifestPath,
      manifest,
      referenced,
      source,
    );
    const stagedManifestPath =
      harness === 'codex'
        ? '.codex-plugin/plugin.json'
        : '.claude-plugin/plugin.json';
    const stagedManifest = staged.get(stagedManifestPath);
    if (stagedManifest) {
      staged.set(
        stagedManifestPath,
        JSON.stringify(
          {
            ...parseJson(stagedManifest),
            name: wrapperName,
          },
          null,
          2,
        ) + '\n',
      );
    }
    copyFiles(files, root, staged);
    if (harness !== 'codex') claudePluginRoots.push(root);
    else codexCapabilityRoots.push(root);
    if (harness !== 'codex')
      claudeSkillNames.push(
        ...claudeInvocableNames(source, manifest, wrapperName),
      );
  }

  for (const ref of refs.mcpServerRefs) {
    const accountOnly =
      legacyAccountMcpConnectionId(ref.serverId) !== undefined ||
      isCustomAccountMcpServerKey(ref.serverId);
    let parsed: unknown;
    if (!accountOnly) {
      try {
        parsed = JSON.parse(
          await readFile(getMcpServerFilePath(ref.serverId), 'utf8'),
        );
      } catch {
        parsed = undefined;
      }
    }
    if (parsed === undefined) {
      if (!accountMcpConnectionsEnabled())
        throw new DelegationAgentCapabilityError(
          accountOnly ? 'unsupported_capability' : 'missing_selection',
        );
      const connection = accountMcpConnectionForRef(
        ref,
        (await options.loadAccountConnections()) ?? [],
      );
      if (!connection)
        throw new DelegationAgentCapabilityError('missing_selection');
      mcpSelections.push({
        source: 'account',
        serverId: connection.serverKey,
        configId: connection.configId,
        configDigest: accountMcpTransportDigest(connection),
      });
      continue;
    }

    let server: ReturnType<typeof normalizeMcpServerFile>['server'];
    try {
      server = normalizeMcpServerFile(parsed, ref.serverId).server;
    } catch {
      throw new DelegationAgentCapabilityError('invalid_projection');
    }
    const config = server.configs.find((entry) => entry.id === ref.configId);
    if (!config || !config.enabled)
      throw new DelegationAgentCapabilityError('missing_selection');
    if (server.definition.type === 'http') {
      const target = {
        kind: 'standalone' as const,
        serverId: ref.serverId,
        configId: ref.configId,
      };
      const indexEntry = await readMcpAccountIndexEntry(ref.serverId);
      const { handler, source } = getMcpHttpAuthHandler(
        effectiveSelections,
        target,
        getMcpHttpAuthDefault(
          server.definition,
          indexEntry,
          await options.defaultHttpAuthHandler(),
        ),
      );
      // Pinned like the plugin loop above: every handler is supported.
      selectedHttpAuthPreferences.set(mcpHttpAuthTargetKey(target), {
        target,
        handler,
        source,
      });
    }
    mcpSelections.push({
      source: 'standalone',
      serverId: ref.serverId,
      configId: ref.configId,
      configDigest: standaloneMcpTransportDigest(
        ref.serverId,
        ref.configId,
        server.definition,
        config,
      ),
    });
  }

  if (
    Object.keys(files).length > MAX_FILES ||
    Buffer.byteLength(JSON.stringify(files), 'utf8') > MAX_BYTES
  )
    throw new DelegationAgentCapabilityError('unavailable_asset');
  return {
    files,
    toolNames: ['read', 'search'],
    capabilities: {
      claudePluginRoots,
      claudeSkillNames,
      codexCapabilityRoots,
      mcpSelections,
      mcpHttpAuthPreferences: Array.from(selectedHttpAuthPreferences.values()),
      hookDeclarations: [],
    },
  };
}

/** Resolve and project independent layers, isolating unusable items. */
export async function materializeDelegationCapabilities(
  layers: readonly DelegationCapabilityLayer[],
  openFiles: (
    directory: string,
  ) => Promise<Pick<NativeDelegationFiles, 'list' | 'read' | 'close'>>,
  harness: ModelHarness,
  options?: {
    readonly cache?: DelegationCapabilityCache;
    /**
     * The workspace the parent chat resolved its plugins for, so a delegate
     * keeps the organization skills that workspace allows (CAN-6237);
     * without it none load.
     */
    readonly workspaceId?: string;
  },
): Promise<MaterializedDelegationCapabilities> {
  if (
    harness !== 'claude' &&
    harness !== 'codex' &&
    harness !== 'cursor' &&
    harness !== 'copilot' &&
    harness !== 'opencode'
  )
    throw new DelegationAgentCapabilityError('unsupported_capability');

  const files: Record<string, string> = {};
  const claudePluginRoots: string[] = [];
  const claudeSkillNames: string[] = [];
  const codexCapabilityRoots: string[] = [];
  const mcpSelections: AgentMcpSelection[] = [];
  const mcpSelectionSources: DelegationCapabilitySource[] = [];
  const mcpHttpAuthPreferences = new Map<string, AgentMcpHttpAuthPin>();
  const roots: Record<string, DelegationCapabilitySource> = {};
  const included: DelegationCapabilityItemResult[] = [];
  const skipped: SkippedDelegationCapabilityItem[] = [];
  const layerWarnings: {
    source: DelegationCapabilitySource;
    reason: DelegationAgentCapabilityErrorCode;
  }[] = [];
  const seen = new Set<string>();
  const usedNames = new Map<string, number>();
  let globalHttpAuthHandler: Promise<McpHttpAuthHandler> | undefined;
  const defaultHttpAuthHandler = (): Promise<McpHttpAuthHandler> => {
    globalHttpAuthHandler ??= readPreferencesFile().then(
      (preferences) =>
        preferences.mcpHttpAuthDefaultHandler ?? DEFAULT_MCP_HTTP_AUTH_HANDLER,
    );
    return globalHttpAuthHandler;
  };
  let marketplaceCache:
    | Awaited<ReturnType<typeof loadMarketplacesCacheOnly>>
    | undefined;
  let marketplaceCacheLoaded = false;
  let accountConnections:
    | ReturnType<typeof loadAccountMcpRefConnections>
    | undefined;
  const loadAccountConnections = (): ReturnType<
    typeof loadAccountMcpRefConnections
  > => {
    accountConnections ??= loadAccountMcpRefConnections();
    return accountConnections;
  };

  const commit = (
    projection: AgentPluginProjection,
    source: DelegationCapabilitySource,
  ): void => {
    for (const name of Object.keys(projection.files)) {
      if (name in files)
        throw new DelegationAgentCapabilityError('invalid_projection');
    }
    const candidateFiles = { ...files, ...projection.files };
    const candidateRootCount =
      harness !== 'codex'
        ? claudePluginRoots.length +
          projection.capabilities.claudePluginRoots.length
        : codexCapabilityRoots.length +
          projection.capabilities.codexCapabilityRoots.length;
    if (
      Object.keys(candidateFiles).length > MAX_FILES ||
      Buffer.byteLength(JSON.stringify(candidateFiles), 'utf8') > MAX_BYTES ||
      candidateRootCount > 64 ||
      (harness !== 'codex' &&
        claudeSkillNames.length +
          projection.capabilities.claudeSkillNames.length >
          128) ||
      mcpSelections.length + projection.capabilities.mcpSelections.length > 128
    )
      throw new DelegationAgentCapabilityError('unavailable_asset');

    for (const [name, content] of Object.entries(projection.files))
      files[name] = content;
    claudePluginRoots.push(...projection.capabilities.claudePluginRoots);
    claudeSkillNames.push(...projection.capabilities.claudeSkillNames);
    codexCapabilityRoots.push(...projection.capabilities.codexCapabilityRoots);
    for (const mcpSelection of projection.capabilities.mcpSelections) {
      mcpSelections.push(mcpSelection);
      mcpSelectionSources.push(source);
    }
    for (const preference of projection.capabilities.mcpHttpAuthPreferences)
      mcpHttpAuthPreferences.set(
        mcpHttpAuthTargetKey(preference.target),
        preference,
      );
    for (const root of [
      ...projection.capabilities.claudePluginRoots,
      ...projection.capabilities.codexCapabilityRoots,
    ])
      roots[root] = source;
  };

  const recordItemError = (
    error: unknown,
    ref: CapabilityItemRef,
    name: string,
    source: DelegationCapabilitySource,
  ): void => {
    const capabilityError = itemError(error);
    skipped.push({
      ...resultFor(ref, name, source),
      reason: capabilityError.code,
    });
  };

  const priorities: readonly DelegationCapabilitySource[] = [
    'agent',
    'explicit',
    'loaded',
    'inherited',
  ];
  for (const priority of priorities) {
    for (const layer of layers) {
      if (layer.source !== priority) continue;
      const selections = normalizePluginSelections(layer.selections);
      const resolverWarnings: string[] = [];
      const refs = await resolveEffectivePluginSelectionRefs(
        selections,
        resolverWarnings,
        options?.workspaceId,
      );
      if (resolverWarnings.length > 0 || refs.warnings.length > 0)
        layerWarnings.push({
          source: layer.source,
          reason: 'missing_selection',
        });

      for (const ref of refs.skillRefs) {
        const itemRef: CapabilityItemRef = {
          kind: 'skill',
          sourceId: ref.sourceId,
          skillName: ref.skillName,
        };
        const key = JSON.stringify(['skill', ref.sourceId, ref.skillName]);
        if (seen.has(key)) continue;
        seen.add(key);
        const localNames = new Map(usedNames);
        try {
          const projection = await materializeSingleAgentPluginItem(
            selections,
            openFiles,
            harness,
            singleRefs([ref], [], []),
            {
              cache: options?.cache,
              marketplaceCache,
              loadAccountConnections,
              defaultHttpAuthHandler,
              usedNames: localNames,
            },
          );
          commit(projection, layer.source);
          usedNames.clear();
          for (const [name, count] of Array.from(localNames.entries()))
            usedNames.set(name, count);
          included.push(resultFor(itemRef, ref.skillName, layer.source));
        } catch (error) {
          recordItemError(error, itemRef, ref.skillName, layer.source);
        }
      }

      for (const ref of refs.pluginRefs) {
        if (!marketplaceCacheLoaded) {
          marketplaceCache = await loadMarketplacesCacheOnly();
          marketplaceCacheLoaded = true;
        }
        const marketplace = marketplaceCache?.success
          ? marketplaceCache.data?.marketplaces.find(
              (entry) => entry.id === ref.marketplaceId,
            )
          : undefined;
        const plugin = marketplace?.plugins.find(
          (entry) => entry.name.toLowerCase() === ref.pluginName.toLowerCase(),
        );
        const pluginName = plugin?.name ?? ref.pluginName;
        const itemRef: CapabilityItemRef = {
          kind: 'plugin',
          marketplaceId: ref.marketplaceId,
          pluginName,
        };
        const key = JSON.stringify([
          'plugin',
          ref.marketplaceId,
          pluginName.toLowerCase(),
        ]);
        if (seen.has(key)) continue;
        seen.add(key);
        const localNames = new Map(usedNames);
        try {
          const projection = await materializeSingleAgentPluginItem(
            selections,
            openFiles,
            harness,
            singleRefs([], [ref], []),
            {
              cache: options?.cache,
              marketplaceCache,
              loadAccountConnections,
              defaultHttpAuthHandler,
              usedNames: localNames,
            },
          );
          commit(projection, layer.source);
          usedNames.clear();
          for (const [name, count] of Array.from(localNames.entries()))
            usedNames.set(name, count);
          included.push(resultFor(itemRef, pluginName, layer.source));
        } catch (error) {
          recordItemError(error, itemRef, pluginName, layer.source);
        }
      }

      for (const ref of refs.mcpServerRefs) {
        let itemRef: CapabilityItemRef = {
          kind: 'mcp',
          serverId: ref.serverId,
          configId: ref.configId,
        };
        let itemName = ref.serverId;
        const selectedKey = JSON.stringify([
          'mcp-ref',
          ref.serverId,
          ref.configId,
        ]);
        if (seen.has(selectedKey)) continue;
        // Record the raw ref immediately so a second occurrence of this
        // exact ref (e.g. the same explicit selection repeated in another
        // layer) is caught by the check above instead of re-running file
        // reads and account-connection resolution just to reach the
        // `duplicateKey` de-dupe below.
        seen.add(selectedKey);
        let duplicateKey = selectedKey;
        let parsed: unknown;
        const accountOnly =
          legacyAccountMcpConnectionId(ref.serverId) !== undefined ||
          isCustomAccountMcpServerKey(ref.serverId);
        if (!accountOnly) {
          try {
            parsed = JSON.parse(
              await readFile(getMcpServerFilePath(ref.serverId), 'utf8'),
            );
          } catch {
            parsed = undefined;
          }
        }
        if (parsed !== undefined) {
          duplicateKey = JSON.stringify([
            'standalone',
            ref.serverId,
            ref.configId,
          ]);
          try {
            const server = normalizeMcpServerFile(parsed, ref.serverId).server;
            itemName = server.definition.name || ref.serverId;
            const config = server.configs.find(
              (entry) => entry.id === ref.configId,
            );
            if (config && config.name !== server.definition.name)
              itemName = itemName + ' / ' + config.name;
          } catch {
            // The item projection records invalid persisted configuration.
          }
        } else if (accountMcpConnectionsEnabled()) {
          const connections = (await loadAccountConnections()) ?? [];
          const connection = accountMcpConnectionForRef(ref, connections);
          if (connection) {
            itemRef = {
              kind: 'mcp',
              serverId: connection.serverKey,
              configId: connection.configId,
            };
            itemName = connection.displayName || connection.serverKey;
            duplicateKey = JSON.stringify(['account', connection.id]);
          }
        }
        if (duplicateKey !== selectedKey && seen.has(duplicateKey)) continue;
        seen.add(duplicateKey);
        try {
          const projection = await materializeSingleAgentPluginItem(
            selections,
            openFiles,
            harness,
            singleRefs([], [], [ref]),
            {
              cache: options?.cache,
              marketplaceCache,
              loadAccountConnections,
              defaultHttpAuthHandler,
              usedNames: new Map(usedNames),
            },
          );
          commit(projection, layer.source);
          included.push(resultFor(itemRef, itemName, layer.source));
        } catch (error) {
          recordItemError(error, itemRef, itemName, layer.source);
        }
      }
    }
  }

  return {
    files,
    toolNames: ['read', 'search'],
    capabilities: {
      claudePluginRoots,
      claudeSkillNames,
      codexCapabilityRoots,
      mcpSelections,
      mcpHttpAuthPreferences: Array.from(mcpHttpAuthPreferences.values()),
      hookDeclarations: [],
    },
    provenance: {
      roots,
      mcpSelections: mcpSelectionSources,
    },
    included,
    skipped,
    layerWarnings,
  };
}

/** Compatibility wrapper preserving the Agent projection's fail-fast API. */
export async function materializeDelegationAgentPlugins(
  selections: ChatTabPluginSelections | undefined,
  openFiles: (
    directory: string,
  ) => Promise<Pick<NativeDelegationFiles, 'list' | 'read' | 'close'>>,
  harness: ModelHarness = 'claude',
  options?: { readonly cache?: DelegationCapabilityCache },
): Promise<{
  files: Readonly<Record<string, string>>;
  toolNames: readonly AgentProjectionToolName[];
  capabilities: AgentCapabilitySnapshot;
}> {
  const emptySelections: ChatTabPluginSelections = {
    collectionIds: [],
    skillRefs: [],
    pluginRefs: [],
  };
  const materialized = await materializeDelegationCapabilities(
    [{ source: 'agent', selections: selections ?? emptySelections }],
    openFiles,
    harness,
    options,
  );
  const firstLayerWarning = materialized.layerWarnings[0];
  if (firstLayerWarning)
    throw new DelegationAgentCapabilityError(firstLayerWarning.reason);
  const firstSkippedItem = materialized.skipped[0];
  if (firstSkippedItem)
    throw new DelegationAgentCapabilityError(firstSkippedItem.reason);
  return {
    files: materialized.files,
    toolNames: materialized.toolNames,
    capabilities: materialized.capabilities,
  };
}
