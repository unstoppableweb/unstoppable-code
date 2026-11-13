// CAN-6215 (cloud pipelines CP-27): builtin/http-request with auth_header_env
// and builtin/read-linear-ticket work in a cloud run whose secrets arrive in
// its bootstrap activation. The runner's secret source redeems the
// activation's grant once for the start it was staged for, and the actions
// run with the environment a step gets: the launch's public env with the
// redeemed secretEnv over it. The HTTP endpoint is local and the Linear
// client is a stand-in that records the key it was given.
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brandEnvName } from '@canopy/execution-engine/brand/env';
import {
  CLOUD_RUNNER_ACTIVATION_KIND,
  CloudRunnerActivationSchema,
  type CloudRunnerActivation,
} from '@canopy/protocol/pipeline-relay';
import type { ExecutionSecretBinding } from '@canopy/protocol/canopy-core';
import {
  createActivationExecutionSecretSource,
  redeemExecutionSecrets,
} from '@canopy/core-runtime/node/execution-secrets';
import { resetRunDir } from '../_lib/output';
import { runHttpRequestAction } from '../http-request/runner';
import { runReadLinearTicketAction } from '../read-linear-ticket/runner';

const mockLinearKeys: string[] = [];
jest.mock('../_lib/linear-client', () => ({
  createLinearClient: (apiKey: string): unknown => {
    mockLinearKeys.push(apiKey);
    const issue = {
      id: 'issue-6215',
      identifier: 'CAN-6215',
      number: 6215,
      title: 'Add hosted pipeline environments and secrets',
      description: null,
      url: 'https://linear.app/example/issue/CAN-6215',
      priority: 0,
      priorityLabel: 'No priority',
      branchName: 'can-6215',
      labelIds: [],
      previousIdentifiers: [],
      customerTicketCount: 0,
      createdAt: new Date('2026-11-10T00:00:00Z'),
      updatedAt: new Date('2026-11-10T00:00:00Z'),
      labels: (): Promise<{ nodes: never[] }> => Promise.resolve({ nodes: [] }),
    };
    return {
      searchIssues: (): Promise<{ nodes: unknown[] }> =>
        Promise.resolve({
          nodes: [
            {
              id: issue.id,
              identifier: issue.identifier,
              previousIdentifiers: [],
            },
          ],
        }),
      issue: (): Promise<typeof issue> => Promise.resolve(issue),
    };
  },
}));

const ACME_TOKEN = 'Bearer acme-cloud-secret-6215';
const LINEAR_KEY = 'lin_api_cloud_key_6215';
const LINEAR_ENV = brandEnvName('LINEAR_API_KEY');

const BINDINGS: ExecutionSecretBinding[] = [
  {
    name: 'ACME_TOKEN',
    source: {
      kind: 'stored-secret',
      family: 'environment',
      record: 'user:u-1',
      ref: `ssr1_${'a'.repeat(43)}`,
    },
  },
  {
    name: LINEAR_ENV,
    source: { kind: 'integration-token', provider: 'linear' },
  },
];

/** The activation the web core stages for the run's start (`stageCloudRunSecrets`). */
function activation(): CloudRunnerActivation {
  return CloudRunnerActivationSchema.parse({
    kind: CLOUD_RUNNER_ACTIVATION_KIND,
    version: 1,
    delegationId: '5a1f0c3e-7a4b-4c2d-9e6f-0123456789ab',
    leaseEpoch: 1,
    credentialId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
    expiresAt: '2026-11-11T00:00:00.000Z',
    relay: {
      url: 'wss://pipeline-relay.example.test/v1/runner',
      token: 'relay-token',
    },
    sessionKey: 'k'.repeat(43),
    secrets: {
      grantId: '0b7a5c1e-2f3d-4a6b-8c9d-0e1f2a3b4c5d',
      audience: { operation: 'worker.pipeline.execution.start', key: 'run-1' },
      redeemWithinMs: 60_000,
      entries: [
        { binding: BINDINGS[0], value: ACME_TOKEN },
        { binding: BINDINGS[1], value: LINEAR_KEY },
      ],
    },
  });
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hosted-secrets-actions-'));
  resetRunDir();
  mockLinearKeys.length = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A step's environment: the launch's public env, its redeemed secrets, the step's inputs. */
async function stepEnv(
  inputs: Record<string, string>,
): Promise<NodeJS.ProcessEnv> {
  const source = createActivationExecutionSecretSource(activation().secrets);
  try {
    const redeemed = await redeemExecutionSecrets(
      source,
      { operation: 'worker.pipeline.execution.start', key: 'run-1' },
      BINDINGS,
      new AbortController().signal,
    );
    return {
      PATH: process.env.PATH,
      REGION: 'eu-west',
      ...redeemed.env,
      [brandEnvName('OUTPUT')]: join(dir, 'outputs.txt'),
      [brandEnvName('OUTPUT_DIR')]: join(dir, 'files'),
      ...inputs,
    };
  } finally {
    source.dispose();
  }
}

it('http-request sends the redeemed secret named by auth_header_env', async () => {
  const seen: IncomingHttpHeaders[] = [];
  const server = createServer((request, response) => {
    seen.push(request.headers);
    response.setHeader('content-type', 'application/json');
    response.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('The test server has no port.');
  const { port } = address;
  try {
    await runHttpRequestAction(
      await stepEnv({
        INPUT_URL: `http://127.0.0.1:${String(port)}/hook`,
        INPUT_AUTH_HEADER_ENV: 'ACME_TOKEN',
        INPUT_EXPECTED_STATUS: '200',
      }),
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  expect(seen).toHaveLength(1);
  expect(seen[0]?.authorization).toBe(ACME_TOKEN);
});

it('read-linear-ticket reads the hosted Linear key as <BRAND>_LINEAR_API_KEY', async () => {
  await runReadLinearTicketAction(
    await stepEnv({ INPUT_TICKET_ID: 'CAN-6215' }),
  );
  expect(mockLinearKeys).toEqual([LINEAR_KEY]);
});

describe("the activation's one-shot grant", () => {
  const start = {
    operation: 'worker.pipeline.execution.start' as const,
    key: 'run-1',
  };
  const signal = new AbortController().signal;

  it('redeems once, for exactly its instruction and binding set', async () => {
    const source = createActivationExecutionSecretSource(activation().secrets);
    // Another instruction is refused and leaves the grant for its own.
    await expect(
      redeemExecutionSecrets(
        source,
        { operation: 'worker.pipeline.execution.start', key: 'run-2' },
        BINDINGS,
        signal,
      ),
    ).rejects.toMatchObject({
      payload: { code: 'worker.executionSecret.notGranted' },
    });
    await expect(
      redeemExecutionSecrets(source, start, BINDINGS, signal),
    ).resolves.toEqual({ env: { ACME_TOKEN, [LINEAR_ENV]: LINEAR_KEY } });
    await expect(
      redeemExecutionSecrets(source, start, BINDINGS, signal),
    ).rejects.toMatchObject({
      payload: { code: 'worker.executionSecret.notGranted' },
    });
    source.dispose();
  });

  it('burns the grant on a narrowed request, and after its deadline or dispose', async () => {
    const narrowed = createActivationExecutionSecretSource(
      activation().secrets,
    );
    await expect(
      redeemExecutionSecrets(narrowed, start, BINDINGS.slice(0, 1), signal),
    ).rejects.toMatchObject({
      payload: { code: 'worker.executionSecret.notGranted' },
    });
    await expect(
      redeemExecutionSecrets(narrowed, start, BINDINGS, signal),
    ).rejects.toMatchObject({
      payload: { code: 'worker.executionSecret.notGranted' },
    });
    let now = 0;
    const late = createActivationExecutionSecretSource(activation().secrets, {
      now: () => now,
    });
    now = 60_000;
    await expect(
      redeemExecutionSecrets(late, start, BINDINGS, signal),
    ).rejects.toMatchObject({
      payload: { code: 'worker.executionSecret.notGranted' },
    });
    const disposed = createActivationExecutionSecretSource(
      activation().secrets,
    );
    disposed.dispose();
    await expect(
      redeemExecutionSecrets(disposed, start, BINDINGS, signal),
    ).rejects.toMatchObject({
      payload: { code: 'worker.executionSecret.notGranted' },
    });
    // An activation with no secrets refuses any binding.
    await expect(
      redeemExecutionSecrets(
        createActivationExecutionSecretSource(null),
        start,
        BINDINGS,
        signal,
      ),
    ).rejects.toMatchObject({
      payload: { code: 'worker.executionSecret.unavailable' },
    });
  });
});
