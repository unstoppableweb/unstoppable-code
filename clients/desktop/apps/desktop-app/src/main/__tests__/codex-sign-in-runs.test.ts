import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  providerCredentialEffects,
  type CanopyCallerDescriptor,
  type OperationRecord,
} from '@canopy/protocol/canopy-core';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import type { CodexLoginState } from '@canopy/desktop-shared/types';
import {
  createCoreOperationAdapter,
  type CoreOperationAdapter,
} from '../canopy-runtime/core-operation-adapter';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../canopy-runtime/desktop-runtime';
import {
  currentSignInWorkerContext,
  type SignInWorkerContext,
} from '../sign-in-runs/sign-in-worker-context';

const mockWarn = jest.fn();
jest.mock('../lib/main-process-logging', () => {
  const actual: Record<string, unknown> = jest.requireActual(
    '../lib/main-process-logging',
  );
  return {
    ...actual,
    logMainProcessWarn: (...args: unknown[]): void => {
      mockWarn(...args);
    },
  };
});

interface FakeSession {
  ready: Promise<void>;
  startContexts: (SignInWorkerContext | undefined)[];
  closed: number;
  complete(success: boolean): void;
}
let session: FakeSession;
let activeWork = 0;
let pausedChats = 0;
let accountVerifies = true;
let pauseReleases = 0;
let pausePromise: (() => Promise<number>) | null = null;
const account = {
  authenticated: true,
  accountEmail: 'person@example.com',
  accountLabel: 'person@example.com',
  accessToken: 'tok-canary-789',
};

function fakeSession(): FakeSession & Record<string, unknown> {
  let completion: ((result: { success: boolean }) => void) | null = null;
  const fake = {
    ready: Promise.resolve(),
    startContexts: [] as (SignInWorkerContext | undefined)[],
    closed: 0,
    complete: (success: boolean): void => completion?.({ success }),
    start: (
      _method: string,
      onCompleted: (result: { success: boolean }) => void,
    ): Promise<unknown> => {
      fake.startContexts.push(currentSignInWorkerContext());
      completion = onCompleted;
      return Promise.resolve({
        type: 'chatgpt',
        loginId: 'l1',
        authUrl: 'https://auth.openai.com/x',
      });
    },
    retireLogin: (): Promise<void> => Promise.resolve(),
    resetLogin: (): Promise<void> => Promise.resolve(),
    verifyAccount: (): Promise<unknown> => Promise.resolve(account),
    close: (): Promise<void> => {
      fake.closed += 1;
      return Promise.resolve();
    },
  };
  return fake;
}

jest.mock('../codex/runtime-service', () => ({
  getCodexRuntimeService: (): unknown => ({
    beginAuthentication: (): unknown => session,
    admin: (): { getResourceSnapshots: () => unknown[] } => ({
      getResourceSnapshots: (): unknown[] => [],
    }),
  }),
}));
jest.mock('../agents/session-manager', () => ({
  getCodexAuthenticationActiveWorkCount: (): number => activeWork,
  pauseCodexSessionsForAuthentication: (): {
    paused: Promise<number>;
    release: () => void;
  } => ({
    paused: pausePromise ? pausePromise() : Promise.resolve(pausedChats),
    release: (): void => {
      pauseReleases += 1;
    },
  }),
}));
jest.mock('../pipelines/pipeline-execution-registry', () => ({
  getActivePipelineExecutionHandles: (): unknown[] => [],
}));
jest.mock('../auth/provider-auth-state', () => ({
  commitVerifiedCodexAccount: (value: unknown): unknown => value,
  checkCodexAuthStatus: (): Promise<unknown> => Promise.resolve(account),
  fingerprintCodexRecoveryIdentity: (): string => 'fingerprint',
  verifiedCodexAccountStatus: (value: unknown): unknown => {
    if (!accountVerifies)
      throw new Error('Could not verify Codex authentication.');
    return value;
  },
}));
const mockRecordGrant = jest.fn<Promise<void>, [string, string]>(() =>
  Promise.resolve(),
);
jest.mock('../lib/usage-limited-chats-registry', () => ({
  hasCodexAuthenticationGrant: (): Promise<boolean> => Promise.resolve(true),
  recordCodexAuthenticationGrant: (
    attemptId: string,
    fingerprint: string,
  ): Promise<void> => mockRecordGrant(attemptId, fingerprint),
  revokeCodexAuthenticationGrant: (): Promise<void> => Promise.resolve(),
}));

import { CodexLoginManager } from '../auth/codex-login';

let root: string;
let operations: CoreOperationAdapter;
let runtime: DesktopCanopyDispatcher;
let manager: CodexLoginManager;
let states: CodexLoginState[];
const caller: CanopyCallerDescriptor = {
  principalId: 'another-client',
  clientInstanceId: 'test',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: ['core.operation.cancel'],
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'codex-sign-in-runs-'));
  operations = createCoreOperationAdapter({
    ledgerPath: () => join(root, 'ledger.sqlite'),
  });
  runtime = createDesktopRuntime({
    operationAdapter: operations,
    shutdownTimeoutMs: 25,
  });
  session = fakeSession();
  activeWork = 0;
  pausedChats = 0;
  accountVerifies = true;
  pauseReleases = 0;
  pausePromise = null;
  mockWarn.mockReset();
  mockRecordGrant.mockClear();
  manager = new CodexLoginManager();
  states = [];
  manager.onState((state) => states.push(state));
});
afterEach(async () => {
  await runtime.shutdown();
  rmSync(root, { recursive: true, force: true });
});

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate() && Date.now() < deadline)
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  if (!predicate()) throw new Error('Condition not reached');
}

async function signInRuns(): Promise<OperationRecord[]> {
  return (
    await operations.service.list({ kinds: ['core.signIn.run'], limit: 10 })
  ).items;
}

async function settled(operationId: string): Promise<OperationRecord> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const record = await operations.service.get(operationId);
    if (record && record.status !== 'running' && record.status !== 'queued')
      return record;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('The sign-in run did not settle');
}

const phases = (): string[] =>
  states
    .map((state) => state.phase)
    .filter((phase, index, all) => phase !== all[index - 1]);

it('Codex login starts only inside its sign-in run', async () => {
  manager.start({ method: 'chatgpt', confirmPause: false });
  await until(() => session.startContexts.length === 1);
  const [parent] = await signInRuns();
  if (!parent) throw new Error('No parent');
  expect(parent).toMatchObject({ status: 'running' });
  const [delegation] = await runtime.localWorker.listDelegations(
    parent.operationId,
  );
  if (!delegation) throw new Error('No dispatch');
  const child = await operations.service.get(delegation.childOperationId);
  expect(child).toMatchObject({ kind: 'worker.agent.signIn.run' });
  const runIdMatcher: unknown = expect.any(String);
  expect(session.startContexts).toEqual([
    { provider: 'codex', signInRunId: runIdMatcher },
  ]);
});

it('a refused run closes the reserved session and starts no login', async () => {
  await runtime.shutdown();
  manager.start({ method: 'chatgpt', confirmPause: false });
  await until(() => states.at(-1)?.phase === 'complete');
  expect(session.startContexts).toEqual([]);
  expect(session.closed).toBe(1);
  expect(states.at(-1)).toMatchObject({ phase: 'complete', outcome: 'failed' });
});

it('a refused run closes the session without a signed-in account', async () => {
  await runtime.shutdown();
  accountVerifies = false;
  manager.start({ method: 'chatgpt', confirmPause: false });
  await until(() => states.at(-1)?.phase === 'complete');
  expect(session.startContexts).toEqual([]);
  expect(session.closed).toBe(1);
  expect(pauseReleases).toBe(1);
  expect(states.at(-1)).toMatchObject({ phase: 'complete', outcome: 'failed' });
});

it('a refused run waits for the chat pause to settle before completing', async () => {
  await runtime.shutdown();
  let rejectPause: (error: Error) => void = () => undefined;
  pausePromise = (): Promise<number> =>
    new Promise<number>((_resolve, reject) => {
      rejectPause = reject;
    });
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', onUnhandled);
  try {
    manager.start({ method: 'chatgpt', confirmPause: false });
    for (let attempt = 0; attempt < 20; attempt += 1)
      await new Promise<void>((resolve) => setImmediate(resolve));
    expect(states.at(-1)?.phase).toBe('pausing');
    expect(pauseReleases).toBe(0);
    rejectPause(new Error('pause failed'));
    await until(() => states.at(-1)?.phase === 'complete');
    expect(states.at(-1)).toMatchObject({
      phase: 'complete',
      outcome: 'failed',
    });
    expect(session.closed).toBe(1);
    expect(pauseReleases).toBe(1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(unhandled).toEqual([]);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

it('success completes the run with the Codex effects', async () => {
  manager.start({ method: 'chatgpt', confirmPause: false });
  await until(() => states.at(-1)?.phase === 'waiting');
  const [parent] = await signInRuns();
  if (!parent) throw new Error('No parent');
  session.complete(true);
  await until(() => states.at(-1)?.phase === 'complete');
  expect(states.at(-1)).toMatchObject({
    phase: 'complete',
    outcome: 'success',
    account: { accountEmail: 'person@example.com' },
  });
  const os = hostOperatingSystem();
  if (os === null) throw new Error('Unsupported test host');
  expect(await settled(parent.operationId)).toMatchObject({
    status: 'completed',
    outcome: {
      status: 'succeeded',
      provider: 'codex',
      credentialEffects: providerCredentialEffects('codex', os),
    },
  });
});

it('cancel settles the run as cancelled after the session closes', async () => {
  manager.start({ method: 'chatgpt', confirmPause: false });
  await until(() => states.at(-1)?.phase === 'waiting');
  const [parent] = await signInRuns();
  if (!parent) throw new Error('No parent');
  let closedWhenSettled: number | null = null;
  const closedAtSettle = settled(parent.operationId).then((record) => {
    closedWhenSettled = session.closed;
    return record;
  });
  await manager.finish('cancelled');
  expect(await closedAtSettle).toMatchObject({ status: 'cancelled' });
  expect(closedWhenSettled).toBe(1);
});

// CAN-6718 review: an attempt nobody is left to finish (its window went
// away, or a remote attempt ended) is checked like a cancel, and closed
// without a verified account when that check fails, as on a signed-out host,
// instead of staying open.
it('abandoning a waiting attempt on a signed-out host closes it', async () => {
  accountVerifies = false;
  manager.start({ method: 'chatgpt', confirmPause: false });
  await until(() => states.at(-1)?.phase === 'waiting');
  const [parent] = await signInRuns();
  if (!parent) throw new Error('No parent');
  await expect(manager.abandon()).resolves.toMatchObject({
    phase: 'complete',
    outcome: 'cancelled',
  });
  expect(session.closed).toBe(1);
  expect(pauseReleases).toBe(1);
  expect(await settled(parent.operationId)).toMatchObject({
    status: 'cancelled',
  });
});

// A signed-in account still grants the work the attempt paused, so that work
// can resume under the same attempt.
it('abandoning a waiting attempt on a signed-in host grants its paused work', async () => {
  activeWork = 1;
  pausedChats = 1;
  manager.start({ method: 'chatgpt', confirmPause: true });
  await until(() => states.at(-1)?.phase === 'waiting');
  const attemptId = states.at(-1)?.attemptId;
  await expect(manager.abandon()).resolves.toMatchObject({
    phase: 'complete',
    outcome: 'cancelled',
    activeWorkCount: 1,
  });
  expect(mockRecordGrant).toHaveBeenCalledWith(attemptId, 'fingerprint');
});

it('abandoning an attempt that failed verification keeps its outcome', async () => {
  accountVerifies = false;
  manager.start({ method: 'chatgpt', confirmPause: false });
  await until(() => states.at(-1)?.phase === 'waiting');
  // The device code expired: the login reports failure, and verifying the
  // signed-out account fails too.
  session.complete(false);
  await until(() => states.at(-1)?.phase === 'verification-failed');
  await expect(manager.abandon()).resolves.toMatchObject({
    phase: 'complete',
    outcome: 'failed',
  });
  expect(session.closed).toBe(1);
  expect(pauseReleases).toBe(1);
});

it('a confirmed relaunch runs inside the same sign-in run', async () => {
  pausedChats = 1;
  manager.start({ method: 'chatgpt', confirmPause: false });
  await until(() => states.at(-1)?.phase === 'confirm');
  const [parent] = await signInRuns();
  if (!parent) throw new Error('No parent');
  expect(session.startContexts).toEqual([]);
  manager.start({ method: 'chatgpt', confirmPause: true });
  await until(() => states.at(-1)?.phase === 'waiting');
  const [delegation] = await runtime.localWorker.listDelegations(
    parent.operationId,
  );
  if (!delegation) throw new Error('No dispatch');
  const child = await operations.service.get(delegation.childOperationId);
  expect(child).toMatchObject({ status: 'running' });
  expect(session.startContexts).toHaveLength(1);
  expect(session.startContexts[0]?.provider).toBe('codex');
  expect(await signInRuns()).toHaveLength(1);
});

it('core.operation.cancel cancels the attempt', async () => {
  manager.start({ method: 'chatgpt', confirmPause: false });
  await until(() => states.at(-1)?.phase === 'waiting');
  const [parent] = await signInRuns();
  if (!parent) throw new Error('No parent');
  await runtime.instruction(
    'core.operation.cancel',
    { operationId: parent.operationId, reason: 'stop' },
    { caller },
  );
  await until(() => states.at(-1)?.phase === 'complete');
  expect(states.at(-1)).toMatchObject({
    phase: 'complete',
    outcome: 'cancelled',
  });
});

it('the published login states are unchanged', async () => {
  manager.start({ method: 'chatgpt', confirmPause: false });
  await until(() => states.at(-1)?.phase === 'waiting');
  session.complete(true);
  await until(() => states.at(-1)?.phase === 'complete');
  expect(phases()).toEqual(['pausing', 'waiting', 'verifying', 'complete']);
  expect(states.at(-1)?.outcome).toBe('success');

  session = fakeSession();
  states = [];
  manager.start({ method: 'chatgpt', confirmPause: false });
  await until(() => states.at(-1)?.phase === 'waiting');
  await manager.finish('cancelled');
  await until(() => states.at(-1)?.phase === 'complete');
  expect(phases()).toEqual(['pausing', 'waiting', 'verifying', 'complete']);
  expect(states.at(-1)?.outcome).toBe('cancelled');
});

it('no credential reaches the ledger, receipts or logs', async () => {
  const consoleCalls: unknown[] = [];
  const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(
    (method) =>
      jest.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        consoleCalls.push(args);
      }),
  );
  try {
    manager.start({ method: 'chatgpt', confirmPause: false });
    await until(() => states.at(-1)?.phase === 'waiting');
    const [parent] = await signInRuns();
    if (!parent) throw new Error('No parent');
    session.complete(true);
    await settled(parent.operationId);
    const delegations = await runtime.localWorker.listDelegations(
      parent.operationId,
    );
    const children = await Promise.all(
      delegations.map((entry) =>
        operations.service.get(entry.childOperationId),
      ),
    );
    const recorded = JSON.stringify({
      runs: await operations.service.list({ limit: 50 }),
      delegations,
      children,
      warnings: mockWarn.mock.calls,
      consoleCalls,
    });
    for (const canary of ['person@example.com', 'tok-canary-789']) {
      expect(recorded).not.toContain(canary);
      for (const file of readdirSync(root))
        expect(readFileSync(join(root, file)).includes(canary)).toBe(false);
    }
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
});
