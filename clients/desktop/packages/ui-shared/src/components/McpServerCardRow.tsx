import { TextLink } from '../primitives/TextLink';
import type { JSX, ReactNode } from 'react';
import { REPLAY_MASK_CLASS } from '../lib/replay-privacy';
import { COMPACT_ACTIVITY_ITEM_CLASS_NAME } from './activity-item-density';
import { ControlButton, Button } from '../primitives/Button';
import { Surface } from '../primitives/Surface';

/** Hosts resolve identities; the shared row only renders the supplied control. */
export type McpRowDestination =
  | { readonly kind: 'button'; readonly onActivate: () => void }
  | { readonly kind: 'link'; readonly href: string };

export function McpRowSettings({
  destination,
  name,
}: {
  readonly destination?: McpRowDestination;
  readonly name: string;
}): JSX.Element | null {
  if (!destination) return null;
  return (
    <div className="pt-1.5 text-2xs">
      {destination.kind === 'button' ? (
        <Button
          variant="link"
          onClick={destination.onActivate}
          aria-label={`Open MCP settings for ${name}`}
          data-testid="mcp-servers-card-settings"
        >
          Open MCP settings
        </Button>
      ) : (
        <TextLink
          href={destination.href}
          target="_blank"
          rel="noopener"
          aria-label={`Open MCP settings for ${name} (opens in a new tab)`}
          data-testid="mcp-servers-card-settings"
        >
          Open MCP settings
        </TextLink>
      )}
    </div>
  );
}

export function McpManageRowSurface({
  children,
  group,
  enabled,
}: {
  readonly children: ReactNode;
  readonly group: string;
  readonly enabled: boolean;
}): JSX.Element {
  return (
    <Surface
      as="li"
      variant="mcp-manage-row"
      data-testid="mcp-manage-row"
      data-group={group}
      data-on={enabled ? 'true' : 'false'}
    >
      {children}
    </Surface>
  );
}

export interface McpServerCardRowProps {
  readonly name: string;
  /**
   * Masks the name in session replay, for a name another person chose, such
   * as an organization's shared connection.
   */
  readonly maskName?: boolean;
  readonly enabled: boolean;
  readonly destination?: McpRowDestination;
  readonly compact?: boolean;
  readonly alignActions?: 'start' | 'center';
  readonly metadata?: ReactNode;
  readonly status?: ReactNode;
  readonly children?: ReactNode;
  /** Margin-free host prompts below the row; the MCP control owns the 6px gap. */
  readonly footer?: ReactNode;
  readonly actions?: ReactNode;
}

export function McpServerCardRow({
  name: rawName,
  maskName = false,
  enabled,
  destination,
  compact = false,
  alignActions = 'start',
  metadata,
  status,
  children,
  footer,
  actions,
}: McpServerCardRowProps): JSX.Element {
  const name = maskName ? (
    <span className={REPLAY_MASK_CLASS}>{rawName}</span>
  ) : (
    rawName
  );
  const nameClass = compact
    ? 'min-w-0 break-words fg-primary'
    : 'min-w-0 break-words text-s font-medium fg-primary';
  const mainContent = (
    <>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {destination === undefined ? (
          <span className={nameClass} data-testid="mcp-servers-card-name">
            {name}
          </span>
        ) : destination.kind === 'button' ? (
          <ControlButton
            type="button"
            presentation="mcp-card-title"
            appearance={{ compact: !!compact }}
            onClick={destination.onActivate}
            data-testid="mcp-servers-card-name"
          >
            {name}
          </ControlButton>
        ) : (
          <TextLink
            variant="mcp-title"
            compact={!!compact}
            href={destination.href}
            target="_blank"
            rel="noopener"
            aria-label={`${rawName} (opens in a new tab)`}
            data-testid="mcp-servers-card-name"
          >
            {name}
          </TextLink>
        )}
        {metadata}
        {status}
      </div>
      {children}
    </>
  );
  return (
    <li
      className={
        compact
          ? `group/mcp-row flex flex-wrap ${COMPACT_ACTIVITY_ITEM_CLASS_NAME}`
          : alignActions === 'center'
            ? 'flex flex-wrap items-center justify-between gap-2 px-2.5 py-2'
            : 'flex flex-wrap items-start justify-between gap-2 px-2.5 py-2'
      }
      data-testid="mcp-servers-card-row"
      data-enabled={enabled ? 'true' : 'false'}
    >
      <div className="min-w-0 flex-1">
        {footer === undefined ? (
          mainContent
        ) : (
          <div className="flex flex-col gap-1.5">
            <div>{mainContent}</div>
            <div className="flex flex-col gap-1.5 empty:hidden">{footer}</div>
          </div>
        )}
      </div>
      <div className="flex max-w-full shrink-0 flex-wrap items-center gap-1.5">
        {actions}
      </div>
    </li>
  );
}
