/**
 * CAN-7620: when the fork capability install recovery that starts with the
 * shared-container handlers fails, main.log gets checked strings only, never
 * the error object, its stack or its cause. The real handler registration runs
 * on a data root the golden owns. Replaced: IPC registration, observability,
 * the cloud base URL and HTTP, the recovery itself (it fails on purpose) and
 * the main-process warning sink, which records what would reach main.log.
 */
import type * as CloudConfig from '../canopy-cloud/config';
import type * as Install from '../shared-containers/capability-package/install';
import type * as MainProcessLogging from '../lib/main-process-logging';
import {
  fakeCloud,
  handlers,
  ownDataRoot,
  type OwnedDataRoot,
} from './helpers/shared-containers-golden-harness';

jest.setTimeout(30_000);

const RECOVERY_WARNING =
  '[shared-containers] failed to recover fork capability installs';
const WITHHELD_ERROR =
  'Capability install error withheld because it looks like it holds a credential';
// Assembled from parts so this file never holds a credential-shaped literal.
const FAKE_TOKEN = `gh${'p_'}${'R8s9'.repeat(9)}`;
const FAKE_BODY = 'R8s9R8s9R8s9';

const recovery: { failure: () => Error } = {
  failure: () => new Error('unused'),
};
const warnings: unknown[][] = [];

jest.mock('../ipc/register', () => ({
  registerIpcHandler: (
    channel: string,
    handler: (event: unknown, ...args: unknown[]) => unknown,
  ): void => {
    handlers.set(channel, handler);
  },
}));
jest.mock('../canopy-cloud/config', () => ({
  ...jest.requireActual<typeof CloudConfig>('../canopy-cloud/config'),
  getCanopyCloudBaseUrl: (): string => 'https://cloud.example.test',
}));
jest.mock('../observability', () => ({
  getObservabilityService: (): Record<string, unknown> => ({
    getRetentionDays: (): number => 30,
    recordSessionDiagnostic: (): void => undefined,
  }),
}));
jest.mock('../shared-containers/capability-package/install', () => ({
  ...jest.requireActual<typeof Install>(
    '../shared-containers/capability-package/install',
  ),
  recoverForkCapabilityInstalls: (): Promise<void> =>
    Promise.reject(recovery.failure()),
}));
jest.mock('../lib/main-process-logging', () => ({
  ...jest.requireActual<typeof MainProcessLogging>(
    '../lib/main-process-logging',
  ),
  logMainProcessWarn: (...args: unknown[]): void => {
    warnings.push(args);
  },
}));

let owned: OwnedDataRoot;
let fetchSpy: jest.SpyInstance;

beforeAll(() => {
  owned = ownDataRoot('shared-container-recovery-log-golden-');
  fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(fakeCloud);
});

afterAll(() => {
  fetchSpy?.mockRestore();
  owned?.release();
});

beforeEach(() => {
  warnings.length = 0;
});

/** Registers the handlers and returns what the failed recovery logged. */
async function recoveryWarning(failure: () => Error): Promise<unknown[]> {
  recovery.failure = failure;
  const { registerSharedContainerHandlers } =
    await import('../ipc/shared-containers');
  registerSharedContainerHandlers({
    dispatcher: { instruction: jest.fn() },
    resolveCaller: () => {
      throw new Error('Recovery must not dispatch to core');
    },
  });
  for (let turn = 0; turn < 20; turn += 1) {
    const found = warnings.find((args) => args[0] === RECOVERY_WARNING);
    if (found !== undefined) return found;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('The failed recovery logged nothing');
}

describe('fork capability install recovery in main.log (CAN-7620)', () => {
  it('logs checked strings only when the error and its cause hold a token', async () => {
    const args = await recoveryWarning(
      () =>
        new Error(`journal names ${FAKE_TOKEN}`, {
          cause: new Error(`cause quotes ${FAKE_TOKEN}`),
        }),
    );
    expect(JSON.stringify(args).includes(FAKE_BODY)).toBe(false);
    expect(args.some((arg) => arg instanceof Error)).toBe(false);
    expect(args).toEqual([
      RECOVERY_WARNING,
      { error: WITHHELD_ERROR, errorType: 'Error' },
    ]);
  });

  it('keeps a clean message and the error type, without the stack', async () => {
    const args = await recoveryWarning(
      () => new TypeError('the install journal is unreadable'),
    );
    expect(args).toEqual([
      RECOVERY_WARNING,
      { error: 'the install journal is unreadable', errorType: 'TypeError' },
    ]);
  });
});
