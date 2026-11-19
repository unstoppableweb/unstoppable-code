import { z } from 'zod';
import type { AppError } from './app-errors';
import {
  AppErrorCopySchema,
  AppErrorDetailSchema,
  AppErrorIdentifierSchema,
  AppErrorKindSchema,
  AppErrorTimestampSchema,
} from './app-errors/primitives';

export const FEEDBACK_REPORT_TYPES = ['bug', 'idea'] as const;
export type FeedbackReportType = (typeof FEEDBACK_REPORT_TYPES)[number];
export const MAX_FEEDBACK_DESCRIPTION_LENGTH = 20_000;
export const MAX_FEEDBACK_TITLE_LENGTH = 200;
export const MAX_FEEDBACK_DETAIL_BYTES = 64 * 1024;
export const MAX_FEEDBACK_DETAIL_ENCODED_LENGTH = Math.ceil(
  (MAX_FEEDBACK_DETAIL_BYTES * 4) / 3,
);
export const MAX_FEEDBACK_ARCHIVE_BYTES = 25 * 1024 * 1024;
export const MAX_FEEDBACK_ARCHIVE_EXPANDED_BYTES = 100 * 1024 * 1024;
export const MAX_FEEDBACK_ARCHIVE_ENTRIES = 5000;
export const MAX_FEEDBACK_ENTRY_PREVIEW_BYTES = 256 * 1024;

export const FeedbackReferenceIdSchema = z
  .string()
  .regex(/^(ERR|REP)-[0-9A-HJKMNP-TV-Z]{8}$/);
export const FeedbackSessionIdSchema = z.string().uuid();
export const FeedbackReportContextSchema = z
  .object({
    activePage: z.string().max(1024).optional(),
    workspaceId: z.string().max(1024).optional(),
    workspaceName: z.string().max(1024).optional(),
    worktreeId: z.string().max(1024).optional(),
    worktreeName: z.string().max(1024).optional(),
    chatProjectId: z.string().max(1024).optional(),
    chatId: z.string().max(1024).optional(),
    provider: z.string().max(1024).optional(),
    model: z.string().max(1024).optional(),
    appVersion: z.string().max(1024).optional(),
    platform: z.string().max(1024).optional(),
  })
  .strict();
export type FeedbackReportContext = z.infer<typeof FeedbackReportContextSchema>;
export type FeedbackContextSnapshot = FeedbackReportContext;

export const FeedbackReportErrorSchema = z
  .object({
    referenceId: z.string().regex(/^ERR-[0-9A-HJKMNP-TV-Z]{8}$/),
    // Accept future catalog codes from newer clients.
    code: AppErrorIdentifierSchema,
    kind: AppErrorKindSchema,
    occurredAt: AppErrorTimestampSchema,
    copy: AppErrorCopySchema,
    detail: AppErrorDetailSchema,
  })
  .strict();
export type FeedbackReportError = z.infer<typeof FeedbackReportErrorSchema>;

/** SDK validation; hosted callers must additionally enforce an origin allowlist. */
export function validatedPostHogReplayUrl(
  value: unknown,
  sessionId: string,
): string | undefined {
  if (
    !FeedbackSessionIdSchema.safeParse(sessionId).success ||
    typeof value !== 'string' ||
    value.length > 2048
  )
    return undefined;
  try {
    const url = new URL(value);
    if (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      new RegExp(`^/project/[a-z0-9_-]+/replay/${sessionId}/?$`, 'i').test(
        url.pathname,
      )
    )
      return url.href;
  } catch {
    /* Invalid SDK identities never interrupt capture. */
  }
  return undefined;
}

export const FeedbackReportTelemetrySchema = z
  .object({
    datadogSessionId: FeedbackSessionIdSchema.optional(),
    posthogSessionId: FeedbackSessionIdSchema.optional(),
    posthogReplayUrl: z.string().url().max(2048).optional(),
  })
  .strict();
export type FeedbackReportTelemetry = z.infer<
  typeof FeedbackReportTelemetrySchema
>;
export interface FeedbackReportDraft {
  context: FeedbackReportContext;
  telemetry?: FeedbackReportTelemetry;
  /**
   * What the executing host offers for this opening. `snapshot` is the exact
   * prepare/inspect/submit flow; `host-collected` is an older host that builds
   * its own archive at submission and cannot be previewed. Absent means none.
   */
  diagnostics?: 'snapshot' | 'host-collected';
}

export const FeedbackDiagnosticsSnapshotIdSchema = z.string().uuid();
export const FeedbackReportSubmissionSchema = z
  .object({
    type: z.enum(FEEDBACK_REPORT_TYPES),
    description: z.string().trim().min(1).max(MAX_FEEDBACK_DESCRIPTION_LENGTH),
    title: z.string().max(MAX_FEEDBACK_TITLE_LENGTH).optional(),
    context: FeedbackReportContextSchema,
    includeDiagnostics: z.boolean(),
    error: FeedbackReportErrorSchema.optional(),
    telemetry: FeedbackReportTelemetrySchema.optional(),
    diagnosticsSnapshotId: FeedbackDiagnosticsSnapshotIdSchema.optional(),
    // One key per intentional submission, retained across transport retries.
    submissionId: z.string().uuid().optional(),
  })
  .strict();
export type FeedbackReportSubmission = z.infer<
  typeof FeedbackReportSubmissionSchema
>;
export const FeedbackReportResultSchema = z.object({
  referenceId: FeedbackReferenceIdSchema.optional(),
  diagnosticsStatus: z
    .enum(['not-requested', 'pending', 'attached', 'unavailable'])
    .optional(),
});
export type FeedbackReportResult = z.infer<typeof FeedbackReportResultSchema>;

export interface FeedbackDiagnosticsSnapshot {
  id: string;
  preparedAt: string;
  expiresAt: string;
  sizeBytes: number;
  entries: { path: string; sizeBytes: number }[];
  skippedEntries: { path: string; reason: string }[];
  /** Exactly the final feedback.json entry in the prepared archive. */
  manifest: string;
}
export type FeedbackDiagnosticsEntryContent =
  | { kind: 'text'; text: string }
  | { kind: 'download-required'; reason: 'binary' | 'too-large' };
/** Hosted `code` for a report whose filing could not be confirmed. */
export const FEEDBACK_OUTCOME_UNKNOWN_CODE = 'feedback_outcome_unknown';
/** The host could not say whether the report was filed; retry the same intent. */
export class FeedbackOutcomeUnknownError extends Error {
  constructor(message = 'The report outcome is unknown.') {
    super(message);
    this.name = 'FeedbackOutcomeUnknownError';
  }
}
/** This intent already filed different text; the edit can't join that report. */
export class FeedbackSubmissionConflictError extends Error {
  constructor(message = 'This submission already filed different feedback.') {
    super(message);
    this.name = 'FeedbackSubmissionConflictError';
  }
}
/** The snapshot expired or its scope changed; only a new preview can continue. */
export class FeedbackDiagnosticsExpiredError extends Error {
  constructor(message = 'The diagnostics preview expired.') {
    super(message);
    this.name = 'FeedbackDiagnosticsExpiredError';
  }
}
export interface FeedbackReportClient {
  /** Host build policy. Missing fails closed; raw contents remain downloadable. */
  readonly diagnosticTextVisibility?: 'inline' | 'download-only';
  draft(): Promise<FeedbackReportDraft>;
  submit(request: FeedbackReportSubmission): Promise<FeedbackReportResult>;
  prepareDiagnostics?(request: {
    context: FeedbackReportContext;
    error?: FeedbackReportError;
  }): Promise<FeedbackDiagnosticsSnapshot>;
  readDiagnosticsEntry?(
    snapshotId: string,
    entryPath: string,
  ): Promise<FeedbackDiagnosticsEntryContent>;
  saveDiagnostics?(snapshotId: string): Promise<void>;
  releaseDiagnostics?(snapshotId: string): Promise<void>;
  /** Offline copy from an older host, which cannot save a prepared snapshot. */
  saveCollectedDiagnostics?(request: {
    context: FeedbackReportContext;
    description: string;
    error?: FeedbackReportError;
  }): Promise<{ filename: string }>;
}

export function toFeedbackReportError(error: AppError): FeedbackReportError {
  const { referenceId, code, kind, occurredAt, copy, detail } = error;
  return FeedbackReportErrorSchema.parse({
    referenceId,
    code,
    kind,
    occurredAt,
    copy,
    detail,
  });
}

function encodeBytes(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function encodeFeedbackErrorDetail(
  detail: FeedbackReportError['detail'],
): string {
  const wireDetail = AppErrorDetailSchema.parse(detail);
  // Older web deployments decode with a strict schema that predates `errno`.
  delete wireDetail.errno;
  const bytes = new TextEncoder().encode(JSON.stringify(wireDetail));
  if (bytes.byteLength > MAX_FEEDBACK_DETAIL_BYTES)
    throw new Error('Error detail exceeds the report size limit.');
  return encodeBytes(bytes);
}

export function decodeFeedbackErrorDetail(
  encoded: string,
): FeedbackReportError['detail'] {
  if (
    encoded.length === 0 ||
    encoded.length > MAX_FEEDBACK_DETAIL_ENCODED_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(encoded) ||
    encoded.length % 4 === 1
  )
    throw new Error('Invalid encoded error detail.');
  const decodedLength = Math.floor((encoded.length * 3) / 4);
  if (decodedLength > MAX_FEEDBACK_DETAIL_BYTES)
    throw new Error('Error detail exceeds the report size limit.');
  const binary = atob(encoded.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (encodeBytes(bytes) !== encoded)
    throw new Error('Invalid encoded error detail.');
  return AppErrorDetailSchema.parse(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
  );
}

const EncodedDetailSchema = z
  .string()
  .max(MAX_FEEDBACK_DETAIL_ENCODED_LENGTH)
  .transform((value, ctx) => {
    try {
      return decodeFeedbackErrorDetail(value);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Invalid or oversized encoded error detail.',
      });
      return z.NEVER;
    }
  });
export const FeedbackReportErrorWireSchema = FeedbackReportErrorSchema.omit({
  detail: true,
})
  .extend({ detailBase64Url: EncodedDetailSchema })
  .transform(({ detailBase64Url, ...error }) => ({
    ...error,
    detail: detailBase64Url,
  }));
export type FeedbackReportErrorWire = z.input<
  typeof FeedbackReportErrorWireSchema
>;
export function encodeFeedbackReportError(
  error: FeedbackReportError,
): FeedbackReportErrorWire {
  const { detail, ...identity } = FeedbackReportErrorSchema.parse(error);
  return { ...identity, detailBase64Url: encodeFeedbackErrorDetail(detail) };
}
