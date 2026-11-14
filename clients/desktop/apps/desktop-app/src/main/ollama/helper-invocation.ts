import {
  createAccountProxyQuotaWait,
  type AccountProxyQuotaWait,
} from '../account-proxy/quota-wait';
import {
  getExecutionHarnessForModel,
  getModelSource,
  type ChatModel,
  type AiCreditsRoutingState,
  type ModelHarness,
  type ModelHarnessSource,
} from '@canopy/desktop-shared/types';
import type { CodexConfig } from '@canopy/execution-engine/lib/codex-model-config';
import type { WorkOwner } from '@canopy/protocol/llm-gateway';
import { resolveClaudeCompatibleInvocation } from './claude-compatible';
import {
  resolveAiCreditsRoutingOverride,
  type ResolveAiCreditsRoutingOverrideOptions,
} from '../agents/ai-credits-routing';
import { resolveCodexCompatibleOllamaInvocation } from './codex-compatible';
import { getCodexGatewayProxyService } from '../agents/codex-gateway-proxy-service';
import {
  checkModelGatewayRoute,
  resolveHelperModelForEnforcedGateway,
} from '../lib/model-gateway-state';
import {
  resolveBackgroundWorkOwner,
  resolveInvocationWorkOwner,
} from '../agents/work-owner';
import { randomUUID } from 'node:crypto';

/**
 * Resolved invocation for an in-process background helper task (worktree /
 * chat / archive / handoff summaries, branch naming, commit-message and PR
 * generation, plan-diagram generation).
 *
 * This is the single place helper routing lives, so explicit routing state and
 * global `on`/`on-quota` mode apply to every helper uniformly and future
 * helpers get AI Credits routing for free.
 *
 * Precedence is **E2E mock > Ollama > AI Credits > native**:
 * - The UI-automation Anthropic mock (surfaced as a Claude `envOverride` by
 *   `resolveClaudeCompatibleInvocation`) always wins so deterministic tests are
 *   never routed through the gateway.
 * - Ollama models are local and never gateway-routable, so they bypass routing.
 * - Otherwise, if AI Credits routing resolves an override it is applied.
 * - Otherwise the helper falls back to the native provider path.
 */
export interface HelperInvocation {
  waitForQuotaRecovery?: AccountProxyQuotaWait;
  providerType: 'claude' | 'ollama' | 'codex';
  source: ModelHarnessSource;
  harness: Exclude<
    ModelHarness,
    'cursor' | 'copilot' | 'opencode' | 'antigravity'
  >;
  /** Selected catalog model after policy routing, before SDK slug translation. */
  resolvedModel?: string;
  /** SDK model id to run (gateway slug when routed, else the native model). */
  sdkModel?: string;
  /**
   * Claude proxy / Ollama / E2E-mock env override merged into the helper's SDK
   * `env`. Routed Codex helpers receive only thread-scoped provider config.
   */
  envOverride?: Record<string, string>;
  /** Nested Codex provider block for the SDK `config` path (routed Codex only). */
  codexConfig?: CodexConfig;
  /** True iff AI Credits routing was actually applied to this invocation. */
  aiCreditsRouted: boolean;
  /** True when the invocation goes to the account proxy (CAN-4020). */
  accountProxyRouted?: boolean;
  /** Stable proxy identity for continuations; set with `accountProxyRouted`. */
  accountProxyAccountKey?: string;
  /** Revoke any parent-owned gateway routes allocated for this helper. */
  dispose: () => void;
}

/** Options for {@link resolveHelperInvocation}. */
export interface ResolveHelperInvocationOptions {
  signal?: AbortSignal;
  /** Refuse gateway substitution when a helper's selected route is a data boundary. */
  preserveModelSelection?: boolean;
  /** Optional native billing choice captured by the owning chat. */
  subscriptionBillingOverride?: boolean;
  /**
   * Whether an absent native login may route this helper through AI Credits.
   * Forwarded to `resolveAiCreditsRoutingOverride`; see that option's docs.
   *
   * Defaults to `true`. Unattended callers — work that runs on a schedule
   * rather than because the user asked for it — pass `false` so a background
   * task can never silently spend a credit (ECW-9091 review rounds 5-6).
   *
   * This must be threaded through BOTH provider branches below: the worktree
   * summary generator dispatches on model provider, and its default model is a
   * Claude one, so opting out only the Codex path leaves the default
   * configuration unprotected.
   */
  allowNoNativeAuthFallback?: boolean;
  /**
   * Workspace this helper will spawn for, forwarded to the user-supplied-
   * credential guard.
   *
   * Load-bearing, not cosmetic: `resolveEnvironmentForRuntime` picks
   * `workspaceAssignment?.runtimes[runtime] ?? globalRuntimes[runtime]` — a
   * workspace assignment REPLACES the global one rather than merging. So
   * resolving the guard without a workspace reads a different environment than
   * the spawn actually gets, and a per-workspace `ANTHROPIC_API_KEY` would be
   * invisible to the guard while live at spawn — the exact suppression the
   * guard exists to prevent (ECW-9091 review round 7).
   */
  workspaceId?: string;
  /**
   * Owner already bound by the work this helper runs for, e.g. a delegation
   * child's parent chat. Without it the owner is resolved from `workspaceId`
   * and the navigation context when the helper starts (CAN-3456). Property
   * presence is significant: an explicit `undefined` preserves a bound missing
   * owner instead of consulting live navigation again.
   */
  workOwner?: WorkOwner | null;
  /**
   * Persisted context for a background run. Presence identifies background
   * work even when the legacy value itself is absent, which binds Personal.
   */
  executionContext?: string;
  /** Route key of the chat this helper works for; see the override option. */
  accountProxyParentSessionId?: string;
  retainRoutesUntilDisposed?: boolean;
  /** Called once when the invocation takes its route hold. */
  onRoutesRetained?: () => void;
}

export async function resolveHelperWorkOwner(
  options: ResolveHelperInvocationOptions,
): Promise<WorkOwner | undefined> {
  if (Object.prototype.hasOwnProperty.call(options, 'workOwner')) {
    return options.workOwner ?? undefined;
  }
  return 'executionContext' in options
    ? resolveBackgroundWorkOwner(
        {
          ...(options.workspaceId ? { projectId: options.workspaceId } : {}),
        },
        options.executionContext,
      )
    : resolveInvocationWorkOwner({
        ...(options.workspaceId ? { projectId: options.workspaceId } : {}),
      });
}

/**
 * Resolve the effective invocation (provider + model + env/config overrides)
 * for a background helper task, layering AI Credits routing on top of the
 * existing Ollama / E2E-mock resolution. Helpers usually pass no routing state,
 * so the global routing mode decides.
 */
export async function resolveHelperInvocation(
  requestedModel: ChatModel | undefined,
  routingState?: AiCreditsRoutingState,
  options: ResolveHelperInvocationOptions = {},
): Promise<HelperInvocation> {
  // Begin the capture before any model/policy lookup can yield. The promise is
  // consumed only on a gateway-capable branch, but its navigation snapshot is
  // fixed at helper invocation start (CAN-3456).
  const workOwnerPromise = resolveHelperWorkOwner(options);
  const owner = await workOwnerPromise;
  if (options.preserveModelSelection) {
    const admission = await checkModelGatewayRoute(requestedModel, owner);
    if (!admission.ok) throw new Error(admission.message);
  }
  // Resolved FIRST, so the source/harness derivation below and every provider
  // branch after it see the model that will actually run. See
  // {@link resolveHelperModelForEnforcedGateway} for why a helper substitutes
  // where an org model policy refuses.
  const model = options.preserveModelSelection
    ? requestedModel
    : await resolveHelperModelForEnforcedGateway(requestedModel, owner);
  const buildRoutingOptions =
    async (): Promise<ResolveAiCreditsRoutingOverrideOptions> => {
      const workOwner = await workOwnerPromise;
      return {
        ...(options.subscriptionBillingOverride !== undefined
          ? { subscriptionBillingOverride: options.subscriptionBillingOverride }
          : {}),
        ...(options.allowNoNativeAuthFallback !== undefined
          ? { allowNoNativeAuthFallback: options.allowNoNativeAuthFallback }
          : {}),
        ...(options.workspaceId !== undefined
          ? { workspaceId: options.workspaceId }
          : {}),
        ...(options.accountProxyParentSessionId !== undefined
          ? { accountProxyParentSessionId: options.accountProxyParentSessionId }
          : {}),
        workOwner,
        signal: options.signal,
      };
    };
  const source = model ? getModelSource(model) : 'claude-managed';
  const harness = model ? getExecutionHarnessForModel(model) : 'claude';
  if (harness === 'cursor')
    throw new Error('Cursor is not available for background helpers.');
  if (harness === 'antigravity')
    throw new Error(
      'Google subscription models are available in chats, not background helpers.',
    );
  if (harness === 'opencode')
    throw new Error('OpenCode is not available for background helpers.');
  if (harness === 'copilot')
    throw new Error('Copilot is not available for background helpers.');
  if (!source || !harness) {
    throw new Error(`Unknown model "${model ?? ''}".`);
  }
  const routeSessionId = `ephemeral:helper:${randomUUID()}`;
  let disposed = false;
  let releaseQuotaRoutes: (() => void) | undefined;
  let releaseInvocationRoutes: (() => void) | undefined;
  const dispose = (): void => {
    if (disposed) {
      return;
    }
    disposed = true;
    options.signal?.removeEventListener('abort', dispose);
    getCodexGatewayProxyService().unregisterRoutesForSession(routeSessionId);
    releaseQuotaRoutes?.();
    releaseInvocationRoutes?.();
  };
  const holdUntilDisposed = (): void => {
    if (!options.retainRoutesUntilDisposed || disposed) return;
    releaseInvocationRoutes ??=
      getCodexGatewayProxyService().retainRoutesForSession(routeSessionId);
    options.onRoutesRetained?.();
    if (options.signal?.aborted) dispose();
    else options.signal?.addEventListener('abort', dispose, { once: true });
  };

  const quotaWait = (
    accountKey: string | undefined,
  ): AccountProxyQuotaWait | undefined => {
    const wait = createAccountProxyQuotaWait(harness, accountKey);
    if (!wait) return undefined;
    return async (failure, signal): Promise<void> => {
      if (disposed) throw new Error('Helper invocation was released.');
      signal?.throwIfAborted();
      releaseQuotaRoutes ??=
        getCodexGatewayProxyService().retainRoutesForSession(routeSessionId);
      await wait(failure, signal);
      signal?.throwIfAborted();
      if (disposed) throw new Error('Helper invocation was released.');
    };
  };

  try {
    if (source === 'ollama') {
      if (harness === 'codex') {
        const invocation = await resolveCodexCompatibleOllamaInvocation(model, {
          ensureRunningReason: 'helper',
          assertInstalled: true,
        });
        return {
          providerType: 'ollama',
          source,
          harness,
          sdkModel: invocation.runtimeModel,
          resolvedModel: model,
          codexConfig: invocation.codexConfig,
          aiCreditsRouted: false,
          dispose,
        };
      }
      const base = await resolveClaudeCompatibleInvocation(model, {
        providerType: 'ollama',
        ensureRunningReason: 'helper',
        assertInstalled: true,
      });
      return {
        ...base,
        source,
        harness,
        resolvedModel: model,
        aiCreditsRouted: false,
        dispose,
      };
    }

    if (harness === 'codex') {
      // The runtime resolves the app-server E2E profile separately. Only AI
      // Credits routing is represented here.
      const override = await resolveAiCreditsRoutingOverride(
        model,
        'codex',
        routingState,
        routeSessionId,
        await buildRoutingOptions(),
      );
      if (override) {
        if (override.accountProxyRouted) holdUntilDisposed();
        return {
          providerType: 'codex',
          source,
          harness,
          sdkModel: override.model,
          resolvedModel: model,
          codexConfig: override.codexConfig,
          aiCreditsRouted: override.accountProxyRouted !== true,
          ...(override.accountProxyRouted
            ? {
                accountProxyRouted: true,
                waitForQuotaRecovery: quotaWait(
                  override.accountProxyAccountKey,
                ),
                ...(override.accountProxyAccountKey
                  ? { accountProxyAccountKey: override.accountProxyAccountKey }
                  : {}),
              }
            : {}),
          dispose,
        };
      }
      return {
        providerType: 'codex',
        source,
        harness,
        resolvedModel: model,
        ...(model ? { sdkModel: model } : {}),
        aiCreditsRouted: false,
        dispose,
      };
    }

    const base = await resolveClaudeCompatibleInvocation(model);

    // Ollama and the deterministic E2E Anthropic mock both take precedence over
    // AI Credits routing. The mock is the only case where a Claude invocation
    // carries an `envOverride`.
    if (base.envOverride) {
      return {
        ...base,
        source,
        harness,
        resolvedModel: model,
        aiCreditsRouted: false,
        dispose,
      };
    }

    const override = await resolveAiCreditsRoutingOverride(
      model,
      'claude',
      routingState,
      routeSessionId,
      await buildRoutingOptions(),
    );
    if (override?.accountProxyRouted) {
      holdUntilDisposed();
      // The proxy serves the native model id, so the SDK model is unchanged.
      return {
        ...base,
        source,
        harness,
        resolvedModel: model,
        envOverride: override.env,
        aiCreditsRouted: false,
        accountProxyRouted: true,
        waitForQuotaRecovery: quotaWait(override.accountProxyAccountKey),
        ...(override.accountProxyAccountKey
          ? { accountProxyAccountKey: override.accountProxyAccountKey }
          : {}),
        dispose,
      };
    }
    if (override) {
      return {
        providerType: 'claude',
        source,
        harness,
        sdkModel: override.model,
        resolvedModel: model,
        envOverride: override.env,
        aiCreditsRouted: true,
        dispose,
      };
    }
    return {
      ...base,
      source,
      harness,
      resolvedModel: model,
      aiCreditsRouted: false,
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
