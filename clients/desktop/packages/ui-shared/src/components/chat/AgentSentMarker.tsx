import { memo, type JSX } from 'react';
import type { ToolMessageSender } from '@canopy/protocol/remote-control/shell';
import { McpIcon } from '../../icons';
import { REPLAY_MASK_CLASS } from '../../lib/replay-privacy';
import { SubagentIcon } from '../../icons/SubagentIcon';

interface AgentSentMarkerProps {
  agentSent: ToolMessageSender;
  /** `inline` leads a one-line queued row at the row's own text size. */
  layout?: 'block' | 'inline';
}

/**
 * Title row above a user message an agent sent, in the watcher title's place.
 * An external MCP agent (Cursor, Claude Code, …) sending on the person's
 * behalf shows `Sent by Cursor`, plus `Unverified app` when the connection's
 * redirect trust was not verified. A managed delegate writing to its root
 * chat shows `Sent by <its task>` with the subagent glyph.
 *
 * `clientName` and `title` are untrusted display text from host records.
 * React renders them as text nodes only, and a long one truncates. An app
 * name takes no session-replay class and keeps its full value in the native
 * title. A delegate's task is user-authored, so it is masked like other
 * subagent titles and kept out of attributes, which replay records verbatim.
 */
export const AgentSentMarker = memo(function AgentSentMarker({
  agentSent,
  layout = 'block',
}: AgentSentMarkerProps): JSX.Element {
  const inline = layout === 'inline';
  const rowClass = inline
    ? 'flex min-w-0 max-w-full items-center gap-1.5 fg-tertiary'
    : 'pb-1 flex min-w-0 max-w-full items-center gap-1.5 text-3xs font-medium fg-secondary';
  const iconSize = inline ? 14 : 11;
  if (agentSent.kind === 'managed_delegate') {
    return (
      <span
        data-testid="agent-sent-marker"
        data-sender="managed_delegate"
        className={rowClass}
      >
        <SubagentIcon size={iconSize} className="shrink-0" />
        <span data-testid="agent-sent-marker-name" className="min-w-0 truncate">
          Sent by <span className={REPLAY_MASK_CLASS}>{agentSent.title}</span>
        </span>
      </span>
    );
  }
  return (
    <span
      data-testid="agent-sent-marker"
      data-verified={agentSent.verified ? 'true' : 'false'}
      className={rowClass}
    >
      <McpIcon aria-hidden="true" size="sm" className="shrink-0" />
      <span
        data-testid="agent-sent-marker-name"
        className="min-w-0 truncate"
        title={agentSent.clientName}
      >
        Sent by {agentSent.clientName}
      </span>
      {agentSent.verified ? null : (
        <span
          data-testid="agent-sent-marker-unverified"
          className="shrink-0 fg-warning"
        >
          Unverified app
        </span>
      )}
    </span>
  );
});
