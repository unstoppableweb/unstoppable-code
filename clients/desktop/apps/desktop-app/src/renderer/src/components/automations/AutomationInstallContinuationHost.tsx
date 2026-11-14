import { Stack } from '@canopy/ui-shared/components';
import type { JSX } from 'react';
import { Button, Notice } from '@canopy/ui-shared';
import { DialogModal } from '@/components/shared/DialogModal';
import { useAutomationScope } from '@/hooks/useAutomationScope';
import { isWorkspaceInContext } from '@/lib/automationContextScope';
import {
  useLinkedPersonalWorkspacesStore,
  linkedPersonalWorkspaceIdsForContext,
} from '@/stores/linkedPersonalWorkspacesStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { toInstallWorkspaceOptions } from '@/lib/installWorkspaceOptions';
import {
  closeAutomationInstallContinuation,
  requestAutomationProjectCreation,
  resumeAutomationInstall,
  useAutomationInstallContinuationStore,
} from '@/stores/automationInstallContinuationStore';
import { InstallSharedAutomationModal } from './InstallSharedAutomationModal';
import { AutomationsE2eInstallFixtureHost } from './AutomationsE2eInstallFixtureHost';

/**
 * Always-mounted automation install surfaces: the wizard resumed after a
 * project was created for it and, in E2E builds only, the install-fixture
 * seam. `__CANOPY_E2E__` makes the fixture branch dead code that the
 * production bundle eliminates.
 */
export function AutomationInstallContinuationHost(): JSX.Element {
  return (
    <>
      <AutomationInstallContinuationModal />
      {__CANOPY_E2E__ ? <AutomationsE2eInstallFixtureHost /> : null}
    </>
  );
}

function AutomationInstallContinuationModal(): JSX.Element | null {
  const state = useAutomationInstallContinuationStore((store) => store.state);
  const scope = useAutomationScope();
  const projects = useProjectsStore((store) => store.projects);
  const linkedState = useLinkedPersonalWorkspacesStore();
  if (state.status === 'closed' || state.status === 'creating') return null;
  const { request } = state.continuation;
  if (state.status !== 'ready')
    return (
      <DialogModal
        title={request.detail.automation.name}
        titleId="automation-install-resume-title"
        onClose={closeAutomationInstallContinuation}
        dataTestId="install-shared-automation-modal"
      >
        <Stack gap="item">
          {state.status === 'loading' ? (
            <p>Refreshing the share and your projects…</p>
          ) : (
            <>
              <Notice
                errorSource="automation-install-continuation-modal"
                intent="destructive"
              >
                {state.error}
              </Notice>
              <Button
                className="self-start"
                variant="secondary"
                onClick={(): void => {
                  void resumeAutomationInstall(state.continuation);
                }}
              >
                Try again
              </Button>
            </>
          )}
        </Stack>
      </DialogModal>
    );
  const context = state.continuation.workspaceContext ?? scope.context;
  const linked = new Set(
    linkedPersonalWorkspaceIdsForContext(linkedState, context),
  );
  const workspaces = projects.filter((project) =>
    isWorkspaceInContext(project, context, linked),
  );
  return (
    <InstallSharedAutomationModal
      detail={state.detail}
      source={request.source}
      staleActivities={request.staleActivities}
      subtitle={request.subtitle}
      initialDraft={request.draft}
      createdProjectId={state.createdProjectId}
      revisionChanged={state.detail.contentHash !== request.detail.contentHash}
      workspaces={toInstallWorkspaceOptions(workspaces)}
      onClose={closeAutomationInstallContinuation}
      onCreateProject={requestAutomationProjectCreation}
      onDone={(id, outcome): void => {
        closeAutomationInstallContinuation();
        request.onDone(id, outcome);
      }}
    />
  );
}
