import type { ComponentType, JSX, MouseEvent, ReactNode } from 'react';
import type { UnifiedEntryPlacement } from '../lib/unified-plugin-entry';
import { mcpPlacementLabel } from '../lib/mcp-row-health';
import { formatDateOrEmpty } from '../lib/format-date';
import { ClaudeLogo, CodexLogo } from '../icons';
import { AlertTriangle, PersonIcon, RefreshIcon } from '../icons/AppIcons';
import { curatedLogoKey } from '../lib/curated-logo-key';
import { createdByViewer, pendingSignInLabel } from '../lib/customize-row-copy';
import { displayVersion } from '../lib/display-version';
import { INSTALLED_SHARE_UPDATE_AVAILABLE_LABEL } from '../lib/installed-share-copy';
import { REPLAY_MASK_CLASS, REPLAY_BLOCK_CLASS } from '../lib/replay-privacy';
import type { UnifiedPluginEntry } from '../lib/unified-plugin-entry';
import {
  CustomizeRowMenu,
  type CustomizeRowMenuItem,
} from './CustomizeRowMenu';
import { EntrySurfaceIcon } from './EntrySurfaceIcon';
import { McpConnectionStatusBadge } from './McpConnectionStatusBadge';
import { McpServerLogo, type McpServerLogoProps } from './McpServerLogo';
import {
  EntrySourceProviderMark,
  entrySourceTextWithoutProvider,
} from './EntrySourceLabel';
import { Tooltip } from './Tooltip';
import { MarketplaceTypeLabel } from './MarketplaceTypeLabel';
import { Badge } from './Badge';

function compactMetadata(entry: UnifiedPluginEntry): {
  source: string | undefined;
  version: string | null;
  tooltip: string;
  visibleCounts: readonly (readonly [
    number | undefined,
    'plugin' | 'skill' | 'app' | 'agent',
    string,
  ])[];
  triggerSummary: string | undefined;
} {
  const version = displayVersion(entry.version);
  const own = createdByViewer(entry) && !entry.installedFrom;
  const owner = own
    ? 'You'
    : entry.sharedSource?.sharedBy?.trim() ||
      entry.installedFrom?.sharedByName?.trim() ||
      entry.installedFrom?.ownerName?.trim() ||
      entry.authorName?.trim();
  const catalog = entry.sourceLabel?.trim();
  const source = entry.installedVia
    ? `Installed via ${entry.installedVia.name}`
    : entry.builtIn === true || entry.origin === 'built-in'
      ? 'Built-in'
      : own
        ? 'You'
        : entry.sharedSource?.sharedBy?.trim() ||
          entry.installedFrom?.sharedByName?.trim() ||
          entry.installedFrom?.ownerName?.trim() ||
          (entry.origin === 'marketplace' ? catalog : undefined) ||
          owner ||
          entry.workflow?.sourceText?.replace(/^Shared by /, '') ||
          entry.ownershipLabel?.trim() ||
          (catalog &&
          !['Curated', 'Local', 'Shared', 'Project'].includes(catalog)
            ? catalog
            : undefined);
  const workflow = entry.workflow;
  const triggers = workflow?.triggers ?? [];
  const triggerSummary =
    workflow?.schedule?.label ||
    (triggers.length > 1
      ? `${triggers.length} triggers`
      : triggers[0]?.label) ||
    workflow?.triggerText;
  const scope = entry.sharedWith;
  const scopeLabel = scope
    ? scope.personal
      ? 'Personal'
      : scope.name || (scope.audience === 'team' ? 'Team' : 'Organization')
    : undefined;
  const receiptContextNames = entry.installedFrom
    ? [
        ...new Set([
          entry.installedFrom.teamName?.trim(),
          entry.installedFrom.ownerName?.trim(),
        ]),
      ].filter(
        (name): boolean =>
          Boolean(name) && name !== owner && name !== scopeLabel?.trim(),
      )
    : [];
  const edited = formatDateOrEmpty(entry.editedAt);
  const tooltip = [
    owner ? `Created by ${own ? 'you' : owner}` : undefined,
    scopeLabel ? `shared to ${scopeLabel}` : undefined,
    ...receiptContextNames,
    entry.publicShare ? 'Public link' : undefined,
    entry.workflow?.sourceText,
    entry.workflow?.triggerText,
    ...(entry.workflow?.triggers?.map(
      (trigger) => `${trigger.label}: ${trigger.explainer}`,
    ) ?? []),
    entry.workflow?.schedule?.tooltip,
    entry.workflow?.stepCount !== undefined
      ? `${entry.workflow.stepCount} steps`
      : undefined,
    edited ? `Edited ${edited}` : undefined,
    entry.workflow?.lastRun
      ? `Last run: ${entry.workflow.lastRun.state}${entry.workflow.lastRun.errorMessage ? `: ${entry.workflow.lastRun.errorMessage}` : ''}`
      : undefined,
  ]
    .filter(Boolean)
    .join(' · ');
  const counts = [
    [entry.components.plugins, 'plugin', 'plugins'],
    [entry.components.skills, 'skill', 'skills'],
    [entry.components.mcpServers, 'app', 'MCP servers'],
    [entry.components.agents, 'agent', 'agents'],
  ] as const;
  const visibleCounts =
    entry.kind === 'collection'
      ? counts.filter(
          ([count]) =>
            count !== undefined && Number.isSafeInteger(count) && count > 0,
        )
      : [];
  return { source, version, tooltip, visibleCounts, triggerSummary };
}

function CompactMetadata({
  entry,
  metadata,
}: {
  entry: UnifiedPluginEntry;
  metadata: ReturnType<typeof compactMetadata>;
}): JSX.Element | null {
  const { version, tooltip, visibleCounts, triggerSummary } = metadata;
  const source = metadata.source
    ? entrySourceTextWithoutProvider(entry, metadata.source)
    : metadata.source;
  const hasHarnessIcons =
    entry.installedHarnesses?.claude === true ||
    entry.installedHarnesses?.codex === true;
  // With nothing to say, the row drops the line so its name centers.
  if (
    !hasHarnessIcons &&
    !source &&
    !version &&
    visibleCounts.length === 0 &&
    !triggerSummary &&
    !entry.bundledBy &&
    !entry.sharedSourceProvider &&
    !(entry.origin === 'marketplace' && entry.kind === 'plugin')
  )
    return null;
  return (
    <span
      data-testid={`customize-row-subtitle-${entry.id}`}
      className={`mt-0.5 flex h-4 min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap text-xs fg-tertiary ${entry.origin === 'shared' || entry.installedFrom || entry.sharedSource || entry.collectionProvenanceUnknown ? REPLAY_BLOCK_CLASS : entry.workflow?.sourceIsPerson ? REPLAY_MASK_CLASS : ''}`}
    >
      {/* Where it's installed says more than the marketplace's mark, and one
          row of logos reads better than two. */}
      {hasHarnessIcons ? (
        <HarnessIcons entry={entry} />
      ) : (
        entry.origin !== 'shared' && <EntrySourceProviderMark entry={entry} />
      )}
      {source && (
        <Tooltip
          label={
            <span className={REPLAY_BLOCK_CLASS}>
              {tooltip || entry.description || entry.name}
            </span>
          }
        >
          <span
            data-testid={`customize-row-source-${entry.id}`}
            className="min-w-0 truncate"
          >
            {source}
          </span>
        </Tooltip>
      )}
      {!hasHarnessIcons && entry.origin === 'shared' && (
        <EntrySourceProviderMark entry={entry} />
      )}
      {source && version && <span>·</span>}
      {version && (
        <span
          data-testid={`customize-row-version-${entry.id}`}
          className="shrink-0"
        >
          {version}
        </span>
      )}
      {(source || version) && entry.bundledBy && <span>·</span>}
      {entry.bundledBy && (
        <span
          data-testid={`customize-row-from-plugin-${entry.id}`}
          className="truncate"
        >
          From {entry.bundledBy.name}
        </span>
      )}
      {(source || version || entry.bundledBy) && visibleCounts.length > 0 && (
        <span>·</span>
      )}
      {visibleCounts.length > 0 && (
        <span className="flex shrink-0 items-center gap-2">
          {visibleCounts.map(([count, kind, label]) => (
            <Tooltip
              key={kind}
              label={`${count} ${count === 1 ? (label === 'MCP servers' ? 'MCP server' : label.slice(0, -1)) : label}`}
            >
              <span>
                <span aria-hidden="true">
                  <MarketplaceTypeLabel kind={kind} label={String(count)} />
                </span>
                <span className="sr-only">{`${count} ${count === 1 ? (label === 'MCP servers' ? 'MCP server' : label.slice(0, -1)) : label}`}</span>
              </span>
            </Tooltip>
          ))}
        </span>
      )}
      {(source || version || entry.bundledBy || visibleCounts.length > 0) &&
        triggerSummary && <span>·</span>}
      {triggerSummary && (
        <Tooltip
          label={
            <span className={REPLAY_BLOCK_CLASS}>
              {tooltip || triggerSummary}
            </span>
          }
        >
          <span
            data-testid={`customize-row-trigger-${entry.id}`}
            className="min-w-0 truncate"
          >
            {triggerSummary}
          </span>
        </Tooltip>
      )}
    </span>
  );
}

function CustomItemBadge({
  entry,
  selected,
}: {
  readonly entry: UnifiedPluginEntry;
  readonly selected: boolean;
}): JSX.Element {
  const creator = entry.authorName?.trim();
  const kind = entry.typeLabel?.toLowerCase() || entry.kind;
  const label = creator ? `Custom ${kind} by ${creator}` : `Custom ${kind}`;
  return (
    <span
      className={`absolute ${entry.kind === 'collection' ? '-bottom-1.5 -right-1.5' : '-bottom-1 -right-1'} z-10 inline-flex overflow-visible`}
    >
      <Tooltip
        label={
          <span className={creator ? REPLAY_BLOCK_CLASS : undefined}>
            {label}
          </span>
        }
      >
        <span
          data-testid={`customize-row-custom-${entry.id}`}
          role="img"
          aria-label={label}
          className={`inline-flex size-4 items-center justify-center rounded-full bg-fg-primary [color:var(--bg-primary)] ring-2 ${
            selected
              ? 'ring-selected'
              : 'ring-[var(--bg-primary)] group-hover/skill-row:ring-subtle'
          } ${creator ? REPLAY_BLOCK_CLASS : ''}`}
        >
          <PersonIcon size="xs" drawnStrokeWidth={1.4} aria-hidden="true" />
        </span>
      </Tooltip>
    </span>
  );
}

/** A DOM id unique per section, since one entry may appear in several. */
export function customizeRowDomId(sectionId: string, entryId: string): string {
  return `customize-${encodeURIComponent(sectionId)}-${encodeURIComponent(entryId)}`;
}

export interface CustomizeInstalledRowProps {
  readonly entry: UnifiedPluginEntry;
  /** Owning section; qualifies DOM ids and scopes test ids. */
  readonly sectionId: string;
  readonly primaryTestId?: string;
  readonly menuTestId?: string;
  readonly selected?: boolean;
  readonly showEntryType?: boolean;
  readonly onSelect: (entry: UnifiedPluginEntry) => void;
  /** Semantic link target; plain clicks still route through `onSelect`. */
  readonly href?: string;
  readonly menuItems?: readonly CustomizeRowMenuItem[];
  /** Extension slot for status controls supplied by a later surface. */
  readonly status?: ReactNode;
  readonly values?: ReactNode;
  /** Visible row actions such as Update. */
  readonly actions?: ReactNode;
  /** Replaces the attention chip and connection badge on an MCP row. */
  readonly health?: ReactNode;
  /** An attention action kept outside the primary row control. */
  readonly inlineAction?: ReactNode;
  /** Where an MCP row is saved; replaces the surface icon. */
  readonly placement?: UnifiedEntryPlacement;
  /**
   * Starts sign-in from the row's menu, beside the marker that says one is
   * pending. Omit when the row has nothing to connect.
   */
  readonly onConnect?: (entry: UnifiedPluginEntry) => void;
  /**
   * What the menu item connects, when that is not this row (a plugin row
   * signing in to a bundled server). Defaults to the row.
   */
  readonly connectName?: string;
  /**
   * A Disabled item (CAN-4838): the logo, name, inline badges, subtitle and
   * version text take 60% opacity; the harness icons, connection badge, focus
   * ring, status, actions and menu keep full ink.
   */
  readonly dimmed?: boolean;
  readonly McpServerLogoComponent?: ComponentType<McpServerLogoProps>;
}

function HarnessIcons({
  entry,
}: {
  entry: UnifiedPluginEntry;
}): JSX.Element | null {
  const harnesses = entry.installedHarnesses;
  if (harnesses?.claude !== true && harnesses?.codex !== true) return null;
  return (
    <span
      data-testid={`customize-row-harnesses-${entry.id}`}
      className="flex shrink-0 items-center gap-1"
    >
      {harnesses.claude === true && (
        <Tooltip label="Installed for Claude">
          <ClaudeLogo
            width={12}
            height={12}
            role="img"
            aria-label="Installed for Claude"
            className="shrink-0 fg-secondary"
          />
        </Tooltip>
      )}
      {harnesses.codex === true && (
        <Tooltip label="Installed for Codex">
          <CodexLogo
            width={12}
            height={12}
            role="img"
            aria-label="Installed for Codex"
            className="shrink-0 fg-secondary"
          />
        </Tooltip>
      )}
    </span>
  );
}

/**
 * One Installed, Updates or Shared by me row. The primary control and the
 * trailing controls are siblings, so a secondary action never opens details.
 */
export function CustomizeInstalledRow({
  entry,
  sectionId,
  primaryTestId,
  menuTestId,
  selected = false,
  showEntryType = false,
  onSelect,
  href,
  menuItems = [],
  status,
  values,
  actions,
  health,
  inlineAction,
  placement,
  onConnect,
  connectName,
  dimmed = false,
  McpServerLogoComponent = McpServerLogo,
}: CustomizeInstalledRowProps): JSX.Element {
  const domId = customizeRowDomId(sectionId, entry.id);
  const metadata = compactMetadata(entry);
  const compactMcp = health !== undefined || entry.installedVia !== undefined;
  // Only real pending sign-ins are counted (`pendingSignIns`, set by the
  // entry projection); any other problem keeps `Needs attention`. A plugin
  // counts the sign-ins its bundled servers wait for. The host decides what
  // the marker's menu item connects through `onConnect`.
  const signInCount = entry.pendingSignIns ?? 0;
  const attentionLabel =
    signInCount > 0
      ? pendingSignInLabel(signInCount)
      : entry.state === 'needs-auth'
        ? 'Needs attention'
        : undefined;
  const rowMenuItems =
    health === undefined &&
    attentionLabel !== undefined &&
    onConnect &&
    !menuItems?.some((item) => item.id === 'connect')
      ? [
          ...(menuItems ?? []),
          {
            id: 'connect',
            label:
              connectName && connectName !== entry.name
                ? `Connect ${connectName}`
                : 'Connect',
            onSelect: (): void => onConnect(entry),
          },
        ]
      : menuItems;
  // Opacity on the control itself would dim its focus ring, so the content
  // wrapper carries it.
  const content = (
    <span
      data-testid={`customize-row-content-${entry.id}`}
      className={`flex min-w-0 flex-1 items-center gap-3${dimmed ? ' opacity-60' : ''}`}
    >
      <span className="relative inline-flex shrink-0 overflow-visible">
        <McpServerLogoComponent
          curatedKey={curatedLogoKey(entry)}
          logoUrl={entry.logoUrl}
          bundledLogo={entry.bundledLogo}
          brandMark={entry.brandMark}
          size={28}
          fallback="monogram"
          name={entry.name}
          shape="circle"
          fit="contain"
        />
        {createdByViewer(entry) && !entry.installedFrom && (
          <CustomItemBadge entry={entry} selected={selected} />
        )}
      </span>
      <span className="min-w-0 flex-1">
        {/* The name and its labels stay on one line: a long name truncates
            instead of pushing the type label onto a line of its own. */}
        <span
          data-testid={`customize-row-name-line-${entry.id}`}
          className="flex min-w-0 items-center gap-x-1.5 overflow-hidden"
        >
          {/* The line clips rather than spilling into the row's controls.
              The name truncates as space runs out;
              the kind and surface icon stay whole. */}
          <span
            title={[entry.name, entry.description].filter(Boolean).join(' · ')}
            className="min-w-0 truncate text-s font-medium fg-primary"
          >
            {entry.name}
          </span>
          {showEntryType && entry.typeLabel && (
            <MarketplaceTypeLabel
              kind={entry.kind}
              label={entry.typeLabel}
              dataTestId={`customize-row-type-${entry.id}`}
            />
          )}
          {placement !== undefined && placement !== 'account' && (
            <EntrySurfaceIcon
              surface="desktop"
              label={mcpPlacementLabel('desktop')}
              testId={`customize-row-placement-${entry.id}`}
            />
          )}
          {placement !== undefined && placement !== 'desktop' && (
            <EntrySurfaceIcon
              surface="cloud"
              label={mcpPlacementLabel('account')}
              testId={`customize-row-placement-cloud-${entry.id}`}
            />
          )}
          {placement === undefined && entry.surface && (
            <EntrySurfaceIcon
              surface={entry.surface}
              testId={`plugins-surface-${entry.id}`}
            />
          )}
          {health === undefined && attentionLabel !== undefined && (
            <Tooltip label={`${attentionLabel}. Open details to fix it.`}>
              <span
                data-testid={`customize-row-sign-in-${entry.id}`}
                aria-label={attentionLabel}
                role="img"
                className="inline-flex shrink-0 fg-warning"
              >
                <AlertTriangle width={13} height={13} aria-hidden="true" />
              </span>
            </Tooltip>
          )}
          {/* A shared copy whose source changed (CAN-5309): the detail's
              marker, never shrunk; its text is part of the row's name. The
              Update action stays on the detail. */}
          {entry.shareUpdateAvailable === true && (
            <Badge
              tone="info"
              icon={RefreshIcon}
              className="shrink-0 whitespace-nowrap"
              data-testid={`customize-row-update-available-${entry.id}`}
            >
              {INSTALLED_SHARE_UPDATE_AVAILABLE_LABEL}
            </Badge>
          )}
        </span>
        {health !== undefined ? (
          <span className="mt-0.5 flex h-4 min-w-0 items-center gap-1 overflow-hidden whitespace-nowrap text-xs fg-tertiary">
            {health}
          </span>
        ) : (
          <CompactMetadata entry={entry} metadata={metadata} />
        )}
      </span>
    </span>
  );
  const primaryProps = {
    id: domId,
    'aria-describedby': `${domId}-description`,
    'data-marketplace-entry': 'true',
    'data-testid': primaryTestId ?? `customize-row-${entry.id}`,
    'data-selected': selected ? 'true' : 'false',
    // MCP names yield width to the controls rather than moving them below.
    className: `focus-ring flex flex-1 items-center gap-3 rounded-xl py-2.5 text-left pointer-coarse:min-h-11 ${compactMcp ? 'min-w-0 pl-4 pr-0' : 'min-w-32 px-4'} ${
      selected ? 'bg-selected' : ''
    }`,
  };
  const onLinkClick = (event: MouseEvent<HTMLAnchorElement>): void => {
    if (
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      event.button !== 0
    )
      return;
    event.preventDefault();
    onSelect(entry);
  };
  return (
    <li
      data-testid={`customize-${sectionId}-row-${entry.id}`}
      data-dimmed={dimmed ? 'true' : undefined}
      className={`group/skill-row relative -ml-4 flex min-w-0 ${compactMcp ? 'flex-nowrap' : 'flex-wrap'} items-center gap-2 rounded-xl pr-4 transition-colors hover:bg-subtle`}
    >
      {href !== undefined ? (
        <a {...primaryProps} href={href} onClick={onLinkClick}>
          {content}
        </a>
      ) : (
        <button {...primaryProps} type="button" onClick={() => onSelect(entry)}>
          {content}
        </button>
      )}
      <span
        id={`${domId}-description`}
        className={`sr-only ${REPLAY_BLOCK_CLASS}`}
      >
        {metadata.tooltip}
      </span>
      <div
        data-testid={`customize-row-controls-${entry.id}`}
        className={`ml-auto flex min-w-min max-w-full items-center justify-end empty:hidden ${compactMcp ? 'shrink-0 flex-nowrap gap-2' : 'flex-wrap gap-2'}`}
      >
        {/* Health shows only once a check has a result; a server that was
          never checked shows nothing rather than a "Not checked" chip. An
          attention marker already says a sign-in is missing, so Auth
          required is not repeated beside it. */}
        {inlineAction}
        {health === undefined &&
          entry.connection &&
          entry.connection.status !== 'unknown' &&
          !(
            attentionLabel !== undefined &&
            entry.connection.status === 'auth_required'
          ) && (
            <McpConnectionStatusBadge
              badge={{
                status: entry.connection.status,
                isProvider: entry.connection.provider === true,
              }}
              dataTestId={`plugins-connection-status-${entry.id}`}
              providerTestId={`plugins-connection-provider-${entry.id}`}
            />
          )}
        {values}
        {status ??
          (!compactMcp && <span className="w-36 shrink-0" aria-hidden />)}
        <span className="flex w-7 shrink-0 items-center justify-end pointer-coarse:w-11">
          {actions}
        </span>
        <span className="flex w-7 shrink-0 justify-end pointer-coarse:w-11">
          <CustomizeRowMenu
            entryName={entry.name}
            idPrefix={domId}
            items={rowMenuItems}
            testId={menuTestId ?? `customize-row-menu-${entry.id}`}
          />
        </span>
      </div>
    </li>
  );
}
