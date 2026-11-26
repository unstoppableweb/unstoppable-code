import { useState, type JSX, type ReactNode } from 'react';
import { Surface } from '../../primitives/Surface';
import { StepRow } from './StepRow';

export function TranscriptEventRow({
  icon,
  label,
  detail,
  children,
  dataTestId,
  forceOpen = false,
  status,
  actions,
}: {
  readonly icon: ReactNode;
  readonly label: ReactNode;
  readonly detail?: ReactNode;
  readonly children?: ReactNode;
  readonly dataTestId?: string;
  readonly forceOpen?: boolean;
  /** A word at the row's end in the tertiary ink, such as Queued. */
  readonly status?: ReactNode;
  /** Controls after the status; they show on hover, focus or touch. */
  readonly actions?: ReactNode;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const expandable = children != null;
  const expanded = open || forceOpen;
  const hasEnd = status != null || actions != null;
  const row = (
    <StepRow
      step
      icon={icon}
      label={label}
      detail={detail}
      expandable={expandable}
      isOpen={expanded}
      onToggle={forceOpen ? undefined : (): void => setOpen((value) => !value)}
      extent={hasEnd ? 'remaining' : 'fill'}
      // The toggle's hit area covers the whole row; the actions stay
      // clickable by being positioned after it.
      stretched={hasEnd && expandable}
      dataTestId={dataTestId}
    />
  );

  return (
    <div className="min-w-0">
      <div className="px-2">
        {hasEnd ? (
          <div className="group/event relative flex min-w-0 items-center gap-2">
            {row}
            {/* With a pointer, the actions take the status's place on hover
                or focus, so the status rests on the row's end. On touch both
                stay visible side by side: the status must still say what
                happened (Cancelled, Delivery uncertain) beside the action. */}
            <span className="relative grid shrink-0 items-center justify-items-end pointer-coarse:flex pointer-coarse:gap-1">
              {status != null ? (
                <span
                  className={`col-start-1 row-start-1 text-xs fg-tertiary${actions != null ? ' transition-opacity pointer-fine:group-focus-within/event:opacity-0 pointer-fine:group-hover/event:opacity-0' : ''}`}
                >
                  {status}
                </span>
              ) : null}
              {actions != null ? (
                <span className="relative col-start-1 row-start-1 flex items-center gap-1 opacity-0 transition-opacity group-focus-within/event:opacity-100 group-hover/event:opacity-100 pointer-coarse:opacity-100">
                  {actions}
                </span>
              ) : null}
            </span>
          </div>
        ) : (
          row
        )}
      </div>
      {expanded && expandable ? (
        <div className="pl-9 text-s fg-secondary">
          <Surface
            variant="transcript-nested-well"
            padding="tight"
            className="min-w-0"
          >
            {children}
          </Surface>
        </div>
      ) : null}
    </div>
  );
}

/** Quiet transcript context that does not require an action. */
export function TranscriptEventMarker({
  icon,
  children,
  dataTestId,
}: {
  readonly icon: ReactNode;
  readonly children: ReactNode;
  readonly dataTestId?: string;
}): JSX.Element {
  return (
    <div
      data-testid={dataTestId}
      data-chat-notice=""
      className="flex min-w-0 items-center gap-2 py-1 text-xs fg-tertiary"
    >
      <span aria-hidden="true" className="h-px min-w-3 flex-1 bg-line-base" />
      <span className="flex min-w-0 items-center justify-center gap-1.5 text-center">
        <span className="shrink-0" aria-hidden="true">
          {icon}
        </span>
        <span>{children}</span>
      </span>
      <span aria-hidden="true" className="h-px min-w-3 flex-1 bg-line-base" />
    </div>
  );
}
