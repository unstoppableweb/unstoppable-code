import type { JSX } from 'react';
import { Notice } from '../../primitives/Notice';

/** The same context disclosure on a local transcript and its paired view. */
export function ForkContextNotice({
  mode,
}: {
  mode: 'fresh' | 'visible-transcript';
}): JSX.Element {
  return mode === 'fresh' ? (
    <Notice
      intent="attention"
      role="none"
      title="Starts fresh here"
      data-testid="fork-fresh-context-notice"
    >
      The agent can&apos;t see the messages above. Tell it what it needs to know
      in your next message.
    </Notice>
  ) : (
    <Notice
      intent="neutral"
      role="none"
      title="Copied message text"
      data-testid="fork-visible-context-notice"
    >
      This OpenCode session starts with the copied user and assistant message
      text. Hidden provider context, tool details and attachment contents are
      not included.
    </Notice>
  );
}
