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
  type AiGatewayScope,
  type PersonalAiGatewayConfig,
} from '@canopy/protocol/model-gateway';
import {
  aiGatewayConnectionResultSchema,
  suggestGatewayModel,
  type DiscoveredGatewayModel,
} from '@canopy/protocol/model-gateway/discovery';
import { matchAiGatewayPreset } from '@canopy/protocol/model-gateway/presets';
import { MODEL_GATEWAY_MAX_MODELS } from '@canopy/protocol/canopy-server';
import { organizationConfigDetailSchema } from '@canopy/protocol/settings/organization';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import type { CanopyInjectedToolRuntime } from '../canopy-tools/core';
import { getFeatureFlagService } from '../feature-flags';
import { acquireSettingsBridgeSession } from '../canopy-cloud/settings-session';
import { executeSettingsOperation } from '../canopy-cloud/settings-client';
import {
  readCanopyCloudAccountWithStatus,
  subscribeCanopyCloudAccountChanges,
} from '../lib/canopy-cloud-account-store';
import {
  authorizeDesktopGatewayScope,
  connectDesktopGateway,
} from '../services/ai-gateway-settings';
import { requestApprovalDecision } from '../approvals/prompt-bridge';
import { requestSecretInputApproval } from '../approvals/secret-input';
import { cancelApproval } from '../approvals/pending-approvals';
import { isHostedSettingsEnabled } from '../services/hosted-settings-feature-flag';

interface DiscoveryReceipt {
  accountId: string;
  organizationId: string;
  baseUrl: string;
  sessionKey: string;
  expiresAt: number;
  models: DiscoveredGatewayModel[];
}
const discoveries = new Map<string, DiscoveryReceipt>();
export function desktopAiGatewayEnabled(): boolean {
  return (
    isHostedSettingsEnabled() &&
    getFeatureFlagService().isEnabled(
      CLIENT_FEATURE_FLAGS.canopyAiGatewaySettingsEnabled.key,
    )
  );
}
function json(value: unknown): AgentJson {
  return z.json().parse(JSON.parse(JSON.stringify(value)));
}

export async function executeDesktopAiGateway(
  action: AiGatewayAction,
  call: AgentActionCall<CanopyInjectedToolRuntime>,
): Promise<AgentJson> {
  if (!desktopAiGatewayEnabled())
    throw new Error('AI gateway setup unavailable');
  const read = await readCanopyCloudAccountWithStatus();
  if (read.status !== 'ok' || !read.entry?.account?.id)
    throw new Error('Signed-in account required');
  const account = read.entry;
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
  await authorizeDesktopGatewayScope(
    session,
    scope,
    action.type.endsWith('.get')
      ? 'read'
      : action.type.endsWith('.update')
        ? 'update'
        : 'connect',
  );
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  call.signal?.addEventListener('abort', abort, { once: true });
  if (call.signal?.aborted) abort();
  const expires = setTimeout(abort, 120_000);
  const stopAccountWatch = subscribeCanopyCloudAccountChanges((next) => {
    if (
      next?.account?.id !== accountId ||
      (scope.kind === 'personal' &&
        next.personalOrganizationId !== organizationId)
    )
      abort();
  });
  const signal = controller.signal;
  const identity = call.scope;
  const sessionKey = identity
    ? `${identity.workspaceId}/${identity.worktreeId}/${identity.chatId}`
    : '';
  const getWindow = (): SendableBrowserWindow | null =>
    call.host.worktreeActionRuntime?.getWindow() ??
    call.host.settingsWindow?.() ??
    null;
  const readConfig = async (): Promise<PersonalAiGatewayConfig | null> => {
    if (scope.kind === 'personal') {
      const value = await executeSettingsOperation(
        session,
        'account.settings.ai-gateway.read',
        {},
        { signal },
      );
      return z
        .object({ gateway: personalAiGatewayConfigSchema.nullable() })
        .parse(value).gateway;
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
      organizationId,
      displayName: value.modelGatewayDisplayName ?? null,
      baseUrl: value.modelGatewayBaseUrl,
      models: value.modelGatewayModels,
      enabled: value.enforceMemberModelGateway,
      onlyThisGateway: value.modelGatewayEnforced,
      promptCachePassthrough: value.modelGatewayPromptCachePassthrough,
      revision: value.modelGatewayRevision ?? 'absent',
    };
  };
  try {
    signal.throwIfAborted();
    if (action.type === 'settings.ai_gateway.get') {
      const gateway = await readConfig();
      await authorizeDesktopGatewayScope(session, scope, 'read');
      signal.throwIfAborted();
      return json({ scope, gateway });
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
          await authorizeDesktopGatewayScope(
            session,
            scope,
            action.type.endsWith('.get')
              ? 'read'
              : action.type.endsWith('.update')
                ? 'update'
                : 'connect',
          );
          const name =
            scope.kind === 'personal'
              ? 'account.settings.ai-gateway.connect'
              : 'organization.settings.ai-gateway.connect';
          const input =
            scope.kind === 'personal'
              ? {
                  expectedOrganizationId: organizationId,
                  baseUrl: action.baseUrl,
                  ...(secret ? { apiKey: secret } : {}),
                }
              : {
                  organizationId,
                  baseUrl: action.baseUrl,
                  ...(secret ? { apiKey: secret } : {}),
                };
          return aiGatewayConnectionResultSchema.parse(
            await connectDesktopGateway(session, name, input, signal),
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
    const current = await readConfig();
    if ((current?.revision ?? 'absent') !== action.expectedRevision)
      throw new Error('Stale gateway revision');
    const { addDiscovered, ...patch } = action.patch;
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
    // Clearing the URL of a configured gateway removes it, so say so rather
    // than "Save AI gateway with 0 models". Removal implies disabling, so
    // that change isn't listed; any other policy change still shows.
    const removing = baseUrl === null && Boolean(current?.baseUrl);
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
    await authorizeDesktopGatewayScope(
      session,
      scope,
      action.type.endsWith('.get')
        ? 'read'
        : action.type.endsWith('.update')
          ? 'update'
          : 'connect',
    );
    signal.throwIfAborted();
    if (reusedReceipt && reusedReceipt.expiresAt < Date.now())
      throw new Error('Stale gateway discovery');
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
              expectedRevision: action.expectedRevision,
              ...patch,
              ...(addDiscovered ? { models } : {}),
            },
          })
        : await service.write({
            accountId,
            operation: 'organization.settings.policies.update',
            input: {
              organizationId,
              expectedModelGatewayRevision: action.expectedRevision,
              ...(patch.displayName === undefined
                ? {}
                : { modelGatewayDisplayName: patch.displayName }),
              ...(patch.baseUrl === undefined
                ? {}
                : { modelGatewayBaseUrl: patch.baseUrl }),
              ...(patch.models === undefined && !addDiscovered
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
    if (action.discoveryId) discoveries.delete(action.discoveryId);
    return { status: 'updated', organizationId };
  } finally {
    clearTimeout(expires);
    stopAccountWatch();
    call.signal?.removeEventListener('abort', abort);
  }
}
