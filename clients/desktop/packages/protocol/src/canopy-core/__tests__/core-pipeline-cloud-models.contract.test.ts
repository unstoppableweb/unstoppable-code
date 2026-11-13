// CAN-6174 (plan CP-26): the cloud model preflight and save contracts the web
// core serves and desktop never registers.
import { CANOPY_INSTRUCTION_DEFINITIONS, CANOPY_QUERY_DEFINITIONS } from '..';
import {
  CORE_PIPELINE_CLOUD_MODEL_INSTRUCTION_DEFINITIONS,
  CORE_PIPELINE_CLOUD_MODEL_QUERY_DEFINITIONS,
  CORE_PIPELINE_CLOUD_RUN_INSTRUCTION_DEFINITIONS,
  CORE_PIPELINE_CLOUD_RUN_OPERATIONS,
  CLOUD_PIPELINE_RUN_TARGET_ID,
} from '../core';

const preflight =
  CORE_PIPELINE_CLOUD_MODEL_QUERY_DEFINITIONS[
    'core.pipeline.cloudModels.preflight'
  ];
const save =
  CORE_PIPELINE_CLOUD_MODEL_INSTRUCTION_DEFINITIONS[
    'core.pipeline.cloudModels.save'
  ];
const HASH = 'a'.repeat(64);

describe('cloud model preflight contracts (CAN-6174)', () => {
  it('reads with core.pipeline.read and saves with core.pipeline.write', () => {
    expect(preflight.requiredGrants).toEqual(['core.pipeline.read']);
    expect(save.requiredGrants).toEqual(['core.pipeline.write']);
    expect(preflight.idempotency).toBe('inherent');
    expect(save.idempotency).toBe('inherent');
  });

  it('stays out of the registries every core must serve and the cloud run group', () => {
    expect(Object.keys(CANOPY_QUERY_DEFINITIONS)).not.toContain(
      'core.pipeline.cloudModels.preflight',
    );
    expect(Object.keys(CANOPY_INSTRUCTION_DEFINITIONS)).not.toContain(
      'core.pipeline.cloudModels.save',
    );
    expect(CORE_PIPELINE_CLOUD_RUN_OPERATIONS).not.toContain(
      'core.pipeline.cloudModels.preflight',
    );
    expect(CORE_PIPELINE_CLOUD_RUN_OPERATIONS).not.toContain(
      'core.pipeline.cloudModels.save',
    );
  });

  it('names a workflow, its run owner and an optional schedule', () => {
    const request = {
      definitionId: 'shared:canopy-cloud:1',
      owner: 'personal',
    };
    expect(preflight.params.safeParse(request).success).toBe(true);
    expect(
      preflight.params.safeParse({ ...request, scheduleId: 'automation-1' })
        .success,
    ).toBe(true);
    expect(
      preflight.params.safeParse({ ...request, choices: [] }).success,
    ).toBe(false);
  });

  it('saves only choices tied to the preflight the user saw', () => {
    const request = {
      definitionId: 'shared:canopy-cloud:1',
      owner: 'personal',
      choices: [{ itemKey: 'work#0', modelId: 'anthropic/claude-opus-5.5' }],
    };
    expect(save.params.safeParse(request).success).toBe(false);
    expect(
      save.params.safeParse({
        ...request,
        definitionHash: HASH,
        policyFingerprint: HASH,
      }).success,
    ).toBe(true);
  });

  it('answers the items with no model chosen for the user', () => {
    const result = {
      definitionId: 'shared:canopy-cloud:1',
      scheduleId: null,
      definitionHash: HASH,
      policyFingerprint: HASH,
      saved: 'none',
      items: [
        {
          itemKey: 'work#0',
          reason: 'local_harness',
          parityId: 'R2',
          message: 'This step uses Cursor, which only runs on your computer.',
          jobId: 'work',
          stepIndex: 0,
          uses: 'builtin/agent-prompt',
          model: 'cursor:gpt-5',
          harness: 'cursor',
          alternatives: [
            {
              modelId: 'anthropic/claude-opus-5.5',
              label: 'Opus 5.5',
              harness: 'claude',
            },
          ],
        },
      ],
    };
    expect(preflight.result.safeParse(result).success).toBe(true);
    expect(
      preflight.result.safeParse({
        ...result,
        items: [{ ...result.items[0], chosen: 'anthropic/claude-opus-5.5' }],
      }).success,
    ).toBe(false);
  });
});

// CAN-6187 (plan CP-37): the run location travels as `scope.targetId` on the
// start the web core serves for its cloud target.
describe('cloud run start contract (CAN-6187)', () => {
  const start =
    CORE_PIPELINE_CLOUD_RUN_INSTRUCTION_DEFINITIONS[
      'core.pipeline.execution.start'
    ];
  const request = {
    scope: { targetId: CLOUD_PIPELINE_RUN_TARGET_ID },
    definitionId: 'shared:canopy-cloud:1',
    owner: 'personal',
    inputs: { topic: 'release' },
    eventName: 'dispatch',
  };

  it('is the keyed start that offers Run on: Cloud, served by the web core only', () => {
    expect(start.idempotency).toBe('keyed');
    expect(start.requiredGrants).toEqual(['core.pipeline.write']);
    expect(start.placement).toBe('target-selectable');
    // The first of the group; CP-21 (CAN-6214) adds the reads and controls.
    expect(CORE_PIPELINE_CLOUD_RUN_OPERATIONS[0]).toBe(
      'core.pipeline.execution.start',
    );
    expect(Object.keys(CANOPY_INSTRUCTION_DEFINITIONS)).not.toContain(
      'core.pipeline.execution.start',
    );
    expect(CLOUD_PIPELINE_RUN_TARGET_ID).toBe('cloud_sandbox_worker');
  });

  it('carries the location in the scope, apart from the other run fields', () => {
    expect(start.params.safeParse(request).success).toBe(true);
    expect(
      start.params.safeParse({
        ...request,
        modelChoices: {
          definitionHash: HASH,
          policyFingerprint: HASH,
          choices: [
            { itemKey: 'work#0', modelId: 'anthropic/claude-opus-5.5' },
          ],
        },
      }).success,
    ).toBe(true);
    expect(
      start.params.safeParse({ ...request, scope: undefined }).success,
    ).toBe(false);
    expect(
      start.params.safeParse({ ...request, targetId: 'cloud_sandbox_worker' })
        .success,
    ).toBe(false);
  });
});
