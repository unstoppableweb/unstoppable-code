import { ListRowFrame } from '../primitives/ListRow';
import { ControlButton } from '../primitives/Button';
import type { ComponentType, JSX, MouseEvent, ReactNode } from 'react';
import {
  sourceLabelProvider,
  type UnifiedEntryHarnessInstalls,
  type UnifiedEntryPlacement,
} from '../lib/unified-plugin-entry';
import { mcpPlacementLabel, mcpRowHealthModel } from '../lib/mcp-row-health';
import { formatDateOrEmpty } from '../lib/format-date';
import { ClaudeLogo, CodexLogo } from '../icons';
import {
  PersonIcon,
  RefreshIcon,
  SkillIcon,
  ThumbsUpIcon,
} from '../icons/AppIcons';
import { curatedPluginLogo } from '../lib/curated-plugin-logos';
import { curatedLogoKey } from '../lib/curated-logo-key';
import {
  customizeHarnessInstallWarning,
  customizeHarnessRetryLabel,
  customizeIntegrationInstalledLabel,
  customizeWorksWithHarnesses,
  CUSTOMIZE_DISCOVERY_HARNESS_OPTIONS,
  type CustomizeSkillMatch,
} from '../lib/customize-discovery';
import { MCP_BRAND_LOGOS } from '../lib/mcp-brand-logos';
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
import { ItemStateMark } from './ItemStateMark';
import { McpRowAttention, McpRowHealth } from './McpRowHealth';
import { McpServerLogo, type McpServerLogoProps } from './McpServerLogo';
import {
  EntrySourceProviderMark,
  entrySourceTextWithoutProvider,
} from './EntrySourceLabel';
import { Tooltip } from '../primitives/Tooltip';
import { MarketplaceTypeLabel } from './MarketplaceTypeLabel';
import { Badge } from '../primitives/Badge';
import {
  CustomizeRowSplitButton,
  type CustomizeRowSplitAction,
} from './CustomizeRowSplitButton';
import { CustomizeWorksWithChips } from './CustomizeWorksWithChips';

/** Corporate suffixes a publisher name drops before matching a brand key. */
const PUBLISHER_SUFFIX = /-(inc|llc|ltd|corp|corporation|co|hq)$/;

/**
 * The bundled brand mark of an entry's publisher (CAN-6813), for a row whose
 * catalog supplies no logo: "Sentry" and "Sentry, Inc." both resolve the
 * `sentry` mark. Only the publisher is matched, never the item's own name,
 * so an unrelated item named after a brand keeps its letter.
 */
export function customizePublisherLogoKey(
  entry: Pick<UnifiedPluginEntry, 'authorName'>,
): string | undefined {
  const slug = entry.authorName
    ?.trim()
    .toLowerCase()
    .replace(/^@/, '')
    .replace(/[\s_./]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (!slug) return undefined;
  return [slug, slug.replace(PUBLISHER_SUFFIX, '')].find((key) =>
    Object.prototype.hasOwnProperty.call(MCP_BRAND_LOGOS, key),
  );
}

/**
 * New Customize's logo chain for an entry (tiles and detail pages alike): its
 * curated mark, else the publisher's bundled mark when the catalog has no
 * logo of its own (or only a guessed one), then the catalog logo.
 */
export function customizeEntryLogo(entry: UnifiedPluginEntry): {
  readonly curatedKey: string | undefined;
  readonly logoUrl: string | undefined;
  readonly bundledLogo: string | undefined;
  readonly brandMark: boolean | undefined;
} {
  return {
    curatedKey:
      curatedLogoKey(entry) ??
      // A guessed avatar or favicon yields to the publisher's bundled mark.
      ((!entry.logoUrl || entry.logoDerived === true) &&
      entry.bundledLogo === undefined &&
      entry.brandMark !== true
        ? customizePublisherLogoKey(entry)
        : undefined),
    logoUrl: entry.logoUrl,
    // Curated plugins carry the Unstoppable Code logos (item 8).
    bundledLogo: curatedPluginLogo(entry) ?? entry.bundledLogo,
    brandMark: entry.brandMark,
  };
}

/** A detail page's 40px logo: the tile's chain, rounded square and plate. */
export function CustomizeEntryLogo({
  entry,
  size = 40,
  McpServerLogoComponent = McpServerLogo,
}: {
  readonly entry: UnifiedPluginEntry;
  readonly size?: number;
  readonly McpServerLogoComponent?: ComponentType<McpServerLogoProps>;
}): JSX.Element {
  return (
    <McpServerLogoComponent
      {...customizeEntryLogo(entry)}
      name={entry.name}
      size={size}
      fallback="monogram"
      shape="tile"
      plate
      fit="contain"
    />
  );
}

/**
 * New Customize's publisher line on a detail page: the text a tile's line 2
 * shows when no status takes its place (publisher, "Built-in", "You",
 * "Shared by X"), never a version, category or "by".
 */
export function customizePublisherText(entry: UnifiedPluginEntry): string {
  const source = compactMetadata(entry).source;
  return (
    (source ? entrySourceTextWithoutProvider(entry, source) : undefined) ||
    discoveryFallbackSource(entry)
  );
}

/**
 * The session-replay class a row's line 2 takes, and so the detail page's
 * publisher line: a share's attribution can name a person or a team.
 */
export function customizePublisherReplayClass(
  entry: UnifiedPluginEntry,
): string {
  return entry.origin === 'shared' ||
    entry.installedFrom ||
    entry.sharedSource ||
    entry.collectionProvenanceUnknown
    ? REPLAY_BLOCK_CLASS
    : entry.workflow?.sourceIsPerson
      ? REPLAY_MASK_CLASS
      : '';
}

/** A detail page's publisher line: the tile's text, with its replay class. */
export function CustomizePublisher({
  entry,
}: {
  readonly entry: UnifiedPluginEntry;
}): JSX.Element {
  const replayClass = customizePublisherReplayClass(entry);
  return (
    <span className={replayClass || undefined}>
      {customizePublisherText(entry)}
    </span>
  );
}

/** Catalog source labels that are internal, never shown as a publisher. */
const INTERNAL_SOURCE_LABELS = new Set([
  'Curated',
  'Local',
  'Shared',
  'Project',
]);

/**
 * New Customize's last word on line 2 when nothing names a publisher: the
 * marketplace it came from, its catalog, or that the publisher is unknown.
 */
function discoveryFallbackSource(entry: UnifiedPluginEntry): string {
  // An MCP server added by hand, often on a private host, names no maker.
  if (entry.ref.type === 'local-mcp' && !entry.marketplaceSourceName)
    return 'Custom MCP server';
  const marketplace = entry.marketplaceSourceName?.trim();
  if (marketplace) return marketplace;
  const catalog = entry.sourceLabel?.trim();
  if (catalog && !INTERNAL_SOURCE_LABELS.has(catalog)) return catalog;
  return 'Unknown publisher';
}

/** A row's pending sign-in, said on its status line (New Customize). */
export interface CustomizeRowSignIn {
  readonly accessibleName: string;
  readonly busy?: boolean;
  readonly run: () => void;
}

/**
 * A row's failed action (New Customize): a status change or Add that did not
 * finish, said on the tile's status line instead of in a page banner.
 */
export interface CustomizeRowFailure {
  /** Short and neutral: "Couldn't turn on". */
  readonly label: string;
  /** The full reason, shown in a tooltip. */
  readonly reason: string;
  /** Amber when a retry may work, red when it can't. */
  readonly tone: 'attention' | 'destructive';
  readonly retry?: () => void;
  /** The retry's wording; "Try again" by default ("Reconnect" for MCP). */
  readonly retryLabel?: string;
  /** Said while the retry runs, in place of its label. */
  readonly retryBusyLabel?: string;
  readonly retryBusy?: boolean;
  /**
   * A connection check failed on one binding; a sign-in another binding waits
   * for stays beside it. A failed status change leaves this off and outranks
   * the sign-in.
   */
  readonly alongsideSignIn?: boolean;
}

/** "✕ Reconnect" (or "✕ Couldn't connect" with nothing to click). */
export function CustomizeRowFailureStatus({
  entryId,
  name,
  failure,
}: {
  readonly entryId: string;
  /** The item's name, so each tile's Try again says what it retries. */
  readonly name: string;
  readonly failure: CustomizeRowFailure;
}): JSX.Element {
  const mark = (
    <ItemStateMark
      tone={failure.tone === 'destructive' ? 'failed' : 'sign-in'}
    />
  );
  // One format: an icon and a clickable callout, or the status in text when
  // there is nothing to click. The reason is in the tooltip, which describes
  // the focused control. It can carry a home-directory path, so it stays out
  // of accessible names (which replay records) and the tooltip is blocked.
  return (
    <span
      data-testid={`customize-row-failure-${entryId}`}
      className="pointer-events-auto inline-flex min-w-0 items-center gap-1"
    >
      {mark}
      {/* With nothing to click, a tap shows the reason: touch has no hover. */}
      <Tooltip
        label={failure.reason}
        clamp
        replayBlock
        showOnPress={failure.retry === undefined}
      >
        {failure.retry !== undefined ? (
          <ControlButton
            presentation="customize-row-sign-in"
            data-testid={`customize-row-failure-${entryId}-retry`}
            aria-label={`${failure.retryLabel ?? 'Try again'} for ${name}`}
            aria-busy={failure.retryBusy || undefined}
            // Stays focusable while busy, so keyboard focus is not dropped.
            aria-disabled={failure.retryBusy || undefined}
            onClick={failure.retryBusy ? undefined : failure.retry}
          >
            {failure.retryBusy
              ? (failure.retryBusyLabel ?? 'Working…')
              : (failure.retryLabel ?? 'Try again')}
          </ControlButton>
        ) : (
          <span className="truncate fg-primary" tabIndex={0}>
            {failure.label}
          </span>
        )}
      </Tooltip>
    </span>
  );
}

/**
 * A row's available update (New Customize): its third line. `run` is the
 * existing update; omitted, the line says so without a CTA.
 */
export interface CustomizeRowUpdate {
  readonly busy?: boolean;
  readonly run?: () => void;
}

/** "⚠ Sign in": the status-line sign-in of New Customize (item 4). */
export function CustomizeRowSignInStatus({
  entryId,
  signIn,
}: {
  readonly entryId: string;
  readonly signIn: CustomizeRowSignIn;
}): JSX.Element {
  return (
    <span
      data-testid={`customize-row-sign-in-${entryId}`}
      className="pointer-events-auto inline-flex shrink-0 items-center gap-1"
    >
      <ItemStateMark tone="sign-in" />
      <ControlButton
        presentation="customize-row-sign-in"
        data-testid={`customize-row-sign-in-${entryId}-action`}
        aria-label={signIn.accessibleName}
        aria-busy={signIn.busy || undefined}
        // Stays focusable while busy, so keyboard focus is not dropped.
        aria-disabled={signIn.busy || undefined}
        onClick={signIn.busy ? undefined : signIn.run}
      >
        {signIn.busy ? 'Signing in…' : 'Sign in'}
      </ControlButton>
    </span>
  );
}

/**
 * New Customize's update callout, on the status line: "↻ Update" with the
 * icon colored and the text plain, like every other callout.
 */
function UpdateCallout({
  entry,
  update,
}: {
  readonly entry: UnifiedPluginEntry;
  readonly update: CustomizeRowUpdate;
}): JSX.Element {
  return (
    <span
      data-testid={`customize-row-update-line-${entry.id}`}
      className="pointer-events-none relative z-10 inline-flex min-w-0 shrink-0 items-center gap-1 whitespace-nowrap"
    >
      <ItemStateMark tone="update" />
      {update.run === undefined ? (
        <span className="fg-primary">Update available</span>
      ) : (
        <ControlButton
          presentation="customize-row-sign-in"
          className="pointer-events-auto"
          data-testid={`customize-update-${entry.id}`}
          aria-label={`Update ${entry.name}`}
          aria-busy={update.busy || undefined}
          // Stays focusable while busy, so keyboard focus is not dropped.
          aria-disabled={update.busy || undefined}
          onClick={update.busy ? undefined : update.run}
        >
          {update.busy ? 'Updating…' : 'Update'}
        </ControlButton>
      )}
    </span>
  );
}

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
          owner ||
          entry.workflow?.sourceText?.replace(/^Shared by /, '') ||
          entry.ownershipLabel?.trim() ||
          (!entry.marketplaceProviders &&
          catalog &&
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
  health,
  attentionLabel,
  updateBadge = false,
  worksWith = false,
  harnessWarning,
  dimmed = false,
  signIn,
  failure,
  part = 'all',
  statusExtra,
}: {
  entry: UnifiedPluginEntry;
  metadata: ReturnType<typeof compactMetadata>;
  health?: ReactNode;
  attentionLabel?: string;
  updateBadge?: boolean;
  /** New Customize (CAN-6813): harness chips replace the installed marks. */
  worksWith?: boolean;
  /** New Customize (CAN-6815): harnesses one Add could not install for. */
  harnessWarning?: { readonly label: string; readonly instruction: string };
  /** A Disabled item; New Customize then shows no health. */
  dimmed?: boolean;
  /** New Customize: a pending sign-in, said as "⚠ Sign in". */
  signIn?: CustomizeRowSignIn;
  /** New Customize: a failed status change or Add; it outranks the rest. */
  failure?: CustomizeRowFailure;
  /**
   * New Customize splits a tile's text in two: `meta` is line 2 (publisher
   * and harness logos, always), `status` is line 3 (what needs action:
   * failure, sign-in, update). Without discovery one line holds both.
   */
  part?: 'all' | 'meta' | 'status';
  /** Callouts that join the status line, such as the update. */
  statusExtra?: ReactNode;
}): JSX.Element | null {
  const { tooltip, visibleCounts, triggerSummary } = metadata;
  // New Customize's line 2 (Sergii's QA): status or publisher, then the
  // harness logos. Tiles show no version; the detail view keeps it.
  const version = worksWith ? null : metadata.version;
  const failureShown = worksWith && failure !== undefined;
  const signInShown = !failureShown && worksWith && signIn !== undefined;
  // An integration row's installed line names the harness instead (CAN-6811).
  const hasWorksWith =
    worksWith &&
    ((entry.harnessRows?.length ?? 0) > 0 ||
      customizeWorksWithHarnesses(entry).length > 0);
  const hasHarnessIcons =
    !worksWith &&
    entry.integrationCopies?.installed === undefined &&
    (entry.installedHarnesses?.claude === true ||
      entry.installedHarnesses?.codex === true);
  const hasSourceMark =
    !worksWith &&
    !entry.marketplaceProviders &&
    entry.kind === 'plugin' &&
    (entry.origin === 'marketplace'
      ? Boolean(sourceLabelProvider(entry.sourceLabel))
      : entry.origin === 'shared' && Boolean(entry.sharedSourceProvider));
  const healthConnection = entry.connection ?? entry.aggregateConnection;
  const fallbackModel =
    !health &&
    !signInShown &&
    !failureShown &&
    // New Customize: a disabled item shows no health line (item 1).
    !(worksWith && (dimmed || healthConnection?.disabled === true)) &&
    healthConnection &&
    (healthConnection.status !== 'unknown' ||
      healthConnection.signIn ||
      healthConnection.disabled)
      ? mcpRowHealthModel(healthConnection)
      : undefined;
  // New Customize names a connection only when the person must act or it
  // failed (sign-in, Couldn't connect); otherwise the publisher shows.
  const fallbackHealth =
    worksWith &&
    fallbackModel !== undefined &&
    fallbackModel.tone !== 'attention' &&
    fallbackModel.tone !== 'destructive'
      ? undefined
      : fallbackModel;
  // An unreachable check and a pending sign-in can describe separate bindings.
  const hasIndependentSignIn =
    (entry.pendingSignIns ?? 0) > 0 &&
    healthConnection?.status === 'unreachable' &&
    !healthConnection.signIn &&
    !healthConnection.disabled;
  const warning =
    !signInShown &&
    (!failureShown ||
      (hasIndependentSignIn && failure?.alongsideSignIn === true)) &&
    (hasIndependentSignIn || (!health && !fallbackHealth))
      ? attentionLabel
      : undefined;
  const statusShown =
    failureShown ||
    signInShown ||
    Boolean(health) ||
    fallbackHealth !== undefined ||
    warning !== undefined ||
    harnessWarning !== undefined;
  const sourceText = metadata.source
    ? entrySourceTextWithoutProvider(entry, metadata.source)
    : metadata.source;
  // New Customize's line 2 always says the publisher in text, never only
  // harness logos; a status goes on line 3.
  const source =
    worksWith &&
    !sourceText &&
    !entry.bundledBy &&
    !triggerSummary &&
    visibleCounts.length === 0
      ? discoveryFallbackSource(entry)
      : sourceText;
  // A status used to take the publisher's place here; now both show, and a
  // manifest's publisher can name a person, so its text stays out of replay
  // while the status controls stay recordable.
  const sourceReplayClass =
    worksWith && statusShown ? ` ${REPLAY_BLOCK_CLASS}` : '';
  const providerBadges = worksWith ? undefined : entry.marketplaceProviders;
  const hasSubtitle = Boolean(
    hasHarnessIcons ||
    hasWorksWith ||
    source ||
    version ||
    visibleCounts.length > 0 ||
    triggerSummary ||
    entry.bundledBy ||
    hasSourceMark ||
    providerBadges?.length ||
    (entry.shareUpdateAvailable && !updateBadge && !worksWith),
  );
  const warningTestId =
    attentionLabel === undefined
      ? `plugins-connection-status-${entry.id}`
      : `customize-row-sign-in-${entry.id}`;
  const statusNodes = (
    <>
      {failureShown && failure !== undefined && (
        <CustomizeRowFailureStatus
          entryId={entry.id}
          name={entry.name}
          failure={failure}
        />
      )}
      {signInShown && signIn !== undefined && (
        <CustomizeRowSignInStatus entryId={entry.id} signIn={signIn} />
      )}
      {!signInShown && !failureShown && health}
      {fallbackHealth && (
        <McpRowHealth
          name={entry.name}
          model={fallbackHealth}
          testId={
            fallbackHealth.tone === 'attention'
              ? warningTestId
              : `plugins-connection-status-${entry.id}`
          }
        />
      )}
      {fallbackHealth && healthConnection?.provider === true && (
        <span
          className="text-3xs fg-secondary"
          data-testid={`plugins-connection-provider-${entry.id}`}
        >
          Agent provider
        </span>
      )}
      {warning !== undefined && (
        <McpRowAttention
          name={entry.name}
          label={warning}
          action={(entry.pendingSignIns ?? 0) > 0 ? 'connect' : null}
          showLabel={worksWith}
          testId={warningTestId}
        />
      )}
      {harnessWarning !== undefined && (
        <McpRowAttention
          name={entry.name}
          label={harnessWarning.label}
          instruction={harnessWarning.instruction}
          action={null}
          showLabel={worksWith}
          testId={`customize-row-harness-install-failed-${entry.id}`}
        />
      )}
    </>
  );
  if (part === 'status') {
    if (!statusShown && statusExtra === undefined) return null;
    return (
      <span
        data-testid={`customize-row-status-${entry.id}`}
        className="pointer-events-none relative z-10 flex min-h-4 min-w-0 items-center gap-3 overflow-hidden whitespace-nowrap text-xs fg-tertiary"
      >
        {statusNodes}
        {statusExtra}
      </span>
    );
  }
  if (!hasSubtitle && (part === 'meta' || !statusShown)) return null;
  return (
    <span
      data-testid={`customize-row-subtitle-${entry.id}`}
      className={`pointer-events-none relative z-10 mt-0.5 flex min-h-4 min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap text-xs fg-tertiary ${worksWith ? '@container/customize-row-subtitle ' : ''}${customizePublisherReplayClass(entry)}`}
    >
      {part === 'all' && statusNodes}
      {providerBadges?.map((provider) => (
        <Tooltip
          key={provider}
          label={`Available from the ${provider} marketplace`}
        >
          <Badge>{provider}</Badge>
        </Tooltip>
      ))}
      {/* The name line's Update badge, or New Customize's update line,
          already says so. */}
      {entry.shareUpdateAvailable === true && !updateBadge && !worksWith && (
        <Badge
          tone="info"
          icon={RefreshIcon}
          className="shrink-0"
          data-testid={`customize-row-update-available-${entry.id}`}
        >
          {INSTALLED_SHARE_UPDATE_AVAILABLE_LABEL}
        </Badge>
      )}
      {/* Where it's installed says more than the marketplace's mark, and one
          row of logos reads better than two. */}
      {hasHarnessIcons ? (
        <HarnessIcons entry={entry} />
      ) : (
        hasSourceMark &&
        entry.origin !== 'shared' && <EntrySourceProviderMark entry={entry} />
      )}
      {source && (
        <Tooltip
          label={
            <span className={REPLAY_BLOCK_CLASS}>
              {tooltip.includes(source)
                ? tooltip
                : [source, tooltip].filter(Boolean).join(' · ')}
            </span>
          }
          allowShrink
          className="pointer-events-auto"
        >
          <span
            data-testid={`customize-row-source-${entry.id}`}
            className={`min-w-0 truncate${sourceReplayClass}`}
          >
            {source}
          </span>
        </Tooltip>
      )}
      {!hasHarnessIcons && !worksWith && entry.origin === 'shared' && (
        <EntrySourceProviderMark entry={entry} />
      )}
      {source && version && <span aria-hidden>·</span>}
      {version && (
        <span
          data-testid={`customize-row-version-${entry.id}`}
          className="shrink-0"
        >
          {version}
        </span>
      )}
      {(source || version) && entry.bundledBy && <span aria-hidden>·</span>}
      {entry.bundledBy && (
        <span
          data-testid={`customize-row-from-plugin-${entry.id}`}
          className="truncate"
        >
          From {entry.bundledBy.name}
        </span>
      )}
      {(source || version || entry.bundledBy) && visibleCounts.length > 0 && (
        <span aria-hidden>·</span>
      )}
      {visibleCounts.length > 0 && (
        <span className="flex shrink-0 items-center gap-2">
          {visibleCounts.map(([count, kind, label]) => (
            <Tooltip
              key={kind}
              className="pointer-events-auto"
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
        triggerSummary && <span aria-hidden>·</span>}
      {triggerSummary && (
        <Tooltip
          label={
            <span className={REPLAY_BLOCK_CLASS}>
              {tooltip || triggerSummary}
            </span>
          }
          clamp={false}
          className="pointer-events-auto"
        >
          <span
            data-testid={`customize-row-trigger-${entry.id}`}
            className="min-w-0 truncate"
          >
            {triggerSummary}
          </span>
        </Tooltip>
      )}
      {hasWorksWith &&
        (source ||
          version ||
          entry.bundledBy ||
          visibleCounts.length > 0 ||
          triggerSummary) && <span aria-hidden>·</span>}
      {hasWorksWith && <CustomizeWorksWithChips entry={entry} />}
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
      className={`pointer-events-auto absolute ${entry.kind === 'collection' ? '-bottom-1.5 -right-1.5' : '-bottom-1 -right-1'} z-10 inline-flex overflow-visible`}
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

/**
 * A row's short kind label: MCP servers say `MCP` so the name keeps its room
 * (CAN-7856). Detail headers keep the full `MCP server`.
 */
function customizeRowTypeLabel(entry: UnifiedPluginEntry): string {
  return entry.kind === 'app' ? 'MCP' : (entry.typeLabel ?? '');
}

/** What the recommendation mark means; the row's description repeats it. */
const RECOMMENDED_HINT = 'Preferred MCP listing for this integration';

/**
 * The curated catalog's editorial pick (CAN-7856), as a small mark after the
 * name. It claims nothing about sign-in or vendor approval. The mark sits
 * inside the row's primary control, so it takes no focus of its own: its
 * label joins that control's accessible name and its hint joins the row's
 * description.
 */
function CustomizeRecommendedMark({
  entryId,
}: {
  readonly entryId: string;
}): JSX.Element {
  return (
    <Tooltip label={RECOMMENDED_HINT}>
      <span
        data-testid={`customize-row-recommended-${entryId}`}
        className="inline-flex h-4 w-4 shrink-0 items-center justify-center fg-tertiary"
      >
        <ThumbsUpIcon size="xs" ariaHidden />
        <span className="sr-only">Recommended</span>
      </span>
    </Tooltip>
  );
}

export interface CustomizeInstalledRowProps {
  readonly entry: UnifiedPluginEntry;
  /** Active product name supplied by the desktop or web host. */
  readonly brandName?: string;
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
  /**
   * New Customize (CAN-6810): an Update badge beside the name replaces the
   * Updates section, and the subtitle's share update badge.
   */
  readonly updateBadge?: boolean;
  /**
   * New Customize search (CAN-6812): a plugin row a search reached through
   * its skills names them on an "Includes" line.
   */
  readonly skillMatch?: CustomizeSkillMatch;
  readonly recommended?: boolean;
  /**
   * New Customize row polish (CAN-6813): Works with harness chips, and the
   * publisher's bundled mark for a row whose catalog supplies no logo.
   */
  readonly discovery?: boolean;
  /**
   * New Customize (CAN-6813): one split control replaces the status,
   * actions and ⋯ menu. Its caret lists the row's menu items.
   */
  readonly splitAction?: CustomizeRowSplitAction;
  /**
   * New Customize (CAN-6815): stages one harness that refused the server
   * again. Omit where the host cannot, and the row only says why.
   */
  readonly onRetryHarnessInstall?: (
    entry: UnifiedPluginEntry,
    failure: UnifiedEntryHarnessInstalls['failed'][number],
  ) => void;
  /**
   * New Customize (Sergii's QA, item 4): a pending sign-in, said on the
   * status line as "⚠ Sign in" instead of in the split control.
   */
  readonly signIn?: CustomizeRowSignIn;
  /**
   * New Customize (Sergii's QA, item 5): an available update, said on a
   * third line that only exists while one is available.
   */
  readonly update?: CustomizeRowUpdate;
  /**
   * New Customize (Sergii's QA): this row's failed status change or Add, on
   * its status line with Retry and the reason in a tooltip.
   */
  readonly failure?: CustomizeRowFailure;
  readonly McpServerLogoComponent?: ComponentType<McpServerLogoProps>;
}

/**
 * The "Includes" line of the Customize search design (CAN-6812), one line
 * at most (Sergii's QA): the first matched skill, then "+N more".
 */
function SkillMatchLine({
  entryId,
  match,
}: {
  entryId: string;
  match: CustomizeSkillMatch;
}): JSX.Element | null {
  const [first] = match.names;
  if (first === undefined) return null;
  const more = match.names.length - 1 + match.moreCount;
  return (
    <span
      data-testid={`customize-row-skill-match-${entryId}`}
      className="pointer-events-none relative z-10 flex min-w-0 max-w-full items-center gap-1 overflow-hidden whitespace-nowrap text-xs leading-5 fg-secondary"
    >
      <span className="inline-flex shrink-0">
        <SkillIcon size="xs" ariaHidden />
      </span>
      <span className="shrink-0">Includes</span>
      <mark className="min-w-0 truncate rounded bg-accent-subtle px-1 font-medium fg-primary">
        {first}
      </mark>
      {more > 0 && <span className="shrink-0">{`+${more} more`}</span>}
    </span>
  );
}

/**
 * An integration row's installed state (CAN-6811): the harness its copy is
 * installed for, and how many other installed copies it stands for.
 */
function IntegrationInstalledLine({
  entry,
}: {
  entry: UnifiedPluginEntry;
}): JSX.Element | null {
  const installed = customizeIntegrationInstalledLabel(entry);
  if (installed === undefined) return null;
  return (
    <span
      data-testid={`customize-row-installed-copies-${entry.id}`}
      className="pointer-events-none relative z-10 block min-w-0 truncate text-xs leading-5 fg-tertiary"
    >
      {installed.label}
      {installed.moreLabel !== undefined && ` · ${installed.moreLabel}`}
    </span>
  );
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
  brandName = 'this app',
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
  updateBadge = false,
  skillMatch,
  recommended = false,
  discovery = false,
  splitAction,
  onRetryHarnessInstall,
  signIn,
  update,
  failure,
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
  const connectMenuItems =
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
  // One Add for every harness (CAN-6815): New Customize only.
  const harnessFailures = discovery
    ? (entry.harnessInstalls?.failed ?? [])
    : [];
  const harnessWarning = customizeHarnessInstallWarning(
    harnessFailures,
    onRetryHarnessInstall !== undefined,
  );
  const rowMenuItems: readonly CustomizeRowMenuItem[] =
    onRetryHarnessInstall && harnessFailures.length > 0
      ? [
          ...connectMenuItems,
          ...harnessFailures.map(
            (failure): CustomizeRowMenuItem => ({
              id: `retry-harness-install-${failure.harness}`,
              label: customizeHarnessRetryLabel(failure.harness),
              onSelect: (): void => onRetryHarnessInstall(entry, failure),
            }),
          ),
        ]
      : connectMenuItems;
  const primaryProps = {
    id: domId,
    'aria-describedby': `${domId}-description`,
    'data-marketplace-entry': 'true',
    'data-testid': primaryTestId ?? `customize-row-${entry.id}`,
    'data-selected': selected ? 'true' : 'false',
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
  function onMetadataClick(event: MouseEvent<HTMLSpanElement>): void {
    const target = event.target;
    if (
      target instanceof Element &&
      !target.closest('a, button, [tabindex="0"], [role="tooltip"]') &&
      !event.defaultPrevented &&
      event.button === 0 &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.shiftKey &&
      !event.altKey
    ) {
      onSelect(entry);
    }
  }
  // The native action stretches across the row while focusable warning
  // controls in the subtitle remain its siblings.
  const title = (
    <span
      data-testid={`customize-row-name-line-${entry.id}`}
      className="@container/customize-row-name relative z-10 flex min-w-0 items-center gap-x-1.5 overflow-hidden"
    >
      {/* The line clips rather than spilling into the row's controls.
              The name truncates as space runs out;
              the kind and surface icon stay whole. Below 9rem the kind
              gives up its room: with the recommendation mark and both
              placement icons it would otherwise leave the name no width
              (CAN-7856). */}
      <Tooltip
        label={
          entry.description
            ? `${entry.name} · ${entry.description}`
            : entry.name
        }
        clamp={Boolean(entry.description)}
        delay="long"
        allowShrink
        replayBlock
      >
        <span className="min-w-0 truncate text-s font-medium fg-primary">
          {entry.name}
        </span>
      </Tooltip>
      {updateBadge && (
        <Badge
          tone="info"
          className="shrink-0"
          data-testid={`customize-row-update-badge-${entry.id}`}
        >
          Update
        </Badge>
      )}
      {showEntryType && entry.typeLabel && (
        <span className="flex shrink-0 @max-[9rem]/customize-row-name:hidden">
          <MarketplaceTypeLabel
            kind={entry.kind}
            label={customizeRowTypeLabel(entry)}
            dataTestId={`customize-row-type-${entry.id}`}
          />
        </span>
      )}
      {recommended && <CustomizeRecommendedMark entryId={entry.id} />}
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
    </span>
  );
  const metadataProps = {
    entry,
    metadata,
    health,
    attentionLabel,
    updateBadge,
    worksWith: discovery,
    harnessWarning,
    dimmed,
    signIn: discovery ? signIn : undefined,
    failure: discovery ? failure : undefined,
  };
  const metadataLine = (
    <CompactMetadata {...metadataProps} part={discovery ? 'meta' : 'all'} />
  );
  // New Customize's line 3 holds what needs action: a failure, a pending
  // sign-in, an update. Icons carry the color; the text is plain.
  const statusLine = discovery ? (
    <CompactMetadata
      {...metadataProps}
      part="status"
      statusExtra={
        update !== undefined ? (
          <UpdateCallout entry={entry} update={update} />
        ) : undefined
      }
    />
  ) : undefined;
  // New Customize replaces the "Installed for" line (item 7).
  const installedLine = discovery ? undefined : (
    <IntegrationInstalledLine entry={entry} />
  );
  // New Customize: the logo chain a detail page reads too.
  const discoveryLogo = discovery ? customizeEntryLogo(entry) : undefined;
  const curatedHarnesses = customizeWorksWithHarnesses(entry);
  const curatedHarnessNames = CUSTOMIZE_DISCOVERY_HARNESS_OPTIONS.filter(
    ({ value }) => curatedHarnesses.includes(value),
  )
    .map(({ label }) => label)
    .join(', ');
  const logoKey = discoveryLogo
    ? discoveryLogo.curatedKey
    : curatedLogoKey(entry);
  // Opacity on the control itself would dim its focus ring, so the content
  // wrapper carries it.
  const content = (
    <span
      role="presentation"
      data-testid={`customize-row-content-${entry.id}`}
      className={`relative isolate flex flex-1 items-center gap-3 rounded-xl py-2.5 outline-offset-2 has-[[data-marketplace-entry]:focus-visible]:outline-2 has-[[data-marketplace-entry]:focus-visible]:outline-line-focus pointer-coarse:min-h-11 ${compactMcp ? 'min-w-0 pl-4 pr-0' : 'min-w-32 px-4'} ${selected ? 'bg-selected' : ''}`}
      onClick={onMetadataClick}
    >
      <span
        className={`pointer-events-none relative inline-flex shrink-0 overflow-visible${dimmed ? ' opacity-60' : ''}`}
      >
        <McpServerLogoComponent
          curatedKey={logoKey}
          logoUrl={entry.logoUrl}
          bundledLogo={discoveryLogo?.bundledLogo ?? entry.bundledLogo}
          brandMark={entry.brandMark}
          size={28}
          fallback="monogram"
          name={entry.name}
          // New Customize: every item is a rounded square; people stay round.
          shape={discovery ? 'tile' : 'circle'}
          plate={discovery}
          fit="contain"
        />
        {createdByViewer(entry) && !entry.installedFrom && (
          <CustomItemBadge entry={entry} selected={selected} />
        )}
        {discovery &&
          entry.ref.type === 'curated-mcp' &&
          entry.curatedManagedConnection === true && (
            <span className="pointer-events-auto absolute -bottom-1 -right-1 z-20 inline-flex rounded-full bg-base">
              <Tooltip
                label={`We recommend ${brandName}'s curated connectors because ${brandName} manages the connection and makes it available across supported harnesses. Connect ${entry.name} once and use it with ${curatedHarnessNames || 'its supported agents'}. Plugins from other catalogs may require separate setup or have compatibility limitations.`}
                showOnPress
              >
                <span
                  tabIndex={0}
                  role="img"
                  aria-label={`${brandName}-curated connector`}
                  data-testid={`customize-row-curated-connector-${entry.id}`}
                  className="inline-flex size-5 items-center justify-center rounded-full bg-base"
                >
                  <McpServerLogoComponent
                    brandMark
                    name={brandName}
                    size={20}
                    shape="circle"
                    chrome="transparent"
                    fallback="icon"
                  />
                </span>
              </Tooltip>
            </span>
          )}
      </span>
      <span className={`min-w-0 flex-1${dimmed ? ' opacity-60' : ''}`}>
        {href !== undefined ? (
          <a
            {...primaryProps}
            className="block min-w-0 text-left outline-none after:absolute after:inset-0"
            href={href}
            onClick={onLinkClick}
          >
            {title}
          </a>
        ) : (
          <ControlButton
            presentation="customize-installed-primary"
            {...primaryProps}
            type="button"
            onClick={() => onSelect(entry)}
          >
            {title}
          </ControlButton>
        )}
        {skillMatch ||
        statusLine != null ||
        (installedLine !== undefined && entry.integrationCopies?.installed) ? (
          <span
            className={`flex min-w-0 flex-col ${discovery ? 'gap-0.5' : 'gap-1'}`}
          >
            {metadataLine}
            {/* Line 3 holds what needs action; it wins over the search hint. */}
            {skillMatch && (!discovery || update === undefined) && (
              <SkillMatchLine entryId={entry.id} match={skillMatch} />
            )}
            {installedLine}
            {statusLine}
          </span>
        ) : (
          metadataLine
        )}
      </span>
    </span>
  );
  return (
    <ListRowFrame
      layout="customize-installed"
      as="li"
      state={compactMcp ? 'compact-control' : 'wrapping-control'}
      data-testid={`customize-${sectionId}-row-${entry.id}`}
      data-dimmed={dimmed ? 'true' : undefined}
    >
      {content}
      <span
        id={`${domId}-description`}
        className={`sr-only ${REPLAY_BLOCK_CLASS}`}
      >
        {[
          entry.description,
          metadata.tooltip,
          recommended ? RECOMMENDED_HINT : undefined,
        ]
          .filter(Boolean)
          .join(' · ')}
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
        {values}
        {splitAction !== undefined && (
          <CustomizeRowSplitButton
            entryName={entry.name}
            idPrefix={domId}
            action={splitAction}
            items={rowMenuItems.filter(
              (item) => !splitAction.omitItemIds?.includes(item.id),
            )}
            testId={menuTestId ?? `customize-row-menu-${entry.id}`}
          />
        )}
        {splitAction === undefined && status}
        {splitAction === undefined && actions && (
          <span className="flex shrink-0 items-center justify-end">
            {actions}
          </span>
        )}
        {splitAction === undefined && rowMenuItems.length > 0 && (
          <span className="flex w-7 shrink-0 justify-end pointer-coarse:w-11">
            <CustomizeRowMenu
              entryName={entry.name}
              idPrefix={domId}
              items={rowMenuItems}
              testId={menuTestId ?? `customize-row-menu-${entry.id}`}
            />
          </span>
        )}
      </div>
    </ListRowFrame>
  );
}
