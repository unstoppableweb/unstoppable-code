'use client';

import { useState, type JSX } from 'react';
import type { SharedArtifactsClient } from '@canopy/app-core';
import {
  useSharedArtifactList,
  type SharedArtifactListQuery,
} from '@canopy/app-state/shared-artifacts';
import type { SharedArtifact } from '@canopy/protocol/canopy-core';
import { Button, ErrorBanner, Stack } from '@canopy/ui-shared/components';
import {
  Badge,
  CenteredLoadingSpinner,
  ListRow,
  TabBar,
} from '@canopy/ui-shared/primitives';
import {
  SHARED_ARTIFACT_AUDIENCE_LABELS,
  SHARED_ARTIFACT_COPY,
  SHARED_ARTIFACT_KIND_LABELS,
} from './shared-artifact-copy';
import {
  formatSharedArtifactTime,
  isSharedArtifactEffectivelyPublic,
  isSharedArtifactPublicLinkPaused,
} from './shared-artifact-view-model';

function SharedArtifactRow({
  artifact,
  showOwner,
  onOpen,
}: {
  readonly artifact: SharedArtifact;
  readonly showOwner: boolean;
  readonly onOpen: (artifactId: string) => void;
}): JSX.Element {
  const facts = [
    SHARED_ARTIFACT_KIND_LABELS[artifact.kind],
    SHARED_ARTIFACT_AUDIENCE_LABELS[artifact.shareScope],
    ...(showOwner && artifact.owner.name ? [artifact.owner.name] : []),
    formatSharedArtifactTime(artifact.updatedAt),
  ].filter((fact) => fact !== '');
  const badge = isSharedArtifactEffectivelyPublic(artifact) ? (
    <Badge tone="info" size="compact">
      {SHARED_ARTIFACT_COPY.badgePublic}
    </Badge>
  ) : isSharedArtifactPublicLinkPaused(artifact) ? (
    <Badge tone="warning" size="compact">
      {SHARED_ARTIFACT_COPY.badgePaused}
    </Badge>
  ) : undefined;
  return (
    <ListRow
      type="button"
      description={facts.join(' · ')}
      {...(badge === undefined ? {} : { trailing: badge })}
      onClick={(): void => onOpen(artifact.id)}
      data-testid={`shared-artifact-row-${artifact.id}`}
    >
      {artifact.title}
    </ListRow>
  );
}

/** One paged list of artifacts with its loading, empty and error states. */
export function SharedArtifactListBody({
  client,
  query,
  emptyLabel,
  showOwner,
  onOpen,
}: {
  readonly client: SharedArtifactsClient | null;
  readonly query: SharedArtifactListQuery;
  readonly emptyLabel: string;
  readonly showOwner: boolean;
  readonly onOpen: (artifactId: string) => void;
}): JSX.Element | null {
  const { state, loadMore, retry } = useSharedArtifactList(client, query);
  if (state.status === 'unavailable') return null;
  if (state.status === 'loading')
    return (
      <div className="flex min-h-24" data-testid="shared-artifact-list-loading">
        <CenteredLoadingSpinner spacing="section" />
      </div>
    );
  if (state.status === 'failed')
    return (
      <ErrorBanner
        className=""
        errorSource="shared-artifact-list"
        blockMessageFromReplay={false}
        error={SHARED_ARTIFACT_COPY.listFailed}
        onRetry={retry}
        testId="shared-artifact-list-error"
      />
    );
  if (state.artifacts.length === 0)
    return (
      <p
        className="text-s fg-secondary"
        data-testid="shared-artifact-list-empty"
      >
        {emptyLabel}
      </p>
    );
  return (
    <Stack gap="item">
      <Stack gap="tight" data-testid="shared-artifact-list-rows">
        {state.artifacts.map((artifact) => (
          <SharedArtifactRow
            key={artifact.id}
            artifact={artifact}
            showOwner={showOwner}
            onOpen={onOpen}
          />
        ))}
      </Stack>
      {state.loadMoreFailure !== null && (
        <ErrorBanner
          className=""
          errorSource="shared-artifact-list-more"
          blockMessageFromReplay={false}
          error={SHARED_ARTIFACT_COPY.listLoadMoreFailed}
        />
      )}
      {state.nextCursor !== null && (
        <Button
          type="button"
          variant="secondary"
          size="compact"
          className="self-start"
          loading={state.loadingMore}
          onClick={loadMore}
          data-testid="shared-artifact-list-load-more"
        >
          {SHARED_ARTIFACT_COPY.listLoadMore}
        </Button>
      )}
    </Stack>
  );
}

type ListTab = 'mine' | 'sharedWithMe';

/**
 * "Created by me" and "Shared with me" (CAN-8017). Built and storied here;
 * no web surface mounts it yet, and desktop mounts it in CAN-8018.
 */
export function SharedArtifactsList({
  client,
  onOpen,
}: {
  readonly client: SharedArtifactsClient | null;
  readonly onOpen: (artifactId: string) => void;
}): JSX.Element {
  const [tab, setTab] = useState<ListTab>('mine');
  return (
    <Stack gap="group" data-testid="shared-artifacts-list">
      <TabBar<ListTab>
        label={SHARED_ARTIFACT_COPY.listLabel}
        value={tab}
        onChange={(next): void => setTab(next)}
        items={[
          { id: 'mine', label: SHARED_ARTIFACT_COPY.listMine },
          { id: 'sharedWithMe', label: SHARED_ARTIFACT_COPY.listSharedWithMe },
        ]}
      />
      {/* Keyed by tab, so a page in flight for the other tab is dropped. */}
      <SharedArtifactListBody
        key={tab}
        client={client}
        query={{ view: tab }}
        emptyLabel={
          tab === 'mine'
            ? SHARED_ARTIFACT_COPY.listEmptyMine
            : SHARED_ARTIFACT_COPY.listEmptySharedWithMe
        }
        showOwner={tab === 'sharedWithMe'}
        onOpen={onOpen}
      />
    </Stack>
  );
}
