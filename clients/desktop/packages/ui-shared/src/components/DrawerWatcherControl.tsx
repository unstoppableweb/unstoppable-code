import { useState, type JSX } from 'react';
import { REPLAY_BLOCK_CLASS, REPLAY_MASK_CLASS } from '../lib/replay-privacy';
import { BeingWatchedIcon } from '../icons/AppIcons';
import { DrawerInspectorAction } from './DrawerInspectorAction';
import { ExecutionActionButton } from './ExecutionActionButton';
import { RichHoverTooltip } from './RichHoverTooltip';

export interface DrawerWatcherPreviewRow {
  readonly id: string;
  readonly name: string;
  readonly details: readonly string[];
}

/** Quiet watcher action and preview shared by the drawer and its design mock. */
export function DrawerWatcherControl({
  count,
  label,
  rows,
  heading = 'Active watchers',
  ariaLabel,
  dataTestId,
  onClick,
}: {
  readonly count: number;
  readonly label?: string;
  readonly rows: readonly DrawerWatcherPreviewRow[];
  readonly heading?: string;
  readonly ariaLabel: string;
  readonly dataTestId?: string;
  readonly onClick: () => void;
}): JSX.Element | null {
  const [previewOpen, setPreviewOpen] = useState(false);
  if (count === 0) return null;
  return (
    <RichHoverTooltip
      open={previewOpen}
      onOpenChange={setPreviewOpen}
      dataTestId={dataTestId ? `${dataTestId}-tooltip` : undefined}
      surfacePadding="card"
      content={
        <div className="flex w-64 max-w-full flex-col gap-2 text-s">
          <div className="flex items-center gap-1.5 fg-tertiary">
            {heading} <span className="fg-quaternary">{count}</span>
          </div>
          <ul className="flex flex-col gap-3">
            {rows.map((row) => (
              <li key={row.id} className="flex min-w-0 flex-col gap-1">
                <span
                  className={`${REPLAY_MASK_CLASS} break-words text-s fg-primary`}
                >
                  {row.name}
                </span>
                <div
                  className={`${REPLAY_BLOCK_CLASS} flex flex-col gap-0.5 break-words fg-secondary`}
                >
                  {row.details.map((detail, index) => (
                    <span key={index}>{detail}</span>
                  ))}
                </div>
              </li>
            ))}
          </ul>
          {count > rows.length && (
            <div className="fg-tertiary">+{count - rows.length} more</div>
          )}
        </div>
      }
    >
      {label !== undefined ? (
        <DrawerInspectorAction
          // It sits at the row's end among the row's controls.
          alignment="inline"
          aria-label={ariaLabel}
          aria-haspopup="dialog"
          data-testid={dataTestId}
          onClick={(): void => {
            setPreviewOpen(false);
            onClick();
          }}
        >
          {label}
        </DrawerInspectorAction>
      ) : (
        <ExecutionActionButton
          variant="text"
          icon={<BeingWatchedIcon size="sm" />}
          label={<span className="tabular-nums">{count}</span>}
          ariaLabel={ariaLabel}
          aria-haspopup="dialog"
          stopKeyDownPropagation={false}
          dataTestId={dataTestId}
          onClick={(): void => {
            setPreviewOpen(false);
            onClick();
          }}
        />
      )}
    </RichHoverTooltip>
  );
}
