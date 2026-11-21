import { create } from 'zustand';
import type {
  PipelineEditorOpenLocator,
  PipelineEditorRow,
} from '@canopy/desktop-shared/types';
import type {
  Pipeline,
  PipelineInfo,
} from '@canopy/execution-engine/types/pipeline';
import type { UsePipelineEditorReturn } from '@/hooks/usePipelineEditor';

export interface PipelineEditorControllerTarget {
  pipelineId: string | null;
  draftKey?: string;
  cwd?: string;
  pipelineFilePath?: string;
  sharedRemoteId?: string;
}

/**
 * Live adapter exposed by the mounted pipeline editor session so the
 * {@link PipelineEditorRuntimeBridge} can read and mutate the editor that is
 * currently in front of the user.
 *
 * The adapter is intentionally **not** the bare `usePipelineEditor` return:
 * raw YAML mode keeps its own state inside `usePipelineEditorSession`
 * (`rawYamlText`, `rawYamlError`, `rawYamlBaselineRef`, `applyRawYaml`,
 * `isRawMode = editor.mainView === 'raw'`). Without bundling these, a
 * `get_current` would ignore unsaved raw-textarea edits and a `set_yaml`
 * would leave the visible textarea stale (its next view-switch would clobber
 * the agent's change). Every member is a getter/mutator that reads the latest
 * value so the bridge always sees current state even though the adapter object
 * itself is registered once.
 */
export interface PipelineEditorControllerAdapter {
  /** Latest editor target backing this adapter. */
  getTarget: () => PipelineEditorControllerTarget;
  /** Latest `usePipelineEditor` return for the mounted editor. */
  getEditor: () => UsePipelineEditorReturn;
  /** True when the editor's main view is the raw YAML textarea. */
  isRawMode: () => boolean;
  /** The visible raw-YAML buffer (only meaningful while `isRawMode`). */
  getRawYamlText: () => string;
  /** The current raw-YAML parse/validation error, if any. */
  getRawYamlError: () => string | null;
  /** Whether the visible raw buffer diverges from its applied baseline. */
  isRawYamlDirty: () => boolean;
  /** Replace the visible raw-YAML buffer text. */
  setRawYamlText: (text: string) => void;
  /** Clear the current raw-YAML parse/validation error. */
  clearRawYamlError: () => void;
  /**
   * Reset the raw-YAML dirty baseline to `text` so the buffer is no longer
   * treated as a competing dirty edit after the bridge applies a change.
   */
  resetRawYamlBaseline: (text: string) => void;
  /**
   * Parse + validate the current raw buffer and, on success, push it into the
   * editor state via `replaceEntirePipeline` (resetting the baseline).
   * Returns false on validation failure.
   */
  applyRawYaml: () => boolean;
  /**
   * Shows a pipeline core saved for an agent as the editor's saved state, and
   * as what Discard restores (CAN-5822).
   */
  adoptSaved: (
    savedPipeline: Pipeline,
    info: PipelineInfo,
    shown?: Pipeline,
  ) => void;
}

/**
 * Page-mode controller exposed by {@link PipelinesPage}. Drives navigation
 * that lives above the editor (open an existing pipeline, start a new draft,
 * return to the list) and serves the source-aware row list for the
 * `pipeline.list` round-trip.
 */
export interface PipelineEditorPageController {
  /**
   * Open the pipeline identified by the source-aware locator in the editor.
   * Resolves `false` when the person kept editing unsaved changes instead.
   */
  openEditor: (locator: PipelineEditorOpenLocator) => Promise<boolean>;
  /**
   * Open a brand-new draft pipeline in the editor. Resolves null when the
   * person kept editing unsaved changes instead.
   */
  openNewDraft: () => Promise<PipelineEditorControllerTarget | null>;
  /**
   * Leave the editor and return to the pipeline list. Resolves `false` when
   * the person kept editing unsaved changes instead.
   */
  goToList: () => Promise<boolean>;
  /**
   * Current source-aware rows merged from the page's `usePipelineList`
   * result (`pipelines` + the separate `shared` substate).
   */
  getPipelineRows: () => PipelineEditorRow[];
}

export interface PipelineEditorBridgeState {
  /** Adapter for the mounted editor, or null when the list view is showing. */
  editorController: PipelineEditorControllerAdapter | null;
  /** Page-mode controller, present whenever `PipelinesPage` is mounted. */
  pageController: PipelineEditorPageController | null;

  registerEditorController: (adapter: PipelineEditorControllerAdapter) => void;
  /**
   * Unregister the editor adapter. Pass the same adapter instance that was
   * registered so a late unmount from a previous editor cannot clobber a newer
   * editor that already re-registered (StrictMode / fast remounts).
   */
  unregisterEditorController: (
    adapter?: PipelineEditorControllerAdapter,
  ) => void;
  registerPageController: (controller: PipelineEditorPageController) => void;
  /** Unregister the page controller (identity-checked, see above). */
  unregisterPageController: (controller?: PipelineEditorPageController) => void;
}

/**
 * Renderer "bridge" store mirroring `appAdvisorStore`'s wiring but targeting
 * the pipeline editor. The mounted editor session (`usePipelineEditorSession`) registers its
 * controller adapter here; `PipelinesPage` registers the page-mode controller;
 * the {@link PipelineEditorRuntimeBridge} reads both to apply main-process tool
 * requests to whatever the user is currently looking at.
 */
export const usePipelineEditorBridgeStore = create<PipelineEditorBridgeState>(
  (set, get) => ({
    editorController: null,
    pageController: null,

    registerEditorController: (adapter): void => {
      set({ editorController: adapter });
    },
    unregisterEditorController: (adapter): void => {
      // Only clear when the adapter being unregistered is still the active one
      // (or no instance was supplied), so a late unmount from a previous editor
      // cannot clobber a newer editor that already re-registered.
      const current = get().editorController;
      if (current && (!adapter || current === adapter)) {
        set({ editorController: null });
      }
    },
    registerPageController: (controller): void => {
      set({ pageController: controller });
    },
    unregisterPageController: (controller): void => {
      const current = get().pageController;
      if (current && (!controller || current === controller)) {
        set({ pageController: null });
      }
    },
  }),
);
