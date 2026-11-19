import { memo, type JSX } from 'react';
import { subordinateSteeringRequest } from '@canopy/agent-transcript';
import type {
  AgentSentInfo,
  ChatWatcherFiredInfo,
  ToolMessageSender,
} from '@canopy/protocol/remote-control/shell';
import { REPLAY_MASK_CLASS } from '../../lib/replay-privacy';
import { AgentSentMarker } from './AgentSentMarker';
import { SubagentIcon } from '../../icons/SubagentIcon';
import {
  watcherFiredPresentation,
  type WatcherFiredPresentation,
} from './WatcherFiredTitle';
import {
  SUBAGENT_STEERING_REQUEST_LABEL,
  subagentSteeringRequestFromLabel,
} from './subagents/subagent-copy';

interface SteeringRequestTitleProps {
  /** The requesting delegate's task description, when the request names it. */
  requestedBy?: string;
  /** As {@link WatcherFiredTitle}'s `layout`: `inline` leads a queued row. */
  layout?: 'block' | 'inline';
}

/**
 * Title row above a delegate's steering request in its root chat, queued or
 * sent, in the watcher title's place: `Steering request from Port handlers`.
 */
export const SteeringRequestTitle = memo(function SteeringRequestTitle({
  requestedBy,
  layout = 'block',
}: SteeringRequestTitleProps): JSX.Element {
  const inline = layout === 'inline';
  return (
    <span
      data-testid="steering-request-title"
      className={
        inline
          ? 'flex min-w-0 items-center gap-1.5 fg-info'
          : 'pb-1 flex items-center gap-1.5 text-3xs font-medium fg-info'
      }
    >
      <SubagentIcon size={inline ? 14 : 11} className="shrink-0" />
      {/* The delegate's task description is user content: mask it. */}
      <span
        className={inline ? `truncate ${REPLAY_MASK_CLASS}` : REPLAY_MASK_CLASS}
      >
        {requestedBy
          ? subagentSteeringRequestFromLabel(requestedBy)
          : SUBAGENT_STEERING_REQUEST_LABEL}
      </span>
    </span>
  );
});

/**
 * How every queued and sent bubble, on every host, shows a delegate's
 * steering request: its readable text on the info tint watcher messages use,
 * under {@link SteeringRequestTitle}, or under the trusted sender marker when
 * the host recorded the delegate as its sender. Undefined for any other
 * message, and for an external agent's message: an outside agent controls
 * its text, so text-derived presentation never applies to it.
 */
export interface SteeringRequestPresentation {
  readonly text: string;
  readonly title: JSX.Element;
  readonly variant: 'info';
}

export function steeringRequestPresentation(
  text: string,
  agentSent?: ToolMessageSender,
  layout: 'block' | 'inline' = 'block',
): SteeringRequestPresentation | undefined {
  if (agentSent?.kind === 'external_agent') return undefined;
  const request = subordinateSteeringRequest(text);
  if (!request) return undefined;
  return {
    text: request.text,
    // The broker wrote the wrapper, so its request text is shown, but only
    // the host's sender record names the delegate.
    title: agentSent ? (
      <AgentSentMarker agentSent={agentSent} layout={layout} />
    ) : (
      <SteeringRequestTitle requestedBy={request.requestedBy} layout={layout} />
    ),
    variant: 'info',
  };
}

/**
 * How a bubble shows a host message: a delegate's steering request, or a
 * fired watcher (see {@link watcherFiredPresentation}), each as its readable
 * part, under its title on the info tint when the host vouches for it.
 * `watcherFired` is the host's marker on the message. Undefined for an
 * ordinary message. A message with a trusted sender is never a watcher; see
 * {@link steeringRequestPresentation}.
 */
export function hostMessagePresentation(
  text: string,
  agentSent?: AgentSentInfo,
  layout: 'block' | 'inline' = 'block',
  watcherFired?: ChatWatcherFiredInfo,
): SteeringRequestPresentation | WatcherFiredPresentation | undefined {
  // Only a managed delegate's recorded request keeps a text-derived
  // presentation; a Canopy chat or an external agent controls its own text.
  if (agentSent)
    return 'kind' in agentSent
      ? steeringRequestPresentation(text, agentSent, layout)
      : undefined;
  return (
    steeringRequestPresentation(text, undefined, layout) ??
    watcherFiredPresentation(text, layout, watcherFired)
  );
}
