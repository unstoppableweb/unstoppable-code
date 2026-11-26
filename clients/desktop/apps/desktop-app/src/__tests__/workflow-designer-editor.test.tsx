/** @jest-environment jsdom */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  Pipeline,
  PipelineInfo,
} from '@canopy/execution-engine/types/pipeline';
import { parsePipelineText } from '@canopy/pipeline-interop/parse-pipeline';
import { serializePipelineDocument } from '@canopy/pipeline-interop/serialize-pipeline';

jest.mock('@/hooks/useShareAccess', () => ({
  useShareAccess: (): object => ({
    requestShare: (): undefined => undefined,
    shareGateModal: null,
  }),
}));
jest.mock('../renderer/src/hooks/useCurrentUiStateReporter', () => ({
  useCurrentUiStateReporter: (): undefined => undefined,
}));
jest.mock('../renderer/src/components/pipeline/SharePipelineModal', () => ({
  SharePipelineModal: (): null => null,
}));
jest.mock('@/lib/navigation/settings-destinations', () => ({
  openCloudAccountSettings: (): undefined => undefined,
}));
jest.mock('@/client/interface-tools-client', () => ({
  contributeInterfaceTools: (): (() => void) => (): undefined => undefined,
}));

import {
  usePipelineEditorSession,
  type PipelineEditorSession,
} from '../renderer/src/components/pipeline/usePipelineEditorSession';
import { PipelineEditorBody } from '../renderer/src/components/pipeline/PipelineEditorBody';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
// The editor opens in Flow, whose canvas measures itself; jsdom cannot.
Reflect.set(
  globalThis,
  'ResizeObserver',
  class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  },
);

const ROOT = resolve(__dirname, '../../../..');
const CORPUS_DIRS = [
  'packages/desktop-shared/resources/pipelines',
  'example-pipelines',
];

/** Brand tokens rendered as for the canopy brand, as the corpus golden does. */
function renderBrandTokens(text: string): string {
  return text
    .replaceAll('{{BRAND_EXPRESSION_ROOT}}', 'canopy')
    .replaceAll('{{BRAND_REPORT_ACTION_ID}}', 'pipeline-report')
    .replaceAll('{{BRAND_OUTPUT_VARIABLE_NAME}}', 'brandOutput')
    .replace(/\{\{BRAND_[A-Z_]+\}\}/g, 'BRAND');
}

const corpus = CORPUS_DIRS.flatMap((dir) =>
  readdirSync(join(ROOT, dir))
    .filter((name) => /\.ya?ml$/.test(name))
    .sort()
    .map(
      (name) =>
        [
          `${dir}/${name}`,
          renderBrandTokens(readFileSync(join(ROOT, dir, name), 'utf8')),
        ] as const,
    ),
);

function infoFor(pipeline: Pipeline): PipelineInfo {
  return {
    id: 'corpus',
    name: pipeline.name,
    filename: 'corpus.yaml',
    description: '',
    icon: '',
    createdAt: '',
    updatedAt: '',
    triggerTypes: ['dispatch'],
    stepCount: 1,
    revision: 1,
    source: 'user',
    readonly: false,
  };
}

let session: PipelineEditorSession | null = null;
function Harness(): JSX.Element {
  session = usePipelineEditorSession(
    { pipelineId: 'corpus' },
    { bindShortcuts: false },
  );
  return <PipelineEditorBody session={session} />;
}

const current = (): PipelineEditorSession => {
  if (!session) throw new Error('not rendered');
  return session;
};

async function settle(): Promise<void> {
  await act(async () => {
    for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
  });
}

describe('workflow designer in the editor (CAN-4224)', () => {
  let root: Root;
  let container: HTMLDivElement;
  const get = jest.fn();
  const save = jest.fn<
    Promise<{ success: boolean; data: PipelineInfo }>,
    [{ content: Pipeline }]
  >();

  beforeEach(() => {
    Object.defineProperty(window, 'pipelines', {
      configurable: true,
      value: { get, save },
    });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    session = null;
    get.mockReset();
    save.mockReset();
  });

  it('loads the bundled and example corpus', () => {
    expect(corpus.length).toBeGreaterThan(10);
  });

  it.each(corpus)(
    'opens %s in the designer, selects every card, and saves it unchanged',
    async (_file, text) => {
      // The editor gets its own parse, so nothing it does can reach `pipeline`.
      // It opens an editable copy without the `readonly` marker, as it always
      // has, so that is what an unedited save writes.
      const pipeline = parsePipelineText(text);
      delete pipeline.readonly;
      const info = infoFor(pipeline);
      get.mockResolvedValue({
        success: true,
        data: { content: parsePipelineText(text), info },
      });
      save.mockResolvedValue({ success: true, data: info });
      act(() => {
        root.render(<Harness />);
      });
      await settle();
      expect(current().editor.pipeline).not.toBeNull();

      act(() => {
        current().setMainView('designer');
      });
      expect(
        container.querySelector('[data-testid="workflow-designer"]'),
      ).not.toBeNull();
      // Selecting a card opens its details panel, which must not edit it.
      for (const card of container.querySelectorAll<HTMLElement>(
        '[data-testid="workflow-designer-card"]',
      )) {
        act(() => card.click());
      }
      act(() => {
        current().editor.setSelection({ type: 'none' });
      });

      expect(current().editor.isDirty).toBe(false);
      expect(current().editor.canSave).toBe(false);

      await act(async () => {
        await current().editor.save();
      });
      expect(save).toHaveBeenCalledTimes(1);
      const content = save.mock.calls[0]?.[0].content;
      if (!content) throw new Error('nothing saved');
      expect(content).toEqual(pipeline);
      expect(serializePipelineDocument(content)).toBe(
        serializePipelineDocument(pipeline),
      );
    },
  );
});
