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

/** The catalog loads still running for one scope (CAN-7506). */
export interface PluginCatalogScopeLoads<Scope extends PluginCatalogLoadScope> {
  scope: Scope;
  count: number;
}

/** The running loads once a load for `scope` starts. */
export function pluginCatalogLoadsAfterStart<
  Scope extends PluginCatalogLoadScope,
>(
  loads: readonly PluginCatalogScopeLoads<Scope>[],
  scope: Scope,
): readonly PluginCatalogScopeLoads<Scope>[] {
  const found = loads.some((entry) =>
    isSamePluginCatalogLoadScope(entry.scope, scope),
  );
  return found
    ? loads.map((entry) =>
        isSamePluginCatalogLoadScope(entry.scope, scope)
          ? { scope: entry.scope, count: entry.count + 1 }
          : entry,
      )
    : [...loads, { scope, count: 1 }];
}

/** The running loads once a load for `scope` settles, however it ended. */
export function pluginCatalogLoadsAfterSettle<
  Scope extends PluginCatalogLoadScope,
>(
  loads: readonly PluginCatalogScopeLoads<Scope>[],
  scope: Scope,
): readonly PluginCatalogScopeLoads<Scope>[] {
  const entry = loads.find((candidate) =>
    isSamePluginCatalogLoadScope(candidate.scope, scope),
  );
  if (entry !== undefined && entry.count > 1) {
    return loads.map((candidate) =>
      candidate === entry
        ? { scope: candidate.scope, count: candidate.count - 1 }
        : candidate,
    );
  }
  return loads.filter((candidate) => candidate !== entry);
}

/**
 * Whether the composer shows the picker's catalog as loading for `current`:
 * only a load for that scope counts, so a scope the composer has left never
 * ends or starts its spinner.
 */
export function isPluginCatalogLoading<Scope extends PluginCatalogLoadScope>(
  loads: readonly PluginCatalogScopeLoads<Scope>[],
  current: Scope,
): boolean {
  return loads.some(
    (entry) =>
      entry.count > 0 && isSamePluginCatalogLoadScope(entry.scope, current),
  );
}
