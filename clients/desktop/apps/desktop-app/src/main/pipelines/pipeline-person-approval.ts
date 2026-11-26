/**
 * CAN-5782: a person's approval of a user pipeline's content, which a timed
 * fire of a `workflow`-only definition needs. The approval names content (the
 * `nativeGrantContentHash` digest), so a fire compares the definition it
 * admitted, never a revision. Only a person's write stamps it, after the
 * write commits and holding the pipeline's schedule guard; every stamp is a
 * compare-and-set on the revision that write committed, so a delayed older
 * save never replaces a newer digest.
 */
import type {
  ApprovePipelineForSchedulesRequest,
  ApprovePipelineForSchedulesResult,
  Pipeline,
} from '@canopy/execution-engine/types/pipeline';
import type { PipelineScheduleApprovalFacts } from '@canopy/protocol/pipelines';
import { nativeGrantContentHash } from '../automations/chat-automation-native-grant';
import {
  readPipelineLocalMetadata,
  recordPersonApprovalTakeover,
  setUserPipelinePersonApproval,
  type PipelineLocalMetadata,
  type PipelinePersonApproval,
} from './pipeline-local-metadata-store';
import { getStoredPipelineBySource } from './pipeline-service';
import { withPipelineScheduleGuard } from './pipeline-schedule-guard';
import { SCHEDULE_UNREADABLE_PACKAGE_MESSAGE } from '../automations/scheduled-workflow-refusal';

/**
 * The package the pipeline runs with now, as its start resolves it, read
 * without changing any install record: its digest, `undefined` for none, or
 * unreadable when it fails
 * verification. An unreadable package is never approved, and is refused
 * before a fire's If Command, as its start would refuse it.
 */
async function currentPackageDigest(
  pipelineId: string,
): Promise<PackageLookup> {
  try {
    const { installedPipelinePackageDigest } =
      await import('./pipeline-package-service');
    return { digest: await installedPipelinePackageDigest(pipelineId) };
  } catch {
    return { unreadable: true };
  }
}

/** A package lookup: its digest (`undefined` for none), or unreadable. */
type PackageLookup = { digest: string | undefined } | { unreadable: true };

function userPipelineMetadata(pipelineId: string): PipelineLocalMetadata {
  return readPipelineLocalMetadata({
    type: 'stored',
    source: 'user',
    value: pipelineId,
  });
}

/** The stored user pipeline's revision and content; a failed read is none. */
function storedUserPipeline(
  pipelineId: string,
): { revision: number; content: Pipeline } | undefined {
  try {
    const stored = getStoredPipelineBySource('user', pipelineId);
    return stored.success && stored.data
      ? {
          revision: stored.data.info.revision ?? 0,
          content: stored.data.content,
        }
      : undefined;
  } catch {
    return undefined;
  }
}

/** Whether the stored approval reads back as `approval`. */
function approvalRecorded(
  pipelineId: string,
  approval: PipelinePersonApproval | null,
): boolean {
  const recorded = userPipelineMetadata(pipelineId).personApprovedDigest;
  return approval === null
    ? recorded === undefined
    : recorded?.contentHash === approval.contentHash &&
        recorded.revision === approval.revision &&
        recorded.packageDigest === approval.packageDigest;
}

/**
 * Stamps the stored content as the person's, if the pipeline is still at the
 * revision their write committed. Callers hold the pipeline's schedule
 * guard. Returns whether the stamp reads back; a skipped or failed stamp
 * leaves the previous digest, which doesn't match the new content.
 *
 * The package the stamp names: the one an **Approve for schedules** request
 * says the person saw (`reviewedPackage`, refused by the caller when it
 * isn't the current one), or, for a save, which shows no package, the
 * current package only when the previous approval already named it. A save
 * never approves a package that appeared since, so a fire with it waits for
 * an explicit approval.
 */
export async function stampPersonApproval(
  pipelineId: string,
  committedRevision: number,
  reviewedPackage?: { digest: string | undefined },
): Promise<boolean> {
  const stored = storedUserPipeline(pipelineId);
  if (stored === undefined || stored.revision !== committedRevision)
    return false;
  const lookup = await currentPackageDigest(pipelineId);
  if ('unreadable' in lookup) return false;
  const current = lookup.digest;
  const previous = userPipelineMetadata(pipelineId).personApprovedDigest;
  const packageDigest =
    reviewedPackage !== undefined
      ? reviewedPackage.digest
      : current !== undefined && previous?.packageDigest === current
        ? current
        : undefined;
  const approval: PipelinePersonApproval = {
    contentHash: nativeGrantContentHash(stored.content),
    revision: stored.revision,
    ...(packageDigest === undefined ? {} : { packageDigest }),
  };
  setUserPipelinePersonApproval(pipelineId, approval);
  return approvalRecorded(pipelineId, approval);
}

/**
 * Puts back the approval a rolled-back write replaced, if the pipeline is
 * still at the revision the rollback committed: one that held for the
 * restored content holds for its new revision; any other stays as it was,
 * and none clears the rolled-back write's stamp. Callers hold the guard.
 */
export function restorePersonApproval(
  pipelineId: string,
  previous: PipelinePersonApproval | undefined,
  restoredRevision: number | undefined,
): Promise<void> {
  if (restoredRevision === undefined) return Promise.resolve();
  const stored = storedUserPipeline(pipelineId);
  if (stored === undefined || stored.revision !== restoredRevision)
    return Promise.resolve();
  setUserPipelinePersonApproval(
    pipelineId,
    previous === undefined
      ? null
      : nativeGrantContentHash(stored.content) === previous.contentHash
        ? { ...previous, revision: stored.revision }
        : previous,
  );
  return Promise.resolve();
}

/**
 * Whether a person approved exactly `admittedContent` running with the
 * package `packageDigest` names (none when `undefined`): no agent wrote the
 * pipeline since, and its approval names that content's digest and that
 * package.
 */
export function isPersonApprovedUserPipeline(
  pipelineId: string,
  admittedContent: unknown,
  packageDigest: string | undefined,
): Promise<boolean> {
  const metadata = userPipelineMetadata(pipelineId);
  const approval = metadata.personApprovedDigest;
  return Promise.resolve(
    metadata.agentAuthor === undefined &&
      approval !== undefined &&
      approval.contentHash === nativeGrantContentHash(admittedContent) &&
      approval.packageDigest === packageDigest,
  );
}

/**
 * The pipeline's stored content and whether a person approved it with the
 * package it runs with now (`runPackage` when a run brings its own), both read under its schedule guard, so a save
 * that commits meanwhile is checked as stored. `undefined` when it can't be
 * read.
 */
export function readApprovedStoredUserPipeline(
  pipelineId: string,
  runPackage?: { digest: string },
): Promise<
  | { content: Pipeline; approved: boolean; packageUnreadable: boolean }
  | undefined
> {
  return withPipelineScheduleGuard(pipelineId, async () => {
    const stored = storedUserPipeline(pipelineId);
    if (stored === undefined) return undefined;
    const lookup: PackageLookup =
      runPackage ?? (await currentPackageDigest(pipelineId));
    const packageUnreadable = 'unreadable' in lookup;
    const approved =
      !('unreadable' in lookup) &&
      (await isPersonApprovedUserPipeline(
        pipelineId,
        stored.content,
        lookup.digest,
      ));
    return {
      content: stored.content,
      approved,
      packageUnreadable,
    };
  });
}

/**
 * What a workflow page's **Approve for schedules** shows for a stored user
 * pipeline (CAN-5782), read under its schedule guard: whether it is
 * approved, and the revision, content digest and package an approval names.
 * `undefined` when it can't be read or its package can't be verified.
 */
export function scheduleApprovalFacts(
  pipelineId: string,
): Promise<PipelineScheduleApprovalFacts | undefined> {
  return withPipelineScheduleGuard(pipelineId, async () => {
    const stored = storedUserPipeline(pipelineId);
    if (stored === undefined) return undefined;
    const lookup = await currentPackageDigest(pipelineId);
    if ('unreadable' in lookup) return undefined;
    return {
      approved: await isPersonApprovedUserPipeline(
        pipelineId,
        stored.content,
        lookup.digest,
      ),
      revision: stored.revision,
      contentDigest: nativeGrantContentHash(stored.content),
      packageDigest: lookup.digest ?? null,
    };
  });
}

/**
 * **Approve for schedules** (person-only): stamps the saved content when it
 * is still the revision and content the person's page shows.
 */
export function approvePipelineForSchedules({
  pipelineId,
  revision,
  contentDigest,
  packageDigest,
}: ApprovePipelineForSchedulesRequest): Promise<ApprovePipelineForSchedulesResult> {
  return withPipelineScheduleGuard(
    pipelineId,
    async (): Promise<ApprovePipelineForSchedulesResult> => {
      const stored = storedUserPipeline(pipelineId);
      if (stored === undefined)
        return {
          success: false,
          refusal: 'not_found',
          error: 'This workflow could not be found.',
        };
      if (stored.revision !== revision)
        return {
          success: false,
          refusal: 'stale_revision',
          error: 'This workflow changed since it was loaded. Reload it first.',
        };
      if (nativeGrantContentHash(stored.content) !== contentDigest)
        return {
          success: false,
          refusal: 'content_mismatch',
          error: 'This workflow changed since it was loaded. Reload it first.',
        };
      // The package the person saw is the one the workflow runs with now.
      const lookup = await currentPackageDigest(pipelineId);
      if ('unreadable' in lookup)
        return {
          success: false,
          refusal: 'package_mismatch',
          error: SCHEDULE_UNREADABLE_PACKAGE_MESSAGE,
        };
      const current = lookup.digest;
      // The lookup awaited: a write that landed meanwhile (an agent's save
      // doesn't take this guard) means the person approved older content.
      const after = storedUserPipeline(pipelineId);
      if (
        after === undefined ||
        after.revision !== revision ||
        nativeGrantContentHash(after.content) !== contentDigest
      )
        return {
          success: false,
          refusal: 'stale_revision',
          error: 'This workflow changed since it was loaded. Reload it first.',
        };
      if ((packageDigest ?? undefined) !== current)
        return {
          success: false,
          refusal: 'package_mismatch',
          error: 'This workflow changed since it was loaded. Reload it first.',
        };
      // An agent's last write: the person takes the reviewed content over,
      // as their save would, clearing the agent author in the same write as
      // the stamp. One whose runs keep an agent's grant is saved from its
      // page instead, where taking the grant away asks first.
      const metadata = userPipelineMetadata(pipelineId);
      if (
        metadata.agentAuthor !== undefined &&
        metadata.nativeGrant !== undefined
      )
        return {
          success: false,
          refusal: 'agent_granted',
          error:
            "This workflow runs with an agent's settings. Save it from its page to take it over, then approve it.",
        };
      const approval: PipelinePersonApproval = {
        contentHash: contentDigest,
        revision,
        ...(current === undefined ? {} : { packageDigest: current }),
      };
      recordPersonApprovalTakeover(pipelineId, approval);
      // Success only when the stamp reads back and no agent author remains.
      if (
        !approvalRecorded(pipelineId, approval) ||
        userPipelineMetadata(pipelineId).agentAuthor !== undefined
      )
        return {
          success: false,
          refusal: 'not_recorded',
          error: 'The approval could not be recorded.',
        };
      return {
        success: true,
        data: {
          contentHash: contentDigest,
          revision,
          ...(current === undefined ? {} : { packageDigest: current }),
        },
      };
    },
  );
}
