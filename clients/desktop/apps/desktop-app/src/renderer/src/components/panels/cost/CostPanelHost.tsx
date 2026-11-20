import { useMemo, type JSX } from 'react';
import { useStore } from 'zustand';
import type { CostScopeStore } from '@canopy/app-state/cost';
import type { CostScopeRef } from '@canopy/protocol/cost-view';
import { CostScopeView, useCostScopeStore } from '@canopy/ui-app/cost';
import { ErrorState, LoadingRegion } from '@canopy/ui-shared/components';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { useDesktopCostNavigator } from '@/hooks/useDesktopCostNavigator';
import {
  costPanelUiState,
  costPanelUiStateKey,
} from '@/lib/cost/cost-panel-ui-state';
import { desktopCostClient } from '@/lib/cost/ipc-cost-client';
import { useScopeCapabilities } from '@/hooks/useScopeCapabilities';
import { isWebCoreScope } from '@/lib/chat-authority';
import {
  retryWebCoreServedOperations,
  useWebCoreServedOperationsFailed,
  useWebCoreServedOperationsKnown,
} from '@/lib/web-core-served-operations';

export interface CostPanelHostProps {
  readonly projectId: string;
  readonly worktreeId: string;
}

/** Reports the open Cost panel to App Advisor (see `costPanelUiState`). */
function CostPanelUiStateReporter({
  store,
  projectId,
  worktreeId,
}: {
  readonly store: CostScopeStore;
  readonly projectId: string;
  readonly worktreeId: string;
}): null {
  const status = useStore(store, (state) => state.status);
  const value = useStore(store, (state) => state.value);
  useCurrentUiStateReporter(
    costPanelUiStateKey(projectId, worktreeId),
    costPanelUiState(projectId, worktreeId, status, value),
  );
  return null;
}

function CostPanelBody({
  projectId,
  worktreeId,
}: CostPanelHostProps): JSX.Element {
  const scope = useMemo(
    (): CostScopeRef => ({ kind: 'entry', projectId, worktreeId }),
    [projectId, worktreeId],
  );
  const store = useCostScopeStore(desktopCostClient, scope);
  const navigator = useDesktopCostNavigator(scope);
  return (
    <>
      <CostPanelUiStateReporter
        store={store}
        projectId={projectId}
        worktreeId={worktreeId}
      />
      <CostScopeView
        client={desktopCostClient}
        navigator={navigator}
        scope={scope}
        store={store}
      />
    </>
  );
}

/**
 * Whether a cloud scope's Cost reads wait on the web core's manifest
 * (CAN-7464): a kept tab reads nothing while the manifest read is in flight
 * or failed. A local scope, or a cloud one once the read lands, reads as
 * before.
 */
function useCloudCostManifest(
  projectId: string,
): 'read' | 'pending' | 'failed' {
  const capabilities = useScopeCapabilities({ projectId });
  const known = useWebCoreServedOperationsKnown();
  const failed = useWebCoreServedOperationsFailed();
  if (!isWebCoreScope(projectId) || capabilities.costInsights === true || known)
    return 'read';
  return failed ? 'failed' : 'pending';
}

/** Try again on a failed manifest read; the read stays one at a time. */
function retryManifest(): void {
  retryWebCoreServedOperations();
}

/** The desktop Cost panel (panel kind `cost`) for the panel's own work scope. */
export function CostPanelHost({
  projectId,
  worktreeId,
}: CostPanelHostProps): JSX.Element {
  const manifest = useCloudCostManifest(projectId);
  return (
    <div
      data-testid="cost-panel-host"
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      {manifest === 'read' ? (
        <CostPanelBody projectId={projectId} worktreeId={worktreeId} />
      ) : manifest === 'failed' ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center">
          <ErrorState
            space="panel"
            testId="cost-manifest-failed"
            retryTestId="cost-manifest-retry"
            message="Couldn't load cost."
            onRetry={retryManifest}
          />
        </div>
      ) : (
        <LoadingRegion layout="fill" slowNote="Still loading cost…" />
      )}
    </div>
  );
}
