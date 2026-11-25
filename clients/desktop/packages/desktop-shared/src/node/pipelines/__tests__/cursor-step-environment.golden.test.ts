// Golden: a Cursor pipeline step on Linux never hands its own loader or
// shell-startup variables to cursor-agent. The production pipeline runner
// launches a bash launcher (as Linux's `cursor-agent` is) through the real
// provider-process spawner for the version probe and for the turn. Only the
// ACP turn driver is replaced, by one that launches the same executable with
// the environment the runner gave it. Each launch records its environment, and
// the step's LD_AUDIT/LD_PRELOAD, BASH_ENV, SHELLOPTS=xtrace and PS4 would
// each leave a visible trace (an ld.so error, or a marker file) if bash or the
// loader ever saw them.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'; // prettier-ignore
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as TurnDriver from '../../cursor/turn-driver';

type TurnInput = Parameters<typeof TurnDriver.runCursorTurn>[0];

jest.mock('../../cursor/turn-driver', () => ({
  runCursorTurn: async (input: TurnInput): Promise<object> => {
    // What the real driver does first: start the launcher with this env.
    const child = input.providerProcess.spawner({
      command: input.launch.command,
      args: [...input.launch.prefix, 'acp'],
      cwd: input.cwd,
      env: input.env,
      owner: input.providerProcess.owner,
    });
    child.stdin?.end();
    child.stdout.resume();
    child.stderr.on('data', (chunk: Buffer) => mockStderr.push(String(chunk)));
    await new Promise((resolve) => child.once('close', resolve));
    return {
      isError: true,
      cancelled: false,
      message: 'stub turn',
      contextLost: false,
      inheritedContextDelivered: false,
      responseText: '',
    };
  },
}));

const mockStderr: string[] = [];

const linux = process.platform === 'linux' ? describe : describe.skip;
linux('Cursor pipeline step environment on Linux', () => {
  let root: string;
  const savedDataDir = process.env.CANOPY_DATA_DIR;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cursor-step-env-'));
    process.env.CANOPY_DATA_DIR = join(root, 'data');
    mockStderr.length = 0;
  });
  afterEach(() => {
    if (savedDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
    else process.env.CANOPY_DATA_DIR = savedDataDir;
    rmSync(root, { recursive: true, force: true });
  });

  /**
   * Runs one step through the production runner over a bash `cursor-agent`
   * stand-in. The app's own environment carries an LD_LIBRARY_PATH, which
   * must survive; `step` is the step's declared environment.
   */
  async function runStep(
    step: (paths: { markers: string; root: string }) => Record<string, string>,
  ): Promise<{
    launches: string[][];
    markers: string[];
    stderr: string;
    transcript: string;
    inheritedLibraryPath: string;
  }> {
    const { runCursorPromptWithDriver } =
      await import('../cursor-prompt-runner');
    const { CURSOR_RUNTIME_VERSION } =
      await import('../../cursor/runtime-metadata');
    const { getCursorRuntimeTarget } =
      await import('../../../lib/cursor-runtime-targets');
    const { spawnProviderProcessDirect } =
      await import('../../provider-process/spawn');
    const target = getCursorRuntimeTarget('linux', 'x64');
    if (!target) throw new Error('missing linux-x64 Cursor target');

    const runtime = join(root, 'runtime');
    const records = join(root, 'records');
    const markers = join(root, 'markers');
    const inheritedLibraryPath = join(root, 'inherited-lib');
    for (const directory of [
      runtime,
      records,
      markers,
      inheritedLibraryPath,
      join(root, 'cwd'),
      join(root, 'data'),
    ])
      mkdirSync(directory, { recursive: true });
    const launcher = join(runtime, 'cursor-agent');
    writeFileSync(
      launcher,
      [
        '#!/usr/bin/env bash',
        `env > '${records}'/"$$".env`,
        `case " $* " in *" --version "*) echo '${CURSOR_RUNTIME_VERSION}' ;; esac`,
        'exit 0',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );

    const stderr: string[] = [];
    const result = await runCursorPromptWithDriver(
      {
        cwd: join(root, 'cwd'),
        prompt: 'hello',
        environment: { ...step({ markers, root }), STEP_VALUE: 'kept' },
        model: 'cursor-default',
        totalTimeoutMs: 60_000,
        permissionPreset: 'read_only',
        executionsDir: join(root, 'executions'),
        executionId: 'execution',
        jobId: 'job',
        stepId: 'step',
        attempt: 1,
      },
      {
        launch: { command: launcher, prefix: [] },
        target,
        baseEnvironment: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          LD_LIBRARY_PATH: inheritedLibraryPath,
        },
        spawner: (request) => {
          const child = spawnProviderProcessDirect(request);
          child.stderr.on('data', (chunk: Buffer) =>
            stderr.push(String(chunk)),
          );
          return child;
        },
      },
    );
    return {
      launches: readdirSync(records).map((file) =>
        readFileSync(join(records, file), 'utf8').split('\n'),
      ),
      markers: readdirSync(markers),
      stderr: [...stderr, ...mockStderr].join(''),
      transcript: result.transcript,
      inheritedLibraryPath,
    };
  }

  function expectNoneReached(run: Awaited<ReturnType<typeof runStep>>): void {
    // The probe and the turn both launched, with the step's own value and the
    // app's inherited library path.
    expect(run.launches.length).toBeGreaterThanOrEqual(2);
    for (const seen of run.launches) {
      expect(seen).toContain('STEP_VALUE=kept');
      expect(seen).toContain(`LD_LIBRARY_PATH=${run.inheritedLibraryPath}`);
      expect(
        seen.filter(
          (line) =>
            /^(LD_|BASH_ENV=|SHELLOPTS=|PS4=)/.test(line) &&
            line !== `LD_LIBRARY_PATH=${run.inheritedLibraryPath}`,
        ),
      ).toEqual([]);
    }
    // Neither bash nor the loader acted on anything the step supplied.
    expect(run.markers).toEqual([]);
    expect(run.stderr).not.toMatch(/ld\.so|missing/);
  }

  it('never reaches the version probe or the turn', async () => {
    const run = await runStep(({ markers, root: dir }) => {
      const startup = join(dir, 'bash-env.sh');
      writeFileSync(startup, `touch '${markers}/bash-env'\n`);
      const preload = join(dir, 'missing-preload.so');
      return {
        LD_PRELOAD: preload,
        LD_AUDIT: preload,
        LD_LIBRARY_PATH: join(dir, 'step-lib'),
        BASH_ENV: startup,
        SHELLOPTS: 'xtrace',
        PS4: `$(touch '${markers}/ps4')`,
      };
    });
    expectNoneReached(run);
    // The step's transcript names what was withheld.
    expect(run.transcript).toContain(
      'Cursor does not receive these step environment variables: BASH_ENV, LD_AUDIT, LD_LIBRARY_PATH, LD_PRELOAD, PS4, SHELLOPTS.',
    );
  });

  it('refuses a key a child would read as a refused name', async () => {
    // A child reads `BASH_ENV=<dir>/startup` = `sh` as BASH_ENV, with the
    // value `<dir>/startup=sh`, and likewise for LD_PRELOAD.
    const run = await runStep(({ markers, root: dir }) => {
      writeFileSync(join(dir, 'startup=sh'), `touch '${markers}/bash-env'\n`);
      return {
        [`BASH_ENV=${join(dir, 'startup')}`]: 'sh',
        [`LD_PRELOAD=${join(dir, 'missing')}`]: 'preload.so',
      };
    });
    expectNoneReached(run);
    expect(run.transcript).toContain(
      'Cursor does not receive these step environment variables: BASH_ENV=…, LD_PRELOAD=….',
    );
    expect(run.transcript).not.toContain(root);
  });
});
