import { pluginEntryId } from '@canopy/protocol/canopy-core';
import type { PipelinePackageAnalysisSummary } from '@canopy/protocol/pipelines';
import type { InstalledSkillInfo } from '@canopy/protocol/skills';
import type {
  CloudCopyAnalyzeResult,
  CloudCopyAudience,
} from '@canopy/desktop-shared/types';
import type { ShareRemoteMetadata } from '@canopy/protocol/sharing';
import { cloudCopyAudience, readLinkedCopyAudience } from './audience';
import { CUSTOM_SOURCE_ID } from '../skills/paths';

/** What a cloud-copy analysis calls; tests inject fakes. Defaults load lazily. */
export interface AnalyzeForCloudCopyDeps {
  /** The installed skills, each with its author-side link. */
  loadSkills: () => Promise<readonly InstalledSkillInfo[]>;
  /**
   * Who sees the account's linked copy now, read from the cloud as the
   * publish reads it; null when it's gone. Throws when it can't be read.
   */
  linkedCopyAudience: (
    skillId: string,
    accountId: string,
  ) => Promise<CloudCopyAudience | null>;
  readRawSkill: (localId: string) => Promise<string>;
  analyzeSkill: (request: {
    sourceId: string;
    skillName: string;
    rawSkill: string;
  }) => Promise<PipelinePackageAnalysisSummary>;
  /** The installed marketplaces, each with its plugins' names. */
  marketplaces: () => Promise<
    readonly {
      id: string;
      builtIn?: boolean;
      curated?: boolean;
      plugins: readonly { name: string }[];
    }[]
  >;
  analyzePlugin: (request: {
    marketplaceId: string;
    pluginName: string;
  }) => Promise<PipelinePackageAnalysisSummary>;
}

const defaultDeps: AnalyzeForCloudCopyDeps = {
  loadSkills: async () => {
    const { loadSkills } = await import('../skills/skill-service');
    const loaded = loadSkills();
    return loaded.success && loaded.data ? loaded.data : [];
  },
  linkedCopyAudience: async (skillId, accountId) => {
    const { resolveCanopyCloudCredentialContext } =
      await import('../canopy-cloud/client');
    const context = await resolveCanopyCloudCredentialContext();
    if (!context.apiKey || context.account?.id.trim() !== accountId)
      throw new Error('The cloud account changed.');
    return readLinkedCopyAudience(skillId, context);
  },
  readRawSkill: async (localId) =>
    (await import('../skills/skill-service')).readRawSkill(localId),
  analyzeSkill: async (request) =>
    (
      await import('../pipelines/pipeline-package-service')
    ).analyzeSkillCapabilityPackage(
      { ...request, cloudCopy: true },
      { persistDismissals: false },
    ),
  marketplaces: async () => {
    const cache = await (
      await import('../plugins/plugin-service')
    ).loadMarketplacesCacheOnly();
    return cache.success ? (cache.data?.marketplaces ?? []) : [];
  },
  analyzePlugin: async (request) =>
    (
      await import('../pipelines/pipeline-package-service')
    ).analyzePluginForCloudCopy(request),
};

/**
 * The audience the dialog shows for a skill's linked copy: read live, as the
 * publish checks it, since the local link file records neither a public link
 * nor a scope changed on the web. A copy that's gone gets a new private one.
 * If the cloud can't be read, the local link's scope stands, and the publish
 * checks again before anything uploads.
 */
async function linkedAudience(
  linked: ShareRemoteMetadata | undefined,
  accountId: string,
  deps: AnalyzeForCloudCopyDeps,
): Promise<CloudCopyAudience> {
  if (linked === undefined) return 'private';
  try {
    return (
      (await deps.linkedCopyAudience(linked.remoteId, accountId)) ?? 'private'
    );
  } catch {
    return cloudCopyAudience({
      shareScope: linked.shareScope,
      public: linked.publicLink !== undefined,
    });
  }
}

const CUSTOM_SKILL_PREFIX = `skill:${CUSTOM_SOURCE_ID}/`;

/**
 * The cloud-copy analysis of a desktop catalog entry (CAN-6176 9c): a custom
 * skill, over its SKILL.md as main reads it, or an installed plugin that
 * isn't built in or curated. The renderer names the entry only; main finds
 * its files. Anything else is `unsupported`. A skill linked to a copy the
 * account already shares reports that copy's audience, since "Add to cloud"
 * updates it in place; a plugin goes to the account's private marketplace.
 */
export async function analyzeForCloudCopy(
  entryId: string,
  accountId: string,
  deps: AnalyzeForCloudCopyDeps = defaultDeps,
): Promise<CloudCopyAnalyzeResult> {
  if (entryId.startsWith(CUSTOM_SKILL_PREFIX)) {
    const skillName = entryId.slice(CUSTOM_SKILL_PREFIX.length);
    if (skillName === '' || skillName.includes('/'))
      return { ok: false, reason: 'not-found' };
    let rawSkill: string;
    try {
      rawSkill = await deps.readRawSkill(`${CUSTOM_SOURCE_ID}/${skillName}`);
    } catch {
      return { ok: false, reason: 'not-found' };
    }
    const remote = (await deps.loadSkills()).find(
      (skill) =>
        skill.sourceId === CUSTOM_SOURCE_ID && skill.name === skillName,
    )?.remote;
    return {
      ok: true,
      analysis: await deps.analyzeSkill({
        sourceId: CUSTOM_SOURCE_ID,
        skillName,
        rawSkill,
      }),
      audience: await linkedAudience(
        remote?.accountId === accountId ? remote : undefined,
        accountId,
        deps,
      ),
    };
  }
  if (!entryId.startsWith('plugin:'))
    return { ok: false, reason: 'unsupported' };
  for (const marketplace of await deps.marketplaces()) {
    const prefix = pluginEntryId({
      marketplaceId: marketplace.id,
      pluginName: '',
    });
    if (!entryId.startsWith(prefix)) continue;
    const pluginName = entryId.slice(prefix.length);
    if (!marketplace.plugins.some((plugin) => plugin.name === pluginName))
      continue;
    // A built-in or curated plugin is already in the cloud catalog.
    if (marketplace.builtIn === true || marketplace.curated === true)
      return { ok: false, reason: 'unsupported' };
    return {
      ok: true,
      analysis: await deps.analyzePlugin({
        marketplaceId: marketplace.id,
        pluginName,
      }),
      audience: 'private',
    };
  }
  return { ok: false, reason: 'not-found' };
}
