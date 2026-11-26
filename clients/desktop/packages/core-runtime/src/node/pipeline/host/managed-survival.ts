import type {
  WorkerPipelineNativeRouteEvidence,
  WorkerPipelineSurvivalAssessment,
} from '@canopy/protocol/canopy-core';
import type { WorkOwner } from '@canopy/protocol/llm-gateway';
import type { CloudAccountAuthority } from '../../cloud-account/authority';
import { readCloudAccountAccess } from '../../cloud-account/access';
import { type CloudAiCreditsAvailabilityService } from '../../cloud-account/availability';

type Blocker = WorkerPipelineSurvivalAssessment['blockers'][number]['code'];

/**
 * Governed-native and AI Credits survival admission (CAN-6997, A5-C).
 *
 * Not selected: no production composition calls this until the daemon account
 * authority is active and the qualification in the CAN-6997 inventory passes.
 * Until then those runs keep their existing `policy` and `ai-credits` pause
 * reasons, and native-independent survival is unchanged.
 *
 * Possessing an account never authorizes bypassing a gateway: any gateway or
 * account-proxy dependency, an unknown policy or availability answer, a
 * missing launch consent for AI Credits, or a dynamic selection is a blocker.
 */
export interface ManagedPipelineSurvivalPorts {
  readonly authority: CloudAccountAuthority;
  readonly availability: CloudAiCreditsAvailabilityService;
  /** Whether the brokered route can be created in the daemon for this run. */
  readonly brokerReady: () => boolean;
  /** `owner` only when the launch recorded owner-scoped enforcement. */
  readonly policyScope: 'owner' | 'union';
  /** Production supplies the independently validated launch catalog resolver. */
  readonly governedModelId?: (requestModel: string) => string | undefined;
}

export type ManagedPipelineCredentialFamily =
  | WorkerPipelineSurvivalAssessment['credentialFamilies'][number]
  | 'cloud-account';

export type ManagedPipelineSurvivalDecision =
  | {
      readonly kind: 'admissible';
      readonly credentialFamilies: readonly ManagedPipelineCredentialFamily[];
      readonly accountId: string | null;
      readonly credentialGeneration: number;
    }
  | { readonly kind: 'pauses'; readonly blockers: readonly Blocker[] };

function workOwnerOf(owner: string): WorkOwner | null {
  if (owner === 'personal') return { kind: 'personal' };
  const match = /^org:([0-9a-f-]{36})$/.exec(owner);
  return match?.[1] ? { kind: 'organization', organizationId: match[1] } : null;
}

export async function assessManagedPipelineSurvival(
  evidence: WorkerPipelineNativeRouteEvidence,
  ports: ManagedPipelineSurvivalPorts,
  signal?: AbortSignal,
): Promise<ManagedPipelineSurvivalDecision> {
  const blockers = new Set<Blocker>();
  if (evidence.gateway !== 'absent') blockers.add('gateway');
  if (evidence.accountProxy !== 'absent') blockers.add('account-proxy');
  if (evidence.futureSelections !== 'closed') blockers.add('dynamic-selection');
  const credits = evidence.routes.filter(
    (route) => route.effectiveRoute === 'ai-credits',
  );
  for (const route of evidence.routes) {
    switch (route.effectiveRoute) {
      case 'native':
        if (route.authentication === 'unknown')
          blockers.add('native-auth-unknown');
        break;
      case 'ai-credits':
        break;
      case 'gateway':
        blockers.add('gateway');
        break;
      case 'account-proxy':
        blockers.add('account-proxy');
        break;
      case 'ollama':
        blockers.add('ollama');
        break;
      case 'unknown':
        blockers.add('unsupported-route');
        break;
    }
  }
  // Credits must be the launch's recorded choice, never an inferred fallback.
  if (credits.length > 0 && evidence.aiCredits !== 'required')
    blockers.add('ai-credits');
  if (credits.length === 0 && evidence.aiCredits !== 'absent')
    blockers.add('ai-credits');
  if (evidence.policy === 'unknown') blockers.add('policy');

  const owner = workOwnerOf(evidence.identity.owner);
  if (!owner) blockers.add('unknown');
  let admissionRead = await readCloudAccountAccess(ports.authority);
  if (credits.length > 0) {
    if (
      admissionRead.kind !== 'ok' ||
      !admissionRead.hasCredential ||
      admissionRead.sessionExpired ||
      !ports.brokerReady()
    )
      blockers.add('ai-credits');
    else if (!signal?.aborted) {
      const available = await ports.availability.load(owner, signal);
      // Billing can overlap a policy/membership refresh without changing the
      // credential generation. All admission gates below use this snapshot.
      admissionRead = await readCloudAccountAccess(ports.authority);
      if (
        available.kind !== 'spendable' ||
        admissionRead.kind !== 'ok' ||
        available.credentialGeneration !== admissionRead.credentialGeneration ||
        available.accountId !== admissionRead.accountId
      )
        blockers.add('ai-credits');
    }
  }
  const read = admissionRead;
  const accountReady =
    read.kind === 'ok' && read.hasCredential && !read.sessionExpired;
  if (!accountReady || evidence.expectedAccountIdentity !== read.routeIdentity)
    blockers.add('policy');
  // The launch observation can predate a refresh that made a gateway
  // mandatory; current daemon-held policy must agree before admission.
  if (read.kind === 'ok' && read.hasCredential && read.mayRequireGateway(owner))
    blockers.add('gateway');
  if (evidence.policy === 'required' || accountReady) {
    if (!accountReady) blockers.add('policy');
    for (const route of evidence.routes) {
      const governedModelId = ports.governedModelId
        ? ports.governedModelId(route.requestModel)
        : route.requestModel;
      if (governedModelId === undefined) {
        blockers.add('policy');
        continue;
      }
      const answer =
        read.kind === 'ok'
          ? read.modelPolicy({
              owner,
              scope: evidence.policyScope ?? ports.policyScope,
              governedModelId,
            })
          : { kind: 'unknown' };
      if (answer.kind !== 'allowed') blockers.add('policy');
    }
  }
  if (signal?.aborted) blockers.add('unknown');
  if (blockers.size > 0 || read.kind !== 'ok')
    return {
      kind: 'pauses',
      blockers: blockers.size > 0 ? [...blockers] : ['unknown'],
    };
  const families = new Set<ManagedPipelineCredentialFamily>();
  for (const route of evidence.routes)
    families.add(
      route.effectiveRoute === 'ai-credits'
        ? 'cloud-account'
        : route.authentication === 'explicit-environment'
          ? 'explicit-environment'
          : 'vendor-profile',
    );
  if (evidence.policy === 'required') families.add('cloud-account');
  return {
    kind: 'admissible',
    credentialFamilies: [...families],
    accountId: read.accountId,
    credentialGeneration: read.credentialGeneration,
  };
}
