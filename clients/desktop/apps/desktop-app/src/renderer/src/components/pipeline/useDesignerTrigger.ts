import { useCallback, useEffect, useMemo, useState } from 'react';
import { BRAND } from '@canopy/brand/current';
import {
  projectWorkflowTrigger,
  runContextRoots,
  setManualEntries,
  type WorkflowManualEntry,
} from '@canopy/pipeline-interop/workflow-designer-trigger';
import {
  WORKFLOW_DESIGNER_ENTRY_LABELS,
  workflowTriggerRefusalMessage,
  type WorkflowDesignerTriggerCard,
  type WorkflowTriggerPanelProps,
} from '@canopy/ui-app/workflows';
import type { PipelineInfo } from '@canopy/execution-engine/types/pipeline';
import type { UsePipelineEditorReturn } from '../../hooks/usePipelineEditor';
import type { DesignerTriggerHost } from './PipelineEditorBody';

/** The names the executor reads `event_name` under, for this brand. */
const ROOTS = runContextRoots(BRAND.internalName);

export interface DesignerTrigger {
  /** Whether the trigger's panel is open in place of a card's. */
  readonly open: boolean;
  readonly close: () => void;
  readonly card: WorkflowDesignerTriggerCard | undefined;
  readonly panel: WorkflowTriggerPanelProps | undefined;
}

type ScheduleKind = 'schedule' | 'once';

/**
 * The Designer's trigger card and its panel (CAN-4224 phase 04). Entry
 * changes write only `on:`, as one undoable edit. A schedule is added where
 * the host adds them; one chosen before the person saves opens after their
 * own save, never by saving for them.
 */
export function useDesignerTrigger(
  editor: UsePipelineEditorReturn,
  host: DesignerTriggerHost | undefined,
  onOpen: () => void,
): DesignerTrigger {
  const { pipeline, readonly, replaceEntirePipeline, isDirty, pipelineInfo } =
    editor;
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A schedule chosen with unsaved edits, and the saved info it was chosen
  // against: only a save, which brings new info, opens it. An undo back to
  // the saved draft brings none.
  const [pending, setPending] = useState<{
    readonly kind: ScheduleKind;
    readonly before: PipelineInfo | null;
  } | null>(null);
  const trigger = useMemo(
    () => (pipeline ? projectWorkflowTrigger(pipeline, ROOTS) : null),
    [pipeline],
  );
  const schedules = host?.schedules ?? [];
  const runsByHand = trigger?.entries.includes('run') ?? false;
  const saved = pipelineInfo !== null && !isDirty;

  // A schedule chosen before saving opens once the person has saved. The
  // host opens it from its save, which outlives a draft's first save; here
  // the notice goes once a save brings new info.
  const onAddSchedule = host?.onAddSchedule;
  const queueAfterSave = host?.onQueueScheduleAfterSave;
  // The notice and the host's queue go together: a save the host doesn't
  // see, such as the assistant's, must not leave a request nothing shows.
  useEffect(() => {
    if (pending === null || !saved || pipelineInfo === pending.before) return;
    queueAfterSave?.(null);
    setPending(null);
  }, [pending, pipelineInfo, queueAfterSave, saved]);

  // Selecting a card, from the stack, a "+" or another view, closes the
  // trigger's panel, so closing that card's panel never brings it back.
  const selectionType = editor.selection.type;
  useEffect(() => {
    if (selectionType !== 'none') setOpen(false);
  }, [selectionType]);

  const toggleEntry = useCallback(
    (entry: WorkflowManualEntry, next: boolean): void => {
      if (!pipeline || !trigger) return;
      const entries = next
        ? [...trigger.entries, entry]
        : trigger.entries.filter((other) => other !== entry);
      const result = setManualEntries(pipeline, entries, {
        // A schedule waiting for a save counts: it will start a run.
        scheduled: schedules.length > 0 || pending !== null,
        hooked: host?.startedByHooks === true,
        // Without a host there is nothing that starts it to wait for.
        startersKnown: host?.startersKnown ?? true,
        expressionRoots: ROOTS,
      });
      if (!result.ok) {
        setError(workflowTriggerRefusalMessage(result.refusal));
        return;
      }
      setError(null);
      if (result.pipeline !== pipeline) replaceEntirePipeline(result.pipeline);
    },
    [
      host?.startedByHooks,
      host?.startersKnown,
      pending,
      pipeline,
      replaceEntirePipeline,
      schedules.length,
      trigger,
    ],
  );

  const addSchedule = useCallback(
    (kind: ScheduleKind): void => {
      if (!onAddSchedule) return;
      // Leaving for the automation editor would strand unsaved edits, so it
      // waits for the person's own save. A page's schedules save with it.
      if (host?.addsInPlace === true || saved) {
        onAddSchedule(kind);
        return;
      }
      if (!queueAfterSave) return;
      queueAfterSave(kind);
      setPending({ kind, before: pipelineInfo });
    },
    [host?.addsInPlace, onAddSchedule, pipelineInfo, queueAfterSave, saved],
  );

  const select = useCallback((): void => {
    onOpen();
    setOpen(true);
  }, [onOpen]);
  const close = useCallback((): void => {
    setOpen(false);
    setError(null);
  }, []);

  if (!trigger)
    return { open: false, close, card: undefined, panel: undefined };

  const entryTitle = [
    ...trigger.entries.map((entry) => WORKFLOW_DESIGNER_ENTRY_LABELS[entry]),
    ...(trigger.fromWorkflow ? ['Another workflow'] : []),
  ].join(' · ');
  const title =
    pending !== null
      ? pending.kind === 'once'
        ? 'Once, after you save'
        : 'On a schedule, after you save'
      : pipelineInfo === null
        ? 'Choose a trigger'
        : entryTitle;
  const card: WorkflowDesignerTriggerCard = {
    title,
    ...(schedules.length > 0
      ? {
          detail:
            schedules.length === 1
              ? '1 schedule'
              : `${String(schedules.length)} schedules`,
        }
      : {}),
    selected: open,
    onSelect: select,
    onDismiss: close,
    stepEntries: trigger.stepEntries,
  };
  const blockedReason = !runsByHand
    ? 'Turn on Run first: schedules start the workflow as a run.'
    : host?.addBlockedReason;
  const panel: WorkflowTriggerPanelProps = {
    entries: trigger.entries,
    ...(readonly ? {} : { onToggleEntry: toggleEntry }),
    ...(error !== null ? { entryError: error } : {}),
    fromWorkflow: trigger.fromWorkflow,
    schedules,
    ...(host ? { onEditSchedule: host.onEditSchedule } : {}),
    ...(!readonly && onAddSchedule ? { onAddSchedule: addSchedule } : {}),
    ...(blockedReason !== undefined
      ? { addScheduleBlockedReason: blockedReason }
      : {}),
    ...(pending !== null
      ? {
          scheduleNotice: 'Your schedule opens after you save the workflow.',
          onCancelPendingSchedule: () => {
            queueAfterSave?.(null);
            setPending(null);
          },
        }
      : {}),
  };
  return { open, close, card, panel };
}
