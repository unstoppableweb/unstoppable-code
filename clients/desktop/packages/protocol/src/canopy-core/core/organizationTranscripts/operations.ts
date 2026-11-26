import { z } from 'zod';
import {
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
  defineCanopyQuery,
  defineCanopyQueryRegistry,
} from '../../definitions';
import { CanopyRequestMetadataSchema } from '../../common';
import {
  inherentOperationErrorSchema,
  keyedOperationErrorSchema,
} from '../shared';

/**
 * Organization transcripts: owners browse, download and export the chat
 * transcripts members share with the organization
 * (docs/organization-transcripts.md). Served by the web core only; desktop and
 * the daemon answer `capability_unavailable`.
 */

/** Sessions list page size: 50 by default, at most 100. */
export const ORG_TRANSCRIPT_SESSIONS_DEFAULT_LIMIT = 50;
export const ORG_TRANSCRIPT_SESSIONS_MAX_LIMIT = 100;
/** Exports and access log page size. */
export const ORG_TRANSCRIPT_LIST_DEFAULT_LIMIT = 25;
export const ORG_TRANSCRIPT_LIST_MAX_LIMIT = 100;
/** A date range spans at most 366 days. */
export const ORG_TRANSCRIPT_MAX_RANGE_DAYS = 366;
/** Export caps: sessions, and plaintext bytes of bodies plus extras. */
export const ORG_TRANSCRIPT_EXPORT_SESSION_LIMIT = 5000;
export const ORG_TRANSCRIPT_EXPORT_BYTE_LIMIT = 1024 * 1024 * 1024;
/** A Ready export can be downloaded for 7 days. */
export const ORG_TRANSCRIPT_EXPORT_RETENTION_DAYS = 7;
/** A single-session download is synchronous up to 50 MiB. */
export const ORG_TRANSCRIPT_SESSION_DOWNLOAD_BYTE_LIMIT = 50 * 1024 * 1024;

export const ORG_TRANSCRIPT_DOWNLOAD_FORMATS = ['md', 'jsonl'] as const;
export const OrgTranscriptDownloadFormatSchema = z.enum(
  ORG_TRANSCRIPT_DOWNLOAD_FORMATS,
);
export type OrgTranscriptDownloadFormat = z.output<
  typeof OrgTranscriptDownloadFormatSchema
>;

const isoInstant = z.iso.datetime({ offset: true });
const cursor = z.string().min(1).max(512);

/** A required `[from, to)` range of at most 366 days. */
const dateRangeShape = {
  from: isoInstant,
  to: isoInstant,
};

/**
 * Why a `[from, to)` range is invalid, or null. Params schemas stay plain
 * objects (so hosts can extend them); every server enforces this.
 */
export function orgTranscriptRangeProblem(range: {
  from: string;
  to: string;
}): string | null {
  const from = Date.parse(range.from);
  const to = Date.parse(range.to);
  if (!(from < to)) return 'to must be after from';
  if (to - from > ORG_TRANSCRIPT_MAX_RANGE_DAYS * 24 * 60 * 60 * 1000) {
    return `range must be at most ${ORG_TRANSCRIPT_MAX_RANGE_DAYS} days`;
  }
  return null;
}

/** Session-level filters shared by the list, the estimate and the export. */
const sessionFilterShape = {
  organizationId: z.uuid(),
  ...dateRangeShape,
  /** An opaque member ID the server issued (a user external ID). */
  memberUserId: z.uuid().optional(),
  /** An opaque project ID the server issued (a workspace external ID). */
  projectId: z.uuid().optional(),
  model: z.string().min(1).max(256).optional(),
};

export const OrgTranscriptMemberSchema = z.strictObject({
  /** Null when the user account no longer exists. */
  id: z.uuid().nullable(),
  name: z.string().nullable(),
  /** True when the user has no membership in the organization anymore. */
  formerMember: z.boolean(),
});
export type OrgTranscriptMember = z.output<typeof OrgTranscriptMemberSchema>;

export const OrgTranscriptProjectSchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
});

export const OrgTranscriptSessionStatusSchema = z.enum(['done', 'failed']);

export const OrgTranscriptSessionSummarySchema = z.strictObject({
  /** The canonical session ID: the lowest-id qualifying turn's external ID. */
  id: z.uuid(),
  member: OrgTranscriptMemberSchema,
  project: OrgTranscriptProjectSchema,
  branchName: z.string(),
  firstActivityAt: isoInstant,
  lastActivityAt: isoInstant,
  turnCount: z.number().int().min(0),
  model: z.string().nullable(),
  totalCostUsd: z.number().nullable(),
  status: OrgTranscriptSessionStatusSchema,
});
export type OrgTranscriptSessionSummary = z.output<
  typeof OrgTranscriptSessionSummarySchema
>;

export const OrgTranscriptFilterOptionsSchema = z.strictObject({
  members: z.array(OrgTranscriptMemberSchema.extend({ id: z.uuid() })),
  projects: z.array(OrgTranscriptProjectSchema),
  models: z.array(z.string()),
});
export type OrgTranscriptFilterOptions = z.output<
  typeof OrgTranscriptFilterOptionsSchema
>;

/**
 * One transcript message, the shape the memory explorer's transcript renderer
 * (`ExplorerTranscriptMessage`) already consumes.
 */
export const OrgTranscriptMessageSchema = z.strictObject({
  scope: z.literal('worktree'),
  localChatId: z.string(),
  localMessageId: z.string(),
  role: z.string(),
  status: z.string(),
  content: z.string(),
  occurredAt: isoInstant,
  parts: z.unknown().optional(),
});
export type OrgTranscriptMessage = z.output<typeof OrgTranscriptMessageSchema>;

export const OrgTranscriptTurnUnavailableSchema = z.enum([
  'missing',
  'undecryptable',
]);

export const OrgTranscriptTurnSchema = z.strictObject({
  id: z.uuid(),
  startedAt: isoInstant,
  completedAt: isoInstant.nullable(),
  model: z.string().nullable(),
  messages: z.array(OrgTranscriptMessageSchema),
  /** Set when this part of the transcript can't be read. */
  unavailable: OrgTranscriptTurnUnavailableSchema.optional(),
});
export type OrgTranscriptTurn = z.output<typeof OrgTranscriptTurnSchema>;

export const ORG_TRANSCRIPT_EXPORT_STATUSES = [
  'preparing',
  'ready',
  'failed',
  'expired',
] as const;
export const OrgTranscriptExportStatusSchema = z.enum(
  ORG_TRANSCRIPT_EXPORT_STATUSES,
);

export const ORG_TRANSCRIPT_EXPORT_FAILURE_REASONS = [
  'unreadable',
  'too_large',
  'storage_unavailable',
] as const;
export const OrgTranscriptExportFailureReasonSchema = z.enum(
  ORG_TRANSCRIPT_EXPORT_FAILURE_REASONS,
);

export const OrgTranscriptExportSchema = z.strictObject({
  id: z.uuid(),
  /** `deleted` exports are only returned by `exports.delete`. */
  status: z.enum([...ORG_TRANSCRIPT_EXPORT_STATUSES, 'deleted']),
  requestedAt: isoInstant,
  requestedBy: OrgTranscriptMemberSchema.nullable(),
  from: isoInstant,
  to: isoInstant,
  includePlans: z.boolean(),
  includeSummaries: z.boolean(),
  sessionCount: z.number().int().min(0).nullable(),
  sizeBytes: z.number().int().min(0).nullable(),
  readyAt: isoInstant.nullable(),
  expiresAt: isoInstant.nullable(),
  failureReason: OrgTranscriptExportFailureReasonSchema.nullable(),
});
export type OrgTranscriptExport = z.output<typeof OrgTranscriptExportSchema>;

export const ORG_TRANSCRIPT_ACCESS_EVENT_TYPES = [
  'session_viewed',
  'session_downloaded',
  'export_requested',
  'export_downloaded',
  'export_deleted',
] as const;

export const OrgTranscriptAccessEventSchema = z.strictObject({
  id: z.uuid(),
  type: z.enum(ORG_TRANSCRIPT_ACCESS_EVENT_TYPES),
  occurredAt: isoInstant,
  actor: OrgTranscriptMemberSchema.nullable(),
  subject: OrgTranscriptMemberSchema.nullable(),
  sessionId: z.uuid().nullable(),
  sessionBranchName: z.string().nullable(),
  /** The export's `requestedAt`, for export events. */
  exportRequestedAt: isoInstant.nullable(),
  sessionCount: z.number().int().min(0).nullable(),
  format: OrgTranscriptDownloadFormatSchema.nullable(),
});
export type OrgTranscriptAccessEvent = z.output<
  typeof OrgTranscriptAccessEventSchema
>;

export const OrgTranscriptSessionsListParamsSchema = z.strictObject({
  ...sessionFilterShape,
  cursor: cursor.optional(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(ORG_TRANSCRIPT_SESSIONS_MAX_LIMIT)
    .optional(),
  includeFilterOptions: z.boolean().optional(),
});
export type OrgTranscriptSessionsListParams = z.output<
  typeof OrgTranscriptSessionsListParamsSchema
>;

export const OrgTranscriptSessionsListResultSchema = z.strictObject({
  sessions: z.array(OrgTranscriptSessionSummarySchema),
  nextCursor: cursor.nullable(),
  filterOptions: OrgTranscriptFilterOptionsSchema.optional(),
});
export type OrgTranscriptSessionsListResult = z.output<
  typeof OrgTranscriptSessionsListResultSchema
>;

export const OrgTranscriptSessionGetParamsSchema = z.strictObject({
  organizationId: z.uuid(),
  sessionId: z.uuid(),
  turnsCursor: cursor.optional(),
});
export type OrgTranscriptSessionGetParams = z.output<
  typeof OrgTranscriptSessionGetParamsSchema
>;

export const OrgTranscriptSessionGetResultSchema = z.strictObject({
  session: OrgTranscriptSessionSummarySchema,
  turns: z.array(OrgTranscriptTurnSchema),
  nextTurnsCursor: cursor.nullable(),
});
export type OrgTranscriptSessionGetResult = z.output<
  typeof OrgTranscriptSessionGetResultSchema
>;

export const OrgTranscriptExportRequestParamsSchema = z.strictObject({
  ...sessionFilterShape,
  includePlans: z.boolean(),
  includeSummaries: z.boolean(),
});
export type OrgTranscriptExportRequestParams = z.output<
  typeof OrgTranscriptExportRequestParamsSchema
>;

export const OrgTranscriptExportEstimateResultSchema = z.strictObject({
  sessionCount: z.number().int().min(0),
  approximateBytes: z.number().int().min(0),
  tooLarge: z.boolean(),
  sessionLimit: z.number().int().min(1),
});
export type OrgTranscriptExportEstimateResult = z.output<
  typeof OrgTranscriptExportEstimateResultSchema
>;

export const OrgTranscriptExportsListParamsSchema = z.strictObject({
  organizationId: z.uuid(),
  cursor: cursor.optional(),
  limit: z.number().int().min(1).max(ORG_TRANSCRIPT_LIST_MAX_LIMIT).optional(),
});
export type OrgTranscriptExportsListParams = z.output<
  typeof OrgTranscriptExportsListParamsSchema
>;

export const OrgTranscriptExportsListResultSchema = z.strictObject({
  exports: z.array(OrgTranscriptExportSchema),
  nextCursor: cursor.nullable(),
  /** The org's QUEUED or RUNNING export, if any: Export is off while set. */
  activeExport: OrgTranscriptExportSchema.nullable(),
  /** False when export storage isn't configured: Export is off. */
  storageAvailable: z.boolean(),
});
export type OrgTranscriptExportsListResult = z.output<
  typeof OrgTranscriptExportsListResultSchema
>;

const keyedMeta = {
  _meta: CanopyRequestMetadataSchema.extend({
    idempotencyKey: z.string().min(1).max(512),
  }),
};

export const OrgTranscriptExportCreateParamsSchema =
  OrgTranscriptExportRequestParamsSchema.extend(keyedMeta);
export type OrgTranscriptExportCreateParams = z.output<
  typeof OrgTranscriptExportCreateParamsSchema
>;

export const OrgTranscriptExportDeleteParamsSchema = z.strictObject({
  organizationId: z.uuid(),
  exportId: z.uuid(),
  ...keyedMeta,
});
export type OrgTranscriptExportDeleteParams = z.output<
  typeof OrgTranscriptExportDeleteParamsSchema
>;

export const OrgTranscriptAccessEventsListParamsSchema =
  OrgTranscriptExportsListParamsSchema;
export type OrgTranscriptAccessEventsListParams =
  OrgTranscriptExportsListParams;

export const OrgTranscriptAccessEventsListResultSchema = z.strictObject({
  events: z.array(OrgTranscriptAccessEventSchema),
  nextCursor: cursor.nullable(),
});
export type OrgTranscriptAccessEventsListResult = z.output<
  typeof OrgTranscriptAccessEventsListResultSchema
>;

/** Operation-specific error codes. */
export const ORG_TRANSCRIPT_ERROR_CODES = {
  tooLarge: 'core.organizationTranscripts.exports.tooLarge',
  activeExportExists: 'core.organizationTranscripts.exports.activeExportExists',
  rateLimited: 'core.organizationTranscripts.exports.rateLimited',
  notDeletable: 'core.organizationTranscripts.exports.notDeletable',
  storageUnavailable: 'core.organizationTranscripts.storageUnavailable',
} as const;

/**
 * Owners only, and never through an agent: `agent-chat` sessions never hold
 * this grant.
 */
export const ORG_TRANSCRIPTS_GRANT = 'core.organizationTranscripts.owner';

const BASE = {
  plane: 'core',
  domain: 'organizationTranscripts',
  version: 1,
  placement: 'core-only',
} as const;

// Web-core only. Do not compose into desktop or daemon definitions.
export const CORE_ORGANIZATION_TRANSCRIPT_QUERIES = defineCanopyQueryRegistry(
  'core',
  {
    'core.organizationTranscripts.sessions.list': defineCanopyQuery({
      ...BASE,
      requiredGrants: ['core.organizationTranscripts.owner'],
      idempotency: 'inherent',
      params: OrgTranscriptSessionsListParamsSchema,
      result: OrgTranscriptSessionsListResultSchema,
      error: inherentOperationErrorSchema([
        ORG_TRANSCRIPT_ERROR_CODES.storageUnavailable,
      ]),
    }),
    'core.organizationTranscripts.session.get': defineCanopyQuery({
      ...BASE,
      requiredGrants: ['core.organizationTranscripts.owner'],
      idempotency: 'inherent',
      params: OrgTranscriptSessionGetParamsSchema,
      result: OrgTranscriptSessionGetResultSchema,
      error: inherentOperationErrorSchema([
        ORG_TRANSCRIPT_ERROR_CODES.storageUnavailable,
      ]),
    }),
    'core.organizationTranscripts.exports.estimate': defineCanopyQuery({
      ...BASE,
      requiredGrants: ['core.organizationTranscripts.owner'],
      idempotency: 'inherent',
      params: OrgTranscriptExportRequestParamsSchema,
      result: OrgTranscriptExportEstimateResultSchema,
      error: inherentOperationErrorSchema([
        ORG_TRANSCRIPT_ERROR_CODES.storageUnavailable,
      ]),
    }),
    'core.organizationTranscripts.exports.list': defineCanopyQuery({
      ...BASE,
      requiredGrants: ['core.organizationTranscripts.owner'],
      idempotency: 'inherent',
      params: OrgTranscriptExportsListParamsSchema,
      result: OrgTranscriptExportsListResultSchema,
      error: inherentOperationErrorSchema([
        ORG_TRANSCRIPT_ERROR_CODES.storageUnavailable,
      ]),
    }),
    'core.organizationTranscripts.accessEvents.list': defineCanopyQuery({
      ...BASE,
      requiredGrants: ['core.organizationTranscripts.owner'],
      idempotency: 'inherent',
      params: OrgTranscriptAccessEventsListParamsSchema,
      result: OrgTranscriptAccessEventsListResultSchema,
      error: inherentOperationErrorSchema([
        ORG_TRANSCRIPT_ERROR_CODES.storageUnavailable,
      ]),
    }),
  },
);

export const CORE_ORGANIZATION_TRANSCRIPT_INSTRUCTIONS =
  defineCanopyInstructionRegistry('core', {
    'core.organizationTranscripts.exports.create': defineCanopyInstruction({
      ...BASE,
      requiredGrants: ['core.organizationTranscripts.owner'],
      idempotency: 'keyed',
      params: OrgTranscriptExportCreateParamsSchema,
      result: OrgTranscriptExportSchema,
      error: keyedOperationErrorSchema([
        ORG_TRANSCRIPT_ERROR_CODES.tooLarge,
        ORG_TRANSCRIPT_ERROR_CODES.activeExportExists,
        ORG_TRANSCRIPT_ERROR_CODES.rateLimited,
        ORG_TRANSCRIPT_ERROR_CODES.storageUnavailable,
      ]),
    }),
    'core.organizationTranscripts.exports.delete': defineCanopyInstruction({
      ...BASE,
      requiredGrants: ['core.organizationTranscripts.owner'],
      idempotency: 'keyed',
      params: OrgTranscriptExportDeleteParamsSchema,
      result: OrgTranscriptExportSchema,
      error: keyedOperationErrorSchema([
        ORG_TRANSCRIPT_ERROR_CODES.notDeletable,
      ]),
    }),
  });
