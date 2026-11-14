import {
  CATALOG_HARNESS_IDS,
  CatalogSkillListResultSchema,
  CatalogSnapshotGetResultSchema,
  type CatalogEntry,
  type CatalogHarnessId,
} from '@canopy/protocol/canopy-core';
import {
  cloudCapabilityRows,
  needsCloudUpload,
  type CloudCapabilityUploadRow,
} from '@canopy/app-state/core-cowork';
import type { PortalPluginsLocalItem } from '@canopy/ui-app';
import type { PortalChatTabPluginSelections } from '@canopy/protocol/portal';

/** This computer's skills, from the desktop core (CAN-6176). */
export interface LocalCatalog {
  readonly entries: readonly CatalogEntry[];
  readonly skills: Parameters<typeof cloudCapabilityRows>[0]['localSkills'];
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

/** Reads this computer's skills and each one's cloud link. */
export async function readLocalCatalog(): Promise<LocalCatalog> {
  const [snapshot, skills] = await Promise.all([
    request('core.catalog.snapshot.get', {
      scope: {},
      kinds: ['skill'],
      includeUnavailable: true,
    }),
    request('core.catalog.skill.list', {}),
  ]);
  return {
    entries: CatalogSnapshotGetResultSchema.parse(snapshot).entries,
    skills: CatalogSkillListResultSchema.parse(skills).skills,
  };
}

const harnessOf = (value: string | undefined): CatalogHarnessId =>
  CATALOG_HARNESS_IDS.find((id) => id === value) ?? 'claude';

/**
 * The skills main's cloud-copy analyser takes: this computer's custom ones.
 * An installed skill from a source (GitHub, a marketplace) can't be copied.
 */
const COPYABLE_SKILL_PREFIX = 'skill:custom:app/';

/**
 * The custom skills on this computer the chat's cloud account lacks, or has
 * an older copy of: the rows the picker offers to add. Only an entry id
 * leaves the renderer; main reads the files, as the consent dialog shows.
 */
export function localUploadRows(
  local: LocalCatalog,
  cloud: readonly CatalogEntry[],
  harness: string | undefined,
): CloudCapabilityUploadRow[] {
  return (
    cloudCapabilityRows({
      local: local.entries,
      localSkills: local.skills,
      cloud,
      harness: harnessOf(harness),
    })
      .filter(needsCloudUpload)
      // Plugins aren't offered here yet: a local plugin and its cloud copy
      // have different entry ids, and nothing records which is which, so a
      // copied plugin would read as never copied and be offered again.
      .filter(
        (row) =>
          row.state.action === 'publish_skill' &&
          row.localEntry.entryId.startsWith(COPYABLE_SKILL_PREFIX),
      )
  );
}

export function localPickerItem(
  row: CloudCapabilityUploadRow,
): PortalPluginsLocalItem {
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
): Pick<PortalChatTabPluginSelections, 'skillRefs' | 'pluginRefs'> | null {
  const entry = cloud.find((candidate) => candidate.entryId === cloudEntryId);
  if (entry === undefined) return null;
  const content = entry.content;
  if (content.kind === 'skill' && content.selectionRef !== undefined)
    return { skillRefs: [content.selectionRef], pluginRefs: [] };
  if (content.kind === 'plugin' && content.selectionRef !== undefined)
    return { skillRefs: [], pluginRefs: [content.selectionRef] };
  return null;
}
