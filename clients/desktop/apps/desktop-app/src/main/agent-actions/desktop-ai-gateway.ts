import type { SendableBrowserWindow } from '../lib/window-send';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type {
  AiGatewayAction,
  AgentActionCall,
  AgentJson,
} from '@canopy/agent-actions';
import {
  gatewayModelsSchema,
  personalAiGatewayConfigSchema,
  personalAiGatewayUseInCloudChatsSchema,
  type AiGatewayScope,
  type PersonalAiGatewayConfig,
} from '@canopy/protocol/model-gateway';
import {
  aiGatewayConnectionResultSchema,
  suggestGatewayModel,
  type AiGatewayConnectionResult,
  type DiscoveredGatewayModel,
} from '@canopy/protocol/model-gateway/discovery';
import { matchAiGatewayPreset } from '@canopy/protocol/model-gateway/presets';
import { MODEL_GATEWAY_MAX_MODELS } from '@canopy/protocol/canopy-server';
import { organizationConfigDetailSchema } from '@canopy/protocol/settings/organization';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import type { CanopyInjectedToolRuntime } from '../canopy-tools/core';
import { acquireSettingsBridgeSession } from '../canopy-cloud/settings-session';
import { executeSettingsOperation } from '../canopy-cloud/settings-client';
import {
  readCanopyCloudAccountWithStatus,
  subscribeCanopyCloudAccountChanges,
} from '../lib/canopy-cloud-account-store';
import { aiGatewaySettingsAvailable } from '../services/ai-gateway-availability';
import {
  authorizeDesktopGatewayScope,
  connectDesktopGateway,
  connectDeviceGateway,
} from '../services/ai-gateway-settings';
import { requestApprovalDecision } from '../approvals/prompt-bridge';
import { requestSecretInputApproval } from '../approvals/secret-input';
import { cancelApproval } from '../approvals/pending-approvals';
import { accountUsesDeviceModelGateway } from '@canopy/desktop-shared/lib/org-model-gateway';
import type { CanopyCloudAccountEntry } from '../lib/canopy-cloud-account-store';
import {
  getLocalModelGatewayOrganizationId,
  LOCAL_MODEL_GATEWAY_ACCOUNT_ID,
  readLocalModelGateway,
  updateLocalModelGateway,
} from '../lib/local-model-gateway-store';
import {
  isModelGatewayUsedOnThisComputer,
  setModelGatewayUsedOnThisComputer,
} from '../lib/model-gateway-device-use';

interface DiscoveryReceipt {
  accountId: string;
  organizationId: string;
  baseUrl: string;
  sessionKey: string;
  expiresAt: number;
  models: DiscoveredGatewayModel[];
}
const discoveries = new Map<string, DiscoveryReceipt>();
function json(value: unknown): AgentJson {
  return z.json().parse(JSON.parse(JSON.stringify(value)));
}

type GatewayIntent = 'read' | 'connect' | 'update';
type GatewayPatch = Extract<
  AiGatewayAction,
  { type: 'settings.ai_gateway.update' }
>['patch'];

interface GatewayRead {
  gateway: PersonalAiGatewayConfig | null;
  /** Hosted Personal only: where the gateway is used. */
  useOn?: { useInCloudChats: boolean; useOnThisComputer: boolean };
}

/**
 * Where one action's gateway lives. The approval flow is the same for both;
 * only storage differs: the account's hosted gateway, or the device gateway
 * while the account names no Personal organization.
 */
interface GatewayBackend {
  readonly accountId: string;
  readonly organizationId: string;
  readonly scope: AiGatewayScope;
  authorize(intent: GatewayIntent): Promise<void>;
  /** Abort when the account, Personal organization or device scope changes. */
  onScopeChange(abort: () => void): () => void;
  readConfig(signal: AbortSignal): Promise<GatewayRead>;
  connect(
    input: { baseUrl: string; apiKey?: string },
    signal: AbortSignal,
  ): Promise<AiGatewayConnectionResult>;
  write(input: {
    expectedRevision: string;
    patch: Omit<GatewayPatch, 'addDiscovered' | 'useOnThisComputer'>;
    models: PersonalAiGatewayConfig['models'];
    replaceModels: boolean;
  }): Promise<void>;
}

async function hostedGatewayBackend(
  action: AiGatewayAction,
  account: CanopyCloudAccountEntry,
): Promise<GatewayBackend> {
  const accountId = account.account?.id;
  if (!accountId) throw new Error('Signed-in account required');
  const organizationId =
    action.scope.kind === 'organization'
      ? action.scope.organizationId
      : 'expectedOrganizationId' in action.scope
        ? action.scope.expectedOrganizationId
        : account.personalOrganizationId;
  if (!organizationId) throw new Error('Personal organization unavailable');
  const scope: AiGatewayScope =
    action.scope.kind === 'personal'
      ? { kind: 'personal', expectedOrganizationId: organizationId }
      : { kind: 'organization', organizationId };
  const session = await acquireSettingsBridgeSession(accountId);
  await session.ensureReady({ userInitiated: true });
  return {
    accountId,
    organizationId,
    scope,
    authorize: async (intent) => {
      await authorizeDesktopGatewayScope(session, scope, intent);
    },
    onScopeChange: (abort) =>
      subscribeCanopyCloudAccountChanges((next) => {
        if (
          next?.account?.id !== accountId ||
          (scope.kind === 'personal' &&
            next.personalOrganizationId !== organizationId)
        )
          abort();
      }),
    readConfig: async (signal) => {
      if (scope.kind === 'personal') {
        const value = await executeSettingsOperation(
          session,
          'account.settings.ai-gateway.read',
          {},
          { signal },
        );
        const read = z
          .object({
            gateway: personalAiGatewayConfigSchema.nullable(),
            useInCloudChats: personalAiGatewayUseInCloudChatsSchema,
          })
          .parse(value);
        return {
          gateway: read.gateway,
          useOn: {
            useInCloudChats: read.useInCloudChats,
            useOnThisComputer:
              await isModelGatewayUsedOnThisComputer(organizationId),
          },
        };
      }
      const value = organizationConfigDetailSchema.parse(
        await executeSettingsOperation(
          session,
          'organization.settings.config',
          { organizationId },
          { signal },
        ),
      );
      return {
        gateway: {
          organizationId,
          displayName: value.modelGatewayDisplayName ?? null,
          baseUrl: value.modelGatewayBaseUrl,
          models: value.modelGatewayModels,
          enabled: value.enforceMemberModelGateway,
          onlyThisGateway: value.modelGatewayEnforced,
          promptCachePassthrough: value.modelGatewayPromptCachePassthrough,
          revision: value.modelGatewayRevision ?? 'absent',
        },
      };
    },
    connect: (input, signal) =>
      scope.kind === 'personal'
        ? connectDesktopGateway(
            session,
            'account.settings.ai-gateway.connect',
            { expectedOrganizationId: organizationId, ...input },
            signal,
          )
        : connectDesktopGateway(
            session,
            'organization.settings.ai-gateway.connect',
            { organizationId, ...input },
            signal,
          ),
    write: async ({ expectedRevision, patch, models, replaceModels }) => {
      const service = (
        await import('../services/account-organization-settings-host')
      ).getAccountOrganizationSettingsService();
      const result =
        scope.kind === 'personal'
          ? await service.write({
              accountId,
              operation: 'account.settings.ai-gateway.update',
              input: {
                expectedOrganizationId: organizationId,
                expectedRevision,
                ...patch,
                ...(replaceModels ? { models } : {}),
              },
            })
          : await service.write({
              accountId,
              operation: 'organization.settings.policies.update',
              input: {
                organizationId,
                expectedModelGatewayRevision: expectedRevision,
                ...(patch.displayName === undefined
                  ? {}
                  : { modelGatewayDisplayName: patch.displayName }),
                ...(patch.baseUrl === undefined
                  ? {}
                  : { modelGatewayBaseUrl: patch.baseUrl }),
                ...(patch.models === undefined && !replaceModels
                  ? {}
                  : { modelGatewayModels: models }),
                ...(patch.enabled === undefined
                  ? {}
                  : { enforceMemberModelGateway: patch.enabled }),
                ...(patch.onlyThisGateway === undefined
                  ? {}
                  : { modelGatewayEnforced: patch.onlyThisGateway }),
                ...(patch.promptCachePassthrough === undefined
                  ? {}
                  : {
                      modelGatewayPromptCachePassthrough:
                        patch.promptCachePassthrough,
                    }),
              },
            });
      if (!result.ok) throw new Error('Gateway update failed');
    },
  };
}

/** The device gateway: Personal scope only, with nothing sent off the device. */
async function deviceGatewayBackend(
  action: AiGatewayAction,
): Promise<GatewayBackend> {
  if (action.scope.kind !== 'personal')
    throw new Error('Signed-in account required');
  const organizationId = await getLocalModelGatewayOrganizationId();
  if (
    'expectedOrganizationId' in action.scope &&
    action.scope.expectedOrganizationId !== organizationId
  )
    throw new Error('Stale gateway scope');
  const requireDeviceScope = async (): Promise<void> => {
    const read = await readCanopyCloudAccountWithStatus();
    if (read.status !== 'ok' || !accountUsesDeviceModelGateway(read.entry))
      throw new Error('Stale gateway scope');
  };
  return {
    accountId: LOCAL_MODEL_GATEWAY_ACCOUNT_ID,
    organizationId,
    scope: { kind: 'personal', expectedOrganizationId: organizationId },
    authorize: requireDeviceScope,
    onScopeChange: (abort) =>
      subscribeCanopyCloudAccountChanges((next) => {
        if (!accountUsesDeviceModelGateway(next)) abort();
      }),
    readConfig: async () => ({ gateway: await readLocalModelGateway() }),
    connect: (input, signal) =>
      connectDeviceGateway(
        { expectedOrganizationId: organizationId, ...input },
        signal,
      ),
    write: async ({ expectedRevision, patch, models, replaceModels }) => {
      await requireDeviceScope();
      await updateLocalModelGateway({
        expectedOrganizationId: organizationId,
        expectedRevision,
        ...patch,
        ...(replaceModels ? { models } : {}),
      });
    },
  };
}

export async function executeDesktopAiGateway(
  action: AiGatewayAction,
  call: AgentActionCall<CanopyInjectedToolRuntime>,
): Promise<AgentJson> {
  if (!aiGatewaySettingsAvailable())
    throw new Error('AI gateway setup unavailable');
  const read = await readCanopyCloudAccountWithStatus();
  if (read.status !== 'ok') throw new Error('Signed-in account required');
  // Only the Personal scope can be the device gateway. An organization's
  // gateway stays hosted, including before the Personal id arrives.
  const useDevice =
    action.scope.kind === 'personal' &&
    accountUsesDeviceModelGateway(read.entry);
  let backend: GatewayBackend;
  if (useDevice) backend = await deviceGatewayBackend(action);
  else if (read.entry) backend = await hostedGatewayBackend(action, read.entry);
  else throw new Error('Signed-in account required');
  const { accountId, organizationId, scope } = backend;
  const intent: GatewayIntent = action.type.endsWith('.get')
    ? 'read'
    : action.type.endsWith('.update')
      ? 'update'
      : 'connect';
  await backend.authorize(intent);
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  call.signal?.addEventListener('abort', abort, { once: true });
  if (call.signal?.aborted) abort();
  const expires = setTimeout(abort, 120_000);
  const stopAccountWatch = backend.onScopeChange(abort);
  const signal = controller.signal;
  const identity = call.scope;
  const sessionKey = identity
    ? `${identity.workspaceId}/${identity.worktreeId}/${identity.chatId}`
    : '';
  const getWindow = (): SendableBrowserWindow | null =>
    call.host.worktreeActionRuntime?.getWindow() ??
    call.host.settingsWindow?.() ??
    null;
  const readConfig = (): Promise<GatewayRead> => backend.readConfig(signal);
  try {
    signal.throwIfAborted();
    if (action.type === 'settings.ai_gateway.get') {
      const { gateway, useOn } = await readConfig();
      await backend.authorize('read');
      signal.throwIfAborted();
      return json({ scope, gateway, ...useOn });
    }
    if (!identity || !getWindow()) return { status: 'key_required' };
    const event = {
      projectId: identity.workspaceId,
      worktreeId: identity.worktreeId,
      chatId: identity.chatId,
      provider: 'claude' as const,
      ...(call.toolUseId ? { toolUseId: call.toolUseId } : {}),
    };
    if (action.type === 'settings.ai_gateway.connect') {
      const host = new URL(action.baseUrl).hostname;
      const result = await requestSecretInputApproval({
        sessionKey,
        signal,
        getWindow,
        event: {
          ...event,
          title: `Connect AI gateway ${host}?`,
          details: { kind: 'tool', toolName: 'settings.ai_gateway.connect' },
        },
        consume: async (secret) => {
          signal.throwIfAborted();
          await backend.authorize(intent);
          return aiGatewayConnectionResultSchema.parse(
            await backend.connect(
              {
                baseUrl: action.baseUrl,
                ...(secret ? { apiKey: secret } : {}),
              },
              signal,
            ),
          );
        },
      });
      if (!result) return { status: 'key_required' };
      if (result.status !== 'connected') return json(result);
      signal.throwIfAborted();
      const discoveryId = randomUUID();
      for (const [id, receipt] of discoveries)
        if (receipt.expiresAt < Date.now() || receipt.accountId !== accountId)
          discoveries.delete(id);
      if (discoveries.size >= 64) discoveries.clear();
      discoveries.set(discoveryId, {
        accountId,
        organizationId,
        sessionKey,
        baseUrl: result.baseUrl,
        models: result.models,
        expiresAt: Date.now() + 5 * 60_000,
      });
      return json({ ...result, discoveryId });
    }
    const { gateway: current, useOn } = await readConfig();
    if ((current?.revision ?? 'absent') !== action.expectedRevision)
      throw new Error('Stale gateway revision');
    const { addDiscovered, useOnThisComputer, ...patch } = action.patch;
    if (
      !useOn &&
      (patch.useInCloudChats !== undefined || useOnThisComputer !== undefined)
    )
      throw new Error('Signed-in account required');
    const baseUrl =
      patch.baseUrl === undefined ? (current?.baseUrl ?? null) : patch.baseUrl;
    let models = patch.models ?? current?.models ?? [];
    let reusedReceipt: DiscoveryReceipt | undefined;
    if (addDiscovered) {
      const receipt = action.discoveryId
        ? discoveries.get(action.discoveryId)
        : undefined;
      if (
        !receipt ||
        receipt.accountId !== accountId ||
        receipt.organizationId !== organizationId ||
        receipt.sessionKey !== sessionKey ||
        receipt.baseUrl !== baseUrl ||
        receipt.expiresAt < Date.now()
      )
        throw new Error('Stale gateway discovery');
      reusedReceipt = receipt;
      models = [...models];
      let adding = receipt.models.filter(
        (discovered) =>
          !models.some((model) => model.gatewayId === discovered.id),
      );
      // Discovery lists whole catalogs, but a gateway saves at most
      // MODEL_GATEWAY_MAX_MODELS: a preset falls back to its suggestions.
      if (models.length + adding.length > MODEL_GATEWAY_MAX_MODELS) {
        const room = Math.max(0, MODEL_GATEWAY_MAX_MODELS - models.length);
        const pending = adding;
        adding = (
          matchAiGatewayPreset(receipt.baseUrl)?.suggestedModelIds ?? []
        )
          .flatMap((id) => pending.filter((discovered) => discovered.id === id))
          .slice(0, room);
        if (adding.length === 0)
          throw new Error(
            `Too many models to add: the gateway lists ${receipt.models.length} and a gateway can have up to ${MODEL_GATEWAY_MAX_MODELS}. Pass explicit models.`,
          );
      }
      for (const discovered of adding)
        models.push(suggestGatewayModel(discovered, models, organizationId));
    }
    models = gatewayModelsSchema.parse(models);
    const enabled = patch.enabled ?? current?.enabled ?? false;
    const only = patch.onlyThisGateway ?? current?.onlyThisGateway ?? false;
    if (enabled && (!baseUrl || models.length === 0))
      throw new Error('Select a model before enabling');
    if (
      only &&
      (patch.useInCloudChats === false || useOnThisComputer === false)
    )
      throw new Error('Use only my AI gateway applies everywhere');
    // Clearing the URL of a configured gateway removes it, so say so rather
    // than "Save AI gateway with 0 models". Removal implies disabling, so
    // that change isn't listed; any other policy change still shows.
    const removing = baseUrl === null && Boolean(current?.baseUrl);
    const useOnChanges = [
      ...(patch.useInCloudChats === undefined ||
      patch.useInCloudChats === useOn?.useInCloudChats
        ? []
        : [
            patch.useInCloudChats
              ? 'use in cloud chats'
              : "don't use in cloud chats",
          ]),
      ...(useOnThisComputer === undefined ||
      useOnThisComputer === useOn?.useOnThisComputer
        ? []
        : [
            useOnThisComputer
              ? 'use on this computer'
              : "don't use on this computer",
          ]),
    ];
    const policyChanges = [
      ...(patch.enabled === undefined || (removing && !enabled)
        ? []
        : [enabled ? 'enable AI gateway' : 'disable AI gateway']),
      ...(patch.onlyThisGateway === undefined
        ? enabled && only
          ? ['use only this gateway']
          : []
        : [
            only
              ? 'use only this gateway when enabled'
              : 'allow other providers',
          ]),
      ...useOnChanges,
    ];
    const title =
      removing && current?.baseUrl
        ? `Remove AI gateway ${new URL(current.baseUrl).hostname}${policyChanges.length ? `; ${policyChanges.join('; ')}` : ''}?`
        : `Save ${baseUrl ? new URL(baseUrl).hostname : 'AI gateway'} with ${models.length} models${policyChanges.length ? `; ${policyChanges.join('; ')}` : ''}?`;
    let approvalId: string | undefined;
    const cancel = (): void => {
      if (approvalId) cancelApproval(approvalId, 'gateway_update_cancelled');
    };
    signal.addEventListener('abort', cancel, { once: true });
    let approved = false;
    try {
      const result = await requestApprovalDecision({
        sessionKey,
        getWindow,
        timeoutMs: 120_000,
        event: {
          ...event,
          title,
          details: {
            kind: 'tool',
            toolName: 'settings.ai_gateway.update',
            inputSummary: title,
          },
        },
        // No tool policy applies to this prompt: a policy change shows it
        // again at the new revision and never decides it (CAN-4129).
        revalidate: () => Promise.resolve('prompt'),
        onRegistered: (id) => {
          approvalId = id;
          if (signal.aborted) cancel();
        },
      });
      approved =
        result.kind === 'decision' && result.decision.behavior === 'allow';
    } finally {
      signal.removeEventListener('abort', cancel);
    }
    if (!approved) return { status: 'denied' };
    signal.throwIfAborted();
    await backend.authorize(intent);
    signal.throwIfAborted();
    if (reusedReceipt && reusedReceipt.expiresAt < Date.now())
      throw new Error('Stale gateway discovery');
    // "This computer" is saved here only, so a change to it alone sends nothing.
    if (Object.keys(patch).length > 0 || addDiscovered === true)
      await backend.write({
        expectedRevision: action.expectedRevision,
        patch,
        models,
        replaceModels: addDiscovered === true,
      });
    if (useOnThisComputer !== undefined) {
      const changed = await setModelGatewayUsedOnThisComputer(
        organizationId,
        useOnThisComputer,
      );
      const { refreshLocalModelGatewayPolicy } =
        await import('../services/org-enforced-settings');
      await refreshLocalModelGatewayPolicy();
      // The key is unchanged, but its "This computer" status is not.
      if (changed) {
        const { sendToAllWindows } = await import('../lib/window-send');
        sendToAllWindows(
          IPC_CHANNELS.modelGatewayCredentialChanged,
          organizationId,
        );
      }
    }
    if (action.discoveryId) discoveries.delete(action.discoveryId);
    return { status: 'updated', organizationId };
  } finally {
    clearTimeout(expires);
    stopAccountWatch();
    call.signal?.removeEventListener('abort', abort);
  }
}
