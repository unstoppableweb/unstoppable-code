import type { JSX, ReactNode } from 'react';
import {
  cloudSandboxNotAwakeFromDetails,
  sandboxStatusOf,
} from '@canopy/protocol/cloud-session';
import { cloudSandboxStatusCopy } from '../cloud-sandbox-status/cloud-sandbox-status-copy';

/**
 * Why a cloud chat's file link didn't open, as desktop and web both say it
 * (CAN-6658, CAN-6648, CAN-6665).
 *
 * - `refused`: the link names nothing inside the task's folder. This is a
 *   security boundary: the set of answers that refuse is pinned in the golden
 *   and must not widen.
 * - `missing`: inside the folder, but no such file.
 * - `not-awake`: the task's sandbox is asleep (or expired, or failed to
 *   start), with the project state Files shows.
 * - `failed`: anything else; the link stays retryable.
 */
export type FileLinkFailure =
  | { readonly kind: 'refused' }
  | { readonly kind: 'missing' }
  | { readonly kind: 'not-awake'; readonly message: string }
  | { readonly kind: 'failed' };

/** The web core's link refusals that name nothing inside the task's folder. */
export const REFUSED_FILE_LINK_CODES: readonly string[] = [
  'worker.filesystem.link.outsideRoots',
  'worker.filesystem.link.symlinkEscape',
  'worker.filesystem.link.unsupported',
];

/** The web core's answer for a link inside the task's folder to no file. */
export const MISSING_FILE_LINK_CODE = 'worker.filesystem.link.notFound';

/** A `worker.filesystem.link.resolve` failure, as the web core sends it. */
export interface FileLinkRefusal {
  readonly kind: string;
  readonly code?: string;
  readonly details?: unknown;
}

/**
 * What a `worker.filesystem.link.resolve` failure means for the link. A
 * resolve that names no file is `refused` too; its host decides that, since
 * it holds the answer.
 */
export function classifyFileLinkRefusal(
  refusal: FileLinkRefusal,
): FileLinkFailure {
  const notAwake = cloudSandboxNotAwakeFromDetails(refusal.details);
  if (notAwake !== null)
    return {
      kind: 'not-awake',
      message: cloudSandboxStatusCopy(
        sandboxStatusOf(notAwake, false).kind,
        null,
        { wake: false, tryAgain: false },
      ).copy,
    };
  if (refusal.code === MISSING_FILE_LINK_CODE) return { kind: 'missing' };
  if (
    refusal.kind === 'not_found' ||
    (refusal.code !== undefined &&
      REFUSED_FILE_LINK_CODES.includes(refusal.code))
  )
    return { kind: 'refused' };
  return { kind: 'failed' };
}

/** What a link that didn't open says beside it. */
export function fileLinkFailureText(failure: FileLinkFailure): string {
  switch (failure.kind) {
    case 'not-awake':
      return failure.message;
    case 'missing':
      return 'File not found';
    case 'refused':
      return "This file isn't in the task's folder";
    case 'failed':
      return "Couldn't open file";
  }
}

const FAILURE_KEY = 'fileLinkFailure';

/**
 * Marks `error` with why a link didn't open, so a host's rejection carries
 * it to the shared link. Returns the same error.
 */
export function withFileLinkFailure<E extends object>(
  error: E,
  failure: FileLinkFailure,
): E {
  return Object.assign(error, { [FAILURE_KEY]: failure });
}

/** The reason a rejection carries, or null for an unmarked one. */
export function fileLinkFailureOf(error: unknown): FileLinkFailure | null {
  if (typeof error !== 'object' || error === null || !(FAILURE_KEY in error))
    return null;
  const failure: unknown = Reflect.get(error, FAILURE_KEY);
  if (typeof failure !== 'object' || failure === null || !('kind' in failure))
    return null;
  switch (failure.kind) {
    case 'refused':
    case 'missing':
    case 'failed':
      return { kind: failure.kind };
    case 'not-awake':
      return 'message' in failure && typeof failure.message === 'string'
        ? { kind: 'not-awake', message: failure.message }
        : null;
    default:
      return null;
  }
}

/**
 * A link resolve for something other than opening the link, such as listing
 * a turn's files: a missing file is no target, as before CAN-6665 marked it
 * for the link, never a failure. Any other rejection still rejects.
 */
export async function fileLinkTargetOrNull<T>(
  resolving: Promise<T | null>,
): Promise<T | null> {
  try {
    return await resolving;
  } catch (error) {
    if (fileLinkFailureOf(error)?.kind === 'missing') return null;
    throw error;
  }
}

/**
 * A link, and why it didn't open beside it. The two form one inline group
 * with an 8px gap that may wrap as a unit in its paragraph; a link with no
 * failure renders alone, unchanged.
 */
export function FileLinkStatus({
  failure,
  children,
}: {
  readonly failure: FileLinkFailure | null;
  readonly children: ReactNode;
}): JSX.Element {
  if (failure === null) return <>{children}</>;
  return (
    <span className="inline-flex max-w-full flex-wrap items-baseline gap-2">
      {children}
      <span
        role="status"
        className="text-xs fg-secondary"
        data-testid="file-link-status"
        data-file-link-failure={failure.kind}
      >
        {fileLinkFailureText(failure)}
      </span>
    </span>
  );
}
