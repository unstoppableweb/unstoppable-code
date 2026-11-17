import type * as Runtime from '@canopy/core-runtime';
import { createProcessIdentifier } from '../supervision/identify';
import { createProcessInspector } from '../supervision/inspect';
import { type SupervisionOperations } from '../supervision/shared';

type Os = Runtime.PlatformOperatingSystem;
const PID = 4242;
const BOOT_PATH = '/proc/sys/kernel/random/boot_id';
const STAT_PATH = `/proc/${PID}/stat`;
const BOOT = '0F1E2D3C-4B5A-6978-8796-A5B4C3D2E1F0\n';
const fail = (code: string): Error => Object.assign(new Error(code), { code });
const exit1 = Object.assign(new Error('Command failed'), { code: 1 });
const stat = (
  comm = 'node',
  state = 'S',
  start = '987654',
  pid = PID,
): string => `${pid} (${comm}) ${state} ${'1 '.repeat(18)}${start} 7\n`;
const PS = `${PID} Ss   Thu Oct  8 06:23:26 2026   \n`;
const STARTED = '20261008062326123456';
const TICKS = '134359142061234560';
const receipt = (ticks = TICKS, pid = PID): string =>
  `canopy-process-v1 ${pid} ${ticks}\n`;
const A = { state: 'absent' };
const anyReason: unknown = expect.any(String);
const U = { state: 'unverifiable', reason: anyReason };
const R = (startIdentity: string): Runtime.PlatformProcessInspection => ({
  state: 'running',
  startIdentity,
});
const LINUX_ID = `linux:v1:${PID}:${BOOT.trim().toLowerCase()}:987654`;

/** `presence`: errno thrown by each kill(pid, 0); the last entry repeats. */
interface Fake {
  readonly os: Os;
  readonly presence?: ReadonlyArray<string | null>;
  readonly files?: Readonly<Record<string, string | Error>>;
  readonly output?: string | Error;
}
function harness(
  fake: Fake,
  overrides: Partial<SupervisionOperations> = {},
): Runtime.PlatformSupervisionServices['inspectProcess'] {
  let kills = 0;
  const presence = fake.presence ?? [null];
  return createProcessInspector(fake.os, {
    kill: (): void => {
      const code = presence[Math.min(kills++, presence.length - 1)];
      if (code) throw fail(code);
    },
    readText: (file) => settle(fake.files?.[file] ?? fail('ENOENT')),
    run: () => settle(fake.output ?? ''),
    windowsProcess: () => settle(fake.output ?? ''),
    systemRoot: () => 'C:\\Windows',
    selfPid: 1000,
    ...overrides,
  });
}
const settle = (value: string | Error): Promise<string> =>
  typeof value === 'string' ? Promise.resolve(value) : Promise.reject(value);

const GONE = [null, 'ESRCH'];
const fake =
  (os: Os) =>
  (value: string | Error, presence?: Fake['presence']): Fake =>
    os === 'linux'
      ? { os, presence, files: { [STAT_PATH]: value, [BOOT_PATH]: BOOT } }
      : { os, presence, output: value };
const [L, D, W] = (['linux', 'darwin', 'win32'] as const).map(fake);
const BAD_BOOT = { ...L(stat()), files: { [STAT_PATH]: stat() } };
const cases: ReadonlyArray<[string, Fake, unknown]> = [
  ['linux comm ") ("', L(stat(') (x')), R(LINUX_ID)],
  ['linux zombie', L(stat('node', 'Z')), A],
  ['linux dead', L(stat('node', 'X')), A],
  ['linux lowercase dead', L(stat('node', 'x')), A],
  ['linux unknown state', L(stat('node', 'Q')), U],
  ['linux stat missing under EPERM', L(fail('ENOENT'), ['EPERM']), U],
  ['linux stat denied while alive', L(fail('EACCES')), U],
  ['linux stat missing, then gone', L(fail('ENOENT'), GONE), A],
  ['linux malformed, then gone', L('junk', GONE), A],
  ['linux stat pid mismatch', L(stat('node', 'S', '9', 7)), U],
  ['linux float starttime', L(stat('node', 'S', '1.5e3')), U],
  ['linux truncated stat', L(`${PID} (node) S 1 2\n`), U],
  ['linux missing boot_id', BAD_BOOT, U],
  ['linux malformed boot_id', { ...BAD_BOOT, files: { [BOOT_PATH]: 'x' } }, U],
  ['darwin C-locale lstart', D(PS), R(`darwin:v1:${PID}:1791440606`)],
  ['darwin zombie', D(`${PID} Z+ Thu Oct  8 06:23:26 2026`), A],
  ['darwin wrong weekday', D(PS.replace('Thu', 'Fri')), U],
  ['darwin Feb 30', D(`${PID} S Mon Feb 30 06:23:26 2026`), U],
  ['darwin hour 24', D(PS.replace('06:23', '24:23')), U],
  ['darwin localized', D(`${PID} S jeu.  8 oct. 06:23:26 2026`), U],
  ['darwin pid mismatch', D(PS.replace(`${PID}`, '7')), U],
  ['darwin two rows', D(PS + PS), U],
  ['darwin exit 1 alive', D(exit1), U],
  ['darwin exit 1 gone', D(exit1, GONE), A],
  ['darwin empty alive', D(''), U],
  ['win32 native receipt', W(receipt()), R(`win32:v1:${PID}:${STARTED}`)],
  ['win32 pid mismatch', W(receipt(TICKS, 7)), U],
  ['win32 default', W(receipt('0')), U],
  ['win32 sub-microsecond default', W(receipt('9')), U],
  ['win32 invalid ticks', W(receipt('wat')), U],
  ['win32 overflow', W(receipt('2650467744000000000')), U],
  ['win32 blank', W(''), U],
  ['win32 old CIM', W('null', GONE), U],
  ['win32 multiple receipts', W(receipt() + receipt()), U],
  ['win32 sentinel alive', W('canopy-process-v1 absent\n'), U],
  ['win32 sentinel EPERM', W('canopy-process-v1 absent\n', ['EPERM']), U],
  ['win32 sentinel gone', W('canopy-process-v1 absent\n', GONE), A],
  ['win32 query failure then gone', W(exit1, GONE), U],
];
it.each(cases)('%s', async (_name, fake, expected) => {
  await expect(harness(fake)({ pid: PID })).resolves.toEqual(expected);
});

describe.each(['linux', 'darwin', 'win32'] as const)('%s probe', (os) => {
  it('validates PIDs, permits self and short-circuits ESRCH', async () => {
    for (const pid of [0, 1, -5, 2.5, Number.NaN])
      await expect(harness({ os })({ pid })).rejects.toThrow('PID');
    const readText = jest.fn(() => Promise.resolve(''));
    const run = jest.fn(() => Promise.resolve(''));
    const gone = harness(
      { os, presence: ['ESRCH'] },
      { selfPid: PID, readText, run },
    );
    await expect(gone({ pid: PID })).resolves.toEqual(A);
    expect([readText.mock.calls, run.mock.calls]).toEqual([[], []]);
    const odd = harness({ os, presence: ['EINVAL'] });
    await expect(odd({ pid: PID })).resolves.toEqual(U);
  });

  it('rejects cancellation before, during and after the query', async () => {
    const kill = jest.fn();
    const early = harness({ os }, { kill });
    const aborted = AbortSignal.abort();
    await expect(early({ pid: PID, signal: aborted })).rejects.toThrow();
    expect(kill).not.toHaveBeenCalled();
    const controller = new AbortController();
    const abortThen = (value: string | Error): Promise<string> => {
      controller.abort();
      return settle(value);
    };
    const late = harness(
      { ...L(stat()), os },
      {
        readText: (file) => abortThen(file === BOOT_PATH ? BOOT : stat()),
        run: () => abortThen(fail('ABORT_ERR')),
        windowsProcess: () => abortThen(fail('ABORT_ERR')),
      },
    );
    const { signal } = controller;
    await expect(late({ pid: PID, signal })).rejects.toThrow();
  });
});

it('runs darwin ps with fixed arguments in the C locale and UTC', async () => {
  const run = jest.fn<
    Promise<string>,
    Parameters<SupervisionOperations['run']>
  >(() => Promise.resolve(PS));
  const inspect = harness(D(PS), { run });
  await inspect({ pid: PID });
  const args = ['-o', 'pid=,stat=,lstart=', '-p', `${PID}`];
  const env = { LC_ALL: 'C', TZ: 'UTC0' };
  expect(run.mock.calls).toEqual([['/bin/ps', args, undefined, env]]);
});

it('validates the Windows PID domain before probing', async () => {
  const kill = jest.fn();
  for (const pid of [2147483648, 4294967295, 4294967296, Infinity])
    await expect(harness({ os: 'win32' }, { kill })({ pid })).rejects.toThrow(
      'PID',
    );
  expect(kill).not.toHaveBeenCalled();
});

it('caches a validated boot_id but never a failed read', async () => {
  let bootReads = 0;
  const inspect = harness(L(stat()), {
    readText: (file) =>
      file !== BOOT_PATH
        ? settle(stat())
        : settle(++bootReads === 1 ? fail('EIO') : BOOT),
  });
  await expect(inspect({ pid: PID })).resolves.toEqual(U);
  await expect(inspect({ pid: PID })).resolves.toEqual(R(LINUX_ID));
  await expect(inspect({ pid: PID })).resolves.toEqual(R(LINUX_ID));
  expect(bootReads).toBe(2);
});

describe('pending Linux reads', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });
  it.each([
    [BOOT_PATH, 'abort'],
    [BOOT_PATH, 'deadline'],
    [STAT_PATH, 'abort'],
    [STAT_PATH, 'deadline'],
  ])('%s settles on %s and permits a retry', async (path, stop) => {
    const controller = new AbortController();
    const removed = jest.spyOn(controller.signal, 'removeEventListener');
    const reason = new Error('inspection cancelled');
    let finish: (text: string) => void = () => {};
    let readSignal: AbortSignal | undefined;
    let blocked = false;
    const inspect = harness(L(stat()), {
      readText: (file: string, signal?: AbortSignal) => {
        if (file !== path || blocked)
          return settle(file === BOOT_PATH ? BOOT : stat());
        blocked = true;
        readSignal = signal;
        return new Promise<string>((resolve) => {
          finish = resolve;
        });
      },
    });
    const result = inspect({ pid: PID, signal: controller.signal }).catch(
      (error: unknown) => error,
    );
    await jest.advanceTimersByTimeAsync(0);
    expect(blocked).toBe(true);
    await expect(
      Promise.race([result, Promise.resolve('pending')]),
    ).resolves.toBe('pending');
    if (stop === 'abort') controller.abort(reason);
    else await jest.advanceTimersByTimeAsync(4000);
    await jest.advanceTimersByTimeAsync(0);
    const expected = stop === 'abort' ? reason : U;
    expect(await Promise.race([result, Promise.resolve('pending')])).toEqual(
      expected,
    );
    expect(readSignal?.aborted).toBe(true);
    expect(removed).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(jest.getTimerCount()).toBe(0);
    await expect(inspect({ pid: PID })).resolves.toEqual(R(LINUX_ID));
    finish(
      path === BOOT_PATH
        ? '11111111-1111-1111-1111-111111111111\n'
        : stat('late', 'S', '1'),
    );
    await jest.advanceTimersByTimeAsync(0);
    await expect(inspect({ pid: PID })).resolves.toEqual(R(LINUX_ID));
    await expect(result).resolves.toEqual(expected);
  });
});

it('fresh Windows reads distinguish the same PID with changed creation and recover from unavailable identity', async () => {
  const observations = [receipt('0'), receipt(), receipt('134359142061234570')];
  const windowsProcess = jest.fn(() =>
    settle(observations.shift() ?? receipt()),
  );
  const run = jest.fn(() => settle('must not run PowerShell'));
  const inspect = harness({ os: 'win32' }, { windowsProcess, run });
  await expect(inspect({ pid: PID })).resolves.toEqual(U);
  await expect(inspect({ pid: PID })).resolves.toEqual(
    R(`win32:v1:${PID}:${STARTED}`),
  );
  await expect(inspect({ pid: PID })).resolves.toEqual(
    R(`win32:v1:${PID}:20261008062326123457`),
  );
  expect(windowsProcess).toHaveBeenCalledTimes(3);
  expect(run).not.toHaveBeenCalled();
});

it('preserves the largest Windows PID and never converts query failures to absence', async () => {
  const windowsProcess = jest.fn(() => settle(receipt(TICKS, 2147483647)));
  await expect(
    harness({ os: 'win32' }, { windowsProcess })({ pid: 2147483647 }),
  ).resolves.toEqual(R(`win32:v1:2147483647:${STARTED}`));
  expect(windowsProcess).toHaveBeenCalledWith(2147483647, undefined);
  for (const code of ['EACCES', 'EPERM', 'ETIMEDOUT', 'ENOENT'])
    await expect(harness(W(fail(code), GONE))({ pid: PID })).resolves.toEqual(
      U,
    );
});

/**
 * CAN-7026: a process that exits between the inspector's read and the detail
 * reads is a zombie until its parent reaps it. Its `/proc/PID/exe` or `lsof`
 * row is gone while kill(pid, 0) still finds it, so only a second inspection
 * tells an exit from an unreadable live process.
 */
describe('identifying a process that exits while it is read', () => {
  const PGID = 4300;
  function identifier(
    os: 'linux' | 'darwin',
    exits: boolean,
  ): Runtime.PlatformSupervisionServices['identifyProcess'] {
    let inspections = 0;
    const exitedAfterFirst = (): boolean => exits && inspections++ > 0;
    const ops: SupervisionOperations = {
      kill: (): void => undefined,
      readText: (file) => {
        if (file === BOOT_PATH) return settle(BOOT);
        if (file !== STAT_PATH) return settle(fail('ENOENT'));
        // The inspector's reads count; the group read sees the same row.
        return settle(stat('sleep', exitedAfterFirst() ? 'Z' : 'S'));
      },
      readLink: () => settle(fail('ENOENT')),
      run: (_file, args) =>
        args.includes('pid=,stat=,lstart=')
          ? settle(
              exitedAfterFirst() ? `${PID} Z+ Thu Oct  8 06:23:26 2026` : PS,
            )
          : args.includes('pgid=')
            ? settle(`${PGID}\n`)
            : settle(''),
      systemRoot: () => '/',
      selfPid: 1000,
    };
    return createProcessIdentifier(os, ops, createProcessInspector(os, ops));
  }

  it.each(['linux', 'darwin'] as const)(
    '%s: an exit between the reads is absent, not unverifiable',
    async (os) => {
      await expect(identifier(os, true)?.({ pid: PID })).resolves.toEqual(A);
    },
  );

  it.each(['linux', 'darwin'] as const)(
    '%s: a live process whose executable cannot be read stays unverifiable',
    async (os) => {
      await expect(identifier(os, false)?.({ pid: PID })).resolves.toEqual(U);
    },
  );
});
