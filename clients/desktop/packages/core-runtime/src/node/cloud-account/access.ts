import type { WorkOwner } from '@canopy/protocol/llm-gateway';
import type {
  CloudAccountAuthority,
  CloudAccountAuthorityFailure,
  CloudAccountAuthorityRead,
} from './authority';
import {
  cloudAccountExecutionUnknownReason,
  cloudAccountBrokerPresentationUnknownReason,
  cloudAccountMayRequireGateway,
  evaluateCloudModelPolicy,
  type CloudModelPolicyAnswer,
  type CloudPolicyUnknownReason,
} from './availability';
import {
  cloudAccountRouteIdentity,
  hasCloudAccountCredential,
  isGuestCloudAccount,
} from './record';

/** Nonsecret decisions from one snapshot; the account record stays in custody. */
export type CloudAccountAccessRead =
  | CloudAccountAuthorityFailure
  | {
      readonly kind: 'ok';
      readonly accountId: string | null;
      readonly routeIdentity: string | null;
      readonly credentialGeneration: number;
      readonly hasCredential: boolean;
      readonly sessionExpired: boolean;
      readonly guest: boolean;
      executionUnknownReason(
        owner: WorkOwner | null,
      ): CloudPolicyUnknownReason | null;
      brokerPresentationUnknownReason(
        owner: WorkOwner | null,
      ): CloudPolicyUnknownReason | null;
      mayRequireGateway(owner: WorkOwner | null): boolean;
      modelPolicyActive(
        owner: WorkOwner,
        scope: 'owner' | 'union',
      ): boolean | null;
      modelPolicy(input: {
        readonly owner: WorkOwner | null;
        readonly scope: 'owner' | 'union';
        readonly governedModelId: string;
        readonly mode?: 'admission' | 'presentation';
      }): CloudModelPolicyAnswer;
    };

export async function readCloudAccountAccess(
  authority: CloudAccountAuthority,
): Promise<CloudAccountAccessRead> {
  return projectCloudAccountAccess(await authority.read());
}

/** Internal snapshot projection shared with the authorization port. */
export function projectCloudAccountAccess(
  read: CloudAccountAuthorityRead,
): CloudAccountAccessRead {
  if (read.kind !== 'ok') return read;
  return Object.freeze({
    kind: 'ok',
    accountId: read.record?.accountId ?? null,
    routeIdentity: read.record ? cloudAccountRouteIdentity(read.record) : null,
    credentialGeneration: read.credentialGeneration,
    hasCredential: hasCloudAccountCredential(read.record),
    sessionExpired: read.sessionExpired,
    guest: read.record !== null && isGuestCloudAccount(read.record),
    executionUnknownReason: (
      owner: WorkOwner | null,
    ): CloudPolicyUnknownReason | null =>
      cloudAccountExecutionUnknownReason(read, owner),
    brokerPresentationUnknownReason: (
      owner: WorkOwner | null,
    ): CloudPolicyUnknownReason | null =>
      cloudAccountBrokerPresentationUnknownReason(read, owner),
    mayRequireGateway: (owner: WorkOwner | null): boolean =>
      read.record !== null && cloudAccountMayRequireGateway(read.record, owner),
    modelPolicyActive: (
      owner: WorkOwner,
      scope: 'owner' | 'union',
    ): boolean | null => {
      const record = read.record;
      // Same organization id normalization as evaluateCloudModelPolicy.
      const ownerOrganization =
        owner.kind === 'organization'
          ? owner.organizationId.trim().toLowerCase()
          : null;
      if (
        !record ||
        cloudAccountExecutionUnknownReason(read, owner) !== null ||
        (ownerOrganization !== null &&
          !record.organizationIds.includes(ownerOrganization))
      )
        return null;
      if (
        (scope === 'union' || ownerOrganization !== null) &&
        record.modelPolicyEnforcementUnavailable
      )
        return null;
      return record.enforcedSettings.some(
        (setting) =>
          (scope === 'union' ||
            (ownerOrganization !== null &&
              setting.organizationId.trim().toLowerCase() ===
                ownerOrganization)) &&
          setting.policies.some((policy) => policy.kind === 'model-policy'),
      );
    },
    modelPolicy: (input: {
      readonly owner: WorkOwner | null;
      readonly scope: 'owner' | 'union';
      readonly governedModelId: string;
      readonly mode?: 'admission' | 'presentation';
    }): CloudModelPolicyAnswer => evaluateCloudModelPolicy({ read, ...input }),
  });
}
