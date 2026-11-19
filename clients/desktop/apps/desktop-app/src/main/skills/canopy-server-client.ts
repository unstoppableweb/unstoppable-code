import { createHash } from 'node:crypto';
import { BUILTIN_SOURCE_ID, CUSTOM_SOURCE_ID } from './paths';
import { parseInstalledSkillLocalId } from './installed-skill-cloud-copy';
import { withPackageVersionNegotiation } from '../canopy-cloud/package-version-negotiation';
import {
  assertSkillContext,
  assertSkillContextSnapshot,
  listSkillLanes,
  skillContextSnapshot,
  skillResourceContextEnabled,
} from './resource-lanes';
import type {
  CreateSharedSkillRequest,
  DeleteSharedSkillRequest,
  ListSharedSkillsRequest,
  ListSharedSkillsResponse,
  SharedSkillDetail,
  SharedSkillPublicShareInfo,
  UpdateSharedSkillRequest,
} from '@canopy/desktop-shared/types/skills';
import { BRAND } from '@canopy/brand/current';
import {
  PIPELINE_PACKAGE_CLIENT_VERSION,
  PIPELINE_PACKAGE_VERSION_HEADER,
} from '@canopy/protocol/pipelines';
import {
  scanSharedSkillForSecrets,
  sharedSkillSecretMessage,
} from '@canopy/protocol/skills';
import {
  assertCanopyCloudCapability,
  type CanopyCloudCredentialContext,
  requestCanopyCloudJson,
  requestCanopyCloudJsonConditional,
  requestCanopyCloudNoContent,
} from '../canopy-cloud/client';
import {
  assertResourceShareDestination,
  assertResourceShareTransition,
} from '../lib/resource-share-context';
import { assertShareScopeTarget } from '../lib/share-scope-target';
import {
  ShareOperationError,
  SkillSecretDetectedError,
} from '../sharing/share-operation-result';
import { parseFrontmatter } from '../lib/frontmatter';

const API_PREFIX = `/api/v1/${BRAND.web.apiNamespace}`;

/**
 * Refuses to send SKILL.md bytes other than the ones the caller checked: the
 * resource-context path reads the file again, and an edit in between must not
 * upload (CAN-6176).
 */
function assertCheckedSource(
  rawSkill: string,
  expectedSourceSha256: string | undefined,
): void {
  if (
    expectedSourceSha256 !== undefined &&
    createHash('sha256').update(rawSkill).digest('hex') !== expectedSourceSha256
  )
    throw new ShareOperationError(
      'dependency-review',
      'This skill changed after its files were checked. Check them again.',
      'prepare',
    );
}

/**
 * Declares which package fields this build can read, so a server holding a
 * newer share projects it down instead of returning a shape this client would
 * misread.
 */
const PACKAGE_HEADERS: Record<string, string> = {
  [PIPELINE_PACKAGE_VERSION_HEADER]: String(PIPELINE_PACKAGE_CLIENT_VERSION),
};

const SKILLS_CAPABILITY = 'skills-crud-v1';

/**
 * Fail closed when the configured Cloud account cannot host shared skills, so
 * a share attempt reports the missing capability instead of a raw 404. The IPC
 * handlers assert the same capability before every shared-skill call.
 */
export async function assertSharedSkillsSupported(
  credentials?: CanopyCloudCredentialContext,
): Promise<void> {
  await assertCanopyCloudCapability(SKILLS_CAPABILITY, credentials);
}

export async function listSharedSkills(
  request: ListSharedSkillsRequest,
): Promise<ListSharedSkillsResponse> {
  if (skillResourceContextEnabled()) {
    return listSkillLanes(request, (lane, cursor, etag) => {
      const query = sharedSkillQuery({ ...request, cursor });
      query.set(
        'shareScope',
        lane.kind === 'personal' ? 'private' : 'organization',
      );
      if (lane.kind === 'organization')
        query.set('organizationId', lane.organizationId);
      return requestCanopyCloudJsonConditional<ListSharedSkillsResponse>(
        `${API_PREFIX}/skills?${query.toString()}`,
        { etag },
      );
    });
  }
  const query = sharedSkillQuery(request);
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  return requestCanopyCloudJson<ListSharedSkillsResponse>(
    `${API_PREFIX}/skills${suffix}`,
  );
}
function sharedSkillQuery(request: ListSharedSkillsRequest): URLSearchParams {
  const query = new URLSearchParams();
  if (request.limit !== undefined) query.set('limit', String(request.limit));
  if (request.cursor) query.set('cursor', request.cursor);
  if (request.query) query.set('q', request.query);
  if (request.createdBy) query.set('createdBy', request.createdBy);
  return query;
}

export async function getSharedSkill(
  skillId: string,
  credentialContext?: CanopyCloudCredentialContext,
): Promise<SharedSkillDetail> {
  const snapshot = skillResourceContextEnabled()
    ? await skillContextSnapshot()
    : undefined;
  const detail = await withPackageVersionNegotiation((version) =>
    requestCanopyCloudJson<SharedSkillDetail>(
      `${API_PREFIX}/skills/${encodeURIComponent(skillId)}`,
      {
        headers: { [PIPELINE_PACKAGE_VERSION_HEADER]: String(version) },
        ...(credentialContext ? { credentialContext } : {}),
      },
    ),
  );
  if (snapshot !== undefined) {
    await assertSkillContext({ owner: detail.owner });
    await assertSkillContextSnapshot(snapshot);
  }
  return detail;
}

/**
 * How a share is authorized. Only a cloud copy of an installed-source skill
 * (CAN-6943), from main's own publish, sets `allowInstalledSource`; it never
 * comes from a renderer request.
 */
export interface SkillShareSourceOptions {
  readonly allowInstalledSource?: boolean;
}

async function authorizedSkillSource(
  sourceSkillId: string | undefined,
  owner: unknown,
  options: SkillShareSourceOptions = {},
): Promise<string> {
  const installed =
    options.allowInstalledSource === true &&
    sourceSkillId !== undefined &&
    parseInstalledSkillLocalId(sourceSkillId) !== null;
  if (
    !sourceSkillId ||
    (!sourceSkillId.startsWith(`${CUSTOM_SOURCE_ID}/`) &&
      !sourceSkillId.startsWith(`${BUILTIN_SOURCE_ID}/`) &&
      !installed)
  )
    throw new Error('A source-qualified local skill is required.');
  // Break the cycle: stored-origin authorization reuses this cloud client.
  const { assertStoredSkillContext, assertSkillShareOrigin } =
    await import('./skill-install-context');
  const { readRawSkill, readInstalledSkillForCloudCopy } =
    await import('./skill-service');
  await assertStoredSkillContext(sourceSkillId);
  await assertSkillShareOrigin(sourceSkillId, owner);
  // Read the authorized local file; caller-supplied bytes cannot select content.
  return installed
    ? readInstalledSkillForCloudCopy(sourceSkillId)
    : readRawSkill(sourceSkillId);
}

/** The name the server gives a skill: frontmatter `name`, else the first heading. */
function sharedSkillDisplayName(rawSkill: string): string {
  const name = parseFrontmatter<Record<string, unknown>>(rawSkill)?.['name'];
  if (typeof name === 'string' && name.trim()) return name.trim();
  for (const line of rawSkill.split(/\r?\n/)) {
    const heading = line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/)?.[1]?.trim();
    if (heading) return heading;
  }
  return 'Untitled skill';
}

/**
 * Refuses to upload SKILL.md text that looks like it holds a secret (CAN-7226).
 * It runs on the exact text that would be sent, before the POST or PUT is
 * built, so the request that would carry it is never sent; reads before it
 * carry no skill text. The message names the skill, file and rule, never the
 * match.
 */
function assertSkillHoldsNoSecret(rawSkill: string): void {
  const finding = scanSharedSkillForSecrets({
    skillName: sharedSkillDisplayName(rawSkill),
    files: [{ path: 'SKILL.md', text: rawSkill }],
  });
  if (finding !== null)
    throw new SkillSecretDetectedError(
      sharedSkillSecretMessage(finding),
      'access',
    );
}

/** An installed-source skill's copy is private only (CAN-6943). */
function assertInstalledSourceScope(
  shareScope: string | undefined,
  options: SkillShareSourceOptions,
  creating: boolean,
): void {
  if (options.allowInstalledSource !== true) return;
  if (creating ? shareScope !== 'private' : shareScope !== undefined)
    throw new Error('A copy of an installed skill stays private.');
}

export async function createSharedSkill(
  request: CreateSharedSkillRequest,
  credentialContext?: CanopyCloudCredentialContext,
  options: SkillShareSourceOptions = {},
): Promise<SharedSkillDetail> {
  assertShareScopeTarget(request, 'a skill');
  assertInstalledSourceScope(request.shareScope, options, true);
  let rawSkill = request.rawSkill;
  if (skillResourceContextEnabled()) {
    const { listSharedTeams } =
      await import('../pipelines/canopy-server-client');
    const team =
      request.shareScope === 'team'
        ? (await listSharedTeams({ id: request.teamId })).data.find(
            (row) => row.id === request.teamId,
          )
        : undefined;
    const owner =
      request.shareScope === 'organization'
        ? { type: 'organization', id: request.organizationId, name: null }
        : request.shareScope === 'team'
          ? team
            ? { ...team, type: 'team' }
            : undefined
          : { type: 'user', id: 'local', name: null };
    await assertSkillContext({ owner });
    rawSkill = await authorizedSkillSource(
      request.sourceSkillId,
      owner,
      options,
    );
  }
  assertCheckedSource(rawSkill, request.expectedSourceSha256);
  assertSkillHoldsNoSecret(rawSkill);
  const body: {
    rawSkill: string;
    shareScope?: CreateSharedSkillRequest['shareScope'];
    teamId?: string;
    organizationId?: string;
    capabilityPackage?: CreateSharedSkillRequest['capabilityPackage'];
    committedPackageUploadId?: string;
    expectedAudience?: CreateSharedSkillRequest['expectedAudience'];
  } = { rawSkill };
  if (request.shareScope !== undefined) body.shareScope = request.shareScope;
  if (request.shareScope === 'team' && request.teamId)
    body.teamId = request.teamId;
  if (request.shareScope === 'organization' && request.organizationId) {
    body.organizationId = request.organizationId;
  }
  // The package ref rides beside the content, never inside it: the server
  // hashes `rawSkill` verbatim and the hash has to round-trip.
  if (request.capabilityPackage) {
    body.capabilityPackage = request.capabilityPackage;
  }
  if (request.committedPackageUploadId) {
    body.committedPackageUploadId = request.committedPackageUploadId;
  }
  if (request.expectedAudience)
    body.expectedAudience = request.expectedAudience;
  return requestCanopyCloudJson<SharedSkillDetail>(`${API_PREFIX}/skills`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: PACKAGE_HEADERS,
    ...(credentialContext ? { credentialContext } : {}),
  });
}

export async function updateSharedSkill(
  request: UpdateSharedSkillRequest,
  credentialContext?: CanopyCloudCredentialContext,
  /** Runs just before the PUT, after any reads; throwing sends nothing. */
  beforeWrite?: () => void,
  options: SkillShareSourceOptions = {},
): Promise<SharedSkillDetail> {
  assertShareScopeTarget(request, 'a skill');
  assertInstalledSourceScope(request.shareScope, options, false);
  let rawSkill = request.rawSkill;
  let storedContentHash = request.expectedContentHash;
  let currentOwner: SharedSkillDetail['owner'] | undefined;
  if (skillResourceContextEnabled()) {
    // The caller's account, so a switch mid-update can't read another's copy.
    const current = await getSharedSkill(request.skillId, credentialContext);
    storedContentHash = current.contentHash;
    currentOwner = current.owner;
    const destination = request.shareScope
      ? await assertResourceShareDestination(request)
      : undefined;
    if (destination) {
      await assertResourceShareTransition(current.owner, destination);
    }
    const destinationOwner =
      destination?.kind === 'organization'
        ? {
            type: 'organization' as const,
            id: destination.organizationId,
            name: null,
          }
        : destination?.kind === 'personal'
          ? { type: 'user' as const, id: 'local', name: null }
          : current.owner;
    rawSkill = await authorizedSkillSource(
      request.sourceSkillId,
      destinationOwner,
      options,
    );
  }
  assertCheckedSource(rawSkill, request.expectedSourceSha256);
  // As on the server, new text, or the same text reaching a team or
  // organization that doesn't own it now, is a share. Making it private or
  // resending it unchanged isn't, so a skill stored before this check can
  // still be taken down (CAN-7226). An unknown stored hash or owner counts as
  // new.
  const keepsOwner =
    (request.shareScope === 'team' &&
      currentOwner?.type === 'team' &&
      currentOwner.id === request.teamId) ||
    (request.shareScope === 'organization' &&
      currentOwner?.type === 'organization' &&
      currentOwner.id === request.organizationId);
  if (
    (request.shareScope !== undefined &&
      request.shareScope !== 'private' &&
      !keepsOwner) ||
    createHash('sha256').update(rawSkill).digest('hex') !== storedContentHash
  )
    assertSkillHoldsNoSecret(rawSkill);
  beforeWrite?.();
  return requestCanopyCloudJson<SharedSkillDetail>(
    `${API_PREFIX}/skills/${encodeURIComponent(request.skillId)}`,
    {
      method: 'PUT',
      ...(credentialContext ? { credentialContext } : {}),
      body: JSON.stringify({
        rawSkill,
        ...(request.preservePackage ? { preservePackage: true } : {}),
        ...(request.expectedContentHash
          ? { expectedContentHash: request.expectedContentHash }
          : {}),
        ...(request.shareScope ? { shareScope: request.shareScope } : {}),
        ...(request.shareScope === 'team' && request.teamId
          ? { teamId: request.teamId }
          : {}),
        ...(request.shareScope === 'organization' && request.organizationId
          ? { organizationId: request.organizationId }
          : {}),
        ...(request.capabilityPackage
          ? { capabilityPackage: request.capabilityPackage }
          : {}),
        ...(request.committedPackageUploadId
          ? { committedPackageUploadId: request.committedPackageUploadId }
          : {}),
        ...(request.revokePublicShare
          ? { revokePublicShare: request.revokePublicShare }
          : {}),
        ...(request.expectedAudience
          ? { expectedAudience: request.expectedAudience }
          : {}),
      }),
      headers: PACKAGE_HEADERS,
    },
  );
}

export async function deleteSharedSkill(
  request: DeleteSharedSkillRequest,
  credentialContext?: CanopyCloudCredentialContext,
): Promise<void> {
  if (skillResourceContextEnabled())
    await getSharedSkill(request.skillId, credentialContext);
  await requestCanopyCloudNoContent(
    `${API_PREFIX}/skills/${encodeURIComponent(request.skillId)}`,
    { method: 'DELETE', ...(credentialContext ? { credentialContext } : {}) },
  );
}

export async function publishSkillPublicShare(
  skillId: string,
): Promise<SharedSkillPublicShareInfo> {
  if (skillResourceContextEnabled()) await getSharedSkill(skillId);
  const response = await requestCanopyCloudJson<{
    publicShare: SharedSkillPublicShareInfo;
  }>(`${API_PREFIX}/skills/${encodeURIComponent(skillId)}/public-share`, {
    method: 'POST',
  });
  return response.publicShare;
}

export async function revokeSkillPublicShare(skillId: string): Promise<void> {
  if (skillResourceContextEnabled()) await getSharedSkill(skillId);
  await requestCanopyCloudNoContent(
    `${API_PREFIX}/skills/${encodeURIComponent(skillId)}/public-share`,
    { method: 'DELETE' },
  );
}
