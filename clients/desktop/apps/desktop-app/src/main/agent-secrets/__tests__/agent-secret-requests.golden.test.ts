import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ExecutionSecretGrants } from '@canopy/core-runtime/node/execution-secrets';
import {
  REQUEST_SECRETS_DECLINED_TEXT,
  REQUEST_SECRETS_USAGE_TEXT,
  type RequestSecretsInput,
} from '@canopy/agent-actions';
import { openClaudeAmbientSecretEnv } from '../ambient-env';
import {
  IPC_CHANNELS,
  type McpQuestion,
  type McpQuestionAnswer,
  type PersistedPendingQuestion,
} from '@canopy/desktop-shared/types';
import { IPC_REMOTE_DISPOSITIONS } from '@canopy/desktop-shared/remote-control/channel-dispositions';

jest.mock('../feature-gate', () => ({
  isAgentSecretRequestsEnabled: jest.fn(() => true),
  isRunWithSecretsSupported: jest.fn(() => true),
}));
let ambientDir = '';
jest.mock('../../lib/paths', () => ({
  ...jest.requireActual<object>('../../lib/paths'),
  getAgentSecretAmbientEnvDir: (): string => ambientDir,
}));
jest.mock('../../canopy-tools/session-runtime', () => ({
  requestAnswersFromRenderer: jest.fn(),
}));
jest.mock('../../ipc/chat-state', () => ({
  getChatStateCommandPort: jest.fn(),
}));
type WaitObserver = {
  settled(wait: { waitId: string; status: string }): void;
};
const waitObservers = new Set<WaitObserver>();
const waits = {
  isOpen: jest.fn(() => true),
  observe: (observer: WaitObserver): (() => void) => {
    waitObservers.add(observer);
    return (): void => {
      waitObservers.delete(observer);
    };
  },
};
/** What the answer command does as it commits: settles the open wait. */
function answerWait(waitId: string): void {
  for (const observer of waitObservers)
    observer.settled({ waitId, status: 'answered' });
}
jest.mock('../../chat-waits/desktop-chat-waits', () => ({
  getDesktopChatWaits: (): typeof waits => waits,
}));
jest.mock('../../chat-questions/respond', () => ({
  ...jest.requireActual<object>('../../chat-questions/respond'),
  chatQuestionScope: jest.fn(),
  respondToChatQuestion: jest.fn(),
}));

import { isAgentSecretRequestsEnabled } from '../feature-gate';
import { requestAnswersFromRenderer } from '../../canopy-tools/session-runtime';
import { getChatStateCommandPort } from '../../ipc/chat-state';
import {
  chatQuestionScope,
  respondToChatQuestion,
} from '../../chat-questions/respond';
import {
  CHAT_SECRET_TTL_MS,
  ChatSecretStore,
  chatSecretBindings,
  setChatSecretStoreForTests,
  type ChatSecretScope,
} from '../chat-secret-store';
import {
  declineSecretRequest,
  requestSecrets,
  submitSecretRequest,
  type RequestSecretsHost,
} from '../request-secrets';
import {
  cancelWaitingSecretRequests,
  captureWaitingSecretRequests,
} from '../waiting-secret-requests';
import { desktopExecutionSecretReader } from '../../execution-secrets/reader';
import { executeCanopyInjectedTool } from '../../canopy-tools/core';
import { IPC_PRIVATE_CHANNELS } from '../../ipc/channel-policy';
import type * as RespondModule from '../../chat-questions/respond';

/*
 * Agent secret requests on desktop (U2a): values a person gives through the
 * secret request form reach only the chat's encrypted store and the
 * execution-secret grants; the agent, the pending question, results and
 * audit records see names and states only.
 */

const CANARY = 'canary-7f3e1b29-secret-value';
const SHORT_CANARY = 'cnr5x';
const scope: ChatSecretScope = {
  projectId: 'project-1',
  worktreeId: 'worktree-1',
  chatId: 'chat-1',
};

let dir: string;
let now: number;
let encryptionAvailable: boolean;

function fakeEncryption(): {
  available(): boolean;
  encrypt(text: string): Buffer;
  decrypt(ciphertext: Buffer): string;
} {
  // A reversible stand-in for safeStorage whose ciphertext never contains
  // the plaintext.
  return {
    available: (): boolean => encryptionAvailable,
    encrypt: (text): Buffer =>
      Buffer.from(Buffer.from(text, 'utf8').map((byte) => byte ^ 0x5a)),
    decrypt: (ciphertext): string =>
      Buffer.from(ciphertext.map((byte) => byte ^ 0x5a)).toString('utf8'),
  };
}

function newStore(): ChatSecretStore {
  return new ChatSecretStore({
    filePath: () => join(dir, 'chat-secrets.json'),
    auditFilePath: () => join(dir, 'audit.jsonl'),
    now: () => now,
    encryption: fakeEncryption(),
  });
}

function everything(): string {
  return ['chat-secrets.json', 'audit.jsonl']
    .map((name) => join(dir, name))
    .filter((path) => existsSync(path))
    .map((path) => readFileSync(path, 'utf8'))
    .join('\n');
}

function readFileSyncIfExists(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function expectNoCanary(text: string): void {
  for (const canary of [CANARY, SHORT_CANARY]) {
    expect(text).not.toContain(canary);
    expect(text).not.toContain(Buffer.from(canary).toString('base64'));
    expect(text).not.toContain(Buffer.from(canary).toString('hex'));
  }
}

async function redeem(
  store: ChatSecretStore,
  env: Record<string, string>,
): Promise<Readonly<Record<string, string>>> {
  setChatSecretStoreForTests(store);
  const grants = new ExecutionSecretGrants({
    reader: desktopExecutionSecretReader,
  });
  const bindings = chatSecretBindings(scope, env);
  const audience = {
    operation: 'worker.script.execute' as const,
    key: `run-${Math.random()}`,
  };
  grants.stage(audience, bindings);
  const first = await grants.redeem(
    { audience, bindings },
    new AbortController().signal,
  );
  // Single use: the same grant never reads again.
  await expect(
    grants.redeem({ audience, bindings }, new AbortController().signal),
  ).rejects.toThrow();
  return first.env;
}

const input: RequestSecretsInput = {
  reason: 'Run the checkout integration tests.',
  secrets: [
    {
      name: 'STRIPE_SECRET_KEY',
      label: 'Stripe secret key',
      hint: { prefix: 'sk_test_' },
    },
    { name: 'SENTRY_DSN', required: false },
  ],
};

function host(mode: 'ask' | 'full-access' = 'ask'): RequestSecretsHost {
  return {
    scope,
    sessionKey: 'session-1',
    getWindow: () => null,
    providerType: 'claude',
    getApprovalMode: () => mode,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'agent-secrets-'));
  now = Date.parse('2026-11-16T12:00:00.000Z');
  encryptionAvailable = true;
  waits.isOpen.mockReset();
  waits.isOpen.mockReturnValue(true);
  jest.mocked(isAgentSecretRequestsEnabled).mockReturnValue(true);
  setChatSecretStoreForTests(newStore());
});

afterEach(() => {
  setChatSecretStoreForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

describe('ChatSecretStore', () => {
  it('persists only ciphertext and gives values out only through a single-use grant', async () => {
    const store = newStore();
    await store.put(scope, { STRIPE_SECRET_KEY: CANARY, SHORT: SHORT_CANARY });
    expect(store.storageMode()).toBe('encrypted');
    expect(existsSync(join(dir, 'chat-secrets.json'))).toBe(true);
    expectNoCanary(everything());

    // A fresh process reads the file back.
    const reloaded = newStore();
    expect(
      await reloaded.heldNames(scope, ['STRIPE_SECRET_KEY', 'NOPE']),
    ).toEqual(['STRIPE_SECRET_KEY']);
    expect(
      await redeem(reloaded, { STRIPE_KEY: 'STRIPE_SECRET_KEY', S: 'SHORT' }),
    ).toEqual({ STRIPE_KEY: CANARY, S: SHORT_CANARY });
    // Another chat's bindings never read this chat's values.
    expect(await reloaded.readForExecution('other-record', ['ssr1_x'])).toEqual(
      new Map(),
    );
  });

  it('keeps values in memory only when secure storage is unavailable', async () => {
    encryptionAvailable = false;
    const store = newStore();
    expect(store.storageMode()).toBe('session');
    await store.put(scope, { STRIPE_SECRET_KEY: CANARY });
    expect(existsSync(join(dir, 'chat-secrets.json'))).toBe(false);
    expect(await redeem(store, { K: 'STRIPE_SECRET_KEY' })).toEqual({
      K: CANARY,
    });
    expect(await newStore().heldNames(scope, ['STRIPE_SECRET_KEY'])).toEqual(
      [],
    );
  });

  it('refuses empty, oversized and badly named values', async () => {
    const store = newStore();
    await expect(
      store.put(scope, { STRIPE_SECRET_KEY: '   ' }),
    ).rejects.toThrow('Invalid secret value');
    await expect(
      store.put(scope, { STRIPE_SECRET_KEY: 'x'.repeat(16_385) }),
    ).rejects.toThrow('Invalid secret value');
    await expect(store.put(scope, { 'lower-case': 'value' })).rejects.toThrow(
      'Invalid secret name',
    );
    await store.put(scope, { STRIPE_SECRET_KEY: 'x'.repeat(16_384) });
  });

  it('never resurrects a revoked value and retries a deletion the disk refused', async () => {
    const store = newStore();
    const undo = await store.put(scope, { STRIPE_SECRET_KEY: CANARY });
    expect(await store.remove(scope)).toEqual(['STRIPE_SECRET_KEY']);
    await undo();
    expect(await store.listNames(scope)).toEqual([]);

    // Overlapping requests that both fail, settling out of order, never put
    // back either refused value.
    const undoA = await store.put(scope, { X_KEY: CANARY });
    const undoB = await store.put(scope, { X_KEY: SHORT_CANARY });
    await undoA();
    await undoB();
    expect(await store.listNames(scope)).toEqual([]);
    await store.put(scope, { X_KEY: 'earlier-value' });
    const undoC = await store.put(scope, { X_KEY: CANARY });
    const undoD = await store.put(scope, { X_KEY: SHORT_CANARY });
    await undoC();
    await undoD();
    expect(await redeem(store, { X: 'X_KEY' })).toEqual({
      X: 'earlier-value',
    });
    await store.remove(scope);

    const other = { ...scope, chatId: 'chat-2' };
    const elsewhere = { ...scope, worktreeId: 'worktree-2' };
    await store.put(scope, { A_KEY: CANARY });
    await store.put(other, { B_KEY: CANARY });
    await store.put(elsewhere, { C_KEY: CANARY });
    expect(
      await store.removeScope({
        projectId: scope.projectId,
        worktreeId: scope.worktreeId,
      }),
    ).toEqual([
      { scope, names: ['A_KEY'] },
      { scope: other, names: ['B_KEY'] },
    ]);
    expect(await store.listNames(elsewhere)).toEqual(['C_KEY']);

    // A deletion the disk refuses still takes effect at once, and the next
    // write (the hourly sweep at the latest) takes it off the disk. A chat
    // that ends deletes everything; a revocation keeps the value for
    // redaction only (CONTRACTS.md §4a), covered with RunWithSecrets.
    let refuse = false;
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, '');
    const flakyStore = (): ChatSecretStore =>
      new ChatSecretStore({
        filePath: (): string =>
          refuse ? join(blocker, 'chat-secrets.json') : join(dir, 'flaky.json'),
        auditFilePath: (): string => join(dir, 'audit.jsonl'),
        now: (): number => now,
        encryption: fakeEncryption(),
      });
    const flaky = flakyStore();
    await flaky.put(scope, { D_KEY: CANARY });
    refuse = true;
    await expect(flaky.endChat(scope)).rejects.toThrow();
    expect(await flaky.listNames(scope)).toEqual([]);
    await expect(redeem(flaky, { D: 'D_KEY' })).rejects.toThrow(
      'no longer available',
    );
    refuse = false;
    expect(existsSync(join(dir, 'flaky.json'))).toBe(true);
    expect(await flaky.sweepExpired()).toEqual([]);
    expect(existsSync(join(dir, 'flaky.json'))).toBe(false);
    expect(await flakyStore().listNames(scope)).toEqual([]);

    // An undo whose write fails still takes the refused submission away.
    const undoing = flakyStore();
    await undoing.put(scope, { E_KEY: 'earlier-value' });
    const undoE = await undoing.put(scope, { E_KEY: CANARY, F_KEY: CANARY });
    refuse = true;
    await expect(undoE()).rejects.toThrow();
    expect(await undoing.listNames(scope)).toEqual(['E_KEY']);
    expect(await redeem(undoing, { E: 'E_KEY' })).toEqual({
      E: 'earlier-value',
    });
    refuse = false;
    await undoing.sweepExpired();
    expect(await flakyStore().listNames(scope)).toEqual(['E_KEY']);
    expect(await redeem(flakyStore(), { E: 'E_KEY' })).toEqual({
      E: 'earlier-value',
    });
  });

  it('never starts from an empty store when the file cannot be read', async () => {
    const seeded = newStore();
    const archived = { ...scope, worktreeId: 'worktree-archived' };
    await seeded.put(scope, {
      STRIPE_SECRET_KEY: CANARY,
      DATABASE_URL: CANARY,
    });
    await seeded.put(archived, { OLD_KEY: CANARY });
    const file = join(dir, 'chat-secrets.json');
    const original = readFileSync(file, 'utf8');
    let failRead = true;
    const store = new ChatSecretStore({
      filePath: (): string => file,
      auditFilePath: (): string => join(dir, 'audit.jsonl'),
      now: (): number => now,
      encryption: fakeEncryption(),
      readFile: (path: string): Promise<string> =>
        failRead
          ? Promise.reject(
              Object.assign(new Error('permission denied'), { code: 'EACCES' }),
            )
          : Promise.resolve(readFileSync(path, 'utf8')),
    });
    await expect(store.sweepExpired()).rejects.toThrow('permission denied');
    await expect(store.remove(scope, ['OTHER'])).rejects.toThrow();
    await expect(store.listNames(scope)).rejects.toThrow();
    // Revocations made meanwhile wait for the read that succeeds.
    await expect(store.remove(scope, ['DATABASE_URL'])).rejects.toThrow();
    await expect(
      store.removeScope({
        projectId: archived.projectId,
        worktreeId: archived.worktreeId,
      }),
    ).rejects.toThrow();
    expect(readFileSync(file, 'utf8')).toBe(original);
    // The next operation reads again and applies them first.
    failRead = false;
    expect(await store.listNames(scope)).toEqual(['STRIPE_SECRET_KEY']);
    expect(await store.listNames(archived)).toEqual([]);
    await expect(redeem(store, { D: 'DATABASE_URL' })).rejects.toThrow(
      'no longer available',
    );
    await store.sweepExpired();
    expect(await newStore().listNames(scope)).toEqual(['STRIPE_SECRET_KEY']);
    expect(await newStore().listNames(archived)).toEqual([]);

    // A file from a newer version is left alone too.
    const newer = JSON.stringify({ version: 2, chats: [] });
    writeFileSync(file, newer);
    await expect(newStore().sweepExpired()).rejects.toThrow('format');
    expect(readFileSync(file, 'utf8')).toBe(newer);
  });

  it('deletes values on chat close and seven days after they were given', async () => {
    const store = newStore();
    await store.put(scope, { STRIPE_SECRET_KEY: CANARY });
    now += CHAT_SECRET_TTL_MS - 1;
    expect(await store.heldNames(scope, ['STRIPE_SECRET_KEY'])).toHaveLength(1);
    now += 1;
    expect(await store.heldNames(scope, ['STRIPE_SECRET_KEY'])).toEqual([]);
    // A read that skips an expired value leaves it for the sweep, which
    // deletes its ciphertext from disk too.
    expect(await store.sweepExpired()).toEqual([
      { scope, names: ['STRIPE_SECRET_KEY'] },
    ]);
    expect(existsSync(join(dir, 'chat-secrets.json'))).toBe(false);

    await store.put(scope, { A_KEY: CANARY, B_KEY: CANARY });
    now += CHAT_SECRET_TTL_MS;
    expect(await store.sweepExpired()).toEqual([
      { scope, names: ['A_KEY', 'B_KEY'] },
    ]);
    expect(existsSync(join(dir, 'chat-secrets.json'))).toBe(false);

    // Undo restores exactly what one put replaced.
    await store.put(scope, { C_KEY: 'first-value' });
    const undo = await store.put(scope, { C_KEY: CANARY, D_KEY: CANARY });
    await undo();
    expect(await store.listNames(scope)).toEqual(['C_KEY']);
    expect(await redeem(store, { C: 'C_KEY' })).toEqual({ C: 'first-value' });
    expect(await store.remove(scope)).toEqual(['C_KEY']);
    expect(await store.listNames(scope)).toEqual([]);
    expectNoCanary(everything());
  });
});

describe('RequestSecrets', () => {
  it('returns at once in Full access when the chat holds every name', async () => {
    const store = newStore();
    setChatSecretStoreForTests(store);
    await store.put(scope, { STRIPE_SECRET_KEY: CANARY, SENTRY_DSN: CANARY });
    const result = await requestSecrets(host('full-access'), input);
    expect(requestAnswersFromRenderer).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: 'provided',
      secrets: [
        {
          name: 'STRIPE_SECRET_KEY',
          state: 'provided',
          source: 'chat',
          scope: 'chat',
        },
        {
          name: 'SENTRY_DSN',
          state: 'provided',
          source: 'chat',
          scope: 'chat',
        },
      ],
      usage: REQUEST_SECRETS_USAGE_TEXT,
    });
  });

  it('always shows the form in Ask, marks held names, and waits as a person-only secret question', async () => {
    const store = newStore();
    setChatSecretStoreForTests(store);
    await store.put(scope, { STRIPE_SECRET_KEY: CANARY });
    let shown: McpQuestion[] = [];
    jest.mocked(requestAnswersFromRenderer).mockImplementation((options) => {
      shown = options.questions;
      expect(options.personOnly).toBe(true);
      expect(options.askUserTimeoutMs).toBe(3_540_000);
      const answer: McpQuestionAnswer = {
        question: options.questions[0]?.question ?? '',
        selectedOptions: [],
        freeformText: JSON.stringify({
          action: 'provide',
          secrets: [
            { name: 'STRIPE_SECRET_KEY', state: 'provided', source: 'chat' },
            { name: 'SENTRY_DSN', state: 'skipped' },
          ],
        }),
      };
      return Promise.resolve([answer]);
    });
    const result = await requestSecrets(host('ask'), input);
    expect(shown).toHaveLength(1);
    expect(shown[0]?.secret).toBe(true);
    expect(shown[0]?.question).toBe('Claude needs 2 secrets');
    expect(shown[0]?.secretRequest).toEqual({
      reason: input.reason,
      agentName: 'Claude',
      accessMode: 'ask',
      storage: 'encrypted',
      secrets: [
        {
          name: 'STRIPE_SECRET_KEY',
          label: 'Stripe secret key',
          hint: { prefix: 'sk_test_' },
          held: true,
        },
        { name: 'SENTRY_DSN', required: false },
      ],
    });
    expect(result).toEqual({
      status: 'partial',
      secrets: [
        {
          name: 'STRIPE_SECRET_KEY',
          state: 'provided',
          source: 'chat',
          scope: 'chat',
        },
        { name: 'SENTRY_DSN', state: 'skipped' },
      ],
      usage: REQUEST_SECRETS_USAGE_TEXT,
    });
    expectNoCanary(JSON.stringify({ shown, result }));
  });

  it.each([
    ['ask_user_timeout', 'expired'],
    ['cancelled', 'declined'],
    ['ask_user_cancelled', 'cancelled'],
  ])(
    'maps a %s wait to %s with the fixed decline text',
    async (reason, status) => {
      jest
        .mocked(requestAnswersFromRenderer)
        .mockRejectedValue(new Error(reason));
      const result = await requestSecrets(host(), input);
      expect(result.status).toBe(status);
      expect(result.secrets.every((s) => s.state === 'skipped')).toBe(true);
      expect(result.usage).toBe(
        `${REQUEST_SECRETS_USAGE_TEXT} ${REQUEST_SECRETS_DECLINED_TEXT}`,
      );
    },
  );

  it("a Stop of the chat cancels its waiting request through the wait's own abort, and no other chat's", async () => {
    setChatSecretStoreForTests(newStore());
    // The renderer wait settles as `ask_user_cancelled` when its signal
    // aborts, as `requestAnswersFromRenderer` does: it closes the wait so a
    // late answer is refused, and consumes the form.
    const signals = new Map<string, AbortSignal>();
    jest.mocked(requestAnswersFromRenderer).mockImplementation(
      (options) =>
        new Promise((_resolve, reject) => {
          const signal = options.signal;
          if (!signal) {
            reject(new Error('no signal'));
            return;
          }
          signals.set(options.chatId, signal);
          options.onRequestCreated?.(`request-${options.chatId}`);
          signal.addEventListener('abort', () =>
            reject(new Error('ask_user_cancelled')),
          );
        }),
    );
    const other: ChatSecretScope = { ...scope, chatId: 'chat-2' };
    const stopped = requestSecrets(host('ask'), input);
    const waiting = requestSecrets({ ...host('ask'), scope: other }, input);
    for (let tries = 0; signals.size < 2 && tries < 200; tries += 1)
      await new Promise((resolve) => setTimeout(resolve, 5));
    expect([...signals.keys()].sort()).toEqual(['chat-1', 'chat-2']);

    expect(cancelWaitingSecretRequests(scope)).toBe(1);
    const result = await stopped;
    expect(result.status).toBe('cancelled');
    expect(result.secrets.every((s) => s.state === 'skipped')).toBe(true);
    expect(signals.get('chat-2')?.aborted).toBe(false);
    // Settled requests leave nothing to cancel.
    expect(cancelWaitingSecretRequests(scope)).toBe(0);

    expect(cancelWaitingSecretRequests(other)).toBe(1);
    expect((await waiting).status).toBe('cancelled');
  });

  it('a Stop cancels only the requests waiting when it began, not one a newer turn opens', async () => {
    setChatSecretStoreForTests(newStore());
    const signals: AbortSignal[] = [];
    jest.mocked(requestAnswersFromRenderer).mockImplementation(
      (options) =>
        new Promise((_resolve, reject) => {
          if (options.signal) signals.push(options.signal);
          options.signal?.addEventListener('abort', () =>
            reject(new Error('ask_user_cancelled')),
          );
        }),
    );
    const waitFor = async (count: number): Promise<void> => {
      for (let tries = 0; signals.length < count && tries < 200; tries += 1)
        await new Promise((resolve) => setTimeout(resolve, 5));
    };
    const older = requestSecrets(host('ask'), input);
    await waitFor(1);
    const stop = captureWaitingSecretRequests(scope);
    const newer = requestSecrets(host('ask'), input);
    await waitFor(2);
    expect(stop()).toBe(1);
    expect((await older).status).toBe('cancelled');
    expect(signals[1]?.aborted).toBe(false);
    expect(cancelWaitingSecretRequests(scope)).toBe(1);
    expect((await newer).status).toBe('cancelled');
  });

  it('runs through the injected-tool executor and fails closed without a runtime', async () => {
    const requestSecretsRuntime = jest.fn(() =>
      Promise.resolve({
        status: 'declined' as const,
        secrets: [],
        usage: 'x',
      }),
    );
    const runtime = {
      requestUserAnswers: jest.fn(),
      loadScriptOutput: jest.fn(),
      requestSecrets: requestSecretsRuntime,
    };
    const ok = await executeCanopyInjectedTool(
      'request_secrets',
      input,
      runtime,
    );
    expect(JSON.parse(ok.text)).toMatchObject({ status: 'declined' });
    const bad = await executeCanopyInjectedTool(
      'request_secrets',
      { reason: 'x', secrets: [{ name: 'lower' }] },
      runtime,
    );
    expect(bad.isError).toBe(true);
    const unavailable = await executeCanopyInjectedTool(
      'request_secrets',
      input,
      { ...runtime, requestSecrets: undefined },
    );
    expect(unavailable.isError).toBe(true);
    expect(unavailable.text).toContain('capability_unavailable');
    for (const key of ['run_with_secrets', 'write_secrets_file'] as const) {
      const refused = await executeCanopyInjectedTool(key, {}, runtime);
      expect(refused.isError).toBe(true);
    }
  });
});

describe('secretRequest.submit and decline', () => {
  const requestId = '7a4c6e0c-5d0e-4f5a-9b7e-0b3a1e2f4c5d';
  let record: PersistedPendingQuestion;

  beforeEach(() => {
    record = {
      requestId,
      toolUseId: 'codex-call-1',
      chatId: scope.chatId,
      questions: [
        {
          id: 'secret-request',
          question: 'Claude needs 2 secrets',
          options: [],
          secret: true,
          secretRequest: {
            reason: input.reason,
            agentName: 'Claude',
            accessMode: 'ask',
            storage: 'encrypted',
            secrets: [
              { name: 'STRIPE_SECRET_KEY' },
              { name: 'SENTRY_DSN', required: false },
            ],
          },
        },
      ],
    };
    jest.mocked(chatQuestionScope).mockReturnValue({
      workspaceId: scope.projectId,
      worktreeId: scope.worktreeId,
      chatId: scope.chatId,
    });
    jest.mocked(getChatStateCommandPort).mockReturnValue({
      getState: jest.fn(() =>
        Promise.resolve({ tabsFile: { pendingQuestions: [record] } }),
      ),
      command: jest.fn(),
    } as never);
  });

  it('a submission that starts after Stop began is refused and stores nothing', async () => {
    const store = newStore();
    setChatSecretStoreForTests(store);
    let waitSignal: AbortSignal | undefined;
    jest.mocked(requestAnswersFromRenderer).mockImplementation(
      (options) =>
        new Promise((_resolve, reject) => {
          waitSignal = options.signal;
          options.signal?.addEventListener('abort', () =>
            reject(new Error('ask_user_cancelled')),
          );
          options.onRequestCreated?.(requestId);
        }),
    );
    const request = requestSecrets(host('ask'), input);
    for (let tries = 0; !waitSignal && tries < 200; tries += 1)
      await new Promise((resolve) => setTimeout(resolve, 5));
    // Stop has begun and is still interrupting the provider.
    const stop = captureWaitingSecretRequests(scope);
    expect(
      await submitSecretRequest({
        requestId,
        values: { STRIPE_SECRET_KEY: CANARY },
        useHeld: [],
      }),
    ).toEqual({ accepted: false, error: 'This request is no longer waiting.' });
    expect(respondToChatQuestion).not.toHaveBeenCalled();
    expect(stop()).toBe(1);
    expect((await request).status).toBe('cancelled');
    expect(await store.heldNames(scope, ['STRIPE_SECRET_KEY'])).toEqual([]);
  });

  it('a Stop during a submission waits for it: an accepted answer stands, a refused one is then cancelled', async () => {
    const store = newStore();
    setChatSecretStoreForTests(store);
    let settleWait: ((answers: McpQuestionAnswer[]) => void) | undefined;
    let waitSignal: AbortSignal | undefined;
    jest.mocked(requestAnswersFromRenderer).mockImplementation(
      (options) =>
        new Promise((resolve, reject) => {
          waitSignal = options.signal;
          settleWait = resolve;
          options.signal?.addEventListener('abort', () =>
            reject(new Error('ask_user_cancelled')),
          );
          options.onRequestCreated?.(requestId);
        }),
    );
    const getState = jest.fn();
    jest.mocked(getChatStateCommandPort).mockReturnValue({
      getState,
      command: jest.fn(),
    } as never);
    const startRequest = async (): Promise<{
      result: Promise<Awaited<ReturnType<typeof requestSecrets>>>;
    }> => {
      waitSignal = undefined;
      const result = requestSecrets(host('ask'), input);
      for (let tries = 0; !waitSignal && tries < 200; tries += 1)
        await new Promise((resolve) => setTimeout(resolve, 5));
      return { result };
    };
    /** Holds the submission at its first read until `release`. */
    const holdSubmission = (): ((records: unknown[]) => void) => {
      let release: (records: unknown[]) => void = () => undefined;
      getState.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = (records): void =>
              resolve({ tabsFile: { pendingQuestions: records } });
          }),
      );
      return (records): void => release(records);
    };

    // Refused: the Stop it waited for cancels the request afterwards.
    const refusedRequest = await startRequest();
    let release = holdSubmission();
    const refused = submitSecretRequest({
      requestId,
      values: { STRIPE_SECRET_KEY: CANARY },
      useHeld: [],
    });
    expect(cancelWaitingSecretRequests(scope)).toBe(0);
    expect(waitSignal?.aborted).toBe(false);
    release([]);
    expect(await refused).toEqual({
      accepted: false,
      error: 'This request is no longer waiting.',
    });
    expect((await refusedRequest.result).status).toBe('cancelled');
    expect(await store.heldNames(scope, ['STRIPE_SECRET_KEY'])).toEqual([]);

    // Accepted: the answer the person sent before the Stop stands.
    const acceptedRequest = await startRequest();
    release = holdSubmission();
    getState.mockResolvedValue({ tabsFile: { pendingQuestions: [record] } });
    jest.mocked(respondToChatQuestion).mockImplementation((request) => {
      const text =
        request.response.kind === 'answer'
          ? (request.response.answers[0]?.freeformText ?? '')
          : '';
      settleWait?.([
        {
          question: 'Claude needs 2 secrets',
          selectedOptions: [],
          freeformText: text,
        },
      ]);
      answerWait(request.questionId);
      return Promise.resolve({ status: 'applied', result: {} as never });
    });
    const accepted = submitSecretRequest({
      requestId,
      values: { STRIPE_SECRET_KEY: CANARY },
      useHeld: [],
    });
    expect(cancelWaitingSecretRequests(scope)).toBe(0);
    release([record]);
    expect(await accepted).toEqual({ accepted: true });
    expect((await acceptedRequest.result).status).toBe('partial');
    expect(waitSignal?.aborted).toBe(false);
    expect(await store.heldNames(scope, ['STRIPE_SECRET_KEY'])).toEqual([
      'STRIPE_SECRET_KEY',
    ]);
  });

  it('stores values before settling the wait with names and states only', async () => {
    const store = newStore();
    setChatSecretStoreForTests(store);
    let heldAtSettle: string[] = [];
    jest.mocked(respondToChatQuestion).mockImplementation(async (request) => {
      heldAtSettle = await store.heldNames(scope, ['STRIPE_SECRET_KEY']);
      expect(request.executionOptions).toEqual({
        answeredByPerson: true,
        secretRequestSettlement: true,
      });
      expectNoCanary(JSON.stringify(request));
      answerWait(request.questionId);
      return { status: 'applied', result: {} as never };
    });
    const response = await submitSecretRequest({
      requestId,
      values: { STRIPE_SECRET_KEY: CANARY },
      useHeld: [],
    });
    expect(response).toEqual({ accepted: true });
    expect(heldAtSettle).toEqual(['STRIPE_SECRET_KEY']);
    const answer = jest.mocked(respondToChatQuestion).mock.calls[0]?.[0]
      .response;
    expect(answer).toEqual({
      kind: 'answer',
      answers: [
        {
          questionId: 'secret-request',
          question: 'Claude needs 2 secrets',
          selectedOptions: [],
          freeformText: JSON.stringify({
            action: 'provide',
            secrets: [
              {
                name: 'STRIPE_SECRET_KEY',
                state: 'provided',
                source: 'entered',
              },
              { name: 'SENTRY_DSN', state: 'skipped' },
            ],
          }),
        },
      ],
    });
    expectNoCanary(everything());
  });

  // Windows has no ambient values file (tools only).
  const itPosix = process.platform === 'win32' ? it.skip : it;
  itPosix(
    "settles only once a Full-access chat's own commands can read the new values",
    async () => {
      const store = newStore();
      setChatSecretStoreForTests(store);
      ambientDir = mkdtempSync(
        join(process.env.TMPDIR ?? tmpdir(), 'agent-secrets-ambient-'),
      );
      const ambient = await openClaudeAmbientSecretEnv({
        scope,
        getApprovalMode: () => 'full-access',
      });
      if (!ambient) throw new Error('no ambient env');
      try {
        let fileAtSettle = '';
        jest.mocked(respondToChatQuestion).mockImplementation((request) => {
          fileAtSettle = existsSync(ambient.valuesPath)
            ? readFileSync(ambient.valuesPath, 'utf8')
            : '';
          answerWait(request.questionId);
          return Promise.resolve({ status: 'applied', result: {} as never });
        });
        const response = await submitSecretRequest({
          requestId,
          values: { STRIPE_SECRET_KEY: CANARY },
          useHeld: [],
        });
        expect(response).toEqual({ accepted: true });
        expect(fileAtSettle).toContain('export STRIPE_SECRET_KEY=');
      } finally {
        await ambient.dispose();
        rmSync(ambientDir, { recursive: true, force: true });
      }
    },
  );

  it('drops the values when the wait expires before the answer commits', async () => {
    const store = newStore();
    setChatSecretStoreForTests(store);
    // The command applies, but the wait had already timed out: nothing
    // settled it as answered.
    jest
      .mocked(respondToChatQuestion)
      .mockResolvedValue({ status: 'applied', result: {} as never });
    const response = await submitSecretRequest({
      requestId,
      values: { STRIPE_SECRET_KEY: CANARY },
      useHeld: [],
    });
    expect(response.accepted).toBe(false);
    expect(await store.listNames(scope)).toEqual([]);
  });

  it('keeps a request shown as session-only in memory after storage returns', async () => {
    const store = newStore();
    setChatSecretStoreForTests(store);
    const shown = record.questions[0]?.secretRequest;
    if (shown) shown.storage = 'session';
    jest.mocked(respondToChatQuestion).mockImplementation((request) => {
      answerWait(request.questionId);
      return Promise.resolve({ status: 'applied', result: {} as never });
    });
    // Secure storage is available again by the time the person submits.
    expect(
      await submitSecretRequest({
        requestId,
        values: { STRIPE_SECRET_KEY: CANARY },
        useHeld: [],
      }),
    ).toEqual({ accepted: true });
    expect(await store.listNames(scope)).toEqual(['STRIPE_SECRET_KEY']);
    expect(existsSync(join(dir, 'chat-secrets.json'))).toBe(false);
    expect(await newStore().listNames(scope)).toEqual([]);
    // The provided audit line is written after the reply.
    while (!existsSync(join(dir, 'audit.jsonl')))
      await new Promise((resolve) => setImmediate(resolve));
  });

  it('refuses invalid submissions without storing anything', async () => {
    const store = newStore();
    setChatSecretStoreForTests(store);
    const submissions: Array<{
      values: Record<string, string>;
      useHeld: string[];
    }> = [
      { values: { UNKNOWN: CANARY }, useHeld: [] },
      { values: { SENTRY_DSN: CANARY }, useHeld: [] },
      { values: { STRIPE_SECRET_KEY: '  ' }, useHeld: [] },
      { values: {}, useHeld: ['STRIPE_SECRET_KEY'] },
    ];
    for (const submission of submissions) {
      const response = await submitSecretRequest({ requestId, ...submission });
      expect(response.accepted).toBe(false);
      expectNoCanary(JSON.stringify(response));
    }
    expect(respondToChatQuestion).not.toHaveBeenCalled();
    expect(await store.listNames(scope)).toEqual([]);
  });

  it('takes the first answer only and drops values a refused settle stored', async () => {
    const store = newStore();
    setChatSecretStoreForTests(store);
    let release: () => void = () => undefined;
    jest.mocked(respondToChatQuestion).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = (): void => resolve({ status: 'cancelled' });
        }),
    );
    const first = submitSecretRequest({
      requestId,
      values: { STRIPE_SECRET_KEY: CANARY },
      useHeld: [],
    });
    while (jest.mocked(respondToChatQuestion).mock.calls.length === 0)
      await new Promise((resolve) => setImmediate(resolve));
    const second = await submitSecretRequest({
      requestId,
      values: { STRIPE_SECRET_KEY: 'another-value' },
      useHeld: [],
    });
    expect(second.accepted).toBe(false);
    release();
    expect((await first).accepted).toBe(false);
    expect(await store.listNames(scope)).toEqual([]);
  });

  it('refuses when the flag is off or the wait closed, and declines with names only', async () => {
    jest.mocked(isAgentSecretRequestsEnabled).mockReturnValueOnce(false);
    expect(
      (
        await submitSecretRequest({
          requestId,
          values: { STRIPE_SECRET_KEY: CANARY },
          useHeld: [],
        })
      ).accepted,
    ).toBe(false);
    waits.isOpen.mockReturnValueOnce(false);
    expect(
      (
        await submitSecretRequest({
          requestId,
          values: { STRIPE_SECRET_KEY: CANARY },
          useHeld: [],
        })
      ).accepted,
    ).toBe(false);
    jest.mocked(respondToChatQuestion).mockImplementation((request) => {
      answerWait(request.questionId);
      return Promise.resolve({ status: 'applied', result: {} as never });
    });
    expect(await declineSecretRequest(requestId)).toEqual({ accepted: true });
    expect(
      jest.mocked(respondToChatQuestion).mock.calls[0]?.[0].response,
    ).toMatchObject({
      kind: 'answer',
      answers: [
        {
          freeformText: JSON.stringify({
            action: 'decline',
            secrets: [
              { name: 'STRIPE_SECRET_KEY', state: 'skipped' },
              { name: 'SENTRY_DSN', state: 'skipped' },
            ],
          }),
        },
      ],
    });
  });

  // U7: a paired browser or phone answers through the same settlement, so
  // it gets the same rules; only the audit line names where it came from.
  it('settles a paired answer once, kept for the chat, and audits its origin', async () => {
    const store = newStore();
    setChatSecretStoreForTests(store);
    jest.mocked(respondToChatQuestion).mockImplementation((request) => {
      expect(request.executionOptions).toEqual({
        answeredByPerson: true,
        secretRequestSettlement: true,
      });
      answerWait(request.questionId);
      // The settled record, as the chat state commits it.
      record = { ...record, answeredAt: 1 };
      return Promise.resolve({ status: 'applied', result: {} as never });
    });
    expect(
      await submitSecretRequest(
        { requestId, values: { STRIPE_SECRET_KEY: CANARY }, useHeld: [] },
        { answeredFrom: 'browser' },
      ),
    ).toEqual({ accepted: true });
    // The same answer again, resent or after a reconnect, never settles
    // twice or replaces the value.
    const again = await submitSecretRequest(
      {
        requestId,
        values: { STRIPE_SECRET_KEY: 'another-value' },
        useHeld: [],
      },
      { answeredFrom: 'mobile' },
    );
    expect(again).toEqual({
      accepted: false,
      error: 'This request was already answered.',
    });
    expect(
      await declineSecretRequest(requestId, { answeredFrom: 'mobile' }),
    ).toEqual({
      accepted: false,
      error: 'This request was already answered.',
    });
    expect(respondToChatQuestion).toHaveBeenCalledTimes(1);
    expect(await store.listNames(scope)).toEqual(['STRIPE_SECRET_KEY']);
    // The audit line is written without holding up the answer.
    const auditPath = join(dir, 'audit.jsonl');
    for (let tries = 0; tries < 100; tries += 1) {
      if (readFileSyncIfExists(auditPath).includes('"provided"')) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const audit = readFileSync(auditPath, 'utf8')
      .trim()
      .split('\n')
      .map((line): unknown => JSON.parse(line));
    expect(audit).toContainEqual(
      expect.objectContaining({
        event: 'provided',
        names: ['STRIPE_SECRET_KEY'],
        answeredFrom: 'browser',
      }),
    );
    expectNoCanary(everything());
  });

  it('refuses every other answer or dismissal of a secret request', async () => {
    const { respondToChatQuestion: realRespond } = jest.requireActual<
      typeof RespondModule
    >('../../chat-questions/respond');
    const port = {
      getState: jest.fn(() =>
        Promise.resolve({ tabsFile: { pendingQuestions: [record] } }),
      ),
      command: jest.fn(),
    };
    const answer = {
      kind: 'answer' as const,
      answers: [{ question: 'x', selectedOptions: [], freeformText: '{}' }],
    };
    const dismiss = { kind: 'dismiss' as const };
    // By request id, and by the tool-use id alias the chat state also
    // settles a question by.
    for (const [questionId, response] of [
      [requestId, answer],
      [requestId, dismiss],
      ['codex-call-1', answer],
      ['codex-call-1', dismiss],
    ] as const) {
      const outcome = await realRespond({
        scope: { projectId: scope.projectId, worktreeId: scope.worktreeId },
        chatId: scope.chatId,
        questionId,
        response,
        commandId: 'command-1',
        executionOptions: { answeredByPerson: true },
        port: port as never,
      });
      expect(outcome.status).toBe('invalid');
    }
    expect(port.command).not.toHaveBeenCalled();
  });
});

describe('exposure', () => {
  it('keeps the submission channels private and away from remote control', () => {
    for (const channel of [
      IPC_CHANNELS.secretRequestSubmit,
      IPC_CHANNELS.secretRequestDecline,
    ]) {
      expect(IPC_PRIVATE_CHANNELS.has(channel)).toBe(true);
    }
    expect(IPC_REMOTE_DISPOSITIONS.secretRequestSubmit).toBe('blocked');
    expect(IPC_REMOTE_DISPOSITIONS.secretRequestDecline).toBe('blocked');
    // mcp:dismiss-user still tunnels; the answer path's refusal (above)
    // keeps it from settling a secret request, and its handler no longer
    // cancels a wait that path refused.
    expect(IPC_CHANNELS.mcpDismissUser).toBe('mcp:dismiss-user');
    expect(IPC_REMOTE_DISPOSITIONS.mcpDismissUser).toBe('tunnel');
  });
});
