'use strict';

const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { tmpdir } = require('node:os');
const { spawn } = require('node:child_process');

const MODES = ['native-v1', 'resolution-v1'];
const PREFIX = '--canopy-linux-diagnostic=';
const OZONE_SWITCH = '--ozone-platform=headless';
let isolated;
let finished = false;
let deadline;
const admittedAt = Date.now();
const argument = process.argv[1];
const mode =
  typeof argument === 'string' && argument.startsWith(PREFIX)
    ? argument.slice(PREFIX.length)
    : '';
const resources = process.resourcesPath;

function finish(evidence, code) {
  if (finished) return;
  finished = true;
  clearTimeout(deadline);
  try {
    const result = JSON.stringify({
      schemaVersion: 1,
      mode,
      platform: process.platform,
      arch: process.arch,
      executable: process.execPath,
      resources,
      evidence,
    });
    if (
      Buffer.byteLength(result) > (mode === 'native-v1' ? 65536 : 1024 * 1024)
    )
      throw new Error('Diagnostic result exceeded limit');
    const bytes = Buffer.from(`${result}\n`);
    let offset = 0;
    while (offset < bytes.length) {
      const written = fs.writeSync(3, bytes, offset, bytes.length - offset);
      if (written <= 0) throw new Error('Diagnostic result pipe closed');
      offset += written;
    }
  } catch {
    code = 1;
  }
  // The external watchdog owns descendant teardown before deleting this state.
  app.exit(code);
}

async function main() {
  const descriptor = fs.fstatSync(3);
  if (
    process.platform !== 'linux' ||
    !app.isPackaged ||
    process.argv.length !== 3 ||
    process.argv[2] !== OZONE_SWITCH ||
    !MODES.includes(mode) ||
    process.env.CANOPY_LINUX_SAFE_STORAGE_HELPER_MODE ||
    (!descriptor.isFIFO() && !descriptor.isSocket())
  )
    throw new Error('Packaged diagnostic admission refused');
  if (resources !== path.join(path.dirname(process.execPath), 'resources'))
    throw new Error('Diagnostic package identity mismatch');
  // Fixed probes create no windows and must also run on display-less builders.
  // Chromium selects its platform and sandbox before this script runs, so the
  // trusted launcher (runNativeCommand) passes the switch and disables the
  // sandbox. Confirm Chromium parsed the switch as admitted.
  if (app.commandLine.getSwitchValue('ozone-platform') !== 'headless')
    throw new Error('Packaged diagnostic admission refused');
  isolated = fs.mkdtempSync(path.join(tmpdir(), 'canopy-diagnostic-'));
  for (const name of [
    'HOME',
    'USERPROFILE',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_CACHE_HOME',
    'TMPDIR',
    'TMP',
    'TEMP',
  ])
    process.env[name] = isolated;
  for (const name of ['userData', 'sessionData', 'temp', 'crashDumps'])
    app.setPath(name, isolated);
  app.setAppLogsPath(isolated);
  deadline = setTimeout(
    () =>
      finish(
        { status: 'failed', diagnostic: 'Diagnostic deadline exceeded' },
        1,
      ),
    Math.max(
      1,
      (mode === 'native-v1' ? 60000 : 300000) - (Date.now() - admittedAt),
    ),
  );
  if (mode === 'native-v1') {
    require('./verify-linux-native-runtime.cjs').probe(
      path.dirname(resources),
      isolated,
      finish,
    );
    return;
  }
  const resolver = require('../../../packages/execution-engine/src/pipelines/config-paths.ts');
  const desktopResolver = require('../src/main/pipelines/config-paths.ts');
  const enhancedEnv = resolver.getEnhancedEnv({
    environment: false,
    includeCanopySecrets: false,
  });
  const probes = [
    ['claude', 'getBundledClaudeBinaryPath', '--version'],
    ['codex', 'getBundledCodexBinaryPath', '--version'],
    ['codex-code-mode-host', 'getBundledCodexCodeModeHostPath', '--help'],
    ['gh', 'getBundledGhBinaryPath', '--version'],
    ['rg', 'getBundledRgBinaryPath', '--version'],
    ['rtk', 'getBundledRtkBinaryPath', '--version'],
  ];
  const absoluteDeadline = admittedAt + 300000;
  const members = [];
  for (const [member, getter, flag] of probes) {
    const file = resolver[getter]();
    if (
      file !== path.join(resources, 'bin', member) ||
      fs.realpathSync(file) !== file
    )
      throw new Error('Diagnostic resolver selected external code');
    const remaining = absoluteDeadline - Date.now();
    if (remaining <= 0) throw new Error('Diagnostic deadline exceeded');
    const run = await new Promise((resolve, reject) => {
      const child = spawn(file, [flag], {
        env: { ...enhancedEnv, PATH: '', HOME: isolated, TMPDIR: isolated },
        cwd: isolated,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const output = [];
      let bytes = 0;
      const timer = setTimeout(
        () => {
          child.kill('SIGKILL');
          reject(new Error('Tool deadline exceeded'));
        },
        Math.min(60000, remaining),
      );
      for (const stream of [child.stdout, child.stderr])
        stream.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > 1024 * 1024) {
            child.kill('SIGKILL');
            reject(new Error('Tool output exceeded limit'));
          } else output.push(chunk);
        });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('close', (status, signal) => {
        clearTimeout(timer);
        resolve({
          status,
          signal,
          error: null,
          firstLine:
            Buffer.concat(output).toString('utf8').trim().split('\n')[0] ?? '',
        });
      });
    });
    members.push({
      member,
      path: file,
      status: resolver.resolveBundledBinary(member).status,
      run,
    });
  }
  const fileBroker = desktopResolver.getBundledDelegationFileBrokerPath();
  let executable = false;
  try {
    fs.accessSync(fileBroker, fs.constants.X_OK);
    executable = true;
  } catch {
    /* reported below */
  }
  finish(
    {
      mode: 'packaged',
      platform: process.platform,
      arch: process.arch,
      execPath: process.execPath,
      resourcesPath: resources,
      resourcesPathSource: 'electron',
      binDir: resolver.getBundledBinDir(),
      enhancedPath: enhancedEnv.PATH ?? null,
      members,
      fileBroker: { path: fileBroker, executable },
      missing: resolver
        .listMissingBundledBinaries()
        .map(({ member }) => member),
    },
    0,
  );
}

void main().catch((error) =>
  finish(
    { status: 'failed', diagnostic: String(error.message).slice(0, 4096) },
    1,
  ),
);
