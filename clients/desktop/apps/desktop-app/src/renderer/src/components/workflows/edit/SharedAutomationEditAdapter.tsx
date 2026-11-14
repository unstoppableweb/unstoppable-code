import { useEffect, useState, type JSX } from 'react';
import { useCapabilities } from '@canopy/app-state';
import { getAutomationTriggerLabel } from '@canopy/desktop-shared/lib/automations';
import type { WorkflowEditSection } from '@canopy/desktop-shared/types';
import type { SharedAutomationDetail } from '@canopy/protocol/automations';
import {
  WorkflowEditShell,
  resolveWorkflowEditPlan,
} from '@canopy/ui-app/workflows';
import {
  CenteredLoadingSpinner,
  DelayedLoadingPlaceholder,
  EmptyState,
  Notice,
  NoticeButton,
} from '@canopy/ui-shared/components';
import { AutomationDefinitionSummary } from '@canopy/ui-shared/components/AutomationDefinitionSummary';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { useInstallWorkspaces } from '@/hooks/useInstallWorkspaces';
import { resolveSharedResourceErrorMessage } from '@/lib/sharedResourceErrors';
import { useNavigationStore } from '@/stores/navigationStore';
import { InstallSharedAutomationModal } from '../../automations/InstallSharedAutomationModal';
import { replaceSavedDraft } from './replaceSavedDraft';

export interface SharedAutomationEditAdapterProps {
  readonly targetKey: string;
  readonly remoteId: string;
  /** The Library row's name, shown until the share loads. */
  readonly fallbackName?: string;
  readonly section: WorkflowEditSection;
  readonly backLabel: string;
}

function setSection(section: WorkflowEditSection): void {
  useNavigationStore.getState().setWorkflowEditSection(section);
}

function goBack(): void {
  useNavigationStore.getState().closeWorkflowEdit();
}

function describeSchedule(detail: SharedAutomationDetail): string {
  const trigger = detail.automation.trigger;
  if (trigger.kind === 'cron') {
    return `${getAutomationTriggerLabel(trigger)} · ${trigger.expression}`;
  }
  return `${getAutomationTriggerLabel(trigger)} · ${new Date(
    trigger.runAt,
  ).toLocaleString()}`;
}

/**
 * A shared automation that is not added yet, read-only in the edit shell
 * (CAN-4072). Duplicate is the one action: it adds a copy that stays off,
 * then opens that copy ready to edit.
 */
export function SharedAutomationEditAdapter({
  targetKey,
  remoteId,
  fallbackName,
  section,
  backLabel,
}: SharedAutomationEditAdapterProps): JSX.Element {
  const capabilities = useCapabilities();
  const workspaces = useInstallWorkspaces();
  const [detail, setDetail] = useState<SharedAutomationDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [duplicating, setDuplicating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setError(null);
    window.api.automations
      .getShared(remoteId)
      .then((next) => {
        if (!cancelled) setDetail(next);
      })
      .catch((failure: unknown) => {
        if (cancelled) return;
        setError(
          resolveSharedResourceErrorMessage(failure, {
            unsupportedResource: 'automations',
          }),
        );
      });
    return (): void => {
      cancelled = true;
    };
  }, [remoteId, reloadKey]);

  useCurrentUiStateReporter('workflows.editShell', {
    kind: 'automation',
    id: remoteId,
    section,
    dirty: false,
    readonly: true,
    draft: false,
  });

  const plan = resolveWorkflowEditPlan({
    kind: 'automation',
    readOnly: true,
    dirty: false,
    saving: duplicating,
    draft: false,
    canSubmit: detail !== null,
    userOwned: false,
    capabilities,
  });

  const renderSection = (id: WorkflowEditSection): JSX.Element => {
    if (error !== null) {
      return (
        <Notice
          errorSource="automation-source-error-shared-edit-adapter"
          intent="destructive"
          title="Couldn't load this automation."
          data-testid="automation-source-error"
          actions={
            <NoticeButton onClick={(): void => setReloadKey((n) => n + 1)}>
              Try again
            </NoticeButton>
          }
        >
          {error}
        </Notice>
      );
    }
    if (id === 'runs') {
      return <EmptyState testId="workflow-edit-no-runs" title="No runs yet" />;
    }
    if (detail === null) {
      return (
        <DelayedLoadingPlaceholder
          className=""
          slowNote="Still loading automation…"
        >
          <div className="box-content flex min-h-full flex-1 py-8">
            <CenteredLoadingSpinner className="" />
          </div>
        </DelayedLoadingPlaceholder>
      );
    }
    if (id === 'trigger') {
      return (
        <div className="flex flex-col gap-1 text-s">
          <span className="text-xs fg-tertiary">Schedule</span>
          <span className="fg-primary" data-testid="shared-automation-schedule">
            {describeSchedule(detail)}
          </span>
        </div>
      );
    }
    return <AutomationDefinitionSummary automation={detail.automation} />;
  };

  return (
    <>
      <WorkflowEditShell
        kind="automation"
        name={detail?.name ?? fallbackName ?? 'Shared automation'}
        backLabel={backLabel}
        onBack={goBack}
        plan={plan}
        section={section}
        onSectionChange={setSection}
        renderSection={renderSection}
        targetKey={targetKey}
        {...(detail !== null
          ? { onDuplicate: (): void => setDuplicating(true) }
          : {})}
        actionTestIds={{ duplicate: 'shared-automation-duplicate' }}
      />
      {duplicating && detail !== null && (
        <InstallSharedAutomationModal
          detail={detail}
          source="shared"
          staleActivities={[]}
          workspaces={workspaces}
          leaveDisabled
          onClose={(): void => setDuplicating(false)}
          onDone={(activityId): void => {
            if (activityId === undefined) return;
            // The copy is the user's own, so it opens editable in place of
            // the share, unless the user has left the share meanwhile.
            replaceSavedDraft(targetKey, { kind: 'automation', activityId });
          }}
        />
      )}
    </>
  );
}
