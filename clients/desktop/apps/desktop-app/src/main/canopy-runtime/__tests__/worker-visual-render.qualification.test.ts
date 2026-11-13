import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canopyCapabilityUnavailableError } from '@canopy/core-runtime';
import {
  CANOPY_QUERY_DEFINITIONS,
  WORKER_VISUAL_GRANTS,
  WORKER_VISUAL_LIMITS,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import {
  VISUAL_PREVIEW_LIMITS,
  type VisualMeasureRequest,
  type VisualMeasureResult,
  type VisualPreviewRequest,
  type VisualPreviewResult,
} from '../../browser/visual-preview-types';
import type { StageVisualDocument } from '../../lib/chat-visual-contracts';
import { createShowVisualHost } from '../../canopy-tools/show-visual-host';
import {
  executeCanopyInjectedTool,
  type CanopyInjectedToolRuntime,
} from '../../canopy-tools/core';
import { PREVIEW_VISUAL_UNAVAILABLE_TEXT } from '../../canopy-tools/preview-visual-runtime';
import type { CoreChatVisualStageHost } from '../core-chat-visual-stage-adapter';
import { createCoreOperationAdapter } from '../core-operation-adapter';
import { INTERFACE_RELAY_ALLOWLIST } from '../renderer-relay/interface-allowlist.generated';
import type { WorkerVisualHost } from '../worker-visual-adapter';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../desktop-runtime';

const mockState = { runtime: null as DesktopCanopyDispatcher | null };

jest.mock('../desktop-runtime', () => ({
  ...jest.requireActual<Record<string, unknown>>('../desktop-runtime'),
  getActiveDesktopRuntime: (): unknown => mockState.runtime,
}));
jest.mock('../../lib/chat-visuals-feature-flag', () => ({
  isChatVisualsEnabled: (): boolean => true,
}));

const SESSION = { projectId: 'p', worktreeId: 'w', chatId: 'chat-1' };
const RENDER: CanopyCallerDescriptor = {
  principalId: 'desktop-agent-visuals',
  clientInstanceId: 'desktop-main',
  authorityId: 'local',
  interfaceKind: 'mcp',
  grants: [WORKER_VISUAL_GRANTS.render],
};
const PREPARED = {
  html: '<!doctype html><html><body><h1>Chart</h1></body></html>',
};
/** What the service gets: the document, never the caller's host paths. */
const SERVED = { ...PREPARED, unresolvedImagePaths: [] };

/** What the offscreen service answers for one preview; the fixture under test. */
const PREVIEW: VisualPreviewResult = {
  status: 'ok',
  image: {
    dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
    mime: 'image/png',
    width: 720,
    height: 410,
    bytes: 8,
  },
  contentHeight: 410,
  capturedHeight: 410,
  console: [
    { level: 'warning', message: 'untrusted', line: 3, source: 'about:srcdoc' },
    { level: 'log', message: 'no line' },
  ],
  cspViolations: [{ directive: 'img-src', blockedUri: 'https://x.test/a' }],
  blockedRequests: ['https://x.test/a'],
  omitted: { console: 2, cspViolations: 0, blockedRequests: 1 },
  timing: { queuedMs: 1, loadMs: 2, settleMs: 3, captureMs: 4, totalMs: 10 },
};

interface Recorded {
  measure: VisualMeasureRequest[];
  preview: VisualPreviewRequest[];
}

let root: string;
let recorded: Recorded;
let staged: StageVisualDocument[];
let measureAnswer: (
  request: VisualMeasureRequest,
) => Promise<VisualMeasureResult>;
let previewAnswer: (
  request: VisualPreviewRequest,
) => Promise<VisualPreviewResult>;

const renderHost: WorkerVisualHost = {
  measure: (request) => {
    recorded.measure.push(request);
    return measureAnswer(request);
  },
  preview: (request) => {
    recorded.preview.push(request);
    return previewAnswer(request);
  },
};
const stageHost: CoreChatVisualStageHost = {
  stage: (_target, document) => {
    staged.push(document);
    return Promise.resolve({
      visualId: document.visualId,
      byteLength: document.html.length,
      sha256: '0'.repeat(64),
    } as never);
  },
};

function session(): CanopyInjectedToolRuntime {
  return {
    showVisual: createShowVisualHost({ ...SESSION, cwd: root }),
  } as CanopyInjectedToolRuntime;
}

function query(
  params: unknown,
  caller: CanopyCallerDescriptor = RENDER,
  signal?: AbortSignal,
): Promise<unknown> {
  const runtime = mockState.runtime;
  if (!runtime) throw new Error('No runtime.');
  return (
    runtime.query as unknown as (
      name: string,
      params: unknown,
      options: { caller: CanopyCallerDescriptor; signal?: AbortSignal },
    ) => Promise<unknown>
  )('worker.visual.render', params, { caller, ...(signal ? { signal } : {}) });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'visual-render-'));
  recorded = { measure: [], preview: [] };
  staged = [];
  measureAnswer = (request): Promise<VisualMeasureResult> =>
    Promise.resolve({
      status: 'ok',
      heights: request.widths.map((width): [number, number] => [
        width,
        Math.round(100000 / width),
      ]),
    });
  previewAnswer = (): Promise<VisualPreviewResult> => Promise.resolve(PREVIEW);
  mockState.runtime = createDesktopRuntime({
    operationAdapter: createCoreOperationAdapter({
      ledgerPath: () => join(root, 'ledger.sqlite'),
    }),
    visualStageHost: stageHost,
    visualRenderHost: renderHost,
    shutdownTimeoutMs: 25,
  });
});
afterEach(async () => {
  await mockState.runtime?.shutdown();
  mockState.runtime = null;
  rmSync(root, { recursive: true, force: true });
});

describe('worker.visual.render on the desktop dispatcher (CAN-6040)', () => {
  it('answers what the offscreen service answers, for both modes, and hands it the same request', async () => {
    await expect(
      query({
        scope: {},
        mode: 'measure',
        prepared: PREPARED,
        appearance: 'dark',
        maxHeight: 600,
        widths: [360, 720],
        deadlineMs: 3000,
      }),
    ).resolves.toEqual({
      mode: 'measure',
      status: 'ok',
      heights: [
        [360, 278],
        [720, 139],
      ],
    });
    await expect(
      query({
        scope: {},
        mode: 'preview',
        prepared: PREPARED,
        width: 720,
        imageBudgetBytes: 256 * 1024,
      }),
    ).resolves.toEqual({ mode: 'preview', ...PREVIEW });

    const [measure] = recorded.measure;
    expect({ ...measure, signal: undefined }).toEqual({
      prepared: SERVED,
      appearance: 'dark',
      maxHeight: 600,
      widths: [360, 720],
      deadlineMs: 3000,
      signal: undefined,
    });
    expect(measure?.signal).toBeInstanceOf(AbortSignal);
    const [preview] = recorded.preview;
    expect({ ...preview, signal: undefined }).toEqual({
      prepared: SERVED,
      width: 720,
      imageBudgetBytes: 256 * 1024,
      signal: undefined,
    });
  });

  it.each(['busy', 'timeout', 'aborted', 'error'] as const)(
    'passes a %s run through as a result, not an error',
    async (status) => {
      measureAnswer = (): Promise<VisualMeasureResult> =>
        Promise.resolve({ status, heights: [] });
      previewAnswer = (): Promise<VisualPreviewResult> =>
        Promise.resolve({
          ...PREVIEW,
          status,
          image: null,
          contentHeight: 0,
          capturedHeight: 0,
        });
      await expect(
        query({
          scope: {},
          mode: 'measure',
          prepared: PREPARED,
          maxHeight: 600,
          widths: [360],
          deadlineMs: 3000,
        }),
      ).resolves.toEqual({ mode: 'measure', status, heights: [] });
      await expect(
        query({
          scope: {},
          mode: 'preview',
          prepared: PREPARED,
          width: 720,
          imageBudgetBytes: 0,
        }),
      ).resolves.toMatchObject({ mode: 'preview', status, image: null });
    },
  );

  it("aborts the service's run when the caller cancels", async () => {
    let seen: AbortSignal | undefined;
    previewAnswer = (request): Promise<VisualPreviewResult> =>
      new Promise((resolve) => {
        seen = request.signal;
        request.signal?.addEventListener('abort', () =>
          resolve({ ...PREVIEW, status: 'aborted' }),
        );
      });
    const controller = new AbortController();
    const call = query(
      {
        scope: {},
        mode: 'preview',
        prepared: PREPARED,
        width: 720,
        imageBudgetBytes: 0,
      },
      RENDER,
      controller.signal,
    );
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    await expect(call).rejects.toMatchObject({
      payload: { kind: 'cancelled' },
    });
    expect(seen?.aborted).toBe(true);
  });

  it('takes no host path: a request carrying unresolved image paths is refused', async () => {
    await expect(
      query({
        scope: {},
        mode: 'measure',
        prepared: {
          ...PREPARED,
          unresolvedImagePaths: ['/Users/x/missing.png'],
        },
        maxHeight: 600,
        widths: [360],
        deadlineMs: 3000,
      }),
    ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });
    expect(recorded.measure).toEqual([]);
  });

  it('refuses a caller without worker.visual.render before the service runs', async () => {
    await expect(
      query(
        {
          scope: {},
          mode: 'measure',
          prepared: PREPARED,
          maxHeight: 600,
          widths: [360],
          deadlineMs: 3000,
        },
        { ...RENDER, grants: ['core.chat.write'] },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
    expect(recorded.measure).toEqual([]);
  });

  it('keeps worker.visual.render off every renderer relay surface and out of the daemon registry', () => {
    for (const mode of Object.values(INTERFACE_RELAY_ALLOWLIST))
      for (const operations of Object.values(mode))
        expect(
          operations.filter((name) => name.startsWith('worker.visual.')),
        ).toEqual([]);
    expect(Object.keys(CANOPY_QUERY_DEFINITIONS)).not.toContain(
      'worker.visual.render',
    );
  });

  it("matches the offscreen service's limits", () => {
    expect(WORKER_VISUAL_LIMITS).toMatchObject({
      minWidth: VISUAL_PREVIEW_LIMITS.minWidth,
      maxWidth: VISUAL_PREVIEW_LIMITS.maxWidth,
      maxHeight: VISUAL_PREVIEW_LIMITS.captureMaxHeight,
      measureDeadlineMs: VISUAL_PREVIEW_LIMITS.measureDeadlineMs,
      diagnostics: {
        console: VISUAL_PREVIEW_LIMITS.diagnostics.console,
        cspViolations: VISUAL_PREVIEW_LIMITS.diagnostics.cspViolations,
        blockedRequests: VISUAL_PREVIEW_LIMITS.diagnostics.blockedRequests,
      },
    });
    expect(VISUAL_PREVIEW_LIMITS.measureWidths.length).toBeLessThanOrEqual(
      WORKER_VISUAL_LIMITS.measureWidths,
    );
  });
});

describe('ShowVisual and PreviewVisual render through worker.visual.render (CAN-6040)', () => {
  it('ShowVisual stages the heights the operation measured', async () => {
    const result = await executeCanopyInjectedTool(
      'show_visual',
      { html: PREPARED.html, title: 'Chart', height: 400 },
      session(),
    );
    expect(result.isError).toBeUndefined();
    expect(recorded.measure.map((request) => request.widths)).toEqual([
      [...VISUAL_PREVIEW_LIMITS.measureWidths],
    ]);
    expect(staged[0]?.heights).toEqual(
      VISUAL_PREVIEW_LIMITS.measureWidths.map((width) => [
        width,
        Math.min(400, Math.round(100000 / width)),
      ]),
    );
  });

  it('ShowVisual stages without heights when the host has no render engine', async () => {
    measureAnswer = (): Promise<VisualMeasureResult> =>
      Promise.reject(canopyCapabilityUnavailableError());
    const result = await executeCanopyInjectedTool(
      'show_visual',
      { html: PREPARED.html, title: 'Chart', height: 400 },
      session(),
    );
    expect(result.isError).toBeUndefined();
    expect(staged).toHaveLength(1);
    expect(staged[0]?.heights).toBeUndefined();
  });

  it('PreviewVisual returns the rendered diagnostics and screenshot', async () => {
    const result = await executeCanopyInjectedTool(
      'preview_visual',
      { html: PREPARED.html },
      session(),
    );
    expect(result.isError).toBeUndefined();
    expect(result.text).toContain(
      'Preview rendered at 720px. Content height: 410px; captured height: 410px.',
    );
    expect(result.text).toContain(
      'Console warning (untrusted page output): untrusted',
    );
    expect(recorded.preview).toHaveLength(1);
  });

  it('PreviewVisual still reports unresolved images itself, and their paths never reach the render request', async () => {
    const result = await executeCanopyInjectedTool(
      'preview_visual',
      { html: '<p>Chart</p><img src="missing.png">' },
      session(),
    );
    expect(result.text).toContain('Unresolved image path: ');
    expect(recorded.preview).toHaveLength(1);
    expect(recorded.preview[0]?.prepared.unresolvedImagePaths).toEqual([]);
    expect(JSON.stringify(recorded.preview[0]?.prepared)).not.toContain(root);
  });

  it('PreviewVisual reports a clear tool error when the host has no render engine', async () => {
    previewAnswer = (): Promise<VisualPreviewResult> =>
      Promise.reject(canopyCapabilityUnavailableError());
    const result = await executeCanopyInjectedTool(
      'preview_visual',
      { html: PREPARED.html },
      session(),
    );
    expect(result).toMatchObject({
      isError: true,
      text: PREVIEW_VISUAL_UNAVAILABLE_TEXT,
    });
  });
});
