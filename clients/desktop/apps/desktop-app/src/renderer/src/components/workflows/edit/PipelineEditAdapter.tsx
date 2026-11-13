import { hasOnlyLocalPipelineTriggers } from '@canopy/protocol/pipelines';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import { useCapabilities } from '@canopy/app-state';
import { pipelineAssistantSelection } from '@/components/pipeline/pipelineAssistantSuggestions';
import type { WorkflowEditSection } from '@canopy/desktop-shared/types';
import {
  getTriggerTypes,
  type PipelineInfo,
} from '@canopy/execution-engine/types/pipeline';
import {
  PipelineTriggers,
  WorkflowEditShell,
  resolveWorkflowEditPlan,
  type UnsavedChangesSaveResult,
} from '@canopy/ui-app/workflows';
import {
  ConfirmDialog,
  EmptyState,
  InlineTextInput,
  Notice,
} from '@canopy/ui-shared/components';
import { REPLAY_MASK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import {
  hooksRunningPipeline,
  pipelineStartKinds,
  pipelineUserCount,
} from '@/lib/workflows/pipeline-automations';
import { useProjectsStore } from '@/stores/projectsStore';
import { pipelineInfoToDocumentLocator } from '@/lib/pipelineDocument';
import {
  pipelineEditLinkFromLocator,
  workflowEditKey,
  type WorkflowEditTarget,
} from '@/lib/workflows/edit-target';
import { useChatStore } from '@/stores/chatStore';
import {
  runWithoutNavigationGuard,
  useNavigationStore,
} from '@/stores/navigationStore';
import { useDispatchPipelineModal } from '../../activity/useDispatchPipelineModal';
import type { AutomationsPageBodyApi } from '../../pages/AutomationsPage';
import type { PipelinesPageListApi } from '../../pages/PipelinesPage';
import {
  PipelineEditorBody,
  PipelineEditorNotices,
} from '../../pipeline/PipelineEditorBody';
import {
  PipelineAddJobButton,
  PipelineHistoryControls,
  PipelineSettingsToggle,
  PipelineViewModeControls,
} from '../../pipeline/PipelineToolbar';
import { usePipelineEditorSession } from '../../pipeline/usePipelineEditorSession';
import {
  PipelineRunsSection,
  PipelineTriggerSection,
} from './PipelineEditSections';
import { replaceSavedDraft } from './replaceSavedDraft';
import { useWorkflowEditGuard } from './useWorkflowEditGuard';
import { useWorkflowSchedules } from './useWorkflowSchedules';
import { usePipelineAssistantDraft } from '@/components/pipeline/pipelineAssistantDraft';
import { WorkflowEditNotFound } from './WorkflowEditNotFound';

type PipelineTarget = Extract<WorkflowEditTarget, { kind: 'pipeline' }>;

/** How the agent-grant confirmation was answered. */
type GrantChoice = 'save' | 'duplicate' | 'cancel';

const GRANT_SAVE_TITLE = 'Save changes to this workflow?';
const GRANT_SAVE_MESSAGE =
  'Its schedule will stop using the plugins and approval mode the agent was granted, so runs that need them will fail. Duplicate the workflow to run it as yours.';

export interface PipelineEditAdapterProps {
  readonly target: PipelineTarget;
  readonly targetKey: string;
  readonly section: WorkflowEditSection;
  readonly backLabel: string;
  readonly pipelines: PipelinesPageListApi;
  readonly automations: AutomationsPageBodyApi;
}

function setSection(section: WorkflowEditSection): void {
  useNavigationStore.getState().setWorkflowEditSection(section);
}

function goBack(): void {
  useNavigationStore.getState().closeWorkflowEdit();
}

/** The pipeline's name in the heading, renamed in place when editable. */
function PipelineNameEditor({
  name,
  onRename,
}: {
  readonly name: string;
  readonly onRename: (name: string) => void;
}): JSX.Element {
  const [editing, setEditing] = useState(false);
  // The name when editing began, which Escape puts back, and the last name
  // typed since.
  const nameBeforeEdit = useRef(name);
  const typedName = useRef(name);
  const label = name || 'Untitled workflow';
  if (editing) {
    return (
      // The replay mask sits on a wrapper: the field's own class is
      // placement only.
      <span className={`flex min-w-0 max-w-full ${REPLAY_MASK_CLASS}`}>
        {/* Each keystroke renames, so the shell's ⌘S, which saves without
            leaving the field, saves the typed name. Escape keeps the old
            name. */}
        <InlineTextInput
          autoFocus
          // Keeps the heading's font; the margin cancels the field's 8px
          // inset so the name does not shift when editing starts.
          size="inherit"
          grow
          className="-ml-2"
          value={name}
          placeholder="Untitled workflow"
          aria-label="Workflow name"
          data-testid="pipeline-editor-name-input"
          onDraftChange={(next): void => {
            typedName.current = next;
            onRename(next);
          }}
          onCommit={onRename}
          onCancel={(): void => {
            if (typedName.current !== nameBeforeEdit.current) {
              onRename(nameBeforeEdit.current);
            }
          }}
          onBlur={(): void => setEditing(false)}
        />
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={(): void => {
        nameBeforeEdit.current = name;
        typedName.current = name;
        setEditing(true);
      }}
      aria-label={`Rename ${label}`}
      // Capped at the heading's width, so a long name ends in an ellipsis
      // instead of running under the save state and the actions.
      className={`focus-ring min-w-0 max-w-full truncate rounded-sm align-top text-left transition-colors hover:fg-accent ${REPLAY_MASK_CLASS}`}
    >
      {label}
    </button>
  );
}

/**
 * One pipeline in the Workflows edit shell (CAN-4072). Definition is the
 * pipeline editor under its own toolbar; Trigger lists the automations that
 * run it; Runs is the Runs feed narrowed to it. The shell owns ⌘S, Back and
 * the unsaved-changes prompt.
 */
export function PipelineEditAdapter({
  target,
  targetKey,
  section,
  backLabel,
  pipelines,
  automations,
}: PipelineEditAdapterProps): JSX.Element {
  const capabilities = useCapabilities();
  const projectContext = pipelines.projectContext;
  // The opener's own worktree wins: a pop-out panel knows its checkout even
  // while the main window shows another one.
  const contextWorktree =
    target.cwd !== undefined && target.worktree !== undefined
      ? target.worktree
      : target.cwd !== undefined && target.cwd === projectContext?.cwd
        ? projectContext.worktree
        : undefined;
  // The worktree the pipeline opened in. The editor stays open when another
  // worktree is selected, and Share still needs this checkout's identity.
  const [openedWorktree] = useState(contextWorktree);
  const worktree = contextWorktree ?? openedWorktree;

  // The pipeline the last save stored, read by a related-row link right
  // after its save, before the session's own info has rendered.
  const savedInfoRef = useRef<PipelineInfo | null>(null);
  const handleSaved = useCallback(
    (saved: PipelineInfo, { wasDraft }: { wasDraft: boolean }): void => {
      savedInfoRef.current = saved;
      if (!wasDraft) return;
      replaceSavedDraft(targetKey, {
        kind: 'pipeline',
        ...pipelineEditLinkFromLocator(
          pipelineInfoToDocumentLocator(saved, target.cwd),
        ),
      });
    },
    [target.cwd, targetKey],
  );

  const session = usePipelineEditorSession(
    {
      pipelineId: target.pipelineId,
      draftKey: target.draftKey,
      cwd: target.cwd,
      worktree,
      pipelineFilePath: target.filePath,
      pipelineSource: target.source,
      sharedRemoteId: target.sharedRemoteId,
      onSharedPipelineCreated: (): void => {
        void pipelines.refreshSharedList();
      },
      onDuplicate: pipelines.openDuplicate,
    },
    {
      bindSaveShortcut: false,
      // Undo and redo act on the editor only while it is shown: ⌘Z in the
      // Runs search must not revert a hidden pipeline edit.
      bindShortcuts: section === 'definition',
      runWithoutGuard: (navigate): void => {
        runWithoutNavigationGuard(navigate);
      },
      onSaved: handleSaved,
    },
  );

  const projects = useProjectsStore((state) => state.projects);
  // CAN-5782: a workflow page's schedules, edited on its Trigger tab.
  const listedInfo = session.pipelineInfo
    ? pipelines.pipelines.find(
        (row) => row.source === 'user' && row.id === session.pipelineInfo?.id,
      )
    : undefined;
  const schedules = useWorkflowSchedules({
    info: session.pipelineInfo,
    // The list carries the workflow-page facts; it is refreshed after a
    // Remove that keeps the workflow, so they stay current here.
    workflowPage: listedInfo?.workflowPage,
    name: session.name,
    pipelineDirty: session.isDirty,
    pipeline: session.pipeline,
    automations,
    pipelines,
    ...(session.canDuplicate ? { onDuplicateWorkflow: session.duplicate } : {}),
    ...(target.focusScheduleId !== undefined
      ? { focusScheduleId: target.focusScheduleId }
      : {}),
  });

  // CAN-5782: a save that writes an agent-granted workflow's pipeline voids
  // its grant, so it asks first. Schedule-only saves don't write it.
  const [grantChoice, setGrantChoice] = useState<
    ((choice: GrantChoice) => void) | null
  >(null);
  const askGrant = useCallback(
    (): Promise<GrantChoice> =>
      new Promise((resolve) => {
        setGrantChoice(() => (choice: GrantChoice): void => {
          setGrantChoice(null);
          resolve(choice);
        });
      }),
    [],
  );

  // A failed save, from Save, ⌘S or the unsaved-changes prompt: the item
  // stays dirty, the shell shows why and moves to Definition, where every
  // pipeline field is. A declined save-impact confirm reports no message.
  const [saveFailure, setSaveFailure] = useState<string | null>(null);
  const sessionSave = session.save;
  const sessionDirty = session.isDirty;
  const sessionDuplicate = session.duplicate;
  const { agentGranted, saveAll: saveSchedules } = schedules;
  const save = useCallback(async (): Promise<UnsavedChangesSaveResult> => {
    setSaveFailure(null);
    if (sessionDirty) {
      if (agentGranted) {
        const choice = await askGrant();
        if (choice === 'duplicate') sessionDuplicate();
        if (choice !== 'save') return { ok: false };
      }
      const result = await sessionSave();
      if (!result.ok) {
        if (result.message !== undefined) {
          setSaveFailure(result.message);
          const shown = useNavigationStore.getState().workflowEdit;
          if (shown !== undefined && workflowEditKey(shown) === targetKey) {
            setSection('definition');
          }
        }
        return result;
      }
    }
    // The pipeline first, then each changed schedule, under the name the
    // pipeline save stored.
    const scheduled = await saveSchedules(
      sessionDirty ? savedInfoRef.current?.name : undefined,
    );
    if (!scheduled.ok && scheduled.message !== undefined) {
      setSaveFailure(scheduled.message);
      const shown = useNavigationStore.getState().workflowEdit;
      if (shown !== undefined && workflowEditKey(shown) === targetKey) {
        setSection('trigger');
      }
    }
    return scheduled;
  }, [
    agentGranted,
    askGrant,
    saveSchedules,
    sessionDirty,
    sessionDuplicate,
    sessionSave,
    targetKey,
  ]);
  const requestSave = useCallback((): void => {
    void save();
  }, [save]);

  // A related row (similar pipelines, its skills and plugins) leaves the
  // page: it saves the way Save does, the grant question and the schedules
  // included, before it goes.
  const schedulesDirty = schedules.dirty;
  const pipelineInfoRef = useRef(session.pipelineInfo);
  pipelineInfoRef.current = session.pipelineInfo;
  const relatedNavigate = useCallback(
    (navigate: (savedPipelineInfo?: PipelineInfo) => void): void => {
      if (!sessionDirty && !schedulesDirty) {
        navigate(pipelineInfoRef.current ?? undefined);
        return;
      }
      void save().then((result) => {
        if (!result.ok) return;
        const saved = savedInfoRef.current ?? pipelineInfoRef.current;
        runWithoutNavigationGuard((): void => navigate(saved ?? undefined));
      });
    },
    [save, schedulesDirty, sessionDirty],
  );
  const bodySession = useMemo(
    () => ({ ...session, relatedNavigate }),
    [relatedNavigate, session],
  );

  // Text typed into the Assistant and not sent is unsaved work too (Sergii's
  // QA, 2026-10-23): leaving asks, and Discard drops it with the edits.
  const assistantDraft = usePipelineAssistantDraft();
  // With only the draft unsaved, Save keeps the draft and writes nothing: a
  // clean pipeline has nothing to save.
  const sessionIsDirty = session.isDirty || schedules.dirty;
  const guardSave = useCallback(
    (): Promise<UnsavedChangesSaveResult> =>
      sessionIsDirty ? save() : Promise.resolve({ ok: true }),
    [sessionIsDirty, save],
  );
  const sessionDiscard = session.discard;
  const discardAssistantDraft = assistantDraft.discard;
  const discardSchedules = schedules.discard;
  const discard = useCallback((): void => {
    sessionDiscard();
    discardSchedules();
    discardAssistantDraft();
  }, [sessionDiscard, discardSchedules, discardAssistantDraft]);
  const guard = useWorkflowEditGuard({
    isDirty: sessionIsDirty || (!session.readOnly && assistantDraft.present),
    save: guardSave,
    discard,
    targetKey,
  });

  const selectedWorktree = useChatStore((state) => state.selectedWorktree);
  const { openWorkflowsRunModal, dispatchPipelineModal } =
    useDispatchPipelineModal();
  const [deleting, setDeleting] = useState(false);
  const [toggling, setToggling] = useState(false);

  const info = session.pipelineInfo;
  const listedPipelines = useMemo(
    () => [...pipelines.pipelines, ...pipelines.shared.rows],
    [pipelines.pipelines, pipelines.shared.rows],
  );
  const enabled = info ? !pipelines.disabledPipelineIds.has(info.id) : true;
  const scheduleIds = useMemo(
    () => new Set(schedules.records.map((record) => record.id)),
    [schedules.records],
  );
  const draft = session.isDraft;

  const plan = resolveWorkflowEditPlan({
    kind: 'pipeline',
    readOnly: session.readOnly,
    dirty: sessionIsDirty,
    saving: session.saving || schedules.saving || deleting,
    draft,
    // A schedule-only change saves without the pipeline's own checks.
    canSubmit: session.canSave || (!session.isDirty && schedules.dirty),
    userOwned: session.isUserOwned,
    // A saved pipeline runs once its info has loaded; a draft keeps Run in
    // place, disabled until its first save. The run picker lists only
    // pipelines it can start, so one that starts only from the Workflows
    // page (`workflow`, CAN-5782) has no Run here yet.
    runnable:
      draft ||
      (info !== null && !hasOnlyLocalPipelineTriggers(info.triggerTypes)),
    // A draft keeps Share in place, disabled until its first save.
    shareable: draft || session.canShare,
    // The Library offers Delete on a shared pipeline only when allowed.
    deletable: info?.source !== 'shared' || info.canDelete === true,
    capabilities,
  });

  useCurrentUiStateReporter('workflows.editShell', {
    kind: 'pipeline',
    ...(info ? { id: info.id } : {}),
    section,
    dirty: sessionIsDirty,
    readonly: session.readOnly,
    draft,
    ...(schedules.isWorkflowPage ? { scheduleIds: [...scheduleIds] } : {}),
  });

  const run = useCallback((): void => {
    if (!info) return;
    openWorkflowsRunModal({
      initialPipelineId: info.id,
      ...(selectedWorktree
        ? {
            currentTarget: {
              projectId: selectedWorktree.projectId,
              worktreeId: selectedWorktree.worktreeId,
            },
          }
        : {}),
    });
  }, [info, openWorkflowsRunModal, selectedWorktree]);

  // The shell confirms first, and shows a failure in its confirmation.
  const handleDelete = useCallback(
    async (pipeline: PipelineInfo): Promise<void> => {
      setDeleting(true);
      try {
        await pipelines.remove(pipeline);
      } catch (error: unknown) {
        throw error instanceof Error
          ? error
          : new Error('The workflow could not be deleted.');
      } finally {
        setDeleting(false);
      }
      // Nothing is left to save, so leaving never asks.
      session.discard();
      runWithoutNavigationGuard(goBack);
    },
    [pipelines, session],
  );

  const handleToggle = useCallback(
    (next: boolean): void => {
      if (!info || toggling) return;
      setToggling(true);
      void pipelines
        .setPipelineEnabled(info.id, next)
        .finally(() => setToggling(false));
    },
    [info, pipelines, toggling],
  );

  // The page's bar names the open pipeline, renames included, a read-only
  // one opens on the editor alone, and the assistant's empty chat offers
  // what fits it (CAN-4319).
  const { reportEdit } = pipelines;
  const editTitle = session.loading
    ? null
    : session.name || 'Untitled workflow';
  const editReadOnly = session.readOnly;
  const isDraft = session.isDraft;
  const jobCount = session.pipeline
    ? Object.keys(session.pipeline.jobs).length
    : 0;
  const validationIssueCount = session.validationErrors.length;
  const selection = pipelineAssistantSelection(
    session.pipeline,
    session.editor.selection,
  );
  const selectionKind = selection?.kind;
  const selectionLabel = selection?.label;
  const selectionJobLabel = selection?.jobLabel;
  const duplicateRef = useRef(session.duplicate);
  duplicateRef.current = session.duplicate;
  const canDuplicateCopy = editReadOnly && session.canDuplicate;
  const editDetails = useMemo(
    () =>
      editTitle === null
        ? null
        : {
            title: editTitle,
            readOnly: editReadOnly,
            ...(isDraft
              ? {}
              : {
                  assistant: {
                    name: editTitle,
                    readOnly: editReadOnly,
                    jobCount,
                    validationIssueCount,
                    selection:
                      selectionKind !== undefined &&
                      selectionLabel !== undefined &&
                      selectionJobLabel !== undefined
                        ? {
                            kind: selectionKind,
                            label: selectionLabel,
                            jobLabel: selectionJobLabel,
                          }
                        : null,
                    ...(canDuplicateCopy
                      ? { duplicate: (): void => duplicateRef.current() }
                      : {}),
                  },
                }),
          },
    [
      editTitle,
      editReadOnly,
      isDraft,
      jobCount,
      validationIssueCount,
      selectionKind,
      selectionLabel,
      selectionJobLabel,
      canDuplicateCopy,
    ],
  );
  useEffect(() => {
    reportEdit(editDetails);
  }, [editDetails, reportEdit]);
  useEffect(() => (): void => reportEdit(null), [reportEdit]);

  if (!session.loading && session.notFound) {
    return <WorkflowEditNotFound kind="pipeline" backLabel={backLabel} />;
  }

  const definitionToolbar: ReactNode = session.readDefinition ? (
    <div className="flex shrink-0 items-center gap-3 pb-3">
      <PipelineViewModeControls
        mode="read"
        view={session.readDetailView}
        onViewChange={session.setReadDetailView}
      />
    </div>
  ) : session.pipeline ? (
    <div
      className="flex shrink-0 items-center gap-3 pb-3"
      data-testid="pipeline-definition-toolbar"
    >
      <PipelineViewModeControls
        mode="edit"
        view={session.mainView}
        onViewChange={session.setMainView}
      />
      {session.canAddJob && <PipelineAddJobButton onAddJob={session.addJob} />}
      <PipelineSettingsToggle
        open={session.settingsOpen}
        onToggle={session.toggleSettings}
      />
      <div className="flex-1" />
      {session.showHistoryControls && (
        <PipelineHistoryControls
          canUndo={session.canUndo}
          canRedo={session.canRedo}
          onUndo={session.undo}
          onRedo={session.redo}
        />
      )}
    </div>
  ) : null;

  // The declared triggers are edited in Definition's settings panel.
  const onEditTriggers =
    !session.readOnly && session.pipeline
      ? (): void => {
          setSection('definition');
          session.setActivePanel('settings');
        }
      : undefined;

  // CAN-5782 phase 09: an edit to these steps reaches every workflow that
  // uses the pipeline, so Definition says so when there are several. The
  // list row carries the run-pipeline callers of a user pipeline; any other
  // pipeline (a project one that hooks run) counts from the opened info.
  const countedInfo = listedInfo ?? info;
  const sharedUserCount = countedInfo
    ? pipelineUserCount(countedInfo, {
        activities: automations.activities,
        // Local and cloud rows, so an automation that runs a cloud pipeline
        // finds it.
        pipelines: listedPipelines,
        hookCount: hooksRunningPipeline(projects, countedInfo).length,
      })
    : 0;

  const renderSection = (id: WorkflowEditSection): ReactNode => {
    if (id === 'definition') {
      return (
        <div className="flex min-h-0 flex-1 flex-col">
          {definitionToolbar}
          <PipelineEditorNotices
            session={session}
            showDuplicateAction={false}
            sharedUserCount={sharedUserCount}
          >
            <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border">
              <PipelineEditorBody
                session={bodySession}
                returnToEntryId={target.returnToEntryId}
                returnToEntryContext={target.returnToEntryContext}
                returnToPipeline={target.returnToPipeline}
                returnToMarketplace={target.returnToMarketplace}
                {...(schedules.firstScheduleInputs
                  ? { inputValues: schedules.firstScheduleInputs }
                  : {})}
              />
            </div>
          </PipelineEditorNotices>
        </div>
      );
    }
    const content =
      info === null ? (
        id === 'trigger' ? (
          // Nothing can name an unsaved pipeline yet.
          <PipelineTriggers
            starts={pipelineStartKinds(
              session.pipeline ? getTriggerTypes(session.pipeline.on) : [],
            )}
            hooks={[]}
            automations={[]}
            onOpenHook={(): void => undefined}
            onOpenAutomation={(): void => undefined}
            {...(onEditTriggers ? { onEditStarts: onEditTriggers } : {})}
          />
        ) : (
          <EmptyState testId="workflow-edit-no-runs" title="No runs yet" />
        )
      ) : id === 'trigger' ? (
        <PipelineTriggerSection
          pipeline={info}
          pipelines={listedPipelines}
          automations={automations}
          returnTo={target}
          triggerTypes={
            session.pipeline
              ? getTriggerTypes(session.pipeline.on)
              : info.triggerTypes
          }
          {...(onEditTriggers ? { onEditTriggers } : {})}
          {...(schedules.triggers ? { schedules: schedules.triggers } : {})}
        />
      ) : (
        <PipelineRunsSection
          pipeline={info}
          pipelines={listedPipelines}
          automations={automations}
          {...(schedules.isWorkflowPage ? { scheduleIds } : {})}
        />
      );
    return <div className="min-h-0 flex-1 overflow-auto pb-8">{content}</div>;
  };

  return (
    <>
      <WorkflowEditShell
        kind="pipeline"
        name={session.name || 'Untitled workflow'}
        {...(!session.readOnly && session.pipeline
          ? {
              nameEditor: (
                <PipelineNameEditor
                  name={session.name}
                  onRename={session.rename}
                />
              ),
            }
          : {})}
        {...(info?.description ? { description: info.description } : {})}
        backLabel={backLabel}
        onBack={goBack}
        plan={plan}
        section={section}
        onSectionChange={setSection}
        renderSection={renderSection}
        targetKey={targetKey}
        // The page's bar (CAN-4319) holds the way back and the actions.
        pageBar={{ actionsTarget: pipelines.editActionsTarget }}
        notices={
          // The editor shows its own load, save and Raw errors on Definition.
          saveFailure !== null &&
          session.error === null &&
          session.rawYamlError === null ? (
            <Notice
              intent="destructive"
              data-testid="pipeline-editor-save-error"
            >
              {saveFailure}
            </Notice>
          ) : undefined
        }
        onSave={requestSave}
        // Run and Share stay in place on a draft, disabled until it is saved.
        onRun={run}
        onShare={session.requestShare}
        {...(info !== null
          ? {
              onDelete: (): Promise<void> => handleDelete(info),
              ...(session.canDuplicate
                ? { onDuplicate: session.duplicate }
                : {}),
            }
          : {})}
        enabled={enabled}
        onToggleEnabled={handleToggle}
        actionTestIds={{
          save: 'pipeline-save',
          share: 'pipeline-share',
          back: 'pipeline-editor-back',
          duplicate: 'pipeline-editor-duplicate',
          toggle: 'pipeline-editor-enabled',
          delete: 'pipeline-editor-delete',
        }}
        busyActions={{ save: session.saving, duplicate: session.duplicating }}
        unsavedPrompt={guard.prompt}
        layout="fill"
      />
      {session.shareModal}
      {session.shareGateModal}
      {session.saveImpactDialog}
      {grantChoice !== null ? (
        <ConfirmDialog
          title={GRANT_SAVE_TITLE}
          message={GRANT_SAVE_MESSAGE}
          confirmLabel="Save anyway"
          onConfirm={(): void => grantChoice('save')}
          secondaryAction={{
            label: 'Duplicate instead',
            onSelect: (): void => grantChoice('duplicate'),
            testId: 'workflow-grant-save-duplicate',
          }}
          onCancel={(): void => grantChoice('cancel')}
          dataTestId="workflow-grant-save-confirm"
        />
      ) : null}
      {dispatchPipelineModal}
    </>
  );
}
