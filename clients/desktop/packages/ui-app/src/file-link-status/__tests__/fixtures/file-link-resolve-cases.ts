import type { CanopyErrorPayload } from '@canopy/protocol/canopy-core';
import type { FileLinkFailure } from '../../file-link-status';

/**
 * Every `worker.filesystem.link.resolve` refusal a cloud chat's file link
 * meets, and what the link makes of it (CAN-6665). The shared golden runs
 * the table through the shared classifier, and desktop and web each run it
 * through their own host's resolve, so the two can't drift apart.
 *
 * The `refused` rows are a security boundary: a link that names nothing
 * inside the task's folder opens nothing. They are exactly the set desktop
 * refused before CAN-6665 moved it here (outsideRoots, symlinkEscape,
 * unsupported, and any other `not_found`); `link.notFound` is the only
 * answer that left it. A resolve that names no file is refused too, by each
 * host, which holds that answer. Every code is one the operation declares:
 * the core client turns any other into `internal`.
 */
export interface FileLinkResolveCase {
  readonly name: string;
  readonly refusal: CanopyErrorPayload;
  readonly outcome: FileLinkFailure['kind'];
  /** What the link says beside it. */
  readonly text: string;
}

const NEVER = { kind: 'never' } as const;
const REFUSED = "This file isn't in the task's folder";

export const FILE_LINK_RESOLVE_CASES: readonly FileLinkResolveCase[] = [
  {
    name: 'a link outside the workspace roots',
    refusal: {
      kind: 'not_found',
      code: 'worker.filesystem.link.outsideRoots',
      message: 'The link is outside the workspace.',
      retry: NEVER,
    },
    outcome: 'refused',
    text: REFUSED,
  },
  {
    name: 'a link outside the roots answered under another kind',
    refusal: {
      kind: 'failed_precondition',
      code: 'worker.filesystem.link.outsideRoots',
      message: 'The link is outside the workspace.',
      retry: NEVER,
    },
    outcome: 'refused',
    text: REFUSED,
  },
  {
    name: 'a link that leaves the workspace by a symlink',
    refusal: {
      kind: 'not_found',
      code: 'worker.filesystem.link.symlinkEscape',
      message: 'The link leaves the workspace.',
      retry: NEVER,
    },
    outcome: 'refused',
    text: REFUSED,
  },
  {
    name: 'a link the web core does not support',
    refusal: {
      kind: 'invalid_argument',
      code: 'worker.filesystem.link.unsupported',
      message: 'The link is not supported.',
      retry: NEVER,
    },
    outcome: 'refused',
    text: REFUSED,
  },
  {
    name: 'any other not_found code',
    refusal: {
      kind: 'not_found',
      code: 'worker.filesystem.link.ambiguous',
      message: 'The link names more than one file.',
      retry: NEVER,
    },
    outcome: 'refused',
    text: REFUSED,
  },
  {
    name: 'a not_found with no code',
    refusal: { kind: 'not_found', message: 'Not found.', retry: NEVER },
    outcome: 'refused',
    text: REFUSED,
  },
  {
    name: 'a link inside the folder to a missing file',
    refusal: {
      kind: 'not_found',
      code: 'worker.filesystem.link.notFound',
      message: 'The linked file does not exist.',
      retry: NEVER,
    },
    outcome: 'missing',
    text: 'File not found',
  },
  {
    name: 'any link while the sandbox sleeps',
    refusal: {
      kind: 'failed_precondition',
      code: 'worker.filesystem.link.invalidState',
      message: 'The sandbox is asleep.',
      details: { reason: 'sandbox_sleeping', wakeAllowed: true },
      retry: { kind: 'after_refresh', resource: 'worker.filesystem.link' },
    },
    outcome: 'not-awake',
    text: 'Project is sleeping. Send a message to wake it.',
  },
  {
    name: 'any other failure',
    refusal: {
      kind: 'unavailable',
      message: 'The worker is unavailable.',
      retry: { kind: 'same_request', delayMs: 1_000 },
    },
    outcome: 'failed',
    text: "Couldn't open file",
  },
];
