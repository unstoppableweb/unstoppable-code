import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ConfirmDialog } from '@canopy/ui-shared/components';
import type { UnsavedChangesSaveResult } from '@canopy/ui-app/workflows';
import type { RemoteControlPipelineDefinitionViewModel } from '@canopy/protocol/remote-control/shell';
import type {
  Pipeline,
  PipelineInfo,
} from '@canopy/execution-engine/types/pipeline';
import {
  usePipelineEditor,
  type MainView,
  type UsePipelineEditorReturn,
} from '../../hooks/usePipelineEditor';
import { useCurrentUiStateReporter } from '../../hooks/useCurrentUiStateReporter';
import {
  usePipelineEditorBridgeStore,
  type PipelineEditorControllerAdapter,
} from '../../stores/pipelineEditorBridgeStore';
import {
  retitleRawYaml,
  serializePipelineToYaml,
  tryParseAndValidateYaml,
} from '../../lib/pipeline-yaml';
import {
  isPipelineSelectionValid,
  type ValidationIssue,
} from '../../lib/pipelineEditor';
import { SharePipelineModal } from './SharePipelineModal';
import { useShareAccess } from '@/hooks/useShareAccess';
import { SHARE_PIPELINE_GATE_CONTEXT } from '@/lib/share-gate-context';
import type { PipelineFlowSource } from '@/components/pipeline/flow/PipelineFlowDiagram';
import { toPipelineDefinitionViewModel } from './pipeline-read-detail-adapter';
import { openCloudAccountSettings } from '@/lib/navigation/settings-destinations';

export const SHARED_PIPELINE_SAVE_IMPACT_MESSAGE =
  'People using this workflow in their automations will need to approve your changes before they run again.';

const SAVE_FAILED_MESSAGE = 'The workflow could not be saved.';

/** What the editor is pointed at. A share that moves the pipeline swaps it. */
export interface PipelineEditorTarget {
  pipelineId: string | null;
  draftKey?: string;
  cwd?: string;
  pipelineFilePath?: string;
  pipelineSource?: 'bundled' | 'user' | 'curated';
  sharedRemoteId?: string;
}

export interface PipelineEditorSessionProps {
  pipelineId: string | null;
  draftKey?: string;
  cwd?: string;
  /**
   * Worktree identity behind `cwd`, forwarded to the share dialog so main can
   * resolve that checkout and package repo-local `.claude` commands/skills.
   * Ids only — the renderer never sends a path.
   */
  worktree?: { projectId: string; worktreeId: string; repoId?: string };
  pipelineFilePath?: string;
  /** Stored-catalog namespace, when known, so bundled/user id collisions resolve exactly. */
  pipelineSource?: 'bundled' | 'user' | 'curated';
  /** When set, opens a shared pipeline from the configured Canopy Cloud account. */
  sharedRemoteId?: string;
  onSharedPipelineCreated?: () => void;
  /**
   * Copies the pipeline and opens the copy for editing. Rejects when no copy
   * was made. Omitted when the host cannot duplicate.
   */
  onDuplicate?: (pipeline: PipelineInfo) => Promise<void>;
}

export interface PipelineEditorSessionOptions {
  /**
   * Binds ⌘S, ⌘Z and ⇧⌘Z on the window. A host that owns the save shortcut
   * itself turns this off and calls `save`. Defaults to `true`.
   */
  bindShortcuts?: boolean;
  /**
   * Binds ⌘S with the other shortcuts. Defaults to `bindShortcuts`; the
   * Workflows edit shell owns ⌘S and turns only this off, keeping undo.
   */
  bindSaveShortcut?: boolean;
  /**
   * Runs a navigation the editor performs itself after saving (a related
   * pipeline link), so the host's unsaved-changes guard lets it through. The
   * draft may still read dirty until it renders. Defaults to calling it.
   */
  runWithoutGuard?: (navigate: () => void) => void;
  /** Called after every successful save, with the stored pipeline. */
  onSaved?: (saved: PipelineInfo, context: { wasDraft: boolean }) => void;
  /**
   * Handles the `pipeline.save` command (an agent's or App Advisor's save of
   * the open pipeline) instead of the editor's own definition save, so a host
   * whose Save does more (the Workflow page's "Send as", CAN-7186) runs the
   * same checks and writes for it.
   */
  saveCommand?: () => void;
}

export interface PipelineEditorSession {
  /** The underlying editor state and mutators, for the body. */
  editor: UsePipelineEditorReturn;
  target: PipelineEditorTarget;
  /** Identifies what is being edited, for an unsaved-changes guard. */
  targetKey: string;
  /** The host's `cwd`, which the settings panel resolves related items in. */
  cwd?: string;

  loading: boolean;
  /** Set when loading finished without a pipeline. */
  notFound: boolean;
  /** Why loading failed, when it did. */
  loadError: string | null;
  /** The last load or save error, shown above the editor. */
  error: string | null;
  pipeline: Pipeline | null;
  pipelineInfo: PipelineInfo | null;
  /** The pipeline's display name; empty while loading or unnamed. */
  name: string;
  rename: (name: string) => void;
  readOnly: boolean;
  /** Stored as the user's own pipeline. A draft is not, until it is saved. */
  isUserOwned: boolean;
  /** A new pipeline that has never been saved. */
  isDraft: boolean;

  /** Unsaved edits on an editable pipeline, including Raw text. */
  isDirty: boolean;
  saving: boolean;
  /** Save would do something now. */
  canSave: boolean;
  /**
   * Saves, asking first when a shared pipeline's automations would need to
   * approve the change. Resolves `{ ok: false }` when the user declines, and
   * `{ ok: false, message }` when validation or the save fails; the editor
   * stays dirty either way.
   */
  save: () => Promise<UnsavedChangesSaveResult>;
  /** `save` without waiting, for a button. */
  requestSave: () => void;
  /** Drops unsaved edits back to the last saved definition. */
  discard: () => void;

  mainView: MainView;
  /** Switches Flow, List and Raw; leaving Raw applies valid text first. */
  setMainView: (view: MainView) => void;
  isRawMode: boolean;
  rawYamlText: string;
  setRawYamlText: (text: string) => void;
  rawYamlError: string | null;
  /** Read-only pipelines show Flow or Details instead of the editor. */
  readDetailView: 'flowchart' | 'details';
  setReadDetailView: (view: 'flowchart' | 'details') => void;
  /** Set for a read-only pipeline: what the read detail renders. */
  readDefinition: RemoteControlPipelineDefinitionViewModel | null;
  flowSource: PipelineFlowSource | null;
  selectionIsValid: boolean;
  validationErrors: ValidationIssue[];
  validationWarnings: ValidationIssue[];

  /** Add Job is offered: editable and not in Raw. */
  canAddJob: boolean;
  addJob: () => void;
  settingsOpen: boolean;
  toggleSettings: () => void;
  /** Opens steps or settings; opening settings from Raw applies valid text first. */
  setActivePanel: (panel: 'steps' | 'settings') => void;
  /** Undo and Redo are offered: editable and not in Raw. */
  showHistoryControls: boolean;
  canUndo: boolean;
  canRedo: boolean;
  undo: () => void;
  redo: () => void;

  /** Bumped after each save so related sections reload. */
  relatedDataRevision: number;
  /** Follows a related-item link, saving unsaved edits first. */
  relatedNavigate: (
    navigate: (savedPipelineInfo?: PipelineInfo) => void,
  ) => void;

  canShare: boolean;
  /** Checks share access, then opens the share dialog. */
  requestShare: () => void;
  /** The share dialog, while open. */
  shareModal: ReactNode;
  /** The share access prompt, while open. */
  shareGateModal: ReactNode;

  canDuplicate: boolean;
  /** Copies the pipeline through the host; a failure lands in `duplicateError`. */
  duplicate: () => void;
  duplicating: boolean;
  duplicateError: string | null;

  /** The shared-pipeline save-impact confirmation, while open. */
  saveImpactDialog: ReactNode;
}

type SaveOutcome =
  | { readonly ok: true; readonly saved: PipelineInfo }
  | { readonly ok: false; readonly message?: string };

/**
 * Everything the pipeline editor does apart from its chrome: loading the
 * target, Raw YAML, save with the shared-pipeline impact check, dirty state,
 * the live-edit bridge registration, Share, Duplicate and shortcuts. A host
 * renders its own header from this and `PipelineEditorBody` below it, and
 * builds its own unsaved-changes guard from `isDirty`, `save` and `targetKey`.
 */
export function usePipelineEditorSession(
  {
    pipelineId,
    draftKey,
    cwd,
    worktree,
    pipelineFilePath,
    pipelineSource,
    sharedRemoteId,
    onSharedPipelineCreated,
    onDuplicate,
  }: PipelineEditorSessionProps,
  {
    bindShortcuts = true,
    bindSaveShortcut = bindShortcuts,
    runWithoutGuard,
    onSaved,
    saveCommand,
  }: PipelineEditorSessionOptions = {},
): PipelineEditorSession {
  const [editorTarget, setEditorTarget] = useState<PipelineEditorTarget>({
    pipelineId,
    draftKey,
    cwd,
    pipelineFilePath,
    pipelineSource,
    sharedRemoteId,
  });
  const editor = usePipelineEditor(editorTarget);
  const setEditorMainView = editor.setMainView;
  const [shareOpen, setShareOpen] = useState(false);
  const { requestShare, shareGateModal } = useShareAccess();
  const [duplicating, setDuplicating] = useState(false);
  const [duplicateError, setDuplicateError] = useState<string | null>(null);
  // A read-only workflow opens on its flow, like an editable one (CAN-4319).
  const [readDetailView, setReadDetailView] = useState<'flowchart' | 'details'>(
    'flowchart',
  );
  const [relatedDataRevision, setRelatedDataRevision] = useState(0);

  // Raw YAML view state
  const [rawYamlText, setRawYamlText] = useState<string>('');
  const [rawYamlError, setRawYamlError] = useState<string | null>(null);
  const rawYamlBaselineRef = useRef<string>('');

  const isRawMode: boolean = editor.mainView === 'raw';
  const isRawYamlDirty: boolean =
    isRawMode && rawYamlText !== rawYamlBaselineRef.current;
  useCurrentUiStateReporter('pipelines.activeEditor', {
    pipelineId: editor.pipelineInfo?.id ?? pipelineId ?? '',
    name: editor.pipeline?.name ?? '',
    editorOpen: true,
    dirty: isRawMode ? isRawYamlDirty || editor.isDirty : editor.isDirty,
    readonly: editor.readonly,
    ...(editor.readonly
      ? { activeView: readDetailView === 'flowchart' ? 'flow' : 'details' }
      : {}),
  });

  useEffect((): void => {
    // A saved-to-saved recommendation swaps targets without unmounting this
    // component. Reset Raw mode before the new definition loads so the old
    // textarea can never be saved over the new target.
    setRawYamlText('');
    rawYamlBaselineRef.current = '';
    setRawYamlError(null);
    setReadDetailView('flowchart');
    setEditorMainView('flowchart');
    setEditorTarget({
      pipelineId,
      draftKey,
      cwd,
      pipelineFilePath,
      pipelineSource,
      sharedRemoteId,
    });
  }, [
    cwd,
    draftKey,
    pipelineFilePath,
    pipelineId,
    pipelineSource,
    setEditorMainView,
    sharedRemoteId,
  ]);

  // The definition as last loaded or saved, so Discard can restore it. The
  // editor reads clean exactly when its pipeline matches that baseline.
  const savedPipelineRef = useRef<Pipeline | null>(null);
  useEffect((): void => {
    if (editor.pipeline && !editor.isDirty) {
      savedPipelineRef.current = editor.pipeline;
    }
  }, [editor.pipeline, editor.isDirty]);

  /**
   * Try to apply the current raw YAML text back to the pipeline state.
   * Returns true on success, false on validation failure (sets rawYamlError).
   */
  const applyRawYaml = useCallback((): boolean => {
    const result = tryParseAndValidateYaml(rawYamlText);
    if (!result.success) {
      setRawYamlError(result.error);
      return false;
    }
    setRawYamlError(null);
    editor.replaceEntirePipeline(result.pipeline);
    // Update the baseline so dirty tracking resets after apply
    rawYamlBaselineRef.current = rawYamlText;
    return true;
  }, [rawYamlText, editor]);

  // ---------------------------------------------------------------------------
  // Renderer live-edit bridge registration
  //
  // Expose a controller adapter (the `usePipelineEditor` return PLUS the
  // raw-mode accessors/mutators that live here) so the
  // `PipelineEditorRuntimeBridge` can apply main-process tool requests to the
  // editor the user is currently looking at. The adapter object is registered
  // once and reads the latest values through refs, so the bridge always sees
  // current state without re-subscribing on every render.
  // ---------------------------------------------------------------------------
  const editorRef = useRef(editor);
  editorRef.current = editor;
  const editorTargetRef = useRef(editorTarget);
  editorTargetRef.current = editorTarget;
  const isRawModeRef = useRef(isRawMode);
  isRawModeRef.current = isRawMode;
  const rawYamlTextRef = useRef(rawYamlText);
  rawYamlTextRef.current = rawYamlText;
  const rawYamlErrorRef = useRef(rawYamlError);
  rawYamlErrorRef.current = rawYamlError;
  const isRawYamlDirtyRef = useRef(isRawYamlDirty);
  isRawYamlDirtyRef.current = isRawYamlDirty;
  const applyRawYamlRef = useRef(applyRawYaml);
  applyRawYamlRef.current = applyRawYaml;

  const registerEditorController = usePipelineEditorBridgeStore(
    (s) => s.registerEditorController,
  );
  const unregisterEditorController = usePipelineEditorBridgeStore(
    (s) => s.unregisterEditorController,
  );

  useEffect(() => {
    const adapter: PipelineEditorControllerAdapter = {
      getTarget: () => editorTargetRef.current,
      getEditor: () => editorRef.current,
      isRawMode: () => isRawModeRef.current,
      getRawYamlText: () => rawYamlTextRef.current,
      getRawYamlError: () => rawYamlErrorRef.current,
      isRawYamlDirty: () => isRawYamlDirtyRef.current,
      setRawYamlText: (text: string): void => {
        setRawYamlText(text);
      },
      clearRawYamlError: (): void => {
        setRawYamlError(null);
      },
      resetRawYamlBaseline: (text: string): void => {
        rawYamlBaselineRef.current = text;
      },
      applyRawYaml: () => applyRawYamlRef.current(),
      adoptSaved: (savedPipeline, info, shown): void => {
        editorRef.current.adoptSaved(savedPipeline, info, shown);
        savedPipelineRef.current = savedPipeline;
      },
    };
    registerEditorController(adapter);
    return (): void => {
      unregisterEditorController(adapter);
    };
  }, [registerEditorController, unregisterEditorController]);

  /**
   * Handle switching the main view, with validation gating when leaving raw mode.
   */
  const handleMainViewChange = useCallback(
    (view: MainView): void => {
      // Switching away from raw mode: validate and apply YAML first
      if (isRawMode && view !== 'raw') {
        // If there are unsaved YAML edits, validate and apply them
        if (rawYamlText !== rawYamlBaselineRef.current) {
          if (!applyRawYaml()) {
            return; // Block the switch — validation failed
          }
        }
        setRawYamlError(null);
      }

      // Switching into raw mode: serialize current pipeline
      if (!isRawMode && view === 'raw') {
        if (editor.pipeline) {
          const text = serializePipelineToYaml(editor.pipeline);
          setRawYamlText(text);
          rawYamlBaselineRef.current = text;
          setRawYamlError(null);
        }
      }

      editor.setMainView(view);
    },
    [isRawMode, rawYamlText, applyRawYaml, editor],
  );

  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;

  /**
   * Handle save, with raw YAML apply-first logic.
   */
  // Raw text typed while a save renamed an Orchestrator workflow takes the
  // entry title the save stored, so its next save can't write the old one
  // back (CAN-5782). It stays unsaved.
  const retitleTypedRawYaml = useCallback(
    (previousNames: readonly string[], savedName: string): void => {
      if (previousNames.length === 0) return;
      const typed = retitleRawYaml(
        rawYamlTextRef.current,
        previousNames,
        savedName,
      );
      // Text that can't be retitled now (invalid for the moment) is
      // retitled by its next save.
      if (typed === null) editorRef.current.deferRetitleFrom(previousNames);
      else setRawYamlText(typed);
    },
    [],
  );

  const saveCurrentPipeline = useCallback(async (): Promise<SaveOutcome> => {
    const wasDraft =
      editorTarget.pipelineId === null &&
      !editorTarget.sharedRemoteId &&
      editor.pipelineInfo === null;
    const finish = (saved: PipelineInfo | null): SaveOutcome => {
      if (!saved) return { ok: false, message: SAVE_FAILED_MESSAGE };
      setRelatedDataRevision((revision) => revision + 1);
      onSavedRef.current?.(saved, { wasDraft });
      return { ok: true, saved };
    };

    if (isRawMode) {
      const result = tryParseAndValidateYaml(rawYamlText);
      if (!result.success) {
        setRawYamlError(result.error);
        return { ok: false, message: result.error };
      }

      setRawYamlError(null);
      const rawYamlDirty = rawYamlText !== rawYamlBaselineRef.current;
      const sent = rawYamlDirty ? result.pipeline : editor.pipeline;
      const previousNames = editor.retitleFromNames();
      const saved = await editor.save(
        rawYamlDirty ? result.pipeline : undefined,
      );
      if (saved) {
        // A save that stored more than the text said (an Orchestrator
        // entry's new title) shows what it stored, so a later raw edit
        // can't write the old text back. Text typed while it saved stays,
        // unsaved.
        const stored = editor.getSavedPipeline();
        const text =
          stored && stored !== sent
            ? serializePipelineToYaml(stored)
            : rawYamlText;
        if (text !== rawYamlText) {
          if (rawYamlTextRef.current === rawYamlText) setRawYamlText(text);
          else retitleTypedRawYaml(previousNames, saved.name);
        }
        rawYamlBaselineRef.current = text;
        setRawYamlError(null);
      }
      return finish(saved);
    }

    const shown = editor.pipeline;
    const previousNames = editor.retitleFromNames();
    const saved = await editor.save();
    // Raw view opened during the save shows what it stored; text typed
    // there since keeps every edit, with only the entry title moved.
    const stored = editor.getSavedPipeline();
    if (
      saved &&
      shown !== null &&
      stored !== null &&
      stored !== shown &&
      isRawModeRef.current
    ) {
      if (rawYamlTextRef.current === serializePipelineToYaml(shown)) {
        const text = serializePipelineToYaml(stored);
        setRawYamlText(text);
        rawYamlBaselineRef.current = text;
      } else retitleTypedRawYaml(previousNames, saved.name);
    }
    return finish(saved);
  }, [
    editorTarget.pipelineId,
    editorTarget.sharedRemoteId,
    isRawMode,
    rawYamlText,
    editor,
    retitleTypedRawYaml,
  ]);

  // Publisher warning (CAN-3354): saving a shared pipeline that pinned
  // automations use sends them back for review. Ask once before saving when
  // this desktop knows of affected automations; the dialog resolves the
  // pending promise with the user's choice.
  const [saveImpactConfirmOpen, setSaveImpactConfirmOpen] = useState(false);
  const saveImpactResolverRef = useRef<((confirmed: boolean) => void) | null>(
    null,
  );
  const saveImpactCheckPendingRef = useRef(false);
  const saveWithImpactPromiseRef = useRef<Promise<SaveOutcome> | null>(null);
  const editorSharedRemoteId = editorTarget.sharedRemoteId;
  const confirmSharedSaveImpact = useCallback(async (): Promise<boolean> => {
    if (!editorSharedRemoteId) return true;
    // A second save must not start another query or stack a confirmation.
    if (saveImpactCheckPendingRef.current) return false;
    saveImpactCheckPendingRef.current = true;
    try {
      let affected: boolean;
      try {
        const result =
          await window.pipelines.getSharedUpdateImpact(editorSharedRemoteId);
        // Fail toward warning: an unknown impact still asks before saving.
        affected =
          !result.success || !result.data || result.data.automations.length > 0;
      } catch {
        affected = true;
      }
      if (!affected) return true;
      return await new Promise<boolean>((resolve) => {
        saveImpactResolverRef.current = resolve;
        setSaveImpactConfirmOpen(true);
      });
    } finally {
      saveImpactCheckPendingRef.current = false;
    }
  }, [editorSharedRemoteId]);
  const resolveSaveImpactConfirm = useCallback((confirmed: boolean): void => {
    const resolve = saveImpactResolverRef.current;
    saveImpactResolverRef.current = null;
    setSaveImpactConfirmOpen(false);
    resolve?.(confirmed);
  }, []);
  useEffect(
    (): (() => void) => (): void => {
      saveImpactResolverRef.current?.(false);
      saveImpactResolverRef.current = null;
      saveImpactCheckPendingRef.current = false;
    },
    [],
  );

  const saveWithImpactConfirm = useCallback((): Promise<SaveOutcome> => {
    const pending = saveWithImpactPromiseRef.current;
    if (pending) return pending;
    const next = (async (): Promise<SaveOutcome> => {
      if (!(await confirmSharedSaveImpact())) return { ok: false };
      return await saveCurrentPipeline();
    })();
    saveWithImpactPromiseRef.current = next;
    const clearPending = (): void => {
      if (saveWithImpactPromiseRef.current === next) {
        saveWithImpactPromiseRef.current = null;
      }
    };
    void next.then(clearPending, clearPending);
    return next;
  }, [confirmSharedSaveImpact, saveCurrentPipeline]);

  const save = useCallback(async (): Promise<UnsavedChangesSaveResult> => {
    const outcome = await saveWithImpactConfirm();
    if (outcome.ok) return { ok: true };
    return outcome.message === undefined
      ? { ok: false }
      : { ok: false, message: outcome.message };
  }, [saveWithImpactConfirm]);

  const handleSave = useCallback((): void => {
    void saveWithImpactConfirm();
  }, [saveWithImpactConfirm]);

  const runWithoutGuardRef = useRef(runWithoutGuard);
  runWithoutGuardRef.current = runWithoutGuard;

  const handleRelatedNavigate = useCallback(
    (navigate: (savedPipelineInfo?: PipelineInfo) => void): void => {
      const dirty = isRawMode
        ? isRawYamlDirty || editor.isDirty
        : editor.isDirty;
      if (!dirty) {
        navigate(editor.pipelineInfo ?? undefined);
        return;
      }
      void (async (): Promise<void> => {
        const outcome = await saveWithImpactConfirm();
        if (outcome.ok) {
          // Saved just now; the draft may still read dirty until it renders.
          const leave = (): void => navigate(outcome.saved);
          const bypass = runWithoutGuardRef.current;
          if (bypass) bypass(leave);
          else leave();
        }
      })();
    },
    [
      editor.isDirty,
      editor.pipelineInfo,
      isRawMode,
      isRawYamlDirty,
      saveWithImpactConfirm,
    ],
  );

  const saveCommandRef = useRef(saveCommand);
  saveCommandRef.current = saveCommand;
  useEffect(() => {
    const onSaveCommand = (): void => {
      const host = saveCommandRef.current;
      if (host) host();
      else handleSave();
    };
    window.addEventListener('canopy:pipeline-save-active', onSaveCommand);
    return (): void => {
      window.removeEventListener('canopy:pipeline-save-active', onSaveCommand);
    };
  }, [handleSave]);

  const hasUnsavedEdits: boolean =
    !editor.readonly &&
    (isRawMode ? isRawYamlDirty || editor.isDirty : editor.isDirty);
  const targetKey = [
    editorTarget.pipelineSource ?? '',
    editorTarget.sharedRemoteId ?? '',
    editorTarget.cwd ?? '',
    editorTarget.pipelineId ?? `draft-${editorTarget.draftKey ?? 0}`,
  ].join('\0');

  const discard = useCallback((): void => {
    if (editor.readonly) return;
    const saved = savedPipelineRef.current;
    if (saved && editor.isDirty) editor.replaceEntirePipeline(saved);
    if (isRawMode && saved) {
      const text = serializePipelineToYaml(saved);
      setRawYamlText(text);
      rawYamlBaselineRef.current = text;
    }
    setRawYamlError(null);
  }, [editor, isRawMode]);

  // Effective canSave: in raw mode, the textarea is validated at save time.
  const effectiveCanSave: boolean = isRawMode
    ? !editor.readonly && !editor.saving && (isRawYamlDirty || editor.isDirty)
    : editor.canSave;

  /**
   * Handle active panel change, with validation gating when leaving raw mode.
   */
  const handleActivePanelChange = useCallback(
    (panel: 'steps' | 'settings'): void => {
      // If switching to settings while in raw mode with unsaved edits, validate first
      if (isRawMode && panel === 'settings') {
        if (rawYamlText !== rawYamlBaselineRef.current) {
          if (!applyRawYaml()) {
            return; // Block — validation failed
          }
        }
        setRawYamlError(null);
      }
      editor.setActivePanel(panel);
    },
    [isRawMode, rawYamlText, applyRawYaml, editor],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent): void => {
      const mod = e.metaKey || e.ctrlKey;
      // In raw mode, let the textarea handle its own undo/redo
      if (isRawMode && mod && e.key === 'z') {
        return;
      }
      if (mod && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        editor.undo();
      } else if (mod && e.key === 'z' && e.shiftKey) {
        e.preventDefault();
        editor.redo();
      } else if (mod && e.key === 's' && bindSaveShortcut) {
        e.preventDefault();
        if (effectiveCanSave) {
          handleSave();
        }
      }
    },
    [editor, isRawMode, effectiveCanSave, handleSave, bindSaveShortcut],
  );

  useEffect((): (() => void) | undefined => {
    if (!bindShortcuts) return undefined;
    window.addEventListener('keydown', handleKeyDown);
    return (): void => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [bindShortcuts, handleKeyDown]);

  const flowSource = useMemo<PipelineFlowSource | null>(
    () =>
      editor.pipeline
        ? {
            kind: 'definition',
            pipeline: editor.pipeline,
            jobOrder: editor.jobOrder,
          }
        : null,
    [editor.pipeline, editor.jobOrder],
  );

  const currentPipeline = editor.pipeline;
  const currentSelection = editor.selection;
  const setEditorSelection = editor.setSelection;

  const selectionIsValid = useMemo(
    (): boolean =>
      currentPipeline
        ? isPipelineSelectionValid(currentPipeline, currentSelection)
        : true,
    [currentPipeline, currentSelection],
  );

  useEffect(() => {
    if (!currentPipeline || selectionIsValid) {
      return;
    }

    setEditorSelection({ type: 'none' });
  }, [currentPipeline, selectionIsValid, setEditorSelection]);

  const readDefinition = useMemo(
    () =>
      editor.readonly && editor.pipeline
        ? toPipelineDefinitionViewModel(editor.pipeline)
        : null,
    [editor.pipeline, editor.readonly],
  );

  const pipelineInfo = editor.pipelineInfo;
  const requestShareDialog = useCallback((): void => {
    requestShare(SHARE_PIPELINE_GATE_CONTEXT, () => setShareOpen(true));
  }, [requestShare]);

  const duplicate = useCallback((): void => {
    if (!onDuplicate || !pipelineInfo) return;
    setDuplicateError(null);
    setDuplicating(true);
    void onDuplicate(pipelineInfo)
      .catch((error: unknown) => {
        setDuplicateError(
          error instanceof Error ? error.message : String(error),
        );
      })
      .finally(() => setDuplicating(false));
  }, [onDuplicate, pipelineInfo]);

  const toggleSettings = useCallback((): void => {
    handleActivePanelChange(
      editor.activePanel === 'settings' ? 'steps' : 'settings',
    );
  }, [editor.activePanel, handleActivePanelChange]);

  const rename = useCallback(
    (name: string): void => editor.updatePipelineField('name', name),
    [editor],
  );

  const openAccountSettings = (): void => {
    setShareOpen(false);
    openCloudAccountSettings();
  };
  const shareModal: ReactNode =
    shareOpen && editor.pipeline && pipelineInfo ? (
      editor.readonly ? (
        <SharePipelineModal
          pipeline={editor.pipeline}
          localPipelineInfo={pipelineInfo}
          {...(editorTarget.cwd && worktree ? { worktree } : {})}
          onClose={(): void => setShareOpen(false)}
          onOpenAccountSettings={openAccountSettings}
          // The dialog stays open on its success notice until Done.
          onShared={(): void => onSharedPipelineCreated?.()}
          onPublicLinkRemoved={(): void => onSharedPipelineCreated?.()}
        />
      ) : (
        <SharePipelineModal
          pipeline={editor.pipeline}
          localPipelineInfo={pipelineInfo}
          {...(editorTarget.cwd && worktree ? { worktree } : {})}
          onClose={() => setShareOpen(false)}
          onOpenAccountSettings={openAccountSettings}
          onPublicLinkRemoved={(): void => onSharedPipelineCreated?.()}
          // Sharing keeps the local pipeline, so the editor stays on it, and
          // the dialog stays open on its success notice until Done.
          onShared={(): void => onSharedPipelineCreated?.()}
        />
      )
    ) : null;

  const saveImpactDialog: ReactNode = saveImpactConfirmOpen ? (
    <ConfirmDialog
      title="Save changes?"
      message={SHARED_PIPELINE_SAVE_IMPACT_MESSAGE}
      confirmLabel="Save"
      onConfirm={(): void => resolveSaveImpactConfirm(true)}
      onCancel={(): void => resolveSaveImpactConfirm(false)}
      dataTestId="shared-pipeline-save-impact-dialog"
      confirmTestId="shared-pipeline-save-impact-confirm"
    />
  ) : null;

  const editable = !editor.readonly && editor.mainView !== 'raw';

  return {
    editor,
    target: editorTarget,
    targetKey,
    cwd,

    loading: editor.loading,
    notFound: !editor.loading && !editor.pipeline,
    loadError: !editor.loading && !editor.pipeline ? editor.error : null,
    error: editor.error,
    pipeline: editor.pipeline,
    pipelineInfo,
    name: editor.pipeline?.name ?? '',
    rename,
    readOnly: editor.readonly,
    isUserOwned: pipelineInfo?.source === 'user',
    isDraft:
      editorTarget.pipelineId === null &&
      !editorTarget.sharedRemoteId &&
      pipelineInfo === null,

    isDirty: hasUnsavedEdits,
    saving: editor.saving,
    canSave: effectiveCanSave,
    save,
    requestSave: handleSave,
    discard,

    mainView: editor.mainView,
    setMainView: handleMainViewChange,
    isRawMode,
    rawYamlText,
    setRawYamlText,
    rawYamlError,
    readDetailView,
    setReadDetailView,
    readDefinition,
    flowSource,
    selectionIsValid,
    validationErrors: editor.validation.filter((v) => v.type === 'error'),
    validationWarnings: editor.validation.filter((v) => v.type === 'warning'),

    canAddJob: editable,
    addJob: editor.addJob,
    settingsOpen: editor.activePanel === 'settings',
    toggleSettings,
    setActivePanel: handleActivePanelChange,
    showHistoryControls: editable,
    canUndo: editor.canUndo,
    canRedo: editor.canRedo,
    undo: editor.undo,
    redo: editor.redo,

    relatedDataRevision,
    relatedNavigate: handleRelatedNavigate,

    canShare: pipelineInfo !== null,
    requestShare: requestShareDialog,
    shareModal,
    shareGateModal,

    canDuplicate: Boolean(onDuplicate) && pipelineInfo !== null,
    duplicate,
    duplicating,
    duplicateError,

    saveImpactDialog,
  };
}
