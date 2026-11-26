import { createHash } from 'node:crypto';

/** The identity every registry row carries; hosts add display fields. */
export interface WorkEntryRegistryRow {
  id: string;
  createdAt: string;
}

export interface WorkEntryRegistryFile<Row extends WorkEntryRegistryRow> {
  version: 1;
  entries: Row[];
}

/**
 * An opaque value that changes when the registry's membership, row identity
 * or order changes. Display fields (titles, pins, summaries, touches) are
 * excluded so routine writes never conflict. Computed from content and never
 * stored: the codec drops unknown top-level fields.
 */
export function workEntryRegistryRevision(
  rows: readonly WorkEntryRegistryRow[],
): string {
  const identity = JSON.stringify(rows.map((row) => [row.id, row.createdAt]));
  return `wer1-${createHash('sha256').update(identity).digest('hex').slice(0, 32)}`;
}

export class WorkEntryRegistryRevisionConflictError extends Error {
  public readonly expected: string;
  public readonly current: string;

  public constructor(expected: string, current: string) {
    super('Work Entry registry changed since it was read');
    this.name = 'WorkEntryRegistryRevisionConflictError';
    this.expected = expected;
    this.current = current;
  }
}

export class WorkEntryRowIncarnationConflictError extends Error {
  public readonly entryId: string;
  public readonly expectedCreatedAt: string;
  public readonly currentCreatedAt: string;

  public constructor(
    entryId: string,
    expectedCreatedAt: string,
    currentCreatedAt: string,
  ) {
    super(`Work Entry ${entryId} was recreated since it was read`);
    this.name = 'WorkEntryRowIncarnationConflictError';
    this.entryId = entryId;
    this.expectedCreatedAt = expectedCreatedAt;
    this.currentCreatedAt = currentCreatedAt;
  }
}

export function workEntryProjectDeletedError(workspaceId: string): Error {
  return new Error(`Work Entry project has been deleted: ${workspaceId}`);
}
