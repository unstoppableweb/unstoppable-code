// Drives `startUsageAnalyticsOptOutPing`, the function that
// `startProductionUsageAnalyticsOptOutPing` (host.ts) calls with the real
// policy, stored-choice read, marker file and fetch. The schedule is one `setTimeout`
// at a time and a `policy.subscribe` listener, both exercised below with fake
// timers.
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import type * as FsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  USAGE_ANALYTICS_OPT_OUT_PATH,
  UsageAnalyticsOptOutPingSchema,
} from '@canopy/protocol/usage-analytics-optout';
import { BRAND } from '@canopy/brand/current';
import { app } from 'electron';
import { resetCanopyCloudBaseUrlCacheForTest } from '../../canopy-cloud/config';
import {
  arePreferencesUnconfirmed,
  readPreferencesFile,
  readStoredProductAnalyticsChoice,
  resetPreferencesLoadErrorForTests,
} from '../../lib/preferences-store';
import {
  __resetUsageDataPolicyForTests,
  createUsageDataPolicy,
  defaultUsageDataPreferences,
  getUsageDataPolicy,
  initializeUsageDataPolicy,
  type UsageDataPolicy,
  type UsageDataPreferencesState,
  type UsageDataProhibitionState,
} from '../../lib/usage-data-policy';
import { startProductionUsageAnalyticsOptOutPing } from '../host';
import {
  createFileOptOutMarkerStore,
  OPT_OUT_PING_MARKER_FILE_NAME,
} from '../marker-store';
import {
  OPT_OUT_PING_RETRY_DELAYS_MS,
  startUsageAnalyticsOptOutPing,
  utcDateOf,
  type MarkerRead,
  type OptOutChannel,
  type OptOutFetch,
  type UsageAnalyticsOptOutPingHandle,
} from '../ping';

// The real denial journal check reads `preferences.json.usage-data-denied.json`
// beside the preferences file: point it at a temp directory.
let mockPreferencesFilePath = '';
jest.mock('../../lib/paths', () => ({
  getPreferencesFilePath: (): string => mockPreferencesFilePath,
}));

// Lets a test fail chosen reads of real files (the denial journal) while every
// other read goes through to the real file system.
let mockReadFileFailure: ((file: unknown) => Error | null) | null = null;
jest.mock('node:fs/promises', () => {
  const actual: typeof FsPromises = jest.requireActual('node:fs/promises');
  return {
    ...actual,
    readFile: (
      ...args: Parameters<typeof actual.readFile>
    ): ReturnType<typeof actual.readFile> => {
      const failure = mockReadFileFailure?.(args[0]) ?? null;
      if (failure !== null) return Promise.reject(failure);
      return Reflect.apply(actual.readFile, actual, args);
    },
  };
});

// Real file I/O doesn't run on the fake clock. The sender holds exactly one
// timer whenever it is waiting and none while a step (timer callback, file
// reads, request, marker write) is in flight, so "one timer again" is the
// barrier that the step finished: no fixed sleeps. `setImmediate` is captured
// before any test fakes the timers, and the deadline keeps a stuck sender from
// hanging the suite.
const realSetImmediate = setImmediate;
const realDateNow = Date.now.bind(Date);
/** Lets real I/O run until `done()` holds; fails after 5 s of real time. */
async function waitForRealIo(done: () => boolean): Promise<void> {
  const deadline = realDateNow() + 5_000;
  while (!done()) {
    if (realDateNow() > deadline) throw new Error('real I/O never settled');
    await new Promise<void>((resolve) => {
      realSetImmediate(resolve);
    });
  }
}
function settleRealIo(): Promise<void> {
  return waitForRealIo(() => jest.getTimerCount() > 0);
}
async function advanceWithRealIo(
  totalMs: number,
  stepMs = 60_000,
): Promise<void> {
  await settleRealIo();
  for (let elapsed = 0; elapsed < totalMs; elapsed += stepMs) {
    await jest.advanceTimersByTimeAsync(Math.min(stepMs, totalMs - elapsed));
    await settleRealIo();
  }
}

/** Main's `appIsQuitting` before any quit. */
const notQuitting = (): boolean => false;
const ACME = '11111111-1111-4111-8111-111111111111';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const BASE_URL = 'https://cloud.example.test';
const START = '2026-11-20T10:00:00.000Z';

function acmeProhibits(): UsageDataProhibitionState {
  return new Map([
    [
      ACME,
      {
        organizationName: 'Acme',
        prohibited: {
          productAnalytics: true,
          sessionReplay: false,
          errorReports: false,
          activeUseSignal: false,
          featureFlagIdentity: false,
        },
      },
    ],
  ]);
}

function optedOut(): UsageDataPreferencesState {
  return { ...defaultUsageDataPreferences(), productAnalytics: false };
}

type StoredChoice =
  | 'allowed'
  | 'denied'
  | 'unconfirmed'
  | 'denial-journal-unreadable';

interface HarnessOptions {
  preferences?: UsageDataPreferencesState;
  prohibitions?: UsageDataProhibitionState;
  /** `null`: the context is never set. */
  context?: Parameters<UsageDataPolicy['setWorkspaceContext']>[0] | null;
  marker?: MarkerRead;
  channel?: OptOutChannel | null;
  isPackaged?: boolean;
  allowsAutomaticCall?: boolean;
  /** The stored choice; by default what the starting preferences say. */
  stored?: StoredChoice;
  fetchImpl?: OptOutFetch;
  /** Runs on every stored-choice read, before it answers. */
  onStoredRead?: () => void;
  isQuitting?: () => boolean;
  /** Holds every marker write until this settles. */
  writeGate?: Promise<void>;
  /** Holds every marker read until this settles. */
  readGate?: Promise<void>;
  /** Runs on every marker read, before it answers. */
  onMarkerRead?: () => void;
  /** Default 0: the send waits only its minimum delay. */
  random?: number;
  resolveEndpointUrl?: () => string;
}

function startHarness(options: HarnessOptions = {}): {
  policy: UsageDataPolicy;
  fetchMock: jest.Mock<ReturnType<OptOutFetch>, Parameters<OptOutFetch>>;
  markerWrites: string[];
  handle: UsageAnalyticsOptOutPingHandle;
  setMarker: (marker: MarkerRead) => void;
  setStored: (choice: StoredChoice) => void;
} {
  const policy = createUsageDataPolicy({
    preferences: options.preferences ?? optedOut(),
    prohibitions: options.prohibitions ?? new Map(),
    settleTimeoutMs: 1_000,
  });
  if (options.context !== null) {
    policy.setWorkspaceContext(options.context ?? { kind: 'personal' });
  }
  let marker: MarkerRead = options.marker ?? { kind: 'missing' };
  const startingPreferences = options.preferences ?? optedOut();
  let stored: StoredChoice =
    options.stored ??
    (startingPreferences !== 'unreadable' &&
    startingPreferences.productAnalytics
      ? 'allowed'
      : 'denied');
  const markerWrites: string[] = [];
  const fetchMock = jest.fn<ReturnType<OptOutFetch>, Parameters<OptOutFetch>>(
    options.fetchImpl ??
      ((): ReturnType<OptOutFetch> => Promise.resolve({ status: 204 })),
  );
  const handle = startUsageAnalyticsOptOutPing({
    channel: options.channel === undefined ? 'stable' : options.channel,
    isPackaged: options.isPackaged ?? true,
    allowsAutomaticCall: options.allowsAutomaticCall ?? true,
    policy,
    readStoredProductAnalytics: () => {
      options.onStoredRead?.();
      return Promise.resolve(stored);
    },
    isQuitting: options.isQuitting,
    markerStore: {
      read: async () => {
        options.onMarkerRead?.();
        await options.readGate;
        return marker;
      },
      write: async (utcDate) => {
        await options.writeGate;
        markerWrites.push(utcDate);
        marker = { kind: 'present', utcDate };
      },
    },
    resolveEndpointUrl:
      options.resolveEndpointUrl ??
      ((): string => `${BASE_URL}${USAGE_ANALYTICS_OPT_OUT_PATH}`),
    fetch: fetchMock,
    random: () => options.random ?? 0,
  });
  return {
    policy,
    fetchMock,
    markerWrites,
    handle,
    setMarker: (next) => {
      marker = next;
    },
    setStored: (next) => {
      stored = next;
    },
  };
}

function bodyOf(
  fetchMock: jest.Mock<ReturnType<OptOutFetch>, Parameters<OptOutFetch>>,
  call = 0,
): unknown {
  const init = fetchMock.mock.calls[call]?.[1];
  if (!init) throw new Error('no request');
  return JSON.parse(init.body);
}

let handles: UsageAnalyticsOptOutPingHandle[] = [];
function track(
  harness: ReturnType<typeof startHarness>,
): ReturnType<typeof startHarness> {
  handles.push(harness.handle);
  return harness;
}

beforeEach(() => {
  jest.useFakeTimers({ now: Date.parse(START) });
});

afterEach(async () => {
  await Promise.all(handles.map((handle) => handle.stop()));
  handles = [];
  jest.useRealTimers();
});

describe('usage analytics opt-out ping: sending', () => {
  it('sends a personal opt-out once and writes the marker after the 2xx', async () => {
    const { fetchMock, markerWrites } = track(startHarness());
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(bodyOf(fetchMock)).toEqual({
      reason: 'personal',
      channel: 'stable',
    });
    expect(markerWrites).toEqual(['2026-11-20']);
    // Never again on the same UTC date.
    await jest.advanceTimersByTimeAsync(10 * HOUR);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends at a random time of the UTC day, not at launch', async () => {
    const { fetchMock } = track(startHarness({ random: 0.5 }));
    // 10:00 launch, 12:00 target.
    await jest.advanceTimersByTimeAsync(HOUR);
    expect(fetchMock).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(2 * HOUR);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends an org prohibition with reason org when the member left it on', async () => {
    const { fetchMock } = track(
      startHarness({
        preferences: defaultUsageDataPreferences(),
        prohibitions: acmeProhibits(),
        context: { kind: 'organization', organizationId: ACME },
      }),
    );
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    expect(bodyOf(fetchMock)).toEqual({ reason: 'org', channel: 'stable' });
  });

  it('reports a personal choice as personal even inside a prohibiting org', async () => {
    const { fetchMock } = track(
      startHarness({
        prohibitions: acmeProhibits(),
        context: { kind: 'organization', organizationId: ACME },
      }),
    );
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    expect(bodyOf(fetchMock)).toEqual({
      reason: 'personal',
      channel: 'stable',
    });
  });

  it.each(['internal', 'rc', 'stable'] as const)(
    'sends the %s channel',
    async (channel) => {
      const { fetchMock } = track(startHarness({ channel }));
      await jest.advanceTimersByTimeAsync(10 * 60_000);
      expect(bodyOf(fetchMock)).toEqual({ reason: 'personal', channel });
    },
  );

  it('does not send when the marker is already today, then sends on the next UTC day', async () => {
    const { fetchMock, markerWrites } = track(
      startHarness({ marker: { kind: 'present', utcDate: '2026-11-20' } }),
    );
    await jest.advanceTimersByTimeAsync(13 * HOUR); // 23:00 UTC
    expect(fetchMock).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(13 * HOUR); // next day 12:00 UTC
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(markerWrites).toEqual(['2026-11-21']);
  });

  it('sends when the marker holds an earlier UTC date', async () => {
    const { fetchMock, markerWrites } = track(
      startHarness({ marker: { kind: 'present', utcDate: '2026-11-19' } }),
    );
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(markerWrites).toEqual(['2026-11-20']);
  });

  it('keys the marker by the UTC date at send time when the delay crosses midnight', async () => {
    jest.setSystemTime(Date.parse('2026-11-20T23:59:00.000Z'));
    const { fetchMock, markerWrites } = track(
      startHarness({
        marker: { kind: 'present', utcDate: '2026-11-19' },
        random: 0.5,
      }),
    );
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(markerWrites).toEqual(['2026-11-21']);
  });

  it('skips a send whose date already has a marker after the delay crossed midnight', async () => {
    jest.setSystemTime(Date.parse('2026-11-20T23:59:00.000Z'));
    const { fetchMock, setMarker } = track(
      startHarness({
        marker: { kind: 'present', utcDate: '2026-11-19' },
        random: 0.5,
      }),
    );
    // Something else recorded the next date while the send was waiting.
    setMarker({ kind: 'present', utcDate: '2026-11-21' });
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // The checks before a send are async. When midnight passes under them, the
  // request and its marker must still carry the same UTC date, or the next
  // cycle would see the new date as unsent and count the install twice.
  it.each([1, 2, 5])(
    'sends once with one date for the request and the marker when midnight passes %i time(s) under the send-time checks',
    async (hops) => {
      jest.setSystemTime(Date.parse('2026-11-20T23:50:00.000Z'));
      let armed = false;
      let hopsLeft = hops;
      const sentAt: number[] = [];
      const { fetchMock, markerWrites } = track(
        startHarness({
          marker: { kind: 'present', utcDate: '2026-11-19' },
          random: 0.5,
          onStoredRead: () => {
            if (!armed || hopsLeft === 0) return;
            hopsLeft -= 1;
            jest.setSystemTime(Date.now() + DAY);
          },
          fetchImpl: () => {
            sentAt.push(Date.now());
            return Promise.resolve({ status: 204 });
          },
        }),
      );
      // The launch evaluation is done and a send is waiting (23:50:10 UTC).
      await jest.advanceTimersByTimeAsync(10_000);
      armed = true;
      await jest.advanceTimersByTimeAsync(2 * HOUR);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(markerWrites).toHaveLength(1);
      expect(markerWrites[0]).toBe(utcDateOf(sentAt[0] ?? 0));
      // Nothing more the same UTC date.
      await jest.advanceTimersByTimeAsync(HOUR);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it('starts over from the schedule, without sending, when midnight keeps passing under the send-time checks', async () => {
    jest.setSystemTime(Date.parse('2026-11-20T23:50:00.000Z'));
    let hopping = false;
    let readsWhileHopping = 0;
    const sentAt: number[] = [];
    const { fetchMock, markerWrites } = track(
      startHarness({
        marker: { kind: 'present', utcDate: '2026-11-19' },
        random: 0.5,
        onStoredRead: () => {
          // Capped, so a send that never gives up can't spin forever here.
          if (!hopping || readsWhileHopping >= 200) return;
          readsWhileHopping += 1;
          jest.setSystemTime(Date.now() + DAY);
        },
        fetchImpl: () => {
          sentAt.push(Date.now());
          return Promise.resolve({ status: 204 });
        },
      }),
    );
    // The launch evaluation is done; the send is due at 23:53:00 UTC.
    await jest.advanceTimersByTimeAsync(10_000);
    hopping = true;
    await jest.advanceTimersByTimeAsync(3 * 60_000);
    // Three send-time passes, then one new evaluation that schedules a fresh
    // send: a bounded number of checks, and nothing sent for a date the
    // checks didn't cover.
    expect(readsWhileHopping).toBeGreaterThanOrEqual(3);
    expect(readsWhileHopping).toBeLessThanOrEqual(4);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(markerWrites).toEqual([]);
    hopping = false;
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(markerWrites).toEqual([utcDateOf(sentAt[0] ?? 0)]);
  });

  it('sends once per UTC day over several days', async () => {
    const { fetchMock, markerWrites } = track(startHarness());
    await jest.advanceTimersByTimeAsync(40 * HOUR);
    expect(markerWrites).toEqual(['2026-11-20', '2026-11-21', '2026-11-22']);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('sends the day an opt-out starts, once the policy changes', async () => {
    const { fetchMock, policy, setStored } = track(
      startHarness({ preferences: defaultUsageDataPreferences() }),
    );
    await jest.advanceTimersByTimeAsync(2 * HOUR);
    expect(fetchMock).not.toHaveBeenCalled();
    // The save lands on disk, then in the live policy.
    setStored('denied');
    policy.setPreferences(optedOut());
    await jest.advanceTimersByTimeAsync(DAY / 2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('builds the exact request the schema allows and nothing else', async () => {
    const { fetchMock } = track(startHarness());
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://cloud.example.test/api/usage-analytics/opt-out');
    if (!init) throw new Error('no request');
    expect(Object.keys(init).sort()).toEqual([
      'body',
      'credentials',
      'headers',
      'method',
      'redirect',
      'signal',
    ]);
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('omit');
    expect(init.redirect).toBe('error');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(Object.keys(init.headers)).toEqual(['Content-Type']);
    const body: unknown = JSON.parse(init.body);
    expect(UsageAnalyticsOptOutPingSchema.safeParse(body).success).toBe(true);
    expect(
      Object.keys(UsageAnalyticsOptOutPingSchema.parse(body)).sort(),
    ).toEqual(['channel', 'reason']);
    expect(init.body).toBe('{"reason":"personal","channel":"stable"}');
  });
});

describe('usage analytics opt-out ping: nothing is sent', () => {
  async function expectSilent(
    options: HarnessOptions,
    forMs = 3 * DAY,
  ): Promise<void> {
    const { fetchMock, markerWrites } = track(startHarness(options));
    await jest.advanceTimersByTimeAsync(forMs);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(markerWrites).toEqual([]);
  }

  it('sends nothing while Usage analytics is on', () =>
    expectSilent({ preferences: defaultUsageDataPreferences() }));

  it('sends nothing when the preferences are unreadable', () =>
    expectSilent({ preferences: 'unreadable' }));

  it('sends nothing when the organization policy is unreadable', () =>
    expectSilent({ prohibitions: 'unreadable' }));

  it('sends nothing for an unreadable organization policy even with a personal opt-out', () =>
    expectSilent({ preferences: optedOut(), prohibitions: 'unreadable' }));

  it('sends nothing while the workspace context is unknown', () =>
    expectSilent({ context: null, prohibitions: acmeProhibits() }));

  it('sends nothing for a startup-conservative org prohibition', () =>
    expectSilent({
      context: null,
      preferences: defaultUsageDataPreferences(),
      prohibitions: acmeProhibits(),
    }));

  it('sends nothing when the denial journal is unreadable', () =>
    expectSilent({ stored: 'denial-journal-unreadable' }));

  it('sends nothing when the marker and its write date are unreadable', () =>
    expectSilent({ marker: { kind: 'unreadable', lastWrittenUtcDate: null } }));

  it('sends nothing in a development build', () =>
    expectSilent({ isPackaged: false }));

  it('sends nothing in a local-only build', () =>
    expectSilent({ allowsAutomaticCall: false }));

  it('sends nothing without a release channel', () =>
    expectSilent({ channel: null }));

  it('sends once the context becomes known after startup', async () => {
    const { fetchMock, policy } = track(startHarness({ context: null }));
    await jest.advanceTimersByTimeAsync(2 * HOUR);
    expect(fetchMock).not.toHaveBeenCalled();
    policy.setWorkspaceContext({ kind: 'personal' });
    await jest.advanceTimersByTimeAsync(HOUR);
    expect(bodyOf(fetchMock)).toEqual({
      reason: 'personal',
      channel: 'stable',
    });
  });

  it('aborts when analytics turns on while the send waits', async () => {
    const { fetchMock, markerWrites, policy } = track(startHarness());
    await jest.advanceTimersByTimeAsync(10_000);
    policy.setPreferences(defaultUsageDataPreferences());
    await jest.advanceTimersByTimeAsync(2 * DAY);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(markerWrites).toEqual([]);
  });

  it('aborts when the state turns unknown while the send waits', async () => {
    const { fetchMock, markerWrites, policy } = track(startHarness());
    await jest.advanceTimersByTimeAsync(10_000);
    policy.setProhibitionsByOrganization('unreadable');
    await jest.advanceTimersByTimeAsync(2 * DAY);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(markerWrites).toEqual([]);
  });

  // Random 0.5 puts the send at 12:00 UTC plus 3 minutes of jitter, so the
  // flip lands after the evaluation at launch and before the send.
  it('sends at 12:03 UTC when nothing changes (control for the re-checks)', async () => {
    const { fetchMock } = track(startHarness({ random: 0.5 }));
    await jest.advanceTimersByTimeAsync(2 * HOUR + 10_000); // 12:00:10 UTC
    expect(fetchMock).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(10 * 60_000); // 12:10:10 UTC
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  type Harness = ReturnType<typeof startHarness>;
  it.each<[string, (harness: Harness) => void]>([
    [
      'the denial journal',
      (h): void => h.setStored('denial-journal-unreadable'),
    ],
    ['the stored choice', (h): void => h.setStored('unconfirmed')],
  ])('re-checks %s right before sending', async (_label, flip) => {
    const harness = track(startHarness({ random: 0.5 }));
    await jest.advanceTimersByTimeAsync(10_000);
    flip(harness);
    // Past the 12:03 send, so a missing re-check would have sent by now.
    await jest.advanceTimersByTimeAsync(2 * HOUR + 10 * 60_000);
    expect(harness.fetchMock).not.toHaveBeenCalled();
    expect(harness.markerWrites).toEqual([]);
  });

  it('sends nothing while the stored choice is unconfirmed, then sends once it is proven', async () => {
    // A latched preferences recovery: the live policy still reads as a
    // personal opt-out, which disk can't confirm.
    const { fetchMock, markerWrites, setStored } = track(
      startHarness({ stored: 'unconfirmed' }),
    );
    await jest.advanceTimersByTimeAsync(DAY / 2);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(markerWrites).toEqual([]);
    setStored('denied');
    await jest.advanceTimersByTimeAsync(HOUR);
    expect(bodyOf(fetchMock)).toEqual({
      reason: 'personal',
      channel: 'stable',
    });
  });

  it('sends nothing for a personal opt-out the saved preference does not hold', async () => {
    // A stale `false` from the fail-closed journal overlay: the journal is
    // readable again and the saved choice is on.
    await expectSilent({ stored: 'allowed' });
  });

  it('sends nothing for an org prohibition while a personal denial is stored', async () => {
    await expectSilent({
      preferences: defaultUsageDataPreferences(),
      prohibitions: acmeProhibits(),
      context: { kind: 'organization', organizationId: ACME },
      stored: 'denied',
    });
  });

  it('sends an org prohibition when the saved choice is on', async () => {
    const { fetchMock } = track(
      startHarness({
        preferences: defaultUsageDataPreferences(),
        prohibitions: acmeProhibits(),
        context: { kind: 'organization', organizationId: ACME },
        stored: 'allowed',
      }),
    );
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    expect(bodyOf(fetchMock)).toEqual({ reason: 'org', channel: 'stable' });
  });

  it('treats a stored-choice read that fails as unconfirmed', async () => {
    const policy = createUsageDataPolicy({ preferences: optedOut() });
    policy.setWorkspaceContext({ kind: 'personal' });
    const fetchMock = jest.fn<ReturnType<OptOutFetch>, Parameters<OptOutFetch>>(
      () => Promise.resolve({ status: 204 }),
    );
    handles.push(
      startUsageAnalyticsOptOutPing({
        channel: 'stable',
        isPackaged: true,
        allowsAutomaticCall: true,
        policy,
        readStoredProductAnalytics: () => Promise.reject(new Error('EIO')),
        markerStore: {
          read: () => Promise.resolve({ kind: 'missing' }),
          write: () => Promise.resolve(),
        },
        resolveEndpointUrl: () => BASE_URL,
        fetch: fetchMock,
        random: () => 0,
      }),
    );
    await jest.advanceTimersByTimeAsync(DAY);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stops every timer on stop()', async () => {
    const { fetchMock, handle } = track(startHarness());
    await handle.stop();
    await jest.advanceTimersByTimeAsync(2 * DAY);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('usage analytics opt-out ping: failures', () => {
  it('leaves the marker unwritten after a non-2xx and retries later', async () => {
    let status = 500;
    const { fetchMock, markerWrites } = track(
      startHarness({ fetchImpl: () => Promise.resolve({ status }) }),
    );
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(markerWrites).toEqual([]);
    status = 204;
    await jest.advanceTimersByTimeAsync(30 * 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(markerWrites).toEqual(['2026-11-20']);
  });

  it.each([301, 400, 404, 199])(
    'treats status %i as a failure',
    async (status) => {
      const { markerWrites } = track(
        startHarness({ fetchImpl: () => Promise.resolve({ status }) }),
      );
      await jest.advanceTimersByTimeAsync(10 * 60_000);
      expect(markerWrites).toEqual([]);
    },
  );

  it('leaves the marker unwritten after a thrown fetch', async () => {
    const { fetchMock, markerWrites } = track(
      startHarness({
        fetchImpl: () => Promise.reject(new Error('offline')),
      }),
    );
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(markerWrites).toEqual([]);
  });

  it('counts a redirect as a failed send: no marker, and a retry', async () => {
    // Real fetch with `redirect: 'error'` rejects with a TypeError when the
    // endpoint redirects, instead of following to a 2xx and looking delivered.
    const sentAt: number[] = [];
    const { fetchMock, markerWrites } = track(
      startHarness({
        fetchImpl: () => {
          sentAt.push(Date.now());
          return Promise.reject(
            new TypeError('fetch failed', { cause: 'redirect' }),
          );
        },
      }),
    );
    // The send lands within the launch jitter; stop right after it.
    await jest.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(markerWrites).toEqual([]);
    // The first retry waits the first delay, not less.
    const [first = 0] = sentAt;
    const retryAt = first + OPT_OUT_PING_RETRY_DELAYS_MS[0];
    await jest.advanceTimersByTimeAsync(retryAt - Date.now() - 1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(2 * 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(markerWrites).toEqual([]);
  });

  it('leaves the marker unwritten when the cloud base URL is unusable', async () => {
    const { fetchMock, markerWrites } = track(
      startHarness({
        resolveEndpointUrl: () => {
          throw new Error('base-url-not-configured');
        },
      }),
    );
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(markerWrites).toEqual([]);
  });

  it('bounds retries per UTC day and tries again the next day', async () => {
    let status = 500;
    const { fetchMock, markerWrites } = track(
      startHarness({ fetchImpl: () => Promise.resolve({ status }) }),
    );
    // One send plus every retry, then silence until the day changes.
    await jest.advanceTimersByTimeAsync(13 * HOUR);
    const perDay = 1 + OPT_OUT_PING_RETRY_DELAYS_MS.length;
    expect(fetchMock).toHaveBeenCalledTimes(perDay);
    expect(markerWrites).toEqual([]);
    status = 204;
    await jest.advanceTimersByTimeAsync(DAY);
    expect(fetchMock).toHaveBeenCalledTimes(perDay + 1);
    expect(markerWrites).toEqual(['2026-11-21']);
  });

  // With random 0 every wait is its minimum (30 s of jitter), so launching at
  // 18:42:50 puts the first send at 18:43:20 and the last retry (after 15 min,
  // 1 h and 4 h) at 23:59:50 UTC.
  describe('a request that runs into the next UTC day', () => {
    const LAST_ATTEMPT = 4;
    function launchAtLastAttempt(finalStatus: number): {
      fetchMock: jest.Mock<ReturnType<OptOutFetch>, Parameters<OptOutFetch>>;
      markerWrites: string[];
      finishLastAttempt: () => void;
      bodies: () => unknown[];
    } {
      jest.setSystemTime(Date.parse('2026-11-20T18:42:50.000Z'));
      let attempts = 0;
      let finish: () => void = () => undefined;
      const harness = track(
        startHarness({
          fetchImpl: () => {
            attempts += 1;
            if (attempts < LAST_ATTEMPT)
              return Promise.resolve({ status: 500 });
            if (attempts > LAST_ATTEMPT)
              return Promise.resolve({ status: 204 });
            return new Promise((resolve) => {
              finish = (): void => resolve({ status: finalStatus });
            });
          },
        }),
      );
      return {
        fetchMock: harness.fetchMock,
        markerWrites: harness.markerWrites,
        finishLastAttempt: () => finish(),
        bodies: () =>
          harness.fetchMock.mock.calls.map((_call, index) =>
            bodyOf(harness.fetchMock, index),
          ),
      };
    }

    it('starts a fresh cycle for the new day when the last retry fails after midnight', async () => {
      const { fetchMock, markerWrites, finishLastAttempt } =
        launchAtLastAttempt(500);
      // 23:59:50: the last retry of the day is on the wire.
      await jest.advanceTimersByTimeAsync(5 * HOUR + 17 * 60_000);
      expect(fetchMock).toHaveBeenCalledTimes(LAST_ATTEMPT);
      // It fails at 00:00:10 UTC.
      await jest.advanceTimersByTimeAsync(20_000);
      expect(utcDateOf(Date.now())).toBe('2026-11-21');
      finishLastAttempt();
      // The new day is not used up: its own send follows within the hour.
      await jest.advanceTimersByTimeAsync(HOUR);
      expect(fetchMock).toHaveBeenCalledTimes(LAST_ATTEMPT + 1);
      expect(markerWrites).toEqual(['2026-11-21']);
      // Once per day from then on.
      await jest.advanceTimersByTimeAsync(10 * HOUR);
      expect(fetchMock).toHaveBeenCalledTimes(LAST_ATTEMPT + 1);
    });

    it('gives the new day a full retry budget', async () => {
      const { fetchMock, markerWrites, finishLastAttempt } =
        launchAtLastAttempt(500);
      await jest.advanceTimersByTimeAsync(5 * HOUR + 17 * 60_000);
      await jest.advanceTimersByTimeAsync(20_000);
      finishLastAttempt();
      // Every later attempt fails too: all four attempts of the new day run.
      fetchMock.mockImplementation(() => Promise.resolve({ status: 500 }));
      await jest.advanceTimersByTimeAsync(12 * HOUR);
      expect(fetchMock).toHaveBeenCalledTimes(
        LAST_ATTEMPT + 1 + OPT_OUT_PING_RETRY_DELAYS_MS.length,
      );
      expect(markerWrites).toEqual([]);
    });

    it('keeps the day used up for a request that fails before midnight', async () => {
      const { fetchMock, finishLastAttempt } = launchAtLastAttempt(500);
      await jest.advanceTimersByTimeAsync(5 * HOUR + 17 * 60_000);
      expect(fetchMock).toHaveBeenCalledTimes(LAST_ATTEMPT);
      // Still 23:59:50 UTC: the budget for the day is spent, so no immediate
      // retry; the new day sends once, on its own schedule.
      finishLastAttempt();
      await jest.advanceTimersByTimeAsync(5_000);
      expect(fetchMock).toHaveBeenCalledTimes(LAST_ATTEMPT);
      await jest.advanceTimersByTimeAsync(HOUR);
      expect(fetchMock).toHaveBeenCalledTimes(LAST_ATTEMPT + 1);
    });

    it('records the date the request was dispatched under when it succeeds after midnight', async () => {
      const { fetchMock, markerWrites, finishLastAttempt, bodies } =
        launchAtLastAttempt(204);
      await jest.advanceTimersByTimeAsync(5 * HOUR + 17 * 60_000);
      expect(fetchMock).toHaveBeenCalledTimes(LAST_ATTEMPT);
      await jest.advanceTimersByTimeAsync(20_000);
      finishLastAttempt();
      await jest.advanceTimersByTimeAsync(0);
      expect(markerWrites).toEqual(['2026-11-20']);
      // The new UTC date still gets its own ping, with the same exact body.
      await jest.advanceTimersByTimeAsync(HOUR);
      expect(markerWrites).toEqual(['2026-11-20', '2026-11-21']);
      expect(bodies().at(-1)).toEqual({
        reason: 'personal',
        channel: 'stable',
      });
    });
  });

  it('does not repeat in this process when the marker write fails after a 2xx', async () => {
    const policy = createUsageDataPolicy({ preferences: optedOut() });
    policy.setWorkspaceContext({ kind: 'personal' });
    const fetchMock = jest.fn<ReturnType<OptOutFetch>, Parameters<OptOutFetch>>(
      () => Promise.resolve({ status: 204 }),
    );
    handles.push(
      startUsageAnalyticsOptOutPing({
        channel: 'stable',
        isPackaged: true,
        allowsAutomaticCall: true,
        policy,
        readStoredProductAnalytics: () => Promise.resolve('denied'),
        markerStore: {
          read: () => Promise.resolve({ kind: 'missing' }),
          write: () => Promise.reject(new Error('disk full')),
        },
        resolveEndpointUrl: () => BASE_URL,
        fetch: fetchMock,
        random: () => 0.5,
      }),
    );
    await jest.advanceTimersByTimeAsync(10 * HOUR);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('usage analytics opt-out ping: marker read across midnight', () => {
  it('uses the new date when the marker read finishes after midnight', async () => {
    jest.setSystemTime(Date.parse('2026-11-20T23:59:59.000Z'));
    let release: () => void = () => undefined;
    const readGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Yesterday's marker: it says nothing about the new day.
    const { fetchMock, markerWrites } = track(
      startHarness({
        marker: { kind: 'present', utcDate: '2026-11-20' },
        readGate,
      }),
    );
    await jest.advanceTimersByTimeAsync(2_000);
    expect(utcDateOf(Date.now())).toBe('2026-11-21');
    expect(fetchMock).not.toHaveBeenCalled();
    release();
    // The new day gets its own attempt, not a wait for the next midnight.
    await jest.advanceTimersByTimeAsync(23 * HOUR);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(markerWrites).toEqual(['2026-11-21']);
  });

  it('does not repeat the old day when the marker read finishes after midnight', async () => {
    jest.setSystemTime(Date.parse('2026-11-20T23:59:59.000Z'));
    let release: () => void = () => undefined;
    const readGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The marker is missing, so the old day could still send: it must not,
    // and the new day sends once under its own date.
    const { fetchMock, markerWrites } = track(startHarness({ readGate }));
    await jest.advanceTimersByTimeAsync(2_000);
    release();
    await jest.advanceTimersByTimeAsync(23 * HOUR);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(markerWrites).toEqual(['2026-11-21']);
  });

  it('stays bounded when every marker read crosses midnight', async () => {
    jest.setSystemTime(Date.parse('2026-11-20T23:59:59.000Z'));
    let reads = 0;
    const { fetchMock } = track(
      startHarness({
        onMarkerRead: () => {
          reads += 1;
          jest.setSystemTime(Date.now() + DAY);
        },
      }),
    );
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    // Three passes per cycle, then a wait: never a tight loop.
    expect(reads).toBeGreaterThanOrEqual(3);
    expect(reads).toBeLessThan(20);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('usage analytics opt-out ping: real denial journal', () => {
  let dir = '';
  beforeEach(async () => {
    jest.useRealTimers();
    dir = await mkdtemp(path.join(tmpdir(), 'optout-ping-'));
    mockPreferencesFilePath = path.join(dir, 'preferences.json');
    resetPreferencesLoadErrorForTests();
    // The saved choice agrees with the live policy below: off.
    await writeFile(
      mockPreferencesFilePath,
      JSON.stringify({
        version: 1,
        preferences: { usageData: { productAnalytics: false } },
      }),
    );
  });
  afterEach(async () => {
    resetPreferencesLoadErrorForTests();
    await rm(dir, { recursive: true, force: true });
  });

  // Starts the sender with the real stored-choice read (preferences file and
  // denial journal) and marker file; counts the reads so a test can tell the
  // launch evaluation has finished.
  function launchWithRealJournal(): {
    fetchMock: jest.Mock<ReturnType<OptOutFetch>, Parameters<OptOutFetch>>;
    storedReads: () => number;
  } {
    jest.useFakeTimers({ now: Date.parse(START) });
    const policy = createUsageDataPolicy({ preferences: optedOut() });
    policy.setWorkspaceContext({ kind: 'personal' });
    const fetchMock = jest.fn<ReturnType<OptOutFetch>, Parameters<OptOutFetch>>(
      () => Promise.resolve({ status: 204 }),
    );
    let reads = 0;
    handles.push(
      startUsageAnalyticsOptOutPing({
        channel: 'stable',
        isPackaged: true,
        allowsAutomaticCall: true,
        policy,
        readStoredProductAnalytics: () => {
          reads += 1;
          return readStoredProductAnalyticsChoice();
        },
        markerStore: createFileOptOutMarkerStore(() => dir),
        resolveEndpointUrl: () => BASE_URL,
        fetch: fetchMock,
        random: () => 0.5,
      }),
    );
    return { fetchMock, storedReads: () => reads };
  }

  const journalPath = (): string =>
    path.join(dir, 'preferences.json.usage-data-denied.json');
  const markerPath = (): string =>
    path.join(dir, OPT_OUT_PING_MARKER_FILE_NAME);

  it.each([
    ['a missing journal', null],
    ['a journal that holds the denial', JSON.stringify(['productAnalytics'])],
    ['a journal that holds another key', JSON.stringify(['sessionReplay'])],
  ])('sends with %s and records the marker', async (_label, journal) => {
    if (journal !== null) await writeFile(journalPath(), journal);
    const { fetchMock } = launchWithRealJournal();
    await advanceWithRealIo(13 * HOUR, 30 * 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await readFile(markerPath(), 'utf8'))).toEqual({
      version: 1,
      lastSentUtcDate: '2026-11-20',
    });
  });

  it.each(['not json', '{"a":1}', '["unknownKey"]'])(
    'sends nothing when the real journal is damaged at launch (%s)',
    async (content) => {
      await writeFile(journalPath(), content);
      const { fetchMock, storedReads } = launchWithRealJournal();
      await advanceWithRealIo(2 * DAY, 60 * 60_000);
      // Read at launch and at every later check, and never a send.
      expect(storedReads()).toBeGreaterThan(0);
      expect(fetchMock).not.toHaveBeenCalled();
      await expect(readFile(markerPath(), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
    },
  );

  it('sends nothing when the journal path is unreadable', async () => {
    await mkdir(journalPath());
    const { fetchMock } = launchWithRealJournal();
    await advanceWithRealIo(DAY, 60 * 60_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('re-reads the real journal right before sending', async () => {
    const { fetchMock, storedReads } = launchWithRealJournal();
    // 10:00 to 10:10 UTC: the launch evaluation has read the stored choice
    // and the journal, and the send, due at 12:03, is waiting.
    await advanceWithRealIo(10 * 60_000, 60_000);
    // Barrier: one read, one timer, nothing sent.
    expect(storedReads()).toBe(1);
    expect(jest.getTimerCount()).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
    await writeFile(journalPath(), 'garbage');
    const readsBefore = storedReads();
    await advanceWithRealIo(2 * HOUR + 10 * 60_000, 30 * 60_000);
    expect(storedReads()).toBeGreaterThan(readsBefore);
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(readFile(markerPath(), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});

describe('usage analytics opt-out ping: failing dependencies never stick the schedule', () => {
  function startWith(
    overrides: Partial<Parameters<typeof startUsageAnalyticsOptOutPing>[0]>,
  ): {
    fetchMock: jest.Mock<ReturnType<OptOutFetch>, Parameters<OptOutFetch>>;
  } {
    const policy = createUsageDataPolicy({ preferences: optedOut() });
    policy.setWorkspaceContext({ kind: 'personal' });
    const fetchMock = jest.fn<ReturnType<OptOutFetch>, Parameters<OptOutFetch>>(
      () => Promise.resolve({ status: 204 }),
    );
    handles.push(
      startUsageAnalyticsOptOutPing({
        channel: 'stable',
        isPackaged: true,
        allowsAutomaticCall: true,
        policy,
        readStoredProductAnalytics: () => Promise.resolve('denied'),
        markerStore: {
          read: () => Promise.resolve({ kind: 'missing' }),
          write: () => Promise.resolve(),
        },
        resolveEndpointUrl: () => BASE_URL,
        fetch: fetchMock,
        random: () => 0,
        ...overrides,
      }),
    );
    return { fetchMock };
  }

  it('treats a rejected marker read as unknown for today, then recovers', async () => {
    let failing = true;
    const { fetchMock } = startWith({
      markerStore: {
        read: () =>
          failing
            ? Promise.reject(new Error('EIO'))
            : Promise.resolve({ kind: 'missing' }),
        write: () => Promise.resolve(),
      },
    });
    await jest.advanceTimersByTimeAsync(HOUR);
    expect(fetchMock).not.toHaveBeenCalled();
    failing = false;
    // The next UTC day reads the marker again.
    await jest.advanceTimersByTimeAsync(DAY);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('treats a rejected stored-choice read as unknown, then recovers', async () => {
    let failing = true;
    const { fetchMock } = startWith({
      readStoredProductAnalytics: () =>
        failing ? Promise.reject(new Error('EIO')) : Promise.resolve('denied'),
    });
    await jest.advanceTimersByTimeAsync(5 * 60_000);
    expect(fetchMock).not.toHaveBeenCalled();
    failing = false;
    await jest.advanceTimersByTimeAsync(HOUR);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('usage analytics opt-out ping: damaged marker', () => {
  it('sends when a damaged marker was last replaced before today, once', async () => {
    const { fetchMock, markerWrites } = track(
      startHarness({
        marker: { kind: 'unreadable', lastWrittenUtcDate: '2026-11-19' },
      }),
    );
    await jest.advanceTimersByTimeAsync(10 * HOUR);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The new marker replaces the damaged one.
    expect(markerWrites).toEqual(['2026-11-20']);
  });

  it('sends nothing today when a damaged marker was replaced today, then sends tomorrow', async () => {
    const { fetchMock, markerWrites } = track(
      startHarness({
        marker: { kind: 'unreadable', lastWrittenUtcDate: '2026-11-20' },
      }),
    );
    await jest.advanceTimersByTimeAsync(13 * HOUR); // 23:00 UTC
    expect(fetchMock).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(2 * HOUR);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(markerWrites).toEqual(['2026-11-21']);
  });

  it('heals a real damaged marker file last replaced yesterday, and a relaunch sends nothing more', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'optout-marker-'));
    try {
      const markerPath = path.join(dir, OPT_OUT_PING_MARKER_FILE_NAME);
      await writeFile(markerPath, 'garbage');
      const yesterday = new Date('2026-11-19T12:00:00.000Z');
      await utimes(markerPath, yesterday, yesterday);
      const launch = (): jest.Mock<
        ReturnType<OptOutFetch>,
        Parameters<OptOutFetch>
      > => {
        const policy = createUsageDataPolicy({ preferences: optedOut() });
        policy.setWorkspaceContext({ kind: 'personal' });
        const fetchMock = jest.fn<
          ReturnType<OptOutFetch>,
          Parameters<OptOutFetch>
        >(() => Promise.resolve({ status: 204 }));
        handles.push(
          startUsageAnalyticsOptOutPing({
            channel: 'stable',
            isPackaged: true,
            allowsAutomaticCall: true,
            policy,
            readStoredProductAnalytics: () => Promise.resolve('denied'),
            markerStore: createFileOptOutMarkerStore(() => dir),
            resolveEndpointUrl: () => BASE_URL,
            fetch: fetchMock,
            random: () => 0,
          }),
        );
        return fetchMock;
      };
      const first = launch();
      await advanceWithRealIo(10 * 60_000);
      expect(first).toHaveBeenCalledTimes(1);
      expect(JSON.parse(await readFile(markerPath, 'utf8'))).toEqual({
        version: 1,
        lastSentUtcDate: '2026-11-20',
      });
      await Promise.all(handles.map((handle) => handle.stop()));
      handles = [];
      const second = launch();
      await advanceWithRealIo(HOUR);
      expect(second).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('usage analytics opt-out ping: marker after a 2xx', () => {
  it('retries a failed marker write once, so a relaunch the same day sends nothing', async () => {
    let marker: MarkerRead = { kind: 'missing' };
    let writeAttempts = 0;
    const markerStore = {
      read: (): Promise<MarkerRead> => Promise.resolve(marker),
      write: (utcDate: string): Promise<void> => {
        writeAttempts += 1;
        if (writeAttempts === 1) return Promise.reject(new Error('EBUSY'));
        marker = { kind: 'present', utcDate };
        return Promise.resolve();
      },
    };
    const launch = (): jest.Mock<
      ReturnType<OptOutFetch>,
      Parameters<OptOutFetch>
    > => {
      const policy = createUsageDataPolicy({ preferences: optedOut() });
      policy.setWorkspaceContext({ kind: 'personal' });
      const fetchMock = jest.fn<
        ReturnType<OptOutFetch>,
        Parameters<OptOutFetch>
      >(() => Promise.resolve({ status: 204 }));
      handles.push(
        startUsageAnalyticsOptOutPing({
          channel: 'stable',
          isPackaged: true,
          allowsAutomaticCall: true,
          policy,
          readStoredProductAnalytics: () => Promise.resolve('denied'),
          markerStore,
          resolveEndpointUrl: () => BASE_URL,
          fetch: fetchMock,
          random: () => 0,
        }),
      );
      return fetchMock;
    };
    const first = launch();
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    expect(first).toHaveBeenCalledTimes(1);
    expect(writeAttempts).toBe(2);
    expect(marker).toEqual({ kind: 'present', utcDate: '2026-11-20' });
    await Promise.all(handles.map((handle) => handle.stop()));
    handles = [];
    const second = launch();
    await jest.advanceTimersByTimeAsync(10 * HOUR);
    expect(second).not.toHaveBeenCalled();
  });

  it('writes the marker for a 2xx that arrives after stop()', async () => {
    let respond: (response: { status: number }) => void = () => undefined;
    const { handle, markerWrites, fetchMock } = startHarness({
      fetchImpl: () =>
        new Promise((resolve) => {
          respond = resolve;
        }),
    });
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The app quits while the request is in flight.
    const stopped = handle.stop();
    respond({ status: 204 });
    await stopped;
    expect(markerWrites).toEqual(['2026-11-20']);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('settles stop() only once the marker write after a 2xx has finished', async () => {
    let releaseWrite: () => void = () => undefined;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const { handle, markerWrites, fetchMock } = startHarness({ writeGate });
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    // The request got its 2xx and the marker write is under way.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(markerWrites).toEqual([]);
    let settled = false;
    const stopped = handle.stop().then((): void => {
      settled = true;
    });
    await jest.advanceTimersByTimeAsync(5_000);
    expect(settled).toBe(false);
    releaseWrite();
    await stopped;
    expect(settled).toBe(true);
    expect(markerWrites).toEqual(['2026-11-20']);
  });

  it('settles stop() when the marker write fails, and again when called twice', async () => {
    const policy = createUsageDataPolicy({ preferences: optedOut() });
    policy.setWorkspaceContext({ kind: 'personal' });
    const handle = startUsageAnalyticsOptOutPing({
      channel: 'stable',
      isPackaged: true,
      allowsAutomaticCall: true,
      policy,
      readStoredProductAnalytics: () => Promise.resolve('denied'),
      markerStore: {
        read: () => Promise.resolve({ kind: 'missing' }),
        write: () => Promise.reject(new Error('disk full')),
      },
      resolveEndpointUrl: () => BASE_URL,
      fetch: () => Promise.resolve({ status: 204 }),
      random: () => 0,
    });
    handles.push(handle);
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    await expect(handle.stop()).resolves.toBeUndefined();
    await expect(handle.stop()).resolves.toBeUndefined();
  });

  describe('quit', () => {
    // `isQuitting` is main's `appIsQuitting`, set before any quit await.
    it('sends nothing once a quit begins while a send waits, and drops the timer', async () => {
      let quitting = false;
      const { fetchMock, markerWrites } = track(
        startHarness({ isQuitting: () => quitting }),
      );
      // The launch evaluation is done and a send is waiting.
      await jest.advanceTimersByTimeAsync(10_000);
      expect(jest.getTimerCount()).toBe(1);
      quitting = true;
      await jest.advanceTimersByTimeAsync(2 * DAY);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(markerWrites).toEqual([]);
      expect(jest.getTimerCount()).toBe(0);
    });

    it('halts at once on a policy change after a quit began', async () => {
      let quitting = false;
      const { policy, fetchMock } = track(
        startHarness({
          preferences: defaultUsageDataPreferences(),
          isQuitting: () => quitting,
        }),
      );
      await jest.advanceTimersByTimeAsync(10_000);
      expect(jest.getTimerCount()).toBe(1);
      quitting = true;
      policy.setPreferences(optedOut());
      // Synchronously: the policy change halted the sender, no new cycle.
      expect(jest.getTimerCount()).toBe(0);
      await jest.advanceTimersByTimeAsync(2 * DAY);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([
      ['the launch evaluation', 1],
      ['the send-time re-check, right before the request', 2],
    ])(
      'sends nothing when a quit begins during %s',
      async (_label, quitOnRead) => {
        let quitting = false;
        let reads = 0;
        const { fetchMock, markerWrites } = track(
          startHarness({
            random: 0.5,
            isQuitting: () => quitting,
            onStoredRead: () => {
              reads += 1;
              // Read 2 is the send-time re-check at 12:03.
              if (reads === quitOnRead) quitting = true;
            },
          }),
        );
        await jest.advanceTimersByTimeAsync(2 * DAY);
        expect(reads).toBe(quitOnRead);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(markerWrites).toEqual([]);
        expect(jest.getTimerCount()).toBe(0);
      },
    );

    it('sends nothing on a retry after a quit began during the failed request', async () => {
      let quitting = false;
      const { fetchMock, markerWrites } = track(
        startHarness({
          isQuitting: () => quitting,
          fetchImpl: () => {
            quitting = true;
            return Promise.resolve({ status: 503 });
          },
        }),
      );
      await jest.advanceTimersByTimeAsync(2 * DAY);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(markerWrites).toEqual([]);
      expect(jest.getTimerCount()).toBe(0);
    });

    it('lets a request sent before the quit finish and record its marker, and stop() waits for it', async () => {
      let quitting = false;
      let respond: (response: { status: number }) => void = () => undefined;
      const { handle, markerWrites, fetchMock } = startHarness({
        isQuitting: () => quitting,
        fetchImpl: () =>
          new Promise((resolve) => {
            respond = resolve;
          }),
      });
      await jest.advanceTimersByTimeAsync(10 * 60_000);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      quitting = true;
      let settled = false;
      const stopped = handle.stop().then((): void => {
        settled = true;
      });
      await jest.advanceTimersByTimeAsync(1_000);
      // `stop()` still waits for the request and the marker write.
      expect(settled).toBe(false);
      respond({ status: 204 });
      await stopped;
      expect(markerWrites).toEqual(['2026-11-20']);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);
    });

    it('never starts when the app is already quitting', async () => {
      const { fetchMock, markerWrites } = track(
        startHarness({ isQuitting: () => true }),
      );
      await jest.advanceTimersByTimeAsync(2 * DAY);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(markerWrites).toEqual([]);
      expect(jest.getTimerCount()).toBe(0);
    });

    it('does not start when a quit begins while the policy settles', async () => {
      let quitting = false;
      let settle: () => void = () => undefined;
      const policy = createUsageDataPolicy({ preferences: optedOut() });
      policy.setWorkspaceContext({ kind: 'personal' });
      const fetchMock = jest.fn<
        ReturnType<OptOutFetch>,
        Parameters<OptOutFetch>
      >(() => Promise.resolve({ status: 204 }));
      handles.push(
        startUsageAnalyticsOptOutPing({
          channel: 'stable',
          isPackaged: true,
          allowsAutomaticCall: true,
          policy: {
            getUsageDataPolicySnapshot: () =>
              policy.getUsageDataPolicySnapshot(),
            hasWorkspaceContext: () => policy.hasWorkspaceContext(),
            isOrganizationPolicyUnreadable: () =>
              policy.isOrganizationPolicyUnreadable(),
            subscribe: (listener) => policy.subscribe(listener),
            whenSettled: () =>
              new Promise<void>((resolve) => {
                settle = resolve;
              }),
          },
          readStoredProductAnalytics: () => Promise.resolve('denied'),
          isQuitting: () => quitting,
          markerStore: {
            read: () => Promise.resolve({ kind: 'missing' }),
            write: () => Promise.resolve(),
          },
          resolveEndpointUrl: () => BASE_URL,
          fetch: fetchMock,
          random: () => 0,
        }),
      );
      await jest.advanceTimersByTimeAsync(HOUR);
      quitting = true;
      settle();
      await jest.advanceTimersByTimeAsync(2 * DAY);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    });
  });

  it('settles stop() at once for a build that never pings', async () => {
    const { handle, fetchMock } = startHarness({ channel: null });
    await expect(handle.stop()).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('usage analytics opt-out ping: production wiring (host.ts)', () => {
  const globals = globalThis;
  let dir = '';
  let fetchSpy: jest.SpiedFunction<typeof fetch>;
  const readGlobal = (name: string): unknown => Reflect.get(globals, name);
  const saved = {
    flavor: readGlobal('__CANOPY_RELEASE_FLAVOR__'),
    identity: readGlobal('__CANOPY_BUILD_IDENTITY__'),
    e2e: readGlobal('__CANOPY_E2E__'),
    cloud: readGlobal('__CANOPY_CLOUD_BASE_URL__'),
    isPackaged: app.isPackaged,
  };

  const setCompiledBuild = (build: string | undefined): void => {
    Reflect.set(
      globals,
      '__CANOPY_BUILD_IDENTITY__',
      build === undefined ? undefined : { brandId: BRAND.id, build },
    );
  };
  const writeStoredPreferences = (
    usageData: Record<string, boolean>,
  ): Promise<void> =>
    writeFile(
      mockPreferencesFilePath,
      JSON.stringify({ version: 1, preferences: { usageData } }),
    );

  beforeEach(async () => {
    jest.useRealTimers();
    dir = await mkdtemp(path.join(tmpdir(), 'optout-host-'));
    mockPreferencesFilePath = path.join(dir, 'preferences.json');
    resetPreferencesLoadErrorForTests();
    // The saved choice agrees with the live policy below: off.
    await writeStoredPreferences({ productAnalytics: false });
    jest.useFakeTimers({ now: Date.parse(START) });
    jest.spyOn(app, 'getPath').mockReturnValue(dir);
    // The send goes at 12:00 UTC plus 2.5 minutes of jitter.
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
    Reflect.set(app, 'isPackaged', true);
    // A release build compiles in both: the bundler sets the identity from
    // CANOPY_RELEASE_FLAVOR and leaves it at `dev` when none is configured.
    Reflect.set(globals, '__CANOPY_RELEASE_FLAVOR__', 'rc');
    setCompiledBuild('rc');
    Reflect.set(globals, '__CANOPY_E2E__', false);
    // A trailing slash on the configured origin must not double the path.
    Reflect.set(
      globals,
      '__CANOPY_CLOUD_BASE_URL__',
      'https://cloud.example.test/',
    );
    resetCanopyCloudBaseUrlCacheForTest();
    __resetUsageDataPolicyForTests();
    initializeUsageDataPolicy(optedOut(), new Map());
    getUsageDataPolicy().setWorkspaceContext({ kind: 'personal' });
    fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));
  });

  afterEach(async () => {
    await Promise.all(handles.map((handle) => handle.stop()));
    handles = [];
    jest.restoreAllMocks();
    Reflect.set(app, 'isPackaged', saved.isPackaged);
    Reflect.set(globals, '__CANOPY_RELEASE_FLAVOR__', saved.flavor);
    Reflect.set(globals, '__CANOPY_BUILD_IDENTITY__', saved.identity);
    Reflect.set(globals, '__CANOPY_E2E__', saved.e2e);
    Reflect.set(globals, '__CANOPY_CLOUD_BASE_URL__', saved.cloud);
    resetCanopyCloudBaseUrlCacheForTest();
    __resetUsageDataPolicyForTests();
    resetPreferencesLoadErrorForTests();
    jest.useRealTimers();
    await rm(dir, { recursive: true, force: true });
  });

  it('posts the exact body to the cloud origin with a plain fetch and records the marker', async () => {
    handles.push(startProductionUsageAnalyticsOptOutPing(notQuitting));
    // 10:00 to 23:30 UTC: whatever time of day it picked, one send.
    await advanceWithRealIo(13.5 * HOUR, 30 * 60_000);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(url).toBe('https://cloud.example.test/api/usage-analytics/opt-out');
    expect(init).toMatchObject({
      method: 'POST',
      credentials: 'omit',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(
      UsageAnalyticsOptOutPingSchema.parse(
        JSON.parse(typeof init?.body === 'string' ? init.body : ''),
      ),
    ).toEqual({ reason: 'personal', channel: 'rc' });
    expect(
      JSON.parse(
        await readFile(path.join(dir, OPT_OUT_PING_MARKER_FILE_NAME), 'utf8'),
      ),
    ).toEqual({ version: 1, lastSentUtcDate: '2026-11-20' });
  });

  it.each([
    [
      'a development build',
      (): void => {
        Reflect.set(globals, '__CANOPY_RELEASE_FLAVOR__', 'dev');
        setCompiledBuild('dev');
      },
    ],
    [
      // The default local packaging path: no CANOPY_RELEASE_FLAVOR, so the
      // flavor define falls back to `stable` while the identity stays `dev`.
      'a packaged build without a release flavor',
      (): void => {
        Reflect.set(globals, '__CANOPY_RELEASE_FLAVOR__', 'stable');
        setCompiledBuild('dev');
      },
    ],
    [
      'a build with no compiled identity',
      (): void => {
        Reflect.set(globals, '__CANOPY_RELEASE_FLAVOR__', 'stable');
        setCompiledBuild(undefined);
      },
    ],
    [
      'a compiled build the ping has no channel for',
      (): void => {
        setCompiledBuild('beta');
      },
    ],
    [
      'an E2E build',
      (): void => {
        Reflect.set(globals, '__CANOPY_E2E__', true);
      },
    ],
    [
      'an unpackaged run',
      (): void => {
        Reflect.set(app, 'isPackaged', false);
      },
    ],
  ])('sends nothing from %s', async (_label, arrange) => {
    arrange();
    handles.push(startProductionUsageAnalyticsOptOutPing(notQuitting));
    // Nothing starts, so no file is ever read: plain fake time is enough.
    await jest.advanceTimersByTimeAsync(DAY);
    expect(jest.getTimerCount()).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each(['internal', 'rc', 'stable'] as const)(
    'labels the ping with the compiled %s build',
    async (build) => {
      setCompiledBuild(build);
      handles.push(startProductionUsageAnalyticsOptOutPing(notQuitting));
      await advanceWithRealIo(13.5 * HOUR, 30 * 60_000);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const init = fetchSpy.mock.calls[0]?.[1];
      expect(
        JSON.parse(typeof init?.body === 'string' ? init.body : ''),
      ).toEqual({ reason: 'personal', channel: build });
    },
  );

  // The live policy says off in each case below; the sender sends only when
  // the saved choice on disk agrees.
  it.each<[string, () => Promise<void>]>([
    [
      'the saved choice is on (a stale or fail-closed snapshot)',
      (): Promise<void> => writeStoredPreferences({ productAnalytics: true }),
    ],
    [
      'the preferences file is corrupt (a failed recovery)',
      (): Promise<void> => writeFile(mockPreferencesFilePath, '{ not json'),
    ],
    [
      'the preferences file is missing but revocations remain',
      async (): Promise<void> => {
        await rm(mockPreferencesFilePath);
        await writeFile(
          path.join(dir, 'preferences.json.usage-data-denied.json'),
          JSON.stringify(['productAnalytics']),
        );
      },
    ],
    [
      'the denial journal is damaged',
      (): Promise<void> =>
        writeFile(
          path.join(dir, 'preferences.json.usage-data-denied.json'),
          'garbage',
        ),
    ],
  ])('sends nothing when %s', async (_label, arrange) => {
    await arrange();
    handles.push(startProductionUsageAnalyticsOptOutPing(notQuitting));
    await advanceWithRealIo(DAY, 30 * 60_000);
    expect(fetchSpy).not.toHaveBeenCalled();
    await expect(
      readFile(path.join(dir, OPT_OUT_PING_MARKER_FILE_NAME), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  // The live policy below is an organization prohibition while the member's
  // own choice is on, as `org` needs.
  const useAcmeProhibition = (): void => {
    __resetUsageDataPolicyForTests();
    initializeUsageDataPolicy(defaultUsageDataPreferences(), acmeProhibits());
    getUsageDataPolicy().setWorkspaceContext({
      kind: 'organization',
      organizationId: ACME,
    });
  };

  it('sends an org prohibition when the saved choice on disk is on', async () => {
    useAcmeProhibition();
    await writeStoredPreferences({ productAnalytics: true });
    handles.push(startProductionUsageAnalyticsOptOutPing(notQuitting));
    await advanceWithRealIo(13.5 * HOUR, 30 * 60_000);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const init = fetchSpy.mock.calls[0]?.[1];
    expect(JSON.parse(typeof init?.body === 'string' ? init.body : '')).toEqual(
      { reason: 'org', channel: 'rc' },
    );
  });

  it.each<[string, boolean, () => void]>([
    ['a personal opt-out', false, (): void => undefined],
    ['an org prohibition', true, useAcmeProhibition],
  ])(
    'sends nothing for %s after a preferences recovery latched while the app runs, though the file reads again',
    async (_label, savedChoice, arrangePolicy) => {
      arrangePolicy();
      // A failed recovery after startup: the primary is gone and the
      // last-good copy can't be read. The live policy is never told, so it
      // keeps its stale answer, and reads serve defaults (on).
      const lastGoodPath = path.join(dir, 'preferences.last-good.json');
      await rm(mockPreferencesFilePath);
      await mkdir(lastGoodPath);
      jest.useRealTimers();
      await readPreferencesFile();
      expect(arePreferencesUnconfirmed()).toBe(true);
      // The file is back and agrees with the live policy; only the latch
      // stands between the stale snapshot and a ping.
      await rm(lastGoodPath, { recursive: true });
      await writeStoredPreferences({ productAnalytics: savedChoice });
      jest.useFakeTimers({ now: Date.parse(START) });
      handles.push(startProductionUsageAnalyticsOptOutPing(notQuitting));
      await advanceWithRealIo(DAY, 30 * 60_000);
      expect(fetchSpy).not.toHaveBeenCalled();
      await expect(
        readFile(path.join(dir, OPT_OUT_PING_MARKER_FILE_NAME), 'utf8'),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it('sends for a personal denial that only the readable journal holds', async () => {
    // The primary file is on; the write-ahead journal revokes the choice.
    await writeStoredPreferences({ productAnalytics: true });
    await writeFile(
      path.join(dir, 'preferences.json.usage-data-denied.json'),
      JSON.stringify(['productAnalytics']),
    );
    handles.push(startProductionUsageAnalyticsOptOutPing(notQuitting));
    await advanceWithRealIo(13.5 * HOUR, 30 * 60_000);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
  const rawPreferences = (usageData: unknown): Promise<void> =>
    writeFile(
      mockPreferencesFilePath,
      JSON.stringify({ version: 1, preferences: { usageData } }),
    );
  const journalFile = (): string =>
    path.join(dir, 'preferences.json.usage-data-denied.json');
  const sentBodies = (): unknown[] =>
    fetchSpy.mock.calls.map((call): unknown => {
      const body: unknown = JSON.parse(
        typeof call[1]?.body === 'string' ? call[1].body : '',
      );
      return body;
    });

  // A saved value that is present but not a boolean normalizes to the default
  // (on): not a proven choice, so nothing is sent for either reason.
  // The journal overlay must not repair a malformed section: a readable
  // journal that denies a key rewrites the section the repository parses
  // into a well-formed object, so the check is on the saved text. That holds
  // when the journal denies Usage analytics itself, too.
  describe.each<[string, readonly string[] | null]>([
    ['no journal', null],
    ['a readable journal denying an unrelated key', ['sessionReplay']],
    ['a readable journal denying Usage analytics', ['productAnalytics']],
  ])('with %s', (_journalLabel, journal) => {
    it.each<[string, unknown]>([
      ['a string', { productAnalytics: 'false' }],
      ['a number', { productAnalytics: 0 }],
      ['null', { productAnalytics: null }],
      ['an object', { productAnalytics: { value: false } }],
      ['a usage-data section that is not an object', 'off'],
      ['a usage-data section that is a number', 7],
      ['a usage-data section that is null', null],
    ])(
      'sends nothing for a personal opt-out or an org prohibition when the saved choice is %s',
      async (_label, usageData) => {
        await rawPreferences(usageData);
        if (journal !== null) {
          await writeFile(journalFile(), JSON.stringify(journal));
        }
        handles.push(startProductionUsageAnalyticsOptOutPing(notQuitting));
        await advanceWithRealIo(DAY, 30 * 60_000);
        useAcmeProhibition();
        handles.push(startProductionUsageAnalyticsOptOutPing(notQuitting));
        await advanceWithRealIo(DAY, 30 * 60_000);
        expect(fetchSpy).not.toHaveBeenCalled();
        await expect(
          readFile(path.join(dir, OPT_OUT_PING_MARKER_FILE_NAME), 'utf8'),
        ).rejects.toMatchObject({ code: 'ENOENT' });
      },
    );
  });

  it('treats an absent saved choice as the default (on), so an org prohibition sends', async () => {
    useAcmeProhibition();
    await rawPreferences({ sessionReplay: false });
    handles.push(startProductionUsageAnalyticsOptOutPing(notQuitting));
    await advanceWithRealIo(13.5 * HOUR, 30 * 60_000);
    expect(sentBodies()).toEqual([{ reason: 'org', channel: 'rc' }]);
  });

  it('treats a missing preferences file as a fresh install (on), so an org prohibition sends', async () => {
    useAcmeProhibition();
    await rm(mockPreferencesFilePath);
    handles.push(startProductionUsageAnalyticsOptOutPing(notQuitting));
    await advanceWithRealIo(13.5 * HOUR, 30 * 60_000);
    expect(sentBodies()).toEqual([{ reason: 'org', channel: 'rc' }]);
  });

  // The journal can't be read for a moment while the stored choice is read:
  // the document then shows every choice as denied. The journal state comes
  // from that same read, so it can't look like a saved denial afterwards.
  // The flapping journal is read once per check (the evaluation and the
  // send-time re-check), so a pattern that is unreadable on both makes a
  // guess-free reading look like a personal opt-out.
  it.each<[string, Array<'readable' | 'unreadable'>]>([
    [
      'unreadable on the evaluation and the send-time check, then readable',
      ['unreadable', 'unreadable'],
    ],
    ['readable then unreadable then readable', ['readable', 'unreadable']],
    [
      'unreadable, readable, unreadable',
      ['unreadable', 'readable', 'unreadable'],
    ],
  ])(
    'sends nothing when the journal reads %s while the saved choice is on',
    async (_label, pattern) => {
      // The live policy is stale (off); the saved choice on disk is on.
      await writeStoredPreferences({ productAnalytics: true });
      let journalReads = 0;
      mockReadFileFailure = (file): Error | null => {
        if (file !== journalFile()) return null;
        const status = pattern[journalReads] ?? 'readable';
        journalReads += 1;
        return status === 'unreadable'
          ? Object.assign(new Error('EIO'), { code: 'EIO' })
          : null;
      };
      try {
        handles.push(startProductionUsageAnalyticsOptOutPing(notQuitting));
        await advanceWithRealIo(2 * DAY, 30 * 60_000);
      } finally {
        mockReadFileFailure = null;
      }
      expect(journalReads).toBeGreaterThanOrEqual(pattern.length);
      expect(fetchSpy).not.toHaveBeenCalled();
      await expect(
        readFile(path.join(dir, OPT_OUT_PING_MARKER_FILE_NAME), 'utf8'),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it('sends for a personal denial once an unreadable journal is readable again', async () => {
    mockReadFileFailure = (file): Error | null =>
      file === journalFile()
        ? Object.assign(new Error('EIO'), { code: 'EIO' })
        : null;
    handles.push(startProductionUsageAnalyticsOptOutPing(notQuitting));
    await advanceWithRealIo(2 * HOUR, 30 * 60_000);
    expect(fetchSpy).not.toHaveBeenCalled();
    mockReadFileFailure = null;
    await advanceWithRealIo(13 * HOUR, 30 * 60_000);
    expect(sentBodies()).toEqual([{ reason: 'personal', channel: 'rc' }]);
  });

  it('never starts when the app is already quitting', async () => {
    handles.push(startProductionUsageAnalyticsOptOutPing(() => true));
    await jest.advanceTimersByTimeAsync(2 * DAY);
    expect(jest.getTimerCount()).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sends nothing more once a quit begins while the send waits', async () => {
    let quitting = false;
    handles.push(startProductionUsageAnalyticsOptOutPing(() => quitting));
    await advanceWithRealIo(10 * 60_000, 60_000);
    expect(jest.getTimerCount()).toBe(1);
    quitting = true;
    // The waiting timer fires into the quit flag and halts; nothing is read.
    await jest.advanceTimersByTimeAsync(2 * DAY);
    expect(jest.getTimerCount()).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sends nothing when a quit begins during the send-time re-read of the saved choice', async () => {
    let quitting = false;
    let quitSeen = false;
    let journalReads = 0;
    // Read 1 is the launch evaluation, read 2 the send-time re-check.
    mockReadFileFailure = (file): Error | null => {
      if (file === journalFile()) {
        journalReads += 1;
        if (journalReads === 2) quitting = true;
      }
      return null;
    };
    try {
      handles.push(
        startProductionUsageAnalyticsOptOutPing(() => {
          if (quitting) quitSeen = true;
          return quitting;
        }),
      );
      await advanceWithRealIo(2 * HOUR, 30 * 60_000);
      // The send is due at 12:03 UTC; its re-check runs into the quit.
      await jest.advanceTimersByTimeAsync(30 * 60_000);
      // Barrier without `stop()` (which would halt the sender itself): the
      // sender consults the quit flag after the re-read, or, were that check
      // missing, after the request and its marker write.
      await waitForRealIo(() => quitSeen);
    } finally {
      mockReadFileFailure = null;
    }
    expect(journalReads).toBe(2);
    expect(fetchSpy).not.toHaveBeenCalled();
    await expect(
      readFile(path.join(dir, OPT_OUT_PING_MARKER_FILE_NAME), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
