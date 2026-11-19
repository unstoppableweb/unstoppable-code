import type { JSX } from 'react';
import { BADGE_ICON_BY_SIZE, badgeClassName } from '../lib/badge';
import {
  CUSTOMIZE_DISCOVERY_HARNESS_OPTIONS,
  customizeWorksWithChipLabel,
  customizeWorksWithChips,
  customizeWorksWithHarnesses,
  type CustomizeDiscoveryHarness,
} from '../lib/customize-discovery';
import {
  customizeEntryHarnessRows,
  type CustomizeHarnessRow,
} from '../lib/customize-harness-rows';
import type { UnifiedPluginEntry } from '../lib/unified-plugin-entry';
import { GitHubIcon } from '../icons/AppIcons';
import { ClaudeLogo } from '../icons/ClaudeLogo';
import { CodexLogo } from '../icons/CodexLogo';
import { CursorLogo } from '../icons/CursorLogo';
import { OpenCodeLogo } from '../icons/OpenCodeLogo';
import { Tooltip } from './Tooltip';
import {
  PluginWorksWith,
  type PluginWorksWithRow,
} from './PluginHarnessConnections';

/** The most badges a tile shows; a third harness folds into a "+N" badge. */
const MAX_CHIP_BADGES = 2;

/** A harness's short name; the Works with filter keeps the full names. */
const CHIP_NAMES: Readonly<Record<CustomizeDiscoveryHarness, string>> = {
  claude: 'Claude',
  codex: 'Codex',
  cursor: 'Cursor',
  copilot: 'Copilot',
  opencode: 'OpenCode',
};

function harnessFullName(harness: CustomizeDiscoveryHarness): string {
  return (
    CUSTOMIZE_DISCOVERY_HARNESS_OPTIONS.find(
      (option) => option.value === harness,
    )?.label ?? CHIP_NAMES[harness]
  );
}

/** "Claude Code, Codex and Cursor". */
function nameList(harnesses: readonly CustomizeDiscoveryHarness[]): string {
  const names = harnesses.map(harnessFullName);
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function HarnessMark({
  harness,
  muted = false,
}: {
  readonly harness: CustomizeDiscoveryHarness;
  /** Not supported: the mark takes the muted text color. */
  readonly muted?: boolean;
}): JSX.Element {
  const { px } = BADGE_ICON_BY_SIZE.regular;
  const className = `${BADGE_ICON_BY_SIZE.regular.className}${muted ? ' fg-disabled' : ''}`;
  switch (harness) {
    case 'claude':
      return <ClaudeLogo width={px} height={px} className={className} />;
    case 'codex':
      return <CodexLogo width={px} height={px} className={className} />;
    case 'cursor':
      return <CursorLogo width={px} height={px} className={className} />;
    case 'copilot':
      // GitHub retired Copilot's own icon and mascot head; the approved
      // product lockup is the Invertocat beside "Copilot"
      // (https://brand.github.com/brand-identity/copilot).
      return <GitHubIcon size={px} exactSize className={className} />;
    case 'opencode':
      return <OpenCodeLogo width={px} height={px} className={className} />;
  }
}

/**
 * A Customize row's "Works with" chips (CAN-6813): one logo chip per
 * harness it works with, at most two badges, the second a "+N" counter past
 * that; each tooltip names its harness. Reads the CAN-6807 compatibility
 * through `customizeWorksWithChips`, which falls back to the published harness.
 */
function isChipHarness(id: string): id is CustomizeDiscoveryHarness {
  return Object.prototype.hasOwnProperty.call(CHIP_NAMES, id);
}

/**
 * A plugin's chips from the one harness reading its page's Works with table
 * also uses (`customizeHarnessRows`): every offered harness, in the table's
 * order. A harness a copy found elsewhere serves looks like one this copy
 * serves; one nothing serves is muted. Each tooltip says where it comes from.
 */
function HarnessRowChips({
  entryId,
  rows,
}: {
  readonly entryId: string;
  readonly rows: readonly CustomizeHarnessRow[];
}): JSX.Element | null {
  const chipRows = rows.flatMap((row) =>
    isChipHarness(row.id) ? [{ ...row, harness: row.id }] : [],
  );
  if (chipRows.length === 0) return null;
  const chip = badgeClassName('neutral');
  const working = chipRows.filter((row) => row.support !== 'none');
  if (working.length === 0) return null;
  // At most two badges, and only the harnesses it works in (Sergii's QA):
  // past two, the second badge becomes a "+N" counter whose tooltip lists
  // every harness the way the page's Works with table reads it.
  const overflow = working.length > MAX_CHIP_BADGES;
  const shownRows = overflow ? working.slice(0, MAX_CHIP_BADGES - 1) : working;
  const hiddenRows = overflow ? working.slice(MAX_CHIP_BADGES - 1) : [];
  return (
    <span
      data-testid={`customize-row-works-with-${entryId}`}
      className="pointer-events-auto flex shrink-0 items-center gap-1"
    >
      <span className="sr-only">
        {`Works with the ${nameList(working.map((row) => row.harness))} ${working.length === 1 ? 'harness' : 'harnesses'}`}
      </span>
      {shownRows.map((row) => (
        <Tooltip key={row.harness} label={row.tooltip}>
          <span
            aria-hidden="true"
            data-testid={`customize-row-works-with-${entryId}-${row.harness}`}
            data-harness-support={row.support}
            className={chip}
          >
            <HarnessMark harness={row.harness} />
          </span>
        </Tooltip>
      ))}
      {overflow && (
        <Tooltip
          label={
            <span className="flex flex-col gap-0.5">
              {chipRows.map((row) => (
                <span key={row.harness}>{row.tooltip}</span>
              ))}
            </span>
          }
        >
          <span
            aria-hidden="true"
            data-testid={`customize-row-works-with-${entryId}-more`}
            className={chip}
          >
            {`+${hiddenRows.length}`}
          </span>
        </Tooltip>
      )}
    </span>
  );
}

export function CustomizeWorksWithChips({
  entry,
}: {
  readonly entry: Pick<
    UnifiedPluginEntry,
    | 'id'
    | 'providerSupport'
    | 'harnessCompatibility'
    | 'marketplaceListings'
    | 'chatGptAppStandIn'
    | 'harnessRows'
    | 'alsoAvailableFrom'
  >;
}): JSX.Element | null {
  const rows = customizeEntryHarnessRows(entry);
  if (rows !== undefined)
    return <HarnessRowChips entryId={entry.id} rows={rows} />;
  const chips = customizeWorksWithChips(entry);
  // One chip per harness, never the same harness twice.
  const shown = [...new Set([...chips.shown, ...chips.more])];
  if (shown.length === 0) return null;
  const chip = badgeClassName('neutral');
  const overflow = shown.length > MAX_CHIP_BADGES;
  const visible = overflow ? shown.slice(0, MAX_CHIP_BADGES - 1) : shown;
  const hidden = overflow ? shown.slice(MAX_CHIP_BADGES - 1) : [];
  return (
    <span
      data-testid={`customize-row-works-with-${entry.id}`}
      className="pointer-events-auto flex shrink-0 items-center gap-1"
    >
      <span className="sr-only">
        {`Works with the ${nameList(shown)} ${shown.length === 1 ? 'harness' : 'harnesses'}`}
      </span>
      {visible.map((harness) => (
        <Tooltip
          key={harness}
          label={customizeWorksWithChipLabel(
            entry,
            harness,
            harnessFullName(harness),
          )}
        >
          <span
            aria-hidden="true"
            data-testid={`customize-row-works-with-${entry.id}-${harness}`}
            className={chip}
          >
            <HarnessMark harness={harness} />
          </span>
        </Tooltip>
      ))}
      {overflow && (
        <Tooltip
          label={
            <span className="flex flex-col gap-0.5">
              {CUSTOMIZE_DISCOVERY_HARNESS_OPTIONS.map(({ value: harness }) => (
                <span key={harness}>
                  {shown.includes(harness)
                    ? customizeWorksWithChipLabel(
                        entry,
                        harness,
                        harnessFullName(harness),
                      )
                    : `${harnessFullName(harness)}: not supported`}
                </span>
              ))}
            </span>
          }
        >
          <span
            aria-hidden="true"
            data-testid={`customize-row-works-with-${entry.id}-more`}
            className={chip}
          >
            {`+${hidden.length}`}
          </span>
        </Tooltip>
      )}
    </span>
  );
}

/**
 * A detail page's Works with rows, from the same selector as the tile's
 * chips: the entry's harness rows when it has them, else every harness with
 * whether this item works there (installed items read Installed).
 */
export function customizeWorksWithRows(
  entry: Parameters<typeof CustomizeWorksWithChips>[0]['entry'] &
    Pick<UnifiedPluginEntry, 'state'>,
): PluginWorksWithRow[] {
  const rows = customizeEntryHarnessRows(entry);
  if (rows !== undefined) {
    // An installed copy in the group (another marketplace's listing) fills
    // the harnesses it serves.
    const installedRows = (entry.marketplaceListings ?? [])
      .filter(
        (listing) =>
          listing.state === 'installed' || listing.state === 'needs-auth',
      )
      .flatMap((listing) => listing.harnessRows ?? []);
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      installation:
        row.installation !== 'Installed' &&
        installedRows.some(
          (theirs) =>
            theirs.id === row.id && theirs.installation === 'Installed',
        )
          ? 'Installed'
          : row.installation,
    }));
  }
  const supported = new Set(customizeWorksWithHarnesses(entry));
  // Not added, and no copy's files read: only the marketplace's own
  // harness is known, so the others are unknown rather than unsupported.
  // Per harness: compatibility may cover only some of them.
  const listings = [entry, ...(entry.marketplaceListings ?? [])];
  const copyRead =
    entry.state !== 'available' ||
    listings.some(
      (listing) =>
        listing.state === 'installed' || listing.state === 'needs-auth',
    );
  // A harness an installed copy in the group serves reads Installed.
  const installedVia = new Set(
    listings
      .filter(
        (listing) =>
          listing !== entry &&
          (listing.state === 'installed' || listing.state === 'needs-auth'),
      )
      .flatMap((listing) =>
        customizeWorksWithHarnesses({ ...listing, marketplaceListings: [] }),
      ),
  );
  const verified = (harness: CustomizeDiscoveryHarness): boolean =>
    copyRead ||
    listings.some(
      (listing) =>
        listing.harnessCompatibility?.harnesses[harness] !== undefined,
    );
  return CUSTOMIZE_DISCOVERY_HARNESS_OPTIONS.map(({ value }) => ({
    id: value,
    name: CHIP_NAMES[value],
    installation: !supported.has(value)
      ? verified(value)
        ? 'Not supported'
        : 'Unknown until added'
      : entry.state !== 'available' || installedVia.has(value)
        ? 'Installed'
        : 'Not installed',
  }));
}

/** The Works with table for an entry, as its tile's chips read it. */
export function CustomizeEntryWorksWith({
  entry,
  checking = false,
}: {
  readonly entry: Parameters<typeof customizeWorksWithRows>[0];
  /** A preview of the plugin's files is being read: unknown rows say so. */
  readonly checking?: boolean;
}): JSX.Element | null {
  const rows = customizeWorksWithRows(entry);
  return (
    <PluginWorksWith
      rows={
        checking
          ? rows.map((row) =>
              row.installation === 'Unknown until added'
                ? { ...row, installation: 'Checking…' }
                : row,
            )
          : rows
      }
      caption="Installation by harness"
    />
  );
}
