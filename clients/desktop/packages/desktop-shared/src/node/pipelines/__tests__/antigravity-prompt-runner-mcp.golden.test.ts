// Golden: a Google workflow step's selected MCP servers reach the launcher, and
// the launcher allows the runtime's ACP permission request for their tools.
// Antigravity 1.5.14 asks ACP permission for MCP calls; a step that did not
// hand over the servers it delivers would have every selected MCP tool denied.
// The host below forwards the step's open input to the real
// openAntigravityRuntime, as both production hosts do; only the executable
// checks, the process and the ACP transport are stubbed. A session saved under
// another pinned runtime is refused with that reason before anything opens,
// not as a workspace mismatch.
import type { AcpClientOptions } from '@canopy/desktop-shared/node/acp';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPipelineExecutionAntigravitySessionsDir } from '@canopy/execution-engine/node/lib/paths';
import type { AntigravityPromptRunnerRequest } from '@canopy/execution-engine/node/pipelines/executor/types';
import type { EffectiveCapabilitySnapshot } from '../../capabilities/effective-snapshot';
import { EFFECTIVE_CAPABILITY_SNAPSHOT_VERSION } from '../../capabilities/effective-snapshot';
import { ANTIGRAVITY_RUNTIME_VERSION } from '../../antigravity/runtime-metadata';
import { openAntigravityRuntime } from '../../antigravity/runtime';
import type { ProviderProcess } from '../../provider-process/spawn';
import {
  runAntigravityPipelinePrompt,
  type AntigravityPipelineCapabilities,
  type AntigravityPromptHost,
} from '../antigravity-prompt-runner';

// The opener's client options; the session itself is refused right after.
let mockAnswer: AcpClientOptions['onPermission'];
jest.mock('@canopy/desktop-shared/node/acp', () => ({
  connectAcp: (options: AcpClientOptions): Promise<unknown> => {
    mockAnswer = options.onPermission;
    return Promise.resolve({
      getInitialization: (): { agentInfo: { version: string } } => ({
        agentInfo: { version: ANTIGRAVITY_RUNTIME_VERSION },
      }),
      newSession: (): Promise<never> =>
        Promise.reject(new Error('session refused by the test')),
      close: (): void => undefined,
    });
  },
}));
// Stands in for Google's signed release, which CI does not have.
jest.mock('../../antigravity/runtime-integrity', () => ({
  ...jest.requireActual<object>('../../antigravity/runtime-integrity'),
  verifyAntigravityExecutable: (file: string): Promise<string> =>
    Promise.resolve(file),
  antigravityExecutableIdentityForLaunch: (): Promise<string> =>
    Promise.resolve('identity'),
}));

/** A provider process that stays open until stopped; ACP is stubbed. */
class OpenProcess extends EventEmitter implements ProviderProcess {
  readonly pid = 1;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stop = (): Promise<void> => {
    this.stdout.end();
    return Promise.resolve();
  };
}

const SNAPSHOT: EffectiveCapabilitySnapshot = {
  version: EFFECTIVE_CAPABILITY_SNAPSHOT_VERSION,
  harness: 'antigravity',
  runtimeVersion: ANTIGRAVITY_RUNTIME_VERSION,
  selections: {
    chat: ['mcp:sel-ected'],
    effective: [{ entryId: 'mcp:sel-ected', origin: 'chat' }],
    optedOut: [],
    packageOverlayDigest: null,
  },
  grants: {
    toolSurface: 'antigravity-acp',
    appTools: [],
    codeGraph: false,
    feed: false,
    deferredTools: false,
    delegation: false,
    planMode: false,
    approvalMode: 'ask',
    childInheritance: 'none',
  },
  content: { skills: [], commands: [], files: {}, fingerprint: 'none' },
  mcp: [],
  omitted: [],
  complete: true,
};

let root: string;
const savedEnv = { ...process.env };
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agy-workflow-mcp-'));
  mockAnswer = undefined;
});
afterEach(() => {
  process.env = { ...savedEnv };
  rmSync(root, { recursive: true, force: true });
});

function request(): AntigravityPromptRunnerRequest {
  return {
    cwd: root,
    prompt: 'Reply done.',
    environment: {},
    model: 'antigravity:gemini-4-neon',
    totalTimeoutMs: 60_000,
    permissionPreset: 'dangerous_all',
    pluginSelections: {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [{ serverId: 'sel-ected', configId: 'default' }],
    },
    executionsDir: join(root, 'executions'),
    executionId: 'workflow-mcp',
    jobId: 'job',
    stepId: 'step',
    attempt: 1,
  };
}

// Google workflows launch only on macOS and Linux; the resolver refuses any
// other host before the stubs below are reached.
const supportedIt =
  process.platform === 'darwin' || process.platform === 'linux' ? it : it.skip;

supportedIt(
  'allows the routed calls of the MCP servers a workflow step delivers',
  async () => {
    const executable = join(root, 'agy');
    writeFileSync(executable, '#!/bin/sh\n', { mode: 0o755 });
    process.env.ANTIGRAVITY_EXECUTABLE = executable;
    const capabilities: AntigravityPipelineCapabilities = {
      servers: [{ name: 'sel-ected', command: '/bin/true', args: [], env: [] }],
      instructions: '',
      expandPrompt: (text) => text,
      captureSnapshot: () => Promise.resolve(SNAPSHOT),
      close: () => Promise.resolve(),
    };
    const host: AntigravityPromptHost = {
      assertEnabled: () => undefined,
      authorize: () => Promise.resolve('deny'),
      prepareCapabilities: () => Promise.resolve(capabilities),
      open: (input) =>
        openAntigravityRuntime({
          ...input,
          cwd: root,
          owner: { kind: 'pipeline', id: 'workflow-mcp' },
          spawnProcess: () => new OpenProcess(),
          assertEnabled: () => undefined,
          managedRootDir: join(root, 'no-managed-runtime'),
        }),
    };
    await runAntigravityPipelinePrompt(request(), host);
    const answer = mockAnswer;
    if (!answer) throw new Error('The launcher was never opened.');
    const ask = (name: string): Promise<'allow' | 'deny'> =>
      answer({
        requestId: 1,
        resourceGeneration: 1,
        request: {
          sessionId: 's',
          toolCall: { toolCallId: 't', name, kind: 'other' },
          options: [
            { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
            { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
          ],
        },
        signal: new AbortController().signal,
      });
    await expect(ask('mcp_sel-ected_lookup')).resolves.toBe('allow');
    await expect(ask('mcp_other_lookup')).resolves.toBe('deny');
  },
);

it('refuses a session saved under another pinned runtime before opening it', async () => {
  const base = request();
  const sessionId = 'saved-session';
  const sessions = getPipelineExecutionAntigravitySessionsDir(
    base.executionsDir,
    base.executionId,
  );
  mkdirSync(sessions, { recursive: true });
  writeFileSync(
    join(
      sessions,
      `${createHash('sha256').update(sessionId).digest('hex')}.json`,
    ),
    JSON.stringify({
      version: 1,
      sessionId,
      profileId: '00000000-0000-4000-8000-000000000000',
      cwd: root,
      runtimeVersion: '0.0.1',
      model: 'gemini-4-neon',
      permissionPreset: base.permissionPreset,
    }),
  );
  let opened = false;
  const host: AntigravityPromptHost = {
    assertEnabled: () => undefined,
    authorize: () => Promise.resolve('deny'),
    open: () => {
      opened = true;
      return Promise.reject(new Error('opened'));
    },
  };
  const result = await runAntigravityPipelinePrompt(
    { ...base, pluginSelections: undefined, resumeSessionId: sessionId },
    host,
  );
  if (result.status === 'success') throw new Error('The resume ran.');
  expect(result.failure.message).toMatch(
    /started with an earlier Antigravity CLI/,
  );
  expect(opened).toBe(false);
});
