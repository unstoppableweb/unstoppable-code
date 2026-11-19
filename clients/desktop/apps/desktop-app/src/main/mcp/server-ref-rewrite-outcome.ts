import { AsyncLocalStorage } from 'node:async_hooks';
import { markIpcOperationPayload } from '@canopy/desktop-shared/ipc/operation-failure';
import type { CanopyErrorPayload } from '@canopy/protocol/canopy-core';
import {
  McpRefRewriteResultSchema,
  type McpRefRewriteCode,
  type McpRefRewritePhase,
  type McpRefRewriteResult,
} from '@canopy/protocol/canopy-core/core';

interface Failure {
  phase: McpRefRewritePhase;
  code?: McpRefRewriteCode;
  phases: McpRefRewritePhase[];
}
interface Execution {
  failures: Map<unknown, Failure>;
  active: boolean;
}
const execution = new AsyncLocalStorage<Execution>();
const dependencyCodes = new Set([
  'EACCES',
  'EPERM',
  'ENOENT',
  'EIO',
  'ENOSPC',
  'EROFS',
  'EMFILE',
  'ENFILE',
  'EBUSY',
  'ENOTDIR',
  'EISDIR',
]);
const retirementPhases = new Set<McpRefRewritePhase>([
  'retirementRead',
  'removalPreflight',
  'removalRevalidation',
  'tokenClear',
  'serverUnlink',
  'indexUpdate',
]);

export type McpRefRewriteOutcome =
  | { ok: true; value: McpRefRewriteResult }
  | { ok: false; error: CanopyErrorPayload; legacyError: unknown }
  | { ok: false; error: CanopyErrorPayload; legacyValue: McpRefRewriteResult };

/** Associate evidence with the rejection, never with unrelated caught work. */
export function recordMcpRefRewriteFailure<T>(
  error: T,
  phase: McpRefRewritePhase,
  code?: McpRefRewriteCode,
  causes: readonly unknown[] = [],
): T {
  const context = execution.getStore();
  if (!context?.active || context.failures.has(error)) return error;
  const identified =
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    dependencyCodes.has(error.code);
  const phases = causes.flatMap(
    (cause) => context.failures.get(cause)?.phases ?? [],
  );
  context.failures.set(error, {
    phase,
    phases: Array.from(new Set(phases.length ? phases : [phase])),
    code:
      code ??
      (identified
        ? retirementPhases.has(phase)
          ? 'retirementFailed'
          : 'rewriteFailed'
        : undefined),
  });
  return error;
}

/** Observe only: keep the original rejection, writer, ordering and locks. */
export async function inMcpRefRewritePhase<T>(
  phase: McpRefRewritePhase,
  run: () => Promise<T>,
  code?: McpRefRewriteCode,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw recordMcpRefRewriteFailure(error, phase, code);
  }
}

function failurePayload(failure?: Failure): CanopyErrorPayload {
  const code = failure?.code;
  const invalid = code === 'invalidRef' || code === 'retireNotRewritten';
  const refused = code === 'removalRefused';
  const operationCode: CanopyErrorPayload['code'] = code
    ? `core.catalog.mcpServer.${code}`
    : undefined;
  return {
    kind: !code
      ? 'internal'
      : invalid || refused
        ? 'invalid_argument'
        : 'unavailable',
    message: !code
      ? 'MCP reference rewrite failed.'
      : refused
        ? 'Device MCP removal was refused before cleanup. Open Repair device MCP removal and inspect the server.'
        : invalid
          ? 'Invalid MCP reference rewrite request.'
          : 'MCP reference rewrite could not complete.',
    ...(operationCode ? { code: operationCode } : {}),
    details: {
      phase: failure?.phase ?? 'rewrite',
      phases: failure?.phases ?? [],
      // Rejections cannot prove durability or which token clears applied.
      effects: invalid || refused ? 'none' : 'unknown',
    },
    retry: { kind: 'never' },
  };
}

/** Internal representation; the legacy adapter keeps its rejection and only
 * marks it so IPC can carry the retry directive and effects beside the text. */
export async function captureMcpRefRewriteOutcome(
  run: () => Promise<McpRefRewriteResult>,
): Promise<McpRefRewriteOutcome> {
  const context: Execution = { failures: new Map(), active: true };
  return execution.run(context, async (): Promise<McpRefRewriteOutcome> => {
    try {
      const value = await run();
      // Validation cannot turn a successful legacy mutation into a rejection.
      try {
        McpRefRewriteResultSchema.parse(value);
      } catch {
        return {
          ok: false,
          legacyValue: value,
          error: failurePayload({ phase: 'result', phases: ['result'] }),
        };
      }
      return { ok: true, value };
    } catch (legacyError) {
      return {
        ok: false,
        legacyError,
        error: failurePayload(context.failures.get(legacyError)),
      };
    } finally {
      // Detached work can retain the ALS store after the response has settled.
      context.active = false;
      context.failures.clear();
    }
  });
}

export function unwrapMcpRefRewriteOutcome(
  outcome: McpRefRewriteOutcome,
): McpRefRewriteResult {
  if (outcome.ok) return outcome.value;
  if ('legacyValue' in outcome) return outcome.legacyValue;
  throw markIpcOperationPayload(outcome.legacyError, outcome.error);
}
