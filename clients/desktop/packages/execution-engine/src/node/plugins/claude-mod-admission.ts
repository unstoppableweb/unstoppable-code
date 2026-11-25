import { createHash, type Hash } from 'node:crypto';
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import type { BigIntStats, Dirent } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import type { SettingSource } from '@anthropic-ai/claude-agent-sdk';
import {
  isClaudeModAdmission,
  isClaudeModContentDigest,
  isClaudeModPluginId,
  isSkippedClaudeMod,
  type ClaudeModAdmission,
  type SkippedClaudeMod,
} from '../../types/claude-mod-admission';

export interface ClaudeModPluginInput {
  pluginId: string;
  installPath: string | null;
  /**
   * An ambient id Claude won't load: a higher settings layer turns it off,
   * or it has no install. It is still turned off, with no skipped record.
   */
  notLoaded?: true;
  /**
   * An ambient id enabled in settings whose install record can't be read:
   * Claude's `installed_plugins.json` is unreadable or does not parse.
   */
  installListUnreadable?: true;
  /**
   * A Mod Claude wrote in a session: the `<name>@inline` ids Claude loads it
   * under, turned off in place of `pluginId` (Canopy's `<name>@claude-session`).
   */
  inlineIds?: readonly string[];
}

export type ClaudeModAuthority = 'ok' | 'absent' | 'unreadable';

export interface ClaudeModAdmissionInput {
  enabled: boolean;
  /** The Claude config folder the ambient plugins were read from. */
  claudeConfigDir?: string;
  authority: ClaudeModAuthority;
  admissions: readonly ClaudeModAdmission[];
  modsDisabled: boolean;
  selectedPlugins: readonly ClaudeModPluginInput[];
  ambientPlugins: readonly ClaudeModPluginInput[];
  /**
   * `<name>@inline` ids of Mods Claude wrote in earlier sessions, which load
   * when a session resumes. Listed while every Mod is off, to turn them off.
   */
  sessionModIds?: readonly string[];
  /** Mods Claude wrote in the session this launch resumes, each admitted like any Mod. */
  sessionMods?: readonly ClaudeModPluginInput[];
}

/**
 * Flag-tier settings a launch merges last. While admission is on, `env` empties
 * CLAUDE_CODE_PLUGIN_DIRS: Claude applies flag-tier env over both the inherited
 * value and user-settings env, so no plugin dir loads outside admission.
 */
export interface ClaudeModAdmissionSettings {
  enabledPlugins?: Record<string, false>;
  env?: { CLAUDE_CODE_PLUGIN_DIRS: '' };
}

export interface ClaudeModAdmissionDecision {
  settings?: ClaudeModAdmissionSettings;
  stripSelectedPlugins: readonly ClaudeModPluginInput[];
  skippedMods: readonly SkippedClaudeMod[];
}

export interface ClaudePluginDigestLimits {
  maxBytes?: number;
  maxEntries?: number;
  maxFiles?: number;
}

export type ClaudePluginHooksInspection =
  | {
      success: true;
      pluginRoot: string;
      manifest: Record<string, unknown> | null;
      hooksFiles: readonly string[];
      hasMods: boolean;
    }
  | { success: false };

export interface ClaudeModLaunchPlugin {
  type: 'local';
  path: string;
}

export interface ClaudeModAdmissionLaunch {
  version: 1;
  cwd: string;
  /** The absolute Claude config folder the ambient plugins were read from. */
  claudeConfigDir?: string;
  settingSources: readonly SettingSource[];
  settings?: ClaudeModAdmissionSettings;
  plugins: readonly ClaudeModLaunchPlugin[];
  skippedMods: readonly SkippedClaudeMod[];
}

interface PluginTreeEntry {
  relativePath: string;
  absolutePath: string;
  kind: 'directory' | 'file';
  stat: BigIntStats;
}

const BigIntStatsOptions = { bigint: true } as const;
const DEFAULT_MAX_PLUGIN_FILES = 20_000;
const DEFAULT_MAX_PLUGIN_ENTRIES = 40_000;
const DEFAULT_MAX_PLUGIN_BYTES = 128 * 1024 * 1024;
const DIGEST_VERSION = Buffer.from('canopy-claude-plugin-content-v1', 'utf8');
// Claude Code 2.1.310 reads a plugin dir with none of these top-level names as
// a collection, and loads each child plugin in it.
const CLAUDE_PLUGIN_COMPONENT_DIRS = [
  'commands',
  'skills',
  'agents',
  'hooks',
  'themes',
  'output-styles',
  'monitors',
  'workflows',
];
const CLAUDE_PLUGIN_MARKERS = new Set([
  '.claude-plugin',
  ...CLAUDE_PLUGIN_COMPONENT_DIRS,
  'SKILL.md',
  '.mcp.json',
  '.lsp.json',
]);
const SYNCED_PLUGIN_GENERATION = /~g\d+$/;
const MAX_MANIFEST_BYTES = 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafePluginIdentity(value: string): boolean {
  return /^[^@\s/\\]{1,200}@[^@\s\\]{1,200}$/.test(value);
}

function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function compareBytewise(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

/**
 * The config folder a Claude child uses: a set CLAUDE_CONFIG_DIR taken
 * literally (empty and whitespace included) against its cwd, else `.claude`
 * under the child's own HOME, as Claude Code 2.1.310 resolves it.
 */
export function effectiveClaudeConfigDir(
  value: string | undefined,
  cwd: string,
  home?: string,
): string {
  const childHome = home?.trim();
  return (
    value !== undefined
      ? path.resolve(cwd, value)
      : path.join(childHome ? path.resolve(childHome) : homedir(), '.claude')
  ).normalize('NFC');
}

/**
 * Parse a JSON file as Claude does: invalid UTF-8 bytes decode to U+FFFD
 * (Claude Code 2.1.310 still applies such a settings file), and one leading
 * BOM is stripped.
 */
export function parseClaudeJsonFile(bytes: Buffer): unknown {
  return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
}

/** The nearest folder at or above cwd that holds `.git`, as Claude scopes it. */
export function findClaudeProjectGitRoot(cwd: string): string | undefined {
  // Claude runs from the physical cwd, so walk up from it, not a symlink.
  let current = path.resolve(cwd);
  try {
    current = realpathSync(current);
  } catch {
    // An unresolvable cwd keeps its lexical form.
  }
  while (true) {
    try {
      lstatSync(path.join(current, '.git'));
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return undefined;
      current = parent;
    }
  }
}

/**
 * True when two paths name the same file or folder after resolving symlinks,
 * through the nearest existing ancestor when the path itself does not exist.
 */
export function isSameClaudePath(left: string, right: string): boolean {
  const canonical = (value: string): string => {
    let existing = path.resolve(value);
    const missing: string[] = [];
    while (true) {
      try {
        return path.join(realpathSync(existing), ...missing);
      } catch {
        const parent = path.dirname(existing);
        if (parent === existing) return path.resolve(value);
        missing.unshift(path.basename(existing));
        existing = parent;
      }
    }
  };
  return canonical(left) === canonical(right);
}

function sameStat(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function resolvedPluginRoot(pluginPath: string): string | null {
  try {
    const absolute = path.resolve(pluginPath);
    const initial = lstatSync(absolute, BigIntStatsOptions);
    if (!initial.isDirectory() || initial.isSymbolicLink()) return null;
    const root = realpathSync(absolute);
    const canonical = lstatSync(root, BigIntStatsOptions);
    return canonical.isDirectory() && !canonical.isSymbolicLink() ? root : null;
  } catch {
    return null;
  }
}

function readRegularFile(
  root: string,
  filePath: string,
): { status: 'ok'; bytes: Buffer } | { status: 'missing' | 'error' } {
  const absolute = path.resolve(filePath);
  if (!isPathInside(root, absolute)) return { status: 'error' };
  const relative = path.relative(root, absolute);
  let current = root;
  const segments = relative
    .split(path.sep)
    .filter((segment) => segment.length > 0);
  if (segments.length === 0) return { status: 'error' };

  try {
    for (let index = 0; index < segments.length; index++) {
      current = path.join(current, segments[index]);
      const entry = lstatSync(current, BigIntStatsOptions);
      if (entry.isSymbolicLink()) return { status: 'error' };
      if (index < segments.length - 1 && !entry.isDirectory()) {
        return { status: 'error' };
      }
      if (index === segments.length - 1 && !entry.isFile()) {
        return { status: 'error' };
      }
    }

    const before = lstatSync(absolute, BigIntStatsOptions);
    const canonicalFile = realpathSync(absolute);
    if (
      before.isSymbolicLink() ||
      !before.isFile() ||
      !isPathInside(root, canonicalFile)
    ) {
      return { status: 'error' };
    }
    const descriptor = openSync(
      absolute,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const opened = fstatSync(descriptor, BigIntStatsOptions);
      if (!opened.isFile() || !sameStat(before, opened)) {
        return { status: 'error' };
      }
      const bytes = readFileSync(descriptor);
      const afterRead = fstatSync(descriptor, BigIntStatsOptions);
      const pathAfterRead = lstatSync(absolute, BigIntStatsOptions);
      if (
        !sameStat(opened, afterRead) ||
        !sameStat(afterRead, pathAfterRead) ||
        bytes.length !== Number(afterRead.size)
      ) {
        return { status: 'error' };
      }
      return { status: 'ok', bytes };
    } finally {
      closeSync(descriptor);
    }
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') {
      return { status: 'missing' };
    }
    return { status: 'error' };
  }
}

function collectPluginTree(
  root: string,
  limits: { maxBytes: number; maxEntries: number; maxFiles: number },
): PluginTreeEntry[] | null {
  const entries: PluginTreeEntry[] = [];
  let fileCount = 0;
  let byteCount = 0n;

  const visit = (directory: string, relativeDirectory: string): boolean => {
    let names: string[];
    try {
      names = readdirSync(directory).sort(compareBytewise);
    } catch {
      return false;
    }
    for (const name of names) {
      const absolutePath = path.join(directory, name);
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${name}`
        : name;
      let stat: PluginTreeEntry['stat'];
      try {
        stat = lstatSync(absolutePath, BigIntStatsOptions);
      } catch {
        return false;
      }
      if (stat.isSymbolicLink()) return false;
      // `.git` is hashed too: Claude can load Mod code from under it.
      if (stat.isDirectory()) {
        entries.push({ relativePath, absolutePath, kind: 'directory', stat });
        if (
          entries.length > limits.maxEntries ||
          !visit(absolutePath, relativePath)
        ) {
          return false;
        }
      } else if (stat.isFile()) {
        fileCount++;
        byteCount += stat.size;
        if (
          fileCount > limits.maxFiles ||
          entries.length + 1 > limits.maxEntries ||
          byteCount > BigInt(limits.maxBytes)
        ) {
          return false;
        }
        entries.push({ relativePath, absolutePath, kind: 'file', stat });
      } else {
        return false;
      }
    }
    return true;
  };

  try {
    const rootStat = lstatSync(root, BigIntStatsOptions);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return null;
    if (!visit(root, '')) return null;
    return entries.sort((left, right) =>
      compareBytewise(left.relativePath, right.relativePath),
    );
  } catch {
    return null;
  }
}

function sameTree(
  left: readonly PluginTreeEntry[],
  right: readonly PluginTreeEntry[],
): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        entry.relativePath === other.relativePath &&
        entry.kind === other.kind &&
        sameStat(entry.stat, other.stat)
      );
    })
  );
}

function updateLengthPrefixed(hash: Hash, bytes: Buffer): void {
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  hash.update(length);
  hash.update(bytes);
}

function validLimits(limits: ClaudePluginDigestLimits): {
  maxBytes: number;
  maxEntries: number;
  maxFiles: number;
} | null {
  const maxBytes = limits.maxBytes ?? DEFAULT_MAX_PLUGIN_BYTES;
  const maxEntries = limits.maxEntries ?? DEFAULT_MAX_PLUGIN_ENTRIES;
  const maxFiles = limits.maxFiles ?? DEFAULT_MAX_PLUGIN_FILES;
  return [maxBytes, maxEntries, maxFiles].every(
    (value) => Number.isSafeInteger(value) && value > 0,
  )
    ? { maxBytes, maxEntries, maxFiles }
    : null;
}

/** Hash a bounded, stable snapshot of every regular file and directory in a plugin. */
export function computeClaudePluginContentDigest(
  pluginPath: string,
  limits: ClaudePluginDigestLimits = {},
): string | null {
  const root = resolvedPluginRoot(pluginPath);
  const bounded = validLimits(limits);
  if (!root || !bounded) return null;
  let rootBefore: BigIntStats;
  try {
    rootBefore = lstatSync(root, BigIntStatsOptions);
  } catch {
    return null;
  }
  const entries = collectPluginTree(root, bounded);
  if (!entries) return null;

  const contents = new Map<string, Buffer>();
  for (const entry of entries) {
    if (entry.kind !== 'file') continue;
    const result = readRegularFile(root, entry.absolutePath);
    let currentStat: BigIntStats;
    try {
      currentStat = lstatSync(entry.absolutePath, BigIntStatsOptions);
    } catch {
      return null;
    }
    if (result.status !== 'ok' || !sameStat(entry.stat, currentStat)) {
      return null;
    }
    contents.set(entry.relativePath, result.bytes);
  }

  const after = collectPluginTree(root, bounded);
  let rootAfter: BigIntStats;
  try {
    rootAfter = lstatSync(root, BigIntStatsOptions);
  } catch {
    return null;
  }
  if (!after || !sameTree(entries, after) || !sameStat(rootBefore, rootAfter)) {
    return null;
  }

  const hash = createHash('sha256');
  updateLengthPrefixed(hash, DIGEST_VERSION);
  updateLengthPrefixed(hash, Buffer.from(String(entries.length), 'utf8'));
  for (const entry of entries) {
    updateLengthPrefixed(hash, Buffer.from(entry.relativePath, 'utf8'));
    updateLengthPrefixed(hash, Buffer.from(entry.kind, 'utf8'));
    updateLengthPrefixed(
      hash,
      entry.kind === 'file'
        ? (contents.get(entry.relativePath) ?? Buffer.alloc(0))
        : Buffer.alloc(0),
    );
  }
  return `sha256:${hash.digest('hex')}`;
}

function manifestHookReferences(
  manifest: Record<string, unknown> | null,
): string[] | null {
  const hooks = manifest?.hooks;
  if (hooks === undefined || isRecord(hooks)) return [];
  if (typeof hooks === 'string') return [hooks];
  if (Array.isArray(hooks)) {
    return hooks.filter((entry): entry is string => typeof entry === 'string');
  }
  return null;
}

function readPluginManifest(
  root: string,
): Record<string, unknown> | null | false {
  const manifestPath = path.join(root, '.claude-plugin', 'plugin.json');
  const read = readRegularFile(root, manifestPath);
  if (read.status === 'missing') return null;
  if (read.status !== 'ok') return false;
  try {
    const parsed = parseClaudeJsonFile(read.bytes);
    return isRecord(parsed) ? parsed : false;
  } catch {
    return false;
  }
}

function pathPresence(target: string): 'there' | 'absent' | 'unsure' {
  try {
    return lstatSync(target).isSymbolicLink() ? 'unsure' : 'there';
  } catch (error) {
    const code = isRecord(error) ? error.code : undefined;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'absent' : 'unsure';
  }
}

/**
 * The child plugins Claude loads when it reads `root` as a plugin dir: none
 * when a top-level marker makes it one plugin, `null` when that is unclear.
 */
function claudeCollectionChildren(root: string): string[] | null {
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  let candidates = entries;
  if (entries.some((entry) => entry.name === '.claude-plugin')) {
    const pluginJson = pathPresence(
      path.join(root, '.claude-plugin', 'plugin.json'),
    );
    const marketplaceJson = pathPresence(
      path.join(root, '.claude-plugin', 'marketplace.json'),
    );
    if (pluginJson === 'unsure' || marketplaceJson === 'unsure') return null;
    // A marketplace root with no plugin.json of its own is not one plugin.
    if (pluginJson === 'absent' && marketplaceJson === 'there') {
      candidates = entries.filter((entry) => entry.name !== '.claude-plugin');
    }
  }
  const markers = candidates
    .map((entry) => entry.name)
    .filter((name) => CLAUDE_PLUGIN_MARKERS.has(name));
  if (markers.some((name) => !CLAUDE_PLUGIN_COMPONENT_DIRS.includes(name))) {
    return [];
  }
  // A component folder marks one plugin unless it is a plugin itself.
  const markerPresence = markers.map((name) =>
    pathPresence(path.join(root, name, '.claude-plugin', 'plugin.json')),
  );
  if (markerPresence.includes('absent')) return [];
  if (markerPresence.includes('unsure')) return null;
  const children: string[] = [];
  for (const entry of candidates) {
    if (entry.name.startsWith('.')) continue;
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const presence = pathPresence(
      path.join(root, entry.name, '.claude-plugin', 'plugin.json'),
    );
    if (presence === 'unsure') return null;
    if (presence === 'there') children.push(entry.name);
  }
  return children;
}

/**
 * Inspect a plugin dir as Claude loads it: the root and, when Claude reads it
 * as a collection, each child plugin. Installed plugins always load as one
 * plugin, so for them the children only add disables.
 */
export function inspectClaudePluginHooks(
  pluginPath: string,
): ClaudePluginHooksInspection {
  const root = resolvedPluginRoot(pluginPath);
  if (!root) return { success: false };
  const inspection = inspectPluginRoot(root);
  const children = claudeCollectionChildren(root);
  if (!inspection.success || !children) return { success: false };
  const hooksFiles = [...inspection.hooksFiles];
  let hasMods = inspection.hasMods;
  for (const child of children) {
    const childRoot = resolvedPluginRoot(path.join(root, child));
    if (!childRoot || !isPathInside(root, childRoot)) return { success: false };
    const childInspection = inspectPluginRoot(childRoot);
    if (!childInspection.success) return { success: false };
    hooksFiles.push(...childInspection.hooksFiles);
    hasMods ||= childInspection.hasMods;
  }
  return { ...inspection, hooksFiles, hasMods };
}

/** Strictly inspect the default and manifest-named hooks files Claude Code reads. */
function inspectPluginRoot(root: string): ClaudePluginHooksInspection {
  const manifest = readPluginManifest(root);
  if (manifest === false) return { success: false };
  const references = manifestHookReferences(manifest);
  if (!references) return { success: false };

  const seen = new Set<string>();
  const hooksFiles: string[] = [];
  let hasMods = false;
  for (const reference of ['hooks/hooks.json', ...references]) {
    const candidate = path.resolve(root, reference);
    if (!isPathInside(root, candidate)) return { success: false };
    const key = path.normalize(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    const read = readRegularFile(root, candidate);
    if (read.status === 'missing') {
      if (reference === 'hooks/hooks.json') continue;
      return { success: false };
    }
    if (read.status !== 'ok') return { success: false };
    let parsed: unknown;
    try {
      parsed = parseClaudeJsonFile(read.bytes);
    } catch {
      return { success: false };
    }
    if (!isRecord(parsed)) return { success: false };
    if (parsed.modules !== undefined) {
      if (
        !Array.isArray(parsed.modules) ||
        !parsed.modules.every(
          (module): module is string => typeof module === 'string',
        )
      ) {
        return { success: false };
      }
      hasMods ||= parsed.modules.length > 0;
    }
    const canonicalFile = realpathSync(candidate);
    if (!isPathInside(root, canonicalFile)) return { success: false };
    hooksFiles.push(canonicalFile);
  }
  return { success: true, pluginRoot: root, manifest, hooksFiles, hasMods };
}

/** A plugin Claude would load under a name admission cannot read. */
export class ClaudeModUncheckablePluginError extends Error {
  override name = 'ClaudeModUncheckablePluginError';
}

function autoLoadedPlugin(
  dir: string,
  fallbackName: string,
  marketplace: 'skills-dir' | 'synced',
): ClaudeModPluginInput {
  let installPath: string | null = null;
  try {
    installPath = realpathSync(dir);
  } catch {
    // The evaluator fails closed on a copy it cannot read.
  }
  const name = (installPath && claudeManifestName(installPath)) ?? fallbackName;
  return { pluginId: `${name}@${marketplace}`, installPath };
}

/**
 * The name Claude gives a plugin from its plugin.json: Claude follows a
 * symlinked manifest, decodes it as UTF-8 and strips one leading BOM, so a
 * manifest inspection refuses can still name the plugin Claude loads.
 */
function claudeManifestName(root: string): string | undefined {
  const manifestPath = path.join(root, '.claude-plugin', 'plugin.json');
  let size: number | undefined;
  try {
    const stat = statSync(manifestPath);
    size = stat.isFile() ? stat.size : undefined;
  } catch {
    return undefined;
  }
  // Claude reads any size, so a skipped read could disable the wrong id:
  // refuse the launch instead.
  if (size !== undefined && size > MAX_MANIFEST_BYTES) {
    throw new ClaudeModUncheckablePluginError(
      `Claude can't start: the plugin manifest ${manifestPath} is too large to check for Mods. Remove that plugin or shrink its plugin.json.`,
    );
  }
  if (size === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''),
    );
    return isRecord(parsed) && typeof parsed.name === 'string'
      ? parsed.name
      : undefined;
  } catch {
    return undefined;
  }
}

function listPluginFolders(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(
        (entry) =>
          (entry.isDirectory() || entry.isSymbolicLink()) &&
          !entry.name.startsWith('.'),
      )
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * Mods Claude wrote in sessions, `<config>/dev-mods/<session>/<mod>/`, or only
 * `sessionId`'s. Each is named as its manifest (else its folder) names it, as
 * `<name>@claude-session`, with every `<name>@inline` id Claude may load it
 * under when that session starts again; an extra id only adds a disable.
 */
export function listClaudeSessionMods(
  claudeConfigDir: string,
  sessionId?: string,
): (ClaudeModPluginInput & { inlineIds: readonly string[] })[] {
  const subfolders = (folder: string): string[] => {
    try {
      return readdirSync(folder, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return [];
    }
  };
  const root = path.join(claudeConfigDir, 'dev-mods');
  if (sessionId === undefined) {
    // A session this can't read can't start (its own launch is refused), and
    // its Mods load nowhere else, so it never blocks the other sessions.
    return subfolders(root).flatMap((session) => {
      try {
        return listClaudeSessionMods(claudeConfigDir, session);
      } catch {
        return [];
      }
    });
  }
  if (!/^[\w-][\w.-]*$/.test(sessionId)) return [];
  const mods: (ClaudeModPluginInput & { inlineIds: readonly string[] })[] = [];
  for (const folder of subfolders(path.join(root, sessionId))) {
    const dir = path.join(root, sessionId, folder);
    // Named as Claude names it; an unreadable size refuses the launch.
    const names = [claudeManifestName(dir), folder].filter(
      (name): name is string => !!name && /^[^@\s/\\]+$/.test(name),
    );
    const name = names[0];
    if (name === undefined) {
      throw new ClaudeModUncheckablePluginError(
        `Claude can't start: the Mod Claude wrote in ${dir} has a name this app can't check. Remove that folder.`,
      );
    }
    let installPath: string | null = null;
    try {
      installPath = realpathSync(dir);
    } catch {
      // The evaluator fails closed on a Mod it cannot read.
    }
    mods.push({
      pluginId: `${name}@claude-session`,
      installPath,
      inlineIds: Array.from(new Set(names.map((each) => `${each}@inline`))),
    });
  }
  return mods;
}

/** Every session-written Mod's `<name>@inline` ids, turned off while Mods are off. */
export function listClaudeSessionModIds(claudeConfigDir: string): string[] {
  return Array.from(
    new Set(
      listClaudeSessionMods(claudeConfigDir).flatMap((mod) => mod.inlineIds),
    ),
  ).sort();
}

/**
 * Plugins Claude Code 2.1.310 loads with no install record: folders with a
 * `.claude-plugin` entry in the user and project skills folders
 * (`<name>@skills-dir`) and copies synced from a claude.ai account
 * (`<name>@synced`). This reads a superset of Claude's scan; an extra folder
 * only adds a disable.
 */
export function listClaudeAutoLoadedPlugins(options: {
  claudeConfigDir: string;
  projectPaths: readonly string[];
  settingSources: readonly SettingSource[];
}): ClaudeModPluginInput[] {
  const userSettings = options.settingSources.includes('user');
  const skillsDirs = userSettings
    ? [path.join(options.claudeConfigDir, 'skills')]
    : [];
  if (options.settingSources.includes('project')) {
    for (const projectPath of options.projectPaths) {
      skillsDirs.push(path.join(projectPath, '.claude', 'skills'));
    }
  }
  const plugins: ClaudeModPluginInput[] = [];
  for (const skillsDir of skillsDirs) {
    for (const name of listPluginFolders(skillsDir)) {
      const dir = path.join(skillsDir, name);
      if (pathPresence(path.join(dir, '.claude-plugin')) === 'absent') continue;
      plugins.push(autoLoadedPlugin(dir, name, 'skills-dir'));
    }
  }
  if (userSettings) {
    const syncedRoot = path.join(options.claudeConfigDir, 'plugins', 'synced');
    for (const bucket of listPluginFolders(syncedRoot)) {
      for (const name of listPluginFolders(path.join(syncedRoot, bucket))) {
        plugins.push(
          autoLoadedPlugin(
            path.join(syncedRoot, bucket, name),
            name.replace(SYNCED_PLUGIN_GENERATION, ''),
            'synced',
          ),
        );
      }
    }
  }
  return plugins;
}

function safeAdmissionForPlugin(
  admissions: readonly ClaudeModAdmission[],
  pluginId: string,
): ClaudeModAdmission | undefined {
  if (!isClaudeModPluginId(pluginId)) return undefined;
  const matches = admissions.filter(
    (admission) =>
      admission.pluginId === pluginId && isClaudeModAdmission(admission),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function skippedMod(
  plugin: ClaudeModPluginInput,
  source: 'selected' | 'ambient',
  reason: SkippedClaudeMod['reason'],
  contentDigest: string | null,
): SkippedClaudeMod {
  return { pluginId: plugin.pluginId, source, contentDigest, reason };
}

/** Merge flag-tier plugin disables into launch settings, keeping every other key. */
export function mergeClaudeModAdmissionSettings<
  T extends Record<string, unknown>,
>(base: T, admission: ClaudeModAdmissionSettings | undefined): T {
  if (!admission?.enabledPlugins && !admission?.env) return base;
  const existingPlugins = base.enabledPlugins;
  const existingEnv = base.env;
  return {
    ...base,
    ...(admission.enabledPlugins
      ? {
          enabledPlugins: {
            ...(isRecord(existingPlugins) ? existingPlugins : {}),
            ...admission.enabledPlugins,
          },
        }
      : {}),
    ...(admission.env
      ? {
          env: {
            ...(isRecord(existingEnv) ? existingEnv : {}),
            ...admission.env,
          },
        }
      : {}),
  };
}

/** One synchronous policy function shared by desktop and pipeline resolvers. */
export function evaluateClaudeModAdmission(
  input: ClaudeModAdmissionInput,
): ClaudeModAdmissionDecision {
  if (!input.enabled) {
    return { stripSelectedPlugins: [], skippedMods: [] };
  }

  const enabledPlugins: Record<string, false> = {};
  const stripSelectedPlugins: ClaudeModPluginInput[] = [];
  const skippedMods: SkippedClaudeMod[] = [];
  const seenSkipped = new Set<string>();

  const recordSkipped = (
    plugin: ClaudeModPluginInput,
    source: 'selected' | 'ambient',
    reason: SkippedClaudeMod['reason'],
    contentDigest: string | null,
  ): void => {
    const key = `${plugin.pluginId}\0${source}\0${reason}`;
    if (seenSkipped.has(key)) return;
    seenSkipped.add(key);
    skippedMods.push(skippedMod(plugin, source, reason, contentDigest));
  };

  const checkPlugin = (
    plugin: ClaudeModPluginInput,
    source: 'selected' | 'ambient',
  ): void => {
    if (!isSafePluginIdentity(plugin.pluginId)) {
      // An id the skipped records cannot name is still kept from loading.
      if (source === 'selected') stripSelectedPlugins.push(plugin);
      else {
        for (const id of plugin.inlineIds ?? [plugin.pluginId]) {
          enabledPlugins[id] = false;
        }
      }
      return;
    }
    const failClosed = (
      reason: SkippedClaudeMod['reason'],
      digest: string | null,
    ): void => {
      if (source === 'selected') stripSelectedPlugins.push(plugin);
      else if (plugin.inlineIds) {
        // Shared with a selected plugin of the same name, which goes off too.
        for (const inlineId of plugin.inlineIds)
          enabledPlugins[inlineId] = false;
      } else if (!plugin.pluginId.endsWith('@inline')) {
        enabledPlugins[plugin.pluginId] = false;
      }
      recordSkipped(plugin, source, reason, digest);
    };

    if (plugin.installPath === null) {
      // Claude won't load it, so it is turned off without a skipped record.
      if (plugin.notLoaded && source === 'ambient') {
        enabledPlugins[plugin.pluginId] = false;
        return;
      }
      failClosed(
        plugin.installListUnreadable
          ? 'install-list-unreadable'
          : 'inspection-failed',
        null,
      );
      return;
    }
    const inspection = inspectClaudePluginHooks(plugin.installPath);
    if (!inspection.success) {
      failClosed('inspection-failed', null);
      return;
    }
    if (!inspection.hasMods) return;

    if (input.authority === 'unreadable') {
      failClosed('authority-unreadable', null);
      return;
    }
    if (input.modsDisabled) {
      failClosed('kill-switch', null);
      return;
    }
    if (input.authority !== 'ok') {
      failClosed('not-admitted', null);
      return;
    }
    const admission = safeAdmissionForPlugin(input.admissions, plugin.pluginId);
    if (!admission || !isClaudeModContentDigest(admission.contentDigest)) {
      failClosed('not-admitted', null);
      return;
    }
    const currentDigest = computeClaudePluginContentDigest(plugin.installPath);
    if (!currentDigest) {
      failClosed('inspection-failed', null);
      return;
    }
    if (currentDigest !== admission.contentDigest) {
      failClosed('digest-changed', currentDigest);
    }
  };

  for (const plugin of input.selectedPlugins) checkPlugin(plugin, 'selected');
  for (const plugin of input.ambientPlugins) checkPlugin(plugin, 'ambient');
  for (const plugin of input.sessionMods ?? []) checkPlugin(plugin, 'ambient');
  // A session Mod keeps its own question while Mods are on (decision 65).
  if (input.modsDisabled || input.authority === 'unreadable') {
    for (const pluginId of input.sessionModIds ?? []) {
      enabledPlugins[pluginId] = false;
    }
  }

  const settings: ClaudeModAdmissionSettings = {
    env: { CLAUDE_CODE_PLUGIN_DIRS: '' },
    ...(Object.keys(enabledPlugins).length > 0 ? { enabledPlugins } : {}),
  };
  return { settings, stripSelectedPlugins, skippedMods };
}

function isSettingSource(value: unknown): value is SettingSource {
  return value === 'user' || value === 'project' || value === 'local';
}

function isAdmissionSettings(
  value: unknown,
): value is ClaudeModAdmissionSettings {
  if (!isRecord(value)) return false;
  if (
    Object.keys(value).some((key) => key !== 'enabledPlugins' && key !== 'env')
  ) {
    return false;
  }
  if (value.env !== undefined) {
    const env = value.env;
    if (
      !isRecord(env) ||
      Object.keys(env).length !== 1 ||
      env.CLAUDE_CODE_PLUGIN_DIRS !== ''
    ) {
      return false;
    }
  }
  if (value.enabledPlugins === undefined) return true;
  if (!isRecord(value.enabledPlugins)) return false;
  return Object.entries(value.enabledPlugins).every(
    ([key, enabled]) =>
      key.length > 0 && !key.includes('\0') && enabled === false,
  );
}

/**
 * Read a pipeline step's launch envelope. `undefined` when absent; throws when
 * malformed, invalid or written for another cwd or setting sources, so a step
 * never launches with a decision made for a different context.
 */
export function readClaudeModAdmissionEnvelope(
  raw: string | undefined,
  expected: { cwd: string; settingSources: readonly SettingSource[] },
): ClaudeModAdmissionLaunch | undefined {
  const parsed = parseClaudeModAdmissionEnvelope(raw);
  if (!parsed) return undefined;
  const sourcesMatch =
    parsed.settingSources.length === expected.settingSources.length &&
    parsed.settingSources.every(
      (source, index) => source === expected.settingSources[index],
    );
  if (!isSameClaudePath(parsed.cwd, expected.cwd) || !sourcesMatch) {
    throw new Error(
      'Claude Mod admission launch envelope does not match this step context.',
    );
  }
  return parsed;
}

/** Parse and validate a launch envelope without checking its context. */
export function parseClaudeModAdmissionEnvelope(
  raw: string | undefined,
): ClaudeModAdmissionLaunch | undefined {
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Claude Mod admission launch envelope is malformed.');
  }
  if (!isClaudeModAdmissionLaunch(parsed)) {
    throw new Error('Claude Mod admission launch envelope is invalid.');
  }
  return parsed;
}

/** True when `target` is a folder strictly inside `root`, after symlinks. */
export function isClaudeLaunchCwdInside(root: string, target: string): boolean {
  const canonical = (value: string): string => {
    const resolved = path.resolve(value);
    try {
      return realpathSync(resolved);
    } catch {
      return resolved;
    }
  };
  return isPathInside(canonical(root), canonical(target));
}

/**
 * Keep only the requested plugins the decision allows. A decision never adds
 * plugins a caller did not ask for.
 */
export function filterToClaudeModLaunchPlugins<T extends { path: string }>(
  requested: readonly T[],
  launch: ClaudeModAdmissionLaunch,
): T[] {
  const allowed = launch.plugins.map((plugin) => plugin.path);
  return requested.filter((plugin) =>
    allowed.some((allowedPath) => isSameClaudePath(plugin.path, allowedPath)),
  );
}

/** Validate the host-local launch DTO before a caller uses or transports it. */
export function isClaudeModAdmissionLaunch(
  value: unknown,
): value is ClaudeModAdmissionLaunch {
  if (!isRecord(value)) return false;
  return (
    value.version === 1 &&
    typeof value.cwd === 'string' &&
    path.isAbsolute(value.cwd) &&
    (value.claudeConfigDir === undefined ||
      (typeof value.claudeConfigDir === 'string' &&
        path.isAbsolute(value.claudeConfigDir))) &&
    Array.isArray(value.settingSources) &&
    value.settingSources.every(isSettingSource) &&
    (value.settings === undefined || isAdmissionSettings(value.settings)) &&
    Array.isArray(value.plugins) &&
    value.plugins.every(
      (plugin) =>
        isRecord(plugin) &&
        plugin.type === 'local' &&
        typeof plugin.path === 'string' &&
        path.isAbsolute(plugin.path) &&
        Object.keys(plugin).every((key) => key === 'type' || key === 'path'),
    ) &&
    Array.isArray(value.skippedMods) &&
    value.skippedMods.every(isSkippedClaudeMod)
  );
}
