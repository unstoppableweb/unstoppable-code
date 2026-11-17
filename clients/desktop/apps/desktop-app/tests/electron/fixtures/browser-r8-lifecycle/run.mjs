// Coordinator only: run through run-guarded-dev-script.mjs --suite e2e.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const root = await mkdtemp(join(tmpdir(), 'browser-r8-'));
const fixture = join(dirname(fileURLToPath(import.meta.url)), 'runtime.cjs');
const output = resolve(
  process.argv[2] ?? '.playwright/can-4497-r8/native-lifecycle.json',
);
const results = [];
try {
  for (const phase of ['loaded', 'unloaded']) {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(
      require('electron'),
      ['--use-mock-keychain', fixture, root, phase],
      { env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let log = '';
    for (const stream of [child.stdout, child.stderr])
      stream.on('data', (data) => {
        log = (log + String(data)).slice(-32768);
      });
    const timer = setTimeout(() => child.kill('SIGKILL'), 60000);
    let code;
    try {
      code = await new Promise((resolveExit, reject) => {
        child.once('error', reject);
        child.once('exit', resolveExit);
      });
    } finally {
      clearTimeout(timer);
    }
    const result = JSON.parse(
      await readFile(join(root, `${phase}.json`), 'utf8').catch(() => '{}'),
    );
    results.push({ ...result, code, log });
    if (code !== 0 || !result.passed) break;
  }
  const passed =
    results.length === 2 &&
    results.every((result) => result.code === 0 && result.passed);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(
    output,
    JSON.stringify(
      {
        passed,
        results,
        fixtureSha256: createHash('sha256')
          .update(await readFile(fixture))
          .digest('hex'),
        limitation:
          'Graceful two-process macOS lifecycle only; no power loss, crash recovery, product authorization, cross-version Chromium migration or Windows/Linux acceptance.',
      },
      null,
      2,
    ) + '\n',
  );
  console.log(JSON.stringify({ output, passed }));
  if (!passed) process.exitCode = 1;
} finally {
  await rm(root, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 100,
  });
}
