import type { ShareScope } from '@canopy/protocol/sharing';
import type { JSX, ReactNode } from 'react';
import { ClaudeLogo, CodexLogo } from '../icons';
import { shareAudienceLabelText } from '../lib/share-audience-label';
import {
  parseProviderSourceLabel,
  sourceLabelProvider,
  type UnifiedPluginEntry,
} from '../lib/unified-plugin-entry';
import { Tooltip } from '../primitives/Tooltip';

function entrySourceProvider(
  entry: UnifiedPluginEntry,
): 'Claude' | 'Codex' | undefined {
  if (entry.kind !== 'plugin') return undefined;
  if (entry.origin === 'shared') return entry.sharedSourceProvider;
  if (entry.origin !== 'marketplace') return undefined;
  return sourceLabelProvider(entry.sourceLabel);
}

/**
 * A marketplace source line without the provider its logo already names:
 * `Claude · PostHog` reads `PostHog`, and `Codex official` reads nothing. A row
 * with no logo, such as a plugin's bundled skill, keeps the full line.
 */
export function entrySourceTextWithoutProvider(
  entry: UnifiedPluginEntry,
  text: string,
): string {
  if (
    entrySourceProvider(entry) === undefined ||
    entry.origin !== 'marketplace' ||
    text !== entry.sourceLabel?.trim()
  )
    return text;
  return parseProviderSourceLabel(text)?.rest ?? text;
}

/**
 * The provider a marketplace plugin's source line names, as a small logo with
 * a tooltip, so same-named plugins read as different packages rather than
 * duplicates. The source label leads with its provider (`pluginSourceLabel`).
 * It sits inside the Customize row's button, so it is not focusable itself;
 * its label is part of the row's accessible name.
 */
export function EntrySourceProviderMark({
  entry,
}: {
  entry: UnifiedPluginEntry;
}): JSX.Element | null {
  const provider = entrySourceProvider(entry);
  if (provider === undefined) return null;
  const Logo = provider === 'Claude' ? ClaudeLogo : CodexLogo;
  const tooltip = `${provider} marketplace`;
  return (
    <Tooltip label={tooltip}>
      <Logo
        width={12}
        height={12}
        role="img"
        aria-label={tooltip}
        data-testid={`entry-source-provider-${entry.id}`}
        className="shrink-0 fg-secondary"
      />
    </Tooltip>
  );
}

/**
 * Where a plugin row comes from (`Claude · slackapi`, `Codex official`), as
 * routine plain-text metadata below its title. Plugins only: MCP rows and
 * pipelines render their sources elsewhere or not at all, a shared plugin
 * already names its audience, and a curated plugin's `Curated` is not a
 * source the copy documents (CAN-3653).
 */
/** Whether {@link EntrySourceLabel} renders anything for the entry. */
export function showsEntrySourceLabel(entry: UnifiedPluginEntry): boolean {
  return (
    entry.kind === 'plugin' &&
    entry.origin === 'marketplace' &&
    Boolean(entry.sourceLabel)
  );
}

export function EntrySourceLabel({
  entry,
  testId,
  shrinkable = false,
}: {
  entry: UnifiedPluginEntry;
  testId: string;
  /** Lets a one-line metadata row truncate the label. */
  shrinkable?: boolean;
}): JSX.Element | null {
  if (!showsEntrySourceLabel(entry)) return null;
  return (
    <span
      className={`${shrinkable ? 'min-w-0 shrink' : 'shrink-0'} inline-flex items-center gap-1`}
    >
      <EntrySourceProviderMark entry={entry} />
      <span
        data-testid={testId}
        className={`${shrinkable ? 'min-w-0 shrink truncate' : 'shrink-0'} text-xs fg-tertiary`}
      >
        {entrySourceTextWithoutProvider(entry, entry.sourceLabel ?? '')}
      </span>
    </span>
  );
}

/** Where a workflow comes from, in the vocabulary of the desktop picker. */
export type PipelineOrigin =
  | 'bundled'
  | 'user'
  | 'project'
  | 'shared'
  | 'curated';

const PIPELINE_ORIGIN_LABELS: Record<PipelineOrigin, string> = {
  bundled: 'Bundled',
  user: 'Custom',
  project: 'Project',
  shared: 'Shared',
  curated: 'Curated',
};

/** The label desktop and paired Portal pickers show for a workflow origin. */
export function pipelineOriginLabel(origin: PipelineOrigin): string {
  return PIPELINE_ORIGIN_LABELS[origin];
}

/**
 * The audience of a local item the viewer shared, for its source or ownership
 * label. A public-link share is stored as `private`, so it reads `Shared`.
 */
export function ownShareAudienceText(audience: ShareScope): string {
  return audience === 'private' ? 'Shared' : shareAudienceLabelText(audience);
}

/**
 * Routine workflow provenance, shared by desktop and paired Portal pickers.
 * `audience` marks a local row the viewer shared: `Custom · Organization`.
 */
export function PipelineSourceLabel({
  children,
  audience,
  'data-testid': testId,
}: {
  readonly children: ReactNode;
  readonly audience?: ShareScope;
  readonly 'data-testid'?: string;
}): JSX.Element {
  return (
    <span data-testid={testId} className="shrink-0 text-2xs fg-tertiary">
      {children}
      {audience ? ` · ${ownShareAudienceText(audience)}` : null}
    </span>
  );
}
