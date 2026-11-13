import { readFileSync } from 'node:fs';
import type * as NodeCrypto from 'node:crypto';
import path from 'node:path';
import type {
  AgentDelegationEvent,
  AgentDelegationResult,
  AgentDelegationSpawnRequest,
  GetDelegateOutputValue,
} from '@canopy/protocol/delegation';
import type { DynamicToolCallResponse } from '@canopy/execution-engine/node/codex-runtime/generated/v2/DynamicToolCallResponse';
import { CodexHostToolDispatcher } from '@canopy/execution-engine/node/codex-runtime/host-tools';
import {
  AgentDelegationBroker,
  type AgentDelegationBrokerOptions,
  type DelegationStorage,
  type StoredDelegation,
} from '../broker';
import { createDelegationProjection } from '../projections';
import { AgentRunnerRegistry } from '../runner-registry';
import type { DelegationParentContext } from '../types';
import { FakeRunner, routeFixture } from './fixtures';

const FIXTURE_DIRECTORY = path.join(__dirname, 'fixtures/get-output-golden');
const OUTPUT_TOOL_NAME = 'test_get_delegate_output';
const UUID_PREFIX = '00000000-0000-4000-8000-';
const CAPTURE_GOLDENS = process.env.CANOPY_CAPTURE_OUTPUT_GOLDENS === '1';
const CODEX_LIMIT_BYTES = 65_536;
const FINAL_NEAR_LIMIT_BYTES = CODEX_LIMIT_BYTES - 64;

const rootParent: DelegationParentContext = {
  harnessId: 'codex',
  projectId: 'project',
  worktreeId: 'worktree',
  chatId: 'chat',
  sessionKey: 'project/worktree/chat',
  turnId: 'turn-1',
  toolCallId: 'golden-output',
  runtimeGeneration: 1,
  depth: 0,
};

const task: AgentDelegationSpawnRequest = {
  modelId: 'logical-review-model',
  description: 'Capture delegate output',
  prompt: 'Read the fixed fixture.',
  executionMode: 'background',
  contextPolicy: 'task_only',
  isolation: 'shared_worktree',
};

interface MemoryStorage extends DelegationStorage {
  readonly records: Map<string, StoredDelegation>;
}

interface OutputGolden {
  readonly invocation: AgentDelegationResult<unknown>;
  readonly serializedInvocation: string;
  readonly codexResponse: DynamicToolCallResponse;
  readonly serializedCodexResponse: string;
}

interface ScenarioHandle {
  readonly broker: AgentDelegationBroker;
  readonly runner: FakeRunner;
  readonly projection: ReturnType<typeof createDelegationProjection>;
  readonly parent: DelegationParentContext;
  readonly delegationId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function makeStorage(): MemoryStorage {
  const records = new Map<string, StoredDelegation>();
  return {
    records,
    load: (): Promise<readonly StoredDelegation[]> =>
      Promise.resolve(structuredClone(Array.from(records.values()))),
    loadOne: (id): Promise<StoredDelegation | undefined> =>
      Promise.resolve(structuredClone(records.get(id))),
    commit: (record): Promise<void> => {
      const copy = structuredClone(record);
      records.set(copy.state.delegationId, copy);
      return Promise.resolve();
    },
  };
}

function nextFixedUuid(index: number): string {
  return `${UUID_PREFIX}${String(index).padStart(12, '0')}`;
}

jest.mock('node:crypto', () => {
  const actual = jest.requireActual<typeof NodeCrypto>('node:crypto');
  return {
    ...actual,
    randomUUID: (): string => '00000000-0000-4000-8000-000000000001',
  };
});

async function createScenario(scenario: string): Promise<ScenarioHandle> {
  const runner = new FakeRunner('local-sdk');
  const registry = new AgentRunnerRegistry();
  registry.register({
    apiVersion: 1,
    registrationId: 'third-local',
    adapter: runner,
  });
  const brokerOptions: AgentDelegationBrokerOptions = {
    storage: makeStorage(),
    registry,
    cwd: '/golden/worktree',
    capacity: 2,
    resolveRoute: (): Promise<{
      ok: true;
      value: ReturnType<typeof routeFixture>;
    }> =>
      Promise.resolve({
        ok: true,
        value: routeFixture({ capabilities: ['read', 'progress', 'resume'] }),
      }),
    authorize: (): Promise<{ ok: true; value: undefined }> =>
      Promise.resolve({ ok: true, value: undefined }),
  };
  const broker = new AgentDelegationBroker(brokerOptions);
  await broker.initialize();
  const parent =
    scenario === 'outside-subtree'
      ? {
          ...rootParent,
          chatId: 'other-chat',
          sessionKey: 'project/worktree/other-chat',
          toolCallId: 'outside-subtree-parent',
        }
      : { ...rootParent, toolCallId: `tool-${scenario}` };
  const spawned = await broker.spawn(parent, task);
  if (!spawned.ok)
    throw new Error(
      `Could not spawn fixture for ${scenario}: ${JSON.stringify(spawned)}`,
    );
  await new Promise<void>((resolve) => setImmediate(resolve));
  const projection = createDelegationProjection('codex', 'test', broker);
  return {
    broker,
    runner,
    projection,
    parent: rootParent,
    delegationId: spawned.value.delegationId,
  };
}

async function sendEvent(
  runner: FakeRunner,
  delegationId: string,
  runGeneration: number,
  sequence: number,
  event: AgentDelegationEvent['event'],
): Promise<void> {
  const sink = runner.sinks.get(delegationId);
  if (!sink) throw new Error(`Missing event sink for ${delegationId}`);
  await sink({
    delegationId,
    runGeneration,
    sequence,
    occurredAt: sequence * 10,
    event,
  });
}

function finalNearLimitLength(): number {
  const emptyResponse: AgentDelegationResult<GetDelegateOutputValue> = {
    ok: true,
    value: {
      delegationId: nextFixedUuid(1),
      currentRunGeneration: 1,
      currentStatus: 'completed',
      latestResultIndex: 1,
      result: {
        resultIndex: 1,
        runGeneration: 1,
        status: 'completed',
        finalText: '',
        outputTruncated: false,
      },
      currentPhase: 'idle',
      queue: {
        id: 'default',
        name: 'Default',
        running: 0,
        waiting: 0,
        limit: 2,
      },
    },
  };
  const emptyCodexEnvelope = {
    success: true,
    contentItems: [{ type: 'inputText', text: JSON.stringify(emptyResponse) }],
  };
  const overhead = Buffer.byteLength(
    JSON.stringify(emptyCodexEnvelope),
    'utf8',
  );
  return FINAL_NEAR_LIMIT_BYTES - overhead;
}

function requestForScenario(scenario: string, delegationId: string): unknown {
  switch (scenario) {
    case 'historical-result-index':
      return { delegationId, resultIndex: 1 };
    case 'missing-result-index':
      return { delegationId, resultIndex: 2 };
    case 'malformed-unknown-key':
      return { delegationId, unsupported: 'still invalid in 11c2' };
    case 'malformed-non-integer-index':
      return { delegationId, resultIndex: 1.5 };
    default:
      return { delegationId };
  }
}

async function settleScenario(
  handle: ScenarioHandle,
  scenario: string,
): Promise<void> {
  const { broker, runner, delegationId } = handle;
  if (scenario === 'unsettled-no-result') {
    await sendEvent(runner, delegationId, 1, 1, {
      type: 'started',
      nativeSessionId: 'native-golden',
    });
    return;
  }

  await sendEvent(runner, delegationId, 1, 1, {
    type: 'started',
    nativeSessionId: 'native-golden',
  });

  if (scenario === 'interrupted-no-text') {
    const interrupted = await broker.manage(
      { ...handle.parent, turnId: 'turn-2', toolCallId: 'interrupt-golden' },
      { delegationId, operation: 'interrupt' },
    );
    if (!interrupted.ok)
      throw new Error('Could not interrupt the output fixture');
    await new Promise<void>((resolve) => setImmediate(resolve));
    return;
  }

  if (scenario === 'partial-only')
    await sendEvent(runner, delegationId, 1, 2, {
      type: 'progress',
      text: 'Partial answer only.',
    });
  if (scenario === 'both-bodies')
    await sendEvent(runner, delegationId, 1, 2, {
      type: 'progress',
      text: 'Retained partial body.',
    });
  if (scenario === 'empty-final-with-partial')
    await sendEvent(runner, delegationId, 1, 2, {
      type: 'progress',
      text: 'The partial remains beside an empty final.',
    });
  if (scenario === 'execution-failure-error-usage')
    await sendEvent(runner, delegationId, 1, 2, {
      type: 'usage',
      usage: { inputTokens: 17, outputTokens: 5 },
    });
  if (scenario === 'output-truncated')
    await sendEvent(runner, delegationId, 1, 2, {
      type: 'progress',
      text: 'Retained prefix.',
      truncated: true,
    });

  if (scenario === 'historical-result-index') {
    await sendEvent(runner, delegationId, 1, 2, {
      type: 'terminal',
      status: 'completed',
      finalText: 'Historical result one.',
    });
    const followUp = await broker.message(
      { ...handle.parent, turnId: 'turn-2', toolCallId: 'history-follow-up' },
      {
        delegationId,
        operation: 'follow_up',
        message: 'Create a second retained result.',
      },
    );
    if (!followUp.ok) throw new Error('Could not create the second result');
    await new Promise<void>((resolve) => setImmediate(resolve));
    await sendEvent(runner, delegationId, 2, 1, {
      type: 'started',
      nativeSessionId: 'native-golden',
    });
    await sendEvent(runner, delegationId, 2, 2, {
      type: 'terminal',
      status: 'completed',
      finalText: 'Latest result two.',
    });
    return;
  }

  const finalText =
    scenario === 'final-ascii'
      ? 'A stable ASCII answer.'
      : scenario === 'escaped-control'
        ? 'Quote: " slash: \\ nul: \u0000 unit: \u001f line: \u2028.'
        : scenario === 'multibyte-astral'
          ? '雪 café 😀'
          : scenario === 'lone-surrogate'
            ? `before\uD800after`
            : scenario === 'empty-final' ||
                scenario === 'empty-final-with-partial'
              ? ''
              : scenario === 'both-bodies'
                ? 'Final body.'
                : scenario === 'execution-failure-error-usage'
                  ? undefined
                  : scenario === 'output-truncated'
                    ? 'Truncated output body.'
                    : scenario === 'near-limit-codex'
                      ? 'x'.repeat(finalNearLimitLength())
                      : scenario.startsWith('oversized-1mib')
                        ? 'x'.repeat(1_048_576)
                        : scenario.startsWith('oversized-utf8')
                          ? 'é'.repeat(32_768)
                          : scenario === 'oversized-empty-final-large-partial'
                            ? ''
                            : undefined;

  const sequence =
    scenario === 'partial-only' ||
    scenario === 'both-bodies' ||
    scenario === 'empty-final-with-partial' ||
    scenario === 'execution-failure-error-usage' ||
    scenario === 'output-truncated' ||
    scenario === 'oversized-empty-final-large-partial'
      ? 3
      : 2;
  const terminalStatus =
    scenario === 'execution-failure-error-usage' ? 'failed' : 'completed';
  const event: AgentDelegationEvent['event'] = {
    type: 'terminal',
    status: terminalStatus,
    ...(finalText !== undefined ? { finalText } : {}),
    ...(scenario === 'execution-failure-error-usage'
      ? {
          error: {
            code: 'runtime_error',
            message: 'The delegated operation failed.',
            retryable: false,
          },
          usage: { inputTokens: 17, outputTokens: 5 },
        }
      : {}),
  };
  if (scenario === 'oversized-empty-final-large-partial')
    await sendEvent(runner, delegationId, 1, sequence - 1, {
      type: 'progress',
      text: 'p'.repeat(1_048_576),
    });
  await sendEvent(runner, delegationId, 1, sequence, event);
}

async function outputGolden(scenario: string): Promise<OutputGolden> {
  const handle = await createScenario(scenario);
  try {
    await settleScenario(handle, scenario);
    const request = requestForScenario(scenario, handle.delegationId);
    const invocation = await handle.projection.invoke(
      handle.parent,
      OUTPUT_TOOL_NAME,
      request,
    );
    const serializedInvocation = JSON.stringify(invocation);
    const dispatcher = new CodexHostToolDispatcher(
      'native-golden-thread',
      () => 'native-golden-turn',
      {
        allowedTools: [{ namespace: null, tool: OUTPUT_TOOL_NAME }],
        authorize: (): Promise<boolean> => Promise.resolve(true),
        execute: async (call): Promise<DynamicToolCallResponse> => {
          const result = await handle.projection.invoke(
            handle.parent,
            call.tool,
            call.arguments,
          );
          return {
            success: result.ok,
            contentItems: [{ type: 'inputText', text: JSON.stringify(result) }],
          };
        },
      },
      new AbortController().signal,
    );
    const codexResponse = await dispatcher.run({
      params: {
        threadId: 'native-golden-thread',
        turnId: 'native-golden-turn',
        callId: `call-${scenario}`,
        namespace: null,
        tool: OUTPUT_TOOL_NAME,
        arguments: request,
      },
    });
    const serializedCodexResponse = JSON.stringify(codexResponse);
    return {
      invocation,
      serializedInvocation,
      codexResponse,
      serializedCodexResponse,
    };
  } finally {
    await handle.broker.close();
  }
}

function compareGolden(actual: unknown, expected: unknown): void {
  expect(actual).toEqual(expected);
  expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
}

function assertOrCaptureGolden(name: string, actual: unknown): void {
  // Frozen in the 11c2 A0 commit; capture stays off so the oracle cannot be regenerated.
  if (CAPTURE_GOLDENS)
    throw new Error('Golden capture is disabled: these fixtures are frozen.');
  const file = path.join(FIXTURE_DIRECTORY, `${name}.json`);
  const expectedText = readFileSync(file, 'utf8');
  const expected: unknown = JSON.parse(expectedText);
  compareGolden(actual, expected);
}

async function oversizedPages(): Promise<unknown> {
  const names: readonly string[] = [
    'oversized-1mib-answer',
    'oversized-utf8-under-unit-cap',
    'oversized-empty-final-large-partial',
  ];
  const cases: Array<{
    name: string;
    changesIn11c2: 'paged';
    codexResponse: DynamicToolCallResponse;
    serializedCodexResponse: string;
  }> = [];
  for (const name of names) {
    const handle = await createScenario(name);
    try {
      await settleScenario(handle, name);
      const request = { delegationId: handle.delegationId };
      const dispatcher = new CodexHostToolDispatcher(
        'native-golden-thread',
        () => 'native-golden-turn',
        {
          allowedTools: [{ namespace: null, tool: OUTPUT_TOOL_NAME }],
          authorize: (): Promise<boolean> => Promise.resolve(true),
          execute: async (call): Promise<DynamicToolCallResponse> => {
            const result = await handle.projection.invoke(
              handle.parent,
              call.tool,
              call.arguments,
            );
            return {
              success: result.ok,
              contentItems: [
                { type: 'inputText', text: JSON.stringify(result) },
              ],
            };
          },
        },
        new AbortController().signal,
      );
      const codexResponse = await dispatcher.run({
        params: {
          threadId: 'native-golden-thread',
          turnId: 'native-golden-turn',
          callId: `call-${name}`,
          namespace: null,
          tool: OUTPUT_TOOL_NAME,
          arguments: request,
        },
      });
      expect(codexResponse.success).toBe(true);
      expect(
        Buffer.byteLength(JSON.stringify(codexResponse), 'utf8'),
      ).toBeLessThanOrEqual(CODEX_LIMIT_BYTES);
      const item = codexResponse.contentItems[0];
      if (!item || item.type !== 'inputText')
        throw new Error('Expected text output');
      const reply: unknown = JSON.parse(item.text);
      if (
        !isRecord(reply) ||
        !isRecord(reply.value) ||
        !isRecord(reply.value.result) ||
        !isRecord(reply.value.result.answer)
      )
        throw new Error('Expected paged output');
      const result = reply.value.result;
      expect(result).not.toHaveProperty('finalText');
      expect(result).not.toHaveProperty('partialText');
      expect(result.answer).toMatchObject({
        role: 'final',
        encoding: 'utf8',
        offset: 0,
      });
      if (name === 'oversized-empty-final-large-partial') {
        expect(result.answer).toEqual({
          role: 'final',
          text: '',
          encoding: 'utf8',
          byteLength: 0,
          offset: 0,
        });
      } else {
        expect(result.answer).toHaveProperty('nextOffset');
        expect(result.answer).toHaveProperty(
          'notice',
          'The answer continues. Call Get Delegate Output again with this resultIndex and offset set to nextOffset.',
        );
      }
      cases.push({
        name,
        changesIn11c2: 'paged',
        codexResponse,
        serializedCodexResponse: JSON.stringify(codexResponse),
      });
    } finally {
      await handle.broker.close();
    }
  }
  return { cases };
}

beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
});

afterEach(() => {
  jest.restoreAllMocks();
});

it('captures literal unchanged Get Delegate Output and Codex bound goldens', async () => {
  const scenarios: readonly string[] = [
    'final-ascii',
    'escaped-control',
    'multibyte-astral',
    'lone-surrogate',
    'partial-only',
    'interrupted-no-text',
    'empty-final',
    'both-bodies',
    'empty-final-with-partial',
    'execution-failure-error-usage',
    'output-truncated',
    'unsettled-no-result',
    'historical-result-index',
    'missing-result-index',
    'outside-subtree',
    'malformed-unknown-key',
    'malformed-non-integer-index',
    'near-limit-codex',
  ];
  for (const scenario of scenarios)
    assertOrCaptureGolden(scenario, await outputGolden(scenario));
});

it('supersedes oversized-today denials with C6 pages (changes in 11c2: paged)', async () => {
  // oversized-today.json is retained as the archived A0 denial oracle, superseded only here.
  await oversizedPages();
});

it('proves the golden comparison rejects a mutated captured wire value', async () => {
  const actual = await outputGolden('final-ascii');
  const mutated = {
    ...actual,
    serializedInvocation: `${actual.serializedInvocation} `,
  };
  expect(() => compareGolden(mutated, actual)).toThrow();
});

it('detaches a public snapshot from later Get Delegate Output reads', async () => {
  const handle = await createScenario('final-ascii');
  try {
    await settleScenario(handle, 'final-ascii');
    const first = await handle.projection.invoke(
      handle.parent,
      OUTPUT_TOOL_NAME,
      { delegationId: handle.delegationId },
    );
    if (!first.ok || !isRecord(first.value) || !isRecord(first.value.result))
      throw new Error('Expected a settled output value');
    first.value.result.finalText = 'mutated caller copy';
    const next = await handle.projection.invoke(
      handle.parent,
      OUTPUT_TOOL_NAME,
      { delegationId: handle.delegationId },
    );
    if (!next.ok || !isRecord(next.value) || !isRecord(next.value.result))
      throw new Error('Expected the next output value');
    expect(next.value.result.finalText).toBe('A stable ASCII answer.');
  } finally {
    await handle.broker.close();
  }
});
