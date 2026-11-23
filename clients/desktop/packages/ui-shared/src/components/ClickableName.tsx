import { ControlButton } from './Button';
import type { JSX } from 'react';
import { REPLAY_BLOCK_CLASS } from '../lib/replay-privacy';

/**
 * Name + optional one-line description rendered as a click target, used by the
 * plugin detail component lists. Ported from the desktop `PluginDetailView`
 * internal — class names match it exactly so tests/selectors and visual diffs
 * are unchanged.
 */
export function ClickableName({
  name,
  description,
  mono = false,
  privateName = false,
  onClick,
}: {
  name: string;
  description?: string;
  /** For identifiers people type, like a command. */
  mono?: boolean;
  /**
   * A name read from someone's files: session replay keeps a placeholder for
   * the text, never for the button itself.
   */
  privateName?: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <ControlButton
      type="button"
      onClick={onClick}
      presentation="clickable-name"
    >
      <span
        className={`fg-primary font-medium group-hover:fg-accent transition-colors${
          mono ? ' font-mono text-xs' : ''
        }${privateName ? ` ${REPLAY_BLOCK_CLASS}` : ''}`}
      >
        {name}
      </span>
      {description && (
        <span
          className="block text-xs fg-secondary mt-0.5 line-clamp-1"
          title={description}
        >
          {description}
        </span>
      )}
    </ControlButton>
  );
}
