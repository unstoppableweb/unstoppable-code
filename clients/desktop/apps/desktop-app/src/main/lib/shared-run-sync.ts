import { assertShareScopeTarget } from './share-scope-target';
import type {
  ShareRunEligibilityRequest,
  ShareRunEligibilityResponse,
  ShareRunRequest,
  ShareRunResponse,
  UnshareRunRequest,
  UnshareRunResponse,
} from '@canopy/desktop-shared/types';
import type { AgentAuditEntry } from '@canopy/execution-engine/types/observability';
import {
  MAX_SHARED_RUN_TITLE_LENGTH,
  type RunShareScope,
  type SharedRunCreateRequest,
} from '@canopy/protocol/runs';
import { redactSecrets } from '@canopy/execution-engine/lib/redaction';
import { getObservabilityService } from '../observability';
import { getTelemetrySyncService } from '../services/telemetry-sync-service';
import { readDiff } from '../services/diff-service';
import {
  createSharedRun,
  unshareSharedRunByClientLocalId,
} from '../runs/canopy-server-client';
import {
  registerSharedRunForComments,
  sharedRunIdempotencyKey,
  unregisterSharedRunForComments,
} from './shared-run-comments-registry';
import { rollupFromEntries } from './shared-run-rollup';
import { readWorktreeSummary } from './worktree-summary-persistence';
import { listTrackedPlans } from './plan-persistence';
import {
  loadStoredTelemetryEnforcementByOrganization,
  recordTelemetryEnforcementReadFailure,
  type StoredTelemetryEnforcementByOrganization,
} from './telemetry-enforcement-state';
import { enforcementForOrganization } from '@canopy/desktop-shared/lib/telemetry-enforcement';
import { normalizeUuid } from '@canopy/execution-engine/lib/workspace-owner';
import { resolveWorkOwnerOrganization } from './work-owner';
import { getWorkspaceContextService } from './workspace-context-service';
import type { WorkspaceContext } from '@canopy/protocol/workspace-context';
import { resolveLapsedOrganizationNames } from './org-billing-state';
import { getCanopyCloudCredentials } from './canopy-cloud-account-store';

/**
 * Scopes whose prohibition blocks run sharing outright.
 *
 * A shared run is a full chat transcript published to an audience, so
 * `transcripts` is the obvious one. `metadata` is here too because the
 * workspace/worktree/turn envelope the run rows are attached to IS metadata —
 * with it prohibited there is no row for the grant to reference. A `plans`
 * prohibition is NOT blocking: the run still shares, minus its plans (handled
 * inside `ingestSessionForShare`).
 */
const SHARE_BLOCKING_SCOPES = ['transcripts', 'metadata'] as const;

/**
 * Resolve whether an org prohibition blocks run sharing.
 *
 * Run sharing is a first-class org transcript path, not an edge case: it
 * bypasses the ambient telemetry gate by design, defaults to `organization`
 * scope, and captures at higher fidelity than ambient sync. Without this gate a
 * transcripts prohibition would be one click away from being bypassed by any
 * member, which is exactly what makes it worth enforcing at the eligibility
 * probe rather than only at upload time.
 *
 * Fail closed: a read failure blocks the share and is recorded because "the
 * local gate silently stopped running" is otherwise indistinguishable from
 * "the owner org permits this".
 * The diagnostic is app-scoped, not session-scoped: the failure is in the
 * policy-state read, not in this worktree's transcript capture.
 *
 * `targetOrganizationId` adds the second, per-org reason (CAN-2311): an org
 * that has lost the `teams` capability can no longer receive shared runs. It is
 * deliberately keyed by the SHARE'S TARGET org rather than "any org the user
 * belongs to" — a member of one lapsed org and one healthy org must still be
 * able to share into the healthy one, and a private-scope share (no target org
 * at all) is never affected. The two report through DIFFERENT reasons
 * (`blocked-by-org-policy` vs `blocked-by-org-billing`): both are
 * organization-side conditions only an admin can lift, but they name different
 * remedies, and telling a lapsed org that its data sharing is "blocked" is
 * false.
 */
async function resolveShareOrgPolicyBlock(
  projectId: string,
  worktreeId: string,
  selectedContext: WorkspaceContext | null,
  targetOrganizationId?: string | null,
): Promise<{
  blocked: boolean;
  organizationNames: string[];
  /**
   * WHICH org-side condition blocked the share. Kept distinct because the two
   * render different copy and name different remedies: a data-sharing
   * prohibition is a policy an admin can lift, while a lapse is a subscription
   * an admin must restore. Collapsing them told a lapsed org's members that
   * "sharing that data is blocked by {org}", which is simply not true.
   */
  kind: 'policy' | 'billing' | null;
}> {
  try {
    const owner = await resolveWorkOwnerOrganization(
      { projectId, worktreeId },
      () => Promise.resolve(selectedContext),
    );
    if (owner.kind === 'unknown') {
      return { blocked: true, organizationNames: [], kind: 'policy' };
    }
    const governingOrg =
      owner.kind === 'organization' ? owner.organizationId : null;
    const byOrg: StoredTelemetryEnforcementByOrganization =
      governingOrg === null
        ? new Map<string, never>()
        : await loadStoredTelemetryEnforcementByOrganization();
    const enforcement = enforcementForOrganization(byOrg, governingOrg);
    const normalizedGoverningOrg = governingOrg
      ? normalizeUuid(governingOrg)
      : null;
    const organizationName = normalizedGoverningOrg
      ? byOrg.get(normalizedGoverningOrg)?.organizationName
      : undefined;
    for (const scope of SHARE_BLOCKING_SCOPES) {
      if (enforcement.prohibited[scope]) {
        return {
          blocked: true,
          organizationNames: organizationName ? [organizationName] : [],
          kind: 'policy',
        };
      }
    }
  } catch (error) {
    recordTelemetryEnforcementReadFailure('share-eligibility', error);
    return { blocked: true, organizationNames: [], kind: 'policy' };
  }
  if (targetOrganizationId) {
    const lapsed = await resolveLapsedOrganizationNames([targetOrganizationId]);
    if (lapsed.length > 0) {
      return { blocked: true, organizationNames: lapsed, kind: 'billing' };
    }
  }
  return { blocked: false, organizationNames: [], kind: null };
}

/**
 * The organization a share lands in, or `null` when there is none.
 *
 * Organization scope names its target directly. Team scope does not, but a
 * team's data lives in its owning org, so the team is resolved through the
 * persisted account snapshot to that org. Private scope has no org, so it is
 * never gated. A lookup failure resolves to `null` (ungated) — see the
 * fail-open invariant in `lib/org-billing-state`.
 */
async function resolveShareTargetOrganizationId(
  request: ShareRunRequest,
  shareScope: RunShareScope,
): Promise<string | null> {
  if (shareScope === 'organization') {
    return request.organizationId ?? null;
  }
  if (shareScope !== 'team' || !request.teamId) {
    return null;
  }
  try {
    const credentials = await getCanopyCloudCredentials();
    const team = (credentials.teams ?? []).find(
      (candidate) => candidate.id === request.teamId,
    );
    return team?.organization.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Explicit "Share run" orchestration.
 *
 * 1. Load the finished chat session's audit entries and roll up its
 *    cost/token/tool totals.
 * 2. Compute the run diff (combined worktree diff) and redact secrets.
 * 3. Materialize the session's rows server-side by ingesting it on demand into
 *    a dedicated, collision-proof share namespace (USER-owned). This bypasses
 *    the ambient telemetry gate so the share proceeds even when ambient sync is
 *    Off (the click is consent), and the returned ids are what the grant
 *    references — see `ingestSessionForShare`.
 * 4. Create the private-, team-, or organization-scoped `SharedRun` grant in
 *    Cloud.
 *
 * Returns the created run's `externalId`, or `null` plus a `no-activity` reason
 * when the session has no finished turns to share — see
 * {@link getShareRunEligibility} for why that is a permanent state rather than
 * a retryable failure.
 */
export async function shareRun(
  request: ShareRunRequest,
): Promise<ShareRunResponse> {
  const { projectId, worktreeId, chatId } = request;
  const selectedContext =
    getWorkspaceContextService().getState()?.context ?? null;

  // Every caller names the audience; an omitted scope is never widened to the
  // organization on the author's behalf.
  if (request.shareScope === undefined) {
    throw new Error('Choose a team or organization to share this run with.');
  }
  const shareScope: RunShareScope = request.shareScope;
  assertShareScopeTarget(request, 'a run');

  // Refuse BEFORE loading entries and computing a diff: both are expensive
  // (history paging plus a full worktree diff), and neither is worth doing for
  // a share the org has prohibited.
  const policyBlock = await resolveShareOrgPolicyBlock(
    projectId,
    worktreeId,
    selectedContext,
    await resolveShareTargetOrganizationId(request, shareScope),
  );
  if (policyBlock.blocked) {
    return {
      externalId: null,
      reason:
        policyBlock.kind === 'billing'
          ? 'blocked-by-org-billing'
          : 'blocked-by-org-policy',
      auditRetentionDays: getObservabilityService().getRetentionDays(),
      blockedByOrganizationNames: policyBlock.organizationNames,
    };
  }

  // Shared-run projection and canonical state import each other; resolve the
  // service only at the durability boundary.
  const { getChatStateService } =
    await import('../services/chat-state-service');
  await getChatStateService().flushScope(projectId, worktreeId);

  const entries = await loadFinishedChatEntries(projectId, worktreeId, chatId);
  if (entries.length === 0) {
    return {
      externalId: null,
      reason: 'no-activity',
      auditRetentionDays: getObservabilityService().getRetentionDays(),
    };
  }

  const rollup = rollupFromEntries(entries);
  const latest = entries[entries.length - 1];
  const title = clampTitle(
    redactSecrets(await resolveShareTitle(projectId, worktreeId, latest)),
  );

  const diff = await computeRunDiff(projectId, worktreeId);

  // Materialize the session's rows server-side before creating the grant, and
  // learn the share-namespaced ids they were written under. A null result means
  // the session could not be ingested (e.g. worktree meta could not be
  // resolved), so the grant would reference turns that were never persisted —
  // surface a clear error instead of creating a broken run.
  const ingested = await getTelemetrySyncService().ingestSessionForShare(
    projectId,
    worktreeId,
    chatId,
    selectedContext,
  );
  if (ingested.status === 'blocked-by-org-policy') {
    // Backstop: the eligibility gate above already covers the normal flow, so
    // reaching here means the policy changed mid-share.
    return {
      externalId: null,
      reason: 'blocked-by-org-policy',
      auditRetentionDays: getObservabilityService().getRetentionDays(),
      blockedByOrganizationNames: ingested.organizationNames,
    };
  }
  if (ingested.status !== 'ok') {
    throw new Error(
      'Failed to sync the session for sharing; no shareable turns were ingested.',
    );
  }

  const payload: SharedRunCreateRequest = {
    // Stable, client-authoritative idempotency key derived from the session
    // identity so re-sharing (or retrying after a transient failure) updates the
    // existing SharedRun in place instead of minting duplicate grants/feed items.
    clientLocalRunId: sharedRunIdempotencyKey(projectId, worktreeId, chatId),
    // The share-namespaced ids the rows were actually written under, so the
    // grant resolves to exactly those rows server-side.
    workspaceLocalId: ingested.workspaceLocalId,
    worktreeLocalId: ingested.worktreeLocalId,
    clientChatId: chatId,
    shareScope,
    ...(shareScope === 'team' && request.teamId
      ? { teamId: request.teamId }
      : {}),
    ...(shareScope === 'organization' && request.organizationId
      ? { organizationId: request.organizationId }
      : {}),
    ...(request.preserveExistingOwner ? { preserveExistingOwner: true } : {}),
    title,
    summary: '',
    rollup,
    diff,
  };

  const ref = await createSharedRun(payload);
  // Register the grant so the comment poller (CAN-397) watches it. Best-effort:
  // a registry write failure must never fail the share itself — the next
  // (re-)share re-registers it.
  await registerSharedRunForComments({
    projectId,
    worktreeId,
    chatId,
    externalId: ref.externalId,
  }).catch(() => undefined);
  return { externalId: ref.externalId };
}

/**
 * Unshare a previously shared run for a `(projectId, worktreeId, chatId)`
 * session (CAN-395). Recomputes the deterministic idempotency key from the
 * session identity — rather than depending on the locally-persisted
 * `externalId`, which can be stale — and hard-deletes the grant on Canopy
 * Cloud so a later re-share mints a fresh run.
 */
export async function unshareRun(
  request: UnshareRunRequest,
): Promise<UnshareRunResponse> {
  const { projectId, worktreeId, chatId } = request;
  const clientLocalRunId = sharedRunIdempotencyKey(
    projectId,
    worktreeId,
    chatId,
  );
  const result = await unshareSharedRunByClientLocalId(clientLocalRunId);
  // Stop polling this session's comments; the threads cascaded away with the
  // grant. Best-effort, for the same reason registration is.
  await unregisterSharedRunForComments({
    projectId,
    worktreeId,
    chatId,
  }).catch(() => undefined);
  return { unshared: result.unshared };
}

function clampTitle(title: string): string {
  return title.length > MAX_SHARED_RUN_TITLE_LENGTH
    ? title.slice(0, MAX_SHARED_RUN_TITLE_LENGTH)
    : title;
}

/**
 * Derive a meaningful run title. The raw audit-entry label is generic ("Code
 * Chat"), so every share would collide; prefer, in order:
 *
 *   1. the worktree summary title — the desktop's evolving headline for the work
 *      (e.g. "Hero text change: 'Ship faster with a team of agents'"),
 *   2. the latest active tracked plan's title (skipping hidden/dismissed plans),
 *   3. the audit-entry label, then a static fallback.
 *
 * Each lookup is best-effort: a read failure falls through to the next source so
 * a title lookup can never block the share. The caller still redacts + clamps.
 */
async function resolveShareTitle(
  projectId: string,
  worktreeId: string,
  latest: AgentAuditEntry,
): Promise<string> {
  try {
    const summary = await readWorktreeSummary(projectId, worktreeId);
    const summaryTitle = summary?.title.trim();
    if (summaryTitle) {
      return summaryTitle;
    }
  } catch {
    // Fall through to the plan/label sources.
  }

  try {
    const plans = await listTrackedPlans(projectId, worktreeId);
    const planTitle = plans
      .find((plan) => plan.hidden !== true && plan.dismissedAt === undefined)
      ?.title.trim();
    if (planTitle) {
      return planTitle;
    }
  } catch {
    // Fall through to the label.
  }

  return latest.label || 'Shared run';
}

/**
 * Whether a session can be shared at all, without doing any of the share work.
 *
 * A run is assembled from observability audit entries rather than the persisted
 * chat transcript, and those entries are pruned on the `auditRetentionDays`
 * schedule. A chat older than that window still has every message on disk and
 * still renders normally, but has no audit rows left — so it can never be
 * shared again. That is a permanent, explainable state, and the share modal
 * probes it on open so the user is told up front instead of after choosing an
 * audience and clicking Share.
 *
 * A history read failure resolves to `shareable: true`: absence of proof is not
 * proof of absence, and blocking on a transient read error would strand a
 * perfectly shareable session behind permanent-sounding copy. The share itself
 * still reports the real outcome.
 */
export async function getShareRunEligibility(
  request: ShareRunEligibilityRequest,
): Promise<ShareRunEligibilityResponse> {
  const { projectId, worktreeId, chatId } = request;
  const auditRetentionDays = getObservabilityService().getRetentionDays();
  const selectedContext =
    getWorkspaceContextService().getState()?.context ?? null;

  // Org policy is checked first and reported ahead of `no-activity`: it is the
  // more actionable explanation, and it is decided without touching history.
  //
  // No target org is passed, and that is deliberate (CAN-2311): the probe runs
  // before the user picks an audience, so it cannot know which org a share
  // would land in. Blocking here on "any org the user belongs to is lapsed"
  // would be exactly the global kill switch this gate must not be — it would
  // disable Share for a member of one lapsed org even for a private share or a
  // share into a healthy org. The lapsed reason is therefore reported by
  // `shareRun`, once the audience is known.
  const policyBlock = await resolveShareOrgPolicyBlock(
    projectId,
    worktreeId,
    selectedContext,
  );
  if (policyBlock.blocked) {
    return {
      shareable: false,
      reason: 'blocked-by-org-policy',
      auditRetentionDays,
      blockedByOrganizationNames: policyBlock.organizationNames,
    };
  }

  let shareable = true;
  try {
    shareable =
      (await loadFinishedChatEntries(projectId, worktreeId, chatId, true))
        .length > 0;
  } catch {
    // Fall through to the permissive default.
  }
  return shareable
    ? { shareable: true, auditRetentionDays }
    : { shareable: false, reason: 'no-activity', auditRetentionDays };
}

/**
 * Collect a chat's finished audit entries, oldest-first.
 *
 * `stopAtFirstMatch` short-circuits the paging for the eligibility probe, which
 * only needs to know whether *any* entry exists and runs on every share-modal
 * open. Note the page budget is spent per worktree, not per chat: entries from
 * sibling chats consume it too, so a very busy worktree can page past an older
 * chat's entries.
 */
async function loadFinishedChatEntries(
  projectId: string,
  worktreeId: string,
  chatId: string,
  stopAtFirstMatch = false,
): Promise<AgentAuditEntry[]> {
  const observability = getObservabilityService();
  const collected: AgentAuditEntry[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const response = await observability.loadHistory({
      projectId,
      worktreeId,
      limit: 200,
      ...(cursor ? { cursor } : {}),
    });
    for (const entry of response.entries) {
      if (entry.chatId === chatId && entry.status !== 'running') {
        collected.push(entry);
      }
    }
    if (stopAtFirstMatch && collected.length > 0) {
      return collected;
    }
    if (!response.nextCursor) {
      break;
    }
    cursor = response.nextCursor;
  }
  // History is newest-first; a run reads oldest-first.
  return collected.reverse();
}

async function computeRunDiff(
  projectId: string,
  worktreeId: string,
): Promise<string> {
  try {
    const diff = await readDiff({
      workspaceId: projectId,
      worktreeId,
      source: 'combined',
    });
    return redactSecrets(diff.patch ?? '');
  } catch {
    return '';
  }
}
