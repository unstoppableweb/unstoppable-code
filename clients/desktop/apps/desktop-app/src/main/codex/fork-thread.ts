import { applyCodexMultiAgentConfig } from '@canopy/execution-engine/lib/codex-multi-agent';
import {
  CODEX_PROJECT_DOC_THREAD_CONFIG,
  flattenCodexThreadConfig,
} from '@canopy/execution-engine/node/codex-runtime/thread-config';
import {
  type AgentModelConfig,
  type ChatTabPluginSelections,
} from '@canopy/desktop-shared/types';
import { resolveCodexRuntimeEnvironmentProfile } from '../lib/user-environment-runtime';
import { getCodexRuntimeService } from './runtime-service';
import { codexLifecycleServiceTier } from './speed-policy';
import {
  readCodexSpeedRecord,
  withCodexSpeed,
} from '@canopy/execution-engine/lib/codex-speed';

/**
 * Forks a persisted thread through the host-owned Codex runtime service.
 *
 * The renderer-driven chat fork flow uses this so the source chat does not
 * need to have a live app-server connection at the moment. The fork RPC
 * loads the source thread by id, so any initialized client can perform the
 * fork.
 */
interface CodexForkOptions {
  cwd: string;
  projectId: string;
  worktreeId: string;
  chatId: string;
  sourceThreadId: string;
  sourceProjectId?: string;
  sourceWorktreeId?: string;
  sourceChatId?: string;
  pluginSelections?: ChatTabPluginSelections;
  codexMultiAgentEnabled?: boolean;
  codexMaxConcurrentSubagents?: number | null;
  /**
   * Destination chat's requested speed. The fork is metadata-only, so it
   * sends the lifecycle tier: exact Regular/Fast, explicit `default` for Ultra
   * fast until an admitted turn. Absent keeps the source thread's tier.
   */
  modelConfig?: AgentModelConfig;
  /** @deprecated Use modelConfig.speed. */
  codexFastModeEnabled?: boolean;
  /** Keeps the fork observable until its canonical destination is durable. */
  onForked?: (threadId: string) => Promise<void>;
}

const pendingForks = new Map<
  string,
  { sourceThreadId: string; result: Promise<string> }
>();

function forkTargetKey(target: {
  projectId: string;
  worktreeId: string;
  chatId: string;
}): string {
  return JSON.stringify([target.projectId, target.worktreeId, target.chatId]);
}

export async function forkCodexThreadByIdViaOneShot(
  opts: CodexForkOptions,
): Promise<string> {
  const key = forkTargetKey(opts);
  const existing = pendingForks.get(key);
  if (existing) {
    if (existing.sourceThreadId !== opts.sourceThreadId)
      throw new Error(
        'A different source thread is already being forked into this chat',
      );
    return existing.result;
  }
  const result = (async (): Promise<string> => {
    const threadId = await forkThread(opts);
    await opts.onForked?.(threadId);
    return threadId;
  })();
  pendingForks.set(key, { sourceThreadId: opts.sourceThreadId, result });
  try {
    return await result;
  } finally {
    if (pendingForks.get(key)?.result === result) pendingForks.delete(key);
  }
}

/** Wait without cancelling the shared fork when this particular send is stopped. */
export async function waitForPendingCodexFork(
  target: { projectId: string; worktreeId: string; chatId: string },
  signal: AbortSignal,
): Promise<string | undefined> {
  signal.throwIfAborted();
  const pending = pendingForks.get(forkTargetKey(target));
  if (!pending) return undefined;
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      reject(new Error('Fork continuation cancelled'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void pending.result.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

function forkSpeedRecord(
  opts: Pick<CodexForkOptions, 'modelConfig' | 'codexFastModeEnabled'>,
): AgentModelConfig | undefined {
  const speed = readCodexSpeedRecord(
    opts.modelConfig,
    opts.codexFastModeEnabled,
  );
  return speed === undefined
    ? opts.modelConfig
    : withCodexSpeed(opts.modelConfig, speed);
}

async function forkThread(opts: CodexForkOptions): Promise<string> {
  const workspaceEnvironment = resolveCodexRuntimeEnvironmentProfile({
    runtime: 'agent',
    workspaceId: opts.projectId,
  });
  const speedRecord = forkSpeedRecord(opts);
  const handle = await getCodexRuntimeService().forkThread({
    params: {
      threadId: opts.sourceThreadId,
      cwd: opts.cwd,
      ...(speedRecord
        ? { serviceTier: codexLifecycleServiceTier(speedRecord) }
        : {}),
      config: flattenCodexThreadConfig(
        applyCodexMultiAgentConfig(
          { ...CODEX_PROJECT_DOC_THREAD_CONFIG },
          {
            enabled: opts.codexMultiAgentEnabled,
            maxConcurrentSubagents: opts.codexMaxConcurrentSubagents,
          },
        ),
      ),
    },
    capabilitySnapshotId: 'legacy-canonical',
    profile: {
      environment: workspaceEnvironment.environment,
      logicalWorkspaceEnvironmentId:
        workspaceEnvironment.logicalWorkspaceEnvironmentId,
      ...(workspaceEnvironment.secretVersionFingerprint
        ? {
            secretVersionFingerprint:
              workspaceEnvironment.secretVersionFingerprint,
          }
        : {}),
    },
  });
  try {
    return handle.threadId;
  } finally {
    await handle.unsubscribe();
  }
}
