import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '@canopy/core-runtime';
import { createDesktopRuntime } from '../canopy-runtime/desktop-runtime';
import { withLocalGitBinding } from '../canopy-runtime/worker-git-local-mutations-binding';
import {
  ensureRepoShadowThroughWorker,
  persistTurnRefThroughWorker,
  restoreSnapshotThroughWorker,
  revertFileThroughWorker,
} from '../canopy-runtime/worker-git-local-mutations-dispatch';
import { withRepositoryCreationBinding } from '../canopy-runtime/worker-git-repository-creation-binding';
import {
  cloneRepositoryThroughWorker,
  initializeRepositoryThroughWorker,
} from '../canopy-runtime/worker-git-repository-creation-dispatch';
import * as gitEffects from '../lib/git';
import {
  clearRepoShadowRuntimeCaches,
  ensureRepoShadow,
  getBaselineReadPath,
  getRepoShadowDir,
  withEnsuredRepoShadow,
} from '../lib/repo-shadow';

const caller: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'local-git-golden',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: ['worker.git.write'],
};
let root: string;
let runtime: ReturnType<typeof createDesktopRuntime>;
function git(...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: 'pipe',
  }).trim();
}
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'local-git-dispatch-')));
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Golden');
  git('config', 'user.email', 'golden@example.com');
  writeFileSync(join(root, 'file'), 'original');
  git('add', '.');
  git('commit', '-qm', 'initial');
  runtime = createDesktopRuntime();
});
afterEach(async () => {
  await runtime.shutdown();
  jest.restoreAllMocks();
  clearRepoShadowRuntimeCaches();
  rmSync(root, { recursive: true, force: true });
});

it('fails closed with typed lifecycle errors and never falls back to direct effects', async () => {
  const treeSha = git('rev-parse', 'HEAD^{tree}');
  writeFileSync(join(root, 'file'), 'keep');
  await runtime.shutdown();
  for (const operation of [
    (): Promise<unknown> => restoreSnapshotThroughWorker(root, { treeSha }),
    (): Promise<unknown> =>
      persistTurnRefThroughWorker(root, 'project', 'turn', treeSha),
    (): Promise<unknown> => ensureRepoShadowThroughWorker(root),
  ]) {
    await expect(operation()).rejects.toBeInstanceOf(CanopyOperationError);
    await expect(operation()).rejects.toMatchObject({
      payload: {
        kind: 'unavailable',
        message: 'The desktop Git mutation runtime is unavailable.',
      },
    });
  }
  await expect(
    revertFileThroughWorker(runtime, caller, root, {
      filePath: 'file',
      status: 'modified',
    }),
  ).rejects.toMatchObject({
    name: 'CanopyOperationError',
    payload: { kind: 'unavailable' },
    runtimeCause: undefined,
  });
  expect(readFileSync(join(root, 'file'), 'utf8')).toBe('keep');
  // A superseded runtime shutting down cannot unregister the new composition.
  const oldRuntime = runtime;
  runtime = createDesktopRuntime();
  await oldRuntime.shutdown();
  await persistTurnRefThroughWorker(root, 'project', 'turn', treeSha);
  expect(
    git('rev-parse', `refs/app/turn-diff-trees/project/turn/${treeSha}`),
  ).toBe(treeSha);
});

it('lets an admitted restore finish its real Git mutations after dispatcher cancellation', async () => {
  const treeSha = git('rev-parse', 'HEAD^{tree}');
  writeFileSync(join(root, 'file'), 'edited');
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<void>();
  const restore = gitEffects.restoreToSnapshot;
  const effect = jest
    .spyOn(gitEffects, 'restoreToSnapshot')
    .mockImplementation(async (...args) => {
      entered.resolve();
      await release.promise;
      try {
        await restore(...args);
      } finally {
        finished.resolve();
      }
    });
  const controller = new AbortController();
  const instruction = withLocalGitBinding(
    'worker.git.snapshot.restore',
    root,
    undefined,
    (bindingId) =>
      runtime.instruction(
        'worker.git.snapshot.restore',
        { bindingId, treeSha },
        { caller, signal: controller.signal },
      ),
  );
  const rejected = expect(instruction).rejects.toMatchObject({
    payload: { kind: 'cancelled' },
  });
  try {
    await entered.promise;
    controller.abort();
    await rejected;
    expect(effect).toHaveBeenCalledWith(root, { treeSha });
  } finally {
    release.resolve();
    await finished.promise;
  }
  expect(readFileSync(join(root, 'file'), 'utf8')).toBe('original');
});

function attachOrigin(): string {
  const origin = join(root, 'origin.git');
  execFileSync('git', ['clone', '-q', '--bare', root, origin], {
    stdio: 'pipe',
  });
  git('remote', 'add', 'origin', origin);
  return origin;
}

it('keeps the failure-cache TTL at its exact boundary through the shadow port', async () => {
  const now = Date.now();
  const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
  await expect(ensureRepoShadow(root)).rejects.toThrow(
    'no remote default branch',
  );
  attachOrigin();
  clock.mockReturnValue(now + 59_999);
  await expect(ensureRepoShadow(root)).rejects.toThrow(
    'no remote default branch',
  );
  clock.mockReturnValue(now + 60_000);
  expect((await ensureRepoShadow(root)).defaultBranch).toBe('main');
});

it('deduplicates stale refreshes and keeps internal background work independent of dispatcher shutdown', async () => {
  attachOrigin();
  const shadow = await ensureRepoShadow(root);
  writeFileSync(join(root, 'file'), 'new origin');
  git('add', 'file');
  git('commit', '-qm', 'advance origin');
  git('push', '-q', 'origin', 'main');
  const makeStale = (): void =>
    writeFileSync(
      join(getRepoShadowDir(root), 'meta.json'),
      JSON.stringify({
        version: 1,
        repoPath: root,
        defaultBranch: 'main',
        lastSyncAt: new Date(Date.now() - 16 * 60_000).toISOString(),
      }),
    );
  makeStale();
  const fetch = gitEffects.fetchOrigin;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const effect = jest
    .spyOn(gitEffects, 'fetchOrigin')
    .mockImplementation(async (...args) => {
      entered.resolve();
      await release.promise;
      return fetch(...args);
    });
  try {
    const stale = await Promise.all(
      Array.from({ length: 8 }, () =>
        ensureRepoShadow(root, { allowStale: true }),
      ),
    );
    expect(stale.every((value) => value.shadowPath === shadow.shadowPath)).toBe(
      true,
    );
    await entered.promise;
    expect(effect).toHaveBeenCalledTimes(1);
    await runtime.shutdown();
  } finally {
    release.resolve();
    await withEnsuredRepoShadow(root, { maxAgeMs: Infinity }, () =>
      Promise.resolve(),
    );
  }
  expect(readFileSync(join(shadow.shadowPath, 'file'), 'utf8')).toBe(
    'new origin',
  );
  effect.mockRestore();
  makeStale();
  // Baseline reads can schedule new background work even after runtime shutdown.
  expect(await getBaselineReadPath(root)).toBe(shadow.shadowPath);
  await withEnsuredRepoShadow(root, { maxAgeMs: Infinity }, (value) => {
    expect(Date.now() - Date.parse(value.lastSyncAt)).toBeLessThan(60_000);
    return Promise.resolve();
  });
});

it('runs the restore primitive and turn refs on the desktop dispatcher without moving chat:reset-to-point', async () => {
  const headCommitSha = git('rev-parse', 'HEAD');
  writeFileSync(join(root, 'file'), 'snapshot');
  git('add', '.');
  const treeSha = git('write-tree');
  await persistTurnRefThroughWorker(root, 'project', 'turn', treeSha, runtime);
  expect(
    git('rev-parse', `refs/app/turn-diff-trees/project/turn/${treeSha}`),
  ).toBe(treeSha);
  git('commit', '-qm', 'later');
  writeFileSync(join(root, 'file'), 'later edits');
  await restoreSnapshotThroughWorker(root, { treeSha, headCommitSha }, runtime);
  expect(git('rev-parse', 'HEAD')).toBe(headCommitSha);
  expect(readFileSync(join(root, 'file'), 'utf8')).toBe('snapshot');
  await expect(
    restoreSnapshotThroughWorker(root, { treeSha: '' }, runtime),
  ).rejects.toThrow('Invalid tree SHA');
});

it('projects legacy revert results and errors without a runtime wrapper', async () => {
  writeFileSync(join(root, 'file'), 'edited');
  await expect(
    revertFileThroughWorker(runtime, caller, root, {
      filePath: 'file',
      status: 'modified',
    }),
  ).resolves.toBeUndefined();
  expect(readFileSync(join(root, 'file'), 'utf8')).toBe('original');
  await expect(
    revertFileThroughWorker(runtime, caller, root, {
      filePath: 'file',
      status: 'unknown',
    }),
  ).rejects.toMatchObject({
    name: 'Error',
    message: 'Cannot revert file "file": unknown status is not supported',
  });
});

it.each([caller, { ...caller, principalId: 'remote-device:one' }])(
  'preserves the original filesystem Error instance, properties and long message for $principalId',
  async (effectCaller) => {
    const failure = Object.assign(new Error('ENOENT: '.padEnd(5_000, 'x')), {
      code: 'ENOENT',
      errno: -2,
      syscall: 'unlink',
      path: join(root, 'missing'),
    });
    jest
      .spyOn(gitEffects, 'revertUncommittedFile')
      .mockRejectedValueOnce(failure);
    await expect(
      revertFileThroughWorker(runtime, effectCaller, root, {
        filePath: 'missing',
        status: 'untracked',
      }),
    ).rejects.toBe(failure);
  },
);

it('rejects a binding used by a delayed child context after the request expired', async () => {
  const release = Promise.withResolvers<void>();
  const treeSha = git('rev-parse', 'HEAD^{tree}');
  let late: Promise<unknown> = Promise.resolve();
  await withLocalGitBinding(
    'worker.git.turnRef.persist',
    root,
    undefined,
    (bindingId) => {
      late = release.promise.then(() =>
        runtime.instruction(
          'worker.git.turnRef.persist',
          {
            bindingId,
            projectId: 'project',
            worktreeId: 'turn',
            treeSha,
          },
          { caller },
        ),
      );
      return Promise.resolve();
    },
  );
  const refused = expect(late).rejects.toMatchObject({
    payload: { code: 'worker.git.localMutation.bindingUnavailable' },
  });
  release.resolve();
  await refused;
  expect(
    git('for-each-ref', '--format=%(objectname)', 'refs/app/turn-diff-trees'),
  ).toBe('');
});

it.each<CanopyCallerDescriptor>([
  { ...caller, principalId: 'remote-device:one' },
  { ...caller, principalId: 'core', interfaceKind: 'worker' },
  { ...caller, principalId: 'test', interfaceKind: 'test' },
])(
  'admits $principalId on $interfaceKind and preserves the legacy void revert result',
  async (admittedCaller) => {
    writeFileSync(join(root, 'file'), 'edited');
    await expect(
      revertFileThroughWorker(runtime, admittedCaller, root, {
        filePath: 'file',
        status: 'modified',
      }),
    ).resolves.toBeUndefined();
    expect(readFileSync(join(root, 'file'), 'utf8')).toBe('original');
  },
);

it.each<CanopyCallerDescriptor>([
  { ...caller, principalId: 'local-desktop-renderer:one' },
  { ...caller, principalId: 'renderer-relay' },
  { ...caller, principalId: 'portal', interfaceKind: 'portal' },
  { ...caller, principalId: 'remote-device:one', interfaceKind: 'portal' },
  { ...caller, principalId: 'local-desktop-user', interfaceKind: 'portal' },
  { ...caller, principalId: 'unknown' },
])(
  'refuses $principalId on $interfaceKind even with the write grant before effects',
  async (refusedCaller) => {
    writeFileSync(join(root, 'file'), 'keep');
    await expect(
      revertFileThroughWorker(runtime, refusedCaller, root, {
        filePath: 'file',
        status: 'modified',
      }),
    ).rejects.toMatchObject({
      payload: {
        kind: 'permission_denied',
        code: 'worker.git.localMutation.callerRefused',
      },
    });
    expect(readFileSync(join(root, 'file'), 'utf8')).toBe('keep');
  },
);

it.each([
  'worker.git.file.revert',
  'worker.git.snapshot.restore',
  'worker.git.turnRef.persist',
  'worker.git.repoShadow.ensure',
] as const)(
  'refuses renderer relay for %s before effects',
  async (operation) => {
    writeFileSync(join(root, 'file'), 'keep');
    const treeSha = git('rev-parse', 'HEAD^{tree}');
    const options = {
      caller: { ...caller, principalId: 'local-desktop-renderer:one' },
    };
    await withLocalGitBinding(operation, root, undefined, async (bindingId) => {
      const invoke = (): Promise<unknown> => {
        switch (operation) {
          case 'worker.git.file.revert':
            return runtime.instruction(
              operation,
              { bindingId, filePath: 'file', status: 'modified' },
              options,
            );
          case 'worker.git.snapshot.restore':
            return runtime.instruction(
              operation,
              { bindingId, treeSha },
              options,
            );
          case 'worker.git.turnRef.persist':
            return runtime.instruction(
              operation,
              { bindingId, treeSha, projectId: 'project', worktreeId: 'turn' },
              options,
            );
          case 'worker.git.repoShadow.ensure':
            return runtime.instruction(operation, { bindingId }, options);
        }
      };
      await expect(invoke()).rejects.toMatchObject({
        payload: {
          kind: 'permission_denied',
          code: 'worker.git.localMutation.callerRefused',
        },
      });
    });
    expect(readFileSync(join(root, 'file'), 'utf8')).toBe('keep');
    expect(
      git('for-each-ref', '--format=%(objectname)', 'refs/app/turn-diff-trees'),
    ).toBe('');
  },
);

it('rejects an empty principal as unauthenticated before effects', async () => {
  writeFileSync(join(root, 'file'), 'keep');
  await expect(
    revertFileThroughWorker(runtime, { ...caller, principalId: '' }, root, {
      filePath: 'file',
      status: 'modified',
    }),
  ).rejects.toMatchObject({ payload: { kind: 'unauthenticated' } });
  expect(readFileSync(join(root, 'file'), 'utf8')).toBe('keep');
});

it('rejects absent, wrong-operation, foreign-context and consumed capabilities', async () => {
  const params = { treeSha: git('rev-parse', 'HEAD^{tree}') };
  const invoke = (bindingId: string): Promise<unknown> =>
    runtime.instruction(
      'worker.git.snapshot.restore',
      { bindingId, ...params },
      { caller },
    );
  await expect(
    invoke('00000000-0000-4000-8000-000000000001'),
  ).rejects.toMatchObject({
    payload: { code: 'worker.git.localMutation.bindingUnavailable' },
  });
  await withLocalGitBinding(
    'worker.git.file.revert',
    root,
    undefined,
    async (bindingId) => {
      await expect(invoke(bindingId)).rejects.toMatchObject({
        payload: { code: 'worker.git.localMutation.bindingUnavailable' },
      });
    },
  );
  await withLocalGitBinding(
    'worker.git.snapshot.restore',
    root,
    undefined,
    async (bindingId) => {
      await withLocalGitBinding(
        'worker.git.snapshot.restore',
        root,
        undefined,
        async () => {
          await expect(invoke(bindingId)).rejects.toMatchObject({
            payload: { code: 'worker.git.localMutation.bindingUnavailable' },
          });
        },
      );
      await invoke(bindingId);
      await expect(invoke(bindingId)).rejects.toMatchObject({
        payload: { code: 'worker.git.localMutation.bindingUnavailable' },
      });
    },
  );
});

it('checks the grant before consuming a request binding', async () => {
  const treeSha = git('rev-parse', 'HEAD^{tree}');
  await withLocalGitBinding(
    'worker.git.turnRef.persist',
    root,
    undefined,
    async (bindingId) => {
      const params = {
        bindingId,
        projectId: 'project',
        worktreeId: 'turn',
        treeSha,
      };
      await expect(
        runtime.instruction('worker.git.turnRef.persist', params, {
          caller: { ...caller, grants: [] },
        }),
      ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
      await runtime.instruction('worker.git.turnRef.persist', params, {
        caller,
      });
    },
  );
});

// CAN-7952: repository initialize and clone share the binding admission.
describe('worker.git.repository initialize and clone', () => {
  const seeded = (directory: string) =>
    ({
      operation: 'worker.git.repository.initialize',
      effect: { kind: 'seeded', directory, name: 'fresh' },
    }) as const;

  it('admits a paired controller and the core caller with the helpers effects', async () => {
    const created = join(root, 'created');
    mkdirSync(created);
    await initializeRepositoryThroughWorker(
      { kind: 'seeded', directory: created, name: 'fresh' },
      {
        dispatcher: runtime,
        caller: { ...caller, principalId: 'remote-device:paired' },
      },
    );
    expect(
      execFileSync('git', ['-C', created, 'log', '--format=%s'], {
        encoding: 'utf8',
      }).trim(),
    ).toBe('Initial commit');
    const cloned = join(root, 'cloned');
    await cloneRepositoryThroughWorker({
      kind: 'clone',
      url: root,
      destination: cloned,
    });
    expect(readFileSync(join(cloned, 'file'), 'utf8')).toBe('original');
  });

  it.each([
    'worker.git.repository.initialize',
    'worker.git.repository.clone',
  ] as const)(
    'refuses renderer relay for %s before effects',
    async (operation) => {
      const destination = join(root, 'refused');
      const staged =
        operation === 'worker.git.repository.clone'
          ? ({
              operation,
              effect: { kind: 'clone', url: root, destination },
            } as const)
          : seeded(destination);
      await withRepositoryCreationBinding(staged, async (bindingId) => {
        await expect(
          runtime.instruction(
            operation,
            { bindingId },
            {
              caller: { ...caller, principalId: 'local-desktop-renderer:one' },
            },
          ),
        ).rejects.toMatchObject({
          payload: {
            kind: 'permission_denied',
            code: 'worker.git.repository.callerRefused',
          },
        });
      });
      expect(existsSync(destination)).toBe(false);
    },
  );

  it('rejects absent, wrong-operation, foreign-context and consumed bindings', async () => {
    const directory = join(root, 'bound');
    mkdirSync(directory);
    const invoke = (bindingId: string): Promise<unknown> =>
      runtime.instruction(
        'worker.git.repository.initialize',
        { bindingId },
        { caller },
      );
    const unavailable = {
      payload: {
        kind: 'failed_precondition',
        code: 'worker.git.repository.bindingUnavailable',
      },
    };
    await expect(
      invoke('00000000-0000-4000-8000-000000000001'),
    ).rejects.toMatchObject(unavailable);
    await withRepositoryCreationBinding(
      {
        operation: 'worker.git.repository.clone',
        effect: { kind: 'clone', url: root, destination: directory },
      },
      async (bindingId) => {
        await expect(invoke(bindingId)).rejects.toMatchObject(unavailable);
      },
    );
    await withRepositoryCreationBinding(
      seeded(directory),
      async (bindingId) => {
        await withRepositoryCreationBinding(seeded(directory), async () => {
          await expect(invoke(bindingId)).rejects.toMatchObject(unavailable);
        });
        expect(existsSync(join(directory, '.git'))).toBe(false);
        await invoke(bindingId);
        await expect(invoke(bindingId)).rejects.toMatchObject(unavailable);
      },
    );
  });

  it('fails closed without a registered runtime and never falls back to direct effects', async () => {
    const directory = join(root, 'closed');
    mkdirSync(directory);
    await runtime.shutdown();
    await expect(
      initializeRepositoryThroughWorker({ kind: 'empty', directory }),
    ).rejects.toMatchObject({
      payload: {
        kind: 'unavailable',
        message: 'The desktop Git mutation runtime is unavailable.',
      },
    });
    expect(existsSync(join(directory, '.git'))).toBe(false);
  });
});
