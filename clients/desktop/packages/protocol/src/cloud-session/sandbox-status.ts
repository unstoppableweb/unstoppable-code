/** 409 codes under which the sandbox cannot serve files or a terminal right now. */
export const CLOUD_SANDBOX_NOT_AWAKE_CODES = [
  'SANDBOX_NOT_READY',
  'SANDBOX_STOPPING',
  'SANDBOX_MATERIALIZATION_FAILED',
  'SANDBOX_SESSION_EXPIRED',
] as const;
export type CloudSandboxNotAwakeCode =
  (typeof CLOUD_SANDBOX_NOT_AWAKE_CODES)[number];
export function isCloudSandboxNotAwakeCode(
  code: unknown,
): code is CloudSandboxNotAwakeCode {
  return (
    typeof code === 'string' &&
    CLOUD_SANDBOX_NOT_AWAKE_CODES.some((candidate) => candidate === code)
  );
}

/** A cloud chat's sandbox as the files and terminal surfaces show it. */
export type CloudSandboxStatus =
  | { readonly kind: 'ready' }
  | { readonly kind: 'waking' }
  | { readonly kind: 'sleeping' }
  | { readonly kind: 'no-sandbox' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'expired' };

export function sandboxStatusOf(
  notAwake: {
    readonly code: CloudSandboxNotAwakeCode;
    readonly wakeAllowed: boolean;
  },
  wakePending: boolean,
): CloudSandboxStatus {
  switch (notAwake.code) {
    // The sandbox's session ended while it was idle: it sleeps, and a turn
    // restarts it with its files (CAN-6654). Nothing here means the files
    // are gone.
    case 'SANDBOX_SESSION_EXPIRED':
      return { kind: wakePending ? 'waking' : 'sleeping' };
    case 'SANDBOX_MATERIALIZATION_FAILED':
      return { kind: wakePending ? 'waking' : 'failed' };
    case 'SANDBOX_STOPPING':
      return { kind: wakePending ? 'waking' : 'sleeping' };
    case 'SANDBOX_NOT_READY':
      return {
        kind: wakePending
          ? 'waking'
          : !notAwake.wakeAllowed
            ? 'no-sandbox'
            : 'sleeping',
      };
  }
}

/**
 * Whether a read that asks to wake can wake this sandbox. A stopping sandbox
 * and one Core calls not ready (unless it says otherwise) wake; one whose
 * session ended, or that failed, waits for a turn to restart it (CAN-6654).
 */
export function cloudSandboxWakeAllowed(
  code: CloudSandboxNotAwakeCode,
  details: unknown,
): boolean {
  return (
    code === 'SANDBOX_STOPPING' ||
    (code === 'SANDBOX_NOT_READY' && wakeAllowedFromDetails(details))
  );
}

export function wakeAllowedFromDetails(details: unknown): boolean {
  if (
    typeof details === 'object' &&
    details !== null &&
    'wakeAllowed' in details &&
    details.wakeAllowed === false
  ) {
    return false;
  }
  return true;
}

/** The `details.reason` of a web core refusal because the sandbox is not awake. */
export const CLOUD_SANDBOX_SLEEPING_REASON = 'sandbox_sleeping';

/**
 * The not-awake sandbox a web core `sandbox_sleeping` refusal names, from its
 * `details`; null for any other refusal. A web core that sends no
 * `cloudCode` reads as Core's `SANDBOX_NOT_READY`.
 */
export function cloudSandboxNotAwakeFromDetails(details: unknown): {
  readonly code: CloudSandboxNotAwakeCode;
  readonly wakeAllowed: boolean;
} | null {
  if (
    typeof details !== 'object' ||
    details === null ||
    !('reason' in details) ||
    details.reason !== CLOUD_SANDBOX_SLEEPING_REASON
  )
    return null;
  const cloudCode = 'cloudCode' in details ? details.cloudCode : undefined;
  return {
    code: isCloudSandboxNotAwakeCode(cloudCode)
      ? cloudCode
      : 'SANDBOX_NOT_READY',
    wakeAllowed: wakeAllowedFromDetails(details),
  };
}
