/**
 * A workflow page's schedules (CAN-5782): the automation records that run its
 * pipeline on a time, edited on its Trigger tab. Each is a draft of its
 * stored `worktree_pipeline` action (phase 03's drafts), so a save never
 * regenerates the steps; main enforces who may add, remove or edit one
 * (phase 04).
 */
import {
  initializeInputValues,
  resolvePipelineTriggerInputs,
} from '@/lib/pipelineTriggerInputs';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import type {
  Pipeline,
  PipelineInfo,
} from '@canopy/execution-engine/types/pipeline';
import { getTriggerInputDefs } from '@canopy/execution-engine/types/pipeline';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import type {
  AutomationCloudDestinationCandidate,
  AutomationScheduleMoveRequest,
  ScheduledActivity,
} from '@canopy/desktop-shared/types';
import type { CloudModelPreflightResult } from '@canopy/protocol/canopy-core';
import { CloudModelReplacementDialog } from '@canopy/ui-app';
import type { PipelineWorkflowPageInfo } from '@canopy/protocol/pipelines';
import {
  ScheduleRunOnField,
  type PipelineTriggerScheduleRow,
  type PipelineTriggerSchedules,
  type UnsavedChangesSaveResult,
} from '@canopy/ui-app/workflows';
import {
  Button,
  FormField,
  Notice,
  NoticeButton,
  TextInput,
} from '@canopy/ui-shared/components';
import { automationTrigger } from '@/lib/workflows/library-projection';
import { storedAutomationActivity } from '@/lib/workflows/stored-automation-activity';
import { useAutomationsStore } from '@/stores/automationsStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { ActivityFormBody } from '../../automations/form/ActivityFormBody';
import { usePipelineCloudRuns } from '../../activity/pipelineRunOn';
import {
  activityToFormState,
  type FormState,
} from '../../automations/form/automationFormState';
import type { AutomationsPageBodyApi } from '../../pages/AutomationsPage';
import type { PipelinesPageListApi } from '../../pages/PipelinesPage';
import {
  useScheduleDrafts,
  type ScheduleDraft,
  type ScheduleDraftSource,
} from './useScheduleDrafts';

const AGENT_ORIGIN_NOTICE =
  "An agent created this workflow. Its runs keep the agent's restrictions.";
const AGENT_ORIGIN_DUPLICATE = 'Duplicate the workflow to run it as yours.';
const AGENT_ORIGIN_SAVE_FIRST =
  'Save your changes, then duplicate the workflow to run it as yours.';
const NEW_SCHEDULE = 'New schedule';
// The Run on field (CAN-6917). Copy beside the strings: these are this
// surface's reasons, not a UX writing rule.
const RUN_ON_SAVE_FIRST = 'Save this schedule before choosing where it runs.';
const RUN_ON_ORCHESTRATOR = 'Orchestrator workflows stay on this computer.';
/** Shown in a cloud schedule's row, beside when it runs. */
const RUNS_IN_CLOUD = 'Cloud';

/** A move of one schedule, as the Run on field shows it. */
interface ScheduleMove {
  readonly busy: boolean;
  readonly error: string | null;
  /** The move asked where in the cloud it runs. */
  readonly place?: {
    readonly message: string;
    readonly candidates: readonly AutomationCloudDestinationCandidate[];
    readonly value: string | null;
  };
  /** The move asked for cloud models for steps the cloud can't run. */
  readonly models?: CloudModelPreflightResult;
}

/**
 * A converted Orchestrator workflow stays on this computer (CAN-6917), as
 * main's ownsOrchestratorPromptPipeline decides; main refuses it either way.
 */
function isOrchestratorSchedule(activity: ScheduledActivity): boolean {
  // The stored action: a chat-editable owner shows its chat action instead.
  const { action } = storedAutomationActivity(activity);
  return (
    action.type === 'worktree_pipeline' &&
    action.inputs?.bot_id !== undefined &&
    action.inputs.chat_id === undefined &&
    activity.ownedPipeline !== undefined
  );
}
const SAVING_SCHEDULE = 'Saving this schedule…';
/** Weekdays at 9:00 AM, the schedule a new one starts with. */
const NEW_SCHEDULE_CRON = '0 9 * * 1-5';

/** A declared input default as the text a schedule stores. */
function inputDefaultText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  return JSON.stringify(value);
}

/** The inputs a step reads (`inputs.project_id` and the like). */
function inputsTheStepsRead(pipeline: Pipeline | null): ReadonlySet<string> {
  if (!pipeline) return new Set();
  const read = new Set<string>();
  for (const match of JSON.stringify(pipeline.jobs).matchAll(
    /inputs\.([A-Za-z0-9_-]+)/g,
  ))
    if (match[1]) read.add(match[1]);
  return read;
}

/** The form a new schedule starts with, from another one's values. */
function newScheduleState(
  info: PipelineInfo,
  from: ScheduledActivity | undefined,
  workflowPage: PipelineWorkflowPageInfo | undefined,
  name: string,
  defaults: Readonly<Record<string, string>>,
): FormState {
  const scheduleName = name.trim() || info.name;
  if (from !== undefined) {
    // A copy of the first schedule, as the person's own new record.
    return {
      ...activityToFormState(storedAutomationActivity(from)),
      name: scheduleName,
      mode: 'create',
      id: undefined,
      installed: false,
      enabled: true,
      pipelineDependencies: undefined,
    };
  }
  const values = workflowPage?.lastScheduleValues;
  // Without kept values, the declared input defaults.
  const inputs =
    values?.inputs ??
    (Object.keys(defaults).length > 0 ? { ...defaults } : undefined);
  // A project-bound schedule keeps its project; only a converted one, which
  // stores no project, runs with no project.
  const target =
    values?.target ??
    (values?.workspaceId !== undefined
      ? undefined
      : { kind: 'global' as const });
  const activity: ScheduledActivity = {
    version: 1,
    id: 'new-schedule',
    name: scheduleName,
    enabled: true,
    schedule: {
      kind: 'cron',
      expression: NEW_SCHEDULE_CRON,
      timezone: 'local',
    },
    action: {
      type: 'worktree_pipeline',
      ...(target !== undefined ? { target } : {}),
      ...(values?.workspaceId !== undefined
        ? { workspaceId: values.workspaceId }
        : {}),
      ...(values?.repoId !== undefined ? { repoId: values.repoId } : {}),
      pipelineId: info.id,
      pipelineSource: 'user',
      pipelineName: scheduleName,
      ...(inputs ? { inputs } : {}),
      ...(values?.modelAliasPreferences
        ? { modelAliasPreferences: values.modelAliasPreferences }
        : {}),
      ...(values?.pluginCollectionPreferences
        ? { pluginCollectionPreferences: values.pluginCollectionPreferences }
        : {}),
    },
    createdAt: '',
    updatedAt: '',
    failureCount: 0,
  };
  return { ...activityToFormState(activity), mode: 'create', id: undefined };
}

export interface WorkflowSchedulesApi {
  /** The pipeline is a workflow page: its schedules replace Automations. */
  readonly isWorkflowPage: boolean;
  readonly records: readonly ScheduledActivity[];
  readonly dirty: boolean;
  readonly saving: boolean;
  /** An agent wrote the pipeline and main granted its runs (phase 04). */
  readonly agentGranted: boolean;
  /**
   * Saves each changed schedule; the first failure stops and says why.
   * `savedName` is the name the pipeline save just stored, which a Raw YAML
   * rename sets without the editor's own name having rendered yet.
   */
  readonly saveAll: (savedName?: string) => Promise<UnsavedChangesSaveResult>;
  readonly discard: () => void;
  readonly triggers: PipelineTriggerSchedules | undefined;
  /**
   * The run values of the first schedule, else the ones the workflow kept
   * from its last (phase 08): what the steps' `inputs.*` stand for.
   */
  readonly firstScheduleInputs: Readonly<Record<string, string>> | undefined;
  /**
   * CAN-7186: the run values of the first schedule as edited, which Save
   * stores, else `firstScheduleInputs`.
   */
  readonly editedFirstScheduleInputs:
    | Readonly<Record<string, string>>
    | undefined;
  /**
   * CAN-7186: the plugin collections each schedule keeps its own
   * preferences for, as edited, by collection id: their runs use those.
   */
  readonly editedCollectionOverrides: ReadonlyMap<string, readonly string[]>;
}

export interface UseWorkflowSchedulesOptions {
  readonly info: PipelineInfo | null;
  /**
   * The workflow-page facts the pipeline list carries (phase 04): the
   * editor's own pipeline info is read from `pipelines:get`, which has none.
   */
  readonly workflowPage: PipelineWorkflowPageInfo | undefined;
  /** The workflow's name as saved, which its schedules take (Decision 6). */
  readonly name: string;
  /** The pipeline as edited, for its inputs and the ones its steps read. */
  readonly pipeline: Pipeline | null;
  readonly automations: AutomationsPageBodyApi;
  readonly pipelines: PipelinesPageListApi;
  /** The page's Duplicate (phase 04), which opens the copy. */
  readonly onDuplicateWorkflow?: () => void;
  /**
   * Opens the page's Delete confirmation (CAN-6065): Remove on the last
   * schedule of an installed workflow, which can't stay without it.
   */
  readonly onDeleteWorkflow?: () => void;
  /** The pipeline has unsaved edits, which a Duplicate wouldn't carry. */
  readonly pipelineDirty: boolean;
  /** The schedule an opener asked for, shown expanded (phase 07). */
  readonly focusScheduleId?: string;
}

export function useWorkflowSchedules({
  info,
  workflowPage,
  name,
  pipeline,
  automations,
  pipelines,
  onDuplicateWorkflow,
  onDeleteWorkflow,
  pipelineDirty,
  focusScheduleId,
}: UseWorkflowSchedulesOptions): WorkflowSchedulesApi {
  const projects = useProjectsStore((s) => s.projects);
  const pipelineId = info?.source === 'user' ? info.id : undefined;
  const records = useMemo(
    () =>
      pipelineId === undefined
        ? []
        : automations.activities.filter(
            (activity) => activity.workflowSchedule?.pipelineId === pipelineId,
          ),
    [automations.activities, pipelineId],
  );
  const isWorkflowPage =
    pipelineId !== undefined &&
    (workflowPage !== undefined || records.length > 0);
  // The grant is the pipeline's (CAN-6065), so it holds after its first
  // schedule is removed.
  const agentGranted =
    workflowPage?.agentGranted === true ||
    records.some((record) => record.ownedPipeline?.agentGranted === true);

  // New rows not saved yet, keyed by their own key.
  const [newRows, setNewRows] = useState<
    readonly { key: string; initial: FormState }[]
  >([]);
  const nextKey = useRef(0);
  // A new row's edits made while its create was in flight, by the record it
  // became; handed to that record's draft once.
  const carriedRef = useRef(new Map<string, FormState>());
  const sources = useMemo(
    (): ScheduleDraftSource[] => [
      ...records.map((activity) => {
        const pending = carriedRef.current.get(activity.id);
        return {
          key: activity.id,
          activity,
          stored: true,
          ...(pending ? { pending } : {}),
        };
      }),
      ...newRows.map((row) => ({
        key: row.key,
        activity: null,
        initial: row.initial,
      })),
    ],
    [newRows, records],
  );
  const drafts = useScheduleDrafts({
    sources,
    onCreated: (key, activity, pending) => {
      if (pending) carriedRef.current.set(activity.id, pending);
      // The row stays, read-only, until its record is listed: until then
      // the page still counts as unsaved and Save can't report its edits
      // as written.
      awaitingRef.current.set(key, {
        id: activity.id,
        pending: pending !== undefined,
      });
      setAwaitingKeys((keys) => new Set(keys).add(key));
    },
  });
  // New rows created whose records aren't listed yet.
  const awaitingRef = useRef(
    new Map<string, { id: string; pending: boolean }>(),
  );
  const [awaitingKeys, setAwaitingKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  // Once its record is listed, a created row goes, and carried edits are
  // spent: the record's draft has taken them.
  useEffect(() => {
    const listed = (id: string): boolean =>
      records.some((record) => record.id === id);
    for (const id of carriedRef.current.keys())
      if (listed(id)) carriedRef.current.delete(id);
    const gone = [...awaitingRef.current].filter(([, { id }]) => listed(id));
    if (gone.length === 0) return;
    for (const [key] of gone) awaitingRef.current.delete(key);
    const goneKeys = new Set(gone.map(([key]) => key));
    setNewRows((rows) => rows.filter((row) => !goneKeys.has(row.key)));
    setAwaitingKeys((keys) => {
      const next = new Set(keys);
      for (const key of goneKeys) next.delete(key);
      return next;
    });
  }, [records]);
  const [expandedKey, setExpandedKey] = useState<string | null>(
    focusScheduleId ?? null,
  );
  // A later open of another schedule on this page expands that one.
  const [focusedId, setFocusedId] = useState(focusScheduleId);
  if (focusScheduleId !== focusedId) {
    setFocusedId(focusScheduleId);
    if (focusScheduleId !== undefined) setExpandedKey(focusScheduleId);
  }
  const [rowError, setRowError] = useState<{
    key: string;
    message: string;
  } | null>(null);

  const required = useMemo(() => inputsTheStepsRead(pipeline), [pipeline]);
  const definitions = useMemo(
    () => getTriggerInputDefs(pipeline?.on, 'dispatch') ?? {},
    [pipeline],
  );
  const declared = useMemo(() => Object.keys(definitions), [definitions]);
  // A run resolves a missing input to its declared default.
  const defaults = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(definitions).flatMap(([key, definition]) => {
          const value = inputDefaultText(definition.default);
          return value === undefined ? [] : [[key, value]];
        }),
      ),
    [definitions],
  );

  const missingInput = useCallback(
    (state: FormState): string | undefined => {
      const values = new Map(
        state.pipelineInputs.map((entry) => [entry.key, entry.value]),
      );
      return declared.find(
        (key) =>
          required.has(key) &&
          defaults[key] === undefined &&
          !values.get(key)?.trim(),
      );
    },
    [declared, defaults, required],
  );

  const saveAll = useCallback(
    async (savedName?: string): Promise<UnsavedChangesSaveResult> => {
      const scheduleName = savedName ?? name;
      setRowError(null);
      // Read the drafts as they are now, again after each pass: a schedule
      // edited while the pipeline saved is saved too, never skipped.
      for (let pass = 0; pass < 3; pass += 1) {
        const pending = drafts
          .current()
          .filter((draft) => draft.dirty || draft.activity === null);
        if (pending.length === 0) break;
        for (const draft of pending) {
          // A schedule takes the workflow's name; the Trigger tab never edits
          // it, so a draft's copy may predate a rename saved just before.
          // Only the name changes: edits made meanwhile stay.
          if (scheduleName.trim() !== '')
            drafts.setName(draft.key, scheduleName);
          const state = drafts.latest(draft.key);
          if (state === undefined) continue;
          const missing = missingInput(state);
          if (missing !== undefined) {
            const message = `Fill in ${missing} for this schedule.`;
            setRowError({ key: draft.key, message });
            setExpandedKey(draft.key);
            return { ok: false, message };
          }
          const saved = await drafts.save(draft.key);
          if (!saved.ok) {
            setExpandedKey(draft.key);
            return saved;
          }
        }
      }
      // Edits made during a create live on as its record, which isn't
      // listed yet: they aren't written.
      const carriedUnlisted = [...awaitingRef.current.values()].some(
        (entry) => entry.pending,
      );
      return carriedUnlisted || drafts.current().some((draft) => draft.dirty)
        ? {
            ok: false,
            message:
              "Your latest edits aren't saved yet. Save again to keep them.",
          }
        : { ok: true };
    },
    [drafts, missingInput, name],
  );

  const { discard: discardDrafts } = drafts;
  const discard = useCallback((): void => {
    discardDrafts();
    setNewRows([]);
    setRowError(null);
  }, [discardDrafts]);

  const addSchedule = useCallback((): void => {
    if (!info) return;
    nextKey.current += 1;
    const key = `new-schedule-${String(nextKey.current)}`;
    setNewRows((rows) => [
      ...rows,
      {
        key,
        initial: newScheduleState(
          info,
          records[0],
          workflowPage,
          name,
          defaults,
        ),
      },
    ]);
    setExpandedKey(key);
  }, [defaults, info, name, records, workflowPage]);

  // Another schedule of this workflow, from a row's stored action: never
  // the chat action it shows as, which would make a workflow of its own.
  const createActivity = useAutomationsStore((s) => s.createActivity);
  const duplicateSchedule = useCallback(
    async (activity: ScheduledActivity): Promise<void> => {
      const stored = storedAutomationActivity(activity);
      const response = await createActivity({
        // The saved record's name is the saved workflow's; an unsaved rename
        // that Discard could undo never reaches a record created now.
        name: activity.name,
        schedule: stored.schedule,
        action: stored.action,
        // Off, so it never fires on the original's time before it's reviewed.
        enabled: false,
        ...(stored.ifCommand !== undefined
          ? { ifCommand: stored.ifCommand }
          : {}),
        ...(stored.targetRequirement !== undefined &&
        stored.targetRequirementCleared !== true
          ? { targetRequirement: stored.targetRequirement }
          : {}),
      });
      if (!response.ok)
        setRowError({ key: activity.id, message: response.error });
    },
    [createActivity],
  );

  const removeSchedule = useCallback(
    async (draft: ScheduleDraft): Promise<void> => {
      if (draft.activity === null) {
        setNewRows((rows) => rows.filter((row) => row.key !== draft.key));
        return;
      }
      try {
        // Main decides whether this was the last schedule: two removals in
        // flight can't both think another one keeps the workflow.
        await drafts.remove(draft.key, { keepPipeline: true });
        // The kept values live on the pipeline, which the list re-reads.
        await pipelines.refresh();
      } catch (error: unknown) {
        // A refusal (`{ ok: false }`) is thrown with its message; anything
        // else is recorded.
        if (!(error instanceof Error)) reportClientAppError(error);
        setRowError({
          key: draft.key,
          message:
            error instanceof Error
              ? error.message
              : 'The schedule could not be removed.',
        });
      }
    },
    [drafts, pipelines],
  );

  // Where each schedule runs (CAN-6917): this computer or the cloud.
  const cloudRuns = usePipelineCloudRuns();
  const moveSchedule = useAutomationsStore((s) => s.moveSchedule);
  const [moves, setMoves] = useState<ReadonlyMap<string, ScheduleMove>>(
    () => new Map(),
  );
  const setMove = useCallback(
    (id: string, next: ScheduleMove | null): void =>
      setMoves((current) => {
        const updated = new Map(current);
        if (next === null) updated.delete(id);
        else updated.set(id, next);
        return updated;
      }),
    [],
  );
  /** Changes a move, keeping the place or models it asked about. */
  const updateMove = useCallback(
    (id: string, change: Pick<ScheduleMove, 'busy' | 'error'>): void =>
      setMoves((current) => {
        const updated = new Map(current);
        updated.set(id, { ...current.get(id), ...change });
        return updated;
      }),
    [],
  );
  const move = useCallback(
    async (
      id: string,
      request: Omit<AutomationScheduleMoveRequest, 'id'>,
    ): Promise<void> => {
      // The dialog or picker that asked stays open while it is answered.
      updateMove(id, { busy: true, error: null });
      const response = await moveSchedule({ id, ...request });
      if (response.ok) {
        setMove(id, null);
        return;
      }
      if ('needs' in response) {
        setMove(
          id,
          response.needs === 'destination'
            ? {
                busy: false,
                error: null,
                place: {
                  message: response.error,
                  candidates: response.candidates,
                  value: null,
                },
              }
            : {
                busy: false,
                // Asked again after choosing: main says why (the workflow
                // or its model rules changed).
                error: request.models === undefined ? null : response.error,
                models: response.preflight,
              },
        );
        return;
      }
      // Refused: the dialog or picker that asked shows why, choices kept.
      updateMove(id, { busy: false, error: response.error });
    },
    [moveSchedule, setMove, updateMove],
  );

  const renderBody = useCallback(
    (row: PipelineTriggerScheduleRow): ReactNode => {
      const draft = drafts.drafts.find((entry) => entry.key === row.key);
      if (!draft) return null;
      const { activity } = draft;
      const moving = activity === null ? undefined : moves.get(activity.id);
      const runOnValue =
        activity?.executionLocation === 'cloud' ? 'cloud' : 'local';
      const place = moving?.place;
      const models = moving?.models;
      const runOn = (
        <>
          <ScheduleRunOnField
            capabilities={cloudRuns}
            value={runOnValue}
            busy={moving?.busy === true}
            error={moving?.error ?? null}
            {...(activity !== null && isOrchestratorSchedule(activity)
              ? { cloudUnavailableReason: RUN_ON_ORCHESTRATOR }
              : {})}
            {...(activity === null || draft.dirty
              ? { blockedReason: RUN_ON_SAVE_FIRST }
              : {})}
            onChange={(next): void => {
              // A move would leave unsaved edits behind.
              if (activity !== null && !draft.dirty)
                void move(activity.id, { to: next });
            }}
            {...(activity !== null &&
            activity.executionLocation === 'cloud' &&
            // Held off for models, or never heard back about: moving again
            // finishes it.
            (activity.cloudSchedule?.enabling === true ||
              activity.cloudSchedule?.scheduleId === undefined) &&
            moving?.models === undefined
              ? {
                  onFinish: (): void => {
                    if (!draft.dirty) void move(activity.id, { to: 'cloud' });
                  },
                }
              : {})}
            {...(activity !== null && place !== undefined
              ? {
                  placePick: {
                    message: place.message,
                    options: place.candidates.map((candidate, index) => ({
                      value: String(index),
                      label: candidate.label,
                      // Cloud project and task names are user-authored.
                      maskInReplay: true,
                    })),
                    value: place.value,
                    onChange: (value: string): void =>
                      setMove(activity.id, {
                        ...moving,
                        busy: false,
                        error: null,
                        place: { ...place, value },
                      }),
                    onConfirm: (): void => {
                      const picked =
                        place.value === null
                          ? undefined
                          : place.candidates[Number(place.value)];
                      if (picked !== undefined && !draft.dirty)
                        void move(activity.id, {
                          to: 'cloud',
                          destination: picked.destination,
                        });
                    },
                    onCancel: (): void => setMove(activity.id, null),
                  },
                }
              : {})}
          />
          {activity !== null && models !== undefined ? (
            <CloudModelReplacementDialog
              key={models.definitionHash + models.policyFingerprint}
              preflight={models}
              busy={moving?.busy === true}
              error={moving?.error ?? null}
              onCancel={(): void => setMove(activity.id, null)}
              onConfirm={(choices): void => {
                // Bound to the preflight the person chose for: main asks
                // again if the workflow or model rules changed since.
                void move(activity.id, {
                  to: 'cloud',
                  models: {
                    definitionHash: models.definitionHash,
                    policyFingerprint: models.policyFingerprint,
                    choices,
                  },
                });
              }}
            />
          ) : null}
        </>
      );
      // Saved, and its record not listed yet: nothing to edit here.
      if (awaitingKeys.has(draft.key))
        return <p className="text-xs fg-tertiary">{SAVING_SCHEDULE}</p>;
      return (
        <ScheduleBody
          draft={draft}
          runOn={runOn}
          inCloud={runOnValue === 'cloud'}
          moving={moving?.busy === true}
          projects={projects}
          scope={automations.scope}
          declaredInputs={declared}
          requiredInputs={required}
          error={
            rowError?.key === draft.key
              ? rowError.message
              : (draft.error?.message ?? null)
          }
          running={
            draft.activity !== null &&
            automations.runningActivityId === draft.activity.id
          }
          onChange={(next): void =>
            drafts.change(draft.key, next, { origin: 'user' })
          }
          onMount={(next): void =>
            drafts.change(draft.key, next, { origin: 'mount' })
          }
          onRunNow={(): void => {
            if (!draft.activity) return;
            void automations.runNow(draft.activity).then((response) => {
              if (!response.ok)
                setRowError({ key: draft.key, message: response.error });
            });
          }}
          onDuplicate={(): void => {
            if (draft.activity) void duplicateSchedule(draft.activity);
          }}
          onRemove={(): void => {
            // An installed workflow can't stay without its last schedule,
            // whose record holds the install: Remove deletes the workflow,
            // after the page's own confirmation.
            if (
              onDeleteWorkflow !== undefined &&
              draft.activity?.installedFrom?.capabilityPackage !== undefined &&
              records.length === 1
            ) {
              onDeleteWorkflow();
              return;
            }
            void removeSchedule(draft);
          }}
        />
      );
    },
    [
      automations,
      awaitingKeys,
      cloudRuns,
      declared,
      drafts,
      duplicateSchedule,
      move,
      moves,
      onDeleteWorkflow,
      projects,
      records.length,
      removeSchedule,
      required,
      rowError,
      setMove,
    ],
  );

  // The page's Duplicate copies the saved workflow, never the draft.
  const unsaved = pipelineDirty || drafts.dirty || newRows.length > 0;
  const rows = useMemo(
    (): PipelineTriggerScheduleRow[] =>
      drafts.drafts.map((draft) => {
        const { activity } = draft;
        const agentOrigin = activity?.workflowSchedule?.agentOrigin === true;
        const installed =
          activity?.installedFrom?.capabilityPackage !== undefined;
        return {
          key: draft.key,
          summary:
            activity === null
              ? NEW_SCHEDULE
              : automationTrigger(activity, undefined).text,
          enabled: draft.state.enabled,
          ...(activity?.executionLocation === 'cloud'
            ? { location: RUNS_IN_CLOUD }
            : {}),
          busy:
            draft.saving ||
            draft.deleting ||
            awaitingKeys.has(draft.key) ||
            (activity !== null && moves.get(activity.id)?.busy === true),
          dirty: draft.dirty || activity === null,
          ...(rowError?.key === draft.key
            ? { error: rowError.message }
            : draft.error
              ? { error: draft.error.message }
              : {}),
          ...(agentOrigin
            ? {
                notice: (
                  <Notice
                    intent="neutral"
                    data-testid="workflow-schedule-agent-origin"
                    {...(!installed && onDuplicateWorkflow && !unsaved
                      ? {
                          actions: (
                            <NoticeButton onClick={onDuplicateWorkflow}>
                              Duplicate
                            </NoticeButton>
                          ),
                        }
                      : {})}
                  >
                    {installed
                      ? AGENT_ORIGIN_NOTICE
                      : unsaved
                        ? `${AGENT_ORIGIN_NOTICE} ${AGENT_ORIGIN_SAVE_FIRST}`
                        : `${AGENT_ORIGIN_NOTICE} ${AGENT_ORIGIN_DUPLICATE}`}
                  </Notice>
                ),
              }
            : {}),
        };
      }),
    [
      awaitingKeys,
      drafts.drafts,
      moves,
      onDuplicateWorkflow,
      rowError,
      unsaved,
    ],
  );

  const { toggle } = drafts;
  const triggers: PipelineTriggerSchedules | undefined = isWorkflowPage
    ? {
        rows,
        expandedKey,
        onExpand: setExpandedKey,
        onToggle: (row, next): void => toggle(row.key, next),
        renderBody,
        onAdd: addSchedule,
      }
    : undefined;

  const firstScheduleInputs = useMemo(() => {
    const first = records[0];
    if (first === undefined) return workflowPage?.lastScheduleValues?.inputs;
    const { action } = storedAutomationActivity(first);
    return action.type === 'worktree_pipeline' ? action.inputs : undefined;
  }, [records, workflowPage]);

  // CAN-7186: what Save stores, kept by content so a re-render that copies
  // the drafts unchanged reads nothing again.
  const draftStates = drafts.drafts.map((draft) => draft.state);
  const editedKey = JSON.stringify([
    draftStates[0]?.pipelineInputs ?? null,
    draftStates.map((state) => [
      state.name,
      Object.keys(state.pluginCollectionPreferences ?? {}),
    ]),
  ]);
  const [edited, setEdited] = useState({ key: editedKey, states: draftStates });
  if (edited.key !== editedKey)
    setEdited({ key: editedKey, states: draftStates });
  // A schedule's run takes the workflow's declared defaults under the
  // values it stores, so a draft that clears them reads the defaults.
  const declaredDefaults = useMemo(
    () =>
      initializeInputValues(
        resolvePipelineTriggerInputs(pipeline, 'dispatch').inputDefs,
      ),
    [pipeline],
  );
  const editedFirstScheduleInputs = useMemo(() => {
    const first = edited.states[0];
    return {
      ...declaredDefaults,
      ...(first === undefined
        ? firstScheduleInputs
        : Object.fromEntries(
            first.pipelineInputs
              .filter((row) => row.key.trim().length > 0)
              .map((row) => [row.key.trim(), row.value]),
          )),
    };
  }, [edited, firstScheduleInputs, declaredDefaults]);
  const editedCollectionOverrides = useMemo(() => {
    const byCollection = new Map<string, string[]>();
    for (const state of edited.states)
      for (const id of Object.keys(state.pluginCollectionPreferences ?? {}))
        byCollection.set(id, [...(byCollection.get(id) ?? []), state.name]);
    return byCollection;
  }, [edited]);

  return {
    isWorkflowPage,
    records,
    dirty: drafts.dirty || newRows.length > 0,
    saving: drafts.saving,
    agentGranted,
    saveAll,
    discard,
    triggers,
    firstScheduleInputs,
    editedFirstScheduleInputs,
    editedCollectionOverrides,
  };
}

interface ScheduleBodyProps {
  readonly draft: ScheduleDraft;
  /** Where it runs: the Run on field (CAN-6917). */
  readonly runOn: ReactNode;
  /**
   * A move is in flight: the record shows off until it answers, so its
   * fields are held rather than edited from that passing state.
   */
  readonly moving: boolean;
  /** It runs in the cloud: Run now starts it here, so it isn't offered. */
  readonly inCloud: boolean;
  readonly projects: ReturnType<typeof useProjectsStore.getState>['projects'];
  readonly scope: AutomationsPageBodyApi['scope'];
  readonly declaredInputs: readonly string[];
  readonly requiredInputs: ReadonlySet<string>;
  readonly error: string | null;
  readonly running: boolean;
  readonly onChange: (next: FormState) => void;
  readonly onMount: (next: FormState) => void;
  readonly onRunNow: () => void;
  /** Another schedule of this workflow, off until it's reviewed. */
  readonly onDuplicate: () => void;
  readonly onRemove: () => void;
}

/** One schedule's editor: when it runs, then what it runs with. */
function ScheduleBody({
  draft,
  runOn,
  inCloud,
  moving,
  projects,
  scope,
  declaredInputs,
  requiredInputs,
  error,
  running,
  onChange,
  onMount,
  onRunNow,
  onDuplicate,
  onRemove,
}: ScheduleBodyProps): JSX.Element {
  const { state, activity } = draft;
  const values = new Map(
    state.pipelineInputs.map((entry) => [entry.key, entry.value]),
  );
  // The declared inputs first, then any others this schedule already sets.
  const keys = [
    ...declaredInputs,
    ...state.pipelineInputs
      .map((entry) => entry.key)
      .filter((key) => !declaredInputs.includes(key)),
  ];
  const setInput = (key: string, value: string): void => {
    const others = state.pipelineInputs.filter((entry) => entry.key !== key);
    // A blank field is unset, so a run falls back to the declared default.
    onChange({
      ...state,
      pipelineInputs: value === '' ? others : [...others, { key, value }],
    });
  };
  return (
    <div className="flex flex-col gap-4" data-testid="workflow-schedule-body">
      <ActivityFormBody
        state={state}
        saving={draft.saving || moving}
        projects={projects}
        scope={scope}
        error={error}
        fieldGroup="trigger"
        showEnabledField={false}
        onChange={(next, meta): void =>
          meta.origin === 'mount' ? onMount(next) : onChange(next)
        }
      />
      {runOn}
      {keys.length > 0 ? (
        <div
          className="flex flex-col gap-3"
          data-testid="workflow-schedule-inputs"
        >
          <p className="text-xs font-medium fg-secondary">Runs with</p>
          {keys.map((key) => (
            <FormField
              key={key}
              label={requiredInputs.has(key) ? `${key} (required)` : key}
            >
              {(control) => (
                <TextInput
                  {...control}
                  value={values.get(key) ?? ''}
                  disabled={moving}
                  onChange={(event): void => setInput(key, event.target.value)}
                  data-testid={`workflow-schedule-input-${key}`}
                />
              )}
            </FormField>
          ))}
        </div>
      ) : null}
      {activity?.executionContext ? (
        <p
          className="text-xs fg-tertiary"
          data-testid="workflow-schedule-owner"
        >
          Runs as{' '}
          {scope.ownerLabel
            ? scope.ownerLabel(activity.executionContext)
            : activity.executionContext}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {activity !== null ? (
          <>
            {inCloud ? null : (
              <Button
                variant="secondary"
                size="compact"
                disabled={running}
                onClick={onRunNow}
                data-testid="workflow-schedule-run-now"
              >
                Run now
              </Button>
            )}
            <Button
              variant="secondary"
              size="compact"
              onClick={onDuplicate}
              data-testid="workflow-schedule-duplicate"
            >
              Duplicate
            </Button>
          </>
        ) : null}
        <Button
          variant="ghost"
          size="compact"
          // A new row's create can't be called back once sent.
          disabled={draft.deleting || draft.saving}
          onClick={onRemove}
          data-testid="workflow-schedule-remove"
        >
          Remove
        </Button>
      </div>
    </div>
  );
}
