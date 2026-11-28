import { parseWorkspaceContext } from '@canopy/protocol/workspace-context';
import {
  decideResourceContext,
  normalizeResourceContextSubjectName,
  type ResourceContextInput,
  type ResourceContextDecision,
} from '@canopy/execution-engine/lib/resource-context-policy';
import { classifyResourceOwner } from '@canopy/execution-engine/lib/resource-context';
import { getWorkspaceContextService } from '../lib/workspace-context-service';
import { readCanopyCloudAccountWithStatus } from '../lib/canopy-cloud-account-store';
import { getObservabilityService } from '../observability';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { getFeatureFlagService } from '../feature-flags';

export interface ResourceContextPolicyService {
  decide(
    input: ResourceContextInput,
    options?: { recordDenial?: boolean },
  ): Promise<ResourceContextDecision>;
}

/**
 * Main-owned context eligibility, not a substitute for family read/team grants.
 * Pipelines use this boundary behind their organization-project feature gate.
 * Background hosts supply a persisted context; foreground selection remains main-owned.
 */
async function decide(
  input: ResourceContextInput,
  { recordDenial = true }: { recordDenial?: boolean } = {},
): Promise<ResourceContextDecision> {
  // CAN-2960: with the rollout flag off the policy plane is inert. Every
  // landed caller is gated separately; this keeps a stray call from reading
  // the account or recording denial diagnostics.
  if (
    !getFeatureFlagService().isEnabled(
      CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key,
    )
  )
    return { allow: true };
  const contextService = getWorkspaceContextService();
  await contextService.initialize();
  await contextService.whenIdle();
  const epoch = contextService.accountEpoch();
  const account = await readCanopyCloudAccountWithStatus();
  await contextService.whenIdle();
  const context =
    input.invocation.mode === 'background'
      ? input.invocation.executionContext === undefined
        ? { kind: 'personal' as const }
        : typeof input.invocation.executionContext === 'string'
          ? parseWorkspaceContext(input.invocation.executionContext)
          : null
      : contextService.getState().context;
  // An unavailable capability read must not silently opt into legacy mode.
  const strict =
    account.status !== 'ok' ||
    account.entry === null ||
    account.entry.capabilities.includes('resource-context-v1');
  const owner = classifyResourceOwner(input.resource.owner, { strict });
  const organizationIds = [
    ...(input.invocation.mode === 'background' &&
    context?.kind === 'organization'
      ? [context.organizationId]
      : []),
    ...(typeof owner === 'object' ? [owner.organizationId] : []),
    ...(input.resource.provenance?.ownerContext?.kind === 'organization'
      ? [input.resource.provenance.ownerContext.organizationId]
      : []),
  ];
  let result: ResourceContextDecision;
  if (epoch !== contextService.accountEpoch()) {
    result = { allow: false, reason: 'access-removed' };
  } else if (
    !context ||
    (input.invocation.mode === 'background' &&
      input.invocation.boundBindingId !== undefined &&
      input.invocation.executionContext === undefined)
  ) {
    result = { allow: false, reason: 'unsupported-target' };
  } else if (
    organizationIds.some(
      (id) =>
        account.status !== 'ok' ||
        (account.entry?.personalOrganizationId !== id &&
          !account.entry?.organizations?.some(
            (organization) => organization.id === id,
          )),
    )
  ) {
    result = { allow: false, reason: 'access-removed' };
  } else {
    result = decideResourceContext(
      { ...input, invocation: { ...input.invocation, context } },
      {
        strict,
        personalOrganizationId:
          account.status === 'ok'
            ? (account.entry?.personalOrganizationId ?? null)
            : null,
      },
    );
  }
  if (
    !result.allow &&
    result.reason === 'unknown-provenance' &&
    input.resource.subject
  ) {
    const subjectName = normalizeResourceContextSubjectName(
      input.resource.subject.name,
    );
    if (subjectName)
      result = {
        ...result,
        subject: { ...input.resource.subject, name: subjectName },
      };
  }
  if (!result.allow && recordDenial) {
    getObservabilityService().recordSessionDiagnostic({
      version: 1,
      timestamp: new Date().toISOString(),
      kind: 'resource_context_denied',
      sessionKey: 'resource-context-policy',
      projectId: '',
      worktreeId: '',
      chatId: '',
      providerType: 'unknown',
      reason: result.reason,
      ...(result.reason === 'unknown-provenance' && result.subject
        ? {
            resourceKind: result.subject.kind,
            resourceName: result.subject.name,
          }
        : {}),
    });
  }
  return result;
}

const service: ResourceContextPolicyService = { decide };
export function getResourceContextPolicyService(): ResourceContextPolicyService {
  return service;
}
