import { FileSaveConflictError } from '@canopy/app-core';
import { CoreCoworkRequestError } from '@canopy/app-state/core-cowork';
import type {
  CanopyCoreRelayApi,
  CanopyCoreRelayReply,
  CanopyCoreRelayRequest,
} from '../../../../../shared/canopy-core-relay';
import { parseWebCoreFilePath, webCoreScopeId } from '../../chat-authority';
import { createWebCoreFileOperations } from '../web-core-file-operations';
import { wholeUtf8Prefix } from '../saved-deliverables';
import {
  ambiguousDeliverableMessage,
  downloadCloudDeliverable,
} from '@/cloud-chats/cloud-file-download';
import { createWebCoreFileSource } from '../web-core-file-source';
import { workspaceFileSourceFor } from '../workspace-file-source';

const CHAT = 'chat-1';
const SCOPE = webCoreScopeId(CHAT);
const target = { projectId: 'project-1', worktreeId: SCOPE };

type Answer = (
  params: Record<string, unknown>,
) => CanopyCoreRelayReply | undefined;

function relayAnswering(answers: Record<string, Answer>): {
  relay: CanopyCoreRelayApi;
  requests: CanopyCoreRelayRequest[];
} {
  const requests: CanopyCoreRelayRequest[] = [];
  return {
    requests,
    relay: {
      invoke: (request): Promise<CanopyCoreRelayReply> => {
        requests.push(request);
        if (request.kind !== 'request')
          throw new Error(`unexpected ${request.kind}`);
        const reply = answers[request.method]?.(request.params);
        if (!reply) throw new Error(`unexpected ${request.method}`);
        return Promise.resolve(reply);
      },
    },
  };
}

const ok = (value: unknown): CanopyCoreRelayReply => ({ ok: true, value });

const ROOTS: Answer = () =>
  ok({
    roots: [
      { fileRootId: 'workspace', name: 'Workspace', kind: 'workspace-root' },
    ],
  });

function fileRead(overrides: Record<string, unknown> = {}): unknown {
  return {
    fileRootId: 'workspace',
    relativePath: 'src/index.ts',
    name: 'index.ts',
    contentKind: 'text',
    encoding: 'utf8',
    content: 'export const answer = 42;\n',
    sizeBytes: 26,
    returnedBytes: 26,
    truncated: false,
    modifiedAt: '2026-11-10T09:00:00.000Z',
    version: 'v1',
    ...overrides,
  };
}

describe('cloud chat file source over the web core relay (CAN-6175)', () => {
  it('maps roots, directories and the index onto the desktop shapes with round-tripping cloud paths', async () => {
    const { relay, requests } = relayAnswering({
      'worker.filesystem.roots.list': ROOTS,
      'worker.filesystem.directory.list': () =>
        ok({
          entries: [
            {
              name: 'index.ts',
              relativePath: 'src/index.ts',
              kind: 'file',
              isIgnored: false,
              isIndexExcluded: false,
              isSymlink: false,
              hasChildren: false,
            },
          ],
        }),
      'worker.filesystem.search': () =>
        ok({
          matches: [
            {
              fileRootId: 'workspace',
              path: 'src',
              kind: 'directory',
              name: 'src',
              isIgnored: false,
            },
            {
              fileRootId: 'workspace',
              path: 'src/index.ts',
              kind: 'file',
              name: 'index.ts',
              isIgnored: false,
            },
          ],
          nextCursor: null,
          truncated: true,
        }),
    });
    const source = createWebCoreFileSource(relay);

    const { roots } = await source.getFileTreeRoots(target);
    expect(roots).toEqual([
      {
        repoId: 'workspace',
        repoName: 'Workspace',
        rootKind: 'workspace-root',
        absolutePath: 'web-core:chat-1/workspace/',
      },
    ]);
    expect(roots[0] && 'imageSaveSupport' in roots[0]).toBe(false);

    const { entries } = await source.getFileTreeDirectory({
      ...target,
      repoId: 'workspace',
      relativeDir: 'src',
    });
    expect(entries[0]?.absolutePath).toBe(
      'web-core:chat-1/workspace/src/index.ts',
    );
    expect(parseWebCoreFilePath(entries[0]?.absolutePath ?? '')).toEqual({
      chatId: CHAT,
      fileRootId: 'workspace',
      relativePath: 'src/index.ts',
    });

    const index = await source.getFileIndex({
      ...target,
      purpose: 'file-explorer',
    });
    expect(index.repos).toEqual([
      expect.objectContaining({
        repoId: 'workspace',
        truncated: true,
        files: [
          {
            relativePath: 'src/index.ts',
            filename: 'index.ts',
            isIgnored: false,
            absolutePath: 'web-core:chat-1/workspace/src/index.ts',
          },
        ],
      }),
    ]);

    // Every call names the web core and the chat, never a workspace or host path.
    for (const request of requests) {
      expect(request).toMatchObject({
        kind: 'request',
        authority: 'web-core',
        params: { scope: { chatId: CHAT } },
      });
    }
    expect(
      requests.find(
        (r) => r.kind === 'request' && r.method === 'worker.filesystem.search',
      ),
    ).toMatchObject({
      params: {
        fileRootId: 'workspace',
        query: '',
        mode: 'name',
        purpose: 'file-explorer',
        limit: 25_000,
      },
    });
  });

  it('reads text, images and missing files as the local viewer does', async () => {
    const reads: Record<string, unknown>[] = [];
    const { relay } = relayAnswering({
      'worker.filesystem.file.read': (params) => {
        reads.push(params);
        if (params.relativePath === 'gone.ts')
          return {
            ok: false,
            error: {
              kind: 'not_found',
              code: 'worker.filesystem.file.notFound',
              message: 'No such file.',
              retry: { kind: 'never' },
            },
          };
        if (params.relativePath === 'logo.png')
          return ok(
            fileRead({
              relativePath: 'logo.png',
              name: 'logo.png',
              contentKind: 'image',
              encoding: 'base64',
              content: 'iVBORw0KGgo=',
              mediaType: 'image/png',
            }),
          );
        return ok(fileRead());
      },
    });
    const source = createWebCoreFileSource(relay);

    await expect(
      source.readFileContent({
        absolutePath: 'web-core:chat-1/workspace/src/index.ts',
      }),
    ).resolves.toEqual({
      kind: 'text',
      content: 'export const answer = 42;\n',
      filename: 'index.ts',
      sizeBytes: 26,
      truncated: false,
      modifiedAtMs: Date.parse('2026-11-10T09:00:00.000Z'),
    });
    await expect(
      source.readFileContent({
        absolutePath: 'web-core:chat-1/workspace/logo.png',
      }),
    ).resolves.toMatchObject({
      kind: 'image',
      content: 'data:image/png;base64,iVBORw0KGgo=',
    });
    await expect(
      source.readFileContent({
        absolutePath: 'web-core:chat-1/workspace/gone.ts',
      }),
    ).resolves.toMatchObject({ kind: 'missing', filename: 'gone.ts' });
    expect(reads[0]).toEqual({
      scope: { chatId: CHAT },
      fileRootId: 'workspace',
      relativePath: 'src/index.ts',
      maxBytes: 5 * 1024 * 1024,
    });
  });

  it('keeps a sleeping sandbox as itself and never wakes it', async () => {
    const sleeping: CanopyCoreRelayReply = {
      ok: false,
      error: {
        kind: 'failed_precondition',
        message: 'The sandbox is asleep.',
        details: { reason: 'sandbox_sleeping' },
        retry: { kind: 'never' },
      },
    };
    const { relay, requests } = relayAnswering({
      'worker.filesystem.roots.list': () => sleeping,
    });
    const failure = await createWebCoreFileSource(relay)
      .getFileTreeRoots(target)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CoreCoworkRequestError);
    expect(
      failure instanceof CoreCoworkRequestError && failure.payload,
    ).toMatchObject({
      kind: 'failed_precondition',
      details: { reason: 'sandbox_sleeping' },
    });
    expect(requests).toHaveLength(1);

    // A folder listing and a search keep the web core's whole reason, which
    // the explorer reads to say the project is asleep (CAN-6543).
    type Namespace = 'worker.filesystem.directory' | 'worker.filesystem.search';
    const asleepError = (
      namespace: Namespace,
    ): Extract<CanopyCoreRelayReply, { ok: false }>['error'] => ({
      kind: 'failed_precondition',
      message: 'The sandbox is asleep.',
      code: `${namespace}.invalidState`,
      details: {
        reason: 'sandbox_sleeping',
        wakeAllowed: true,
        cloudCode: 'SANDBOX_NOT_READY',
      },
      retry: { kind: 'after_refresh', resource: namespace },
    });
    const asleep = (namespace: Namespace): CanopyCoreRelayReply => ({
      ok: false,
      error: asleepError(namespace),
    });
    const listing = relayAnswering({
      'worker.filesystem.roots.list': ROOTS,
      'worker.filesystem.directory.list': () =>
        asleep('worker.filesystem.directory'),
      'worker.filesystem.search': () => asleep('worker.filesystem.search'),
    });
    const source = createWebCoreFileSource(listing.relay);
    for (const [read, namespace] of [
      [
        (): Promise<unknown> =>
          source.getFileTreeDirectory({
            ...target,
            repoId: 'workspace',
            relativeDir: '',
          }),
        'worker.filesystem.directory',
      ],
      [
        (): Promise<unknown> =>
          source.getFileIndex({ ...target, purpose: 'file-explorer' }),
        'worker.filesystem.search',
      ],
    ] as const) {
      const refused = await read().catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(CoreCoworkRequestError);
      expect(
        refused instanceof CoreCoworkRequestError && refused.payload,
      ).toEqual(asleepError(namespace));
    }
    expect(
      listing.requests.filter(
        (request) =>
          request.kind === 'request' &&
          typeof request.params === 'object' &&
          request.params !== null &&
          'wake' in request.params,
      ),
    ).toEqual([]);
  });

  it('refuses a local scope or host path without calling the relay', async () => {
    const { relay, requests } = relayAnswering({});
    const source = createWebCoreFileSource(relay);
    await expect(
      source.getFileTreeRoots({ projectId: 'project-1', worktreeId: 'wt-1' }),
    ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });
    await expect(
      source.readFileContent({ absolutePath: '/Users/someone/repo/a.ts' }),
    ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });
    expect(requests).toHaveLength(0);
  });

  it('routes a cloud scope to the relay and a local scope to window.api', async () => {
    const api = {
      getFileTreeRoots: jest.fn(() => Promise.resolve({ roots: [] })),
    };
    const { relay, requests } = relayAnswering({
      'worker.filesystem.roots.list': ROOTS,
    });
    // The source reads `window` at call time; this suite runs in Node.
    Object.assign(globalThis, { window: { api, canopyCore: relay } });

    await workspaceFileSourceFor(SCOPE).getFileTreeRoots(target);
    expect(requests).toHaveLength(1);
    expect(api.getFileTreeRoots).not.toHaveBeenCalled();

    const local = { projectId: 'project-1', worktreeId: 'wt-1' };
    await workspaceFileSourceFor('wt-1').getFileTreeRoots(local);
    expect(api.getFileTreeRoots).toHaveBeenCalledWith(local);
    expect(requests).toHaveLength(1);
    Reflect.deleteProperty(globalThis, 'window');
  });
});

describe('shared viewer file queries for a cloud chat (CAN-6175)', () => {
  it('answers file.roots, file.read and file.resolveLink in the client shapes', async () => {
    const { relay, requests } = relayAnswering({
      'worker.filesystem.roots.list': ROOTS,
      'worker.filesystem.file.read': (params) =>
        ok(
          params.relativePath === 'logo.png'
            ? fileRead({
                relativePath: 'logo.png',
                name: 'logo.png',
                contentKind: 'image',
                encoding: 'base64',
                content: 'iVBORw0KGgo=',
                mediaType: 'image/png',
              })
            : fileRead(),
        ),
      'worker.filesystem.link.resolve': () =>
        ok({
          fileRootId: 'workspace',
          relativePath: 'src/index.ts',
          name: 'index.ts',
          kind: 'file',
        }),
    });
    const queries = createWebCoreFileOperations(relay);

    await expect(queries['file.roots'](target)).resolves.toEqual([
      {
        workspaceLocalId: 'project-1',
        worktreeLocalId: SCOPE,
        fileRootLocalId: 'workspace',
        label: 'Workspace',
        rootKind: 'workspace-root',
        absolutePath: 'web-core:chat-1/workspace/',
      },
    ]);
    await expect(
      queries['file.read']({
        ...target,
        fileRootLocalId: 'workspace',
        relativePath: 'src/index.ts',
      }),
    ).resolves.toEqual({
      workspaceLocalId: 'project-1',
      worktreeLocalId: SCOPE,
      fileRootLocalId: 'workspace',
      path: 'src/index.ts',
      content: 'export const answer = 42;\n',
      language: 'ts',
      size: 26,
      version: 'v1',
      truncated: false,
      modifiedAt: '2026-11-10T09:00:00.000Z',
    });
    await expect(
      queries['file.read']({
        ...target,
        fileRootLocalId: 'workspace',
        relativePath: 'logo.png',
      }),
    ).rejects.toThrow('Binary files cannot be read.');
    await expect(
      queries['file.resolveLink']({ ...target, href: 'src/index.ts' }),
    ).resolves.toEqual({
      fileRootLocalId: 'workspace',
      relativePath: 'src/index.ts',
    });
    expect(
      requests.find(
        (r) =>
          r.kind === 'request' && r.method === 'worker.filesystem.link.resolve',
      ),
    ).toMatchObject({
      authority: 'web-core',
      params: {
        scope: { chatId: CHAT },
        mode: 'transcript',
        href: 'src/index.ts',
      },
    });
  });
});

describe('cloud chat file writes over the web core relay (CAN-6175)', () => {
  const keys = (): (() => string) => {
    let next = 0;
    return () => `key-${(next += 1)}`;
  };

  it('maps explorer mutations onto the web core writes, one idempotency key per action', async () => {
    const { relay, requests } = relayAnswering({
      'worker.filesystem.file.write': () =>
        ok({
          relativePath: 'notes.md',
          sizeBytes: 0,
          sha256: 'a'.repeat(64),
          version: 'v1',
          modifiedAt: '2026-11-10T09:00:00.000Z',
        }),
      'worker.filesystem.directory.create': () =>
        ok({
          fileRootId: 'workspace',
          relativePath: 'docs',
          createdParentPaths: [],
          version: 'v1',
        }),
      'worker.filesystem.entry.move': () =>
        ok({
          fromRelativePath: 'notes.md',
          toRelativePath: 'docs/notes.md',
          version: 'v2',
          sourceFileRootId: 'workspace',
          destinationFileRootId: 'workspace',
          requestedToRelativePath: 'docs/notes.md',
          conflictPolicy: 'error',
        }),
      'worker.filesystem.entry.delete': () =>
        ok({ deleted: true, deletedEntryCount: 1, disposition: 'permanent' }),
    });
    const source = createWebCoreFileSource(relay, keys());
    const at = (
      relativePath: string,
    ): { repoId: string; relativePath: string } => ({
      repoId: 'workspace',
      relativePath,
    });

    await source.mutateFileTree({
      ...target,
      operation: 'create-file',
      target: at('notes.md'),
    });
    await source.mutateFileTree({
      ...target,
      operation: 'create-directory',
      target: at('docs'),
    });
    await source.mutateFileTree({
      ...target,
      operation: 'move',
      source: at('notes.md'),
      target: at('docs/notes.md'),
      conflict: 'error',
    });
    await expect(
      source.mutateFileTree({
        ...target,
        operation: 'delete',
        target: at('docs'),
        useTrash: false,
      }),
    ).resolves.toEqual({ operation: 'delete', target: at('docs') });

    expect(
      requests.map((r) => (r.kind === 'request' ? [r.method, r.params] : [])),
    ).toEqual([
      [
        'worker.filesystem.file.write',
        {
          scope: { chatId: CHAT },
          fileRootId: 'workspace',
          relativePath: 'notes.md',
          content: '',
          createOnly: true,
          _meta: { idempotencyKey: 'key-1' },
        },
      ],
      [
        'worker.filesystem.directory.create',
        {
          scope: { chatId: CHAT },
          fileRootId: 'workspace',
          relativePath: 'docs',
          createParents: false,
          expectedAbsent: true,
          _meta: { idempotencyKey: 'key-2' },
        },
      ],
      [
        'worker.filesystem.entry.move',
        {
          scope: { chatId: CHAT },
          sourceFileRootId: 'workspace',
          destinationFileRootId: 'workspace',
          fromRelativePath: 'notes.md',
          toRelativePath: 'docs/notes.md',
          expectedSourceVersion: null,
          expectedDestinationAbsent: true,
          conflictPolicy: 'error',
          _meta: { idempotencyKey: 'key-3' },
        },
      ],
      [
        'worker.filesystem.entry.delete',
        {
          scope: { chatId: CHAT },
          fileRootId: 'workspace',
          relativePath: 'docs',
          expectedVersion: null,
          recursive: true,
          disposition: 'permanent',
          _meta: { idempotencyKey: 'key-4' },
        },
      ],
    ]);
    for (const r of requests)
      expect(r).toMatchObject({ authority: 'web-core' });
  });

  it('names a move refused because its destination exists (CAN-6282)', async () => {
    const { relay, requests } = relayAnswering({
      'worker.filesystem.entry.move': () => ({
        ok: false,
        error: {
          kind: 'already_exists',
          message: 'The destination already exists.',
          retry: { kind: 'never' },
        },
      }),
    });
    const source = createWebCoreFileSource(relay, keys());
    await expect(
      source.mutateFileTree({
        ...target,
        operation: 'move',
        source: { repoId: 'workspace', relativePath: 'notes.md' },
        target: { repoId: 'workspace', relativePath: 'docs/notes.md' },
        conflict: 'error',
      }),
    ).rejects.toMatchObject({
      payload: { kind: 'already_exists' },
      message: 'A file or folder named notes.md already exists there.',
    });
    expect(
      requests.map((r) => (r.kind === 'request' ? r.method : r.kind)),
    ).toEqual(['worker.filesystem.entry.move']);
  });

  it('refuses copy and a trash delete before the relay', async () => {
    const { relay, requests } = relayAnswering({});
    const source = createWebCoreFileSource(relay, keys());
    const ref = { repoId: 'workspace', relativePath: 'a.ts' };
    await expect(
      source.mutateFileTree({
        ...target,
        operation: 'copy',
        source: ref,
        target: ref,
        conflict: 'increment',
      }),
    ).rejects.toMatchObject({ payload: { kind: 'capability_unavailable' } });
    await expect(
      source.mutateFileTree({
        ...target,
        operation: 'delete',
        target: ref,
        useTrash: true,
      }),
    ).rejects.toMatchObject({ payload: { kind: 'capability_unavailable' } });
    expect(requests).toHaveLength(0);
  });

  it('saves with the version read and turns a stale version into a save conflict', async () => {
    let stale = false;
    const { relay, requests } = relayAnswering({
      'worker.filesystem.file.write': () =>
        stale
          ? {
              ok: false,
              error: {
                kind: 'failed_precondition',
                code: 'worker.filesystem.file.revisionConflict',
                message: 'The file changed.',
                retry: { kind: 'never' },
              },
            }
          : ok({
              relativePath: 'a.ts',
              sizeBytes: 3,
              sha256: 'b'.repeat(64),
              version: 'v2',
              modifiedAt: '2026-11-10T10:00:00.000Z',
            }),
    });
    const operations = createWebCoreFileOperations(relay, keys());
    const save = {
      ...target,
      fileRootLocalId: 'workspace',
      relativePath: 'a.ts',
      content: 'abc',
    };

    await expect(
      operations['file.save']({ ...save, expectedVersion: 'v1' }),
    ).resolves.toMatchObject({
      version: 'v2',
      size: 3,
      modifiedAt: '2026-11-10T10:00:00.000Z',
    });
    expect(requests[0]).toMatchObject({
      method: 'worker.filesystem.file.write',
      params: {
        createOnly: false,
        expectedVersion: 'v1',
        content: 'abc',
        _meta: { idempotencyKey: 'key-1' },
      },
    });

    stale = true;
    await expect(
      operations['file.save']({ ...save, expectedVersion: 'v1' }),
    ).rejects.toBeInstanceOf(FileSaveConflictError);
    // No version read: a conflict, never a blind overwrite.
    await expect(operations['file.save'](save)).rejects.toBeInstanceOf(
      FileSaveConflictError,
    );
    expect(requests).toHaveLength(2);
  });
});

describe("a sleeping sandbox's saved deliverables (CAN-6587)", () => {
  const DLV = '00000000-0000-4000-8000-0000000000d1';
  const SLEEPING: CanopyCoreRelayReply = {
    ok: false,
    error: {
      kind: 'failed_precondition',
      message: 'The sandbox is asleep.',
      details: { reason: 'sandbox_sleeping' },
      retry: { kind: 'never' },
    },
  };
  const artifact = (artifactId: string, name: string): unknown => ({
    artifactId,
    owner: { kind: 'chat', id: CHAT },
    kind: 'file',
    name,
    mediaType: 'text/csv',
    sizeBytes: 8,
    sha256: 'c'.repeat(64),
    createdAt: '2026-11-10T09:00:00.000Z',
    availability: 'available',
    transfer: null,
  });

  /** A sleeping sandbox whose chat saved `report.csv`, served in two ranges. */
  function sleepingWorld(bytes = 'a,b\n1,2\n'): {
    relay: CanopyCoreRelayApi;
    requests: CanopyCoreRelayRequest[];
  } {
    const data = Buffer.from(bytes, 'latin1');
    return relayAnswering({
      'worker.filesystem.file.read': () => SLEEPING,
      'worker.filesystem.link.resolve': () => SLEEPING,
      'worker.filesystem.roots.list': () =>
        ok({
          roots: [
            {
              fileRootId: 'workspace',
              name: 'Workspace',
              kind: 'workspace-root',
              mountPath: '',
            },
          ],
        }),
      'core.artifact.list': () =>
        ok({
          artifacts: [
            // An attachment with the same name is not the deliverable.
            artifact(
              `att:${CHAT}:00000000-0000-4000-8000-0000000000a1`,
              'report.csv',
            ),
            artifact(`dlv:${CHAT}:${DLV}`, 'report.csv'),
            artifact(
              `dlv:${CHAT}:00000000-0000-4000-8000-0000000000d2`,
              'other.csv',
            ),
          ],
          nextCursor: null,
        }),
      'worker.artifact.download.read': (params) => {
        const offset = Number(params.offset);
        const end = offset === 0 ? 4 : data.byteLength;
        return ok({
          sizeBytes: data.byteLength,
          offset,
          data: data.subarray(offset, end).toString('base64'),
          nextOffset: end < data.byteLength ? end : null,
        });
      },
    });
  }

  const methods = (requests: CanopyCoreRelayRequest[]): string[] =>
    requests.map((r) => (r.kind === 'request' ? r.method : r.kind));

  it("opens a deliverable's link and reads its saved copy while the sandbox sleeps", async () => {
    const { relay, requests } = sleepingWorld();
    const operations = createWebCoreFileOperations(relay);
    const relativePath = 'deliverables/session-1/report.csv';

    await expect(
      operations['file.resolveLink']({
        ...target,
        href: `/vercel/sandbox/workspace/${relativePath}`,
      }),
    ).resolves.toEqual({ fileRootLocalId: 'workspace', relativePath });
    await expect(
      operations['file.read']({
        ...target,
        fileRootLocalId: 'workspace',
        relativePath,
      }),
    ).resolves.toMatchObject({
      path: relativePath,
      content: 'a,b\n1,2\n',
      size: 8,
      truncated: false,
      version: `deliverable:${DLV}`,
    });
    await expect(
      createWebCoreFileSource(relay).readFileContent({
        absolutePath: `web-core:${CHAT}/workspace/${relativePath}`,
      }),
    ).resolves.toMatchObject({
      kind: 'text',
      content: 'a,b\n1,2\n',
      filename: 'report.csv',
    });

    // The saved copy is the chat's own deliverable, read range by range.
    const reads = requests.flatMap((r) =>
      r.kind === 'request' && r.method === 'worker.artifact.download.read'
        ? [r.params]
        : [],
    );
    expect(reads.map((params) => params.offset)).toEqual([0, 4, 0, 4]);
    for (const params of reads)
      expect(params).toMatchObject({
        artifactId: `deliverable:${DLV}`,
        scope: { chatId: CHAT },
      });
    for (const r of requests)
      expect(r).toMatchObject({ authority: 'web-core' });
    expect(
      requests.find(
        (r) => r.kind === 'request' && r.method === 'core.artifact.list',
      ),
    ).toMatchObject({
      params: { owner: { kind: 'chat', id: CHAT }, kinds: ['file'] },
    });
  });

  it("keeps the sandbox's refusal for anything but one of the chat's saved deliverables", async () => {
    const { relay, requests } = sleepingWorld();
    const operations = createWebCoreFileOperations(relay);
    const sleeping = { payload: { details: { reason: 'sandbox_sleeping' } } };

    for (const href of [
      '/vercel/sandbox/workspace/src/index.ts',
      '/etc/deliverables/session-1/report.csv',
      '/etc/workspace/deliverables/session-1/report.csv',
      '/home/someone/workspace/deliverables/session-1/report.csv',
      '/vercel/sandbox/workspace/deliverables/session-1/../../secret.csv',
      'deliverables/session-1/nested/report.csv',
    ]) {
      await expect(
        operations['file.resolveLink']({ ...target, href }),
      ).rejects.toMatchObject(sleeping);
    }
    // None of those reached the chat's saved copies.
    expect(methods(requests)).toEqual(
      Array(6).fill('worker.filesystem.link.resolve'),
    );

    // A deliverable path the chat saved no copy of stays refused.
    await expect(
      operations['file.resolveLink']({
        ...target,
        href: 'deliverables/session-1/missing.csv',
      }),
    ).rejects.toMatchObject(sleeping);
    await expect(
      operations['file.read']({
        ...target,
        fileRootLocalId: 'workspace',
        relativePath: 'deliverables/session-1/missing.csv',
      }),
    ).rejects.toMatchObject(sleeping);
    await expect(
      operations['file.read']({
        ...target,
        fileRootLocalId: 'workspace',
        relativePath: 'src/index.ts',
      }),
    ).rejects.toMatchObject(sleeping);
    expect(
      methods(requests).filter(
        (method) => method === 'worker.artifact.download.read',
      ),
    ).toEqual([]);
  });

  it("keeps the refusal for a saved deliverable that isn't text", async () => {
    const { relay } = sleepingWorld('\xff\xfe\x00\x01');
    await expect(
      createWebCoreFileOperations(relay)['file.read']({
        ...target,
        fileRootLocalId: 'workspace',
        relativePath: 'deliverables/session-1/report.csv',
      }),
    ).rejects.toMatchObject({
      payload: { details: { reason: 'sandbox_sleeping' } },
    });
  });
});

describe("a task's saved deliverables across its chats (CAN-6587)", () => {
  const OTHER_CHAT = 'chat-2';
  const DLV = '00000000-0000-4000-8000-0000000000e1';
  const taskTarget = {
    projectId: webCoreScopeId('workspace-1'),
    worktreeId: SCOPE,
  };
  const chatRow = (chatId: string): unknown => ({
    chatId,
    workspaceId: 'workspace-1',
    worktreeId: CHAT,
    title: chatId,
    state: 'idle',
    revision: 1,
    createdAt: '2026-11-10T09:00:00.000Z',
  });
  const saved = (chatId: string, id: string): unknown => ({
    artifactId: `dlv:${chatId}:${id}`,
    owner: { kind: 'chat', id: chatId },
    kind: 'file',
    name: 'report.csv',
    mediaType: 'text/csv',
    sizeBytes: 4,
    sha256: 'e'.repeat(64),
    createdAt: '2026-11-10T09:00:00.000Z',
    availability: 'available',
    transfer: null,
  });

  /** A sleeping task whose deliverable `report.csv` the chats in `savers` saved. */
  function taskWorld(
    savers: readonly string[],
    archived: readonly string[] = [],
  ): {
    relay: CanopyCoreRelayApi;
    requests: CanopyCoreRelayRequest[];
  } {
    const sleeping: CanopyCoreRelayReply = {
      ok: false,
      error: {
        kind: 'failed_precondition',
        message: 'The sandbox is asleep.',
        details: { reason: 'sandbox_sleeping' },
        retry: { kind: 'never' },
      },
    };
    return relayAnswering({
      'worker.filesystem.file.read': () => sleeping,
      'worker.filesystem.link.resolve': () => sleeping,
      'worker.filesystem.roots.list': () =>
        ok({
          roots: [
            {
              fileRootId: 'workspace',
              name: 'Workspace',
              kind: 'workspace-root',
              mountPath: '',
            },
          ],
        }),
      'core.chat.list': () =>
        ok({
          items: [
            chatRow(CHAT),
            ...archived.map((chatId) =>
              Object.assign({}, chatRow(chatId), { state: 'archived' }),
            ),
            chatRow(OTHER_CHAT),
          ],
          nextCursor: null,
        }),
      'core.artifact.list': (params) => {
        const chatId = String(Reflect.get(Object(params.owner), 'id'));
        if (archived.includes(chatId))
          return {
            ok: false,
            error: {
              kind: 'not_found',
              message: 'The artifact or its owner was not found.',
              code: 'core.artifact.notFound',
              retry: { kind: 'never' },
            },
          };
        return ok({
          artifacts: savers.includes(chatId) ? [saved(chatId, DLV)] : [],
          nextCursor: null,
        });
      },
      'worker.artifact.download.read': () =>
        ok({
          sizeBytes: 4,
          offset: 0,
          data: Buffer.from('a,b\n').toString('base64'),
          nextOffset: null,
        }),
    });
  }

  const read = (relay: CanopyCoreRelayApi): Promise<unknown> =>
    createWebCoreFileOperations(relay)['file.read']({
      ...taskTarget,
      fileRootLocalId: 'workspace',
      relativePath: 'deliverables/session-2/report.csv',
    });

  it("reads a deliverable another chat of the task saved, in that chat's scope", async () => {
    const { relay, requests } = taskWorld([OTHER_CHAT]);
    await expect(read(relay)).resolves.toMatchObject({ content: 'a,b\n' });
    expect(
      requests.find(
        (r) => r.kind === 'request' && r.method === 'core.chat.list',
      ),
    ).toMatchObject({
      params: { scope: { workspaceId: 'workspace-1', worktreeId: CHAT } },
    });
    expect(
      requests.find(
        (r) =>
          r.kind === 'request' && r.method === 'worker.artifact.download.read',
      ),
    ).toMatchObject({
      params: {
        artifactId: `deliverable:${DLV}`,
        scope: { chatId: OTHER_CHAT },
      },
    });
  });

  it("skips the task's archived chats, whose artifacts the web core refuses", async () => {
    const ARCHIVED_CHAT = 'chat-3';
    const { relay, requests } = taskWorld([OTHER_CHAT], [ARCHIVED_CHAT]);
    await expect(read(relay)).resolves.toMatchObject({ content: 'a,b\n' });
    expect(
      requests.some(
        (r) =>
          r.kind === 'request' &&
          r.method === 'core.artifact.list' &&
          Reflect.get(Object(r.params.owner), 'id') === ARCHIVED_CHAT,
      ),
    ).toBe(false);
  });

  it('never picks one of two chats that saved the same name, and says how to open it instead', async () => {
    const { relay, requests } = taskWorld([CHAT, OTHER_CHAT]);
    const refusal = {
      payload: {
        kind: 'failed_precondition',
        details: { reason: 'deliverable_ambiguous' },
        message:
          'More than one chat in this task saved report.csv. Send a message in the task to wake it, then open the file from its folder.',
      },
    };
    await expect(read(relay)).rejects.toMatchObject(refusal);
    await expect(
      createWebCoreFileOperations(relay)['file.resolveLink']({
        ...taskTarget,
        href: '/vercel/sandbox/workspace/deliverables/session-2/report.csv',
      }),
    ).rejects.toMatchObject(refusal);

    // The download refuses too, and never asks main to save either copy.
    const downloadFile = jest.fn();
    Object.assign(globalThis, {
      window: { api: { cloudChats: { downloadFile } } },
    });
    await expect(
      downloadCloudDeliverable(relay, taskTarget, {
        chatId: CHAT,
        fileRootId: 'workspace',
        relativePath: 'deliverables/session-2/report.csv',
      }),
    ).resolves.toEqual({ ok: false, reason: 'ambiguous' });
    expect(downloadFile).not.toHaveBeenCalled();
    Reflect.deleteProperty(globalThis, 'window');
    expect(ambiguousDeliverableMessage('report.csv', 'download')).toBe(
      'More than one chat in this task saved report.csv. Download it from its chat on the web.',
    );
    expect(
      requests.some(
        (r) =>
          r.kind === 'request' && r.method === 'worker.artifact.download.read',
      ),
    ).toBe(false);
  });
});

describe("a saved deliverable's text at the read cap (CAN-6587)", () => {
  it('keeps whole UTF-8 characters when a read ends inside one', () => {
    const decode = (bytes: Uint8Array): string =>
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    for (const tail of ['é', '€', '😀']) {
      const whole = new TextEncoder().encode(`swell ${tail}`);
      // Every cut inside the last character drops it, and only it.
      for (
        let cut = 1;
        cut < new TextEncoder().encode(tail).byteLength;
        cut += 1
      )
        expect(
          decode(wholeUtf8Prefix(whole.subarray(0, whole.byteLength - cut))),
        ).toBe('swell ');
      expect(decode(wholeUtf8Prefix(whole))).toBe(`swell ${tail}`);
    }
  });

  it("finds a saved deliverable on a later page of the chat's artifacts", async () => {
    const DLV = '00000000-0000-4000-8000-0000000000f1';
    const listed: unknown[] = [];
    const artifact = (n: number, name: string, id: string): unknown => ({
      artifactId: `dlv:${CHAT}:${id}`,
      owner: { kind: 'chat', id: CHAT },
      kind: 'file',
      name,
      mediaType: 'text/csv',
      sizeBytes: 4,
      sha256: String(n % 10).repeat(64),
      createdAt: '2026-11-10T09:00:00.000Z',
      availability: 'available',
      transfer: null,
    });
    const { relay } = relayAnswering({
      'worker.filesystem.file.read': () => ({
        ok: false,
        error: {
          kind: 'failed_precondition',
          message: 'The sandbox is asleep.',
          details: { reason: 'sandbox_sleeping' },
          retry: { kind: 'never' },
        },
      }),
      'core.artifact.list': (params) => {
        listed.push(params.cursor);
        return params.cursor === null
          ? ok({
              artifacts: [
                artifact(
                  1,
                  'other.csv',
                  '00000000-0000-4000-8000-0000000000f2',
                ),
              ],
              nextCursor: 'page-2',
            })
          : ok({
              artifacts: [artifact(2, 'report.csv', DLV)],
              nextCursor: null,
            });
      },
      'worker.artifact.download.read': () =>
        ok({
          sizeBytes: 4,
          offset: 0,
          data: Buffer.from('a,b\n').toString('base64'),
          nextOffset: null,
        }),
    });
    await expect(
      createWebCoreFileOperations(relay)['file.read']({
        ...target,
        fileRootLocalId: 'workspace',
        relativePath: 'deliverables/session-1/report.csv',
      }),
    ).resolves.toMatchObject({
      content: 'a,b\n',
      version: `deliverable:${DLV}`,
    });
    expect(listed).toEqual([null, 'page-2']);
  });
});
