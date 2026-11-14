import { z } from 'zod';

import { CanopyRequestMetadataSchema } from '../../common';
import {
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
} from '../../definitions';
import { keyedOperationErrorSchema } from '../shared';
import { CORE_INTEGRATION_GRANTS } from './operations';

const HttpsUrlSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => {
    try {
      return new URL(value).protocol === 'https:';
    } catch {
      return false;
    }
  }, 'Use an https URL.');

const ConfigIdSchema = z.string().regex(/^[a-zA-Z0-9._-]{1,128}$/);
const SECRET_INPUT = {
  writeOnly: true,
  description: 'Secret input; never echoed, logged or returned.',
} as const;
const SecretSchema = z.string().min(1).max(16384).meta(SECRET_INPUT);
const HeaderNameSchema = z
  .string()
  .max(256)
  .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/);
const HeaderValueSchema = z
  .string()
  .max(4096)
  .regex(/^[\t\x20-\x7e\x80-\xff]*$/)
  .meta(SECRET_INPUT);

/**
 * A stored-secret slot of a desktop HTTP MCP server that may be copied to
 * the cloud: a definition header, a configuration's extra header, or its
 * bearer token. The OAuth client secret and a command server's environment
 * are never copied (CAN-6176 D16, 3.7), so they have no slot here.
 */
export const McpAccountSecretSlotSchema = z
  .string()
  .max(512)
  .regex(
    /^(?:definition\/headers\/[!#$%&'*+.^_`|~0-9A-Za-z-]{1,256}|config\/[a-zA-Z0-9._-]{1,128}\/(?:extraHeaders\/[!#$%&'*+.^_`|~0-9A-Za-z-]{1,256}|authToken))$/,
  );

/**
 * Copy a server this desktop already has (CAN-6176 D15). The renderer names
 * the slots the person agreed to copy; main resolves their values from the
 * desktop's own secret store, and only toward the server's own origin.
 */
export const McpAccountFromDeviceServerSchema = z.strictObject({
  serverId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
  configId: ConfigIdSchema,
  /** Empty copies no secret, which is valid for a server that needs none. */
  secretSlots: z.array(McpAccountSecretSlotSchema).max(64),
});

/**
 * Start or reconnect an MCP account connection on Canopy Cloud (CAN-6176
 * PR 4a). Exactly one of `serverKey` (curated, D17) or `customUrl`. Secret
 * inputs are write-only: no result, event, error or log carries them.
 */
export const McpAccountConnectParamsSchema = z
  .strictObject({
    serverKey: z.string().min(1).max(256).optional(),
    customUrl: HttpsUrlSchema.optional(),
    endpointUrl: HttpsUrlSchema.optional(),
    displayName: z.string().trim().min(1).max(120).optional(),
    configId: ConfigIdSchema,
    headers: z.record(HeaderNameSchema, HeaderValueSchema).optional(),
    bearerToken: SecretSchema.optional(),
    oauthClient: z
      .strictObject({
        clientId: z.string().min(1).max(4096),
        clientSecret: SecretSchema.optional(),
      })
      .optional(),
    fromDeviceServer: McpAccountFromDeviceServerSchema.optional(),
    expectedAccountId: z.string().min(1).max(256).optional(),
    _meta: CanopyRequestMetadataSchema.extend({
      idempotencyKey: z.string().min(1).max(512),
    }),
  })
  .superRefine((params, context) => {
    const refuse = (message: string): void => {
      context.addIssue({ code: 'custom', message });
    };
    if ((params.serverKey === undefined) === (params.customUrl === undefined))
      refuse('Choose a server key or a custom URL.');
    if (params.endpointUrl !== undefined && params.serverKey === undefined)
      refuse('Choose a curated server for an endpoint selection.');
    if (params.displayName !== undefined && params.customUrl === undefined)
      refuse('Only a custom server takes a display name.');
    if (params.headers !== undefined && params.customUrl === undefined)
      refuse('Only a custom server takes headers.');
    if (params.headers !== undefined && Object.keys(params.headers).length > 16)
      refuse('Use at most 16 headers.');
    if (params.bearerToken !== undefined && params.oauthClient !== undefined)
      refuse('Use a bearer token or an OAuth client, not both.');
    // A copy's secrets come only from its consented slots.
    if (
      params.fromDeviceServer !== undefined &&
      (params.customUrl === undefined ||
        params.headers !== undefined ||
        params.bearerToken !== undefined ||
        params.oauthClient !== undefined)
    )
      refuse(
        'A copied server takes a custom URL and its secrets only from its slots.',
      );
  });
export type McpAccountConnectParams = z.output<
  typeof McpAccountConnectParamsSchema
>;

export const MCP_ACCOUNT_CONNECTION_STATES = [
  'pending',
  'connected',
  'reauthRequired',
  'disconnected',
] as const;

export const McpAccountConnectionSummarySchema = z.strictObject({
  connectionId: z.string().min(1).max(512),
  serverKey: z.string().min(1).max(256).optional(),
  state: z.enum(MCP_ACCOUNT_CONNECTION_STATES),
  /** Absent while the cloud reports no connection version. */
  version: z.number().int().min(0).optional(),
  hasStoredHeaders: z.boolean().optional(),
});

/** The connection, or the sign-in the desktop opened for an OAuth server (D16). */
export const McpAccountConnectResultSchema = z.union([
  z.strictObject({ connection: McpAccountConnectionSummarySchema }),
  z.strictObject({
    authorizationUrl: HttpsUrlSchema.pipe(z.string().max(2048)),
  }),
]);
export type McpAccountConnectResult = z.output<
  typeof McpAccountConnectResultSchema
>;

export const CORE_INTEGRATION_MCP_ACCOUNT_CONNECT_CODES = [
  'core.integration.mcpAccount.invalidUrl',
  'core.integration.mcpAccount.invalidHeaders',
  'core.integration.mcpAccount.oauthClientRequired',
  'core.integration.mcpAccount.connectRefused',
  'core.integration.mcpAccount.connectionLimitReached',
  'core.integration.mcpAccount.busy',
  'core.integration.mcpAccount.accountDisabled',
  'core.integration.mcpAccount.accountChanged',
  'core.integration.mcpAccount.secretSlotRefused',
  'core.integration.mcpAccount.consentDeclined',
] as const;

/** Served by the desktop dispatcher only; kept out of the composed registries. */
export const CORE_INTEGRATION_MCP_ACCOUNT_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('core', {
    'core.integration.mcpAccount.connect': defineCanopyInstruction({
      plane: 'core',
      domain: 'integration',
      version: 1,
      placement: 'core-only',
      idempotency: 'keyed',
      requiredGrants: [CORE_INTEGRATION_GRANTS.write],
      params: McpAccountConnectParamsSchema,
      result: McpAccountConnectResultSchema,
      error: keyedOperationErrorSchema(
        CORE_INTEGRATION_MCP_ACCOUNT_CONNECT_CODES,
      ),
    }),
  });
