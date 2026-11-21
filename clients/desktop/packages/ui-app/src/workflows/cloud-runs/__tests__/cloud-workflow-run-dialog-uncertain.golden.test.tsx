/** @jest-environment jsdom */
/**
 * CAN-7196 pin for the web Run dialog: a cloud run start that couldn't be
 * confirmed keeps the launch's key whatever a later press of it is
 * answered, so the next press sends the same key and the web core answers
 * with the run it recorded: one run, never two.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CLOUD_RUN_START_UNCERTAIN } from '@canopy/app-state/cloud-pipeline-runs';
import type { CoreCoworkInvoker } from '@canopy/app-state/core-cowork';
import type { CanopyErrorPayload } from '@canopy/protocol/canopy-core';
import { CloudWorkflowRunDialog } from '../CloudWorkflowRunDialog';

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const DEFINITION_ID = 'curated:golden-review';

const definition = {
  definitionId: DEFINITION_ID,
  scope: {},
  source: 'curated',
  owner: null,
  name: 'Golden review',
  description: '',
  icon: 'workflow',
  enabled: true,
  readonly: true,
  format: 'yaml',
  revision: 1,
  checksum: 'golden-checksum',
  triggerTypes: ['dispatch'],
  executionScopes: ['global'],
  createdAt: null,
  updatedAt: null,
  document: 'name: Golden review',
  normalized: {},
  diagnostics: [],
};

function operationFor(key: string): Record<string, unknown> {
  const now = '2026-11-19T21:00:00.000Z';
  return {
    operationId: 'run-golden',
    kind: 'core.pipeline.run',
    status: 'queued',
    revision: 1,
    parentOperationId: null,
    rootOperationId: 'run-golden',
    authorityId: 'web-core-golden',
    executionTargetId: null,
    runtimeDelegationId: null,
    scope: {},
    origin: { kind: 'client', sourceId: 'user:golden' },
    owner: { kind: 'principal', id: 'user:golden' },
    receipt: { idempotencyKey: key, acceptedAt: now, outcome: 'recorded' },
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    progress: null,
    outcome: null,
    error: null,
    cancellation: null,
    restart: null,
  };
}

type StartAnswer = CanopyErrorPayload | 'recorded';

/** A web core that answers each start with the next scripted answer. */
function webCore(answers: StartAnswer[]): {
  readonly invoker: CoreCoworkInvoker;
  readonly keys: string[];
} {
  const keys: string[] = [];
  return {
    keys,
    invoker: {
      request: (method, params) => {
        if (method === 'core.pipeline.definition.get')
          return Promise.resolve({ ok: true, value: { definition } });
        if (method !== 'core.pipeline.execution.start')
          return Promise.reject(new Error(`${method} is not expected`));
        const key = String(Reflect.get(Object(params._meta), 'idempotencyKey'));
        keys.push(key);
        const answer = answers.shift();
        if (answer === undefined)
          return Promise.reject(new Error('No more starts are expected.'));
        if (answer !== 'recorded')
          return Promise.resolve({ ok: false, error: answer });
        return Promise.resolve({
          ok: true,
          value: {
            operation: operationFor(key),
            statusReason: null,
            admission: 'admitted',
            replayed: true,
          },
        });
      },
      openStream: () => Promise.reject(new Error('no streams')),
    },
  };
}

const byTestId = (id: string): HTMLElement | null =>
  document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1)
    await act(async () => {
      await Promise.resolve();
    });
}

describe('the web Run dialog after a start it could not confirm (CAN-7196)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('keeps the launch key and says it could not confirm when the next press is refused, then starts the run once', async () => {
    const started: string[] = [];
    const core = webCore([
      // The first answer was lost.
      { kind: 'unavailable', message: 'Lost.', retry: { kind: 'never' } },
      // The next press is refused outright by the web core.
      {
        kind: 'failed_precondition',
        message: 'The run service failed.',
        retry: { kind: 'never' },
      },
      // The press after that finds the run the first one recorded.
      'recorded',
    ]);
    act(() => {
      root.render(
        <CloudWorkflowRunDialog
          invoker={core.invoker}
          definitionId={DEFINITION_ID}
          name="Golden review"
          owners={[{ value: 'personal', label: 'Personal' }]}
          initialOwner="personal"
          onClose={() => undefined}
          onStarted={(executionId) => started.push(executionId)}
        />,
      );
    });
    await settle();

    const press = async (): Promise<void> => {
      act(() => byTestId('cloud-workflow-run-start')?.click());
      await settle();
    };

    await press();
    expect(byTestId('cloud-workflow-run-error')?.textContent).toContain(
      CLOUD_RUN_START_UNCERTAIN,
    );

    await press();
    const error = byTestId('cloud-workflow-run-error')?.textContent ?? '';
    expect(error).toContain(CLOUD_RUN_START_UNCERTAIN);
    expect(error).not.toContain('The run service failed.');

    await press();
    expect(started).toEqual(['run-golden']);
    expect(core.keys).toHaveLength(3);
    expect(new Set(core.keys).size).toBe(1);
  });
});
