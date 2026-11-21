import { useId, type JSX, type MouseEventHandler, type ReactNode } from 'react';
import { REPLAY_BLOCK_CLASS } from '../lib/replay-privacy';
import { ControlButton } from './Button';
import { Surface } from './Surface';
import { Inline } from './Stack';

export interface AttachmentItemRowContentProps {
  readonly filename: string;
  readonly icon: ReactNode;
  readonly metadata?: ReactNode;
  /**
   * The row's controls. Session replay records attributes, so a control names
   * the file through `aria-describedby` on the id passed here, never by
   * putting the filename in its label.
   */
  readonly actions?: ReactNode | ((nameId: string) => ReactNode);
  readonly contentTestId?: string;
  /**
   * Opens the file: the icon, name and metadata become one button. Its label
   * is generic (`openLabel`) and it names the file through the row's blocked
   * name, as the actions do.
   */
  readonly onOpen?: () => void;
  readonly openLabel?: string;
}

/** Pure attachment row content; each host supplies its transport actions. */
function AttachmentItemRowContent({
  filename,
  icon,
  metadata,
  actions,
  contentTestId,
  onOpen,
  openLabel = 'Open file',
}: AttachmentItemRowContentProps): JSX.Element {
  const nameId = useId();
  // The size gives way to the action tray on hover; with no actions it stays.
  const hasActions = actions !== undefined && actions !== null;
  const content = (
    <Inline gap="inline" align="center">
      {icon}
      <div className="flex min-w-0 flex-1 items-center">
        <span
          id={nameId}
          className={`${REPLAY_BLOCK_CLASS} truncate text-xs font-medium fg-primary`}
          // Safe in replay: the block class drops the element's attributes.
          title={filename}
        >
          {filename}
        </span>
      </div>
      {metadata !== undefined ? (
        <span
          className={`shrink-0 text-2xs tabular-nums fg-secondary${hasActions ? ' transition-opacity pointer-fine:group-hover:opacity-0 pointer-fine:group-focus-within:opacity-0' : ''}`}
        >
          {metadata}
        </span>
      ) : null}
    </Inline>
  );
  return (
    <div className="contents pointer-coarse:flex pointer-coarse:min-h-11 pointer-coarse:flex-wrap pointer-coarse:items-center pointer-coarse:justify-end pointer-coarse:gap-2 pointer-coarse:px-2 pointer-coarse:py-2">
      {onOpen === undefined ? (
        <div
          className="px-2 py-1.5 pointer-coarse:w-full pointer-coarse:px-0 pointer-coarse:py-0"
          data-testid={contentTestId}
        >
          {content}
        </div>
      ) : (
        // The whole row reads as the file and opens it; the actions sit
        // over its end, above the button.
        <ControlButton
          type="button"
          presentation="attachment-row-open"
          aria-label={openLabel}
          aria-describedby={nameId}
          onClick={onOpen}
          data-testid={contentTestId}
        >
          {content}
        </ControlButton>
      )}
      {typeof actions === 'function' ? actions(nameId) : actions}
    </div>
  );
}

export interface AttachmentItemRowProps extends AttachmentItemRowContentProps {
  readonly as?: 'div' | 'li';
  readonly testId: string;
  readonly attachmentId?: string;
  readonly state?: 'ready';
  readonly onMouseEnter?: MouseEventHandler<HTMLElement>;
  readonly onMouseLeave?: MouseEventHandler<HTMLElement>;
}

/** One populated attachment frame on both hosts; actions remain host-owned. */
export function AttachmentItemRow({
  as = 'div',
  testId,
  attachmentId,
  state,
  onMouseEnter,
  onMouseLeave,
  ...content
}: AttachmentItemRowProps): JSX.Element {
  return (
    <Surface
      as={as}
      variant="group"
      size="small"
      className="group relative"
      data-testid={testId}
      data-attachment-id={attachmentId}
      data-state={state}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <AttachmentItemRowContent {...content} />
    </Surface>
  );
}
