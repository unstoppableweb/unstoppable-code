import { CanopyClientError } from '@canopy/core-client';
import { CanopyTransportError } from '@canopy/core-transport';
import {
  ORG_TRANSCRIPT_ERROR_CODES,
  type CanopyErrorPayload,
} from '@canopy/protocol/canopy-core';
import {
  SettingsOperationError,
  type SettingsOperationName,
} from '@canopy/protocol/settings';
import { ORGANIZATION_SETTINGS_OPERATIONS } from '@canopy/protocol/settings/operations-organization';
import type { OrganizationTranscriptSettingsCalls } from '../organization-capabilities/web-core-calls';
import type { SettingsOrchestratedOperation } from './account-organization-settings';

// ---------------------------------------------------------------------------
// The organization Transcripts pages on desktop (docs/organization-transcripts.md).
//
// Their settings table entries name web compatibility routes; desktop main
// answers them through `core.organizationTranscripts.*` on the web core
// instead, as the signed-in account, as the Project defaults page does. A
// refusal becomes the settings error the web route would have answered, so
// the shared pages handle both hosts alike. Downloads are not table entries;
// they go through the download channel (`services/organization-transcript-download.ts`).
// ---------------------------------------------------------------------------

const OPS = ORGANIZATION_SETTINGS_OPERATIONS;

function payloadOf(error: unknown): CanopyErrorPayload | null {
  if (error instanceof CanopyClientError) return error.payload;
  if (error instanceof CanopyTransportError) return error.payload;
  return null;
}

/**
 * The settings error for a failed call, matching the compat routes' statuses
 * and codes. A write whose refusal doesn't prove it never applied is
 * `uncertain`, never retried.
 */
export function organizationTranscriptsSettingsError(
  error: unknown,
  write: boolean,
): SettingsOperationError {
  const payload = payloadOf(error);
  const fallback = new SettingsOperationError({
    code: write ? 'uncertain' : 'failed',
  });
  if (payload === null) return fallback;
  const failed = (
    status: number,
    serverCode?: string,
  ): SettingsOperationError =>
    new SettingsOperationError({
      code: 'failed',
      status,
      ...(serverCode === undefined ? {} : { serverCode }),
    });
  switch (payload.code) {
    case ORG_TRANSCRIPT_ERROR_CODES.tooLarge:
      return failed(422, payload.code);
    case ORG_TRANSCRIPT_ERROR_CODES.activeExportExists:
    case ORG_TRANSCRIPT_ERROR_CODES.notDeletable:
      return failed(409, payload.code);
    case ORG_TRANSCRIPT_ERROR_CODES.rateLimited:
      return failed(429, payload.code);
    case ORG_TRANSCRIPT_ERROR_CODES.storageUnavailable:
      return failed(503, payload.code);
    default:
      break;
  }
  switch (payload.kind) {
    case 'invalid_argument':
      return failed(400);
    case 'resource_exhausted':
      return failed(429);
    case 'permission_denied':
      return new SettingsOperationError({ code: 'forbidden', status: 403 });
    case 'not_found':
      return new SettingsOperationError({ code: 'not_found', status: 404 });
    case 'unauthenticated':
      return new SettingsOperationError({ code: 'unauthenticated' });
    case 'capability_unavailable':
      return new SettingsOperationError({ code: 'unsupported_server' });
    default:
      return fallback;
  }
}

function run(
  write: boolean,
  call: () => Promise<unknown>,
): SettingsOrchestratedOperation {
  return async (): Promise<unknown> => {
    try {
      return await call();
    } catch (error) {
      throw organizationTranscriptsSettingsError(error, write);
    }
  };
}

/**
 * The web core call that answers an organization transcripts table entry, or
 * null for any other entry. `getCalls` is lazy so the web core client loads
 * only when a Transcripts page is opened.
 */
export function organizationTranscriptsOrchestration(
  name: SettingsOperationName,
  validatedInput: unknown,
  getCalls: () => Promise<OrganizationTranscriptSettingsCalls>,
): SettingsOrchestratedOperation | null {
  switch (name) {
    case 'organization.transcripts.sessions': {
      const input = OPS[name].input.safeParse(validatedInput);
      if (!input.success) return null;
      return run(false, async () => (await getCalls()).sessions(input.data));
    }
    case 'organization.transcripts.session': {
      const input = OPS[name].input.safeParse(validatedInput);
      if (!input.success) return null;
      return run(false, async () => (await getCalls()).session(input.data));
    }
    case 'organization.transcripts.exports': {
      const input = OPS[name].input.safeParse(validatedInput);
      if (!input.success) return null;
      return run(false, async () => (await getCalls()).exports(input.data));
    }
    case 'organization.transcripts.exports.estimate': {
      const input = OPS[name].input.safeParse(validatedInput);
      if (!input.success) return null;
      return run(false, async () => (await getCalls()).estimate(input.data));
    }
    case 'organization.transcripts.accessEvents': {
      const input = OPS[name].input.safeParse(validatedInput);
      if (!input.success) return null;
      return run(false, async () =>
        (await getCalls()).accessEvents(input.data),
      );
    }
    case 'organization.transcripts.exports.create': {
      const input = OPS[name].input.safeParse(validatedInput);
      if (!input.success) return null;
      const { idempotencyKey, ...params } = input.data;
      return run(true, async () =>
        (await getCalls()).createExport(params, idempotencyKey),
      );
    }
    case 'organization.transcripts.exports.delete': {
      const input = OPS[name].input.safeParse(validatedInput);
      if (!input.success) return null;
      const { idempotencyKey, organizationId, exportId } = input.data;
      return run(true, async () =>
        (await getCalls()).deleteExport(
          { organizationId, exportId },
          idempotencyKey,
        ),
      );
    }
    default:
      return null;
  }
}
