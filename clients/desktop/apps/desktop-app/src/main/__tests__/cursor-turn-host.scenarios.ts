import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { after, test as nodeTest, type TestContext } from 'node:test';
import type { CursorHookOutcome } from '@canopy/desktop-shared/node/cursor/hook-transport';
import { verifyCursorRuntimeVersion } from '@canopy/desktop-shared/node/cursor/runtime-process';
import {
  runCursorTurn,
  type CursorTurnHost,
  type CursorTurnRequest,
} from '@canopy/desktop-shared/node/cursor/turn-driver';
import {
  startOwnedProviderProcessHost,
  type OwnedProviderProcessHost,
} from './helpers/owned-provider-process-host';

// Cursor turns whose CLI runs under the provider process host, launched over
// the owned-process port, against the deterministic ACP fixture. The fixture
// answers `--version`, speaks ACP, and runs the private hooks.json command it
// discovers under CURSOR_DATA_DIR, so these scenarios exercise the driver end
// to end through the host: spawn, hook transport, session creation, prompt,
// and teardown.
const FIXTURE = path.resolve(
  __dirname,
  '../../../tests/electron/fixtures/cursor-acp-agent.mjs',
);
const FIXTURE_VERSION = '2026.09.08-6caf4ff';
const run = promisify(execFile);

function test(
  name: string,
  scenario: (context: TestContext) => Promise<void>,
): void {
  // Node's runner owns completion and reports rejected scenarios to the parent.
  void nodeTest(name, scenario);
}

function host(
  decide: (payload: unknown) => CursorHookOutcome,
  events: Record<string, unknown>[],
): CursorTurnHost {
  return {
    clientName: 'turn-driver-test',
    planMode: false,
    authorizeNative: (payload) => Promise.resolve(decide(payload)),
    authorizeMcp: () => Promise.resolve({ decision: 'deny' }),
    prepareMcp: () =>
      Promise.resolve({
        servers: [],
        notes: [],
        notices: [],
        appToolsAvailable: false,
        pluginServerNames: [],
      }),
    beforePrompt: () => Promise.resolve({ instructions: '' }),
    emit: (event): void => {
      events.push(event);
    },
  };
}

// An MCP-capable host: the driver only routes a permission request to
// `authorizeMcp` when the tool's server is one `prepareMcp` declared, so the
// ACP decision path is unreachable through `host()` above (which denies MCP and
// declares no servers). Used by the ACP anchor scenarios.
function mcpHost(
  decide: () => 'allow' | 'deny',
  calls: { permissions: number; nativeHooks: number },
): CursorTurnHost {
  return {
    clientName: 'turn-driver-test',
    planMode: false,
    authorizeNative: (): Promise<CursorHookOutcome> => {
      calls.nativeHooks += 1;
      return Promise.resolve({ decision: 'allow' });
    },
    authorizeMcp: (): Promise<{ decision: 'allow' | 'deny' }> => {
      calls.permissions += 1;
      return Promise.resolve({ decision: decide() });
    },
    prepareMcp: () =>
      Promise.resolve({
        servers: [
          { name: 'fixture-mcp', command: process.execPath, args: [], env: [] },
        ],
        notes: [],
        notices: [],
        appToolsAvailable: false,
        pluginServerNames: ['fixture-mcp'],
      }),
    beforePrompt: () => Promise.resolve({ instructions: '' }),
    emit: (): void => {},
  };
}

async function directories(context: TestContext): Promise<{
  cwd: string;
  profileDir: string;
}> {
  const cwd = await mkdtemp(path.join(tmpdir(), 'cursor-turn-cwd-'));
  const profileDir = await mkdtemp(path.join(tmpdir(), 'cursor-turn-profile-'));
  context.after(async () => {
    await rm(cwd, { recursive: true, force: true });
    await rm(profileDir, { recursive: true, force: true });
  });
  return { cwd, profileDir };
}

function present(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && Reflect.get(error, 'code') === 'EPERM';
  }
}

async function until(check: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Starts a hanging turn and resolves once it has streamed a patch. */
function hangingTurn(
  harness: OwnedProviderProcessHost,
  directory: { cwd: string; profileDir: string },
  controller: AbortController,
): { pending: ReturnType<typeof runCursorTurn>; streaming: Promise<void> } {
  const events: Record<string, unknown>[] = [];
  let streamed: () => void = () => undefined;
  const streaming = new Promise<void>((resolve) => {
    streamed = resolve;
  });
  const recording = host(() => ({ decision: 'allow' }), events);
  const pending = runCursorTurn(
    request(harness, directory, 'CURSOR_CHAT_E2E_HANG', controller.signal),
    {
      ...recording,
      emit: (event): void => {
        void recording.emit(event);
        if (event.type === 'canopy_assistant_patch') streamed();
      },
    },
  );
  return { pending, streaming };
}

async function fixturePid(directory: { profileDir: string }): Promise<number> {
  return Number(
    await readFile(path.join(directory.profileDir, 'fixture-pid.txt'), 'utf8'),
  );
}

function request(
  harness: OwnedProviderProcessHost,
  directory: { cwd: string; profileDir: string },
  text: string,
  signal: AbortSignal = new AbortController().signal,
): CursorTurnRequest {
  return {
    cwd: directory.cwd,
    text,
    launch: { command: process.execPath, prefix: [FIXTURE] },
    providerProcess: {
      spawner: harness.client.spawn,
      owner: { kind: 'turn', id: 'cursor-turn-host' },
    },
    env: { ...process.env, CURSOR_CONFIG_DIR: directory.profileDir },
    hookRuntime: process.execPath,
    profileDir: directory.profileDir,
    rawModelId: 'default[]',
    signal,
  };
}

function scenarios(harness: OwnedProviderProcessHost): void {
  test('streams response text into the projection and the result', async (t) => {
    const directory = await directories(t);
    const events: Record<string, unknown>[] = [];
    const result = await runCursorTurn(
      request(harness, directory, 'CURSOR_CHAT_E2E_TEXT'),
      host(() => ({ decision: 'allow' }), events),
    );
    assert.equal(result.isError, false);
    assert.ok(result.responseText.includes('Cursor chat works.'));
    assert.ok(
      events.some((event) => event.type === 'canopy_assistant_patch'),
      'expected the projection to emit assistant patches',
    );
  });

  test('two approved large Writes deliver their full ACP diffs and finish the turn', async (context) => {
    const directory = await directories(context);
    const before = 'x'.repeat(4 * 1024 * 1024);
    for (const filename of ['large-a.txt', 'large-b.txt'])
      await writeFile(path.join(directory.cwd, filename), before);
    const events: Record<string, unknown>[] = [];
    const result = await runCursorTurn(
      request(harness, directory, 'CURSOR_CHAT_E2E_LARGE_DIFFS'),
      host(() => ({ decision: 'allow' }), events),
    );
    assert.equal(result.isError, false, result.message);
    assert.equal(result.cancelled, false);
    assert.equal(result.responseText, 'Both large edits completed.');
    for (const filename of ['large-a.txt', 'large-b.txt']) {
      assert.equal(
        await readFile(path.join(directory.cwd, filename), 'utf8'),
        before + 'CURSOR_CHAT_OK',
      );
    }
    // Both snapshots must reach the transcript, not be silently discarded.
    const output = events.map((event) => JSON.stringify(event)).join('\n');
    assert.equal(output.includes(before + 'CURSOR_CHAT_OK'), true);
    assert.equal(output.includes('large-b.txt'), true);
  });

  test('writes the file when the host allows the Write hook', async (t) => {
    const directory = await directories(t);
    const events: Record<string, unknown>[] = [];
    const result = await runCursorTurn(
      request(harness, directory, 'create the result file'),
      host(() => ({ decision: 'allow' }), events),
    );
    assert.equal(result.isError, false);
    assert.equal(result.cancelled, false);
    assert.equal(
      await readFile(path.join(directory.cwd, 'result.txt'), 'utf8'),
      'CURSOR_APPROVAL_OK\n',
    );
    assert.ok(events.some((event) => event.type === 'system'));
  });

  test('leaves the file absent when the host denies Write', async (t) => {
    const directory = await directories(t);
    const events: Record<string, unknown>[] = [];
    const result = await runCursorTurn(
      request(harness, directory, 'create the result file'),
      host(
        (payload) =>
          typeof payload === 'object' &&
          payload !== null &&
          'tool_name' in payload &&
          payload.tool_name === 'Write'
            ? { decision: 'deny', message: 'blocked' }
            : { decision: 'allow' },
        events,
      ),
    );
    assert.equal(result.isError, false);
    await assert.rejects(
      readFile(path.join(directory.cwd, 'result.txt'), 'utf8'),
    );
  });

  test('stops a reused MCP tool id whose second call was never re-approved', async (t) => {
    // The MCP half of the same lifecycle rule. An MCP call has no native hook,
    // so its recorded ACP decision is its only exemption; that decision
    // belonged to the first invocation and must not carry over to a second
    // one the host never saw.
    const directory = await directories(t);
    const calls = { permissions: 0, nativeHooks: 0 };
    const result = await runCursorTurn(
      request(harness, directory, 'CURSOR_CHAT_E2E_REUSED_ACP_DECISION'),
      mcpHost(() => 'allow', calls),
    );
    assert.equal(calls.permissions, 1);
    assert.equal(calls.nativeHooks, 0);
    assert.equal(result.isError, true);
    assert.match(String(result.integrityFailure), /approval/i);
  });

  test('accepts a reused MCP tool id whose second call was approved again', async (t) => {
    // Control: two permission requests, two decisions, ordinary behaviour.
    const directory = await directories(t);
    const calls = { permissions: 0, nativeHooks: 0 };
    const result = await runCursorTurn(
      request(harness, directory, 'CURSOR_CHAT_E2E_REAPPROVED_ACP_DECISION'),
      mcpHost(() => 'allow', calls),
    );
    assert.equal(calls.permissions, 2);
    assert.equal(calls.nativeHooks, 0);
    assert.equal(result.isError, false);
    assert.equal(result.integrityFailure, undefined);
  });

  test('reports cancellation when the signal aborts mid-turn', async (t) => {
    // Aborted only once the turn is provably running: the fixture has been
    // spawned, prompted, and has streamed text for a turn that never finishes
    // on its own.
    const directory = await directories(t);
    const controller = new AbortController();
    const { pending, streaming } = hangingTurn(harness, directory, controller);
    await streaming;
    const pid = await fixturePid(directory);
    controller.abort();
    const result = await pending;
    assert.equal(result.cancelled, true);
    assert.equal(result.isError, false);
    assert.ok(result.responseText.includes('Working on it'));
    // The spawned runtime is gone, not left running behind a settled turn.
    await until(() => !present(pid), 5_000);
  });

  test('reports a child that never spawns as a failure, not a cancellation', async (t) => {
    // Only the CALLER's own signal may produce a cancellation; a spawn
    // failure reported by the host is an infrastructure failure.
    const directory = await directories(t);
    const events: Record<string, unknown>[] = [];
    const failing = request(harness, directory, 'never runs');
    const result = await runCursorTurn(
      {
        ...failing,
        launch: {
          command: path.join(directory.cwd, 'no-such-cursor-binary'),
          prefix: [],
        },
      },
      host(() => ({ decision: 'allow' }), events),
    );
    assert.equal(result.cancelled, false);
    assert.equal(result.isError, true);
    assert.notEqual(result.message, 'Turn cancelled');
  });

  test('refuses a resume whose session is gone without running a fresh turn', async (t) => {
    const directory = await directories(t);
    const events: Record<string, unknown>[] = [];
    const result = await runCursorTurn(
      {
        ...request(harness, directory, 'create the result file'),
        sessionId: 'missing-fixture-session',
        requireExistingSession: true,
      },
      host(() => ({ decision: 'allow' }), events),
    );
    assert.equal(result.isError, true);
    assert.equal(result.contextLost, true);
    // The whole point: no fresh, write-capable turn ran in place of the resume.
    await assert.rejects(
      readFile(path.join(directory.cwd, 'result.txt'), 'utf8'),
    );
  });

  test('a continued turn loads the saved session and a lost one falls back with contextLost', async (t) => {
    const directory = await directories(t);
    const events: Record<string, unknown>[] = [];
    const first = await runCursorTurn(
      request(harness, directory, 'CURSOR_CHAT_E2E_TEXT'),
      host(() => ({ decision: 'allow' }), events),
    );
    assert.equal(first.isError, false, first.message);
    const saved = first.sessionId;
    assert.ok(saved);
    const continued = await runCursorTurn(
      {
        ...request(harness, directory, 'CURSOR_CHAT_E2E_TEXT'),
        sessionId: saved,
      },
      host(() => ({ decision: 'allow' }), events),
    );
    assert.equal(continued.isError, false, continued.message);
    assert.equal(continued.sessionId, saved);
    assert.equal(continued.contextLost, false);
    assert.equal(
      await readFile(
        path.join(directory.profileDir, 'fixture-loaded.txt'),
        'utf8',
      ),
      saved,
    );
    let cleared = 0;
    const fallback = await runCursorTurn(
      {
        ...request(harness, directory, 'CURSOR_CHAT_E2E_TEXT'),
        sessionId: 'missing-fixture-session',
      },
      {
        ...host(() => ({ decision: 'allow' }), events),
        onSessionCleared: (): void => {
          cleared += 1;
        },
      },
    );
    assert.equal(fallback.contextLost, true);
    assert.ok(fallback.sessionId);
    assert.notEqual(fallback.sessionId, 'missing-fixture-session');
    assert.equal(cleared, 1);
  });

  test('the Cursor CLI is a child of the provider process host, not of this process', async (t) => {
    const directory = await directories(t);
    const controller = new AbortController();
    const { pending, streaming } = hangingTurn(harness, directory, controller);
    await streaming;
    const pid = await fixturePid(directory);
    const { stdout } = await run('ps', ['-o', 'ppid=', '-p', String(pid)]);
    const parent = Number(stdout.trim());
    assert.equal(parent, harness.hostPid());
    assert.notEqual(parent, process.pid);
    controller.abort();
    await pending;
  });

  test('a host that dies mid-turn fails the turn instead of cancelling it', async (t) => {
    const directory = await directories(t);
    const controller = new AbortController();
    const { pending, streaming } = hangingTurn(harness, directory, controller);
    await streaming;
    const pid = await fixturePid(directory);
    harness.killHost();
    const result = await pending;
    assert.equal(result.isError, true);
    assert.equal(result.cancelled, false);
    assert.match(result.message, /Provider process host exited/);
    await until(() => !present(pid), 8_000);
    const events: Record<string, unknown>[] = [];
    const next = await runCursorTurn(
      request(harness, directory, 'CURSOR_CHAT_E2E_TEXT'),
      host(() => ({ decision: 'allow' }), events),
    );
    assert.equal(next.isError, false, next.message);
  });

  test('the version probe runs under the host', async () => {
    const providerProcess = {
      spawner: harness.client.spawn,
      owner: { kind: 'turn', id: 'probe' },
    } as const;
    const launch = { command: process.execPath, prefix: [FIXTURE] };
    await verifyCursorRuntimeVersion(
      providerProcess,
      launch,
      process.env,
      new AbortController().signal,
      FIXTURE_VERSION,
    );
    await assert.rejects(
      verifyCursorRuntimeVersion(
        providerProcess,
        launch,
        process.env,
        new AbortController().signal,
        '0.0.0',
      ),
      /Cursor CLI 0\.0\.0 is required\./,
    );
  });
}

if (process.platform === 'win32') {
  // The owned-process port's own suite covers win32, and the fixture's hook
  // runner uses a POSIX shell.
  void nodeTest('Cursor turns through the provider process host', {
    skip: 'POSIX only',
  });
} else {
  const harness = startOwnedProviderProcessHost();
  after(() => harness.dispose());
  scenarios(harness);
}
