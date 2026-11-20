import type { LinearStatus } from '@canopy/desktop-shared/types';
import {
  CORE_INTEGRATION_GRANTS,
  LINEAR_INTEGRATION_ID,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import type {
  LinearIssuePreviewRequest,
  LinearIssuePreviewResult,
  LinearTeamKeysResult,
} from '@canopy/protocol/reference-previews';
import {
  captureLinearForLegacyIpc,
  INVALID_LINEAR_TOKEN,
  type CoreIntegrationDispatcher,
} from './core-integration-adapter';
import { preserveRuntimeCauseError } from './runtime-cause-error';

/*
 * The `core.integration.*` projections behind the Linear validate and
 * reference-preview channels. Each call holds only its own grant and returns
 * the legacy result the host captured, byte for byte.
 */

const LINEAR_SECRET_MAX_LENGTH = 16384;

/** `settings:validate-linear-token`: probes the candidate, storing nothing. */
export async function validateLinearTokenForIpc(
  dispatcher: CoreIntegrationDispatcher,
  caller: CanopyCallerDescriptor,
  token: string,
): Promise<LinearStatus> {
  // Trimmed once, as the legacy handler sent it to Linear.
  const secret = token.trim();
  if (!secret) return { authenticated: false, displayName: null, error: null };
  // Linear refused a candidate this long before; the secret bound would throw.
  if (secret.length > LINEAR_SECRET_MAX_LENGTH)
    return {
      authenticated: false,
      displayName: null,
      error: INVALID_LINEAR_TOKEN,
    };
  return preserveRuntimeCauseError(
    captureLinearForLegacyIpc('validation', () =>
      dispatcher.instruction(
        'core.integration.credential.validate',
        { credentialKind: 'linear.apiToken', secret },
        { caller: { ...caller, grants: [CORE_INTEGRATION_GRANTS.write] } },
      ),
    ),
  );
}

/** `reference-preview:linear-issue`: one issue through `resource.get`. */
export async function readLinearIssueForIpc(
  dispatcher: CoreIntegrationDispatcher,
  caller: CanopyCallerDescriptor,
  request: LinearIssuePreviewRequest,
): Promise<LinearIssuePreviewResult> {
  return preserveRuntimeCauseError(
    captureLinearForLegacyIpc('issue', () =>
      dispatcher.query(
        'core.integration.resource.get',
        {
          integrationId: LINEAR_INTEGRATION_ID,
          resourceId: request.identifier,
          ...(request.workspaceSlug === undefined
            ? {}
            : { workspaceSlug: request.workspaceSlug }),
        },
        { caller: { ...caller, grants: [CORE_INTEGRATION_GRANTS.read] } },
      ),
    ),
  );
}

/** `reference-preview:linear-teams`: the team keys through `resource.list`. */
export async function readLinearTeamKeysForIpc(
  dispatcher: CoreIntegrationDispatcher,
  caller: CanopyCallerDescriptor,
): Promise<LinearTeamKeysResult> {
  return preserveRuntimeCauseError(
    captureLinearForLegacyIpc('teams', () =>
      dispatcher.query(
        'core.integration.resource.list',
        {
          integrationId: LINEAR_INTEGRATION_ID,
          kinds: ['team'],
          query: null,
          cursor: null,
          limit: 200,
        },
        { caller: { ...caller, grants: [CORE_INTEGRATION_GRANTS.read] } },
      ),
    ),
  );
}
