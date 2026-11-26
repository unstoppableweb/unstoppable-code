import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import * as path from 'node:path';
import { homedir, userInfo } from 'node:os';
import type { WorkerPipelineSetupFact } from '@canopy/protocol/canopy-core';
import type { PlatformOperatingSystem } from '../../../platform/platform-services';
import { readPreferencesEnvelopeRecord } from '@canopy/protocol/preferences';

/** Host-local projection only; these paths never enter a public assessment. */
export function pipelineSetupFactRoots(input: {
  readonly cwd: string;
  readonly dataRoot: string;
  readonly environment: Readonly<Record<string, string>>;
}): Readonly<Record<WorkerPipelineSetupFact['root'], string>> {
  const home = input.environment.HOME?.trim() || homedir();
  return {
    data: input.dataRoot,
    worktree: input.cwd,
    home: path.resolve(home),
    system: path.parse(path.resolve(home)).root,
    'claude-config': (input.environment.CLAUDE_CONFIG_DIR !== undefined
      ? path.resolve(input.cwd, input.environment.CLAUDE_CONFIG_DIR)
      : path.join(path.resolve(home), '.claude')
    ).normalize('NFC'),
    'codex-config': input.environment.CODEX_HOME
      ? path.resolve(input.cwd, input.environment.CODEX_HOME)
      : path.join(path.resolve(home), '.codex'),
  };
}

/** Only these non-secret projections can extend a run's start admission. */
export function isPipelineSetupFactAllowed(
  fact: Pick<WorkerPipelineSetupFact, 'root' | 'relativePath' | 'projection'>,
  operatingSystem: PlatformOperatingSystem | null = null,
): boolean {
  const parts = fact.relativePath.split('/');
  if (
    parts.some(
      (part) => !part || part === '.' || part === '..' || part.includes('\\'),
    ) ||
    path.isAbsolute(fact.relativePath)
  )
    return false;
  if (fact.projection === 'preferences')
    return fact.root === 'data' && fact.relativePath === 'preferences.json';
  if (fact.projection === 'local-plugin') return fact.root === 'worktree';
  if (fact.projection === 'claude-connections')
    return (
      (fact.root === 'home' || fact.root === 'claude-config') &&
      fact.relativePath === '.claude.json'
    );
  if (fact.projection === 'absence')
    return (
      (fact.root === 'data' &&
        fact.relativePath === 'resource-install-receipts.json') ||
      [
        // Absence facts do not depend on the environment.
        ...claudeNativeConfigurationFacts(operatingSystem, {}),
        ...codexNativeConfigurationFacts(operatingSystem),
        ...localPipelinePluginPolicyFacts(true),
      ].some(
        (candidate) =>
          candidate.root === fact.root &&
          candidate.relativePath === fact.relativePath &&
          candidate.projection === fact.projection,
      )
    );
  switch (fact.root) {
    case 'home':
    case 'system':
      return false;
    case 'data':
      return [
        'agent-models.json',
        'workspace-context.json',
        'model-policy-marker.json',
        'model-gateway-marker.json',
        'plugins-cache.json',
        'plugin-cache-index.json',
      ].includes(fact.relativePath);
    case 'codex-config':
      return fact.relativePath === 'config.toml';
    case 'claude-config':
      return ['settings.json', 'plugins', 'skills', 'dev-mods'].some(
        (name) =>
          fact.relativePath === name ||
          fact.relativePath.startsWith(`${name}/`),
      );
    case 'worktree':
      return /^(?:[^/]+\/)*(?:\.claude\/(?:settings\.json|settings\.local\.json|skills(?:\/.*)?)|\.codex\/config\.toml)$/.test(
        fact.relativePath,
      );
  }
}

/** Explicit local resources do not lease either vendor's installed-plugin
 * authority. Its absence is rechecked, even when the other harness runs.
 */
export function localPipelinePluginPolicyFacts(
  codexCatalog: boolean,
): readonly Omit<WorkerPipelineSetupFact, 'id' | 'version'>[] {
  return [
    {
      root: 'claude-config',
      relativePath: 'settings.json',
      projection: 'content',
    },
    {
      root: 'claude-config',
      relativePath: 'plugins/installed_plugins.json',
      projection: 'content',
    },
    {
      root: 'claude-config',
      relativePath: 'plugins/installed_plugins.json',
      projection: 'absence',
    },
    ...(codexCatalog
      ? [
          {
            root: 'codex-config' as const,
            relativePath: 'config.toml',
            projection: 'content' as const,
          },
          {
            root: 'codex-config' as const,
            relativePath: 'plugins',
            projection: 'absence' as const,
          },
          {
            root: 'codex-config' as const,
            relativePath: '.tmp/marketplaces',
            projection: 'absence' as const,
          },
          {
            root: 'home' as const,
            relativePath: '.agents/plugins',
            projection: 'absence' as const,
          },
        ]
      : []),
  ];
}

/** Sources the pinned Claude SDK can load without an explicit plugin selection.
 * Native MCP is structurally checked; managed/agent configuration must be absent.
 * No policy helper, MDM parser or configured MCP server is executed here.
 */
export function claudeNativeConfigurationFacts(
  operatingSystem: PlatformOperatingSystem | null,
  /** The environment the Claude step is spawned with, not this process's. */
  environment: Readonly<Record<string, string>>,
): readonly Omit<WorkerPipelineSetupFact, 'id' | 'version'>[] {
  if (operatingSystem !== 'darwin' && operatingSystem !== 'linux') return [];
  const facts: Omit<WorkerPipelineSetupFact, 'id' | 'version'>[] = [
    {
      // Pinned Claude Code 2.1.325 (aYr/z_; SDK 0.3.325 core-0bmnpbz2.mjs:16,
      // Wf) reads CLAUDE_CONFIG_DIR || homedir(), never both, unless the
      // legacy .config.json below exists. Requalify when the pin moves.
      root: environment.CLAUDE_CONFIG_DIR ? 'claude-config' : 'home',
      relativePath: '.claude.json',
      projection: 'claude-connections',
    },
    { root: 'worktree', relativePath: '.mcp.json', projection: 'absence' },
  ];
  for (const name of [
    '.config.json',
    'remote-settings.json',
    'remote-settings.signature.json',
    'remote-settings.signature-iat.json',
    'policy-limits.json',
    'policy-limits.signature.json',
    'policy-limits.signature-iat.json',
    'managed-settings.json',
    'managed-mcp.json',
    'agents',
  ])
    facts.push({
      root: 'claude-config',
      relativePath: name,
      projection: 'absence',
    });
  facts.push({
    root: 'worktree',
    relativePath: '.claude/agents',
    projection: 'absence',
  });
  const managed =
    operatingSystem === 'darwin'
      ? 'Library/Application Support/ClaudeCode'
      : 'etc/claude-code';
  for (const name of [
    'managed-settings.json',
    'managed-settings.d',
    'managed-mcp.json',
  ])
    facts.push({
      root: 'system',
      relativePath: `${managed}/${name}`,
      projection: 'absence',
    });
  if (operatingSystem === 'darwin') {
    facts.push({
      root: 'system',
      relativePath:
        'Library/Managed Preferences/com.anthropic.claudecode.plist',
      projection: 'absence',
    });
    // Failure to establish this source is an admission failure, not no MDM.
    const username = userInfo().username;
    if (!username || username.includes('/') || username.includes('\\'))
      throw new Error('Unknown managed configuration scope');
    facts.push({
      root: 'system',
      relativePath: `Library/Managed Preferences/${username}/com.anthropic.claudecode.plist`,
      projection: 'absence',
    });
  }
  return facts;
}

/** Only absence is classified for machine-wide Codex configuration/policy. */
export function codexNativeConfigurationFacts(
  operatingSystem: PlatformOperatingSystem | null,
): readonly Omit<WorkerPipelineSetupFact, 'id' | 'version'>[] {
  if (operatingSystem !== 'darwin' && operatingSystem !== 'linux') return [];
  // macOS /etc is a system symlink. Facts traverse physical containment paths,
  // rather than relaxing the prohibition on symlinks inside a fact projection.
  const folder =
    operatingSystem === 'darwin' ? 'private/etc/codex' : 'etc/codex';
  return ['config.toml', 'requirements.toml'].map((name) => ({
    root: 'system',
    relativePath: `${folder}/${name}`,
    projection: 'absence',
  }));
}

function noNativeMcp(value: unknown): boolean {
  if (!record(value)) return false;
  const servers = value.mcpServers;
  const enabled = value.enabledMcpjsonServers;
  if (
    (servers !== undefined &&
      (!record(servers) || Object.keys(servers).length > 0)) ||
    (enabled !== undefined &&
      (!Array.isArray(enabled) || enabled.length > 0)) ||
    (value.enableAllProjectMcpServers !== undefined &&
      value.enableAllProjectMcpServers !== false)
  )
    return false;
  if (
    value.projects !== undefined &&
    (!record(value.projects) ||
      !Object.values(value.projects).every(noNativeMcp))
  )
    return false;
  return true;
}

const PREFERENCE_FACT_KEYS = [
  'aiCreditsRoutingMode',
  'claudeModAdmissions',
  'claudeModsDisabled',
  'defaultChatProvider',
  'defaultChatModelByProvider',
  'defaultWorktreeProvider',
  'defaultWorktreeModelByProvider',
  'appAdvisorModel',
  'mcpHttpAuthDefaultHandler',
  'disabledInstalledItems',
  'parkedCodexPlugins',
  'pendingInstalledItemUninstalls',
] as const;

function missing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Re-digests projected content, including absence and directory membership; never follows links. */
export async function readPipelineSetupFactVersion(
  root: string,
  fact: Pick<WorkerPipelineSetupFact, 'root' | 'relativePath' | 'projection'>,
  operatingSystem: PlatformOperatingSystem | null = null,
  options: {
    readonly frozenAiCreditsConsent?: boolean;
    readonly requireAiCreditsConsent?: boolean;
    readonly expectedPreferencesVersion?: string;
  } = {},
): Promise<string | undefined> {
  if (
    !path.isAbsolute(root) ||
    !isPipelineSetupFactAllowed(fact, operatingSystem)
  )
    return undefined;
  const hash = createHash('sha256');
  let entries = 0;
  let bytes = 0;
  try {
    const projectedRoot = await realpath(root).catch((error: unknown) => {
      if (missing(error)) return undefined;
      throw error;
    });
    if (!projectedRoot)
      return fact.projection === 'local-plugin' ||
        options.requireAiCreditsConsent
        ? undefined
        : hash.update('absent-root').digest('hex');
    hash.update(projectedRoot);
    // A missing ancestor is an observable absence. Existing ancestors must
    // never redirect the admitted projection outside its root.
    let ancestor = projectedRoot;
    const allParts = fact.relativePath.split('/');
    for (const part of allParts) {
      if (!part) continue;
      ancestor = path.join(ancestor, part);
      const entry = await lstat(ancestor).catch((error: unknown) => {
        if (missing(error)) return undefined;
        throw error;
      });
      if (!entry)
        return fact.projection === 'local-plugin' ||
          options.requireAiCreditsConsent
          ? undefined
          : hash.update('absent').digest('hex');
      if (entry.isSymbolicLink()) return undefined;
    }
    // Never open managed policy, native MCP or agent files merely to prove
    // absence: they may contain credentials or launch external helpers.
    if (fact.projection === 'absence') return undefined;
    let pluginManifest = false;
    const visit = async (file: string, relative: string): Promise<void> => {
      if (++entries > 4096) throw new Error('Fact entry limit');
      const before = await lstat(file, { bigint: true });
      if (before.isSymbolicLink()) throw new Error('Fact link');
      const local = path
        .relative(path.join(projectedRoot, fact.relativePath), file)
        .split(path.sep)
        .join('/');
      if (fact.projection === 'local-plugin') {
        // Only text-only native plugins. Hooks, MCP, apps, executables, path
        // overrides and future manifest keys need their own dependency proof.
        const allowed = before.isDirectory()
          ? local === '' ||
            /^\.(?:claude|codex)-plugin$/.test(local) ||
            /^skills(?:\/[^/]+)*$/.test(local)
          : /^\.(?:claude|codex)-plugin\/plugin\.json$/.test(local) ||
            /^skills\/(?:[^/]+\/)*[^/]+\.md$/i.test(local);
        if (!allowed) throw new Error('Unclassified plugin content');
      }
      hash.update(
        JSON.stringify([relative, before.isDirectory() ? 'directory' : 'file']),
      );
      if (before.isDirectory()) {
        if (fact.projection === 'preferences')
          throw new Error('Preferences must be a file');
        const children = (await readdir(file)).sort();
        for (const child of children)
          await visit(path.join(file, child), `${relative}/${child}`);
      } else if (before.isFile()) {
        // Config scopes intentionally cannot read authentication records.
        if (
          /^(?:auth(?:\.json)?|\.credentials\.json|credentials(?:\..*)?)$/i.test(
            path.basename(file),
          ) ||
          /\.(?:pem|key)$/i.test(file)
        )
          throw new Error('Credential record');
        if (before.size > 8n * 1024n * 1024n)
          throw new Error('Fact file limit');
        // eslint-disable-next-line admitted-writers/no-unadmitted-write -- O_RDONLY only digests existing content and cannot mutate preferences; remove when the rule recognizes numeric read-only open flags.
        const handle = await open(
          file,
          constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
        );
        const buffer = Buffer.allocUnsafe(Number(before.size) + 1);
        let count = 0;
        try {
          const opened = await handle.stat({ bigint: true });
          if (!opened.isFile() || opened.ino !== before.ino)
            throw new Error('Fact identity changed');
          while (count < buffer.length) {
            const read = await handle.read(
              buffer,
              count,
              buffer.length - count,
              count,
            );
            if (read.bytesRead === 0) break;
            count += read.bytesRead;
          }
        } finally {
          await handle.close();
        }
        if (count > 8 * 1024 * 1024) throw new Error('Fact file limit');
        const content = buffer.subarray(0, count);
        bytes += content.length;
        if (bytes > 32 * 1024 * 1024) throw new Error('Fact byte limit');
        if (
          fact.projection === 'local-plugin' &&
          local.endsWith('/plugin.json')
        ) {
          const manifest: unknown = JSON.parse(content.toString('utf8'));
          if (
            !record(manifest) ||
            typeof manifest.name !== 'string' ||
            !manifest.name ||
            !Object.entries(manifest).every(
              ([key, value]) =>
                ['name', 'version', 'description'].includes(key) &&
                typeof value === 'string',
            )
          )
            throw new Error('Unclassified plugin manifest');
          pluginManifest = true;
        }
        if (fact.projection === 'claude-connections') {
          if (!noNativeMcp(JSON.parse(content.toString('utf8'))))
            throw new Error('Native MCP configuration');
          // Native profiles may contain tokens. Retain no values or content
          // digest; auth refresh and unrelated preferences are not route facts.
          hash.update('no-native-mcp');
        } else if (fact.projection === 'preferences') {
          const preferences = readPreferencesEnvelopeRecord(
            JSON.parse(content.toString('utf8')),
          );
          if (!preferences) throw new Error('Invalid preferences');
          if (
            options.requireAiCreditsConsent &&
            (preferences.aiCreditsRoutingMode !== 'on' ||
              hash
                .copy()
                .update(
                  JSON.stringify(
                    PREFERENCE_FACT_KEYS.map((key) => [key, preferences[key]]),
                  ),
                )
                .digest('hex') !== options.expectedPreferencesVersion)
          )
            throw new Error(
              'AI Credits consent not established for the admitted preferences',
            );
          hash.update(
            JSON.stringify(
              PREFERENCE_FACT_KEYS.filter(
                (key) =>
                  !options.frozenAiCreditsConsent ||
                  key !== 'aiCreditsRoutingMode',
              ).map((key) => [key, preferences[key]]),
            ),
          );
        } else
          hash.update(
            JSON.stringify([
              content.length,
              createHash('sha256').update(content).digest('hex'),
            ]),
          );
      } else throw new Error('Unsupported fact content');
      const after = await lstat(file, { bigint: true });
      if (
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs
      )
        throw new Error('Fact changed while reading');
    };
    await visit(path.join(projectedRoot, fact.relativePath), fact.relativePath);
    if (fact.projection === 'local-plugin' && !pluginManifest) return undefined;
    return hash.digest('hex');
  } catch {
    return undefined;
  }
}
