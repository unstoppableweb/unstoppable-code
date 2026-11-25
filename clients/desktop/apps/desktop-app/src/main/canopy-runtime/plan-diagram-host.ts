import type { BrowserWindow } from 'electron';
import {
  IPC_CHANNELS,
  getExecutionHarnessForModel,
  resolveProviderModelConfig,
  type AgentModelConfig,
  type ChatModel,
  type ThinkingLevel,
  type TrackedPlanData,
  type TrackedPlansUpdatedEvent,
} from '@canopy/desktop-shared/types';
import {
  createPlanDiagramScheduler,
  type PlanDiagramGeneration,
  type PlanDiagramKey,
  type PlanDiagramScheduleStatus,
} from '@canopy/core-runtime/node/plans';
import {
  addPlanContentChangeListener,
  getTrackedPlan,
  removePlanContentChangeListener,
  removePlanDiagramArtifact,
  setPlanDiagramArtifact,
} from '../lib/plan-persistence';
import { resolveWorktreeCwd } from '../lib/resolve-worktree';
import { readPreferencesFile } from '../lib/preferences-store';
import { sendToWindow } from '../lib/window-send';
import {
  finalizeObservedHelperTask,
  startObservedHelperTask,
  type ObservedHelperUsage,
} from '../lib/helper-observed-task';
import {
  generateDataModelDiffDiagram,
  generateLogicDiffDiagram,
  generateSequenceDiagram,
} from '../lib/plan-diagram-generator';
import { createHelperTranscriptObserver } from '../lib/helper-transcript-observer';
import { getMainWindow } from '../lib/main-window-focus';

/*
 * The desktop host of the core plan diagram scheduler (CAN-4167 PR 3b): the
 * diagram model from preferences, the worktree the generators run in, the
 * worker helper runs, their observed-task bookkeeping, and the
 * `tracked-plans:updated` push to the window that scheduled the run.
 */

type WindowTarget = () => BrowserWindow | null;

interface DiagramRunSettings {
  model: ChatModel;
  modelConfig: AgentModelConfig;
  thinkingLevel: ThinkingLevel;
  repoPath: string;
}

type DiagramRun = PlanDiagramGeneration<TrackedPlanData, DiagramRunSettings>;

const TASK_LABELS: Record<PlanDiagramKey, string> = {
  sequence: 'Plan Sequence Diagram',
  logicDiff: 'Plan Logic Diagram',
  dataModelDiff: 'Plan Data Model Diagram',
};

/** The diagram model's settings, or why no harness serves it. */
async function readDiagramSettings(): Promise<
  | {
      model: ChatModel;
      modelConfig: AgentModelConfig;
      thinkingLevel: ThinkingLevel;
    }
  | { unavailable: string }
> {
  const preferences = await readPreferencesFile();
  const model = preferences.planDiagramModel;
  const thinkingLevel = preferences.planDiagramThinkingLevel;
  const executionHarness = getExecutionHarnessForModel(model);
  if (!executionHarness) {
    return {
      unavailable: `No execution harness is available for diagram model "${model}".`,
    };
  }
  const modelConfig = resolveProviderModelConfig(
    executionHarness,
    { thinkingLevel },
    preferences.providerModelConfigDefaults,
  );
  return { model, modelConfig, thinkingLevel };
}

function generatorOptions(run: DiagramRun): {
  userInitiated: boolean;
  planText: string;
  repoPath: string;
  projectId: string;
  model: ChatModel;
  modelConfig: AgentModelConfig;
  thinkingLevel: ThinkingLevel;
  transcriptObserver: ReturnType<typeof createHelperTranscriptObserver>;
} {
  return {
    userInitiated: run.attended,
    planText: run.plan.content,
    repoPath: run.settings.repoPath,
    projectId: run.ref.projectId,
    model: run.settings.model,
    modelConfig: run.settings.modelConfig,
    thinkingLevel: run.settings.thinkingLevel,
    transcriptObserver: createHelperTranscriptObserver(run.taskKey),
  };
}

function emitPlanUpdated(plan: TrackedPlanData, getWindow: WindowTarget): void {
  const event: TrackedPlansUpdatedEvent = {
    projectId: plan.projectId,
    worktreeId: plan.worktreeId,
    plan,
  };
  sendToWindow(getWindow(), IPC_CHANNELS.trackedPlansUpdated, event);
}

const scheduler = createPlanDiagramScheduler<
  TrackedPlanData,
  WindowTarget,
  DiagramRunSettings,
  ObservedHelperUsage
>({
  getPlan: (ref) => getTrackedPlan(ref.projectId, ref.worktreeId, ref.planId),
  async prepare(ref) {
    const settings = await readDiagramSettings();
    if ('unavailable' in settings) throw new Error(settings.unavailable);
    return {
      ...settings,
      repoPath: resolveWorktreeCwd(ref.projectId, ref.worktreeId),
    };
  },
  generateSequence: (run) => generateSequenceDiagram(generatorOptions(run)),
  generateLogicDiff: (run) => generateLogicDiffDiagram(generatorOptions(run)),
  generateDataModelDiff: (run) =>
    generateDataModelDiffDiagram(generatorOptions(run)),
  startTask(kind, run) {
    startObservedHelperTask({
      taskKey: run.taskKey,
      eventType: 'worktree_plan_diagram',
      label: TASK_LABELS[kind],
      model: run.settings.model,
      modelConfig: run.settings.modelConfig,
      auditContext: {
        projectId: run.ref.projectId,
        worktreeId: run.ref.worktreeId,
        planId: run.ref.planId,
      },
    });
  },
  finishTask: (taskKey, outcome, message, usage) =>
    finalizeObservedHelperTask(taskKey, outcome, message, usage),
  writeArtifact: (ref, kind, artifact) =>
    setPlanDiagramArtifact(
      ref.projectId,
      ref.worktreeId,
      ref.planId,
      kind,
      artifact,
    ),
  removeDataModelArtifact: (ref, expectedRevision) =>
    removePlanDiagramArtifact(
      ref.projectId,
      ref.worktreeId,
      ref.planId,
      expectedRevision,
    ),
  planUpdated: emitPlanUpdated,
});

/**
 * Schedules a plan's diagrams after a content change, pushing each change to
 * `getWindow`. Always debounced and never a person's request, so it never
 * falls back to AI Credits for lack of a native login: only
 * `requestPlanDiagramGeneration` can be attended.
 */
export function schedulePlanDiagramGeneration(
  plan: TrackedPlanData,
  getWindow: WindowTarget,
): void {
  scheduler.schedule(plan, getWindow);
}

/**
 * Schedules the debounced background run after every plan content change,
 * whichever writer made it: the core.plan operations, an external edit of the
 * plan file, or a writer still beside the dispatcher. Returns the unsubscribe.
 */
export function followPlanContentChanges(getWindow: WindowTarget): () => void {
  const listener = (plan: TrackedPlanData): void =>
    schedulePlanDiagramGeneration(plan, getWindow);
  addPlanContentChangeListener(listener);
  return () => removePlanContentChangeListener(listener);
}

/**
 * `core.plan.diagram.generate`: runs at once and pushes to the main window,
 * as the channel did. `attended` comes from the caller's principal.
 */
export function requestPlanDiagramGeneration(
  plan: TrackedPlanData,
  attended: boolean,
): Exclude<PlanDiagramScheduleStatus, 'debounced'> {
  const status = scheduler.schedule(plan, getMainWindow, {
    immediate: true,
    attended,
  });
  return status === 'queued' ? 'queued' : 'started';
}

/** The diagram model's harness is available, or why not. */
export async function planDiagramModelUnavailable(): Promise<string | null> {
  const settings = await readDiagramSettings();
  return 'unavailable' in settings ? settings.unavailable : null;
}
