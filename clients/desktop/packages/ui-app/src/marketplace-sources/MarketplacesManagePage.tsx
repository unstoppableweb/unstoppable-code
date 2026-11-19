'use client';

import { useRef, useState, type JSX, type ReactNode } from 'react';
import type { MarketplaceSource } from '@canopy/app-core/client';
import {
  Badge,
  Button,
  CustomizeRowMenu,
  DataTable,
  DisplayAvatar,
  ErrorBanner,
  ErrorState,
  Heading,
  LoadingSpinner,
  Notice,
  NoticeButton,
  PageHeader,
  Stack,
  TableActionsCell,
  type CustomizeRowMenuItem,
  type DataTableColumn,
} from '@canopy/ui-shared/components';
import { ClaudeLogo, CodexLogo } from '@canopy/ui-shared/icons';
import { PlusIcon } from '@canopy/ui-shared/icons/AppIcons';
import { formatRelativeTime } from '@canopy/ui-shared/lib';
import { REPLAY_MASK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import { marketplaceSourcePluginCountLabel } from './source-plugins';
import type { UseMarketplaceSourcesResult } from './useMarketplaceSources';
import { MarketplaceSourceRemoveDialog } from './MarketplaceSourceRemoveDialog';
import { MarketplaceSourceInvalidBanner } from './MarketplaceSourceInvalidBanner';
import type { MarketplaceSourceRemoveConfirmation } from './MarketplaceSourcesList';
import {
  marketplaceSourceInstalledCount,
  marketplaceSourceProvider,
  marketplaceSourceTag,
  marketplaceUpdatesLabel,
  marketplaceUpdatesMessage,
  marketplaceUpdatesSummary,
  type MarketplaceSourceUpdateCounts,
} from './marketplace-manage';

export interface MarketplacesManagePageProps {
  readonly state: UseMarketplaceSourcesResult;
  /** The back link's target and label (`Customize`). */
  readonly back: { readonly label: string; readonly onClick: () => void };
  /** Opens the host's existing add flow; absent when adding is unavailable. */
  readonly onAddMarketplace?: () => void;
  readonly onOpenSource: (sourceId: string) => void;
  /** Host copy (brand helpers) shown before Remove is called. */
  readonly removeConfirmation?: (
    source: MarketplaceSource,
  ) => MarketplaceSourceRemoveConfirmation;
  /**
   * Updates per source id. Hosts that cannot detect updates omit it, which
   * hides the banner and every row's update state.
   */
  readonly updateCounts?: MarketplaceSourceUpdateCounts;
  /** The banner's Review: opens the host's list of updates. */
  readonly onReviewUpdates?: () => void;
  /** `none` when the host already insets the page top (the web frame). */
  readonly headerInset?: 'page' | 'none';
}

const TEST_ID = 'marketplaces-page';

function defaultRemoveConfirmation(
  source: MarketplaceSource,
): MarketplaceSourceRemoveConfirmation {
  return {
    title: (
      <>
        Remove <span className={REPLAY_MASK_CLASS}>{source.name}</span>?
      </>
    ),
    message:
      'The marketplace is removed from your list. Plugins you already installed stay installed.',
  };
}

/**
 * A marketplace's mark: its avatar, with the Claude or Codex glyph for a
 * provider marketplace. The list row and the detail page wear the same one.
 */
export function MarketplaceSourceLogo({
  source,
  size = 'lg',
}: {
  source: MarketplaceSource;
  size?: 'lg' | 'xl';
}): JSX.Element {
  const provider = marketplaceSourceProvider(source);
  const Logo =
    provider === 'Claude'
      ? ClaudeLogo
      : provider === 'Codex'
        ? CodexLogo
        : undefined;
  return (
    <DisplayAvatar
      name={source.name}
      subject="group"
      size={size}
      replayBlocked
      className="shrink-0"
      glyph={Logo ? <Logo width={16} height={16} aria-hidden /> : undefined}
      data-provider={provider?.toLowerCase()}
    />
  );
}

function busyLabel(
  state: UseMarketplaceSourcesResult,
  sourceId: string,
): string | undefined {
  const operation = state.operations[sourceId];
  return (
    state.sourceProgress[sourceId] ??
    (operation === 'update'
      ? 'Updating…'
      : operation === 'remove'
        ? 'Removing…'
        : operation === 'install'
          ? 'Installing…'
          : undefined)
  );
}

/**
 * The Marketplaces page (CAN-6814, New Customize): every marketplace source
 * with its counts and actions, an updates banner, and Check now. A new layout
 * over the existing source operations; adding stays the host's existing flow.
 * Shared by desktop and Portal.
 */
export function MarketplacesManagePage({
  state,
  back,
  onAddMarketplace,
  onOpenSource,
  removeConfirmation = defaultRemoveConfirmation,
  updateCounts,
  onReviewUpdates,
  headerInset = 'page',
}: MarketplacesManagePageProps): JSX.Element {
  const [pendingRemoval, setPendingRemoval] =
    useState<MarketplaceSource | null>(null);
  const [updatingAll, setUpdatingAll] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const { sources, loading, listError, refreshing } = state;
  const anyBusy =
    refreshing || loading || Object.keys(state.operations).length > 0;
  const summary = marketplaceUpdatesSummary(sources ?? [], updateCounts);

  const updateAll = async (ids: readonly string[]): Promise<void> => {
    setUpdatingAll(true);
    try {
      // One at a time: the source operations refuse overlapping work.
      for (const id of ids) await state.update(id);
    } finally {
      setUpdatingAll(false);
    }
  };

  const installedCell = (source: MarketplaceSource): ReactNode => {
    const installed = marketplaceSourceInstalledCount(source);
    const updates = updateCounts?.[source.id];
    if (installed === undefined) return '—';
    if (updateCounts === undefined) return String(installed);
    return (
      <span>
        {installed} ·{' '}
        {updates !== undefined && updates > 0 ? (
          <span className="fg-accent">{marketplaceUpdatesLabel(updates)}</span>
        ) : (
          'Up to date'
        )}
      </span>
    );
  };

  const menuItems = (source: MarketplaceSource): CustomizeRowMenuItem[] => {
    const busy = state.operations[source.id] !== undefined || refreshing;
    return [
      {
        id: 'open',
        label: 'View plugins',
        onSelect: () => onOpenSource(source.id),
      },
      ...(source.actions.update
        ? [
            {
              id: 'update',
              label: 'Update',
              disabled: busy,
              onSelect: () => void state.update(source.id),
            },
          ]
        : []),
      ...(source.actions.remove
        ? [
            {
              id: 'remove',
              label: 'Remove…',
              destructive: true,
              disabled: busy,
              onSelect: () => setPendingRemoval(source),
            },
          ]
        : []),
    ];
  };

  const columns: DataTableColumn<MarketplaceSource>[] = [
    {
      key: 'marketplace',
      header: 'Marketplace',
      rowHeader: true,
      overflow: 'truncate',
      render: (source) => {
        const tag = marketplaceSourceTag(source);
        const busy = busyLabel(state, source.id);
        return (
          <span className="flex min-w-0 items-center gap-3 py-2">
            <MarketplaceSourceLogo source={source} />
            <span className="flex min-w-0 flex-col">
              <span className="flex min-w-0 items-center gap-2">
                <span
                  className={`truncate font-medium fg-primary ${REPLAY_MASK_CLASS}`}
                >
                  {source.name}
                </span>
                {tag ? <Badge>{tag}</Badge> : null}
                {source.status.state === 'invalid' ? (
                  <Badge tone="danger">Invalid</Badge>
                ) : null}
                {busy ? (
                  <span
                    role="status"
                    className={`inline-flex shrink-0 items-center gap-1.5 text-xs fg-secondary ${REPLAY_MASK_CLASS}`}
                  >
                    <LoadingSpinner decorative />
                    {busy}
                  </span>
                ) : null}
              </span>
              <span
                className={`truncate font-mono text-xs fg-tertiary ${REPLAY_MASK_CLASS}`}
              >
                {source.sourceLabel}
              </span>
            </span>
          </span>
        );
      },
    },
    {
      key: 'items',
      header: 'Items',
      render: (source) => marketplaceSourcePluginCountLabel(source.pluginCount),
    },
    {
      key: 'installed',
      header: 'Installed',
      render: installedCell,
    },
    {
      key: 'actions',
      header: 'Actions',
      headerHidden: true,
      align: 'right',
      render: (source) => (
        <TableActionsCell>
          <CustomizeRowMenu
            entryName={source.name}
            idPrefix={`${TEST_ID}-${source.id}`}
            items={menuItems(source)}
            testId={`${TEST_ID}-row-menu`}
          />
        </TableActionsCell>
      ),
    },
  ];

  const messages = (sources ?? []).flatMap((source) => {
    const error = state.sourceErrors[source.id];
    const warning = state.sourceWarnings[source.id];
    const items: ReactNode[] = [];
    if (source.status.state === 'invalid')
      items.push(
        <MarketplaceSourceInvalidBanner
          key={`${source.id}-invalid`}
          source={source}
          state={state}
        />,
      );
    if (error || warning)
      items.push(
        <Notice
          key={`${source.id}-message`}
          errorSource="marketplace-source-message"
          errorRecordingDisabled={
            error !== undefined && state.recordedErrors.has(error)
          }
          intent={error ? 'destructive' : 'attention'}
          data-testid="marketplace-source-message"
          onDismiss={() => state.dismissSourceMessage(source.id)}
        >
          <span className={REPLAY_MASK_CLASS}>
            {source.name}: {error ?? warning}
          </span>
        </Notice>,
      );
    return items;
  });

  const confirmation = pendingRemoval
    ? removeConfirmation(pendingRemoval)
    : null;
  const removing =
    pendingRemoval !== null && state.operations[pendingRemoval.id] === 'remove';

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      className="outline-none"
      data-testid={TEST_ID}
    >
      <Stack gap="section">
        <PageHeader
          title="Marketplaces"
          description="Where your plugins, skills and MCP servers come from. Updates and sources are managed here."
          inset={headerInset}
          back={{
            label: back.label,
            onClick: back.onClick,
            testId: `${TEST_ID}-back`,
          }}
          actions={
            onAddMarketplace ? (
              <Button
                size="compact"
                variant="primary"
                onClick={onAddMarketplace}
                data-testid={`${TEST_ID}-add`}
              >
                <PlusIcon size="sm" aria-hidden />
                Add marketplace
              </Button>
            ) : undefined
          }
        />
        {summary ? (
          <Notice
            intent="neutral"
            icon={null}
            data-testid={`${TEST_ID}-updates`}
            actions={
              <>
                {onReviewUpdates ? (
                  <NoticeButton
                    onClick={onReviewUpdates}
                    data-testid={`${TEST_ID}-updates-review`}
                  >
                    Review
                  </NoticeButton>
                ) : null}
                <NoticeButton
                  variant="primary"
                  disabled={anyBusy || updatingAll}
                  onClick={() => void updateAll(summary.sourceIds)}
                  data-testid={`${TEST_ID}-updates-update-all`}
                >
                  Update all
                </NoticeButton>
              </>
            }
          >
            <span className="inline-flex items-center gap-2">
              <Badge tone="info">
                {marketplaceUpdatesLabel(summary.updates)}
              </Badge>
              {marketplaceUpdatesMessage(summary.sourceIds.length)}
            </span>
          </Notice>
        ) : null}
        <Stack gap="item">
          <div className="flex min-w-0 items-center justify-between gap-3">
            <span className="flex items-baseline gap-2">
              <Heading level={2} variant="section">
                Sources
              </Heading>
              {sources !== null ? (
                <span
                  className="text-s fg-quaternary"
                  data-testid={`${TEST_ID}-count`}
                >
                  {sources.length}
                </span>
              ) : null}
            </span>
            <span
              className="flex items-center gap-1 text-xs fg-tertiary"
              aria-live="polite"
              data-testid={`${TEST_ID}-last-checked`}
            >
              {state.listProgress ??
                (state.lastRefreshedAt
                  ? `Last checked ${formatRelativeTime(state.lastRefreshedAt)}`
                  : null)}
              {state.listProgress === null && state.lastRefreshedAt ? (
                <span aria-hidden>·</span>
              ) : null}
              <Button
                variant="link"
                disabled={anyBusy}
                onClick={() => void state.refresh()}
                data-testid={`${TEST_ID}-check-now`}
              >
                {refreshing ? 'Checking…' : 'Check now'}
              </Button>
            </span>
          </div>
          {sources !== null ? (
            <ErrorBanner
              errorSource="marketplace-sources-refresh-error"
              className=""
              error={listError}
              blockMessageFromReplay
              testId="marketplace-sources-refresh-error"
            />
          ) : null}
          {messages.length > 0 ? <Stack gap="tight">{messages}</Stack> : null}
          {!loading && sources === null ? (
            <ErrorState
              testId="marketplace-sources-load-error"
              message={
                <span className={REPLAY_MASK_CLASS}>
                  {listError ?? "Couldn't load marketplaces."}
                </span>
              }
              onRetry={() => void state.reload()}
            />
          ) : (
            <DataTable
              caption="Marketplaces"
              columns={columns}
              rows={sources ?? []}
              rowKey={(source) => source.id}
              loading={loading}
              emptyLabel="No marketplaces yet"
              onRowActivate={(source) => onOpenSource(source.id)}
              rowAttributes={(source) => ({
                'data-source-id': source.id,
                'data-source-state': source.status.state,
                'data-busy': state.operations[source.id] !== undefined,
              })}
              testId={`${TEST_ID}-sources`}
            />
          )}
        </Stack>
      </Stack>
      {pendingRemoval && confirmation ? (
        <MarketplaceSourceRemoveDialog
          title={confirmation.title}
          message={confirmation.message}
          busy={removing}
          restoreFocusRef={rootRef}
          onCancel={() => setPendingRemoval(null)}
          onConfirm={() => {
            const target = pendingRemoval;
            void state.remove(target.id).finally(() => {
              setPendingRemoval((current) =>
                current?.id === target.id ? null : current,
              );
            });
          }}
        />
      ) : null}
    </div>
  );
}
