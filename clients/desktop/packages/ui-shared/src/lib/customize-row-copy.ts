import type { InstalledItemUninstallTarget } from '@canopy/protocol/installed-items';
import type { UnifiedEntryRef } from '@canopy/protocol/unified-entry';
import { displayVersion } from './display-version';
import { formatDateOrEmpty } from './format-date';
import { marketplaceCardSubtitle } from './marketplace-card-subtitle';
import { shareAudienceLabelText } from './share-audience-label';
import {
  SHARED_BY_YOU_PUBLIC_LINK_LABEL,
  sharedByYouSinceLabel,
} from './shared-by-you';
import type {
  UnifiedEntryPluginLink,
  UnifiedPluginEntry,
} from './unified-plugin-entry';

/** The verb a Customize row's destructive menu item and confirmation use. */
export type RemovalVerb = 'Uninstall' | 'Remove' | 'Delete';

/** Why Edit is disabled on a custom skill where the host has no editor. */
export const CUSTOM_SKILL_EDIT_UNAVAILABLE_REASON =
  'Edit this skill in the desktop app.';

/** Under Installed when a listed skill came with a plugin (CAN-4844). */
export const BUNDLED_SKILL_FOOTNOTE =
  "A skill that comes with a plugin follows that plugin's status.";

/**
 * A skill an installed plugin bundles. It has no status, update or removal
 * of its own and follows its plugin (CAN-4844).
 */
export function isBundledSkill(
  entry: UnifiedPluginEntry,
): entry is UnifiedPluginEntry & { bundledBy: UnifiedEntryPluginLink } {
  return (
    entry.kind === 'skill' &&
    entry.ref.type === 'plugin-skill' &&
    entry.bundledBy !== undefined
  );
}

/** A search result that links to the plugin bundling an unlisted MCP server. */
export function isPluginServerResult(
  entry: UnifiedPluginEntry,
): entry is UnifiedPluginEntry & { bundledBy: UnifiedEntryPluginLink } {
  return entry.pluginServerResult === true && entry.bundledBy !== undefined;
}

/** The plugin an MCP row or catalog card came with, when one did. */
export function mcpEntryPluginLink(
  entry: UnifiedPluginEntry,
): UnifiedEntryPluginLink | undefined {
  return entry.kind === 'app'
    ? (entry.bundledBy ?? entry.installedVia)
    : undefined;
}

/** Why a bundled skill's inherited status cannot be changed on its row. */
export function bundledSkillStatusReason(pluginName: string): string {
  return `Set by the ${pluginName} plugin. Change it on the plugin.`;
}

/** Whether the viewer made this item, so it reads `Created by you`. */
export function createdByViewer(entry: UnifiedPluginEntry): boolean {
  if (entry.kind === 'collection' && entry.ref.type === 'local-collection') {
    if (entry.sharedSource || entry.collectionProvenanceUnknown)
      return entry.ownedByViewer === true;
    return entry.ownedByViewer !== false;
  }
  if (entry.custom === true || entry.ownedByViewer === true) return true;
  return refCreatedByViewer(entry.ref, entry.origin);
}

function refCreatedByViewer(
  ref: UnifiedEntryRef,
  origin: UnifiedPluginEntry['origin'],
): boolean {
  switch (ref.type) {
    case 'local-collection':
    case 'local-agent':
      return true;
    case 'automation':
      return origin === 'custom';
    case 'public-share':
    case 'curated-plugin':
    case 'curated-pipeline':
    case 'marketplace-plugin':
    case 'plugin-skill':
    case 'curated-mcp':
    case 'local-mcp':
    case 'mcp-server':
    case 'skill':
    case 'shared-skill':
    case 'pipeline':
    case 'shared-collection':
    case 'shared-agent':
    case 'shared-plugin':
    case 'shared-blueprint':
    case 'shared-automation':
    case 'curated-automation':
    case 'provider-connector':
      return false;
    default: {
      const unhandled: never = ref;
      return unhandled;
    }
  }
}

const CREATED_BY_YOU = 'Created by you';

/** A dated source line, split so the row keeps the date whole (CAN-4844). */
export interface CustomizeRowEditedLine {
  /** `Created by you ·`, which truncates first. */
  readonly lead: string;
  /** `Edited {date}`, which keeps its full width. */
  readonly edited: string;
}

/**
 * The source line of an item the viewer created and has an edit date for;
 * `customizeRowSourceLine` joins the same parts with a space.
 */
export function customizeRowEditedLine(
  entry: UnifiedPluginEntry,
): CustomizeRowEditedLine | undefined {
  if (entry.bundledBy || entry.installedFrom || !createdByViewer(entry))
    return undefined;
  const edited = formatDateOrEmpty(entry.editedAt);
  return edited
    ? { lead: `${CREATED_BY_YOU} ·`, edited: `Edited ${edited}` }
    : undefined;
}

/**
 * Where a Customize Installed row's item came from, in plain words. The
 * bundling plugin wins, then the share a copy's install receipt names, then
 * the viewer's own items, then the sharer, then the catalog it was installed
 * from. Absent when there is no source worth naming;
 * `customizeRowSecondLine` then shows the description.
 */
export function customizeRowSourceLine(
  entry: UnifiedPluginEntry,
): string | undefined {
  if (entry.kind === 'collection' && entry.ref.type === 'local-collection') {
    if (createdByViewer(entry)) return 'Created by you';
    const sharer = entry.sharedSource?.sharedBy?.trim();
    return sharer ? `Shared by ${sharer}` : 'Shared with you';
  }
  if (entry.bundledBy) return `From the ${entry.bundledBy.name} plugin`;
  if (entry.installedFrom) {
    // A copy installed from a share reads as the share, not as the viewer's.
    const sharer = trimmed(entry.installedFrom.sharedByName);
    const owner = trimmed(entry.installedFrom.ownerName);
    const shared = sharer ? `Shared by ${sharer}` : 'Shared';
    return owner ? `${shared} · ${owner}` : shared;
  }
  if (createdByViewer(entry)) {
    const dated = customizeRowEditedLine(entry);
    return dated ? `${dated.lead} ${dated.edited}` : CREATED_BY_YOU;
  }
  if (entry.origin === 'shared') {
    const author = entry.authorName?.trim();
    return author ? `Shared by ${author}` : 'Shared';
  }
  return catalogSourceLine(entry);
}

/**
 * The catalog source as user-facing copy. Internal labels such as `Curated`
 * and `Local` never reach the row (CAN-4840).
 */
function catalogSourceLine(entry: UnifiedPluginEntry): string | undefined {
  switch (entry.origin) {
    case 'built-in':
      return 'Built-in';
    case 'project':
      return 'From project';
    case 'curated':
      // MCP server rows name no catalog source (CAN-3653).
      return entry.kind === 'app' ? undefined : 'From the curated catalog';
    case 'marketplace':
      return trimmed(entry.sourceLabel);
    case 'installed-standalone':
      return standaloneSourceLine(entry);
    case 'custom':
      return CREATED_BY_YOU;
    case 'shared':
      return undefined;
    default: {
      const unhandled: never = entry.origin;
      return unhandled;
    }
  }
}

/**
 * A built-in item reads `Built-in`; a skill from a GitHub skills source
 * names that source (`GitHub · acme/skills`). A server or skill added on
 * this machine has no catalog to name.
 */
function standaloneSourceLine(entry: UnifiedPluginEntry): string | undefined {
  if (entry.builtIn === true) return 'Built-in';
  if (entry.ref.type === 'skill' && entry.ref.sourceId.startsWith('github:')) {
    const owner = trimmed(entry.ownershipLabel);
    return owner ? `GitHub · ${owner}` : 'GitHub';
  }
  return undefined;
}

function trimmed(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text ? text : undefined;
}

/**
 * The second line of a Customize Installed or Updates row: its source, or
 * its description when no source is worth naming, so a row is never blank
 * when it has something to say.
 */
export function customizeRowSecondLine(
  entry: UnifiedPluginEntry,
): string | undefined {
  const source = customizeRowSourceLine(entry);
  if (source !== undefined) return source;
  return entry.description
    ? trimmed(marketplaceCardSubtitle(entry.name, entry.description))
    : undefined;
}

export function pendingSignInLabel(count: number): string {
  return count === 1 ? '1 sign-in pending' : `${count} sign-ins pending`;
}

/**
 * Delete for what the viewer made and for a device MCP server, as its detail
 * page says; Remove for other apps and others' collections; Uninstall for
 * plugins and installed skills.
 */
export function removalVerb(
  entry: UnifiedPluginEntry,
  target?: InstalledItemUninstallTarget,
): RemovalVerb {
  if (target?.kind === 'mcp-server') return 'Delete';
  if (entry.kind === 'collection')
    return createdByViewer(entry) ? 'Delete' : 'Remove';
  if (
    entry.custom === true ||
    entry.ref.type === 'local-collection' ||
    entry.ref.type === 'local-agent'
  ) {
    return 'Delete';
  }
  switch (entry.kind) {
    case 'app':
      return 'Remove';
    case 'plugin':
    case 'skill':
    case 'pipeline':
    case 'automation':
    case 'blueprint':
    case 'agent':
      return 'Uninstall';
    default: {
      const unhandled: never = entry.kind;
      return unhandled;
    }
  }
}

export function removalMenuLabel(
  entry: UnifiedPluginEntry,
  target?: InstalledItemUninstallTarget,
): string {
  return `${removalVerb(entry, target)}…`;
}

export function removalConfirmTitle(
  entry: UnifiedPluginEntry,
  target?: InstalledItemUninstallTarget,
): string {
  return `${removalVerb(entry, target)} ${entry.name}?`;
}

export function removalBusyLabel(verb: RemovalVerb): string {
  switch (verb) {
    case 'Uninstall':
      return 'Uninstalling…';
    case 'Remove':
      return 'Removing…';
    case 'Delete':
      return 'Deleting…';
    default: {
      const unhandled: never = verb;
      return unhandled;
    }
  }
}

export function removalFallbackError(verb: RemovalVerb): string {
  return `Could not ${verb.toLowerCase()}. Try again.`;
}

/** `Update to v1.3.0` when the version is known, otherwise `Update`. */
export function updateMenuLabel(latestVersion: string | undefined): string {
  const latest = displayVersion(latestVersion);
  return latest ? `Update to ${latest}` : 'Update';
}

/**
 * The parts of a Shared by me row's second line, kept apart so the row can
 * drop the date before it truncates the audience and keep the badge whole.
 */
export interface CustomizeSharedByMeLine {
  /** The team or organization name, else `Team`, `Organization` or `Personal`. */
  readonly audience?: string;
  /** When the item was shared with that audience, e.g. `Since Oct 12`. */
  readonly since?: string;
  /** A public link exists, even one that serves an older copy. */
  readonly publicLink: boolean;
  /** `Public link · Since Sep 26` when the link's date is known. */
  readonly publicLinkTitle?: string;
}

/**
 * The second line of a Shared by me row: who it is shared with, whether it
 * has a public link, and since when it is shared. A named audience omits
 * its kind. Undefined when there is nothing to say.
 */
export function sharedByMeLine(
  entry: UnifiedPluginEntry,
): CustomizeSharedByMeLine | undefined {
  const sharedWith = entry.sharedWith;
  const audience = sharedWith
    ? (trimmed(sharedWith.name) ??
      shareAudienceLabelText(
        sharedWith.audience,
        undefined,
        sharedWith.personal,
      ))
    : undefined;
  const since = sinceLabel(entry.sharedSince);
  const publicShare = entry.publicShare;
  if (audience === undefined && since === undefined && !publicShare)
    return undefined;
  const linkSince = sinceLabel(publicShare?.since);
  return {
    ...(audience !== undefined ? { audience } : {}),
    ...(since !== undefined ? { since } : {}),
    publicLink: publicShare !== undefined,
    ...(publicShare && linkSince !== undefined
      ? { publicLinkTitle: `${SHARED_BY_YOU_PUBLIC_LINK_LABEL} · ${linkSince}` }
      : {}),
  };
}

/** The detail card's `Since Oct 12`, or undefined for a missing or bad date. */
function sinceLabel(iso: string | undefined): string | undefined {
  return iso && Number.isFinite(Date.parse(iso))
    ? sharedByYouSinceLabel(iso)
    : undefined;
}
