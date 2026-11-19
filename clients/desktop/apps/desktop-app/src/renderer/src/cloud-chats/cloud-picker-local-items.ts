import {
  CATALOG_HARNESS_IDS,
  CatalogSkillListResultSchema,
  CatalogSnapshotGetResultSchema,
  CatalogSourceListResultSchema,
  type CatalogEntry,
  type CatalogHarnessId,
} from '@canopy/protocol/canopy-core';
import {
  cloudCapabilityRows,
  needsCloudUpload,
  type CloudCapabilityUploadRow,
} from '@canopy/app-state/core-cowork';
import type { RemoteControlPluginsLocalItem } from '@canopy/ui-app';
import type { RemoteControlChatTabPluginSelections } from '@canopy/protocol/remote-control/shell';

/** This computer's skills and plugins, from the desktop core (CAN-6176). */
export interface LocalCatalog {
  readonly entries: readonly CatalogEntry[];
  readonly skills: Parameters<typeof cloudCapabilityRows>[0]['localSkills'];
  /** The built-in and curated marketplaces, whose plugins are never copied. */
  readonly bundledMarketplaceIds: ReadonlySet<string>;
}

async function request(
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const reply = await window.canopyCore.invoke({
    kind: 'request',
    method,
    params,
  });
  if (!reply.ok) throw new Error(reply.error.message);
  return reply.value;
}

/** Reads this computer's skills, each one's cloud link, and its plugins. */
export async function readLocalCatalog(): Promise<LocalCatalog> {
  const [snapshot, skills, sources] = await Promise.all([
    request('core.catalog.snapshot.get', {
      scope: {},
      kinds: ['skill', 'plugin'],
      includeUnavailable: true,
    }),
    request('core.catalog.skill.list', {}),
    request('core.catalog.source.list', {}),
  ]);
  return {
    entries: CatalogSnapshotGetResultSchema.parse(snapshot).entries,
    skills: CatalogSkillListResultSchema.parse(skills).skills,
    bundledMarketplaceIds: new Set(
      CatalogSourceListResultSchema.parse(sources)
        .sources.filter(
          (source) =>
            source.locator.kind === 'builtin' ||
            source.locator.kind === 'curated',
        )
        .map((source) => source.sourceId),
    ),
  };
}

const harnessOf = (value: string | undefined): CatalogHarnessId =>
  CATALOG_HARNESS_IDS.find((id) => id === value) ?? 'claude';

/**
 * The skills main's cloud-copy analyser takes: this computer's custom ones,
 * and with CAN-6943's flag on, ones installed from GitHub, a URL or a local
 * folder. Main checks each again; a marketplace plugin's skill is never one.
 */
const COPYABLE_SKILL_PREFIX = 'skill:custom:app/';
const INSTALLED_SKILL_PREFIXES: readonly string[] = [
  'skill:github:',
  'skill:url:',
  'skill:local:',
];

/** A skill installed from GitHub, a URL or a local folder (CAN-6943). */
export function isInstalledSourceSkill(entryId: string): boolean {
  return INSTALLED_SKILL_PREFIXES.some((prefix) => entryId.startsWith(prefix));
}

/**
 * The custom skills and the plugins on this computer the chat's cloud account
 * lacks, or has an older copy of: the rows the picker offers to add. With
 * `installedSkills` (CAN-6943's flag), skills installed from GitHub, a URL or
 * a local folder too. Only an
 * entry id leaves the renderer; main reads the files, as the consent dialog
 * shows.
 *
 * A plugin is offered only when the cloud snapshot marks the plugins this
 * desktop uploaded (`thisDesktopUploads`, CAN-6725): its cloud copy has
 * another entry id, so without the mark a copied plugin would read as never
 * copied and be offered again.
 */
export function localUploadRows(
  local: LocalCatalog,
  cloud: readonly CatalogEntry[],
  harness: string | undefined,
  thisDesktopUploads: boolean,
  installedSkills: boolean,
): CloudCapabilityUploadRow[] {
  return cloudCapabilityRows({
    local: local.entries,
    localSkills: local.skills,
    cloud,
    harness: harnessOf(harness),
    thisDesktopUploads,
    bundledMarketplaceIds: local.bundledMarketplaceIds,
  })
    .filter(needsCloudUpload)
    .filter((row) =>
      row.state.action === 'publish_plugin'
        ? thisDesktopUploads && row.localEntry.kind === 'plugin'
        : row.state.action === 'publish_skill' &&
          (row.localEntry.entryId.startsWith(COPYABLE_SKILL_PREFIX) ||
            (installedSkills &&
              isInstalledSourceSkill(row.localEntry.entryId))),
    );
}

export function localPickerItem(
  row: CloudCapabilityUploadRow,
): RemoteControlPluginsLocalItem {
  return {
    key: row.localEntry.entryId,
    name: row.name,
    kind: row.state.action === 'publish_plugin' ? 'plugin' : 'skill',
    replacing: row.state.reason === 'changed',
  };
}

/** What to select for a cloud entry: its own selection ref, or nothing. */
export function selectionForCloudEntry(
  cloud: readonly CatalogEntry[],
  cloudEntryId: string,
): Pick<
  RemoteControlChatTabPluginSelections,
  'skillRefs' | 'pluginRefs'
> | null {
  const entry = cloud.find((candidate) => candidate.entryId === cloudEntryId);
  if (entry === undefined) return null;
  const content = entry.content;
  if (content.kind === 'skill' && content.selectionRef !== undefined)
    return { skillRefs: [content.selectionRef], pluginRefs: [] };
  if (content.kind === 'plugin' && content.selectionRef !== undefined)
    return { skillRefs: [], pluginRefs: [content.selectionRef] };
  return null;
}
