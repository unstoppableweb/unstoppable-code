import type {
  AgentProviderType,
  AssistantMode,
  ChatInterfaceMode,
  ChatTabPluginSelections,
  DeferredResourceSummary,
  DeferredToolsReloadAdditions,
  DeferredToolsReloadScopeKey,
  LoadDeferredToolRejection,
  LoadDeferredToolRejectionCode,
  LoadDeferredToolsResult,
} from '@canopy/desktop-shared/types';
import type {
  DeferredToolProvider,
  SearchDeferredToolsInput,
} from '@canopy/desktop-shared/types';
import {
  buildDeferredToolsCatalog,
  classifyLoadItems,
  searchDeferredCatalogResult,
} from './catalog';
import {
  loadDeferredToolsSchema,
  searchDeferredToolsSchema,
} from './definitions';
import { recordIssuedDeferredRefs, wasDeferredRefIssued } from './issued-refs';
import { deferredToolsReloadCoordinator } from './reload-coordinator';

export interface DeferredToolsReloadSink {
  request(input: {
    readonly toolCallId: string;
    readonly refs: readonly string[];
    readonly additions: DeferredToolsReloadAdditions;
    readonly enabledResources: readonly DeferredResourceSummary[];
  }):
    | { accepted: true; reloadId: string }
    | {
        accepted: false;
        code: 'reload_in_progress' | 'reload_limit';
        message: string;
      };
}

export interface DeferredToolsExecutorRuntime {
  scope: DeferredToolsReloadScopeKey;
  providerType?: AgentProviderType;
  interfaceMode?: ChatInterfaceMode;
  assistantMode?: AssistantMode;
  pluginSelections?: ChatTabPluginSelections;
  /** Missing values are allowed for backward compatibility. */
  allowed?: boolean;
  /** Managed delegates route accepted loads to their in-run reload controller. */
  reloadSink?: DeferredToolsReloadSink;
}

type DeferredLoadRejection = Omit<LoadDeferredToolRejection, 'code'> & {
  code: LoadDeferredToolRejectionCode | 'reload_limit';
};

type DeferredLoadResult = Omit<LoadDeferredToolsResult, 'rejected'> & {
  rejected: DeferredLoadRejection[];
};

export interface DeferredToolsExecutionResult {
  text: string;
  isError?: boolean;
}

interface LoadDeferredToolsContext {
  toolUseId?: string;
}

function deferredProvider(
  providerType: AgentProviderType | undefined,
): DeferredToolProvider {
  if (providerType === 'copilot') return 'copilot';
  if (providerType === 'codex') return 'codex';
  if (providerType === 'ollama') return 'ollama';
  if (providerType === 'opencode') return 'opencode';
  if (providerType === 'antigravity') return 'antigravity';
  return 'claude';
}

function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function deferredToolsUnavailable(): DeferredToolsExecutionResult {
  return {
    text: 'Deferred tools are not available for this chat. Instruct user to enable using the plugin picker from the chat composer.',
    isError: true,
  };
}

export function resetDeferredToolsRefRegistryForTests(): void {
  // Kept for older tests that reset executor module state between cases.
}

export async function executeSearchDeferredTools(
  rawArgs: unknown,
  runtime: DeferredToolsExecutorRuntime,
): Promise<DeferredToolsExecutionResult> {
  if (runtime.allowed === false) {
    return deferredToolsUnavailable();
  }
  const parsed = searchDeferredToolsSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return {
      text: 'Invalid arguments for SearchDeferredTools.',
      isError: true,
    };
  }
  const provider = deferredProvider(runtime.providerType);
  const catalog = await buildDeferredToolsCatalog({
    provider,
    pluginSelections: runtime.pluginSelections,
  });
  const input: SearchDeferredToolsInput = parsed.data;
  const results = input.queries.map((query) => {
    const result = searchDeferredCatalogResult(catalog, query.text, {
      kinds: query.kinds,
      limit: query.limit,
    });
    return {
      query: query.text,
      matches: result.matches,
      ...(result.unsupportedMatches > 0
        ? { unsupportedMatches: result.unsupportedMatches }
        : {}),
    };
  });
  recordIssuedDeferredRefs(
    runtime.scope,
    results.flatMap((result) => result.matches.map((match) => match.ref)),
  );
  return { text: jsonText({ provider, results }) };
}

export async function executeLoadDeferredTools(
  rawArgs: unknown,
  runtime: DeferredToolsExecutorRuntime,
  context?: LoadDeferredToolsContext,
): Promise<DeferredToolsExecutionResult> {
  if (runtime.allowed === false) {
    return deferredToolsUnavailable();
  }
  const parsed = loadDeferredToolsSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return {
      text: 'Invalid arguments for LoadDeferredTools.',
      isError: true,
    };
  }
  const provider = deferredProvider(runtime.providerType);
  const catalog = await buildDeferredToolsCatalog({
    provider,
    pluginSelections: runtime.pluginSelections,
  });
  const classified = classifyLoadItems(
    catalog,
    parsed.data.items.map((item) => item.ref),
    (ref) => wasDeferredRefIssued(runtime.scope, ref),
  );
  const initialResult: LoadDeferredToolsResult = {
    status:
      classified.willEnable.length === 0
        ? 'error'
        : classified.rejected.length > 0
          ? 'partial_success'
          : 'success',
    willEnable: classified.willEnable,
    rejected: classified.rejected,
  };

  if (classified.willEnable.length === 0) {
    return { text: jsonText(initialResult), isError: true };
  }

  if (!context?.toolUseId) {
    return {
      text: jsonText({
        ...initialResult,
        status: 'error',
        rejected: [
          ...initialResult.rejected,
          ...classified.willEnable.map((item) => ({
            ref: item.ref,
            code: 'missing_tool_call_id' as const,
            message:
              'Cannot enable item because this tool call did not include a provider-owned tool call id.',
          })),
        ],
        willEnable: [],
      }),
      isError: true,
    };
  }
  const toolCallId = context.toolUseId;

  const willEnable = classified.willEnable;
  const rejected = classified.rejected;
  const additions = classified.additions;

  const baseResult: LoadDeferredToolsResult = {
    status:
      willEnable.length === 0
        ? 'error'
        : rejected.length > 0
          ? 'partial_success'
          : 'success',
    willEnable,
    rejected,
  };

  if (willEnable.length === 0) {
    return { text: jsonText(baseResult), isError: true };
  }

  if (runtime.reloadSink) {
    const admission = runtime.reloadSink.request({
      toolCallId,
      refs: willEnable.map((item) => item.ref),
      additions,
      enabledResources: willEnable,
    });
    if (!admission.accepted) {
      const result: DeferredLoadResult = {
        status: 'error',
        willEnable: [],
        rejected: [
          ...baseResult.rejected,
          ...willEnable.map(
            (item): DeferredLoadRejection => ({
              ref: item.ref,
              code: admission.code,
              message: admission.message,
            }),
          ),
        ],
      };
      return { text: jsonText(result), isError: true };
    }
    return { text: jsonText(baseResult) };
  }

  const admission = await deferredToolsReloadCoordinator.request({
    scope: runtime.scope,
    toolCallId,
    providerType: runtime.providerType,
    interfaceMode: runtime.interfaceMode,
    assistantMode: runtime.assistantMode,
    additions,
    enabledResources: willEnable,
  });
  if (!admission.accepted) {
    const message =
      admission.reason === 'reload_in_progress'
        ? 'Another deferred-tools reload is already in progress for this chat.'
        : 'Deferred tools cannot reload this chat right now. Continue with the tools you have.';
    return {
      text: jsonText({
        status: 'error',
        willEnable: [],
        rejected: [
          ...baseResult.rejected,
          ...willEnable.map((item) => ({
            ref: item.ref,
            code: 'reload_in_progress' as const,
            message,
          })),
        ],
      } satisfies LoadDeferredToolsResult),
      isError: true,
    };
  }

  return {
    // ACP tool IDs differ from the HTTP request ID. The native completed
    // tool result carries this receipt back after durable transcript delivery.
    text: jsonText({
      ...baseResult,
      ...(provider === 'opencode' ? { requestId: admission.requestId } : {}),
    }),
  };
}
