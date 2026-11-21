import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import * as yaml from 'js-yaml';
import type {
  Pipeline,
  PipelineData,
  PipelineDefaults,
  PipelineInfo,
  PipelineScalar,
  Step,
  Job,
} from '@canopy/execution-engine/types/pipeline';
import {
  createDefaultPipeline,
  createDefaultStep,
} from '@canopy/execution-engine/types/pipeline';
import {
  createJobId,
  createStepId,
  getDraftValidation,
  getSafeJobOrder,
  renameJobId as renameJobIdHelper,
  type ValidationIssue,
  type SafeJobOrderResult,
  type PipelineEditorSelection,
} from '../lib/pipelineEditor';
import {
  loadPipelineDocument,
  sharedDetailToPipelineData,
} from '../lib/pipelineDocument';
import { retitleChatAutomationEntry } from '@canopy/desktop-shared/lib/chat-automation-conversion';

export type ActivePanel = 'steps' | 'settings';
export type MainView = 'list' | 'flowchart' | 'raw';

export type Selection = PipelineEditorSelection;

const MAX_HISTORY = 50;

export interface UsePipelineEditorReturn {
  pipeline: Pipeline | null;
  pipelineInfo: PipelineInfo | null;
  loading: boolean;
  error: string | null;
  readonly: boolean;

  jobOrder: string[];
  validation: ValidationIssue[];
  canSave: boolean;

  selection: Selection;
  setSelection: (sel: Selection) => void;

  activePanel: ActivePanel;
  setActivePanel: (p: ActivePanel) => void;
  mainView: MainView;
  setMainView: (v: MainView) => void;

  updatePipelineField: (field: keyof Pipeline, value: unknown) => void;
  updateDefaults: (defaults: PipelineDefaults) => void;
  updateEnv: (env: Record<string, PipelineScalar>) => void;

  addJob: () => void;
  removeJob: (jobId: string) => void;
  updateJob: (jobId: string, patch: Partial<Job>) => void;
  renameJob: (oldJobId: string, newJobId: string) => void;

  addStep: (jobId: string) => void;
  removeStep: (jobId: string, stepIndex: number) => void;
  updateStep: (jobId: string, stepIndex: number, step: Step) => void;
  reorderSteps: (jobId: string, fromIndex: number, toIndex: number) => void;
  moveStepBetweenJobs: (
    fromJobId: string,
    fromIndex: number,
    toJobId: string,
    toIndex: number,
  ) => void;

  replaceEntirePipeline: (newPipeline: Pipeline) => void;

  canUndo: boolean;
  canRedo: boolean;
  undo: () => void;
  redo: () => void;

  isDirty: boolean;
  saving: boolean;
  save: (pipelineOverride?: Pipeline) => Promise<PipelineInfo | null>;
  /**
   * Shows a pipeline core saved for this editor elsewhere (an agent's save,
   * CAN-5822) as its saved state. The current draft is kept, so edits made
   * since `savedPipeline` stay unsaved, unless `shown` replaces it; either
   * way the Undo history starts again from what is shown.
   */
  adoptSaved: (
    savedPipeline: Pipeline,
    info: PipelineInfo,
    shown?: Pipeline,
  ) => void;
  /**
   * The pipeline the editor last loaded or saved, as stored: a save may
   * store more than it was handed (an Orchestrator entry's new title,
   * CAN-5782), and a Raw YAML save's draft hasn't rendered yet.
   */
  getSavedPipeline: () => Pipeline | null;
  /**
   * Raw text that a rename save couldn't retitle (CAN-5782): the next save
   * also moves an entry title generated from any of `previousNames`.
   */
  deferRetitleFrom: (previousNames: readonly string[]) => void;
  /** The names a save's Orchestrator entry title follows the rename from. */
  retitleFromNames: () => readonly string[];
  /**
   * Holds the save guard while core saves this editor's draft for an agent
   * (CAN-5822), so no other save overlaps it. Returns its release, or null
   * when a save is already running.
   */
  holdSave: () => (() => void) | null;
}

export interface PipelineEditorRequest {
  pipelineId: string | null;
  cwd?: string;
  pipelineFilePath?: string;
  /**
   * Stored-catalog namespace of the pipeline. Bundled and user pipelines can
   * share an id, and the bare-id lookup resolves user-before-bundled; callers
   * that know the source (related-item navigation, CAN-2382) pass it so the
   * exact pipeline loads.
   */
  pipelineSource?: 'bundled' | 'user' | 'curated';
  /**
   * Set when opening a shared pipeline. The editor uses this remote id to
   * fetch via `getShared` / save via `updateShared` instead of the local
   * `pipelines.get` / `pipelines.save` round-trip.
   */
  sharedRemoteId?: string;
}

export function usePipelineEditor({
  pipelineId,
  cwd,
  pipelineFilePath,
  pipelineSource,
  sharedRemoteId,
}: PipelineEditorRequest): UsePipelineEditorReturn {
  const [pipeline, setPipeline] = useState<Pipeline | null>(null);
  const [pipelineInfo, setPipelineInfo] = useState<PipelineInfo | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<boolean>(false);
  // Set synchronously so a save started before the next render is refused.
  const savingRef = useRef(false);
  const [selection, setSelection] = useState<Selection>({ type: 'none' });
  const [activePanel, setActivePanel] = useState<ActivePanel>('steps');
  const [mainView, setMainView] = useState<MainView>('flowchart');

  // History for undo/redo
  const pastRef = useRef<Pipeline[]>([]);
  const futureRef = useRef<Pipeline[]>([]);

  // Baseline for dirty tracking (last saved state)
  const baselineRef = useRef<string>('');
  const savedPipelineRef = useRef<Pipeline | null>(null);
  const deferredRetitleRef = useRef<readonly string[]>([]);
  // Bumped when a save moves the baseline. A save keeps the same pipeline
  // object, so without it `isDirty` would not recompute.
  const [baselineRevision, setBaselineRevision] = useState(0);

  // Track the persisted ID for newly created pipelines
  const persistedIdRef = useRef<string | undefined>(pipelineId ?? undefined);

  const isReadonly: boolean = pipelineInfo?.readonly ?? false;

  // Load pipeline on mount
  useEffect(() => {
    let cancelled = false;

    async function load(): Promise<void> {
      setLoading(true);
      setError(null);

      if (!sharedRemoteId && pipelineId === null) {
        const defaultPipeline: Pipeline = createDefaultPipeline();
        if (!cancelled) {
          setPipeline(defaultPipeline);
          setPipelineInfo(null);
          baselineRef.current = JSON.stringify(defaultPipeline);
          savedPipelineRef.current = null;
          persistedIdRef.current = undefined;
          pastRef.current = [];
          futureRef.current = [];
          setLoading(false);
        }
        return;
      }

      try {
        // Source dispatch lives in `lib/pipelineDocument` so the editor and the
        // Pipelines-page row Share flow load definitions identically.
        const loaded = await loadPipelineDocument({
          pipelineId,
          cwd,
          pipelineFilePath,
          pipelineSource,
          sharedRemoteId,
        });
        if (cancelled) return;

        if (loaded.error !== undefined || !loaded.data) {
          setError(loaded.error ?? 'Failed to load workflow');
          setLoading(false);
          return;
        }
        const pipelineData: PipelineData = loaded.data;

        const content: Pipeline = { ...pipelineData.content };
        // Normalize: editable pipelines should not carry readonly in their content
        if (!pipelineData.info.readonly) {
          delete content.readonly;
        }

        setPipeline(content);
        setPipelineInfo(pipelineData.info);
        baselineRef.current = JSON.stringify(content);
        savedPipelineRef.current = content;
        persistedIdRef.current = pipelineData.info.id;
        pastRef.current = [];
        futureRef.current = [];
        setLoading(false);
      } catch (err: unknown) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      }
    }

    void load();
    return (): void => {
      cancelled = true;
    };
  }, [cwd, pipelineFilePath, pipelineId, pipelineSource, sharedRemoteId]);

  // Derived: validation
  const validation: ValidationIssue[] = useMemo(
    (): ValidationIssue[] => (pipeline ? getDraftValidation(pipeline) : []),
    [pipeline],
  );

  // Derived: job order
  const safeOrder: SafeJobOrderResult = useMemo(
    (): SafeJobOrderResult =>
      pipeline ? getSafeJobOrder(pipeline) : { order: [] },
    [pipeline],
  );
  const jobOrder: string[] = safeOrder.order;

  // Derived: dirty state
  const isDirty: boolean = useMemo((): boolean => {
    if (!pipeline) return false;
    return JSON.stringify(pipeline) !== baselineRef.current;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- baselineRevision re-reads the ref
  }, [pipeline, baselineRevision]);

  // Derived: can save
  const hasErrors: boolean = validation.some(
    (v: ValidationIssue): boolean => v.type === 'error',
  );
  const canSave: boolean = !isReadonly && !hasErrors && isDirty && !saving;

  // Push to history before making a change
  const pushHistory = useCallback((current: Pipeline): void => {
    pastRef.current = [...pastRef.current.slice(-(MAX_HISTORY - 1)), current];
    futureRef.current = [];
  }, []);

  // Apply a mutation to the pipeline
  const applyMutation = useCallback(
    (mutator: (p: Pipeline) => Pipeline): void => {
      setPipeline((prev: Pipeline | null): Pipeline | null => {
        if (!prev) return prev;
        pushHistory(prev);
        return mutator(prev);
      });
    },
    [pushHistory],
  );

  // Pipeline field updates
  const updatePipelineField = useCallback(
    (field: keyof Pipeline, value: unknown): void => {
      applyMutation(
        (p: Pipeline): Pipeline => ({
          ...p,
          [field]: value,
        }),
      );
    },
    [applyMutation],
  );

  const updateDefaults = useCallback(
    (defaults: PipelineDefaults): void => {
      applyMutation((p: Pipeline): Pipeline => {
        // Collapse empty run defaults
        const run = defaults.run;
        const hasRun: boolean = Boolean(run?.shell ?? run?.working_directory);
        const cleanDefaults: PipelineDefaults | undefined = hasRun
          ? { run }
          : undefined;
        return { ...p, defaults: cleanDefaults };
      });
    },
    [applyMutation],
  );

  const updateEnv = useCallback(
    (env: Record<string, PipelineScalar>): void => {
      applyMutation(
        (p: Pipeline): Pipeline => ({
          ...p,
          env: Object.keys(env).length > 0 ? env : undefined,
        }),
      );
    },
    [applyMutation],
  );

  // Job CRUD
  const addJob = useCallback((): void => {
    applyMutation((p: Pipeline): Pipeline => {
      const newId: string = createJobId(Object.keys(p.jobs));
      const newJob: Job = { name: newId, steps: [] };
      return { ...p, jobs: { ...p.jobs, [newId]: newJob } };
    });
  }, [applyMutation]);

  const removeJob = useCallback(
    (jobId: string): void => {
      applyMutation((p: Pipeline): Pipeline => {
        const jobs: Record<string, Job> = { ...p.jobs };
        delete jobs[jobId];
        // Clean up needs references to the removed job
        for (const key of Object.keys(jobs)) {
          const job = jobs[key];
          if (typeof job.needs === 'string' && job.needs === jobId) {
            jobs[key] = { ...job, needs: undefined };
          } else if (Array.isArray(job.needs)) {
            const filtered: string[] = job.needs.filter(
              (d: string): boolean => d !== jobId,
            );
            jobs[key] = {
              ...job,
              needs: filtered.length > 0 ? filtered : undefined,
            };
          }
        }
        return { ...p, jobs };
      });
      // Clear selection if we removed the selected job
      setSelection((prev: Selection): Selection => {
        if (prev.type === 'none') return prev;
        if (prev.jobId === jobId) return { type: 'none' };
        return prev;
      });
    },
    [applyMutation],
  );

  const updateJob = useCallback(
    (jobId: string, patch: Partial<Job>): void => {
      applyMutation((p: Pipeline): Pipeline => {
        const job = p.jobs[jobId];
        if (!job) return p;
        return {
          ...p,
          jobs: { ...p.jobs, [jobId]: { ...job, ...patch } },
        };
      });
    },
    [applyMutation],
  );

  const renameJob = useCallback(
    (oldJobId: string, newJobId: string): void => {
      if (oldJobId === newJobId) return;
      applyMutation(
        (p: Pipeline): Pipeline => renameJobIdHelper(p, oldJobId, newJobId),
      );
      // Update selection to follow the renamed job
      setSelection((prev: Selection): Selection => {
        if (prev.type === 'none') return prev;
        if (prev.jobId === oldJobId) {
          return { ...prev, jobId: newJobId };
        }
        return prev;
      });
    },
    [applyMutation],
  );

  // Step CRUD
  const addStep = useCallback(
    (jobId: string): void => {
      applyMutation((p: Pipeline): Pipeline => {
        const job = p.jobs[jobId];
        if (!job) return p;
        const existingIds: string[] = job.steps
          .map((s: Step): string | undefined => s.id)
          .filter((id): id is string => id !== undefined);
        const newId: string = createStepId(existingIds);
        const newStep: Step = { ...createDefaultStep(), id: newId };
        return {
          ...p,
          jobs: {
            ...p.jobs,
            [jobId]: { ...job, steps: [...job.steps, newStep] },
          },
        };
      });
    },
    [applyMutation],
  );

  const removeStep = useCallback(
    (jobId: string, stepIndex: number): void => {
      applyMutation((p: Pipeline): Pipeline => {
        const job = p.jobs[jobId];
        if (!job) return p;
        const steps: Step[] = job.steps.filter(
          (_: Step, i: number): boolean => i !== stepIndex,
        );
        return {
          ...p,
          jobs: { ...p.jobs, [jobId]: { ...job, steps } },
        };
      });
      // Adjust selection
      setSelection((prev: Selection): Selection => {
        if (prev.type !== 'step') return prev;
        if (prev.jobId !== jobId) return prev;
        if (prev.stepIndex === stepIndex) return { type: 'job', jobId };
        if (prev.stepIndex > stepIndex) {
          return { ...prev, stepIndex: prev.stepIndex - 1 };
        }
        return prev;
      });
    },
    [applyMutation],
  );

  const updateStep = useCallback(
    (jobId: string, stepIndex: number, step: Step): void => {
      applyMutation((p: Pipeline): Pipeline => {
        const job = p.jobs[jobId];
        if (!job) return p;
        const steps: Step[] = [...job.steps];
        steps[stepIndex] = step;
        return {
          ...p,
          jobs: { ...p.jobs, [jobId]: { ...job, steps } },
        };
      });
    },
    [applyMutation],
  );

  const reorderSteps = useCallback(
    (jobId: string, fromIndex: number, toIndex: number): void => {
      if (fromIndex === toIndex) return;
      applyMutation((p: Pipeline): Pipeline => {
        const job = p.jobs[jobId];
        if (!job) return p;
        const steps: Step[] = [...job.steps];
        const [moved] = steps.splice(fromIndex, 1);
        steps.splice(toIndex, 0, moved);
        return {
          ...p,
          jobs: { ...p.jobs, [jobId]: { ...job, steps } },
        };
      });
      // Update selection to follow the moved step
      setSelection((prev: Selection): Selection => {
        if (prev.type !== 'step' || prev.jobId !== jobId) return prev;
        if (prev.stepIndex === fromIndex) {
          return { ...prev, stepIndex: toIndex };
        }
        return prev;
      });
    },
    [applyMutation],
  );

  const moveStepBetweenJobs = useCallback(
    (
      fromJobId: string,
      fromIndex: number,
      toJobId: string,
      toIndex: number,
    ): void => {
      applyMutation((p: Pipeline): Pipeline => {
        const fromJob = p.jobs[fromJobId];
        const toJob = p.jobs[toJobId];
        if (!fromJob || !toJob) return p;

        const fromSteps: Step[] = [...fromJob.steps];
        const [moved] = fromSteps.splice(fromIndex, 1);
        const toSteps: Step[] = [...toJob.steps];
        toSteps.splice(toIndex, 0, moved);

        return {
          ...p,
          jobs: {
            ...p.jobs,
            [fromJobId]: { ...fromJob, steps: fromSteps },
            [toJobId]: { ...toJob, steps: toSteps },
          },
        };
      });
      // Update selection to the new location
      setSelection({
        type: 'step',
        jobId: toJobId,
        stepIndex: toIndex,
      });
    },
    [applyMutation],
  );

  // Replace entire pipeline (used by raw YAML view)
  const replaceEntirePipeline = useCallback(
    (newPipeline: Pipeline): void => {
      applyMutation((): Pipeline => newPipeline);
    },
    [applyMutation],
  );

  // Undo/Redo
  const canUndo: boolean = pastRef.current.length > 0;
  const canRedo: boolean = futureRef.current.length > 0;

  const undo = useCallback((): void => {
    setPipeline((current: Pipeline | null): Pipeline | null => {
      if (!current || pastRef.current.length === 0) return current;
      const prev = pastRef.current[pastRef.current.length - 1];
      pastRef.current = pastRef.current.slice(0, -1);
      futureRef.current = [...futureRef.current, current];
      return prev;
    });
  }, []);

  const redo = useCallback((): void => {
    setPipeline((current: Pipeline | null): Pipeline | null => {
      if (!current || futureRef.current.length === 0) return current;
      const next = futureRef.current[futureRef.current.length - 1];
      futureRef.current = futureRef.current.slice(0, -1);
      pastRef.current = [...pastRef.current, current];
      return next;
    });
  }, []);

  // Save
  const save = useCallback(
    async (pipelineOverride?: Pipeline): Promise<PipelineInfo | null> => {
      const pipelineToSave = pipelineOverride ?? pipeline;
      if (!pipelineToSave || isReadonly || saving || savingRef.current)
        return null;

      savingRef.current = true;
      setSaving(true);
      try {
        // Shared pipeline path: serialize the in-memory pipeline back to YAML
        // (wrapped as `{ pipeline }` to mirror the canonical document shape)
        // and round-trip via `updateShared`. The handler is the source of
        // truth for the remote response — we apply it back into the editor
        // so the displayed metadata (`updatedAt`, `canUpdate`) stays in sync.
        if (sharedRemoteId) {
          const rawPipeline = yaml.dump(
            { pipeline: pipelineToSave },
            { lineWidth: 120, noRefs: true },
          );
          const result = await window.pipelines.updateShared({
            remoteId: sharedRemoteId,
            rawPipeline,
          });
          if (!result.success || !result.data) {
            setError(result.error ?? 'Failed to save workflow');
            return null;
          }
          const updated = sharedDetailToPipelineData(result.data);
          setError(null);
          setPipeline(pipelineToSave);
          setPipelineInfo(updated.info);
          persistedIdRef.current = updated.info.id;
          baselineRef.current = JSON.stringify(pipelineToSave);
          savedPipelineRef.current = pipelineToSave;
          setBaselineRevision((revision) => revision + 1);
          pastRef.current = [];
          futureRef.current = [];
          return updated.info;
        }

        // The revision this editor loaded: a save after another writer's
        // edit is refused as a conflict instead of overwriting it.
        const stored =
          persistedIdRef.current && pipelineInfo?.source === 'user';
        const expectedRevision = stored
          ? (pipelineInfo.revision ?? 0)
          : undefined;
        // A renamed Orchestrator workflow's new entries take its new name.
        const toStore = stored
          ? retitleChatAutomationEntry(pipelineToSave, [
              pipelineInfo.name,
              ...deferredRetitleRef.current,
            ])
          : pipelineToSave;
        const result = await window.pipelines.save({
          id: persistedIdRef.current,
          ...(expectedRevision === undefined ? {} : { expectedRevision }),
          name: toStore.name,
          description: toStore.description ?? '',
          icon: toStore.icon ?? '',
          content: toStore,
        });

        if (!result.success) {
          setError(result.error ?? 'Failed to save workflow');
          return null;
        }

        setError(null);
        setPipeline(toStore);
        if (result.data) {
          setPipelineInfo(result.data);
          persistedIdRef.current = result.data.id;
        }

        baselineRef.current = JSON.stringify(toStore);
        savedPipelineRef.current = toStore;
        deferredRetitleRef.current = [];
        setBaselineRevision((revision) => revision + 1);
        pastRef.current = [];
        futureRef.current = [];
        return result.data ?? pipelineInfo;
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err));
        return null;
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    },
    [isReadonly, pipeline, pipelineInfo, saving, sharedRemoteId],
  );

  const adoptSaved = useCallback(
    (savedPipeline: Pipeline, info: PipelineInfo, shown?: Pipeline): void => {
      setError(null);
      // Set directly, never as an edit, so Undo can't bring back the draft
      // it replaces.
      if (shown !== undefined) setPipeline(shown);
      setPipelineInfo(info);
      persistedIdRef.current = info.id;
      baselineRef.current = JSON.stringify(savedPipeline);
      savedPipelineRef.current = savedPipeline;
      deferredRetitleRef.current = [];
      setBaselineRevision((revision) => revision + 1);
      pastRef.current = [];
      futureRef.current = [];
    },
    [],
  );

  const getSavedPipeline = useCallback(
    (): Pipeline | null => savedPipelineRef.current,
    [],
  );

  const deferRetitleFrom = useCallback(
    (previousNames: readonly string[]): void => {
      deferredRetitleRef.current = previousNames;
    },
    [],
  );
  const retitleFromNames = useCallback(
    (): readonly string[] => [
      ...(pipelineInfo ? [pipelineInfo.name] : []),
      ...deferredRetitleRef.current,
    ],
    [pipelineInfo],
  );

  const holdSave = useCallback((): (() => void) | null => {
    if (savingRef.current) return null;
    savingRef.current = true;
    setSaving(true);
    let held = true;
    return (): void => {
      if (!held) return;
      held = false;
      savingRef.current = false;
      setSaving(false);
    };
  }, []);

  return {
    pipeline,
    pipelineInfo,
    loading,
    error,
    readonly: isReadonly,

    jobOrder,
    validation,
    canSave,

    selection,
    setSelection,

    activePanel,
    setActivePanel,
    mainView,
    setMainView,

    updatePipelineField,
    updateDefaults,
    updateEnv,

    addJob,
    removeJob,
    updateJob,
    renameJob,

    addStep,
    removeStep,
    updateStep,
    reorderSteps,
    moveStepBetweenJobs,

    replaceEntirePipeline,

    canUndo,
    canRedo,
    undo,
    redo,

    isDirty,
    saving,
    save,
    adoptSaved,
    getSavedPipeline,
    deferRetitleFrom,
    retitleFromNames,
    holdSave,
  };
}
