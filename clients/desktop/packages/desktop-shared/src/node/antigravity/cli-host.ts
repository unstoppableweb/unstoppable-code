import { watch, type FSWatcher } from 'node:fs';
import { getCanopyDataDir } from '@canopy/execution-engine/canopy-paths';
import type { AntigravityPromptRunnerRequest } from '@canopy/execution-engine/node/pipelines/executor/types';
import { antigravityReadRules } from './tool-approval';
import {
  createHeadlessApprovalSession,
  readHeadlessPreferences,
} from '../approvals/headless-session';
import { spawnProviderProcessDirect } from '../provider-process/spawn';
import type { AntigravityPromptHost } from '../pipelines/antigravity-prompt-runner';
import { openAntigravityRuntime } from './runtime';
import { authorizeAntigravityTool } from './tool-approval';
import {
  openCliAntigravityRollout,
  type CliAntigravityRollout,
} from './cli-rollout';

/**
 * Run-start check for a workflow that still needs Google: the saved
 * connection and the live rollout, without opening the native runtime.
 */
export async function preflightCliAntigravity(
  signal?: AbortSignal,
): Promise<void> {
  const preferences = await readHeadlessPreferences();
  if (preferences.googleSubscriptionDisconnected === true)
    throw new Error(
      'This workflow has Google steps. Connect Google before running it.',
    );
  const lifetime = new AbortController();
  const scope = signal
    ? AbortSignal.any([signal, lifetime.signal])
    : lifetime.signal;
  const unavailable =
    'This workflow has Google steps, but Google workflows are unavailable under the current rollout policy.';
  let rollout: CliAntigravityRollout | undefined;
  try {
    rollout = await openCliAntigravityRollout(scope, () => lifetime.abort());
  } catch (error) {
    signal?.throwIfAborted();
    // The rollout's own refusal, an unreadable rollout identity and network
    // failures all mean availability could not be confirmed.
    throw Object.assign(new Error(unavailable), { cause: error });
  }
  try {
    if (!rollout.isEnabled()) throw new Error(unavailable);
  } finally {
    lifetime.abort();
    await rollout.close();
  }
}

/** Source and packaged CLI use native auth without a desktop process. */
export function createCliAntigravityHost(
  request: AntigravityPromptRunnerRequest,
): AntigravityPromptHost {
  const lifetime = new AbortController();
  let rollout: CliAntigravityRollout | undefined;
  let watcher: FSWatcher | undefined;
  let signal = lifetime.signal;
  let approval: ReturnType<typeof createHeadlessApprovalSession> | undefined;
  const assertEnabled = async (): Promise<void> => {
    signal.throwIfAborted();
    const preferences = await readHeadlessPreferences();
    if (
      preferences.googleSubscriptionDisconnected === true ||
      !rollout?.isEnabled()
    )
      throw new Error(
        'Google subscription workflows are unavailable under the current connection or rollout policy.',
      );
    signal.throwIfAborted();
  };
  return {
    // Admission before open checks preferences; live rollout starts in open.
    async assertEnabled() {
      if (rollout) return assertEnabled();
      signal.throwIfAborted();
      const preferences = await readHeadlessPreferences();
      if (preferences.googleSubscriptionDisconnected === true)
        throw new Error('Connect Google before running this workflow.');
    },
    async open(input) {
      signal = AbortSignal.any([input.signal, lifetime.signal]);
      rollout = await openCliAntigravityRollout(signal, () => lifetime.abort());
      await assertEnabled();
      watcher = watch(
        getCanopyDataDir(),
        { persistent: false },
        (_event, name) => {
          if (!name || name.toString() === 'preferences.json')
            void assertEnabled().catch(() => lifetime.abort());
        },
      );
      watcher.on('error', () => lifetime.abort());
      approval = createHeadlessApprovalSession({
        cwd: request.cwd,
        projectId: request.projectId,
        mode:
          request.permissionPreset === 'dangerous_all' ? 'full-access' : 'ask',
        sessionRules: antigravityReadRules(request.permissionPreset),
        signal,
      });
      return openAntigravityRuntime({
        ...input,
        cwd: request.cwd,
        environment: request.environment,
        signal,
        owner: { kind: 'pipeline', id: request.executionId },
        spawnProcess: spawnProviderProcessDirect,
        assertEnabled,
      });
    },
    async authorize(permission) {
      await assertEnabled();
      if (!approval) return 'deny';
      const result = await authorizeAntigravityTool(permission, {
        approval,
        cwd: request.cwd,
        planMode: request.permissionPreset === 'plan',
        stopTurn: () => lifetime.abort(),
      });
      await assertEnabled();
      return result;
    },
    async dispose() {
      lifetime.abort();
      watcher?.close();
      await rollout?.close();
    },
  };
}
