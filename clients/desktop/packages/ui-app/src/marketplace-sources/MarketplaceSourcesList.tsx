'use client';

import { Badge } from '@canopy/ui-shared/components/Badge';
import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react';
import type { MarketplaceSource } from '@canopy/app-core/client';
import {
  Button,
  DelayedLoadingPlaceholder,
  EmptyState,
  ErrorBanner,
  ErrorState,
  LoadingSpinner,
  MissingPluginsBadge,
  RefreshButton,
  ProviderSupportIcons,
  Skeleton,
  Notice,
} from '@canopy/ui-shared/components';
import { formatRelativeTime } from '@canopy/ui-shared/lib';
import { REPLAY_MASK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import {
  countSourcePluginsNeedingInstall,
  marketplaceSourcePluginCountLabel,
} from './source-plugins';
import type { UseMarketplaceSourcesResult } from './useMarketplaceSources';
import { MarketplaceSourceRemoveDialog } from './MarketplaceSourceRemoveDialog';
import { MarketplaceSourceInvalidBanner } from './MarketplaceSourceInvalidBanner';

export interface MarketplaceSourceRemoveConfirmation {
  readonly title: ReactNode;
  readonly message: ReactNode;
}

export interface MarketplaceSourcesListProps {
  readonly state: UseMarketplaceSourcesResult;
  readonly onOpenSource: (sourceId: string) => void;
  /** Host copy (brand helpers) shown before Remove is called. */
  readonly removeConfirmation?: (
    source: MarketplaceSource,
  ) => MarketplaceSourceRemoveConfirmation;
  /** Optional host Add entry point; existing add dialogs stay host-owned. */
  readonly addAction?: ReactNode;
}

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

function sampleSource(
  id: string,
  name: string,
  description: string,
): MarketplaceSource {
  return {
    id,
    name,
    description,
    kind: 'github',
    sourceLabel: `acme/${name.toLowerCase().replace(/ /gu, '-')}`,
    status: { state: 'valid', errors: [] },
    pluginCount: 4,
    actions: { update: true, remove: true },
    plugins: [],
  };
}

/** Plain marketplaces the loading skeleton measures. */
const SAMPLE_SOURCES: readonly MarketplaceSource[] = [
  sampleSource(
    'marketplace-skeleton-1',
    'Team plugins',
    'Plugins the team shares',
  ),
  sampleSource(
    'marketplace-skeleton-2',
    'Release tools',
    'Tools for shipping releases',
  ),
];

const noop = (): void => undefined;

/** Marketplaces tab body: source rows with Refresh, Update and Remove. */
export function MarketplaceSourcesList({
  state,
  onOpenSource,
  removeConfirmation = defaultRemoveConfirmation,
  addAction,
}: MarketplaceSourcesListProps): JSX.Element {
  const [pendingRemoval, setPendingRemoval] =
    useState<MarketplaceSource | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const { sources, loading, listError, refreshing } = state;
  useEffect(() => {
    listRef.current?.focus();
  }, []);

  const header = (
    <div className="flex items-center justify-between gap-3">
      <p
        className="text-xs fg-tertiary"
        data-testid="marketplace-sources-last-refreshed"
        aria-live="polite"
      >
        {state.listProgress ??
          (state.lastRefreshedAt
            ? `Last refreshed ${formatRelativeTime(state.lastRefreshedAt)}`
            : null)}
      </p>
      <div className="flex items-center gap-2">
        {addAction}
        <RefreshButton
          onClick={() => void state.refresh()}
          busy={refreshing}
          disabled={
            refreshing || loading || Object.keys(state.operations).length > 0
          }
          ariaLabel="Refresh marketplaces"
          title="Refresh marketplaces"
          dataTestId="marketplace-sources-refresh"
        />
      </div>
    </div>
  );

  let body: ReactNode;
  if (loading) {
    body = (
      <DelayedLoadingPlaceholder slowNote="Still loading marketplaces…">
        <Skeleton
          loading
          label="Loading marketplaces"
          testId="marketplace-sources-loading"
        >
          <ul className="flex flex-col divide-y">
            {SAMPLE_SOURCES.map((source) => (
              <MarketplaceSourceRow
                key={source.id}
                source={source}
                state={state}
                onOpen={noop}
                onRemove={noop}
              />
            ))}
          </ul>
        </Skeleton>
      </DelayedLoadingPlaceholder>
    );
  } else if (sources === null) {
    body = (
      <ErrorState
        testId="marketplace-sources-load-error"
        message={
          <span className={REPLAY_MASK_CLASS}>
            {listError ?? "Couldn't load marketplaces."}
          </span>
        }
        onRetry={() => void state.reload()}
      />
    );
  } else if (sources.length === 0) {
    body = (
      <EmptyState
        testId="marketplace-sources-empty"
        title="No marketplaces yet"
      />
    );
  } else {
    body = (
      <ul
        className="flex flex-col divide-y"
        data-testid="marketplace-sources-list"
      >
        {sources.map((source) => (
          <MarketplaceSourceRow
            key={source.id}
            source={source}
            state={state}
            onOpen={() => onOpenSource(source.id)}
            onRemove={() => setPendingRemoval(source)}
          />
        ))}
      </ul>
    );
  }

  const confirmation = pendingRemoval
    ? removeConfirmation(pendingRemoval)
    : null;
  const removing =
    pendingRemoval !== null && state.operations[pendingRemoval.id] === 'remove';

  return (
    <div
      ref={listRef}
      tabIndex={-1}
      className="flex flex-col gap-4 outline-none"
      data-testid="marketplace-sources"
    >
      {header}
      {sources !== null && (
        <ErrorBanner
          errorSource="marketplace-sources-refresh-error"
          className=""
          error={listError}
          blockMessageFromReplay
          testId="marketplace-sources-refresh-error"
        />
      )}
      {body}
      {pendingRemoval && confirmation && (
        <MarketplaceSourceRemoveDialog
          title={confirmation.title}
          message={confirmation.message}
          busy={removing}
          restoreFocusRef={listRef}
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
      )}
    </div>
  );
}

interface MarketplaceSourceRowProps {
  readonly source: MarketplaceSource;
  readonly state: UseMarketplaceSourcesResult;
  readonly onOpen: () => void;
  readonly onRemove: () => void;
}

function MarketplaceSourceRow({
  source,
  state,
  onOpen,
  onRemove,
}: MarketplaceSourceRowProps): JSX.Element {
  const operation = state.operations[source.id];
  const busy = operation !== undefined;
  const error = state.sourceErrors[source.id];
  const warning = state.sourceWarnings[source.id];
  const progress = state.sourceProgress[source.id];
  const missing = state.canInstall
    ? countSourcePluginsNeedingInstall(source)
    : 0;
  const invalid = source.status.state === 'invalid';
  const busyLabel =
    progress ??
    (operation === 'update'
      ? 'Updating…'
      : operation === 'remove'
        ? 'Removing…'
        : operation === 'install'
          ? 'Installing…'
          : undefined);

  return (
    <li
      className="flex flex-col gap-2 py-3"
      data-testid="marketplace-source-row"
      data-source-id={source.id}
      data-source-state={source.status.state}
      aria-busy={busy}
    >
      <div className="flex items-start justify-between gap-3">
        <button
          type="button"
          onClick={onOpen}
          className="focus-ring min-w-0 flex-1 rounded text-left"
          data-testid="marketplace-source-open"
        >
          <span className="flex items-center gap-2">
            <span
              className={`truncate text-s font-medium fg-primary ${REPLAY_MASK_CLASS}`}
            >
              {source.name}
            </span>
            {invalid && <Badge tone="danger">Invalid</Badge>}
            {source.status.state === 'syncing' && (
              <span className="shrink-0 text-3xs fg-tertiary">Syncing…</span>
            )}
            {source.providerStatus && (
              <ProviderSupportIcons
                support={{
                  claude:
                    source.providerStatus.claude?.state === 'valid'
                      ? 'native'
                      : 'none',
                  codex:
                    source.providerStatus.codex?.state === 'valid'
                      ? 'native'
                      : source.providerStatus.claude?.state === 'valid'
                        ? 'compat'
                        : 'none',
                }}
              />
            )}
            <MissingPluginsBadge
              count={missing}
              testId="marketplace-source-missing-count"
            />
          </span>
          <span className="mt-0.5 flex items-center gap-2 text-xs fg-tertiary">
            <span className={`truncate ${REPLAY_MASK_CLASS}`}>
              {source.sourceLabel}
            </span>
            <span aria-hidden>·</span>
            <span className="shrink-0">
              {marketplaceSourcePluginCountLabel(source.pluginCount)}
            </span>
          </span>
          {source.description && (
            <span
              className={`mt-1 line-clamp-2 block text-xs fg-secondary ${REPLAY_MASK_CLASS}`}
            >
              {source.description}
            </span>
          )}
        </button>
        <div className="flex shrink-0 items-center gap-2">
          {busyLabel && (
            <span
              role="status"
              className={`inline-flex items-center gap-1.5 text-xs fg-secondary ${REPLAY_MASK_CLASS}`}
            >
              <LoadingSpinner decorative />
              {busyLabel}
            </span>
          )}
          {source.actions.update && (
            <Button
              size="compact"
              variant="secondary"
              disabled={busy}
              onClick={() => void state.update(source.id)}
              data-testid="marketplace-source-update"
            >
              Update
            </Button>
          )}
          {source.actions.remove && (
            <Button
              size="compact"
              variant="ghost"
              disabled={busy}
              onClick={onRemove}
              data-testid="marketplace-source-remove"
            >
              Remove
            </Button>
          )}
        </div>
      </div>
      {invalid && (
        <MarketplaceSourceInvalidBanner source={source} state={state} />
      )}
      {(error || warning) && (
        <Notice
          errorSource="marketplace-source-message"
          intent={error ? 'destructive' : 'attention'}
          data-testid="marketplace-source-message"
        >
          <span className={REPLAY_MASK_CLASS}>{error ?? warning}</span>
        </Notice>
      )}
    </li>
  );
}
