import { CLOUD_ATTACHMENT_MAX_BYTES } from '@canopy/protocol/cloud-attachments';
import { CanopyClientError } from '@canopy/core-client';
import type * as CoreClient from '@canopy/core-client';
import { KEYED_WRITE_OUTCOME_SHAPES } from '@canopy/app-state/core-cowork';
import {
  CoreChatAttachmentUploadParamsSchema,
  WorkerArtifactUploadWriteParamsSchema,
} from '@canopy/protocol/canopy-core';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { IPC_REMOTE_DISPOSITIONS } from '@canopy/desktop-shared/remote-control/channel-dispositions';
import { createInMemoryFramedPair } from '@canopy/core-transport';
import type { CoreRuntimeInitializeResult } from '@canopy/protocol/canopy-core';

/** A web core that advertises the upload, as main's real client needs. */
const UPLOAD_CORE_INITIALIZE: CoreRuntimeInitializeResult = {
  runtime: {
    runtimeId: 'runtime-1',
    hostId: 'host-1',
    authorityId: 'authority-1',
    profile: 'core+worker',
    daemonEpoch: 'epoch-1',
    protocolVersions: [1],
    state: 'ready',
    buildVersion: '0.0.0-test',
  },
  selectedProtocolVersion: 1,
  capabilities: {
    operations: ['core.chat.attachment.upload'],
    events: [],
    streams: [],
  },
  limits: {},
  authentication: { required: true, methods: [] },
};

/**
 * A web core main's real client talks to over an in-memory connection, so a
 * golden reaches the client's own validation (CAN-7196). It advertises
 * `operations` and answers each request with `answer`; `methods` lists them.
 */
async function serveUploadCore(
  operations: string[],
  answer: (method: string, params: unknown) => unknown,
): Promise<{ methods: string[]; done: Promise<void> }> {
  const { client, server } = await createInMemoryFramedPair();
  const methods: string[] = [];
  const initialize: CoreRuntimeInitializeResult = {
    ...UPLOAD_CORE_INITIALIZE,
    capabilities: { operations, events: [], streams: [] },
  };
  const done = (async (): Promise<void> => {
    for (;;) {
      const message = await server.receive().catch(() => null);
      if (!message) return;
      if (!('method' in message) || !('id' in message)) continue;
      methods.push(message.method);
      await server
        .send({
          jsonrpc: '2.0',
          id: message.id,
          result:
            message.method === 'core.runtime.initialize'
              ? initialize
              : answer(message.method, message.params),
        })
        .catch(() => undefined);
    }
  })();
  mockConnectWebCore.mockImplementationOnce(() => Promise.resolve(client));
  return { methods, done };
}

const mockIpcHandlers = new Map<
  string,
  (event: unknown, ...args: unknown[]) => Promise<unknown>
>();
const uploaded = (attachmentId = 'att-1'): unknown => ({
  attachment: {
    attachmentId,
    filename: 'notes.txt',
    mediaType: 'text/plain',
    size: 5,
    contentSha256: HELLO_SHA256,
    storageKind: 'blob',
    source: 'user',
  },
});
const HELLO_SHA256 =
  '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
const mockInstruction = jest.fn<Promise<unknown>, [string, unknown]>(() =>
  Promise.resolve(uploaded()),
);
const mockQuery = jest.fn<Promise<unknown>, [string, unknown]>();
const mockClientClose = jest.fn(() => Promise.resolve());
/** Each client's definitions, as `createCanopyClient` was given them. */
const mockClientDefinitions: {
  queries: Record<string, unknown>;
  instructions: Record<string, unknown>;
}[] = [];
const mockConnectWebCore = jest.fn<Promise<unknown>, unknown[]>(() =>
  Promise.resolve({}),
);
/** The connection of main's Files wake, the only one with the wake proof. */
const mockConnectFilesWake = jest.fn<Promise<unknown>, unknown[]>(() =>
  Promise.resolve({}),
);
/** The cloud chats the asking window follows on its relay session. */
const mockFollows = jest.fn<boolean, [unknown, string]>(() => false);
const mockBridgeFetch = jest.fn();
const mockState = { flagEnabled: true, realClient: false };

/** Each upload's lease calls, in order, beside its instruction calls. */
const mockCalls: string[] = [];
jest.mock('@canopy/core-client', () => ({
  ...jest.requireActual<object>('@canopy/core-client'),
  createCanopyClient: (options: {
    definitions: {
      queries: Record<string, unknown>;
      instructions: Record<string, unknown>;
    };
  }): Promise<unknown> => {
    mockClientDefinitions.push(options.definitions);
    // The real client, validation included, over the connection main opened.
    if (mockState.realClient)
      return jest
        .requireActual<typeof CoreClient>('@canopy/core-client')
        .createCanopyClient(options as never);
    return Promise.resolve({
      instruction: mockInstruction,
      query: mockQuery,
      close: mockClientClose,
    });
  },
  createCanopyClientLease: (): unknown => ({
    acquire: (): Promise<unknown> => {
      mockCalls.push('lease.acquire');
      return Promise.resolve({});
    },
    release: (): Promise<void> => {
      mockCalls.push('lease.release');
      return Promise.resolve();
    },
  }),
}));

jest.mock('../web-core-connection', () => ({
  ...jest.requireActual<object>('../web-core-connection'),
  connectWebCore: (...args: unknown[]): Promise<unknown> =>
    mockConnectWebCore(...args),
  connectWebCoreForFilesWake: (...args: unknown[]): Promise<unknown> =>
    mockConnectFilesWake(...args),
}));

jest.mock('../../ipc/register', () => ({
  registerIpcHandler: (
    channel: string,
    handler: (event: unknown, ...args: unknown[]) => Promise<unknown>,
  ): void => {
    mockIpcHandlers.set(channel, handler);
  },
}));

jest.mock('../../feature-flags', () => ({
  getFeatureFlagService: (): { isEnabled: () => boolean } => ({
    isEnabled: (): boolean => mockState.flagEnabled,
  }),
}));

jest.mock('../../lib/canopy-cloud-account-store', () => ({
  readCanopyCloudAccountWithStatus: (): Promise<unknown> =>
    Promise.resolve({ status: 'ok', entry: { account: { id: 'account-1' } } }),
}));

jest.mock('../settings-session', () => ({
  acquireSettingsBridgeSession: (): Promise<unknown> =>
    Promise.resolve({
      fetch: mockBridgeFetch,
      ensureReady: (): Promise<void> => Promise.resolve(),
    }),
}));

jest.mock('../../lib/main-process-logging', () => ({
  logMainProcessWarn: jest.fn(),
}));

import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { app, BrowserWindow, dialog } from 'electron';
import { registerCloudChatsHandlers } from '../../ipc/cloud-chats';
import { logMainProcessWarn } from '../../lib/main-process-logging';
import type { DesktopAppWindow } from '../../canopy-runtime/desktop-ipc-caller';
import type { RendererRelayEvent } from '../../canopy-runtime/renderer-relay/relay';
import { resolveTrustedRelaySurface } from '../../canopy-runtime/renderer-relay/trusted-surface';

const MAIN_URL = 'app://canopy/index.html';
const ADVISOR_URL = 'app://canopy/app-advisor.html';

function rendererEvent(id: number, url: string): RendererRelayEvent {
  const frame = { url, detached: false, isDestroyed: (): boolean => false };
  return {
    sender: {
      id,
      mainFrame: frame,
      getURL: () => url,
      isDestroyed: () => false,
      on: () => undefined,
      removeListener: () => undefined,
    },
    senderFrame: frame,
  };
}

const MAIN = rendererEvent(1, MAIN_URL);
const ADVISOR = rendererEvent(2, ADVISOR_URL);
const STRANGER = rendererEvent(3, MAIN_URL);
const windowOf = (event: RendererRelayEvent): DesktopAppWindow => ({
  isDestroyed: (): boolean => false,
  webContents: event.sender,
});

const targetOf = (key: unknown): unknown => ({
  key,
  workspaceId: 'ws-1',
  worktreeId: 'chat-1',
});

function upload(
  event: RendererRelayEvent,
  chatKey: unknown,
  file: unknown,
): Promise<unknown> {
  const handler = mockIpcHandlers.get(IPC_CHANNELS.cloudChatsUploadAttachment);
  if (handler === undefined) throw new Error('The upload is not registered.');
  // As `registerIpcHandler` does, a thrown refusal rejects the invoke.
  return Promise.resolve().then(() => handler(event, targetOf(chatKey), file));
}

const file = (
  bytes = new TextEncoder().encode('hello'),
): { name: string; mimeType: string; bytes: Uint8Array } => ({
  name: 'notes.txt',
  mimeType: 'text/plain',
  bytes,
});

describe('cloud chat attachment upload through main (CAN-5972, CAN-5988)', () => {
  beforeAll(() => {
    registerCloudChatsHandlers(
      (event) =>
        resolveTrustedRelaySurface(
          event,
          [
            { surface: 'main', window: windowOf(MAIN), url: MAIN_URL },
            {
              surface: 'app-advisor',
              window: windowOf(ADVISOR),
              url: ADVISOR_URL,
            },
          ],
          [],
        ),
      (event, chatId) => mockFollows(event, chatId),
    );
  });

  beforeEach(() => {
    mockBridgeFetch.mockClear();
    mockConnectWebCore.mockClear();
    mockInstruction.mockClear();
    mockInstruction.mockImplementation(() => {
      mockCalls.push('upload');
      return Promise.resolve(uploaded());
    });
    mockCalls.length = 0;
    mockState.flagEnabled = true;
  });

  it('upload refuses a local chat key and never sends bytes from the renderer to the network', async () => {
    // A local chat id, a key of no authority and a key that tries to leave
    // the attachment route are refused before any request.
    for (const chatKey of [
      'chat-local-1',
      'local:chat-1',
      'web-core:../../settings',
      'web-core:chat-1?x=1',
      42,
    ])
      await expect(upload(MAIN, chatKey, file())).resolves.toEqual({
        ok: false,
        reason: 'rejected',
      });
    // A path instead of bytes is refused: main never opens a renderer path.
    await expect(
      upload(MAIN, 'web-core:chat-1', {
        name: 'passwd',
        mimeType: 'text/plain',
        path: '/etc/passwd',
      }),
    ).resolves.toEqual({ ok: false, reason: 'rejected' });
    await expect(
      upload(
        MAIN,
        'web-core:chat-1',
        file(new Uint8Array(CLOUD_ATTACHMENT_MAX_BYTES + 1)),
      ),
    ).resolves.toEqual({ ok: false, reason: 'too_large' });
    // Only the main window may upload, by the trusted-surface check.
    await expect(upload(ADVISOR, 'web-core:chat-1', file())).rejects.toThrow(
      'Untrusted cloud chats sender.',
    );
    await expect(upload(STRANGER, 'web-core:chat-1', file())).rejects.toThrow(
      'Untrusted cloud chats sender.',
    );
    mockState.flagEnabled = false;
    await expect(upload(MAIN, 'web-core:chat-1', file())).resolves.toEqual({
      ok: false,
      reason: 'disabled',
    });
    // A target whose scope ids are not ids is refused too.
    mockState.flagEnabled = true;
    const handler = mockIpcHandlers.get(
      IPC_CHANNELS.cloudChatsUploadAttachment,
    );
    await expect(
      handler?.(
        MAIN,
        { key: 'web-core:chat-1', workspaceId: '../ws', worktreeId: 'chat-1' },
        file(),
      ),
    ).resolves.toEqual({ ok: false, reason: 'rejected' });
    expect(mockConnectWebCore).not.toHaveBeenCalled();
    expect(mockInstruction).not.toHaveBeenCalled();

    // A cloud key: main sends the bytes as core.chat.attachment.upload on its
    // own web core connection; nothing goes to the REST attachment route and
    // no credential comes from the renderer.
    mockState.flagEnabled = true;
    const bytes = new TextEncoder().encode('hello');
    await expect(upload(MAIN, 'web-core:chat-1', file(bytes))).resolves.toEqual(
      {
        ok: true,
        attachmentId: 'att-1',
        attachment: {
          attachmentId: 'att-1',
          filename: 'notes.txt',
          mediaType: 'text/plain',
          size: 5,
          contentSha256: HELLO_SHA256,
          storageKind: 'blob',
          source: 'user',
        },
      },
    );
    expect(mockConnectWebCore).toHaveBeenCalledTimes(1);
    expect(mockInstruction).toHaveBeenCalledTimes(1);
    const [method, params] = mockInstruction.mock.calls[0] ?? [];
    expect(method).toBe('core.chat.attachment.upload');
    const sent = CoreChatAttachmentUploadParamsSchema.parse(params);
    expect(sent).toEqual({
      scope: { workspaceId: 'ws-1', worktreeId: 'chat-1' },
      chatId: 'chat-1',
      filename: 'notes.txt',
      mediaType: 'text/plain',
      size: 5,
      contentSha256: HELLO_SHA256,
      data: 'aGVsbG8=',
      _meta: { idempotencyKey: sent._meta.idempotencyKey },
    });
    // A fresh key per upload, so a retry of the same file is a new upload.
    expect(sent._meta.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    // The connection holds a lease for the whole upload, so a slow upload
    // outlives the web core's unleased connection TTL.
    expect(mockCalls).toEqual(['lease.acquire', 'upload', 'lease.release']);
    expect(mockClientClose).toHaveBeenCalled();
    expect(mockBridgeFetch).not.toHaveBeenCalled();
  });

  it('maps the web core refusals to the reasons the composer shows', async () => {
    const refusal = (
      kind:
        | 'resource_exhausted'
        | 'unauthenticated'
        | 'not_found'
        | 'unavailable'
        | 'internal',
      code?: `core.${string}.${string}`,
    ): CanopyClientError =>
      new CanopyClientError({
        kind,
        message: 'refused',
        retry: { kind: 'never' },
        ...(code === undefined ? {} : { code }),
      });
    const cases: [CanopyClientError, Record<string, unknown>][] = [
      [
        refusal('resource_exhausted', 'core.chat.attachment.tooLarge'),
        { reason: 'too_large' },
      ],
      [refusal('unauthenticated'), { reason: 'unauthenticated' }],
      // A refusal keeps the web core's own words, which the composer shows
      // instead of a bare "Couldn't upload it" (CAN-6369).
      [refusal('not_found'), { reason: 'rejected', message: 'refused' }],
      // An error the client raised itself keeps the composer's own words.
      [refusal('internal'), { reason: 'rejected' }],
    ];
    for (const [error, expected] of cases) {
      mockInstruction.mockImplementationOnce(() => Promise.reject(error));
      await expect(upload(MAIN, 'web-core:chat-1', file())).resolves.toEqual({
        ok: false,
        ...expected,
      });
    }
  });

  // SWAN guardrail (CAN-7196): a sent upload reads as unknown only when its
  // answer never came: lost and never retried, or a same-key retry, as the
  // client's own deadline after dispatch arrives. Every error the web core
  // answered stays a refusal, and nothing is sent again on its own.
  it.each([
    ['lost, never retried', 'unavailable', { kind: 'never' }, 'unknown'],
    [
      'a same-key retry',
      'unavailable',
      { kind: 'same_idempotency_key' },
      'unknown',
    ],
    [
      "the client's own deadline after dispatch",
      'deadline_exceeded',
      { kind: 'same_idempotency_key' },
      'unknown',
    ],
    ['busy, same request', 'unavailable', { kind: 'same_request' }, 'offline'],
    [
      "the web core's own deadline",
      'deadline_exceeded',
      { kind: 'never' },
      'offline',
    ],
    ['cancelled', 'cancelled', { kind: 'never' }, 'offline'],
    [
      'a running rebuild, before any post',
      'unavailable',
      { kind: 'same_idempotency_key' },
      'offline',
      'cloud-worktree-recovery-in-progress',
    ],
    [
      'a same-key retry with a code that only starts like the rebuild’s',
      'unavailable',
      { kind: 'same_idempotency_key' },
      'unknown',
      'cloud-worktree-recovery-in-progress-later',
    ],
  ] as const)(
    'answers a sent upload read as %s (a %s error) with its pinned reason, sent once (CAN-7196)',
    async (...row) => {
      const [, kind, retry, reason] = row;
      const cloudCode = row.length === 5 ? row[4] : undefined;
      mockCalls.length = 0;
      mockInstruction.mockImplementationOnce(() => {
        mockCalls.push('upload');
        return Promise.reject(
          new CanopyClientError({
            kind,
            message: 'Answered.',
            retry,
            ...(cloudCode === undefined ? {} : { details: { cloudCode } }),
          }),
        );
      });
      await expect(upload(MAIN, 'web-core:chat-1', file())).resolves.toEqual({
        ok: false,
        reason,
      });
      expect(mockCalls.filter((call) => call === 'upload')).toHaveLength(1);
    },
  );

  // CAN-7196: main reads every shape of the shared table as app-state's
  // check does, each sent once.
  it.each(KEYED_WRITE_OUTCOME_SHAPES.map((row) => [row.name, row] as const))(
    'answers a sent upload answered as %s as the shared check reads it (CAN-7196)',
    async (_name, row) => {
      mockCalls.length = 0;
      mockInstruction.mockImplementationOnce(() => {
        mockCalls.push('upload');
        return Promise.reject(new CanopyClientError(row.payload));
      });
      const result = await upload(MAIN, 'web-core:chat-1', file());
      if (row.unknown) expect(result).toEqual({ ok: false, reason: 'unknown' });
      else expect(result).not.toEqual({ ok: false, reason: 'unknown' });
      expect(mockCalls.filter((call) => call === 'upload')).toHaveLength(1);
    },
  );

  it('reads an answer the client itself finds malformed as develop does, rejected: known debt for the S7c flip, sent once (CAN-7196)', async () => {
    const core = await serveUploadCore(
      ['core.chat.attachment.upload'],
      () => '<html>proxy page PAGE-BODY</html>',
    );
    jest.mocked(logMainProcessWarn).mockClear();
    mockState.realClient = true;
    try {
      // Core-client refuses the answer as `internal` with retry `never`
      // before main sees it, so it reads `rejected`, as on develop. Reading it
      // unknown needs a typed mark from the client: the S7c flip owns it.
      await expect(upload(MAIN, 'web-core:chat-1', file())).resolves.toEqual({
        ok: false,
        reason: 'rejected',
      });
    } finally {
      mockState.realClient = false;
    }
    await core.done;
    expect(core.methods).toEqual([
      'core.runtime.initialize',
      'core.chat.attachment.upload',
    ]);
    expect(jest.mocked(logMainProcessWarn)).not.toHaveBeenCalled();
  });

  it('keeps a busy upload slot rejected, as develop reads it, sent once (CAN-7196)', async () => {
    mockCalls.length = 0;
    mockInstruction.mockImplementationOnce(() => {
      mockCalls.push('upload');
      return Promise.reject(
        new CanopyClientError({
          kind: 'resource_exhausted',
          code: 'core.chat.attachment.busy',
          message: 'Three uploads are already running.',
          retry: { kind: 'same_idempotency_key', delayMs: 1000 },
        }),
      );
    });
    await expect(upload(MAIN, 'web-core:chat-1', file())).resolves.toEqual({
      ok: false,
      reason: 'rejected',
      message: 'Three uploads are already running.',
    });
    expect(mockCalls.filter((call) => call === 'upload')).toHaveLength(1);
  });

  it('answers an upload whose connection never opened as offline, never unknown (CAN-7196)', async () => {
    mockCalls.length = 0;
    mockConnectWebCore.mockImplementationOnce(() =>
      Promise.reject(
        new CanopyClientError({
          kind: 'unavailable',
          message: 'The connection closed.',
          retry: { kind: 'never' },
        }),
      ),
    );
    await expect(upload(MAIN, 'web-core:chat-1', file())).resolves.toEqual({
      ok: false,
      reason: 'offline',
    });
    expect(mockCalls).not.toContain('upload');
  });

  it("uploads beyond the web's three slots wait instead of failing", async () => {
    const releases: (() => void)[] = [];
    mockInstruction.mockImplementation(
      () =>
        new Promise<unknown>((resolve) => {
          releases.push(() => resolve(uploaded(`att-${releases.length}`)));
        }),
    );
    const flush = async (): Promise<void> => {
      for (let turn = 0; turn < 5; turn += 1)
        await new Promise<void>((resolve) => setImmediate(resolve));
    };
    const uploads = Array.from({ length: 5 }, () =>
      upload(MAIN, 'web-core:chat-1', file()),
    );
    await flush();
    expect(mockInstruction).toHaveBeenCalledTimes(3);

    releases[0]?.();
    await flush();
    expect(mockInstruction).toHaveBeenCalledTimes(4);
    releases[1]?.();
    releases[2]?.();
    await flush();
    expect(mockInstruction).toHaveBeenCalledTimes(5);
    releases[3]?.();
    releases[4]?.();

    const results = await Promise.all(uploads);
    for (const result of results)
      expect(result).toEqual(expect.objectContaining({ ok: true }));
  });
});

describe("a cloud chat's file download through main (CAN-6587)", () => {
  const ATTACHMENT = '00000000-0000-4000-8000-0000000000e1';
  const savePath = jest.spyOn(dialog, 'showSaveDialog');
  let dir = '';

  function download(
    event: RendererRelayEvent,
    chatKey: unknown,
    attachment: unknown,
  ): Promise<unknown> {
    const handler = mockIpcHandlers.get(IPC_CHANNELS.cloudChatsDownloadFile);
    if (handler === undefined)
      throw new Error('The download is not registered.');
    return Promise.resolve().then(() =>
      handler(event, targetOf(chatKey), attachment),
    );
  }

  const range = (
    content: string,
    offset: number,
    end: number,
    nextOffset: number | null,
  ): unknown => ({
    sizeBytes: content.length,
    offset,
    data: Buffer.from(content.slice(offset, end)).toString('base64'),
    nextOffset,
  });

  beforeAll(() => {
    Object.assign(BrowserWindow, { fromWebContents: (): null => null });
  });

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'cloud-attachment-download-'));
    mockQuery.mockReset();
    mockCalls.length = 0;
    mockState.flagEnabled = true;
    savePath.mockReset();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('saves the attachment range by range to the path the user chose, and nowhere else', async () => {
    const chosen = path.join(dir, 'chosen.txt');
    savePath.mockResolvedValue({ canceled: false, filePath: chosen });
    const content = 'hello, cloud';
    mockQuery
      .mockImplementationOnce(() => {
        mockCalls.push('read');
        return Promise.resolve(range(content, 0, 7, 7));
      })
      .mockImplementationOnce(() => {
        mockCalls.push('read');
        return Promise.resolve(range(content, 7, 12, null));
      });

    await expect(
      download(MAIN, 'web-core:chat-1', {
        kind: 'attachment',
        id: ATTACHMENT,
        filename: '../../.ssh/authorized_keys',
      }),
    ).resolves.toEqual({ ok: true });

    // The dialog suggests the name alone, in Downloads; the bytes go only to
    // the path the user picked.
    expect(savePath).toHaveBeenCalledWith({
      defaultPath: path.join(app.getPath('downloads'), 'authorized_keys'),
    });
    expect(await readFile(chosen, 'utf8')).toBe(content);
    expect(await readdir(dir)).toEqual(['chosen.txt']);
    expect(mockQuery.mock.calls).toEqual([
      [
        'worker.artifact.download.read',
        {
          artifactId: `attachment:${ATTACHMENT}`,
          scope: { chatId: 'chat-1' },
          offset: 0,
          length: 4 * 1024 * 1024,
        },
      ],
      ['worker.artifact.download.read', expect.objectContaining({ offset: 7 })],
    ]);
    // One leased connection for the whole download, whose client defines the
    // lease it acquires and the read.
    const definitions = mockClientDefinitions.at(-1);
    expect(Object.keys(definitions?.instructions ?? {})).toEqual(
      expect.arrayContaining([
        'core.client.lease.acquire',
        'core.client.lease.release',
      ]),
    );
    expect(Object.keys(definitions?.queries ?? {})).toContain(
      'worker.artifact.download.read',
    );
    expect(mockCalls).toEqual([
      'lease.acquire',
      'read',
      'read',
      'lease.release',
    ]);
  });

  it("reads a chat's deliverable in the chat's scope and a shared file in its project's", async () => {
    const content = 'date,max\n';
    for (const [kind, scope] of [
      ['deliverable', { chatId: 'chat-1' }],
      ['workspace-file', { workspaceId: 'ws-1' }],
    ] as const) {
      const chosen = path.join(dir, `${kind}.csv`);
      savePath.mockResolvedValue({ canceled: false, filePath: chosen });
      mockQuery.mockReset();
      mockQuery.mockImplementationOnce(() =>
        Promise.resolve(range(content, 0, content.length, null)),
      );
      await expect(
        download(MAIN, 'web-core:chat-1', {
          kind,
          id: ATTACHMENT,
          filename: 'ericeira_weather.csv',
        }),
      ).resolves.toEqual({ ok: true });
      expect(mockQuery.mock.calls[0]?.[1]).toMatchObject({
        artifactId: `${kind}:${ATTACHMENT}`,
        scope,
      });
      expect(await readFile(chosen, 'utf8')).toBe(content);
    }
  });

  it('refuses a local chat, a malformed file and a window other than main before asking for a path', async () => {
    for (const chatKey of ['chat-local-1', 'web-core:../../settings', 42])
      await expect(
        download(MAIN, chatKey, {
          kind: 'attachment',
          id: ATTACHMENT,
          filename: 'a',
        }),
      ).resolves.toEqual({ ok: false, reason: 'rejected' });
    for (const attachment of [
      { kind: 'attachment', id: '../files', filename: 'a' },
      {
        kind: 'attachment',
        id: ATTACHMENT,
        filename: 'a',
        path: '/etc/passwd',
      },
      { kind: 'attachment', id: ATTACHMENT },
    ])
      await expect(
        download(MAIN, 'web-core:chat-1', attachment),
      ).resolves.toEqual({ ok: false, reason: 'rejected' });
    // A target whose workspace or task id fails the shared validator.
    const handler = mockIpcHandlers.get(IPC_CHANNELS.cloudChatsDownloadFile);
    for (const target of [
      { key: 'web-core:chat-1', workspaceId: '../ws', worktreeId: 'chat-1' },
      { key: 'web-core:chat-1', workspaceId: 'ws-1', worktreeId: 'a/b' },
    ])
      await expect(
        handler?.(MAIN, target, {
          kind: 'attachment',
          id: ATTACHMENT,
          filename: 'a',
        }),
      ).resolves.toEqual({ ok: false, reason: 'rejected' });
    for (const event of [ADVISOR, STRANGER])
      await expect(
        download(event, 'web-core:chat-1', {
          kind: 'attachment',
          id: ATTACHMENT,
          filename: 'a',
        }),
      ).rejects.toThrow('Untrusted cloud chats sender.');
    mockState.flagEnabled = false;
    await expect(
      download(MAIN, 'web-core:chat-1', {
        kind: 'attachment',
        id: ATTACHMENT,
        filename: 'a',
      }),
    ).resolves.toEqual({ ok: false, reason: 'disabled' });
    expect(savePath).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('writes nothing when the user cancels, and removes a partial file when a read fails', async () => {
    savePath.mockResolvedValueOnce({ canceled: true, filePath: '' });
    await expect(
      download(MAIN, 'web-core:chat-1', {
        kind: 'attachment',
        id: ATTACHMENT,
        filename: 'a',
      }),
    ).resolves.toEqual({ ok: false, reason: 'canceled' });
    expect(mockQuery).not.toHaveBeenCalled();

    const chosen = path.join(dir, 'partial.txt');
    savePath.mockResolvedValue({ canceled: false, filePath: chosen });
    const content = 'hello, cloud';
    const cases: [unknown[], unknown][] = [
      // Another account's chat, or an attachment gone since it was listed.
      [
        [
          range(content, 0, 7, 7),
          new CanopyClientError({
            kind: 'not_found',
            message: 'The artifact was not found.',
            retry: { kind: 'never' },
          }),
        ],
        { ok: false, reason: 'not_found' },
      ],
      // A range that does not start where the last one ended.
      [
        [range(content, 0, 7, 7), range(content, 3, 12, null)],
        { ok: false, reason: 'rejected' },
      ],
      // A last range that leaves bytes missing.
      [[range(content, 0, 7, null)], { ok: false, reason: 'rejected' }],
      // The web core is down.
      [
        [
          new CanopyClientError({
            kind: 'unavailable',
            message: 'down',
            retry: { kind: 'same_request' },
          }),
        ],
        { ok: false, reason: 'offline' },
      ],
    ];
    for (const [answers, expected] of cases) {
      mockQuery.mockReset();
      for (const answer of answers)
        mockQuery.mockImplementationOnce(() =>
          answer instanceof Error
            ? Promise.reject(answer)
            : Promise.resolve(answer),
        );
      await expect(
        download(MAIN, 'web-core:chat-1', {
          kind: 'attachment',
          id: ATTACHMENT,
          filename: 'a',
        }),
      ).resolves.toEqual(expected);
      expect(await readdir(dir)).toEqual([]);
    }

    // A file the user chose to replace survives a failed read.
    const existing = path.join(dir, 'existing.txt');
    await writeFile(existing, 'keep me');
    savePath.mockResolvedValue({ canceled: false, filePath: existing });
    mockQuery.mockReset();
    mockQuery
      .mockImplementationOnce(() => Promise.resolve(range(content, 0, 7, 7)))
      .mockImplementationOnce(() =>
        Promise.reject(
          new CanopyClientError({
            kind: 'unavailable',
            message: 'down',
            retry: { kind: 'same_request' },
          }),
        ),
      );
    await expect(
      download(MAIN, 'web-core:chat-1', {
        kind: 'attachment',
        id: ATTACHMENT,
        filename: 'a',
      }),
    ).resolves.toEqual({ ok: false, reason: 'offline' });
    expect(await readFile(existing, 'utf8')).toBe('keep me');
  });
});

describe("main's Files wake of a sleeping cloud chat (CAN-6724)", () => {
  function wakeFiles(
    event: RendererRelayEvent,
    target: unknown = targetOf('web-core:chat-1'),
  ): Promise<unknown> {
    const handler = mockIpcHandlers.get(IPC_CHANNELS.cloudChatsWakeFiles);
    if (handler === undefined) throw new Error('The wake is not registered.');
    return Promise.resolve().then(() => handler(event, target));
  }

  const ROOTS = {
    roots: [
      { fileRootId: 'workspace', name: 'Workspace', kind: 'workspace-root' },
    ],
  };

  beforeEach(() => {
    mockQuery.mockReset();
    mockQuery.mockImplementation((method) =>
      Promise.resolve(
        method === 'worker.filesystem.roots.list' ? ROOTS : { entries: [] },
      ),
    );
    mockConnectWebCore.mockClear();
    mockConnectFilesWake.mockClear();
    mockFollows.mockReset();
    mockFollows.mockImplementation((_event, chatId) => chatId === 'chat-1');
    mockCalls.length = 0;
    mockState.flagEnabled = true;
  });

  it('wakes a chat the window has open with one waking listing, on the connection that carries the wake proof', async () => {
    await expect(wakeFiles(MAIN)).resolves.toEqual({ ok: true });
    expect(mockFollows).toHaveBeenCalledWith(MAIN, 'chat-1');
    expect(mockConnectFilesWake).toHaveBeenCalledTimes(1);
    expect(mockConnectWebCore).not.toHaveBeenCalled();
    expect(mockQuery.mock.calls).toEqual([
      ['worker.filesystem.roots.list', { scope: { chatId: 'chat-1' } }],
      [
        'worker.filesystem.directory.list',
        {
          scope: { chatId: 'chat-1' },
          fileRootId: 'workspace',
          relativePath: '',
          wake: true,
        },
      ],
    ]);
    expect(mockCalls).toEqual(['lease.acquire', 'lease.release']);
  });

  it("refuses a chat the window doesn't follow, a local or mismatched target, another window and a disabled flag, before any connection", async () => {
    await expect(wakeFiles(MAIN, targetOf('web-core:chat-2'))).resolves.toEqual(
      { ok: false, reason: 'rejected' },
    );
    mockFollows.mockImplementation(() => false);
    await expect(wakeFiles(MAIN)).resolves.toEqual({
      ok: false,
      reason: 'not_open',
    });
    mockFollows.mockImplementation((_event, chatId) => chatId === 'chat-1');
    for (const target of [
      targetOf('chat-local-1'),
      targetOf('web-core:../../settings'),
      { key: 'web-core:chat-1', workspaceId: '../ws', worktreeId: 'chat-1' },
      { ...Object(targetOf('web-core:chat-1')), wake: true },
      'web-core:chat-1',
    ])
      await expect(wakeFiles(MAIN, target)).resolves.toEqual({
        ok: false,
        reason: 'rejected',
      });
    for (const event of [ADVISOR, STRANGER])
      await expect(wakeFiles(event)).rejects.toThrow(
        'Untrusted cloud chats sender.',
      );
    mockState.flagEnabled = false;
    await expect(wakeFiles(MAIN)).resolves.toEqual({
      ok: false,
      reason: 'disabled',
    });
    expect(mockConnectFilesWake).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('a second wake of the same chat shares the running one, and a refusal falls back with its reason', async () => {
    let finish = (): void => undefined;
    mockQuery.mockImplementation((method) =>
      method === 'worker.filesystem.roots.list'
        ? Promise.resolve(ROOTS)
        : new Promise((resolve) => {
            finish = (): void => resolve({ entries: [] });
          }),
    );
    const first = wakeFiles(MAIN);
    const second = wakeFiles(MAIN);
    await new Promise((resolve) => setTimeout(resolve, 0));
    finish();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { ok: true },
      { ok: true },
    ]);
    expect(mockConnectFilesWake).toHaveBeenCalledTimes(1);

    // Still asleep after the wake, or a wake out of credit: refused.
    mockQuery.mockImplementation((method) =>
      method === 'worker.filesystem.roots.list'
        ? Promise.resolve(ROOTS)
        : Promise.reject(
            new CanopyClientError({
              kind: 'failed_precondition',
              message: 'The sandbox is asleep.',
              details: { reason: 'sandbox_sleeping' },
              retry: { kind: 'never' },
            }),
          ),
    );
    await expect(wakeFiles(MAIN)).resolves.toEqual({
      ok: false,
      reason: 'refused',
    });
    mockConnectFilesWake.mockImplementationOnce(() =>
      Promise.reject(
        new CanopyClientError({
          kind: 'unavailable',
          message: 'Offline.',
          retry: { kind: 'never' },
        }),
      ),
    );
    await expect(wakeFiles(MAIN)).resolves.toEqual({
      ok: false,
      reason: 'offline',
    });
  });
});

describe("a cloud project's workspace file upload through main (CAN-7008)", () => {
  const WORKSPACE = '11111111-1111-4111-8111-111111111111';
  const OPERATION = '22222222-2222-4222-8222-222222222222';
  const FILE_ID = '33333333-3333-4333-8333-333333333333';
  const VERSION = '44444444-4444-4444-8444-444444444444';
  const BYTES = new TextEncoder().encode('hello world!');
  const SHA256 =
    '7509e5bda0c762d2bac7f90d758b5b2263fa01ccbc542ab5e3df163be08e6ca9';
  const stored = {
    artifactId: `workspace-file:${FILE_ID}`,
    name: 'notes.txt',
    mediaType: 'text/plain',
    sizeBytes: BYTES.byteLength,
    sha256: SHA256,
    storageState: 'available',
    createdAt: '2026-11-17T12:00:00.000Z',
  };
  // Each upload gets its own operation id unless a case names one: main
  // remembers an id whose upload ended unknown (CAN-7196).
  const request = (extra: Record<string, unknown> = {}): unknown => ({
    workspaceId: WORKSPACE,
    operationId: crypto.randomUUID(),
    name: 'notes.txt',
    mimeType: 'text/plain',
    bytes: BYTES,
    ...extra,
  });

  function uploadFile(
    event: RendererRelayEvent,
    input: unknown,
  ): Promise<unknown> {
    const handler = mockIpcHandlers.get(
      IPC_CHANNELS.cloudChatsUploadWorkspaceFile,
    );
    if (handler === undefined) throw new Error('The upload is not registered.');
    return Promise.resolve().then(() => handler(event, input));
  }

  /** Answers the web core's upload instructions, four bytes a chunk. */
  function answering(
    fail: Partial<Record<string, () => Promise<unknown>>> = {},
  ): void {
    mockInstruction.mockImplementation((method, params) => {
      mockCalls.push(method);
      const failure = fail[method];
      if (failure !== undefined) return failure();
      if (method === 'worker.artifact.upload.open')
        return Promise.resolve({
          artifact: { ...stored, storageState: 'pending' },
          uploadId: 'upload-1',
          chunkSizeBytes: 4,
          nextOffset: 0,
        });
      if (method === 'worker.artifact.upload.write') {
        const { offset, data } =
          WorkerArtifactUploadWriteParamsSchema.parse(params);
        return Promise.resolve({
          nextOffset: offset + Buffer.from(data, 'base64').byteLength,
        });
      }
      return Promise.resolve(stored);
    });
  }

  beforeAll(() => {
    registerCloudChatsHandlers(
      (event) =>
        resolveTrustedRelaySurface(
          event,
          [
            { surface: 'main', window: windowOf(MAIN), url: MAIN_URL },
            {
              surface: 'app-advisor',
              window: windowOf(ADVISOR),
              url: ADVISOR_URL,
            },
          ],
          [],
        ),
      (event, chatId) => mockFollows(event, chatId),
    );
  });

  beforeEach(() => {
    mockConnectWebCore.mockReset();
    mockConnectWebCore.mockImplementation(() => Promise.resolve({}));
    mockInstruction.mockReset();
    mockCalls.length = 0;
    mockState.flagEnabled = true;
    answering();
  });

  it('adds the picked bytes in chunks under their operation id, on a leased connection of its own', async () => {
    await expect(
      uploadFile(MAIN, request({ operationId: OPERATION })),
    ).resolves.toEqual({
      ok: true,
      fileId: FILE_ID,
    });
    expect(mockCalls).toEqual([
      'lease.acquire',
      'worker.artifact.upload.open',
      'worker.artifact.upload.write',
      'worker.artifact.upload.write',
      'worker.artifact.upload.write',
      'worker.artifact.upload.commit',
      'lease.release',
    ]);
    expect(mockInstruction.mock.calls[0]).toEqual([
      'worker.artifact.upload.open',
      {
        artifactId: 'workspace-file:',
        scope: { workspaceId: WORKSPACE },
        name: 'notes.txt',
        mediaType: 'text/plain',
        sizeBytes: BYTES.byteLength,
        sha256: SHA256,
        _meta: { idempotencyKey: OPERATION },
      },
    ]);
    // A new version names its file and the version the person replaced.
    mockCalls.length = 0;
    await uploadFile(
      MAIN,
      request({ replaceFileId: FILE_ID, expectedVersionId: VERSION }),
    );
    expect(mockInstruction.mock.calls.at(-5)?.[1]).toMatchObject({
      artifactId: `workspace-file:${FILE_ID}`,
      expectedVersionId: VERSION,
    });
  });

  it('refuses another window, and bad ids, a path, size or type before any connection', async () => {
    for (const event of [ADVISOR, STRANGER])
      await expect(uploadFile(event, request())).rejects.toThrow(
        'Untrusted cloud chats sender.',
      );
    for (const input of [
      request({ workspaceId: '../settings' }),
      request({ operationId: 'not-a-uuid' }),
      request({ replaceFileId: FILE_ID }),
      request({ expectedVersionId: VERSION }),
      { ...(request() as object), bytes: undefined, path: '/etc/passwd' },
    ])
      await expect(uploadFile(MAIN, input)).resolves.toEqual({
        ok: false,
        reason: 'rejected',
      });
    await expect(
      uploadFile(
        MAIN,
        request({ bytes: new Uint8Array(CLOUD_ATTACHMENT_MAX_BYTES + 1) }),
      ),
    ).resolves.toEqual({ ok: false, reason: 'too_large' });
    await expect(
      uploadFile(MAIN, request({ mimeType: 'application/x-msdownload' })),
    ).resolves.toEqual({ ok: false, reason: 'unsupported_type' });
    mockState.flagEnabled = false;
    await expect(uploadFile(MAIN, request())).resolves.toEqual({
      ok: false,
      reason: 'disabled',
    });
    expect(mockConnectWebCore).not.toHaveBeenCalled();
    expect(mockInstruction).not.toHaveBeenCalled();
  });

  it('is blocked for remote control', () => {
    expect(IPC_REMOTE_DISPOSITIONS.cloudChatsUploadWorkspaceFile).toBe(
      'blocked',
    );
  });

  it('answers a lost reply after the open as an unknown outcome and never retries it', async () => {
    const lost = (): Promise<never> =>
      Promise.reject(
        new CanopyClientError({
          kind: 'unavailable',
          message: 'The connection closed.',
          retry: { kind: 'never' },
        }),
      );
    for (const method of [
      'worker.artifact.upload.open',
      'worker.artifact.upload.write',
      'worker.artifact.upload.commit',
    ]) {
      mockCalls.length = 0;
      answering({ [method]: lost });
      await expect(uploadFile(MAIN, request())).resolves.toEqual({
        ok: false,
        reason: 'unknown',
      });
      // Each instruction went once; the failed one was not sent again.
      expect(mockCalls.filter((call) => call === method)).toHaveLength(1);
      expect(mockCalls.at(-1)).toBe('lease.release');
    }
    // Nothing sent: a connection that never opened is offline, not unknown.
    mockCalls.length = 0;
    mockConnectWebCore.mockImplementation(() =>
      Promise.reject(new Error('ECONNREFUSED')),
    );
    await expect(uploadFile(MAIN, request())).resolves.toEqual({
      ok: false,
      reason: 'offline',
    });
    expect(mockCalls).toEqual([]);
  });

  it('keeps a refusal the web core answered typed, with its words', async () => {
    answering({
      'worker.artifact.upload.open': () =>
        Promise.reject(
          new CanopyClientError({
            kind: 'conflict',
            message: 'This file has a newer version.',
            retry: { kind: 'never' },
          }),
        ),
    });
    await expect(
      uploadFile(
        MAIN,
        request({ replaceFileId: FILE_ID, expectedVersionId: VERSION }),
      ),
    ).resolves.toEqual({
      ok: false,
      reason: 'conflict',
      message: 'This file has a newer version.',
    });
  });

  // CAN-7196: the commit stores the file and is inherent, not keyed, so a
  // lost reply to it (a closed connection, or the upload's own timeout) can't
  // be told from an answered transient one: it is unknown. A write before it
  // stored nothing, so a busy write keeps its kind.
  it.each([
    [
      'the connection closed',
      {
        kind: 'unavailable',
        message: 'The connection closed.',
        retry: { kind: 'same_request' },
      },
    ],
    [
      'the upload timed out',
      {
        kind: 'cancelled',
        message: 'The operation was cancelled.',
        retry: { kind: 'never' },
      },
    ],
    [
      'an internal error',
      {
        kind: 'internal',
        message: 'Something broke.',
        retry: { kind: 'never' },
      },
    ],
  ] as const)(
    'answers a commit whose reply was lost as %s as unknown, sent once (CAN-7196)',
    async (_case, payload) => {
      mockCalls.length = 0;
      answering({
        'worker.artifact.upload.commit': () =>
          Promise.reject(new CanopyClientError(payload)),
      });
      await expect(uploadFile(MAIN, request())).resolves.toEqual({
        ok: false,
        reason: 'unknown',
      });
      expect(
        mockCalls.filter((call) => call === 'worker.artifact.upload.commit'),
      ).toHaveLength(1);
    },
  );

  // CAN-7196 (SWAN 05:33): once the commit is sent, only a refusal proven to
  // come before the store keeps its kind; any other answer, a conflict
  // included, may follow a stored file and reads unknown.
  it.each([
    [
      'a conflict',
      {
        kind: 'conflict',
        code: 'worker.artifact.upload.revisionConflict',
        message: 'Conflict.',
        retry: { kind: 'never' },
      },
      { ok: false, reason: 'unknown' },
    ],
    [
      'too large',
      {
        kind: 'resource_exhausted',
        code: 'worker.artifact.upload.tooLarge',
        message: 'Too large.',
        retry: { kind: 'never' },
      },
      { ok: false, reason: 'unknown' },
    ],
    [
      'an unsupported type',
      {
        kind: 'invalid_argument',
        code: 'worker.artifact.upload.unsupportedType',
        message: 'Unsupported.',
        retry: { kind: 'never' },
      },
      { ok: false, reason: 'unknown' },
    ],
    [
      'a busy store',
      {
        kind: 'resource_exhausted',
        code: 'worker.artifact.upload.busy',
        message: 'Busy.',
        retry: { kind: 'same_request' },
      },
      { ok: false, reason: 'unknown' },
    ],
    [
      'an upload not found',
      {
        kind: 'not_found',
        code: 'worker.artifact.upload.notFound',
        message: 'Gone.',
        retry: { kind: 'never' },
      },
      { ok: false, reason: 'unknown' },
    ],
    [
      'a workspace that cannot take files',
      {
        kind: 'failed_precondition',
        code: 'worker.artifact.upload.invalidState',
        message: 'No.',
        retry: { kind: 'never' },
      },
      { ok: false, reason: 'unknown' },
    ],
    [
      'a digest mismatch',
      {
        kind: 'invalid_argument',
        code: 'worker.artifact.upload.digestMismatch',
        message: "The file's size or digest doesn't match its bytes.",
        retry: { kind: 'never' },
      },
      {
        ok: false,
        reason: 'rejected',
        message: "The file's size or digest doesn't match its bytes.",
      },
    ],
    [
      'workspace files switched off',
      {
        kind: 'capability_unavailable',
        message: 'Not served.',
        retry: { kind: 'never' },
      },
      { ok: false, reason: 'disabled' },
    ],
  ] as const)(
    'answers a commit refused as %s as only a refusal before the store may read, sent once (CAN-7196)',
    async (_case, payload, expected) => {
      mockCalls.length = 0;
      answering({
        'worker.artifact.upload.commit': () =>
          Promise.reject(new CanopyClientError(payload)),
      });
      await expect(uploadFile(MAIN, request())).resolves.toEqual(expected);
      expect(
        mockCalls.filter((call) => call === 'worker.artifact.upload.commit'),
      ).toHaveLength(1);
    },
  );

  it('never says a commit stored before its reply was lost was refused, when the re-commit is answered with a conflict (CAN-7196)', async () => {
    const operationId = '66666666-6666-4666-8666-666666666666';
    answering({
      'worker.artifact.upload.commit': () =>
        Promise.reject(
          new CanopyClientError({
            kind: 'unavailable',
            message: 'The connection closed.',
            retry: { kind: 'same_request' },
          }),
        ),
    });
    await expect(uploadFile(MAIN, request({ operationId }))).resolves.toEqual({
      ok: false,
      reason: 'unknown',
    });
    // Try again: the file is stored, so Core's write answers a conflict.
    answering({
      'worker.artifact.upload.commit': () =>
        Promise.reject(
          new CanopyClientError({
            kind: 'conflict',
            code: 'worker.artifact.upload.revisionConflict',
            message: 'This file has a newer version.',
            retry: { kind: 'never' },
          }),
        ),
    });
    const retried = await uploadFile(MAIN, request({ operationId }));
    expect(retried).toEqual({ ok: false, reason: 'unknown' });
    expect(retried).not.toMatchObject({ reason: 'conflict' });
  });

  it('keeps a busy write before the commit offline, since nothing was stored (CAN-7196)', async () => {
    mockCalls.length = 0;
    answering({
      'worker.artifact.upload.write': () =>
        Promise.reject(
          new CanopyClientError({
            kind: 'unavailable',
            message: 'Busy.',
            retry: { kind: 'same_request' },
          }),
        ),
    });
    await expect(uploadFile(MAIN, request())).resolves.toEqual({
      ok: false,
      reason: 'offline',
    });
    expect(mockCalls).not.toContain('worker.artifact.upload.commit');
  });

  // CAN-7196: Try again resends the same operation id. Once an attempt under
  // it ended unknown, the retry stays unknown however it is answered; a fresh
  // upload the web core refuses keeps its kind.
  it('keeps a refused retry of an unknown upload unknown, while a fresh refusal keeps its kind (CAN-7196)', async () => {
    // An answered refusal that asks for nothing again.
    const rateLimited = (): Promise<never> =>
      Promise.reject(
        new CanopyClientError({
          kind: 'conflict',
          message: 'Too many uploads.',
          retry: { kind: 'never' },
        }),
      );
    mockCalls.length = 0;
    answering({ 'worker.artifact.upload.open': rateLimited });
    await expect(
      uploadFile(
        MAIN,
        request({ operationId: '55555555-5555-4555-8555-555555555555' }),
      ),
    ).resolves.toEqual({
      ok: false,
      reason: 'conflict',
      message: 'Too many uploads.',
    });

    answering({
      'worker.artifact.upload.commit': () =>
        Promise.reject(
          new CanopyClientError({
            kind: 'unavailable',
            message: 'The connection closed.',
            retry: { kind: 'never' },
          }),
        ),
    });
    await expect(
      uploadFile(MAIN, request({ operationId: OPERATION })),
    ).resolves.toEqual({
      ok: false,
      reason: 'unknown',
    });
    mockCalls.length = 0;
    answering({ 'worker.artifact.upload.open': rateLimited });
    await expect(
      uploadFile(MAIN, request({ operationId: OPERATION })),
    ).resolves.toEqual({
      ok: false,
      reason: 'unknown',
    });
    expect(
      mockCalls.filter((call) => call === 'worker.artifact.upload.open'),
    ).toHaveLength(1);
  });

  it("reads a workspace file write whose answer the client finds malformed as rejected, without the client's own words, sent once (CAN-7196)", async () => {
    const core = await serveUploadCore(
      ['worker.artifact.upload.open', 'worker.artifact.upload.write'],
      (method) =>
        method === 'worker.artifact.upload.open'
          ? {
              artifact: { ...stored, storageState: 'pending' },
              uploadId: 'upload-1',
              chunkSizeBytes: 4,
              nextOffset: 0,
            }
          : '<html>proxy page PAGE-BODY</html>',
    );
    let result: unknown;
    mockState.realClient = true;
    try {
      result = await uploadFile(MAIN, request());
    } finally {
      mockState.realClient = false;
    }
    // No message, so the card shows its own "Couldn't save the workspace
    // file.", and the client's words appear nowhere in what main answers.
    expect(result).toEqual({ ok: false, reason: 'rejected' });
    expect(JSON.stringify(result)).not.toContain('returned an invalid result');
    await core.done;
    expect(
      core.methods.filter(
        (method) => method === 'worker.artifact.upload.write',
      ),
    ).toHaveLength(1);
  });

  it('reads a workspace file commit whose answer the client finds malformed as unknown, sent once (CAN-7196)', async () => {
    jest.mocked(logMainProcessWarn).mockClear();
    const core = await serveUploadCore(
      [
        'worker.artifact.upload.open',
        'worker.artifact.upload.write',
        'worker.artifact.upload.commit',
      ],
      (method, params) => {
        if (method === 'worker.artifact.upload.open')
          return {
            artifact: { ...stored, storageState: 'pending' },
            uploadId: 'upload-1',
            chunkSizeBytes: 4,
            nextOffset: 0,
          };
        if (method === 'worker.artifact.upload.write') {
          const { offset, data } =
            WorkerArtifactUploadWriteParamsSchema.parse(params);
          return {
            nextOffset: offset + Buffer.from(data, 'base64').byteLength,
          };
        }
        return '<html>proxy page PAGE-BODY</html>';
      },
    );
    mockState.realClient = true;
    try {
      // The client refuses the commit's answer as `internal` before main sees
      // it; once the commit is sent, only a refusal proven to come before the
      // store keeps its kind, so it reads unknown.
      await expect(uploadFile(MAIN, request())).resolves.toEqual({
        ok: false,
        reason: 'unknown',
      });
    } finally {
      mockState.realClient = false;
    }
    await core.done;
    expect(
      core.methods.filter(
        (method) => method === 'worker.artifact.upload.commit',
      ),
    ).toHaveLength(1);
    expect(core.methods[0]).toBe('core.runtime.initialize');
  });

  // CAN-7196: the keyed open reads every shape of the shared table as
  // app-state's check does, and goes once.
  it.each(KEYED_WRITE_OUTCOME_SHAPES.map((row) => [row.name, row] as const))(
    'answers a sent workspace file upload answered as %s as the shared check reads it (CAN-7196)',
    async (_name, row) => {
      mockCalls.length = 0;
      answering({
        'worker.artifact.upload.open': () =>
          Promise.reject(new CanopyClientError(row.payload)),
      });
      const result = await uploadFile(MAIN, request());
      if (row.unknown) expect(result).toEqual({ ok: false, reason: 'unknown' });
      else expect(result).not.toEqual({ ok: false, reason: 'unknown' });
      expect(
        mockCalls.filter((call) => call === 'worker.artifact.upload.open'),
      ).toHaveLength(1);
    },
  );

  // CAN-7196: once sent, `unknown` only when the answer never came: lost and
  // never retried, or a same-key retry, as the client's own deadline arrives.
  // A running rebuild's refusal (its exact code only) and every other error
  // the web core answered keep their kind, and nothing is sent again.
  it.each([
    ['lost, never retried', 'unavailable', { kind: 'never' }, {}, 'unknown'],
    [
      'a same-key retry',
      'unavailable',
      { kind: 'same_idempotency_key' },
      {},
      'unknown',
    ],
    [
      "the client's own deadline after dispatch",
      'deadline_exceeded',
      { kind: 'same_idempotency_key' },
      {},
      'unknown',
    ],
    [
      'a same-key retry with another code',
      'unavailable',
      { kind: 'same_idempotency_key' },
      { cloudCode: 'cloud-worktree-recovery-needed' },
      'unknown',
    ],
    [
      'a same-key retry with a code that only starts like the rebuild’s',
      'unavailable',
      { kind: 'same_idempotency_key' },
      { cloudCode: 'cloud-worktree-recovery-in-progress-later' },
      'unknown',
    ],
    [
      'a running rebuild, before any post',
      'unavailable',
      { kind: 'same_idempotency_key' },
      { cloudCode: 'cloud-worktree-recovery-in-progress' },
      'offline',
    ],
    [
      'busy, same request',
      'unavailable',
      { kind: 'same_request' },
      {},
      'offline',
    ],
    [
      "the core's own deadline",
      'deadline_exceeded',
      { kind: 'never' },
      {},
      'offline',
    ],
    ['cancelled by the core', 'cancelled', { kind: 'never' }, {}, 'offline'],
    ['internal', 'internal', { kind: 'never' }, {}, 'rejected'],
  ] as const)(
    'answers a sent workspace file upload answered as %s (a %s error) with its pinned reason, sent once (CAN-7196)',
    async (_case, kind, retry, details, reason) => {
      mockCalls.length = 0;
      answering({
        'worker.artifact.upload.open': () =>
          Promise.reject(
            new CanopyClientError({
              kind,
              message: 'The core said no.',
              retry,
              ...(Object.keys(details).length === 0 ? {} : { details }),
            }),
          ),
      });
      // An internal error can be the client's own, in developer words: it
      // never reaches the renderer, as an attachment upload's never does.
      await expect(uploadFile(MAIN, request())).resolves.toEqual({
        ok: false,
        reason,
      });
      expect(
        mockCalls.filter((call) => call === 'worker.artifact.upload.open'),
      ).toHaveLength(1);
    },
  );
});
