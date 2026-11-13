import { CoreCoworkRequestError } from '@canopy/app-state/core-cowork';
import type {
  CanopyCoreRelayApi,
  CanopyCoreRelayReply,
  CanopyCoreRelayRequest,
} from '../../../../../shared/canopy-core-relay';
import { parseWebCoreFilePath, webCoreScopeId } from '../../chat-authority';
import { createWebCoreFileQueries } from '../web-core-file-queries';
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
    const queries = createWebCoreFileQueries(relay);

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
