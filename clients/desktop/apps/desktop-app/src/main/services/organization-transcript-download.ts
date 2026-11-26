import { randomBytes } from 'node:crypto';
import { open, rename, rm, type FileHandle } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import type { SettingsTranscriptDownloadResult } from '@canopy/desktop-shared/types';

// ---------------------------------------------------------------------------
// The organization Transcripts pages' download port on desktop
// (docs/organization-transcripts.md). The renderer names one of the two
// authenticated transcript download routes and a suggested filename; main
// derives the web origin from the signed-in account, asks where to save
// first (a cancelled dialog makes no request, so records no access event),
// then streams the response with the account's desktop key into a temporary
// file beside the target, renaming it on completion. Credentials never cross
// the bridge, and the channel is local only (blocked for Remote Control).
// ---------------------------------------------------------------------------

const UUID =
  '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const SESSION_DOWNLOAD_PATH = new RegExp(
  `^/api/v1/settings/organization/${UUID}/transcripts/sessions/${UUID}/download(?:\\?format=(?:md|jsonl))?$`,
);
const EXPORT_DOWNLOAD_PATH = new RegExp(
  `^/api/v1/settings/organization/${UUID}/transcripts/exports/${UUID}/download$`,
);

/** The whole renderer request. Strict: no URL, header, method or origin. */
export const transcriptDownloadRequestSchema = z.strictObject({
  accountId: z.string().min(1).max(256),
  path: z.string().min(1).max(512),
  suggestedName: z.string().min(1).max(255),
});
export type TranscriptDownloadRequest = z.output<
  typeof transcriptDownloadRequestSchema
>;

/** True only for exactly one of the two transcript download routes. */
export function isTranscriptDownloadPath(path: string): boolean {
  return SESSION_DOWNLOAD_PATH.test(path) || EXPORT_DOWNLOAD_PATH.test(path);
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/** The suggested name, sanitized again in main: one plain filename segment. */
export function sanitizeDownloadName(raw: string): string {
  let name = basename(raw.replace(/\\/g, '/'))
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, '-')
    .trim()
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '');
  if (name.length > 200) name = name.slice(0, 200);
  if (name === '' || name === '..') name = 'transcript';
  if (WINDOWS_RESERVED.test(name)) name = `_${name}`;
  return name;
}

export interface TranscriptDownloadDependencies {
  /** The signed-in account's id, or null. */
  signedInAccountId(): Promise<string | null>;
  /** The signed-in account's own web origin and desktop key. */
  readCredentials(): Promise<{ baseUrl: string; apiKey: string }>;
  /** The save dialog; null when cancelled. */
  choosePath(suggestedName: string): Promise<string | null>;
  fetch: typeof fetch;
}

function statusResult(status: number): SettingsTranscriptDownloadResult {
  switch (status) {
    case 401:
      return { ok: false, reason: 'unauthenticated' };
    case 403:
      return { ok: false, reason: 'forbidden' };
    case 404:
      return { ok: false, reason: 'not_found' };
    case 410:
      return { ok: false, reason: 'gone' };
    case 422:
      return { ok: false, reason: 'too_large' };
    case 429:
      return { ok: false, reason: 'busy' };
    default:
      return { ok: false, reason: 'failed' };
  }
}

/** Runs one validated download. Never throws; every failure is a typed result. */
export async function downloadOrganizationTranscript(
  value: unknown,
  deps: TranscriptDownloadDependencies,
): Promise<SettingsTranscriptDownloadResult> {
  const parsed = transcriptDownloadRequestSchema.safeParse(value);
  if (!parsed.success || !isTranscriptDownloadPath(parsed.data.path)) {
    return { ok: false, reason: 'invalid' };
  }
  const request = parsed.data;
  if ((await deps.signedInAccountId()) !== request.accountId) {
    return { ok: false, reason: 'unauthenticated' };
  }
  const target = await deps.choosePath(
    sanitizeDownloadName(request.suggestedName),
  );
  if (target === null) return { ok: true, saved: false };
  // The dialog can stay open across an account switch; download only as the
  // account that asked, so the access event names it.
  if ((await deps.signedInAccountId()) !== request.accountId) {
    return { ok: false, reason: 'unauthenticated' };
  }

  let credentials: { baseUrl: string; apiKey: string };
  try {
    credentials = await deps.readCredentials();
  } catch {
    return { ok: false, reason: 'unauthenticated' };
  }
  let url: URL;
  try {
    const origin = new URL(credentials.baseUrl).origin;
    url = new URL(request.path, origin);
    if (url.origin !== origin) return { ok: false, reason: 'invalid' };
  } catch {
    return { ok: false, reason: 'failed' };
  }

  const temporary = join(
    dirname(target),
    `.${basename(target)}.${randomBytes(6).toString('hex')}.part`,
  );
  let response: Response;
  try {
    response = await deps.fetch(url, {
      method: 'GET',
      // Uncompressed, so the server's content-length survives to the check
      // below; a compressed response arrives without it.
      headers: {
        authorization: `Bearer ${credentials.apiKey}`,
        'accept-encoding': 'identity',
      },
      redirect: 'error',
    });
  } catch {
    return { ok: false, reason: 'failed' };
  }
  if (!response.ok || response.body === null) {
    await response.body?.cancel().catch(() => undefined);
    return statusResult(response.status);
  }
  let handle: FileHandle;
  try {
    handle = await open(temporary, 'wx');
  } catch {
    await response.body.cancel().catch(() => undefined);
    return { ok: false, reason: 'failed' };
  }
  const reader = response.body.getReader();
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      await handle.write(chunk.value);
    }
    // A chunked body cut short already errors the read above; with a
    // content-length, a short body fails here too.
    const expected = response.headers.get('content-length');
    const { size } = await handle.stat();
    if (
      expected !== null &&
      /^\d+$/.test(expected) &&
      Number(expected) !== size
    ) {
      throw new Error('Short download');
    }
    await handle.close();
    await rename(temporary, target);
    return { ok: true, saved: true };
  } catch {
    // Release the connection, so the server frees its download slot now.
    await reader.cancel().catch(() => undefined);
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    return { ok: false, reason: 'failed' };
  }
}
