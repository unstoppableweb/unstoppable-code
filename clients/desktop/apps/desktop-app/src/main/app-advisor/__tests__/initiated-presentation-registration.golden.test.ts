// CAN-4174 migration golden: the Orchestrator window reaction as Electron
// main registers it. Its caller, what it subscribes to, that it settles
// `ready` once attached, that a stream end reopens it a bounded number of
// times without replaying history, that stop tears it down, and that its only
// effects are the window surface. A recording dispatcher drives the stream;
// the last case runs it on the real desktop runtime, which authorizes the
// caller as registered.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ChatStateChangedEvent,
  ChatStateCommandPort,
} from '@canopy/desktop-shared/types';
import { createDesktopRuntime } from '../../canopy-runtime/desktop-runtime';
import {
  INITIATED_PRESENTATION_CALLER,
  INITIATED_PRESENTATION_MAX_REOPENS,
  registerInitiatedPresentation,
  whenInitiatedPresentationReady,
} from '../initiated-presentation-registration';

const mockWarn = jest.fn();
jest.mock('../../lib/main-process-logging', () => ({
  ...jest.requireActual<object>('../../lib/main-process-logging'),
  logMainProcessWarn: (...args: unknown[]): void => {
    mockWarn(...args);
  },
}));

const BOT = { projectId: 'app-advisor', worktreeId: 'entry-1' };
const T0 = '2026-11-18T03:00:00.000Z';
const T1 = '2026-11-18T03:00:01.000Z';
const T2 = '2026-11-18T03:00:02.000Z';
const T3 = '2026-11-18T03:00:03.000Z';

type Frame =
  | { kind: 'item'; cursor: string; item: unknown }
  | { kind: 'end'; cursor: string; outcome: string; error: unknown };

interface FakeStream {
  params: unknown;
  options: unknown;
  listener: ((frame: Frame) => void) | undefined;
  closed: boolean;
  emit(frame: Frame): void;
}

function recordingDispatcher(): {
  dispatcher: Parameters<typeof registerInitiatedPresentation>[0]['dispatcher'];
  streams: FakeStream[];
  hold(): () => void;
  failNext(): void;
} {
  const streams: FakeStream[] = [];
  let gate: Promise<void> | undefined;
  let fail = false;
  const openStream = async (
    name: string,
    params: unknown,
    options: unknown,
  ): Promise<unknown> => {
    expect(name).toBe('core.chat.events');
    if (gate) await gate;
    if (fail) {
      fail = false;
      throw new Error('stream refused');
    }
    const stream: FakeStream = {
      params,
      options,
      listener: undefined,
      closed: false,
      emit(frame) {
        this.listener?.(frame);
      },
    };
    streams.push(stream);
    return {
      requestId: `request-${streams.length}`,
      openResult: {
        subscriptionId: `s-${streams.length}`,
        acceptedCursor: null,
      },
      frames: (async function* () {})(),
      onFrame: (listener: (frame: Frame) => void) => {
        stream.listener = listener;
        return () => {
          stream.listener = undefined;
        };
      },
      close: () => {
        stream.closed = true;
      },
    };
  };
  return {
    dispatcher: { openStream } as unknown as Parameters<
      typeof registerInitiatedPresentation
    >[0]['dispatcher'],
    streams,
    hold: () => {
      let release: () => void = () => undefined;
      gate = new Promise((resolve) => {
        release = resolve;
      });
      return () => {
        gate = undefined;
        release();
      };
    },
    failNext: () => {
      fail = true;
    },
  };
}

let itemCount = 0;
function initiatedItem(
  presentation: string,
  acceptedAt: string,
  scope: { projectId: string; worktreeId: string } = BOT,
): Frame {
  itemCount += 1;
  return {
    kind: 'item',
    cursor: `c-${itemCount}`,
    item: {
      ...scope,
      changes: [
        {
          type: 'chat.initiated',
          chatId: `chat-${itemCount}`,
          userMessageId: `input-${itemCount}`,
          origin: { kind: 'automation', sourceId: 'automation-1' },
          presentation,
          acceptedAt,
        },
      ],
    },
  };
}

const end = (outcome: 'completed' | 'cancelled' | 'error'): Frame => ({
  kind: 'end',
  cursor: 'c-end',
  outcome,
  error: null,
});

// Any thrown Error, typed for the logged fields it matches.
const anError: unknown = expect.any(Error);

const settle = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

function clock(...times: string[]): () => Date {
  let index = 0;
  return () => new Date(times[Math.min(index++, times.length - 1)] ?? T0);
}

beforeEach(() => {
  mockWarn.mockClear();
  itemCount = 0;
});

describe('the Orchestrator window reaction as Electron main registers it (CAN-4174)', () => {
  it('reads chat events as the legacy chat push does, under its own client instance and nothing more', async () => {
    expect(INITIATED_PRESENTATION_CALLER).toEqual({
      principalId: 'local-desktop-user',
      clientInstanceId: 'electron-main-initiated-presentation',
      authorityId: 'local-desktop',
      interfaceKind: 'desktop',
      grants: ['core.chat.read'],
    });
    expect(Object.isFrozen(INITIATED_PRESENTATION_CALLER)).toBe(true);
    // The push's declaration, field for field, apart from its client instance.
    const pushSource = readFileSync(
      join(__dirname, '..', '..', 'ipc', 'chat-state.ts'),
      'utf8',
    );
    const push = /const caller: CanopyCallerDescriptor = \{([^}]*)\};/.exec(
      pushSource,
    )?.[1];
    expect(push?.replace(/\s+/g, ' ').trim()).toBe(
      "principalId: 'local-desktop-user', clientInstanceId: 'electron-main-chat-push', authorityId: LOCAL_DESKTOP_AUTHORITY_ID, interfaceKind: 'desktop', grants: ['core.chat.read'],",
    );

    const fake = recordingDispatcher();
    const registration = registerInitiatedPresentation({
      dispatcher: fake.dispatcher,
      surfaces: { ensureAppAdvisorWindow: jest.fn() },
    });
    await registration.ready;
    expect(fake.streams).toHaveLength(1);
    expect(fake.streams[0]?.params).toEqual({
      scope: 'all',
      cursor: null,
      revision: 4,
    });
    expect(fake.streams[0]?.options).toEqual({
      caller: INITIATED_PRESENTATION_CALLER,
    });
    registration.stop();
  });

  it('settles ready only once the first subscription is attached, and the automations start waits on it', async () => {
    const fake = recordingDispatcher();
    const release = fake.hold();
    const registration = registerInitiatedPresentation({
      dispatcher: fake.dispatcher,
      surfaces: { ensureAppAdvisorWindow: jest.fn() },
    });
    let ready = false;
    void whenInitiatedPresentationReady().then(() => {
      ready = true;
    });
    await settle();
    expect(ready).toBe(false);
    release();
    await registration.ready;
    await settle();
    expect(ready).toBe(true);
    expect(fake.streams[0]?.listener).toBeDefined();
    registration.stop();

    // Electron main's startup can't run under Jest; pin the order instead:
    // the IPC handlers register the reaction, and the automations service
    // starts only after its ready.
    const mainSource = readFileSync(
      join(__dirname, '..', '..', 'index.ts'),
      'utf8',
    );
    const wait = '.then((): Promise<void> => whenInitiatedPresentationReady())';
    const start = '.then((): Promise<void> => getAutomationsService().start())';
    const waits = mainSource.indexOf(wait);
    const starts = mainSource.indexOf(start);
    expect(waits).toBeGreaterThan(-1);
    // The start is the very next step, and the only one.
    expect(mainSource.slice(waits + wait.length, starts).trim()).toBe('');
    expect(mainSource.indexOf('getAutomationsService().start()')).toBe(
      starts + '.then((): Promise<void> => '.length,
    );
    const ipcSource = readFileSync(
      join(__dirname, '..', '..', 'ipc', 'index.ts'),
      'utf8',
    );
    expect(ipcSource).toContain('registerInitiatedPresentation({');
    expect(ipcSource).toContain('stopInitiatedPresentation();');
  });

  it('reopens a stream that ended, at most three times in a row without an item, then logs once and stays down', async () => {
    const fake = recordingDispatcher();
    const registration = registerInitiatedPresentation({
      dispatcher: fake.dispatcher,
      surfaces: { ensureAppAdvisorWindow: jest.fn() },
    });
    await registration.ready;
    for (let index = 0; index < 10; index += 1) {
      fake.streams.at(-1)?.emit(end('error'));
      await settle();
    }
    expect(INITIATED_PRESENTATION_MAX_REOPENS).toBe(3);
    expect(fake.streams).toHaveLength(4);
    expect(fake.streams.every((stream) => stream.closed)).toBe(true);
    const stopped = mockWarn.mock.calls.filter(
      ([message]) =>
        message === 'The Orchestrator presentation stream stopped reopening',
    );
    expect(stopped).toEqual([
      [
        'The Orchestrator presentation stream stopped reopening',
        { reopens: 3 },
      ],
    ]);
    registration.stop();
  });

  it('counts a refused reopen against the same bound', async () => {
    const fake = recordingDispatcher();
    const registration = registerInitiatedPresentation({
      dispatcher: fake.dispatcher,
      surfaces: { ensureAppAdvisorWindow: jest.fn() },
    });
    await registration.ready;
    fake.failNext();
    fake.streams[0]?.emit(end('error'));
    for (let index = 0; index < 10; index += 1) {
      await settle();
      fake.streams.at(-1)?.emit(end('error'));
    }
    await settle();
    // The first stream, a refused open, then two more before the bound.
    expect(fake.streams).toHaveLength(3);
    expect(mockWarn).toHaveBeenCalledWith(
      'The Orchestrator presentation stream did not open',
      { error: anError },
    );
    registration.stop();
  });

  it('an item between ends resets the bound, and a cancelled end never reopens', async () => {
    const fake = recordingDispatcher();
    const registration = registerInitiatedPresentation({
      dispatcher: fake.dispatcher,
      surfaces: { ensureAppAdvisorWindow: jest.fn() },
    });
    await registration.ready;
    for (let index = 0; index < 5; index += 1) {
      fake.streams.at(-1)?.emit({
        kind: 'item',
        cursor: `c-${index}`,
        item: { ...BOT, changes: [] },
      });
      fake.streams.at(-1)?.emit(end('completed'));
      await settle();
    }
    expect(fake.streams).toHaveLength(6);
    fake.streams.at(-1)?.emit(end('cancelled'));
    await settle();
    expect(fake.streams).toHaveLength(6);
    registration.stop();
  });

  it('a reopened stream acts only on sends accepted after it attached again', async () => {
    const fake = recordingDispatcher();
    const ensure = jest.fn(() =>
      Promise.resolve({ open: true, focused: true }),
    );
    const registration = registerInitiatedPresentation({
      dispatcher: fake.dispatcher,
      surfaces: { ensureAppAdvisorWindow: ensure },
      now: clock(T0, T2),
    });
    await registration.ready;
    fake.streams[0]?.emit(end('error'));
    await settle();
    await settle();
    expect(fake.streams).toHaveLength(2);
    // Accepted while the first stream was down: history to the new one.
    fake.streams[1]?.emit(initiatedItem('focus', T1));
    fake.streams[1]?.emit(initiatedItem('focus', T3));
    await settle();
    expect(ensure.mock.calls).toEqual([[{ chatId: 'chat-2' }]]);
    registration.stop();
  });

  it('stop closes the stream and nothing reacts or reopens afterwards, even an open still in flight', async () => {
    const fake = recordingDispatcher();
    const ensure = jest.fn(() =>
      Promise.resolve({ open: true, focused: true }),
    );
    const registration = registerInitiatedPresentation({
      dispatcher: fake.dispatcher,
      surfaces: { ensureAppAdvisorWindow: ensure },
      now: clock(T0),
    });
    await registration.ready;
    const first = fake.streams[0];
    registration.stop();
    expect(first?.closed).toBe(true);
    expect(first?.listener).toBeUndefined();
    first?.emit(initiatedItem('focus', T1));
    first?.emit(end('error'));
    await settle();
    expect(ensure).not.toHaveBeenCalled();
    expect(fake.streams).toHaveLength(1);

    const held = recordingDispatcher();
    const release = held.hold();
    const pending = registerInitiatedPresentation({
      dispatcher: held.dispatcher,
      surfaces: { ensureAppAdvisorWindow: ensure },
    });
    pending.stop();
    release();
    await pending.ready;
    expect(held.streams[0]?.closed).toBe(true);
    expect(held.streams[0]?.listener).toBeUndefined();
  });

  it('its only effect is the window surface, and it logs ids and outcomes, never chat content', async () => {
    const fake = recordingDispatcher();
    const ensure = jest.fn((request?: { chatId?: string }) =>
      request?.chatId === 'chat-4'
        ? Promise.reject(new Error('no display'))
        : Promise.resolve({ open: true, focused: true }),
    );
    const registration = registerInitiatedPresentation({
      dispatcher: fake.dispatcher,
      surfaces: { ensureAppAdvisorWindow: ensure },
      now: clock(T0),
    });
    await registration.ready;
    const stream = fake.streams[0];
    stream?.emit(initiatedItem('focus', T1));
    stream?.emit(initiatedItem('open', T1));
    stream?.emit(initiatedItem('none', T1));
    stream?.emit(initiatedItem('focus', T1));
    stream?.emit(
      initiatedItem('focus', T1, {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
      }),
    );
    await settle();
    expect(ensure.mock.calls).toEqual([
      [{ chatId: 'chat-1' }],
      [undefined],
      [{ chatId: 'chat-4' }],
    ]);
    expect(mockWarn.mock.calls).toEqual([
      [
        'Opening the Orchestrator window for an automation failed',
        { presentation: 'focus', chatId: 'chat-4', error: anError },
      ],
    ]);
    registration.stop();
  });

  it('on the real desktop runtime, the registered caller is authorized and a live focus selects the chat once', async () => {
    const listeners = new Set<(event: ChatStateChangedEvent) => void>();
    const port: ChatStateCommandPort = {
      getState: jest.fn(),
      getTranscriptPage: jest.fn(),
      searchTranscript: jest.fn(),
      readToolOutput: jest.fn(),
      readVisual: jest.fn(),
      command: jest.fn(),
      getCommandReceipt: () => Promise.resolve(null),
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    };
    const runtime = createDesktopRuntime({ getChatStatePort: () => port });
    const ensure = jest.fn(() =>
      Promise.resolve({ open: true, focused: true }),
    );
    const registration = registerInitiatedPresentation({
      dispatcher: runtime,
      surfaces: { ensureAppAdvisorWindow: ensure },
      now: clock(T0),
    });
    try {
      await registration.ready;
      expect(mockWarn).not.toHaveBeenCalled();
      const event = {
        schemaVersion: 1,
        eventId: 'event-1',
        occurredAt: T1,
        ...BOT,
        baseRevision: 0,
        revision: 1,
        changes: [
          {
            type: 'chat.initiated',
            chatId: 'chat-live',
            userMessageId: 'input-live',
            origin: { kind: 'automation', sourceId: 'automation-1' },
            presentation: 'focus',
            acceptedAt: T1,
          },
        ],
      } as ChatStateChangedEvent;
      listeners.forEach((listener) => listener(event));
      await settle();
      expect(ensure.mock.calls).toEqual([[{ chatId: 'chat-live' }]]);
    } finally {
      registration.stop();
      await runtime.shutdown();
    }
  });
});
