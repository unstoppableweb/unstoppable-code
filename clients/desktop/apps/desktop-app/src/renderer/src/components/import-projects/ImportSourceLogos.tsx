import type { JSX } from 'react';
import type { ExternalProjectProvider } from '@canopy/desktop-shared/types';
import { Tooltip } from '@canopy/ui-shared/components';
import { ClaudeLogo, CodexLogo, OpenCodeLogo } from '@canopy/ui-shared/icons';
import { TerminalIcon } from '@canopy/ui-shared/icons/AppIcons';
import { importSourcesList, providerDisplayName } from './importProjectsCopy';

/**
 * A tool's mark. T3 Code publishes no mark the icon rules let us vendor, so
 * it takes the neutral terminal glyph; its tooltip and label name it.
 */
function SourceLogo({
  provider,
}: {
  provider: ExternalProjectProvider;
}): JSX.Element {
  switch (provider) {
    case 'claude':
      return <ClaudeLogo className="size-3.5" aria-hidden />;
    case 'codex':
      return <CodexLogo className="size-3.5" aria-hidden />;
    case 'opencode':
      return <OpenCodeLogo className="size-3.5" aria-hidden />;
    case 't3code':
      return <TerminalIcon size="sm" aria-hidden />;
  }
}

/**
 * The tools a project was used with, as their logos, each named in a
 * tooltip. Shared by the first-run page and the import modal's rows.
 */
export function ImportSourceLogos({
  providers,
  dataTestId,
}: {
  providers: readonly ExternalProjectProvider[];
  dataTestId?: string;
}): JSX.Element | null {
  // A picked folder has no tool of its own.
  if (providers.length === 0) return null;
  return (
    <span
      role="img"
      className="flex shrink-0 items-center gap-1.5 fg-secondary"
      aria-label={`Used with ${importSourcesList(providers, 'and')}`}
      data-testid={dataTestId}
    >
      {providers.map((provider) => (
        <Tooltip key={provider} label={providerDisplayName[provider]}>
          <span className="flex" data-provider={provider}>
            <SourceLogo provider={provider} />
          </span>
        </Tooltip>
      ))}
    </span>
  );
}
