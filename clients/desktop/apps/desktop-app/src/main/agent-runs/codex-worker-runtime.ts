import type { BrowserWindow } from 'electron';
import type { CodexRuntimeService } from '@canopy/execution-engine/node/codex-runtime';
import {
  createCodexRuntimeService,
  resetCanonicalCodexHomeForTests,
} from '@canopy/execution-engine/node/codex-runtime';
import {
  IPC_CHANNELS,
  type AgentProviderType,
  type ChatIngestionLagEventData,
  type ChatModel,
} from '@canopy/desktop-shared/types';
import '../codex/runtime-host-adapter';
import { getDesktopCodexCapabilityStore } from '../codex/capability-store';
import { resolveDesktopCodexMcpLauncher } from '../codex/mcp-launcher-command';
import type { CodexCompatibleInvocation } from '../agents/codex-session';
import type { AgentProvider } from '../agents/types';
import { sendToWindow } from '../lib/window-send';
import { currentHelperWorkerContext } from '../helper-runs/helper-worker-context';
import {
  assertAgentWorkerContext,
  currentAgentWorkerContext,
} from './agent-worker-context';
import type { WorkerProviderRuntime } from './worker-provider-runtimes';

let runtimeService: CodexRuntimeService | null = null;
let shutdownPromise: Promise<void> | null = null;
const replacementListeners = new Set<() => void>();

/** Account-scoped caches built from the old runtime must not outlive it. */
export function onCodexWorkerRuntimeReplaced(listener: () => void): () => void {
  replacementListeners.add(listener);
  return (): void => {
    replacementListeners.delete(listener);
  };
}

function notifyRuntimeReplaced(): void {
  for (const listener of Array.from(replacementListeners)) {
    try {
      listener();
    } catch {
      // A cache observer must never block runtime shutdown.
    }
  }
}

/**
 * The in-process worker's one Codex runtime (CAN-4117): the shared app-server
 * pool, MCP secret broker and capability leases every desktop Codex session
 * uses. Only this module creates it, and only the app-quit stage
 * `codex-runtime` shuts it down (check:codex-runtime-ownership CX2).
 */
export function acquireCodexWorkerRuntime(): CodexRuntimeService {
  if (!runtimeService) {
    runtimeService = createCodexRuntimeService({
      capabilityStore: getDesktopCodexCapabilityStore(),
      mcpLauncher: resolveDesktopCodexMcpLauncher(),
    });
    shutdownPromise = null;
  }
  return runtimeService;
}

/** Shuts the runtime down once; the next acquisition creates a new one. */
export function shutdownCodexWorkerRuntime(): Promise<void> {
  if (shutdownPromise) {
    return shutdownPromise;
  }
  const service = runtimeService;
  runtimeService = null;
  shutdownPromise = service?.shutdown() ?? Promise.resolve();
  if (service) notifyRuntimeReplaced();
  return shutdownPromise;
}

export async function resetCodexWorkerRuntimeForTests(): Promise<void> {
  await shutdownCodexWorkerRuntime();
  resetCanonicalCodexHomeForTests();
  shutdownPromise = null;
}

export type CodexWorkerRunEntry =
  | 'attachInteractiveClient'
  | 'codexDelegationRunner'
  | 'runCodexHelperText'
  | 'codexStructuredHelper'
  | 'pipelineAdvisorSdkTurn';

export class CodexRuntimeOutsideWorkerError extends Error {
  constructor(entry: CodexWorkerRunEntry) {
    super(`Codex sessions run through the local worker (${entry}).`);
    this.name = 'CodexRuntimeOutsideWorkerError';
  }
}

/**
 * The worker-owned runtime for a Codex session (CAN-4117). Refuses, before
 * the runtime is created or touched, unless the caller runs inside a worker
 * turn, subagent or helper run.
 */
export function codexRuntimeForWorkerRun(
  entry: CodexWorkerRunEntry,
): CodexRuntimeService {
  if (
    currentAgentWorkerContext() === undefined &&
    currentHelperWorkerContext() === undefined
  )
    throw new CodexRuntimeOutsideWorkerError(entry);
  return acquireCodexWorkerRuntime();
}

/** The worker-owned Codex harness runtime (CAN-4117): Codex, and Ollama on the Codex harness. */
export interface CodexWorkerRuntime extends WorkerProviderRuntime {
  readonly harness: 'codex';
}

class DesktopCodexWorkerRuntime implements CodexWorkerRuntime {
  readonly harness = 'codex' as const;

  async providerFor(
    providerType: AgentProviderType,
    getWindow: () => BrowserWindow | null,
  ): Promise<AgentProvider> {
    assertAgentWorkerContext('CodexWorkerRuntime.providerFor');
    // Keep this local import lazy to break the session-manager ↔ codex-session
    // cycle; the packaged Electron main build exercises this resolution path.
    const { CodexProvider } = await import('../agents/codex-session');
    const emitIngestionLag = (
      target: { projectId: string; worktreeId: string; chatId: string },
      data: ChatIngestionLagEventData,
    ): void => {
      sendToWindow(getWindow(), IPC_CHANNELS.chatEvent, { ...target, data });
    };
    if (providerType === 'ollama') {
      // Keep the Ollama adapter lazy with the Codex provider to preserve the
      // same session-manager cycle break in packaged Electron main builds.
      const { resolveCodexCompatibleOllamaInvocation } =
        await import('../ollama/codex-compatible');
      return new CodexProvider({
        providerType: 'ollama',
        emitIngestionLag,
        prepareInvocation: async (
          model: ChatModel | undefined,
        ): Promise<CodexCompatibleInvocation> => {
          const invocation = await resolveCodexCompatibleOllamaInvocation(
            model,
            {
              ensureRunningReason: 'chat',
              assertInstalled: true,
            },
          );
          return {
            runtimeModel: invocation.runtimeModel,
            envOverride: invocation.envOverride,
            codexConfig: invocation.codexConfig,
          };
        },
      });
    }
    return new CodexProvider({ emitIngestionLag });
  }
}

const codexWorkerRuntime = new DesktopCodexWorkerRuntime();

export function getCodexWorkerRuntime(): CodexWorkerRuntime {
  return codexWorkerRuntime;
}
