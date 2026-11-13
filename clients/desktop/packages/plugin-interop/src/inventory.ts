import {
  basenamePluginPath,
  comparePluginPaths,
  directChildDirectories,
  directMarkdownFiles,
  isRecord,
  joinPluginPath,
  normalizePluginFiles,
  readJsonRecord,
  readString,
  readStringArray,
  readTextFile,
  resolvePluginPath,
} from './file-map';
import { parseFrontmatter } from './frontmatter';
import type {
  BuildPluginMemberInventoryInput,
  ClaudePluginManifest,
  PluginHookMember,
  PluginLspServerMember,
  PluginMarkdownMember,
  PluginMcpServerMember,
  PluginMemberInventory,
  PluginModMember,
  PluginSkillMember,
} from './types';

function isInventoryRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasStringFields(
  value: unknown,
  fields: readonly string[],
): value is Record<string, unknown> {
  return (
    isInventoryRecord(value) &&
    fields.every((field) => typeof value[field] === 'string')
  );
}

function hasOptionalString(
  value: Record<string, unknown>,
  key: string,
): boolean {
  return value[key] === undefined || typeof value[key] === 'string';
}

function hasOptionalBoolean(
  value: Record<string, unknown>,
  key: string,
): boolean {
  return value[key] === undefined || typeof value[key] === 'boolean';
}

function hasOptionalStringArray(
  value: Record<string, unknown>,
  key: string,
): boolean {
  const candidate = value[key];
  return (
    candidate === undefined ||
    (Array.isArray(candidate) &&
      candidate.every((entry) => typeof entry === 'string'))
  );
}

/** Validates the JSON form persisted by web tree materialization. */
export function isPluginMemberInventory(
  value: unknown,
): value is PluginMemberInventory {
  if (!isInventoryRecord(value)) return false;
  return (
    Array.isArray(value.skills) &&
    value.skills.every(
      (member) =>
        hasStringFields(member, ['name', 'description', 'path']) &&
        hasOptionalBoolean(member, 'userInvocable') &&
        hasOptionalBoolean(member, 'disableModelInvocation'),
    ) &&
    Array.isArray(value.commands) &&
    value.commands.every((member) =>
      hasStringFields(member, ['name', 'description', 'filePath']),
    ) &&
    Array.isArray(value.agents) &&
    value.agents.every((member) =>
      hasStringFields(member, ['name', 'description', 'filePath']),
    ) &&
    (value.apps === undefined ||
      (Array.isArray(value.apps) &&
        value.apps.every((member) =>
          hasStringFields(member, ['name', 'description', 'filePath']),
        ))) &&
    Array.isArray(value.hooks) &&
    value.hooks.every(
      (member) =>
        hasStringFields(member, ['event', 'hookType']) &&
        hasOptionalString(member, 'matcher') &&
        hasOptionalString(member, 'command'),
    ) &&
    (value.mods === undefined ||
      (Array.isArray(value.mods) &&
        value.mods.every((member) =>
          hasStringFields(member, ['module', 'hooksFile']),
        ))) &&
    Array.isArray(value.mcpServers) &&
    value.mcpServers.every(
      (member) =>
        hasStringFields(member, ['name', 'type']) &&
        (member.type === 'command' || member.type === 'http') &&
        hasOptionalString(member, 'command') &&
        hasOptionalStringArray(member, 'args') &&
        hasOptionalString(member, 'url'),
    ) &&
    Array.isArray(value.lspServers) &&
    value.lspServers.every(
      (member) =>
        hasStringFields(member, ['name', 'command']) &&
        hasOptionalStringArray(member, 'args') &&
        hasOptionalStringArray(member, 'languages'),
    )
  );
}

function normalizePaths(value: string | string[] | undefined): string[] {
  if (!value) return [];
  return typeof value === 'string' ? [value] : value;
}

function resolvedManifestPaths(
  value: string | string[] | undefined,
  fallback: string,
): string[] {
  const configured = normalizePaths(value);
  const candidates = configured.length > 0 ? configured : [fallback];
  const resolved: string[] = [];
  for (const candidate of candidates) {
    const filePath = resolvePluginPath(candidate);
    if (filePath !== null) resolved.push(filePath);
  }
  return resolved;
}

function scanSkills(
  files: ReadonlyMap<string, string | Uint8Array>,
  manifest: ClaudePluginManifest | null,
): PluginSkillMember[] {
  const results: PluginSkillMember[] = [];
  const visited = new Set<string>();
  for (const root of resolvedManifestPaths(manifest?.skills, 'skills')) {
    // A manifest may name a skill itself or a directory containing skills.
    // A skill's supporting files remain inside that skill, even when a support
    // directory contains its own SKILL.md example.
    const directories = files.has(joinPluginPath(root, 'SKILL.md'))
      ? [root]
      : directChildDirectories(files, root).map((name) =>
          joinPluginPath(root, name),
        );
    for (const directory of directories) {
      if (visited.has(directory)) continue;
      visited.add(directory);
      const content = readTextFile(
        files,
        joinPluginPath(directory, 'SKILL.md'),
      );
      if (content === null || content.length === 0) continue;
      const frontmatter = parseFrontmatter(content) ?? {};
      const configuredName = readString(frontmatter, 'name');
      const description = readString(frontmatter, 'description');
      const userInvocable = frontmatter['user-invocable'];
      const disableModelInvocation = frontmatter['disable-model-invocation'];
      results.push({
        name: configuredName?.trim() || basenamePluginPath(directory),
        description: description?.trim() ?? '',
        path: directory,
        ...(typeof userInvocable === 'boolean' ? { userInvocable } : {}),
        ...(typeof disableModelInvocation === 'boolean'
          ? { disableModelInvocation }
          : {}),
      });
    }
  }
  return results.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
}

function scanMarkdownMembers(
  files: ReadonlyMap<string, string | Uint8Array>,
  configuredPaths: string | string[] | undefined,
  fallback: string,
): PluginMarkdownMember[] {
  const results: PluginMarkdownMember[] = [];
  for (const root of resolvedManifestPaths(configuredPaths, fallback)) {
    for (const filePath of directMarkdownFiles(files, root)) {
      const content = readTextFile(files, filePath);
      if (content === null || content.length === 0) continue;
      const frontmatter = parseFrontmatter(content) ?? {};
      const configuredName = readString(frontmatter, 'name');
      const description = readString(frontmatter, 'description');
      const basename = basenamePluginPath(filePath);
      const fallbackName = basename.endsWith('.md')
        ? basename.slice(0, -3)
        : basename;
      results.push({
        name: configuredName?.trim() || fallbackName,
        description: description?.trim() ?? '',
        filePath,
      });
    }
  }
  return results.sort((left, right) =>
    comparePluginPaths(left.filePath, right.filePath),
  );
}

function referencedConfigRecords(
  files: ReadonlyMap<string, string | Uint8Array>,
  configured: string | string[] | Record<string, unknown> | undefined,
  fallback: string,
): Record<string, unknown>[] {
  if (typeof configured === 'string') {
    const resolved = resolvePluginPath(configured);
    const config = resolved === null ? null : readJsonRecord(files, resolved);
    return config ? [config] : [];
  }
  if (Array.isArray(configured)) {
    const results: Record<string, unknown>[] = [];
    for (const entry of configured) {
      if (typeof entry !== 'string') continue;
      const resolved = resolvePluginPath(entry);
      const config = resolved === null ? null : readJsonRecord(files, resolved);
      if (config) results.push(config);
    }
    return results;
  }
  if (isRecord(configured)) return [configured];
  const fallbackConfig = readJsonRecord(files, fallback);
  return fallbackConfig ? [fallbackConfig] : [];
}

function flattenHooksConfig(
  config: Readonly<Record<string, unknown>>,
): PluginHookMember[] {
  const configuredHooks = config.hooks;
  const hooks = isRecord(configuredHooks) ? configuredHooks : config;
  const results: PluginHookMember[] = [];
  for (const [event, entries] of Object.entries(hooks)) {
    if (event === 'modules') continue;
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!isRecord(entry)) continue;
      const nestedHooks = Array.isArray(entry.hooks) ? entry.hooks : [entry];
      for (const hook of nestedHooks) {
        if (!isRecord(hook)) continue;
        results.push({
          event,
          ...(typeof entry.matcher === 'string'
            ? { matcher: entry.matcher }
            : {}),
          hookType: typeof hook.type === 'string' ? hook.type : 'command',
          ...(typeof hook.command === 'string'
            ? { command: hook.command }
            : {}),
        });
      }
    }
  }
  return results;
}

// Claude Code reads a Mod's `modules` from hooks/hooks.json and also from
// every hooks file path the manifest names; an inline hooks object adds none.
function modHookFileRecords(
  files: ReadonlyMap<string, string | Uint8Array>,
  configured: string | string[] | Record<string, unknown> | undefined,
): Array<{ filePath: string; config: Record<string, unknown> }> {
  const references = [
    'hooks/hooks.json',
    ...[configured ?? []]
      .flat()
      .filter((entry): entry is string => typeof entry === 'string'),
  ];
  const records: Array<{ filePath: string; config: Record<string, unknown> }> =
    [];
  const seen = new Set<string>();
  for (const reference of references) {
    const filePath = resolvePluginPath(reference);
    if (filePath === null || seen.has(filePath)) continue;
    seen.add(filePath);
    const config = readJsonRecord(files, filePath);
    if (config) records.push({ filePath, config });
  }
  return records;
}

function scanHooks(
  files: ReadonlyMap<string, string | Uint8Array>,
  manifest: ClaudePluginManifest | null,
): PluginHookMember[] {
  return referencedConfigRecords(
    files,
    manifest?.hooks,
    'hooks/hooks.json',
  ).flatMap(flattenHooksConfig);
}

function scanMods(
  files: ReadonlyMap<string, string | Uint8Array>,
  manifest: ClaudePluginManifest | null,
): PluginModMember[] {
  const results: PluginModMember[] = [];
  for (const { filePath, config } of modHookFileRecords(
    files,
    manifest?.hooks,
  )) {
    for (const module of readStringArray(config.modules) ?? []) {
      results.push({ module, hooksFile: filePath });
    }
  }
  return results;
}

function mcpServerRecords(
  config: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return isRecord(config.mcpServers) ? config.mcpServers : config;
}

function extractMcpServers(
  config: Readonly<Record<string, unknown>>,
): PluginMcpServerMember[] {
  const results: PluginMcpServerMember[] = [];
  for (const [name, definition] of Object.entries(mcpServerRecords(config))) {
    if (!isRecord(definition)) continue;
    const args = readStringArray(definition.args);
    if (
      (definition.type === 'http' || definition.command === undefined) &&
      typeof definition.url === 'string'
    ) {
      results.push({ name, type: 'http', url: definition.url });
    } else if (typeof definition.command === 'string') {
      results.push({
        name,
        type: 'command',
        command: definition.command,
        ...(args ? { args } : {}),
      });
    }
  }
  return results;
}

function scanMcpServers(
  files: ReadonlyMap<string, string | Uint8Array>,
  manifest: ClaudePluginManifest | null,
): PluginMcpServerMember[] {
  return referencedConfigRecords(
    files,
    manifest?.mcpServers,
    '.mcp.json',
  ).flatMap(extractMcpServers);
}

function extractLspServers(
  config: Readonly<Record<string, unknown>>,
): PluginLspServerMember[] {
  const results: PluginLspServerMember[] = [];
  for (const [name, definition] of Object.entries(config)) {
    if (!isRecord(definition) || typeof definition.command !== 'string') {
      continue;
    }
    const args = readStringArray(definition.args);
    const extensionToLanguage = definition.extensionToLanguage;
    const languages: string[] = [];
    if (isRecord(extensionToLanguage)) {
      for (const language of Object.values(extensionToLanguage)) {
        if (typeof language === 'string' && !languages.includes(language)) {
          languages.push(language);
        }
      }
    }
    results.push({
      name,
      command: definition.command,
      ...(args ? { args } : {}),
      ...(languages.length > 0 ? { languages } : {}),
    });
  }
  return results;
}

function scanLspServers(
  files: ReadonlyMap<string, string | Uint8Array>,
  manifest: ClaudePluginManifest | null,
): PluginLspServerMember[] {
  return referencedConfigRecords(
    files,
    manifest?.lspServers,
    '.lsp.json',
  ).flatMap(extractLspServers);
}

export function buildPluginMemberInventory(
  input: BuildPluginMemberInventoryInput,
): PluginMemberInventory {
  const files = normalizePluginFiles(input.files);
  return {
    skills: scanSkills(files, input.manifest),
    commands: scanMarkdownMembers(files, input.manifest?.commands, 'commands'),
    agents: scanMarkdownMembers(files, input.manifest?.agents, 'agents'),
    apps: scanMarkdownMembers(files, input.manifest?.apps, 'apps'),
    hooks: scanHooks(files, input.manifest),
    mods: scanMods(files, input.manifest),
    mcpServers: scanMcpServers(files, input.manifest),
    lspServers: scanLspServers(files, input.manifest),
  };
}
