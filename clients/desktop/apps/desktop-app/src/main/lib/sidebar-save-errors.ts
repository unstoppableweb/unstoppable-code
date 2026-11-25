// No imports: `ipc/app-error-rejection.ts` and the IPC failure record match
// these classes by `instanceof` without pulling in the sidebar writers.

/**
 * `projects:save` from a window whose last `projects:load` was a stale
 * projection: a daemon-backed store could not be reached at load time, so the
 * window has no edit baseline (CAN-7357).
 */
export class ProjectsReloadRequiredError extends Error {
  constructor() {
    super('Reload your projects before saving changes.');
    this.name = 'ProjectsReloadRequiredError';
  }
}

/** Why a sidebar save's items were refused, for the local failure record. */
export type SidebarItemsInvalidReason =
  | 'duplicate-id'
  | 'external-path'
  | 'repo-path'
  | 'source-repo-path'
  | 'temporary'
  | 'compatibility-symlink';

/** A sidebar save's items failed validation other than an id's format. */
export class SidebarItemsInvalidError extends Error {
  constructor(
    readonly reason: SidebarItemsInvalidReason,
    message: string,
  ) {
    super(message);
    this.name = 'SidebarItemsInvalidError';
  }
}
