import {
  MEMORY_SYNC_ACCOUNT_HEADER,
  MEMORY_SYNC_DEVICE_SESSION_HEADER,
  MEMORY_SYNC_LIMITS,
  MEMORY_SYNC_PROTOCOL_HEADER,
  MEMORY_SYNC_PROTOCOL_VERSION,
  MEMORY_SYNC_PURGE_CONFIRMATION,
  MEMORY_SYNC_ROUTES,
  MemoryChangesPageSchema,
  MemoryCommitRequestSchema,
  MemoryCommitResponseSchema,
  MemoryDeviceRegisterRequestSchema,
  MemoryDeviceRegisterResponseSchema,
  MemoryLeaseAcquireRequestSchema,
  MemoryLeaseAcquireResponseSchema,
  MemoryLeaseReleaseRequestSchema,
  MemoryLeaseRenewRequestSchema,
  MemoryLeaseRenewResponseSchema,
  MemoryNotesPushRequestSchema,
  MemoryNotesPushResponseSchema,
  MemoryProjectSettingListResponseSchema,
  MemoryProjectSettingRequestSchema,
  MemoryProjectSettingResponseSchema,
  MemoryPurgeRequestSchema,
  MemoryRestoreRequestSchema,
  MemoryRevisionListResponseSchema,
  MemoryScopeResolveRequestSchema,
  MemoryScopeResolveResponseSchema,
  MemorySnapshotPageSchema,
  MemorySyncErrorResponseSchema,
  MemorySyncSettingsResponseSchema,
  MemorySyncSettingsUpdateRequestSchema,
  MemoryUsagePushRequestSchema,
  type MemoryChangesPage,
  type MemoryCommitRequest,
  type MemoryCommitResponse,
  type MemoryDeviceRegisterRequest,
  type MemoryDeviceRegisterResponse,
  type MemoryLeaseAcquireResponse,
  type MemoryLeaseFence,
  type MemoryNotesPushRequest,
  type MemoryNotesPushResponse,
  type MemoryProjectSettingList,
  type MemoryScopeRef,
  type MemorySnapshotPage,
  type MemorySyncErrorCode,
  type MemorySyncErrorResponse,
} from '@canopy/protocol/memory-sync';
import { z } from 'zod';

/*
 * The memory sync HTTP API (design §7) as the engine calls it. The host
 * supplies the raw request (base URL, bearer key, fetch); this module adds the
 * protocol headers, refuses to send what the contract would refuse, checks
 * every answer against its schema, and turns every failure into what the
 * engine should do next. Nothing here throws.
 */

export interface MemorySyncHttpRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Path and query, from `MEMORY_SYNC_ROUTES`. */
  path: string;
  headers: Readonly<Record<string, string>>;
  body?: string;
  /** A longer answer is refused unread. */
  maxResponseBytes: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface MemorySyncHttpResponse {
  status: number;
  /** The parsed JSON body; undefined when there was none or it was not JSON. */
  body: unknown;
  retryAfterMs?: number;
}

/** Rejects when the request did not complete (network, timeout, abort). */
export type MemorySyncHttp = (
  request: MemorySyncHttpRequest,
) => Promise<MemorySyncHttpResponse>;

/** Why a call failed, as what the engine does about it. */
export type MemorySyncFailure =
  /** The network, the server, ingest switched off, a rate limit: wait. */
  | { kind: 'retry'; code: string; retryAfterMs?: number }
  /** The device session is unknown: register again, then retry. */
  | { kind: 'register'; code: MemorySyncErrorCode }
  /** The cursor is gone: take a snapshot. */
  | { kind: 'snapshot'; code: MemorySyncErrorCode }
  /** A compare-and-set or lease refusal: pull, then decide. */
  | {
      kind: 'conflict';
      code: MemorySyncErrorCode;
      headRevision?: number;
      noteIds?: readonly string[];
      retryAfterMs?: number;
    }
  /** Sync is off for the account: replicas pause and keep working. */
  | { kind: 'paused'; code: MemorySyncErrorCode }
  /** The project keeps its memory on its devices. */
  | { kind: 'device_only'; code: MemorySyncErrorCode }
  /** The scope was deleted from the cloud. */
  | { kind: 'scope_deleted'; code: MemorySyncErrorCode }
  /** This engine must stop: another session, another account, no access. */
  | { kind: 'stop'; code: string }
  /** The server needs a newer client (426). */
  | { kind: 'update_required'; minimumProtocolVersion?: number }
  /** Memory sync is not available to this account (404, rollout off). */
  | { kind: 'unavailable' }
  /** The server refused the request as it is; sending it again won't help. */
  | { kind: 'refused'; code: string };

export type MemorySyncResult<Value> =
  | { ok: true; value: Value }
  | { ok: false; failure: MemorySyncFailure };

const STOP_CODES: ReadonlySet<MemorySyncErrorCode> = new Set([
  'memory_stale_session',
  'memory_account_mismatch',
  'memory_account_ineligible',
]);

function failureForError(
  response: MemorySyncHttpResponse,
  error: MemorySyncErrorResponse['error'],
): MemorySyncFailure {
  const retryAfterMs = error.retryAfterMs ?? response.retryAfterMs;
  const later = retryAfterMs === undefined ? {} : { retryAfterMs };
  switch (error.code) {
    case 'memory_unsupported_protocol':
      return {
        kind: 'update_required',
        ...(error.minimumProtocolVersion === undefined
          ? {}
          : { minimumProtocolVersion: error.minimumProtocolVersion }),
      };
    case 'memory_sync_disabled':
      return { kind: 'paused', code: error.code };
    case 'memory_scope_device_only':
      return { kind: 'device_only', code: error.code };
    case 'memory_scope_deleted':
      return { kind: 'scope_deleted', code: error.code };
    case 'memory_cursor_expired':
      return { kind: 'snapshot', code: error.code };
    case 'memory_device_unregistered':
      return { kind: 'register', code: error.code };
    default:
      break;
  }
  if (STOP_CODES.has(error.code)) return { kind: 'stop', code: error.code };
  switch (error.retry) {
    case 'later':
      return { kind: 'retry', code: error.code, ...later };
    case 'after_register':
      return { kind: 'register', code: error.code };
    case 'after_snapshot':
      return { kind: 'snapshot', code: error.code };
    case 'after_pull':
      return {
        kind: 'conflict',
        code: error.code,
        ...(error.headRevision === undefined
          ? {}
          : { headRevision: error.headRevision }),
        ...(error.noteIds === undefined ? {} : { noteIds: error.noteIds }),
        ...later,
      };
    case 'never':
      return error.code.startsWith('memory_lease') ||
        error.code === 'memory_revision_conflict' ||
        error.code === 'memory_notes_changed'
        ? { kind: 'conflict', code: error.code, ...later }
        : { kind: 'refused', code: error.code };
  }
}

/** What a non-2xx answer asks of the engine. */
export function memorySyncFailureForResponse(
  response: MemorySyncHttpResponse,
): MemorySyncFailure {
  const parsed = MemorySyncErrorResponseSchema.safeParse(response.body);
  if (parsed.success) return failureForError(response, parsed.data.error);
  const { status } = response;
  const later =
    response.retryAfterMs === undefined
      ? {}
      : { retryAfterMs: response.retryAfterMs };
  // Rollout off: the routes answer 404 without a code.
  if (status === 404) return { kind: 'unavailable' };
  if (status === 401 || status === 403) {
    return { kind: 'stop', code: 'unauthorized' };
  }
  if (status === 426) return { kind: 'update_required' };
  if (status === 408 || status === 425 || status === 429 || status >= 500) {
    return { kind: 'retry', code: `http_${status}`, ...later };
  }
  return { kind: 'refused', code: `http_${status}` };
}

const DEFAULT_TIMEOUT_MS = 15_000;
const LONG_TIMEOUT_MS = 30_000;
const SMALL_RESPONSE_MAX_BYTES = 1024 * 1024;

export interface MemorySyncTransport {
  readonly accountId: string;
  /** The device session writes carry; set by registration. */
  setDeviceSession(sessionId: string | null): void;
  register(
    request: MemoryDeviceRegisterRequest,
    signal?: AbortSignal,
  ): Promise<MemorySyncResult<MemoryDeviceRegisterResponse>>;
  resolveScope(
    scope: MemoryScopeRef,
    create: boolean,
    signal?: AbortSignal,
  ): Promise<
    MemorySyncResult<z.output<typeof MemoryScopeResolveResponseSchema>>
  >;
  settings(
    signal?: AbortSignal,
  ): Promise<
    MemorySyncResult<z.output<typeof MemorySyncSettingsResponseSchema>>
  >;
  /** The account's per-project modes (design §22). */
  projectSettings(
    signal?: AbortSignal,
  ): Promise<MemorySyncResult<MemoryProjectSettingList>>;
  /** Sets "keep memory on this device" for one project, on every device. */
  setProjectSetting(
    projectId: string,
    mode: 'sync' | 'device_only',
    signal?: AbortSignal,
  ): Promise<
    MemorySyncResult<z.output<typeof MemoryProjectSettingResponseSchema>>
  >;
  snapshotPage(
    scopeId: string,
    pageToken: string | null,
    signal?: AbortSignal,
  ): Promise<MemorySyncResult<MemorySnapshotPage>>;
  changesPage(
    scopeId: string,
    cursor: string,
    signal?: AbortSignal,
  ): Promise<MemorySyncResult<MemoryChangesPage>>;
  pushNotes(
    scopeId: string,
    request: MemoryNotesPushRequest,
    signal?: AbortSignal,
  ): Promise<MemorySyncResult<MemoryNotesPushResponse>>;
  acquireLease(
    scopeId: string,
    reason: z.output<typeof MemoryLeaseAcquireRequestSchema>['reason'],
    signal?: AbortSignal,
  ): Promise<MemorySyncResult<MemoryLeaseAcquireResponse>>;
  renewLease(
    scopeId: string,
    fence: MemoryLeaseFence,
    signal?: AbortSignal,
  ): Promise<MemorySyncResult<z.output<typeof MemoryLeaseRenewResponseSchema>>>;
  releaseLease(
    scopeId: string,
    request: z.output<typeof MemoryLeaseReleaseRequestSchema>,
    signal?: AbortSignal,
  ): Promise<MemorySyncResult<unknown>>;
  commit(
    scopeId: string,
    request: MemoryCommitRequest,
    signal?: AbortSignal,
  ): Promise<MemorySyncResult<MemoryCommitResponse>>;
  pushUsage(
    scopeId: string,
    request: z.output<typeof MemoryUsagePushRequestSchema>,
    signal?: AbortSignal,
  ): Promise<MemorySyncResult<unknown>>;
  updateSettings(
    request: z.output<typeof MemorySyncSettingsUpdateRequestSchema>,
    signal?: AbortSignal,
  ): Promise<
    MemorySyncResult<z.output<typeof MemorySyncSettingsResponseSchema>>
  >;
  listRevisions(
    scopeId: string,
    before: number | null,
    signal?: AbortSignal,
  ): Promise<
    MemorySyncResult<z.output<typeof MemoryRevisionListResponseSchema>>
  >;
  restore(
    scopeId: string,
    request: z.output<typeof MemoryRestoreRequestSchema>,
    signal?: AbortSignal,
  ): Promise<MemorySyncResult<MemoryCommitResponse>>;
  /**
   * "Delete from the cloud": every scope and device of the account, and
   * sync off. The device session ends with it.
   */
  purge(signal?: AbortSignal): Promise<MemorySyncResult<unknown>>;
}

/** A 204 has no body; any 2xx answer is the acknowledgement. */
const NoContentSchema = z.unknown();

interface CallSpec<Response> {
  method: MemorySyncHttpRequest['method'];
  path: string;
  body?: unknown;
  requestSchema?: z.ZodType;
  responseSchema: z.ZodType<Response>;
  /** Writes carry the device session once there is one. */
  write: boolean;
  maxResponseBytes?: number;
  timeoutMs?: number;
  /** An answer about something else is no answer. */
  accept?: (value: Response) => boolean;
}

function withQuery(
  path: string,
  query: Readonly<Record<string, string | null>>,
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== null) params.set(key, value);
  }
  const search = params.toString();
  return search.length > 0 ? `${path}?${search}` : path;
}

export function createMemorySyncTransport(
  accountId: string,
  http: MemorySyncHttp,
): MemorySyncTransport {
  let deviceSessionId: string | null = null;

  async function call<Response>(
    spec: CallSpec<Response>,
    signal: AbortSignal | undefined,
  ): Promise<MemorySyncResult<Response>> {
    if (spec.requestSchema !== undefined) {
      const outgoing = spec.requestSchema.safeParse(spec.body);
      if (!outgoing.success) {
        return {
          ok: false,
          failure: { kind: 'refused', code: 'memory_invalid_request' },
        };
      }
    }
    const headers: Record<string, string> = {
      [MEMORY_SYNC_PROTOCOL_HEADER]: String(MEMORY_SYNC_PROTOCOL_VERSION),
      [MEMORY_SYNC_ACCOUNT_HEADER]: accountId,
      ...(spec.write && deviceSessionId !== null
        ? { [MEMORY_SYNC_DEVICE_SESSION_HEADER]: deviceSessionId }
        : {}),
    };
    let response: MemorySyncHttpResponse;
    try {
      response = await http({
        method: spec.method,
        path: spec.path,
        headers,
        ...(spec.body === undefined ? {} : { body: JSON.stringify(spec.body) }),
        maxResponseBytes: spec.maxResponseBytes ?? SMALL_RESPONSE_MAX_BYTES,
        timeoutMs: spec.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch {
      return { ok: false, failure: { kind: 'retry', code: 'network' } };
    }
    if (response.status < 200 || response.status >= 300) {
      return { ok: false, failure: memorySyncFailureForResponse(response) };
    }
    const parsed = spec.responseSchema.safeParse(response.body);
    if (!parsed.success || (spec.accept && !spec.accept(parsed.data))) {
      return {
        ok: false,
        failure: { kind: 'retry', code: 'invalid_response' },
      };
    }
    return { ok: true, value: parsed.data };
  }

  return {
    accountId,
    setDeviceSession(sessionId): void {
      deviceSessionId = sessionId;
    },
    register: (request, signal) =>
      call(
        {
          method: 'POST',
          path: MEMORY_SYNC_ROUTES.deviceRegister(),
          body: request,
          requestSchema: MemoryDeviceRegisterRequestSchema,
          responseSchema: MemoryDeviceRegisterResponseSchema,
          write: true,
        },
        signal,
      ),
    resolveScope: (scope, create, signal) =>
      call(
        {
          method: 'POST',
          path: MEMORY_SYNC_ROUTES.scopeResolve(),
          body: { scope, create },
          requestSchema: MemoryScopeResolveRequestSchema,
          responseSchema: MemoryScopeResolveResponseSchema,
          write: true,
          accept: (value) =>
            value.scope.accountId === accountId &&
            value.scope.kind === scope.kind &&
            value.scope.projectId ===
              (scope.kind === 'project' ? scope.projectId : null),
        },
        signal,
      ),
    settings: (signal) =>
      call(
        {
          method: 'GET',
          path: MEMORY_SYNC_ROUTES.settings(),
          responseSchema: MemorySyncSettingsResponseSchema,
          write: false,
        },
        signal,
      ),
    projectSettings: (signal) =>
      call(
        {
          method: 'GET',
          path: MEMORY_SYNC_ROUTES.projectSettings(),
          responseSchema: MemoryProjectSettingListResponseSchema,
          write: false,
        },
        signal,
      ),
    setProjectSetting: (projectId, mode, signal) =>
      call(
        {
          method: 'PUT',
          path: MEMORY_SYNC_ROUTES.projectSetting(projectId),
          body: { mode },
          requestSchema: MemoryProjectSettingRequestSchema,
          responseSchema: MemoryProjectSettingResponseSchema,
          write: true,
          accept: (value) =>
            value.projectId === projectId && value.mode === mode,
        },
        signal,
      ),
    snapshotPage: (scopeId, pageToken, signal) =>
      call(
        {
          method: 'GET',
          path: withQuery(MEMORY_SYNC_ROUTES.snapshot(scopeId), { pageToken }),
          responseSchema: MemorySnapshotPageSchema,
          write: false,
          maxResponseBytes:
            MEMORY_SYNC_LIMITS.snapshotPageMaxBytes +
            MEMORY_SYNC_LIMITS.changesPageEnvelopeMaxBytes,
          timeoutMs: LONG_TIMEOUT_MS,
          accept: (page) => page.scopeId === scopeId,
        },
        signal,
      ),
    changesPage: (scopeId, cursor, signal) =>
      call(
        {
          method: 'GET',
          path: withQuery(MEMORY_SYNC_ROUTES.changes(scopeId), {
            cursor,
            limit: String(MEMORY_SYNC_LIMITS.changesPageMax),
          }),
          responseSchema: MemoryChangesPageSchema,
          write: false,
          maxResponseBytes: MEMORY_SYNC_LIMITS.changesPageHardMaxBytes,
          timeoutMs: LONG_TIMEOUT_MS,
          accept: (page) => page.scopeId === scopeId,
        },
        signal,
      ),
    pushNotes: (scopeId, request, signal) =>
      call(
        {
          method: 'POST',
          path: MEMORY_SYNC_ROUTES.notes(scopeId),
          body: request,
          requestSchema: MemoryNotesPushRequestSchema,
          responseSchema: MemoryNotesPushResponseSchema,
          write: true,
          timeoutMs: LONG_TIMEOUT_MS,
        },
        signal,
      ),
    acquireLease: (scopeId, reason, signal) =>
      call(
        {
          method: 'POST',
          path: MEMORY_SYNC_ROUTES.leaseAcquire(scopeId),
          body: { reason },
          requestSchema: MemoryLeaseAcquireRequestSchema,
          responseSchema: MemoryLeaseAcquireResponseSchema,
          write: true,
        },
        signal,
      ),
    renewLease: (scopeId, fence, signal) =>
      call(
        {
          method: 'POST',
          path: MEMORY_SYNC_ROUTES.leaseRenew(scopeId),
          body: fence,
          requestSchema: MemoryLeaseRenewRequestSchema,
          responseSchema: MemoryLeaseRenewResponseSchema,
          write: true,
          accept: (value) =>
            value.lease.leaseId === fence.leaseId &&
            value.lease.epoch === fence.epoch,
        },
        signal,
      ),
    releaseLease: (scopeId, request, signal) =>
      call(
        {
          method: 'POST',
          path: MEMORY_SYNC_ROUTES.leaseRelease(scopeId),
          body: request,
          requestSchema: MemoryLeaseReleaseRequestSchema,
          responseSchema: NoContentSchema,
          write: true,
        },
        signal,
      ),
    commit: (scopeId, request, signal) =>
      call(
        {
          method: 'POST',
          path: MEMORY_SYNC_ROUTES.commits(scopeId),
          body: request,
          requestSchema: MemoryCommitRequestSchema,
          responseSchema: MemoryCommitResponseSchema,
          write: true,
          maxResponseBytes: MEMORY_SYNC_LIMITS.revisionEntryOverheadMaxBytes,
          timeoutMs: LONG_TIMEOUT_MS,
          accept: (value) =>
            value.revision.commitId === request.commitId &&
            value.revision.parentRevision === request.baseRevision,
        },
        signal,
      ),
    pushUsage: (scopeId, request, signal) =>
      call(
        {
          method: 'POST',
          path: MEMORY_SYNC_ROUTES.usage(scopeId),
          body: request,
          requestSchema: MemoryUsagePushRequestSchema,
          responseSchema: NoContentSchema,
          write: true,
        },
        signal,
      ),
    updateSettings: (request, signal) =>
      call(
        {
          method: 'PUT',
          path: MEMORY_SYNC_ROUTES.settings(),
          body: request,
          requestSchema: MemorySyncSettingsUpdateRequestSchema,
          responseSchema: MemorySyncSettingsResponseSchema,
          write: true,
        },
        signal,
      ),
    listRevisions: (scopeId, before, signal) =>
      call(
        {
          method: 'GET',
          path: withQuery(MEMORY_SYNC_ROUTES.revisions(scopeId), {
            before: before === null ? null : String(before),
            limit: String(MEMORY_SYNC_LIMITS.historyPageMax),
          }),
          responseSchema: MemoryRevisionListResponseSchema,
          write: false,
        },
        signal,
      ),
    restore: (scopeId, request, signal) =>
      call(
        {
          method: 'POST',
          path: MEMORY_SYNC_ROUTES.restore(scopeId),
          body: request,
          requestSchema: MemoryRestoreRequestSchema,
          responseSchema: MemoryCommitResponseSchema,
          write: true,
          maxResponseBytes: MEMORY_SYNC_LIMITS.revisionEntryOverheadMaxBytes,
          timeoutMs: LONG_TIMEOUT_MS,
          accept: (value) =>
            value.revision.commitId === request.commitId &&
            value.revision.parentRevision === request.baseRevision,
        },
        signal,
      ),
    purge: async (signal) => {
      const purged = await call(
        {
          method: 'POST',
          path: MEMORY_SYNC_ROUTES.purge(),
          body: { confirm: MEMORY_SYNC_PURGE_CONFIRMATION },
          requestSchema: MemoryPurgeRequestSchema,
          responseSchema: NoContentSchema,
          write: true,
          timeoutMs: LONG_TIMEOUT_MS,
        },
        signal,
      );
      // The purge deletes the account's devices, this session among them.
      if (purged.ok) deviceSessionId = null;
      return purged;
    },
  };
}
