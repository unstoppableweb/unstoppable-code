import type { JSX } from 'react';
import type {
  MarketplaceSourceAddPlugin,
  MarketplaceSourceAddReview,
} from '@canopy/app-core/client';
import {
  ErrorBanner,
  ExternalTextLink,
  SecurityAuditSummary,
  StatusLabel,
  Heading,
} from '@canopy/ui-shared/components';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import { Surface } from '@canopy/ui-shared/components';

function MarketplaceSourceAddPluginPreview({
  plugin,
}: {
  readonly plugin: MarketplaceSourceAddPlugin;
}): JSX.Element {
  return (
    <Surface variant="outline" size="small">
      <div className="px-3 py-2">
        <p className={`text-s font-medium fg-primary ${REPLAY_BLOCK_CLASS}`}>
          {plugin.name}
        </p>
        {plugin.description && (
          <p className={`text-xs fg-secondary ${REPLAY_BLOCK_CLASS}`}>
            {plugin.description}
          </p>
        )}
        {(plugin.license !== null ||
          plugin.sourceUrl !== null ||
          plugin.securityAudit !== null) && (
          <p
            className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs fg-secondary"
            data-testid="cloud-marketplace-plugin-provenance"
          >
            {plugin.license !== null && (
              <span className={REPLAY_BLOCK_CLASS}>
                License: {plugin.license}
              </span>
            )}
            {plugin.sourceUrl !== null && (
              <span className={REPLAY_BLOCK_CLASS}>
                <ExternalTextLink href={plugin.sourceUrl} label="View source" />
              </span>
            )}
            {plugin.securityAudit !== null && (
              <SecurityAuditSummary
                audit={plugin.securityAudit}
                dataTestId="cloud-marketplace-plugin-security-audit"
              />
            )}
          </p>
        )}
        {plugin.syncError && (
          <p
            className={`mt-1 ${REPLAY_BLOCK_CLASS}`}
            data-testid="cloud-marketplace-plugin-error"
          >
            <StatusLabel size="xs">{plugin.syncError}</StatusLabel>
          </p>
        )}
        {plugin.hooksStripped && (
          <p
            className="mt-1 text-xs fg-secondary"
            data-testid="cloud-marketplace-plugin-warning"
          >
            Hooks will be omitted in cloud sessions.
          </p>
        )}
        {plugin.mcpOnly && (
          <p
            className="mt-1 text-xs fg-secondary"
            data-testid="cloud-marketplace-plugin-warning"
          >
            MCP-only plugins are not yet available in cloud sessions.
          </p>
        )}
      </div>
    </Surface>
  );
}

export function MarketplaceSourceAddPreview({
  review,
}: {
  readonly review: MarketplaceSourceAddReview;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      <div>
        <Heading level={3} variant="title">
          <span className={REPLAY_BLOCK_CLASS}>{review.name}</span>
        </Heading>
        {review.revision && (
          <p
            className="break-all text-xs fg-secondary"
            data-testid="cloud-marketplace-preview-revision"
          >
            Pinned revision: {review.revision}
          </p>
        )}
      </div>
      <ErrorBanner
        errorSource="marketplace-source-add-preview-review-sync"
        className=""
        error={review.syncError}
        blockMessageFromReplay
      />
      <div className="grid grid-cols-1 content-start max-h-64 overflow-y-auto gap-2">
        {review.plugins.length === 0 ? (
          <p className="text-xs fg-secondary">No plugins were detected.</p>
        ) : (
          review.plugins.map((plugin) => (
            <MarketplaceSourceAddPluginPreview
              key={plugin.pluginKey}
              plugin={plugin}
            />
          ))
        )}
      </div>
      {review.pluginsReported && !review.canConfirm && (
        <ErrorBanner
          errorSource="cloud-marketplace-no-usable-plugins"
          className=""
          testId="cloud-marketplace-no-usable-plugins"
          error="This marketplace preview has no usable plugins. Add or fix a plugin before confirming."
        />
      )}
    </div>
  );
}
