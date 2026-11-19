import type { WorkOwner } from '@canopy/protocol/llm-gateway';
import {
  getExecutionHarnessForModel,
  getProviderForModel,
  resolveProviderModelConfig,
  type AgentModelConfig,
  type ChatModel,
  type PreferencesData,
  type ThinkingLevel,
} from '@canopy/desktop-shared/types';
import {
  LOCAL_MEMORY_MODEL_BLOCKED_MESSAGE,
  LOCAL_MEMORY_MODEL_UNAVAILABLE_MESSAGE,
} from '@canopy/desktop-shared/types/local-memory';
import { resolveAvailableModel } from '../../lib/model-availability';
import type { ConsolidationRunOutcome } from './consolidation-state';

export interface LocalMemoryHelperModel {
  model: ChatModel;
  thinkingLevel: ThinkingLevel;
  modelConfig?: AgentModelConfig;
}

/**
 * The memory model the user chose cannot run right now (for example, Ollama
 * is not running). Memory runs skip with this message as their reason rather
 * than send saved memory to another model.
 */
export class LocalMemoryModelUnavailableError extends Error {
  constructor() {
    super(LOCAL_MEMORY_MODEL_UNAVAILABLE_MESSAGE);
    this.name = 'LocalMemoryModelUnavailableError';
  }
}

/**
 * The model every local-memory helper run uses: the user's local memory
 * model and its thinking level, resolved against the provider defaults. Kept
 * free of the structured-helper stack so the scheduler can import it on the
 * startup path.
 *
 * Fails closed: a model this install cannot run right now throws
 * {@link LocalMemoryModelUnavailableError}. Runtime preferences keep a chosen
 * memory model even while it is unavailable, so this never substitutes
 * another provider's model.
 */
export function resolveLocalMemoryHelperModel(
  preferences: Pick<
    PreferencesData,
    | 'localMemoryModel'
    | 'localMemoryThinkingLevel'
    | 'providerModelConfigDefaults'
  >,
): LocalMemoryHelperModel {
  const model = resolveAvailableModel(preferences.localMemoryModel);
  if (model === null) throw new LocalMemoryModelUnavailableError();
  return helperModelForChatModel(
    model,
    preferences.localMemoryThinkingLevel,
    preferences,
  );
}

/**
 * A structured-helper model for `model` at `thinkingLevel`, resolved against
 * the provider defaults. Shared by the memory model and callers that run a
 * helper on the user's default chat model instead.
 */
export function helperModelForChatModel(
  model: ChatModel,
  thinkingLevel: ThinkingLevel,
  preferences: Pick<PreferencesData, 'providerModelConfigDefaults'>,
): LocalMemoryHelperModel {
  const modelProvider = getProviderForModel(model);
  const executionHarness =
    getExecutionHarnessForModel(model) ??
    (modelProvider === 'codex'
      ? 'codex'
      : modelProvider
        ? 'claude'
        : undefined);
  if (!executionHarness) {
    throw new Error(`No execution harness is available for model "${model}".`);
  }
  const modelConfig = resolveProviderModelConfig(
    executionHarness,
    { thinkingLevel },
    preferences.providerModelConfigDefaults,
  );
  return {
    model,
    thinkingLevel: modelConfig.thinkingLevel,
    modelConfig,
  };
}

function failureReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The model a memory run is about to use, or the outcome to record instead
 * of running. This is the one place scheduled runs, manual runs, rebuild
 * runs, and the chat history profile decide it, so they cannot disagree: a
 * chosen model that cannot run right now, that the stored organization
 * policy blocks for the scope, or whose provider is signed out with no
 * billing source, skips with the message that says why, and any other error
 * fails. Memory is never sent to another model instead.
 */
export async function resolveLocalMemoryRunModel(
  preferences: Parameters<typeof resolveLocalMemoryHelperModel>[0],
  workspaceId?: string,
  owner?: { workOwner: WorkOwner | null },
): Promise<
  { helperModel: LocalMemoryHelperModel } | { refusal: ConsolidationRunOutcome }
> {
  let helperModel: LocalMemoryHelperModel;
  try {
    helperModel = resolveLocalMemoryHelperModel(preferences);
  } catch (error) {
    return {
      refusal:
        error instanceof LocalMemoryModelUnavailableError
          ? { result: 'skipped', reason: error.message }
          : { result: 'failed', reason: failureReason(error) },
    };
  }
  try {
    // Loaded on demand to keep the helper invocation stack off the startup
    // import path; local dynamic imports are safe in packaged main.
    const { isLocalMemoryModelBlockedByPolicy } =
      await import('./model-policy');
    if (
      await isLocalMemoryModelBlockedByPolicy(
        helperModel.model,
        workspaceId,
        owner,
      )
    ) {
      return {
        refusal: {
          result: 'skipped',
          reason: LOCAL_MEMORY_MODEL_BLOCKED_MESSAGE,
        },
      };
    }
  } catch (error) {
    return { refusal: { result: 'failed', reason: failureReason(error) } };
  }
  // A provider known (from caches) to be signed out with nothing to pay for
  // the run would refuse the helper before any spawn (CAN-7062). Skip before
  // the caller opens an audit entry; the pending input is left for the next
  // run after sign-in. A cold cache runs, and the helper refuses itself.
  const provider = getProviderForModel(helperModel.model);
  if (provider === 'claude' || provider === 'codex') {
    const [
      { isNoBillingSourceRefusalCached },
      { helperNoBillingSourceMessage },
    ] = await Promise.all([
      import('../../agents/no-billing-source-refusal'),
      import('../../agents/helper-no-billing-source'),
    ]);
    if (
      isNoBillingSourceRefusalCached(
        {
          model: helperModel.model,
          ...(workspaceId === undefined ? {} : { projectId: workspaceId }),
        },
        provider,
      )
    ) {
      return {
        refusal: {
          result: 'skipped',
          reason: helperNoBillingSourceMessage(provider),
        },
      };
    }
  }
  return { helperModel };
}
