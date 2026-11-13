/** @jest-environment jsdom */
// CAN-6174 (plan CP-26): the shared dialog where the user confirms a cloud
// model for each model step a cloud run can't run as written. No step starts
// with a model chosen, saved choices included, and the dialog confirms only
// with an explicit choice for every step: nothing is substituted silently.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  CloudModelChoice,
  CloudModelPreflightItem,
  CloudModelPreflightResult,
} from '@canopy/protocol/canopy-core';
import {
  CLOUD_MODEL_DIALOG_TEST_IDS,
  CloudModelReplacementDialog,
  confirmedCloudModelChoices,
} from '../CloudModelReplacementDialog';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const OPUS = {
  modelId: 'anthropic/claude-opus-5.5',
  label: 'Opus 5.5',
  harness: 'claude',
} as const;
const HAIKU = {
  modelId: 'anthropic/claude-haiku-5.5',
  label: 'Haiku 5.5',
  harness: 'claude',
} as const;

function item(
  itemKey: string,
  overrides: Partial<CloudModelPreflightItem> = {},
): CloudModelPreflightItem {
  return {
    itemKey,
    reason: 'local_harness',
    parityId: 'R2',
    message: 'This step uses Cursor, which only runs on your computer.',
    jobId: 'work',
    stepIndex: Number(itemKey.split('#')[1]),
    uses: 'builtin/agent-prompt',
    model: 'cursor:gpt-5',
    harness: 'cursor',
    alternatives: [OPUS, HAIKU],
    ...overrides,
  };
}

function preflight(
  items: CloudModelPreflightItem[],
  saved: CloudModelPreflightResult['saved'] = 'none',
): CloudModelPreflightResult {
  return {
    definitionId: 'shared:canopy-cloud:1',
    scheduleId: null,
    definitionHash: 'a'.repeat(64),
    policyFingerprint: 'b'.repeat(64),
    items,
    saved,
  };
}

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
  document.body.innerHTML = '';
});

function render(
  result: CloudModelPreflightResult,
  onConfirm: (choices: CloudModelChoice[]) => void = () => undefined,
): void {
  act(() => {
    root.render(
      <CloudModelReplacementDialog
        preflight={result}
        onConfirm={onConfirm}
        onCancel={() => undefined}
      />,
    );
  });
}

function byTestId(id: string): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`),
  );
}

function confirmButton(): HTMLButtonElement {
  const [button] = byTestId(CLOUD_MODEL_DIALOG_TEST_IDS.confirm);
  if (!(button instanceof HTMLButtonElement)) throw new Error('no confirm');
  return button;
}

function choose(selectIndex: number, modelId: string): void {
  const trigger = byTestId(CLOUD_MODEL_DIALOG_TEST_IDS.select)[selectIndex];
  if (trigger === undefined) throw new Error('no select');
  act(() => trigger.click());
  const option = document.querySelector<HTMLElement>(
    `[role="option"][data-value="${modelId}"]`,
  );
  if (option === null) throw new Error(`no option ${modelId}`);
  act(() => option.click());
}

it('starts with no model chosen, even for steps answered before a change', () => {
  render(preflight([item('work#0'), item('work#3')], 'stale'));
  expect(byTestId(CLOUD_MODEL_DIALOG_TEST_IDS.stale)).toHaveLength(1);
  const selects = byTestId(CLOUD_MODEL_DIALOG_TEST_IDS.select);
  expect(selects).toHaveLength(2);
  for (const select of selects) {
    expect(select.getAttribute('data-value')).toBeNull();
    expect(select.textContent).toContain('Choose a cloud model');
  }
  expect(confirmButton().disabled).toBe(true);
});

it('confirms only once every step has a model the user picked', () => {
  const onConfirm = jest.fn();
  render(preflight([item('work#0'), item('work#3')]), onConfirm);
  choose(0, HAIKU.modelId);
  expect(confirmButton().disabled).toBe(true);
  act(() => confirmButton().click());
  expect(onConfirm).not.toHaveBeenCalled();
  choose(1, OPUS.modelId);
  expect(confirmButton().disabled).toBe(false);
  act(() => confirmButton().click());
  expect(onConfirm).toHaveBeenCalledWith([
    { itemKey: 'work#0', modelId: HAIKU.modelId },
    { itemKey: 'work#3', modelId: OPUS.modelId },
  ]);
});

it('cannot confirm a step no cloud model can run', () => {
  render(preflight([item('work#0', { alternatives: [] })]));
  expect(byTestId(CLOUD_MODEL_DIALOG_TEST_IDS.unavailable)).toHaveLength(1);
  expect(byTestId(CLOUD_MODEL_DIALOG_TEST_IDS.select)).toHaveLength(0);
  expect(confirmButton().disabled).toBe(true);
});

it('never turns a missing or unlisted pick into a choice', () => {
  const items = [item('work#0'), item('work#1')];
  expect(confirmedCloudModelChoices(items, {})).toBeNull();
  expect(
    confirmedCloudModelChoices(items, { 'work#0': OPUS.modelId }),
  ).toBeNull();
  expect(
    confirmedCloudModelChoices(items, {
      'work#0': OPUS.modelId,
      'work#1': 'openai/gpt-6.1-terra',
    }),
  ).toBeNull();
  expect(
    confirmedCloudModelChoices(items, {
      'work#0': OPUS.modelId,
      'work#1': HAIKU.modelId,
    }),
  ).toEqual([
    { itemKey: 'work#0', modelId: OPUS.modelId },
    { itemKey: 'work#1', modelId: HAIKU.modelId },
  ]);
});
