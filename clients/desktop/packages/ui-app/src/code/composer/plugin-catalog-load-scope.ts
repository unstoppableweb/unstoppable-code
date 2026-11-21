/**
 * Where a Remote Control plugin catalog load ran: the computer's client, the
 * chat, the workspace and the worktree (CAN-7473).
 */
export interface PluginCatalogLoadScope {
  client: unknown;
  sessionId: string | undefined;
  workspaceLocalId: string | undefined;
  worktreeLocalId: string | undefined;
}

export function isSamePluginCatalogLoadScope(
  a: PluginCatalogLoadScope,
  b: PluginCatalogLoadScope,
): boolean {
  return (
    a.client === b.client &&
    a.sessionId === b.sessionId &&
    a.workspaceLocalId === b.workspaceLocalId &&
    a.worktreeLocalId === b.worktreeLocalId
  );
}

/**
 * The failure to show once a load for `load.scope` settles while the composer
 * shows `current`. Only the latest load for a scope decides its outcome: a
 * superseded load changes nothing, whether it failed or succeeded. A failure
 * for a scope the composer has left changes nothing either.
 */
export function pluginCatalogFailureAfterLoad<
  Scope extends PluginCatalogLoadScope,
>(
  shown: Scope | null,
  load: { scope: Scope; failed: boolean },
  current: Scope,
  latest: boolean,
): Scope | null {
  if (!latest) return shown;
  if (load.failed) {
    return isSamePluginCatalogLoadScope(load.scope, current)
      ? load.scope
      : shown;
  }
  return shown !== null && isSamePluginCatalogLoadScope(shown, load.scope)
    ? null
    : shown;
}

/**
 * Whether the picker still shows its catalog as loading once a load settles.
 * A superseded load leaves the newer load's spinner on.
 */
export function pluginCatalogLoadingAfterLoad(
  loading: boolean,
  latest: boolean,
): boolean {
  return latest ? false : loading;
}
