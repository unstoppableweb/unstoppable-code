import { createHash } from 'node:crypto';
import {
  CatalogHostRefusedError,
  type CatalogPublication,
  type CatalogPublishOptions,
  type CatalogPublishPackage,
} from '@canopy/core-runtime/node/catalog';
import {
  CLOUD_CUSTOM_SKILL_SOURCE_ID,
  skillEntryId,
} from '@canopy/protocol/canopy-core';
import type { PipelinePackageRef } from '@canopy/protocol/pipelines';
import type { ShareRemoteMetadata } from '@canopy/protocol/sharing';
import {
  scanSharedSkillForSecrets,
  sharedSkillSecretMessage,
  type InstalledSkillInfo,
  type SharedSkillDetail,
} from '@canopy/protocol/skills';
import {
  CanopyCloudClientError,
  type CanopyCloudCredentialContext,
} from '../canopy-cloud/client';
import type {
  AnalyzeSkillCapabilityPackageInput,
  PackageConsentFacts,
  SkillAnalysisSubject,
} from '../pipelines/pipeline-package-service';
import {
  PackageAnalysisBlockedError,
  ShareOperationError,
  SkillSecretDetectedError,
} from '../sharing/share-operation-result';
import type { CloudCopyAudience } from '@canopy/desktop-shared/types';
import {
  cloudCopyAudience,
  readLinkedCopyAudience,
} from '../cloud-copy/audience';
import {
  CloudCopyConsentStore,
  type CloudCopyConsent,
} from './cloud-copy-consents';
import { CUSTOM_SOURCE_ID, getSkillsRootDir } from './paths';
import {
  isCopyableInstalledSkill,
  parseInstalledSkillEntry,
} from './installed-skill-cloud-copy';

/**
 * How a share request is authorized: an installed-source skill's cloud copy
 * (CAN-6943) may read a skill installed from GitHub, a URL or a local
 * folder; every other share reads only custom and built-in skills.
 */
export interface ShareSourceOptions {
  readonly installedSource: boolean;
}

/** What a skill publish calls; tests inject fakes. Defaults load lazily. */
export interface PublishSkillDeps {
  /** The installed skills, each with its author-side link. */
  loadSkills: () => Promise<readonly InstalledSkillInfo[]>;
  readRawSkill: (localId: string) => Promise<string>;
  /**
   * Whether skills installed from GitHub, a URL or a local folder may be
   * copied (CAN-6943's flag), and their SKILL.md as main reads it.
   */
  installedSkillsEnabled: () => Promise<boolean>;
  readInstalledSkill: (localId: string) => Promise<string>;
  /** Its whole folder's fingerprint, which its consent records. */
  fingerprintInstalledSkill: (localId: string) => Promise<string>;
  /**
   * Throws unless the cloud honours a create's expectedAudience; an older
   * one would relink an identical public skill's package (CAN-6943).
   */
  assertCreateAudienceSupported: (
    context: CanopyCloudCredentialContext,
  ) => Promise<void>;
  /**
   * The skill a live analysis covered and the content hash it was made over;
   * null once expired or for a pipeline analysis.
   */
  analysisSubject: (analysisId: string) => Promise<SkillAnalysisSubject | null>;
  /** What a live analysis would package; null once expired. */
  analysisFacts: (
    analysisId: string,
    selectedOptionalResourceIds: readonly string[],
  ) => Promise<PackageConsentFacts | null>;
  /**
   * The signed-in account and its credentials, resolved once per publish so
   * every request lands in the account the person consented under; throws
   * `missing-api-key` when signed out.
   */
  credentials: () => Promise<{
    accountId: string;
    context: CanopyCloudCredentialContext;
  }>;
  commitPackage: (
    pkg: CatalogPublishPackage,
    context: CanopyCloudCredentialContext,
    /**
     * The caller's budget, checked before preparing the package and before
     * every request and retry; throwing stops it, so nothing more is sent.
     */
    stillInTime?: () => void,
  ) => Promise<{
    capabilityPackage: PipelinePackageRef;
    committedPackageUploadId: string;
  }>;
  createSharedSkill: (
    request: {
      sourceSkillId: string;
      rawSkill: string;
      shareScope: 'private';
      capabilityPackage: PipelinePackageRef;
      committedPackageUploadId: string;
      expectedSourceSha256: string;
      expectedAudience: CloudCopyAudience;
    },
    context: CanopyCloudCredentialContext,
    options?: ShareSourceOptions,
  ) => Promise<SharedSkillDetail>;
  updateSharedSkill: (
    request: {
      sourceSkillId: string;
      skillId: string;
      rawSkill: string;
      expectedContentHash: string;
      capabilityPackage: PipelinePackageRef;
      committedPackageUploadId: string;
      expectedSourceSha256: string;
      expectedAudience: CloudCopyAudience;
    },
    context: CanopyCloudCredentialContext,
    /** Runs just before the copy is written; throwing stops it. */
    beforeWrite?: () => void,
    options?: ShareSourceOptions,
  ) => Promise<SharedSkillDetail>;
  writeLink: (localId: string, remote: ShareRemoteMetadata) => Promise<void>;
  writeConsent: (localId: string, consent: CloudCopyConsent) => Promise<void>;
  now: () => string;
  /**
   * Who sees the linked copy in the cloud now, from its own record; null
   * when it no longer exists for this account.
   */
  linkedCopyAudience: (
    skillId: string,
    context: CanopyCloudCredentialContext,
  ) => Promise<CloudCopyAudience | null>;
}

const consentStore = (): CloudCopyConsentStore =>
  CloudCopyConsentStore.inSkillsRoot(getSkillsRootDir());

const defaultDeps: PublishSkillDeps = {
  linkedCopyAudience: readLinkedCopyAudience,
  loadSkills: async () => {
    const { loadSkills } = await import('./skill-service');
    const { filterStoredSkillContexts } =
      await import('./skill-install-context');
    const loaded = loadSkills();
    return loaded.success && loaded.data
      ? filterStoredSkillContexts(loaded.data)
      : [];
  },
  readRawSkill: async (localId) =>
    (await import('./skill-service')).readRawSkill(localId),
  installedSkillsEnabled: async () =>
    (
      await import('../cloud-copy/installed-skills-flag')
    ).installedSkillCloudCopyEnabled(),
  readInstalledSkill: async (localId) =>
    (await import('./skill-service')).readInstalledSkillForCloudCopy(localId),
  fingerprintInstalledSkill: async (localId) =>
    (await import('./skill-service')).fingerprintInstalledSkillForCloudCopy(
      localId,
    ),
  assertCreateAudienceSupported: async (context) => {
    const { assertCanopyCloudCapability } =
      await import('../canopy-cloud/client');
    const { SKILL_CREATE_EXPECTED_AUDIENCE_CAPABILITY } =
      await import('@canopy/protocol/canopy-server');
    await assertCanopyCloudCapability(
      SKILL_CREATE_EXPECTED_AUDIENCE_CAPABILITY,
      context,
    );
  },
  analysisSubject: async (analysisId) =>
    (
      await import('../pipelines/pipeline-package-service')
    ).skillAnalysisSubject(analysisId),
  analysisFacts: async (analysisId, selectedOptionalResourceIds) =>
    (
      await import('../pipelines/pipeline-package-service')
    ).packageAnalysisConsentFacts(analysisId, selectedOptionalResourceIds),
  credentials: async () => {
    const { resolveCanopyCloudCredentialContext } =
      await import('../canopy-cloud/client');
    const context = await resolveCanopyCloudCredentialContext();
    const accountId = context.apiKey ? context.account?.id.trim() : undefined;
    if (!accountId)
      throw new CanopyCloudClientError(
        'missing-api-key',
        'Sign in to add skills to the cloud.',
      );
    return { accountId, context };
  },
  commitPackage: async (pkg, context, stillInTime) => {
    const { assertSharedSkillsSupported } =
      await import('./canopy-server-client');
    await assertSharedSkillsSupported(context);
    return (
      await import('../pipelines/pipeline-package-service')
    ).createSubjectCapabilityPackage(
      {
        analysisId: pkg.analysisId,
        selectedOptionalResourceIds: [...pkg.selectedOptionalResourceIds],
      },
      undefined,
      context,
      stillInTime,
    );
  },
  createSharedSkill: async (request, context, options) =>
    (await import('./canopy-server-client')).createSharedSkill(
      request,
      context,
      { allowInstalledSource: options?.installedSource === true },
    ),
  updateSharedSkill: async (request, context, beforeWrite, options) =>
    (await import('./canopy-server-client')).updateSharedSkill(
      request,
      context,
      beforeWrite,
      { allowInstalledSource: options?.installedSource === true },
    ),
  writeLink: async (localId, remote) =>
    (await import('./skill-service')).writeSkillRemoteMetadata(localId, remote),
  writeConsent: (localId, consent) => {
    consentStore().set(localId, consent);
    return Promise.resolve();
  },
  now: () => new Date().toISOString(),
};

const CUSTOM_PREFIX = `skill:${CUSTOM_SOURCE_ID}/`;

const sha256 = (text: string): string =>
  createHash('sha256').update(text).digest('hex');

function cloudRefusal(error: unknown): CatalogHostRefusedError {
  if (error instanceof CatalogHostRefusedError) return error;
  return new CatalogHostRefusedError(
    // The package commit and the share client refuse a skill that looks
    // like it holds a secret, naming it (CAN-7226), a blocked analysis, and
    // an expired or outdated one or a SKILL.md edited since the check,
    // locally.
    error instanceof SkillSecretDetectedError ||
      (error instanceof PackageAnalysisBlockedError && error.secretDetected)
      ? 'publish-secret-detected'
      : error instanceof PackageAnalysisBlockedError
        ? 'publish-package-blocked'
        : error instanceof ShareOperationError &&
            error.kind === 'dependency-review'
          ? 'publish-package-stale'
          : error instanceof CanopyCloudClientError &&
              error.status === 409 &&
              error.serverCode === 'audience_changed'
            ? 'publish-package-stale'
            : error instanceof CanopyCloudClientError && error.status === 409
              ? 'publish-revision-moved'
              : 'publish-remote-unavailable',
    error,
  );
}

/**
 * Publishes a custom skill as the account's cloud copy (CAN-6176, D6 to D8).
 * Only the local SKILL.md and the package the person consented to travel:
 * the analysis must have covered this skill and been made over its file as it
 * is now, so another skill's analysis or a skill edited after the consent
 * dialog answers `publish-package-stale` and nothing uploads. A linked copy is updated in its existing scope against the hash it
 * was last published with, so a copy changed elsewhere answers 409.
 *
 * With CAN-6943's flag on, a skill installed from GitHub, a URL or a local
 * folder publishes the same way, with three differences: only to a private
 * copy, never kept in step (its consent records `keepInStep: false`, so a
 * changed skill offers "Update in cloud" and asks again), and its SKILL.md is
 * read through the installed-source reader. Off, it is refused as
 * `publish-source-unsupported` and nothing uploads.
 */
export async function publishSkillToCloud(
  entryId: string,
  pkg: CatalogPublishPackage,
  deps: PublishSkillDeps = defaultDeps,
  options: CatalogPublishOptions = {},
): Promise<CatalogPublication> {
  const installed = entryId.startsWith(CUSTOM_PREFIX)
    ? null
    : parseInstalledSkillEntry(entryId);
  if (
    !entryId.startsWith(CUSTOM_PREFIX) &&
    (installed === null || !(await deps.installedSkillsEnabled()))
  )
    throw new CatalogHostRefusedError('publish-source-unsupported');
  const sourceId = installed?.sourceId ?? CUSTOM_SOURCE_ID;
  const skillName = installed?.skillName ?? entryId.slice(CUSTOM_PREFIX.length);
  const skill = (await deps.loadSkills()).find(
    (candidate) =>
      candidate.sourceId === sourceId && candidate.name === skillName,
  );
  if (skill === undefined)
    throw new CatalogHostRefusedError('publish-entry-not-found');
  if (installed !== null && !isCopyableInstalledSkill(skill))
    throw new CatalogHostRefusedError('publish-source-unsupported');
  const shareSource: ShareSourceOptions = {
    installedSource: installed !== null,
  };
  const localId = `${sourceId}/${skillName}`;
  const rawSkill =
    installed === null
      ? await deps.readRawSkill(localId)
      : await deps.readInstalledSkill(localId);
  // The package carries SKILL.md, so a secret-looking one is refused before
  // the commit and every other request, not only at the create (CAN-7226).
  const secret = scanSharedSkillForSecrets({
    skillName,
    files: [{ path: 'SKILL.md', text: rawSkill }],
  });
  if (secret !== null)
    throw new CatalogHostRefusedError(
      'publish-secret-detected',
      new SkillSecretDetectedError(sharedSkillSecretMessage(secret), 'prepare'),
    );
  const checked = sha256(rawSkill);
  const analysed = await deps.analysisSubject(pkg.analysisId);
  if (
    analysed?.sourceId !== sourceId ||
    analysed.skillName !== skillName ||
    analysed.contentHash !== checked ||
    // Only a cloud copy's review withholds what a share would block on.
    !analysed.cloudCopy ||
    // And only the consent dialog's own, for the account it was issued for.
    analysed.accountId === null ||
    analysed.accountId !== options.expectedAccountId ||
    analysed.audience === null
  )
    throw new CatalogHostRefusedError('publish-package-stale');
  const consentedAudience = analysed.audience;
  // A third-party skill goes to a private copy only, until wider copies of
  // them are decided (CAN-6943).
  if (installed !== null && consentedAudience !== 'private')
    throw new CatalogHostRefusedError('publish-source-unsupported');
  // The files it would carry and leave out, recorded with the consent so a
  // later republish is held to them.
  const facts = await deps.analysisFacts(
    pkg.analysisId,
    pkg.selectedOptionalResourceIds,
  );
  // A skill it carries looks like it holds a secret: say which, not that the
  // files changed (CAN-7226).
  if (facts?.secretRefusal !== undefined)
    throw new CatalogHostRefusedError(
      'publish-secret-detected',
      new SkillSecretDetectedError(facts.secretRefusal, 'prepare'),
    );
  if (facts === null || !facts.ready || facts.contentHash !== checked)
    throw new CatalogHostRefusedError('publish-package-stale');
  // Taken before the package commit, which refuses an analysis whose files
  // changed since: the folder recorded is the one that uploads (CAN-6943).
  let sourceFingerprint: string | undefined;
  if (installed !== null) {
    try {
      sourceFingerprint = await deps.fingerprintInstalledSkill(localId);
    } catch (error) {
      throw new CatalogHostRefusedError('publish-package-stale', error);
    }
  }

  let accountId: string;
  let detail: SharedSkillDetail;
  // The audience of the copy this writes: private for a new one.
  let writtenAudience: CloudCopyAudience = consentedAudience;
  try {
    // Every request below uses this one context, so an account switch
    // mid-publish cannot split the copy and its link across accounts.
    const credentials = await deps.credentials();
    accountId = credentials.accountId;
    // Nothing uploads for an account the person didn't choose.
    if (
      options.expectedAccountId !== undefined &&
      accountId !== options.expectedAccountId
    )
      throw new CatalogHostRefusedError('publish-account-mismatch');
    // Only an author link of this account is a copy to update.
    const link =
      skill.remote !== undefined && skill.remote.accountId === accountId
        ? skill.remote
        : undefined;
    // An update reaches whoever sees the linked copy now. That must be the
    // audience the consent dialog named; a copy shared more widely since
    // (or never shown) uploads nothing, and the dialog asks again.
    if (link !== undefined) {
      const now = await deps.linkedCopyAudience(
        link.remoteId,
        credentials.context,
      );
      if (now !== null && now !== consentedAudience)
        throw new CatalogHostRefusedError('publish-package-stale');
    }
    // Nothing uploads for an installed skill to a cloud that would ignore
    // the create's audience and relink an identical public skill.
    if (installed !== null) {
      try {
        await deps.assertCreateAudienceSupported(credentials.context);
      } catch (error) {
        throw error instanceof CanopyCloudClientError &&
          error.code === 'unsupported-capability'
          ? new CatalogHostRefusedError('publish-source-unsupported', error)
          : error;
      }
    }
    const committed = await deps.commitPackage(pkg, credentials.context);
    // A new copy is always private, including one replacing a linked copy
    // deleted in the cloud. An identical skill the account already shares
    // more widely is refused, never returned or relinked, and said as such
    // (CAN-7037).
    const create = async (): Promise<SharedSkillDetail> => {
      let created: SharedSkillDetail;
      try {
        created = await deps.createSharedSkill(
          {
            sourceSkillId: localId,
            rawSkill,
            shareScope: 'private',
            ...committed,
            expectedSourceSha256: checked,
            expectedAudience: 'private',
          },
          credentials.context,
          shareSource,
        );
      } catch (error) {
        throw error instanceof CanopyCloudClientError &&
          error.status === 409 &&
          error.serverCode === 'audience_changed'
          ? new CatalogHostRefusedError('publish-audience-wider', error)
          : error;
      }
      // A cloud that predates that precondition can still answer with an
      // identical row shared more widely: nothing is linked or consented.
      if (
        cloudCopyAudience({
          shareScope: created.shareScope,
          public: created.publicShare !== null,
        }) !== 'private'
      )
        throw new CatalogHostRefusedError('publish-audience-wider');
      writtenAudience = 'private';
      return created;
    };
    try {
      detail =
        link === undefined
          ? await create()
          : await deps.updateSharedSkill(
              {
                sourceSkillId: localId,
                skillId: link.remoteId,
                rawSkill,
                expectedContentHash: link.contentHash,
                ...committed,
                expectedSourceSha256: checked,
                // The cloud checks this as it writes, closing the gap
                // after the read above.
                expectedAudience: consentedAudience,
              },
              credentials.context,
              undefined,
              shareSource,
            );
    } catch (error) {
      // The linked copy was deleted in the cloud: start a new private one.
      if (
        link === undefined ||
        !(error instanceof CanopyCloudClientError && error.status === 404)
      )
        throw error;
      // A 404 after an account switch means "not this account's", not
      // "deleted": a new copy would fork the skill.
      if ((await deps.credentials()).accountId !== accountId) throw error;
      detail = await create();
    }
  } catch (error) {
    throw cloudRefusal(error);
  }
  // Creation is content-addressed and can return another publisher's row;
  // only a row this account can update is an author link.
  if (detail.canUpdate) {
    await deps.writeLink(localId, {
      accountId,
      remoteId: detail.id,
      contentHash: detail.contentHash,
      shareScope: detail.shareScope,
      sharedAt: detail.updatedAt,
    });
    await deps.writeConsent(localId, {
      accountId,
      remoteId: detail.id,
      // An installed-source copy is never kept in step: any change to the
      // skill asks again (CAN-6943), whatever the request said.
      keepInStep: installed === null && pkg.keepInStep,
      consentedAt: deps.now(),
      selectedOptionalResourceIds: [...pkg.selectedOptionalResourceIds],
      files: facts.files,
      withheld: facts.withheld,
      audience: writtenAudience,
      ...(sourceFingerprint === undefined ? {} : { sourceFingerprint }),
    });
  }
  return {
    publicationId: detail.id,
    remoteEntryId: skillEntryId({
      sourceId: CLOUD_CUSTOM_SKILL_SOURCE_ID,
      skillName: detail.id,
    }),
    revision: detail.contentHash,
  };
}

/** What removing a cloud copy calls; tests inject fakes. Defaults load lazily. */
export interface UnpublishSkillDeps {
  loadSkills: PublishSkillDeps['loadSkills'];
  /**
   * The signed-in account and its credentials, resolved once so every read
   * and the delete land in the same account; throws `missing-api-key` when
   * signed out.
   */
  credentials: PublishSkillDeps['credentials'];
  getSharedSkill: (
    skillId: string,
    context: CanopyCloudCredentialContext,
  ) => Promise<SharedSkillDetail>;
  deleteSharedSkill: (
    skillId: string,
    context: CanopyCloudCredentialContext,
  ) => Promise<void>;
  clearLink: (remoteId: string) => Promise<void>;
}

const defaultUnpublishDeps: UnpublishSkillDeps = {
  loadSkills: defaultDeps.loadSkills,
  credentials: defaultDeps.credentials,
  getSharedSkill: async (skillId, context) =>
    (await import('./canopy-server-client')).getSharedSkill(skillId, context),
  deleteSharedSkill: async (skillId, context) =>
    (await import('./canopy-server-client')).deleteSharedSkill(
      { skillId },
      context,
    ),
  // Consent first: if its write fails, the link stays and a retry can finish.
  clearLink: async (remoteId) => {
    consentStore().clearByRemoteId(remoteId);
    (await import('./skill-service')).clearSkillRemoteMetadataByRemoteId(
      remoteId,
    );
  },
};

const isCloudNotFound = (error: unknown): boolean =>
  error instanceof CanopyCloudClientError && error.status === 404;

/**
 * Removes the account's private cloud copy of a custom skill and its local
 * link (CAN-6176, D10). Only a copy linked from this desktop for the signed-in
 * account is removed; one shared with a team or an organization, or with a
 * public link, stays with the share dialog. A copy already gone only loses its link.
 */
export async function unpublishSkillFromCloud(
  publicationId: string,
  expectedRemoteVersion: string | null,
  deps: UnpublishSkillDeps = defaultUnpublishDeps,
): Promise<void> {
  let credentials: Awaited<ReturnType<UnpublishSkillDeps['credentials']>>;
  try {
    credentials = await deps.credentials();
  } catch (error) {
    throw cloudRefusal(error);
  }
  const { accountId, context } = credentials;
  const linked = (await deps.loadSkills()).some(
    (skill) =>
      skill.sourceId === CUSTOM_SOURCE_ID &&
      skill.remote?.remoteId === publicationId &&
      skill.remote.accountId === accountId,
  );
  if (!linked) throw new CatalogHostRefusedError('unpublish-not-found');
  const read = async (): Promise<SharedSkillDetail | null> => {
    try {
      return await deps.getSharedSkill(publicationId, context);
    } catch (error) {
      if (!isCloudNotFound(error)) throw cloudRefusal(error);
      return null;
    }
  };
  const assertRemovable = (current: SharedSkillDetail): void => {
    // A public link keeps the copy private, but deleting it would revoke a
    // URL the person published on purpose: that stays with the share dialog.
    if (
      current.shareScope !== 'private' ||
      !current.canDelete ||
      current.publicShare !== null
    )
      throw new CatalogHostRefusedError('unpublish-shared');
    if (
      expectedRemoteVersion !== null &&
      current.contentHash !== expectedRemoteVersion
    )
      throw new CatalogHostRefusedError('unpublish-version-moved');
  };
  const current = await read();
  if (current !== null) {
    assertRemovable(current);
    // The hosted delete is unconditional, so check again right before it:
    // a share or an edit since the first read keeps the copy (CAN-6337).
    const latest = await read();
    if (latest !== null) {
      assertRemovable(latest);
      try {
        await deps.deleteSharedSkill(publicationId, context);
      } catch (error) {
        if (!isCloudNotFound(error)) throw cloudRefusal(error);
      }
    }
  }
  await deps.clearLink(publicationId);
}

/** Why a turn went with the last published copy of a skill. */
export type StaleCloudCopyReason =
  /** The skill now needs consent it was not given: the dialog again. */
  | 'needs_consent'
  /** The cloud copy changed elsewhere since the last publish. */
  | 'changed_elsewhere'
  | 'failed'
  | 'timed_out';

export interface KeepInStepOutcome {
  republished: string[];
  usedLastCopy: { name: string; reason: StaleCloudCopyReason }[];
}

/** What keeping copies in step calls; tests inject fakes. Defaults load lazily. */
export interface KeepInStepDeps extends Pick<
  PublishSkillDeps,
  | 'loadSkills'
  | 'readRawSkill'
  | 'credentials'
  | 'analysisFacts'
  | 'commitPackage'
  | 'updateSharedSkill'
  | 'writeLink'
  | 'writeConsent'
  | 'linkedCopyAudience'
> {
  readConsent: (localId: string) => Promise<CloudCopyConsent | null>;
  /** Analyses the skill's current SKILL.md; returns the analysis id. */
  analyzeSkill: (input: AnalyzeSkillCapabilityPackageInput) => Promise<string>;
}

const defaultKeepInStepDeps: KeepInStepDeps = {
  ...defaultDeps,
  readConsent: (localId) => Promise.resolve(consentStore().get(localId)),
  analyzeSkill: async (input) =>
    (
      await (
        await import('../pipelines/pipeline-package-service')
      ).analyzeSkillCapabilityPackage(input)
    ).analysisId,
};

/** How long a send waits for its skills' republish before it goes anyway. */
export const KEEP_IN_STEP_TIMEOUT_MS = 8_000;

class StaleCopyStop extends Error {
  constructor(readonly reason: StaleCloudCopyReason) {
    super(reason);
  }
}

const within = (
  files: readonly string[],
  allowed: readonly string[],
): boolean => files.every((file) => allowed.includes(file));

async function republishOne(
  skill: InstalledSkillInfo,
  link: ShareRemoteMetadata,
  consent: CloudCopyConsent,
  rawSkill: string,
  context: CanopyCloudCredentialContext,
  deps: KeepInStepDeps,
  /** False once the send stopped waiting: no upload starts after that. */
  inTime: () => boolean,
): Promise<void> {
  const localId = `${CUSTOM_SOURCE_ID}/${skill.name}`;
  // A consent recorded before the audience gate never named one: ask again.
  const consentedAudience = consent.audience;
  if (consentedAudience === undefined) throw new StaleCopyStop('needs_consent');
  // As a cloud copy, so it withholds what the consent dialog's analysis did
  // and its files compare with the consented ones.
  const analysisId = await deps.analyzeSkill({
    sourceId: CUSTOM_SOURCE_ID,
    skillName: skill.name,
    rawSkill,
    cloudCopy: true,
  });
  const facts = await deps.analysisFacts(
    analysisId,
    consent.selectedOptionalResourceIds,
  );
  // Every stop comes before the package is committed, so nothing uploads.
  if (
    facts === null ||
    !facts.ready ||
    facts.contentHash !== sha256(rawSkill) ||
    !within(facts.withheld, consent.withheld) ||
    !within(facts.files, consent.files)
  )
    throw new StaleCopyStop('needs_consent');
  // The update reaches whoever sees the copy now, which must still be the
  // audience the person agreed to; a copy shared more widely since asks again.
  if (
    (await deps.linkedCopyAudience(link.remoteId, context)) !==
    consentedAudience
  )
    throw new StaleCopyStop('needs_consent');
  // Checked again right before each write inside the helpers, so slow work
  // there can't land a write after the send stopped waiting.
  const stillInTime = (): void => {
    if (!inTime()) throw new StaleCopyStop('timed_out');
  };
  stillInTime();
  let detail: SharedSkillDetail;
  try {
    const committed = await deps.commitPackage(
      {
        analysisId,
        selectedOptionalResourceIds: consent.selectedOptionalResourceIds,
        keepInStep: true,
      },
      context,
      stillInTime,
    );
    stillInTime();
    detail = await deps.updateSharedSkill(
      {
        sourceSkillId: localId,
        skillId: link.remoteId,
        rawSkill,
        expectedContentHash: link.contentHash,
        ...committed,
        expectedSourceSha256: sha256(rawSkill),
        // The cloud checks this as it writes, closing the gap after the read.
        expectedAudience: consentedAudience,
      },
      context,
      stillInTime,
    );
  } catch (error) {
    // A helper may wrap the stop in its own error.
    if (error instanceof StaleCopyStop || !inTime())
      throw new StaleCopyStop(
        error instanceof StaleCopyStop ? error.reason : 'timed_out',
      );
    throw new StaleCopyStop(
      // Edited again since this check: the next send checks it afresh.
      (error instanceof ShareOperationError &&
        error.kind === 'dependency-review') ||
        // Shared more widely between the read above and the write.
        (error instanceof CanopyCloudClientError &&
          error.status === 409 &&
          error.serverCode === 'audience_changed')
        ? 'needs_consent'
        : error instanceof CanopyCloudClientError && error.status === 409
          ? 'changed_elsewhere'
          : 'failed',
    );
  }
  await deps.writeLink(localId, {
    ...link,
    contentHash: detail.contentHash,
    sharedAt: detail.updatedAt,
  });
}

/**
 * Republishes the selected skills whose cloud copy fell behind their SKILL.md,
 * just before a cloud chat sends a turn (CAN-6176, D9 revised). Only skills
 * with "Keep the cloud copy up to date" on, linked for the signed-in account,
 * are republished, and only within the files the person consented to; any
 * other change needs the consent dialog again. A republish that fails or
 * outlasts `timeoutMs`, or runs past `deadlineAt`, leaves the turn on the
 * last published copy and is named in `usedLastCopy`, so the turn can say
 * so. Never throws.
 */
/**
 * A linked skill's consent and SKILL.md, or null when its cloud copy isn't
 * kept in step for this account. Throws when either can't be read.
 */
async function readForKeepInStep(
  name: string,
  remoteId: string,
  accountId: string,
  deps: KeepInStepDeps,
): Promise<{ consent: CloudCopyConsent; rawSkill: string } | null> {
  const consent = await deps.readConsent(`${CUSTOM_SOURCE_ID}/${name}`);
  if (
    consent === null ||
    !consent.keepInStep ||
    consent.remoteId !== remoteId ||
    consent.accountId !== accountId
  )
    return null;
  return {
    consent,
    rawSkill: await deps.readRawSkill(`${CUSTOM_SOURCE_ID}/${name}`),
  };
}

export async function keepCloudSkillsInStep(
  remoteIds: readonly string[],
  options: {
    timeoutMs?: number;
    /** Answer by then (epoch ms), whatever the reads before took. */
    deadlineAt?: number;
  } = {},
  deps: KeepInStepDeps = defaultKeepInStepDeps,
): Promise<KeepInStepOutcome> {
  const outcome: KeepInStepOutcome = { republished: [], usedLastCopy: [] };
  if (remoteIds.length === 0) return outcome;
  // The deadline runs from the start, so slow reads count against it too: a
  // skill not started by then is named as using its last published copy,
  // and its upload never starts after the send has gone.
  const timeoutMs = Math.min(
    options.timeoutMs ?? KEEP_IN_STEP_TIMEOUT_MS,
    options.deadlineAt === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(0, options.deadlineAt - Date.now()),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  const deadline = new Promise<'timed_out'>((resolve) => {
    timer = setTimeout(() => {
      expired = true;
      resolve('timed_out');
    }, timeoutMs);
  });
  const inTime = <T>(work: Promise<T>): Promise<{ value: T } | null> =>
    Promise.race([
      work.then((value) => ({ value })),
      deadline.then(() => null),
    ]);
  try {
    let credentials: Awaited<ReturnType<KeepInStepDeps['credentials']>>;
    try {
      // One account for every republish of this send, as for a publish.
      const read = await inTime(deps.credentials());
      if (read === null) return outcome;
      credentials = read.value;
    } catch {
      // Signed out: the cloud chat cannot send either; nothing to keep in step.
      return outcome;
    }
    const { accountId } = credentials;
    const loaded = await inTime(deps.loadSkills());
    if (loaded === null) return outcome;
    const linked = [...new Set(remoteIds)].flatMap((remoteId) => {
      const skill = loaded.value.find(
        (candidate) =>
          candidate.sourceId === CUSTOM_SOURCE_ID &&
          candidate.remote?.remoteId === remoteId &&
          candidate.remote.accountId === accountId,
      );
      const link = skill?.remote;
      return skill === undefined || link === undefined
        ? []
        : [{ remoteId, skill, link }];
    });
    const pending: { name: string; work: Promise<void> }[] = [];
    for (const { remoteId, skill, link } of linked) {
      if (expired) {
        outcome.usedLastCopy.push({ name: skill.name, reason: 'timed_out' });
        continue;
      }
      let prepared: { consent: CloudCopyConsent; rawSkill: string } | null;
      try {
        const read = await inTime(
          readForKeepInStep(skill.name, remoteId, accountId, deps),
        );
        if (read === null) {
          outcome.usedLastCopy.push({ name: skill.name, reason: 'timed_out' });
          continue;
        }
        prepared = read.value;
      } catch {
        // One unreadable skill is noted on its own; the others still go.
        outcome.usedLastCopy.push({ name: skill.name, reason: 'failed' });
        continue;
      }
      if (prepared === null || sha256(prepared.rawSkill) === link.contentHash)
        continue;
      pending.push({
        name: skill.name,
        work: republishOne(
          skill,
          link,
          prepared.consent,
          prepared.rawSkill,
          credentials.context,
          deps,
          () => !expired,
        ),
      });
    }
    const settled = await Promise.all(
      pending.map(({ name, work }) =>
        Promise.race([
          work.then(
            () => ({ name, result: 'republished' as const }),
            (error: unknown) => ({
              name,
              result:
                error instanceof StaleCopyStop
                  ? error.reason
                  : ('failed' as const),
            }),
          ),
          deadline.then((result) => ({ name, result })),
        ]),
      ),
    );
    for (const { name, result } of settled) {
      if (result === 'republished') outcome.republished.push(name);
      else outcome.usedLastCopy.push({ name, reason: result });
    }
  } finally {
    clearTimeout(timer);
  }
  return outcome;
}
