import { CLOUD_ATTACHMENT_MAX_BYTES } from '@canopy/protocol/cloud-attachments';
import { CanopyClientError } from '@canopy/core-client';
import { CoreChatAttachmentUploadParamsSchema } from '@canopy/protocol/canopy-core';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';

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
const mockBridgeFetch = jest.fn();
const mockState = { flagEnabled: true };

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
    registerCloudChatsHandlers((event) =>
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
      [refusal('unavailable'), { reason: 'offline' }],
    ];
    for (const [error, expected] of cases) {
      mockInstruction.mockImplementationOnce(() => Promise.reject(error));
      await expect(upload(MAIN, 'web-core:chat-1', file())).resolves.toEqual({
        ok: false,
        ...expected,
      });
    }
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
