import type { WorkspaceType } from '../types';

import {
  DEFAULT_ARCHIVE_RETENTION_DAYS,
  MAX_ARCHIVE_RETENTION_DAYS,
  normalizeArchiveRetentionDays,
} from '@canopy/protocol/archive-retention';
export { DEFAULT_ARCHIVE_RETENTION_DAYS, MAX_ARCHIVE_RETENTION_DAYS };
export const DEFAULT_AUTO_ARCHIVE_DAYS = 7;

export type ArchiveRetentionSurface = WorkspaceType | 'app-advisor';

/**
 * How many days App Advisor's archived chats are kept before its purge
 * deletes them, or null when it keeps them forever: a missing, zero or
 * negative setting turns the purge off.
 */
export function appAdvisorPurgeRetentionDays(
  persistedValue: number | null | undefined,
): number | null {
  return typeof persistedValue === 'number' && persistedValue > 0
    ? persistedValue
    : null;
}

/**
 * The manifest fields retention expiry depends on. A locked container is an
 * "Archived" item and never expires; an unlocked container is a "Deleted"
 * item whose `expiresAt` the retention sweep honors. `expiresAt` only becomes
 * meaningful again after an unlock recomputes it from the unlock time.
 */
export interface ArchiveRetentionExpiryInput {
  expiresAt: string;
  lockedAt?: string;
}

export function isArchivedContainerExpired(
  manifest: ArchiveRetentionExpiryInput,
  now: number,
): boolean {
  if (manifest.lockedAt !== undefined) return false;
  const expiry = Date.parse(manifest.expiresAt);
  return Number.isFinite(expiry) && expiry <= now;
}

/**
 * Resolve the persisted deletion-retention window shared by renderer labels
 * and main-process archive decisions.
 *
 * Deletion retention is always on: every surface keeps deleted worktrees and
 * work entries for a positive number of days before the sweep removes them.
 * A positive in-range integer is honored as-is; `undefined`, legacy `null`,
 * legacy `0` ("retention off" before the always-on rework), and out-of-range
 * values all resolve to the default window. The `surface` argument is kept so
 * call sites stay self-describing.
 */
export function resolveArchiveRetentionDays(
  _surface: ArchiveRetentionSurface,
  persistedValue: number | null | undefined,
): number {
  return normalizeArchiveRetentionDays(persistedValue);
}

/** Resolve the opt-in Auto Delete window. */
export function resolveAutoArchiveDays(
  _surface: ArchiveRetentionSurface,
  _archiveRetentionDays: number | null | undefined,
  autoArchiveDays: number | null | undefined,
): number | null {
  return Number.isInteger(autoArchiveDays) &&
    Number(autoArchiveDays) >= 1 &&
    Number(autoArchiveDays) <= MAX_ARCHIVE_RETENTION_DAYS
    ? Number(autoArchiveDays)
    : null;
}
