import type { PipelineSaveInput } from '@canopy/execution-engine/types/pipeline';
import type * as PipelineDefinitionDispatch from '../../canopy-runtime/pipeline-definition-dispatch';

let mockBoundTools: readonly string[] = [];
jest.mock('../../agents/session-manager', () => ({
  getActiveSessionCapabilityProfile: (): {
    interfaceTools: readonly string[];
  } => ({ interfaceTools: mockBoundTools }),
}));

const mockInstruction = jest.fn<
  Promise<unknown>,
  [string, Record<string, unknown>]
>();
jest.mock('../../canopy-runtime/desktop-runtime-access', () => ({
  getDesktopCanopyRuntime: (): { instruction: jest.Mock } => ({
    instruction: mockInstruction,
  }),
}));
jest.mock('../../pipelines/pipeline-service', () => ({
  getStoredPipelineBySource: (): { success: false } => ({ success: false }),
}));
jest.mock('../../pipelines/pipeline-local-metadata-store', () => ({
  readPipelineLocalMetadata: (): object => ({}),
}));
// The editor's Save button path: the owner rules around it are unchanged by
// CAN-5822; the write itself is the canonical upsert.
jest.mock('../../pipelines/pipeline-handlers', () => ({
  saveEditorPipeline: (input: PipelineSaveInput): unknown =>
    jest
      .requireActual<
        typeof PipelineDefinitionDispatch
      >('../../canopy-runtime/pipeline-definition-dispatch')
      .saveUserPipeline({
        ...(input.id ? { id: input.id } : {}),
        ...(input.expectedRevision === undefined
          ? {}
          : { expectedRevision: input.expectedRevision }),
        name: input.name,
        description: input.description,
        icon: input.icon,
        content: input.content,
      }),
  updateSharedPipelineFromEditor: jest.fn(),
}));

import {
  InterfaceToolRegistry,
  type InterfaceToolCall,
} from '@canopy/core-runtime/node/client';
import { CanopyOperationError } from '@canopy/core-runtime';
import {
  interfaceToolDescriptor,
  INTERFACE_TOOL_NAMES,
  type InterfaceToolName,
} from '@canopy/protocol/canopy-core';
import {
  PIPELINE_EDITOR_PROJECT_ID,
  PIPELINE_EDITOR_WORKTREE_ID,
} from '@canopy/desktop-shared/types';
import type { Pipeline } from '@canopy/execution-engine/types/pipeline';
import { setSessionInterfaceToolRegistry } from '../../agents/interface-tool-binding';
import { pipelineEditorSurfaceUnavailableResponse } from '../../ipc/pipeline-editor';
import { buildPipelineEditorDynamicToolSpecs } from '../codex-dynamic-tools';
import { executePipelineEditorTool } from '../tool-executor';
import {
  createPipelineEditorToolRuntime,
  type PipelineEditorToolRuntime,
} from '../runtime';

const EDITOR_TOOLS: readonly InterfaceToolName[] = INTERFACE_TOOL_NAMES.filter(
  (name) => name.startsWith('ui.pipeline_editor.'),
);
const CHAT_ID = 'editor-chat';

type Responder = (call: InterfaceToolCall) => Record<string, unknown> | null;

interface Lease {
  registry: InterfaceToolRegistry;
  calls: InterfaceToolCall[];
}

/** The main window's lease; `respond` answers each delivered call, or leaves it pending with null. */
function mainWindowLease(respond: Responder): Lease {
  const registry = new InterfaceToolRegistry();
  const calls: InterfaceToolCall[] = [];
  registry.openLease(
    { leaseId: 'main-1', surface: 'main', interfaceKind: 'desktop' },
    {
      deliver: (call) => {
        calls.push(call);
        const reply = respond(call);
        if (reply)
          queueMicrotask(() =>
            registry.reply('main-1', call.callId, {
              requestId: call.callId,
              ...reply,
            }),
          );
        return true;
      },
      cancel: () => undefined,
    },
  );
  registry.register('main-1', {
    tools: EDITOR_TOOLS.map((name) => interfaceToolDescriptor(name)),
    _meta: { idempotencyKey: 'main-tools' },
  });
  setSessionInterfaceToolRegistry(registry);
  return { registry, calls };
}

function runtime(
  getMainWindow = jest.fn((): null => null),
): PipelineEditorToolRuntime {
  return createPipelineEditorToolRuntime(
    { getMainWindow },
    {
      projectId: PIPELINE_EDITOR_PROJECT_ID,
      worktreeId: PIPELINE_EDITOR_WORKTREE_ID,
      chatId: CHAT_ID,
      providerType: 'claude',
    },
  );
}

const draft: Pipeline = {
  name: 'Nightly',
  description: 'Runs at night',
  icon: 'moon',
  on: 'dispatch',
  jobs: { build: { steps: [{ run: 'echo hi' }] } },
} as unknown as Pipeline;

function definition(revision: number): object {
  return {
    definition: {
      definitionId: 'pipe-1',
      name: 'Nightly',
      description: 'Runs at night',
      icon: 'moon',
      revision,
      triggerTypes: ['dispatch'],
      executionScopes: ['worktree'],
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-08T00:00:00.000Z',
    },
  };
}

function saveReply(snapshotId = 'snap-1'): Record<string, unknown> {
  return {
    ok: true,
    originChatId: CHAT_ID,
    pipelineYaml: 'name: Nightly\n',
    isDirty: true,
    validation: [],
    readonly: false,
    snapshot: {
      id: snapshotId,
      target: { persistedId: 'pipe-1', source: 'user', revision: 4 },
      pipeline: draft,
    },
  };
}

beforeEach(() => {
  mockBoundTools = EDITOR_TOOLS;
  mockInstruction.mockReset();
});
afterEach(() => setSessionInterfaceToolRegistry(null));

describe('pipeline editor tools through the interface lease (CAN-5822)', () => {
  it('every editor tool reaches the window only through its lease', async () => {
    const getMainWindow = jest.fn((): null => null);
    const lease = mainWindowLease((call) => ({
      ok: true,
      originChatId: call.input.originChatId,
      ...(call.toolName === 'ui.pipeline_editor.list' ? { pipelines: [] } : {}),
    }));
    const editor = runtime(getMainWindow);
    const locator = { pipelineId: 'pipe-1' };
    const results = [
      await editor.dispatchEditorAction({ type: 'pipeline.list' }, 'r-list'),
      await editor.dispatchEditorAction(
        { type: 'pipeline.open', locator },
        'r-open',
      ),
      await editor.dispatchEditorAction({ type: 'pipeline.create' }, 'r-new'),
      await editor.requestEditorState('r-state'),
      await editor.dispatchEditorAction(
        { type: 'navigation.to_list' },
        'r-list-view',
      ),
    ];
    expect(lease.calls.map((call) => call.toolName)).toEqual([
      'ui.pipeline_editor.list',
      'ui.pipeline_editor.open',
      'ui.pipeline_editor.create',
      'ui.pipeline_editor.get_current',
      'ui.pipeline_editor.to_list',
    ]);
    expect(lease.calls[1]?.input).toEqual({ locator, originChatId: CHAT_ID });
    expect(results.map((result) => result.requestId)).toEqual([
      'r-list',
      'r-open',
      'r-new',
      'r-state',
      'r-list-view',
    ]);
    for (const result of results) {
      expect(result.ok).toBe(true);
      expect(result.originChatId).toBe(CHAT_ID);
    }
    expect(getMainWindow).not.toHaveBeenCalled();
  });

  it('an unbound session never reaches the registry', async () => {
    const lease = mainWindowLease(() => ({ ok: true }));
    mockBoundTools = [];
    const result = await executePipelineEditorTool(
      'pipeline_get_current',
      {},
      runtime(),
      { toolUseId: 'tool-1' },
    );
    expect(lease.calls).toEqual([]);
    expect(JSON.parse(result.text)).toEqual(
      pipelineEditorSurfaceUnavailableResponse('tool-1'),
    );
    expect(result.isError).toBe(true);
  });

  it('with no lease the editor tools and SavePipeline are absent and the other tools remain', () => {
    const names = (interfaceTools: readonly InterfaceToolName[]): string[] =>
      buildPipelineEditorDynamicToolSpecs({ interfaceTools }).map(
        (spec) => spec.name,
      );
    const all = names(EDITOR_TOOLS);
    const unbound = names([]);
    expect(all).toHaveLength(15);
    expect(
      unbound.map((name) => name.replace(/^.*_pipeline_editor_/, '')),
    ).toEqual([
      'ask_user_question',
      'pipeline_get_action_definition',
      'automation_list',
      'automation_get',
      'automation_create',
      'automation_update',
      'search_deferred_tools',
      'load_deferred_tools',
    ]);
    expect(all.filter((name) => unbound.includes(name))).toEqual(unbound);
    // SavePipeline needs both halves of a save.
    expect(
      names(['ui.pipeline_editor.prepare_save']).some((name) =>
        name.endsWith('_pipeline_save'),
      ),
    ).toBe(false);
  });

  it("an agent save writes through the canonical upsert with the editor's loaded revision", async () => {
    mockInstruction.mockResolvedValue(definition(5));
    const lease = mainWindowLease((call) =>
      call.toolName === 'ui.pipeline_editor.prepare_save'
        ? saveReply()
        : { ok: true },
    );
    const result = await runtime().dispatchEditorAction(
      { type: 'pipeline.save' },
      'r-save',
    );
    expect(mockInstruction).toHaveBeenCalledTimes(1);
    const [operation, params] = mockInstruction.mock.calls[0] ?? [];
    expect(operation).toBe('core.pipeline.definition.upsert');
    expect(params).toMatchObject({
      definitionId: 'pipe-1',
      expectedRevision: 4,
      source: 'user',
      document: { pipeline: draft },
    });
    expect(lease.calls.map((call) => call.toolName)).toEqual([
      'ui.pipeline_editor.prepare_save',
      'ui.pipeline_editor.adopt_saved',
    ]);
    expect(lease.calls[1]?.input).toMatchObject({
      snapshotId: 'snap-1',
      saved: { kind: 'stored', info: { id: 'pipe-1', revision: 5 } },
    });
    expect(result).toEqual({
      requestId: 'r-save',
      ok: true,
      originChatId: CHAT_ID,
      pipelineYaml: 'name: Nightly\n',
      isDirty: false,
      validation: [],
      readonly: false,
    });
  });

  it('SetPipelineYaml applies in the window and saves the applied draft through core', async () => {
    mockInstruction.mockResolvedValue(definition(5));
    const lease = mainWindowLease((call) =>
      call.toolName === 'ui.pipeline_editor.set_yaml'
        ? saveReply('snap-yaml')
        : { ok: true },
    );
    const result = await runtime().dispatchEditorAction(
      { type: 'pipeline.set_yaml', yaml: 'name: Nightly\n' },
      'r-yaml',
    );
    expect(lease.calls[0]?.input).toEqual({
      yaml: 'name: Nightly\n',
      originChatId: CHAT_ID,
    });
    expect(mockInstruction.mock.calls[0]?.[1]).toMatchObject({
      expectedRevision: 4,
    });
    expect(lease.calls[1]?.input).toMatchObject({ snapshotId: 'snap-yaml' });
    expect(result.ok).toBe(true);
    expect(result.isDirty).toBe(false);
  });

  it('an agent save of a shared pipeline runs the pipelines:shared-update body with the draft YAML', async () => {
    const { updateSharedPipelineFromEditor } = jest.requireMock<{
      updateSharedPipelineFromEditor: jest.Mock<
        Promise<unknown>,
        [{ remoteId: string; rawPipeline: string }]
      >;
    }>('../../pipelines/pipeline-handlers');
    updateSharedPipelineFromEditor.mockResolvedValue({
      success: true,
      data: { id: 'remote-1', rawPipeline: 'pipeline:\n  name: Nightly\n' },
    });
    const reply = saveReply('snap-shared');
    const lease = mainWindowLease((call) =>
      call.toolName === 'ui.pipeline_editor.prepare_save'
        ? {
            ...reply,
            snapshot: {
              id: 'snap-shared',
              target: { sharedRemoteId: 'remote-1', source: 'shared' },
              pipeline: draft,
            },
          }
        : { ok: true },
    );
    const result = await runtime().dispatchEditorAction(
      { type: 'pipeline.save' },
      'r-shared',
    );
    // PIPELINE_CHANNELS.SHARED_UPDATE's body, not the canonical upsert.
    expect(mockInstruction).not.toHaveBeenCalled();
    const [shared] = updateSharedPipelineFromEditor.mock.calls[0] ?? [];
    expect(shared?.remoteId).toBe('remote-1');
    expect(shared?.rawPipeline).toContain('name: Nightly');
    expect(lease.calls[1]?.input).toMatchObject({
      snapshotId: 'snap-shared',
      saved: { kind: 'shared', detail: { id: 'remote-1' } },
    });
    // The share's document never rides the lease back to the window, so a
    // large pipeline stays within the lease's input limit.
    expect(JSON.stringify(lease.calls[1]?.input)).not.toContain('rawPipeline');
    expect(result.ok).toBe(true);
  });

  it('an agent save after a newer write is refused and the editor keeps its draft', async () => {
    mockInstruction.mockRejectedValue(
      new CanopyOperationError({
        kind: 'conflict',
        code: 'core.pipeline.revisionConflict',
        message: 'This workflow changed since it was loaded.',
        retry: { kind: 'after_refresh', resource: 'core.pipeline' },
      }),
    );
    const lease = mainWindowLease(() => saveReply());
    const result = await runtime().dispatchEditorAction(
      { type: 'pipeline.save' },
      'r-stale',
    );
    expect(mockInstruction.mock.calls[0]?.[1]).toMatchObject({
      expectedRevision: 4,
    });
    // The window is told the save failed, so it frees its save guard, and
    // has nothing to adopt.
    expect(lease.calls.map((call) => call.toolName)).toEqual([
      'ui.pipeline_editor.prepare_save',
      'ui.pipeline_editor.adopt_saved',
    ]);
    expect(lease.calls[1]?.input).toEqual({
      snapshotId: 'snap-1',
      originChatId: CHAT_ID,
    });
    expect(result).toEqual({
      requestId: 'r-stale',
      ok: false,
      originChatId: CHAT_ID,
      error: 'This workflow changed since it was loaded.',
      pipelineYaml: 'name: Nightly\n',
      isDirty: true,
      validation: [],
      readonly: false,
    });
  });

  it('a retried tool call joins or returns the first call and never saves twice', async () => {
    mockInstruction.mockResolvedValue(definition(5));
    const lease = mainWindowLease((call) =>
      call.toolName === 'ui.pipeline_editor.set_yaml'
        ? saveReply('snap-retry')
        : { ok: true },
    );
    const action = {
      type: 'pipeline.set_yaml',
      yaml: 'name: Nightly\n',
    } as const;
    const editor = runtime();
    const [first, joined] = await Promise.all([
      editor.dispatchEditorAction(action, 'r-retry'),
      editor.dispatchEditorAction(action, 'r-retry'),
    ]);
    const later = await runtime().dispatchEditorAction(action, 'r-retry');
    expect(joined).toEqual(first);
    expect(later).toEqual(first);
    expect(first.ok).toBe(true);
    expect(mockInstruction).toHaveBeenCalledTimes(1);
    expect(lease.calls.map((call) => call.toolName)).toEqual([
      'ui.pipeline_editor.set_yaml',
      'ui.pipeline_editor.adopt_saved',
    ]);
  });

  it('a draft naming an invalid pipeline or share id is refused before any save', async () => {
    for (const [index, target] of [
      { persistedId: '../user-pipeline', source: 'user', revision: 4 },
      { sharedRemoteId: 'remote/1', source: 'shared' },
    ].entries()) {
      const lease = mainWindowLease(() => ({
        ...saveReply(),
        snapshot: { id: 'snap-1', target, pipeline: draft },
      }));
      const result = await runtime().dispatchEditorAction(
        { type: 'pipeline.save' },
        `r-invalid-${index}`,
      );
      expect(result).toEqual({
        requestId: `r-invalid-${index}`,
        ok: false,
        error: 'The window returned an invalid result.',
      });
      expect(lease.calls.map((call) => call.toolName)).toEqual([
        'ui.pipeline_editor.prepare_save',
      ]);
    }
    expect(mockInstruction).not.toHaveBeenCalled();
  });

  it("lease loss returns today's unavailable response", async () => {
    const lease = mainWindowLease(() => null);
    const pending = runtime().requestEditorState('r-gone');
    for (let tick = 0; tick < 50 && lease.calls.length === 0; tick += 1)
      await new Promise((resolve) => setImmediate(resolve));
    expect(lease.calls).toHaveLength(1);
    lease.registry.endLease('main-1');
    await expect(pending).resolves.toEqual(
      pipelineEditorSurfaceUnavailableResponse('r-gone'),
    );
  });
});
