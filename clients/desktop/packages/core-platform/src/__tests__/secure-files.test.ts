import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type * as Runtime from '@canopy/core-runtime';
import { createSecureFileServices as create } from '../secure-files';
import { errorCode } from '../secure-files/shared';

const posixIt = process.platform === 'win32' ? it.skip : it;
const wait = { delay: (): Promise<void> => Promise.resolve() };
const retry = { attempts: 3, ...wait };
const RENAMED = { kind: 'renamed', sourceState: 'removed' };
const RETAINED = { ...RENAMED, sourceState: 'retained' };
const fsError = (code: string): Error =>
  Object.assign(new Error(code), { code });

const codeOf = (run: Promise<unknown>): Promise<unknown> =>
  run.then(
    () => 'resolved',
    (e: unknown) => errorCode(e) ?? e,
  );

let dir = '';
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(tmpdir(), 'secure-files-'));
});
afterEach(() => fs.rm(dir, { recursive: true, force: true }));

/** A file with `data`, or a directory when `data` is null. */
async function make(
  name: string,
  mode = 0o600,
  data: string | null = name,
): Promise<string> {
  const target = path.join(dir, name);
  await (data === null ? fs.mkdir(target) : fs.writeFile(target, data));
  await fs.chmod(target, mode);
  return target;
}
const modeOf = async (target: string): Promise<number> =>
  (await fs.stat(target)).mode & 0o7777;
const read = (target: string): Promise<string> => fs.readFile(target, 'utf8');

const BASE = { kind: 'file', mode: 'owner-only', action: 'verify' } as const;
const states = (
  services: Runtime.PlatformSecureFileServices,
  requests: ReadonlyArray<Partial<Runtime.PlatformPermissionRequest>>,
): Promise<string[]> =>
  Promise.all(
    requests.map(
      async (r) =>
        (await services.permissions({ ...BASE, path: dir, ...r })).state,
    ),
  );
const insecure = (count: number): string[] =>
  Array<string>(count).fill('insecure');

describe('secure files: POSIX permissions', () => {
  const services = create(process.platform === 'darwin' ? 'darwin' : 'linux');

  posixIt('accepts only exact owner modes', async () => {
    const [exe, kind] = [{ mode: 'owner-executable' }, 'directory'] as const;
    expect(services.permissionModel).toBe('posix-mode');
    expect(
      await states(services, [
        { path: await make('a', 0o600) },
        { path: await make('b', 0o700), ...exe },
        { path: await make('c', 0o700, null), kind },
        { path: await make('d', 0o644) },
        { path: await make('e', 0o600), ...exe },
        { path: await make('f', 0o4600) },
        { path: await make('g', 0o750, null), kind },
      ]),
    ).toEqual(['private', 'private', 'private', ...insecure(4)]);
  });

  posixIt('refuses links, wrong kinds and missing paths', async () => {
    const real = await make('real');
    const alias = path.join(dir, 'alias');
    await fs.symlink(real, alias);
    const linked = await make('linked', 0o644);
    await fs.link(linked, path.join(dir, 'second'));
    for (const action of ['verify', 'restrict'] as const) {
      expect(
        await states(services, [
          { path: alias, action },
          { path: linked, action },
          { path: dir, action },
          { path: real, action, kind: 'directory' },
          { path: '/dev/null', action },
          { path: path.join(dir, 'none'), action },
        ]),
      ).toEqual([...insecure(5), 'unverifiable']);
    }
    expect([await modeOf(linked), await modeOf(real)]).toEqual([0o644, 0o600]);
  });

  posixIt('restricts owned nodes, never another or unknown owner', async () => {
    const [file, sub] = [await make('a', 0o4755), await make('b', 0o777, null)];
    const action = 'restrict';
    expect(
      await states(services, [
        { path: file, action },
        { path: sub, action, kind: 'directory' },
      ]),
    ).toEqual(['private', 'private']);
    expect([await modeOf(file), await modeOf(sub)]).toEqual([0o600, 0o700]);
    const loose = await make('c', 0o644);
    const uid = (await fs.stat(loose)).uid;
    const other = create('linux', { getuid: () => uid + 1 });
    const unknown = create('linux', { getuid: () => undefined });
    expect(await states(other, [{ path: loose, action }])).toEqual(insecure(1));
    expect(await states(unknown, [{ path: loose, action }])).toEqual([
      'unverifiable',
    ]);
    expect(await modeOf(loose)).toBe(0o644);
  });

  posixIt('ignores the Windows foreign-trustee opt-in (CAN-7915)', async () => {
    const [loose, sub] = [await make('a', 0o644), await make('b', 0o755, null)];
    const foreignTrustees = 'accept';
    expect(
      await states(services, [
        { path: loose, foreignTrustees },
        { path: sub, kind: 'directory', foreignTrustees },
      ]),
    ).toEqual(insecure(2));
    expect(
      await services.permissions({
        ...BASE,
        path: sub,
        kind: 'directory',
        action: 'restrict',
        foreignTrustees,
      }),
    ).toEqual({ state: 'private' });
    expect(await modeOf(sub)).toBe(0o700);
  });
});

describe('secure files: rename', () => {
  const services = create('linux');

  it.each(['replace', 'no-replace'] as const)(
    'rejects a multiply linked source in %s mode',
    async (mode) => {
      const from = await make('from');
      const alias = path.join(dir, 'alias');
      const to = path.join(dir, 'to');
      await fs.link(from, alias);
      if (mode === 'replace') await fs.writeFile(to, 'target');
      expect(await codeOf(services.rename({ from, to, mode }))).toBe(
        'not_regular_file',
      );
      expect([await read(from), await read(alias)]).toEqual(['from', 'from']);
      if (mode === 'replace') expect(await read(to)).toBe('target');
      else expect(await codeOf(fs.stat(to))).toBe('ENOENT');
    },
  );

  it.each(['replace', 'no-replace'] as const)(
    'does not retry %s publication against a changed source',
    async (mode) => {
      const [from, to, replacement] = [
        await make('from'),
        await make('to'),
        await make('replacement'),
      ];
      if (mode === 'no-replace') await fs.unlink(to);
      const native = mode === 'replace' ? fs.rename : fs.link;
      const publish = jest.fn(async (a: string, b: string): Promise<void> => {
        if (publish.mock.calls.length > 1) return native(a, b);
        await fs.rename(replacement, a);
        throw fsError('EBUSY');
      });
      const windows = create('win32', {
        operations:
          mode === 'replace' ? { rename: publish } : { link: publish },
        retry,
      });
      expect(await codeOf(windows.rename({ from, to, mode }))).toBe(
        'source_changed',
      );
      expect(publish).toHaveBeenCalledTimes(1);
      expect(await read(from)).toBe('replacement');
      if (mode === 'replace') expect(await read(to)).toBe('to');
      else expect(await codeOf(fs.stat(to))).toBe('ENOENT');
    },
  );

  it('does not retry replacement after the source disappears', async () => {
    const [from, to] = [await make('from'), await make('to')];
    const rename = jest.fn(async (): Promise<void> => {
      await fs.unlink(from);
      throw fsError('EBUSY');
    });
    const windows = create('win32', { operations: { rename }, retry });
    expect(await codeOf(windows.rename({ from, to, mode: 'replace' }))).toBe(
      'source_changed',
    );
    expect(rename).toHaveBeenCalledTimes(1);
    expect(await read(to)).toBe('to');
  });

  it('reports a same-path replace as retaining the source', async () => {
    const from = await make('from');
    expect(await services.rename({ from, to: from, mode: 'replace' })).toEqual(
      RETAINED,
    );
    expect(await read(from)).toBe('from');
  });

  it('observes a recreated source after replacement completes', async () => {
    const [from, to, replacement] = [
      await make('from'),
      await make('to'),
      await make('replacement'),
    ];
    const rename = async (a: string, b: string): Promise<void> => {
      await fs.rename(a, b);
      await fs.rename(replacement, a);
    };
    const changed = create('linux', { operations: { rename } });
    expect(await changed.rename({ from, to, mode: 'replace' })).toEqual({
      ...RENAMED,
      sourceState: 'changed-or-absent',
    });
    expect([await read(from), await read(to)]).toEqual(['replacement', 'from']);
  });

  it('replaces, or publishes without replacing on collision', async () => {
    const [from, to] = [await make('from', 0o600, 'new'), await make('to')];
    const next = path.join(dir, 'next');
    const again = await make('again', 0o600, 'newer');
    const run = (r: Runtime.PlatformRenameRequest): Promise<unknown> =>
      services.rename(r);
    expect(await run({ from, to, mode: 'replace' })).toEqual(RENAMED);
    expect(await read(to)).toBe('new');
    const mid = path.join(dir, 'mid');
    expect(await run({ from: to, to: mid, mode: 'replace' })).toEqual(RENAMED);
    expect(await run({ from: mid, to: next, mode: 'no-replace' })).toEqual(
      RENAMED,
    );
    expect(await codeOf(fs.stat(mid))).toBe('ENOENT');
    expect(await run({ from: again, to: next, mode: 'no-replace' })).toEqual({
      kind: 'exists',
    });
    expect([await read(next), await read(again)]).toEqual(['new', 'newer']);
  });

  posixIt('renames regular files only', async () => {
    const real = await make('real');
    const alias = path.join(dir, 'alias');
    await fs.symlink(real, alias);
    const to = path.join(dir, 'to');
    const requests: Runtime.PlatformRenameRequest[] = [
      { from: real, to: dir, mode: 'replace' },
      ...(['replace', 'no-replace'] as const).flatMap((mode) =>
        [alias, dir].map((from) => ({ from, to, mode })),
      ),
    ];
    for (const request of requests) {
      expect(await codeOf(services.rename(request))).toBe('not_regular_file');
    }
    expect(await read(real)).toBe('real');
  });

  it.each(
    (['linux', 'win32'] as const).flatMap((os) =>
      ['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EMLINK'].map(
        (code) => [os, code] as const,
      ),
    ),
  )('%s fails closed when hard links report %s', async (os, code) => {
    const [from, to] = [await make('from'), path.join(dir, 'to')];
    const link = jest.fn(() => Promise.reject(fsError(code)));
    const unlink = jest.fn(() => Promise.resolve());
    const fake = create(os, { operations: { link, unlink }, retry });
    expect(await codeOf(fake.rename({ from, to, mode: 'no-replace' }))).toBe(
      'hard_links_unsupported',
    );
    expect(link).toHaveBeenCalledTimes(1);
    expect(unlink).not.toHaveBeenCalled();
    expect(await codeOf(fs.stat(to))).toBe('ENOENT');
    expect(await read(from)).toBe('from');
  });

  it('reports a retained source when cleanup fails after publication', async () => {
    const [from, to] = [await make('from'), path.join(dir, 'to')];
    const unlink = jest.fn(() => Promise.reject(fsError('EBUSY')));
    const link = jest.fn(fs.link);
    const windows = create('win32', { operations: { link, unlink }, retry });
    const result = await windows.rename({ from, to, mode: 'no-replace' });
    expect(result).toEqual(RETAINED);
    expect([await read(to), await read(from)]).toEqual(['from', 'from']);
    expect([link.mock.calls.length, unlink.mock.calls.length]).toEqual([1, 3]);
  });

  it.each(['absent', 'replaced', 'replaced-during-unlink'])(
    'distinguishes a source %s after publication',
    async (scenario) => {
      const [from, to] = [
        await make('from', 0o600, 'old'),
        path.join(dir, 'to'),
      ];
      const change = async (): Promise<void> => {
        await fs.unlink(from);
        if (scenario !== 'absent') await fs.writeFile(from, 'replacement');
      };
      const link = async (a: string, b: string): Promise<void> => {
        await fs.link(a, b);
        if (scenario !== 'replaced-during-unlink') await change();
      };
      const unlink = async (): Promise<void> => {
        await change();
        throw fsError('EBUSY');
      };
      const swapped = create('linux', { operations: { link, unlink } });
      expect(await swapped.rename({ from, to, mode: 'no-replace' })).toEqual({
        ...RENAMED,
        sourceState: 'changed-or-absent',
      });
      expect(await read(to)).toBe('old');
      if (scenario === 'absent')
        expect(await codeOf(fs.stat(from))).toBe('ENOENT');
      else expect(await read(from)).toBe('replacement');
    },
  );

  (process.platform === 'win32' || process.getuid?.() === 0 ? it.skip : it)(
    'reports unknown when source identity cannot be read after failed cleanup',
    async () => {
      const [from, to] = [await make('from'), path.join(dir, 'to')];
      const unlink = async (): Promise<void> => {
        await fs.chmod(dir, 0);
        throw fsError('EBUSY');
      };
      try {
        expect(
          await create('linux', { operations: { unlink } }).rename({
            from,
            to,
            mode: 'no-replace',
          }),
        ).toEqual({ ...RENAMED, sourceState: 'unknown' });
      } finally {
        await fs.chmod(dir, 0o700);
      }
      expect([await read(from), await read(to)]).toEqual(['from', 'from']);
    },
  );

  it('does not retry cleanup against a replacement source', async () => {
    const [from, to] = [await make('from'), path.join(dir, 'to')];
    let first = true;
    const unlink = async (target: string): Promise<void> => {
      if (!first) return fs.unlink(target);
      first = false;
      await fs.unlink(target);
      await fs.writeFile(target, 'replacement');
      throw fsError('EBUSY');
    };
    const services = create('win32', { operations: { unlink }, retry });
    expect(await services.rename({ from, to, mode: 'no-replace' })).toEqual({
      ...RENAMED,
      sourceState: 'changed-or-absent',
    });
    expect(await read(from)).toBe('replacement');
    expect(await read(to)).toBe('from');
  });

  it.each(['source', 'target'])(
    'preserves a swapped %s on failed publication',
    async (swappedPath) => {
      const [from, to] = [await make('from'), path.join(dir, 'to')];
      const link = async (a: string, b: string): Promise<void> => {
        if (swappedPath === 'target') await fs.link(a, b);
        const changed = swappedPath === 'source' ? a : b;
        const original = await fs.stat(changed, { bigint: true });
        const replacement = await make('replacement');
        expect((await fs.stat(replacement, { bigint: true })).ino).not.toBe(
          original.ino,
        );
        await fs.rename(replacement, changed);
        if (swappedPath === 'source') await fs.link(a, b);
      };
      const swapped = create('linux', { operations: { link } });
      expect(
        await codeOf(swapped.rename({ from, to, mode: 'no-replace' })),
      ).toBe('source_changed');
      expect(await read(from)).toBe(
        swappedPath === 'source' ? 'replacement' : 'from',
      );
      if (swappedPath === 'target') expect(await read(to)).toBe('replacement');
      else expect(await codeOf(fs.stat(to))).toBe('ENOENT');
    },
  );

  it('retries Windows lock errors within a bounded budget only', async () => {
    const [from, to] = [await make('from', 0o600, 'new'), await make('to')];
    let failures = 2;
    const rename = jest.fn(async (a: string, b: string): Promise<void> => {
      if (failures-- > 0) throw fsError('EBUSY');
      await fs.rename(a, b);
    });
    const windows = create('win32', { operations: { rename }, retry });
    await windows.rename({ from, to, mode: 'replace' });
    expect(rename).toHaveBeenCalledTimes(3);
    const source = await make('source', 0o600, 'kept');
    const cases = [
      ['win32', 'EPERM', 10],
      ['win32', 'EXDEV', 1],
      ['darwin', 'EBUSY', 1],
    ] as const;
    for (const [os, code, calls] of cases) {
      const fails = jest.fn(() => Promise.reject(fsError(code)));
      const stuck = create(os, { operations: { rename: fails }, retry: wait });
      const request = { from: source, to, mode: 'replace' } as const;
      expect(await codeOf(stuck.rename(request))).toBe(code);
      expect(fails).toHaveBeenCalledTimes(calls);
    }
    expect([await read(to), await read(source)]).toEqual(['new', 'kept']);
  });
});

describe('secure files: syncDirectory', () => {
  posixIt('flushes a POSIX directory and propagates open errors', async () => {
    const services = create('linux');
    expect(await services.syncDirectory(dir)).toBe('flushed');
    const missing = services.syncDirectory(path.join(dir, 'none'));
    expect(await codeOf(missing)).toBe('ENOENT');
  });

  it('closes the handle when fsync fails, on POSIX and Windows alike', async () => {
    const close = jest.fn(() => Promise.resolve());
    const sync = jest.fn((): Promise<void> => Promise.reject(fsError('EIO')));
    const openDirectory = jest.fn(() => Promise.resolve({ sync, close }));
    const posix = create('darwin', { operations: { openDirectory } });
    await expect(posix.syncDirectory(dir)).rejects.toMatchObject({
      name: 'DirectoryFlushError',
      stage: 'flush',
      code: 'EIO',
    });
    expect(close).toHaveBeenCalledTimes(1);
    close.mockImplementationOnce(() => Promise.reject(fsError('EBADF')));
    expect(await codeOf(posix.syncDirectory(dir))).toBe('EIO');
    const windows = create('win32', { operations: { openDirectory } });
    expect(windows.permissionModel).toBe('windows-dacl');
    expect(await codeOf(windows.syncDirectory(dir))).toBe('EIO');
    sync.mockImplementationOnce(() => Promise.resolve());
    expect(await windows.syncDirectory(dir)).toBe('flushed');
    expect(openDirectory).toHaveBeenCalledTimes(4);
  });

  const windowsIt = process.platform === 'win32' ? it : it.skip;
  windowsIt('flushes a real Windows directory read-write', async () => {
    const services = create('win32');
    await make('child');
    await fs.rename(path.join(dir, 'child'), path.join(dir, 'renamed'));
    expect(await services.syncDirectory(dir)).toBe('flushed');
    const missing = services.syncDirectory(path.join(dir, 'none'));
    expect(await codeOf(missing)).toBe('ENOENT');
  });
});
