import type { JSX } from 'react';
import { SettingsLink } from '../host';
import { Surface } from '@canopy/ui-shared/primitives/Surface';

export { digestNeighbors } from './digest-neighbors';

export interface DigestDetailNavigationProps {
  newerHref: string | null;
  olderHref: string | null;
  settingsHref: string | null;
}

export function DigestDetailNavigation({
  newerHref,
  olderHref,
  settingsHref,
}: DigestDetailNavigationProps): JSX.Element {
  return (
    <Surface
      as="nav"
      variant="card"
      padding="compact"
      aria-label="Digest navigation"
      data-testid="digest-detail-navigation"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
        <div className="flex gap-3">
          {olderHref ? (
            <SettingsLink
              href={olderHref}
              className="fg-accent hover:underline"
            >
              ← Older
            </SettingsLink>
          ) : (
            <span className="fg-secondary">← Older</span>
          )}
          {newerHref ? (
            <SettingsLink
              href={newerHref}
              className="fg-accent hover:underline"
            >
              Newer →
            </SettingsLink>
          ) : (
            <span className="fg-secondary">Newer →</span>
          )}
        </div>
        {settingsHref && (
          <SettingsLink
            href={settingsHref}
            className="fg-accent hover:underline"
          >
            Digest cadence settings
          </SettingsLink>
        )}
      </div>
    </Surface>
  );
}
