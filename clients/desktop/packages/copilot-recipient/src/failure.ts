import {
  CopilotSdkErrorTypeSchema,
  type CopilotRecipientRefusal,
  type CopilotSdkErrorType,
} from '@canopy/protocol/copilot-recipient';

export type CopilotFailureReason = Extract<
  CopilotRecipientRefusal,
  | 'provider_error'
  | 'limit'
  | 'auth'
  | 'start_timeout'
  | 'exited_during_startup'
  | 'version_mismatch'
  | 'not_installed'
  | 'refresh_failed'
>;

/**
 * A Copilot failure with a closed cause. The message stays local, for the
 * same callers and copy as before; only `reason` and `errorType` may cross
 * the recipient wire (CAN-7117).
 */
export class CopilotRecipientFailure extends Error {
  constructor(
    message: string,
    readonly reason: CopilotFailureReason,
    readonly errorType?: CopilotSdkErrorType,
  ) {
    super(message);
  }
}

/** An SDK `session.error` type when it is allowlisted, else `other`. */
export function copilotSdkErrorType(value: unknown): CopilotSdkErrorType {
  const parsed = CopilotSdkErrorTypeSchema.safeParse(value);
  return parsed.success ? parsed.data : 'other';
}
