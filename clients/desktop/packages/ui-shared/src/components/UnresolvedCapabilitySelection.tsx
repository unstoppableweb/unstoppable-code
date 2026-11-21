import type { JSX } from 'react';
import {
  buildTryItCapabilityKey,
  normalizeTryItCapabilities,
  type TryItCapability,
} from '@canopy/protocol/try-it';

/** Catalog selections stay visible while installation or authorization is pending. */
export function UnresolvedCapabilitySelection({
  capabilities,
}: {
  capabilities?: readonly TryItCapability[];
}): JSX.Element | null {
  if (!capabilities?.length) return null;
  return (
    <div
      role="group"
      className="flex flex-wrap items-center gap-2 px-4 pt-3 text-xs fg-secondary"
      aria-label="Selected for this chat"
      data-testid="unresolved-capability-selection"
    >
      {normalizeTryItCapabilities(capabilities).map((capability) => (
        <span key={buildTryItCapabilityKey('', capability)}>
          <span className="fg-primary">{capability.name}</span>
          {' · Setup required'}
        </span>
      ))}
    </div>
  );
}
