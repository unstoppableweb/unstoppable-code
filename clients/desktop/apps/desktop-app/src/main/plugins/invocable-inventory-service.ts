import { assertStoredSkillContext } from '../skills/skill-install-context';
import {
  skillResourceContextEnabled,
  skillContextSnapshot,
  assertSkillContextSnapshot,
} from '../skills/resource-lanes';
import { BrowserWindow } from 'electron';
import * as fs from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { INVOCABLE_INVENTORY_CHANNELS } from '@canopy/desktop-shared/constants/invocable-inventory-channels';
import type {
  ChatTabPluginSelections,
  InvocableInventoryCache,
  InvocableInventoryEnableRef,
  InvocableInventoryEntry,
  InvocableInventoryKind,
  InvocableInventoryProvider,
  ListInvocableInventoryRequest,
  ListInvocableInventoryResponse,
  ResolveInvocableSelectionRequest,
  ResolveInvocableSelectionResponse,
} from '@canopy/desktop-shared/types';
import type { IPCResult } from '@canopy/execution-engine/types/pipeline';
import type {
  MarketplaceInfo,
  PluginCommandInfo,
  PluginInfo,
  PluginProviderFacet,
  PluginSkillInfo,
} from '@canopy/execution-engine/types/plugins';
import { getDataDir } from '../lib/paths';
import { getBundledSkillDir } from '../pipelines/config-paths';
import { readSkillContent, loadSkills } from '../skills/skill-service';
import { getSkillDir, isBuiltinSourceId } from '../skills/paths';
import type { PipelinePackageSourceDescriptor } from '@canopy/desktop-shared/node/pipelines/package-analyzer';
import {
  buildProjectionPlan,
  BUILTIN_APP_PLUGIN_NAME,
  readClaudePluginCompatibilitySource,
  type ClaudePluginCompatibilitySource,
} from './codex-plugin-compat';
import { loadMarketplaces, loadMarketplacesCacheOnly } from './plugin-service';
import {
  codexAggregateSkillInvocationNamesForRefs,
  cursorSkillSourceDir,
  discoverCursorPluginMembers,
  resolveEffectivePluginSelectionRefs,
} from './plugin-resolver';
import {
  assignCursorInvocationIds,
  cursorInvocationKey,
  inheritedCursorRootLabel,
  sortCursorPluginMembers,
  type CursorInvocationSource,
} from '@canopy/desktop-shared/lib/cursor-capabilities';
import {
  discoverInheritedCursorCapabilities,
  emptyInheritedCursorCapabilities,
  type InheritedCursorCapabilities,
} from '@canopy/desktop-shared/node/cursor/inherited-capabilities';
import { resolveInheritedCursorRoots } from '../cursor/inherited-roots';
import { inheritedClaudePluginRefs } from './inherited-cursor-plugins';
import { readInstalledItemPolicy } from '../installed-items/installed-item-policy';
import {
  isPluginInstallRoot,
  readClaudeEnabledPlugins,
} from './claude-enabled-plugins';
import { sendToWebContents } from '../lib/web-contents-send';

// A cache written with any other version is rebuilt from disk.
const CACHE_VERSION = 6;

let cachedInventory: InvocableInventoryCache | null | undefined;
let cacheMarkedStale = false;
let staleGeneration = 0;
let rebuildPromise: Promise<InvocableInventoryCache> | null = null;
let writeQueue: Promise<void> = Promise.resolve();
/** When a served list last re-checked the inherited Cursor set. */
let lastInheritedRecheckAt = 0;
/** Bursts of list calls (a mount and the change push it triggers) share one check. */
const INHERITED_RECHECK_INTERVAL_MS = 1_000;

function cachePath(): string {
  return path.join(getDataDir(), 'invocable-inventory-cache.json');
}

function success<T>(data: T): IPCResult<T> {
  return { success: true, data };
}

function failure<T>(error: string): IPCResult<T> {
  return { success: false, error };
}

function providerMatches(
  entry: InvocableInventoryEntry,
  providerType: InvocableInventoryProvider,
): boolean {
  return entry.provider === providerType;
}

function markCacheStale(): void {
  cacheMarkedStale = true;
  staleGeneration += 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInvocableInventoryProvider(
  value: unknown,
): value is InvocableInventoryProvider {
  return (
    value === 'claude' ||
    value === 'codex' ||
    value === 'ollama' ||
    value === 'cursor' ||
    value === 'copilot' ||
    value === 'opencode' ||
    value === 'antigravity'
  );
}

function isInvocableInventoryKind(
  value: unknown,
): value is InvocableInventoryKind {
  return (
    value === 'skill' ||
    value === 'plugin_skill' ||
    value === 'plugin_command' ||
    value === 'inherited_skill' ||
    value === 'inherited_command'
  );
}

function normalizeEnableRef(
  value: unknown,
): InvocableInventoryEnableRef | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    value.kind === 'skill' &&
    typeof value.sourceId === 'string' &&
    typeof value.skillName === 'string'
  ) {
    return {
      kind: 'skill',
      sourceId: value.sourceId,
      skillName: value.skillName,
    };
  }
  if (
    value.kind === 'plugin' &&
    typeof value.marketplaceId === 'string' &&
    typeof value.pluginName === 'string'
  ) {
    return {
      kind: 'plugin',
      marketplaceId: value.marketplaceId,
      pluginName: value.pluginName,
    };
  }
  if (value.kind === 'none') {
    return { kind: 'none' };
  }
  return null;
}

function normalizeCacheEntry(value: unknown): InvocableInventoryEntry | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    typeof value.id !== 'string' ||
    !isInvocableInventoryProvider(value.provider) ||
    !isInvocableInventoryKind(value.kind) ||
    typeof value.name !== 'string' ||
    typeof value.displayName !== 'string' ||
    typeof value.description !== 'string' ||
    typeof value.insertText !== 'string' ||
    typeof value.invocationKey !== 'string'
  ) {
    return null;
  }
  const enableRef = normalizeEnableRef(value.enableRef);
  if (!enableRef) {
    return null;
  }

  const entry: InvocableInventoryEntry = {
    id: value.id,
    provider: value.provider,
    kind: value.kind,
    name: value.name,
    displayName: value.displayName,
    description: value.description,
    insertText: value.insertText,
    invocationKey: value.invocationKey,
    enableRef,
  };
  if (typeof value.sourceName === 'string') {
    entry.sourceName = value.sourceName;
  }
  if (typeof value.requiresCodexCompatPrepare === 'boolean') {
    entry.requiresCodexCompatPrepare = value.requiresCodexCompatPrepare;
  }
  if (typeof value.sourceLabel === 'string') {
    entry.sourceLabel = value.sourceLabel;
  }
  return entry;
}

function entryId(parts: readonly string[]): string {
  return parts.map((part) => encodeURIComponent(part)).join(':');
}

function skillPathExists(sourceId: string, skillName: string): boolean {
  const skillDir = isBuiltinSourceId(sourceId)
    ? getBundledSkillDir(skillName)
    : getSkillDir(sourceId, skillName);
  return fs.existsSync(path.join(skillDir, 'SKILL.md'));
}

function isSkillUserInvocable(sourceId: string, skillName: string): boolean {
  const content = readSkillContent(sourceId, skillName);
  if (!content.success || !content.data) {
    return false;
  }
  return content.data.frontmatter['user-invocable'] !== false;
}

function pluginSkillInvocable(skill: PluginSkillInfo): boolean {
  return skill.userInvocable !== false;
}

function marketplacePlugin(
  marketplaces: readonly MarketplaceInfo[],
  marketplaceId: string,
  pluginName: string,
): PluginInfo | null {
  const marketplace = marketplaces.find((entry) => entry.id === marketplaceId);
  return (
    marketplace?.plugins.find(
      (entry) => entry.name.toLowerCase() === pluginName.toLowerCase(),
    ) ?? null
  );
}

function facetPluginName(
  plugin: PluginInfo,
  facet: PluginProviderFacet | undefined,
): string {
  return facet?.name || plugin.name;
}

function findSkill(
  facet: PluginProviderFacet | undefined,
  name: string,
): PluginSkillInfo | null {
  return facet?.details?.skills.find((skill) => skill.name === name) ?? null;
}

function findCommand(
  facet: PluginProviderFacet | undefined,
  name: string,
): PluginCommandInfo | null {
  return (
    facet?.details?.commands.find((command) => command.name === name) ?? null
  );
}

function compatibilitySourceFromFacet(
  plugin: PluginInfo,
  claudeFacet: PluginProviderFacet,
): ClaudePluginCompatibilitySource | null {
  const pluginPath = claudeFacet.cachePath || claudeFacet.installLocation;
  const details = claudeFacet.details;
  // Inventory needs only names/metadata to build the deterministic projection
  // plan. Prefer the marketplace scan already cached on the facet so opening a
  // composer never recursively stats the plugin tree on Electron main.
  if (!details && pluginPath && fs.existsSync(pluginPath)) {
    return readClaudePluginCompatibilitySource({
      pluginName: claudeFacet.name || plugin.name,
      pluginPath,
      marketplaceId: plugin.marketplaceId,
      category: claudeFacet.category ?? plugin.category ?? '',
    });
  }

  if (!details) {
    return null;
  }

  const skills = details.skills
    .map((skill) => ({
      ...skill,
      name: skill.name.trim(),
      description: skill.description.trim(),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const commands = details.commands
    .map((command) => ({
      ...command,
      name: command.name.trim(),
      description: command.description.trim(),
    }))
    .sort((left, right) => left.filePath.localeCompare(right.filePath));
  const agents = details.agents
    .map((agent) => ({
      ...agent,
      name: agent.name.trim(),
      description: agent.description.trim(),
    }))
    .sort((left, right) => left.filePath.localeCompare(right.filePath));

  return {
    pluginName: claudeFacet.name || plugin.name,
    pluginPath: pluginPath || '',
    marketplaceId: plugin.marketplaceId,
    category: claudeFacet.category ?? plugin.category ?? '',
    manifest: null,
    rawManifest: {},
    // Built from the cached facet, not a directory walk: nothing to report.
    warnings: [],
    skills: skills.map((skill) => ({
      name: skill.name,
      dirName: skill.name,
      sourceDir: '',
      skillMdPath: '',
      description: skill.description,
      metadata: {
        name: skill.name,
        description: skill.description,
        ...(typeof skill.userInvocable === 'boolean'
          ? { 'user-invocable': skill.userInvocable }
          : {}),
      },
    })),
    commands: commands.map((command) => ({
      name: command.name,
      description: command.description,
      filePath: command.filePath,
    })),
    agents: agents.map((agent) => ({
      name: agent.name,
      description: agent.description,
      filePath: agent.filePath,
    })),
    sourceVersion: claudeFacet.version ?? plugin.version ?? '',
    sourceLastUpdatedAt: claudeFacet.cachedAt ?? '',
  };
}

function addClaudeLikePluginEntries(
  entries: InvocableInventoryEntry[],
  provider: 'claude' | 'ollama',
  plugin: PluginInfo,
): void {
  if (plugin.providerSupport.claude !== 'native') {
    return;
  }
  const facet = plugin.facets.claude;
  if (!facet?.details) {
    return;
  }

  for (const skill of facet.details.skills) {
    if (!pluginSkillInvocable(skill)) {
      continue;
    }
    const displayName = `/${plugin.name}:${skill.name}`;
    entries.push({
      id: entryId([
        provider,
        'plugin_skill',
        plugin.marketplaceId,
        plugin.name,
        skill.name,
      ]),
      provider,
      kind: 'plugin_skill',
      name: skill.name,
      displayName,
      description: skill.description,
      insertText: `${displayName} `,
      invocationKey: displayName,
      enableRef: {
        kind: 'plugin',
        marketplaceId: plugin.marketplaceId,
        pluginName: plugin.name,
      },
      sourceLabel: plugin.name,
    });
  }

  for (const command of facet.details.commands) {
    const displayName = `/${command.name}`;
    entries.push({
      id: entryId([
        provider,
        'plugin_command',
        plugin.marketplaceId,
        plugin.name,
        command.name,
      ]),
      provider,
      kind: 'plugin_command',
      name: command.name,
      displayName,
      description: command.description,
      insertText: `${displayName} `,
      invocationKey: displayName,
      enableRef: {
        kind: 'plugin',
        marketplaceId: plugin.marketplaceId,
        pluginName: plugin.name,
      },
      sourceLabel: plugin.name,
    });
  }
}

function addCodexPluginEntries(
  entries: InvocableInventoryEntry[],
  plugin: PluginInfo,
): void {
  if (plugin.providerSupport.codex === 'none') {
    return;
  }

  const nativeFacet = plugin.facets.codex;
  if (nativeFacet?.details) {
    const pluginName = facetPluginName(plugin, nativeFacet);
    for (const skill of nativeFacet.details.skills) {
      const displayName = `$${pluginName}:${skill.name}`;
      entries.push({
        id: entryId([
          'codex',
          'plugin_skill',
          plugin.marketplaceId,
          plugin.name,
          skill.name,
        ]),
        provider: 'codex',
        kind: 'plugin_skill',
        name: skill.name,
        displayName,
        description: skill.description,
        insertText: `${displayName} `,
        invocationKey: displayName,
        enableRef: {
          kind: 'plugin',
          marketplaceId: plugin.marketplaceId,
          pluginName: plugin.name,
        },
        sourceLabel: plugin.name,
      });
    }
    return;
  }

  if (plugin.codexCompatDisabled === true) {
    return;
  }

  const claudeFacet = plugin.facets.claude;
  if (!claudeFacet?.details) {
    return;
  }
  const source = compatibilitySourceFromFacet(plugin, claudeFacet);
  if (!source) {
    return;
  }
  const projectionPlan = buildProjectionPlan(source);
  const compatFacet = plugin.facets.codexCompatibility;
  const pluginName = facetPluginName(plugin, compatFacet ?? claudeFacet);
  const requiresCodexCompatPrepare = !compatFacet;

  for (const skill of claudeFacet.details.skills) {
    const displayName = `$${pluginName}:${skill.name}`;
    entries.push({
      id: entryId([
        'codex',
        'plugin_skill',
        plugin.marketplaceId,
        plugin.name,
        skill.name,
      ]),
      provider: 'codex',
      kind: 'plugin_skill',
      name: skill.name,
      displayName,
      description: skill.description,
      insertText: `${displayName} `,
      invocationKey: displayName,
      enableRef: {
        kind: 'plugin',
        marketplaceId: plugin.marketplaceId,
        pluginName: plugin.name,
      },
      ...(requiresCodexCompatPrepare ? { requiresCodexCompatPrepare } : {}),
      sourceLabel: plugin.name,
    });
  }

  for (const command of claudeFacet.details.commands) {
    const generatedName =
      projectionPlan.generatedCommandNames.get(command.name) ?? command.name;
    const displayName = `$${pluginName}:${generatedName}`;
    entries.push({
      id: entryId([
        'codex',
        'plugin_command',
        plugin.marketplaceId,
        plugin.name,
        command.name,
        generatedName,
      ]),
      provider: 'codex',
      kind: 'plugin_command',
      name: generatedName,
      sourceName: command.name,
      displayName,
      description: command.description,
      insertText: `${displayName} `,
      invocationKey: displayName,
      enableRef: {
        kind: 'plugin',
        marketplaceId: plugin.marketplaceId,
        pluginName: plugin.name,
      },
      ...(requiresCodexCompatPrepare ? { requiresCodexCompatPrepare } : {}),
      sourceLabel: plugin.name,
    });
  }
}

/**
 * The plugin facet a Cursor session loads members from: the Claude facet of a
 * Claude-native plugin (skills and commands), else the native Codex facet
 * (skills only), matching the resolver's `cursor-session` projection.
 */
function cursorMemberFacet(plugin: PluginInfo): {
  facet: PluginProviderFacet;
  commands: boolean;
} | null {
  if (plugin.providerSupport.claude === 'native' && plugin.facets.claude)
    return { facet: plugin.facets.claude, commands: true };
  if (plugin.providerSupport.codex === 'native' && plugin.facets.codex)
    return { facet: plugin.facets.codex, commands: false };
  return null;
}

interface CursorPluginSource {
  source: CursorInvocationSource;
  kind: 'plugin_skill' | 'plugin_command';
  name: string;
  description: string;
  /** A skill's directory as the chat root copies it; absent for a command. */
  sourceDir?: string;
  /**
   * False for a skill hidden from invocation (`user-invocable: false`). The
   * chat's root still holds it — the CLI loads it for the model — so it takes
   * part in id assignment but never becomes a row.
   */
  invocable: boolean;
}

/**
 * Every member of a plugin from its cached facet, in the order the resolver
 * assigns ids. The cache build lists rows from here; a selection is resolved
 * against the members on disk instead (`cursorPluginDiskSources`).
 */
function cursorPluginSources(plugin: PluginInfo): CursorPluginSource[] {
  const member = cursorMemberFacet(plugin);
  const details = member?.facet.details;
  if (!member || !details) return [];
  const sources: CursorPluginSource[] = [];
  for (const skill of details.skills) {
    sources.push({
      source: {
        kind: 'plugin_skill',
        marketplaceId: plugin.marketplaceId,
        pluginName: plugin.name,
        memberName: skill.name,
      },
      kind: 'plugin_skill',
      name: skill.name,
      description: skill.description,
      invocable: pluginSkillInvocable(skill),
    });
  }
  if (member.commands)
    for (const command of details.commands)
      sources.push({
        source: {
          kind: 'plugin_command',
          marketplaceId: plugin.marketplaceId,
          pluginName: plugin.name,
          memberName: command.name,
        },
        kind: 'plugin_command',
        name: command.name,
        description: command.description,
        invocable: true,
      });
  return sortCursorPluginMembers(sources);
}

/**
 * The plugin's members as the resolver will read them for the chat root:
 * from the installed tree, not the facet cache, so a member added or removed
 * since the cache was built takes part in id assignment exactly as it will
 * on the next turn. Null when the plugin has no installed root to read.
 */
function cursorPluginDiskSources(
  plugin: PluginInfo,
): CursorPluginSource[] | null {
  const member = cursorMemberFacet(plugin);
  if (!member) return null;
  const root = facetRoot(member.facet);
  if (!root) return null;
  return cursorPluginSourcesAt(
    root,
    member.facet.provider,
    plugin.marketplaceId,
    plugin.name,
  );
}

/** The members under one plugin root, as the resolver reads them for the chat root. */
function cursorPluginSourcesAt(
  root: string,
  provider: Parameters<typeof discoverCursorPluginMembers>[1],
  marketplaceId: string,
  pluginName: string,
): CursorPluginSource[] {
  return discoverCursorPluginMembers(root, provider).map((item) => ({
    source: {
      kind: item.kind,
      marketplaceId,
      pluginName,
      memberName: item.name,
    },
    kind: item.kind,
    name: item.name,
    description:
      item.kind === 'plugin_skill'
        ? item.skill.description
        : item.command.description,
    invocable:
      item.kind !== 'plugin_skill' ||
      item.skill.metadata['user-invocable'] !== false,
    ...(item.kind === 'plugin_skill'
      ? { sourceDir: item.skill.sourceDir }
      : {}),
  }));
}

function addCursorPluginEntries(
  entries: InvocableInventoryEntry[],
  plugin: PluginInfo,
): void {
  const sources = cursorPluginSources(plugin);
  // Provisional ids: collisions with other selections are resolved per tab
  // by `resolveInvocableSelection`, which sees the whole effective set.
  const ids = assignCursorInvocationIds(sources.map((item) => item.source));
  for (const item of sources) {
    if (!item.invocable) continue;
    const id = ids.get(cursorInvocationKey(item.source));
    if (!id) continue;
    const invocationKey = `/${id}`;
    entries.push({
      id: entryId([
        'cursor',
        item.kind,
        plugin.marketplaceId,
        plugin.name,
        item.name,
      ]),
      provider: 'cursor',
      kind: item.kind,
      name: item.name,
      displayName: invocationKey,
      description: item.description,
      insertText: `${invocationKey} `,
      invocationKey,
      enableRef: {
        kind: 'plugin',
        marketplaceId: plugin.marketplaceId,
        pluginName: plugin.name,
      },
      sourceLabel: plugin.name,
    });
  }
}

/** A failed home scan contributes no rows; the chat reports the problem. */
async function discoverInheritedForInventory(): Promise<InheritedCursorCapabilities> {
  try {
    return await discoverInheritedCursorCapabilities(
      resolveInheritedCursorRoots(),
    );
  } catch {
    return emptyInheritedCursorCapabilities();
  }
}

/**
 * The inherited entries as the chat root takes them, in its order. A skill
 * whose canonical directory is already a selected skill's (`excludeDirs`)
 * adds nothing to the root, so it takes no id here either.
 */
function inheritedSources(
  inherited: InheritedCursorCapabilities,
  excludeDirs?: { has(dir: string): boolean },
): CursorInvocationSource[] {
  return [
    ...inherited.skills
      .filter((skill) => !excludeDirs?.has(skill.sourceDir))
      .map((skill) => inheritedSkillSource(skill)),
    ...inherited.commands.map((command) => inheritedCommandSource(command)),
  ];
}

/** A cached Cursor plugin member carries its plugin; it is part of the identity. */
function inheritedSkillSource(skill: {
  origin: InheritedCursorCapabilities['skills'][number]['origin'];
  plugin?: string;
  name: string;
}): Extract<CursorInvocationSource, { kind: 'inherited_skill' }> {
  return skill.plugin === undefined
    ? { kind: 'inherited_skill', origin: skill.origin, name: skill.name }
    : {
        kind: 'inherited_skill',
        origin: skill.origin,
        name: skill.name,
        plugin: skill.plugin,
      };
}

function inheritedCommandSource(command: {
  origin: InheritedCursorCapabilities['commands'][number]['origin'];
  plugin?: string;
  name: string;
}): Extract<CursorInvocationSource, { kind: 'inherited_command' }> {
  return command.plugin === undefined
    ? { kind: 'inherited_command', origin: command.origin, name: command.name }
    : {
        kind: 'inherited_command',
        origin: command.origin,
        name: command.name,
        plugin: command.plugin,
      };
}

/**
 * Rows for the user's own home-folder skills and commands: always on for a
 * Cursor chat, nothing to enable. Ids are provisional, over the inherited set
 * alone; the chat root assigns final ids after its selections, so a clash
 * there puts the suffix on the inherited entry.
 */
function addInheritedCursorEntries(
  entries: InvocableInventoryEntry[],
  inherited: InheritedCursorCapabilities,
): void {
  const ids = assignCursorInvocationIds(inheritedSources(inherited));
  for (const skill of inherited.skills) {
    if (!skill.userInvocable) continue;
    const source = inheritedSkillSource(skill);
    const id = ids.get(cursorInvocationKey(source));
    if (!id) continue;
    const invocationKey = `/${id}`;
    entries.push({
      id: entryId([
        'cursor',
        'inherited_skill',
        skill.origin,
        ...(skill.plugin === undefined ? [] : [skill.plugin]),
        skill.name,
      ]),
      provider: 'cursor',
      kind: 'inherited_skill',
      name: skill.name,
      displayName: invocationKey,
      description: skill.description,
      insertText: `${invocationKey} `,
      invocationKey,
      enableRef: { kind: 'none' },
      sourceLabel: inheritedCursorRootLabel(source),
    });
  }
  for (const command of inherited.commands) {
    const source = inheritedCommandSource(command);
    const id = ids.get(cursorInvocationKey(source));
    if (!id) continue;
    const invocationKey = `/${id}`;
    entries.push({
      id: entryId([
        'cursor',
        'inherited_command',
        command.origin,
        ...(command.plugin === undefined ? [] : [command.plugin]),
        command.name,
      ]),
      provider: 'cursor',
      kind: 'inherited_command',
      name: command.name,
      displayName: invocationKey,
      description: command.description,
      insertText: `${invocationKey} `,
      invocationKey,
      enableRef: { kind: 'none' },
      sourceLabel: inheritedCursorRootLabel(source),
    });
  }
}

async function buildInventoryCache(): Promise<InvocableInventoryCache> {
  const entries: InvocableInventoryEntry[] = [];
  const skillsResult = loadSkills();
  if (skillsResult.success && skillsResult.data) {
    const codexGeneratedSkillNames = codexAggregateSkillInvocationNamesForRefs(
      skillsResult.data.map((skill) => ({
        sourceId: skill.sourceId,
        skillName: skill.name,
      })),
    );

    for (const skill of skillsResult.data) {
      if (isSkillUserInvocable(skill.sourceId, skill.name)) {
        for (const provider of ['claude', 'ollama'] as const) {
          const displayName = `/${skill.name}`;
          entries.push({
            id: entryId([provider, 'skill', skill.sourceId, skill.name]),
            provider,
            kind: 'skill',
            name: skill.name,
            displayName,
            description: skill.description,
            insertText: `${displayName} `,
            invocationKey: displayName,
            enableRef: {
              kind: 'skill',
              sourceId: skill.sourceId,
              skillName: skill.name,
            },
            sourceLabel: skill.source,
          });
        }
        const cursorSource: CursorInvocationSource = {
          kind: 'skill',
          sourceId: skill.sourceId,
          skillName: skill.name,
        };
        const cursorId = assignCursorInvocationIds([cursorSource]).get(
          cursorInvocationKey(cursorSource),
        );
        if (cursorId) {
          const invocationKey = `/${cursorId}`;
          entries.push({
            id: entryId(['cursor', 'skill', skill.sourceId, skill.name]),
            provider: 'cursor',
            kind: 'skill',
            name: skill.name,
            displayName: invocationKey,
            description: skill.description,
            insertText: `${invocationKey} `,
            invocationKey,
            enableRef: {
              kind: 'skill',
              sourceId: skill.sourceId,
              skillName: skill.name,
            },
            sourceLabel: skill.source,
          });
        }
      }

      const generatedName = codexGeneratedSkillNames.get(
        `${skill.sourceId}/${skill.name}`,
      );
      if (!generatedName) {
        continue;
      }
      const displayName = `$${BUILTIN_APP_PLUGIN_NAME}:${generatedName}`;
      entries.push({
        id: entryId(['codex', 'skill', skill.sourceId, skill.name]),
        provider: 'codex',
        kind: 'skill',
        name: skill.name,
        displayName,
        description: skill.description,
        insertText: `${displayName} `,
        invocationKey: displayName,
        enableRef: {
          kind: 'skill',
          sourceId: skill.sourceId,
          skillName: skill.name,
        },
        sourceLabel: skill.source,
      });
    }
  }

  // Inventory rebuilds run after local skill/plugin mutations and must not
  // turn that UI path into provider discovery. The deferred startup refresh
  // and plugin mutation handlers rebuild us again after updating this cache.
  const pluginsResult = await loadMarketplacesCacheOnly();
  if (pluginsResult.success && pluginsResult.data) {
    for (const marketplace of pluginsResult.data.marketplaces) {
      for (const plugin of marketplace.plugins) {
        addClaudeLikePluginEntries(entries, 'claude', plugin);
        addClaudeLikePluginEntries(entries, 'ollama', plugin);
        addCodexPluginEntries(entries, plugin);
        addCursorPluginEntries(entries, plugin);
      }
    }
  }

  const inherited = await discoverInheritedForInventory();
  addInheritedCursorEntries(entries, inherited);

  // Copilot and OpenCode run the same projection a Cursor session does,
  // inherited home-folder rows included, so each mirrors every Cursor row.
  // Inherited (`none`) rows are for chats: OpenCode delegates and pipeline
  // steps load the selection alone, so their pickers must not list them.
  const cursorEntries = entries.filter((entry) => entry.provider === 'cursor');
  for (const provider of ['copilot', 'opencode'] as const) {
    entries.push(
      ...cursorEntries.map((entry) => ({
        ...entry,
        id: entryId([provider, entry.id]),
        provider,
      })),
    );
  }
  entries.push(
    ...cursorEntries
      .filter((entry) => entry.enableRef.kind !== 'none')
      .map((entry) => ({
        ...entry,
        id: entryId(['antigravity', entry.id]),
        provider: 'antigravity' as const,
      })),
  );

  return {
    version: CACHE_VERSION,
    builtAt: new Date().toISOString(),
    entries,
    inheritedFingerprint: inherited.fingerprint,
  };
}

async function writeCacheAtomically(
  cache: InvocableInventoryCache,
): Promise<void> {
  const writeTask = writeQueue
    .catch(() => undefined)
    .then(async () => {
      const filePath = cachePath();
      await mkdir(path.dirname(filePath), { recursive: true });
      const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(tempPath, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
      await rename(tempPath, filePath);
    });
  writeQueue = writeTask.catch(() => undefined);
  await writeTask;
}

async function readCacheFromDisk(): Promise<InvocableInventoryCache | null> {
  try {
    const raw = await readFile(cachePath(), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (
      !isRecord(parsed) ||
      parsed.version !== CACHE_VERSION ||
      !Array.isArray(parsed.entries) ||
      typeof parsed.builtAt !== 'string'
    ) {
      return null;
    }
    const entries = parsed.entries.flatMap((item) => {
      const entry = normalizeCacheEntry(item);
      return entry ? [entry] : [];
    });
    return {
      version: CACHE_VERSION,
      builtAt: parsed.builtAt,
      entries,
      ...(typeof parsed.inheritedFingerprint === 'string'
        ? { inheritedFingerprint: parsed.inheritedFingerprint }
        : {}),
    };
  } catch {
    return null;
  }
}

export async function loadCachedInventory(): Promise<InvocableInventoryCache | null> {
  if (cachedInventory !== undefined) {
    return cachedInventory;
  }
  cachedInventory = await readCacheFromDisk();
  if (cachedInventory === null) {
    markCacheStale();
  }
  return cachedInventory;
}

async function responseForCache(
  providerType: InvocableInventoryProvider | null,
  cache: InvocableInventoryCache | null,
  rebuilding: boolean,
): Promise<ListInvocableInventoryResponse> {
  let entries = cache?.entries ?? [];
  const policy = await readInstalledItemPolicy();
  entries = entries.filter(
    (entry) =>
      entry.enableRef.kind === 'none' || !policy.isDisabled(entry.enableRef),
  );
  if (skillResourceContextEnabled()) {
    const snapshot = await skillContextSnapshot();
    const allowed = await Promise.all(
      entries.map(async (entry): Promise<boolean> => {
        if (entry.enableRef.kind !== 'skill') return true;
        try {
          await assertStoredSkillContext(
            `${entry.enableRef.sourceId}/${entry.enableRef.skillName}`,
          );
          return true;
        } catch {
          return false;
        }
      }),
    );
    await assertSkillContextSnapshot(snapshot);
    entries = entries.filter((_entry, index) => allowed[index]);
  }
  return {
    entries:
      entries.filter((entry) =>
        providerType ? providerMatches(entry, providerType) : true,
      ) ?? [],
    stale: cacheMarkedStale || cache === null,
    rebuilding,
    ...(cache?.builtAt ? { builtAt: cache.builtAt } : {}),
  };
}

function deferBackgroundWork(callback: () => void): void {
  if (typeof setImmediate === 'function') {
    setImmediate(callback);
    return;
  }
  setTimeout(callback, 0);
}

function startBackgroundRebuild(
  reason: string,
): Promise<InvocableInventoryCache> {
  if (!rebuildPromise) {
    const startedStaleGeneration = staleGeneration;
    rebuildPromise = new Promise<InvocableInventoryCache>((resolve, reject) => {
      deferBackgroundWork(() => {
        void (async (): Promise<InvocableInventoryCache> => {
          try {
            const nextCache = await buildInventoryCache();
            await writeCacheAtomically(nextCache);
            cachedInventory = nextCache;
            const staleDuringRebuild =
              staleGeneration !== startedStaleGeneration;
            cacheMarkedStale = staleDuringRebuild;
            notifyInvocableInventoryChanged();
            if (staleDuringRebuild) {
              deferBackgroundWork(() => {
                void startBackgroundRebuild(`${reason}:follow-up`).catch(() => {
                  // startBackgroundRebuild already logs and preserves stale state.
                });
              });
            }
            return nextCache;
          } catch (error) {
            markCacheStale();
            // eslint-disable-next-line no-console
            console.warn(
              `[invocable-inventory] Failed to rebuild inventory (${reason}):`,
              error,
            );
            if (cachedInventory) {
              return cachedInventory;
            }
            throw error;
          } finally {
            rebuildPromise = null;
          }
        })().then(resolve, reject);
      });
    });
  }
  return rebuildPromise;
}

/**
 * The inherited Cursor rows come from folders Canopy never writes: the Cursor
 * app installing a plugin, or the user adding a skill to a home folder, is no
 * Canopy mutation and marks nothing stale. A served Cursor list therefore
 * re-checks the inherited fingerprint off the critical path and rebuilds when
 * it moved, so the `/` menu catches up without waiting for a Cursor turn. The
 * list itself is answered from the cache first. A failed check changes nothing.
 */
function recheckInheritedCursorCapabilities(
  cache: InvocableInventoryCache,
): void {
  const now = Date.now();
  if (now - lastInheritedRecheckAt < INHERITED_RECHECK_INTERVAL_MS) return;
  lastInheritedRecheckAt = now;
  deferBackgroundWork(() => {
    void (async (): Promise<void> => {
      try {
        const inherited = await discoverInheritedForInventory();
        // A rebuild that finished meanwhile recorded its own fingerprint.
        if (cachedInventory !== cache) return;
        if (inherited.fingerprint === cache.inheritedFingerprint) return;
        refreshInvocableInventoryAfterMutation(
          'cursor-inherited-capabilities:list',
        );
      } catch {
        // Observational only; the next list re-checks.
      }
    })();
  });
}

export async function listInvocableInventory(
  request: ListInvocableInventoryRequest,
): Promise<IPCResult<ListInvocableInventoryResponse>> {
  const cache = await loadCachedInventory();
  if (!cache || cacheMarkedStale) {
    void startBackgroundRebuild('list').catch(() => {
      // startBackgroundRebuild already logs and preserves stale/null cache state.
    });
  } else if (
    request.providerType === 'cursor' ||
    request.providerType === 'copilot' ||
    request.providerType === 'opencode' ||
    request.providerType === null
  ) {
    recheckInheritedCursorCapabilities(cache);
  }
  return success(
    await responseForCache(request.providerType, cache, !!rebuildPromise),
  );
}

export async function refreshInvocableInventory(
  reason = 'manual',
): Promise<IPCResult<ListInvocableInventoryResponse>> {
  try {
    markCacheStale();
    const cache = await startBackgroundRebuild(reason);
    return success(await responseForCache(null, cache, false));
  } catch {
    const cache = await loadCachedInventory();
    return success(await responseForCache(null, cache, false));
  }
}

function facetRoot(facet: PluginProviderFacet): string | null {
  // Facet discovery has already resolved installLocation to the plugin root.
  // sourcePath retains the marketplace-relative declaration for provenance, so
  // appending it here would duplicate paths such as
  // `claude-plugins/example/claude-plugins/example`.
  const installedRoot = facet.cachePath || facet.installLocation;
  if (installedRoot) return path.resolve(installedRoot);
  return facet.sourcePath && path.isAbsolute(facet.sourcePath)
    ? path.resolve(facet.sourcePath)
    : null;
}

function memberPathForEntry(
  entry: InvocableInventoryEntry,
  facet: PluginProviderFacet,
): string | null {
  const details = facet.details;
  if (!details) return null;
  if (entry.kind === 'plugin_skill') {
    const skill = details.skills.find((item) => item.name === entry.name);
    return skill?.path ?? null;
  }
  const sourceName = entry.sourceName ?? entry.name;
  return (
    details.commands.find((item) => item.name === sourceName)?.filePath ?? null
  );
}

/**
 * Resolve the cached invocation inventory to authoritative local source roots.
 * These paths stay in Electron main and are never serialized to the renderer.
 */
export async function loadPipelinePackageInventorySources(): Promise<{
  inventory: InvocableInventoryCache;
  sources: Record<string, PipelinePackageSourceDescriptor>;
}> {
  let inventory = await loadCachedInventory();
  if (!inventory || cacheMarkedStale) {
    inventory = await startBackgroundRebuild('pipeline-package-analysis');
  }
  if (skillResourceContextEnabled()) {
    const scoped = await responseForCache(null, inventory, false);
    inventory = { ...inventory, entries: scoped.entries };
  }
  const sources: Record<string, PipelinePackageSourceDescriptor> = {};
  const marketplacesResult = await loadMarketplacesCacheOnly();
  const marketplaces = marketplacesResult.success
    ? (marketplacesResult.data?.marketplaces ?? [])
    : [];

  for (const entry of inventory.entries) {
    if (entry.enableRef.kind === 'skill') {
      const builtin = isBuiltinSourceId(entry.enableRef.sourceId);
      sources[entry.id] = {
        sourceRoot: getSkillDir(
          entry.enableRef.sourceId,
          entry.enableRef.skillName,
        ),
        memberPath: '.',
        sourceVisibility: builtin ? 'builtin' : 'local',
        runtimeKind: 'standalone_skill',
        rootName: entry.enableRef.skillName,
      };
      continue;
    }
    // An inherited home-folder row has no package source; it never travels.
    if (entry.enableRef.kind === 'none') continue;

    const pluginRef = entry.enableRef;
    const marketplace = marketplaces.find(
      (item) => item.id === pluginRef.marketplaceId,
    );
    const plugin = marketplace?.plugins.find(
      (item) => item.name.toLowerCase() === pluginRef.pluginName.toLowerCase(),
    );
    if (!marketplace || !plugin) continue;
    const facet =
      entry.provider === 'codex'
        ? (plugin.facets.codex ?? plugin.facets.codexCompatibility)
        : plugin.facets.claude;
    if (!facet) continue;
    const sourceRoot = facetRoot(facet);
    const memberPath = memberPathForEntry(entry, facet);
    if (!sourceRoot || !memberPath) continue;
    sources[entry.id] = {
      sourceRoot,
      memberPath: path.isAbsolute(memberPath)
        ? path.relative(sourceRoot, memberPath)
        : memberPath,
      sourceVisibility: plugin.builtIn
        ? 'builtin'
        : plugin.curated
          ? 'public'
          : 'private',
      runtimeKind: 'plugin_fragment',
      rootName: facet.name || plugin.name,
    };
  }
  return { inventory, sources };
}

export function markInvocableInventoryStale(reason = 'mutation'): void {
  markCacheStale();
  void reason;
}

export function refreshInvocableInventoryAfterMutation(reason: string): void {
  markInvocableInventoryStale(reason);
  void startBackgroundRebuild(reason).catch(() => {
    // startBackgroundRebuild already logs and preserves the last good cache.
  });
}

const inventoryChangeListeners = new Set<() => void>();

/**
 * Main-process counterpart of the renderer `invocable-inventory:changed`
 * push: fires after every completed rebuild so services that mirror the
 * inventory elsewhere (the cloud inventory sync, CAN-2830) can react without
 * a BrowserWindow. Listener failures never affect the rebuild.
 */
export function subscribeInvocableInventoryChanges(
  listener: () => void,
): () => void {
  inventoryChangeListeners.add(listener);
  return (): void => {
    inventoryChangeListeners.delete(listener);
  };
}

export function notifyInvocableInventoryChanged(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      sendToWebContents(
        window.webContents,
        INVOCABLE_INVENTORY_CHANNELS.CHANGED,
      );
    }
  }
  inventoryChangeListeners.forEach((listener): void => {
    try {
      listener();
    } catch {
      // Observational only; see subscribeInvocableInventoryChanges.
    }
  });
}

export function resetInvocableInventoryServiceForTests(): void {
  if (process.env.NODE_ENV !== 'test') {
    return;
  }
  cachedInventory = undefined;
  cacheMarkedStale = false;
  staleGeneration = 0;
  rebuildPromise = null;
  writeQueue = Promise.resolve();
  lastInheritedRecheckAt = 0;
}

function withSelectionRef(
  selections: ChatTabPluginSelections,
  entry: InvocableInventoryEntry,
): ChatTabPluginSelections {
  if (entry.enableRef.kind === 'none') return selections;
  if (entry.enableRef.kind === 'skill') {
    const skillRef = entry.enableRef;
    const exists = selections.skillRefs.some(
      (ref) =>
        ref.sourceId === skillRef.sourceId &&
        ref.skillName === skillRef.skillName,
    );
    return exists
      ? selections
      : {
          ...selections,
          skillRefs: [...selections.skillRefs, skillRef],
        };
  }

  const pluginRef = entry.enableRef;
  const exists = selections.pluginRefs.some(
    (ref) =>
      ref.marketplaceId === pluginRef.marketplaceId &&
      ref.pluginName === pluginRef.pluginName,
  );
  return exists
    ? selections
    : {
        ...selections,
        pluginRefs: [...selections.pluginRefs, pluginRef],
      };
}

async function resolveStandaloneSkill(
  request: ResolveInvocableSelectionRequest,
): Promise<IPCResult<ResolveInvocableSelectionResponse>> {
  const ref = request.entry.enableRef;
  if (ref.kind !== 'skill') {
    return failure('Inventory row is not a standalone skill.');
  }
  await assertStoredSkillContext(`${ref.sourceId}/${ref.skillName}`);
  if (!skillPathExists(ref.sourceId, ref.skillName)) {
    return failure('Selected skill is no longer installed.');
  }
  if (
    request.providerType !== 'codex' &&
    !isSkillUserInvocable(ref.sourceId, ref.skillName)
  ) {
    return failure('Selected skill is not user invocable.');
  }

  if (request.providerType !== 'codex') {
    const invocationKey = `/${ref.skillName}`;
    return success({ insertText: `${invocationKey} `, invocationKey });
  }

  const selections = withSelectionRef(request.selections, request.entry);
  const warnings: string[] = [];
  const effective = await resolveEffectivePluginSelectionRefs(
    selections,
    warnings,
  );
  const generatedNames = codexAggregateSkillInvocationNamesForRefs(
    effective.skillRefs,
    warnings,
  );
  const generatedName = generatedNames.get(`${ref.sourceId}/${ref.skillName}`);
  if (!generatedName) {
    return failure('Selected skill could not be resolved for Codex.');
  }
  const invocationKey = `$${BUILTIN_APP_PLUGIN_NAME}:${generatedName}`;
  return success({ insertText: `${invocationKey} `, invocationKey });
}

async function livePluginForEntry(
  entry: InvocableInventoryEntry,
): Promise<PluginInfo | null> {
  if (entry.enableRef.kind !== 'plugin') {
    return null;
  }
  const cache = await loadMarketplaces();
  if (!cache.success || !cache.data) {
    return null;
  }
  return marketplacePlugin(
    cache.data.marketplaces,
    entry.enableRef.marketplaceId,
    entry.enableRef.pluginName,
  );
}

function resolveClaudeLikePluginSelection(
  providerType: InvocableInventoryProvider,
  entry: InvocableInventoryEntry,
  plugin: PluginInfo,
): IPCResult<ResolveInvocableSelectionResponse> {
  if (providerType !== 'claude' && providerType !== 'ollama') {
    return failure('Provider is not Claude-compatible.');
  }
  if (plugin.providerSupport.claude !== 'native') {
    return failure('Plugin is no longer available for this provider.');
  }

  if (entry.kind === 'plugin_skill') {
    const skill = findSkill(plugin.facets.claude, entry.name);
    if (!skill || !pluginSkillInvocable(skill)) {
      return failure('Selected plugin skill is no longer available.');
    }
    const invocationKey = `/${plugin.name}:${entry.name}`;
    return success({ insertText: `${invocationKey} `, invocationKey });
  }

  const command = findCommand(plugin.facets.claude, entry.name);
  if (!command) {
    return failure('Selected plugin command is no longer available.');
  }
  const invocationKey = `/${entry.name}`;
  return success({ insertText: `${invocationKey} `, invocationKey });
}

function resolveCodexPluginSkill(
  entry: InvocableInventoryEntry,
  plugin: PluginInfo,
): IPCResult<ResolveInvocableSelectionResponse> {
  if (plugin.providerSupport.codex === 'none') {
    return failure('Plugin is no longer available for Codex.');
  }

  const nativeSkill = findSkill(plugin.facets.codex, entry.name);
  if (nativeSkill) {
    const pluginName = facetPluginName(plugin, plugin.facets.codex);
    const invocationKey = `$${pluginName}:${entry.name}`;
    return success({ insertText: `${invocationKey} `, invocationKey });
  }

  if (plugin.codexCompatDisabled === true) {
    return failure('Plugin is no longer available for Codex.');
  }

  const compatSkill = findSkill(plugin.facets.codexCompatibility, entry.name);
  const claudeSkill = findSkill(plugin.facets.claude, entry.name);
  if (compatSkill && claudeSkill) {
    const pluginName = facetPluginName(
      plugin,
      plugin.facets.codexCompatibility,
    );
    const invocationKey = `$${pluginName}:${entry.name}`;
    return success({ insertText: `${invocationKey} `, invocationKey });
  }

  return failure('Selected plugin skill is no longer available.');
}

function resolveCodexPluginCommand(
  entry: InvocableInventoryEntry,
  plugin: PluginInfo,
): IPCResult<ResolveInvocableSelectionResponse> {
  if (
    plugin.providerSupport.codex === 'none' ||
    plugin.codexCompatDisabled === true
  ) {
    return failure('Plugin is no longer available for Codex.');
  }

  const claudeFacet = plugin.facets.claude;
  const compatFacet = plugin.facets.codexCompatibility;
  if (!claudeFacet || !compatFacet?.details || !entry.sourceName) {
    return failure('Selected plugin command is not prepared for Codex.');
  }

  const command = findCommand(claudeFacet, entry.sourceName);
  if (!command) {
    return failure('Selected plugin command is no longer available.');
  }

  const source = compatibilitySourceFromFacet(plugin, claudeFacet);
  if (!source) {
    return failure('Selected plugin command source could not be read.');
  }
  const generatedName = buildProjectionPlan(source).generatedCommandNames.get(
    entry.sourceName,
  );
  if (!generatedName || !findSkill(compatFacet, generatedName)) {
    return failure('Selected plugin command is not available in Codex.');
  }

  const pluginName = facetPluginName(plugin, compatFacet);
  const invocationKey = `$${pluginName}:${generatedName}`;
  return success({ insertText: `${invocationKey} `, invocationKey });
}

/**
 * Cursor ids are assigned over the WHOLE effective selection (standalone
 * skills first, then each plugin's members), exactly as the resolver assigns
 * them for the chat's private root, so the inserted token is the id the CLI
 * will actually know once the selection includes this row.
 */
/**
 * The inherited entry a `none` row stands for: same kind and name, from the
 * folder the row's label names. Two plugins may ship a skill of one name,
 * so the label (which carries the plugin) is part of the match. A skill
 * carries its canonical directory, so the caller can tell when it is a
 * selected skill's directory.
 */
function inheritedEntryForRow(
  inherited: InheritedCursorCapabilities,
  entry: InvocableInventoryEntry,
): { source: CursorInvocationSource; sourceDir?: string } | null {
  if (entry.kind === 'inherited_skill') {
    for (const skill of inherited.skills) {
      if (!skill.userInvocable || skill.name !== entry.name) continue;
      const source = inheritedSkillSource(skill);
      if (inheritedCursorRootLabel(source) === entry.sourceLabel)
        return { source, sourceDir: skill.sourceDir };
    }
    return null;
  }
  if (entry.kind === 'inherited_command') {
    for (const command of inherited.commands) {
      if (command.name !== entry.name) continue;
      const source = inheritedCommandSource(command);
      if (inheritedCursorRootLabel(source) === entry.sourceLabel)
        return { source };
    }
  }
  return null;
}

async function resolveCursorSelection(
  request: ResolveInvocableSelectionRequest,
): Promise<IPCResult<ResolveInvocableSelectionResponse>> {
  const { entry } = request;
  // One discovery serves both an inherited row's own source and the ids the
  // whole inherited set takes below.
  const inherited =
    request.providerType === 'antigravity'
      ? emptyInheritedCursorCapabilities()
      : await discoverInheritedForInventory();
  let own: CursorInvocationSource;
  let ownInheritedDir: string | undefined;
  if (entry.enableRef.kind === 'skill') {
    const ref = entry.enableRef;
    if (!skillPathExists(ref.sourceId, ref.skillName)) {
      return failure('Selected skill is no longer installed.');
    }
    if (!isSkillUserInvocable(ref.sourceId, ref.skillName)) {
      return failure('Selected skill is not user invocable.');
    }
    own = { kind: 'skill', sourceId: ref.sourceId, skillName: ref.skillName };
  } else if (entry.enableRef.kind === 'plugin') {
    const plugin = await livePluginForEntry(entry);
    const installed = plugin ? cursorPluginDiskSources(plugin) : null;
    if (!installed) {
      return failure('Selected plugin is no longer installed.');
    }
    const member = installed.find(
      (item) =>
        item.invocable && item.kind === entry.kind && item.name === entry.name,
    );
    if (!member) {
      return failure(
        entry.kind === 'plugin_skill'
          ? 'Selected plugin skill is no longer available.'
          : 'Selected plugin command is no longer available.',
      );
    }
    own = member.source;
  } else {
    // An inherited row's cached id was assigned over the inherited set alone;
    // the chat root assigns it after the selection, so compute it over the
    // same list the root uses. Nothing is enabled.
    const match = inheritedEntryForRow(inherited, entry);
    if (!match) return failure('Inherited entry is no longer available.');
    own = match.source;
    ownInheritedDir = match.sourceDir;
  }

  const selections = withSelectionRef(request.selections, entry);
  const warnings: string[] = [];
  const effective = await resolveEffectivePluginSelectionRefs(
    selections,
    warnings,
  );
  // Only skills the resolver will copy take part — one whose SKILL.md is
  // gone or that resolves outside the skills root is skipped there, so it
  // must not push another onto a suffix here. Their canonical directories
  // are kept: an inherited skill that IS one of them adds nothing to the
  // chat root, exactly as `buildCursorCapabilityProjection` drops it.
  const sources: CursorInvocationSource[] = [];
  const selectedSkillDirs = new Map<string, CursorInvocationSource>();
  for (const ref of effective.skillRefs) {
    const dir = cursorSkillSourceDir(ref);
    if (dir === null) continue;
    const source: CursorInvocationSource = {
      kind: 'skill',
      sourceId: ref.sourceId,
      skillName: ref.skillName,
    };
    sources.push(source);
    selectedSkillDirs.set(dir, source);
  }
  const cache = await loadMarketplaces();
  const marketplaces =
    cache.success && cache.data ? cache.data.marketplaces : [];
  const addPluginSources = (items: readonly CursorPluginSource[]): void => {
    for (const item of items) {
      sources.push(item.source);
      if (item.sourceDir !== undefined)
        selectedSkillDirs.set(item.sourceDir, item.source);
    }
  };
  for (const ref of effective.pluginRefs) {
    const plugin = marketplacePlugin(
      marketplaces,
      ref.marketplaceId,
      ref.pluginName,
    );
    if (!plugin) continue;
    // A plugin with no readable root contributes nothing to the chat root
    // either, so it takes no ids here.
    addPluginSources(cursorPluginDiskSources(plugin) ?? []);
  }
  // Inherited Claude plugins and home-folder entries occupy ids in the chat
  // root too, in this order, so the row's id is computed over the same list,
  // minus the plugins this chat turned off, exactly as the session subtracts
  // them. Their members are read from the folder Claude Code installed, the
  // folder the session reads; one that is gone contributes nothing there.
  const policy = await readInstalledItemPolicy();
  for (const ref of request.providerType === 'antigravity'
    ? []
    : inheritedClaudePluginRefs(
        marketplaces,
        effective,
        request.chatTombstones,
        readClaudeEnabledPlugins(
          resolveInheritedCursorRoots().claudeConfigDir,
          request.projectPath,
        ),
        policy.disabledPluginRefs,
      )) {
    if (!isPluginInstallRoot(ref.installPath)) continue;
    addPluginSources(
      cursorPluginSourcesAt(
        ref.installPath,
        'claude',
        ref.marketplaceId,
        ref.pluginName,
      ),
    );
  }
  // An inherited skill that is a selected skill's directory stands for the
  // retained skill: the root holds one copy, under the selection's id.
  if (ownInheritedDir !== undefined) {
    const retained = selectedSkillDirs.get(ownInheritedDir);
    if (retained) own = retained;
  }
  sources.push(...inheritedSources(inherited, selectedSkillDirs));
  const id = assignCursorInvocationIds(sources).get(cursorInvocationKey(own));
  if (!id) {
    return failure('Selected row could not be resolved for this provider.');
  }
  const invocationKey = `/${id}`;
  return success({ insertText: `${invocationKey} `, invocationKey });
}

export async function resolveInvocableSelection(
  request: ResolveInvocableSelectionRequest,
): Promise<IPCResult<ResolveInvocableSelectionResponse>> {
  const policy = await readInstalledItemPolicy();
  if (
    request.entry.enableRef.kind !== 'none' &&
    policy.isDisabled(request.entry.enableRef)
  )
    return failure('Selected item is Disabled.');
  const { entry, providerType } = request;
  if (entry.provider !== providerType) {
    return failure('Inventory row provider does not match this session.');
  }

  // Inherited rows exist for the chats that read the user's home folders:
  // Cursor, and Copilot and OpenCode through the same projection.
  if (
    providerType === 'cursor' ||
    providerType === 'copilot' ||
    providerType === 'opencode' ||
    providerType === 'antigravity'
  ) {
    return resolveCursorSelection(request);
  }

  if (entry.enableRef.kind === 'none') {
    return failure(
      'Inherited rows belong to Cursor, Copilot and OpenCode chats.',
    );
  }

  if (entry.kind === 'skill') {
    return resolveStandaloneSkill(request);
  }

  const plugin = await livePluginForEntry(entry);
  if (!plugin) {
    return failure('Selected plugin is no longer installed.');
  }

  if (providerType === 'claude' || providerType === 'ollama') {
    return resolveClaudeLikePluginSelection(providerType, entry, plugin);
  }

  if (entry.kind === 'plugin_skill') {
    return resolveCodexPluginSkill(entry, plugin);
  }
  return resolveCodexPluginCommand(entry, plugin);
}
