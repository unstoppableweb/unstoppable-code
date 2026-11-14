import { Fragment, type JSX } from 'react';
import type { UnifiedEntryAlternative } from '@canopy/ui-shared';
import { Button, DetailFact } from '@canopy/ui-shared/components';
import { displayVersion } from '@canopy/ui-shared/lib/display-version';

interface PluginAlternativesProps {
  alternatives?: readonly UnifiedEntryAlternative[];
  onOpenEntryId?: (entryId: string) => void;
  /** `plugin-detail-also-available` or a surface-specific prefix. */
  testIdPrefix: string;
  /** Only the links, for a host that labels them itself. */
  linksOnly?: boolean;
}

export function PluginVariantDifferences({
  alternatives,
  onOpenEntryId,
}: Pick<
  PluginAlternativesProps,
  'alternatives' | 'onOpenEntryId'
>): JSX.Element | null {
  const variants = (alternatives ?? []).flatMap(
    ({ entryId, marketplaceVariant }) =>
      marketplaceVariant ? [{ entryId, ...marketplaceVariant }] : [],
  );
  const current = variants[0];
  if (!current) return null;

  const currentProvider = current.provider === 'Claude' ? 'Codex' : 'Claude';
  const currentVersion = displayVersion(current.currentVersion);
  const versions = variants.map((variant) => ({
    ...variant,
    label: [variant.provider, displayVersion(variant.version)]
      .filter(Boolean)
      .join(' '),
    version: displayVersion(variant.version),
  }));
  const differs =
    currentVersion !== null &&
    versions.some(
      ({ version }) => version !== null && version !== currentVersion,
    );

  return (
    <DetailFact label={differs ? 'What differs' : 'Provider versions'}>
      <span className="text-pretty">
        {differs && 'Versions differ. '}
        <span aria-current="page">
          {[currentProvider, currentVersion].filter(Boolean).join(' ')}
        </span>
        {versions.map(({ entryId, label }) => (
          <Fragment key={entryId}>
            {' · '}
            <Button
              variant="link"
              data-testid={`plugin-version-detail-${entryId}`}
              disabled={onOpenEntryId === undefined}
              onClick={() => onOpenEntryId?.(entryId)}
            >
              {label}
            </Button>
          </Fragment>
        ))}
      </span>
    </DetailFact>
  );
}

/**
 * "Also available from …" on a plugin page: the same app published by other
 * catalogs, each a link to that copy's page (CAN-3653). Nothing without
 * alternatives.
 */
export function PluginAlternatives({
  alternatives,
  onOpenEntryId,
  testIdPrefix,
  linksOnly = false,
}: PluginAlternativesProps): JSX.Element | null {
  if (!alternatives || alternatives.length === 0) return null;
  const links = (
    <>
      {alternatives.map((alternative, index) => (
        <Fragment key={alternative.entryId}>
          {index > 0 && ', '}
          <Button
            variant="link"
            data-testid={`${testIdPrefix}-${alternative.entryId}`}
            disabled={onOpenEntryId === undefined}
            onClick={() => onOpenEntryId?.(alternative.entryId)}
          >
            {alternative.label}
          </Button>
        </Fragment>
      ))}
    </>
  );
  if (linksOnly) return <span data-testid={testIdPrefix}>{links}</span>;
  return (
    <p data-testid={testIdPrefix} className="mt-2 text-xs fg-secondary">
      Also available from {links}
    </p>
  );
}
