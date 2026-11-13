import {
  ASK_USER_HTTP_TIMEOUT_MS,
  CANOPY_MCP_TOOL_TIMEOUT_MS,
  isCanopyAskUserToolName,
} from '@canopy/execution-engine/lib/canopy-injected-tools';
import type { JsonValue } from './generated/serde_json/JsonValue';
import type { DynamicToolCallParams } from './generated/v2/DynamicToolCallParams';
import type { DynamicToolCallResponse } from './generated/v2/DynamicToolCallResponse';
import type { CodexHostToolPolicy } from './thread-handle';

const MAX_ARGUMENT_BYTES = 32 * 1024;
const MAX_RESULT_BYTES = 64 * 1024;
const MAX_CALLS_PER_TURN = 64;

function denied(text: string): DynamicToolCallResponse {
  return { success: false, contentItems: [{ type: 'inputText', text }] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBoundedJson(
  value: unknown,
  depth = 0,
  budget = { remaining: 4096, bytes: MAX_ARGUMENT_BYTES },
): value is JsonValue {
  budget.remaining -= 1;
  if (depth > 32 || budget.remaining < 0 || budget.bytes < 0) return false;
  if (typeof value === 'string') {
    if (value.length > budget.bytes) return false;
    budget.bytes -= Buffer.byteLength(value, 'utf8');
    return budget.bytes >= 0;
  }
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value))
    return value.every((entry: unknown) =>
      isBoundedJson(entry, depth + 1, budget),
    );
  return (
    isRecord(value) &&
    Object.entries(value).every(
      ([key, entry]) =>
        isBoundedJson(key, depth + 1, budget) &&
        isBoundedJson(entry, depth + 1, budget),
    )
  );
}

function normalizeJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    const result = value.map(normalizeJson);
    Object.freeze(result);
    return result;
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).sort()) {
      const entry = value[key];
      if (entry !== undefined)
        Object.defineProperty(result, key, {
          enumerable: true,
          value: normalizeJson(entry),
        });
    }
    Object.freeze(result);
    return result;
  }
  return value;
}

function parseCall(request: unknown): DynamicToolCallParams | undefined {
  if (!isRecord(request) || !isRecord(request.params)) return undefined;
  const params = request.params;
  if (
    typeof params.threadId !== 'string' ||
    params.threadId.length > 512 ||
    typeof params.turnId !== 'string' ||
    params.turnId.length > 512 ||
    typeof params.callId !== 'string' ||
    params.callId.length === 0 ||
    params.callId.length > 512 ||
    typeof params.tool !== 'string' ||
    params.tool.length > 256 ||
    !(
      params.namespace === null ||
      (typeof params.namespace === 'string' && params.namespace.length <= 256)
    ) ||
    !isBoundedJson(params.arguments)
  )
    return undefined;
  const args = normalizeJson(params.arguments);
  if (Buffer.byteLength(JSON.stringify(args), 'utf8') > MAX_ARGUMENT_BYTES)
    return undefined;
  return Object.freeze({
    threadId: params.threadId,
    turnId: params.turnId,
    callId: params.callId,
    namespace: params.namespace,
    tool: params.tool,
    arguments: args,
  });
}

export type CodexDynamicToolResultClass =
  | { readonly kind: 'ok'; readonly normalized: DynamicToolCallResponse }
  | { readonly kind: 'denied'; readonly text: string };

/**
 * The single bound for every host tool result: what the dispatcher would send,
 * or the denial it would send instead. Callers that shape a result to fit
 * (delegation output paging) classify with this same rule.
 */
export function classifyCodexDynamicToolResult(
  response: DynamicToolCallResponse,
): CodexDynamicToolResultClass {
  if (
    !Array.isArray(response.contentItems) ||
    response.contentItems.length > 256 ||
    typeof response.success !== 'boolean'
  )
    return { kind: 'denied', text: 'Invalid host tool result.' };
  let bytes = 0;
  for (const item of response.contentItems) {
    const value =
      item.type === 'inputText'
        ? item.text
        : item.type === 'inputImage'
          ? item.imageUrl
          : item.type === 'inputAudio'
            ? item.audioUrl
            : undefined;
    if (typeof value !== 'string' || value.length > MAX_RESULT_BYTES)
      return { kind: 'denied', text: 'Invalid or oversized host tool result.' };
    bytes += Buffer.byteLength(value, 'utf8');
    if (bytes > MAX_RESULT_BYTES)
      return {
        kind: 'denied',
        text: 'Host tool result exceeds the output limit.',
      };
  }
  const contentItems = response.contentItems.map((item) => {
    switch (item.type) {
      case 'inputText':
        return { type: item.type, text: item.text };
      case 'inputImage':
        return { type: item.type, imageUrl: item.imageUrl };
      case 'inputAudio':
        return { type: item.type, audioUrl: item.audioUrl };
    }
  });
  const result = { success: response.success, contentItems };
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_RESULT_BYTES)
    return {
      kind: 'denied',
      text: 'Host tool result exceeds the output limit.',
    };
  return { kind: 'ok', normalized: result };
}

function boundResponse(
  response: DynamicToolCallResponse,
): DynamicToolCallResponse {
  const classified = classifyCodexDynamicToolResult(response);
  return classified.kind === 'ok'
    ? classified.normalized
    : denied(classified.text);
}

/** One turn's private dispatcher; no callback or tool authority survives it. */
export class CodexHostToolDispatcher {
  private readonly calls = new Map<
    string,
    { fingerprint: string; response: Promise<DynamicToolCallResponse> }
  >();
  private readonly policy?: CodexHostToolPolicy;

  constructor(
    private readonly threadId: string,
    private readonly getTurnId: () => string | undefined,
    policy: CodexHostToolPolicy | undefined,
    private readonly signal: AbortSignal,
  ) {
    if (policy)
      this.policy = {
        allowedTools: policy.allowedTools.map(({ namespace, tool }) => ({
          namespace,
          tool,
        })),
        authorize: policy.authorize.bind(policy),
        execute: policy.execute.bind(policy),
        timeoutMs: policy.timeoutMs,
      };
  }

  async run(
    request: unknown,
    requestSignal?: AbortSignal,
  ): Promise<DynamicToolCallResponse> {
    if (!this.policy)
      return denied('Dynamic tools are unavailable for this runtime policy');
    if (this.signal.aborted || requestSignal?.aborted)
      return denied('The host tool owner is no longer active.');
    let call: DynamicToolCallParams | undefined;
    try {
      call = parseCall(request);
    } catch {
      return denied('Invalid host tool request.');
    }
    if (
      !call ||
      call.threadId !== this.threadId ||
      call.turnId !== this.getTurnId()
    )
      return denied(
        'Host tool call does not match the active thread and turn.',
      );
    if (
      !this.policy.allowedTools.some(
        (entry) =>
          entry.tool === call.tool && entry.namespace === call.namespace,
      )
    )
      return denied('This host tool is unavailable for the active turn.');
    const fingerprint = JSON.stringify(call);
    const prior = this.calls.get(call.callId);
    if (prior)
      return prior.fingerprint === fingerprint
        ? prior.response
        : denied('Host tool call identity was reused with different input.');
    if (this.calls.size >= MAX_CALLS_PER_TURN)
      return denied('The host tool call limit was reached.');
    const response = this.execute(
      call,
      this.policy,
      requestSignal
        ? AbortSignal.any([this.signal, requestSignal])
        : this.signal,
    );
    this.calls.set(call.callId, { fingerprint, response });
    return response;
  }

  private execute(
    call: DynamicToolCallParams,
    policy: CodexHostToolPolicy,
    signal: AbortSignal,
  ): Promise<DynamicToolCallResponse> {
    // Include authorization and queued execution in the same wall-clock lease.
    const timeoutMs =
      policy.timeoutMs ??
      (isCanopyAskUserToolName(call.tool)
        ? ASK_USER_HTTP_TIMEOUT_MS
        : CANOPY_MCP_TOOL_TIMEOUT_MS);
    if (
      timeoutMs !== undefined &&
      (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
    )
      return Promise.resolve(denied('Invalid host tool deadline.'));
    return new Promise((resolve) => {
      const controller = new AbortController();
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (response: DynamicToolCallResponse): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        resolve(response);
      };
      const onAbort = (): void => {
        controller.abort();
        finish(denied('The host tool owner is no longer active.'));
      };
      if (timeoutMs !== undefined)
        timer = setTimeout(() => {
          controller.abort();
          finish(
            denied(
              'The host tool call was stopped at its time limit; its effects may be incomplete.',
            ),
          );
        }, timeoutMs);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        return;
      }
      void (async (): Promise<void> => {
        try {
          const approved = await policy.authorize(call, controller.signal);
          if (controller.signal.aborted) return;
          if (!approved) {
            finish(denied('The host tool call was denied by policy.'));
            return;
          }
          const response = await policy.execute(call, controller.signal);
          if (!controller.signal.aborted) finish(boundResponse(response));
        } catch {
          finish(denied('The host tool call failed.'));
        }
      })();
    });
  }
}
