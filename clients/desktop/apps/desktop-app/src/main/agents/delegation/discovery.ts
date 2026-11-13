import { isOpenCodeHarnessEnabled } from '../../opencode/feature-flag';
import { delegationRuntimeUnavailableReason } from './runtime-support';
import { isCopilotHarnessEnabled } from '../../copilot/feature-flag';
import { peekCursorAccount } from '../../cursor/connection';
import { readPreferencesFile } from '../../lib/preferences-store';
import type {
  DelegationModelChoice,
  DelegationModelDiscovery,
} from '@canopy/protocol/delegation/discovery';
import { discoverDelegationModels } from '@canopy/desktop-shared/node/delegation/discovery';
import { resolveAnthropicMockEnvOverride } from '@canopy/execution-engine/node/e2e-mock-env';
import {
  getAuthoritativeConfiguredModel,
  listAuthoritativeConfiguredModels,
} from '../../lib/model-config';
import { isModelBlockedByStoredPolicy } from '../../lib/model-policy-state';
import {
  peekFreshProviderNativeAuthAvailability,
  peekProviderAccountIdentity,
} from '../../auth/provider-auth-state';
import { resolveCodexRuntimeEnvironmentProfile } from '../../lib/user-environment-runtime';
import { resolveAiCreditsRoutingAttempt } from '../ai-credits-routing';
import { listAgentModels } from '../agent-model-store';
import { resolveAgentModelRuntime } from '../agent-model-runtime';
import type { AgentSessionOptions } from '../types';
import { resolveSessionWorkOwner } from '../work-owner';
import { materializeDelegationAgentPlugins } from './agent-projection';
import { delegationAgentCapabilityError } from './agent-capability-error';
import { isDelegationModelRejected } from './model-rejections';
import {
  DELEGATION_FILE_HELPER_MISSING_MESSAGE,
  delegationFileBoundaryAvailable,
  openDelegationFiles,
} from './file-process';

const capabilities = [
  'read',
  'search',
  'write',
  'resume',
  'follow_up',
  'worktree',
  'progress',
  'usage',
  'cancel',
  'foreground',
  'background',
];

/** Never mints a billing route, starts a provider, materializes Agent artifacts or opens auth UI. */
export async function discoverManagedDelegationModels(
  owner: AgentSessionOptions,
  signal?: AbortSignal,
): Promise<DelegationModelDiscovery> {
  const workOwner = await resolveSessionWorkOwner(owner);
  const baseModels = listAuthoritativeConfiguredModels();
  const agents = await listAgentModels();
  const boundary = await delegationFileBoundaryAvailable();
  const environment = resolveCodexRuntimeEnvironmentProfile({
    runtime: 'agent',
    workspaceId: owner.projectId,
  }).environment;
  const nativeAuth = peekFreshProviderNativeAuthAvailability();
  return discoverDelegationModels({
    modelIds: [
      ...baseModels
        .filter((model) => model.selectable || !model.enabled)
        .map((model) => model.id),
      ...agents.map((agent) => agent.id),
    ],
    preferredModelId: owner.selectedModel ?? owner.model,
    signal,
    inspect: async (id): Promise<DelegationModelChoice> => {
      let choice: DelegationModelChoice = {
        modelId: id,
        label:
          baseModels.find((model) => model.id === id)?.label ??
          agents.find((agent) => agent.id === id)?.name ??
          id,
        harnessId: '',
        runtimeKind: '',
        capabilities: [],
        supportedThinkingLevels: [],
        availability: 'unavailable',
        authState: 'unknown',
        disabledReason: 'The model route is unavailable.',
      };
      const configuredModel = getAuthoritativeConfiguredModel(id);
      if (configuredModel && !configuredModel.enabled) {
        const harness = configuredModel.defaultHarness;
        return {
          ...choice,
          harnessId: harness,
          runtimeKind:
            harness === 'opencode'
              ? 'opencode-acp'
              : harness === 'copilot'
                ? 'copilot-sdk'
                : harness === 'cursor'
                  ? 'cursor-acp'
                  : harness === 'claude'
                    ? 'claude-sdk'
                    : 'codex-app-server',
          capabilities,
          supportedThinkingLevels:
            configuredModel.supportedThinkingLevels.filter(
              (level) => level !== 'ultra',
            ),
          disabledReason: 'This model is disabled.',
        };
      }
      try {
        const runtime = await resolveAgentModelRuntime({
          model: id,
          inheritDefaultFrom: { projectId: owner.projectId },
        });
        const model = getAuthoritativeConfiguredModel(runtime.runtimeModel);
        const harness = runtime.executionHarness;
        choice = {
          ...choice,
          harnessId: harness,
          runtimeKind:
            harness === 'opencode'
              ? 'opencode-acp'
              : harness === 'copilot'
                ? 'copilot-sdk'
                : harness === 'cursor'
                  ? 'cursor-acp'
                  : harness === 'claude'
                    ? 'claude-sdk'
                    : 'codex-app-server',
          capabilities,
          supportedThinkingLevels:
            model?.supportedThinkingLevels.filter(
              (level) => level !== 'ultra',
            ) ?? [],
        };
        const disabled = (reason: string): DelegationModelChoice => ({
          ...choice,
          disabledReason: reason,
        });
        if (!model?.enabled) return disabled('This model is disabled.');
        if (await isModelBlockedByStoredPolicy(runtime.runtimeModel, workOwner))
          return disabled('This model is blocked by organization policy.');
        if (!boundary) return disabled(DELEGATION_FILE_HELPER_MISSING_MESSAGE);
        if (runtime.providerType === 'ollama')
          return disabled(
            'A validated delegated runner is unavailable for this route.',
          );
        const runtimeUnavailable =
          await delegationRuntimeUnavailableReason(harness);
        if (runtimeUnavailable) return disabled(runtimeUnavailable);
        if (runtime.pluginSelections) {
          const discoverySignal = signal ?? new AbortController().signal;
          await materializeDelegationAgentPlugins(
            runtime.pluginSelections,
            (directory) => openDelegationFiles(directory, discoverySignal),
            harness,
          );
        }
        if (harness === 'opencode') {
          if (
            !isOpenCodeHarnessEnabled() ||
            !(await readPreferencesFile()).opencodeEnabled
          )
            return disabled('Connect OpenCode in Settings.');
          return {
            ...choice,
            availability: 'unknown',
            authState: 'unknown',
            disabledReason:
              'OpenCode model access will be validated at launch.',
          };
        }
        if (harness === 'copilot') {
          if (
            !isCopilotHarnessEnabled() ||
            !(await readPreferencesFile()).copilotEnabled
          )
            return disabled('Connect Copilot in Settings.');
          return {
            ...choice,
            availability: 'unknown',
            authState: 'unknown',
            disabledReason:
              'Copilot authentication will be validated at launch.',
          };
        }
        if (harness === 'cursor') {
          if (!(await readPreferencesFile()).cursorEnabled)
            return disabled('Connect Cursor in Settings.');
          const account = peekCursorAccount();
          return {
            ...choice,
            availability: account
              ? 'available'
              : account === null
                ? 'unavailable'
                : 'unknown',
            authState: account ? 'ready' : 'unknown',
            disabledReason: account
              ? undefined
              : 'Cursor authentication will be validated at launch.',
          };
        }
        if (resolveAnthropicMockEnvOverride())
          return {
            ...choice,
            availability: 'available',
            authState: 'ready',
            disabledReason: undefined,
          };
        const cachedNativeAuth =
          harness === 'claude' ? nativeAuth.claude : nativeAuth.codex;
        // Discovery is advisory and must never cold-start an auth CLI or Codex
        // app-server. Treat a cold/expired cache as native until the explicit
        // availability projection below can report it as unknown; this also
        // prevents the billing resolver from inferring no-native-auth from a
        // cache miss. Launch-time validation performs the authoritative probe.
        const auth = (): Promise<boolean> =>
          Promise.resolve(cachedNativeAuth ?? true);
        const routing = await resolveAiCreditsRoutingAttempt(
          owner.aiCreditsRouting,
          runtime.providerType,
          auth,
          owner.subscriptionBillingOverride,
        );
        // Credit/org routes need launch-time authorization. Do not advertise native readiness
        // or allocate an ephemeral route simply to populate discovery.
        if (
          model.modelSource === 'ai-gateway' ||
          (routing && routing.reason !== 'no-native-auth')
        )
          return {
            ...choice,
            availability: 'unknown',
            disabledReason:
              'The configured billing route will be validated at launch.',
          };
        const value = (key: string): string | undefined =>
          environment[key] ?? process.env[key];
        if (
          harness === 'codex' &&
          (value('OPENAI_API_KEY') || value('OPENAI_BASE_URL'))
        )
          return disabled(
            'This restricted runner does not support an environment-only API route.',
          );
        const credential =
          harness === 'claude' &&
          Boolean(value('ANTHROPIC_API_KEY') || value('ANTHROPIC_AUTH_TOKEN'));
        const ready: boolean | undefined =
          credential ||
          (harness === 'claude' && value('ANTHROPIC_BASE_URL')
            ? false
            : cachedNativeAuth);
        // The signed-in account's plan can exclude a configured model; a
        // launch the provider refused for this account is remembered.
        if (
          harness === 'codex' &&
          ready !== false &&
          isDelegationModelRejected({
            accountKey:
              peekProviderAccountIdentity('codex')?.providerAccountKey,
            modelId: runtime.runtimeModel,
          })
        )
          return {
            ...choice,
            availability: 'unavailable',
            authState: ready ? 'ready' : 'unknown',
            disabledReason:
              'This model is not available for the signed-in account.',
          };
        if (ready === undefined)
          return {
            ...choice,
            availability: 'unknown',
            disabledReason:
              'Provider authentication will be validated at launch.',
          };
        return {
          ...choice,
          availability: ready ? 'available' : 'unavailable',
          authState: ready ? 'ready' : 'required',
          disabledReason: ready
            ? undefined
            : 'Sign in to the selected provider before delegating.',
        };
      } catch (error) {
        const capabilityError = delegationAgentCapabilityError(error);
        return capabilityError
          ? { ...choice, disabledReason: capabilityError.publicMessage }
          : choice;
      }
    },
  });
}
