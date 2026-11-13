import { useMemo } from 'react';
import type { ModelGatewayModel } from '@canopy/protocol';
import type { AccountOrganizationSettingsClient } from '@canopy/app-core/settings';
import type { PersonalAiGatewayConfig } from '@canopy/protocol/model-gateway';
import {
  gatewayHostname,
  type AiGatewayConnectionResult,
} from '@canopy/protocol/model-gateway/discovery';
import type { OrganizationConfigDetail } from '@canopy/protocol/settings/organization';
import {
  connectOrganizationAiGateway,
  updateAiGatewayConfig,
} from '../organization/team-api';

/** One scope's gateway, as the server last confirmed it. */
export interface AiGatewayEditorConfig {
  readonly displayName: string | null;
  readonly baseUrl: string | null;
  readonly models: readonly ModelGatewayModel[];
  /** Personal: the gateway is on. Team: offered to members. */
  readonly enabled: boolean;
  /** Personal only mode, or the team's members requirement. */
  readonly onlyThisGateway: boolean;
  readonly revision: string;
}

export interface AiGatewayEditorPatch {
  readonly displayName?: string | null;
  readonly baseUrl?: string | null;
  readonly models?: readonly ModelGatewayModel[];
  readonly enabled?: boolean;
  readonly onlyThisGateway?: boolean;
}

export interface AiGatewayConnectInput {
  readonly baseUrl: string;
  /** Omitted to reuse this device's stored key for the same endpoint. */
  readonly apiKey?: string;
}

/**
 * Load, connect and save for one scope. Shared gateway UI talks only to this,
 * so Personal and organization gateways render the same components.
 */
export interface AiGatewayEditorAdapter {
  readonly scope: 'personal' | 'organization';
  /** The organization the gateway, its model IDs and its key belong to. */
  readonly organizationId: string;
  /** The label when the gateway has no name; `null` uses its hostname. */
  readonly fallbackName: string | null;
  connect(input: AiGatewayConnectInput): Promise<AiGatewayConnectionResult>;
  save(
    patch: AiGatewayEditorPatch,
    expectedRevision: string,
  ): Promise<AiGatewayEditorConfig>;
}

/**
 * A host that keeps no key on the device also saves a key typed to connect
 * as the member's cloud chats key. Best effort: a refusal, or cloud keys off
 * (404), leaves Cloud chats showing its own not-saved state.
 */
export async function keepKeyForCloudChats(
  client: AccountOrganizationSettingsClient,
  organizationId: string,
  apiKey: string,
  /** The gateway the key connected to; the server refuses if another is stored. */
  expectedBaseUrl: string,
): Promise<void> {
  try {
    await client.write('organization.settings.ai-gateway.cloud-key.save', {
      organizationId,
      apiKey,
      expectedBaseUrl,
    });
  } catch {
    // Silent on purpose: the section below reports the key's state.
  }
}

/**
 * Removes the gateway: no endpoint, no models, switches off. The name goes
 * too, or setup would offer the removed gateway again.
 */
export const CLEARED_GATEWAY_PATCH: AiGatewayEditorPatch = {
  enabled: false,
  onlyThisGateway: false,
  baseUrl: null,
  models: [],
  displayName: null,
};

/** The revision a scope without a stored gateway reports. */
export const ABSENT_GATEWAY_REVISION = 'absent';

/** Display name, then the organization name or hostname. */
export function aiGatewayLabel(
  config: Pick<AiGatewayEditorConfig, 'displayName' | 'baseUrl'>,
  fallbackName: string | null,
): string {
  if (config.displayName) return config.displayName;
  if (fallbackName) return fallbackName;
  return config.baseUrl ? gatewayHostname(config.baseUrl) : '';
}

export function personalGatewayEditorConfig(
  gateway: PersonalAiGatewayConfig | null,
): AiGatewayEditorConfig | null {
  if (gateway === null) return null;
  return {
    displayName: gateway.displayName,
    baseUrl: gateway.baseUrl,
    models: gateway.models,
    enabled: gateway.enabled,
    onlyThisGateway: gateway.onlyThisGateway,
    revision: gateway.revision,
  };
}

export function organizationGatewayEditorConfig(
  config: OrganizationConfigDetail,
): AiGatewayEditorConfig {
  return {
    displayName: config.modelGatewayDisplayName ?? null,
    baseUrl: config.modelGatewayBaseUrl,
    models: config.modelGatewayModels,
    enabled: config.enforceMemberModelGateway,
    onlyThisGateway: config.modelGatewayEnforced,
    revision: config.modelGatewayRevision ?? '',
  };
}

export function usePersonalAiGatewayAdapter(
  client: AccountOrganizationSettingsClient,
  organizationId: string,
): AiGatewayEditorAdapter {
  return useMemo(
    () => ({
      scope: 'personal',
      organizationId,
      fallbackName: null,
      connect: (input) =>
        client.write('account.settings.ai-gateway.connect', {
          ...input,
          expectedOrganizationId: organizationId,
        }),
      save: async ({ models, ...fields }, expectedRevision) => {
        const { gateway } = await client.write(
          'account.settings.ai-gateway.update',
          {
            expectedOrganizationId: organizationId,
            expectedRevision,
            ...fields,
            ...(models === undefined
              ? {}
              : {
                  models: models.map((model) => ({
                    ...model,
                    supportedThinkingLevels: [...model.supportedThinkingLevels],
                  })),
                }),
          },
        );
        return {
          displayName: gateway.displayName,
          baseUrl: gateway.baseUrl,
          models: gateway.models,
          enabled: gateway.enabled,
          onlyThisGateway: gateway.onlyThisGateway,
          revision: gateway.revision,
        };
      },
    }),
    [client, organizationId],
  );
}

export function useOrganizationAiGatewayAdapter(
  client: AccountOrganizationSettingsClient,
  organizationId: string,
  organizationName: string,
): AiGatewayEditorAdapter {
  return useMemo(
    () => ({
      scope: 'organization',
      organizationId,
      fallbackName: organizationName,
      connect: (input) =>
        connectOrganizationAiGateway(client, organizationId, input),
      save: async (patch, expectedRevision) =>
        organizationGatewayEditorConfig(
          await updateAiGatewayConfig(client, organizationId, {
            ...(expectedRevision
              ? { expectedModelGatewayRevision: expectedRevision }
              : {}),
            ...(patch.displayName !== undefined
              ? { modelGatewayDisplayName: patch.displayName }
              : {}),
            ...(patch.baseUrl !== undefined
              ? { modelGatewayBaseUrl: patch.baseUrl }
              : {}),
            ...(patch.models !== undefined
              ? { modelGatewayModels: patch.models }
              : {}),
            ...(patch.enabled !== undefined
              ? { enforceMemberModelGateway: patch.enabled }
              : {}),
            ...(patch.onlyThisGateway !== undefined
              ? { modelGatewayEnforced: patch.onlyThisGateway }
              : {}),
          }),
        ),
    }),
    [client, organizationId, organizationName],
  );
}
