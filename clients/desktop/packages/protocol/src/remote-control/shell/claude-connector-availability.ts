/** Value-free observation of the last real Claude process launch for a chat. */
export type ClaudeConnectorAvailability = { launchId: string } & (
  | {
      status: 'suppressed';
      cause:
        | 'account_proxy'
        | 'ai_credits'
        | 'organization_gateway'
        | 'api_auth';
    }
  | { status: 'eligible'; cause: 'native' }
  | {
      status: 'unknown';
      cause: 'unknown';
      /** Actual child launch configuration; CLI settings may override it. */
      launchRoute?: 'account_proxy' | 'ai_credits' | 'organization_gateway';
    }
);

export const CLAUDE_CONNECTOR_AVAILABILITY_EVENT =
  'canopy_claude_connector_availability';

/** Reconstruct only the allowlisted fields; never retain raw provider context. */
export function readClaudeConnectorAvailability(
  value: unknown,
): ClaudeConnectorAvailability | undefined {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('launchId' in value) ||
    !('status' in value) ||
    !('cause' in value)
  )
    return;
  const { launchId, status, cause } = value;
  if (
    typeof launchId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      launchId,
    )
  )
    return;
  if (
    status === 'suppressed' &&
    (cause === 'account_proxy' ||
      cause === 'ai_credits' ||
      cause === 'organization_gateway' ||
      cause === 'api_auth')
  )
    return { launchId, status, cause };
  if (status === 'eligible' && cause === 'native')
    return { launchId, status, cause };
  if (status === 'unknown' && cause === 'unknown') {
    const launchRoute = 'launchRoute' in value ? value.launchRoute : undefined;
    return {
      launchId,
      status,
      cause,
      ...(launchRoute === 'account_proxy' ||
      launchRoute === 'ai_credits' ||
      launchRoute === 'organization_gateway'
        ? { launchRoute }
        : {}),
    };
  }
}
