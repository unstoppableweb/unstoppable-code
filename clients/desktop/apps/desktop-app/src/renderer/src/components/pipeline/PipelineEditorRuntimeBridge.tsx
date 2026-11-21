import { useEffect, useRef, type JSX } from 'react';
import type { InterfaceToolName } from '@canopy/protocol/canopy-core';
import {
  getRendererToolRequestScopeKey,
  type PipelineEditorRendererToolRequest,
  type PipelineEditorRendererToolResponse,
  type PipelineEditorSaveSnapshot,
  type PipelineEditorValidationIssue,
} from '@canopy/desktop-shared/types';
import type {
  Pipeline,
  PipelineInfo,
} from '@canopy/execution-engine/types/pipeline';
import { contributeInterfaceTools } from '@/client/interface-tools-client';
import { retitleChatAutomationEntry } from '@canopy/desktop-shared/lib/chat-automation-conversion';
import { sharedDetailToPipelineInfo } from '@/lib/pipelineDocument';
import {
  retitleRawYaml,
  serializePipelineToYaml,
  tryParseAndValidateYaml,
} from '@/lib/pipeline-yaml';
import { getDraftValidation } from '@/lib/pipelineEditor';
import {
  usePipelineEditorBridgeStore,
  type PipelineEditorBridgeState,
  type PipelineEditorControllerAdapter,
  type PipelineEditorControllerTarget,
  type PipelineEditorPageController,
} from '@/stores/pipelineEditorBridgeStore';
import { useNavigationStore } from '@/stores/navigationStore';

const READONLY_MESSAGE =
  'This pipeline is read-only — duplicate it to make changes before editing.';
const NO_EDITOR_MESSAGE =
  'No pipeline is open. Open or create a pipeline first, then edit it.';
const NO_PIPELINE_LOADED_MESSAGE =
  'The pipeline editor is still loading. Try again in a moment.';
const NO_PAGE_MESSAGE = 'The Pipelines page is not available.';
const KEPT_EDITING_MESSAGE = 'The person kept editing unsaved changes.';
const PAGE_CONTROLLER_TIMEOUT_MS = 5_000;
const EDITOR_CONTROLLER_TIMEOUT_MS = 5_000;
const BRIDGE_WAIT_INTERVAL_MS = 25;
const MAX_REMEMBERED_SNAPSHOTS = 8;
// Longer than main's save round trip; a save whose report never arrives
// (main restarted, the lease ended) frees the editor's save guard anyway.
const SAVE_HOLD_TIMEOUT_MS = 120_000;
const SAVE_BUSY_MESSAGE = 'Failed to save the pipeline.';

/** The catalog tools this bridge serves on the main window's lease (CAN-5822). */
const PIPELINE_EDITOR_INTERFACE_TOOLS: readonly InterfaceToolName[] = [
  'ui.pipeline_editor.adopt_saved',
  'ui.pipeline_editor.create',
  'ui.pipeline_editor.get_current',
  'ui.pipeline_editor.list',
  'ui.pipeline_editor.open',
  'ui.pipeline_editor.prepare_save',
  'ui.pipeline_editor.set_yaml',
  'ui.pipeline_editor.to_list',
];

/** A draft handed to main for saving, kept until main reports what it saved. */
interface RememberedSnapshot {
  /** The editor that handed over the draft; only it may adopt the save. */
  controller: PipelineEditorControllerAdapter;
  target: PipelineEditorControllerTarget;
  /** The loaded row the draft saves over, absent for a new draft. */
  loaded?: { id: string; source: PipelineInfo['source'] };
  pipeline: Pipeline;
  rawYamlText?: string;
  /**
   * The draft as the editor showed it when `pipeline` adds an Orchestrator
   * entry's new title (CAN-5782): adoption shows `pipeline` instead, while
   * the editor still shows this draft.
   */
  retitledFrom?: {
    draft: Pipeline;
    /** The names the draft's entry title followed the rename from. */
    previousNames: readonly string[];
    rawYamlText?: string;
  };
  /** Frees the editor's save guard, held until main reports the save. */
  release: () => void;
}

function toValidationIssues(
  pipeline: Pipeline,
): PipelineEditorValidationIssue[] {
  return getDraftValidation(pipeline).map((issue) => ({
    type: issue.type,
    path: issue.path,
    message: issue.message,
  }));
}

/**
 * Renderer end of the pipeline-editor renderer-tool round-trip. Mirrors
 * {@link AppAdvisorRuntimeBridge}: it subscribes to main-process tool requests
 * over `window.api.pipelineEditor.onToolRequest`, applies each request to the
 * mounted editor (or to page/navigation state when no editor is mounted) via
 * the {@link usePipelineEditorBridgeStore}, and replies with
 * `completeToolRequest`.
 *
 * Mounted once at the `PipelinesPage` root (outside the list/editor switch) so
 * it lives across list↔editor navigation.
 */
export function PipelineEditorRuntimeBridge(): JSX.Element {
  const responseCacheRef = useRef<
    Map<string, PipelineEditorRendererToolResponse>
  >(new Map());
  const pendingEditorTargetRef = useRef<PipelineEditorControllerTarget | null>(
    null,
  );

  const snapshotsRef = useRef<Map<string, RememberedSnapshot>>(new Map());

  useEffect(() => {
    const dispose = window.api.pipelineEditor.onToolRequest((request) => {
      void handleRequest(request);
    });
    const withdrawTools = contributeInterfaceTools(
      PIPELINE_EDITOR_INTERFACE_TOOLS,
    );
    return (): void => {
      withdrawTools();
      dispose();
    };
    // `handleRequest` reads only the bridge store (via getState) and stable
    // module helpers; listing it would force a re-subscription each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <></>;

  async function handleRequest(
    request: PipelineEditorRendererToolRequest,
  ): Promise<void> {
    const { originChatId } = request;
    const cacheKey = getRendererToolRequestScopeKey(
      request.requestId,
      originChatId,
    );
    const cached = responseCacheRef.current.get(cacheKey);
    if (cached) {
      await window.api.pipelineEditor.completeToolRequest(cached);
      return;
    }

    let response: PipelineEditorRendererToolResponse;
    try {
      response = await routeRequest(request);
    } catch (error: unknown) {
      response = {
        requestId: request.requestId,
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : 'Pipeline editor renderer tool failed.',
      };
    }

    const scopedResponse = originChatId
      ? { ...response, originChatId }
      : response;
    cacheResponse(cacheKey, scopedResponse);
    await window.api.pipelineEditor.completeToolRequest(scopedResponse);
  }

  async function routeRequest(
    request: PipelineEditorRendererToolRequest,
  ): Promise<PipelineEditorRendererToolResponse> {
    const { requestId } = request;

    switch (request.kind) {
      case 'list': {
        const page = await getReadyPageController(requestId);
        if (!page.ok) {
          return page.response;
        }
        return {
          requestId,
          ok: true,
          pipelines: page.pageController.getPipelineRows(),
        };
      }

      case 'open': {
        const page = await getReadyPageController(requestId);
        if (!page.ok) {
          return page.response;
        }
        const opened = await page.pageController.openEditor(request.locator);
        if (!opened) {
          return { requestId, ok: false, error: KEPT_EDITING_MESSAGE };
        }
        pendingEditorTargetRef.current = {
          pipelineId: request.locator.pipelineId ?? null,
          cwd: request.locator.cwd,
          pipelineFilePath: request.locator.pipelineFilePath,
          sharedRemoteId: request.locator.sharedRemoteId,
        };
        return { requestId, ok: true };
      }

      case 'create': {
        const page = await getReadyPageController(requestId);
        if (!page.ok) {
          return page.response;
        }
        const draft = await page.pageController.openNewDraft();
        if (!draft) {
          return { requestId, ok: false, error: KEPT_EDITING_MESSAGE };
        }
        pendingEditorTargetRef.current = draft;
        return { requestId, ok: true };
      }

      case 'to_list': {
        const page = await getReadyPageController(requestId);
        if (!page.ok) {
          return page.response;
        }
        const left = await page.pageController.goToList();
        if (!left) {
          return { requestId, ok: false, error: KEPT_EDITING_MESSAGE };
        }
        pendingEditorTargetRef.current = null;
        return { requestId, ok: true };
      }

      case 'get_current':
        return handleGetCurrent(requestId);

      case 'set_yaml':
        return handleApplyYaml(requestId, request.yaml);

      case 'prepare_save':
        return handlePrepareSave(requestId);

      case 'adopt_saved':
        return handleAdoptSaved(request);

      default: {
        // Exhaustiveness guard for the current union shape.
        const _exhaustive: never = request;
        void _exhaustive;
        return {
          requestId,
          ok: false,
          error: 'Unsupported pipeline-editor renderer-tool request.',
        };
      }
    }
  }

  function handleGetCurrent(
    requestId: string,
  ): Promise<PipelineEditorRendererToolResponse> {
    return withReadyEditorController(requestId, (readyEditorController) => {
      const editor = readyEditorController.getEditor();
      if (readyEditorController.isRawMode()) {
        const rawError = readyEditorController.getRawYamlError();
        const rawYamlText = readyEditorController.getRawYamlText();
        const rawValidation:
          | { success: true; pipeline: Pipeline }
          | { success: false; error: string } =
          rawError !== null
            ? { success: false, error: rawError }
            : tryParseAndValidateYaml(rawYamlText);
        return {
          requestId,
          ok: true,
          pipelineYaml: rawYamlText,
          isDirty: readyEditorController.isRawYamlDirty() || editor.isDirty,
          validation: rawValidation.success
            ? toValidationIssues(rawValidation.pipeline)
            : [{ type: 'error', path: '', message: rawValidation.error }],
          readonly: editor.readonly,
        };
      }

      return {
        requestId,
        ok: true,
        pipelineYaml: serializePipelineToYaml(editor.pipeline as Pipeline),
        isDirty: editor.isDirty,
        validation: editor.validation.map((issue) => ({
          type: issue.type,
          path: issue.path,
          message: issue.message,
        })),
        readonly: editor.readonly,
      };
    });
  }

  async function withReadyEditorController(
    requestId: string,
    handleReady: (
      editorController: PipelineEditorControllerAdapter,
    ) =>
      | PipelineEditorRendererToolResponse
      | Promise<PipelineEditorRendererToolResponse>,
  ): Promise<PipelineEditorRendererToolResponse> {
    const ready = await waitForReadyEditorController(requestId);
    if (!ready.ok) {
      return ready.response;
    }
    return handleReady(ready.editorController);
  }

  /**
   * Keeps the draft main will save and describes it: which pipeline it
   * saves over and the revision this editor loaded, the save's precondition.
   */
  function forgetSnapshot(id: string): RememberedSnapshot | undefined {
    const remembered = snapshotsRef.current.get(id);
    snapshotsRef.current.delete(id);
    remembered?.release();
    return remembered;
  }

  /**
   * Holds the editor's save guard and keeps the draft main will save, so no
   * other save overlaps it. Null when a save is already running.
   */
  function rememberSnapshot(
    editorController: PipelineEditorControllerAdapter,
    pipeline: Pipeline,
    rawYamlText?: string,
    retitledFrom?: RememberedSnapshot['retitledFrom'],
  ): PipelineEditorSaveSnapshot | null {
    const editor = editorController.getEditor();
    const releaseHold = editor.holdSave();
    if (!releaseHold) return null;
    const id = crypto.randomUUID();
    const target = editorController.getTarget();
    const info = editor.pipelineInfo;
    const timer = setTimeout(() => forgetSnapshot(id), SAVE_HOLD_TIMEOUT_MS);
    snapshotsRef.current.set(id, {
      controller: editorController,
      target,
      ...(info ? { loaded: { id: info.id, source: info.source } } : {}),
      pipeline,
      ...(rawYamlText === undefined ? {} : { rawYamlText }),
      ...(retitledFrom === undefined ? {} : { retitledFrom }),
      release: (): void => {
        clearTimeout(timer);
        releaseHold();
      },
    });
    while (snapshotsRef.current.size > MAX_REMEMBERED_SNAPSHOTS) {
      const oldest = snapshotsRef.current.keys().next().value;
      if (oldest === undefined) break;
      forgetSnapshot(oldest);
    }
    return {
      id,
      target: {
        ...(info?.id ? { persistedId: info.id } : {}),
        ...(info?.source ? { source: info.source } : {}),
        ...(info?.revision === undefined ? {} : { revision: info.revision }),
        ...(target.sharedRemoteId
          ? { sharedRemoteId: target.sharedRemoteId }
          : {}),
      },
      pipeline,
    };
  }

  /**
   * The window's half of an agent save: the draft for main to save, or, when
   * another save is running, today's refusal.
   */
  function toSave(
    state: Pick<
      PipelineEditorRendererToolResponse,
      'requestId' | 'pipelineYaml' | 'isDirty' | 'validation'
    >,
    editorController: PipelineEditorControllerAdapter,
    draft: Pipeline,
    draftYamlText?: string,
  ): PipelineEditorRendererToolResponse {
    // A renamed Orchestrator workflow's new entries take its new name
    // (CAN-5782). Main saves the retitled draft and the agent's result shows
    // it; the editor shows it once the save is adopted.
    const editor = editorController.getEditor();
    const info = editor.pipelineInfo;
    const pipeline =
      info?.source === 'user'
        ? retitleChatAutomationEntry(draft, editor.retitleFromNames())
        : draft;
    const retitled = pipeline !== draft && info !== null;
    // The raw text the editor shows, clean or not, so adoption can retitle
    // it too.
    const shownYamlText =
      draftYamlText ??
      (editorController.isRawMode()
        ? editorController.getRawYamlText()
        : undefined);
    const snapshot = retitled
      ? rememberSnapshot(editorController, pipeline, undefined, {
          draft,
          previousNames: editor.retitleFromNames(),
          ...(shownYamlText === undefined
            ? {}
            : { rawYamlText: shownYamlText }),
        })
      : rememberSnapshot(editorController, pipeline, draftYamlText);
    if (!snapshot)
      return {
        ...state,
        ok: false,
        error: editor.error ?? SAVE_BUSY_MESSAGE,
        readonly: false,
      };
    return {
      ...state,
      ...(retitled
        ? {
            pipelineYaml: serializePipelineToYaml(pipeline),
            validation: toValidationIssues(pipeline),
          }
        : {}),
      ok: true,
      readonly: false,
      snapshot,
    };
  }

  /** Applies the agent's YAML to the editor. Main saves it (CAN-5822). */
  async function handleApplyYaml(
    requestId: string,
    yamlText: string,
  ): Promise<PipelineEditorRendererToolResponse> {
    return withReadyEditorController(requestId, (readyEditorController) => {
      const editor = readyEditorController.getEditor();
      if (editor.readonly) {
        return {
          requestId,
          ok: false,
          error: READONLY_MESSAGE,
          readonly: true,
        };
      }

      const result = tryParseAndValidateYaml(yamlText);
      if (!result.success) {
        // Parse/validation failure: report it without mutating the editor.
        return {
          requestId,
          ok: false,
          error: result.error,
          readonly: false,
        };
      }

      editor.replaceEntirePipeline(result.pipeline);
      // Keep the visible raw textarea in sync so a later view-switch does not
      // clobber the agent's change with a stale competing edit.
      if (readyEditorController.isRawMode()) {
        readyEditorController.setRawYamlText(yamlText);
        readyEditorController.clearRawYamlError();
        readyEditorController.resetRawYamlBaseline(yamlText);
      }

      // The parsed pipeline, not the editor's: React has not re-rendered
      // the replacement yet.
      return toSave(
        {
          requestId,
          pipelineYaml: serializePipelineToYaml(result.pipeline),
          isDirty: true,
          validation: toValidationIssues(result.pipeline),
        },
        readyEditorController,
        result.pipeline,
        readyEditorController.isRawMode() ? yamlText : undefined,
      );
    });
  }

  /** Hands main the draft to save, applying a dirty raw buffer first. */
  async function handlePrepareSave(
    requestId: string,
  ): Promise<PipelineEditorRendererToolResponse> {
    return withReadyEditorController(requestId, (readyEditorController) => {
      const editor = readyEditorController.getEditor();
      if (editor.readonly) {
        return {
          requestId,
          ok: false,
          error: READONLY_MESSAGE,
          readonly: true,
        };
      }
      if (editor.saving) {
        return {
          requestId,
          ok: false,
          error: editor.error ?? SAVE_BUSY_MESSAGE,
          isDirty: editor.isDirty,
          readonly: false,
        };
      }

      // Raw mode with unsaved buffer edits: validate and apply the buffer
      // first (mirrors the editor session's save).
      if (
        readyEditorController.isRawMode() &&
        readyEditorController.isRawYamlDirty()
      ) {
        const rawText = readyEditorController.getRawYamlText();
        if (!readyEditorController.applyRawYaml()) {
          return {
            requestId,
            ok: false,
            error:
              readyEditorController.getRawYamlError() ??
              'Failed to apply raw pipeline YAML.',
          };
        }
        const result = tryParseAndValidateYaml(rawText);
        if (!result.success) {
          return { requestId, ok: false, error: result.error };
        }
        return toSave(
          {
            requestId,
            pipelineYaml: serializePipelineToYaml(result.pipeline),
            isDirty: true,
            validation: toValidationIssues(result.pipeline),
          },
          readyEditorController,
          result.pipeline,
          rawText,
        );
      }

      const { pipeline } = editor;
      if (!pipeline) {
        return { requestId, ok: false, error: NO_PIPELINE_LOADED_MESSAGE };
      }
      return toSave(
        {
          requestId,
          pipelineYaml: serializePipelineToYaml(pipeline),
          validation: toValidationIssues(pipeline),
          isDirty: editor.isDirty,
        },
        readyEditorController,
        pipeline,
      );
    });
  }

  /**
   * Shows what core saved as the editor's saved state, when the editor still
   * shows the pipeline it was saved from. Edits made since stay unsaved.
   */
  function handleAdoptSaved(
    request: Extract<
      PipelineEditorRendererToolRequest,
      { kind: 'adopt_saved' }
    >,
  ): PipelineEditorRendererToolResponse {
    const { requestId, saved } = request;
    // Main reports every save it ran, so the save guard is freed either way.
    const remembered = forgetSnapshot(request.snapshotId);
    const editorController =
      usePipelineEditorBridgeStore.getState().editorController;
    // Only the editor that handed over the draft, still showing the same
    // pipeline from the same source, adopts what core saved for it.
    const shown = editorController?.getEditor().pipelineInfo;
    if (
      !saved ||
      !remembered ||
      editorController !== remembered.controller ||
      !targetsMatch(editorController.getTarget(), remembered.target) ||
      shown?.id !== remembered.loaded?.id ||
      shown?.source !== remembered.loaded?.source
    ) {
      return { requestId, ok: true };
    }
    const info =
      saved.kind === 'stored'
        ? saved.info
        : sharedDetailToPipelineInfo(saved.detail);
    // A retitled save shows its new title in the editor: all of the saved
    // draft while the editor still holds it, else only the entry title, so
    // edits made since stay unsaved but can't write the old title back.
    const { retitledFrom } = remembered;
    const editor = editorController.getEditor();
    let deferRetitleFrom: readonly string[] | null = null;
    let retitledDraft: Pipeline | undefined;
    const current = editor.pipeline;
    if (retitledFrom !== undefined && current !== null) {
      const unchanged =
        JSON.stringify(current) === JSON.stringify(retitledFrom.draft);
      const next = unchanged
        ? remembered.pipeline
        : // The title the save stored, even if the draft was renamed since.
          retitleChatAutomationEntry(
            current,
            retitledFrom.previousNames,
            info.name,
          );
      if (next !== current) retitledDraft = next;
      // The raw text as it was handed over, or as Raw view first showed the
      // draft when it opened during the save, becomes the retitled text.
      // Text typed since keeps every edit, with only the title line moved.
      const rawText = editorController.getRawYamlText();
      if (editorController.isRawMode()) {
        if (
          rawText === retitledFrom.rawYamlText ||
          rawText === serializePipelineToYaml(current)
        ) {
          const text = serializePipelineToYaml(next);
          editorController.setRawYamlText(text);
          if (unchanged) editorController.resetRawYamlBaseline(text);
        } else {
          const typed = retitleRawYaml(
            rawText,
            retitledFrom.previousNames,
            info.name,
          );
          // Text that can't be retitled now is retitled by its next save.
          if (typed === null) deferRetitleFrom = retitledFrom.previousNames;
          else editorController.setRawYamlText(typed);
        }
      }
    }
    editorController.adoptSaved(remembered.pipeline, info, retitledDraft);
    if (deferRetitleFrom !== null) editor.deferRetitleFrom(deferRetitleFrom);
    if (
      remembered.rawYamlText !== undefined &&
      editorController.isRawMode() &&
      editorController.getRawYamlText() === remembered.rawYamlText
    ) {
      editorController.resetRawYamlBaseline(remembered.rawYamlText);
    }
    return { requestId, ok: true };
  }

  function cacheResponse(
    cacheKey: string,
    response: PipelineEditorRendererToolResponse,
  ): void {
    responseCacheRef.current.set(cacheKey, response);
    if (responseCacheRef.current.size > 100) {
      const firstKey = responseCacheRef.current.keys().next().value;
      if (firstKey !== undefined) {
        responseCacheRef.current.delete(firstKey);
      }
    }
  }

  function getReadyEditorController(
    requestId: string,
    editorController: PipelineEditorControllerAdapter | null,
  ):
    | { ok: true; editorController: PipelineEditorControllerAdapter }
    | { ok: false; response: PipelineEditorRendererToolResponse } {
    if (!editorController) {
      return {
        ok: false,
        response: {
          requestId,
          ok: false,
          error: pendingEditorTargetRef.current
            ? NO_PIPELINE_LOADED_MESSAGE
            : NO_EDITOR_MESSAGE,
        },
      };
    }

    const pendingTarget = pendingEditorTargetRef.current;
    if (pendingTarget) {
      if (!targetsMatch(editorController.getTarget(), pendingTarget)) {
        return {
          ok: false,
          response: {
            requestId,
            ok: false,
            error: NO_PIPELINE_LOADED_MESSAGE,
          },
        };
      }

      const editor = editorController.getEditor();
      if (editor.loading) {
        return {
          ok: false,
          response: {
            requestId,
            ok: false,
            error: NO_PIPELINE_LOADED_MESSAGE,
          },
        };
      }
      if (!editor.pipeline) {
        pendingEditorTargetRef.current = null;
        return {
          ok: false,
          response: {
            requestId,
            ok: false,
            error: editor.error ?? 'Failed to load the requested pipeline.',
          },
        };
      }
      pendingEditorTargetRef.current = null;
    }

    const editor = editorController.getEditor();
    if (editor.loading || !editor.pipeline) {
      return {
        ok: false,
        response: { requestId, ok: false, error: NO_PIPELINE_LOADED_MESSAGE },
      };
    }

    return { ok: true, editorController };
  }

  async function getReadyPageController(
    requestId: string,
  ): Promise<
    | { ok: true; pageController: PipelineEditorPageController }
    | { ok: false; response: PipelineEditorRendererToolResponse }
  > {
    const current = usePipelineEditorBridgeStore.getState().pageController;
    if (current) {
      return { ok: true, pageController: current };
    }

    useNavigationStore.getState().navigate('workflows-library');

    const pageController = await waitForBridgeState(
      (state) => state.pageController,
      PAGE_CONTROLLER_TIMEOUT_MS,
    );
    if (!pageController) {
      return {
        ok: false,
        response: {
          requestId,
          ok: false,
          error: `${NO_PAGE_MESSAGE} Timed out waiting for it to mount.`,
        },
      };
    }
    return { ok: true, pageController };
  }

  async function waitForReadyEditorController(
    requestId: string,
  ): Promise<
    | { ok: true; editorController: PipelineEditorControllerAdapter }
    | { ok: false; response: PipelineEditorRendererToolResponse }
  > {
    const initial = getReadyEditorController(
      requestId,
      usePipelineEditorBridgeStore.getState().editorController,
    );
    if (initial.ok || initial.response.error !== NO_PIPELINE_LOADED_MESSAGE) {
      return initial;
    }
    if (!pendingEditorTargetRef.current) {
      return initial;
    }

    useNavigationStore.getState().navigate('workflows-library');

    const ready = await waitForBridgeCondition(() => {
      const next = getReadyEditorController(
        requestId,
        usePipelineEditorBridgeStore.getState().editorController,
      );
      return next.ok || next.response.error !== NO_PIPELINE_LOADED_MESSAGE
        ? next
        : null;
    }, EDITOR_CONTROLLER_TIMEOUT_MS);

    return (
      ready ?? {
        ok: false,
        response: {
          requestId,
          ok: false,
          error: NO_PIPELINE_LOADED_MESSAGE,
        },
      }
    );
  }
}

function targetsMatch(
  current: PipelineEditorControllerTarget,
  expected: PipelineEditorControllerTarget,
): boolean {
  return (
    current.pipelineId === expected.pipelineId &&
    current.draftKey === expected.draftKey &&
    current.cwd === expected.cwd &&
    current.pipelineFilePath === expected.pipelineFilePath &&
    current.sharedRemoteId === expected.sharedRemoteId
  );
}

function waitForBridgeState<T>(
  select: (state: PipelineEditorBridgeState) => T | null,
  timeoutMs: number,
): Promise<T | null> {
  return waitForBridgeCondition(
    () => select(usePipelineEditorBridgeStore.getState()),
    timeoutMs,
  );
}

function waitForBridgeCondition<T>(
  select: () => T | null,
  timeoutMs: number,
): Promise<T | null> {
  const current = select();
  if (current) {
    return Promise.resolve(current);
  }

  return new Promise((resolve) => {
    let done = false;
    let interval: ReturnType<typeof setInterval> | null = null;
    const finish = (value: T | null): void => {
      if (done) return;
      done = true;
      if (interval !== null) {
        clearInterval(interval);
      }
      clearTimeout(timer);
      unsubscribe();
      resolve(value);
    };
    const check = (): void => {
      const next = select();
      if (next) {
        finish(next);
      }
    };
    const unsubscribe = usePipelineEditorBridgeStore.subscribe(check);
    const timer = setTimeout(() => finish(null), timeoutMs);
    interval = setInterval(check, BRIDGE_WAIT_INTERVAL_MS);
    check();
  });
}
