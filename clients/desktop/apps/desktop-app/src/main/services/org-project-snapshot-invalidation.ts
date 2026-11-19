import { getFeatureFlagService } from '../feature-flags';
import { getWorkspaceContextService } from '../lib/workspace-context-service';
import { requestDesktopSessionSnapshotInvalidation } from './desktop-session-snapshot-invalidation';
import { getOrgProjectCatalogService } from './org-project-catalog-service';

export interface OrgProjectSnapshotInvalidationDeps {
  subscribeCatalog: (listener: () => void) => () => void;
  subscribeWorkspaceContext: (listener: () => void) => () => void;
  subscribeFeatureFlags: (listener: () => void) => () => void;
  schedule: () => void;
}

/**
 * The shared session snapshot projects catalog placeholder rows (CAN-2955),
 * so it goes stale whenever the catalog, the selected workspace context, or
 * the org-projects flag changes. Each change schedules the same debounced
 * invalidation the local workspace mutations use.
 */
export function installOrgProjectSnapshotInvalidation(
  deps: OrgProjectSnapshotInvalidationDeps = defaultDeps(),
): () => void {
  const unsubscribers = [
    deps.subscribeCatalog(deps.schedule),
    deps.subscribeWorkspaceContext(deps.schedule),
    deps.subscribeFeatureFlags(deps.schedule),
  ];
  return (): void => {
    for (const unsubscribe of unsubscribers) unsubscribe();
  };
}

function defaultDeps(): OrgProjectSnapshotInvalidationDeps {
  return {
    subscribeCatalog: (listener) =>
      getOrgProjectCatalogService().subscribe(() => listener()),
    subscribeWorkspaceContext: (listener) =>
      getWorkspaceContextService().subscribe(() => listener()),
    subscribeFeatureFlags: (listener) =>
      getFeatureFlagService().onSnapshotChanged(() => listener()),
    schedule: (): void =>
      requestDesktopSessionSnapshotInvalidation('org-project'),
  };
}
