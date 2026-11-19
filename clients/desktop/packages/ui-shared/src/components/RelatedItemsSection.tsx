import { ControlButton } from './Button';
import type { JSX, ReactNode } from 'react';
import type { UnifiedEntryKind } from '@canopy/protocol/unified-entry';
import { CUSTOMIZE_ROW_GRID_CLASS } from '../lib/customize-grid';
import { McpServerLogo } from './McpServerLogo';
import { MarketplaceTypeLabel } from './MarketplaceTypeLabel';
import { Heading } from './Heading';
import { Badge } from './Badge';
import { PipelineSourceLabel } from './EntrySourceLabel';
import { REPLAY_MASK_CLASS } from '../lib/replay-privacy';

/** One row in a related-items section (CAN-2382). */
export interface RelatedItemRow {
  key: string;
  /** Emoji tile shown before the title (pipelines); omitted for capabilities. */
  icon?: string;
  title: string;
  subtitle?: string;
  /** A resource kind or role, e.g. "Skill", "Plugin". */
  badge?: string;
  /** Routine workflow provenance, e.g. "Bundled", shown as plain metadata. */
  sourceLabel?: string;
  /** The item's kind: a list badge takes the Customize type tint. */
  kind?: UnifiedEntryKind;
  /** Why this item is related, when it is not obvious. */
  reason?: string;
  /** A user's own name (a workflow, an automation): masked in session replay. */
  privateTitle?: boolean;
  /** The row's own logo in a list (the tile's), instead of a monogram. */
  logo?: ReactNode;
  /** The subtitle's own replay class (a person's name is blocked). */
  subtitleReplayClass?: string;
  /** In a list, say the reason after the subtitle instead of hiding it. */
  reasonInline?: boolean;
  onOpen: () => void;
}

interface RelatedItemsSectionProps {
  title: string;
  description?: string;
  emptyLabel: string;
  items: RelatedItemRow[];
  loading?: boolean;
  testId: string;
  presentation?: 'cards' | 'list';
  hideWhenEmpty?: boolean;
  /** Said inside the section, under its rows: a partial read's failure. */
  footer?: ReactNode;
}

/**
 * Sectioned list of related items shown on skill, plugin, and pipeline detail
 * surfaces. Follows the pipeline-settings section idiom (heading, optional
 * description, bordered rows) so it reads natively on every host. Renders a
 * small empty state when there are no items; renders nothing while loading so
 * the empty state never flashes.
 */
export function RelatedItemsSection({
  title,
  description,
  emptyLabel,
  items,
  loading = false,
  testId,
  presentation = 'cards',
  hideWhenEmpty = false,
  footer,
}: RelatedItemsSectionProps): JSX.Element {
  if (hideWhenEmpty && items.length === 0) return <></>;
  const list = presentation === 'list';
  return (
    <section data-testid={testId} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <Heading level={3} variant="title">
          {title}
        </Heading>
        {description && <p className="text-xs fg-secondary">{description}</p>}
      </div>
      {loading ? null : items.length === 0 ? (
        <p className="text-xs fg-secondary" data-testid={`${testId}-empty`}>
          {emptyLabel}
        </p>
      ) : (
        // `list` rows are the Customize list's row cards (CAN-4261): an
        // avatar, the name with its tinted type, the inset rounded hover,
        // in the same two-column grid as Installed and Browse.
        <div
          data-testid={`${testId}-rows`}
          className={list ? CUSTOMIZE_ROW_GRID_CLASS : 'flex flex-col gap-2'}
        >
          {items.map((item) => (
            <ControlButton
              key={item.key}
              type="button"
              onClick={item.onOpen}
              data-testid={`${testId}-item-${item.key}`}
              // `hover:bg-subtle` is the app's row hover (DropdownMenuItem,
              // the sidebar rows, SidebarPageNav), and it lives here rather
              // than at a call site: hosts render this primitive as-is, and a
              // restyling class on a shared component is a design-lint error.
              presentation="customize-related-item"
              appearance={{ list }}
            >
              {list && item.icon === undefined && item.logo !== undefined && (
                <span
                  data-testid={`${testId}-item-${item.key}-avatar`}
                  className={`flex shrink-0${item.privateTitle ? ` ${REPLAY_MASK_CLASS}` : ''}`}
                >
                  {item.logo}
                </span>
              )}
              {list && item.icon === undefined && item.logo === undefined && (
                <span
                  data-testid={`${testId}-item-${item.key}-avatar`}
                  className={`flex shrink-0${item.privateTitle ? ` ${REPLAY_MASK_CLASS}` : ''}`}
                >
                  <McpServerLogo
                    size={28}
                    fallback="monogram"
                    name={item.title}
                    shape="circle"
                    fit="contain"
                  />
                </span>
              )}
              {item.icon !== undefined && (
                <div className="shrink-0 w-8 h-8 rounded-lg bg-accent-subtle flex items-center justify-center text-m">
                  {item.icon || '⚡'}
                </div>
              )}
              <div className="min-w-0 flex-1">
                <div
                  className={`flex items-center ${list ? 'gap-1.5' : 'gap-2'}`}
                >
                  <span
                    className={`min-w-0 truncate text-s font-medium fg-primary${item.privateTitle ? ` ${REPLAY_MASK_CLASS}` : ''}`}
                  >
                    {item.title}
                  </span>
                  {item.badge && item.kind && (
                    <MarketplaceTypeLabel kind={item.kind} label={item.badge} />
                  )}
                  {item.badge &&
                    !item.kind &&
                    (list ? (
                      <span className="shrink-0 text-xs fg-secondary">
                        {item.badge}
                      </span>
                    ) : (
                      <Badge>{item.badge}</Badge>
                    ))}
                  {item.sourceLabel && (
                    <PipelineSourceLabel>
                      {item.sourceLabel}
                    </PipelineSourceLabel>
                  )}
                </div>
                {(item.subtitle ||
                  (list && item.reasonInline && item.reason)) && (
                  <p
                    className={`mt-0.5 truncate text-xs ${list ? 'fg-tertiary' : 'fg-secondary'}`}
                  >
                    {item.subtitle && (
                      <span className={item.subtitleReplayClass}>
                        {item.subtitle}
                      </span>
                    )}
                    {list && item.reasonInline && item.reason && (
                      <>
                        {item.subtitle && ' · '}
                        {item.reason}
                      </>
                    )}
                  </p>
                )}
                {item.reason && !list && (
                  <p className="text-xs fg-secondary mt-0.5 truncate">
                    {item.reason}
                  </p>
                )}
              </div>
            </ControlButton>
          ))}
        </div>
      )}
      {footer}
    </section>
  );
}
