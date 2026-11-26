import type { JSX } from 'react';
import { Badge } from '../primitives/Badge';
import {
  dataSharingFeatureCaption,
  getDataSharingFeatures,
  type DataSharingScopeKey,
} from '../lib/data-sharing-features';

export interface DataSharingFeaturePillsProps {
  /** Which scope's feature list to render. */
  scope: DataSharingScopeKey;
  /**
   * Whether this scope's data is currently being shared. Drives the whole
   * treatment: `true` reads "Powers <features>" in active pills, `false` reads
   * "Enables <features>" in muted pills, naming what sharing would add.
   */
  sharing: boolean;
  /**
   * Include features that only an org prohibition withholds. Pass `false` from
   * the member-side desktop surfaces so a member's own Transcripts-off does not
   * claim sharing enables `Shared runs`: their own run share bypasses the
   * ambient gate regardless.
   */
  includeEnforcementOnly?: boolean;
  /**
   * `default` keeps the neutral pills, quieted only while sharing is off.
   * `quiet` keeps every pill at the quieter fill, for a surface where the
   * pills sit under a control and the caption alone carries the state, such
   * as the desktop Privacy tab. The org admin card keeps the default.
   */
  tone?: 'default' | 'quiet';
  /** Test ID hook; the caption and each pill derive their own ids from it. */
  dataTestId?: string;
  className?: string;
}

/**
 * The "what this powers / what sharing enables" pill row rendered beneath a
 * data-sharing scope. Shared verbatim by the web org Settings card and the
 * desktop Privacy tab / Cloud sync modal so the admin deciding a policy and the
 * member living with it read the same consequences.
 *
 * Pure display: it derives everything from {@link getDataSharingFeatures} and
 * the `sharing` flag, and never fetches or reads a store.
 */
export function DataSharingFeaturePills({
  scope,
  sharing,
  includeEnforcementOnly = true,
  tone = 'default',
  dataTestId,
  className,
}: DataSharingFeaturePillsProps): JSX.Element | null {
  const features = getDataSharingFeatures(scope, { includeEnforcementOnly });
  if (features.length === 0) {
    return null;
  }

  const caption = dataSharingFeatureCaption(sharing);

  return (
    <div
      className={`flex flex-wrap items-center gap-1.5 ${className ?? ''}`}
      data-testid={dataTestId}
      data-sharing={sharing ? 'true' : 'false'}
    >
      <span className="text-3xs font-medium fg-secondary">{caption}</span>
      {/* Feature names are neutral; they quiet down while sharing is off, or
          always in the quiet tone. */}
      {features.map((entry) => (
        <Badge
          key={entry.id}
          muted={tone === 'quiet' || !sharing}
          data-testid={
            dataTestId ? `${dataTestId}-pill-${entry.id}` : undefined
          }
        >
          {entry.label}
        </Badge>
      ))}
    </div>
  );
}
