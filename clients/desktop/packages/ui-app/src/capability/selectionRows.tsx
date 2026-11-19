import type { JSX } from 'react';
import {
  capabilityUnavailableDisposition,
  type CapabilityUnavailable,
} from '@canopy/protocol/capability-bundle';
import type {
  UnifiedTableBadge,
  UnifiedTableToggleMode,
} from '@canopy/ui-shared';
import { Button } from '@canopy/ui-shared/components';

/**
 * The rows of a capability picker that both hosts render the same way: the
 * selection keys a row stands for, the badge naming the default layer a chat
 * inherits a row from, and the status and Remove action of a selected
 * capability the chat can no longer use (REG-3042). The web cloud picker and
 * the desktop plugin selector each build their own catalog rows and feed them
 * through here, so a row reads the same on both.
 */

/** Selection key of a skill row: `sourceId/skillName`. */
export function skillSelectionKey(sourceId: string, skillName: string): string {
  return `${sourceId}/${skillName}`;
}

/** Selection key of a plugin row: `marketplaceId/pluginName`. */
export function pluginSelectionKey(
  marketplaceId: string,
  pluginName: string,
): string {
  return `${marketplaceId}/${pluginName}`;
}

/** Selection key of an MCP server row: `serverId/configId`. */
export function mcpSelectionKey(serverId: string, configId: string): string {
  return `${serverId}/${configId}`;
}

/** The badge on a row a chat inherits from a default layer. */
export const INHERITED_DEFAULT_BADGE_LABELS = {
  project: 'Project default',
  global: 'Global default',
  // The organization's shared set for the project (CAN-6237).
  organization: 'Organization default',
} as const;

export const CAPABILITY_NOT_SIGNED_IN_LABEL = 'Not signed in';
export const CAPABILITY_NEEDS_RECONNECTING_LABEL = 'Needs reconnecting';
export const CAPABILITY_NO_LONGER_AVAILABLE_LABEL = 'No longer available';
export const CAPABILITY_NO_LONGER_SHARED_LABEL = 'No longer shared with you';
export const CAPABILITY_DESKTOP_ONLY_LABEL = 'Available on desktop only';
export const CAPABILITY_TURNED_OFF_LABEL = 'Turned off';
export const CAPABILITY_REMOVE_LABEL = 'Remove';

/**
 * The quiet status a selected capability's row carries for the reason the
 * server recorded. Degraded capabilities still work, so they carry none;
 * neither does a record whose reason or disposition this client does not
 * know, which reads as degraded.
 */
export function capabilityUnavailableLabel(
  record: Pick<CapabilityUnavailable, 'reason' | 'disposition'>,
): string | undefined {
  if (capabilityUnavailableDisposition(record) === 'degraded') return undefined;
  switch (record.reason) {
    case 'deleted':
    case 'removed_from_catalog':
      return CAPABILITY_NO_LONGER_AVAILABLE_LABEL;
    case 'no_access':
      return CAPABILITY_NO_LONGER_SHARED_LABEL;
    case 'desktop_only':
      return CAPABILITY_DESKTOP_ONLY_LABEL;
    case 'turned_off':
      return CAPABILITY_TURNED_OFF_LABEL;
    case 'not_connected':
      return CAPABILITY_NOT_SIGNED_IN_LABEL;
    case 'needs_reconnect':
      return CAPABILITY_NEEDS_RECONNECTING_LABEL;
    case 'connections_unavailable':
      return 'Needs an account connection';
    case 'marketplace_sync_failed':
      return 'Marketplace sync failed';
    case 'awaiting_rematerialization':
      return 'Updating';
    case 'invalid_skill':
      return 'Needs fixing';
    case 'invalid_ref':
      return 'Not available in cloud chats';
    case 'limit_exceeded':
      return 'Over the limit';
    case 'catalog_disabled':
    case 'files_unavailable':
    case 'partial':
      return 'Unavailable right now';
    default:
      return undefined;
  }
}

/** What a selected capability's row selects. */
export interface CapabilitySelectionRef {
  readonly kind: 'skill' | 'plugin' | 'mcp';
  /** The kind's selection key, e.g. {@link skillSelectionKey}. */
  readonly key: string;
}

/** The row a record's direct ref selects; null for one reached via a plugin. */
export function capabilityUnavailableSelection(
  record: CapabilityUnavailable,
): CapabilitySelectionRef | null {
  const { ref } = record;
  if (ref.via.kind !== 'direct') return null;
  if (ref.kind === 'skill')
    return {
      kind: 'skill',
      key: skillSelectionKey(ref.sourceId, ref.skillName),
    };
  if (ref.kind === 'plugin')
    return {
      kind: 'plugin',
      key: pluginSelectionKey(ref.marketplaceId, ref.pluginName),
    };
  return { kind: 'mcp', key: mcpSelectionKey(ref.serverId, ref.configId) };
}

/** The selections the server says are gone for good, never to be saved back. */
export function goneCapabilitySelections(
  unavailable: readonly CapabilityUnavailable[],
): CapabilitySelectionRef[] {
  return unavailable.flatMap((record) => {
    if (capabilityUnavailableDisposition(record) !== 'gone') return [];
    const selection = capabilityUnavailableSelection(record);
    return selection === null ? [] : [selection];
  });
}

/** What a host's picker row needs for the unavailable status to apply. */
export interface UnavailableStatusRow {
  key: string;
  badges?: UnifiedTableBadge[];
  toggleMode?: UnifiedTableToggleMode;
  toggleReason?: string;
}

/** The host-independent part of a row for a selection the catalog no longer lists. */
export interface UnavailableSelectionRow {
  readonly kind: CapabilitySelectionRef['kind'];
  readonly key: string;
  readonly name: string;
  readonly badges: UnifiedTableBadge[];
  readonly toggleMode: 'unsupported';
  readonly toggleReason: string;
}

/** What a selected capability is called when the server has no name for it. */
const UNNAMED_KIND_LABEL: Record<CapabilityUnavailable['ref']['kind'], string> =
  {
    skill: 'Skill',
    plugin: 'Plugin',
    mcpServer: 'MCP server',
  };

export interface UnavailableRowsOptions<Row extends UnavailableStatusRow> {
  /** The host's row key for a selection. */
  readonly rowKey: (selection: CapabilitySelectionRef) => string;
  /** Whether the chat currently selects it. */
  readonly isSelected: (selection: CapabilitySelectionRef) => boolean;
  /** The host's full row for a selected capability the catalog no longer lists. */
  readonly synthesize: (
    row: UnavailableSelectionRow,
    selection: CapabilitySelectionRef,
  ) => Row;
}

export interface UnavailableRowsProjection<Row> {
  readonly rows: Row[];
  /** Rows of selected capabilities the server recorded as unavailable. */
  readonly removableKeys: Set<string>;
  /** Rows added for selections the catalog no longer lists. */
  readonly added: { rowKey: string; selection: CapabilitySelectionRef }[];
}

/**
 * Badges each listed row of a capability the server recorded as unavailable
 * with its status, adds a row for a selected one the catalog no longer lists
 * (so the selected count and the rows always agree), and marks both
 * removable. A row the server calls gone can be removed but never selected
 * again. Rows are copied, never mutated.
 */
export function withUnavailableRows<Row extends UnavailableStatusRow>(
  rows: readonly Row[],
  unavailable: readonly CapabilityUnavailable[],
  options: UnavailableRowsOptions<Row>,
): UnavailableRowsProjection<Row> {
  const result = [...rows];
  const removableKeys = new Set<string>();
  const added: UnavailableRowsProjection<Row>['added'] = [];
  for (const record of unavailable) {
    const label = capabilityUnavailableLabel(record);
    const selection = capabilityUnavailableSelection(record);
    if (label === undefined || selection === null) continue;
    const rowKey = options.rowKey(selection);
    const gone = capabilityUnavailableDisposition(record) === 'gone';
    const index = result.findIndex((candidate) => candidate.key === rowKey);
    if (index !== -1) {
      result[index] = withStatus(result[index], label, gone);
    } else if (options.isSelected(selection)) {
      result.push(
        options.synthesize(
          unlistedRow(record, selection, rowKey, label, gone),
          selection,
        ),
      );
      added.push({ rowKey, selection });
    } else {
      continue;
    }
    removableKeys.add(rowKey);
  }
  return { rows: result, removableKeys, added };
}

function withStatus<Row extends UnavailableStatusRow>(
  row: Row,
  label: string,
  gone: boolean,
): Row {
  const badges = row.badges ?? [];
  return {
    ...row,
    badges: badges.some((badge) => badge.label === label)
      ? badges
      : [...badges, { label, tone: 'neutral' }],
    ...(gone ? { toggleMode: 'unsupported', toggleReason: label } : {}),
  };
}

function unlistedRow(
  record: CapabilityUnavailable,
  selection: CapabilitySelectionRef,
  rowKey: string,
  label: string,
  gone: boolean,
): UnavailableSelectionRow {
  return {
    kind: selection.kind,
    key: rowKey,
    name: record.displayName ?? UNNAMED_KIND_LABEL[record.ref.kind],
    badges: [{ label, tone: gone ? 'warning' : 'neutral' }],
    toggleMode: 'unsupported',
    toggleReason: label,
  };
}

/** The trailing Remove action on a removable row's selected state. */
export function UnavailableRemoveAction({
  name,
  onRemove,
}: {
  readonly name: string;
  readonly onRemove: () => void;
}): JSX.Element {
  return (
    <Button
      type="button"
      variant="ghost"
      size="compact"
      onClick={onRemove}
      data-testid="portal-plugins-remove-unavailable"
      aria-label={`${CAPABILITY_REMOVE_LABEL} ${name}`}
    >
      {CAPABILITY_REMOVE_LABEL}
    </Button>
  );
}
