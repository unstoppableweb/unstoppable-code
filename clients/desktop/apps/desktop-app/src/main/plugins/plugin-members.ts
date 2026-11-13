import * as fs from 'node:fs';
import * as path from 'node:path';
import { comparePluginPaths } from '@canopy/plugin-interop';
import type { PluginManifest } from '@canopy/execution-engine/types/plugins';
import { safeReadText } from '../lib/fs-utils';
import { parseFrontmatter } from '../lib/frontmatter';
import { isPathInside } from '../lib/path-safety';

/**
 * On-disk discovery of a plugin's markdown members (skills, commands, agents).
 * Shared by the Codex compatibility projection and the Cursor capability
 * projection, which both enumerate a plugin's members from its install root.
 */

export interface ParsedFrontmatter {
  name?: string;
  description?: string;
  'disable-model-invocation'?: boolean;
  'user-invocable'?: boolean;
}

export interface ClaudeSkillSource {
  name: string;
  dirName: string;
  sourceDir: string;
  skillMdPath: string;
  description: string;
  metadata: ParsedFrontmatter;
}

export function normalizePaths(value: string | string[] | undefined): string[] {
  if (!value) return [];
  return typeof value === 'string' ? [value] : value;
}

export function readMarkdownNameAndDescription(filePath: string): {
  name: string;
  description: string;
} | null {
  const content = safeReadText(filePath);
  if (!content) return null;
  const frontmatter = parseFrontmatter<ParsedFrontmatter>(content);
  return {
    name:
      frontmatter?.name?.trim() ||
      path.basename(filePath, path.extname(filePath)),
    description: frontmatter?.description?.trim() ?? '',
  };
}

/**
 * The canonical path of `candidate` when it lies inside `root` once every
 * symbolic link in either path is resolved; null when it is missing or
 * escapes. `isPathInside` alone is lexical and `lstat` inspects only the
 * last segment, so a link anywhere in a path could otherwise point a member
 * root at content outside the tree it claims to be in.
 */
export function canonicalPathInside(
  root: string,
  candidate: string,
): string | null {
  try {
    const realRoot = fs.realpathSync(root);
    const realCandidate = fs.realpathSync(candidate);
    return isPathInside(realRoot, realCandidate) ? realCandidate : null;
  } catch {
    return null;
  }
}

/**
 * A member root is honored only when it resolves inside the plugin. A root
 * that exists but resolves elsewhere is reported through `warnings` so a
 * plugin whose members disappear is not a silent mystery; one that simply
 * does not exist (the default `skills/`, say) is ordinary and not reported.
 */
function memberRoot(
  pluginPath: string,
  root: string,
  warnings: string[] | undefined,
): { path: string; stats: fs.Stats } | null {
  const real = canonicalPathInside(pluginPath, root);
  if (!real) {
    if (fs.existsSync(root))
      warnings?.push(
        `Plugin member root "${root}" resolves outside the plugin and was skipped.`,
      );
    return null;
  }
  try {
    return { path: real, stats: fs.statSync(real) };
  } catch {
    return null;
  }
}

export function collectMarkdownFiles(dirOrFile: string): string[] {
  if (!fs.existsSync(dirOrFile)) return [];
  const stat = fs.statSync(dirOrFile);
  if (stat.isFile()) return dirOrFile.endsWith('.md') ? [dirOrFile] : [];
  if (!stat.isDirectory()) return [];
  return fs
    .readdirSync(dirOrFile, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => path.join(dirOrFile, entry.name))
    .sort(comparePluginPaths);
}

export function discoverPluginSkills(
  pluginPath: string,
  manifest: PluginManifest | null,
  warnings?: string[],
): ClaudeSkillSource[] {
  const configuredRoots = normalizePaths(manifest?.skills);
  const roots =
    configuredRoots.length > 0
      ? configuredRoots.map((relativePath) =>
          path.resolve(pluginPath, relativePath),
        )
      : [path.join(pluginPath, 'skills')];
  const results: ClaudeSkillSource[] = [];
  for (const root of roots) {
    const resolved = memberRoot(pluginPath, root, warnings);
    if (!resolved?.stats.isDirectory()) continue;
    for (const entry of fs.readdirSync(resolved.path, {
      withFileTypes: true,
    })) {
      // Links are skipped, so `sourceDir` is canonical like its root.
      if (!entry.isDirectory()) continue;
      const sourceDir = path.join(resolved.path, entry.name);
      const skillMdPath = path.join(sourceDir, 'SKILL.md');
      const content = safeReadText(skillMdPath);
      if (!content) continue;
      const metadata = parseFrontmatter<ParsedFrontmatter>(content) ?? {};
      results.push({
        name: metadata.name?.trim() || entry.name,
        dirName: entry.name,
        sourceDir,
        skillMdPath,
        description: metadata.description?.trim() ?? '',
        metadata,
      });
    }
  }
  return results.sort((left, right) => left.name.localeCompare(right.name));
}

export function discoverPluginMarkdownSources(
  pluginPath: string,
  manifest: PluginManifest | null,
  defaultSubdir: string,
  manifestKey: 'commands' | 'agents',
  warnings?: string[],
): string[] {
  const configuredRoots = normalizePaths(manifest?.[manifestKey]);
  const roots =
    configuredRoots.length > 0
      ? configuredRoots.map((relativePath) =>
          path.resolve(pluginPath, relativePath),
        )
      : [path.join(pluginPath, defaultSubdir)];
  const files: string[] = [];
  for (const root of roots) {
    const resolved = memberRoot(pluginPath, root, warnings);
    if (resolved) files.push(...collectMarkdownFiles(resolved.path));
  }
  return files.sort(comparePluginPaths);
}

export interface PluginCommandSource {
  name: string;
  description: string;
  filePath: string;
  /** The complete file, read once for both metadata and body. */
  content: string;
}

/** A plugin's commands with their content, for a projection that rewrites them. */
export function discoverPluginCommandSources(
  pluginPath: string,
  manifest: PluginManifest | null,
  warnings?: string[],
): PluginCommandSource[] {
  const results: PluginCommandSource[] = [];
  for (const filePath of discoverPluginMarkdownSources(
    pluginPath,
    manifest,
    'commands',
    'commands',
    warnings,
  )) {
    const content = safeReadText(filePath);
    if (!content) continue;
    const frontmatter = parseFrontmatter<ParsedFrontmatter>(content);
    results.push({
      name:
        frontmatter?.name?.trim() ||
        path.basename(filePath, path.extname(filePath)),
      description: frontmatter?.description?.trim() ?? '',
      filePath,
      content,
    });
  }
  return results;
}

export function discoverPluginMarkdownMembers(
  pluginPath: string,
  manifest: PluginManifest | null,
  memberKind: 'commands' | 'agents',
  warnings?: string[],
): Array<{ name: string; description: string; filePath: string }> {
  const results: Array<{
    name: string;
    description: string;
    filePath: string;
  }> = [];
  for (const filePath of discoverPluginMarkdownSources(
    pluginPath,
    manifest,
    memberKind,
    memberKind,
    warnings,
  )) {
    const parsed = readMarkdownNameAndDescription(filePath);
    if (parsed) results.push({ ...parsed, filePath });
  }
  return results;
}
