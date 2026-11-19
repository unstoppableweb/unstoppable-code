import {
  officialMarketplaceProvider,
  type UnifiedEntryAlternative,
  type UnifiedEntryHarnessRow,
  type UnifiedPluginEntry,
} from './unified-plugin-entry';

/**
 * New Customize's one reading of where a plugin runs (Sergii's QA): a tile's
 * harness chips and its page's Works with table both come from
 * `customizeHarnessRows`, so they list the same harnesses, in the same
 * order, with the same state.
 *
 * - `own`: this copy runs there.
 * - `copy`: this copy doesn't, but a matching copy found elsewhere does.
 * - `none`: no copy runs there.
 */
export type CustomizeHarnessSupport = 'own' | 'copy' | 'none';

export interface CustomizeHarnessCopy {
  readonly entryId: string;
  /** "Slack (slackapi)", for a table row. */
  readonly name: string;
  /** Where the copy comes from: its marketplace or catalog. */
  readonly source?: string;
  /** The copy's own name and publisher, for a tooltip. */
  readonly base: { readonly name: string; readonly publisher?: string };
}

export interface CustomizeHarnessRow extends UnifiedEntryHarnessRow {
  readonly support: CustomizeHarnessSupport;
  /** The copy that serves this harness, when `support` is `copy`. */
  readonly copy?: CustomizeHarnessCopy;
  /** Says where the support comes from, in plain words. */
  readonly tooltip: string;
}

function copyOf(alternative: UnifiedEntryAlternative): CustomizeHarnessCopy {
  return {
    entryId: alternative.entryId,
    name: alternative.copyName ?? alternative.label,
    ...(alternative.copyName ? { source: alternative.label } : {}),
    base: alternative.copyBase ?? { name: alternative.label },
  };
}

function tooltip(
  name: string,
  support: CustomizeHarnessSupport,
  installed: boolean,
  copy: CustomizeHarnessCopy | undefined,
): string {
  // Short on purpose: a tooltip line, not a sentence.
  if (support === 'own')
    return installed ? `${name}: installed` : `${name}: works natively`;
  if (support === 'copy' && copy !== undefined) {
    const version = copy.source ?? copy.name;
    return installed
      ? `${name}: installed from ${version}`
      : `${name}: uses the ${version} version`;
  }
  return `${name}: not supported`;
}

function isOfficialCopy(alternative: UnifiedEntryAlternative): boolean {
  return (
    alternative.ref.type === 'marketplace-plugin' &&
    officialMarketplaceProvider(alternative.ref.marketplaceId) !== undefined
  );
}

/**
 * The rows for one plugin: its own harness rows, with a harness it can't
 * serve taken by a matching copy that can (an installed one first, then one
 * the item's one Add brings along), and a harness it serves but isn't
 * installed for taken by a matching copy that is installed.
 */
export function customizeHarnessRows(
  own: readonly UnifiedEntryHarnessRow[],
  alternatives: readonly UnifiedEntryAlternative[] = [],
): CustomizeHarnessRow[] {
  // Only a verified copy of the same integration (a provider's official
  // listing or the same author, `addedWithItem`) serves a harness; a plugin
  // that only shares the name stays under Other versions.
  const copies = alternatives.filter(
    (alternative) => alternative.addedWithItem === true,
  );
  return own.map((row): CustomizeHarnessRow => {
    // This copy serves the harness: its own row, unless it isn't installed
    // and a matching copy that is installed already serves it.
    const installedCopy =
      row.installation === 'Not installed'
        ? copies.find(
            (alternative) =>
              alternative.harnessRows?.find(
                (candidate) => candidate.id === row.id,
              )?.installation === 'Installed',
          )
        : undefined;
    if (installedCopy !== undefined) {
      const copy = copyOf(installedCopy);
      return {
        id: row.id,
        name: row.name,
        installation: 'Installed',
        support: 'copy',
        copy,
        tooltip: tooltip(row.name, 'copy', true, copy),
      };
    }
    // Unknown (nothing read the plugin's files yet) looks for a copy that
    // serves the harness, as Not supported does.
    if (
      row.installation !== 'Not supported' &&
      row.installation !== 'Unknown until added' &&
      row.installation !== 'Checking…'
    )
      return {
        ...row,
        support: 'own',
        tooltip: tooltip(
          row.name,
          'own',
          row.installation === 'Installed',
          undefined,
        ),
      };
    const serving = copies.flatMap((alternative) => {
      const theirs = alternative.harnessRows?.find(
        (candidate) => candidate.id === row.id,
      );
      // Only a copy known to serve it: unknown is not support. An unread
      // listing's unknown harness fills only from an installed copy (spec
      // 3b), never another uninstalled listing.
      return theirs !== undefined &&
        theirs.installation !== 'Not supported' &&
        theirs.installation !== 'Unknown until added' &&
        (row.installation !== 'Unknown until added' ||
          theirs.installation === 'Installed')
        ? [{ alternative, installed: theirs.installation === 'Installed' }]
        : [];
    });
    // An installed copy first; then official listings first, as the desktop
    // picks the copy its Add installs.
    const best =
      serving.find((candidate) => candidate.installed) ??
      serving.find(({ alternative }) => isOfficialCopy(alternative)) ??
      serving[0];
    if (best === undefined)
      return {
        ...row,
        support: 'none',
        // Unknown is not unsupported: the tooltip says which it is.
        tooltip:
          row.installation === 'Unknown until added'
            ? `${row.name}: unknown until added`
            : tooltip(row.name, 'none', false, undefined),
      };
    const copy = copyOf(best.alternative);
    return {
      id: row.id,
      name: row.name,
      installation: best.installed ? 'Installed' : 'Not installed',
      support: 'copy',
      copy,
      tooltip: tooltip(row.name, 'copy', best.installed, copy),
    };
  });
}

/** A tile's rows: the entry's own harness rows and its copies elsewhere. */
export function customizeEntryHarnessRows(
  entry: Pick<UnifiedPluginEntry, 'harnessRows' | 'alsoAvailableFrom'>,
): CustomizeHarnessRow[] | undefined {
  return entry.harnessRows
    ? customizeHarnessRows(entry.harnessRows, entry.alsoAvailableFrom)
    : undefined;
}
