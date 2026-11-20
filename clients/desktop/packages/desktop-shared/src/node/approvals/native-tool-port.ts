import type {
  ApprovalCheck,
  ApprovalRequestDetails,
  ApprovalRuleTarget,
} from '../../types';

/** Shared policy is supplied by the execution host; no prompt means deny. */
export interface NativeToolApprovalPort {
  check(
    check: ApprovalCheck,
    display: {
      title: string;
      details: ApprovalRequestDetails;
      suggestedTarget?: ApprovalRuleTarget;
      toolUseId?: string;
      signal?: AbortSignal;
    },
  ): Promise<{
    decision: 'allow' | 'deny';
    /** Shared denial text (approval-denial.ts), shown as the tool's result. */
    message?: string;
    stopTurn?: boolean;
  }>;
}
