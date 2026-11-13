import {
  MODEL_GATEWAY_MAX_DISPLAY_NAME_LENGTH,
  MODEL_GATEWAY_MAX_MODELS,
  MODEL_GATEWAY_MAX_ID_LENGTH,
  MODEL_GATEWAY_MAX_LABEL_LENGTH,
} from '@canopy/protocol/canopy-server';
import { AI_GATEWAY_THINKING_LEVELS } from '@canopy/protocol/ai-gateway-models';
import { z } from 'zod';
import {
  gatewayScopeSchema,
  gatewayModelsSchema,
  gatewayBaseUrlSchema,
  gatewayDisplayNameSchema,
} from '@canopy/protocol/model-gateway';
import { AI_GATEWAY_PRESETS } from '@canopy/protocol/model-gateway/presets';
import type { AgentActionCatalogEntry } from '../../catalog/types';
import type { AgentActionFamilyJsonSchema } from '../../surface/family';

const KNOWN_GATEWAYS = AI_GATEWAY_PRESETS.flatMap((preset) =>
  preset.baseUrl === null ? [] : [`${preset.name} ${preset.baseUrl}`],
).join(', ');

export const AI_GATEWAY_ACTION_TYPES = [
  'settings.ai_gateway.get',
  'settings.ai_gateway.connect',
  'settings.ai_gateway.update',
] as const;
const readScope = z.union([
  gatewayScopeSchema,
  z.strictObject({ kind: z.literal('personal') }),
]);
const patchSchema = z
  .strictObject({
    displayName: gatewayDisplayNameSchema.optional(),
    baseUrl: gatewayBaseUrlSchema.nullable().optional(),
    models: gatewayModelsSchema.optional(),
    enabled: z.boolean().optional(),
    onlyThisGateway: z.boolean().optional(),
    promptCachePassthrough: z.boolean().optional(),
    addDiscovered: z.literal(true).optional(),
  })
  .refine(
    (patch) => patch.models === undefined || patch.addDiscovered === undefined,
    'Use explicit models or discovery, not both.',
  );
export const aiGatewayActionSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('settings.ai_gateway.get'),
    scope: readScope,
  }),
  z.strictObject({
    type: z.literal('settings.ai_gateway.connect'),
    scope: gatewayScopeSchema,
    baseUrl: gatewayBaseUrlSchema,
  }),
  z
    .strictObject({
      type: z.literal('settings.ai_gateway.update'),
      scope: gatewayScopeSchema,
      expectedRevision: z.string().min(1).max(128),
      patch: patchSchema,
      discoveryId: z.uuid().optional(),
    })
    .refine(
      (action) =>
        action.patch.addDiscovered !== true || action.discoveryId !== undefined,
      'Discovery ID is required.',
    ),
]);
export type AiGatewayAction = z.output<typeof aiGatewayActionSchema>;
export const aiGatewayActionCatalog: readonly AgentActionCatalogEntry[] =
  AI_GATEWAY_ACTION_TYPES.map((type) => ({
    type,
    category: 'settings',
    requiredFeatureFlag: 'canopy-ai-gateway-settings-enabled',
    summary:
      type === 'settings.ai_gateway.get'
        ? 'Read AI gateway configuration without credentials.'
        : type === 'settings.ai_gateway.connect'
          ? 'Connect an AI gateway with a secure API key approval and discover its models.'
          : 'Update an AI gateway after a separate approval of the actual configuration patch.',
    fields: [
      {
        name: 'scope',
        type: 'object',
        required: true,
        description:
          'Personal, or an explicit organization ID. Read Personal first to resolve its expectedOrganizationId.',
      },
      ...(type.endsWith('.connect')
        ? [
            {
              name: 'baseUrl',
              type: 'string',
              required: true,
              description: `HTTPS gateway endpoint. Known gateways: ${KNOWN_GATEWAYS}. Never supply an API key in tool arguments.`,
            },
          ]
        : []),
      ...(type.endsWith('.update')
        ? [
            {
              name: 'expectedRevision',
              type: 'string',
              required: true,
              description:
                'Revision from get, or absent for a new configuration.',
            },
            {
              name: 'patch',
              type: 'object',
              required: true,
              description:
                'Gateway fields only. Use models or addDiscovered:true with discoveryId.',
            },
            {
              name: 'discoveryId',
              type: 'string',
              required: false,
              description:
                'Expiring ID returned by connect, bound to account, scope, endpoint and session.',
            },
          ]
        : []),
    ],
    example: type.endsWith('.get')
      ? { type, scope: { kind: 'personal' } }
      : type.endsWith('.connect')
        ? {
            type,
            scope: {
              kind: 'personal',
              expectedOrganizationId: '11111111-1111-4111-8111-111111111111',
            },
            baseUrl: 'https://gateway.example',
          }
        : {
            type,
            scope: {
              kind: 'organization',
              organizationId: '11111111-1111-4111-8111-111111111111',
            },
            expectedRevision: 'absent',
            patch: { enabled: false },
          },
    keywords: ['AI gateway', 'models', 'connect', 'personal', 'settings'],
    notes: [
      'Desktop only. API keys are collected through the secure approval prompt, never chat or action payloads.',
    ],
  }));
export const aiGatewayDispatchJsonSchema: AgentActionFamilyJsonSchema = {
  properties: {
    scope: {
      type: 'object',
      properties: {
        kind: { enum: ['personal', 'organization'] },
        organizationId: { type: 'string' },
        expectedOrganizationId: { type: 'string' },
      },
      required: ['kind'],
      additionalProperties: false,
    },
    baseUrl: { type: 'string' },
    expectedRevision: { type: 'string' },
    discoveryId: { type: 'string' },
    patch: {
      type: 'object',
      properties: {
        displayName: {
          type: ['string', 'null'],
          maxLength: MODEL_GATEWAY_MAX_DISPLAY_NAME_LENGTH,
        },
        baseUrl: { type: ['string', 'null'] },
        models: {
          type: 'array',
          maxItems: MODEL_GATEWAY_MAX_MODELS,
          items: {
            type: 'object',
            properties: {
              id: {
                type: 'string',
                minLength: 1,
                maxLength: MODEL_GATEWAY_MAX_ID_LENGTH,
              },
              gatewayId: {
                type: 'string',
                minLength: 1,
                maxLength: MODEL_GATEWAY_MAX_ID_LENGTH,
              },
              label: {
                type: 'string',
                minLength: 1,
                maxLength: MODEL_GATEWAY_MAX_LABEL_LENGTH,
              },
              harness: { enum: ['claude', 'codex'] },
              contextWindow: {
                type: 'integer',
                minimum: 1,
                maximum: Number.MAX_SAFE_INTEGER,
              },
              supportedThinkingLevels: {
                type: 'array',
                uniqueItems: true,
                items: { enum: [...AI_GATEWAY_THINKING_LEVELS] },
              },
              toolSchemaProfile: { enum: ['standard', 'flat'] },
            },
            required: [
              'id',
              'gatewayId',
              'label',
              'harness',
              'contextWindow',
              'supportedThinkingLevels',
              'toolSchemaProfile',
            ],
            additionalProperties: false,
          },
        },
        enabled: { type: 'boolean' },
        onlyThisGateway: { type: 'boolean' },
        promptCachePassthrough: { type: 'boolean' },
        addDiscovered: { const: true },
      },
      additionalProperties: false,
    },
  },
  allOf: AI_GATEWAY_ACTION_TYPES.map((type) => ({
    if: { properties: { type: { const: type } }, required: ['type'] },
    then: {
      required: type.endsWith('.connect')
        ? ['scope', 'baseUrl']
        : type.endsWith('.update')
          ? ['scope', 'expectedRevision', 'patch']
          : ['scope'],
    },
  })),
};
