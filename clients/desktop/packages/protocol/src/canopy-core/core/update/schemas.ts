import { z } from 'zod';

import { CanopyRequestMetadataSchema } from '../../common';
import { CanopyStreamCursorSchema } from '../../definitions';
import { CanopyJsonValueSchema } from '../../errors';
import { OperationStatusSchema } from '../operation/schemas';

const id = z.string().min(1).max(512);
const version = z.string().min(1).max(128);
const timestamp = z.iso.datetime({ offset: true });
const reason = z.string().min(1).max(128);

export const UPDATE_COMPONENTS = [
  'daemon',
  'desktop',
  'cli',
  'worker',
  'browser_engine',
  'provider_binary',
] as const;
export const UpdateComponentSchema = z.enum(UPDATE_COMPONENTS);
export type UpdateComponent = z.output<typeof UpdateComponentSchema>;

/**
 * Release channels. A desktop build's compiled flavor maps onto them: `stable`
 * to `stable`, `rc` to `candidate` and `internal` to `development`.
 */
export const UPDATE_CHANNELS = ['stable', 'candidate', 'development'] as const;
export const UpdateChannelSchema = z.enum(UPDATE_CHANNELS);
export type UpdateChannel = z.output<typeof UpdateChannelSchema>;

export const UPDATE_COMPONENT_STATES = [
  'idle',
  'checking',
  'available',
  'downloading',
  'ready',
  'applying',
  'failed',
] as const;
export const UpdateComponentStateSchema = z.enum(UPDATE_COMPONENT_STATES);
export type UpdateComponentState = z.output<typeof UpdateComponentStateSchema>;

export const UPDATE_RESTART_POLICIES = [
  'when_idle',
  'prompt',
  'immediate',
] as const;
export const UpdateRestartPolicySchema = z.enum(UPDATE_RESTART_POLICIES);
export type UpdateRestartPolicy = z.output<typeof UpdateRestartPolicySchema>;

/** A package digest as its feed publishes it: hex SHA-256 or base64 SHA-512. */
export const UpdateDigestSchema = z.strictObject({
  algorithm: z.enum(['sha256', 'sha512']),
  value: z.string().min(1).max(256),
});
export type UpdateDigest = z.output<typeof UpdateDigestSchema>;

/** Who asked for a pending restart; null when it was the host's own user. */
export const UpdateRestartPendingSchema = z.strictObject({
  policy: z.enum(['when_idle', 'immediate']),
  requestedBy: z
    .strictObject({ principalId: id, name: z.string().min(1).max(120) })
    .nullable(),
});

/** An install that restarted without reaching its version. */
export const UpdateFailedAttemptSchema = z.strictObject({
  targetVersion: version,
  at: timestamp,
  requestedBy: z.string().min(1).max(120).nullable(),
  outcome: z.literal('failed'),
});

/** What a `when_idle` restart is waiting for. */
export const UpdateBlockersSchema = z.strictObject({
  activeChatWork: z.boolean(),
  windowBusy: z.boolean(),
});

/**
 * One component's update state. The required fields are the catalog's; the
 * optional ones are what a desktop host adds, and readers ignore fields they
 * do not know.
 */
export const UpdateComponentStatusSchema = z
  .object({
    component: UpdateComponentSchema,
    currentVersion: version,
    availableVersion: version.nullable(),
    state: UpdateComponentStateSchema,
    mandatory: z.boolean(),
    progress: z.number().min(0).max(1).nullable(),
    errorCode: z.string().max(512).nullable(),
    updatedAt: timestamp,
    /** The build's compiled flavor: `stable`, `rc` or `internal`. */
    releaseFlavor: reason.optional(),
    /** The version as the host shows it, such as `internal-123`. */
    displayVersion: version.optional(),
    availableDisplayVersion: version.nullable().optional(),
    /** False when the host cannot apply this component's updates itself. */
    supported: z.boolean().optional(),
    unsupportedReason: reason.optional(),
    /** Steps the host gives for a manual update, already in its own words. */
    manualInstructions: z.string().min(1).max(4096).optional(),
    restartPending: UpdateRestartPendingSchema.nullable().optional(),
    blockers: UpdateBlockersSchema.optional(),
    message: z.string().max(4096).nullable().optional(),
    /** The person at the host allows paired computers to update it. */
    remoteUpdatesAllowed: z.boolean().optional(),
    /** The last install that restarted on the old version; null when none. */
    lastAttempt: UpdateFailedAttemptSchema.nullable().optional(),
  })
  .catchall(CanopyJsonValueSchema);
export type UpdateComponentStatus = z.output<
  typeof UpdateComponentStatusSchema
>;

export const UpdateStatusGetParamsSchema = z.strictObject({
  components: z.array(UpdateComponentSchema).max(16).optional(),
});
export const UpdateStatusGetResultSchema = z
  .object({
    components: z.array(UpdateComponentStatusSchema),
    /** Monotonic aggregate revision. */
    policyRevision: z.number().int().min(0),
  })
  .catchall(CanopyJsonValueSchema);
export type UpdateStatusGetResult = z.output<
  typeof UpdateStatusGetResultSchema
>;

const KeyedMetadataSchema = CanopyRequestMetadataSchema.required({
  idempotencyKey: true,
});

export const UpdateCheckParamsSchema = z.strictObject({
  components: z.array(z.string().min(1).max(128)).min(1).max(16),
  channel: UpdateChannelSchema,
  requestedVersion: version.nullable(),
  force: z.boolean(),
  _meta: KeyedMetadataSchema,
});
export type UpdateCheckParams = z.output<typeof UpdateCheckParamsSchema>;

export const UpdateCheckResultSchema = z.strictObject({
  operation: z.strictObject({
    operationId: id,
    state: z.enum([
      'queued',
      'running',
      'waiting',
      'succeeded',
      'failed',
      'cancelled',
    ]),
  }),
  checkedComponents: z.array(z.string().max(128)),
});
export type UpdateCheckResult = z.output<typeof UpdateCheckResultSchema>;

export const UpdateOperationRefSchema = z
  .object({
    operationId: id,
    kind: z.string().regex(/^(core|worker)(\.[a-z][A-Za-z0-9]*){2,}$/),
    status: OperationStatusSchema,
    authorityId: z.string().max(512).nullable().optional(),
    executionTargetId: z.string().max(512).nullable().optional(),
    runtimeDelegationId: z.string().max(512).nullable().optional(),
    parentOperationId: z.string().max(512).nullable().optional(),
  })
  // Results may gain additive fields, as the catalog page allows.
  .catchall(CanopyJsonValueSchema);
export type UpdateOperationRef = z.output<typeof UpdateOperationRefSchema>;

export const UpdateDownloadParamsSchema = z.strictObject({
  component: UpdateComponentSchema,
  /** The host's current candidate, as its status names it. */
  version,
  /** When given, must match the candidate's published digest. */
  expectedDigest: UpdateDigestSchema.optional(),
  _meta: KeyedMetadataSchema,
});
export type UpdateDownloadParams = z.output<typeof UpdateDownloadParamsSchema>;

export const UpdateApplyParamsSchema = z.strictObject({
  component: UpdateComponentSchema,
  version,
  clientLeaseId: z.string().max(512).nullable().optional(),
  restartPolicy: UpdateRestartPolicySchema,
  _meta: KeyedMetadataSchema,
});
export type UpdateApplyParams = z.output<typeof UpdateApplyParamsSchema>;

export const UpdateApplyCancelParamsSchema = z.strictObject({
  component: UpdateComponentSchema,
});
export const UpdateApplyCancelResultSchema = z.strictObject({
  component: UpdateComponentSchema,
  /** False when no restart was pending, or it was not this caller's. */
  cancelled: z.boolean(),
});
export type UpdateApplyCancelResult = z.output<
  typeof UpdateApplyCancelResultSchema
>;

/**
 * Opening without a cursor sends each requested component's current state.
 * The stream carries latest state, not history: a cursor from this stream
 * resumes with the current state of each component.
 */
export const UpdateEventsParamsSchema = z.strictObject({
  components: z.array(UpdateComponentSchema).max(16).optional(),
  cursor: CanopyStreamCursorSchema.nullable().optional(),
});
export const UpdateEventsOpenResultSchema = z.strictObject({
  subscriptionId: id,
  acceptedCursor: CanopyStreamCursorSchema.nullable(),
});
