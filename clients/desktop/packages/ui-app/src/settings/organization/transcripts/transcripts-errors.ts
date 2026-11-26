'use client';

import { useMemo } from 'react';
import { ORG_TRANSCRIPT_ERROR_CODES } from '@canopy/protocol/canopy-core/core';
import type { SettingsFileDownloadResult } from '../../host';
import {
  useSettingsAccessLostRefresh,
  useSettingsErrorCopy,
  type KnownSettingsError,
  type SettingsFailure,
} from '../../errors';

/*
 * Copy for the Transcripts states the approved screens don't show
 * (docs/organization-transcripts.md). Each needs sign-off before the
 * production flag goes on.
 */
export const TRANSCRIPTS_STORAGE_UNAVAILABLE_COPY =
  "Stored transcripts aren't available right now. Try again in a few minutes.";
export const TRANSCRIPTS_ACTIVE_EXPORT_COPY =
  "An export is already preparing. Start another once it's ready.";
export const TRANSCRIPTS_RATE_LIMITED_COPY =
  "You've started 5 exports today. Try again tomorrow.";
export const TRANSCRIPTS_EXPORTS_UNAVAILABLE_COPY =
  "Exports aren't available on this server.";
export const TRANSCRIPTS_NOT_DELETABLE_COPY =
  "This export is still preparing, so it can't be deleted yet.";
export const TRANSCRIPTS_SESSION_TOO_LARGE_COPY =
  'This session is too large to download on its own. Use Export instead.';
export const TRANSCRIPTS_DOWNLOAD_BUSY_COPY =
  'Too many downloads are running. Try again in a moment.';
export const TRANSCRIPTS_EXPORT_GONE_COPY =
  'This export expired or was deleted, so it can no longer be downloaded.';
export const TRANSCRIPTS_EXPORT_TOO_LARGE_COPY =
  'This export is now too large. Narrow the date range and try again.';
export const TRANSCRIPTS_DOWNLOAD_FAILED_COPY =
  "Couldn't download this. Try again.";

const STORAGE_UNAVAILABLE: KnownSettingsError = {
  serverCode: ORG_TRANSCRIPT_ERROR_CODES.storageUnavailable,
  copy: TRANSCRIPTS_STORAGE_UNAVAILABLE_COPY,
};

/** Known failures of the Transcripts reads. */
export const TRANSCRIPTS_LOAD_ERRORS: readonly KnownSettingsError[] = [
  STORAGE_UNAVAILABLE,
];

/** Known refusals of Start export and Delete export. */
export const TRANSCRIPTS_EXPORT_ERRORS: readonly KnownSettingsError[] = [
  STORAGE_UNAVAILABLE,
  {
    serverCode: ORG_TRANSCRIPT_ERROR_CODES.activeExportExists,
    copy: TRANSCRIPTS_ACTIVE_EXPORT_COPY,
  },
  // Matches grew past the cap between the estimate and Start export.
  {
    serverCode: ORG_TRANSCRIPT_ERROR_CODES.tooLarge,
    copy: TRANSCRIPTS_EXPORT_TOO_LARGE_COPY,
  },
  {
    serverCode: ORG_TRANSCRIPT_ERROR_CODES.rateLimited,
    copy: TRANSCRIPTS_RATE_LIMITED_COPY,
  },
  {
    serverCode: ORG_TRANSCRIPT_ERROR_CODES.notDeletable,
    copy: TRANSCRIPTS_NOT_DELETABLE_COPY,
  },
  { code: 'unsupported_server', copy: TRANSCRIPTS_EXPORTS_UNAVAILABLE_COPY },
  {
    serverCode: 'capability_unavailable',
    copy: TRANSCRIPTS_EXPORTS_UNAVAILABLE_COPY,
  },
];

export interface TranscriptsErrorCopy {
  loadFailure(error: unknown): SettingsFailure;
  actionFailure(error: unknown, action: string): SettingsFailure;
}

/**
 * Friendly copy for the Transcripts pages. Server text goes only to the
 * host's log; a lost-access failure goes through the host's refresh.
 */
export function useTranscriptsErrorCopy(): TranscriptsErrorCopy {
  const errorCopy = useSettingsErrorCopy('organization-transcripts');
  const refreshOnAccessLost = useSettingsAccessLostRefresh();
  return useMemo(
    (): TranscriptsErrorCopy => ({
      loadFailure: (error): SettingsFailure => {
        refreshOnAccessLost(error);
        return errorCopy.loadFailure(error, TRANSCRIPTS_LOAD_ERRORS);
      },
      actionFailure: (error, action): SettingsFailure => {
        refreshOnAccessLost(error);
        return errorCopy.actionFailure(error, {
          action,
          known: TRANSCRIPTS_EXPORT_ERRORS,
        });
      },
    }),
    [errorCopy, refreshOnAccessLost],
  );
}

/** Copy for a download the host reported as failed, or null when it saved or was cancelled. */
export function downloadFailureCopy(
  result: SettingsFileDownloadResult,
): string | null {
  if (result.ok) return null;
  switch (result.reason) {
    case 'too_large':
      return TRANSCRIPTS_SESSION_TOO_LARGE_COPY;
    case 'busy':
      return TRANSCRIPTS_DOWNLOAD_BUSY_COPY;
    case 'gone':
      return TRANSCRIPTS_EXPORT_GONE_COPY;
    case 'invalid':
    case 'unauthenticated':
    case 'forbidden':
    case 'not_found':
    case 'failed':
      return TRANSCRIPTS_DOWNLOAD_FAILED_COPY;
  }
}
