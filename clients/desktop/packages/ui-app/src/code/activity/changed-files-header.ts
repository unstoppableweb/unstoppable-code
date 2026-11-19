import type { RemoteControlChangedFilesNotice } from '@canopy/protocol/remote-control/shell';

/**
 * The Changed files section header, defined once for every host (REG-3024).
 * Desktop passes its label filter's visible count; the shared descriptor
 * passes the snapshot's rows and notices.
 */
export interface ChangedFilesHeaderInput {
  /** Every changed file the host knows of. */
  readonly totalCount: number;
  /** Rows still shown after a host-side filter; defaults to `totalCount`. */
  readonly visibleCount?: number;
  /** Why the producer's answer is incomplete. */
  readonly notices?: readonly Pick<RemoteControlChangedFilesNotice, 'kind'>[];
}

/**
 * `N files`, `N files (V)` when a filter hides some, `N+ files` when the list
 * was cut. With no rows, an incomplete answer names its state in one word
 * instead of claiming "No local changes".
 */
export function changedFilesHeaderSubtitle(
  input: ChangedFilesHeaderInput,
): string {
  const { totalCount } = input;
  const kinds = new Set((input.notices ?? []).map((notice) => notice.kind));
  if (totalCount > 0) {
    const truncated = kinds.has('truncated');
    const base = `${totalCount}${truncated ? '+' : ''} file${
      totalCount === 1 && !truncated ? '' : 's'
    }`;
    const visible = input.visibleCount ?? totalCount;
    return visible < totalCount ? `${base} (${visible})` : base;
  }
  if (kinds.has('sleeping')) return 'Sleeping';
  if (kinds.has('unavailable') || kinds.has('base_unavailable'))
    return 'Unavailable';
  if (kinds.has('truncated')) return 'Incomplete';
  return 'No local changes';
}

/** Whether the section has rows or explains why it has none. */
export function changedFilesHeaderHasContent(
  input: ChangedFilesHeaderInput,
): boolean {
  return input.totalCount > 0 || (input.notices?.length ?? 0) > 0;
}
