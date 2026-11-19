import type { InitializeResponse } from '@agentclientprotocol/sdk';

/**
 * Whether the agent's ACP initialization advertised `additionalDirectories`
 * on session lifecycle requests. The client's session validation and its
 * public accessor both read this, so one rule governs what may be sent.
 */
export function acpSupportsAdditionalDirectories(
  initialization: InitializeResponse | undefined,
): boolean {
  return (
    initialization?.agentCapabilities?.sessionCapabilities
      ?.additionalDirectories != null
  );
}

/** The `additionalDirectories` session field, present only when it may be sent. */
export function additionalDirectoriesParam(
  directories: readonly string[],
  supported: boolean,
): { additionalDirectories?: string[] } {
  return directories.length > 0 && supported
    ? { additionalDirectories: [...directories] }
    : {};
}
