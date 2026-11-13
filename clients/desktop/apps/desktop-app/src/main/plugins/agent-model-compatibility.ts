import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type {
  ModelHarness,
  ChatTabPluginSelections,
} from '@canopy/desktop-shared/types';
import { parseClaudeJsonFile } from '@canopy/execution-engine/node/plugins/claude-mod-admission';
import {
  buildPluginMemberInventory,
  CURSOR_PLUGIN_SKILL_ROOT_MODE,
  cursorLoadsPluginMemberKind,
  pluginAppConfigPaths,
  resolvePluginPath,
  type ClaudePluginManifest,
} from '@canopy/plugin-interop';
import { readPluginManifest } from './plugin-manifest';
import { normalizePaths } from './plugin-members';
import { loadMarketplacesCacheOnly } from './plugin-service';
import { countPluginSelections } from '@canopy/execution-engine/lib/plugin-selections-normalization';
import {
  inspectSelectedAgentPlugin,
  isSelectedAgentMcpAvailable,
  resolveEffectivePluginSelectionRefs,
  cursorSkillSourceDir,
} from './plugin-resolver';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type ComponentManifest = Pick<
  ClaudePluginManifest,
  | 'skills'
  | 'commands'
  | 'agents'
  | 'apps'
  | 'hooks'
  | 'mcpServers'
  | 'lspServers'
>;

const COMPONENT_KEYS = [
  'skills',
  'commands',
  'agents',
  'apps',
  'hooks',
  'mcpServers',
  'lspServers',
] as const;

function hasReadableComponents(
  manifest: Record<string, unknown>,
): manifest is Record<string, unknown> & ComponentManifest {
  return COMPONENT_KEYS.every((key) => {
    const value = manifest[key];
    return (
      value === undefined ||
      typeof value === 'string' ||
      (Array.isArray(value) &&
        value.every((entry) => typeof entry === 'string')) ||
      (['hooks', 'mcpServers', 'lspServers'].includes(key) && record(value))
    );
  });
}

/** Selection inspection only: no installs, projections, credentials or runtime publication. */
export async function agentModelPluginIncompatibility(
  selections: ChatTabPluginSelections,
  harness: ModelHarness,
  projectId?: string,
): Promise<string | undefined> {
  if ((selections.unresolvedCapabilities?.length ?? 0) > 0)
    return 'Some selected resources have not been installed.';
  if (countPluginSelections(selections) === 0) return undefined;
  try {
    const warnings: string[] = [];
    const refs = await resolveEffectivePluginSelectionRefs(
      selections,
      warnings,
      projectId,
    );
    if (warnings.length || refs.warnings.length)
      return 'Some selected resources could not be checked.';
    for (const ref of refs.skillRefs) {
      const directory = cursorSkillSourceDir(ref);
      if (
        !directory ||
        !(await fs.readFile(path.join(directory, 'SKILL.md'), 'utf8')).trim()
      ) {
        return 'A selected skill is missing or unreadable.';
      }
    }
    for (const ref of refs.mcpServerRefs) {
      if (!(await isSelectedAgentMcpAvailable(ref)))
        return 'A selected MCP server is missing or unavailable.';
    }
    if (!refs.pluginRefs.length) return undefined;
    const catalog = await loadMarketplacesCacheOnly();
    if (!catalog.success || !catalog.data)
      return 'The selected plugins could not be checked.';
    const marketplaces = catalog.data.marketplaces;
    for (const ref of refs.pluginRefs) {
      const plugin = await inspectSelectedAgentPlugin(
        ref,
        marketplaces,
        harness,
      );
      if (!plugin)
        return 'A selected plugin is missing or unavailable for this harness.';
      const files = new Set<string>();
      const fileContents = new Map<string, Buffer>();
      const directories = new Set<string>();
      const emptyMarkdown = new Set<string>();
      let bytes = 0;
      // Bounded, asynchronous and fail closed. Display scanners alone suppress I/O failures.
      const visit = async (relative: string): Promise<void> => {
        for (const entry of await fs.readdir(
          path.join(plugin.pluginPath, relative),
          { withFileTypes: true },
        )) {
          if (entry.name === '.git' || entry.name === 'node_modules') continue;
          const name = relative ? `${relative}/${entry.name}` : entry.name;
          if (files.size >= 20_000 || entry.isSymbolicLink())
            throw new Error('Uncheckable plugin');
          files.add(name);
          if (entry.isDirectory()) {
            directories.add(name);
            await visit(name);
          } else if (entry.isFile()) {
            const filePath = path.join(plugin.pluginPath, name);
            bytes += (await fs.stat(filePath)).size;
            if (bytes > 16 * 1024 * 1024) throw new Error('Uncheckable plugin');
            const content = await fs.readFile(filePath);
            fileContents.set(name, content);
            if (name.endsWith('.md') && !content.toString('utf8').trim())
              emptyMarkdown.add(name);
          } else throw new Error('Uncheckable plugin');
        }
      };
      if ((await fs.lstat(plugin.pluginPath)).isSymbolicLink())
        throw new Error('Uncheckable plugin');
      await visit('');
      const manifest =
        readPluginManifest(plugin.provider, (relativePath) => {
          const content = fileContents.get(relativePath);
          if (content === undefined) {
            if (files.has(relativePath)) throw new Error('Unreadable manifest');
            return null;
          }
          const parsed: unknown = parseClaudeJsonFile(content);
          if (!record(parsed)) throw new Error('Unreadable manifest');
          return parsed;
        }) ?? {};
      if (!hasReadableComponents(manifest))
        return 'A selected plugin has an unreadable inventory.';
      for (const name of [
        'hooks/hooks.json',
        '.mcp.json',
        '.lsp.json',
        ...pluginAppConfigPaths(fileContents),
      ]) {
        const content = fileContents.get(name);
        if (content) parseClaudeJsonFile(content);
      }
      for (const key of COMPONENT_KEYS) {
        const value = manifest[key];
        const paths =
          typeof value === 'string'
            ? [value]
            : Array.isArray(value)
              ? value
              : [];
        for (const declared of paths) {
          if (typeof declared !== 'string')
            return 'A selected plugin has an unreadable inventory.';
          const name = resolvePluginPath(declared);
          if (name === null || (name !== '' && !files.has(name)))
            return 'A selected plugin references missing resources.';
          const content = name.endsWith('.json')
            ? fileContents.get(name)
            : undefined;
          if (content) parseClaudeJsonFile(content);
        }
      }
      // Read the bounded snapshot with the same member inventory as execution
      // projection, not the display scanner that suppresses unreadable members.
      const details = buildPluginMemberInventory({
        files: fileContents,
        manifest,
      });
      const configuredSkillRoots = normalizePaths(manifest.skills);
      const skillRoots = configuredSkillRoots.length
        ? configuredSkillRoots
        : ['skills'];
      for (const root of skillRoots) {
        const normalized = resolvePluginPath(root);
        if (normalized === null)
          return 'A selected plugin references missing resources.';
        const rootSkill = normalized ? `${normalized}/SKILL.md` : 'SKILL.md';
        if (files.has(rootSkill)) {
          if (emptyMarkdown.has(rootSkill))
            return 'A selected plugin skill is missing or unreadable.';
          continue;
        }
        if (
          configuredSkillRoots.length &&
          !details.skills.some(
            (skill) => path.posix.dirname(skill.path) === (normalized || '.'),
          )
        )
          return 'A selected plugin skill is missing or unreadable.';
        for (const directory of directories) {
          const parent = path.posix.dirname(directory);
          if ((parent === '.' ? '' : parent) !== normalized) continue;
          const member = `${directory}/SKILL.md`;
          if (files.has(member) && emptyMarkdown.has(member))
            return 'A selected plugin skill is missing or unreadable.';
        }
      }
      const mcpOnly = harness === 'claude' && plugin.provider === 'codex';
      const restricted = harness !== 'claude' || mcpOnly;
      const cursorFamily =
        harness === 'cursor' || harness === 'copilot' || harness === 'opencode';
      if (cursorFamily) {
        const projected = buildPluginMemberInventory({
          files: fileContents,
          manifest,
          skillRootMode: CURSOR_PLUGIN_SKILL_ROOT_MODE,
        });
        const loadedSkills = new Set(
          projected.skills.map((skill) => skill.path),
        );
        if (details.skills.some((skill) => !loadedSkills.has(skill.path)))
          return "The selected harness cannot load all of the Agent's plugin features.";
      }
      if (
        restricted &&
        (files.has('hooks/hooks.json') ||
          files.has('.lsp.json') ||
          details.hooks.length ||
          (details.mods?.length ?? 0) ||
          details.lspServers.length ||
          manifest.monitors !== undefined ||
          manifest.hooks !== undefined ||
          manifest.lspServers !== undefined)
      ) {
        return "The selected harness cannot load all of the Agent's plugin features.";
      }
      // In-process Codex keeps native apps and projects Claude .app.json;
      // daemon Codex steps separately refuse nonempty selections in owner-ports.
      if (harness === 'codex' && plugin.provider === 'claude') {
        const retainedApps = new Set(pluginAppConfigPaths(fileContents));
        const selectedApps = [
          ...(details.apps ?? []).map((app) => app.filePath),
          ...normalizePaths(manifest.apps),
        ];
        if (
          selectedApps.some((app) => {
            const resolved = resolvePluginPath(app);
            return resolved === null || !retainedApps.has(resolved);
          })
        )
          return "The selected harness cannot load all of the Agent's plugin features.";
      }
      if (
        restricted &&
        harness !== 'codex' &&
        ((details.apps?.length ?? 0) ||
          pluginAppConfigPaths(fileContents).length ||
          manifest.apps !== undefined)
      ) {
        return "The selected harness cannot load all of the Agent's plugin features.";
      }
      if (
        (harness === 'cursor' ||
          harness === 'copilot' ||
          harness === 'opencode') &&
        (details.agents.length || manifest.agents !== undefined)
      ) {
        return 'The selected harness cannot load plugin agents.';
      }
      if (
        (harness === 'cursor' ||
          harness === 'copilot' ||
          harness === 'opencode') &&
        !cursorLoadsPluginMemberKind(plugin.provider, 'commands') &&
        (details.commands.length || manifest.commands !== undefined)
      ) {
        return 'The selected harness cannot load commands from this plugin.';
      }
      if (
        mcpOnly &&
        (details.skills.length ||
          details.commands.length ||
          details.agents.length ||
          manifest.skills !== undefined ||
          manifest.commands !== undefined ||
          manifest.agents !== undefined)
      ) {
        return 'The selected harness only loads MCP servers from this plugin.';
      }
    }
    return undefined;
  } catch {
    return 'Some selected resources are missing or could not be read.';
  }
}
