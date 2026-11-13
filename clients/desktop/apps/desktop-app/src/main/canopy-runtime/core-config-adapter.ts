import { CanopyOperationError } from '@canopy/core-runtime';
import { catalogContentRevision } from '@canopy/core-runtime/node/catalog';
import { KeyedOutcomes } from '@canopy/core-runtime/node/operations';
import {
  CONFIG_GIT_NAMESPACE,
  CONFIG_WRITABLE_NAMESPACES,
  ConfigAccountProxyValueSchema,
  ConfigAgentValueSchema,
  ConfigAppAdvisorValueSchema,
  ConfigGitValueSchema,
  ConfigLedgerValueSchema,
  ConfigMemoryValueSchema,
  ConfigNavigationValueSchema,
  ConfigProfileValueSchema,
  type ConfigAppAdvisorValue,
  type ConfigGetResult,
  type ConfigGitValue,
  type ConfigUpdateParams,
  type ConfigWritableNamespace,
} from '@canopy/protocol/canopy-core';
import {
  MAX_MANAGED_DELEGATION_DEPTH,
  normalizeManagedDelegationMaxDepth,
} from '@canopy/protocol/delegation/discovery';
import { resolvePrContentInstructions } from '@canopy/protocol/pull-requests';
import { MAX_ARCHIVE_RETENTION_DAYS } from '@canopy/desktop-shared/lib/archive-retention';
import { resolveCommitMessageInstructions } from '@canopy/desktop-shared/lib/commit-message-generator';
import {
  getModelPreferenceThinkingLevels,
  isNativeModelPreferenceOption,
  thinkingLevelForChosenModel,
} from '@canopy/desktop-shared/lib/model-thinking-preference';
import { CLAUDE_MAX_TURNS_MAX } from '@canopy/desktop-shared/constants/preferences';
import {
  IPC_CHANNELS,
  resolveModelAlias,
  type PreferencesData,
} from '@canopy/desktop-shared/types';
import type { DesktopDomainAdapter } from './desktop-runtime';

/** The stores behind `core.config.*`, one per served namespace; tests inject them. */
export interface CoreConfigHost {
  readGit(): Promise<ConfigGitValue>;
  readPreferences(): Promise<PreferencesData>;
  /**
   * The window's preferences save. `precondition` runs inside its commit with
   * the stored preferences, projected as reads see them, and throws to refuse
   * the patch before anything is written.
   */
  savePreferences(
    patch: Partial<PreferencesData>,
    precondition: (latest: PreferencesData) => void,
  ): Promise<
    PreferencesData & { __managedDelegationRevocationIncomplete?: boolean }
  >;
  readAppAdvisorSettings(): Promise<ConfigAppAdvisorValue>;
  /** Saves under the settings lock; `precondition` runs inside it. */
  saveAppAdvisorSettings(
    patch: Partial<ConfigAppAdvisorValue>,
    precondition: (current: ConfigAppAdvisorValue) => void,
  ): Promise<ConfigAppAdvisorValue>;
  /** Whether skill suggestions are offered at all. */
  skillSuggestionsAvailable(): Promise<boolean>;
}

function sanitizeBranchPrefix(raw: string): string {
  return raw
    .trim()
    .replace(/\/+$/g, '')
    .replace(/[^A-Za-z0-9._-]/g, '');
}

/** The `git` namespace over Electron main's preferences and the GitHub CLI login. */
export async function projectGitPreferences(
  preferences: PreferencesData,
  githubUsername: () => Promise<string | null>,
): Promise<ConfigGitValue> {
  const prefixMode = preferences.branchNamePrefixMode;
  const sanitized =
    prefixMode === 'github'
      ? sanitizeBranchPrefix((await githubUsername()) ?? '')
      : prefixMode === 'custom'
        ? sanitizeBranchPrefix(preferences.branchNameCustomPrefix)
        : '';
  return {
    branchName: {
      instructions: preferences.branchNamingInstructions.trim(),
      prefixMode,
      prefix: sanitized.length > 0 ? `${sanitized}/` : null,
    },
    pullRequest: {
      instructions: resolvePrContentInstructions({
        instructions: preferences.prInstructions.trim(),
        instructionMode: preferences.prInstructionMode,
      }),
    },
    commitMessage: {
      instructions: resolveCommitMessageInstructions({
        instructions: preferences.commitInstructions.trim(),
        instructionMode: preferences.commitInstructionMode,
      }),
    },
  };
}

const appAdvisorValue = (settings: {
  archiveRetentionDays?: number | null;
  autoArchiveDays?: number | null;
}): ConfigAppAdvisorValue => ({
  archiveRetentionDays: settings.archiveRetentionDays ?? null,
  autoArchiveDays: settings.autoArchiveDays ?? null,
});

const desktopConfigHost: CoreConfigHost = {
  readGit: async () => {
    const { readPreferencesFile } = await import('../lib/preferences-store');
    return projectGitPreferences(
      await readPreferencesFile(),
      async () =>
        (await (await import('../lib/github-auth')).checkGitHubCliStatus())
          .username ?? null,
    );
  },
  readPreferences: async () =>
    (await import('../lib/preferences-store')).readPreferencesFile(),
  savePreferences: async (patch, precondition) => {
    const [{ savePreferencesPatch }, { projectPreferencesForRuntime }] =
      await Promise.all([
        import('../ipc/preferences'),
        import('../lib/preferences-store'),
      ]);
    return savePreferencesPatch(patch, undefined, (latest) =>
      precondition(projectPreferencesForRuntime(latest)),
    );
  },
  readAppAdvisorSettings: async () =>
    appAdvisorValue(
      await (
        await import('../lib/app-advisor-workspace')
      ).readAppAdvisorWorkspaceSettings(),
    ),
  saveAppAdvisorSettings: async (patch, precondition) => {
    const [
      { saveAppAdvisorWorkspaceSettings },
      { BrowserWindow },
      { sendToWindow },
    ] = await Promise.all([
      import('../lib/app-advisor-workspace'),
      import('electron'),
      import('../lib/window-send'),
    ]);
    const saved = await saveAppAdvisorWorkspaceSettings(patch, (current) =>
      precondition(appAdvisorValue(current)),
    );
    // Both windows hear it, as after the settings modal's save.
    for (const window of BrowserWindow.getAllWindows())
      sendToWindow(window, IPC_CHANNELS.appAdvisorSettingsChanged, saved);
    return appAdvisorValue(saved);
  },
  skillSuggestionsAvailable: async () =>
    (
      await import('../skill-suggestions/feature-gate')
    ).isSkillSuggestionsFlagEnabled(),
};

const notServed = (namespace: string): CanopyOperationError =>
  new CanopyOperationError({
    kind: 'not_found',
    message: `The ${namespace} namespace is not served.`,
    code: 'core.config.notFound',
    retry: { kind: 'never' },
  });

const invalid = (message: string): CanopyOperationError =>
  new CanopyOperationError({
    kind: 'invalid_argument',
    message,
    retry: { kind: 'never' },
  });

const revisionConflict = (namespace: string): CanopyOperationError =>
  new CanopyOperationError({
    kind: 'conflict',
    message: `The ${namespace} settings changed since they were read. Read them again first.`,
    code: 'core.config.revisionConflict',
    retry: { kind: 'after_refresh', resource: 'core.config.get' },
  });

const unavailable = (message: string): CanopyOperationError =>
  new CanopyOperationError({
    kind: 'failed_precondition',
    message,
    code: 'core.config.invalidState',
    retry: { kind: 'never' },
  });

function isWritableNamespace(
  namespace: string,
): namespace is ConfigWritableNamespace {
  return CONFIG_WRITABLE_NAMESPACES.some((entry) => entry === namespace);
}

type PreferenceNamespace = Exclude<ConfigWritableNamespace, 'appAdvisor'>;
type ConfigValue = ConfigGetResult['value'];

/** A namespace's value as `core.config.get` returns it, from preferences. */
function preferenceValue(
  namespace: PreferenceNamespace,
  preferences: PreferencesData,
): ConfigValue {
  switch (namespace) {
    case 'agent':
      return ConfigAgentValueSchema.parse({
        claudeMaxTurns: preferences.claudeMaxTurns,
        handoffSummaryModel: preferences.handoffSummaryModel,
        handoffSummaryThinkingLevel: preferences.handoffSummaryThinkingLevel,
        managedDelegationMode: preferences.managedDelegationMode ?? 'off',
        managedDelegationMaxDepth: normalizeManagedDelegationMaxDepth(
          preferences.managedDelegationMaxDepth,
        ),
      });
    case 'memory':
      return ConfigMemoryValueSchema.parse({
        enabled: preferences.localMemoryEnabled,
        model: preferences.localMemoryModel,
        thinkingLevel: preferences.localMemoryThinkingLevel,
        modelSetByUser: preferences.localMemoryModelSetByUser === true,
      });
    case 'ledger':
      return ConfigLedgerValueSchema.parse({
        agentRecordingEnabled:
          preferences.ledgerAgentRecordingEnabled !== false,
      });
    case 'profile':
      return ConfigProfileValueSchema.parse({
        role: preferences.profileRole ?? null,
        roleDetail: preferences.profileRoleDetail || null,
        skillSuggestionsEnabled: preferences.skillSuggestionsEnabled !== false,
      });
    case 'navigation':
      return ConfigNavigationValueSchema.parse({
        mode: preferences.navigationMode,
      });
    case 'accountProxy':
      return ConfigAccountProxyValueSchema.parse({
        routeClaude: preferences.accountProxyRouteClaude !== false,
        routeCodex: preferences.accountProxyRouteCodex !== false,
        keepChatOnOneAccount:
          preferences.accountProxyKeepChatOnOneAccount !== false,
      });
  }
}

/** A model the Settings row offers, by id or alias; refused otherwise. */
function offeredModel(model: string, setting: string): string {
  const resolved = resolveModelAlias(model);
  if (!isNativeModelPreferenceOption(resolved, true))
    throw invalid(
      `${model} isn't an available Claude, Codex or Ollama model for the ${setting}.`,
    );
  return resolved;
}

/** The preferences a patch writes, checked as Settings checks them. */
async function preferencePatch(
  host: CoreConfigHost,
  params: Exclude<ConfigUpdateParams, { namespace: 'appAdvisor' }>,
  current: PreferencesData,
): Promise<Partial<PreferencesData>> {
  switch (params.namespace) {
    case 'agent': {
      const { patch } = params;
      if (
        patch.claudeMaxTurns !== undefined &&
        patch.claudeMaxTurns !== null &&
        patch.claudeMaxTurns > CLAUDE_MAX_TURNS_MAX
      )
        throw invalid(`claudeMaxTurns is at most ${CLAUDE_MAX_TURNS_MAX}.`);
      if (
        patch.managedDelegationMaxDepth !== undefined &&
        patch.managedDelegationMaxDepth > MAX_MANAGED_DELEGATION_DEPTH
      )
        throw invalid(
          `managedDelegationMaxDepth is at most ${MAX_MANAGED_DELEGATION_DEPTH}.`,
        );
      const handoffModel =
        patch.handoffSummaryModel === undefined
          ? undefined
          : offeredModel(patch.handoffSummaryModel, 'conversation handoff');
      return {
        ...(patch.claudeMaxTurns !== undefined
          ? { claudeMaxTurns: patch.claudeMaxTurns }
          : {}),
        ...(handoffModel !== undefined
          ? { handoffSummaryModel: handoffModel }
          : {}),
        ...(patch.handoffSummaryThinkingLevel !== undefined
          ? { handoffSummaryThinkingLevel: patch.handoffSummaryThinkingLevel }
          : {}),
        ...(patch.managedDelegationMode !== undefined
          ? { managedDelegationMode: patch.managedDelegationMode }
          : {}),
        ...(patch.managedDelegationMaxDepth !== undefined
          ? { managedDelegationMaxDepth: patch.managedDelegationMaxDepth }
          : {}),
      };
    }
    case 'memory': {
      const { patch } = params;
      const model =
        patch.model === undefined
          ? undefined
          : offeredModel(patch.model, 'memory model');
      const modelForLevel = model ?? current.localMemoryModel;
      let thinkingLevel = patch.thinkingLevel;
      if (thinkingLevel !== undefined) {
        const supported = getModelPreferenceThinkingLevels(modelForLevel);
        if (!supported.includes(thinkingLevel))
          throw invalid(
            supported.length === 0
              ? `${modelForLevel} has no thinking levels, so leave thinkingLevel out.`
              : `${modelForLevel} supports these thinking levels: ${supported.join(', ')}.`,
          );
      } else if (model !== undefined) {
        // As the Memory model row does on a model change.
        thinkingLevel = thinkingLevelForChosenModel(
          model,
          current.localMemoryThinkingLevel,
        );
      }
      return {
        ...(patch.enabled !== undefined
          ? {
              localMemoryEnabled: patch.enabled,
              localMemoryEnabledSetByUser: true,
            }
          : {}),
        ...(model !== undefined
          ? { localMemoryModel: model, localMemoryModelSetByUser: true }
          : {}),
        ...(thinkingLevel !== undefined
          ? { localMemoryThinkingLevel: thinkingLevel }
          : {}),
      };
    }
    case 'ledger':
      return params.patch.agentRecordingEnabled === undefined
        ? {}
        : { ledgerAgentRecordingEnabled: params.patch.agentRecordingEnabled };
    case 'profile': {
      const { patch } = params;
      if (
        patch.skillSuggestionsEnabled !== undefined &&
        !(await host.skillSuggestionsAvailable())
      )
        throw unavailable('Skill suggestions are not available.');
      if (patch.roleDetail !== undefined && patch.role === undefined)
        throw invalid('Set roleDetail together with the role it describes.');
      // The detail belongs to `other` only, as in Settings and onboarding:
      // another role clears it; an omitted detail keeps the stored text.
      const detail: Partial<PreferencesData> =
        patch.role === undefined
          ? {}
          : patch.role !== 'other'
            ? { profileRoleDetail: '' }
            : patch.roleDetail === undefined
              ? {}
              : { profileRoleDetail: patch.roleDetail };
      return {
        ...(patch.role !== undefined
          ? { profileRole: patch.role, profileRoles: [patch.role] }
          : {}),
        ...detail,
        ...(patch.skillSuggestionsEnabled !== undefined
          ? { skillSuggestionsEnabled: patch.skillSuggestionsEnabled }
          : {}),
      };
    }
    case 'navigation':
      return params.patch.mode === undefined
        ? {}
        : { navigationMode: params.patch.mode };
    case 'accountProxy': {
      const { patch } = params;
      return {
        ...(patch.routeClaude !== undefined
          ? { accountProxyRouteClaude: patch.routeClaude }
          : {}),
        ...(patch.routeCodex !== undefined
          ? { accountProxyRouteCodex: patch.routeCodex }
          : {}),
        ...(patch.keepChatOnOneAccount !== undefined
          ? { accountProxyKeepChatOnOneAccount: patch.keepChatOnOneAccount }
          : {}),
      };
    }
  }
}

/** Thrown inside a commit when the stored namespace no longer has the read revision. */
class StaleNamespaceError extends Error {}

type ConfigDocument = ConfigGetResult;

const documentOf = (namespace: string, value: ConfigValue): ConfigDocument => ({
  namespace,
  scope: {},
  revision: catalogContentRevision(value),
  value,
  enforcedPaths: [],
});

const reused = (): CanopyOperationError =>
  new CanopyOperationError({
    kind: 'conflict',
    message: 'This idempotency key was used with other parameters.',
    retry: { kind: 'never' },
  });

async function readNamespace(
  host: CoreConfigHost,
  namespace: string,
): Promise<ConfigDocument> {
  if (namespace === CONFIG_GIT_NAMESPACE)
    return documentOf(
      namespace,
      ConfigGitValueSchema.parse(await host.readGit()),
    );
  if (!isWritableNamespace(namespace)) throw notServed(namespace);
  if (namespace === 'appAdvisor')
    return documentOf(
      namespace,
      ConfigAppAdvisorValueSchema.parse(await host.readAppAdvisorSettings()),
    );
  return documentOf(
    namespace,
    preferenceValue(namespace, await host.readPreferences()),
  );
}

async function updateNamespace(
  host: CoreConfigHost,
  params: ConfigUpdateParams,
): Promise<ConfigDocument> {
  const unchanged = (value: ConfigValue): void => {
    if (catalogContentRevision(value) !== params.expectedRevision)
      throw new StaleNamespaceError();
  };
  try {
    if (params.namespace === 'appAdvisor') {
      const { patch } = params;
      for (const [key, days] of Object.entries(patch))
        if (typeof days === 'number' && days > MAX_ARCHIVE_RETENTION_DAYS)
          throw invalid(`${key} is at most ${MAX_ARCHIVE_RETENTION_DAYS}.`);
      const saved = await host.saveAppAdvisorSettings(patch, unchanged);
      return documentOf(
        params.namespace,
        ConfigAppAdvisorValueSchema.parse(saved),
      );
    }
    const { namespace } = params;
    const patch = await preferencePatch(
      host,
      params,
      await host.readPreferences(),
    );
    const saved = await host.savePreferences(patch, (latest) =>
      unchanged(preferenceValue(namespace, latest)),
    );
    const document = documentOf(namespace, preferenceValue(namespace, saved));
    return namespace === 'agent' &&
      saved.__managedDelegationRevocationIncomplete === true
      ? { ...document, managedDelegationRevocationIncomplete: true }
      : document;
  } catch (error) {
    if (error instanceof StaleNamespaceError)
      throw revisionConflict(params.namespace);
    throw error;
  }
}

/**
 * `core.config.get` and `core.config.update` on the desktop dispatcher, global
 * scope only: the read-only `git` namespace (CAN-5992) and the writable
 * namespaces (CAN-6004). An update names the revision it read and is checked
 * against the stored settings inside the commit that writes them.
 */
export function createCoreConfigAdapter(
  overrides: Partial<CoreConfigHost> = {},
): DesktopDomainAdapter {
  // A test replaces the stores it exercises; the rest stay the desktop's.
  const host: CoreConfigHost = { ...desktopConfigHost, ...overrides };
  const updates = new KeyedOutcomes<ConfigDocument>({ reusedError: reused });
  return {
    queries: {
      'core.config.get': async (params) => {
        if (
          params.scope &&
          Object.values(params.scope).some((value) => value !== undefined)
        )
          throw invalid('Desktop settings have no scope here.');
        return readNamespace(host, params.namespace);
      },
    },
    instructions: {
      'core.config.update': (params, context) =>
        updates.run(context, params, () => updateNamespace(host, params)),
    },
  };
}
