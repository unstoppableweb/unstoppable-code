import type {
  GitHubTokenProvider,
  SessionEvent,
  ToolResultObject,
} from '@github/copilot-sdk';
import { randomUUID } from 'node:crypto';
import {
  COPILOT_RECIPIENT_REASONING_EFFORTS,
  COPILOT_RECIPIENT_LIMITS,
  CopilotAssistantPatchSchema,
  CopilotToolObservationSchema,
  type CopilotCallbackReply,
  type CopilotCallbackRequest,
  type CopilotRecipientResult,
} from '@canopy/protocol/copilot-recipient';
import {
  startCopilotRuntime,
  type CopilotRuntimeOptions,
  type OwnedCopilotRuntime,
} from './runtime';
import type { CopilotLocalExecution, CopilotLocalRuntime } from './local-host';
import type { CopilotSessionPolicy } from './session-policy';
import { runCopilotTurn, type CopilotTurnOptions } from './turn-driver';
import { isCopilotRecord } from './tool-input';
import {
  CopilotObservationTextRedactor,
  redactCopilotTextParts,
  redactCopilotToolValue,
} from './text-redaction';

const PROJECTED_BYTES = COPILOT_RECIPIENT_LIMITS.frameBytes - 4096;
function boundedToolText(value: string): string {
  return value.length <= 65_536 &&
    Buffer.byteLength(JSON.stringify(value), 'utf8') <= PROJECTED_BYTES
    ? value
    : value.slice(0, 16_384);
}
function toolObservation(
  event: SessionEvent,
  redactor: CopilotObservationTextRedactor,
  maskOutput: (toolCallId: string, output: string) => void,
):
  | Extract<CopilotCallbackRequest, { kind: 'observation' }>['event']
  | undefined {
  try {
    if (event.type === 'tool.execution_complete') {
      const result = event.data.result;
      const output =
        result?.detailedContent ??
        result?.content ??
        event.data.error?.message ??
        '';
      redactor.beginEvent();
      event = {
        ...event,
        data: {
          ...event.data,
          ...(result
            ? {
                result: {
                  ...result,
                  content: redactor.redact(result.content),
                  ...(result.detailedContent === undefined
                    ? {}
                    : {
                        detailedContent: redactor.redact(
                          result.detailedContent,
                        ),
                      }),
                  ...(result.contents === undefined
                    ? {}
                    : {
                        contents: result.contents.map((block) =>
                          block.type === 'text'
                            ? {
                                ...block,
                                text: redactor.redact(block.text),
                              }
                            : block,
                        ),
                      }),
                },
              }
            : {}),
          ...(event.data.error
            ? {
                error: {
                  ...event.data.error,
                  message: redactor.redact(event.data.error.message),
                },
              }
            : {}),
        },
      };
      const maskedOutput =
        event.data.result?.detailedContent ??
        event.data.result?.content ??
        event.data.error?.message ??
        '';
      if (maskedOutput !== output)
        maskOutput(event.data.toolCallId, maskedOutput);
    }
    let candidate: unknown = event;
    if (event.type === 'tool.execution_complete' && event.data.result) {
      const result = event.data.result;
      const bounded = {
        ...event,
        data: {
          ...event.data,
          // Omitted detail/blocks cannot acknowledge a truncated delivery receipt.
          result: { content: result.content.slice(0, 16_384) },
        },
      };
      if (
        result.content.length > 65_536 ||
        (result.detailedContent?.length ?? 0) > 65_536 ||
        (result.contents?.length ?? 0) > 256 ||
        result.contents?.some(
          (block) => block.type === 'text' && block.text.length > 65_536,
        )
      )
        candidate = bounded;
      else {
        candidate = {
          ...event,
          data: {
            ...event.data,
            result: {
              ...result,
              contents: result.contents?.some((block) => block.type !== 'text')
                ? undefined
                : result.contents,
            },
          },
        };
        if (
          Buffer.byteLength(JSON.stringify(candidate), 'utf8') > PROJECTED_BYTES
        )
          candidate = bounded;
      }
    }
    const projected = CopilotToolObservationSchema.safeParse(candidate);
    if (
      !projected.success ||
      Buffer.byteLength(JSON.stringify(projected.data), 'utf8') >
        PROJECTED_BYTES
    )
      return undefined;
    return projected.data;
  } catch {
    // Observability is best effort; missing provenance still denies host approvals.
    return undefined;
  }
}
function boundedToolPatch(
  event: Record<string, unknown>,
  observedOutputs: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const patches = event.patches;
  if (!Array.isArray(patches)) return event;
  const project = (compact: boolean): Record<string, unknown> => ({
    ...event,
    patches: patches.map((patch: unknown) => {
      if (!isCopilotRecord(patch) || !isCopilotRecord(patch.block))
        return patch;
      const block = patch.block;
      if (compact && block.type === 'tool_use')
        return { ...patch, block: { ...block, display: undefined } };
      if (block.type !== 'tool_result' || typeof block.output !== 'string')
        return patch;
      const output =
        typeof block.toolUseId === 'string'
          ? (observedOutputs.get(block.toolUseId) ?? block.output)
          : block.output;
      return {
        ...patch,
        block: {
          ...block,
          output: compact ? output.slice(0, 16_384) : boundedToolText(output),
        },
      };
    }),
  });
  const projected = project(false);
  // The final drain combines input, display and output into a single frame.
  return Buffer.byteLength(JSON.stringify(projected), 'utf8') <= PROJECTED_BYTES
    ? projected
    : project(true);
}

/** These paths, server credentials and tool definitions are trusted host projections. */
export interface CopilotLocalPolicy extends Pick<
  CopilotTurnOptions,
  | 'workingDirectory'
  | 'configDirectory'
  | 'systemPrompt'
  | 'mcpServers'
  | 'skillDirectories'
  | 'secretValues'
  | 'timeoutMs'
> {
  readonly tools?: CopilotSessionPolicy['tools'];
}
function unavailable(): never {
  throw new Error('Copilot recipient unavailable.');
}
async function notice(
  callback: CopilotLocalExecution['callback'],
  request: Extract<CopilotCallbackRequest, { kind: 'notice' }>,
): Promise<void> {
  const reply = await callback(request);
  if (reply.kind !== 'notice' || !reply.accepted) unavailable();
}
function json(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (!encoded || Buffer.byteLength(encoded, 'utf8') > 65_536) unavailable();
  return encoded;
}
function allowed(
  reply: CopilotCallbackReply,
  kind: 'approval' | 'permission',
): boolean {
  return reply.kind === kind && reply.allow;
}

/** Wraps the extracted P3 engine, without exposing its SDK client or callbacks. */
type DriverRuntime = Pick<
  OwnedCopilotRuntime,
  'identity' | 'exited' | 'isClosed' | 'close'
> & {
  client: CopilotTurnOptions['runtime']['client'] & {
    rpc: {
      models: Pick<OwnedCopilotRuntime['client']['rpc']['models'], 'list'>;
      account: Pick<
        OwnedCopilotRuntime['client']['rpc']['account'],
        'getQuota'
      >;
    };
  };
};
export function bindCopilotLocalRuntime(
  owned: DriverRuntime,
  policy: CopilotLocalPolicy,
): CopilotLocalRuntime {
  return {
    identity: owned.identity,
    exited: owned.exited,
    isClosed: () => owned.isClosed(),
    close: () => owned.close(),
    async execute(purpose, context) {
      context.signal.throwIfAborted();
      if (purpose === 'models' || purpose === 'setup-probe') {
        const gitHubToken = await context.token();
        context.admit();
        context.signal.throwIfAborted();
        const response = await owned.client.rpc.models.list({ gitHubToken });
        context.signal.throwIfAborted();
        if (purpose === 'setup-probe')
          return { kind: 'setup-probe', available: true };
        if (response.models.length > 256) unavailable();
        return {
          kind: 'models',
          models: response.models
            .filter((model) => model.policy?.state === 'enabled')
            .map(
              (
                model,
              ): Extract<
                CopilotRecipientResult,
                { kind: 'models' }
              >['models'][number] => {
                const contextWindow =
                  model.capabilities.limits?.max_context_window_tokens;
                return {
                  id: model.id,
                  name: model.name,
                  supportsVision: model.capabilities.supports?.vision === true,
                  reasoningEfforts: (
                    ['none', ...COPILOT_RECIPIENT_REASONING_EFFORTS] as const
                  ).filter(
                    (effort) =>
                      model.capabilities.supports?.reasoningEffort === true &&
                      model.supportedReasoningEfforts?.includes(effort),
                  ),
                  ...(typeof contextWindow === 'number' &&
                  Number.isSafeInteger(contextWindow) &&
                  contextWindow > 0
                    ? { contextWindow }
                    : {}),
                };
              },
            ),
        };
      }
      if (purpose === 'quota') {
        const gitHubToken = await context.token();
        context.admit();
        context.signal.throwIfAborted();
        const response = await owned.client.rpc.account.getQuota({
          gitHubToken,
        });
        context.signal.throwIfAborted();
        return {
          kind: 'quota',
          snapshots: Object.entries(response.quotaSnapshots)
            .slice(0, 16)
            .flatMap(([id, quota]) =>
              quota
                ? [
                    {
                      id,
                      unlimited: quota.isUnlimitedEntitlement === true,
                      ...(Number.isFinite(quota.remainingPercentage) &&
                      quota.remainingPercentage >= 0 &&
                      quota.remainingPercentage <= 100
                        ? { remainingPercentage: quota.remainingPercentage }
                        : {}),
                      ...(quota.resetDate &&
                      Number.isFinite(Date.parse(quota.resetDate))
                        ? { resetsAt: new Date(quota.resetDate).toISOString() }
                        : {}),
                    },
                  ]
                : [],
            ),
        };
      }
      const turn = context.turn;
      if (!turn) unavailable();
      const token = await context.token();
      context.admit();
      context.signal.throwIfAborted();
      const secretValues = [...(policy.secretValues ?? []), token];
      const observationRedactor = new CopilotObservationTextRedactor(
        secretValues,
      );
      // The transcript selects only one field; it cannot see fragments in other fields.
      const observedOutputs = new Map<string, string>();
      const callbackAbort = new AbortController();
      const callback: CopilotLocalExecution['callback'] = (request) => {
        const decoded: unknown =
          'argumentsJson' in request
            ? JSON.parse(request.argumentsJson)
            : 'requestJson' in request
              ? JSON.parse(request.requestJson)
              : request;
        const payload = [request, decoded];
        // Preserve P5's refusal of a different, redacted invocation.
        if (
          JSON.stringify(redactCopilotToolValue(payload, secretValues)) !==
          JSON.stringify(payload)
        ) {
          // The SDK catches hook errors as denials; also stop this turn's admission.
          callbackAbort.abort();
          unavailable();
        }
        return context.callback(request);
      };
      let observations = Promise.resolve();
      const result = await runCopilotTurn({
        ...policy,
        deferSuccessfulClose: true,
        model: turn.model,
        reasoningEffort: turn.reasoningEffort,
        prompt: turn.prompt,
        turnId: context.audience.operationId,
        sessionId:
          context.audience.kind === 'resume'
            ? context.audience.sessionId
            : undefined,
        signal: AbortSignal.any([context.signal, callbackAbort.signal]),
        secretValues,
        runtime: {
          ...owned,
          failed: (error) => context.failed?.(error),
          tokenProviderForSession: (sessionId): GitHubTokenProvider => {
            // A resume token must never authorize a silent create recovery.
            if (
              context.audience.kind === 'resume' &&
              sessionId !== context.audience.sessionId
            )
              unavailable();
            return async ({ host, sessionId: requested }) => {
              if (
                !requested ||
                (sessionId !== undefined && requested !== sessionId)
              )
                unavailable();
              return context.sessionToken(host, requested);
            };
          },
        },
        tools: policy.tools?.map((tool) => ({
          ...tool,
          handler: async (
            args,
            invocation,
          ): Promise<string | ToolResultObject> => {
            const reply = await callback({
              kind: 'tool',
              toolCallId: invocation.toolCallId,
              toolName: tool.name,
              argumentsJson: json(args),
            });
            if (reply.kind !== 'tool') unavailable();
            return reply.structured ?? reply.result;
          },
        })),
        onEvent: (event) => {
          if (
            !turn.observeTools ||
            (event.type !== 'tool.execution_start' &&
              event.type !== 'tool.execution_complete')
          )
            return;
          const projected = toolObservation(
            event,
            observationRedactor,
            (toolCallId, output) => {
              observedOutputs.set(
                `${context.audience.operationId}:${toolCallId}`,
                boundedToolText(output),
              );
            },
          );
          if (!projected) return;
          observations = observations.then(async () => {
            const reply = await callback({
              kind: 'observation',
              event: projected,
            });
            if (reply.kind !== 'observation' || !reply.accepted) unavailable();
          });
          void observations.catch(() => undefined);
        },
        authorize: async (input) => {
          await observations;
          const reply = await callback({
            kind: 'approval',
            toolCallId: randomUUID(),
            toolName: input.toolName,
            argumentsJson: json(input.toolArgs),
          });
          if (reply.kind !== 'approval') return { decision: 'deny' };
          const message =
            reply.message === undefined
              ? undefined
              : redactCopilotTextParts(
                  [reply.message],
                  [
                    ...secretValues,
                    policy.workingDirectory,
                    policy.configDirectory,
                  ],
                )[0];
          if (!reply.allow) return { decision: 'deny', message };
          const modifiedArgs: unknown =
            reply.modifiedArgumentsJson === undefined
              ? undefined
              : JSON.parse(reply.modifiedArgumentsJson);
          return {
            decision: 'allow',
            message,
            ...(modifiedArgs === undefined ? {} : { modifiedArgs }),
          };
        },
        requestManagedPermission: async (request) => ({
          kind: allowed(
            await callback({
              kind: 'permission',
              requestJson: json(request),
            }),
            'permission',
          )
            ? 'approved'
            : 'reject',
        }),
        onUserInputRequest: async (
          request,
        ): Promise<{ answer: string; wasFreeform: boolean }> => {
          const reply = await callback({
            kind: 'input',
            question: request.question,
            choices: request.choices ?? [],
            allowFreeform: request.allowFreeform !== false,
          });
          if (reply.kind !== 'input') unavailable();
          return { answer: reply.answer, wasFreeform: reply.wasFreeform };
        },
        onSession: (sessionId) =>
          notice(callback, { kind: 'notice', name: 'session', sessionId }),
        onPromptAccepted: (sessionId) =>
          notice(callback, {
            kind: 'notice',
            name: 'prompt-accepted',
            sessionId,
          }),
        onToolsReady: (snapshot, servers) =>
          notice(callback, {
            kind: 'notice',
            name: 'tools-ready',
            digest: snapshot.digest,
            servers: servers.map((server) => ({
              name: server.name,
              status: server.status,
            })),
          }),
        beforePrompt: () =>
          notice(callback, { kind: 'notice', name: 'before-prompt' }),
        preparePrompt: async (sessionId) => {
          const reply = await callback({ kind: 'history', sessionId });
          if (reply.kind !== 'history') unavailable();
          return reply.prompt;
        },
        onSessionUnavailable: turn.recoverMissingSession
          ? async (): Promise<never> => {
              await notice(callback, {
                kind: 'notice',
                name: 'session-unavailable',
              });
              // Recovery requires a new create audience/lease, not rebinding this one.
              unavailable();
            }
          : undefined,
        emit: (event): void => {
          // A cancelled turn drains its projector after the lease has closed.
          if (context.signal.aborted) return;
          context.emit({
            kind: 'patch',
            patch: CopilotAssistantPatchSchema.parse(
              boundedToolPatch(event, observedOutputs),
            ),
          });
        },
      });
      await observations;
      return { kind: 'turn', ...result };
    },
  };
}

/** Unselected daemon composition helper; no launch until explicitly invoked. */
export async function startCopilotLocalRuntime(
  options: CopilotRuntimeOptions,
  policy: CopilotLocalPolicy,
): Promise<CopilotLocalRuntime> {
  if (options.workingDirectory !== policy.workingDirectory) unavailable();
  return bindCopilotLocalRuntime(await startCopilotRuntime(options), policy);
}
