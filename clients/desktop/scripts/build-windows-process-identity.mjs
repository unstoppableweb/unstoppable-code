import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertProcessHelper,
  PROCESS_HELPER,
  PROCESS_SOURCE,
  PROCESS_FLAGS,
  PROCESS_LINK,
  processSourceDigest,
  processImageDigest,
  runProcessBuildCommand,
  withProcessBuildArtifacts,
} from './lib/windows-process-helper.mjs';

// Keep native diagnostics visible even when a parent test only renders Error.message.
async function run(file, args, options) {
  try {
    return await runProcessBuildCommand(file, args, options);
  } catch (error) {
    throw new Error(
      `Windows helper command failed: ${file} ${args.join(' ')}\nstderr:\n${error?.stderr ?? '(not captured)'}\nstdout tail:\n${String(error?.stdout ?? '').slice(-1500)}`,
      { cause: error },
    );
  }
}

const root = fileURLToPath(new URL('..', import.meta.url));
if (
  process.platform !== 'win32' ||
  process.arch !== 'x64' ||
  (process.argv.length !== 2 &&
    !(process.argv.length === 3 && process.argv[2] === '--test'))
)
  throw new Error('Build the Windows process helper with Windows x64 Node');
let fresh = false;
try {
  assertProcessHelper(root);
  fresh = true;
} catch {
  /* First or stale build. */
}
if (!fresh || process.argv[2] === '--test') {
  const programFiles = process.env['ProgramFiles(x86)'];
  const systemRoot = process.env.SystemRoot;
  if (!programFiles || !systemRoot)
    throw new Error('Windows C++ build tools required');
  const found = await run(
    join(programFiles, 'Microsoft Visual Studio/Installer/vswhere.exe'),
    [
      '-latest',
      '-products',
      '*',
      '-requires',
      'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
      '-property',
      'installationPath',
    ],
    { timeout: 15000 },
  );
  const installation = found.stdout.trim();
  if (!/^[A-Za-z]:\\/.test(installation) || /["%\r\n&|<>^!]/.test(installation))
    throw new Error('Invalid compiler installation');
  const environment = await run(
    join(systemRoot, 'System32/cmd.exe'),
    [
      '/d',
      '/s',
      '/c',
      `"call "${join(installation, 'Common7/Tools/VsDevCmd.bat')}" -no_logo -arch=x64 >nul && set"`,
    ],
    { windowsVerbatimArguments: true, timeout: 30000, maxBuffer: 1048576 },
  );
  const env = Object.fromEntries(
    environment.stdout.split(/\r?\n/).flatMap((line) => {
      const at = line.indexOf('=');
      return at > 0 ? [[line.slice(0, at), line.slice(at + 1)]] : [];
    }),
  );
  const directory = join(root, '.cache/bin/win32-x64');
  await mkdir(directory, { recursive: true });
  const testing = process.argv[2] === '--test';
  const binary = join(directory, PROCESS_HELPER);
  const temporary = `${binary}.${randomUUID()}.exe`;
  const sourceDigest = processSourceDigest(root);
  await withProcessBuildArtifacts([temporary, `${temporary}.obj`], async () => {
    await run(
      'cl.exe',
      [
        ...PROCESS_FLAGS,
        join(
          root,
          testing ? PROCESS_SOURCE.replace('.c', '-test.c') : PROCESS_SOURCE,
        ),
        `/Fe:${temporary}`,
        `/Fo:${temporary}.obj`,
        '/link',
        ...PROCESS_LINK,
      ],
      { cwd: directory, env, timeout: 60000, maxBuffer: 1048576 },
    );
    if (testing) {
      await run(temporary, [], { timeout: 4000, maxBuffer: 65536 });
    } else {
      const bytes = await readFile(temporary);
      if (processSourceDigest(root) !== sourceDigest)
        throw new Error('Windows process source changed during compilation');
      const marker = {
        source: sourceDigest,
        binary: processImageDigest(bytes),
      };
      await rename(temporary, binary);
      await writeFile(`${binary}.source.json`, JSON.stringify(marker));
      assertProcessHelper(root);
    }
  });
  if (testing) {
    const fixture = `${binary}.${randomUUID()}.exe`;
    await withProcessBuildArtifacts([fixture, `${fixture}.obj`], async () => {
      await run(
        'cl.exe',
        [
          ...PROCESS_FLAGS,
          join(
            root,
            'packages/core-platform/native/windows-process/cold-observation-test.c',
          ),
          `/Fe:${fixture}`,
          `/Fo:${fixture}.obj`,
          '/link',
          ...PROCESS_LINK,
        ],
        { cwd: directory, env, timeout: 60000, maxBuffer: 1048576 },
      );
      for (const phase of [
        '71',
        '72',
        '67',
        '68',
        '69',
        '62',
        '63',
        '64',
        '65',
        '66',
        '61',
        '58',
        '59',
        '60',
        '55',
        '56',
        '57',
        '46',
        '47',
        '48',
        '49',
        '50',
        '51',
        '52',
        '53',
        '54',
        '40',
        '41',
        '42',
        '43',
        '44',
        '45',
        '38',
        '39',
        '7',
        '33',
        '34',
        '35',
        '36',
        '37',
        '25',
        '0',
        '1',
        '2',
        '3',
        '4',
        '5',
        '6',
        '8',
        '9',
        '10',
        '11',
        '12',
        '13',
        '14',
        '15',
        '16',
        '17',
        '18',
        '19',
        '20',
        '21',
        '22',
        '23',
        '24',
        '26',
        '27',
        '28',
        '29',
        '30',
        '31',
        '32',
      ]) {
        const { stdout, stderr: rawStderr } = await run(
          fixture,
          [phase, String(process.pid)],
          { timeout: 60000, maxBuffer: 64 << 20 },
        );
        const unionPaths = [
          ...rawStderr.matchAll(/^fixture-path ([0-9a-f]+)\r?\n/gm),
        ];
        const fixtureFacts =
          /^fixture standard: delete-pending=\d+ links=\d+ directory=\d+\r?\n/gm;
        for (const fact of rawStderr.matchAll(fixtureFacts))
          process.stdout.write(`cold-delete-pending-phase-${phase} ${fact[0]}`);
        const stderr = rawStderr
          .replace(fixtureFacts, '')
          .replace(
            /^fixture-file-type phase=7[12] errors=1 handle-queries=1 tracked-duplicates=1\r?\n/gm,
            '',
          )
          .replace(/^fixture-(?:mapping|image)-queries [1-7]\r?\n/gm, '')
          .replace(/^fixture-denial-elapsed [1-9]\d*\r?\n/gm, '')
          .replace(
            /^fixture-(?:(?:(?:reused|deleted|final-deleted|mapped|mapped-file)-)?path [0-9a-f]+|delete-pending [0-9a-f]{16} [0-9a-f]{32})\r?\n/gm,
            '',
          );
        if (
          !['54', '56', '58'].includes(phase) &&
          stderr.includes('canopy-cold-retry-exhausted-')
        )
          throw new Error(
            `Unexpected typed denial for phase=${phase}: ${rawStderr}`,
          );
        if (
          phase === '61' &&
          !stderr.endsWith('fixture owner-mismatch\r\n') &&
          (!/^exited /m.test(stdout) || !/complete [1-9]\d*\r?\n$/.test(stdout))
        )
          throw new Error(
            `Native exit during retry was not confirmed: ${rawStderr}`,
          );
        if (
          ['55', '56', '57'].includes(phase) &&
          !stderr.endsWith('fixture owner-mismatch\r\n')
        ) {
          const count = /^fixture-mapping-queries ([1-7])\r?\n/m.exec(
            rawStderr,
          )?.[1];
          if (
            (phase === '56'
              ? !/^[2-7]$/.test(count ?? '')
              : count !== (phase === '55' ? '2' : '1')) ||
            (phase !== '55' &&
              (!stderr.includes('stage=mapped-file observation ') ||
                !stderr.includes(`attempts=${phase === '57' ? 2 : count} `) ||
                !stderr.includes(`win32=${phase === '56' ? 5 : 1237} `)))
          )
            throw new Error(
              `Native region re-query qualification failed: phase=${phase} stderr=${rawStderr}`,
            );
        }
        if (
          ['54', '56', '57', '58', '59', '60'].includes(phase) &&
          !stderr.endsWith('fixture owner-mismatch\r\n')
        ) {
          const typed =
            /^canopy-cold-retry-exhausted-v1 ([1-9]\d*) (\d{20}) (image-name|mapping-query|mapping-name) ([1-7]) ([1-9]\d*) ([0-9a-f]+)\r?\n/gm;
          const receipts = [...stderr.matchAll(typed)];
          const exhausted = ['54', '56', '58'].includes(phase);
          if (receipts.length !== (exhausted ? 1 : 0))
            throw new Error(
              `Native typed denial mismatch: phase=${phase} stderr=${rawStderr}`,
            );
          if (exhausted) {
            const [, pid, ticks, stage, attempts, elapsed, image] = receipts[0];
            const expectedStage =
              phase === '54'
                ? 'mapping-name'
                : phase === '56'
                  ? 'mapping-query'
                  : 'image-name';
            if (
              stage !== expectedStage ||
              !/^[2-7]$/.test(attempts ?? '') ||
              Number(elapsed) < 1000 ||
              !stdout.includes(`p ${pid} `) ||
              !stdout.includes(` ${ticks}\r\n`) ||
              !stderr.includes(`(pid ${pid}) and retry`) ||
              !image ||
              /complete /m.test(stdout)
            )
              throw new Error(
                `Native denial evidence incomplete: phase=${phase} stderr=${rawStderr}`,
              );
          }
          if (['58', '59', '60'].includes(phase)) {
            const count = /^fixture-image-queries ([1-7])\r?\n/m.exec(
              rawStderr,
            )?.[1];
            if (
              phase === '58'
                ? !/^[2-7]$/.test(count ?? '')
                : count !== (phase === '59' ? '3' : '1')
            )
              throw new Error(
                `Native image retry count mismatch: ${rawStderr}`,
              );
          }
        }
        if (
          ['46', '47', '48', '49'].includes(phase) &&
          !stderr.endsWith('fixture owner-mismatch\r\n')
        ) {
          const mapped = /^fixture-mapped-path ([0-9a-f]+)\r?\n/m.exec(
            rawStderr,
          )?.[1];
          const file = /^fixture-mapped-file-path ([0-9a-f]+)\r?\n/m.exec(
            rawStderr,
          )?.[1];
          if (
            !mapped ||
            !file ||
            (phase === '46'
              ? !stdout.includes(`m ntfs ${mapped}\r\n`)
              : /^m ntfs /m.test(stdout) || !stdout.includes(`f ${file}\r\n`))
          )
            throw new Error(
              `Native mapped deletion qualification failed (phase ${phase}): ${rawStderr}`,
            );
          if (phase === '46' || phase === '47') {
            const kind = phase === '46' ? 'deleted' : 'lookalike';
            process.stdout.write(`cold-${kind}-mapping-path ${file}\n`);
            process.stdout.write(
              `cold-${kind}-mapping-receipt ${Buffer.from(stdout).toString('base64')}\n`,
            );
          }
        }
        if (phase === '40' && stderr.endsWith('fixture owner-mismatch\r\n'))
          process.stdout.write('cold-delete-pending-owner-mismatch\n');
        if (phase === '40' && !stderr.endsWith('fixture owner-mismatch\r\n')) {
          const identity =
            /^fixture-delete-pending ([0-9a-f]{16} [0-9a-f]{32})\r?\n/m.exec(
              rawStderr,
            )?.[1];
          if (!identity || !stdout.includes(`d ${identity}\r\n`))
            throw new Error(
              `Native POSIX delete-pending receipt missing: ${rawStderr}`,
            );
          process.stdout.write(
            `cold-delete-pending-receipt ${Buffer.from(stdout).toString('base64')}\n`,
          );
        }
        if (
          ['41', '42', '43', '44', '45'].includes(phase) &&
          !stderr.endsWith('fixture owner-mismatch\r\n')
        ) {
          const path = /^fixture-deleted-path ([0-9a-f]+)\r?\n/m.exec(
            rawStderr,
          )?.[1];
          if (!path || !stdout.includes(`f ${path}\r\n`) || /^d /m.test(stdout))
            throw new Error(
              `Unverified or still-linked File object was excluded: ${rawStderr}`,
            );
        }
        if (
          ['25', '26', '38', '39'].includes(phase) &&
          !stderr.endsWith('fixture owner-mismatch\r\n') &&
          (unionPaths.length !== 2 ||
            unionPaths.some((path) => !stdout.includes(`f ${path[1]}\r\n`)))
        )
          throw new Error(
            `Native cold conservative path union incomplete: ${rawStderr}`,
          );
        if (phase === '39') {
          if (stderr.endsWith('fixture owner-mismatch\r\n'))
            process.stdout.write('cold-reuse-owner-mismatch\n');
          else {
            const reused = /^fixture-reused-path ([0-9a-f]+)\r?\n/m.exec(
              rawStderr,
            )?.[1];
            if (!reused || !stdout.includes(`f ${reused}\r\n`))
              throw new Error('Native cold reused-slot path was lost');
            process.stdout.write(`cold-reuse-path ${reused}\n`);
            process.stdout.write(
              `cold-reuse-receipt ${Buffer.from(stdout).toString('base64')}\n`,
            );
          }
        }
        if (stderr.endsWith('fixture owner-mismatch\r\n')) {
          if (
            stdout !== '' ||
            !stderr.includes(
              'cold observer owner mismatch: TokenOwner is not TokenUser',
            )
          )
            throw new Error(
              'Native cold fixture did not refuse the elevated observer',
            );
          continue;
        }
        const receipt =
          /fixture ([1-9]\d*) (exited|observed|refused)\r?\n$/.exec(stderr);
        if (!receipt)
          throw new Error(`Native cold exit fixture missing result: ${stderr}`);
        if (
          phase === '12' &&
          (!stderr.includes('stage=GetFileType(observed File handle) ') ||
            !stderr.includes('win32=6 ntstatus=0x00000000'))
        )
          throw new Error(
            `Native non-File replacement did not refuse at File-type query: ${rawStderr}`,
          );
        if (['71', '72'].includes(phase)) {
          const fact = `fixture-file-type phase=${phase} errors=1 handle-queries=1 tracked-duplicates=1`;
          if (
            !rawStderr.includes(`${fact}\r\n`) ||
            !stderr.includes('stage=GetFileType(observed File handle) ') ||
            !stderr.includes(
              `win32=${phase === '71' ? 6 : 5} ntstatus=0x00000000`,
            )
          )
            throw new Error(
              `Native File-type immediate refusal evidence mismatch: ${rawStderr}`,
            );
          process.stdout.write(`cold-file-type ${fact}\n`);
        }
        if (['67', '68', '69'].includes(phase)) {
          const reuse =
            /^canopy-cold-pid-reuse-v1 ([1-9]\d*) ([a-z-]+) (\d{20}) ([0-9a-f]+) ([a-z-]+) (\d{20}) ([0-9a-f]+)\r?$/m.exec(
              rawStderr,
            );
          if (
            receipt[2] !== 'refused' ||
            (phase === '69'
              ? reuse ||
                !stderr.includes(
                  'stage=process continuity: creation query failed, exit unconfirmed ',
                )
              : !reuse ||
                reuse[1] !== receipt[1] ||
                (phase === '67'
                  ? reuse[4] === reuse[7]
                  : reuse[3] === reuse[6] ||
                    BigInt(reuse[3]) === 0n ||
                    BigInt(reuse[6]) === 0n))
          )
            throw new Error(
              `Native PID-reuse evidence mismatch (phase ${phase}): ${rawStderr}`,
            );
          process.stdout.write(
            `cold-continuity-refusal phase=${phase}: ${reuse?.[0] ?? 'untyped creation-query incompleteness'}\n`,
          );
        }
        if (
          phase === '35' &&
          !stdout.includes(
            `e ${Array.from('C:\\Canopy\\Canopy.exe', (char) => char.charCodeAt(0).toString(16).padStart(4, '0')).join('')}\r\n`,
          )
        )
          throw new Error('Native cold post-T product image was lost');
        if (['4', '7', '33', '34', '35', '51'].includes(phase)) {
          if (
            stderr !== receipt[0] ||
            !stdout.includes(`a ${receipt[1]}\r\n`) ||
            !/complete [1-9]\d*\r?\n$/.test(stdout) ||
            (phase === '7' && [...stdout.matchAll(/^a /gm)].length !== 5)
          )
            throw new Error(
              `Native cold post-T process evidence missing: ${stderr}`,
            );
          continue;
        }
        if (
          phase === '52' &&
          !stderr.includes(
            'stage=process continuity: creation identity changed ',
          )
        )
          throw new Error(
            `Native identity reuse after OWNER RIGHTS change was not refused: ${stderr}`,
          );
        if (
          phase === '54' &&
          !stderr.includes('stage=mapped-file observation ')
        )
          throw new Error(
            `Native stable mapped-name access denial was not refused: ${stderr}`,
          );
        if (['8', '36', '63', '64', '65'].includes(phase)) {
          const reason =
            phase === '8' || phase === '63'
              ? 'exited T PID reappeared'
              : phase === '36'
                ? 'creation identity changed'
                : 'exit absence unconfirmed';
          if (
            !stderr.includes(`stage=process continuity: ${reason} `) ||
            !stderr.includes('process continuity before:') ||
            !stderr.includes('process continuity after:')
          )
            throw new Error(
              `Native process continuity diagnostic missing: ${stderr}`,
            );
        }
        if (
          phase === '66' &&
          !stderr.includes('stage=continuity owner enumeration ')
        )
          throw new Error(
            `Native incomplete exit enumeration was not refused: ${stderr}`,
          );
        if (phase === '18' || phase === '19') {
          const evidence =
            /handle=0x([0-9a-f]+) handle-type=([1-9]\d*) file-type=([1-9]\d*) handle-access=0x([0-9a-f]{8}) handle-attributes=0x[0-9a-f]{8}/.exec(
              stderr,
            );
          if (
            !stderr.includes(
              'ERROR_NOT_SUPPORTED: File handle inspection incomplete after five passes',
            ) ||
            !stderr.includes('win32=50 ') ||
            !evidence ||
            BigInt(`0x${evidence[1]}`) === 0n ||
            evidence[2] !== evidence[3] ||
            (BigInt(`0x${evidence[4]}`) & 0x80n) === 0n
          )
            throw new Error(
              `Native cold unsupported File evidence missing: ${stderr}`,
            );
        }
        if (['0', '1', '61', '62'].includes(phase)) {
          if (
            stderr !== receipt[0] ||
            !stdout.includes(`exited ${receipt[1]} `) ||
            !/complete [1-9]\d*\r?\n$/.test(stdout)
          )
            throw new Error(`Native cold exit fixture incomplete: ${stderr}`);
        } else if (
          [
            '46',
            '47',
            '48',
            '49',
            '50',
            '53',
            '55',
            '59',
            '40',
            '41',
            '42',
            '43',
            '44',
            '45',
            '5',
            '9',
            '10',
            '26',
            '39',
            '14',
            '15',
            '16',
            '17',
            '22',
            '24',
            '25',
            '38',
            '27',
            '28',
            '29',
            '30',
            '31',
          ].includes(phase)
        ) {
          if (
            stderr !== receipt[0] ||
            !stdout.includes(`p ${receipt[1]} `) ||
            !/complete [1-9]\d*\r?\n$/.test(stdout)
          )
            throw new Error(`Native cold live fixture incomplete: ${stderr}`);
        } else if (
          ['18', '19', '23'].includes(phase) &&
          !stderr.includes(
            'File handle inspection incomplete after five passes',
          )
        ) {
          throw new Error(
            `Native cold handle bound was not exercised: ${stderr}`,
          );
        } else if (
          phase === '20' &&
          (!stderr.includes('stage=DuplicateHandle ') ||
            !stderr.includes('win32=5 '))
        ) {
          throw new Error(
            `Native cold retry access denial was not exercised: ${stderr}`,
          );
        } else if (
          phase === '21' &&
          !stderr.includes('stage=DuplicateHandle ')
        ) {
          throw new Error(
            `Native cold retry identity change was not refused: ${stderr}`,
          );
        } else if (
          phase === '32' &&
          !stderr.includes('stage=handle-pass final process identity ')
        ) {
          throw new Error(
            `Native cold optional-arrival identity change was not refused: ${stderr}`,
          );
        } else if (
          phase === '11' &&
          !stderr.includes('stage=DuplicateHandle(continuity)')
        ) {
          throw new Error(
            `Native cold continuity denial was not exercised: ${stderr}`,
          );
        } else if (
          phase === '12' &&
          !stderr.includes('stage=GetFileType(observed File handle)')
        ) {
          throw new Error(
            `Native cold non-File replacement was not refused: ${stderr}`,
          );
        } else if (
          phase === '13' &&
          !stderr.includes('stage=GetFileType(continuity File handle)')
        ) {
          throw new Error(
            `Native cold non-File continuity was not refused: ${stderr}`,
          );
        } else if (/complete [0-9]+\r?\n$/.test(stdout)) {
          throw new Error(
            `Native cold fixture admitted an uninspectable live child: phase=${phase} stderr=${rawStderr.slice(-4000)} stdout-tail=${stdout.slice(-4000)}`,
          );
        }
      }
    });
  }
}
