// CAN-3238: real POSIX fd-0 closure through the retained Git and replica
// production transports. The spawn seam substitutes only an adversarial child;
// promises, error ownership, teardown and purge journal are product code.
import * as childProcess from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { faultScript, NativePipe, type Closure } from './native-pipe';

jest.mock('node:child_process', () => ({
  ...jest.requireActual<typeof childProcess>('node:child_process'),
  execFile: jest.fn(),
  spawn: jest.fn(),
}));
jest.mock('../../lib/git-executable', () => ({
  getResolvedGitExecutableForSpawn: (): Promise<string> =>
    Promise.resolve('git'),
}));
jest.mock('@canopy/execution-engine/pipelines/config-paths', () => ({
  getEnhancedEnv: (): NodeJS.ProcessEnv => ({ ...process.env }),
}));

jest.mock('../../lib/node-runtime', () => ({
  getDesktopNodeRuntime: (): Promise<{
    nodeProcess: { command: string };
  }> =>
    Promise.resolve({
      nodeProcess: { command: process.execPath },
    }),
}));

import { applyIndexPatch, checkIgnoredPaths } from '../../lib/git';
import { SharedContainerReplicaStore } from '../../shared-containers/replica/store';

const native = jest.requireActual<typeof childProcess>('node:child_process');
const mockExecFile = jest.mocked(childProcess.execFile);
const mockSpawn = jest.mocked(childProcess.spawn);
const posix = process.platform !== 'win32' ? describe : describe.skip;

jest.setTimeout(15_000);

posix('CAN-3238 native Git stdin and shared-container cleanup', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'can3238-'));
    mockExecFile.mockImplementation(native.execFile);
    mockSpawn.mockImplementation(native.spawn);
  });
  afterEach(async () => {
    mockExecFile.mockReset();
    mockSpawn.mockReset();
    await rm(directory, { recursive: true, force: true });
  });

  it.each<['check-ignore' | 'patch', Closure]>([
    ['check-ignore', 'before'],
    ['check-ignore', 'during'],
    ['patch', 'before'],
    ['patch', 'during'],
  ])(
    'Git %s closes %s input, rejects once and never replays',
    async (operation, closure) => {
      const fixture = new NativePipe(`git-${operation}`, closure);
      mockExecFile.mockImplementationOnce(
        (_command, _args, _options, callback) => {
          const child = native.execFile(
            process.execPath,
            ['--input-type=commonjs', '--eval', faultScript(closure, false)],
            { cwd: directory, timeout: 6000 },
            callback,
          );
          fixture.attach(child);
          return child;
        },
      );
      try {
        const pending =
          operation === 'patch'
            ? applyIndexPatch(
                directory,
                `diff --git a/a b/a\n${'x'.repeat(8 * 1024 * 1024)}`,
                { unidiffZero: false },
              )
            : // The second chunk must not be submitted after the first fails.
              checkIgnoredPaths(
                directory,
                Array.from(
                  { length: 5001 },
                  (_, i) => `file-${i}-${'x'.repeat(1024)}`,
                ),
              );
        expect(await fixture.rejection(pending)).toBe(fixture.inputError);
        expect(mockExecFile).toHaveBeenCalledTimes(1);
        await fixture.observedClosure();
        // Git's execFile owner does not terminate on input error; the fixture
        // explicitly reaps its bounded child, including the later callback.
        await fixture.dispose();
        fixture.assertNativeFailure();
        expect(mockExecFile).toHaveBeenCalledTimes(1);
      } finally {
        await fixture.dispose();
        fixture.report();
      }
    },
  );

  it.each<Closure>(['before', 'during'])(
    'cleanup closes %s input, fences failure and recovers only explicitly',
    async (closure) => {
      const root = join(directory, 'replica');
      const store = new SharedContainerReplicaStore(root);
      const markerPath = join(directory, '.replica.identity.json');
      await store.prepareContainerForSync('container');
      await mkdir(join(root, 'container'));
      await writeFile(
        join(root, 'container', 'plaintext'),
        'retain until explicit purge',
      );
      const fixture = new NativePipe('shared-container-cleanup', closure);
      mockSpawn.mockImplementationOnce((_command, _args, options) => {
        const child = native.spawn(
          process.execPath,
          ['--input-type=commonjs', '--eval', faultScript(closure, true)],
          { ...options, stdio: ['pipe', 'pipe', 'pipe'] },
        );
        fixture.attach(child);
        return child;
      });
      try {
        expect(await fixture.rejection(store.purgeAllBytes())).toBe(
          fixture.inputError,
        );
        expect(mockSpawn).toHaveBeenCalledTimes(1);
        await fixture.dispose();
        fixture.assertNativeFailure();
        const events = fixture.events.map(({ event }) => event);
        expect(events.indexOf('exit')).toBeLessThan(
          events.indexOf('rejection'),
        );
        expect(events).not.toContain('fixture-terminate');
        const marker: unknown = JSON.parse(await readFile(markerPath, 'utf8'));
        expect(marker).toEqual(expect.objectContaining({ state: 'purging' }));
        if (
          !marker ||
          typeof marker !== 'object' ||
          !('quarantine' in marker) ||
          typeof marker.quarantine !== 'string'
        )
          throw new Error('Missing purge journal');
        expect(
          await readFile(
            join(directory, marker.quarantine, 'container', 'plaintext'),
            'utf8',
          ),
        ).toBe('retain until explicit purge');
        await expect(store.prepareContainerForSync('blocked')).rejects.toThrow(
          'cleanup is incomplete',
        );
        expect(mockSpawn).toHaveBeenCalledTimes(1);

        // Explicit recovery runs the original cleanup script, not a substitute.
        fixture.record('explicit-recovery');
        await store.purgeAllBytes();
        expect(mockSpawn).toHaveBeenCalledTimes(2);
        expect(JSON.parse(await readFile(markerPath, 'utf8'))).toEqual({
          version: 1,
          state: 'absent',
        });
        expect(await readdir(directory)).toEqual(['.replica.identity.json']);
        await store.prepareContainerForSync('replacement');
        await mkdir(join(root, 'replacement'));
        await writeFile(
          join(root, 'replacement', 'new-bytes'),
          'replacement survives',
        );
        expect(
          await readFile(join(root, 'replacement', 'new-bytes'), 'utf8'),
        ).toBe('replacement survives');
        expect(mockSpawn).toHaveBeenCalledTimes(2);
        fixture.record('replacement-survived');
      } finally {
        await fixture.dispose();
        fixture.report();
      }
    },
  );
});
