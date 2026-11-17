import { z } from 'zod';
import {
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
} from '../../definitions';
import {
  inherentOperationErrorSchema,
  keyedOperationErrorSchema,
} from '../shared';

/** Fixed id of the cloud account connection on `core.integration.get`. */
export const CLOUD_ACCOUNT_INTEGRATION_ID = 'cloud-account';

/** How the account is connected; `none` when signed out. */
export const CLOUD_ACCOUNT_KINDS = [
  'guest',
  'apiKey',
  'oauth',
  'none',
] as const;

export const CloudAccountSummarySchema = z.strictObject({
  connected: z.boolean(),
  kind: z.enum(CLOUD_ACCOUNT_KINDS),
});

const OpaqueIdSchema = z.string().min(1).max(512);

const CloudAccountOrganizationSchema = z.strictObject({
  organizationId: OpaqueIdSchema,
  name: z.string().max(256),
  role: z.enum(['OWNER', 'ADMIN', 'MEMBER']).nullable(),
});

/**
 * `kind: 'cloud-account'` member of `core.integration.get`: the signed-in
 * account as clients may see it. Never a credential, a host path or a
 * secure-store backend name. Organizations are the membership snapshot in
 * the order the server sent it; no organization is chosen for the caller.
 */
export const CloudAccountStatusSchema = z.strictObject({
  kind: z.enum(CLOUD_ACCOUNT_KINDS),
  read: z.enum(['ok', 'unavailable', 'error']),
  storage: z.strictObject({
    state: z.enum(['secure', 'unknown', 'unavailable', 'locked']),
    writeAvailable: z.boolean(),
  }),
  sessionExpired: z.boolean(),
  accountId: OpaqueIdSchema.nullable(),
  personalOrganizationId: OpaqueIdSchema.nullable(),
  organizations: z.array(CloudAccountOrganizationSchema).max(500),
  capabilities: z.array(z.string().min(1).max(128)).max(256),
});

export type CloudAccountSummary = z.output<typeof CloudAccountSummarySchema>;
export type CloudAccountStatus = z.output<typeof CloudAccountStatusSchema>;

export const CoreCloudAccountSignInStartParamsSchema = z.strictObject({});
export const CoreCloudAccountSignInStartResultSchema = z.strictObject({
  account: CloudAccountSummarySchema,
  guestDataMerged: z.boolean().optional(),
});

export const CoreCloudAccountSignInCancelParamsSchema = z.strictObject({});
export const CoreCloudAccountSignInCancelResultSchema = z.strictObject({});

export const CoreCloudAccountConnectWithKeyParamsSchema = z.strictObject({
  apiKey: z.string().min(1).max(4096).meta({ writeOnly: true }),
});
export const CoreCloudAccountConnectWithKeyResultSchema = z.strictObject({
  account: CloudAccountSummarySchema,
});

export const CoreCloudAccountDisconnectParamsSchema = z.strictObject({});
export const CoreCloudAccountDisconnectResultSchema = z.strictObject({
  account: CloudAccountSummarySchema,
});

export const CoreCloudAccountResetUnreadableParamsSchema = z.strictObject({});
export const CoreCloudAccountResetUnreadableResultSchema = z.strictObject({
  status: z.enum(['reset', 'notNeeded']),
  account: CloudAccountSummarySchema,
  backupFileName: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[^/\\]+$/)
    .optional(),
});

export const CORE_CLOUD_ACCOUNT_SIGN_IN_START_ERROR_CODES = [
  'core.integration.cloudAccount.signInCancelled',
  'core.integration.cloudAccount.signInReplaced',
  'core.integration.cloudAccount.signInTimedOut',
  'core.integration.cloudAccount.callbackRejected',
  'core.integration.cloudAccount.providerDenied',
  'core.integration.cloudAccount.browserOpenFailed',
  'core.integration.cloudAccount.exchangeFailed',
  'core.integration.cloudAccount.commitQueueTimeout',
  'core.integration.cloudAccount.localOnly',
  'core.integration.cloudAccount.storageUnavailable',
] as const;

export const CORE_CLOUD_ACCOUNT_SIGN_IN_CANCEL_ERROR_CODES = [
  'core.integration.cloudAccount.localOnly',
] as const;

export const CORE_CLOUD_ACCOUNT_CONNECT_WITH_KEY_ERROR_CODES = [
  'core.integration.cloudAccount.keyRejected',
  'core.integration.cloudAccount.missingCapabilities',
  'core.integration.cloudAccount.providerUnreachable',
  'core.integration.cloudAccount.guestProtected',
  'core.integration.cloudAccount.superseded',
  'core.integration.cloudAccount.localOnly',
  'core.integration.cloudAccount.storageUnavailable',
] as const;

export const CORE_CLOUD_ACCOUNT_DISCONNECT_ERROR_CODES = [
  'core.integration.cloudAccount.localOnly',
  'core.integration.cloudAccount.storageUnavailable',
] as const;

export const CORE_CLOUD_ACCOUNT_RESET_UNREADABLE_ERROR_CODES = [
  'core.integration.cloudAccount.localOnly',
  'core.integration.cloudAccount.storageUnavailable',
] as const;

export type CoreCloudAccountConnectWithKeyParams = z.output<
  typeof CoreCloudAccountConnectWithKeyParamsSchema
>;
export type CoreCloudAccountSignInStartResult = z.output<
  typeof CoreCloudAccountSignInStartResultSchema
>;
export type CoreCloudAccountResetUnreadableResult = z.output<
  typeof CoreCloudAccountResetUnreadableResultSchema
>;

/**
 * The desktop cloud account (CAN-4168). Spec-first: no registry composes
 * these until the desktop core adapter lands, so every core answers
 * `capability_unavailable`. On the web the account is the hosted session,
 * so the web core does not serve them.
 */
export const CORE_CLOUD_ACCOUNT_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('core', {
    'core.integration.cloudAccount.signIn.start': defineCanopyInstruction({
      plane: 'core',
      domain: 'integration',
      version: 1,
      placement: 'core-only',
      params: CoreCloudAccountSignInStartParamsSchema,
      result: CoreCloudAccountSignInStartResultSchema,
      error: keyedOperationErrorSchema(
        CORE_CLOUD_ACCOUNT_SIGN_IN_START_ERROR_CODES,
      ),
      idempotency: 'keyed',
      requiredGrants: ['core.integration.write'],
    }),
    'core.integration.cloudAccount.signIn.cancel': defineCanopyInstruction({
      plane: 'core',
      domain: 'integration',
      version: 1,
      placement: 'core-only',
      params: CoreCloudAccountSignInCancelParamsSchema,
      result: CoreCloudAccountSignInCancelResultSchema,
      error: inherentOperationErrorSchema(
        CORE_CLOUD_ACCOUNT_SIGN_IN_CANCEL_ERROR_CODES,
      ),
      idempotency: 'inherent',
      requiredGrants: ['core.integration.write'],
    }),
    'core.integration.cloudAccount.connectWithKey': defineCanopyInstruction({
      plane: 'core',
      domain: 'integration',
      version: 1,
      placement: 'core-only',
      params: CoreCloudAccountConnectWithKeyParamsSchema,
      result: CoreCloudAccountConnectWithKeyResultSchema,
      error: keyedOperationErrorSchema(
        CORE_CLOUD_ACCOUNT_CONNECT_WITH_KEY_ERROR_CODES,
      ),
      idempotency: 'keyed',
      requiredGrants: ['core.integration.write'],
    }),
    'core.integration.cloudAccount.disconnect': defineCanopyInstruction({
      plane: 'core',
      domain: 'integration',
      version: 1,
      placement: 'core-only',
      params: CoreCloudAccountDisconnectParamsSchema,
      result: CoreCloudAccountDisconnectResultSchema,
      error: inherentOperationErrorSchema(
        CORE_CLOUD_ACCOUNT_DISCONNECT_ERROR_CODES,
      ),
      idempotency: 'inherent',
      requiredGrants: ['core.integration.write'],
    }),
    'core.integration.cloudAccount.resetUnreadable': defineCanopyInstruction({
      plane: 'core',
      domain: 'integration',
      version: 1,
      placement: 'core-only',
      params: CoreCloudAccountResetUnreadableParamsSchema,
      result: CoreCloudAccountResetUnreadableResultSchema,
      error: inherentOperationErrorSchema(
        CORE_CLOUD_ACCOUNT_RESET_UNREADABLE_ERROR_CODES,
      ),
      idempotency: 'inherent',
      requiredGrants: ['core.integration.write'],
    }),
  });
