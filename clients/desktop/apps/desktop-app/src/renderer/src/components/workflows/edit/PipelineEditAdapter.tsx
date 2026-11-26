import { ControlButton } from '@canopy/ui-shared/components';
import { tryParseAndValidateYaml } from '@/lib/pipeline-yaml';
import { Surface } from '@canopy/ui-shared/components';
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
import { useAutomationsStore } from '@/stores/automationsStore';
import {
  hooksRunningPipeline,
  pipelineStartKinds,
  pipelineUserCount,
  sharedPipelineDuplicateOffered,
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
  type DesignerTriggerHost,
} from '../../pipeline/PipelineEditorBody';
import { automationsRunningPipeline } from '@/lib/workflows/pipeline-automations';
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
import { useWorkflowSendAs } from './useWorkflowSendAs';
import { SEND_AGENT_MESSAGE_USES } from '@/lib/pipelineStepSendAs';
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
    <ControlButton
      type="button"
      onClick={(): void => {
        nameBeforeEdit.current = name;
        typedName.current = name;
        setEditing(true);
      }}
      aria-label={`Rename ${label}`}
      // Capped at the heading's width, so a long name ends in an ellipsis
      // instead of running under the save state and the actions.
      presentation="workflow-rename"
    >
      {label}
    </ControlButton>
  );
}

/**
 * One pipeline in the Workflows edit shell (CAN-4072). Definition is the
 * pipeline editor under its own toolbar; Trigger lists the automations that
 * run it; Runs is the Runs feed narrowed to it. The shell owns ⌘S, Back and
 * the unsaved-changes prompt.
 */
const SEND_AS_TARGET_CHANGED =
  'A schedule’s target changed while saving. Check “Send as” on the send steps, then save again.';

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
  // A schedule the Designer's trigger card queued for after the next save
  // (CAN-4224). It lives here, not in the card, because a draft's first save
  // swaps the editor for the saved target, remounting the card.
  const scheduleAfterSaveRef = useRef<'schedule' | 'once' | null>(null);
  const handleSaved = useCallback(
    (saved: PipelineInfo, { wasDraft }: { wasDraft: boolean }): void => {
      savedInfoRef.current = saved;
      const queued = scheduleAfterSaveRef.current;
      scheduleAfterSaveRef.current = null;
      const savedTarget: WorkflowEditTarget = {
        kind: 'pipeline',
        ...pipelineEditLinkFromLocator(
          pipelineInfoToDocumentLocator(saved, target.cwd),
        ),
      };
      if (wasDraft) replaceSavedDraft(targetKey, savedTarget);
      // After the swap, and only while the saved workflow is still shown: a
      // save from the unsaved-changes prompt goes where the person chose,
      // and the queued schedule is dropped. A schedule starts the workflow
      // as a run, which the saved workflow must allow.
      if (queued !== null && (saved.triggerTypes ?? []).includes('dispatch')) {
        const expected = wasDraft ? workflowEditKey(savedTarget) : targetKey;
        setTimeout(() => {
          const navigation = useNavigationStore.getState();
          const shown = navigation.workflowEdit;
          if (shown === undefined || workflowEditKey(shown) !== expected)
            return;
          navigation.openAutomationDraft(
            {
              name: saved.name,
              trigger: queued === 'once' ? 'one_time' : 'cron',
            },
            shown,
          );
        }, 0);
      }
    },
    [target.cwd, targetKey],
  );

  const saveCommandRef = useRef<() => void>(() => undefined);
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
      // CAN-7186: the pipeline.save command saves through the page's Save,
      // with its "Send as" check and preference write.
      saveCommand: (): void => saveCommandRef.current(),
    },
  );

  const projects = useProjectsStore((state) => state.projects);
  const projectsLoadCount = useProjectsStore(
    (state) => state.projectsLoadCount,
  );
  // CAN-6933: hook-triggered automations can differ by branch, so the editor
  // reads every worktree's own hooks when it opens and after each load. The
  // Designer's trigger card counts hooks only once every read succeeded for
  // the current load (CAN-4224): a pending or failed read may hide one.
  const [hooksReadForLoad, setHooksReadForLoad] = useState<number | null>(null);
  useEffect(() => {
    const { projects: current, ensureWorktreeEffective } =
      useProjectsStore.getState();
    const reads: Promise<boolean>[] = [];
    for (const project of current) {
      if (project.type === 'cowork' || project.worktrees.length === 0) continue;
      reads.push(
        ensureWorktreeEffective(
          project.id,
          project.worktrees.map((worktree) => worktree.id),
        ),
      );
    }
    let live = true;
    void Promise.all(reads).then((results) => {
      if (live && results.every(Boolean))
        setHooksReadForLoad(projectsLoadCount);
    });
    return (): void => {
      live = false;
    };
  }, [projectsLoadCount]);
  // CAN-6065: Remove on an installed workflow's last schedule opens the
  // page's Delete confirmation.
  const [deleteRequest, setDeleteRequest] = useState(0);
  const requestDelete = useCallback(
    (): void => setDeleteRequest((count) => count + 1),
    [],
  );
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
    ...(session.pipelineInfo !== null
      ? { onDeleteWorkflow: requestDelete }
      : {}),
    ...(target.focusScheduleId !== undefined
      ? { focusScheduleId: target.focusScheduleId }
      : {}),
  });

  // CAN-7186: "Send as" on the send steps, read over the first schedule's
  // run values as edited, which Save stores. A schedule that keeps its own
  // preferences for a collection runs with those instead.
  const sendAs = useWorkflowSendAs({
    editor: session.editor,
    pipeline: session.pipeline,
    info: session.pipelineInfo,
    ...(schedules.editedFirstScheduleInputs
      ? { inputValues: schedules.editedFirstScheduleInputs }
      : {}),
    scheduleOverrides: schedules.editedCollectionOverrides,
    agentGranted: schedules.agentGranted,
    active: !session.readOnly,
  });
  // The schedule target Send as was checked against, and the one now: a
  // target edited while Save writes is checked before schedules are stored.
  const sendAsTargetKey = JSON.stringify(
    schedules.editedFirstScheduleInputs ?? null,
  );
  const latestSendAsTargetKey = useRef(sendAsTargetKey);
  useEffect(() => {
    latestSendAsTargetKey.current = sendAsTargetKey;
  }, [sendAsTargetKey]);
  const sendAsUnchosen = sendAs.unchosenSteps;
  const sendAsChecking = sendAs.checking;
  const sendAsBlocked = sendAsUnchosen.length > 0 || sendAsChecking;

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
  const {
    agentGranted,
    saveAll: saveSchedules,
    pendingScheduleInputs,
  } = schedules;
  const { setPendingScheduleInputs } = session.editor;
  const { save: saveSendAs } = sendAs;
  const { getSavedPipeline } = session.editor;
  const sessionInfo = session.pipelineInfo;
  const { isRawMode, rawYamlText, setMainView } = session;
  // `schedules: false` is the pipeline.save command's save (CAN-7186): the
  // definition and its "Send as" choices, never schedule edits, which an
  // agent may change only through the automation update policy.
  const save = useCallback(
    async ({
      schedules: withSchedules = true,
    }: { schedules?: boolean } = {}): Promise<UnsavedChangesSaveResult> => {
      setSaveFailure(null);
      let pendingSent = false;
      // Raw text is read only when saved, so a send step typed there is
      // applied first and checked for "Send as" before the next Save.
      if (isRawMode && rawYamlText.includes(SEND_AGENT_MESSAGE_USES)) {
        setMainView('designer');
        const message =
          'Check “Send as” on the send steps, then save this workflow.';
        setSaveFailure(message);
        return { ok: false, message };
      }
      // A run nobody watches never picks an account, so Save waits for one,
      // and for the check of what the send steps use to finish. Raw text with
      // no send step left is saved as written: the check read the definition
      // before the text, which may have removed the step it waits on.
      if (sendAsBlocked && !isRawMode) {
        const message = sendAsChecking
          ? 'Checking which accounts the send steps use. Try saving again in a moment.'
          : sendAsBlockedMessage(sendAsUnchosen);
        setSaveFailure(message);
        return { ok: false, message };
      }
      if (sessionDirty) {
        if (agentGranted) {
          const choice = await askGrant();
          if (choice === 'duplicate') sessionDuplicate();
          if (choice !== 'save') return { ok: false };
        }
        // CAN-5782: the schedule check reads the schedules' edited inputs,
        // which this Save writes right after the pipeline.
        // Judged against the definition this save sends: the Raw YAML
        // text when that's the view, as the session parses it.
        const parsedRaw = isRawMode
          ? tryParseAndValidateYaml(rawYamlText)
          : undefined;
        const candidate = parsedRaw?.success ? parsedRaw.pipeline : null;
        const pending = withSchedules
          ? await pendingScheduleInputs(candidate)
          : null;
        pendingSent = pending !== null && Object.keys(pending).length > 0;
        setPendingScheduleInputs(pending);
        const result = await sessionSave().finally(() =>
          setPendingScheduleInputs(null),
        );
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
      // CAN-5782: a failure after the workflow saved on the schedules'
      // edited inputs says the schedules weren't written yet.
      const unwritten = (failure: string): UnsavedChangesSaveResult => {
        const message = pendingSent
          ? `${failure} The workflow is saved, but its schedules aren't yet: save again before they run, or they keep their old inputs.`
          : failure;
        setSaveFailure(message);
        return { ok: false, message };
      };
      // The pipeline first, then its send steps' accounts on this machine,
      // which need its saved identity, then each changed schedule, under the
      // name the pipeline save stored.
      const sentAs = await saveSendAs(savedInfoRef.current ?? sessionInfo);
      if (!sentAs.ok) return unwritten(sentAs.message);
      if (!withSchedules) return { ok: true };
      // Checked again right before each schedule is written, since a
      // schedule can still change while the save reads preferences.
      const targetChanged = (): UnsavedChangesSaveResult | null =>
        latestSendAsTargetKey.current === sendAsTargetKey
          ? null
          : { ok: false, message: SEND_AS_TARGET_CHANGED };
      if (targetChanged()) return unwritten(SEND_AS_TARGET_CHANGED);
      const savedName = sessionDirty ? savedInfoRef.current?.name : undefined;
      const savedPipeline = sessionDirty ? getSavedPipeline() : null;
      const scheduled = await saveSchedules({
        ...(savedName !== undefined ? { savedName } : {}),
        ...(savedPipeline ? { savedPipeline } : {}),
        check: targetChanged,
      });
      if (!scheduled.ok && scheduled.message !== undefined) {
        // CAN-5782: the workflow saved on the schedules' edited inputs; one
        // that didn't save keeps inputs its trigger may no longer accept.
        const message = pendingSent
          ? `${scheduled.message} The workflow is saved, so fix this schedule before it runs: until then it keeps its old inputs.`
          : scheduled.message;
        setSaveFailure(message);
        const shown = useNavigationStore.getState().workflowEdit;
        if (shown !== undefined && workflowEditKey(shown) === targetKey) {
          setSection('trigger');
        }
      }
      return scheduled;
    },
    [
      agentGranted,
      askGrant,
      getSavedPipeline,
      pendingScheduleInputs,
      setPendingScheduleInputs,
      saveSchedules,
      isRawMode,
      rawYamlText,
      saveSendAs,
      sendAsBlocked,
      sendAsChecking,
      sendAsTargetKey,
      sendAsUnchosen,
      sessionDirty,
      setMainView,
      sessionDuplicate,
      sessionInfo,
      sessionSave,
      targetKey,
    ],
  );
  const requestSave = useCallback((): void => {
    void save();
  }, [save]);
  useEffect(() => {
    saveCommandRef.current = (): void => {
      void save({ schedules: false });
    };
  }, [save]);

  // A related row (similar pipelines, its skills and plugins) leaves the
  // page: it saves the way Save does, the grant question and the schedules
  // included, before it goes.
  const schedulesDirty = schedules.dirty || sendAs.dirty;
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
  const sessionIsDirty = session.isDirty || schedules.dirty || sendAs.dirty;
  const automationsHydrated = useAutomationsStore((s) => s.hydrated);
  const guardSave = useCallback(
    (): Promise<UnsavedChangesSaveResult> =>
      sessionIsDirty ? save() : Promise.resolve({ ok: true }),
    [sessionIsDirty, save],
  );
  const sessionDiscard = session.discard;
  const discardAssistantDraft = assistantDraft.discard;
  const discardSchedules = schedules.discard;
  const discardSendAs = sendAs.discard;
  const discard = useCallback((): void => {
    sessionDiscard();
    discardSchedules();
    discardSendAs();
    discardAssistantDraft();
  }, [sessionDiscard, discardSchedules, discardSendAs, discardAssistantDraft]);
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
  // The shell's delete confirmation shows a failure only while the shell is
  // rendered: the adapter can stay mounted and render the not-found page.
  const shellShown = useRef(true);
  const [toggling, setToggling] = useState(false);

  const info = session.pipelineInfo;
  // CAN-5782: a Workflow-only page's schedules run only content a person
  // approved; the list says whether the saved content is approved.
  const [approval, setApproval] = useState<{
    busy: boolean;
    error?: string;
  }>({ busy: false });
  const scheduleApproval = listedInfo?.workflowPage?.scheduleApproval;
  const approveForSchedules = useCallback(async (): Promise<void> => {
    if (!info || !scheduleApproval) return;
    setApproval({ busy: true });
    const result = await window.pipelines.approveForSchedules({
      pipelineId: info.id,
      revision: scheduleApproval.revision,
      contentDigest: scheduleApproval.contentDigest,
      packageDigest: scheduleApproval.packageDigest,
    });
    // The schedules' agent notes come from the automations list, so it
    // reloads with the pipeline list once a person takes the content over.
    await Promise.all([pipelines.refresh(), automations.reload()]);
    setApproval(
      result.success
        ? { busy: false }
        : {
            busy: false,
            error: result.error ?? "This version couldn't be approved.",
          },
    );
  }, [automations, info, pipelines, scheduleApproval]);
  const workflowApproval =
    scheduleApproval && !scheduleApproval.approved
      ? {
          busy: approval.busy,
          ...(approval.error ? { error: approval.error } : {}),
          ...(scheduleApproval.automationPackage
            ? {
                blockedReason:
                  'Its schedules run it with a package installed with the automation, which an approval doesn’t cover yet. Ask its publisher for a version with a Manual trigger, then reinstall it.',
              }
            : session.isDirty ||
                (info?.revision ?? 0) !== scheduleApproval.revision
              ? {
                  blockedReason:
                    'Save your changes first, then approve the saved version.',
                }
              : {
                  onApprove: (): void => {
                    void approveForSchedules();
                  },
                }),
        }
      : undefined;
  // CAN-5782: Settings' trigger list reads the list row's facts: a package
  // install (the row's, or a schedule's own package) and its callers.
  const triggerFacts = useMemo(
    () => ({
      packageInstalled:
        listedInfo?.distributionMode === 'package' ||
        schedules.records.some(
          (record) => record.installedFrom?.capabilityPackage !== undefined,
        ),
      // Callers that declare Workflow, page or not: a run of theirs as
      // Workflow passes the event on to this step.
      workflowCallers: listedInfo?.workflowTriggerCallers ?? 0,
    }),
    [listedInfo, schedules.records],
  );
  const listedPipelines = useMemo(
    () => [...pipelines.pipelines, ...pipelines.shared.rows],
    [pipelines.pipelines, pipelines.shared.rows],
  );
  const enabled = info ? !pipelines.disabledPipelineIds.has(info.id) : true;
  // CAN-4224 phase 04: the Designer's trigger card lists what schedules the
  // pipeline, and edits and adds them where each is edited today: a workflow
  // page's Trigger tab, or the automation editor.
  const pageSchedules = schedules.triggers;
  const addPageSchedule = schedules.addSchedule;
  // A hook runs the pipeline as a run, which needs Run to stay on.
  const startedByHooks = info
    ? hooksRunningPipeline(projects, info).length > 0
    : false;
  const startersKnown =
    !automations.loading &&
    automations.error === null &&
    projectsLoadCount > 0 &&
    hooksReadForLoad === projectsLoadCount;
  const designerTrigger = useMemo((): DesignerTriggerHost => {
    if (pageSchedules)
      return {
        startedByHooks,
        startersKnown,
        schedules: pageSchedules.rows.map((row) => ({
          key: row.key,
          summary: row.summary,
          enabled: row.enabled,
        })),
        addsInPlace: true,
        onEditSchedule: (key): void => {
          pageSchedules.onExpand(key);
          setSection('trigger');
        },
        ...(pageSchedules.onAdd
          ? {
              onAddSchedule: (kind): void => {
                setSection('trigger');
                addPageSchedule(kind);
              },
            }
          : {}),
        ...(pageSchedules.addBlockedReason !== undefined
          ? { addBlockedReason: pageSchedules.addBlockedReason }
          : {}),
      };
    // Every source an automation can target, as the Trigger tab lists them:
    // a shared workflow someone can edit has schedules too. The open
    // workflow resolves its own schedules, whether or not the Library rows
    // have loaded.
    const running = info
      ? automationsRunningPipeline(automations.activities, info, {
          pipelines: [info, ...listedPipelines],
        })
      : [];
    return {
      schedules: running.map((row) => ({
        key: row.activity.id,
        summary: row.scheduleText,
        name: row.activity.name,
        enabled: row.enabled,
      })),
      addsInPlace: false,
      startedByHooks,
      startersKnown,
      onEditSchedule: (key): void =>
        useNavigationStore.getState().openAutomationEdit({
          activityId: key,
          returnTo: target,
        }),
      // The body calls this only once the workflow is saved. The draft
      // carries the schedule's name and kind; the person picks the workflow
      // in the form's own picker, which sets up its inputs, model aliases
      // and plugins, and Save waits for that pick.
      onAddSchedule: (kind): void => {
        const saved = savedInfoRef.current ?? session.pipelineInfo;
        if (!saved) return;
        // Back from the draft returns to this workflow.
        useNavigationStore.getState().openAutomationDraft(
          {
            name: saved.name,
            trigger: kind === 'once' ? 'one_time' : 'cron',
          },
          target,
        );
      },
      onQueueScheduleAfterSave: (kind): void => {
        scheduleAfterSaveRef.current = kind;
      },
    };
  }, [
    addPageSchedule,
    automations.activities,
    info,
    listedPipelines,
    pageSchedules,
    session.pipelineInfo,
    startedByHooks,
    startersKnown,
    target,
  ]);
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
    canSubmit:
      (!sendAsBlocked || session.isRawMode) &&
      (session.canSave ||
        (!session.isDirty && (schedules.dirty || sendAs.dirty))),
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
    ...(schedules.schedulable ? { scheduleIds: [...scheduleIds] } : {}),
  });

  const run = useCallback((): void => {
    if (!info) return;
    openWorkflowsRunModal({
      initialPipelineId: info.id,
      startOnSettings: true,
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
  const scheduleRecords = schedules.records;
  const handleDelete = useCallback(
    async (pipeline: PipelineInfo): Promise<void> => {
      setDeleting(true);
      try {
        // A workflow page with schedules goes in one write, every schedule
        // and its install with it, as the Library's Delete does (CAN-6065).
        const first = scheduleRecords[0];
        if (first !== undefined) {
          await automations.remove(first, { workflow: true });
          await pipelines.refresh();
        } else
          // The shell's confirmation shows and records a failure, so the
          // list's load error holds it only once the editor is gone.
          await pipelines.remove(pipeline, {
            callerShowsFailure: (): boolean => shellShown.current,
          });
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
    [automations, pipelines, scheduleRecords, session],
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

  const showsNotFound = !session.loading && session.notFound;
  useEffect(() => {
    shellShown.current = !showsNotFound;
    return (): void => {
      shellShown.current = false;
    };
  }, [showsNotFound]);
  if (showsNotFound) {
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
  // Only a list main returned counts: a failed or reset load leaves it
  // empty and unhydrated, which can't show that no install owns the page.
  const offerSharedDuplicate =
    !session.readOnly &&
    countedInfo !== null &&
    sharedPipelineDuplicateOffered(countedInfo, {
      activities: automations.activities,
      activitiesLoaded: automationsHydrated && !automations.loading,
    });

  const renderSection = (id: WorkflowEditSection): ReactNode => {
    if (id === 'definition') {
      return (
        <div className="flex min-h-0 flex-1 flex-col">
          {definitionToolbar}
          <PipelineEditorNotices
            session={session}
            showDuplicateAction={false}
            sharedUserCount={sharedUserCount}
            offerSharedDuplicate={offerSharedDuplicate}
            pageDirty={sessionIsDirty}
          >
            <Surface
              variant="outline"
              className="relative flex min-h-0 flex-1 flex-col overflow-hidden"
            >
              <PipelineEditorBody
                session={bodySession}
                returnToEntryId={target.returnToEntryId}
                returnToEntryContext={target.returnToEntryContext}
                returnToPipeline={target.returnToPipeline}
                returnToMarketplace={target.returnToMarketplace}
                {...(schedules.firstScheduleInputs
                  ? { inputValues: schedules.firstScheduleInputs }
                  : {})}
                designerTrigger={designerTrigger}
                stepSendAs={sendAs.step}
                triggerFacts={triggerFacts}
              />
            </Surface>
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
          {...(workflowApproval ? { workflowApproval } : {})}
        />
      ) : (
        <PipelineRunsSection
          pipeline={info}
          pipelines={listedPipelines}
          automations={automations}
          {...(schedules.schedulable ? { scheduleIds } : {})}
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
              errorSource="pipeline-editor-save-error"
              intent="destructive"
              data-testid="pipeline-editor-save-error"
            >
              {saveFailure}
            </Notice>
          ) : sendAsUnchosen.length > 0 ? (
            <Notice data-testid="workflow-send-as-needed">
              {sendAsBlockedMessage(sendAsUnchosen)}
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
        deleteRequest={deleteRequest}
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

/** Why Save waits: the send steps that still need a "Send as" account. */
function sendAsBlockedMessage(steps: readonly string[]): string {
  const named = steps.map((step) => `“${step}”`).join(', ');
  return `Choose which account ${named} sends as in its step settings to save this workflow.`;
}
