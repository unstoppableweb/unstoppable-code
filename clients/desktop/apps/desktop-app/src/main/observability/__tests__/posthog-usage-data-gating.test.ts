import {
  CLIENT_FEATURE_FLAGS,
  getDefaultFeatureFlagSnapshot,
} from '@canopy/protocol/feature-flags';
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sweepStartupCrashDumps } from '../crash-dump-sweep';
import {
  classifyError,
  createAppError,
  createSurfacedErrorRecorder,
} from '@canopy/protocol/app-errors';
import { JSDOM } from 'jsdom';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isNativeError } from 'node:util/types';
import type * as ClientModule from '@canopy/desktop-instrumentation/client';
import type { PostHogRuntimeFlags } from '@canopy/desktop-instrumentation/types';
import type * as ElectronMainModule from '@canopy/desktop-instrumentation/electron/main';

interface CapturedMessage {
  event: string;
  uuid?: string;
  distinctId?: string;
  timestamp?: Date;
  properties: Record<string, unknown>;
}

type PostHogFetch = (
  url: string,
  options: { method: 'POST'; headers: Record<string, string>; body: string },
) => Promise<unknown>;

const mockCapture = jest.fn<
  void,
  [{ distinctId?: string; event: string; properties?: Record<string, unknown> }]
>();
const mockCaptureException = jest.fn<
  void,
  [unknown, string | undefined, Record<string, unknown>, string?]
>();
const mockFlush = jest.fn<Promise<void>, []>();
const mockShutdown = jest.fn<Promise<void>, [number]>();
const mockConstructor = jest.fn<object, [string, unknown]>(() => ({
  capture: mockCapture,
  captureException: mockCaptureException,
  flush: mockFlush,
  shutdown: mockShutdown,
  on: jest.fn(),
}));
jest.mock('posthog-node', () => ({ PostHog: mockConstructor }), {
  virtual: true,
});
type BeforeSend = (event: CapturedMessage) => unknown;
let mockBeforeSend: BeforeSend | undefined;
/** Enough of the browser SDK for the renderer client to initialize. */
const mockBrowserSdk = {
  init: jest.fn((_key: string, config: { before_send?: BeforeSend }) => {
    mockBeforeSend = config.before_send;
  }),
  onSessionId: jest.fn(() => (): void => undefined),
  capture: jest.fn(),
  captureException: jest.fn<void, [unknown, Record<string, unknown>?]>(),
  register_for_session: jest.fn(),
  unregister_for_session: jest.fn(),
  sessionManager: { setBootstrapSessionId: (): boolean => true },
  requestRouter: { endpointFor: (): string => 'http://127.0.0.1:18763/s/' },
  _send_request: jest.fn(),
  _send_retriable_request: jest.fn(),
  _retryQueue: {
    retriableRequest: jest.fn(),
    unload: jest.fn(),
    resume: jest.fn(),
  },
  _requestQueue: { unload: jest.fn() },
  set_config: jest.fn(),
  opt_out_capturing: jest.fn(),
  opt_in_capturing: jest.fn(),
  startSessionRecording: jest.fn(),
  stopSessionRecording: jest.fn(),
  sessionRecordingStarted: jest.fn(() => false),
  sessionRecording: { onRemoteConfig: jest.fn() },
};
jest.mock(
  'posthog-js/dist/module.full.no-external',
  () => ({ __esModule: true, default: mockBrowserSdk }),
  { virtual: true },
);

const ANONYMOUS_ID = '22222222-2222-4222-8222-222222222222';
const BATCH_URL = 'http://127.0.0.1:18763/batch/';
const EPOCH_KEY = '__canopy_operation_epoch';

function latestMainBeforeSend(): BeforeSend {
  const options: unknown = mockConstructor.mock.calls.at(-1)?.[1];
  if (
    !options ||
    typeof options !== 'object' ||
    !('before_send' in options) ||
    typeof options.before_send !== 'function'
  )
    throw new Error('Expected a PostHog sanitization hook');
  const beforeSend = options.before_send;
  return (event): unknown => Reflect.apply(beforeSend, options, [event]);
}

function hasFetch(value: unknown): value is { fetch: PostHogFetch } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'fetch' in value &&
    typeof value.fetch === 'function'
  );
}

/** The delivery hook the most recent client was constructed with. */
function latestFetch(): PostHogFetch {
  const options: unknown = mockConstructor.mock.calls.at(-1)?.[1];
  if (!hasFetch(options)) throw new Error('Expected a PostHog delivery hook');
  return options.fetch;
}

function captured(): CapturedMessage[] {
  return [
    ...mockCapture.mock.calls.map(([message]) => ({
      event: message.event,
      properties: message.properties ?? {},
    })),
    ...mockCaptureException.mock.calls.map(
      ([, distinctId, properties, uuid]) => ({
        event: '$exception',
        ...(distinctId === undefined ? {} : { distinctId }),
        ...(uuid === undefined ? {} : { uuid }),
        properties,
      }),
    ),
  ];
}

function capturedEvent(event: string): CapturedMessage {
  const message = captured().find((candidate) => candidate.event === event);
  if (!message) throw new Error(`Expected a captured ${event}`);
  return message;
}

/** Events that `sendPostHogRequest` lets through to the network. */
async function deliver(
  messages: CapturedMessage[],
  status = 200,
): Promise<string[]> {
  const outgoing = jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response('{}', { status }));
  try {
    await latestFetch()(BATCH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: 'phc_test', batch: messages }),
    });
    const body: unknown = outgoing.mock.calls[0]?.[1]?.body;
    if (body === undefined) return [];
    if (typeof body !== 'string') throw new Error('Unexpected batch body');
    const payload: unknown = JSON.parse(body);
    if (
      typeof payload !== 'object' ||
      payload === null ||
      !('batch' in payload) ||
      !Array.isArray(payload.batch)
    )
      throw new Error('Unexpected batch payload');
    return payload.batch.map((message: unknown) =>
      typeof message === 'object' && message !== null && 'event' in message
        ? String(message.event)
        : '',
    );
  } finally {
    outgoing.mockRestore();
  }
}

function createCrashFixture(
  crashTime: Date,
  marker: 'eligible' | 'unmarked' | 'legacy' = 'eligible',
): Buffer {
  const key =
    marker === 'eligible'
      ? 'canopy_main_crash_eligible'
      : marker === 'legacy'
        ? 'canopy_main_app_version'
        : 'other';
  const markerValue = '1.2.2';
  const dump = Buffer.alloc(208 + markerValue.length);
  // Minidump directory and version-1 Crashpad info stream.
  for (const [offset, value] of [
    [0, 0x504d444d],
    [4, 0xa793],
    [8, 1],
    [12, 32],
    [20, crashTime.getTime() / 1000],
    [32, 0x43500001],
    [36, 52],
    [40, 44],
    [44, 1],
    // Module list descriptor and one module info link.
    [88, 16],
    [92, 96],
    [96, 1],
    [104, 28],
    [108, 112],
    // Module info version, its typed annotation descriptor, and one string.
    [112, 1],
    [132, 16],
    [136, 144],
    [144, 1],
    [148, 168],
    [152, 1],
    [156, 204],
    [168, key.length],
    [204, markerValue.length],
  ])
    dump.writeUInt32LE(value, offset);
  dump.write(key, 172);
  dump.write(markerValue, 208);
  return dump;
}

describe('PostHog main gating by usage-data policy', () => {
  let main: typeof ElectronMainModule;
  const getInstallLaunch = jest.fn(() =>
    Promise.resolve({ isFirstLaunch: true, isReinstall: false }),
  );

  beforeEach(async () => {
    jest.resetModules();
    mockConstructor.mockClear();
    mockCapture.mockClear();
    mockCaptureException.mockClear();
    mockFlush.mockReset().mockResolvedValue(undefined);
    mockShutdown.mockReset().mockResolvedValue(undefined);
    getInstallLaunch.mockClear();
    Object.assign(globalThis, {
      __CANOPY_POSTHOG_ENABLED__: true,
      __CANOPY_POSTHOG_PROJECT_KEY__: 'phc_test',
      __CANOPY_POSTHOG_HOST__: 'http://127.0.0.1:18763',
      __CANOPY_APP_VERSION__: '1.2.3',
      __CANOPY_BRAND_ID__: 'canopy',
      __CANOPY_RELEASE_FLAVOR__: 'rc',
    });
    main = await import('@canopy/desktop-instrumentation/electron/main');
  });

  afterEach(() => {
    Object.assign(globalThis, {
      __CANOPY_POSTHOG_ENABLED__: false,
      __CANOPY_POSTHOG_PROJECT_KEY__: '',
      __CANOPY_POSTHOG_HOST__: 'https://us.i.posthog.com',
      __CANOPY_APP_VERSION__: undefined,
      __CANOPY_BRAND_ID__: undefined,
      __CANOPY_RELEASE_FLAVOR__: undefined,
    });
  });

  async function start(policy: {
    events: boolean;
    errors: boolean;
    launchEvents: boolean;
  }): Promise<void> {
    main.setDesktopPostHogCapturePolicy(policy);
    await main.initializePostHogMain(
      () => Promise.resolve(ANONYMOUS_ID),
      undefined,
      getInstallLaunch,
    );
  }

  it('CAN-6693: keeps private-safe handled frames valid for PostHog symbolication', async () => {
    await start({ events: false, errors: true, launchEvents: false });
    main.reportMainAppError(new Error('private captured detail'));
    const sent = latestMainBeforeSend()({
      event: '$exception',
      properties: {
        ...capturedEvent('$exception').properties,
        $exception_list: [
          {
            type: 'app.unexpected',
            value: 'Unexpected application failure',
            stacktrace: {
              type: 'raw',
              frames: [
                {
                  function: 'PrivateCustomer.secret',
                  module: 'PrivateCustomer',
                  filename:
                    'https://canopy.local/renderer/assets/chunk-parity.js',
                  chunk_id: '66130c22-12bd-53fb-965d-db49c4a605a2',
                  platform: 'web:javascript',
                  lineno: 918,
                  colno: 22307,
                  in_app: true,
                },
                {
                  module: 'PrivateCustomer',
                  filename: '/Users/PrivateCustomer/project/index.js',
                  platform: 'node:javascript',
                  lineno: 12,
                  colno: 7,
                  in_app: false,
                },
              ],
            },
          },
        ],
      },
    });
    expect(sent).toMatchObject({
      properties: {
        $exception_list: [
          {
            stacktrace: {
              type: 'raw',
              frames: [
                {
                  function: '?',
                  filename:
                    'https://canopy.local/renderer/assets/chunk-parity.js',
                  chunk_id: '66130c22-12bd-53fb-965d-db49c4a605a2',
                  platform: 'web:javascript',
                  lineno: 918,
                  colno: 22307,
                  in_app: true,
                },
                {
                  function: '?',
                  filename: 'file:///<redacted>',
                  platform: 'node:javascript',
                  lineno: 12,
                  colno: 7,
                  in_app: false,
                },
              ],
            },
          },
        ],
      },
    });
    expect(JSON.stringify(sent)).not.toContain('PrivateCustomer');
    expect(JSON.stringify(sent)).not.toContain('private captured detail');
  });

  it('CAN-6693: marks only trusted global main exceptions unhandled at the send boundary', async () => {
    await start({ events: false, errors: true, launchEvents: false });
    for (const [kind, handled] of [
      ['main_uncaught_exception', false],
      ['main_unhandled_rejection', false],
      ['manual_capture', true],
      ['main_uncaught_exception_extra', true],
      [undefined, true],
    ] as const) {
      mockCaptureException.mockClear();
      main.captureDesktopInstrumentationError(new Error('test failure'), {
        context: kind === undefined ? undefined : { kind },
      });
      const message = capturedEvent('$exception');
      const sent = latestMainBeforeSend()({
        ...message,
        properties: {
          ...message.properties,
          $exception_list: [
            {
              type: 'Error',
              value: 'test failure',
              mechanism: { type: 'generic', handled: true, synthetic: false },
            },
            {
              type: 'Error',
              value: 'nested cause',
              mechanism: { type: 'chained', handled: true, synthetic: false },
            },
          ],
        },
      });
      expect(sent).toMatchObject({
        properties: {
          $exception_list: [
            { mechanism: { type: 'generic', handled, synthetic: false } },
            { mechanism: { type: 'chained', handled: true, synthetic: false } },
          ],
        },
      });
    }
  });

  it('keeps a crash after mid-session opt-out unmarked even before the preference write', async () => {
    await start({ events: false, errors: true, launchEvents: false });
    const directory = await mkdtemp(join(tmpdir(), 'canopy-crash-denial-'));
    try {
      const dumpPath = join(
        directory,
        '3457d40b-6d9d-4fe3-a22c-30b0a90ea610.dmp',
      );
      let marked = false;
      const nativeCrashAnnotation = main.createMainCrashAnnotation(
        () => 'allow',
        (eligible): void => {
          marked = eligible;
        },
      );
      expect(nativeCrashAnnotation.readPolicy()).toBe('unavailable');
      expect(marked).toBe(false);
      nativeCrashAnnotation.start();
      expect(marked).toBe(true);

      // The saved preference still says allow when the opt-out starts.
      nativeCrashAnnotation.suspendForOptOut();
      expect(nativeCrashAnnotation.readPolicy()).toBe('deny');
      expect(marked).toBe(false);
      nativeCrashAnnotation.refresh();
      expect(marked).toBe(false);
      await writeFile(
        dumpPath,
        createCrashFixture(
          new Date('2026-11-12T12:00:00Z'),
          marked ? 'eligible' : 'unmarked',
        ),
      );
      // A later launch with committed allow still cannot send this dump.
      await expect(
        main.capturePreviousMainCrashes([dumpPath], () => 'allow'),
      ).resolves.toBe(true);
      expect(mockCaptureException).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps an opted-out upgrade crash local after a later durable opt-in', async () => {
    await start({ events: false, errors: true, launchEvents: false });
    const directory = await mkdtemp(
      join(tmpdir(), 'canopy-crash-first-allow-'),
    );
    try {
      const earlyDump = join(
        directory,
        '00000000-0000-4000-8000-000000000001.dmp',
      );
      const laterDump = join(
        directory,
        '00000000-0000-4000-8000-000000000002.dmp',
      );
      const crashTime = new Date('2026-11-12T12:00:00Z');
      let preferenceOptOut = true;
      let marked = false;
      const launch = main.createMainCrashAnnotation(
        () => (preferenceOptOut ? 'deny' : 'allow'),
        (eligible): void => {
          marked = eligible;
        },
      );
      expect(launch.readPolicy()).toBe('unavailable');
      expect(marked).toBe(false);
      await writeFile(earlyDump, createCrashFixture(crashTime, 'legacy'));
      launch.start();
      expect(marked).toBe(false);
      await expect(
        main.capturePreviousMainCrashes([earlyDump], launch.readPolicy),
      ).resolves.toBe(false);
      expect(mockCaptureException).not.toHaveBeenCalled();

      preferenceOptOut = false;
      launch.resumeAfterOptIn();
      expect(marked).toBe(true);
      await writeFile(
        laterDump,
        createCrashFixture(crashTime, marked ? 'eligible' : 'unmarked'),
      );
      mockFlush.mockImplementationOnce(async () => {
        await expect(deliver(captured())).resolves.toEqual(['$exception']);
      });
      await expect(
        main.capturePreviousMainCrashes(
          [earlyDump, laterDump],
          launch.readPolicy,
        ),
      ).resolves.toBe(true);
      expect(mockCaptureException).toHaveBeenCalledTimes(1);
      expect(mockCaptureException.mock.calls[0]?.[2].crash_dump_id).toBe(
        '00000000-0000-4000-8000-000000000002.dmp',
      );
      expect((await stat(earlyDump)).isFile()).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps a pre-consent marked dump local when the clock goes backward', async () => {
    await start({ events: false, errors: true, launchEvents: false });
    const directory = await mkdtemp(join(tmpdir(), 'canopy-crash-clock-'));
    try {
      const earlyId = '00000000-0000-4000-8000-000000000001.dmp';
      const laterId = '00000000-0000-4000-8000-000000000002.dmp';
      const early = join(directory, earlyId);
      const later = join(directory, laterId);
      const allowAt = Date.parse('2026-11-12T12:00:00Z');
      // The legacy marker looks newer only because the clock moved backward.
      await writeFile(
        early,
        createCrashFixture(new Date(allowAt + 300_000), 'legacy'),
      );
      await writeFile(later, createCrashFixture(new Date(allowAt - 1000)));
      mockFlush.mockImplementation(async () => {
        await expect(deliver(captured())).resolves.toEqual(['$exception']);
      });
      await expect(
        main.capturePreviousMainCrashes([early, later], () => 'allow'),
      ).resolves.toBe(true);
      expect(mockCaptureException).toHaveBeenCalledTimes(1);
      expect(mockCaptureException.mock.calls[0]?.[2].crash_dump_id).toBe(
        laterId,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps eligible dumps pending while the shared consent read is unavailable', async () => {
    await start({ events: false, errors: true, launchEvents: false });
    const directory = await mkdtemp(join(tmpdir(), 'canopy-crash-read-retry-'));
    try {
      const unmarkedDump = join(
        directory,
        '00000000-0000-4000-8000-000000000001.dmp',
      );
      const eligibleDump = join(
        directory,
        '00000000-0000-4000-8000-000000000002.dmp',
      );
      const crashTime = new Date('2026-11-12T12:00:00Z');
      await writeFile(unmarkedDump, createCrashFixture(crashTime, 'unmarked'));
      await writeFile(eligibleDump, createCrashFixture(crashTime));
      let readable = false;
      const sweep = (): Promise<boolean> =>
        main.capturePreviousMainCrashes([unmarkedDump, eligibleDump], () =>
          readable ? 'allow' : 'unavailable',
        );
      await expect(sweep()).resolves.toBe(false);
      expect(mockCaptureException).not.toHaveBeenCalled();
      expect((await stat(eligibleDump)).isFile()).toBe(true);
      expect((await stat(unmarkedDump)).isFile()).toBe(true);

      readable = true;
      mockFlush.mockImplementationOnce(async () => {
        await expect(deliver(captured())).resolves.toEqual(['$exception']);
      });
      await expect(sweep()).resolves.toBe(true);
      expect(mockCaptureException).toHaveBeenCalledTimes(1);
      expect(mockCaptureException.mock.calls[0]?.[2].crash_dump_id).toBe(
        '00000000-0000-4000-8000-000000000002.dmp',
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps a crash pending when native policy becomes unavailable before delivery', async () => {
    await start({ events: false, errors: true, launchEvents: false });
    const directory = await mkdtemp(
      join(tmpdir(), 'canopy-crash-policy-race-'),
    );
    try {
      const dumpPath = join(
        directory,
        '00000000-0000-4000-8000-000000000003.dmp',
      );
      await writeFile(
        dumpPath,
        createCrashFixture(new Date('2026-11-12T12:00:00Z')),
      );
      let policy: ElectronMainModule.MainCrashCapturePolicy = 'allow';
      const sweep = (): Promise<boolean> =>
        main.capturePreviousMainCrashes([dumpPath], () => policy);

      const reading = sweep();
      policy = 'unavailable';
      await expect(reading).resolves.toBe(false);
      expect(mockCaptureException).not.toHaveBeenCalled();
      expect((await stat(dumpPath)).isFile()).toBe(true);

      policy = 'allow';
      mockFlush.mockImplementationOnce(async () => {
        const batch = captured();
        policy = 'unavailable';
        await expect(deliver(batch)).resolves.toEqual([]);
        policy = 'allow';
        await expect(deliver(batch)).resolves.toEqual([]);
      });
      await expect(sweep()).resolves.toBe(false);
      expect((await stat(dumpPath)).isFile()).toBe(true);

      mockCaptureException.mockClear();
      mockFlush.mockImplementationOnce(async () => {
        await expect(deliver(captured())).resolves.toEqual(['$exception']);
      });
      await expect(sweep()).resolves.toBe(true);
      expect(mockCaptureException).toHaveBeenCalledTimes(1);
      await expect(deliver(captured())).resolves.toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps eligible dumps pending when the SDK starts in Capture V1 mode', async () => {
    const env = jest.replaceProperty(process, 'env', {
      ...process.env,
      POSTHOG_CAPTURE_MODE: 'v1',
    });
    try {
      await start({ events: false, errors: true, launchEvents: false });
    } finally {
      env.restore();
    }

    const directory = await mkdtemp(join(tmpdir(), 'canopy-crash-v1-'));
    try {
      const dumpPath = join(
        directory,
        '00000000-0000-4000-8000-000000000001.dmp',
      );
      await writeFile(
        dumpPath,
        createCrashFixture(new Date('2026-11-12T12:00:00Z')),
      );
      await expect(
        main.capturePreviousMainCrashes([dumpPath], () => 'allow'),
      ).resolves.toBe(false);
      expect(mockCaptureException).not.toHaveBeenCalled();
      expect(mockFlush).not.toHaveBeenCalled();
      expect((await stat(dumpPath)).isFile()).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps an acknowledged dump from replaying after an interrupted sweep', async () => {
    await start({ events: false, errors: true, launchEvents: false });
    const directory = await mkdtemp(join(tmpdir(), 'canopy-crash-ack-'));
    const first = join(directory, '00000000-0000-4000-8000-000000000001.dmp');
    const second = join(directory, '00000000-0000-4000-8000-000000000002.dmp');
    const receiptPath = (): string => join(directory, 'receipts');
    const policy = (): ElectronMainModule.MainCrashCapturePolicy => 'allow';
    const restartReport = jest
      .fn<Promise<boolean>, [readonly string[]]>()
      .mockResolvedValue(true);
    try {
      const fixture = createCrashFixture(new Date('2026-11-12T12:00:00Z'));
      await writeFile(first, fixture);
      await writeFile(second, fixture);
      const earlier = new Date(Date.now() - 60_000);
      await utimes(second, earlier, earlier);
      mockFlush.mockImplementationOnce(async () => {
        await deliver(captured());
        // Start a fresh sweep from the disk state left by the acknowledged
        // request, before the first sweep can finish its flush.
        await sweepStartupCrashDumps({
          crashDumpsDir: directory,
          policy,
          receipts: main.createMainCrashDeliveryReceipts(receiptPath),
          report: (paths) => restartReport(paths),
        });
      });

      await sweepStartupCrashDumps({
        crashDumpsDir: directory,
        policy,
        receipts: main.createMainCrashDeliveryReceipts(receiptPath),
        report: (paths, onDelivered) =>
          main.capturePreviousMainCrashes(paths, policy, onDelivered),
      });

      expect(restartReport).toHaveBeenCalledTimes(1);
      expect(restartReport).toHaveBeenCalledWith([second]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('reports a prior main Crashpad dump through the same error delivery gate', async () => {
    await start({ events: true, errors: false, launchEvents: false });
    const directory = await mkdtemp(join(tmpdir(), 'canopy-golden-crash-'));
    const dumpId = '3457d40b-6d9d-4fe3-a22c-30b0a90ea610.dmp';
    const dumpPath = join(directory, dumpId);
    const crashTime = new Date('2026-11-12T12:00:00.000Z');
    const captureEnvelope = (): unknown =>
      latestMainBeforeSend()(capturedEvent('$exception'));
    const dump = createCrashFixture(crashTime);
    try {
      const unavailable = getDefaultFeatureFlagSnapshot('ready');
      const usageDuringOutage = {
        preferenceOptOut: false,
        organizationOptOut: false,
        contextResolved: true,
        effective: true,
      };
      unavailable.values[CLIENT_FEATURE_FLAGS.canopyPostHogCaptureEnabled.key] =
        false;
      expect(
        main.resolveMainCrashCapturePolicy(
          unavailable,
          usageDuringOutage,
          undefined,
        ),
      ).toBe('unavailable');
      expect(
        main.resolveMainCrashCapturePolicy(
          unavailable,
          usageDuringOutage,
          false,
        ),
      ).toBe('deny');
      await writeFile(dumpPath, dump);
      await expect(
        main.capturePreviousMainCrash(dumpPath, () => 'allow'),
      ).resolves.toBe('retry');
      expect(mockCaptureException).not.toHaveBeenCalled();
      main.setDesktopPostHogCapturePolicy({
        events: false,
        errors: true,
        launchEvents: false,
      });
      const missing = join(
        directory,
        '00000000-0000-4000-8000-000000000002.dmp',
      );
      await expect(
        main.capturePreviousMainCrash(missing, () => 'allow'),
      ).resolves.toBe('retry');
      expect(mockCaptureException).not.toHaveBeenCalled();
      let attemptedEnvelope: unknown;
      mockFlush.mockImplementationOnce(async () => {
        attemptedEnvelope = captureEnvelope();
        await expect(deliver(captured(), 503)).resolves.toEqual(['$exception']);
      });
      await expect(
        main.capturePreviousMainCrash(dumpPath, () => 'allow'),
      ).resolves.toBe('retry');
      const expectedEnvelope = {
        event: '$exception',
        uuid: dumpId.slice(0, -4),
        distinctId: ANONYMOUS_ID,
        timestamp: crashTime,
        properties: { $ignore_sent_at: true },
      };
      expect(attemptedEnvelope).toMatchObject(expectedEnvelope);
      const crashError = mockCaptureException.mock.calls[0]?.[0];
      if (!(crashError instanceof Error))
        throw new Error('Expected a native crash exception');
      expect(crashError.stack).toBe(
        'NativeMainProcessCrash: Native main-process crash',
      );

      // A delayed file cannot bypass the current send-time denial.
      const flag = getDefaultFeatureFlagSnapshot('error');
      const usage = {
        preferenceOptOut: false,
        organizationOptOut: false,
        contextResolved: true,
        effective: true,
      };
      const key = CLIENT_FEATURE_FLAGS.canopyPostHogCaptureEnabled.key;
      flag.values[key] = false;
      expect(
        main.resolveMainCrashCapturePolicy(flag, usage, flag.values[key]),
      ).toBe('unavailable');
      flag.status = 'ready';
      const denied = main.resolveMainCrashCapturePolicy(
        flag,
        usage,
        flag.values[key],
      );
      expect(denied).toBe('deny');
      const finalizedAt = new Date(crashTime.getTime() + 2000);
      await utimes(dumpPath, finalizedAt, finalizedAt);
      expect((await stat(dumpPath)).mtimeMs).toBeGreaterThan(
        crashTime.getTime(),
      );
      flag.values[key] = true;
      expect(
        main.resolveMainCrashCapturePolicy(flag, usage, flag.values[key]),
      ).toBe('allow');
      const unresolved = {
        ...usage,
        organizationOptOut: true,
        contextResolved: false,
        effective: false,
      };
      expect(
        main.resolveMainCrashCapturePolicy(flag, unresolved, flag.values[key]),
      ).toBe('unavailable');
      expect(
        main.resolveMainCrashCapturePolicy(
          flag,
          {
            ...unresolved,
            contextResolved: true,
          },
          flag.values[key],
        ),
      ).toBe('deny');
      expect(
        main.resolveMainCrashCapturePolicy(
          flag,
          {
            ...unresolved,
            preferenceOptOut: true,
          },
          flag.values[key],
        ),
      ).toBe('deny');
      flag.values[key] = false;
      expect(
        main.resolveMainCrashCapturePolicy(flag, unresolved, flag.values[key]),
      ).toBe('deny');
      await expect(
        main.capturePreviousMainCrashes([dumpPath], () => denied),
      ).resolves.toBe(false);
      expect(mockCaptureException).toHaveBeenCalledTimes(1);

      // A temporarily unwritable receipt is retried without losing the ack.
      const blockedPath = (): string =>
        join(directory, 'blocked-crash-receipts');
      await mkdir(blockedPath());
      const receipts = main.createMainCrashDeliveryReceipts(blockedPath);
      const delivered = new Set([dumpId]);
      await writeFile(missing, dump);
      mockCaptureException.mockClear();
      const accepted = new Response('{}', { status: 200 });
      const outgoing = jest
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(accepted);
      let sendResult: unknown;
      try {
        mockFlush.mockImplementationOnce(async () => {
          sendResult = await latestFetch()(BATCH_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ api_key: 'phc_test', batch: captured() }),
          });
        });
        await expect(
          main.capturePreviousMainCrashes(
            [dumpPath, missing],
            () => 'allow',
            (name) => receipts.save(new Set([name])),
          ),
        ).rejects.toThrow('Could not persist native crash delivery receipt');
        expect(sendResult).toBe(accepted);
      } finally {
        outgoing.mockRestore();
      }
      expect(mockCaptureException).toHaveBeenCalledTimes(1);
      await expect(receipts.read()).resolves.toEqual(delivered);
      await rm(blockedPath(), { recursive: true });
      receipts.retryPending();
      await expect(
        main.createMainCrashDeliveryReceipts(blockedPath).read(),
      ).resolves.toEqual(delivered);

      // A fresh process with a confirmed allow can retry the retained dump.
      mockCaptureException.mockClear();
      jest.resetModules();
      main = await import('@canopy/desktop-instrumentation/electron/main');
      await start({ events: false, errors: true, launchEvents: false });
      mockFlush.mockImplementationOnce(async () => {
        expect(captureEnvelope()).toMatchObject(expectedEnvelope);
        await expect(deliver(captured())).resolves.toEqual(['$exception']);
      });
      const unreadable = join(
        directory,
        '00000000-0000-4000-8000-000000000001.dmp',
      );
      await expect(
        main.capturePreviousMainCrashes([], () => 'deny'),
      ).resolves.toBe(false);
      // A missing dump can retry later without starving the retained one.
      await expect(
        main.capturePreviousMainCrashes([unreadable, dumpPath], () => 'allow'),
      ).resolves.toBe(false);
      expect(capturedEvent('$exception').properties).toMatchObject({
        crash_app_version: '1.2.2',
        crash_dump_id: dumpId,
      });
      expect(JSON.stringify(captured())).not.toContain(directory);
      await expect(deliver(captured())).resolves.toEqual([]);
      mockCaptureException.mockClear();
      main.setDesktopPostHogCapturePolicy({
        events: true,
        errors: false,
        launchEvents: false,
      });
      await main.capturePreviousMainCrash(dumpPath, () => 'allow');
      expect(mockCaptureException).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps handled error details and the reference together in Error Tracking', async () => {
    await start({ events: false, errors: true, launchEvents: false });
    const workEntryId = '26742dbc-af8a-4b9e-80d6-17e463ba3a65';
    const error = new Error(
      `Missing Work Entry ${workEntryId} for someone@example.com\n    at quoted ${workEntryId}`,
    );
    const report = main.reportMainAppError(error);
    expect(report?.error.referenceId).toBeDefined();
    expect(report?.error.detail.message).toContain(workEntryId);
    expect(capturedEvent('$exception').properties.error_reference_id).toBe(
      report?.error.referenceId,
    );
    const sdkError = mockCaptureException.mock.calls[0]?.[0];
    if (!(sdkError instanceof Error))
      throw new Error('Expected an SDK exception');
    const sent = latestMainBeforeSend()({
      event: '$exception',
      properties: {
        ...capturedEvent('$exception').properties,
        $exception_list: [
          {
            type: sdkError.name,
            value: sdkError.message,
            stacktrace: {
              frames: [
                {
                  filename: '/Users/private/project.js',
                  lineno: 10,
                  colno: 20,
                },
              ],
            },
          },
        ],
      },
    });
    expect(JSON.stringify(sent)).not.toContain(workEntryId);
    expect(JSON.stringify(sent)).not.toMatch(
      /someone@example.com|\/Users\/private/,
    );
    expect(sdkError.stack).not.toContain(workEntryId);
    expect(sdkError.stack).toContain('posthog-usage-data-gating.test.ts');
    expect(sent).toMatchObject({
      properties: {
        error_reference_id: report?.error.referenceId,
        $exception_list: [
          {
            type: 'app.unexpected',
            value: 'Unexpected application failure',
            stacktrace: {
              frames: [
                { filename: 'file:///<redacted>', lineno: 10, colno: 20 },
              ],
            },
          },
        ],
      },
    });

    let coded: Error | undefined;
    try {
      readFileSync('bad\u0000path');
    } catch (error) {
      if (
        isNativeError(error) &&
        'code' in error &&
        typeof error.code === 'string'
      ) {
        // Jest supplies a plain header for errors from Node's own realm.
        coded = new TypeError(error.message);
        coded.stack = error.stack?.replace(
          /^TypeError: /,
          `TypeError [${error.code}]: `,
        );
      }
    }
    if (!coded?.stack) throw new Error('Expected a coded Node stack');
    expect(coded.stack).toContain('TypeError [ERR_INVALID_ARG_VALUE]');
    const codedReport = main.reportMainAppError(coded);
    const codedException = mockCaptureException.mock.calls.at(-1)?.[0];
    if (!(codedException instanceof Error))
      throw new Error('Expected a coded SDK exception');
    expect(codedException.message).toBe('Unexpected application failure');
    // This fixture's stack was assigned by the caller, so it has no V8 proof.
    expect(codedException.stack).toBe(
      'app.unexpected: Unexpected application failure',
    );
    expect(codedException.stack).not.toContain(coded.message);
    expect(captured().at(-1)?.properties.error_reference_id).toBe(
      codedReport?.error.referenceId,
    );
  });

  it('keeps native frames past the shared message limit', async () => {
    await start({ events: false, errors: true, launchEvents: false });
    const workEntryId = '26742dbc-af8a-4b9e-80d6-17e463ba3a65';
    const longError = new Error(
      `${'a'.repeat(4096)}\n    at quoted (${workEntryId}.js:2:1)`,
    );
    longError.name =
      'Wrapped native failure\n    at PrivateName (/tmp/secret.js:2:1)\nWrapper';
    const longReport = main.reportMainAppError(longError);
    expect(longReport?.error.detail.message).toHaveLength(4096);
    const longSdkError = mockCaptureException.mock.calls[0]?.[0];
    if (!(longSdkError instanceof Error))
      throw new Error('Expected an SDK exception');
    expect(longSdkError.stack).toContain('posthog-usage-data-gating.test.ts');
    expect(longSdkError.stack).not.toMatch(/PrivateName|quoted|secret\.js/);
    expect(captured().at(-1)?.properties.error_reference_id).toBe(
      longReport?.error.referenceId,
    );

    const ambiguous = createAppError('app.unexpected', {
      detail: {
        name: 'Error',
        message: 'b'.repeat(4096),
        stack: `Error: ${'b'.repeat(4096)}\n    at quoted (${workEntryId}.js:2:1)`,
      },
    });
    main.reportMainAppError(ambiguous);
    const ambiguousSdkError = mockCaptureException.mock.calls[1]?.[0];
    expect(captured().at(-1)?.properties).not.toHaveProperty('thrown_type');
    if (!(ambiguousSdkError instanceof Error))
      throw new Error('Expected an SDK exception');
    expect(ambiguousSdkError.stack).toBe(
      'app.unexpected: Unexpected application failure',
    );

    const ipcError = createAppError('app.unexpected', {
      source: 'ipc:fixture',
      detail: {
        name: longError.name,
        message: longError.message.slice(0, 4096),
        stack: longError.stack,
      },
    });
    const ipcReport = main.reportMainAppError(ipcError, {
      nativeError: longError,
    });
    const ipcException = mockCaptureException.mock.calls.at(-1)?.[0];
    expect(ipcReport?.error.referenceId).toBe(ipcError.referenceId);
    if (!(ipcException instanceof Error))
      throw new Error('Expected an IPC exception');
    expect(ipcException.stack).toBe(longSdkError.stack);
  });

  it('keeps original frames when the recorded external detail is replaced', async () => {
    await start({ events: false, errors: true, launchEvents: false });
    const workEntryId = '26742dbc-af8a-4b9e-80d6-17e463ba3a65';
    const externalMessage = `Provider returned private Work Entry ${workEntryId}`;
    const external = classifyError(
      new Error(externalMessage),
      'external.service_unavailable',
    );
    const externalReport = main.reportMainAppError(external);
    const externalSdkError = mockCaptureException.mock.calls[0]?.[0];
    if (!(externalSdkError instanceof Error))
      throw new Error('Expected an SDK exception');
    expect(externalSdkError.message).toBe('Service unavailable');
    expect(externalSdkError.stack).toContain(
      'posthog-usage-data-gating.test.ts',
    );
    expect(externalSdkError.stack).not.toContain(workEntryId);
    const externalSent = latestMainBeforeSend()({
      event: '$exception',
      properties: {
        ...captured().at(-1)?.properties,
        $exception_list: [
          {
            stacktrace: {
              frames: [
                {
                  filename:
                    '../../../Volumes/PrivateClient/Workspace/node_modules/plugin/index.js',
                  module: 'PrivateClient:plugin:index',
                  lineno: 10,
                },
                {
                  filename:
                    '/Applications/Canopy.app/Contents/Resources/app.asar/out/main/index.jsc',
                  lineno: 2,
                },
              ],
            },
          },
        ],
      },
    });
    expect(JSON.stringify(externalSent)).not.toContain('PrivateClient');
    expect(externalSent).toMatchObject({
      properties: {
        $exception_list: [
          {
            stacktrace: {
              frames: [
                { filename: 'file:///<redacted>', lineno: 10 },
                { filename: 'file:///<redacted>', lineno: 2 },
              ],
            },
          },
        ],
      },
    });
    expect(captured().at(-1)?.properties.error_reference_id).toBe(
      externalReport?.error.referenceId,
    );
  });

  it('delivers catalog-only handled exceptions with an explicitly empty stack', async () => {
    await start({ events: false, errors: true, launchEvents: false });
    const original = new Error('private detail');
    original.stack = '';
    const report = main.reportMainAppError(original);
    const event = capturedEvent('$exception');
    const sdkError = mockCaptureException.mock.calls[0]?.[0];
    if (!(sdkError instanceof Error))
      throw new Error('Expected an SDK exception');
    expect(sdkError.stack).toBe(
      'app.unexpected: Unexpected application failure',
    );
    const sent = latestMainBeforeSend()({
      ...event,
      properties: {
        ...event.properties,
        $exception_list: [{ type: sdkError.name, value: sdkError.message }],
      },
    });
    expect(sent).toMatchObject({
      properties: {
        error_reference_id: report?.error.referenceId,
        frames_unavailable: true,
        $exception_list: [
          {
            type: 'app.unexpected',
            value: 'Unexpected application failure',
            stacktrace: { type: 'raw', frames: [] },
          },
        ],
      },
    });
  });

  it('reports an Error-prototype object with a V8 stack as a non-Error throw', async () => {
    await start({ events: false, errors: true, launchEvents: false });
    const thrown = {};
    Object.setPrototypeOf(thrown, Error.prototype);
    Object.defineProperty(thrown, Symbol.toStringTag, { value: 'Error' });
    Error.captureStackTrace(thrown);
    expect(Object.prototype.toString.call(thrown)).toBe('[object Error]');
    expect(isNativeError(thrown)).toBe(false);
    const report = main.reportMainAppError(thrown);
    const event = capturedEvent('$exception');
    const sdkError = mockCaptureException.mock.calls[0]?.[0];
    if (!(sdkError instanceof Error))
      throw new Error('Expected an SDK exception');
    expect(sdkError.stack).toBe(
      'app.unexpected: Unexpected application failure',
    );
    expect(
      latestMainBeforeSend()({
        ...event,
        properties: {
          ...event.properties,
          $exception_list: [{ type: sdkError.name, value: sdkError.message }],
        },
      }),
    ).toMatchObject({
      properties: {
        error_reference_id: report?.error.referenceId,
        thrown_type: 'object',
        frames_unavailable: true,
        $exception_list: [{ stacktrace: { type: 'raw', frames: [] } }],
      },
    });
  });

  it('keeps verified V8 frames from a native Error in another realm', () => {
    // Use Node's main realm as the reporting host. Jest's VM adds a third
    // realm that owns the native stack formatter during a node:vm call.
    execFileSync(process.execPath, [
      '--import',
      'tsx',
      '-e',
      `
        const assert = require('node:assert/strict');
        const { runInNewContext } = require('node:vm');
        const { createAppErrorHandler } = require(process.argv[1]);
        const { appErrorException } = require(process.argv[2]);
        const thrown = runInNewContext('new Error("private foreign error")', {}, {
          filename: 'foreign-realm-fixture.js',
        });
        assert.equal(Error.isError(thrown), true);
        assert.equal(thrown instanceof Error, false);
        let diagnostic;
        const handler = createAppErrorHandler({
          host: 'main',
          appVersion: '1',
          sinks: [],
          diagnosticSink(record, frames, thrownType) {
            diagnostic = { record, frames, thrownType };
          },
        });
        const report = handler.report(thrown);
        handler.dispose();
        assert.ok(diagnostic);
        assert.equal(diagnostic.record.error.referenceId, report.error.referenceId);
        assert.equal(diagnostic.thrownType, undefined);
        const sdkError = appErrorException(diagnostic.record, diagnostic.frames);
        assert.ok(sdkError.stack.includes('foreign-realm-fixture.js:1:1'));
        assert.ok(!sdkError.stack.includes('private foreign error'));
      `,
      require.resolve('@canopy/protocol/app-errors'),
      require.resolve('@canopy/desktop-instrumentation/app-error-telemetry'),
    ]);
  });

  it('reserves the existing main exception quota when handled records fill theirs', async () => {
    await start({ events: false, errors: true, launchEvents: false });
    for (let index = 0; index < 100; index++) {
      main.reportMainAppError(new Error(`Handled failure ${index}`));
    }
    expect(mockCaptureException).toHaveBeenCalledTimes(100);
    const uncaught = new Error('Fatal main failure');
    main.captureDesktopInstrumentationError(uncaught);
    expect(mockCaptureException).toHaveBeenCalledTimes(101);
    expect(mockCaptureException.mock.calls.at(-1)?.[0]).toBe(uncaught);
  });

  it('sends empty frames when a cached V8 header contains 55 spoofed frames', async () => {
    await start({ events: false, errors: true, launchEvents: false });
    const message = 'replacement message';
    const spoofedFrames = Array.from(
      { length: 55 },
      (_, index) =>
        `    at ConfidentialWorkspace (/tmp/private.js:${index + 1}:2)`,
    );
    // Keep the original header's first line equal to the replacement header.
    // A simple prefix match would still mistake the old header for frames.
    const error = new Error([message, ...spoofedFrames].join('\n'));
    expect(error.stack).toContain(spoofedFrames.join('\n'));
    error.message = message;
    const report = main.reportMainAppError(error);
    const event = capturedEvent('$exception');
    const sdkError = mockCaptureException.mock.calls[0]?.[0];
    if (!(sdkError instanceof Error))
      throw new Error('Expected an SDK exception');
    expect(sdkError.stack).toBe(
      'app.unexpected: Unexpected application failure',
    );
    expect(
      latestMainBeforeSend()({
        ...event,
        properties: {
          ...event.properties,
          $exception_list: [{ type: sdkError.name, value: sdkError.message }],
        },
      }),
    ).toMatchObject({
      properties: {
        error_reference_id: report?.error.referenceId,
        frames_unavailable: true,
        $exception_list: [{ stacktrace: { type: 'raw', frames: [] } }],
      },
    });
  });

  it('stamps bundled release metadata on main exceptions', async () => {
    await start({ events: false, errors: true, launchEvents: false });
    expect(
      latestMainBeforeSend()({
        event: '$exception',
        properties: {
          app_version: 'caller-value',
          app_brand: 'caller-value',
          release_channel: 'caller-value',
        },
      }),
    ).toMatchObject({
      properties: {
        app_version: '1.2.3',
        app_brand: 'canopy',
        release_channel: 'rc',
      },
    });
  });

  it('sends only error events while Usage analytics is off', async () => {
    await start({ events: false, errors: true, launchEvents: false });
    main.succeedDesktopOperation('canopy.chat_turn');
    main.captureDesktopInstrumentationError(new Error('boom'));

    expect(captured().map(({ event }) => event)).toEqual(['$exception']);
    await expect(deliver(captured())).resolves.toEqual(['$exception']);
  });

  it('sends the launch event with its install facts once Usage analytics turns on', async () => {
    await start({ events: false, errors: true, launchEvents: false });
    // The SDK flushes whatever it holds while analytics is still off.
    const flushedWhileOff = captured();
    await expect(deliver(flushedWhileOff)).resolves.toEqual([]);

    main.setDesktopPostHogCapturePolicy({
      events: true,
      errors: true,
      launchEvents: true,
    });
    main.setDesktopPostHogCapturePolicy({
      events: true,
      errors: true,
      launchEvents: true,
    });

    const launches = captured()
      .slice(flushedWhileOff.length)
      .filter(({ event }) => event === 'desktop:app_start');
    expect(launches).toHaveLength(1);
    expect(launches[0]?.properties).toEqual(
      expect.objectContaining({ is_first_launch: true, is_reinstall: false }),
    );
    await expect(deliver(launches)).resolves.toEqual(['desktop:app_start']);
  });

  it('leaves out the account domain from errors while Usage analytics is off', async () => {
    main.setDesktopPostHogCapturePolicy({
      events: false,
      errors: true,
      launchEvents: false,
    });
    await main.initializePostHogMain(() => Promise.resolve(ANONYMOUS_ID), {
      getSnapshot: () => Promise.resolve('person@example.com'),
      onSnapshotChanged: (): (() => void) => (): void => undefined,
    });
    await main.getDesktopPostHogEmailDomain();
    main.captureDesktopInstrumentationError(new Error('boom'));

    const properties = capturedEvent('$exception').properties;
    expect(properties).not.toHaveProperty('email_domain');
    expect(properties.$process_person_profile).toBe(false);
  });

  it('drops queued errors once Error reports turns off', async () => {
    await start({ events: true, errors: true, launchEvents: true });
    main.captureDesktopInstrumentationError(new Error('boom'));
    const queued = captured();

    main.setDesktopPostHogCapturePolicy({
      events: true,
      errors: false,
      launchEvents: true,
    });
    main.captureDesktopInstrumentationError(new Error('after'));

    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    await expect(deliver(queued)).resolves.toEqual(['desktop:app_start']);
  });

  it('keeps a queued desktop:app_start when only the LaunchDarkly flag turns off', async () => {
    await start({ events: true, errors: true, launchEvents: true });
    main.succeedDesktopOperation('canopy.chat_turn');
    const queued = captured();

    main.setDesktopPostHogCapturePolicy({
      events: false,
      errors: false,
      launchEvents: true,
    });

    await expect(deliver(queued)).resolves.toEqual(['desktop:app_start']);
  });

  it('drops a queued desktop:app_start once Usage analytics turns off', async () => {
    await start({ events: true, errors: true, launchEvents: true });
    const queued = captured();

    main.setDesktopPostHogCapturePolicy({
      events: false,
      errors: true,
      launchEvents: false,
    });

    await expect(deliver(queued)).resolves.toEqual([]);
  });

  it('does not revive events captured before an off/on toggle', async () => {
    await start({ events: true, errors: true, launchEvents: true });
    main.succeedDesktopOperation('canopy.chat_turn');
    main.captureDesktopInstrumentationError(new Error('boom'));
    const queued = captured();

    const off = { events: false, errors: false, launchEvents: false };
    const on = { events: true, errors: true, launchEvents: true };
    main.setDesktopPostHogCapturePolicy(off);
    main.setDesktopPostHogCapturePolicy(on);

    await expect(deliver(queued)).resolves.toEqual([]);
  });

  it('restarts with one client and no second desktop:app_start', async () => {
    await start({ events: true, errors: true, launchEvents: true });
    const firstShutdown = mockShutdown;

    main.setDesktopPostHogCapturePolicy({
      events: false,
      errors: false,
      launchEvents: false,
    });
    const suspended = main.suspendPostHogMain();
    // A flip back on while the shutdown is in flight waits for it.
    main.setDesktopPostHogCapturePolicy({
      events: true,
      errors: true,
      launchEvents: true,
    });
    const restarted = main.initializePostHogMain(
      () => Promise.resolve(ANONYMOUS_ID),
      undefined,
      getInstallLaunch,
    );
    await suspended;
    await expect(restarted).resolves.toEqual({
      enabled: true,
      provider: 'posthog',
    });

    expect(firstShutdown).toHaveBeenCalledTimes(1);
    expect(mockConstructor).toHaveBeenCalledTimes(2);
    expect(getInstallLaunch).toHaveBeenCalledTimes(1);
    expect(
      captured().filter(({ event }) => event === 'desktop:app_start'),
    ).toHaveLength(1);

    main.succeedDesktopOperation('canopy.chat_turn');
    const operation = captured().at(-1);
    expect(operation?.properties[EPOCH_KEY]).toEqual(expect.any(Number));
    await expect(deliver(operation ? [operation] : [])).resolves.toEqual([
      'chat:turn_end',
    ]);
  });
});

describe('PostHog renderer identity by usage-data policy', () => {
  let client: typeof ClientModule;

  beforeEach(async () => {
    jest.resetModules();
    Object.assign(globalThis, {
      __CANOPY_POSTHOG_ENABLED__: true,
      __CANOPY_POSTHOG_PROJECT_KEY__: 'phc_test',
      __CANOPY_POSTHOG_HOST__: 'http://127.0.0.1:18763',
      __CANOPY_APP_VERSION__: '1.2.3',
      __CANOPY_BRAND_ID__: 'canopy',
      __CANOPY_RELEASE_FLAVOR__: 'rc',
      __CANOPY_POSTHOG_SESSION_REPLAY_SAMPLE_RATE__: 100,
    });
    client = await import('@canopy/desktop-instrumentation/client');
  });

  afterEach(() => {
    client.disposePostHogInstrumentationClient();
    Object.assign(globalThis, {
      __CANOPY_POSTHOG_ENABLED__: false,
      __CANOPY_POSTHOG_PROJECT_KEY__: '',
      __CANOPY_POSTHOG_HOST__: 'https://us.i.posthog.com',
      __CANOPY_APP_VERSION__: undefined,
      __CANOPY_BRAND_ID__: undefined,
      __CANOPY_RELEASE_FLAVOR__: undefined,
      __CANOPY_POSTHOG_SESSION_REPLAY_SAMPLE_RATE__: 0,
    });
  });

  function flags(open: boolean): PostHogRuntimeFlags {
    return {
      captureEnabled: true,
      sessionReplaySampleRate: 0,
      autocaptureEnabled: false,
      productAnalytics: open,
      errorReports: false,
      sessionReplay: false,
    };
  }

  // Main's identity store creates `posthog-context.json` on first read.
  it('asks main for its identity only once a category opens', async () => {
    let push: ((next: PostHogRuntimeFlags) => void) | undefined;
    const getPostHogAnonymousId = jest.fn(() => Promise.resolve(ANONYMOUS_ID));
    const initialization = client.initializeDesktopInstrumentationClient({
      surface: 'main',
      getPostHogAnonymousId,
      posthogFlags: {
        getSnapshot: () => Promise.resolve(flags(false)),
        onSnapshotChanged: (listener): (() => void) => {
          push = listener;
          return (): void => undefined;
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getPostHogAnonymousId).not.toHaveBeenCalled();

    push?.(flags(true));
    await initialization;
    expect(getPostHogAnonymousId).toHaveBeenCalledTimes(1);
  });

  it('never asks for an identity when disposed while both are off', async () => {
    const getPostHogAnonymousId = jest.fn(() => Promise.resolve(ANONYMOUS_ID));
    const initialization = client.initializeDesktopInstrumentationClient({
      surface: 'main',
      getPostHogAnonymousId,
      posthogFlags: {
        getSnapshot: () => Promise.resolve(flags(false)),
        onSnapshotChanged: (): (() => void) => (): void => undefined,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    client.disposePostHogInstrumentationClient();

    await expect(initialization).resolves.toEqual([
      { enabled: false, provider: 'posthog', reason: 'disabled' },
    ]);
    expect(getPostHogAnonymousId).not.toHaveBeenCalled();
  });

  it('reports a string thrown inside the renderer boundary without frames', async () => {
    const dom = new JSDOM('<div id="root"></div>');
    Object.assign(globalThis, {
      window: dom.window,
      document: dom.window.document,
    });
    const container = document.getElementById('root');
    if (!container) throw new Error('Missing renderer test root');
    const { createElement } = await import('react');
    const { flushSync } = await import('react-dom');
    const { createRoot } = await import('react-dom/client');
    const { AppErrorBoundary } = await import('@canopy/ui-app/feedback');
    const { rootErrorBoundaryHost } =
      await import('@/lib/desktop-error-boundary-host');
    const { installSurfacedErrorRecording } =
      await import('@/lib/surfaced-error-recording');
    const root = createRoot(container, { onCaughtError: jest.fn() });
    const uninstall = installSurfacedErrorRecording();
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    function Crash(): never {
      // oxlint-disable-next-line eslint/no-throw-literal, typescript/only-throw-error -- Exercise a real non-Error throw.
      throw 'private thrown string';
    }
    try {
      const session = {
        sessionId: '01890000-0000-7000-8000-000000000000',
        revision: 0,
      };
      await expect(
        client.initializeDesktopInstrumentationClient({
          surface: 'main',
          getPostHogAnonymousId: () => Promise.resolve(ANONYMOUS_ID),
          posthogFlags: {
            getSnapshot: () =>
              Promise.resolve({ ...flags(false), errorReports: true }),
            onSnapshotChanged: (): (() => void) => (): void => undefined,
          },
          posthogSession: {
            get: () => Promise.resolve(session),
            report: (proposal) => Promise.resolve(proposal),
            subscribe: (): (() => void) => (): void => undefined,
          },
        }),
      ).resolves.toEqual([{ enabled: true, provider: 'posthog' }]);
      mockBrowserSdk.captureException.mockClear();
      flushSync(() =>
        root.render(
          createElement(AppErrorBoundary, {
            host: rootErrorBoundaryHost,
            layout: 'inline',
            message: 'Could not render the fixture.',
            children: createElement(Crash),
          }),
        ),
      );
      expect(mockBrowserSdk.captureException).toHaveBeenCalledTimes(1);
      const [sdkError, properties] =
        mockBrowserSdk.captureException.mock.calls[0] ?? [];
      if (!(sdkError instanceof Error))
        throw new Error('Expected a renderer exception');
      expect(sdkError.stack).toBe(
        'app.unexpected: Unexpected application failure',
      );
      const sent = mockBeforeSend?.({
        event: '$exception',
        properties: {
          ...properties,
          distinct_id: ANONYMOUS_ID,
          $session_id: session.sessionId,
          $exception_list: [{ type: sdkError.name, value: sdkError.message }],
        },
      });
      expect(sent).toMatchObject({
        properties: {
          error_source: 'boundary:root',
          thrown_type: 'string',
          frames_unavailable: true,
          $exception_list: [{ stacktrace: { type: 'raw', frames: [] } }],
        },
      });
      expect(JSON.stringify(sent)).not.toContain('private thrown string');
    } finally {
      flushSync(() => root.unmount());
      await new Promise<void>((resolve) => setImmediate(resolve));
      uninstall();
      consoleError.mockRestore();
      dom.window.close();
      Reflect.deleteProperty(globalThis, 'window');
      Reflect.deleteProperty(globalThis, 'document');
    }
  });

  it('leaves out the account domain from errors while Usage analytics is off', async () => {
    let push: ((next: PostHogRuntimeFlags) => void) | undefined;
    const session = {
      sessionId: '01890000-0000-7000-8000-000000000000',
      revision: 0,
    };
    await expect(
      client.initializeDesktopInstrumentationClient({
        surface: 'main',
        getPostHogAnonymousId: () => Promise.resolve(ANONYMOUS_ID),
        posthogFlags: {
          getSnapshot: () =>
            Promise.resolve({ ...flags(false), errorReports: true }),
          onSnapshotChanged: (listener): (() => void) => {
            push = listener;
            return (): void => undefined;
          },
        },
        posthogAccount: {
          getSnapshot: () => Promise.resolve('example.com'),
          onSnapshotChanged: (): (() => void) => (): void => undefined,
        },
        posthogSession: {
          get: () => Promise.resolve(session),
          report: (proposal) => Promise.resolve(proposal),
          subscribe: (): (() => void) => (): void => undefined,
        },
      }),
    ).resolves.toEqual([{ enabled: true, provider: 'posthog' }]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const resizeObserverNoise =
      'ResizeObserver loop completed with undelivered notifications.';
    const captureException = (...messages: string[]): unknown =>
      mockBeforeSend?.({
        event: '$exception',
        properties: {
          distinct_id: ANONYMOUS_ID,
          token: 'phc_test',
          $session_id: session.sessionId,
          $exception_list: messages.map((value) => ({
            type: 'Error',
            value,
            stacktrace: {
              frames: [
                {
                  filename:
                    'file:///Applications/Canopy%20(Internal).app/Contents/Resources/app.asar/out/renderer/assets/chunk.js',
                  chunk_id: '3457d40b-6d9d-4fe3-a22c-30b0a90ea610',
                  lineno: 12,
                  colno: 3,
                },
              ],
            },
          })),
        },
      });
    expect(captureException(resizeObserverNoise)).toBeNull();
    expect(
      captureException(`${resizeObserverNoise} More details`),
    ).not.toBeNull();
    const sent = captureException(
      'Unexpected renderer error',
      resizeObserverNoise,
    );
    const properties: unknown =
      typeof sent === 'object' && sent !== null && 'properties' in sent
        ? sent.properties
        : undefined;
    expect(properties).toHaveProperty('$process_person_profile', false);
    expect(properties).toHaveProperty('app_version', '1.2.3');
    expect(properties).toHaveProperty('app_brand', 'canopy');
    expect(properties).toHaveProperty('release_channel', 'rc');
    expect(properties).not.toHaveProperty('email_domain');
    expect(JSON.stringify(sent)).not.toContain('example.com');

    expect(properties).toMatchObject({
      $exception_list: [
        {
          stacktrace: {
            frames: [
              {
                filename: 'https://canopy.local/renderer/assets/chunk.js',
                chunk_id: '3457d40b-6d9d-4fe3-a22c-30b0a90ea610',
                lineno: 12,
                colno: 3,
              },
            ],
          },
        },
        expect.any(Object),
      ],
    });
    expect(JSON.stringify(sent)).not.toContain('/Applications/');

    const recorder = createSurfacedErrorRecorder({
      report: client.reportClientAppError,
      recordsMessageText: false,
    });
    const handled = new Error(
      `${'a'.repeat(4096)}\n    at forged (private.js:1:2)`,
    );
    const recordBoundary = (): ReturnType<typeof recorder.record> =>
      recorder.record({
        chokePoint: 'boundary',
        identifier: 'root',
        surface: 'window',
        error: handled,
      });
    mockBrowserSdk.captureException.mockClear();
    push?.({ ...flags(false), errorReports: false });
    recordBoundary();
    recordBoundary();
    expect(mockBrowserSdk.captureException).not.toHaveBeenCalled();

    push?.({ ...flags(false), errorReports: true });
    const enabledReport = recordBoundary();
    expect(enabledReport?.error.referenceId).toBeDefined();
    expect(enabledReport?.error.source).toBe('boundary:root');
    expect(mockBrowserSdk.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        error_reference_id: enabledReport?.error.referenceId,
      }),
    );
    const rendererException: unknown =
      mockBrowserSdk.captureException.mock.calls[0]?.[0];
    if (!(rendererException instanceof Error))
      throw new Error('Expected a renderer exception');
    expect(rendererException.stack).toContain(
      'posthog-usage-data-gating.test.ts',
    );
    expect(rendererException.stack).not.toContain('forged');
    recordBoundary();
    expect(mockBrowserSdk.captureException).toHaveBeenCalledTimes(1);
    recorder.dispose();
  });

  it.each([
    [
      'Usage analytics turns off while Error reports stays on',
      { ...flags(true), errorReports: true },
      { ...flags(false), errorReports: true },
    ],
    [
      'only Session recordings turns off',
      { ...flags(true), sessionReplay: true, sessionReplaySampleRate: 100 },
      { ...flags(true), sessionReplay: false, sessionReplaySampleRate: 100 },
    ],
  ])('drops queued batches when %s', async (_case, initial, next) => {
    // The runtime guard wraps this transport while the client is installed.
    const transport = mockBrowserSdk._send_retriable_request;
    transport.mockClear();
    mockBrowserSdk._requestQueue.unload.mockClear();
    let push: ((next: PostHogRuntimeFlags) => void) | undefined;
    const session = {
      sessionId: '01890000-0000-7000-8000-000000000000',
      revision: 0,
    };
    await expect(
      client.initializeDesktopInstrumentationClient({
        surface: 'main',
        getPostHogAnonymousId: () => Promise.resolve(ANONYMOUS_ID),
        posthogFlags: {
          getSnapshot: () => Promise.resolve(initial),
          onSnapshotChanged: (listener): (() => void) => {
            push = listener;
            return (): void => undefined;
          },
        },
        posthogSession: {
          get: () => Promise.resolve(session),
          report: (proposal) => Promise.resolve(proposal),
          subscribe: (): (() => void) => (): void => undefined,
        },
      }),
    ).resolves.toEqual([{ enabled: true, provider: 'posthog' }]);
    // posthog-js `RequestQueue.unload` beacons fresh batch objects through
    // the SDK's (guarded) retriable transport instead of discarding them.
    mockBrowserSdk._requestQueue.unload.mockImplementation((): void => {
      mockBrowserSdk._send_retriable_request({ url: '/s/', data: [] });
    });
    try {
      push?.(next);
      expect(mockBrowserSdk._requestQueue.unload).toHaveBeenCalledTimes(1);
      expect(transport).not.toHaveBeenCalled();
    } finally {
      mockBrowserSdk._requestQueue.unload.mockReset();
    }
  });
});
