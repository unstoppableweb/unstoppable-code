import { CanopyOperationError } from '@canopy/core-runtime';
import { ORCHESTRATOR_LABEL } from '@canopy/protocol';
import {
  ConfigAccountProxyValueSchema,
  ConfigAgentValueSchema,
  ConfigAppAdvisorValueSchema,
  ConfigLedgerValueSchema,
  ConfigMemoryValueSchema,
  ConfigNavigationValueSchema,
  ConfigProfileValueSchema,
  type ConfigGetResult,
  type ConfigUpdateParams,
  type ConfigWritableNamespace,
} from '@canopy/protocol/canopy-core';
import {
  appAdvisorPurgeRetentionDays,
  resolveArchiveRetentionDays,
} from '@canopy/desktop-shared/lib/archive-retention';
import { launchAtLoginSatisfies } from '@canopy/desktop-shared/lib/launch-at-login';
import type {
  AppAdvisorAction,
  AppAdvisorActionError,
  AppAdvisorActionResponse,
  AppAdvisorJson,
  LaunchAtLoginSetResult,
} from '@canopy/desktop-shared/types';
import type { PersonConfirmation } from './advisor-records-actions';

/**
 * CAN-6004: App Advisor's settings actions, in Electron main through
 * `core.config.get` and `core.config.update`. A person confirms before
 * delegation widens (C1), before the account proxy's routing changes (C2),
 * and before memory or Feed recording turns off or archived chats are
 * deleted sooner (C3). Launch at sign-in is the OS's, through main's own
 * service, and the proxy status is read from its main owner.
 */
export const ADVISOR_SETTINGS_ACTION_TYPES = [
  'account_proxy.set_routing',
  'account_proxy.status',
  'app_advisor.update_settings',
  'settings.get_claude_max_turns',
  'settings.get_handoff_model',
  'settings.get_local_memory_model',
  'settings.set_claude_max_turns',
  'settings.set_handoff_model',
  'settings.set_launch_at_login',
  'settings.set_ledger_agent_recording_enabled',
  'settings.set_local_memory_enabled',
  'settings.set_local_memory_model',
  'settings.set_managed_delegation_max_depth',
  'settings.set_managed_delegation_mode',
  'settings.set_navigation_mode',
  'settings.set_profile_role',
  'settings.set_skill_suggestions_enabled',
] as const;

export type AdvisorSettingsAction = Extract<
  AppAdvisorAction,
  { type: (typeof ADVISOR_SETTINGS_ACTION_TYPES)[number] }
>;

export function isAdvisorSettingsAction(
  action: AppAdvisorAction,
): action is AdvisorSettingsAction {
  return ADVISOR_SETTINGS_ACTION_TYPES.some((type) => type === action.type);
}

/** `core.config.update` params without the request metadata the host adds. */
export type AdvisorConfigUpdate = ConfigUpdateParams extends infer Params
  ? Params extends { _meta: unknown }
    ? Omit<Params, '_meta'>
    : never
  : never;

/** The config operations and main's owners as the advisor chat; tests substitute them. */
export interface AdvisorSettingsActionHost {
  read(namespace: ConfigWritableNamespace): Promise<ConfigGetResult>;
  update(update: AdvisorConfigUpdate): Promise<ConfigGetResult>;
  setLaunchAtLogin(enabled: boolean): Promise<LaunchAtLoginSetResult>;
  accountProxyStatus(refresh: boolean): Promise<AppAdvisorJson>;
  /** One AskUserQuestion; only a person's answer can confirm. */
  confirm(
    question: string,
    options: { confirm: string; decline: string },
  ): Promise<PersonConfirmation>;
}

type Response = Omit<AppAdvisorActionResponse, 'requestId'>;

export const KEEP_SETTING = 'Cancel';
export const ALLOW_DELEGATION = 'Allow';
export const CHANGE_ROUTING = 'Change routing';
export const TURN_OFF = 'Turn off';
export const DELETE_SOONER = 'Delete sooner';

const DELEGATION_REACH = { off: 0, 'explicit-only': 1, proactive: 2 } as const;

function failure(
  code: AppAdvisorActionError['code'],
  message: string,
  retryable = false,
): Response {
  return { ok: false, error: { code, message, retryable } };
}

function refused(answer: Exclude<PersonConfirmation, 'confirmed'>): Response {
  return failure(
    'authorization_conflict',
    answer === 'declined'
      ? 'The person kept the setting as it is.'
      : 'Only a person can confirm this, and nobody did.',
  );
}

function operationFailure(error: unknown, fallback: string): Response {
  if (error instanceof CanopyOperationError) {
    switch (error.payload.kind) {
      case 'not_found':
        return failure('not_found', error.payload.message);
      case 'invalid_argument':
        return failure('invalid_payload', error.payload.message);
      case 'failed_precondition':
        return failure('surface_unavailable', error.payload.message);
      case 'conflict':
        return failure('execution_failed', error.payload.message, true);
      case 'permission_denied':
      case 'unauthenticated':
        return failure('authorization_conflict', error.payload.message);
      default:
        return failure('execution_failed', error.payload.message, true);
    }
  }
  return failure(
    'execution_failed',
    error instanceof Error && error.message ? error.message : fallback,
  );
}

async function agent(host: AdvisorSettingsActionHost): Promise<{
  revision: number;
  value: ReturnType<typeof ConfigAgentValueSchema.parse>;
}> {
  const read = await host.read('agent');
  return {
    revision: read.revision,
    value: ConfigAgentValueSchema.parse(read.value),
  };
}

async function memory(host: AdvisorSettingsActionHost): Promise<{
  revision: number;
  value: ReturnType<typeof ConfigMemoryValueSchema.parse>;
}> {
  const read = await host.read('memory');
  return {
    revision: read.revision,
    value: ConfigMemoryValueSchema.parse(read.value),
  };
}

function memoryModelResult(
  value: ReturnType<typeof ConfigMemoryValueSchema.parse>,
): Record<string, AppAdvisorJson> {
  return {
    localMemoryModel: value.model,
    localMemoryThinkingLevel: value.thinkingLevel,
    localMemoryModelSetByUser: value.modelSetByUser,
  };
}

/** C1: widening managed delegation asks a person; narrowing does not. */
async function setDelegation(
  action: Extract<
    AdvisorSettingsAction,
    {
      type:
        | 'settings.set_managed_delegation_mode'
        | 'settings.set_managed_delegation_max_depth';
    }
  >,
  host: AdvisorSettingsActionHost,
): Promise<Response> {
  const { revision, value } = await agent(host);
  const question =
    action.type === 'settings.set_managed_delegation_mode'
      ? DELEGATION_REACH[action.mode] >
        DELEGATION_REACH[value.managedDelegationMode]
        ? action.mode === 'proactive'
          ? 'Let agents hand work to subagents whenever they decide to? Each subagent is another agent working with your tools and files.'
          : 'Let agents hand work to subagents when you ask them to? Each subagent is another agent working with your tools and files.'
        : null
      : action.maxDepth > value.managedDelegationMaxDepth
        ? `Let subagents start their own subagents, up to ${action.maxDepth} levels deep? It's ${value.managedDelegationMaxDepth} now.`
        : null;
  if (question !== null) {
    const answer = await host.confirm(question, {
      confirm: ALLOW_DELEGATION,
      decline: KEEP_SETTING,
    });
    if (answer !== 'confirmed') return refused(answer);
  }
  const saved = await host.update({
    namespace: 'agent',
    expectedRevision: revision,
    patch:
      action.type === 'settings.set_managed_delegation_mode'
        ? { managedDelegationMode: action.mode }
        : { managedDelegationMaxDepth: action.maxDepth },
  });
  const next = ConfigAgentValueSchema.parse(saved.value);
  return action.type === 'settings.set_managed_delegation_mode'
    ? {
        ok: true,
        result: {
          managedDelegationMode: next.managedDelegationMode,
          revocationIncomplete:
            saved.managedDelegationRevocationIncomplete === true,
        },
      }
    : {
        ok: true,
        result: { managedDelegationMaxDepth: next.managedDelegationMaxDepth },
      };
}

/** C2: any change to where provider traffic goes asks a person. */
async function setRouting(
  action: Extract<AdvisorSettingsAction, { type: 'account_proxy.set_routing' }>,
  host: AdvisorSettingsActionHost,
): Promise<Response> {
  const read = await host.read('accountProxy');
  const value = ConfigAccountProxyValueSchema.parse(read.value);
  const onOff = (on: boolean): string => (on ? 'on' : 'off');
  const changes = [
    ...(action.claude !== undefined && action.claude !== value.routeClaude
      ? [`- Route Claude through the proxy: ${onOff(action.claude)}`]
      : []),
    ...(action.codex !== undefined && action.codex !== value.routeCodex
      ? [`- Route Codex through the proxy: ${onOff(action.codex)}`]
      : []),
    ...(action.keepChatOnOneAccount !== undefined &&
    action.keepChatOnOneAccount !== value.keepChatOnOneAccount
      ? [
          `- Keep each chat on one account: ${onOff(action.keepChatOnOneAccount)}`,
        ]
      : []),
  ];
  const patch = {
    ...(action.claude !== undefined ? { routeClaude: action.claude } : {}),
    ...(action.codex !== undefined ? { routeCodex: action.codex } : {}),
    ...(action.keepChatOnOneAccount !== undefined
      ? { keepChatOnOneAccount: action.keepChatOnOneAccount }
      : {}),
  };
  if (Object.keys(patch).length === 0)
    return failure('invalid_payload', 'Name at least one routing setting.');
  if (changes.length > 0) {
    const answer = await host.confirm(
      [
        'Change where the account proxy sends your provider traffic and credentials?',
        ...changes,
      ].join('\n'),
      { confirm: CHANGE_ROUTING, decline: KEEP_SETTING },
    );
    if (answer !== 'confirmed') return refused(answer);
  }
  const saved = ConfigAccountProxyValueSchema.parse(
    (
      await host.update({
        namespace: 'accountProxy',
        expectedRevision: read.revision,
        patch,
      })
    ).value,
  );
  return {
    ok: true,
    result: {
      ...(action.claude !== undefined
        ? { accountProxyRouteClaude: saved.routeClaude }
        : {}),
      ...(action.codex !== undefined
        ? { accountProxyRouteCodex: saved.routeCodex }
        : {}),
      ...(action.keepChatOnOneAccount !== undefined
        ? { accountProxyKeepChatOnOneAccount: saved.keepChatOnOneAccount }
        : {}),
    },
  };
}

/** C3: deleting archived chats sooner asks a person; keeping them longer does not. */
async function updateAdvisorSettings(
  action: Extract<
    AdvisorSettingsAction,
    { type: 'app_advisor.update_settings' }
  >,
  host: AdvisorSettingsActionHost,
): Promise<Response> {
  const read = await host.read('appAdvisor');
  const current = ConfigAppAdvisorValueSchema.parse(read.value);
  const patch = {
    ...(action.archiveRetentionDays !== undefined
      ? { archiveRetentionDays: action.archiveRetentionDays }
      : {}),
    ...(action.autoArchiveDays !== undefined
      ? { autoArchiveDays: action.autoArchiveDays }
      : {}),
  };
  if (Object.keys(patch).length === 0)
    return failure(
      'invalid_payload',
      'Name archiveRetentionDays or autoArchiveDays.',
    );
  // Two rules read the setting: App Advisor's purge keeps chats forever
  // while it is unset or not positive, and the archive sweep reads that as
  // its default window. Either one deleting sooner asks first.
  const nextRetention =
    action.archiveRetentionDays === undefined
      ? current.archiveRetentionDays
      : action.archiveRetentionDays;
  const purgeNow = appAdvisorPurgeRetentionDays(current.archiveRetentionDays);
  const purgeNext = appAdvisorPurgeRetentionDays(nextRetention);
  const sweepNow = resolveArchiveRetentionDays(
    'app-advisor',
    current.archiveRetentionDays,
  );
  const sweepNext = resolveArchiveRetentionDays('app-advisor', nextRetention);
  const reasons = [
    ...(purgeNext !== null && (purgeNow === null || purgeNext < purgeNow)
      ? [
          purgeNow === null
            ? `- Archived chats are deleted after ${purgeNext} days instead of kept.`
            : `- Archived chats are kept ${purgeNext} days instead of ${purgeNow}.`,
        ]
      : sweepNext < sweepNow
        ? [
            `- Archived chats are kept ${sweepNext} days instead of ${sweepNow}.`,
          ]
        : []),
    ...(action.autoArchiveDays !== undefined &&
    action.autoArchiveDays !== null &&
    (current.autoArchiveDays === null ||
      action.autoArchiveDays < current.autoArchiveDays)
      ? [
          current.autoArchiveDays === null
            ? `- Chats are deleted automatically after ${action.autoArchiveDays} days.`
            : `- Chats are deleted automatically after ${action.autoArchiveDays} days instead of ${current.autoArchiveDays}.`,
        ]
      : []),
  ];
  if (reasons.length > 0) {
    const answer = await host.confirm(
      [`Delete ${ORCHESTRATOR_LABEL} chats sooner?`, ...reasons].join('\n'),
      { confirm: DELETE_SOONER, decline: KEEP_SETTING },
    );
    if (answer !== 'confirmed') return refused(answer);
  }
  const saved = ConfigAppAdvisorValueSchema.parse(
    (
      await host.update({
        namespace: 'appAdvisor',
        expectedRevision: read.revision,
        patch,
      })
    ).value,
  );
  return {
    ok: true,
    result: {
      settings: {
        archiveRetentionDays: saved.archiveRetentionDays,
        autoArchiveDays: saved.autoArchiveDays,
      },
    },
  };
}

/** C3: turning recording off asks a person; turning it on does not. */
async function setRecording(
  action: Extract<
    AdvisorSettingsAction,
    {
      type:
        | 'settings.set_local_memory_enabled'
        | 'settings.set_ledger_agent_recording_enabled';
    }
  >,
  host: AdvisorSettingsActionHost,
): Promise<Response> {
  const isMemory = action.type === 'settings.set_local_memory_enabled';
  const read = await host.read(isMemory ? 'memory' : 'ledger');
  const enabledNow = isMemory
    ? ConfigMemoryValueSchema.parse(read.value).enabled
    : ConfigLedgerValueSchema.parse(read.value).agentRecordingEnabled;
  if (enabledNow && !action.enabled) {
    const answer = await host.confirm(
      isMemory
        ? 'Turn off local memory? Agents stop saving what they learn, and what is saved stops being used in chats.'
        : 'Turn off Feed recording for agents? Their work is no longer recorded in the Feed.',
      { confirm: TURN_OFF, decline: KEEP_SETTING },
    );
    if (answer !== 'confirmed') return refused(answer);
  }
  const saved = isMemory
    ? await host.update({
        namespace: 'memory',
        expectedRevision: read.revision,
        patch: { enabled: action.enabled },
      })
    : await host.update({
        namespace: 'ledger',
        expectedRevision: read.revision,
        patch: { agentRecordingEnabled: action.enabled },
      });
  return isMemory
    ? {
        ok: true,
        result: {
          localMemoryEnabled: ConfigMemoryValueSchema.parse(saved.value)
            .enabled,
        },
      }
    : {
        ok: true,
        result: {
          ledgerAgentRecordingEnabled: ConfigLedgerValueSchema.parse(
            saved.value,
          ).agentRecordingEnabled,
        },
      };
}

async function setLaunchAtLogin(
  enabled: boolean,
  host: AdvisorSettingsActionHost,
): Promise<Response> {
  const result = await host.setLaunchAtLogin(enabled);
  if (!result.ok && result.reason === 'unsupported')
    return failure(
      'missing_capability',
      'Launch at sign-in is only available in the installed app on macOS and Windows.',
    );
  if (!result.ok) {
    const { status } = result;
    const kept = launchAtLoginSatisfies(status, true) ? 'on' : 'off';
    let message = `The system kept launch at sign-in ${kept}.`;
    if (status.pendingApproval) {
      message = `The system kept launch at sign-in ${kept} while it waits for approval in System Settings.`;
    } else if (status.platform === 'win32' && enabled) {
      message = `${message} It may be turned off in Startup apps.`;
    }
    return failure('execution_failed', message);
  }
  return {
    ok: true,
    result: {
      launchAtLogin: {
        enabled: result.status.enabled,
        pendingApproval: result.status.pendingApproval,
      },
    },
  };
}

async function run(
  action: AdvisorSettingsAction,
  host: AdvisorSettingsActionHost,
): Promise<Response> {
  switch (action.type) {
    case 'settings.get_claude_max_turns': {
      const { value } = await agent(host);
      return { ok: true, result: { claudeMaxTurns: value.claudeMaxTurns } };
    }
    case 'settings.set_claude_max_turns': {
      const { revision } = await agent(host);
      const saved = await host.update({
        namespace: 'agent',
        expectedRevision: revision,
        patch: { claudeMaxTurns: action.maxTurns },
      });
      return {
        ok: true,
        result: {
          claudeMaxTurns: ConfigAgentValueSchema.parse(saved.value)
            .claudeMaxTurns,
        },
      };
    }
    case 'settings.get_handoff_model': {
      const { value } = await agent(host);
      return {
        ok: true,
        result: {
          handoffSummaryModel: value.handoffSummaryModel,
          handoffSummaryThinkingLevel: value.handoffSummaryThinkingLevel,
        },
      };
    }
    case 'settings.set_handoff_model': {
      const { revision } = await agent(host);
      const saved = ConfigAgentValueSchema.parse(
        (
          await host.update({
            namespace: 'agent',
            expectedRevision: revision,
            patch: {
              handoffSummaryModel: action.model,
              ...(action.thinkingLevel !== undefined
                ? { handoffSummaryThinkingLevel: action.thinkingLevel }
                : {}),
            },
          })
        ).value,
      );
      return {
        ok: true,
        result: {
          handoffSummaryModel: saved.handoffSummaryModel,
          handoffSummaryThinkingLevel: saved.handoffSummaryThinkingLevel,
        },
      };
    }
    case 'settings.get_local_memory_model':
      return {
        ok: true,
        result: memoryModelResult((await memory(host)).value),
      };
    case 'settings.set_local_memory_model': {
      const { revision } = await memory(host);
      const saved = await host.update({
        namespace: 'memory',
        expectedRevision: revision,
        patch: {
          model: action.model,
          ...(action.thinkingLevel !== undefined
            ? { thinkingLevel: action.thinkingLevel }
            : {}),
        },
      });
      return {
        ok: true,
        result: memoryModelResult(ConfigMemoryValueSchema.parse(saved.value)),
      };
    }
    case 'settings.set_local_memory_enabled':
    case 'settings.set_ledger_agent_recording_enabled':
      return setRecording(action, host);
    case 'settings.set_managed_delegation_mode':
    case 'settings.set_managed_delegation_max_depth':
      return setDelegation(action, host);
    case 'settings.set_navigation_mode': {
      const read = await host.read('navigation');
      const saved = await host.update({
        namespace: 'navigation',
        expectedRevision: read.revision,
        patch: { mode: action.mode },
      });
      return {
        ok: true,
        result: {
          navigationMode: ConfigNavigationValueSchema.parse(saved.value).mode,
        },
      };
    }
    case 'settings.set_profile_role': {
      const read = await host.read('profile');
      const saved = ConfigProfileValueSchema.parse(
        (
          await host.update({
            namespace: 'profile',
            expectedRevision: read.revision,
            patch: {
              role: action.role,
              ...(action.roleDetail !== undefined
                ? { roleDetail: action.roleDetail }
                : {}),
            },
          })
        ).value,
      );
      // What was stored, not what was asked: the store trims and clamps.
      return {
        ok: true,
        result: {
          profileRole: saved.role,
          profileRoleDetail: saved.roleDetail,
        },
      };
    }
    case 'settings.set_skill_suggestions_enabled': {
      const read = await host.read('profile');
      const saved = await host.update({
        namespace: 'profile',
        expectedRevision: read.revision,
        patch: { skillSuggestionsEnabled: action.enabled },
      });
      return {
        ok: true,
        result: {
          skillSuggestionsEnabled: ConfigProfileValueSchema.parse(saved.value)
            .skillSuggestionsEnabled,
        },
      };
    }
    case 'settings.set_launch_at_login':
      return setLaunchAtLogin(action.enabled, host);
    case 'account_proxy.set_routing':
      return setRouting(action, host);
    case 'account_proxy.status':
      return {
        ok: true,
        result: {
          value: await host.accountProxyStatus(action.refresh === true),
        },
      };
    case 'app_advisor.update_settings':
      return updateAdvisorSettings(action, host);
  }
}

export async function dispatchAdvisorSettingsAction(
  action: AdvisorSettingsAction,
  host: AdvisorSettingsActionHost,
): Promise<Response> {
  try {
    return await run(action, host);
  } catch (error) {
    return operationFailure(error, 'The settings action failed.');
  }
}
