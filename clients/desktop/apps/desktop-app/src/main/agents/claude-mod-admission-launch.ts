import { homedir } from 'node:os';
import * as path from 'node:path';
import {
  type SdkPluginConfig,
  type SettingSource,
} from '@anthropic-ai/claude-agent-sdk';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import {
  type ClaudeModAdmissionLaunchProvider,
  setClaudeModAdmissionLaunchProvider,
} from '@canopy/desktop-shared/lib/structured-helper-query';
import {
  effectiveClaudeConfigDir,
  evaluateClaudeModAdmission,
  findClaudeProjectGitRoot,
  inspectClaudePluginHooks,
  isClaudeModAdmissionLaunch,
  listClaudeAutoLoadedPlugins,
  listClaudeSessionModIds,
  listClaudeSessionMods,
  type ClaudeModAdmissionInput,
  type ClaudeModAdmissionLaunch,
  type ClaudeModPluginInput,
  type ClaudeModLaunchPlugin,
} from '@canopy/execution-engine/node/plugins/claude-mod-admission';
import { projectClaudePluginForLaunch } from '@canopy/execution-engine/node/plugins/claude-mod-projection';
import {
  getEnhancedEnv,
  setClaudeModAdmissionEnabled,
} from '@canopy/execution-engine/pipelines/config-paths';
import type { ResolveEnvironmentRequest } from '@canopy/execution-engine/types/user-environment';
import {
  isClaudeModPluginId,
  isSkippedClaudeMod,
  type SkippedClaudeMod,
} from '@canopy/execution-engine/types/claude-mod-admission';
import type { ClaudeModAdmission } from '@canopy/execution-engine/types/claude-mod-admission';
import { resolveAmbientClaudePluginIds } from './delegation/claude-settings';
import { getFeatureFlagService } from '../feature-flags';
import { readClaudeEnabledPlugins } from '../plugins/claude-enabled-plugins';
import { getDataDir } from '../lib/paths';
import { reportPluginLaunchFailure } from '../lib/plugin-launch-failure-reporting';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { readPreferencesFileDetailed } from '../lib/preferences-store';

/**
 * A selected plugin root. `pluginId` is its catalog `<plugin>@<marketplace>`
 * when the caller knows it; without one the root gets a launch-only
 * `<name>@inline` identity that never matches an admission.
 */
export type ClaudeModLaunchPluginRequest = SdkPluginConfig & {
  pluginId?: string;
  /**
   * The installed copy a resolver projection was made from: its Mod and
   * digest are checked here while `path` launches.
   */
  sourcePath?: string;
};

/**
 * Where the launched Claude reads its config. Admission must inspect the same
 * `CLAUDE_CONFIG_DIR` the child gets, so callers pass the environment request
 * they build the child env with, or the child's value when they already have it.
 */
export interface ClaudeModAdmissionEnvironment {
  /** The child's HOME when it differs from the environment request's. */
  home?: string;
  /** `false` when the child env has no user variables (getEnhancedEnv's own option). */
  environment?: ResolveEnvironmentRequest | false;
  claudeConfigDir?: string;
}

export interface ResolveClaudeModAdmissionLaunchOptions extends ClaudeModAdmissionEnvironment {
  cwd: string;
  settingSources?: readonly SettingSource[];
  /** The Claude session the launch resumes or forks, whose own Mods it admits. */
  sessionId?: string;
  plugins?: readonly ClaudeModLaunchPluginRequest[];
  projectionRootDir?: string;
}

/** The launch-independent part of the evaluator input: flag, consent and ambient plugins. */
export type ClaudeModAdmissionContext = Omit<
  ClaudeModAdmissionInput,
  'selectedPlugins'
>;

const DEFAULT_SETTING_SOURCES: readonly SettingSource[] = [
  'user',
  'project',
  'local',
];

let unsubscribeFeatureFlags: (() => void) | undefined;

/**
 * The folder a Claude child launched at `cwd` with this environment reads its
 * config from: its CLAUDE_CONFIG_DIR (relative values against its cwd), else
 * `.claude` under the child env's own HOME. Consent and launches share it.
 */
export function resolveClaudeModConfigDirectory(
  options: ClaudeModAdmissionEnvironment & { cwd: string },
): string {
  const childEnv = getEnhancedEnv(
    options.environment !== undefined
      ? { environment: options.environment }
      : {},
  );
  return effectiveClaudeConfigDir(
    options.claudeConfigDir ?? childEnv.CLAUDE_CONFIG_DIR,
    options.cwd,
    options.home ?? childEnv.HOME,
  );
}

function selectedPluginIdentity(
  plugin: ClaudeModLaunchPluginRequest,
  index: number,
  cwd: string,
): ClaudeModPluginInput {
  const installPath = path.resolve(cwd, plugin.sourcePath ?? plugin.path);
  if (isClaudeModPluginId(plugin.pluginId)) {
    return { pluginId: plugin.pluginId, installPath };
  }
  const inspection = inspectClaudePluginHooks(installPath);
  const manifestName =
    inspection.success && typeof inspection.manifest?.name === 'string'
      ? inspection.manifest.name
      : undefined;
  const safeName =
    manifestName && /^[^@\s/\\]+$/.test(manifestName)
      ? manifestName
      : `local-${index + 1}`;
  return { pluginId: `${safeName}@inline`, installPath };
}

function addSkippedMod(
  skipped: SkippedClaudeMod[],
  entry: SkippedClaudeMod,
): void {
  if (!isSkippedClaudeMod(entry)) return;
  if (
    skipped.some(
      (existing) =>
        existing.pluginId === entry.pluginId &&
        existing.source === entry.source &&
        existing.reason === entry.reason,
    )
  ) {
    return;
  }
  skipped.push(entry);
}

/**
 * Read the flag, consent and ambient plugins fresh for one process launch at
 * its actual cwd and setting sources. `undefined` while the flag is off.
 */
export async function resolveClaudeModAdmissionContext(
  options: ClaudeModAdmissionEnvironment & {
    cwd: string;
    settingSources?: readonly SettingSource[];
    sessionId?: string;
  },
): Promise<ClaudeModAdmissionContext | undefined> {
  const featureFlags = getFeatureFlagService();
  const enabled = featureFlags.isEnabled(
    CLIENT_FEATURE_FLAGS.canopyDesktopClaudeModAdmission.key,
  );
  if (!enabled) return undefined;
  if (!path.isAbsolute(options.cwd)) {
    throw new Error('Claude Mod admission requires an absolute launch cwd.');
  }

  const settingSources = options.settingSources ?? DEFAULT_SETTING_SOURCES;
  const configDirectory = resolveClaudeModConfigDirectory(options);
  const preferenceRead = await readPreferencesFileDetailed();
  if (preferenceRead.authority === 'unreadable') {
    logMainProcessWarn(
      'Claude Mod preferences are unreadable; no admissions are active.',
    );
  }
  const admissions: readonly ClaudeModAdmission[] =
    preferenceRead.authority === 'ok'
      ? preferenceRead.preferences.claudeModAdmissions
      : [];
  const modsDisabled =
    preferenceRead.authority === 'ok' &&
    preferenceRead.preferences.claudeModsDisabled;

  // Claude scopes project and local settings and scoped installs to the Git
  // root; read both the cwd and that root so a subdirectory launch misses none.
  const gitRoot = findClaudeProjectGitRoot(options.cwd);
  const projectPaths =
    gitRoot && gitRoot !== path.resolve(options.cwd)
      ? [options.cwd, gitRoot]
      : [options.cwd];
  const allAmbientIds = new Set<string>();
  // Every distinct install per id: a copy Claude may load that is not
  // admitted at its own digest disables the id.
  const enabledInstalls = new Map<string, Set<string>>();
  // Whether Claude's layered enabled plugins could be read for every path.
  let enabledPluginsRead = true;
  const autoLoadedIds = new Set<string>();
  for (const projectPath of projectPaths) {
    for (const pluginId of await resolveAmbientClaudePluginIds({
      home: homedir(),
      cwd: projectPath,
      configDir: configDirectory,
      settingSources,
    })) {
      allAmbientIds.add(pluginId);
    }
    const enabledPlugins = readClaudeEnabledPlugins(
      configDirectory,
      projectPath,
      settingSources,
    );
    if (enabledPlugins === null) enabledPluginsRead = false;
    for (const [pluginId, installPath] of enabledPlugins ?? []) {
      allAmbientIds.add(pluginId);
      const paths = enabledInstalls.get(pluginId) ?? new Set<string>();
      paths.add(installPath);
      enabledInstalls.set(pluginId, paths);
    }
  }
  // Skills-folder and claude.ai-synced plugins have no install record.
  for (const { pluginId, installPath } of listClaudeAutoLoadedPlugins({
    claudeConfigDir: configDirectory,
    projectPaths,
    settingSources,
  })) {
    allAmbientIds.add(pluginId);
    autoLoadedIds.add(pluginId);
    if (installPath === null) continue;
    const paths = enabledInstalls.get(pluginId) ?? new Set<string>();
    paths.add(installPath);
    enabledInstalls.set(pluginId, paths);
  }
  const ambientPlugins: ClaudeModPluginInput[] = Array.from(allAmbientIds)
    .sort()
    .flatMap((pluginId): ClaudeModPluginInput[] => {
      const paths = Array.from(enabledInstalls.get(pluginId) ?? []).sort();
      if (paths.length > 0) {
        return paths.map((installPath) => ({ pluginId, installPath }));
      }
      // Enabled in some settings file, but Claude's layering or install
      // records leave it out; only an unreadable record is a skipped Mod.
      if (autoLoadedIds.has(pluginId)) return [{ pluginId, installPath: null }];
      return enabledPluginsRead
        ? [{ pluginId, installPath: null, notLoaded: true }]
        : [{ pluginId, installPath: null, installListUnreadable: true }];
    });
  return {
    enabled: true,
    claudeConfigDir: configDirectory,
    authority: preferenceRead.authority,
    admissions,
    modsDisabled,
    ambientPlugins,
    ...(options.sessionId !== undefined
      ? {
          sessionMods: listClaudeSessionMods(
            configDirectory,
            options.sessionId,
          ),
        }
      : {}),
    // A resumed session reloads the Mods Claude wrote in it, consent or not.
    ...(modsDisabled || preferenceRead.authority === 'unreadable'
      ? { sessionModIds: listClaudeSessionModIds(configDirectory) }
      : {}),
  };
}

/** Prepare one fresh authority/flag decision for a single process launch. */
export async function resolveClaudeModAdmissionLaunch(
  options: ResolveClaudeModAdmissionLaunchOptions,
): Promise<ClaudeModAdmissionLaunch | undefined> {
  const context = await resolveClaudeModAdmissionContext(options);
  if (!context) return undefined;
  const settingSources = options.settingSources ?? DEFAULT_SETTING_SOURCES;

  const inputPlugins = options.plugins ?? [];
  const selectedPlugins = inputPlugins.map((plugin, index) =>
    selectedPluginIdentity(plugin, index, options.cwd),
  );
  const decision = evaluateClaudeModAdmission({ ...context, selectedPlugins });
  const stripKeys = new Set(
    decision.stripSelectedPlugins.map(
      (plugin) => `${plugin.pluginId}\0${plugin.installPath ?? ''}`,
    ),
  );
  const skippedMods = [...decision.skippedMods];
  const finalPlugins: ClaudeModLaunchPlugin[] = [];
  const projectionRootDir =
    options.projectionRootDir ??
    path.join(getDataDir(), 'claude-mod-admission-projections');
  for (let index = 0; index < inputPlugins.length; index++) {
    const plugin = inputPlugins[index];
    const selected = selectedPlugins[index];
    if (!plugin || !selected) continue;
    const key = `${selected.pluginId}\0${selected.installPath ?? ''}`;
    // The copy to launch; with a sourcePath, the check read the install.
    const launchPath = path.resolve(options.cwd, plugin.path);
    if (!stripKeys.has(key)) {
      finalPlugins.push({ type: 'local', path: launchPath });
      continue;
    }
    const projection = projectClaudePluginForLaunch({
      sourcePluginPath: launchPath,
      projectionRootDir,
      removeModules: true,
      removeMcpServers: false,
    });
    if (projection.ok) {
      finalPlugins.push({ type: 'local', path: projection.path });
      continue;
    }
    if (projection.error !== undefined) {
      reportPluginLaunchFailure(projection.error, 'plugin.claude_projection');
    }
    const sourceSkipped = decision.skippedMods.find(
      (entry) =>
        entry.pluginId === selected.pluginId && entry.source === 'selected',
    );
    addSkippedMod(skippedMods, {
      pluginId: selected.pluginId,
      source: 'selected',
      contentDigest: sourceSkipped?.contentDigest ?? null,
      reason: 'projection-failed',
    });
    logMainProcessWarn(
      `Claude Mod projection failed for selected plugin "${selected.pluginId}"; it was omitted from this launch.`,
    );
  }

  const launch: ClaudeModAdmissionLaunch = {
    version: 1,
    cwd: options.cwd,
    ...(context.claudeConfigDir
      ? { claudeConfigDir: context.claudeConfigDir }
      : {}),
    settingSources,
    ...(decision.settings ? { settings: decision.settings } : {}),
    plugins: finalPlugins,
    skippedMods,
  };
  if (!isClaudeModAdmissionLaunch(launch)) {
    throw new Error(
      'Claude Mod admission produced an invalid launch decision.',
    );
  }
  return launch;
}

const helperLaunchProvider: ClaudeModAdmissionLaunchProvider = async (
  request,
): Promise<ClaudeModAdmissionLaunch | undefined> =>
  resolveClaudeModAdmissionLaunch({
    cwd: request.cwd,
    settingSources: request.settingSources,
    plugins: request.plugins,
    ...(request.environment ? { environment: request.environment } : {}),
  });

/** Install the desktop-only flag/environment and structured-helper host ports. */
export function installClaudeModAdmissionHost(): void {
  const featureFlags = getFeatureFlagService();
  const flagKey = CLIENT_FEATURE_FLAGS.canopyDesktopClaudeModAdmission.key;
  if (!unsubscribeFeatureFlags) {
    setClaudeModAdmissionEnabled(featureFlags.isEnabled(flagKey));
    unsubscribeFeatureFlags = featureFlags.onSnapshotChanged((snapshot) => {
      setClaudeModAdmissionEnabled(snapshot.values[flagKey]);
    });
  }
  setClaudeModAdmissionLaunchProvider(helperLaunchProvider);
}
