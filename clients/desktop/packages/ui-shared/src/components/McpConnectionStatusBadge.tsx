import type { JSX } from 'react';
import { StatusToneText, useItemStateMarks } from './ItemStateMark';
import {
  mcpConnectionStatusBadgeClass,
  mcpConnectionStatusBadgeTone,
  mcpConnectionStatusLabel,
  type McpConnectionBadge,
} from '../lib/mcp-card-display';

export interface McpConnectionStatusBadgeProps {
  readonly badge: McpConnectionBadge;
  /** Defaults to the legacy table's ids so existing flows keep their anchors. */
  readonly dataTestId?: string;
  readonly providerTestId?: string;
}

/** Cached connection health for an MCP server, with the provider suffix. */
export function McpConnectionStatusBadge({
  badge,
  dataTestId = 'mcp-server-status-badge',
  providerTestId = 'mcp-server-status-provider',
}: McpConnectionStatusBadgeProps): JSX.Element {
  // New Customize: a colored icon and plain text, never a tinted label.
  const neutralText = useItemStateMarks();
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap">
      {neutralText ? (
        <StatusToneText
          tone={mcpConnectionStatusBadgeTone(badge.status)}
          size="xs"
          testId={dataTestId}
          status={badge.status}
        >
          {mcpConnectionStatusLabel(badge.status)}
        </StatusToneText>
      ) : (
        <span
          className={mcpConnectionStatusBadgeClass(badge.status)}
          data-testid={dataTestId}
          data-status={badge.status}
        >
          {mcpConnectionStatusLabel(badge.status)}
        </span>
      )}
      {badge.isProvider && (
        <span className="text-3xs fg-secondary" data-testid={providerTestId}>
          Agent provider
        </span>
      )}
    </span>
  );
}
