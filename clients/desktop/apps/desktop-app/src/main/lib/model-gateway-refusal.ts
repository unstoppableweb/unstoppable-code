/** Stable reason for a send an enforced organization gateway refuses. */
export const MODEL_GATEWAY_REFUSED_CODE = 'model_gateway_refused';

/**
 * Where a gateway refusal happened. `before-save`: a send funnel refused
 * before the chat or its prompt became durable, so the draft can go back to
 * the composer. `session`: the per-turn session gate refused after the
 * message was saved; that is a turn error and must never restore or replay
 * the message.
 */
export type ModelGatewayRefusalStage = 'before-save' | 'session';

/**
 * Thrown when an organization's enforced AI gateway excludes the route a
 * turn would run on (CAN-6701).
 *
 * LEAF MODULE ON PURPOSE, like `auth-preflight-error.ts`: the send queue and
 * the IPC and Portal boundaries must recognize it without importing the
 * gateway state.
 */
export class ModelGatewayRefusedError extends Error {
  public readonly code = MODEL_GATEWAY_REFUSED_CODE;
  public readonly stage: ModelGatewayRefusalStage;

  public constructor(message: string, stage: ModelGatewayRefusalStage) {
    super(message);
    this.name = 'ModelGatewayRefusedError';
    this.stage = stage;
  }
}

/**
 * A refusal raised BEFORE anything was saved. Only these may become
 * `ChatSendMessageResult.refusedSend`, a Portal send's stable reason, or a
 * retained queue row; a session-gate refusal after saving never qualifies.
 */
export function isModelGatewayRefusal(
  error: unknown,
): error is ModelGatewayRefusedError {
  return (
    error instanceof ModelGatewayRefusedError && error.stage === 'before-save'
  );
}
