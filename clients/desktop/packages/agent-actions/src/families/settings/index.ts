import {
  aiGatewayActionSchema,
  AI_GATEWAY_ACTION_TYPES,
  aiGatewayActionCatalog,
  aiGatewayDispatchJsonSchema,
} from './ai-gateway';
import { z } from 'zod';
import {
  SCRIPT_PREFERENCES_ACTION_TYPES,
  scriptPreferencesActionSchema,
  scriptPreferencesActionCatalog,
  scriptPreferencesDispatchJsonSchema,
  dispatchScriptPreferencesAction,
  type ScriptPreferencesPort,
} from './script-preferences';
import {
  ACCOUNT_SETTINGS_PAGES,
  ORGANIZATION_MEMORY_VIEWS,
  ORGANIZATION_SETTINGS_NAV_TABS,
  ORGANIZATION_SETTINGS_SUBTABS,
  type SettingsRoute,
} from '@canopy/protocol/settings';
import type { AgentActionCatalogEntry } from '../../catalog/types';
import {
  agentActionError,
  agentActionResult,
  portErrorResponse,
} from '../../action-support';
import type {
  AgentSettingsOpenRejectionReason,
  AgentSettingsPort,
} from '../../port/settings-port';
import type { AgentActionErrorCode, AgentJson } from '../../response';
import {
  defineAgentActionFamily,
  type AgentActionCall,
  type AgentActionDispatchOutput,
  type AgentActionFamily,
  type AgentActionFamilyJsonSchema,
} from '../../surface/family';
import { SETTINGS_ACTION_TYPES, settingsActionSchema } from './actions';

export { SETTINGS_ACTION_TYPES, settingsActionSchema } from './actions';

const REJECTIONS: Readonly<
  Record<
    AgentSettingsOpenRejectionReason,
    { code: AgentActionErrorCode; message: string; retryable: boolean }
  >
> = {
  organization_not_member: {
    code: 'invalid_target',
    message:
      "That organization is not one of the signed-in account's current memberships.",
    retryable: false,
  },
  signed_out: {
    code: 'authentication_failed',
    message: 'Account and organization settings need a signed-in account.',
    retryable: false,
  },
  unavailable: {
    code: 'surface_unavailable',
    message:
      'Settings could not be opened right now because the account or its window is not available. Retry later.',
    retryable: true,
  },
};

/**
 * `settings.open`: show one account or organization settings destination.
 * The route is validated against the shared `SettingsRoute` schema before the
 * port runs; the port checks the account and membership the route needs.
 * Opening settings changes only what the user sees, so it is not an
 * idempotent write and takes no limits reservation.
 */
export function createSettingsActionFamily<H>(options: {
  port: AgentSettingsPort<H>;
  scriptPreferences?: ScriptPreferencesPort<H>;
}): AgentActionFamily<H> {
  return defineAgentActionFamily({
    id: 'settings',
    types: [...SETTINGS_ACTION_TYPES, ...SCRIPT_PREFERENCES_ACTION_TYPES],
    actionSchema: z.union([
      settingsActionSchema,
      aiGatewayActionSchema,
      scriptPreferencesActionSchema,
    ]),
    supportedTypes: () => [
      'settings.open',
      ...(options.port.aiGateway && options.port.aiGatewayEnabled?.()
        ? AI_GATEWAY_ACTION_TYPES
        : []),
      ...(options.scriptPreferences ? SCRIPT_PREFERENCES_ACTION_TYPES : []),
    ],
    catalog: () => [
      ...settingsActionCatalog(),
      ...(options.port.aiGateway && options.port.aiGatewayEnabled?.()
        ? aiGatewayActionCatalog
        : []),
      ...(options.scriptPreferences ? scriptPreferencesActionCatalog : []),
    ],
    dispatchJsonSchema: options.scriptPreferences
      ? {
          properties: {
            ...settingsDispatchJsonSchema.properties,
            ...scriptPreferencesDispatchJsonSchema.properties,
          },
          allOf: [
            ...(settingsDispatchJsonSchema.allOf ?? []),
            ...(scriptPreferencesDispatchJsonSchema.allOf ?? []),
          ],
        }
      : settingsDispatchJsonSchema,
    dispatch: async (action, call): Promise<AgentActionDispatchOutput> => {
      if (
        action.type === 'settings.ai_gateway.get' ||
        action.type === 'settings.ai_gateway.connect' ||
        action.type === 'settings.ai_gateway.update'
      ) {
        if (!options.port.aiGateway || !options.port.aiGatewayEnabled?.())
          return agentActionError(
            call,
            'unsupported_action',
            'AI gateway setup is unavailable here.',
          );
        try {
          return agentActionResult(
            call,
            action.type,
            await options.port.aiGateway(action, call),
          );
        } catch {
          return agentActionError(
            call,
            'execution_failed',
            'AI gateway operation failed. Read current settings before retrying.',
          );
        }
      }
      if (action.type !== 'settings.open') {
        if (!options.scriptPreferences)
          return agentActionError(
            call,
            'unsupported_action',
            'Script preferences are unavailable here.',
          );
        return dispatchScriptPreferencesAction(
          action,
          options.scriptPreferences,
          call,
        );
      }
      try {
        const outcome = await options.port.open(action.destination, call);
        if (outcome.status === 'rejected') {
          return settingsRejection(call, outcome.reason);
        }
        return agentActionResult(call, action.type, {
          status: 'opened',
          destination: routeJson(action.destination),
        });
      } catch (error) {
        return portErrorResponse(call, action.type, error);
      }
    },
  });
}

/** The route as JSON, without the optional fields it leaves out. */
function routeJson(route: SettingsRoute): AgentJson {
  const json: Record<string, AgentJson> = {};
  for (const [key, value] of Object.entries(route)) {
    if (typeof value === 'string') json[key] = value;
  }
  return json;
}

function settingsRejection(
  call: AgentActionCall<unknown>,
  reason: AgentSettingsOpenRejectionReason,
): AgentActionDispatchOutput {
  const rejection = REJECTIONS[reason];
  return agentActionError(call, rejection.code, rejection.message, {
    retryable: rejection.retryable,
    result: { status: 'rejected', reason },
  });
}

export function settingsActionCatalog(): readonly AgentActionCatalogEntry[] {
  return [
    {
      type: 'settings.open',
      category: 'settings',
      summary:
        "Open Settings pages for the user, including Plugins settings, MCP servers settings, account settings, the organization list, or one organization's settings page. AI gateway setup is available through settings.ai_gateway actions on desktop.",
      fields: [
        {
          name: 'destination',
          type: 'object',
          required: true,
          description:
            'Settings route. For Settings Plugins use {scope: "account", page: "plugins"}; for Settings MCP servers use {scope: "account", page: "mcp"}. Other account pages use scope "account" with page; scope "organizations" opens the list; scope "organization" requires organizationId and page. Detail ids are valid only on their page.',
        },
      ],
      example: {
        type: 'settings.open',
        destination: { scope: 'account', page: 'security' },
      },
      additionalExamples: [
        {
          type: 'settings.open',
          destination: { scope: 'account', page: 'plugins' },
        },
        {
          type: 'settings.open',
          destination: { scope: 'account', page: 'mcp' },
        },
        {
          type: 'settings.open',
          destination: {
            scope: 'organization',
            organizationId: 'org_123',
            page: 'settings',
            subtab: 'billing',
          },
        },
      ],
      keywords: [
        'settings',
        'account',
        'organization',
        ...ACCOUNT_SETTINGS_PAGES,
        'mcp servers',
        'page',
        'members',
        'open',
      ],
      notes: [
        'Use settings.open for a request to open Settings Plugins or Settings MCP servers. plugins.open_management opens Customize, a different destination for managing installed items.',
        "Organization destinations must name one of the signed-in account's current organizations; others are refused with invalid_target.",
        'Destinations are routes, never URLs. Opening settings changes only what the user sees.',
      ],
    },
  ];
}

const settingsRouteIdJsonSchema: AgentJson = {
  type: 'string',
  minLength: 1,
  maxLength: 192,
};

const SETTINGS_PAGES: readonly string[] = Array.from(
  new Set<string>([
    ...ACCOUNT_SETTINGS_PAGES,
    ...ORGANIZATION_SETTINGS_NAV_TABS,
  ]),
);

const settingsOpenDispatchJsonSchema: AgentActionFamilyJsonSchema = {
  properties: {
    destination: {
      type: 'object',
      description:
        'Settings destination for settings.open. Account pages: account, profile, digests, notifications, integrations, plugins, mcp, security, ai-gateway, billing, labs, appearance. Organization pages: feed (the Timeline), statistics, digests, members, groups, projects, memory, settings (subtab ai-gateway for the AI gateway).',
      properties: {
        scope: {
          type: 'string',
          enum: ['account', 'organizations', 'organization'],
        },
        organizationId: settingsRouteIdJsonSchema,
        page: { type: 'string', enum: [...SETTINGS_PAGES] },
        subtab: { type: 'string', enum: [...ORGANIZATION_SETTINGS_SUBTABS] },
        memoryView: { type: 'string', enum: [...ORGANIZATION_MEMORY_VIEWS] },
        itemId: settingsRouteIdJsonSchema,
        userId: settingsRouteIdJsonSchema,
        digestId: settingsRouteIdJsonSchema,
        factId: settingsRouteIdJsonSchema,
        invoiceId: settingsRouteIdJsonSchema,
      },
      required: ['scope'],
      additionalProperties: false,
    },
  },
  allOf: [
    {
      if: {
        properties: { type: { const: 'settings.open' } },
        required: ['type'],
      },
      then: { required: ['destination'] },
    },
  ],
};

/** Shared by the live family and static provider tool projections. */
export const settingsDispatchJsonSchema: AgentActionFamilyJsonSchema = {
  properties: {
    ...settingsOpenDispatchJsonSchema.properties,
    ...aiGatewayDispatchJsonSchema.properties,
  },
  allOf: [
    ...(settingsOpenDispatchJsonSchema.allOf ?? []),
    ...(aiGatewayDispatchJsonSchema.allOf ?? []),
  ],
};
