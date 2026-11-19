import type { ResourceContextDecision } from '@canopy/execution-engine/lib/resource-context-policy';

type RefusalReason = Extract<
  ResourceContextDecision,
  { allow: false }
>['reason'];

/**
 * An expected background-execution policy refusal, such as arming a watcher
 * whose delivery would be denied. Its message is fixed product copy from
 * `automation-context-copy`. Missing selections use a generic capability label;
 * resolved resources may use their normalized display name. Messages never
 * include stored reference IDs, paths or configuration contents.
 */
export class BackgroundExecutionRefusedError extends Error {
  constructor(
    message: string,
    readonly reason: RefusalReason,
    readonly transient: boolean,
  ) {
    super(message);
    this.name = 'BackgroundExecutionRefusedError';
  }
}

/** The tool error for an expected refusal; undefined for any other failure. */
export function backgroundRefusalToolResult(
  error: unknown,
): { text: string; isError: true } | undefined {
  return error instanceof BackgroundExecutionRefusedError
    ? { text: error.message, isError: true }
    : undefined;
}

/**
 * Runs an injected tool so an expected policy refusal reaches the model as an
 * actionable tool error with its copy (CAN-6900), in Orchestrator and worktree
 * chats alike. Any other failure still fails the call and is logged by the
 * transport.
 */
export async function withBackgroundRefusalAsToolError<
  Result extends { text: string; isError?: boolean },
>(
  run: () => Promise<Result>,
): Promise<Result | { text: string; isError: true }> {
  try {
    return await run();
  } catch (error) {
    const refusal = backgroundRefusalToolResult(error);
    if (refusal) return refusal;
    throw error;
  }
}
