import { getRawOpenCodeModelId } from '@canopy/execution-engine/lib/opencode-models';
import {
  resolveGatewayModelEntry,
  resolveOwnerGatewayModelId,
} from '@canopy/execution-engine/lib/gateway-model-availability';
import {
  prepareOpenCodeInferenceRoute,
  type OpenCodeInferenceRoute,
} from '@canopy/desktop-shared/node/opencode/inference-route';
import type { ThinkingLevel } from '@canopy/protocol/thinking';
import type { AiCreditsAttribution } from '../agents/ai-credits-routing';
import {
  openOpenCodeInferenceLease,
  type OpenCodeInferenceLease,
} from './inference-host';
import {
  openManagedOpenCodeRuntime,
  assertOpenCodeModelAvailable,
  assertOpenCodeRuntimeModelAvailable,
  type ManagedOpenCodeRuntime,
} from './connection';

export interface OpenCodeExecutionRuntime extends ManagedOpenCodeRuntime {
  rawModelId: string;
  supportsVision: boolean;
  supportedThinkingLevels: readonly ThinkingLevel[];
  inferenceRoute?: OpenCodeInferenceRoute;
  accountScope: 'native' | 'ai_credits';
  inferenceFunding?: 'ai-credits' | 'org-gateway';
  failureError?: OpenCodeInferenceLease['failureError'];
}

/** One host authority/cleanup path for interactive, delegated and pipeline turns. */
export async function openOpenCodeExecutionRuntime(input: {
  model: string;
  sessionId: string;
  cwd?: string;
  signal: AbortSignal;
  attribution: () => Promise<AiCreditsAttribution>;
  workspaceId?: string;
  restrictedEnvironment?: boolean;
  executionKind?: 'agent' | 'pipeline';
  environment?: Record<string, string>;
  scopedModelDiscovery?: boolean;
  expectedInferenceBindingKey?: string;
}): Promise<OpenCodeExecutionRuntime> {
  const options = {
    ...input,
    ...(input.environment ? { environment: { ...input.environment } } : {}),
  };
  const nativeModel = getRawOpenCodeModelId(options.model);
  let lease: OpenCodeInferenceLease | null = null;
  let runtime: ManagedOpenCodeRuntime | undefined;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> =>
    (closing ??= (async (): Promise<void> => {
      try {
        try {
          lease?.dispose();
        } finally {
          await runtime?.close();
        }
      } catch (error) {
        // Cleanup can fail after a paid response. Never turn that into a new paid retry.
        throw lease ? lease.failureError(error) : error;
      }
    })());
  try {
    options.signal.throwIfAborted();
    if (!nativeModel) {
      const attribution = await options.attribution();
      const entry = resolveGatewayModelEntry(
        resolveOwnerGatewayModelId(options.model, attribution.workOwner),
      );
      if (!entry)
        throw new Error(
          'This model is unavailable with OpenCode. Choose another model.',
        );
      options.signal.throwIfAborted();
      lease = await openOpenCodeInferenceLease({
        model: options.model,
        sessionId: options.sessionId,
        attribution,
        signal: options.signal,
        // Explicit app response budget. Catalogs do not declare provider output maxima.
        outputLimit: Math.min(16_384, entry.contextWindow),
      });
      if (!lease)
        throw new Error('The selected inference route is unavailable.');
      if (
        options.expectedInferenceBindingKey !== undefined &&
        lease.route.bindingKey !== options.expectedInferenceBindingKey
      )
        throw new Error(
          'The selected funding account changed. Start this task again.',
        );
    }
    const signal = lease
      ? AbortSignal.any([options.signal, lease.signal])
      : options.signal;
    signal.throwIfAborted();
    runtime = await openManagedOpenCodeRuntime({
      signal,
      workspaceId: options.workspaceId,
      environment: options.environment,
      restrictedEnvironment: options.restrictedEnvironment,
      executionKind: options.executionKind,
      ...(lease ? { providerConfiguration: 'host-inference' } : {}),
    });
    runtime.signal.throwIfAborted();
    if (lease) {
      const prepared = prepareOpenCodeInferenceRoute(lease.route);
      return {
        ...runtime,
        close,
        inferenceRoute: prepared.route,
        rawModelId: prepared.rawModelId,
        supportsVision: lease.route.model.supportsVision,
        supportedThinkingLevels: [],
        accountScope: 'ai_credits',
        inferenceFunding: lease.funding,
        failureError: lease.failureError,
      };
    }
    if (!nativeModel) throw new Error('Choose an OpenCode model.');
    if (options.scopedModelDiscovery && !options.cwd)
      throw new Error('The pipeline working directory is unavailable.');
    const model =
      options.scopedModelDiscovery && options.cwd
        ? await assertOpenCodeRuntimeModelAvailable(
            options.model,
            runtime,
            options.cwd,
          )
        : await assertOpenCodeModelAvailable(options.model, runtime.signal);
    runtime.signal.throwIfAborted();
    return {
      ...runtime,
      close,
      rawModelId: nativeModel,
      supportsVision: model.supportsVision === true,
      supportedThinkingLevels: model.supportedThinkingLevels ?? [],
      accountScope: 'native',
    };
  } catch (error) {
    await close();
    throw error;
  }
}
