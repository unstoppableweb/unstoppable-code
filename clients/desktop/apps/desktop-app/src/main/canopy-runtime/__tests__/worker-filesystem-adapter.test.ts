import { pathToFileURL } from 'node:url';
import { WORKSPACE_ROOT_REPO_ID } from '@canopy/desktop-shared/types';
import { PortalServiceError } from '../../services/portal-service-error';
import { IdentifierValidationError } from '../../lib/identifier-validation-error';

import {
  createWorkerFilesystemAdapter,
  WorkerFilesystemAdapterError,
} from '../worker-filesystem-adapter';
import {
  deriveDesktopIpcCaller,
  type DesktopAppWindow,
  type DesktopIpcEvent,
  type DesktopIpcFrame,
} from '../desktop-ipc-caller';

interface IpcSenderFixture {
  mainFrame: {
    url: string;
    detached: boolean;
    isDestroyed: jest.MockedFunction<() => boolean>;
  };
  sender: {
    id: number;
    getURL: jest.MockedFunction<() => string>;
    isDestroyed: jest.MockedFunction<() => boolean>;
    mainFrame: IpcSenderFixture['mainFrame'];
  };
  appWindow: {
    isDestroyed: jest.MockedFunction<() => boolean>;
    webContents: IpcSenderFixture['sender'];
  };
}

describe('createWorkerFilesystemAdapter', () => {
  it('projects roots and entries without changing order or field behavior', async () => {
    const listFileTreeRoots = jest.fn(() =>
      Promise.resolve({
        roots: [
          {
            repoId: WORKSPACE_ROOT_REPO_ID,
            repoName: 'Workspace',
            absolutePath: '/workspace',
            rootKind: 'workspace-root' as const,
          },
          {
            repoId: 'repo-1',
            repoName: 'Repository',
            absolutePath: '/workspace/repo',
            rootKind: 'git-repo' as const,
          },
        ],
      }),
    );
    const listFileTreeDirectory = jest.fn(() =>
      Promise.resolve({
        entries: [
          {
            name: 'src',
            relativePath: 'src',
            absolutePath: '/workspace/repo/src',
            kind: 'directory' as const,
            isIgnored: false,
            isIndexExcluded: true,
            isSymlink: false,
            hasChildren: true,
          },
          {
            name: 'ignored.log',
            relativePath: 'ignored.log',
            absolutePath: '/workspace/repo/ignored.log',
            kind: 'file' as const,
            isIgnored: true,
            isIndexExcluded: false,
            isSymlink: true,
            hasChildren: false,
          },
        ],
      }),
    );
    const adapter = createWorkerFilesystemAdapter({
      listFileTreeRoots,
      listFileTreeDirectory,
    });

    await expect(
      adapter['worker.filesystem.roots.list'](
        {
          scope: { workspaceId: 'workspace-1', worktreeId: 'worktree-1' },
        },
        undefined,
      ),
    ).resolves.toEqual({
      roots: [
        {
          fileRootId: WORKSPACE_ROOT_REPO_ID,
          name: 'Workspace',
          kind: 'workspace-root',
        },
        {
          fileRootId: 'repo-1',
          name: 'Repository',
          kind: 'git-repo',
        },
      ],
    });
    await expect(
      adapter['worker.filesystem.directory.list'](
        {
          scope: { workspaceId: 'workspace-1', worktreeId: 'worktree-1' },
          fileRootId: 'repo-1',
          relativePath: '',
        },
        undefined,
      ),
    ).resolves.toEqual({
      entries: [
        {
          name: 'src',
          relativePath: 'src',
          kind: 'directory',
          isIgnored: false,
          isIndexExcluded: true,
          isSymlink: false,
          hasChildren: true,
        },
        {
          name: 'ignored.log',
          relativePath: 'ignored.log',
          kind: 'file',
          isIgnored: true,
          isIndexExcluded: false,
          isSymlink: true,
          hasChildren: false,
        },
      ],
    });
    expect(listFileTreeRoots).toHaveBeenCalledWith({
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
    });
    expect(listFileTreeDirectory).toHaveBeenCalledWith({
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      repoId: 'repo-1',
      relativeDir: '',
    });
  });

  it.each([
    [
      new PortalServiceError('invalid_payload', 'bad payload'),
      'invalid_argument',
    ],
    [
      new PortalServiceError('invalid_target', 'bad target'),
      'invalid_argument',
    ],
    [new PortalServiceError('not_found', 'missing'), 'not_found'],
    [new PortalServiceError('execution_failed', 'failed'), 'internal'],
    [
      new IdentifierValidationError('Invalid projectId: must be lowercase'),
      'invalid_argument',
    ],
    [new Error('Invalid projectId: must be lowercase'), 'internal'],
    [new Error('sensitive unexpected failure'), 'internal'],
  ] as const)(
    'translates %s to %s while retaining only the runtime cause',
    async (cause, kind) => {
      const adapter = createWorkerFilesystemAdapter({
        listFileTreeRoots: () => Promise.reject(cause),
        listFileTreeDirectory: () => Promise.resolve({ entries: [] }),
      });

      const rejection = Promise.resolve(
        adapter['worker.filesystem.roots.list'](
          {
            scope: { workspaceId: 'workspace-1', worktreeId: 'worktree-1' },
          },
          undefined,
        ),
      );
      await expect(rejection).rejects.toMatchObject({
        payload: { kind, retry: { kind: 'never' } },
      });
      await rejection.catch((error: unknown) => {
        expect(error).toBeInstanceOf(WorkerFilesystemAdapterError);
        if (!(error instanceof WorkerFilesystemAdapterError)) {
          throw new Error('Expected WorkerFilesystemAdapterError');
        }
        expect(error.runtimeCause).toBe(cause);
        expect(JSON.stringify(error)).not.toContain(
          'sensitive unexpected failure',
        );
      });
    },
  );

  it('keeps a missing directory as a successful empty listing', async () => {
    const adapter = createWorkerFilesystemAdapter({
      listFileTreeRoots: () => Promise.resolve({ roots: [] }),
      listFileTreeDirectory: () => Promise.resolve({ entries: [] }),
    });
    await expect(
      adapter['worker.filesystem.directory.list'](
        {
          scope: { workspaceId: 'workspace-1', worktreeId: 'worktree-1' },
          fileRootId: 'repo-1',
          relativePath: 'missing',
        },
        undefined,
      ),
    ).resolves.toEqual({ entries: [] });
  });

  it.each([
    { authorityId: 'foreign-authority' },
    { targetId: 'remote-worker' },
  ])(
    'rejects unsupported placement before local reads: %j',
    async (selection) => {
      const services = {
        listFileTreeRoots: jest.fn(() => Promise.resolve({ roots: [] })),
        listFileTreeDirectory: jest.fn(() => Promise.resolve({ entries: [] })),
      };
      const adapter = createWorkerFilesystemAdapter(services);
      const scope = {
        workspaceId: 'workspace-1',
        worktreeId: 'worktree-1',
        ...selection,
      };
      await expect(
        adapter['worker.filesystem.roots.list']({ scope }, undefined),
      ).rejects.toMatchObject({ payload: { kind: 'capability_unavailable' } });
      await expect(
        adapter['worker.filesystem.directory.list'](
          {
            scope,
            fileRootId: 'repo-1',
            relativePath: '',
          },
          undefined,
        ),
      ).rejects.toMatchObject({ payload: { kind: 'capability_unavailable' } });
      expect(services.listFileTreeRoots).not.toHaveBeenCalled();
      expect(services.listFileTreeDirectory).not.toHaveBeenCalled();
    },
  );

  it('accepts an explicit local authority without changing the service request', async () => {
    const services = {
      listFileTreeRoots: jest.fn(() => Promise.resolve({ roots: [] })),
      listFileTreeDirectory: jest.fn(() => Promise.resolve({ entries: [] })),
    };
    await createWorkerFilesystemAdapter(services)[
      'worker.filesystem.roots.list'
    ](
      {
        scope: {
          workspaceId: 'workspace-1',
          worktreeId: 'worktree-1',
          authorityId: 'local-desktop',
        },
      },
      undefined,
    );
    expect(services.listFileTreeRoots).toHaveBeenCalledWith({
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
    });
  });

  it('rejects canonical scopes that lack the desktop workspace identifiers', async () => {
    const adapter = createWorkerFilesystemAdapter({
      listFileTreeRoots: () => Promise.resolve({ roots: [] }),
      listFileTreeDirectory: () => Promise.resolve({ entries: [] }),
    });

    await expect(
      adapter['worker.filesystem.roots.list'](
        {
          scope: { authorityId: 'primary', targetId: 'worker' },
        },
        undefined,
      ),
    ).rejects.toMatchObject({
      payload: { kind: 'invalid_argument', retry: { kind: 'never' } },
    });
  });
});

function makeSender(url: string): IpcSenderFixture {
  const mainFrame = {
    url,
    detached: false,
    isDestroyed: jest.fn(() => false),
  };
  const sender = {
    id: 42,
    getURL: jest.fn(() => url),
    isDestroyed: jest.fn(() => false),
    mainFrame,
  };
  const appWindow = {
    isDestroyed: jest.fn(() => false),
    webContents: sender,
  };
  return { mainFrame, sender, appWindow };
}

describe('deriveDesktopIpcCaller', () => {
  it('accepts a recovered live main frame despite Electron 42 retaining detached', () => {
    const url = pathToFileURL('/app/renderer/index.html').href;
    const { mainFrame, sender, appWindow } = makeSender(url);
    mainFrame.detached = true;
    expect(
      deriveDesktopIpcCaller(
        { sender, senderFrame: mainFrame },
        { getAppWindows: () => [appWindow], packagedRendererUrls: [url] },
      ),
    ).toMatchObject({ clientInstanceId: 'electron-web-contents:42' });
  });

  it.each(['null', 'old-document', 'disposed', 'url-mismatch', 'untracked'])(
    'rejects %s even when a recovered main frame retains detached',
    (scenario) => {
      const url = pathToFileURL('/app/renderer/index.html').href;
      const { mainFrame, sender, appWindow } = makeSender(url);
      mainFrame.detached = true;
      let senderFrame: DesktopIpcFrame | null = mainFrame;
      if (scenario === 'null') senderFrame = null;
      if (scenario === 'old-document') senderFrame = { ...mainFrame };
      if (scenario === 'disposed') mainFrame.isDestroyed.mockReturnValue(true);
      if (scenario === 'url-mismatch')
        sender.getURL.mockReturnValue(`${url}#other`);
      expect(() =>
        deriveDesktopIpcCaller(
          { sender, senderFrame },
          {
            getAppWindows: () => (scenario === 'untracked' ? [] : [appWindow]),
            packagedRendererUrls: [url],
          },
        ),
      ).toThrow('Untrusted desktop IPC sender.');
    },
  );

  it('authenticates a tracked top-level packaged renderer and derives fixed trust', () => {
    const packagedRendererUrl = pathToFileURL('/app/renderer/index.html').href;
    const { mainFrame, sender, appWindow } = makeSender(
      `${packagedRendererUrl}?view=main#workspace`,
    );
    const event: DesktopIpcEvent = {
      sender,
      senderFrame: mainFrame,
    };

    const expectedGrants: unknown = expect.arrayContaining([
      'worker.filesystem.read',
      'core.workspace.read',
      'core.chat.read',
      'core.chat.write',
      'core.worktree.read',
      'core.chat.write',
    ]);

    expect(
      deriveDesktopIpcCaller(event, {
        getAppWindows: () => [appWindow],
        packagedRendererUrls: [packagedRendererUrl],
      }),
    ).toEqual({
      principalId: 'local-desktop-user',
      clientInstanceId: 'electron-web-contents:42',
      authorityId: 'local-desktop',
      interfaceKind: 'desktop',
      grants: expectedGrants,
    });
  });

  it('authenticates each packaged window page and no other renderer page', () => {
    const packagedRendererUrls = [
      pathToFileURL('/app/renderer/index.html').href,
      pathToFileURL('/app/renderer/app-advisor.html').href,
    ];
    const deriveFor = (url: string): unknown => {
      const { mainFrame, sender, appWindow } = makeSender(url);
      try {
        return deriveDesktopIpcCaller(
          { sender, senderFrame: mainFrame },
          { getAppWindows: () => [appWindow], packagedRendererUrls },
        ).authorityId;
      } catch (error) {
        return error;
      }
    };

    expect(
      deriveFor(
        `${pathToFileURL('/app/renderer/app-advisor.html').href}?surface=app-advisor`,
      ),
    ).toBe('local-desktop');
    expect(deriveFor(packagedRendererUrls[0])).toBe('local-desktop');
    for (const untrusted of [
      pathToFileURL('/app/renderer/composer-status-lab.html').href,
      pathToFileURL('/other/renderer/app-advisor.html').href,
    ]) {
      expect(deriveFor(untrusted)).toMatchObject({
        payload: { kind: 'permission_denied' },
      });
    }
  });

  it('authenticates the two renderer scheme pages and no look-alike', () => {
    const packagedRendererUrls = [
      'app-renderer://bundle/index.html',
      'app-renderer://bundle/app-advisor.html',
    ];
    const deriveFor = (url: string): unknown => {
      const { mainFrame, sender, appWindow } = makeSender(url);
      try {
        return deriveDesktopIpcCaller(
          { sender, senderFrame: mainFrame },
          { getAppWindows: () => [appWindow], packagedRendererUrls },
        ).authorityId;
      } catch (error) {
        return error;
      }
    };

    expect(deriveFor('app-renderer://bundle/index.html')).toBe('local-desktop');
    expect(deriveFor('app-renderer://bundle/index.html#workspace')).toBe(
      'local-desktop',
    );
    expect(
      deriveFor('app-renderer://bundle/app-advisor.html?surface=app-advisor'),
    ).toBe('local-desktop');
    for (const untrusted of [
      'app-renderer://bundle/storage-bridge.html',
      'app-renderer://bundle/composer-status-lab.html',
      'app-renderer://bundle/assets/index.html',
      'app-renderer://bundle.evil/index.html',
      'app-renderer://evil/index.html',
      'app-renderer://bundle:8080/index.html',
      'app-rendererx://bundle/index.html',
      'https://bundle/index.html',
      pathToFileURL('/app/renderer/index.html').href,
    ]) {
      expect(deriveFor(untrusted)).toMatchObject({
        payload: { kind: 'permission_denied' },
      });
    }
  });

  it('accepts only the configured dev-server origin', () => {
    const { mainFrame, sender, appWindow } = makeSender(
      'http://127.0.0.1:5173/worktree/one',
    );
    const event: DesktopIpcEvent = {
      sender,
      senderFrame: mainFrame,
    };
    expect(
      deriveDesktopIpcCaller(event, {
        getAppWindows: () => [appWindow],
        packagedRendererUrls: [pathToFileURL('/app/renderer/index.html').href],
        devServerUrl: 'http://127.0.0.1:5173',
      }),
    ).toMatchObject({ authorityId: 'local-desktop' });
  });

  it.each(['untracked', 'subframe', 'wrong-origin', 'destroyed'])(
    'rejects an invalid %s sender before grants are attached',
    (scenario) => {
      const packagedRendererUrl = pathToFileURL(
        '/app/renderer/index.html',
      ).href;
      const { mainFrame, sender, appWindow } = makeSender(packagedRendererUrl);
      let senderFrame: DesktopIpcFrame = mainFrame;
      let windows: DesktopAppWindow[] = [appWindow];
      let devServerUrl: string | undefined;
      if (scenario === 'untracked') windows = [];
      if (scenario === 'subframe') senderFrame = { ...mainFrame };
      if (scenario === 'wrong-origin') {
        mainFrame.url = 'https://attacker.example/index.html';
        sender.getURL.mockReturnValue(mainFrame.url);
        devServerUrl = 'http://127.0.0.1:5173';
      }
      if (scenario === 'destroyed') sender.isDestroyed.mockReturnValue(true);

      try {
        deriveDesktopIpcCaller(
          { sender, senderFrame },
          {
            getAppWindows: () => windows,
            packagedRendererUrls: [packagedRendererUrl],
            devServerUrl,
          },
        );
        throw new Error('Expected sender authentication to fail');
      } catch (error) {
        expect(error).toMatchObject({
          payload: { kind: 'permission_denied' },
        });
      }
    },
  );
});
