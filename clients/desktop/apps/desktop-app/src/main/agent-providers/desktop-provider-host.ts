import { isAntigravityHarnessEnabled } from '../antigravity/feature-flag';
import { hostPlatformOperatingSystem } from '@canopy/core-platform';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { WorkerAgentProviderHost } from '@canopy/core-runtime/node/agent/providers';
import {
  CANOPY_IN_PROCESS_WORKER_TARGET_ID,
  WORKER_AGENT_PROVIDER_IDS,
  type CanopyWorkspaceScope,
  type WorkerAgentProviderAuthState,
  type WorkerAgentProviderId,
} from '@canopy/protocol/canopy-core';
import type { PortalProviderUsageProjection } from '@canopy/protocol/portal';
import { isOllamaSupportedOnPlatform } from '@canopy/desktop-shared/platform-capabilities';
import type { ModelRegistrySnapshot } from '@canopy/desktop-shared/types';
import type { WorkOwner } from '@canopy/protocol/llm-gateway';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../canopy-runtime/desktop-runtime-identity';
import { isCopilotHarnessEnabled } from '../copilot/feature-flag';
import { isCursorHarnessEnabled } from '../cursor/feature-flag';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { isModelBlockedByCurrentPolicy } from '../lib/model-policy-state';
import { isOpenCodeHarnessEnabled } from '../opencode/feature-flag';
import {
  availabilityAuthState,
  nativeAuthState,
  ollamaAuthState,
  projectProviderInventory,
} from './provider-inventory';

export const PROVIDER_STATUS_DEADLINE_MS = 25_000;

/** Where the host reads; production values lazy-import their modules on first use. */
export interface DesktopProviderSources {
  buildRegistry(): ModelRegistrySnapshot | Promise<ModelRegistrySnapshot>;
  supported():
    | Readonly<Record<WorkerAgentProviderId, boolean>>
    | Promise<Readonly<Record<WorkerAgentProviderId, boolean>>>;
  readAuthState(
    provider: WorkerAgentProviderId,
    probe: boolean,
    scope: CanopyWorkspaceScope,
  ): Promise<WorkerAgentProviderAuthState>;
  readUsage(): Promise<PortalProviderUsageProjection>;
  resolveOwner(scope: CanopyWorkspaceScope): Promise<unknown>;
  refreshPolicy(owner: unknown): Promise<void>;
  isBlocked(modelId: string, owner: unknown): boolean;
  now(): Date;
}

const AUTH_STATUS_REASON = 'worker-provider-list';

async function readNativeAuthState(
  provider: 'claude' | 'codex',
  probe: boolean,
  workspaceId: string | undefined,
): Promise<WorkerAgentProviderAuthState> {
  const auth = await import('../auth/provider-auth-state');
  const { hasUserSuppliedProviderCredential } =
    await import('../agents/ai-credits-routing');
  const userSupplied = hasUserSuppliedProviderCredential(provider, workspaceId);
  if (!probe)
    return nativeAuthState(
      auth.peekProviderNativeAuthAvailability()[provider],
      userSupplied,
    );
  const status =
    provider === 'claude'
      ? await auth.getCachedClaudeAuthStatusObserved(AUTH_STATUS_REASON)
      : await auth.getCachedCodexAuthStatusObserved(AUTH_STATUS_REASON);
  return nativeAuthState(status, userSupplied);
}

const productionSources = {
  async buildRegistry(): Promise<ModelRegistrySnapshot> {
    return (
      await import('../models/model-registry')
    ).buildModelRegistrySnapshot();
  },
  async supported(): Promise<Readonly<Record<WorkerAgentProviderId, boolean>>> {
    const [cursor, copilot, opencode] = await Promise.all([
      import('@canopy/desktop-shared/node/cursor/runtime-metadata'),
      import('@canopy/desktop-shared/node/copilot/runtime-metadata'),
      import('@canopy/desktop-shared/node/opencode/runtime-metadata'),
    ]);
    return {
      antigravity:
        isAntigravityHarnessEnabled() &&
        hostPlatformOperatingSystem() === 'darwin',
      claude: true,
      codex: true,
      ollama: isOllamaSupportedOnPlatform(),
      cursor:
        isCursorHarnessEnabled() &&
        cursor.getCursorRuntimeArtifact() !== undefined,
      copilot:
        isCopilotHarnessEnabled() &&
        copilot.getCopilotRuntimeArtifact() !== undefined,
      opencode:
        isOpenCodeHarnessEnabled() &&
        opencode.getOpenCodeRuntimeArtifact() !== undefined,
    };
  },
  async readAuthState(
    provider: WorkerAgentProviderId,
    probe: boolean,
    scope: CanopyWorkspaceScope,
  ): Promise<WorkerAgentProviderAuthState> {
    switch (provider) {
      case 'claude':
      case 'codex':
        return readNativeAuthState(provider, probe, scope.workspaceId);
      case 'ollama': {
        const { getOllamaService } = await import('../ollama');
        return ollamaAuthState(await getOllamaService().getState());
      }
      case 'cursor': {
        const cursor = await import('../cursor/runtime-availability');
        return availabilityAuthState(
          probe
            ? await cursor.isCursorRuntimeAvailable()
            : cursor.peekCursorRuntimeAvailability(),
        );
      }
      case 'antigravity': {
        const google = await import('../antigravity/models');
        return availabilityAuthState(
          probe
            ? await google.refreshAntigravityModels()
            : google.peekAntigravityAvailability(),
        );
      }
      case 'copilot': {
        const copilot = await import('../copilot/runtime-availability');
        return availabilityAuthState(
          probe
            ? await copilot.isCopilotRuntimeAvailable()
            : copilot.peekCopilotRuntimeAvailability(),
        );
      }
      case 'opencode': {
        const opencode = await import('../opencode/runtime-availability');
        return availabilityAuthState(
          probe
            ? await opencode.isOpenCodeRuntimeAvailable()
            : opencode.peekOpenCodeRuntimeAvailability(),
        );
      }
    }
  },
  async readUsage(): Promise<PortalProviderUsageProjection> {
    const { getObservabilityService } = await import('../observability');
    const usage = await import('../portal/provider-usage-projection');
    return usage.projectPortalProviderUsage(
      getObservabilityService().getUsageOverview(),
      await usage.readPortalProviderUsageAccountProxySource(),
    );
  },
  async resolveOwner(
    scope: CanopyWorkspaceScope,
  ): Promise<WorkOwner | undefined> {
    const { resolveAiCreditsScopeOwner } = await import('../agents/work-owner');
    return resolveAiCreditsScopeOwner(
      scope.workspaceId
        ? {
            kind: 'work',
            projectId: scope.workspaceId,
            ...(scope.worktreeId ? { worktreeId: scope.worktreeId } : {}),
            ...(scope.chatId ? { chatId: scope.chatId } : {}),
          }
        : undefined,
    );
  },
  async refreshPolicy(owner: WorkOwner | undefined): Promise<void> {
    const { isOrgModelPolicyActiveForStoredAccount } =
      await import('../lib/model-policy-state');
    await isOrgModelPolicyActiveForStoredAccount(owner);
  },
  isBlocked(modelId: string, owner: WorkOwner | undefined): boolean {
    return isModelBlockedByCurrentPolicy(modelId, owner);
  },
  now(): Date {
    return new Date();
  },
};

export const desktopProviderSources: DesktopProviderSources = productionSources;

const registryCapture = new AsyncLocalStorage<{
  snapshot: ModelRegistrySnapshot | undefined;
}>();

/** Run `fn` with a capture slot; the host stores the registry snapshot it built there. */
export async function runWithModelRegistryCapture<T>(
  fn: () => Promise<T>,
): Promise<{ value: T; snapshot: ModelRegistrySnapshot | undefined }> {
  const slot: { snapshot: ModelRegistrySnapshot | undefined } = {
    snapshot: undefined,
  };
  const value = await registryCapture.run(slot, fn);
  return { value, snapshot: slot.snapshot };
}

function withDeadline<T>(read: Promise<T>, deadlineMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error('Provider status read timed out.')),
      deadlineMs,
    );
  });
  return Promise.race([read, deadline]).finally(() => clearTimeout(timer));
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

class PolicyReadFailed extends Error {}

/** The desktop host: local authority, the in-process worker target (D5). */
export function createDesktopProviderHost(
  sources: DesktopProviderSources = desktopProviderSources,
): WorkerAgentProviderHost {
  return {
    authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
    targetId: CANOPY_IN_PROCESS_WORKER_TARGET_ID,
    async list({ scope, probe }) {
      const supported = await sources.supported();

      const authStates: Partial<
        Record<WorkerAgentProviderId, WorkerAgentProviderAuthState>
      > = {};
      const authReads = WORKER_AGENT_PROVIDER_IDS.filter(
        (provider) => supported[provider],
      ).map(async (provider) => {
        try {
          authStates[provider] = await withDeadline(
            sources.readAuthState(provider, probe, scope),
            PROVIDER_STATUS_DEADLINE_MS,
          );
        } catch (error) {
          authStates[provider] = 'error';
          logMainProcessWarn('[agent-providers] provider status read failed', {
            provider,
            error: errorName(error),
          });
        }
      });
      const usageRead = sources.readUsage().catch((error: unknown) => {
        logMainProcessWarn('[agent-providers] usage read failed', {
          error: errorName(error),
        });
        return null;
      });
      const policyRead = (async (): Promise<
        { readonly owner: unknown } | undefined
      > => {
        try {
          const owner = await sources.resolveOwner(scope);
          if (probe) await sources.refreshPolicy(owner);
          return { owner };
        } catch (error) {
          logMainProcessWarn('[agent-providers] model policy read failed', {
            error: errorName(error),
          });
          return undefined;
        }
      })();
      const [usage, policy] = await Promise.all([
        usageRead,
        policyRead,
        ...authReads,
      ]);

      const registry = await sources.buildRegistry();
      const capture = registryCapture.getStore();
      if (capture) capture.snapshot = registry;

      const checkedAt = sources.now().toISOString();
      const project = (
        isBlocked: (modelId: string) => boolean,
      ): ReturnType<typeof projectProviderInventory> =>
        projectProviderInventory({
          registry,
          supported,
          authStates,
          checkedAt,
          usage,
          isBlocked,
          warn: logMainProcessWarn,
        });
      const blockEverything = (): boolean => true;
      if (!policy) return project(blockEverything);
      try {
        return project((modelId) => {
          try {
            return sources.isBlocked(modelId, policy.owner);
          } catch (error) {
            throw new PolicyReadFailed(errorName(error));
          }
        });
      } catch (error) {
        if (!(error instanceof PolicyReadFailed)) throw error;
        logMainProcessWarn('[agent-providers] model policy read failed', {
          error: error.message,
        });
        return project(blockEverything);
      }
    },
  };
}
