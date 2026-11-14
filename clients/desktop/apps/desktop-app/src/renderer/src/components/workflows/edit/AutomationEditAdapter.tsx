import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';
import { useCapabilities } from '@canopy/app-state';
import type {
  ScheduledActivity,
  WorkflowEditSection,
} from '@canopy/desktop-shared/types';
import {
  WorkflowEditShell,
  resolveWorkflowEditPlan,
  type UnsavedChangesSaveResult,
} from '@canopy/ui-app/workflows';
import { Notice, NoticeButton } from '@canopy/ui-shared/components';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import type { AutomationDraftSeed } from '@/lib/workflows/edit-target';
import { useAutomationsStore } from '@/stores/automationsStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useAutomationChatTargetAvailability } from '../../automations/useAutomationChatTargetAvailability';
import {
  ActivityFormBody,
  type ActivityFormBodyHandle,
  type ActivityFormChangeMeta,
} from '../../automations/form/ActivityFormBody';
import {
  automationDraftFromSeed,
  type FormState,
} from '../../automations/form/automationFormState';
import { SHARED_PIPELINE_REVIEW_NEEDED_MESSAGE } from '../../automations/ReviewSharedPipelineChangeModal';
import type { AutomationsPageBodyApi } from '../../pages/AutomationsPage';
import { AutomationRunsSection } from './AutomationRunsSection';
import { replaceSavedDraft } from './replaceSavedDraft';
import {
  useScheduleDrafts,
  type ScheduleDraftError,
} from './useScheduleDrafts';
import { useWorkflowEditGuard } from './useWorkflowEditGuard';
import { WorkflowEditNotFound } from './WorkflowEditNotFound';

const NO_RUNS_YET = 'No runs yet';
const DEFINITION_BLOCKS_SAVE = 'Fix the issues in Definition, then save.';

export type AutomationEditAdapterProps = {
  readonly targetKey: string;
  readonly section: WorkflowEditSection;
  readonly backLabel: string;
  readonly automations: AutomationsPageBodyApi;
} & (
  | { readonly kind: 'automation'; readonly activityId: string }
  | { readonly kind: 'automation-draft'; readonly seed?: AutomationDraftSeed }
);

function setSection(section: WorkflowEditSection): void {
  useNavigationStore.getState().setWorkflowEditSection(section);
}

function goBack(): void {
  useNavigationStore.getState().closeWorkflowEdit();
}

/**
 * One automation in the Workflows edit shell (CAN-4072): the form split into
 * Definition and Trigger over one draft, and the run history in Runs. A new
 * draft and a saved automation share this adapter; a draft that saves swaps
 * to its saved id without asking.
 */
export function AutomationEditAdapter(
  props: AutomationEditAdapterProps,
): JSX.Element {
  const { automations } = props;
  const activityId = props.kind === 'automation' ? props.activityId : null;
  const activity = useMemo(
    () =>
      activityId === null
        ? null
        : (automations.activities.find((entry) => entry.id === activityId) ??
          null),
    [activityId, automations.activities],
  );

  // The automation last shown. A workspace-context change empties the list
  // and loads it again; the open editor and its unsaved edits stay meanwhile.
  const [lastShown, setLastShown] = useState(activity);
  if (activity !== null && activity !== lastShown) setLastShown(activity);
  const shown =
    activity ??
    (automations.loading && lastShown?.id === activityId ? lastShown : null);

  if (activityId !== null && shown === null) {
    if (automations.loading) {
      return (
        <WorkflowEditNotFound
          kind="automation"
          loading
          backLabel={props.backLabel}
        />
      );
    }
    return (
      <WorkflowEditNotFound kind="automation" backLabel={props.backLabel} />
    );
  }
  return (
    <AutomationEditor
      key={props.targetKey}
      {...props}
      activity={shown}
      seed={props.kind === 'automation-draft' ? props.seed : undefined}
    />
  );
}

interface AutomationEditorProps {
  readonly targetKey: string;
  readonly section: WorkflowEditSection;
  readonly backLabel: string;
  readonly automations: AutomationsPageBodyApi;
  /** Null for a new draft. */
  readonly activity: ScheduledActivity | null;
  readonly seed?: AutomationDraftSeed;
}

/** The single draft this editor holds. */
const DRAFT_KEY = 'automation';

function AutomationEditor({
  targetKey,
  section,
  backLabel,
  automations,
  activity,
  seed,
}: AutomationEditorProps): JSX.Element {
  const capabilities = useCapabilities();
  const projects = useProjectsStore((s) => s.projects);
  const recentRuns = useAutomationsStore((s) => s.recentRuns);

  const [canSubmit, setCanSubmit] = useState(true);
  const canSubmitRef = useRef(canSubmit);
  canSubmitRef.current = canSubmit;
  const definitionRef = useRef<ActivityFormBodyHandle>(null);
  const triggerRef = useRef<ActivityFormBodyHandle>(null);
  const sectionRef = useRef(section);
  sectionRef.current = section;

  const sources = useMemo(
    () => [{ key: DRAFT_KEY, activity, ...(seed ? { seed } : {}) }],
    [activity, seed],
  );
  const schedules = useScheduleDrafts({
    sources,
    beforeSave: (key) => {
      // A late If Command answer would make the saved form dirty again.
      triggerRef.current?.cancelPendingGenerations();
      // The Definition body blocks Save on checks only it can make (a
      // pending or invalid prompt, a chat that is gone). The unsaved-changes
      // prompt saves through here, so it honors them too.
      if (canSubmitRef.current) return null;
      schedules.setError(key, {
        message: DEFINITION_BLOCKS_SAVE,
        section: 'definition',
      });
      if (sectionRef.current !== 'definition') setSection('definition');
      // Shown in Definition (above), not as the prompt's request error, so
      // it clears once Definition stops blocking.
      return { ok: false };
    },
    // The blocking field is in the other section: show it.
    onBlockedSection: (blocked) => {
      if (blocked !== sectionRef.current) setSection(blocked);
    },
    onCreated: (_key, saved) => {
      // The draft now has an id: same shell, no prompt, and the history
      // entry is replaced rather than pushed.
      replaceSavedDraft(targetKey, {
        kind: 'automation',
        activityId: saved.id,
      });
    },
  });
  const [schedule] = schedules.drafts;
  const state = schedule?.state ?? automationDraftFromSeed(seed);
  const error = schedule?.error ?? null;
  const { saving, deleting, dirty } = schedules;
  const { change, discard, remove, setError, toggle } = schedules;
  const saveDraft = schedules.save;

  // Once Definition stops blocking, its "fix the issues" message is stale.
  useEffect(() => {
    if (!canSubmit) return;
    setError(DRAFT_KEY, (current) =>
      current?.message === DEFINITION_BLOCKS_SAVE ? null : current,
    );
  }, [canSubmit, setError]);

  const draft = activity === null;

  const handleChange = useCallback(
    (next: FormState, meta: ActivityFormChangeMeta): void => {
      change(DRAFT_KEY, next, meta);
    },
    [change],
  );

  const save = useCallback(
    (): Promise<UnsavedChangesSaveResult> => saveDraft(DRAFT_KEY),
    [saveDraft],
  );

  const guard = useWorkflowEditGuard({
    isDirty: dirty,
    save,
    discard,
    targetKey,
  });

  const handleSave = useCallback((): void => {
    // The Definition body runs its own checks first (a pending prompt
    // editor, an unresolved chat). Without it nothing in it can block.
    if (definitionRef.current) {
      void definitionRef.current.submit();
      return;
    }
    void save();
  }, [save]);

  const handleToggle = useCallback(
    (next: boolean): void => {
      toggle(DRAFT_KEY, next);
    },
    [toggle],
  );

  // The shell confirms first, and shows a refusal in its confirmation.
  const handleDelete = useCallback(async (): Promise<void> => {
    await remove(DRAFT_KEY);
    guard.runWithoutNavigationGuard(goBack);
  }, [guard, remove]);

  const chatTarget = useAutomationChatTargetAvailability(activity);
  const runActive =
    activity !== null &&
    recentRuns.some(
      (run) => run.activityId === activity.id && run.status === 'running',
    );
  const running =
    activity !== null && automations.runningActivityId === activity.id;

  const plan = resolveWorkflowEditPlan({
    kind: 'automation',
    readOnly: false,
    dirty,
    saving: saving || deleting,
    draft,
    canSubmit,
    userOwned: true,
    shareable: activity?.action.type !== 'pipeline_execution_resume',
    capabilities,
  });
  const runAction = plan.actions.run;
  const planWithRun =
    runAction.visible &&
    !runAction.disabled &&
    (runActive || chatTarget.blocked)
      ? {
          ...plan,
          actions: {
            ...plan.actions,
            run: { ...runAction, disabled: true },
          },
        }
      : plan;

  useCurrentUiStateReporter('workflows.editShell', {
    kind: 'automation',
    ...(activity ? { id: activity.id } : {}),
    section,
    dirty,
    readonly: false,
    draft,
  });

  const name = state.name.trim() || (draft ? 'New automation' : 'Automation');
  // A save from the unsaved-changes prompt that failed shows here too.
  const shownError: ScheduleDraftError | null =
    error ?? (guard.error ? { message: guard.error, section: null } : null);

  const renderSection = (id: WorkflowEditSection): JSX.Element => {
    if (id === 'runs') {
      if (activity === null) {
        return (
          <p className="text-s fg-tertiary" data-testid="workflow-edit-no-runs">
            {NO_RUNS_YET}
          </p>
        );
      }
      return (
        <AutomationRunsSection activity={activity} automations={automations} />
      );
    }
    const fieldGroup = id === 'definition' ? 'definition' : 'trigger';
    const body = (
      <ActivityFormBody
        state={state}
        saving={saving}
        projects={projects}
        scope={automations.scope}
        error={shownError?.section === fieldGroup ? shownError.message : null}
        onChange={handleChange}
        onSubmit={async (): Promise<void> => {
          await save();
        }}
        fieldGroup={fieldGroup}
        // A saved automation turns on and off from the shell's menu; a draft
        // sets it here, saved with the rest.
        showEnabledField={draft}
        {...(id === 'definition'
          ? {
              handleRef: definitionRef,
              onSubmitAvailabilityChange: setCanSubmit,
            }
          : { handleRef: triggerRef })}
      />
    );
    return body;
  };

  // A refused request is not about one field, so it shows above the
  // sections, whichever one is open.
  const requestError =
    shownError !== null && shownError.section === null ? (
      <Notice
        errorSource="automations-form-error-shown"
        intent="destructive"
        data-testid="automations-form-error"
      >
        {shownError.message}
      </Notice>
    ) : null;
  const reviewNotice = activity?.sharedPipelineReview ? (
    <Notice
      intent="attention"
      data-testid="automation-details-review-notice"
      actions={
        <NoticeButton
          variant="primary"
          onClick={(): void => void automations.runNow(activity)}
          data-testid="automation-details-review-pipeline"
        >
          Review
        </NoticeButton>
      }
    >
      {SHARED_PIPELINE_REVIEW_NEEDED_MESSAGE}
    </Notice>
  ) : null;
  const notices =
    requestError !== null || reviewNotice !== null ? (
      <>
        {requestError}
        {reviewNotice}
      </>
    ) : undefined;

  return (
    <WorkflowEditShell
      kind="automation"
      name={name}
      backLabel={backLabel}
      onBack={goBack}
      plan={planWithRun}
      section={section}
      onSectionChange={setSection}
      renderSection={renderSection}
      targetKey={targetKey}
      notices={notices}
      onSave={handleSave}
      // Run and Share stay in place on a draft, disabled until it is saved.
      onRun={(): void => {
        if (activity !== null) void automations.runNow(activity);
      }}
      onShare={(): void => {
        if (activity !== null) automations.share(activity);
      }}
      {...(activity !== null ? { onDelete: handleDelete } : {})}
      enabled={state.enabled}
      onToggleEnabled={handleToggle}
      actionLabels={{
        run: 'Run now',
        save: draft ? 'Create automation' : 'Save',
      }}
      actionTestIds={{
        save: 'automations-form-submit',
        run: 'automation-details-run-now',
        share: 'automation-details-share',
        toggle: 'automations-form-enabled',
        delete: 'automation-details-delete',
      }}
      busyActions={{ save: saving, run: running }}
      unsavedPrompt={guard.prompt}
    />
  );
}
