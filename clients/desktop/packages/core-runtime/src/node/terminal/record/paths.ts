import { join } from 'node:path';
import type { WorkerTerminalRecordLegacyLayout } from '@canopy/protocol/canopy-core';

/** A path segment from a client id: never empty, a dot name or a separator. */
// ASCII only: 255 characters is NAME_MAX bytes; 256 never worked on disk.
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;

export class TerminalRecordPathError extends Error {
  public constructor(label: string) {
    super(`Invalid terminal record ${label}`);
    this.name = 'TerminalRecordPathError';
  }
}

function segment(value: string, label: string): string {
  if (!SAFE_SEGMENT.test(value) || value === '.' || value === '..')
    throw new TerminalRecordPathError(label);
  return value;
}

// Production scope issuers use lowercase IDs: allocateSafeWorkspaceId folds
// taken project IDs; worktree claims/generation use lowercase animal names and
// validateId rejects uppercase identities. Keep the wider historical projection
// unchanged. Supporting independently issued case-variant scopes would require
// a collision-free storage migration, not lowercasing the authority's keys.

/** Every worktree record of the daemon's data root (CAN-7051). */
export function terminalRecordsRoot(dataRoot: string): string {
  return join(dataRoot, 'terminal-records');
}

export function terminalRecordProjectDir(
  dataRoot: string,
  projectId: string,
): string {
  return join(terminalRecordsRoot(dataRoot), segment(projectId, 'projectId'));
}

/** One worktree's record directory, in the daemon's custody. */
export function terminalRecordDir(
  dataRoot: string,
  projectId: string,
  worktreeId: string,
): string {
  return join(
    terminalRecordProjectDir(dataRoot, projectId),
    segment(worktreeId, 'worktreeId'),
  );
}

/**
 * Main's legacy worker state for a worktree, read once at import and never
 * written by the daemon. The layout is main's to decide (its workspace
 * registry), so the client supplies it.
 */
export function legacyTerminalStatePath(
  dataRoot: string,
  layout: WorkerTerminalRecordLegacyLayout,
  projectId: string,
  worktreeId: string,
): string {
  return join(
    dataRoot,
    layout,
    segment(projectId, 'projectId'),
    'worktree-data',
    segment(worktreeId, 'worktreeId'),
    'terminal-state.json',
  );
}
